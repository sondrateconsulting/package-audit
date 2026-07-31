// benchProtocol.test.ts — CI tests for the engine's pure decision pieces: WC formulas,
// segmentation, washout, bucket-delta/straddle, delivery verification, the active-wall clock,
// and the fixed-size child pool.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBenchConfig, restFallbackBudgetFor } from "./benchConfig.ts";
import {
  BenchProtocolError, WallClock, bucketDelta, computeWorstCase, finishMeasuredRun, makeChildPool,
  planSegments, reclaimRunResources, requireToolVersion, summarizeSpawns, summarizeTraffic,
  verifyDeliveries, washoutMs,
} from "./benchProtocol.ts";
import { InlineDiskSampler, WorkerDiskSampler, parseDiskWalkReply } from "./benchDiskSampler.ts";
import { parseDiskWalkRequest } from "./benchDiskWorker.ts";
import { DiskWalkError, duBytes, duBytesStrict, extraBytesStrict } from "./benchDiskWalk.ts";
import { graphqlRecordClassification, parseGraphqlBodyFull, parseRateLimitBucket, type BenchHttpAttemptRecord } from "./benchGh.ts";
import { buildUnitWorkload, seamStringSha256, type WorkloadEntry } from "./benchWorkload.ts";
import type { EntryDelivery } from "./benchDrivers.ts";

const CFG = loadBenchConfig(join(import.meta.dir, "..", "docs", "adrs", "0001-benchmark", "bench-config.json"));
const sha = (c: string): string => c.repeat(40);
const entry = (path: string, over: Partial<WorkloadEntry> = {}): WorkloadEntry => ({
  path, mode: "100644", blobOid: sha("c"), size: 10, class: "source", read: true, noReadReason: null,
  canonicalSeamSha256: seamStringSha256(`content:${path}`), rawSha256: seamStringSha256("raw"),
  restDerefSeamSha256: null, checkoutSeamSha256: seamStringSha256(`co:${path}`),
  gql: { isBinary: false, isTruncated: false, textNull: false },
  ...over,
});
const workloadOf = (n: number, over: Partial<Parameters<typeof buildUnitWorkload>[0]> = {}) =>
  buildUnitWorkload({
    unit: "C2:o/r@main", sha: sha("0"), treeOid: sha("f"), objectFormat: "sha1",
    generatedAtIso: "2026-07-28T00:00:00Z", truncatedTree: false, escapeTripped: false,
    batchContentBytesCap: CFG.t1.batchContentBytesCap,
    entries: Array.from({ length: n }, (_, i) => entry(`f${i}.ts`)),
    ...over,
  });

describe("computeWorstCase — §4.8's exact reservation", () => {
  test("T0: (reads + tree + fallback budget) × attemptCap + the SHA-classifier allowance", () => {
    const w = workloadOf(100);
    const wc = computeWorstCase("T0", w, CFG, { owner: "o", repo: "r" });
    expect(wc.core).toBe((100 + 1 + restFallbackBudgetFor(CFG, 100)) * 6 + 6);
    expect(wc.graphql).toBe(0);
  });
  test("T1: plannedBatches × (1+descendants) × attempts × P_max — never the 1-point floor", () => {
    const w = workloadOf(300);
    const wc = computeWorstCase("T1", w, CFG, { owner: "o", repo: "r" });
    expect(wc.plannedBatches).toBe(2); // 300 aliases under the 250 cap
    expect(wc.graphql).toBe(2 * (1 + 4) * 6 * 10);
    expect(wc.core).toBe((1 + restFallbackBudgetFor(CFG, 300)) * 6 + 6);
  });
  test("clone drivers reserve only the fallback budget; the pinned escape reserves the T0 shape", () => {
    const w = workloadOf(100);
    expect(computeWorstCase("T2c", w, CFG, { owner: "o", repo: "r" }).core).toBe(restFallbackBudgetFor(CFG, 100) * 6 + 6);
    const escaped = workloadOf(100, { escapeTripped: true });
    expect(computeWorstCase("T2a", escaped, CFG, { owner: "o", repo: "r" }).core).toBe((100 + 1 + restFallbackBudgetFor(CFG, 100)) * 6 + 6);
  });
});

describe("planSegments — the feasibility gate", () => {
  test("under capacity: one segment; over capacity: pinned contiguous segments that each fit", () => {
    expect(planSegments("T0", workloadOf(100), CFG, { owner: "o", repo: "r" })).toEqual([100]);
    const big = workloadOf(2000); // WC = (2000+1+200)×6 ≈ 13k ≫ 5000
    const segments = planSegments("T0", big, CFG, { owner: "o", repo: "r" });
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.reduce((a, b) => a + b, 0)).toBe(2000);
    const budget = restFallbackBudgetFor(CFG, 2000);
    for (const s of segments)
      expect(((s + 1 + budget) * CFG.rest.attemptCap + CFG.rest.attemptCap) * CFG.budget.headroomFactor).toBeLessThanOrEqual(CFG.budget.bucketCapacityPerHour);
  });
  test("a non-segmentable driver over capacity is a hard error, not a silent truncation", () => {
    const huge = workloadOf(2000);
    // T2c's WC is budget-only and always fits; force the impossible case via T1 on a
    // pathological fallback budget by checking the guard's error path with T2a non-escape
    expect(planSegments("T2c", huge, CFG, { owner: "o", repo: "r" })).toEqual([2000]);
    expect(() => planSegments("T1", workloadOf(60000), CFG, { owner: "o", repo: "r" })).toThrow(BenchProtocolError);
  });
});

