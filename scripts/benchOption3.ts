// benchOption3.ts — Option 3's compositional evaluation (resolution plan §4.4): Option 3 is
// NOT a driver (the ADR itself concludes it composes with any transport), so it is evaluated
// the way the plan prescribes: (1) an offline duplicate-OID analysis over the pinned corpus
// trees — no network, pure arithmetic over the committed selected/*.json — and (2) one warm-run
// scenario on the commit pair frozen in corpus.json at Step B (base = the parent of C1-main's
// pin, advanced = the pin), each side's workload computed by the production selection rules,
// re-run with and without an OID-keyed content cache, on the §4.7 rule's recommended driver if
// one exists, else on both finalists (T1 and T2c). For clone drivers the analysis STATES what
// git's native object reuse already provides instead of pretending a uniform caching layer.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { restFallbackBudgetFor, type BenchConfig } from "./benchConfig.ts";
import type { Corpus, CorpusUnit, PerformanceSlot } from "./benchCorpus.ts";
import type { DriverId } from "./benchSchedule.ts";
import type { AuditDb } from "./db.ts";
import type { GithubClient } from "./github.ts";
import type { TreeEntry } from "./unitPipeline.ts";
import { recordSelection, type UnitWorkload, type WorkloadEntry } from "./benchWorkload.ts";
import { parseLsTreeZ, type LsTreeEntry } from "./benchFrame.ts";
import { runBenchGit } from "./benchSpawn.ts";
import { gitBlobOid, makeBuckets, outstandingHorizonMs, readRateLimit, type BenchGhContext, type BenchHttpAttemptRecord, type RateLimitSnapshot } from "./benchGh.ts";
import { acquireStore, runDriver, type DriverRunContext } from "./benchDrivers.ts";
import { bucketDelta, computeWorstCase, makeChildPool, washoutMs } from "./benchProtocol.ts";
import { BenchProbeError } from "./benchConcurrencyProbe.ts";
import { classifyFile } from "./cliScanner.ts";

// the honest composition statement the plan demands (§4.4) — a fixed conclusion of the design
// analysis, stated once here and quoted into option3.json and the report
export const CLONE_COMPOSITION_STATEMENT =
  "OID-keyed content caching composes with the API read paths (T0/T1): a cache hit skips a REST request or shrinks a GraphQL batch, which is exactly what the warm legs measure. On the clone paths (T2a/T2c) the unit's cost is dominated by whole-branch pack transfer, which an OID-keyed CONTENT cache does not reduce — a warm T2c leg still clones the branch and saves only local cat-file reads (microseconds each). What git natively provides in this direction is incremental object transfer against a PERSISTED prior store (fetch negotiation); production's fresh-clone-per-unit design has no persisted store, so that reuse is a different architecture (a shared object store), not a cache layer over the measured drivers.";

export class BenchOption3Error extends Error {
  constructor(message: string) {
    super(`BENCH OPTION3: ${message}`);
    this.name = "BenchOption3Error";
  }
}

// ---- offline duplicate-OID analysis (pure, CI-tested) ----------------------------------------
export interface OidUnitStats {
  unit: string;
  readEntries: number;
  distinctOids: number;
  withinUnitDuplicateReads: number; // reads served by an oid already read in the SAME unit
}
export interface OidPairStats {
  a: string;
  b: string;
  sharedOids: number;
  minDistinct: number;
  shareRatio: number; // |A∩B| / min(|A|,|B|) — the C1 pinning measure, over SELECTED reads
}
export interface OidDuplicationReport {
  perUnit: OidUnitStats[];
  c1Pairwise: OidPairStats[];
  c1Estate: { totalReads: number; distinctOids: number; cacheableReads: number };
  corpusEstate: { totalReads: number; distinctOids: number; cacheableReads: number };
}

