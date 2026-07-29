// benchProtocol.test.ts — CI tests for the engine's pure decision pieces: WC formulas,
// segmentation, washout, bucket-delta/straddle, delivery verification, the active-wall clock,
// the fixed-size child pool, and the shared resume/terminalization reconstruction.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBenchConfig, restFallbackBudgetFor } from "./benchConfig.ts";
import {
  BenchProtocolError, RunsLog, WallClock, applyPendingTransition, bucketDelta, computeWorstCase,
  isRerunnableEvidence, makeChildPool, planSegments, reconstructMatrixState, verifyDeliveries,
  washoutMs, type EnvManifest,
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

// ---- reconstructMatrixState: the ONE terminalization rule (resume ∩ scoring) ----------------
const IDENTITY = { harnessCommit: "H".repeat(40), envManifestHash: "E1" };
const row = (over: Record<string, unknown>): string =>
  JSON.stringify({
    type: "run", schemaVersion: 1, pos: 1, attemptId: "a-1", unit: "U1", driver: "T0", rep: 1,
    probe: false, phase: "matrix", epilogue: false, acquisitionForm: null,
    startedAtIso: "2026-07-29T00:00:00Z", wallMs: 1000, segments: 1, outcome: "complete",
    failureCause: null, failureEvidence: null, requests: { "rest-content": 5 },
    requestClassSuccesses: { "rest-content": 5 },
    attempts: { fivexx: 0, retries: 0, noResponse: 0, secondaryByKind: {} }, straddledReset: false, secondarySignals: 0,
    points: { measuredCostSum: 0, imputed: 0 },
    bucketDeltas: { core: { valid: true, used: 5 }, graphql: { valid: true, used: 0 } },
    bucketSnapshots: [], expectedConsumption: { core: 5, graphql: 0 },
    replayOfPos: null, replayKind: null, diskReclaimFailed: false, probeDivergences: 0,
    httpBodyBytes: 0, cloneObjectStoreBytes: null, diskSampledPeakBytes: 0, diskSamples: 0,
    fallbackSpend: 0, routesDelivered: {}, g1Failures: 0, g2Failures: 0,
    washoutAppliedMs: 60_000, washoutUntilEpochMs: 0,
    envManifestHash: IDENTITY.envManifestHash, harnessCommit: IDENTITY.harnessCommit,
    ...over,
  });
const marker = (forAttemptId: string, pos: number): string =>
  JSON.stringify({ type: "washout-done", forAttemptId, pos, rep: 1, probe: false, phase: "matrix", unit: "U1", driver: "T0" });

describe("reconstructMatrixState — attempt-keyed terminalization (Step-C residual 1)", () => {
  test("a marked complete row terminalizes; an unmarked one re-runs and owes its washout horizon", () => {
    const state = reconstructMatrixState([
      row({ pos: 1, attemptId: "a-1" }), marker("a-1", 1),
      row({ pos: 2, attemptId: "a-2", washoutUntilEpochMs: 12_345 }),
    ], IDENTITY);
    expect(state.terminalPos.has(1)).toBe(true);
    expect(state.terminalPos.has(2)).toBe(false);
    expect(state.pendingWashoutUntilMs).toBe(12_345); // residual 2: the horizon survives the crash
    expect(state.successLedger.has("U1|T0|rest-content")).toBe(true); // only the MARKED completion
  });
  test("an old main-phase marker at the same pos cannot terminalize a later epilogue attempt", () => {
    const state = reconstructMatrixState([
      row({ pos: 5, attemptId: "a-main" }), marker("a-main", 5),
      row({ pos: 9, attemptId: "a-drift", outcome: "drift-restart", acquisitionForm: "production" }),
      // the epilogue re-ran pos 5 but crashed before ITS washout marker landed
      row({ pos: 5, attemptId: "a-epi", epilogue: true, acquisitionForm: "scaffolding" }),
    ], IDENTITY);
    expect(state.driftedUnits.has("U1")).toBe(true);
    expect(state.resumeForms.get("U1")).toBe("scaffolding");
    expect(state.terminalPos.has(5)).toBe(false); // pos-keyed markers would have said true
  });
  test("markers without attempt identity bind nothing (legacy shape)", () => {
    const state = reconstructMatrixState([
      row({ pos: 1, attemptId: "a-1" }),
      JSON.stringify({ type: "washout-done", pos: 1, phase: "matrix" }),
    ], IDENTITY);
    expect(state.terminalPos.has(1)).toBe(false);
  });
  test("two recorded straddles on one unit refuse reconstruction (residual 7)", () => {
    const one = reconstructMatrixState([row({ pos: 1, attemptId: "a-1", outcome: "invalidated-straddle" })], IDENTITY);
    expect(one.straddleCounts.get("U1")).toBe(1);
    expect(() => reconstructMatrixState([
      row({ pos: 1, attemptId: "a-1", outcome: "invalidated-straddle" }),
      row({ pos: 7, attemptId: "a-2", outcome: "invalidated-straddle" }),
    ], IDENTITY)).toThrow(/R4 straddles/);
  });
  test("halt/re-pin rows and foreign identities refuse reconstruction", () => {
    expect(() => reconstructMatrixState([row({ outcome: "halt-r5-breach" })], IDENTITY)).toThrow(/freeze-repair/);
    expect(() => reconstructMatrixState([row({ outcome: "re-pin-required" })], IDENTITY)).toThrow(/freeze-repair/);
    expect(() => reconstructMatrixState([row({ harnessCommit: "other" })], IDENTITY)).toThrow(/harness/);
    expect(() => reconstructMatrixState([row({ envManifestHash: "other" })], IDENTITY)).toThrow(/environment/);
    // scoring mode (expect null): a single identity is derived; two identities refuse
    expect(reconstructMatrixState([row({ pos: 1, attemptId: "a-1" })], null).matrixRowsSeen).toBe(1);
    expect(() => reconstructMatrixState([
      row({ pos: 1, attemptId: "a-1" }),
      row({ pos: 2, attemptId: "a-2", envManifestHash: "E2" }),
    ], null)).toThrow(/identities/);
  });
  test("a marked rerunnable unit-failure is superseded: the rerun survives the crash and is charged", () => {
    const failure = {
      outcome: "unit-failure",
      failureEvidence: { kind: "http", code: "no-response", lastClassification: "no-response", requestClass: "rest-content" },
    };
    const state = reconstructMatrixState([
      row({ pos: 3, attemptId: "a-f", ...failure }), marker("a-f", 3),
    ], IDENTITY);
    expect(state.terminalPos.has(3)).toBe(false); // the live process would have replayed it
    expect(state.rerunUsed.has("U1|T0")).toBe(true); // ...and charged the allowance
    expect(state.pendingReplays.get(3)).toBe("r1r2"); // ...with the predecessor linkage owed
    // allowance already consumed by an earlier recorded r1r2 replay → the failure stands
    const spent = reconstructMatrixState([
      row({ pos: 2, attemptId: "a-r", replayKind: "r1r2" }), marker("a-r", 2),
      row({ pos: 3, attemptId: "a-f", ...failure }), marker("a-f", 3),
    ], IDENTITY);
    expect(spent.terminalPos.has(3)).toBe(true);
  });
  test("R2 rerunnability is evaluated against the ledger AS OF the failure, in stream order", () => {
    const transientFailure = {
      outcome: "unit-failure",
      failureEvidence: { kind: "http", code: "attempts-exhausted", lastClassification: "transient", requestClass: "rest-content" },
    };
    // the class succeeded EARLIER (marked) → R2 applies
    const before = reconstructMatrixState([
      row({ pos: 1, attemptId: "a-ok" }), marker("a-ok", 1),
      row({ pos: 2, attemptId: "a-f", ...transientFailure }), marker("a-f", 2),
    ], IDENTITY);
    expect(before.terminalPos.has(2)).toBe(false);
    expect(before.pendingReplays.get(2)).toBe("r1r2");
    // the only success arrives LATER in the stream → at failure time there was no evidence
    const after = reconstructMatrixState([
      row({ pos: 2, attemptId: "a-f", ...transientFailure }), marker("a-f", 2),
      row({ pos: 4, attemptId: "a-ok" }), marker("a-ok", 4),
    ], IDENTITY);
    expect(after.terminalPos.has(2)).toBe(true); // the failure stands, exactly as it did live
    expect(after.rerunUsed.has("U1|T0")).toBe(false);
  });
  test("a last invalidated attempt owes an in-slot replay linkage; a later terminal attempt clears it", () => {
    const state = reconstructMatrixState([
      row({ pos: 6, attemptId: "a-s", outcome: "invalidated-straddle" }), marker("a-s", 6),
    ], IDENTITY);
    expect(state.pendingReplays.get(6)).toBe("r3r4");
    const replayed = reconstructMatrixState([
      row({ pos: 6, attemptId: "a-s", outcome: "invalidated-straddle" }), marker("a-s", 6),
      row({ pos: 6, attemptId: "a-r", replayOfPos: 6, replayKind: "r3r4" }), marker("a-r", 6),
    ], IDENTITY);
    expect(replayed.pendingReplays.has(6)).toBe(false);
    expect(replayed.terminalPos.has(6)).toBe(true);
    const controlPlane = reconstructMatrixState([
      row({ pos: 8, attemptId: "a-c", outcome: "invalidated-control-plane" }), marker("a-c", 8),
    ], IDENTITY);
    expect(controlPlane.pendingReplays.get(8)).toBe("r3r4");
  });
});

describe("reconstructMatrixState — codex C0-R1 remediations", () => {
  test("an unmarked non-rerunnable failure becomes a pending TRANSITION, never a silent re-run (f.1)", () => {
    const state = reconstructMatrixState([
      row({ pos: 4, attemptId: "a-f", outcome: "unit-failure", failureEvidence: { kind: "unit" } }),
    ], IDENTITY);
    expect(state.terminalPos.has(4)).toBe(false); // not yet — the marker is owed first
    expect(state.pendingTransitions.map((t) => t.pos)).toEqual([4]);
    applyPendingTransition(state, state.pendingTransitions[0]!);
    expect(state.terminalPos.has(4)).toBe(true); // the recorded failure STANDS
    expect(state.pendingReplays.has(4)).toBe(false);
    expect(state.rerunUsed.size).toBe(0);
  });
  test("an unmarked RERUNNABLE failure transitions into the charged replay it was owed (f.1)", () => {
    const state = reconstructMatrixState([
      row({ pos: 4, attemptId: "a-f", outcome: "unit-failure", failureEvidence: { kind: "http", code: "no-response", lastClassification: "no-response", requestClass: "rest-content" } }),
    ], IDENTITY);
    applyPendingTransition(state, state.pendingTransitions[0]!);
    expect(state.terminalPos.has(4)).toBe(false);
    expect(state.pendingReplays.get(4)).toBe("r1r2");
    expect(state.rerunUsed.has("U1|T0")).toBe(true);
  });
  test("an unmarked complete row transitions to terminal and feeds the ledger (f.1)", () => {
    const state = reconstructMatrixState([row({ pos: 4, attemptId: "a-c" })], IDENTITY);
    applyPendingTransition(state, state.pendingTransitions[0]!);
    expect(state.terminalPos.has(4)).toBe(true);
    expect(state.successLedger.has("U1|T0|rest-content")).toBe(true);
  });
  test("the ledger admits SUCCESSES, never mere attempts (f.2)", () => {
    const state = reconstructMatrixState([
      row({ pos: 1, attemptId: "a-1", requests: { "rest-content": 5, "graphql-batch": 3 }, requestClassSuccesses: { "rest-content": 5 } }),
      marker("a-1", 1),
    ], IDENTITY);
    expect(state.successLedger.has("U1|T0|rest-content")).toBe(true);
    expect(state.successLedger.has("U1|T0|graphql-batch")).toBe(false); // attempted, never succeeded
  });
  test("control-plane invalidations count durably per pos (f.3)", () => {
    const state = reconstructMatrixState([
      row({ pos: 7, attemptId: "a-1", outcome: "invalidated-control-plane" }), marker("a-1", 7),
      row({ pos: 7, attemptId: "a-2", outcome: "invalidated-control-plane" }), marker("a-2", 7),
    ], IDENTITY);
    expect(state.controlPlaneCounts.get(7)).toBe(2);
    expect(state.pendingReplays.get(7)).toBe("r3r4");
  });
  test("a malformed INTERIOR line refuses reconstruction; a torn final line is tolerated (f.13)", () => {
    expect(() => reconstructMatrixState(["{corrupt", row({ pos: 1, attemptId: "a-1" })], IDENTITY)).toThrow(/malformed interior/);
    const torn = reconstructMatrixState([row({ pos: 1, attemptId: "a-1" }), '{"type":"run","pos":2,"trunc'], IDENTITY);
    expect(torn.matrixRowsSeen).toBe(1);
  });
});

describe("isRerunnableEvidence — the frozen R1/R2 predicate", () => {
  const ledger = new Set(["U|D|rest-content"]);
  test("R1 no-response is unconditional; R2 transient needs prior same-class success; nothing else", () => {
    expect(isRerunnableEvidence({ kind: "http", code: "no-response", lastClassification: null, requestClass: null }, "U", "D", ledger)).toBe(true);
    expect(isRerunnableEvidence({ kind: "http", code: "attempts-exhausted", lastClassification: "transient", requestClass: "rest-content" }, "U", "D", ledger)).toBe(true);
    expect(isRerunnableEvidence({ kind: "http", code: "attempts-exhausted", lastClassification: "transient", requestClass: "rest-tree" }, "U", "D", ledger)).toBe(false);
    expect(isRerunnableEvidence({ kind: "http", code: "attempts-exhausted", lastClassification: "secondary", requestClass: "rest-content" }, "U", "D", ledger)).toBe(false);
    expect(isRerunnableEvidence({ kind: "unit" }, "U", "D", ledger)).toBe(false);
    expect(isRerunnableEvidence(null, "U", "D", ledger)).toBe(false);
  });
});

describe("RunsLog.writeManifestOnce — identical manifests appear once (residual 6)", () => {
  const manifest: EnvManifest = {
    os: "darwin", osVersion: "25.0.0", archName: "arm64", hardwareIdHash: "h", gitVersion: "g",
    ghVersion: "gh", bunVersion: "b", networkDescription: "test", credentialType: "PAT",
    login: "x", harnessCommit: "H",
  };
  test("re-invocations dedup by hash; a different environment still appends", () => {
    const dir = mkdtempSync(join(tmpdir(), "pa-bench-test-"));
    try {
      const path = join(dir, "runs.jsonl");
      const log1 = new RunsLog(path, manifest);
      log1.writeManifestOnce();
      log1.writeManifestOnce();
      new RunsLog(path, manifest).writeManifestOnce(); // a fresh invocation, same environment
      const other = new RunsLog(path, { ...manifest, networkDescription: "elsewhere" });
      other.writeManifestOnce();
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
      expect(lines.length).toBe(2);
      const hashes = lines.map((l) => (JSON.parse(l) as { hash: string }).hash);
      expect(new Set(hashes).size).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