describe("washout + straddle", () => {
  test("washout = max(floor, outstanding horizon)", () => {
    expect(washoutMs(CFG, 0, 1000)).toBe(60_000);
    expect(washoutMs(CFG, 1000 + 90_000, 1000)).toBe(90_000);
  });
  test("a bucket delta is valid within one reset epoch, or when the run itself opened the window (R4 otherwise)", () => {
    expect(bucketDelta({ remaining: 100, reset: 5, used: 4900 }, { remaining: 40, reset: 5, used: 4960 })).toEqual({ valid: true, used: 60 });
    // a consumed bucket whose epoch changed under the run: the straddle, invalid
    expect(bucketDelta({ remaining: 100, reset: 5, used: 4900 }, { remaining: 4990, reset: 6, used: 10 })).toEqual({ valid: false, used: null });
    expect(bucketDelta({ remaining: 100, reset: 5, used: 4900 }, { remaining: 100, reset: 5, used: 4900 })).toEqual({ valid: true, used: 0 });
    // a FULL bucket floats its reset until first consumption — the run opened the window, so
    // after.used is exactly the run's own spend (measured live: pilot rep 1, 2026-07-29)
    expect(bucketDelta({ remaining: 5000, reset: 5, used: 0 }, { remaining: 4940, reset: 9, used: 60 })).toEqual({ valid: true, used: 60 });
    expect(bucketDelta({ remaining: 5000, reset: 5, used: 0 }, { remaining: 5000, reset: 9, used: 0 })).toEqual({ valid: true, used: 0 });
  });
});

describe("verifyDeliveries — G1/G2 bookkeeping against the pinned matrix", () => {
  const w = workloadOf(2, {
    entries: [
      entry("a.ts"),
      entry("bun.lockb", { class: "lockfile", read: false, noReadReason: "binary-lockfile-skip", canonicalSeamSha256: null, rawSha256: null, checkoutSeamSha256: null, gql: null }),
    ],
  });
  const good: EntryDelivery[] = [
    { path: "a.ts", route: "primary", delivered: "content:a.ts", rawVerified: true },
    { path: "bun.lockb", route: "binary-lockfile-skip", delivered: null, rawVerified: null },
  ];
  test("clean deliveries resolve; every entry exactly once", () => {
    const r = verifyDeliveries(w, good, "T0");
    expect(r.resolved).toBe(2);
    expect(r.g1Failures).toEqual([]);
    expect(r.g2Failures).toEqual([]);
    expect(r.probeDivergences).toEqual([]);
    expect(r.routesDelivered).toEqual({ primary: 1, "binary-lockfile-skip": 1 });
  });
  test("wrong bytes = G1; wrong route / missing / duplicate / acquisition-on-no-read = G2 or G1", () => {
    const wrongBytes = verifyDeliveries(w, [{ ...good[0]!, delivered: "tampered" }, good[1]!], "T0");
    expect(wrongBytes.g1Failures.length).toBe(1);
    const wrongRoute = verifyDeliveries(w, [{ ...good[0]!, route: "symlink-fallback" }, good[1]!], "T0");
    expect(wrongRoute.g2Failures.length).toBe(1); // outside the pinned permitted set — no relabeling
    const missing = verifyDeliveries(w, [good[0]!], "T0");
    expect(missing.g2Failures.length).toBe(1);
    const dup = verifyDeliveries(w, [...good, good[0]!], "T0");
    expect(dup.g2Failures.length).toBe(1);
    const acquired = verifyDeliveries(w, [good[0]!, { ...good[1]!, delivered: "bytes!" }], "T0");
    expect(acquired.g1Failures.length).toBe(1); // content acquired on a no-read route
    const foreign = verifyDeliveries(w, [...good, { path: "ghost.ts", route: "primary", delivered: "x", rawVerified: null }], "T0");
    expect(foreign.g2Failures.length).toBe(1);
  });
  test("T1's permitted operational fallbacks pass with the canonical bytes", () => {
    const viaFallback = verifyDeliveries(w, [{ ...good[0]!, route: "batch-error-fallback" }, good[1]!], "T1");
    expect(viaFallback.g2Failures).toEqual([]);
    expect(viaFallback.g1Failures).toEqual([]);
  });
});

describe("WallClock + child pool", () => {
  test("active wall excludes paused spans", () => {
    let t = 0;
    const clock = new WallClock(() => t);
    clock.start();
    t = 100;
    clock.pause();
    t = 500; // a segment sleep
    clock.start();
    t = 650;
    expect(clock.stop()).toBe(250);
  });
  test("the child pool is a fixed-size counting pool with FIFO handoff", async () => {
    const pool = makeChildPool(1);
    const r1 = await pool.acquire();
    let acquired2 = false;
    const p2 = pool.acquire().then((r) => {
      acquired2 = true;
      return r;
    });
    await Promise.resolve();
    expect(acquired2).toBe(false); // capacity 1 — the second waits
    r1();
    const r2 = await p2;
    expect(acquired2).toBe(true);
    r2();
    r2(); // double release is a no-op
    const r3 = await pool.acquire();
    r3();
  });
});

