// benchScore.ts — the §4.6 scoring formulas and the §4.7 pre-registered rule, as a PURE reader
// over committed evidence (runs.jsonl, fidelity.jsonl, the pinned config/corpus/workloads).
// Nothing here dispatches a request or launches a process: §8's read-only-analysis carve-out is
// exactly this module. Terminalization — which recorded attempt IS a schedule position's
// outcome — is benchProtocol's reconstructMatrixState, shared with the matrix's own resume
// path, so scoring and resume can never disagree about replays, epilogues, or crash edges.
//
// Scoring, paired per run (§4.6): wallThroughput(r) = 3600 × files ÷ wall(r); per consuming
// bucket, bucketCeiling(r) = capacity × files ÷ units(r); T(r) = min over the terms — each run
// pairs ITS OWN wall with ITS OWN consumption, never mixed across runs. Score = median of T
// over K, worst-of-K beside it. `files` is the unit's full pinned workload size (read +
// no-read entries — every entry must reach its terminal state, G2), a per-unit constant, so
// within-unit driver ratios are invariant to the choice.

import type { BenchConfig } from "./benchConfig.ts";
import type { Corpus } from "./benchCorpus.ts";
import type { UnitWorkload } from "./benchWorkload.ts";
import type { DriverId, ScheduleRow } from "./benchSchedule.ts";
import { DRIVERS } from "./benchSchedule.ts";
import { reconstructMatrixState } from "./benchProtocol.ts";
import { judgeFidelity, reconstructFidelityLedger, type FidelityVerdict } from "./benchFidelity.ts";

export class BenchScoreError extends Error {
  constructor(message: string) {
    super(`BENCH SCORE: ${message}`);
    this.name = "BenchScoreError";
  }
}
const fail = (msg: string): never => {
  throw new BenchScoreError(msg);
};

// ---- typed row access (runs.jsonl rows arrive as parsed JSON objects) ------------------------
const rnum = (row: Record<string, unknown>, key: string): number => {
  const v = row[key];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`run row pos=${String(row["pos"])} carries no numeric ${key}`);
  return v as number;
};
const rstr = (row: Record<string, unknown>, key: string): string => {
  const v = row[key];
  if (typeof v !== "string") fail(`run row pos=${String(row["pos"])} carries no string ${key}`);
  return v as string;
};
const robj = (row: Record<string, unknown>, key: string): Record<string, unknown> => {
  const v = row[key];
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`run row pos=${String(row["pos"])} carries no object ${key}`);
  return v as Record<string, unknown>;
};

function bucketUsed(row: Record<string, unknown>, bucket: "core" | "graphql"): number {
  const deltas = robj(row, "bucketDeltas");
  const d = deltas[bucket];
  if (typeof d !== "object" || d === null) fail(`run row pos=${String(row["pos"])} carries no bucketDeltas.${bucket}`);
  const dd = d as Record<string, unknown>;
  // a terminal COMPLETE row always carries valid deltas (the engine flips straddled runs to
  // invalidated-straddle before they can terminalize) — enforce rather than assume
  if (dd["valid"] !== true || typeof dd["used"] !== "number")
    fail(`terminal complete row pos=${String(row["pos"])} carries an invalid ${bucket} delta — engine invariant violated`);
  return dd["used"] as number;
}

