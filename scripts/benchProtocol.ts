// benchProtocol.ts — the run engine (resolution plan §4.5/§4.6/§4.8): per-run cold setup,
// worst-case budget reservation with bucket-aware admission, the disk sampler, delivery
// verification against the pinned matrix, washout, reset-window straddle detection, and the
// runs.jsonl record shape. The pure decision pieces (WC formulas, segmentation, washout,
// straddle, verification) are exported for CI tests; the live engine composes them.

import { appendFileSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  makeBuckets, outstandingHorizonMs, readRateLimit,
  type BenchGhContext, type BenchHttpAttemptRecord, type RateLimitSnapshot,
} from "./benchGh.ts";
import { seamStringSha256, type UnitWorkload } from "./benchWorkload.ts";
import type { DriverId } from "./benchSchedule.ts";
import type { BenchSpawnRecord } from "./benchSpawn.ts";

export class BenchProtocolError extends Error {
  constructor(message: string) {
    super(`BENCH PROTOCOL: ${message}`);
    this.name = "BenchProtocolError";
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
  if (driver === "T0" || (driver === "T2a" && workload.escapeTripped && !workload.truncatedTree)) {
    // per-file REST + the tree request + the fallback budget, all under the attempt cap
    return { core: (reads + 1 + budget) * cap + fixed, graphql: 0, plannedBatches: 0 };
  }
  if (driver === "T1") {
    if (workload.truncatedTree) return { core: (1 + budget) * cap + fixed, graphql: 0, plannedBatches: 0 };
    const plan = planRounds(workload);
    let plannedBatches = 0;
    for (const round of [plan.round1, plan.round2]) {
      if (round.length === 0) continue;
      plannedBatches += packBatches(round, cfg, { owner: slot.owner, repo: slot.repo, sha: workload.sha, roundLabel: "wc" }).length;
    }
    const graphql = plannedBatches * (1 + cfg.t1.split.maxDescendantsPerOriginal) * cap * cfg.budget.pMaxPointsPerGraphqlAttempt;
    return { core: (1 + budget) * cap + fixed, graphql, plannedBatches };
  }
  // clone drivers: no REST content, no REST tree — only the fallback budget (and the pinned
  // classifier probes ride inside it via the attempt cap slack)
  return { core: budget * cap + fixed, graphql: 0, plannedBatches: 0 };
}

// §4.8 feasibility gate: segments of the T0-shaped workload, each satisfying
// WC × headroom ≤ bucket capacity. Deterministic, contiguous, pinned by formula.
export function planSegments(driver: DriverId, workload: UnitWorkload, cfg: BenchConfig, slot: { owner: string; repo: string }): number[] {
  const wc = computeWorstCase(driver, workload, cfg, slot);
  const capacity = cfg.budget.bucketCapacityPerHour;
  if (wc.core * cfg.budget.headroomFactor <= capacity) return [workload.entries.filter((e) => e.read).length];
  if (driver !== "T0" && !(driver === "T2a" && workload.escapeTripped)) {
    throw new BenchProtocolError(`WC exceeds bucket capacity for ${driver} — only the per-file REST shape segments`);
  }
  const reads = workload.entries.filter((e) => e.read).length;
  const budget = restFallbackBudgetFor(cfg, workload.entries.length);
  const perSegment = Math.floor(capacity / (cfg.budget.headroomFactor * cfg.rest.attemptCap)) - 1 - budget;
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
export function bucketDelta(before: { remaining: number; reset: number }, after: { remaining: number; reset: number }): BucketDelta {
  if (before.reset !== after.reset) return { valid: false, used: null };
  return { valid: true, used: Math.max(0, before.remaining - after.remaining) };
}

// ---- delivery verification (§4.6.6 fidelity + G2 completeness bookkeeping) -------------------
export interface VerificationReport {
  resolved: number;
  g1Failures: Array<{ path: string; route: string; reason: string }>;
  g2Failures: Array<{ path: string; reason: string }>;
  routesDelivered: Record<string, number>;
}
export function verifyDeliveries(workload: UnitWorkload, deliveries: readonly EntryDelivery[], driver: DriverId): VerificationReport {
  const report: VerificationReport = { resolved: 0, g1Failures: [], g2Failures: [], routesDelivered: {} };
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
      if (d.delivered !== null) report.g1Failures.push({ path: entry.path, route: d.route, reason: "content acquired on a no-read route" });
      else report.resolved++;
      continue;
    }
    if (d.delivered === null) {
      report.g2Failures.push({ path: entry.path, reason: `route ${d.route} delivered nothing` });
      continue;
    }
    const gotHash = seamStringSha256(d.delivered);
    if (gotHash !== expected.seamSha256) {
      report.g1Failures.push({ path: entry.path, route: d.route, reason: `seam-string sha256 mismatch (${gotHash.slice(0, 12)}… != ${expected.seamSha256.slice(0, 12)}…)` });
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

// ---- disk sampler (sampled peak at 1 Hz, §4.6.4) ---------------------------------------------
function duBytes(dir: string): number {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // the dir may vanish mid-sample (teardown race) — a sample, not an invariant
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      const st = lstatSync(p);
      total += st.size;
      if (st.isDirectory()) total += duBytes(p);
    } catch {
      // vanished mid-walk
    }
  }
  return total;
}
export class DiskSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private peak = 0;
  private samples = 0;
  start(dir: string, hz: number): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      this.samples++;
      const b = duBytes(dir);
      if (b > this.peak) this.peak = b;
    }, Math.max(1, Math.round(1000 / hz)));
    this.timer.unref?.();
  }
  point(dir: string): void {
    const b = duBytes(dir);
    this.samples++;
    if (b > this.peak) this.peak = b;
  }
  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
  stop(): { peakBytes: number; samples: number } {
    this.stopTimer();
    return { peakBytes: this.peak, samples: this.samples };
  }
}

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
export async function buildEnvManifest(client: GithubClient, opts: { login: string; harnessCommit: string; networkDescription: string; credentialType: string }): Promise<EnvManifest> {
  const git = await client.git(["--version"]);
  const gh = await client.gh(["--version"]);
  const cpuModel = cpus()[0]?.model ?? "unknown";
  return {
    os: platform(),
    osVersion: release(),
    archName: arch(),
    hardwareIdHash: createHash("sha256").update(`${hostname()}|${cpuModel}|${cpus().length}`).digest("hex").slice(0, 16),
    gitVersion: git.stdout.trim(),
    ghVersion: gh.stdout.split("\n")[0]?.trim() ?? "",
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
  acquisitionForm: AcquisitionForm | null;
  startedAtIso: string;
  wallMs: number; // workload start → unit slot release, teardown included (§4.6.1)
  segments: number;
  outcome: "complete" | "unit-failure" | "invalidated-straddle" | "drift-restart" | "re-pin-required";
  failureCause: string | null;
  requests: Record<string, number>;
  secondarySignals: number; // attributable (driver-own matrix traffic) — G4's classifier input
  points: { measuredCostSum: number; imputed: number };
  bucketDeltas: { core: BucketDelta; graphql: BucketDelta };
  httpBodyBytes: number;
  cloneObjectStoreBytes: number | null;
  diskSampledPeakBytes: number;
  diskSamples: number;
  fallbackSpend: number;
  routesDelivered: Record<string, number>;
  g1Failures: number;
  g2Failures: number;
  washoutAppliedMs: number;
  envManifestHash: string;
  harnessCommit: string;
}

export class RunsLog {
  constructor(private readonly path: string, readonly manifest: EnvManifest) {}
  envManifestHash(): string {
    return createHash("sha256").update(JSON.stringify(this.manifest)).digest("hex").slice(0, 16);
  }
  writeManifestOnce(): void {
    appendFileSync(this.path, `${JSON.stringify({ type: "env-manifest", schemaVersion: 1, ...this.manifest, hash: this.envManifestHash() })}\n`);
  }
  append(record: RunRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }
}

// active-wall accounting: segment sleeps are excluded from the wall term (§4.6.1/§4.7 —
// dropping the wall for segmented runs would make segmentation a scoring exploit, so the wall
// is the SUM of active segments).
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
  runsLog: RunsLog;
  client: GithubClient; // meta traffic (rate_limit, env manifest probes); drivers get their own per-run client
  makeClient: (db: AuditDb | null) => GithubClient;
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
  constructor(o: EngineOptions) {
    this.o = o;
    this.manifestHash = o.runsLog.envManifestHash();
  }
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
    const runDir = join(this.o.benchRoot, `run-${String(row.pos).padStart(4, "0")}-${row.driver}-r${row.rep}${row.probe ? "p" : ""}`);
    mkdirSync(runDir, { recursive: true });
    const dbPath = join(runDir, "bench-cache.sqlite");
    const db = AuditDb.open({ sqlitePath: dbPath, fresh: false, purgeCache: false });
    const client = this.o.makeClient(db);
    const httpRecords: BenchHttpAttemptRecord[] = [];
    const spawnRecords: BenchSpawnRecord[] = [];
    const buckets = makeBuckets();
    const gh: BenchGhContext = {
      client, db, cfg, core: buckets.core, graphql: buckets.graphql,
      record: (r) => httpRecords.push(r),
      now: () => this.now(), sleep: (ms) => this.sleep(ms),
    };
    const ghMeta: BenchGhContext = { ...gh, db: null }; // reservation/straddle snapshots bypass the run cache
    const isCloneDriver = row.driver === "T2a" || row.driver === "T2c";
    const needsClonePath = isCloneDriver || workload.truncatedTree;

    // acquisition-form decision: probe the live head before every clone-involving rep (§4.4)
    let form: AcquisitionForm = "production";
    const probeCtx = {
      cfg, slot, unit, benchRoot: this.o.benchRoot,
      gitEnv: this.gitEnvFor(row.probe), spawnObserver: (r: BenchSpawnRecord) => spawnRecords.push(r),
    };
    if (needsClonePath && !(row.driver === "T2a" && workload.escapeTripped && !workload.truncatedTree)) {
      const live = await probeLiveHead(probeCtx);
      form = live === unit.sha ? "production" : "scaffolding";
      if (form === "scaffolding") this.o.log(`${row.unit}: live head drifted — all reps use the SHA-pinned scaffolding form`);
    }

    const wc = computeWorstCase(row.driver, workload, cfg, { owner: slot.owner, repo: slot.repo });
    // §4.8 feasibility: over-capacity WC runs execute in segmented mode (per-file REST shapes
    // only); each segment satisfies the guard in its own bucket window, deltas sum, and the
    // wall clock pauses between segments.
    const segmentSizes = planSegments(row.driver, workload, cfg, { owner: slot.owner, repo: slot.repo });
    const segmented = segmentSizes.length > 1;
    const wall = new WallClock(() => this.now());
    const segmentDeltas: Array<{ core: BucketDelta; graphql: BucketDelta }> = [];
    let segBefore: RateLimitSnapshot;
    const segmentWc = (sizes: readonly number[], i: number): WorstCase => {
      const budget = restFallbackBudgetFor(cfg, workload.entries.length);
      return { core: ((sizes[i] ?? 0) + (i === 0 ? 1 : 0) + budget) * cfg.rest.attemptCap + cfg.budget.fixedPerRunOverheadRequests, graphql: 0, plannedBatches: 0 };
    };
    if (segmented) {
      this.o.log(`${row.unit} ${row.driver}: WC exceeds bucket capacity — segmented mode, ${segmentSizes.length} segments (${segmentSizes.join(", ")})`);
      await this.reserve(ghMeta, segmentWc(segmentSizes, 0));
    } else {
      await this.reserve(ghMeta, wc);
    }
    const before = await readRateLimit(ghMeta);
    segBefore = before;
    const sampler = new DiskSampler();
    sampler.start(runDir, cfg.protocol.diskSamplerHz);

    if (this.childPool.pool === null) this.childPool.pool = makeChildPool(cfg.frame.childPoolSize);
    const ctx: DriverRunContext = {
      cfg, slot, unit, workload, gh, benchRoot: this.o.benchRoot, runDir,
      gitEnv: this.gitEnvFor(row.probe),
      spawnObserver: (r) => spawnRecords.push(r),
      acquisitionForm: form,
      fallbackBudget: restFallbackBudgetFor(cfg, workload.entries.length),
      onCloneDirReady: () => sampler.point(runDir),
      ...(segmented
        ? {
            segments: {
              sizes: segmentSizes,
              gate: async (nextSegmentIndex: number): Promise<void> => {
                wall.pause(); // the clock pauses between segments (§4.8)
                const segAfter = await readRateLimit(ghMeta);
                segmentDeltas.push({ core: bucketDelta(segBefore.core, segAfter.core), graphql: bucketDelta(segBefore.graphql, segAfter.graphql) });
                await this.reserve(ghMeta, segmentWc(segmentSizes, nextSegmentIndex));
                segBefore = await readRateLimit(ghMeta);
                wall.start();
              },
            },
          }
        : {}),
    };

    const startedAt = this.now();
    const startedAtIso = new Date(startedAt).toISOString();
    wall.start();
    let outcome: DriverRunOutcome | null = null;
    let verification: VerificationReport | null = null;
    let runOutcome: RunRecord["outcome"] = "complete";
    let failureCause: string | null = null;
    try {
      outcome = await runDriver(row.driver, ctx, this.childPool.pool);
    } catch (e) {
      if (e instanceof DriftSignal) {
        runOutcome = "drift-restart";
        failureCause = e.message;
      } else if (e instanceof RePinRequired) {
        runOutcome = "re-pin-required";
        failureCause = e.message;
      } else if (e instanceof UnitFailure) {
        runOutcome = "unit-failure";
        failureCause = e.cause2;
      } else {
        runOutcome = "unit-failure";
        failureCause = `harness/driver error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    // teardown INSIDE the wall: production holds the unit slot through synchronous reclamation
    // (§4.6.1) — clone-dir removal is part of the measured cost.
    let cloneObjectStoreBytes: number | null = null;
    if (outcome?.cloneDir != null) {
      cloneObjectStoreBytes = duBytes(join(outcome.cloneDir, ".git"));
      sampler.point(runDir);
    }
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      // best-effort; the bench root sweep at exit reclaims stragglers
    }
    const wallMs = wall.stop();
    const after = await readRateLimit(ghMeta);
    const disk = sampler.stop();
    if (outcome !== null) verification = verifyDeliveries(workload, outcome.deliveries, row.driver);

    // per-segment same-window deltas, summed by construction (§4.6.2); the final (or only)
    // segment closes against the post-run snapshot. Any straddled segment invalidates the run.
    segmentDeltas.push({ core: bucketDelta(segBefore.core, after.core), graphql: bucketDelta(segBefore.graphql, after.graphql) });
    const sumDelta = (pick: (d: { core: BucketDelta; graphql: BucketDelta }) => BucketDelta): BucketDelta => {
      let used = 0;
      for (const d of segmentDeltas) {
        const one = pick(d);
        if (!one.valid || one.used === null) return { valid: false, used: null };
        used += one.used;
      }
      return { valid: true, used };
    };
    const deltas = { core: sumDelta((d) => d.core), graphql: sumDelta((d) => d.graphql) };
    if ((!deltas.core.valid || !deltas.graphql.valid) && runOutcome === "complete") runOutcome = "invalidated-straddle"; // R4

    const requests: Record<string, number> = {};
    let measuredCostSum = 0;
    let imputed = 0;
    let secondarySignals = 0;
    for (const r of httpRecords) {
      if (r.servedFromCache) continue;
      requests[r.requestClass] = (requests[r.requestClass] ?? 0) + 1;
      if (r.kind === "graphql") {
        if (r.pointsCost !== null) measuredCostSum += r.pointsCost;
        else imputed += 1;
        if (r.pointsCost !== null && r.pointsCost > cfg.budget.pMaxPointsPerGraphqlAttempt)
          throw new BenchProtocolError(`R5 frozen-assumption breach: measured cost ${r.pointsCost} exceeds P_max ${cfg.budget.pMaxPointsPerGraphqlAttempt} — halt for freeze repair`);
      }
      if (r.secondarySignal !== null) secondarySignals++;
    }
    if (deltas.core.valid && deltas.core.used !== null && deltas.core.used > wc.core)
      throw new BenchProtocolError(`R5 frozen-assumption breach: core consumption ${deltas.core.used} overran WC ${wc.core} — halt for freeze repair`);
    if (deltas.graphql.valid && deltas.graphql.used !== null && deltas.graphql.used > Math.max(wc.graphql, 1))
      throw new BenchProtocolError(`R5 frozen-assumption breach: graphql consumption ${deltas.graphql.used} overran WC ${wc.graphql} — halt for freeze repair`);

    const horizon = outstandingHorizonMs(gh);
    const washoutAppliedMs = washoutMs(cfg, horizon, this.now());

    const record: RunRecord = {
      type: "run", schemaVersion: 1, pos: row.pos, unit: row.unit, driver: row.driver, rep: row.rep,
      probe: row.probe, phase, acquisitionForm: outcome?.acquisitionForm ?? (needsClonePath ? form : null),
      startedAtIso, wallMs, segments: segmentSizes.length, outcome: runOutcome, failureCause,
      requests, secondarySignals,
      points: { measuredCostSum, imputed },
      bucketDeltas: deltas,
      httpBodyBytes: outcome?.httpBodyBytes ?? 0,
      cloneObjectStoreBytes,
      diskSampledPeakBytes: disk.peakBytes, diskSamples: disk.samples,
      fallbackSpend: outcome?.fallbackSpend ?? 0,
      routesDelivered: verification?.routesDelivered ?? {},
      g1Failures: verification?.g1Failures.length ?? 0,
      g2Failures: verification?.g2Failures.length ?? 0,
      washoutAppliedMs,
      envManifestHash: this.manifestHash,
      harnessCommit: this.o.runsLog.manifest.harnessCommit,
    };
    this.o.runsLog.append(record);
    if (verification !== null && (verification.g1Failures.length > 0 || verification.g2Failures.length > 0)) {
      this.o.log(`${row.unit} ${row.driver} rep${row.rep}: G1=${verification.g1Failures.length} G2=${verification.g2Failures.length}`);
      for (const f of [...verification.g1Failures.slice(0, 5)]) this.o.log(`  G1 ${f.path} [${f.route}]: ${f.reason}`);
      for (const f of [...verification.g2Failures.slice(0, 5)]) this.o.log(`  G2 ${f.path}: ${f.reason}`);
    }
    // §4.5 washout between consecutive runs — the caller sequences runs, we sleep here
    this.o.log(`washout ${Math.ceil(washoutAppliedMs / 1000)}s (horizon ${horizon === 0 ? "none" : new Date(horizon).toISOString()})`);
    await this.sleep(washoutAppliedMs);
    return { outcome, verification, record };
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

  // §9 diagnostic pilot: K reps of the pinned pilot driver on the pinned slot; the spread feeds
  // the frozen noise-band formula. Declared non-decision.
  async runPilot(schedulePositions: number): Promise<{ walls: number[]; spread: number }> {
    const cfg = this.o.cfg;
    const slot = this.o.corpus.performance.find((s) => s.slot === cfg.pilot.slot) ?? ((): never => {
      throw new BenchProtocolError(`pilot slot ${cfg.pilot.slot} not pinned`);
    })();
    const unit = slot.units[0]!;
    const walls: number[] = [];
    for (let rep = 1; rep <= cfg.pilot.reps; rep++) {
      const handle = await this.runOne(
        { pos: schedulePositions + rep, unit: unit.unitId, driver: cfg.pilot.driver, rep, probe: false },
        "pilot",
      );
      if (handle.record.outcome !== "complete")
        throw new BenchProtocolError(`pilot rep ${rep} did not complete: ${handle.record.outcome} (${handle.record.failureCause ?? ""})`);
      if ((handle.verification?.g1Failures.length ?? 0) > 0 || (handle.verification?.g2Failures.length ?? 0) > 0)
        throw new BenchProtocolError(`pilot rep ${rep} failed verification`);
      walls.push(handle.record.wallMs);
      this.o.log(`pilot rep ${rep}/${cfg.pilot.reps}: wall ${handle.record.wallMs}ms`);
    }
    const spread = Math.max(...walls) / Math.min(...walls);
    return { walls, spread };
  }
}
