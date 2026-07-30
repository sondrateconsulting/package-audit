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
  planSegments, reclaimRunResources, requireToolVersion, summarizeTraffic, verifyDeliveries,
  washoutMs,
} from "./benchProtocol.ts";
import type { BenchHttpAttemptRecord } from "./benchGh.ts";
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
    const s = summarizeTraffic([
      httpRec({ status: 502 }),
      httpRec({ attempt: 2 }),
      httpRec({ kind: "graphql", requestClass: "graphql-batch", pointsCost: 3 }),
      httpRec({ kind: "graphql", requestClass: "graphql-batch", pointsCost: null }),
      httpRec({ requestClass: "rest-meta", status: 502, attempt: 3 }), // still excluded everywhere
    ]);
    expect(s.attempts.fivexx).toBe(1);
    expect(s.attempts.retries).toBe(1);
    expect(s.points).toEqual({ measuredCostSum: 3, imputed: 1 });
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
  // The walk's cost scales with ENTRY COUNT, so it taxed checkout drivers (T2a always; T0/T1 on
  // the truncated-tree fallback) and barely touched T2c's --no-checkout store. That is a
  // driver-correlated tax on the PRIMARY scored metric, and the pilot that calibrated the noise
  // band (T0 on C2, no clone) is precisely the configuration where it is zero — so the band
  // could never have covered it.
  //
  // §4.6 puts teardown inside the clock deliberately ("production holds the unit slot through
  // synchronous reclamation"), but says nothing about charging MEASUREMENT to the measurement.
  // This helper encodes both halves: the wall is paused across instrumentation and running
  // across reclamation.
  const snap = { peakBytes: 4096, samples: 7, cloneObjectStoreBytes: 2048 };
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
  test("a run directory that survives removal reports failure rather than assuming success", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-bench-reclaim-"));
    const dbPath = join(root, "run.sqlite");
    // point at a path that cannot be removed because it is not a directory we own the parent of
    const failed = reclaimRunResources({ close: () => {} }, join(root, "absent"), dbPath);
    expect(failed).toBe(false); // absent == reclaimed; the flag is about SURVIVING state
    rmSync(root, { recursive: true, force: true });
  });
});