describe("summarizeTraffic — one control-plane rule for EVERY record (F7)", () => {
  // The bug: the R5 halt record summed httpBodyBytes WITHOUT the rest-meta exclusion that the
  // normal record applies, contradicting the invariant this module states twice ("control-plane
  // probes never count as driver traffic"). Two literals computing the same metric two ways is
  // how that drift happened, so both records now derive it from this single helper.
  const httpRec = (over: Partial<BenchHttpAttemptRecord> = {}): BenchHttpAttemptRecord => ({
    type: "http-attempt", atMs: 0, wallMs: 5, kind: "rest", requestClass: "rest-content",
    label: "repos/o/r/contents/a.ts", attempt: 1, status: 200, exitCode: 0, classification: "ok",
    secondarySignal: null, pointsCost: null, remaining: 100, resetEpochSec: 0,
    servedFromCache: false, bodyBytes: 1000, ...over,
  });
  test("rest-meta bodies are excluded from driver traffic", () => {
    const s = summarizeTraffic([
      httpRec({ bodyBytes: 1000 }),
      httpRec({ requestClass: "rest-meta", bodyBytes: 777 }),
    ]);
    expect(s.httpBodyBytes).toBe(1000);
    expect(s.requests["rest-meta"]).toBeUndefined();
  });
  test("cache-served attempts are excluded — they crossed no wire", () => {
    expect(summarizeTraffic([httpRec({ servedFromCache: true, bodyBytes: 999 })]).httpBodyBytes).toBe(0);
  });
  test("5xx, retries, graphql points and imputation are counted off the same pass", () => {
    // 5xx fixtures carry what production actually records for them: classification
    // "transient" (never "ok") AND a nonzero gh exit — gh exits 1 BY DESIGN on every
    // non-2xx response. A status-502/classification-ok/exit-0 record is a combination
    // benchGh cannot emit, and driving the okRequestClasses ledger with it masked defects
    const s = summarizeTraffic([
      httpRec({ status: 502, classification: "transient", exitCode: 1 }),
      httpRec({ attempt: 2 }),
      httpRec({ kind: "graphql", requestClass: "graphql-batch", pointsCost: 3 }),
      httpRec({ kind: "graphql", requestClass: "graphql-batch", pointsCost: null }),
      httpRec({ requestClass: "rest-meta", status: 502, classification: "transient", exitCode: 1, attempt: 3 }), // still excluded everywhere
    ]);
    expect(s.attempts.fivexx).toBe(1);
    expect(s.attempts.retries).toBe(1);
    expect(s.points).toEqual({ measuredCostSum: 3, imputed: 1 });
  });
  test("okRequestClasses excludes a success-shaped GraphQL envelope from a failed gh (truncated-transfer rule)", () => {
    // benchGh records classifyGraphql's envelope verdict ("ok") with gh's exit code alongside;
    // benchT1's analyzer treats exactly this record as an http-failure and retries the
    // dispatch — so the ledger must not count it as the §4.5 R2 "succeeded" evidence
    const s = summarizeTraffic([
      httpRec({ kind: "graphql", requestClass: "graphql-batch", classification: "ok", exitCode: 1 }),
    ]);
    expect(s.okRequestClasses).toEqual([]);
    expect(s.requests["graphql-batch"]).toBe(1); // still counted as an ATTEMPT
  });
  test("okRequestClasses includes graphql-batch when the envelope is ok AND gh exited 0", () => {
    const s = summarizeTraffic([
      httpRec({ kind: "graphql", requestClass: "graphql-batch", classification: "ok", exitCode: 0 }),
    ]);
    expect(s.okRequestClasses).toEqual(["graphql-batch"]);
  });
  test("a transient 5xx attempt never mints an okRequestClasses entry", () => {
    expect(summarizeTraffic([httpRec({ status: 502, classification: "transient", exitCode: 1 })]).okRequestClasses).toEqual([]);
  });
  test("a malformed-body 200 GraphQL record never mints an okRequestClasses entry", () => {
    // benchGh records "malformed-body" for a 200 whose body the envelope parser cannot read —
    // the analyzer treats that dispatch as an http-failure, so even exit 0 must mint nothing
    const s = summarizeTraffic([
      httpRec({ kind: "graphql", requestClass: "graphql-batch", classification: "malformed-body", exitCode: 0 }),
    ]);
    expect(s.okRequestClasses).toEqual([]);
    expect(s.requests["graphql-batch"]).toBe(1);
  });
  test("table-accepted classes reach the ledger even when every record is 'fatal' (partial-data acceptance)", () => {
    // a partial-data 200 (some aliases resolved, one attributed NOT_FOUND) is classification
    // "fatal" on the record — production drops partial data BY DESIGN — while the frozen T1
    // table delivers the resolved aliases; the ledger takes the caller's table-accepted
    // classes so that success is not invisible to §4.5 R2
    const s = summarizeTraffic(
      [httpRec({ kind: "graphql", requestClass: "graphql-batch", classification: "fatal", exitCode: 1 })],
      ["graphql-batch"],
    );
    expect(s.okRequestClasses).toEqual(["graphql-batch"]);
  });
  test("table-accepted classes union and dedupe with record-derived ones, sorted", () => {
    const s = summarizeTraffic(
      [httpRec(), httpRec({ kind: "graphql", requestClass: "graphql-batch", classification: "ok", exitCode: 0 })],
      ["graphql-batch"],
    );
    expect(s.okRequestClasses).toEqual(["graphql-batch", "rest-content"]);
  });
  test("secondary signals are tallied by kind, control-plane excluded", () => {
    const s = summarizeTraffic([
      httpRec({ secondarySignal: "status-429" }),
      httpRec({ requestClass: "rest-meta", secondarySignal: "status-429" }),
    ]);
    expect(s.secondarySignals).toBe(1);
    expect(s.attempts.secondaryByKind["status-429"]).toBe(1);
  });
});

