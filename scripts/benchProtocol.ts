// benchProtocol.ts — the run engine (resolution plan §4.5/§4.6/§4.8): per-run cold setup,
// worst-case budget reservation with bucket-aware admission, disk-sampler orchestration (the
// sampler itself lives in benchDiskSampler.ts), delivery verification against the pinned
// matrix, washout, reset-window straddle detection, and the runs.jsonl record shape. The pure decision pieces (WC formulas, segmentation, washout,
// straddle, verification) are exported for CI tests; the live engine composes them.

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, arch, cpus, platform, release } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AuditDb } from "./db.ts";
import { GithubClient, buildGitEnv } from "./github.ts";
import type { BenchConfig } from "./benchConfig.ts";
import { restFallbackBudgetFor } from "./benchConfig.ts";
import type { Corpus, PerformanceSlot, CorpusUnit } from "./benchCorpus.ts";
import { findUnit } from "./benchCorpus.ts";
import { packBatches, planRounds } from "./benchT1.ts";
import {
  DriftSignal, RePinRequired, UnitFailure, probeLiveHead, runDriver,
  type AcquisitionForm, type DriverRunContext, type DriverRunOutcome, type EntryDelivery,
} from "./benchDrivers.ts";
import {
  BenchHttpError, makeBuckets, outstandingHorizonMs, readRateLimit,
  type BenchGhContext, type BenchHttpAttemptRecord, type RateLimitSnapshot,
} from "./benchGh.ts";
import { seamStringSha256, type UnitWorkload } from "./benchWorkload.ts";
import { WorkerDiskSampler, type DiskSamplerPort, type DiskSnapshot } from "./benchDiskSampler.ts";
import type { DriverId } from "./benchSchedule.ts";
import type { BenchSpawnRecord } from "./benchSpawn.ts";

export class BenchProtocolError extends Error {
  // typed discriminant: the engine's R5 classification must never ride a message regex (the
  // same rule §4.5 imposes on the rerun predicate)
  readonly code: "r5-breach" | null;
  constructor(message: string, code: "r5-breach" | null = null) {
    super(`BENCH PROTOCOL: ${message}`);
    this.name = "BenchProtocolError";
    this.code = code;
  }
}

// ---- §4.8 worst-case reservation -------------------------------------------------------------
export interface WorstCase {
  core: number;
  graphql: number; // in P_max-bounded points
  plannedBatches: number;
}
export function computeWorstCase(driver: DriverId, workload: UnitWorkload, cfg: BenchConfig, slot: { owner: string; repo: string }): WorstCase {
  const reads = workload.entries.filter((e) => e.read).length;
  const budget = restFallbackBudgetFor(cfg, workload.entries.length);
  const cap = cfg.rest.attemptCap;
  const fixed = cfg.budget.fixedPerRunOverheadRequests;
  // ONE SHA-classifier allowance (§4.4's pinned-object probe is its own attempt loop): a 404'd
  // fallback plus its classifier can consume attemptCap extra requests beyond the fallback's own
  // — reserve it or the true worst case trips a false R5 (codex R1 finding 24)
  const classifier = cap;
  if (driver === "T0") {
    // a truncated tree routes T0 to the production checkout-clone fallback: the tree request
    // plus REST fallbacks only — content reads are local (§4.2 C4)
    if (workload.truncatedTree) return { core: (1 + budget) * cap + classifier + fixed, graphql: 0, plannedBatches: 0 };
    // per-file REST + the tree request + the fallback budget, all under the attempt cap
    return { core: (reads + 1 + budget) * cap + classifier + fixed, graphql: 0, plannedBatches: 0 };
  }
  if (driver === "T2a" && workload.escapeTripped && !workload.truncatedTree) {
    return { core: (reads + 1 + budget) * cap + classifier + fixed, graphql: 0, plannedBatches: 0 };
  }
  if (driver === "T1") {
    if (workload.truncatedTree) return { core: (1 + budget) * cap + classifier + fixed, graphql: 0, plannedBatches: 0 };
    const plan = planRounds(workload);
    let plannedBatches = 0;
    for (const round of [plan.round1, plan.round2]) {
      if (round.length === 0) continue;
      plannedBatches += packBatches(round, cfg, { owner: slot.owner, repo: slot.repo, sha: workload.sha, roundLabel: "wc" }).length;
    }
    const graphql = plannedBatches * (1 + cfg.t1.split.maxDescendantsPerOriginal) * cap * cfg.budget.pMaxPointsPerGraphqlAttempt;
    return { core: (1 + budget) * cap + classifier + fixed, graphql, plannedBatches };
  }
  // clone drivers: no REST content, no REST tree — the fallback budget plus the classifier
  return { core: budget * cap + classifier + fixed, graphql: 0, plannedBatches: 0 };
}

// §4.8 feasibility gate: segments of the T0-shaped workload, each satisfying
// WC × headroom ≤ bucket capacity. Deterministic, contiguous, pinned by formula.
export function planSegments(driver: DriverId, workload: UnitWorkload, cfg: BenchConfig, slot: { owner: string; repo: string }): number[] {
  const wc = computeWorstCase(driver, workload, cfg, slot);
  const capacity = cfg.budget.bucketCapacityPerHour;
  if (wc.core * cfg.budget.headroomFactor <= capacity) return [workload.entries.filter((e) => e.read).length];
  const perFileRestShape = (driver === "T0" || (driver === "T2a" && workload.escapeTripped)) && !workload.truncatedTree;
  if (!perFileRestShape) {
    throw new BenchProtocolError(`WC exceeds bucket capacity for ${driver} — only the per-file REST shape segments`);
  }
  const reads = workload.entries.filter((e) => e.read).length;
  const budget = restFallbackBudgetFor(cfg, workload.entries.length);
  // − tree − fallback budget − the SHA-classifier allowance (one attempt-loop equivalent)
  const perSegment = Math.floor(capacity / (cfg.budget.headroomFactor * cfg.rest.attemptCap)) - 1 - budget - 1;
  if (perSegment < 1) throw new BenchProtocolError("segmentation cannot satisfy the reservation guard (per-segment allowance < 1)");
  const segments: number[] = [];
  let remaining = reads;
  while (remaining > 0) {
    const take = Math.min(perSegment, remaining);
    segments.push(take);
    remaining -= take;
  }
  return segments;
}

// ---- washout + straddle ----------------------------------------------------------------------
export function washoutMs(cfg: BenchConfig, horizonUntilMs: number, nowMs: number): number {
  return Math.max(cfg.protocol.washoutFloorMs, horizonUntilMs - nowMs);
}
export interface BucketDelta {
  valid: boolean; // false = the run straddled a reset window (R4: invalid, replay in slot)
  used: number | null;
}
// §4.6 item 2 with GitHub's observed reset semantics: a PARTIALLY-consumed bucket's reset epoch is
// fixed for the window, so equal epochs ⇒ a subtraction-valid delta. A FULL, untouched bucket
// FLOATS its reset (now + window) until the first consumption opens the window — measured live:
// epoch equality is unsatisfiable when a run starts on a full bucket. When before.used === 0
// the run itself opened the window, so nothing prior can be misattributed and after.used is TAKEN
// AS the run's own consumption — the check is used === 0 alone, with no timestamp, so it trusts
// that a minutes-long run does not span a SECOND reset rather than proving it. Everything
// else — a consumed bucket whose epoch changed under the run — is the straddle R4 invalidates.
export function bucketDelta(before: { remaining: number; reset: number; used: number }, after: { remaining: number; reset: number; used: number }): BucketDelta {
  if (before.reset === after.reset) return { valid: true, used: Math.max(0, before.remaining - after.remaining) };
  // NOTE: if a SECOND reset lands mid-run, after.used undercounts — conservative for R3 (an
  // undercount can never flag foreign consumption falsely) and irrelevant to R5, which runs on
  // live harness-side counts, not deltas.
  if (before.used === 0) return { valid: true, used: after.used };
  return { valid: false, used: null };
}

