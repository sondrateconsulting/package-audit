// benchProtocol.test.ts — CI tests for the engine's pure decision pieces: WC formulas,
// segmentation, washout, bucket-delta/straddle, delivery verification, the active-wall clock,
// and the fixed-size child pool.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadBenchConfig, restFallbackBudgetFor } from "./benchConfig.ts";
import {
  BenchProtocolError, WallClock, bucketDelta, computeWorstCase, makeChildPool, planSegments,
  verifyDeliveries, washoutMs,
} from "./benchProtocol.ts";
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
  test("T0: (reads + tree + fallback budget) × attemptCap", () => {
    const w = workloadOf(100);
    const wc = computeWorstCase("T0", w, CFG, { owner: "o", repo: "r" });
    expect(wc.core).toBe((100 + 1 + restFallbackBudgetFor(CFG, 100)) * 6);
    expect(wc.graphql).toBe(0);
  });
  test("T1: plannedBatches × (1+descendants) × attempts × P_max — never the 1-point floor", () => {
    const w = workloadOf(300);
    const wc = computeWorstCase("T1", w, CFG, { owner: "o", repo: "r" });
    expect(wc.plannedBatches).toBe(2); // 300 aliases under the 250 cap
    expect(wc.graphql).toBe(2 * (1 + 4) * 6 * 10);
    expect(wc.core).toBe((1 + restFallbackBudgetFor(CFG, 300)) * 6);
  });
  test("clone drivers reserve only the fallback budget; the pinned escape reserves the T0 shape", () => {
    const w = workloadOf(100);
    expect(computeWorstCase("T2c", w, CFG, { owner: "o", repo: "r" }).core).toBe(restFallbackBudgetFor(CFG, 100) * 6);
    const escaped = workloadOf(100, { escapeTripped: true });
    expect(computeWorstCase("T2a", escaped, CFG, { owner: "o", repo: "r" }).core).toBe((100 + 1 + restFallbackBudgetFor(CFG, 100)) * 6);
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
      expect((s + 1 + budget) * CFG.rest.attemptCap * CFG.budget.headroomFactor).toBeLessThanOrEqual(CFG.budget.bucketCapacityPerHour);
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
