// benchRefsProbe.ts — ADR-0002 Confirmation-1: the refs probe RUNNER and CLI entry.
//
//   bun scripts/benchRefsProbe.ts --corpus docs/adrs/0002-benchmark/refs-corpus.json \
//                                 --out    docs/adrs/0002-benchmark/refs-probe.json
//
// Three append-only artifacts: the frozen corpus (input, committed at P2 before any measured
// try), the raw try journal (refs-probe-journal.jsonl — every physical try appended as it
// runs), and the result (written ONLY at completion). A crash resumes from the journal: cell
// state re-derives from recorded rows and only the remainder is re-admitted — no double-spend.
// A completed result is never overwritten; a re-run is a NEW artifact (refs-probe-2.json, …).
//
// The rules are all in benchRefsRules.ts (pre-registered, pure); this module only dispatches,
// records, sleeps, and writes. Transport rides the SANCTIONED bench gh seam (benchGh.ts →
// production GithubClient chokepoint) — no new launch surface. Admission, quarantine, and
// washout follow the benchBoundary precedents, upgraded to per-tranche admission where the
// tranche is the paired try.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GithubClient } from "./github.ts";
import { loadBenchConfig } from "./benchConfig.ts";
import {
  benchGraphqlDispatch,
  graphqlRecordClassification,
  makeBuckets,
  outstandingHorizonMs,
  readRateLimit,
  type BenchGhContext,
  type BenchGraphqlDispatch,
  type BenchHttpAttemptRecord,
  type RateLimitSnapshot,
} from "./benchGh.ts";
import { washoutMs } from "./benchProtocol.ts";
import { buildBatchRefsQuery } from "./graphqlBatch.ts";
import {
  BenchRefsRulesError,
  REFS_PROBE_AGE_CAP_MS,
  REFS_PROBE_INVALIDATION_RERUN_CAP,
  REFS_PROBE_RATE_LIMIT_RIDER,
  SOLO_REFS_QUERY,
  admitTranche,
  assembleRefsWalk,
  buildProbeSoloQuery,
  checkAliasIdentity,
  deriveCellState,
  evaluateCandidate,
  evaluateTry,
  parseJournalRow,
  parseRefsProbeCorpus,
  planOwnerChunks,
  presentCorrectedEstates,
  reduceCell,
  selectOutcome,
  REFS_PROBE_ALL_BATCH_SIZES,
  REFS_PROBE_BUCKET_LIMIT_POINTS,
  REFS_PROBE_CANDIDATE_BATCH_SIZES,
  REFS_PROBE_ESTATE_8X750_REPOS,
  REFS_PROBE_PAIR_COST_GATE_MAX,
  REFS_PROBE_POINT_BOUND_PER_ATTEMPT,
  REFS_PROBE_SHIP_THRESHOLD_POINTS,
  REFS_PROBE_TRIES_PER_CELL,
  REFS_PROBE_WALL_GATE_MS,
  type RefsCandidateVerdict,
  type RefsCellReduction,
  type RefsCellStatus,
  type RefsCorpusCell,
  type RefsCorpusRepo,
  type RefsEstateRow,
  type RefsProbeCorpus,
  type RefsProbeDispatchRecord,
  type RefsProbeJournalRow,
  type RefsProbeOutcome,
  type RefsRepoWalkRecord,
  type RefsTryRow,
  type RefsStratum,
} from "./benchRefsRules.ts";

// the artifact schemas and the whole rule executor are re-exported so this module IS the probe
// surface the plan names; the split into benchRefsRules.ts exists for the file-size rule alone
export * from "./benchRefsRules.ts";

// ---- path + identity helpers (pure, tested) --------------------------------------------------
export function journalPathFor(outPath: string): string {
  if (!outPath.endsWith(".json")) throw new BenchRefsRulesError(`--out must end in .json, got ${outPath}`);
  return `${outPath.slice(0, -".json".length)}-journal.jsonl`;
}

