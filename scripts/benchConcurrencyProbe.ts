// benchConcurrencyProbe.ts — the §4.5 concurrency probe: C1's four branch units as 4
// concurrent streams, for T0 and then for T1, recording every secondary-limit signal. The
// serial matrix cannot observe the shared REST/GraphQL secondary limits that concern Option
// 1's scheduler; this probe evidences the scheduler requirement WITHOUT scoring it — results
// are reported, never ranked, and G4's attributability classifier excludes probe traffic by
// construction (it reads matrix rows only).
//
// Faithfulness notes: all four streams share ONE GithubClient (one process-launch semaphore —
// production's global in-flight cap) and ONE bucket-pause pair (a primary/secondary horizon
// armed by any stream gates every stream, production's global pause semantics). Each stream
// keeps its own cold cache DB and run dir. Admission control deviates from §4.8's matrix WC
// discipline DELIBERATELY: four concurrent worst cases exceed a full bucket by construction
// (each C1×T0 WC alone reserves ~⅗ of the bucket), so the probe admits on expected actual
// spend with margin instead — it is untimed and informational, and an exhausted bucket would
// surface as a recorded primary throttle, which is itself probe data.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BenchConfig } from "./benchConfig.ts";
import type { Corpus, CorpusUnit, PerformanceSlot } from "./benchCorpus.ts";
import type { UnitWorkload } from "./benchWorkload.ts";
import type { DriverId } from "./benchSchedule.ts";
import type { AuditDb } from "./db.ts";
import type { GithubClient } from "./github.ts";
import { makeBuckets, outstandingHorizonMs, readRateLimit, type BenchGhContext, type BenchHttpAttemptRecord, type RateLimitSnapshot } from "./benchGh.ts";
import { runDriver, type DriverRunContext } from "./benchDrivers.ts";
import { makeChildPool, verifyDeliveries, washoutMs } from "./benchProtocol.ts";

export class BenchProbeError extends Error {
  constructor(message: string) {
    super(`BENCH PROBE: ${message}`);
    this.name = "BenchProbeError";
  }
}

export const CONCURRENCY_PROBE_DRIVERS: readonly DriverId[] = ["T0", "T1"];
const ADMISSION_MARGIN = 1.2;

export interface ConcurrencyStreamResult {
  unit: string;
  outcome: "complete" | "failed";
  failureCause: string | null;
  wallMs: number;
  requests: Record<string, number>;
  fivexx: number;
  retries: number;
  secondarySignals: number;
  secondarySignalDetail: Array<{ atMs: number; kind: string; requestClass: string; status: number }>;
  g1Failures: number;
  g2Failures: number;
  httpBodyBytes: number;
}

export interface ConcurrencyDriverBlock {
  driver: DriverId;
  admittedAtIso: string;
  before: RateLimitSnapshot;
  after: RateLimitSnapshot;
  streams: ConcurrencyStreamResult[];
}