// ---- delivery verification (§4.6 item 6 fidelity + G2 completeness bookkeeping) -------------------
export interface VerificationReport {
  resolved: number;
  g1Failures: Array<{ path: string; route: string; reason: string }>;
  g2Failures: Array<{ path: string; reason: string }>;
  // checkout-config probe reps: a caveat-route divergence from the pinned baseline is a
  // FIRST-CLASS FINDING for the decision-maker, never an auto-disqualification (§4.7 G1);
  // primary-route divergence under the probe stays a G1 failure (T2a gets no shelter).
  probeDivergences: Array<{ path: string; route: string }>;
  routesDelivered: Record<string, number>;
}
export interface VerifyOptions {
  probeRep?: boolean;
  acquiredPaths?: ReadonlySet<string>; // content-acquisition events — no-read routes must show ZERO
}
export function verifyDeliveries(workload: UnitWorkload, deliveries: readonly EntryDelivery[], driver: DriverId, opts: VerifyOptions = {}): VerificationReport {
  const report: VerificationReport = { resolved: 0, g1Failures: [], g2Failures: [], probeDivergences: [], routesDelivered: {} };
  // raw-capable primary routes (§4.3): T1's hash-validated text and T2c's pre-decode frames
  // must carry rawVerified — a delivery claiming those routes without it fails G1
  const rawCapablePrimary = driver === "T1" || driver === "T2c";
  const byPath = new Map<string, EntryDelivery[]>();
  for (const d of deliveries) {
    const list = byPath.get(d.path) ?? [];
    list.push(d);
    byPath.set(d.path, list);
  }
  for (const entry of workload.entries) {
    const expectation = workload.routes[entry.path]?.[driver];
    if (expectation === undefined) {
      report.g2Failures.push({ path: entry.path, reason: "no pinned expectation" });
      continue;
    }
    const got = byPath.get(entry.path) ?? [];
    if (got.length !== 1) {
      report.g2Failures.push({ path: entry.path, reason: `delivered ${got.length} times (expected exactly once)` });
      continue;
    }
    const d = got[0]!;
    report.routesDelivered[d.route] = (report.routesDelivered[d.route] ?? 0) + 1;
    const permitted = new Set<string>([expectation.primary, ...expectation.permittedFallbacks]);
    if (!permitted.has(d.route)) {
      report.g2Failures.push({ path: entry.path, reason: `delivered via ${d.route}, outside the pinned permitted set {${[...permitted].join(", ")}}` });
      continue;
    }
    const expected = expectation.expected[d.route];
    if (expected === undefined) {
      report.g2Failures.push({ path: entry.path, reason: `route ${d.route} carries no typed expectation` });
      continue;
    }
    if ("nonAcquisition" in expected) {
      if (d.delivered !== null) {
        report.g1Failures.push({ path: entry.path, route: d.route, reason: "content acquired on a no-read route" });
      } else if (opts.acquiredPaths !== undefined && opts.acquiredPaths.has(entry.path)) {
        // instrumentation must PROVE zero acquisition (§4.3): a discarded body still fails
        report.g1Failures.push({ path: entry.path, route: d.route, reason: "acquisition event observed for a no-read route" });
      } else {
        report.resolved++;
      }
      continue;
    }
    if (d.delivered === null) {
      report.g2Failures.push({ path: entry.path, reason: `route ${d.route} delivered nothing` });
      continue;
    }
    const gotHash = seamStringSha256(d.delivered);
    if (gotHash !== expected.seamSha256) {
      if (opts.probeRep === true && expectation.declaredCaveat) {
        // the caveat waiver is EXACTLY the config delta (§4.7 G1): recorded, not disqualifying
        report.probeDivergences.push({ path: entry.path, route: d.route });
        report.resolved++;
      } else {
        report.g1Failures.push({ path: entry.path, route: d.route, reason: `seam-string sha256 mismatch (${gotHash.slice(0, 12)}… != ${expected.seamSha256.slice(0, 12)}…)` });
      }
      continue;
    }
    if (rawCapablePrimary && d.route === "primary" && d.rawVerified !== true) {
      report.g1Failures.push({ path: entry.path, route: d.route, reason: "raw-capable primary route delivered without pre-decode verification" });
      continue;
    }
    report.resolved++;
  }
  for (const [path, list] of byPath) {
    if (workload.routes[path] === undefined)
      report.g2Failures.push({ path, reason: `delivered ${list.length}× but absent from the pinned workload` });
  }
  return report;
}

// ---- disk sampler ----------------------------------------------------------------------------
// Moved to benchDiskSampler.ts: the §4.6 peak-disk walk now runs OFF the measured thread, so it
// no longer BLOCKS the wall term it is measured against. Residual cross-thread CPU/disk
// contention remains and is declared in the plan's §4.6 amendment — not eliminated.

// ---- environment manifest (§8) ---------------------------------------------------------------
export interface EnvManifest {
  os: string;
  osVersion: string;
  archName: string;
  hardwareIdHash: string;
  gitVersion: string;
  ghVersion: string;
  bunVersion: string;
  networkDescription: string;
  credentialType: string;
  login: string;
  harnessCommit: string;
}
// §8 binds every timed row to an environment manifest whose HASH resume compares. An unchecked
// version probe that returned "" made that binding quietly weaker than it reads, so a blank
// version is refused rather than recorded.
export function requireToolVersion(tool: string, res: { exitCode: number; stdout: string; stderr: string }): string {
  if (res.exitCode !== 0)
    throw new BenchProtocolError(`${tool} --version failed (exit ${res.exitCode}): ${res.stderr.trim().slice(0, 200)} — the §8 environment manifest must record a real toolchain`);
  const line = res.stdout.split("\n")[0]?.trim() ?? "";
  if (line === "")
    throw new BenchProtocolError(`${tool} --version reported no version — the §8 environment manifest must record a real toolchain`);
  return line;
}

export async function buildEnvManifest(client: GithubClient, opts: { login: string; harnessCommit: string; networkDescription: string; credentialType: string }): Promise<EnvManifest> {
  const git = requireToolVersion("git", await client.git(["--version"]));
  const gh = requireToolVersion("gh", await client.gh(["--version"]));
  const cpuModel = cpus()[0]?.model ?? "unknown";
  return {
    os: platform(),
    osVersion: release(),
    archName: arch(),
    hardwareIdHash: createHash("sha256").update(`${hostname()}|${cpuModel}|${cpus().length}`).digest("hex").slice(0, 16),
    gitVersion: git,
    ghVersion: gh,
    bunVersion: Bun.version,
    networkDescription: opts.networkDescription,
    credentialType: opts.credentialType,
    login: opts.login,
    harnessCommit: opts.harnessCommit,
  };
}

// ---- runs.jsonl records ----------------------------------------------------------------------
export interface RunRecord {
  type: "run";
  schemaVersion: 1;
  pos: number;
  unit: string;
  driver: DriverId;
  rep: number;
  probe: boolean;
  phase: "pilot" | "matrix" | "fidelity";
  epilogue: boolean; // R6 branch-arm restart rows (scaffolding form), distinct from main rows
  acquisitionForm: AcquisitionForm | null;
  startedAtIso: string;
  wallMs: number; // workload start → unit slot release, teardown included (§4.6 item 1)
  segments: number;
  // "invalidated-finalisation": the run was measured and reclaimed, but post-run accounting (the
  // rate-limit read) failed. The wall stands; the consumption figures do not, so the row is
  // invalid for scoring — recorded rather than dropped, since silently losing a completed
  // measurement is worse than recording one that cannot be scored.
  outcome: "complete" | "unit-failure" | "invalidated-straddle" | "invalidated-foreign" | "invalidated-finalisation" | "halt-r5-breach" | "drift-restart" | "re-pin-required";
  failureCause: string | null;
  // typed R1/R2 evidence (§4.5): the rerun predicate reads THIS, never a message regex
  failureEvidence: { kind: "http"; code: string; lastClassification: string | null; requestClass: string | null } | { kind: "unit" } | null;
  requests: Record<string, number>;
  okRequestClasses: string[]; // §4.5 R2 ledger input: classes with ≥1 SUCCESSFUL attempt
  attempts: { fivexx: number; retries: number; secondaryByKind: Record<string, number> };
  secondarySignals: number; // attributable (driver-own matrix traffic) — G4's classifier input
  points: { measuredCostSum: number; imputed: number };
  bucketDeltas: { core: BucketDelta; graphql: BucketDelta };
  // the raw before/after snapshots per segment — R3/R4 classifications stay auditable (R2 f.28)
  bucketSnapshots: Array<{ before: RateLimitSnapshot; after: RateLimitSnapshot }>;
  expectedConsumption: { core: number; graphql: number }; // harness-owned accounting (R3's input)
  replayOfPos: number | null; // in-slot replays record their physical predecessor (§4.5)
  replayKind: "r1r2" | "r3r4" | null; // only r1r2 charges the driver allowance (codex R2 f.23)
  // null = reclamation had not yet been attempted when this record landed (only the R5 halt
  // path, whose record must be durable before any fallible work — including reclamation)
  diskReclaimFailed: boolean | null;
  probeDivergences: number;
  httpBodyBytes: number;
  cloneObjectStoreBytes: number | null;
  diskSampledPeakBytes: number;
  diskSamples: number;
  // non-null when the disk instrumentation itself failed: the row still stands (its wall and
  // consumption are unaffected), but its disk fields are degraded and must not be read as measured
  diskSampleError: string | null;
  fallbackSpend: number;
  routesDelivered: Record<string, number>;
  g1Failures: number;
  g2Failures: number;
  // §4.7 disqualification evidence must be auditable from the committed log, not just counted:
  // the first DETAIL_CAP verification failures/divergences ride the row (counts above are exact)
  g1Details: Array<{ path: string; route: string; reason: string }>;
  g2Details: Array<{ path: string; reason: string }>;
  probeDivergenceDetails: Array<{ path: string; route: string }>;
  // §4.6 item 5 evidence for the GIT side (the HTTP side rides `attempts`): spawn counts by
  // lane, timeouts, non-zero exits, and children that never settled
  spawns: SpawnStats;
  // §4.4's "the conflict recorded" and the timed-out-then-split aliases were computed by the
  // analyzer and then discarded — these counters make both durable per run
  t1Conflicts: number;
  t1BodyTimeouts: number;
  washoutAppliedMs: number;
  envManifestHash: string;
  harnessCommit: string; // per-row provenance stamp (§8); the CONTENT binding is the digest below
  // the §8 frozen-surface digest this row was produced under — resume's content binding: an
  // evidence-only or test-only commit moves HEAD but not the digest, and must not orphan rows
  frozenSurfaceDigest: string | null;
}