describe("InlineDiskSampler + finish() contract (santa round 2)", () => {
  // Round-1 review: the worker sampler could hang forever, wasn't idempotent, and reused the
  // deliberately-tolerant sampling walk for cloneObjectStoreBytes — a RECORDED measurement that
  // could therefore silently become 0. And because finish() sits between the driver returning
  // and the record being appended, a throw here would have eaten the run row (including an R5
  // halt record, which is the evidence a freeze repair is diagnosed from).
  test("the DEFAULT clone-store walker is strict — an unreadable store is null, not 0", async () => {
    // Regression for a real hole: the first fix injected a THROWING walk in its test, so it
    // stayed green while the production default still used the tolerant duBytes, which returns
    // 0 for an unreadable root. This drives the default walker against a store that does not
    // exist, which the tolerant walker would happily report as 0 bytes.
    const s = new InlineDiskSampler((_d, _e) => 500); // sampling walk stubbed; strict one is REAL
    const snap = await s.finish("/run", "/definitely/not/a/real/git/store");
    expect(snap.cloneObjectStoreBytes).toBeNull();
    expect(snap.sampleError).toContain("cannot read");
  });
  test("duBytesStrict throws where duBytes silently returns 0", () => {
    expect(duBytes("/definitely/not/a/real/path")).toBe(0);        // tolerant: a SAMPLE
    expect(() => duBytesStrict("/definitely/not/a/real/path")).toThrow(DiskWalkError); // strict: a MEASUREMENT
  });
  test("an injected walk failure still yields null rather than a fabricated 0", async () => {
    const s = new InlineDiskSampler(() => 500, () => { throw new Error("walk blew up"); });
    const snap = await s.finish("/run", "/run/clone/.git");
    expect(snap.cloneObjectStoreBytes).toBeNull();
    expect(snap.sampleError).toContain("walk blew up");
  });
  test("instrumentation failure degrades the disk fields but never throws", async () => {
    const s = new InlineDiskSampler(() => 500, () => { throw new Error("nope"); });
    const snap = await s.finish("/run", null);
    expect(snap.sampleError).not.toBeNull();
    expect(snap.cloneObjectStoreBytes).toBeNull();
  });
  test("finish() is idempotent — one snapshot per run, by contract", async () => {
    let calls = 0;
    const s = new InlineDiskSampler(() => 10, () => { calls++; return 10; });
    const a = await s.finish("/run", null);
    const b = await s.finish("/run", null);
    expect(b).toEqual(a);
    expect(calls).toBe(1); // the second call re-walks nothing
  });
  test("a clean finish records the clone store AND takes the final sample with the STRICT walker", async () => {
    // the final sample is load-bearing (on a short run it may be the only one), so it uses the
    // strict walker like the clone-store measurement — the tolerant tick walker plays no part
    const s = new InlineDiskSampler(() => 1, (d) => (d.endsWith(".git") ? 2048 : 4096));
    const snap = await s.finish("/run", "/run/clone/.git");
    expect(snap.cloneObjectStoreBytes).toBe(2048);
    expect(snap.peakBytes).toBe(4096);
    expect(snap.samples).toBe(1);
    expect(snap.sampleError).toBeNull();
  });
  test("the DEFAULT final sample is strict — an unreadable run dir degrades, never a plausible 0 peak", async () => {
    // drives the PRODUCTION strict walker: a tolerant walk of an unreadable root returned 0
    // with sampleError null, which read as a real (and G4-passing) zero-disk measurement
    const s = new InlineDiskSampler(() => 0);
    const snap = await s.finish("/definitely/not/a/real/run-dir", null);
    expect(snap.sampleError).toContain("cannot read");
    expect(snap.samples).toBe(0); // no sample was fabricated
  });
  test("abandon() releases the sampler without a snapshot — the R5 path's only disposer", async () => {
    // R5 peeks and throws; it never calls finish(), which is the only other disposer. Without
    // abandon() the tick timer stays armed and (for the worker sampler) the worker outlives the
    // run. Driving the REAL worker here so a no-op abandon() would leave it alive.
    const root = mkdtempSync(join(tmpdir(), "pa-bench-abandon-"));
    writeFileSync(join(root, "f"), "k".repeat(256));
    const s = new WorkerDiskSampler();
    s.start(root, 50);
    await new Promise((r) => setTimeout(r, 120));
    const peeked = s.peek();
    s.abandon();
    expect(() => s.abandon()).not.toThrow(); // idempotent
    // after abandon the sampler is inert: a later tick cannot revive the worker or add samples
    await new Promise((r) => setTimeout(r, 120));
    expect(s.peek().samples).toBe(peeked.samples);
    rmSync(root, { recursive: true, force: true });
  }, 10_000);
  test("peek() is synchronous, infallible, and reports no clone measurement", () => {
    // the R5 halt path uses this INSTEAD of finish(), so nothing fallible precedes that record
    const s = new InlineDiskSampler(() => 4096, () => { throw new Error("would have thrown"); });
    const p = s.peek();
    expect(p.cloneObjectStoreBytes).toBeNull();
    expect(p.sampleError).toBeNull();
    expect(p.samples).toBe(0);
  });
});