export interface ConcurrencyProbeDeps {
  cfg: BenchConfig;
  corpus: Corpus;
  workloads: Map<string, UnitWorkload>;
  client: GithubClient; // ONE client — the shared subprocess semaphore is the point
  makeDb: (name: string) => AuditDb;
  disposeDb: (db: AuditDb, name: string) => void;
  benchRoot: string;
  gitEnv: Record<string, string>;
  log: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function c1Slot(corpus: Corpus): { slot: PerformanceSlot; units: CorpusUnit[] } {
  const slot = corpus.performance.find((s) => s.slot === "C1");
  if (slot === undefined || slot.units.length < 4)
    throw new BenchProbeError(`the probe needs C1's 4 branch units; corpus has ${slot?.units.length ?? 0}`);
  return { slot, units: slot.units.slice(0, 4) };
}

// expected actual spend, not worst case (see the header): per T0 stream ≈ reads + tree + the
// measured-at-pinning fallback expectation; per T1 stream the planned batches + fallbacks.
function expectedSpend(driver: DriverId, workloads: readonly UnitWorkload[]): { core: number; graphql: number } {
  let core = 0;
  let graphql = 0;
  for (const w of workloads) {
    const reads = w.entries.filter((e) => e.read).length;
    const symlinks = w.entries.filter((e) => e.read && e.mode === "120000").length;
    if (driver === "T0") core += reads + 1;
    else {
      core += 1 + symlinks + Math.ceil(reads * 0.05);
      graphql += Math.ceil(reads / 50) + 4;
    }
  }
  return { core, graphql };
}

export async function runConcurrencyProbe(deps: ConcurrencyProbeDeps): Promise<ConcurrencyDriverBlock[]> {
  const { slot, units } = c1Slot(deps.corpus);
  const buckets = makeBuckets(); // ONE pause pair shared by all streams
  const meta: BenchGhContext = {
    client: deps.client, db: null, cfg: deps.cfg, core: buckets.core, graphql: buckets.graphql,
    record: () => {}, now: deps.now, sleep: deps.sleep,
  };
  const blocks: ConcurrencyDriverBlock[] = [];
  for (const driver of CONCURRENCY_PROBE_DRIVERS) {
    const workloads = units.map((u) => deps.workloads.get(u.unitId) ?? ((): never => {
      throw new BenchProbeError(`no pinned workload for ${u.unitId}`);
    })());
    for (const w of workloads) {
      if (w.truncatedTree) throw new BenchProbeError(`${w.unit} is truncated — the probe's C1 premise does not hold`);
    }
    const need = expectedSpend(driver, workloads);
    for (;;) {
      const snap = await readRateLimit(meta);
      const needCore = Math.ceil(need.core * ADMISSION_MARGIN);
      const needGraphql = Math.ceil(need.graphql * ADMISSION_MARGIN);
      deps.log(`concurrency ${driver}: need core ${needCore} (have ${snap.core.remaining}), graphql ${needGraphql} (have ${snap.graphql.remaining})`);
      if (snap.core.remaining >= needCore && snap.graphql.remaining >= needGraphql) break;
      const wait = Math.max(Math.max(snap.core.reset, snap.graphql.reset) * 1000 + 5000 - deps.now(), 30_000);
      deps.log(`concurrency ${driver}: headroom short — sleeping ${Math.ceil(wait / 1000)}s to the reset epoch`);
      await deps.sleep(wait);
    }
    const before = await readRateLimit(meta);
    const admittedAtIso = new Date(deps.now()).toISOString();
    const streams = await Promise.all(units.map(async (unit, i): Promise<ConcurrencyStreamResult> => {
      const workload = workloads[i]!;
      const records: BenchHttpAttemptRecord[] = [];
      const dbName = `concurrency-${driver}-${i}`;
      const db = deps.makeDb(dbName);
      const runDir = join(deps.benchRoot, `concurrency-${driver}-s${i}`);
      mkdirSync(runDir, { recursive: true });
      const gh: BenchGhContext = {
        client: deps.client, db, cfg: deps.cfg, core: buckets.core, graphql: buckets.graphql,
        record: (r) => records.push(r), now: deps.now, sleep: deps.sleep,
      };
      const ctx: DriverRunContext = {
        cfg: deps.cfg, slot, unit, workload, gh, benchRoot: deps.benchRoot, runDir,
        gitEnv: deps.gitEnv, spawnObserver: () => {}, acquisitionForm: "production",
        fallbackBudget: Math.max(deps.cfg.restFallbackBudget.floor, Math.ceil(deps.cfg.restFallbackBudget.fractionOfSelected * workload.entries.length)),
      };
      const startedAt = deps.now();
      let outcome: ConcurrencyStreamResult["outcome"] = "complete";
      let failureCause: string | null = null;
      let g1 = 0;
      let g2 = 0;
      try {
        const res = await runDriver(driver, ctx, makeChildPool(1));
        const verification = verifyDeliveries(workload, res.deliveries, driver, { acquiredPaths: res.acquiredPaths });
        g1 = verification.g1Failures.length;
        g2 = verification.g2Failures.length;
      } catch (e) {
        outcome = "failed";
        failureCause = e instanceof Error ? `${e.name}: ${e.message.slice(0, 300)}` : String(e);
      } finally {
        deps.disposeDb(db, dbName);
        rmSync(runDir, { recursive: true, force: true });
      }
      const wallMs = deps.now() - startedAt;
      const requests: Record<string, number> = {};
      let fivexx = 0;
      let retries = 0;
      const detail: ConcurrencyStreamResult["secondarySignalDetail"] = [];
      let bodyBytes = 0;
      for (const r of records) {
        if (r.servedFromCache) continue;
        requests[r.requestClass] = (requests[r.requestClass] ?? 0) + 1;
        if (r.status >= 500) fivexx++;
        if (r.attempt > 1) retries++;
        if (r.requestClass !== "rest-meta") bodyBytes += r.bodyBytes;
        if (r.secondarySignal !== null) detail.push({ atMs: r.atMs, kind: r.secondarySignal, requestClass: r.requestClass, status: r.status });
      }
      return {
        unit: unit.unitId, outcome, failureCause, wallMs, requests, fivexx, retries,
        secondarySignals: detail.length, secondarySignalDetail: detail,
        g1Failures: g1, g2Failures: g2, httpBodyBytes: bodyBytes,
      };
    }));
    const after = await readRateLimit(meta);
    blocks.push({ driver, admittedAtIso, before, after, streams });
    // washout between the two driver blocks so T0's burst cannot push T1 over a rolling window
    const horizon = outstandingHorizonMs(meta);
    const wash = washoutMs(deps.cfg, horizon, deps.now());
    deps.log(`concurrency ${driver} done — washout ${Math.ceil(wash / 1000)}s`);
    await deps.sleep(wash);
  }
  return blocks;
}