// bounded detail retention for the record — counts stay exact, details are evidence samples
export const DETAIL_CAP = 20;

export interface SpawnStats {
  total: number;
  timedOut: number;
  nonZeroExit: number;
  neverSettled: number;
  byLane: Record<string, number>;
}
export function summarizeSpawns(records: readonly BenchSpawnRecord[]): SpawnStats {
  const s: SpawnStats = { total: 0, timedOut: 0, nonZeroExit: 0, neverSettled: 0, byLane: {} };
  for (const r of records) {
    s.total++;
    s.byLane[r.lane] = (s.byLane[r.lane] ?? 0) + 1;
    if (r.timedOut) s.timedOut++;
    if (r.exitCode === null) s.neverSettled++;
    else if (r.exitCode !== 0) s.nonZeroExit++;
  }
  return s;
}

export class RunsLog {
  constructor(private readonly path: string, readonly manifest: EnvManifest) {}
  appendMarker(marker: Record<string, unknown>): void {
    appendFileSync(this.path, `${JSON.stringify(marker)}\n`);
  }
  // The environment hash deliberately EXCLUDES harnessCommit: the §8 source binding is the
  // frozen-surface digest (content-addressed), and folding the commit into this hash made an
  // evidence-only or test-only commit — which changes HEAD but not the frozen surface — orphan
  // every prior row on resume. The commit itself is still stamped per row as provenance.
  envManifestHash(): string {
    const { harnessCommit: _provenanceOnly, ...environment } = this.manifest;
    return createHash("sha256").update(JSON.stringify(environment)).digest("hex").slice(0, 16);
  }
  writeManifestOnce(): void {
    appendFileSync(this.path, `${JSON.stringify({ type: "env-manifest", schemaVersion: 1, ...this.manifest, hash: this.envManifestHash() })}\n`);
  }
  append(record: RunRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }
}

// active-wall accounting: segment sleeps are excluded from the wall term (§4.6 item 1/§4.7 —
// dropping the wall for segmented runs would make segmentation a scoring exploit, so the wall
// is the SUM of active segments).
export interface TrafficSummary {
  requests: Record<string, number>;
  // classes with at least one SUCCESSFUL attempt — §4.5 R2's ledger input ("succeeded in at
  // least one other repetition"): `requests` counts recorded attempts that are neither cache-served
  // nor rest-meta control-plane probes, failures included, and a
  // completed run can contain a class that only ever failed (e.g. every batch drained to
  // batch-error-fallback), which must not authorize an R2 replay. TWO sources feed it: the
  // record classification (an "ok"/"not-modified" the envelope supports), and the caller's
  // table-accepted classes — a partial-data 200 is classification "fatal" on every record
  // (production drops partial data BY DESIGN) while the frozen T1 table delivers its resolved
  // aliases, and omitting that success denied R2 replays to genuinely-working classes
  okRequestClasses: string[];
  attempts: { fivexx: number; retries: number; secondaryByKind: Record<string, number> };
  points: { measuredCostSum: number; imputed: number };
  secondarySignals: number;
  httpBodyBytes: number;
}

// The place the control-plane exclusion is expressed FOR RECORDED TRAFFIC SUMMARIES. Cache-served
// attempts crossed no wire, and rest-meta probes are the harness's own book-keeping — neither is
// driver evidence (§4.6). Every run record that HAS traffic to summarise — the normal, the
// finalisation-failure and the R5 halt records — derives its figures here so the rule cannot
// drift between them; the PRE-REP drift-restart record hardcodes empty counters instead, having
// measured nothing (a DriftSignal raised mid-run takes the normal tail and DOES summarise here). It is NOT the only expression of the rest-meta rule in this module either: live R5
// accounting and R3 foreign-consumption reconciliation each re-encode it against their own scans.
export function summarizeTraffic(httpRecords: readonly BenchHttpAttemptRecord[], tableAcceptedClasses: readonly string[] = []): TrafficSummary {
  const requests: Record<string, number> = {};
  const okClasses = new Set<string>(tableAcceptedClasses);
  const attempts = { fivexx: 0, retries: 0, secondaryByKind: {} as Record<string, number> };
  let measuredCostSum = 0;
  let imputed = 0;
  let secondarySignals = 0;
  let httpBodyBytes = 0;
  for (const r of httpRecords) {
    if (r.servedFromCache) continue;
    if (r.requestClass === "rest-meta") continue;
    requests[r.requestClass] = (requests[r.requestClass] ?? 0) + 1;
    // benchT1's truncated-transfer rule, mirrored for the ledger: a success-shaped GraphQL
    // envelope from a gh that exited nonzero is transport-failure evidence (the analyzer
    // retries that dispatch, never accepts its content), so its record must not mint an
    // R2-authorizing success. REST cannot reach here in that state — benchGh throws
    // truncated-transfer before any "ok" REST record exists.
    if ((r.classification === "ok" || r.classification === "not-modified") && !(r.kind === "graphql" && r.exitCode !== 0))
      okClasses.add(r.requestClass);
    httpBodyBytes += r.bodyBytes;
    if (r.status >= 500) attempts.fivexx++;
    if (r.attempt > 1) attempts.retries++;
    if (r.kind === "graphql") {
      if (r.pointsCost !== null) measuredCostSum += r.pointsCost;
      else imputed += 1;
    }
    if (r.secondarySignal !== null) {
      secondarySignals++;
      attempts.secondaryByKind[r.secondarySignal] = (attempts.secondaryByKind[r.secondarySignal] ?? 0) + 1;
    }
  }
  return { requests, okRequestClasses: [...okClasses].sort(), attempts, points: { measuredCostSum, imputed }, secondarySignals, httpBodyBytes };
}

// The end of a measured run, in the order §4.6 actually licenses.
//
// Reclamation is INSIDE the clock on purpose: production holds the unit slot through synchronous
// reclamation, so stopping at the last resolved entry would structurally favour clone drivers,
// whose teardown is the expensive one (§4.6 item 1). Instrumentation is a different animal — §4.6
// mandates COLLECTING disk data, never charging its collection to the wall — and charging it
// biased the comparison toward whichever driver materialised fewer files.
export async function finishMeasuredRun(opts: {
  wall: WallClock;
  sampler: { finish: () => Promise<DiskSnapshot> };
  reclaim: () => boolean;
}): Promise<{ wallMs: number; disk: DiskSnapshot; diskReclaimFailed: boolean }> {
  opts.wall.pause();
  const disk = await opts.sampler.finish(); // sampled before reclamation removes what it measures
  opts.wall.start();
  const diskReclaimFailed = opts.reclaim();
  return { wallMs: opts.wall.stop(), disk, diskReclaimFailed };
}