describe("WorkerDiskSampler — the real worker-backed sampler (santa round 2)", () => {
  // The round-1 sampler had no error channel, no reply deadline, and no idempotence, so a worker
  // that never replied would hang the matrix between the driver returning and the record landing.
  // These drive the REAL worker, not a fake.
  test("measures a real directory off-thread and reports no sample error", async () => {
    const root = mkdtempSync(join(tmpdir(), "pa-bench-worker-"));
    mkdirSync(join(root, "clone", ".git"), { recursive: true });
    writeFileSync(join(root, "clone", ".git", "pack"), "x".repeat(1024));
    writeFileSync(join(root, "file"), "y".repeat(2048));
    const s = new WorkerDiskSampler();
    const snap = await s.finish(root, join(root, "clone", ".git"));
    expect(snap.sampleError).toBeNull();
    expect(snap.cloneObjectStoreBytes).toBeGreaterThanOrEqual(1024);
    expect(snap.peakBytes).toBeGreaterThanOrEqual(3072);
    rmSync(root, { recursive: true, force: true });
  });
  test("finish() without start() still produces a snapshot (no tick ever fired)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pa-bench-worker-"));
    writeFileSync(join(root, "f"), "z".repeat(64));
    const snap = await new WorkerDiskSampler().finish(root, null);
    expect(snap.sampleError).toBeNull();
    expect(snap.cloneObjectStoreBytes).toBeNull();
    expect(snap.samples).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
  test("start() drives real periodic ticks through the worker, and they fold into the peak", async () => {
    // Every other worker test calls finish() directly, so reverting periodic sampling to a
    // synchronous in-wall walk would leave them green. This one exercises start().
    const root = mkdtempSync(join(tmpdir(), "pa-bench-worker-"));
    writeFileSync(join(root, "a"), "a".repeat(4096));
    const s = new WorkerDiskSampler();
    s.start(root, 50); // 20ms period
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(join(root, "b"), "b".repeat(8192)); // grows while sampling
    await new Promise((r) => setTimeout(r, 250));
    const snap = await s.finish(root, null);
    expect(snap.samples).toBeGreaterThan(1);          // ticks actually fired, not just the final one
    expect(snap.peakBytes).toBeGreaterThanOrEqual(12288);
    expect(snap.sampleError).toBeNull();
    rmSync(root, { recursive: true, force: true });
  }, 15_000);
  test("finish() is idempotent and terminates the worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "pa-bench-worker-"));
    const s = new WorkerDiskSampler();
    const a = await s.finish(root, null);
    const b = await s.finish(root, null);
    expect(b).toEqual(a);
    rmSync(root, { recursive: true, force: true });
  });
  test("a reply that never arrives is bounded by the deadline, not an infinite hang", async () => {
    const root = mkdtempSync(join(tmpdir(), "pa-bench-worker-"));
    const s = new WorkerDiskSampler(50); // 50ms deadline
    // point the walk at a path the worker will answer for, but starve the reply by terminating
    // the worker as soon as it exists — finish() must resolve with an error, never hang
    const p = s.finish(root, join(root, "nonexistent", ".git"));
    (s as unknown as { worker: Worker | null }).worker?.terminate();
    const snap = await p;
    expect(snap.sampleError).not.toBeNull();
    expect(snap.cloneObjectStoreBytes).toBeNull();
    rmSync(root, { recursive: true, force: true });
  }, 10_000);
  test("an UNSOLICITED or stale reply cannot fabricate a peak", async () => {
    // Previously any well-shaped reply with an unrecognised sequence was folded into the peak as
    // "an unawaited tick", so a duplicate, stale, or spurious message could invent a disk figure
    // the filesystem never held. Only the ONE outstanding tick sequence may contribute.
    const root = mkdtempSync(join(tmpdir(), "pa-bench-worker-"));
    writeFileSync(join(root, "f"), "u".repeat(512));
    const s = new WorkerDiskSampler();
    const before = s.peek().samples;
    // inject a reply the sampler never asked for, straight into its handler
    const w = (s as unknown as { ensureWorker: () => Worker }).ensureWorker();
    (w.onmessage as (e: MessageEvent) => void)({ data: { seq: 987654, bytes: 999_999_999 } } as MessageEvent);
    const after = s.peek();
    expect(after.samples).toBe(before);          // not counted
    expect(after.peakBytes).toBe(0);             // and definitely not a peak
    s.abandon();
    rmSync(root, { recursive: true, force: true });
  });
  test("a malformed worker reply is rejected rather than folded into the peak as NaN", () => {
    expect(parseDiskWalkReply({ seq: 1, bytes: 10 })).toEqual({ seq: 1, bytes: 10 });
    expect(parseDiskWalkReply({ seq: 1, bytes: "10" })).toBeNull();
    expect(parseDiskWalkReply({ seq: 1, bytes: Number.NaN })).toBeNull();
    expect(parseDiskWalkReply({ seq: 1, bytes: -5 })).toBeNull();
    expect(parseDiskWalkReply({ seq: 1.5, bytes: 10 })).toBeNull();  // seq must be a safe integer
    expect(parseDiskWalkReply({ seq: -1, bytes: 10 })).toBeNull();
    expect(parseDiskWalkReply({ bytes: 10 })).toBeNull();
    expect(parseDiskWalkReply([1, 2])).toBeNull();
    expect(parseDiskWalkReply(null)).toBeNull();
  });
  test("the WORKER validates its inbound request too — the main thread is not privileged input", () => {
    expect(parseDiskWalkRequest({ seq: 0, dir: "/x", extras: [], strict: false })).toEqual({ seq: 0, dir: "/x", extras: [], strict: false });
    expect(parseDiskWalkRequest({ seq: 0, dir: "", extras: [], strict: false })).toBeNull();
    expect(parseDiskWalkRequest({ seq: 0, dir: "/x", extras: [1], strict: false })).toBeNull();
    expect(parseDiskWalkRequest({ seq: 0, dir: "/x", extras: [] })).toBeNull();   // strict missing
    expect(parseDiskWalkRequest({ seq: -1, dir: "/x", extras: [], strict: true })).toBeNull();
    expect(parseDiskWalkRequest(null)).toBeNull();
  });
  test("concurrent finish() calls join ONE snapshot rather than racing two through one worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "pa-bench-worker-"));
    writeFileSync(join(root, "f"), "q".repeat(128));
    const s = new WorkerDiskSampler();
    const [a, b] = await Promise.all([s.finish(root, null), s.finish(root, null)]);
    expect(b).toEqual(a);          // same object contents — single-flight, not two walks
    expect(a.sampleError).toBeNull();
    expect(a.samples).toBe(1);     // exactly one final sample was taken
    rmSync(root, { recursive: true, force: true });
  });
});