// the live credential must be the corpus's enumeration identity — measuring under a different
// login would price a different estate's visibility and quietly break reproducibility
export function assertProbeIdentity(liveLogin: string, corpus: RefsProbeCorpus): void {
  if (liveLogin !== corpus.login)
    throw new BenchRefsRulesError(
      `authenticated as ${JSON.stringify(liveLogin)} but the frozen corpus was enumerated as ${JSON.stringify(corpus.login)}`,
    );
}

// tolerate exactly one trailing partial line (a crash mid-append); anything else is corruption
export function parseJournal(lines: readonly string[], warn: (line: string) => void): RefsProbeJournalRow[] {
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  const rows: RefsProbeJournalRow[] = [];
  for (let i = 0; i < nonEmpty.length; i++) {
    try {
      rows.push(parseJournalRow(nonEmpty[i]!));
    } catch (e) {
      if (i === nonEmpty.length - 1) {
        warn(`journal: dropping one trailing partial line (${e instanceof Error ? e.message : String(e)}) — that attempt re-runs`);
        break;
      }
      throw e;
    }
  }
  return rows;
}

// ---- runner dependencies (injectable; main() wires the live ones) ----------------------------
export interface RefsDispatchOutcome {
  d: BenchGraphqlDispatch;
  rec: BenchHttpAttemptRecord;
}