// Per-run resource reclamation, run by every exit path ONCE THE RUN-CACHE DB IS OPEN (normal,
// drift-restart, and the throws that escape before the driver's try-block). The one earlier exit
// — a throw from AuditDb.open itself — runs at its own call site instead, and sweeps only the DB
// file and its sidecars: it leaves the already-created runDir behind. The run cache DB is
// documented as "one file per
// run, deleted at teardown", so a path that returns without closing it leaks both the handle and
// its -wal/-shm sidecars while the emitted record still claims a clean reclaim.
// Returns whether anything failed to reclaim — verified, never assumed (finding 18).
export function reclaimRunResources(
  db: { close: () => void },
  runDir: string,
  dbPath: string,
  // seam for CI: lets a test drive the case where removal SILENTLY fails to remove, which is the
  // only case the post-removal verification below actually exists to catch
  io: { rm: (path: string, opts: { recursive?: boolean; force: boolean }) => void } = { rm: rmSync },
): boolean {
  let failed = false;
  try {
    db.close();
  } catch {
    failed = true; // a close failure must not mask the run outcome, but it IS a reclaim failure
  }
  try {
    io.rm(runDir, { recursive: true, force: true });
    for (const suffix of ["", "-wal", "-shm"]) io.rm(`${dbPath}${suffix}`, { force: true });
  } catch {
    failed = true;
  }
  if (existsSync(runDir)) failed = true;
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${dbPath}${suffix}`)) failed = true;
  return failed;
}

// The PRIMARY scored metric accumulates through this clock, so its time source must be
// monotonic: the engine's default is performance.now(), never the system clock — an NTP step
// or manual clock adjustment mid-run would otherwise stretch, shrink, or negate exactly one
// driver's wall. (Epoch time is still used where epochs are the point: ISO stamps and
// reset-epoch arithmetic.)
export class WallClock {
  private activeMs = 0;
  private startedAt: number | null = null;
  constructor(private readonly now: () => number) {}
  start(): void {
    if (this.startedAt === null) this.startedAt = this.now();
  }
  pause(): void {
    if (this.startedAt !== null) {
      this.activeMs += this.now() - this.startedAt;
      this.startedAt = null;
    }
  }
  stop(): number {
    this.pause();
    return this.activeMs;
  }
}

// ---- the live engine -------------------------------------------------------------------------
export interface EngineOptions {
  cfg: BenchConfig;
  corpus: Corpus;
  workloads: Map<string, UnitWorkload>; // unitId → pinned workload
  benchRoot: string;
  artifactsDir: string;
  // per-run cache DBs live here — inside the repo's §0-permitted ./data root (AuditDb's write
  // containment demands it; the bench temp root is NOT a permitted sqlite home), one file per
  // run, deleted at teardown. NEVER the production sqlite path.
  runCacheDir: string;
  runsLog: RunsLog;
  // the §8 frozen-surface digest rows are stamped with (null before ratification — the pilot);
  // resume binds matrix rows to THIS, not to the commit
  frozenSurfaceDigest: string | null;
  client: GithubClient; // meta traffic (rate_limit, env manifest probes); drivers get their own per-run client
  makeClient: (db: AuditDb | null) => GithubClient;
  // seam for CI: the default samples disk off-thread, which a test cannot drive deterministically
  makeDiskSampler?: () => DiskSamplerPort;
  log: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// a tiny counting pool for T2c's unit-lived children — fixed size, independent of unit fan-out
// (plan §3.1); the serial protocol never queues, but the seam is the deliverable's shape.
export function makeChildPool(size: number): { acquire(): Promise<() => void> } {
  let available = size;
  const waiters: Array<() => void> = [];
  return {
    async acquire(): Promise<() => void> {
      if (available > 0) available--;
      else await new Promise<void>((resolve) => waiters.push(resolve));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = waiters.shift();
        if (next !== undefined) next();
        else available++;
      };
    },
  };
}

export interface RunHandle {
  outcome: DriverRunOutcome | null;
  verification: VerificationReport | null;
  record: RunRecord;
}

export class BenchEngine {
  private readonly o: EngineOptions;
  private readonly childPool = { pool: null as null | { acquire(): Promise<() => void> } };
  private readonly manifestHash: string;
  private runCounter = 0;
  // §4.4: the acquisition form is decided at a unit's FIRST clone-involving rep and FROZEN for
  // the unit; a later drift under the production form is R6's restart, never a silent switch
  // (codex R1 finding 10)
  private readonly unitForms = new Map<string, AcquisitionForm>();
  private replayOfPos: number | null = null;
  private replayKind: "r1r2" | "r3r4" | null = null;
  private epilogueMode = false;
  setEpilogueMode(on: boolean): void {
    this.epilogueMode = on;
  }
  setReplayOf(pos: number | null, kind: "r1r2" | "r3r4" | null = null): void {
    this.replayOfPos = pos;
    this.replayKind = pos === null ? null : kind;
  }
  harnessCommit(): string {
    return this.o.runsLog.manifest.harnessCommit;
  }
  envManifestHashValue(): string {
    return this.manifestHash;
  }
  // resume support: restore the per-unit frozen acquisition forms reconstructed from durable
  // records (codex R2 f.20)
  restoreUnitForms(forms: ReadonlyMap<string, AcquisitionForm>): void {
    for (const [unit, form] of forms) this.unitForms.set(unit, form);
  }
  // resume support: the caller COMPLETES an interrupted washout (sleep, then this marker) —
  // §4.5's separation is satisfied without re-running an attempt that already measured
  appendLogMarker(marker: Record<string, unknown>): void {
    this.o.runsLog.appendMarker(marker);
  }
  constructor(o: EngineOptions) {
    this.o = o;
    this.manifestHash = o.runsLog.envManifestHash();
  }
  // EPOCH time, deliberately distinct from the WallClock's monotonic source: this feeds ISO
  // stamps and reset-epoch arithmetic, where epoch semantics are the point. The scored wall
  // never accumulates through this (see the WallClock construction in runOne).
  private now(): number {
    return (this.o.now ?? Date.now)();
  }
  private sleep(ms: number): Promise<void> {
    return (this.o.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms);
  }

  // §4.8: print WC, check headroom, sleep to the reset epoch when short — never inside a run.
  private async reserve(gh: BenchGhContext, wc: WorstCase): Promise<void> {
    for (;;) {
      const snap = await readRateLimit(gh);
      const needCore = wc.core * this.o.cfg.budget.headroomFactor;
      const needGraphql = wc.graphql * this.o.cfg.budget.headroomFactor;
      this.o.log(`WC reserve: core ${wc.core} (need ${Math.ceil(needCore)}, have ${snap.core.remaining}), graphql ${wc.graphql} (need ${Math.ceil(needGraphql)}, have ${snap.graphql.remaining})`);
      if (needCore > this.o.cfg.budget.bucketCapacityPerHour || needGraphql > this.o.cfg.budget.bucketCapacityPerHour)
        throw new BenchProtocolError("WC × headroom exceeds full bucket capacity — this run requires segmented mode");
      if (snap.core.remaining >= needCore && snap.graphql.remaining >= needGraphql) return;
      const resetMs = Math.max(snap.core.reset, snap.graphql.reset) * 1000 + 5_000 - this.now();
      const wait = Math.max(resetMs, 30_000);
      this.o.log(`headroom short — sleeping ${Math.ceil(wait / 1000)}s to the reset epoch`);
      await this.sleep(wait);
    }
  }

  async runOne(row: { pos: number; unit: string; driver: DriverId; rep: number; probe: boolean }, phase: "pilot" | "matrix"): Promise<RunHandle> {
    const cfg = this.o.cfg;
    const { slot, unit } = findUnit(this.o.corpus, row.unit);
    const workload = this.o.workloads.get(row.unit) ?? ((): never => {
      throw new BenchProtocolError(`no pinned workload for ${row.unit}`);
    })();
    this.runCounter++;
    const runDir = join(this.o.benchRoot, `run-${String(row.pos).padStart(4, "0")}-${row.driver}-r${row.rep}${row.probe ? "p" : ""}-a${this.runCounter}`);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(this.o.runCacheDir, { recursive: true });
    // collision-resistant durable attempt identity (pid + wall clock): a crashed process's
    // counter can never resurrect a warm cache; purgeCache drops api_cache rows outright
    // (production --fresh preserves them by design) (codex R2 f.24)
    const dbPath = join(this.o.runCacheDir, `bench-run-${String(row.pos).padStart(4, "0")}-${row.driver}-r${row.rep}${row.probe ? "p" : ""}-${process.pid}-${this.now()}-${this.runCounter}.sqlite`);
    // the open itself can CREATE the file and then fail (WAL/schema initialisation, ENOSPC):
    // nothing downstream owns the path yet — reclaimOnce and the outer finally both live past
    // this line — so a mid-initialisation throw must sweep its own debris here, with the path
    // in the operator's face, before rethrowing
    let db: AuditDb;
    try {
      db = AuditDb.open({ sqlitePath: dbPath, fresh: true, purgeCache: true });
    } catch (openErr) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(`${dbPath}${suffix}`, { force: true });
        } catch {
          // best-effort — the log below names the path either way
        }
      }
      this.o.log(`${row.unit} ${row.driver} rep${row.rep}: run-cache DB failed to initialise (${openErr instanceof Error ? openErr.message : String(openErr)}) — swept ${dbPath}[-wal/-shm] best-effort before rethrowing`);
      throw openErr;
    }
    // The run's resources are owned from HERE, not from the driver's try-block. Several paths
    // leave before that block — the mid-unit drift restart, and throws from probeLiveHead /
    // reserve / the pre-run rate-limit read / planning — and each previously leaked the open
    // handle plus its -wal/-shm sidecars while the emitted record still claimed a clean reclaim.
    // Idempotent so the scored teardown can run it and the outer finally stays a no-op.
    let reclaimed = false;
    const reclaimOnce = (): boolean => {
      if (reclaimed) return false;
      reclaimed = true;
      return reclaimRunResources(db, runDir, dbPath);
    };
    try {
    const client = this.o.makeClient(db);
    const httpRecords: BenchHttpAttemptRecord[] = [];
    const spawnRecords: BenchSpawnRecord[] = [];
    const wcRef = { core: Number.MAX_SAFE_INTEGER, graphql: Number.MAX_SAFE_INTEGER };
    const buckets = makeBuckets();
    let liveGraphqlPoints = 0;
    let liveCoreAttempts = 0;
    const gh: BenchGhContext = {
      client, db, cfg, core: buckets.core, graphql: buckets.graphql,
      record: (r) => {
        httpRecords.push(r);
        if (r.servedFromCache) return;
        // R5's frozen assumptions are enforced AT THE REQUEST, not post-run (codex R1 finding
        // 9): one over-P_max cost or a WC overrun halts before another dispatch can go out.
        if (r.requestClass === "rest-meta") return; // control-plane probes never count as driver traffic (codex R2 f.17)
        if (r.kind === "graphql") {
          liveGraphqlPoints += r.pointsCost ?? 1;
          if (r.pointsCost !== null && r.pointsCost > cfg.budget.pMaxPointsPerGraphqlAttempt)
            throw new BenchProtocolError(`R5 frozen-assumption breach: measured cost ${r.pointsCost} exceeds P_max ${cfg.budget.pMaxPointsPerGraphqlAttempt} — halt for freeze repair`, "r5-breach");
          if (liveGraphqlPoints > wcRef.graphql)
            throw new BenchProtocolError(`R5 frozen-assumption breach: live graphql consumption ${liveGraphqlPoints} overran WC ${wcRef.graphql} — halt for freeze repair`, "r5-breach");
        } else if (r.status > 0 && r.status !== 304) {
          liveCoreAttempts++;
          if (liveCoreAttempts > wcRef.core)
            throw new BenchProtocolError(`R5 frozen-assumption breach: live core consumption ${liveCoreAttempts} overran WC ${wcRef.core} — halt for freeze repair`, "r5-breach");
        }
      },
      now: () => this.now(), sleep: (ms) => this.sleep(ms),
    };
    const ghMeta: BenchGhContext = { ...gh, db: null }; // reservation/straddle snapshots bypass the run cache
    const isCloneDriver = row.driver === "T2a" || row.driver === "T2c";
    const needsClonePath = isCloneDriver || workload.truncatedTree;

    // acquisition-form decision: probe the live head before a unit's FIRST clone-involving rep and
    // before each later PRODUCTION-form one; a form frozen as scaffolding is SHA-pinned and skips it (§4.4).
    // null until DECIDED: a pre-decision failure row must not invent "production" — resume
    // would restore the invented form as frozen, and a later probe seeing an already-drifted
    // branch would then be misclassified as mid-unit R6 drift (discard + epilogue restart)
    // instead of the first-probe scaffolding adoption.
    let form: AcquisitionForm | null = null;
    const probeCtx = {
      cfg, slot, unit, benchRoot: this.o.benchRoot,
      gitEnv: this.gitEnvFor(row.probe), spawnObserver: (r: BenchSpawnRecord) => spawnRecords.push(r),
    };
    const clonePathActive = needsClonePath && !(row.driver === "T2a" && workload.escapeTripped && !workload.truncatedTree);

    // Everything the record tail needs is initialised BEFORE the classifying try below, so a
    // failure in ANY pre-driver phase — the live-head probe, WC planning, the reservation, the
    // before-snapshot — lands as a classified, durable run row exactly like a driver failure.
    // These phases previously threw PAST the classifier: cmdMatrix died with no row at all,
    // and every re-invocation retried the position freely with no evidence trail.
    // monotonic by default (see WallClock); an injected o.now keeps tests deterministic
    const wall = new WallClock(this.o.now !== undefined ? () => this.now() : () => performance.now());
    const segmentDeltas: Array<{ core: BucketDelta; graphql: BucketDelta }> = [];
    const bucketSnapshots: Array<{ before: RateLimitSnapshot; after: RateLimitSnapshot }> = [];
    let segBefore: RateLimitSnapshot | null = null;
    let segmentSizes: number[] = [0]; // planned inside the try; [0].length === 1 keeps `segments: 1` for pre-planning failures
    const segmentWc = (sizes: readonly number[], i: number): WorstCase => {
      const budget = restFallbackBudgetFor(cfg, workload.entries.length);
      return { core: ((sizes[i] ?? 0) + (i === 0 ? 1 : 0) + budget) * cfg.rest.attemptCap + cfg.rest.attemptCap + cfg.budget.fixedPerRunOverheadRequests, graphql: 0, plannedBatches: 0 };
    };
    const sampler: DiskSamplerPort = this.o.makeDiskSampler?.() ?? new WorkerDiskSampler();
    sampler.extraFiles([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]); // runDir PLUS the run-cache DB and its sidecars, which live outside it (R2 f.29)
    sampler.start(runDir, cfg.protocol.diskSamplerHz);
    if (this.childPool.pool === null) this.childPool.pool = makeChildPool(cfg.frame.childPoolSize);
    const liveState = { fallbackSpend: 0, routesDelivered: {} as Record<string, number>, cloneDir: null as string | null, t1Conflicts: 0, t1BodyTimeouts: 0 };
    // §4.5 R2's ledger must also see the success the frozen table accepts and production's
    // classifier does not: a partial-data 200 (some aliases resolved, some attributed-errored)
    // is classification "fatal" on every http record (production drops partial data BY DESIGN),
    // yet the T1 table delivers its resolved aliases — hash-verified, route "primary". Without
    // this, a unit whose pinned workload always carries one dead path never mints
    // graphql-batch, and a later transient 5xx exhaustion is denied its R2 replay — a
    // transient failure turned terminal G3 by ledger blindness.
    const t1TableAccepted = (): readonly string[] =>
      row.driver === "T1" && (liveState.routesDelivered["primary"] ?? 0) > 0 ? ["graphql-batch"] : [];
    const startedAt = this.now();
    const startedAtIso = new Date(startedAt).toISOString();
    let outcome: DriverRunOutcome | null = null;
    let verification: VerificationReport | null = null;
    let runOutcome: RunRecord["outcome"] = "complete";
    let failureCause: string | null = null;
    let failureEvidence: RunRecord["failureEvidence"] = null;
    let r5: BenchProtocolError | null = null;
    try {
      if (clonePathActive) {
        const frozen = this.unitForms.get(row.unit);
        if (frozen === "scaffolding") {
          form = "scaffolding"; // SHA-pinned form needs no live-head probe
        } else {
          const live = await probeLiveHead(probeCtx);
          if (frozen === undefined) {
            form = live === unit.sha ? "production" : "scaffolding";
            this.unitForms.set(row.unit, form);
            if (form === "scaffolding") this.o.log(`${row.unit}: live head drifted — all reps use the SHA-pinned scaffolding form`);
          } else if (live !== unit.sha) {
            // mid-unit drift under the frozen PRODUCTION form: discard reps, restart on the
            // scaffolding form via the preregistered epilogue (§4.4/§4.5 R6 branch arm). This is
            // part of the RECORDED lifecycle — a drift-restart record lands in runs.jsonl and the
            // caller's loop routes it to the epilogue (codex R2 f.19).
            this.unitForms.set(row.unit, "scaffolding");
            const driftReclaimFailed = reclaimOnce();
            const driftRecord: RunRecord = {
              type: "run", schemaVersion: 1, pos: row.pos, unit: row.unit, driver: row.driver, rep: row.rep,
              probe: row.probe, phase, epilogue: this.epilogueMode, acquisitionForm: "production", startedAtIso: new Date(this.now()).toISOString(),
              wallMs: 0, segments: 1, outcome: "drift-restart", failureCause: `live head ${live.slice(0, 12)} moved off the pinned SHA at the pre-rep probe`,
              failureEvidence: null, requests: {}, okRequestClasses: [], attempts: { fivexx: 0, retries: 0, secondaryByKind: {} },
              secondarySignals: 0, points: { measuredCostSum: 0, imputed: 0 },
              bucketDeltas: { core: { valid: true, used: 0 }, graphql: { valid: true, used: 0 } },
              bucketSnapshots: [],
              // this attempt may BE a dispatched replay — its record must say so, and the pending
              // replay state must reset here exactly as the normal tail resets it: leaving it set
              // stamped replayKind:"r1r2" onto the NEXT unrelated row, whose resume scan then
              // counted a different unit×driver's ≤1 allowance as spent
              expectedConsumption: { core: 0, graphql: 0 }, replayOfPos: this.replayOfPos, replayKind: this.replayKind,
              // reclaim BEFORE the record is built, so the flag reports what actually happened
              // rather than asserting a teardown this path used to skip entirely
              diskReclaimFailed: driftReclaimFailed,
              probeDivergences: 0, httpBodyBytes: 0, cloneObjectStoreBytes: null,
              diskSampledPeakBytes: 0, diskSamples: 0, diskSampleError: null, fallbackSpend: 0, routesDelivered: {},
              g1Failures: 0, g2Failures: 0, g1Details: [], g2Details: [], probeDivergenceDetails: [],
              spawns: summarizeSpawns(spawnRecords), t1Conflicts: 0, t1BodyTimeouts: 0, washoutAppliedMs: 0,
              envManifestHash: this.manifestHash, harnessCommit: this.o.runsLog.manifest.harnessCommit,
              frozenSurfaceDigest: this.o.frozenSurfaceDigest,
            };
            try {
              this.o.runsLog.append(driftRecord);
              // the ratified reclaim-failure disposition promises an operator log wherever a
              // row records diskReclaimFailed:true — this early return bypasses the normal tail
              if (driftReclaimFailed)
                this.o.log(`${row.unit} ${row.driver} rep${row.rep}: RECLAMATION FAILED — the run directory and/or its run-cache DB sidecars did not fully release (run dir ${runDir}; cache DB ${dbPath}[-wal/-shm]; diskReclaimFailed:true on the row)`);
              this.replayOfPos = null;
              this.replayKind = null;
              // no washout is owed (the probe consumed no API traffic), but the marker-per-row
              // invariant the resume scan enforces must hold for THIS row too
              this.o.runsLog.appendMarker({ type: "washout-done", pos: row.pos, rep: row.rep, probe: row.probe, phase, unit: row.unit, driver: row.driver });
            } finally {
              // in a finally, mirroring the R5 path: an ENOSPC/EACCES on either append must not
              // skip the release — this early return bypasses finishMeasuredRun, and an armed
              // sampler surviving the run would tick its worker into LATER measured rows
              sampler.abandon();
            }
            return { outcome: null, verification: null, record: driftRecord };
          } else {
            form = "production";
          }
        }
      }
      const wc = computeWorstCase(row.driver, workload, cfg, { owner: slot.owner, repo: slot.repo });
      wcRef.core = wc.core;
      wcRef.graphql = wc.graphql;
      // §4.8 feasibility: over-capacity WC runs execute in segmented mode (per-file REST shapes
      // only); each segment satisfies the guard in its own bucket window, deltas sum, and the
      // wall clock pauses between segments.
      segmentSizes = planSegments(row.driver, workload, cfg, { owner: slot.owner, repo: slot.repo });
      const segmented = segmentSizes.length > 1;
      if (segmented) {
        this.o.log(`${row.unit} ${row.driver}: WC exceeds bucket capacity — segmented mode, ${segmentSizes.length} segments (${segmentSizes.join(", ")})`);
        await this.reserve(ghMeta, segmentWc(segmentSizes, 0));
      } else {
        await this.reserve(ghMeta, wc);
      }
      segBefore = await readRateLimit(ghMeta);
      const ctx: DriverRunContext = {
        cfg, slot, unit, workload, gh, benchRoot: this.o.benchRoot, runDir,
        gitEnv: this.gitEnvFor(row.probe),
        spawnObserver: (r) => spawnRecords.push(r),
        acquisitionForm: form ?? "production", // non-clone paths never read it; clone paths decided above
        fallbackBudget: restFallbackBudgetFor(cfg, workload.entries.length),
        liveState,
        ...(segmented
          ? {
              segments: {
                sizes: segmentSizes,
                gate: async (nextSegmentIndex: number): Promise<void> => {
                  wall.pause(); // the clock pauses between segments (§4.8)
                  const segAfter = await readRateLimit(ghMeta);
                  bucketSnapshots.push({ before: segBefore!, after: segAfter });
                  segmentDeltas.push({ core: bucketDelta(segBefore!.core, segAfter.core), graphql: bucketDelta(segBefore!.graphql, segAfter.graphql) });
                  await this.reserve(ghMeta, segmentWc(segmentSizes, nextSegmentIndex));
                  segBefore = await readRateLimit(ghMeta);
                  wall.start();
                },
              },
            }
          : {}),
      };
      wall.start();
      outcome = await runDriver(row.driver, ctx, this.childPool.pool);
    } catch (e) {
      if (e instanceof DriftSignal) {
        runOutcome = "drift-restart";
        failureCause = e.message;
        this.unitForms.set(row.unit, "scaffolding"); // the epilogue restart runs SHA-pinned (R6)
      } else if (e instanceof RePinRequired) {
        runOutcome = "re-pin-required";
        failureCause = e.message;
      } else if (e instanceof BenchProtocolError && e.code === "r5-breach") {
        runOutcome = "halt-r5-breach"; // recorded IN runs.jsonl, then the halt propagates
        failureCause = e.message;
        r5 = e;
      } else if (e instanceof UnitFailure) {
        runOutcome = "unit-failure";
        failureCause = e.cause2;
        failureEvidence = e.httpEvidence !== null
          ? { kind: "http", code: e.httpEvidence.code, lastClassification: e.httpEvidence.lastClassification, requestClass: e.httpEvidence.requestClass }
          : { kind: "unit" };
      } else if (e instanceof BenchHttpError) {
        runOutcome = "unit-failure";
        failureCause = `${e.code}: ${e.message}`;
        failureEvidence = { kind: "http", code: e.code, lastClassification: e.lastClassification, requestClass: e.requestClass };
      } else {
        runOutcome = "unit-failure";
        failureCause = `harness/driver error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (r5 !== null) {
      // The minimal terminal R5 record lands BEFORE any fallible post-run work (codex R2 f.18) —
      // it is the evidence a freeze repair is diagnosed from, so nothing that can throw, await a
      // worker, or block on reclamation may run ahead of it. wall.stop() and peek() are both
      // synchronous and infallible; the disk snapshot is deliberately the peek, not the full
      // finish, and the run's resources are reclaimed in the outer finally on the way out.
      const wallMs = wall.stop();
      const disk = sampler.peek();
      const r5traffic = summarizeTraffic(httpRecords, t1TableAccepted());
      const r5record: RunRecord = {
        type: "run", schemaVersion: 1, pos: row.pos, unit: row.unit, driver: row.driver, rep: row.rep,
        probe: row.probe, phase, epilogue: this.epilogueMode, acquisitionForm: needsClonePath ? form : null,
        startedAtIso, wallMs, segments: segmentSizes.length, outcome: "halt-r5-breach",
        failureCause, failureEvidence: null,
        // an R5 halt is the evidence a freeze repair is diagnosed from, so it carries the partial
        // traffic it actually observed rather than zeroes — through the SAME control-plane rule
        // the normal record uses, which this literal previously contradicted
        requests: r5traffic.requests, okRequestClasses: r5traffic.okRequestClasses, attempts: r5traffic.attempts,
        secondarySignals: r5traffic.secondarySignals, points: r5traffic.points,
        bucketDeltas: { core: { valid: false, used: null }, graphql: { valid: false, used: null } },
        bucketSnapshots,
        expectedConsumption: { core: liveCoreAttempts, graphql: liveGraphqlPoints },
        // reclamation has NOT run yet on this path (it happens in the outer finally, after this
        // record is durable) — null says "not attempted", which a false would misreport as
        // "attempted and succeeded"
        replayOfPos: this.replayOfPos, replayKind: this.replayKind, diskReclaimFailed: null, probeDivergences: 0,
        httpBodyBytes: r5traffic.httpBodyBytes,
        cloneObjectStoreBytes: null, diskSampledPeakBytes: disk.peakBytes, diskSamples: disk.samples,
        diskSampleError: "not sampled: R5 halt records before any fallible post-run work",
        fallbackSpend: liveState.fallbackSpend, routesDelivered: liveState.routesDelivered,
        g1Failures: 0, g2Failures: 0, g1Details: [], g2Details: [], probeDivergenceDetails: [],
        spawns: summarizeSpawns(spawnRecords), t1Conflicts: liveState.t1Conflicts, t1BodyTimeouts: liveState.t1BodyTimeouts, washoutAppliedMs: 0,
        envManifestHash: this.manifestHash, harnessCommit: this.o.runsLog.manifest.harnessCommit,
        frozenSurfaceDigest: this.o.frozenSurfaceDigest,
      };
      try {
        this.o.runsLog.append(r5record);
      } finally {
        // in a finally, not after the append: appendFileSync can throw (disk full, EACCES), and
        // on that path the sampler would otherwise stay armed with no disposer left — finish()
        // is the only other one and this path deliberately never calls it. abandon() cannot
        // throw, so it can never mask the append failure.
        sampler.abandon();
      }
      this.replayOfPos = null;
      throw r5;
    }
    // §4.6 item 1 keeps RECLAMATION inside the wall (production holds the unit slot through
    // synchronous reclamation, so stopping at the last resolved entry would structurally favour
    // clone drivers). It does not license charging INSTRUMENTATION to the same clock, so the
    // disk snapshot is taken with the wall paused — see finishMeasuredRun.
    // cloneObjectStoreBytes measures the OBJECT STORE (.git/objects), not all of .git — the
    // index/refs/logs would tax T2a (whose checkout builds a full index) against T2c's
    // --no-checkout store, a driver-correlated mislabel of §4.6 item 3's metric. The dir comes
    // from the outcome OR the live mirror, so a post-acquisition failure still measures the
    // store it actually cloned instead of recording a null indistinguishable from no-clone.
    const measuredCloneDir = outcome?.cloneDir ?? liveState.cloneDir;
    const finished = await finishMeasuredRun({
      wall,
      sampler: { finish: () => sampler.finish(runDir, measuredCloneDir != null ? join(measuredCloneDir, ".git", "objects") : null) },
      reclaim: reclaimOnce,
    });
    const cloneObjectStoreBytes = finished.disk.cloneObjectStoreBytes;
    const diskReclaimFailed = finished.diskReclaimFailed;
    const disk = finished.disk;
    const wallMs = finished.wallMs;
    // Everything from here to the append is post-run FINALISATION: the rate-limit probe, delivery
    // verification, and delta arithmetic. A throw in any of it used to discard a run that had
    // already been measured and reclaimed — the wall, the traffic, and the driver's actual work
    // all lost because a control-plane read failed afterwards. Record what we have instead.
    // delivery verification runs BEFORE the fallible accounting read: a §4.7 G1/G2 event is
    // globally irreversible evidence, and appending the invalidated-finalisation row with
    // zeroed failure counts let a wrong-bytes run whose rate-limit read then failed be
    // re-executed and ERASED by a clean replay
    if (outcome !== null) verification = verifyDeliveries(workload, outcome.deliveries, row.driver, { probeRep: row.probe, acquiredPaths: outcome.acquiredPaths });
    let after: RateLimitSnapshot | null = null;
    try {
      after = await readRateLimit(ghMeta);
    } catch (e) {
      // A COMPLETE run without its consumption accounting cannot be scored — that stays the
      // invalidated-finalisation row (wall preserved, then propagate). But a run that already
      // CLASSIFIED a terminal outcome (unit-failure / drift-restart / re-pin-required) must not
      // have that classification overwritten by a later accounting failure: resume and §4.5
      // semantics read the outcome (a re-pin row REFUSES resume; an invalidated-finalisation
      // row in its place would silently re-run against a dead SHA). Those runs keep their
      // classified record, with the deltas degraded and the accounting failure noted.
      if (runOutcome === "complete") {
        const partial = summarizeTraffic(httpRecords, t1TableAccepted());
        this.o.runsLog.append({
          type: "run", schemaVersion: 1, pos: row.pos, unit: row.unit, driver: row.driver, rep: row.rep,
          probe: row.probe, phase, epilogue: this.epilogueMode,
          acquisitionForm: outcome !== null ? outcome.acquisitionForm : (needsClonePath ? form : null),
          startedAtIso, wallMs, segments: segmentSizes.length,
          // the measured wall stands; only the post-run accounting is missing, so the row is
          // marked invalid for scoring rather than dropped or passed off as complete
          outcome: "invalidated-finalisation", failureCause: `post-run rate-limit read failed: ${e instanceof Error ? e.message : String(e)}`,
          failureEvidence: null,
          requests: partial.requests, okRequestClasses: partial.okRequestClasses, attempts: partial.attempts, secondarySignals: partial.secondarySignals,
          points: partial.points,
          bucketDeltas: { core: { valid: false, used: null }, graphql: { valid: false, used: null } },
          bucketSnapshots,
          expectedConsumption: { core: liveCoreAttempts, graphql: liveGraphqlPoints },
          // counted from the SAME verification the g1/g2 and detail fields read below — it ran
          // BEFORE the failed accounting read, so a hardcoded 0 contradicted the nonempty
          // probeDivergenceDetails this row can carry
          replayOfPos: this.replayOfPos, replayKind: this.replayKind, diskReclaimFailed,
          probeDivergences: verification?.probeDivergences.length ?? 0,
          httpBodyBytes: partial.httpBodyBytes, cloneObjectStoreBytes,
          diskSampledPeakBytes: disk.peakBytes, diskSamples: disk.samples, diskSampleError: disk.sampleError,
          fallbackSpend: outcome?.fallbackSpend ?? liveState.fallbackSpend,
          routesDelivered: liveState.routesDelivered,
          g1Failures: verification?.g1Failures.length ?? 0, g2Failures: verification?.g2Failures.length ?? 0,
          g1Details: verification?.g1Failures.slice(0, DETAIL_CAP) ?? [], g2Details: verification?.g2Failures.slice(0, DETAIL_CAP) ?? [],
          probeDivergenceDetails: verification?.probeDivergences.slice(0, DETAIL_CAP) ?? [],
          spawns: summarizeSpawns(spawnRecords), t1Conflicts: liveState.t1Conflicts, t1BodyTimeouts: liveState.t1BodyTimeouts,
          // this row throws before any washout sleep, so resume completes the OWED washout
          // from this field — a hardcoded 0 collapsed a live Retry-After horizon (e.g. the
          // throttle that broke the accounting read) to the 60 s floor
          washoutAppliedMs: washoutMs(cfg, outstandingHorizonMs(gh), this.now()),
          envManifestHash: this.manifestHash, harnessCommit: this.o.runsLog.manifest.harnessCommit,
          frozenSurfaceDigest: this.o.frozenSurfaceDigest,
        });
        // same promise as the drift path: a diskReclaimFailed:true row is always operator-logged
        if (diskReclaimFailed)
          this.o.log(`${row.unit} ${row.driver} rep${row.rep}: RECLAMATION FAILED — the run directory and/or its run-cache DB sidecars did not fully release (run dir ${runDir}; cache DB ${dbPath}[-wal/-shm]; diskReclaimFailed:true on the row)`);
        throw e;
      }
      failureCause = `${failureCause ?? "(no recorded cause)"} — post-run rate-limit read also failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
    }
    // per-segment same-window deltas, summed by construction (§4.6 item 2); the final (or only)
    // segment closes against the post-run snapshot. Any straddled segment invalidates the run.
    if (after !== null && segBefore !== null) {
      bucketSnapshots.push({ before: segBefore, after });
      segmentDeltas.push({ core: bucketDelta(segBefore.core, after.core), graphql: bucketDelta(segBefore.graphql, after.graphql) });
    }
    const sumDelta = (pick: (d: { core: BucketDelta; graphql: BucketDelta }) => BucketDelta): BucketDelta => {
      let used = 0;
      for (const d of segmentDeltas) {
        const one = pick(d);
        if (!one.valid || one.used === null) return { valid: false, used: null };
        used += one.used;
      }
      return { valid: true, used };
    };
    const deltas = after !== null
      ? { core: sumDelta((d) => d.core), graphql: sumDelta((d) => d.graphql) }
      : { core: { valid: false, used: null } as BucketDelta, graphql: { valid: false, used: null } as BucketDelta };
    // R4/R3 apply to unit-failure runs too, not only completed ones: §4.5 declares an invalid
    // run "replayed in its own slot" with no completion condition, and a failure observed under
    // verified external interference (or across a reset) is contaminated evidence — recording
    // it as the driver's permanent failure would let a foreign consumer manufacture G3
    // ineligibility. Invalidation SUPERSEDES the failure; the original cause is preserved.
    const invalidatable = runOutcome === "complete" || runOutcome === "unit-failure";
    const supersede = (newOutcome: "invalidated-straddle" | "invalidated-foreign", why: string): void => {
      failureCause = runOutcome === "unit-failure"
        ? `${why} — superseding a unit-failure observed under it: ${failureCause ?? "(no recorded cause)"}`
        : why;
      runOutcome = newOutcome;
      failureEvidence = null; // an invalidated run's evidence is contaminated, never R1/R2 input
    };
    if ((!deltas.core.valid || !deltas.graphql.valid) && invalidatable && after !== null)
      supersede("invalidated-straddle", "a bucket delta straddled a reset window (R4)");
    // R3 foreign consumption (§4.5/§4.8): the observed delta must reconcile with the harness's
    // OWN accounting — unexplained excess is external interference: run invalid, replayed in
    // its own slot, never charged to the driver allowance (codex R1 finding 8). Conditional
    // 304s and rate_limit reads consume nothing; every other live response consumes one.
    const expectedCore = httpRecords.filter((r) => !r.servedFromCache && r.kind === "rest" && r.status > 0 && r.status !== 304 && r.requestClass !== "rest-meta").length;
    // unknown costs reconcile at their UPPER bound (1..P_max) — an owned-but-unreadable cost
    // must never be labeled foreign (codex R2 f.15); overruns of the frozen bound are R5's job
    const expectedGraphql = httpRecords.filter((r) => !r.servedFromCache && r.kind === "graphql").reduce((n, r) => n + (r.pointsCost ?? cfg.budget.pMaxPointsPerGraphqlAttempt), 0);
    if (runOutcome === "complete" || runOutcome === "unit-failure") {
      if ((deltas.core.valid && deltas.core.used !== null && deltas.core.used > expectedCore) ||
          (deltas.graphql.valid && deltas.graphql.used !== null && deltas.graphql.used > expectedGraphql)) {
        supersede("invalidated-foreign", `observed consumption (core ${deltas.core.used}, graphql ${deltas.graphql.used}) exceeds harness-owned accounting (core ${expectedCore}, graphql ${expectedGraphql})`);
      }
    }

    // control-plane probes are never driver evidence (codex R3 f.7) — the same rule summarizeTraffic
    // and live R5 accounting each apply to their own scans
    const traffic = summarizeTraffic(httpRecords, t1TableAccepted());
    const { requests, attempts, secondarySignals } = traffic;
    const { measuredCostSum, imputed } = traffic.points;

    const horizon = outstandingHorizonMs(gh);
    const washoutAppliedMs = washoutMs(cfg, horizon, this.now());

    const record: RunRecord = {
      type: "run", schemaVersion: 1, pos: row.pos, unit: row.unit, driver: row.driver, rep: row.rep,
      probe: row.probe, phase, epilogue: this.epilogueMode,
      acquisitionForm: outcome !== null ? outcome.acquisitionForm : (needsClonePath ? form : null),
      startedAtIso, wallMs, segments: segmentSizes.length, outcome: runOutcome, failureCause,
      failureEvidence,
      requests, okRequestClasses: traffic.okRequestClasses, attempts, secondarySignals,
      points: { measuredCostSum, imputed },
      bucketDeltas: deltas,
      bucketSnapshots,
      expectedConsumption: { core: expectedCore, graphql: expectedGraphql },
      replayOfPos: this.replayOfPos,
      replayKind: this.replayKind,
      diskReclaimFailed,
      probeDivergences: verification?.probeDivergences.length ?? 0,
      // body bytes derive from the RECORDS so a thrown driver still reports its real transfer
      httpBodyBytes: traffic.httpBodyBytes,
      cloneObjectStoreBytes,
      diskSampledPeakBytes: disk.peakBytes, diskSamples: disk.samples, diskSampleError: disk.sampleError,
      fallbackSpend: outcome?.fallbackSpend ?? liveState.fallbackSpend,
      routesDelivered: verification?.routesDelivered ?? liveState.routesDelivered,
      g1Failures: verification?.g1Failures.length ?? 0,
      g2Failures: verification?.g2Failures.length ?? 0,
      g1Details: verification?.g1Failures.slice(0, DETAIL_CAP) ?? [],
      g2Details: verification?.g2Failures.slice(0, DETAIL_CAP) ?? [],
      probeDivergenceDetails: verification?.probeDivergences.slice(0, DETAIL_CAP) ?? [],
      spawns: summarizeSpawns(spawnRecords),
      t1Conflicts: liveState.t1Conflicts,
      t1BodyTimeouts: liveState.t1BodyTimeouts,
      washoutAppliedMs,
      envManifestHash: this.manifestHash,
      harnessCommit: this.o.runsLog.manifest.harnessCommit,
      frozenSurfaceDigest: this.o.frozenSurfaceDigest,
    };
    this.o.runsLog.append(record);
    // degraded disk fields must reach the operator, not just the raw row: a silent null here
    // would later read as "this driver used no disk" to anything scoring the §4.6 disk axis
    if (disk.sampleError !== null)
      this.o.log(`${row.unit} ${row.driver} rep${row.rep}: DISK INSTRUMENTATION DEGRADED — ${disk.sampleError} (diskSampledPeakBytes/cloneObjectStoreBytes are not measurements for this row)`);
    if (diskReclaimFailed)
      this.o.log(`${row.unit} ${row.driver} rep${row.rep}: RECLAMATION FAILED — the run directory and/or its run-cache DB sidecars did not fully release (run dir ${runDir}; cache DB ${dbPath}[-wal/-shm]; diskReclaimFailed:true on the row)`);
    this.replayOfPos = null;
    this.replayKind = null;
    if (verification !== null && (verification.g1Failures.length > 0 || verification.g2Failures.length > 0)) {
      this.o.log(`${row.unit} ${row.driver} rep${row.rep}: G1=${verification.g1Failures.length} G2=${verification.g2Failures.length}`);
      for (const f of [...verification.g1Failures.slice(0, 5)]) this.o.log(`  G1 ${f.path} [${f.route}]: ${f.reason}`);
      for (const f of [...verification.g2Failures.slice(0, 5)]) this.o.log(`  G2 ${f.path}: ${f.reason}`);
    }
    // §4.5 washout between consecutive runs — the caller sequences runs, we sleep here. The
    // washout-done marker lands AFTER the sleep: resume treats an unmarked terminal row as
    // still-pending its washout/replay transition (codex R3 f.3).
    this.o.log(`washout ${Math.ceil(washoutAppliedMs / 1000)}s (horizon ${horizon === 0 ? "none" : new Date(horizon).toISOString()})`);
    await this.sleep(washoutAppliedMs);
    this.o.runsLog.appendMarker({ type: "washout-done", pos: row.pos, rep: row.rep, probe: row.probe, phase, unit: row.unit, driver: row.driver });
    return { outcome, verification, record };
    } finally {
      // a no-op on every path that already reclaimed; the backstop for the ones that throw
      // before the scored teardown is reached. A failure HERE has no record to land on (the
      // throw is on its way out), so it is logged rather than dropped silently.
      if (reclaimOnce())
        this.o.log(`${row.unit} ${row.driver} rep${row.rep}: run resources did not fully reclaim (run dir ${runDir} and/or cache DB ${dbPath}[-wal/-shm])`);
    }
  }

  private gitEnvFor(probeRep: boolean): Record<string, string> {
    const cfgDir = join(this.o.benchRoot, "gitcfg");
    mkdirSync(cfgDir, { recursive: true });
    const path = join(cfgDir, probeRep ? "gitconfig-probe" : "gitconfig-baseline");
    const ghBin = Bun.which("gh") ?? "gh";
    const quoted = `'${ghBin.replace(/'/g, `'\\''`)}'`;
    const template = probeRep ? this.o.cfg.scaffolding.gitconfigProbeAutocrlfTrue : this.o.cfg.scaffolding.gitconfigBaseline;
    writeFileSync(path, template.replace("{ghBin}", quoted), { mode: 0o600 });
    const env = buildGitEnv(process.env, path);
    // buildGitEnv's allowlist deliberately drops this today — the bench adds it explicitly or
    // the no-replace guarantee is a no-op (plan §3.2)
    env["GIT_NO_REPLACE_OBJECTS"] = "1";
    return env;
  }

  // §4.7/§8's pre-ratification diagnostic pilot: K reps of the pinned pilot driver on the pinned
  // slot; the spread feeds
  // the frozen noise-band formula. Declared non-decision.
  async runPilot(schedulePositions: number): Promise<{ walls: number[]; spread: number }> {
    const cfg = this.o.cfg;
    const slot = this.o.corpus.performance.find((s) => s.slot === cfg.pilot.slot) ?? ((): never => {
      throw new BenchProtocolError(`pilot slot ${cfg.pilot.slot} not pinned`);
    })();
    const unit = slot.units[0]!;
    const walls: number[] = [];
    for (let rep = 1; rep <= cfg.pilot.reps; rep++) {
      let replays = 0;
      for (;;) {
        const handle = await this.runOne(
          { pos: schedulePositions + rep, unit: unit.unitId, driver: cfg.pilot.driver, rep, probe: false },
          "pilot",
        );
        // R3/R4 invalidations replay in their own slot, mirroring §4.5's replay PLACEMENT —
        // but NOT its full taxonomy: this pre-ratification diagnostic bounds BOTH kinds at 2
        // invalidations per rep and then stops for the operator, where the matrix halts on the
        // second R4 per UNIT and never caps R3. The pilot is a declared non-decision
        // diagnostic; its stricter stop exists to surface a noisy account early (measured
        // live: a single foreign GraphQL point from a background consumer invalidated a rep
        // on 2026-07-29), not to implement the frozen matrix discipline.
        if (handle.record.outcome === "invalidated-straddle" || handle.record.outcome === "invalidated-foreign") {
          replays++;
          if (replays > 2) throw new BenchProtocolError(`pilot rep ${rep} invalidated ${replays} times (${handle.record.outcome}) — quiesce the account's other consumers and re-run`);
          this.o.log(`pilot rep ${rep} ${handle.record.outcome} — replaying in its own slot`);
          this.setReplayOf(schedulePositions + rep, "r3r4");
          continue;
        }
        if (handle.record.outcome !== "complete")
          throw new BenchProtocolError(`pilot rep ${rep} did not complete: ${handle.record.outcome} (${handle.record.failureCause ?? ""})`);
        if ((handle.verification?.g1Failures.length ?? 0) > 0 || (handle.verification?.g2Failures.length ?? 0) > 0)
          throw new BenchProtocolError(`pilot rep ${rep} failed verification`);
        walls.push(handle.record.wallMs);
        this.o.log(`pilot rep ${rep}/${cfg.pilot.reps}: wall ${handle.record.wallMs}ms`);
        break;
      }
    }
    const spread = Math.max(...walls) / Math.min(...walls);
    return { walls, spread };
  }
}