describe("requireToolVersion — the §8 environment manifest cannot be half-empty", () => {
  // buildEnvManifest ignored the exit codes of `git --version` / `gh --version`, so a failed or
  // empty probe silently produced gitVersion:"" — and that empty string is folded into the
  // environment-manifest HASH that every timed row binds to, and that resume compares. Provenance
  // that can be silently blank is not provenance.
  test("a failed probe throws instead of yielding an empty version", () => {
    expect(() => requireToolVersion("git", { exitCode: 127, stdout: "", stderr: "not found" }))
      .toThrow(/git --version failed/);
  });
  test("exit 0 with empty output also throws", () => {
    expect(() => requireToolVersion("gh", { exitCode: 0, stdout: "   \n", stderr: "" }))
      .toThrow(/reported no version/);
  });
  test("the first line is taken and trimmed", () => {
    expect(requireToolVersion("gh", { exitCode: 0, stdout: "gh version 2.62.0 (2024)\nhttps://x\n", stderr: "" }))
      .toBe("gh version 2.62.0 (2024)");
    expect(requireToolVersion("git", { exitCode: 0, stdout: "git version 2.47.0\n", stderr: "" }))
      .toBe("git version 2.47.0");
  });
});

describe("finishMeasuredRun — instrumentation is not scored, reclamation is (F1)", () => {
  // The bug: the peak-disk sampler ran a SYNCHRONOUS recursive directory walk on the main thread
  // via setInterval, started before wall.start() and stopped after wall.stop(); two further full
  // walks (the .git size read and the post-acquisition point sample) also sat inside the window.
  // The walk's cost scales with ENTRY COUNT, so it taxed checkout drivers (T2a on every unit
  // except the api-escaping C3; T0/T1 on
  // the truncated-tree fallback) and barely touched T2c's --no-checkout store. That is a
  // driver-correlated tax on the PRIMARY scored metric, and the pilot that calibrated the noise
  // band (T0 on C2, no clone) is the configuration where it is SMALLEST — that run directory stays
  // small, so its walk is cheap (the pilot rows still record sampling) — so the band never saw the
  // driver-correlated part.
  //
  // §4.6 puts teardown inside the clock deliberately ("production holds the unit slot through
  // synchronous reclamation"), but says nothing about charging MEASUREMENT to the measurement.
  // This helper encodes both halves: the wall is paused across instrumentation and running
  // across reclamation.
  const snap = { peakBytes: 4096, samples: 7, cloneObjectStoreBytes: 2048, sampleError: null };
  test("the wall excludes the disk snapshot and includes reclamation", async () => {
    let t = 0;
    const wall = new WallClock(() => t);
    wall.start();
    t += 100; // the driver's real work
    const out = await finishMeasuredRun({
      wall,
      sampler: { finish: async () => { t += 400; return snap; } }, // an expensive walk
      reclaim: () => { t += 25; return false; },
    });
    // 525ms of wall-clock elapses in total. Only the driver's 100ms and reclamation's 25ms are
    // scored: instrumentation is excluded, teardown is not. 125 pins BOTH halves at once —
    // 525 would mean the snapshot leaked in, 100 would mean reclamation leaked out.
    expect(out.wallMs).toBe(125);
    expect(out.disk).toEqual(snap); // every disk field still survives the reordering
    expect(out.diskReclaimFailed).toBe(false);
  });
  test("a failed reclaim is reported without losing the disk snapshot", async () => {
    let t = 0;
    const wall = new WallClock(() => t);
    wall.start();
    const out = await finishMeasuredRun({
      wall,
      sampler: { finish: async () => snap },
      reclaim: () => true,
    });
    expect(out.diskReclaimFailed).toBe(true);
    expect(out.disk).toEqual(snap);
  });
  test("the sampler is finished BEFORE reclamation — it must not walk a directory being deleted", async () => {
    const order: string[] = [];
    let t = 0;
    const wall = new WallClock(() => t);
    wall.start();
    await finishMeasuredRun({
      wall,
      sampler: { finish: async () => { order.push("finish"); return snap; } },
      reclaim: () => { order.push("reclaim"); return false; },
    });
    expect(order).toEqual(["finish", "reclaim"]);
  });
});