export const medianOf = (values: readonly number[]): number => {
  if (values.length === 0) fail("median of an empty list");
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

// ---- per-run scoring -------------------------------------------------------------------------
export interface ScoredRun {
  pos: number;
  unit: string;
  driver: DriverId;
  rep: number;
  epilogue: boolean;
  segments: number;
  acquisitionForm: string | null;
  wallMs: number;
  files: number;
  unitsCore: number; // authoritative consumption: max(bucket delta, harness-owned accounting) — §4.6.2 "the larger governs"
  unitsGraphql: number; // max(bucket delta, measured cost sum + 1-point imputations)
  wallThroughputPerHour: number;
  tScore: number; // at the pinned 5,000-point bucket capacity
  tScore15k: number; // the same data read off at a 15,000-point credential (§4.6)
  diskSampledPeakBytes: number;
  fallbackSpend: number;
  secondarySignals: number;
  httpBodyBytes: number;
  cloneObjectStoreBytes: number | null;
}

export function scoreRun(row: Record<string, unknown>, files: number, cfg: BenchConfig): ScoredRun {
  const wallMs = rnum(row, "wallMs");
  if (wallMs <= 0) fail(`run row pos=${String(row["pos"])} carries a nonpositive wall`);
  const points = robj(row, "points");
  const expected = robj(row, "expectedConsumption");
  const unitsCore = Math.max(bucketUsed(row, "core"), rnum(expected, "core"));
  const unitsGraphql = Math.max(bucketUsed(row, "graphql"), rnum(points, "measuredCostSum") + rnum(points, "imputed"));
  const wallThroughputPerHour = (3_600_000 * files) / wallMs;
  const t = (capacity: number): number => {
    let out = wallThroughputPerHour;
    // a bucket with zero consumption imposes no ceiling (§4.6)
    if (unitsCore > 0) out = Math.min(out, (capacity * files) / unitsCore);
    if (unitsGraphql > 0) out = Math.min(out, (capacity * files) / unitsGraphql);
    return out;
  };
  const cloneBytes = row["cloneObjectStoreBytes"];
  return {
    pos: rnum(row, "pos"), unit: rstr(row, "unit"), driver: rstr(row, "driver") as DriverId,
    rep: rnum(row, "rep"), epilogue: row["epilogue"] === true, segments: rnum(row, "segments"),
    acquisitionForm: typeof row["acquisitionForm"] === "string" ? (row["acquisitionForm"] as string) : null,
    wallMs, files, unitsCore, unitsGraphql, wallThroughputPerHour,
    tScore: t(cfg.budget.bucketCapacityPerHour),
    tScore15k: t(15_000),
    diskSampledPeakBytes: rnum(row, "diskSampledPeakBytes"),
    fallbackSpend: rnum(row, "fallbackSpend"),
    secondarySignals: rnum(row, "secondarySignals"),
    httpBodyBytes: rnum(row, "httpBodyBytes"),
    cloneObjectStoreBytes: typeof cloneBytes === "number" ? cloneBytes : null,
  };
}

// ---- gate verdicts (§4.7 G1–G4, global per driver) -------------------------------------------
export interface DriverGates {
  driver: DriverId;
  eligible: boolean;
  g1: "pass" | "fail";
  g2: "pass" | "fail";
  g3: "pass" | "fail";
  g4: "pass" | "warn" | "fail";
  g4AttributableSignals: number;
  reasons: string[]; // every disqualifying fact, human-readable — the §4.7 evidence attachment
  probeDivergenceFindings: Array<{ unit: string; pos: number; divergences: number }>; // first-class findings, not disqualifications
}

export interface UnitDriverCell {
  unit: string;
  driver: DriverId;
  runs: ScoredRun[]; // terminal complete main reps (epilogue rows for drifted units)
  failures: Array<{ pos: number; rep: number; cause: string }>;
  missingReps: number[];
  medianT: number | null;
  worstT: number | null;
  medianT15k: number | null;
  worstT15k: number | null; // §4.6: every bucket-size readoff reports median WITH worst-of-K (codex C0-R1 finding 19)
}

export interface UnitComparison {
  unit: string;
  pairs: Array<{ a: DriverId; b: DriverId; outcome: "tie" | "a" | "b"; ratio: number }>;
}

export type CaseMapping =
  | { kind: "dominator"; recommendation: DriverId }
  | { kind: "no-dominator"; recommendation: null }
  | { kind: "sole-eligible"; recommendation: DriverId }
  | { kind: "zero-eligible"; recommendation: null };

export interface TaxonomyEvents {
  r1r2RerunsUsed: number;
  r3Foreign: number;
  r4Straddles: number;
  controlPlaneInvalidations: number;
  r6DriftRestarts: number;
  epilogueRows: number;
  segmentedRuns: number;
}

export interface ScoreOutput {
  identity: { harnessCommit: string; envManifestHash: string };
  noiseBand: number;
  cells: UnitDriverCell[];
  gates: DriverGates[];
  eligible: DriverId[];
  comparisons: UnitComparison[];
  perRival: Record<DriverId, Record<DriverId, { wins: number; ties: number; losses: number }>>;
  dominators: DriverId[];
  caseMapping: CaseMapping;
  fidelity: FidelityVerdict;
  taxonomy: TaxonomyEvents;
}

export interface ScoreBundle {
  cfg: BenchConfig;
  corpus: Corpus;
  workloads: Map<string, UnitWorkload>;
  runsLines: readonly string[];
  fidelityLines: readonly string[];
  noiseBand: number; // the RATIFIED band (validated against pilot.json + the frozen formula by the loader)
  // the ratified frozen-surface digest: the fidelity ledger admits exactly this digest's
  // records — discovering the digest from the evidence itself would let a stale-only log pass
  // as current (codex C0-R1 finding 8)
  ratifiedDigest: string;
}

export function scoreMatrix(bundle: ScoreBundle): ScoreOutput {
  const { cfg, corpus, workloads, noiseBand } = bundle;
  const schedule = cfg.schedule ?? fail("bench-config.json carries no pinned schedule — nothing to score");
  const state = reconstructMatrixState(bundle.runsLines, null);
  if (state.matrixRowsSeen === 0) fail("runs.jsonl carries no matrix rows — run the matrix before scoring");
  const rowByPos = new Map<number, ScheduleRow>(schedule.rows.map((r) => [r.pos, r]));

  // raw matrix rows for the G4 signal census and the taxonomy table (invalidated and replaced
  // attempts still happened on the driver's own credential; §4.7's classifier excludes only
  // probe and pinning traffic)
  const allRows: Array<Record<string, unknown>> = [];
  for (const line of bundle.runsLines) {
    if (line.trim() === "") continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec["type"] === "run" && rec["phase"] === "matrix") allRows.push(rec);
    } catch {
      // non-JSON lines were already tolerated by reconstruction
    }
  }
  const firstRow = allRows[0];
  if (firstRow === undefined) fail("no matrix rows carry an identity");
  const identity: ScoreOutput["identity"] = { harnessCommit: rstr(firstRow!, "harnessCommit"), envManifestHash: rstr(firstRow!, "envManifestHash") };
  // every row must bind to the RATIFIED freeze: a re-ratified surface can never silently
  // consume a prior freeze's matrix (codex C0-R2 finding 2)
  for (const rec of allRows) {
    if (rec["frozenSurfaceDigest"] !== bundle.ratifiedDigest)
      fail(`matrix row pos=${String(rec["pos"])} is stamped ${String(rec["frozenSurfaceDigest"]).slice(0, 12)}… but the ratified digest is ${bundle.ratifiedDigest.slice(0, 12)}… — evidence from a different freeze`);
  }

  if (bundle.ratifiedDigest.length === 0) fail("scoring requires the ratified frozen-surface digest (codex C0-R1 finding 8)");
  const fidelity = judgeFidelity(corpus.fidelity, reconstructFidelityLedger(bundle.fidelityLines, bundle.ratifiedDigest));

  // ---- per-(unit × driver) cells over terminal rows ------------------------------------------
  const performanceUnits = corpus.performance.flatMap((slot) => slot.units.map((u) => u.unitId));
  const cells: UnitDriverCell[] = [];
  const cellIndex = new Map<string, UnitDriverCell>();
  for (const unit of performanceUnits) {
    for (const driver of DRIVERS) {
      const cell: UnitDriverCell = { unit, driver, runs: [], failures: [], missingReps: [], medianT: null, worstT: null, medianT15k: null, worstT15k: null };
      cells.push(cell);
      cellIndex.set(`${unit}|${driver}`, cell);
    }
  }
  const probeCompletion = new Map<number, "complete" | "failed" | "missing">();
  for (const schedRow of schedule.rows) {
    const workload = workloads.get(schedRow.unit) ?? fail(`no pinned workload for ${schedRow.unit}`);
    const files = workload.entries.length;
    const terminal = state.terminalRowByPos.get(schedRow.pos);
    if (schedRow.probe) {
      probeCompletion.set(schedRow.pos, terminal === undefined ? "missing" : (String(terminal["outcome"]) === "complete" ? "complete" : "failed"));
      continue;
    }
    const cell = cellIndex.get(`${schedRow.unit}|${schedRow.driver}`) ?? fail(`schedule names unpinned unit ${schedRow.unit}`);
    if (terminal === undefined) {
      cell.missingReps.push(schedRow.rep);
      continue;
    }
    if (String(terminal["outcome"]) === "complete") cell.runs.push(scoreRun(terminal, files, cfg));
    else cell.failures.push({ pos: schedRow.pos, rep: schedRow.rep, cause: String(terminal["failureCause"] ?? "unit failure") });
  }
  for (const cell of cells) {
    if (cell.runs.length === cfg.reps && cell.failures.length === 0) {
      cell.medianT = medianOf(cell.runs.map((r) => r.tScore));
      cell.worstT = Math.min(...cell.runs.map((r) => r.tScore));
      cell.medianT15k = medianOf(cell.runs.map((r) => r.tScore15k));
      cell.worstT15k = Math.min(...cell.runs.map((r) => r.tScore15k));
    }
  }

  // ---- gates ---------------------------------------------------------------------------------
  const gates: DriverGates[] = [];
  for (const driver of DRIVERS) {
    const g: DriverGates = {
      driver, eligible: false, g1: "pass", g2: "pass", g3: "pass", g4: "pass",
      g4AttributableSignals: 0, reasons: [], probeDivergenceFindings: [],
    };
    // POSITIVE misbehaviour evidence — observed byte divergence (g1Failures) and disk-envelope
    // breaches — is read over EVERY physical attempt, terminal or not: an invalidated or
    // replaced attempt's wrong bytes were still delivered by this driver, and invalidation
    // reasons (foreign consumption, straddles, snapshot failures) do not un-deliver them
    // (codex C0-R1 finding 10). ABSENCE-shaped evidence (g2Failures, unit failures) follows
    // the terminal/rerun discipline below — §4.5's R1/R2 rerun exists precisely to excuse a
    // network-caused incomplete attempt, so counting a replaced attempt's absences would
    // defeat the sanctioned rerun.
    for (const row of allRows) {
      if (rstr(row, "driver") !== driver) continue;
      const pos = rnum(row, "pos");
      const g1f = rnum(row, "g1Failures");
      if (g1f > 0) {
        g.g1 = "fail";
        g.reasons.push(`G1: ${g1f} delivery-fidelity failure(s) at pos ${pos} (${rstr(row, "unit")} rep ${rnum(row, "rep")}, outcome ${String(row["outcome"])})`);
      }
      const div = rnum(row, "probeDivergences");
      if (div > 0) g.probeDivergenceFindings.push({ unit: rstr(row, "unit"), pos, divergences: div });
      if (rnum(row, "diskSampledPeakBytes") > cfg.protocol.diskGateBytes) {
        g.g4 = "fail";
        g.reasons.push(`G4: sampled-peak disk ${rnum(row, "diskSampledPeakBytes")} B exceeds the ${cfg.protocol.diskGateBytes} B gate at pos ${pos} (outcome ${String(row["outcome"])})`);
      }
    }
    for (const [pos, row] of state.terminalRowByPos) {
      if (rstr(row, "driver") !== driver) continue;
      const g2f = rnum(row, "g2Failures");
      if (g2f > 0) {
        g.g2 = "fail";
        g.reasons.push(`G2: ${g2f} completeness failure(s) at pos ${pos} (${rstr(row, "unit")} rep ${rnum(row, "rep")})`);
      }
      // a terminal unit failure IS a completeness failure: the unit did not resolve its
      // workload — fallback-budget exhaustion and circuit-breaker aborts are the plan's own
      // named G2 examples (§4.7; codex C0-R1 finding 9)
      if (String(row["outcome"]) === "unit-failure") {
        g.g2 = "fail";
        g.reasons.push(`G2: terminal unit failure at pos ${pos} (${rstr(row, "unit")} rep ${rnum(row, "rep")}): ${String(row["failureCause"] ?? "?").slice(0, 160)}`);
      }
    }
    // every applicable checkout-config probe rep is completion-gated — missing evidence is
    // ineligibility, not a vacuous pass (§4.7 G1)
    for (const schedRow of schedule.rows) {
      if (!schedRow.probe || schedRow.driver !== driver) continue;
      const cs = probeCompletion.get(schedRow.pos) ?? "missing";
      if (cs !== "complete") {
        g.g1 = "fail";
        g.reasons.push(`G1: checkout-config probe rep at pos ${schedRow.pos} (${schedRow.unit}) is ${cs} — missing probe evidence disqualifies`);
      }
    }
    // the fidelity battery is gate-relevant and global (§4.2): observed mismatches are G1;
    // exhausted, pending, or skipped applicable cells are incomplete evidence — G2 (codex
    // C0-R1 finding 9's split)
    if (fidelity.mismatchDrivers.has(driver)) {
      g.g1 = "fail";
      for (const c of fidelity.failures.filter((c) => c.driver === driver && c.final === "fail-mismatch"))
        g.reasons.push(`G1: fidelity battery ${c.final} on ${c.kind} ${c.path}`);
    }
    if (fidelity.incompleteDrivers.has(driver)) {
      g.g2 = "fail";
      for (const c of [...fidelity.failures.filter((c) => c.final === "fail-exhausted"), ...fidelity.pendingRetry, ...fidelity.neverAttempted].filter((c) => c.driver === driver))
        g.reasons.push(`G2: fidelity battery cell ${c.kind} ${c.path} is ${c.final}`);
    }
    // G3 stability: all K reps of every performance unit complete under the rerun discipline
    for (const unit of performanceUnits) {
      const cell = cellIndex.get(`${unit}|${driver}`)!;
      if (cell.runs.length !== cfg.reps || cell.failures.length > 0) {
        g.g3 = "fail";
        g.reasons.push(`G3: ${unit} has ${cell.runs.length}/${cfg.reps} complete reps` +
          (cell.failures.length > 0 ? ` (${cell.failures.map((f) => `rep ${f.rep}: ${f.cause.slice(0, 120)}`).join("; ")})` : "") +
          (cell.missingReps.length > 0 ? ` (missing reps ${cell.missingReps.join(",")})` : ""));
      }
    }
    // G4 secondary-limit conduct: attributable = the driver's own non-probe matrix traffic,
    // across every attempt (replaced and invalidated attempts still ran on this credential)
    let signals = 0;
    for (const rec of allRows) {
      if (rstr(rec, "driver") !== driver || rec["probe"] === true) continue;
      signals += rnum(rec, "secondarySignals");
    }
    g.g4AttributableSignals = signals;
    if (signals >= cfg.protocol.g4.failAt) {
      g.g4 = "fail";
      g.reasons.push(`G4: ${signals} attributable secondary-limit signal(s) (fail at ${cfg.protocol.g4.failAt})`);
    } else if (signals > 0 && g.g4 !== "fail") {
      g.g4 = "warn";
      g.reasons.push(`G4 warning: ${signals} attributable secondary-limit signal(s) — pass with recorded warning`);
    }
    g.eligible = g.g1 === "pass" && g.g2 === "pass" && g.g3 === "pass" && g.g4 !== "fail";
    gates.push(g);
  }
  const eligible = gates.filter((g) => g.eligible).map((g) => g.driver);

  // ---- §4.7 comparison: per-unit win/tie/loss under the ratified band, then dominance --------
  const comparisons: UnitComparison[] = [];
  const perRival: ScoreOutput["perRival"] = {
    T0: { T0: z(), T1: z(), T2a: z(), T2c: z() }, T1: { T0: z(), T1: z(), T2a: z(), T2c: z() },
    T2a: { T0: z(), T1: z(), T2a: z(), T2c: z() }, T2c: { T0: z(), T1: z(), T2a: z(), T2c: z() },
  };
  for (const unit of performanceUnits) {
    const comparison: UnitComparison = { unit, pairs: [] };
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i]!;
        const b = eligible[j]!;
        const ta = cellIndex.get(`${unit}|${a}`)!.medianT ?? fail(`eligible driver ${a} lacks a median on ${unit} — G3 should have caught this`);
        const tb = cellIndex.get(`${unit}|${b}`)!.medianT ?? fail(`eligible driver ${b} lacks a median on ${unit}`);
        const ratio = Math.max(ta, tb) / Math.min(ta, tb);
        const outcome: "tie" | "a" | "b" = ratio <= noiseBand ? "tie" : ta > tb ? "a" : "b";
        comparison.pairs.push({ a, b, outcome, ratio });
        if (outcome === "tie") {
          perRival[a][b].ties++;
          perRival[b][a].ties++;
        } else if (outcome === "a") {
          perRival[a][b].wins++;
          perRival[b][a].losses++;
        } else {
          perRival[b][a].wins++;
          perRival[a][b].losses++;
        }
      }
    }
    comparisons.push(comparison);
  }
  const dominators = eligible.filter((d) =>
    eligible.every((rival) => rival === d || (perRival[d][rival].wins >= 1 && perRival[d][rival].losses === 0)));
  if (dominators.length > 1) fail(`${dominators.length} mutual dominators — the definition makes this impossible; scoring is broken`);

  const caseMapping: CaseMapping =
    eligible.length === 0
      ? { kind: "zero-eligible", recommendation: null }
      : eligible.length === 1
        ? { kind: "sole-eligible", recommendation: eligible[0]! }
        : dominators.length === 1
          ? { kind: "dominator", recommendation: dominators[0]! }
          : { kind: "no-dominator", recommendation: null };

  // ---- replay/invalidation taxonomy census (report evidence) ---------------------------------
  const taxonomy: TaxonomyEvents = {
    r1r2RerunsUsed: state.rerunUsed.size,
    r3Foreign: allRows.filter((r) => r["outcome"] === "invalidated-foreign").length,
    r4Straddles: allRows.filter((r) => r["outcome"] === "invalidated-straddle").length,
    controlPlaneInvalidations: allRows.filter((r) => r["outcome"] === "invalidated-control-plane").length,
    r6DriftRestarts: state.driftedUnits.size,
    epilogueRows: allRows.filter((r) => r["epilogue"] === true).length,
    segmentedRuns: allRows.filter((r) => typeof r["segments"] === "number" && (r["segments"] as number) > 1).length,
  };

  return { identity, noiseBand, cells, gates, eligible, comparisons, perRival, dominators, caseMapping, fidelity, taxonomy };
}

const z = (): { wins: number; ties: number; losses: number } => ({ wins: 0, ties: 0, losses: 0 });