export interface RefsProbeDeps {
  corpus: RefsProbeCorpus;
  corpusPath: string;
  outPath: string;
  journalPath: string;
  benchConfigPath: string;
  existingJournalLines: string[];
  appendJournal: (row: RefsProbeJournalRow) => void;
  writeResult: (result: RefsProbeResult) => void;
  dispatchGraphql: (query: string, fields: Record<string, string>, label: string) => Promise<RefsDispatchOutcome>;
  readRateLimit: () => Promise<RateLimitSnapshot>;
  outstandingHorizonMs: () => number;
  headroomFactor: number;
  washoutFloorMs: number;
  log: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

// ---- result artifact -------------------------------------------------------------------------
export interface RefsCellReport {
  batchSize: number;
  stratum: RefsStratum;
  status: RefsCellStatus;
  reduction: RefsCellReduction;
  tryRowCount: number;
  cleanTryCount: number;
}

export interface RefsProbeResult {
  version: 1;
  generatedAtIso: string;
  login: string;
  corpusPath: string;
  journalPath: string;
  benchConfigPath: string;
  resumedFromJournal: boolean;
  constants: {
    candidateBatchSizes: number[];
    informationalBatchSizes: number[];
    triesPerCell: number;
    invalidationRerunCap: number;
    wallGateMs: number;
    pairCostGateMax: number;
    pointBoundPerAttempt: number;
    bucketLimitPoints: number;
    shipThresholdPoints: number;
    estate8x750Repos: number;
    ageCapMs: number;
  };
  before: RateLimitSnapshot;
  after: RateLimitSnapshot;
  finalWashoutMs: number;
  cells: RefsCellReport[];
  verdicts: RefsCandidateVerdict[];
  outcome: RefsProbeOutcome;
  estates: RefsEstateRow[] | null; // corrected worked table when a default pinned; null otherwise
}

// ---- the runner ------------------------------------------------------------------------------
const isoOf = (ms: number): string => new Date(ms).toISOString();
const repoKeyOf = (r: RefsCorpusRepo): string => `${r.owner}/${r.name}`;

// lenient pageInfo read for LIVE cursor-following only — the strict battery re-validates the
// recorded pages; this must never loop on a malformed shape
function livePageInfo(repoObj: unknown): { hasNextPage: boolean; endCursor: string | null } {
  if (typeof repoObj !== "object" || repoObj === null) return { hasNextPage: false, endCursor: null };
  const refs = (repoObj as Record<string, unknown>)["refs"];
  if (typeof refs !== "object" || refs === null) return { hasNextPage: false, endCursor: null };
  const pi = (refs as Record<string, unknown>)["pageInfo"];
  if (typeof pi !== "object" || pi === null) return { hasNextPage: false, endCursor: null };
  const hn = (pi as Record<string, unknown>)["hasNextPage"];
  const ec = (pi as Record<string, unknown>)["endCursor"];
  return { hasNextPage: hn === true, endCursor: typeof ec === "string" && ec.length > 0 ? ec : null };
}

interface TryRunResult {
  row: RefsTryRow;
  quarantine: boolean;
  resetHintEpochSec: number | null;
}

async function runPairedTry(deps: RefsProbeDeps, cell: RefsCorpusCell, slot: number, attempt: number): Promise<TryRunResult> {
  const dispatches: RefsProbeDispatchRecord[] = [];
  const walks: RefsRepoWalkRecord[] = [];
  let quarantine = false;
  let candidateFailed = false;
  let controlAborted = false;
  let resetHintEpochSec: number | null = null;
  const soloQuery = buildProbeSoloQuery(REFS_PROBE_RATE_LIMIT_RIDER);
  const labelBase = `refs.B${cell.batchSize}.${cell.stratum}.s${slot}.a${attempt}`;

  const dispatchOne = async (
    query: string,
    fields: Record<string, string>,
    label: string,
    meta: Pick<RefsProbeDispatchRecord, "arm" | "callKind" | "repo" | "batchOrdinal" | "pageOrdinal">,
  ): Promise<BenchGraphqlDispatch | null> => {
    try {
      const { d, rec } = await deps.dispatchGraphql(query, fields, label);
      const record: RefsProbeDispatchRecord = {
        ...meta,
        status: d.status,
        exitCode: d.exitCode,
        classification: graphqlRecordClassification(d.status, d.classification, d),
        secondaryLike: d.secondaryLike,
        secondarySignal: rec.secondarySignal,
        pointsCost: d.pointsCost,
        remaining: rec.remaining,
        resetEpochSec: rec.resetEpochSec,
        wallMs: rec.wallMs,
        bodyBytes: rec.bodyBytes,
        errorTypes: d.errors.map((e) => e.type ?? "?"),
        errorMessages: d.errors.flatMap((e) => (e.message === null ? [] : [e.message.slice(0, 200)])),
        malformedErrorEntries: d.malformedErrorEntries,
        dispatchFailure: null,
      };
      dispatches.push(record);
      if (d.status === 502 || d.status === 504) {
        quarantine = true;
        resetHintEpochSec = rec.resetEpochSec;
        return null;
      }
      return d;
    } catch (e) {
      dispatches.push({
        ...meta,
        status: 0,
        exitCode: -1,
        classification: "no-response",
        secondaryLike: false,
        secondarySignal: null,
        pointsCost: null,
        remaining: null,
        resetEpochSec: null,
        wallMs: 0,
        bodyBytes: 0,
        errorTypes: [],
        errorMessages: [],
        malformedErrorEntries: 0,
        dispatchFailure: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      });
      return null;
    }
  };

  const tStart = deps.now();
  // ---- candidate page-1 phase ----
  const chunks = planOwnerChunks(cell.repos, cell.batchSize);
  const aliasPages = new Map<string, unknown>();
  for (let b = 0; b < chunks.length && !quarantine && !candidateFailed; b++) {
    const chunk = chunks[b]!;
    const built = buildBatchRefsQuery(chunk, { rateLimitRider: REFS_PROBE_RATE_LIMIT_RIDER });
    const d = await dispatchOne(built.query, built.fields, `${labelBase}.b${b}`, {
      arm: "candidate", callKind: "batch-page1", repo: null, batchOrdinal: b, pageOrdinal: null,
    });
    if (d === null) {
      candidateFailed = !quarantine;
      break;
    }
    const last = dispatches[dispatches.length - 1]!;
    if (last.classification !== "ok") {
      candidateFailed = true;
      break;
    }
    const data = d.data ?? {};
    for (const expected of built.expected) {
      aliasPages.set(`${expected.owner}/${expected.name}`.toLowerCase(), (data as Record<string, unknown>)[expected.alias]);
    }
  }
  const page1End = deps.now();

  // ---- candidate continuation phase (kept order; full snapshots before anything else) ----
  const contStart = deps.now();
  if (!quarantine && !candidateFailed) {
    for (const r of cell.repos) {
      if (quarantine || candidateFailed) break;
      const key = repoKeyOf(r);
      const alias = aliasPages.get(key.toLowerCase());
      if (alias === undefined || alias === null || typeof alias !== "object") {
        walks.push({
          arm: "candidate", repo: key, pagesObserved: 0, complete: false,
          batteryFailure: "alias absent or null in the batch envelope", identityFailure: null,
          headCount: 0, defaultBranch: null,
        });
        candidateFailed = true;
        continue;
      }
      const identityFailure = checkAliasIdentity(alias, r.owner, r.name);
      const pages: unknown[] = [alias];
      let pageNo = 1;
      for (;;) {
        const info = livePageInfo(pages[pages.length - 1]);
        if (!info.hasNextPage) break;
        // bounded by the frozen depth: one page past it proves drift without unbounded spend
        if (pageNo >= r.frozenPages) break;
        if (info.endCursor === null) break; // the strict battery reports the shape violation
        pageNo++;
        const d = await dispatchOne(soloQuery, { owner: r.owner, name: r.name, endCursor: info.endCursor }, `${labelBase}.cont.${r.name}.p${pageNo}`, {
          arm: "candidate", callKind: "solo-page", repo: key, batchOrdinal: null, pageOrdinal: pageNo,
        });
        if (d === null) {
          candidateFailed = !quarantine;
          break;
        }
        const last = dispatches[dispatches.length - 1]!;
        if (last.classification !== "ok") {
          candidateFailed = true;
          break;
        }
        const repoObj = (d.data as Record<string, unknown> | null)?.["repository"];
        pages.push(repoObj);
      }
      const walk = assembleRefsWalk(pages);
      walks.push(walk.ok
        ? { arm: "candidate", repo: key, pagesObserved: walk.pages, complete: walk.complete, batteryFailure: null, identityFailure, headCount: walk.headCount, defaultBranch: walk.defaultBranch }
        : { arm: "candidate", repo: key, pagesObserved: pages.length, complete: false, batteryFailure: walk.failure, identityFailure, headCount: 0, defaultBranch: null });
    }
  }
  const contEnd = deps.now();

  // ---- control arm (skipped once the candidate has already decided the gate) ----
  const ctrlStart = deps.now();
  if (!quarantine && !candidateFailed) {
    for (const r of cell.repos) {
      if (quarantine || controlAborted) break;
      const key = repoKeyOf(r);
      const pages: unknown[] = [];
      let cursor: string | null = null;
      let pageNo = 0;
      for (;;) {
        pageNo++;
        const fields: Record<string, string> = { owner: r.owner, name: r.name };
        if (cursor !== null) fields["endCursor"] = cursor;
        const d = await dispatchOne(soloQuery, fields, `${labelBase}.ctl.${r.name}.p${pageNo}`, {
          arm: "control", callKind: "solo-page", repo: key, batchOrdinal: null, pageOrdinal: pageNo,
        });
        if (d === null) {
          controlAborted = !quarantine;
          break;
        }
        const last = dispatches[dispatches.length - 1]!;
        if (last.classification !== "ok") {
          controlAborted = true;
          break;
        }
        const repoObj = (d.data as Record<string, unknown> | null)?.["repository"];
        pages.push(repoObj);
        const info = livePageInfo(repoObj);
        if (!info.hasNextPage) break;
        if (pageNo >= r.frozenPages) break; // drift bound, same as the candidate walk
        if (info.endCursor === null) break;
        cursor = info.endCursor;
      }
      if (pages.length > 0) {
        const walk = assembleRefsWalk(pages);
        walks.push(walk.ok
          ? { arm: "control", repo: key, pagesObserved: walk.pages, complete: walk.complete, batteryFailure: null, identityFailure: null, headCount: walk.headCount, defaultBranch: walk.defaultBranch }
          : { arm: "control", repo: key, pagesObserved: pages.length, complete: false, batteryFailure: walk.failure, identityFailure: null, headCount: 0, defaultBranch: null });
      }
    }
  }
  const ctrlEnd = deps.now();

  const continuationPhaseMs = contEnd - contStart;
  const evaluation = evaluateTry(cell, dispatches, walks);
  const row: RefsTryRow = {
    rowKind: "try",
    version: 1,
    atIso: isoOf(deps.now()),
    cellB: cell.batchSize,
    stratum: cell.stratum,
    slot,
    attempt,
    dispatches,
    walks,
    verdict: evaluation.verdict,
    causes: evaluation.causes,
    invalidationCause: evaluation.invalidationCause,
    candidate: evaluation.candidate,
    control: evaluation.control,
    pairRatio: evaluation.pairRatio,
    informational: {
      candidateFullSnapshotMs: contEnd - tStart,
      candidatePage1PhaseMs: page1End - tStart,
      continuationPhaseMs,
      controlArmMs: ctrlEnd - ctrlStart,
      wouldHaveTrippedProductionStop: continuationPhaseMs > REFS_PROBE_AGE_CAP_MS / 2,
    },
  };
  return { row, quarantine: evaluation.verdict === "quarantine-unclean", resetHintEpochSec };
}

const sleepToResetMs = (resetEpochSec: number | null, nowMs: number): number =>
  Math.max(resetEpochSec === null ? 0 : resetEpochSec * 1000 + 5_000 - nowMs, 30_000);

export async function runRefsProbe(deps: RefsProbeDeps): Promise<RefsProbeResult> {
  const rows: RefsProbeJournalRow[] = parseJournal(deps.existingJournalLines, deps.log);
  const resumedFromJournal = rows.length > 0;
  if (resumedFromJournal) deps.log(`journal: resuming with ${rows.length} recorded row(s)`);
  const before = await deps.readRateLimit();
  const push = (row: RefsProbeJournalRow): void => {
    rows.push(row);
    deps.appendJournal(row);
  };
  let finalWashoutMs = 0;
  try {
    for (const cell of deps.corpus.cells) {
      let state = deriveCellState(cell, rows);
      deps.log(`cell B=${cell.batchSize} ${cell.stratum}: ${state.kind}`);
      while (state.kind === "pending") {
        const remainingReruns = REFS_PROBE_INVALIDATION_RERUN_CAP - state.invalidationsUsed;
        const arithmetic = admitTranche(cell, remainingReruns, deps.headroomFactor);
        if (!arithmetic.feasible) {
          deps.log(`cell B=${cell.batchSize} ${cell.stratum}: tranche worst case ${arithmetic.neededPoints} exceeds the bucket limit ${arithmetic.bucketLimitPoints} — infeasible`);
          push({ rowKind: "admission-infeasible", version: 1, atIso: isoOf(deps.now()), cellB: cell.batchSize, stratum: cell.stratum, arithmetic });
          break;
        }
        // per-tranche admission: sleep to the reset epoch until the live remaining funds the
        // tranche's worst case (the tranche is the try, re-runs included)
        let sleptMs = 0;
        let remainingObserved = 0;
        for (;;) {
          const snap = await deps.readRateLimit();
          remainingObserved = snap.graphql.remaining;
          if (snap.graphql.remaining >= arithmetic.neededPoints) break;
          const wait = sleepToResetMs(snap.graphql.reset, deps.now());
          deps.log(`admission: need ${arithmetic.neededPoints}, have ${snap.graphql.remaining} — sleeping ${Math.ceil(wait / 1000)}s to the reset epoch`);
          await deps.sleep(wait);
          sleptMs += wait;
        }
        push({
          rowKind: "admission", version: 1, atIso: isoOf(deps.now()), cellB: cell.batchSize, stratum: cell.stratum,
          slot: state.nextSlot, attempt: state.nextAttempt, neededPoints: arithmetic.neededPoints, remainingObserved, sleptMs,
        });
        deps.log(`try B=${cell.batchSize} ${cell.stratum} slot ${state.nextSlot} attempt ${state.nextAttempt} (admitted ${arithmetic.neededPoints} worst-case points)`);
        const { row, quarantine, resetHintEpochSec } = await runPairedTry(deps, cell, state.nextSlot, state.nextAttempt);
        push(row);
        deps.log(`  verdict: ${row.verdict}${row.causes.length > 0 ? ` (${row.causes[0]})` : ""}`);
        if (quarantine) {
          // the documented timeout penalty is unquantified: no admission can price the current
          // window after one, so the runner quarantines to the next reset epoch before ANY
          // further dispatch anywhere
          const hint = resetHintEpochSec ?? (await deps.readRateLimit()).graphql.reset;
          const wait = sleepToResetMs(hint, deps.now());
          deps.log(`quarantine: 502/504 observed — sleeping ${Math.ceil(wait / 1000)}s to the next reset epoch`);
          await deps.sleep(wait);
          push({
            rowKind: "quarantine", version: 1, atIso: isoOf(deps.now()), cellB: cell.batchSize, stratum: cell.stratum,
            slot: state.nextSlot, attempt: state.nextAttempt, untilEpochSec: hint, sleptMs: wait,
          });
        }
        state = deriveCellState(cell, rows);
      }
      deps.log(`cell B=${cell.batchSize} ${cell.stratum}: ${deriveCellState(cell, rows).kind}`);
    }
  } finally {
    // the run ALWAYS ends with a full washout of its own throttle horizon — even on a thrown
    // dispatch — so a probe burst cannot bleed into the next consumer's window
    finalWashoutMs = Math.max(deps.washoutFloorMs, deps.outstandingHorizonMs() - deps.now());
    deps.log(`refs probe winding down — final washout ${Math.ceil(finalWashoutMs / 1000)}s`);
    await deps.sleep(finalWashoutMs);
    push({ rowKind: "washout", version: 1, atIso: isoOf(deps.now()), sleptMs: finalWashoutMs });
  }
  const after = await deps.readRateLimit();

  // ---- reduce, gate, select (all pre-registered rules) ----
  const tryRowsFor = (b: number, s: RefsStratum): RefsTryRow[] =>
    rows.filter((r): r is RefsTryRow => r.rowKind === "try" && r.cellB === b && r.stratum === s);
  const cellReports: RefsCellReport[] = deps.corpus.cells.map((cell) => {
    const tr = tryRowsFor(cell.batchSize, cell.stratum);
    const reduction = reduceCell(tr);
    return {
      batchSize: cell.batchSize, stratum: cell.stratum,
      status: deriveCellState(cell, rows), reduction,
      tryRowCount: tr.length, cleanTryCount: reduction.cleanTryCount,
    };
  });
  const outcomeFor = (b: number, s: RefsStratum): { status: RefsCellStatus; reduction: RefsCellReduction; tryRows: RefsTryRow[] } => {
    const cell = deps.corpus.cells.find((c) => c.batchSize === b && c.stratum === s);
    if (cell === undefined) throw new BenchRefsRulesError(`corpus carries no (B=${b}, ${s}) cell`);
    const tr = tryRowsFor(b, s);
    return { status: deriveCellState(cell, rows), reduction: reduceCell(tr), tryRows: tr };
  };
  const verdicts = REFS_PROBE_ALL_BATCH_SIZES.map((b) => evaluateCandidate(b, outcomeFor(b, "p1"), outcomeFor(b, "p2")));
  const p1Reductions = new Map(REFS_PROBE_ALL_BATCH_SIZES.map((b) => [b, outcomeFor(b, "p1").reduction]));
  const outcome = selectOutcome(verdicts.filter((v) => v.candidate), p1Reductions);
  const estates = outcome.kind === "default-pinned"
    ? presentCorrectedEstates(
        outcome.defaultBatchSize,
        outcome.page1PerRepo,
        outcomeFor(outcome.defaultBatchSize, "p2").reduction.continuationPerPageMax,
      )
    : null;

  const result: RefsProbeResult = {
    version: 1,
    generatedAtIso: isoOf(deps.now()),
    login: deps.corpus.login,
    corpusPath: deps.corpusPath,
    journalPath: deps.journalPath,
    benchConfigPath: deps.benchConfigPath,
    resumedFromJournal,
    constants: {
      candidateBatchSizes: [...REFS_PROBE_CANDIDATE_BATCH_SIZES],
      informationalBatchSizes: REFS_PROBE_ALL_BATCH_SIZES.filter((b) => !REFS_PROBE_CANDIDATE_BATCH_SIZES.includes(b)),
      triesPerCell: REFS_PROBE_TRIES_PER_CELL,
      invalidationRerunCap: REFS_PROBE_INVALIDATION_RERUN_CAP,
      wallGateMs: REFS_PROBE_WALL_GATE_MS,
      pairCostGateMax: REFS_PROBE_PAIR_COST_GATE_MAX,
      pointBoundPerAttempt: REFS_PROBE_POINT_BOUND_PER_ATTEMPT,
      bucketLimitPoints: REFS_PROBE_BUCKET_LIMIT_POINTS,
      shipThresholdPoints: REFS_PROBE_SHIP_THRESHOLD_POINTS,
      estate8x750Repos: REFS_PROBE_ESTATE_8X750_REPOS,
      ageCapMs: REFS_PROBE_AGE_CAP_MS,
    },
    before,
    after,
    finalWashoutMs,
    cells: cellReports,
    verdicts,
    outcome,
    estates,
  };
  deps.writeResult(result);
  deps.log(`outcome: ${outcome.kind}${outcome.kind === "default-pinned" ? ` (B = ${outcome.defaultBatchSize})` : ""}`);
  return result;
}

// ---- live wiring -----------------------------------------------------------------------------
const BENCH_CONFIG_PATH = join(import.meta.dir, "..", "docs", "adrs", "0001-benchmark", "bench-config.json");

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  let corpusPath: string | null = null;
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--corpus") corpusPath = argv[++i] ?? null;
    else if (argv[i] === "--out") outPath = argv[++i] ?? null;
    else {
      log(`unknown argument ${argv[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  if (corpusPath === null || outPath === null) {
    log("usage: bun scripts/benchRefsProbe.ts --corpus docs/adrs/0002-benchmark/refs-corpus.json --out docs/adrs/0002-benchmark/refs-probe.json");
    process.exitCode = 2;
    return;
  }
  if (existsSync(outPath))
    throw new BenchRefsRulesError(`${outPath} already exists — results are append-only; name a new artifact (refs-probe-2.json, …)`);
  const corpus = parseRefsProbeCorpus(readFileSync(corpusPath, "utf8"));
  const journalPath = journalPathFor(outPath);
  const cfg = loadBenchConfig(BENCH_CONFIG_PATH);
  const client = new GithubClient({ githubHost: cfg.githubHost, db: null, spawnTimeoutMs: cfg.spawn.timeoutMs });
  const login = ((await client.restGetJson("user")) as { login?: string }).login ?? "unknown";
  assertProbeIdentity(login, corpus);
  log(`identity confirmed: ${login}`);
  const buckets = makeBuckets();
  const gh: BenchGhContext = {
    client, db: null, cfg, core: buckets.core, graphql: buckets.graphql,
    record: () => {}, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  mkdirSync(dirname(outPath), { recursive: true });
  const result = await runRefsProbe({
    corpus,
    corpusPath,
    outPath,
    journalPath,
    benchConfigPath: BENCH_CONFIG_PATH,
    existingJournalLines: existsSync(journalPath) ? readFileSync(journalPath, "utf8").split("\n") : [],
    appendJournal: (row) => appendFileSync(journalPath, `${JSON.stringify(row)}\n`),
    writeResult: (r) => writeFileSync(outPath, `${JSON.stringify(r, null, 2)}\n`),
    dispatchGraphql: async (query, fields, label) => {
      let captured: BenchHttpAttemptRecord | null = null;
      const ctx: BenchGhContext = { ...gh, record: (r) => { captured = r; } };
      const d = await benchGraphqlDispatch(ctx, query, fields, label);
      if (captured === null) throw new BenchRefsRulesError("dispatch recorded no attempt row");
      return { d, rec: captured };
    },
    readRateLimit: () => readRateLimit(gh),
    outstandingHorizonMs: () => outstandingHorizonMs(gh),
    headroomFactor: cfg.budget.headroomFactor,
    washoutFloorMs: washoutMs(cfg, 0, 0),
    log,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  log(`result written to ${outPath} (${result.outcome.kind})`);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    log(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    process.exitCode = 1;
  });
}