export function analyzeOidDuplication(corpus: Corpus, workloads: ReadonlyMap<string, UnitWorkload>): OidDuplicationReport {
  const perUnit: OidUnitStats[] = [];
  const unitOids = new Map<string, string[]>(); // read-entry oids, with multiplicity
  for (const slot of corpus.performance) {
    for (const unit of slot.units) {
      const w = workloads.get(unit.unitId);
      if (w === undefined) throw new BenchOption3Error(`no pinned workload for ${unit.unitId}`);
      const oids = w.entries.filter((e) => e.read).map((e) => e.blobOid);
      unitOids.set(unit.unitId, oids);
      const distinct = new Set(oids).size;
      perUnit.push({ unit: unit.unitId, readEntries: oids.length, distinctOids: distinct, withinUnitDuplicateReads: oids.length - distinct });
    }
  }
  const c1 = corpus.performance.find((s) => s.slot === "C1");
  if (c1 === undefined) throw new BenchOption3Error("corpus has no C1 slot");
  const c1Pairwise: OidPairStats[] = [];
  for (let i = 0; i < c1.units.length; i++) {
    for (let j = i + 1; j < c1.units.length; j++) {
      const a = c1.units[i]!.unitId;
      const b = c1.units[j]!.unitId;
      const setA = new Set(unitOids.get(a) ?? []);
      const setB = new Set(unitOids.get(b) ?? []);
      const shared = [...setA].filter((o) => setB.has(o)).length;
      const minDistinct = Math.min(setA.size, setB.size);
      c1Pairwise.push({ a, b, sharedOids: shared, minDistinct, shareRatio: minDistinct === 0 ? 0 : shared / minDistinct });
    }
  }
  const estate = (unitIds: readonly string[]): { totalReads: number; distinctOids: number; cacheableReads: number } => {
    let total = 0;
    const distinct = new Set<string>();
    for (const id of unitIds) {
      const oids = unitOids.get(id) ?? [];
      total += oids.length;
      for (const o of oids) distinct.add(o);
    }
    // an estate-wide OID-keyed cache serves every read after an oid's first — the UPPER BOUND
    // Option 3 could remove, before any transport is chosen
    return { totalReads: total, distinctOids: distinct.size, cacheableReads: total - distinct.size };
  };
  return {
    perUnit, c1Pairwise,
    c1Estate: estate(c1.units.map((u) => u.unitId)),
    corpusEstate: estate([...unitOids.keys()]),
  };
}