describe("reclaimRunResources — teardown owns the DB, not the happy path (F6)", () => {
  // The bug: the per-run sqlite handle was closed and its files removed only on the normal path,
  // AFTER the driver try-block. The mid-unit drift branch returned earlier and leaked the handle
  // plus its -wal/-shm sidecars, while the drift record still claimed diskReclaimFailed:false.
  // Several pre-driver throws (probeLiveHead, reserve, readRateLimit, planning) escape the same
  // way, so reclamation lives in one helper that every exit path runs.
  const mkdirp = (p: string): string => { mkdirSync(p, { recursive: true }); return p; };
  test("closes the handle and removes runDir plus every sqlite sidecar", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-bench-reclaim-"));
    const runDir = mkdirp(join(root, "run"));
    const dbPath = join(root, "run.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) writeFileSync(`${dbPath}${suffix}`, "x");
    let closed = 0;
    const failed = reclaimRunResources({ close: () => { closed++; } }, runDir, dbPath);
    expect(closed).toBe(1);
    expect(failed).toBe(false);
    expect(existsSync(runDir)).toBe(false);
    for (const suffix of ["", "-wal", "-shm"]) expect(existsSync(`${dbPath}${suffix}`)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
  test("absent sidecars are not an error — only some of them ever exist", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-bench-reclaim-"));
    const dbPath = join(root, "run.sqlite");
    writeFileSync(dbPath, "x"); // no -wal/-shm
    expect(reclaimRunResources({ close: () => {} }, mkdirp(join(root, "run")), dbPath)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
  test("a close() failure does not abort file removal, and is reported", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-bench-reclaim-"));
    const runDir = mkdirp(join(root, "run"));
    const dbPath = join(root, "run.sqlite");
    writeFileSync(dbPath, "x");
    const failed = reclaimRunResources({ close: () => { throw new Error("db wedged"); } }, runDir, dbPath);
    expect(failed).toBe(true);            // reported, not swallowed
    expect(existsSync(runDir)).toBe(false); // removal still ran
    expect(existsSync(dbPath)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
  test("a run directory that SURVIVES removal reports failure rather than assuming success", () => {
    // NB: passing an already-absent path would be vacuous — it passes whether or not the
    // post-removal verification exists. This drives the real case: removal runs, the directory
    // is still there afterwards, and the flag must say so.
    const root = mkdtempSync(join(tmpdir(), "pa-bench-reclaim-"));
    const runDir = mkdirp(join(root, "run"));
    const dbPath = join(root, "run.sqlite");
    writeFileSync(dbPath, "x");
    // removal that silently does nothing — no throw, so ONLY the post-removal verification can
    // catch it. Delete that verification and this test goes red.
    const failed = reclaimRunResources({ close: () => {} }, runDir, dbPath, { rm: () => {} });
    expect(failed).toBe(true);
    expect(existsSync(runDir)).toBe(true); // it really did survive
    rmSync(root, { recursive: true, force: true });
  });
});

describe("summarizeSpawns — §4.6 item 5's git-side evidence reaches the record", () => {
  test("counts lanes, timeouts, non-zero exits, and never-settled children", () => {
    const rec = (over: Partial<import("./benchSpawn.ts").BenchSpawnRecord>): import("./benchSpawn.ts").BenchSpawnRecord => ({
      lane: "transport", argv: ["ls-tree"], cwd: null, startedAtMs: 0, wallMs: 1,
      exitCode: 0, timedOut: false, stdoutBytes: 0, stderrBytes: 0, ...over,
    });
    const s = summarizeSpawns([
      rec({}),
      rec({ lane: "scaffolding", exitCode: 128 }),
      rec({ exitCode: 124, timedOut: true }),
      rec({ exitCode: null }),
    ]);
    expect(s).toEqual({ total: 4, timedOut: 1, nonZeroExit: 2, neverSettled: 1, byLane: { transport: 3, scaffolding: 1 } });
  });
});

describe("parseGraphqlBodyFull — present-but-wrong-typed members are malformed EVIDENCE", () => {
  test("an object-valued message on a TIMEOUT error counts as malformed, like production", () => {
    const r = parseGraphqlBodyFull(JSON.stringify({ data: {}, errors: [{ type: "TIMEOUT", message: { odd: true }, path: ["repository", "a0"] }] }));
    expect(r.malformedErrorEntries).toBe(1);
  });
  test("a non-string type counts as malformed too; clean members do not", () => {
    expect(parseGraphqlBodyFull(JSON.stringify({ data: {}, errors: [{ type: 42, message: "x" }] })).malformedErrorEntries).toBe(1);
    expect(parseGraphqlBodyFull(JSON.stringify({ data: {}, errors: [{ type: "NOT_FOUND", message: "x", path: ["repository", "a1"] }] })).malformedErrorEntries).toBe(0);
  });
});

describe("graphqlRecordClassification — degenerate envelopes never record 'ok' (continuation R3)", () => {
  // classifyGraphql's "ok" only means "no errors it could read": {}, {"data":null}, non-object
  // data, and errors:[] are spec-invalid responses a proxy can fabricate with exit 0, the
  // analyzer rejects the dispatch, and an "ok" record would mint a §4.5 R2 ledger success
  test("parseable-but-degenerate 200 envelopes record malformed-body", () => {
    expect(graphqlRecordClassification(200, "ok", parseGraphqlBodyFull("{}"))).toBe("malformed-body");
    expect(graphqlRecordClassification(200, "ok", parseGraphqlBodyFull('{"data":null}'))).toBe("malformed-body");
    expect(graphqlRecordClassification(200, "ok", parseGraphqlBodyFull('{"data":"nope"}'))).toBe("malformed-body");
    expect(graphqlRecordClassification(200, "ok", parseGraphqlBodyFull('{"data":{},"errors":[]}'))).toBe("malformed-body");
  });
  test("a non-JSON 200 body records malformed-body", () => {
    expect(graphqlRecordClassification(200, "ok", parseGraphqlBodyFull("<html>proxy error</html>"))).toBe("malformed-body");
  });
  test("a well-formed success envelope keeps 'ok'", () => {
    expect(graphqlRecordClassification(200, "ok", parseGraphqlBodyFull('{"data":{"repository":{}}}'))).toBe("ok");
  });
  test("non-'ok' verdicts pass through untouched — they carry the honest status-based story", () => {
    expect(graphqlRecordClassification(200, "fatal", parseGraphqlBodyFull('{"data":null,"errors":[{"type":"FORBIDDEN","message":"x"}]}'))).toBe("fatal");
    expect(graphqlRecordClassification(502, "transient", parseGraphqlBodyFull("<html>bad gateway</html>"))).toBe("transient");
  });
});

describe("parseRateLimitBucket — R3/R4 verdicts must not ride unvalidated counters", () => {
  test("a well-formed bucket parses", () => {
    expect(parseRateLimitBucket({ resources: { core: { remaining: 4000, reset: 1000, used: 12 } } }, "core"))
      .toEqual({ remaining: 4000, reset: 1000, used: 12 });
  });
  test("null root, missing resources, fractional or negative counters all refuse", () => {
    expect(() => parseRateLimitBucket(null, "core")).toThrow(/not an object/);
    expect(() => parseRateLimitBucket({}, "core")).toThrow(/no resources/);
    expect(() => parseRateLimitBucket({ resources: {} }, "core")).toThrow(/missing resources.core/);
    expect(() => parseRateLimitBucket({ resources: { core: { remaining: 1.5, reset: 1, used: 0 } } }, "core")).toThrow(/nonnegative integer/);
    expect(() => parseRateLimitBucket({ resources: { core: { remaining: -1, reset: 1, used: 0 } } }, "core")).toThrow(/nonnegative integer/);
  });
});

describe("extraBytesStrict — a present-but-unreadable sidecar fails the measurement", () => {
  test("absent sidecars contribute nothing (they legitimately come and go)", () => {
    expect(extraBytesStrict(["/definitely/not/a/real/sidecar-wal"])).toBe(0);
  });
  test("a real file is counted", () => {
    const dir = mkdtempSync(join(tmpdir(), "pa-bench-extras-"));
    const p = join(dir, "db-wal");
    writeFileSync(p, "x".repeat(64));
    expect(extraBytesStrict([p])).toBe(64);
    rmSync(dir, { recursive: true, force: true });
  });
});