// ---- the warm-run scenario -------------------------------------------------------------------
export interface Option3LegResult {
  leg: "base-cold" | "advanced-cold" | "advanced-warm";
  wallMs: number;
  requests: Record<string, number>;
  graphqlPointsSum: number;
  httpBodyBytes: number;
  fallbackSpend: number;
  deliveries: number;
  // read entries the OID cache SERVED inside the timed wall — each one a real lookup plus a
  // hash re-verification of the stored bytes, so the warm wall carries the cache's true
  // per-read service cost, never a zero-cost analytical shortcut (codex C0-R2 finding 6)
  cacheHits: number;
  bucketBefore: RateLimitSnapshot;
  bucketAfter: RateLimitSnapshot;
  // a reset epoch moved under a consumed bucket during the leg — its wall may contain a
  // window boundary; the leg is flagged rather than silently reported (codex C0-R3 finding 8)
  straddledReset: boolean;
  failureCause: string | null;
}
export interface Option3DriverScenario {
  driver: DriverId;
  legs: Option3LegResult[];
}
export interface Option3ScenarioDeps {
  cfg: BenchConfig;
  corpus: Corpus;
  advancedWorkload: UnitWorkload; // C1-main's pinned workload (the advanced side, from selected/)
  client: GithubClient;
  makeDb: (name: string) => AuditDb;
  disposeDb: (db: AuditDb, name: string) => void;
  benchRoot: string;
  gitEnv: Record<string, string>;
  drivers: readonly DriverId[]; // the rule's recommendation, else both finalists (§4.4)
  log: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

// derive the BASE side's workload with the production selection rules, reading from a
// SHA-pinned local store (scenario preparation, pinning-lane tooling — not a measured leg)
async function deriveBaseWorkload(deps: Option3ScenarioDeps, slot: PerformanceSlot, baseUnit: CorpusUnit, gh: BenchGhContext): Promise<{ workload: UnitWorkload; treeOid: string }> {
  const runDir = join(deps.benchRoot, "option3-base-derive");
  mkdirSync(runDir, { recursive: true });
  try {
    const ctx: DriverRunContext = {
      cfg: deps.cfg, slot, unit: baseUnit, workload: null as unknown as UnitWorkload, gh,
      benchRoot: deps.benchRoot, runDir, gitEnv: deps.gitEnv, spawnObserver: () => {},
      acquisitionForm: "scaffolding", fallbackBudget: 0,
    };
    const { dir } = await acquireStore(ctx, { checkout: false });
    // the REST trees endpoint takes a TREE oid; handing it the commit SHA would fail the
    // parser's root-oid echo check on every T1 leg (codex C0-R1 finding 15)
    const treeOut = await runBenchGit({
      argv: ["rev-parse", `${baseUnit.sha}^{tree}`], lane: { lane: "pinning" }, env: deps.gitEnv,
      benchRoot: deps.benchRoot, cwd: dir,
      limits: { maxStdoutBytes: 4096, maxStderrBytes: 4096, deadlineMs: deps.cfg.spawn.timeoutMs },
    });
    if (treeOut.exitCode !== 0) throw new BenchOption3Error(`base tree resolution failed: ${text(treeOut.stderr).slice(0, 200)}`);
    const treeOid = text(treeOut.stdout).trim();
    const lsOut = await runBenchGit({
      argv: ["ls-tree", "-r", "-z", "-l", "--full-tree", baseUnit.sha],
      lane: { lane: "transport", objectFormat: slot.objectFormat }, env: deps.gitEnv,
      benchRoot: deps.benchRoot, cwd: dir,
      limits: { maxStdoutBytes: deps.cfg.lsTree.maxOutputBytes, maxStderrBytes: 1024 * 1024, deadlineMs: deps.cfg.spawn.timeoutMs },
    });
    if (lsOut.exitCode !== 0) throw new BenchOption3Error(`base ls-tree failed: ${text(lsOut.stderr).slice(0, 200)}`);
    const ls = parseLsTreeZ(lsOut.stdout, slot.objectFormat, { maxEntries: deps.cfg.lsTree.maxEntries, maxRecordBytes: deps.cfg.lsTree.maxRecordBytes });
    const lsIndex = new Map<string, LsTreeEntry>(ls.map((e) => [e.path, e]));
    const entries: TreeEntry[] = ls.map((e) => ({ path: e.path, type: e.type, sha: e.oid, size: e.size }));
    const readFile = async (path: string, entry: TreeEntry): Promise<string | null> => {
      if (entry.type !== "blob") return null;
      const out = await runBenchGit({
        argv: ["cat-file", "blob", entry.sha], lane: { lane: "pinning" }, env: deps.gitEnv,
        benchRoot: deps.benchRoot, cwd: dir,
        limits: { maxStdoutBytes: deps.cfg.spawn.outputCapBytes, maxStderrBytes: 4096, deadlineMs: deps.cfg.spawn.timeoutMs },
      });
      if (out.exitCode !== 0) return null;
      return text(out.stdout);
    };
    const rec = await recordSelection({
      loc: { githubHost: deps.cfg.githubHost, organization: slot.owner, repository: slot.repo, branch: baseUnit.branch, commitSha: baseUnit.sha },
      trackedPackages: deps.cfg.selection.trackedPackages,
      excludeDirGlobs: deps.cfg.selection.excludeDirGlobs,
      maxScanBytes: deps.cfg.selection.maxScanBytes,
      entries, readFile,
    });
    const workloadEntries: WorkloadEntry[] = [];
    for (const path of rec.readPaths) {
      const e = lsIndex.get(path);
      if (e === undefined || e.size === null) throw new BenchOption3Error(`selected ${path} missing from the base ls-tree`);
      workloadEntries.push({
        path, mode: e.mode, blobOid: e.oid, size: e.size, class: rec.classes.get(path) ?? "source",
        read: true, noReadReason: null, canonicalSeamSha256: null, rawSha256: null,
        restDerefSeamSha256: null, checkoutSeamSha256: null, gql: null,
      });
    }
    for (const nr of rec.noReads) {
      const e = lsIndex.get(nr.path);
      workloadEntries.push({
        path: nr.path, mode: e?.mode ?? "100644", blobOid: e?.oid ?? "0".repeat(slot.objectFormat === "sha1" ? 40 : 64),
        size: e?.size ?? 0, class: nr.reason === "binary-lockfile-skip" ? "lockfile" : (classifyFile(nr.path) !== "other" ? "cli" : "source"),
        read: false, noReadReason: nr.reason,
        canonicalSeamSha256: null, rawSha256: null, restDerefSeamSha256: null, checkoutSeamSha256: null, gql: null,
      });
    }
    return {
      workload: {
        unit: `option3-base:${slot.owner}/${slot.repo}@${baseUnit.sha.slice(0, 12)}`,
        sha: baseUnit.sha, treeOid, objectFormat: slot.objectFormat,
        generatedAtIso: new Date(deps.now()).toISOString(), truncatedTree: false, escapeTripped: false,
        batchContentBytesCap: deps.cfg.t1.batchContentBytesCap, entries: workloadEntries, routes: {},
      },
      treeOid,
    };
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

// a leg's workload under the OID cache: read entries whose blob oid is already cached are
// SERVED BY THE CACHE (removed from the leg — that is what an OID-keyed layer does), counted
const applyOidCache = (workload: UnitWorkload, cache: ReadonlySet<string>): { reduced: UnitWorkload; hits: number } => {
  // symlink entries never participate: their delivery is the REST dereference (target bytes),
  // not the link blob the cache would key on — the same predicate as arming/serving (C0-R3 f.11)
  const kept = workload.entries.filter((e) => !e.read || e.mode === "120000" || !cache.has(e.blobOid));
  return { reduced: { ...workload, entries: kept }, hits: workload.entries.length - kept.length };
};

export async function runOption3WarmScenario(deps: Option3ScenarioDeps): Promise<{ pair: { baseSha: string; advancedSha: string }; baseSelection: { reads: number; noReads: number }; scenarios: Option3DriverScenario[] }> {
  const scenario = deps.corpus.option3WarmScenario;
  if (scenario === null) throw new BenchOption3Error("corpus.json carries no frozen option3WarmScenario pair");
  const slot = deps.corpus.performance.find((s) => s.slot === "C1" && s.owner === scenario.owner && s.repo === scenario.repo);
  if (slot === undefined) throw new BenchOption3Error("the frozen pair's repository is not the pinned C1 slot");
  if (deps.advancedWorkload.sha !== scenario.advancedSha)
    throw new BenchOption3Error(`advanced workload sha ${deps.advancedWorkload.sha.slice(0, 12)} is not the frozen advanced sha`);
  const c1main = slot.units[0]!;
  const buckets = makeBuckets();
  const meta: BenchGhContext = {
    client: deps.client, db: null, cfg: deps.cfg, core: buckets.core, graphql: buckets.graphql,
    record: () => {}, now: deps.now, sleep: deps.sleep,
  };
  const baseUnitSeed: CorpusUnit = { unitId: "option3-base", branch: c1main.branch, sha: scenario.baseSha, treeOid: scenario.baseSha };
  const derived = await deriveBaseWorkload(deps, slot, baseUnitSeed, meta);
  const baseWorkload = derived.workload;
  const baseUnit: CorpusUnit = { ...baseUnitSeed, treeOid: derived.treeOid };
  const baseReads = baseWorkload.entries.filter((e) => e.read);
  deps.log(`option3 base side: ${baseReads.length} reads + ${baseWorkload.entries.length - baseReads.length} no-reads at ${scenario.baseSha.slice(0, 12)} (tree ${derived.treeOid.slice(0, 12)})`);
  const oidByPath = new Map(baseWorkload.entries.map((e) => [e.path, e.blobOid]));

  const scenarios: Option3DriverScenario[] = [];
  for (const driver of deps.drivers) {
    if (driver !== "T1" && driver !== "T2c" && driver !== "T0" && driver !== "T2a")
      throw new BenchOption3Error(`unknown driver ${String(driver)}`);
    const legs: Option3LegResult[] = [];
    // the warm cache arms from THIS driver's own base leg — and only from oids whose CONTENT
    // was actually DELIVERED on a primary route with a faithful byte round-trip (a planned-
    // but-failed read, a symlink dereference — whose bytes are the TARGET's, keyed by the
    // LINK's oid — or lossy non-UTF-8 content must never pre-warm the cache; codex C0-R1/R2
    // finding 15). The cache stores CONTENT, not membership: the warm leg serves each hit
    // inside its timed wall with a real lookup + hash re-verification (C0-R2 finding 6).
    const modeByPath = new Map(baseWorkload.entries.map((e) => [e.path, e.mode]));
    const baseDeliveredContent = new Map<string, string>();
    const legPlans: Array<{ leg: Option3LegResult["leg"]; unit: CorpusUnit; makeWorkload: () => { workload: UnitWorkload; hits: number } }> = [
      { leg: "base-cold", unit: baseUnit, makeWorkload: () => ({ workload: baseWorkload, hits: 0 }) },
      { leg: "advanced-cold", unit: c1main, makeWorkload: () => ({ workload: deps.advancedWorkload, hits: 0 }) },
      {
        leg: "advanced-warm", unit: c1main,
        makeWorkload: () => {
          const { reduced, hits } = applyOidCache(deps.advancedWorkload, new Set(baseDeliveredContent.keys()));
          return { workload: reduced, hits };
        },
      },
    ];
    for (const legPlan of legPlans) {
      const { workload: legWorkload, hits } = legPlan.makeWorkload();
      const plan = { leg: legPlan.leg, workload: legWorkload, unit: legPlan.unit, hits };
      const records: BenchHttpAttemptRecord[] = [];
      const dbName = `option3-${driver}-${plan.leg}`;
      const db = deps.makeDb(dbName);
      const runDir = join(deps.benchRoot, `option3-${driver}-${plan.leg}`);
      mkdirSync(runDir, { recursive: true });
      const liveState = { fallbackSpend: 0, routesDelivered: {} as Record<string, number> };
      const gh: BenchGhContext = {
        client: deps.client, db, cfg: deps.cfg, core: buckets.core, graphql: buckets.graphql,
        record: (r) => records.push(r), now: deps.now, sleep: deps.sleep,
      };
      const reads = plan.workload.entries.filter((e) => e.read).length;
      const ctx: DriverRunContext = {
        cfg: deps.cfg, slot, unit: plan.unit, workload: plan.workload, gh,
        benchRoot: deps.benchRoot, runDir, gitEnv: deps.gitEnv, spawnObserver: () => {},
        acquisitionForm: "scaffolding", // both shas are pinned objects; the branch head has moved on
        // the fallback budget is a FROZEN function of the full selected set — deriving it from
        // the cache-reduced workload would shrink the warm leg's allowance and fail it on a
        // fallback pattern the cold legs tolerate (codex C0-R2 finding 7)
        fallbackBudget: restFallbackBudgetFor(deps.cfg, plan.leg === "base-cold" ? baseWorkload.entries.length : deps.advancedWorkload.entries.length),
        liveState,
      };
      // §4.8 admission before the timer, at the EXACT driver worst case under the frozen
      // headroom factor — heuristic under-reservation could let a legal retry/split sleep
      // across a reset inside the measured wall (codex C0-R2 finding 8; C0-R3 finding 8).
      // Only buckets the driver can consume from gate admission.
      void reads;
      const wc = computeWorstCase(driver, plan.workload, deps.cfg, { owner: slot.owner, repo: slot.repo });
      const needCore = Math.ceil(wc.core * deps.cfg.budget.headroomFactor);
      const needGraphql = Math.ceil(wc.graphql * deps.cfg.budget.headroomFactor);
      for (;;) {
        const snap = await readRateLimit(meta);
        if ((wc.core === 0 || snap.core.remaining >= needCore) && (wc.graphql === 0 || snap.graphql.remaining >= needGraphql)) break;
        const wait = Math.max(Math.max(snap.core.reset, snap.graphql.reset) * 1000 + 5000 - deps.now(), 30_000);
        deps.log(`option3 ${driver} ${plan.leg}: headroom short (WC core ${wc.core}/graphql ${wc.graphql}) — sleeping ${Math.ceil(wait / 1000)}s`);
        await deps.sleep(wait);
      }
      const bucketBefore = await readRateLimit(meta);
      const startedAt = deps.now();
      let deliveries = 0;
      let servedFromCache = 0;
      let failureCause: string | null = null;
      try {
        if (plan.leg === "advanced-warm") {
          // the cache SERVICE is part of the timed wall: look up and hash-verify every hit
          for (const entry of deps.advancedWorkload.entries) {
            if (!entry.read || entry.mode === "120000") continue;
            const cached = baseDeliveredContent.get(entry.blobOid);
            if (cached === undefined) continue;
            if (gitBlobOid(Buffer.from(cached, "utf8"), slot.objectFormat) !== entry.blobOid)
              throw new BenchOption3Error(`cached content for ${entry.blobOid.slice(0, 12)} failed re-verification at serve time`);
            servedFromCache++;
          }
        }
        const res = await runDriver(driver, ctx, makeChildPool(deps.cfg.frame.childPoolSize));
        deliveries = res.deliveries.length + servedFromCache;
        if (plan.leg === "base-cold") {
          for (const d of res.deliveries) {
            if (d.route !== "primary" || d.delivered === null) continue;
            if (modeByPath.get(d.path) === "120000") continue; // dereference bytes, wrong key — never cached
            const oid = oidByPath.get(d.path);
            // only faithfully round-trippable content is cache-eligible: the stored string
            // must re-encode to bytes that hash to the oid, or serving it would deliver
            // corrupted (replacement-charactered) bytes
            if (oid !== undefined && gitBlobOid(Buffer.from(d.delivered, "utf8"), slot.objectFormat) === oid)
              baseDeliveredContent.set(oid, d.delivered);
          }
        }
      } catch (e) {
        failureCause = e instanceof Error ? `${e.name}: ${e.message.slice(0, 300)}` : String(e);
      } finally {
        deps.disposeDb(db, dbName);
        rmSync(runDir, { recursive: true, force: true });
      }
      const wallMs = deps.now() - startedAt;
      const bucketAfter = await readRateLimit(meta);
      // a leg is flagged only for buckets it actually CONSUMED from — an unconsumed bucket's
      // epoch rolling over during the leg is not evidence about the leg (codex C0-R4 finding 3)
      const consumedCore = records.some((r) => !r.servedFromCache && r.kind === "rest" && r.requestClass !== "rest-meta");
      const consumedGraphql = records.some((r) => !r.servedFromCache && r.kind === "graphql");
      const legStraddled =
        (consumedCore && !bucketDelta(bucketBefore.core, bucketAfter.core).valid) ||
        (consumedGraphql && !bucketDelta(bucketBefore.graphql, bucketAfter.graphql).valid);
      if (legStraddled) deps.log(`option3 ${driver} ${plan.leg}: a reset window moved under a consumed bucket — flagged (wall may span a boundary)`);
      const requests: Record<string, number> = {};
      let points = 0;
      let bodyBytes = 0;
      for (const r of records) {
        if (r.servedFromCache) continue;
        requests[r.requestClass] = (requests[r.requestClass] ?? 0) + 1;
        if (r.kind === "graphql") points += r.pointsCost ?? 1;
        if (r.requestClass !== "rest-meta") bodyBytes += r.bodyBytes;
      }
      legs.push({
        leg: plan.leg, wallMs, requests, graphqlPointsSum: points, httpBodyBytes: bodyBytes,
        fallbackSpend: liveState.fallbackSpend, deliveries, cacheHits: servedFromCache,
        bucketBefore, bucketAfter, straddledReset: legStraddled, failureCause,
      });
      if (plan.leg === "base-cold" && failureCause !== null)
        deps.log(`option3 ${driver}: base leg failed — the warm leg arms an EMPTY cache (hits will be 0)`);
      deps.log(`option3 ${driver} ${plan.leg}: wall ${wallMs}ms, ${deliveries} deliveries, ${plan.hits} cache hits${failureCause === null ? "" : `, FAILED: ${failureCause}`}`);
      const wash = washoutMs(deps.cfg, outstandingHorizonMs(meta), deps.now());
      await deps.sleep(wash);
    }
    scenarios.push({ driver, legs });
  }
  return {
    pair: { baseSha: scenario.baseSha, advancedSha: scenario.advancedSha },
    baseSelection: { reads: baseReads.length, noReads: baseWorkload.entries.length - baseReads.length },
    scenarios,
  };
}
