// benchScore.test.ts — CI tests for the §4.6 scoring formulas and the §4.7 rule: the paired
// per-run T(r) (own wall with own consumption, larger-governs, zero-consumption buckets, the
// 15k readoff), the G1–G4 global gates (probe completion-gating included), the noise-band
// comparison, dominance, and the exhaustive case mapping — all over synthetic runs.jsonl lines
// so the arithmetic is checked against hand-computed values.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadBenchConfig, type BenchConfig } from "./benchConfig.ts";
import type { Corpus } from "./benchCorpus.ts";
import type { DriverId, ScheduleRow } from "./benchSchedule.ts";
import { DRIVERS } from "./benchSchedule.ts";
import { buildUnitWorkload, seamStringSha256, type UnitWorkload, type WorkloadEntry } from "./benchWorkload.ts";
import { BenchScoreError, medianOf, scoreMatrix, scoreRun, type ScoreBundle } from "./benchScore.ts";

const CFG = loadBenchConfig(join(import.meta.dir, "..", "docs", "adrs", "0001-benchmark", "bench-config.json"));
const DIGEST = "d".repeat(64);
const IDENTITY = { harnessCommit: "H".repeat(40), envManifestHash: "E1" };
const oid = (c: string): string => c.repeat(40);

const entry = (path: string): WorkloadEntry => ({
  path, mode: "100644", blobOid: oid("c"), size: 10, class: "source", read: true, noReadReason: null,
  canonicalSeamSha256: seamStringSha256(`content:${path}`), rawSha256: seamStringSha256("raw"),
  restDerefSeamSha256: null, checkoutSeamSha256: seamStringSha256(`co:${path}`),
  gql: { isBinary: false, isTruncated: false, textNull: false },
});
const workloadFor = (unitId: string, files: number): UnitWorkload =>
  buildUnitWorkload({
    unit: unitId, sha: oid("0"), treeOid: oid("f"), objectFormat: "sha1",
    generatedAtIso: "2026-07-28T00:00:00Z", truncatedTree: false, escapeTripped: false,
    batchContentBytesCap: CFG.t1.batchContentBytesCap,
    entries: Array.from({ length: files }, (_, i) => entry(`f${i}.ts`)),
  });

const UNITS = ["S:o/r@u1", "S:o/r@u2"];
const FILES = 10;
const CORPUS: Corpus = {
  pinnedAtIso: "2026-07-28T00:00:00Z", pinnedByLogin: "test",
  performance: [{
    slot: "C2", owner: "o", repo: "r", objectFormat: "sha1", repoSizeKb: 100,
    units: UNITS.map((u) => ({ unitId: u, branch: "b", sha: oid("0"), treeOid: oid("f") })),
    verification: {},
  }],
  fidelity: [{
    kind: "clone-symlink", owner: "o", repo: "r", branch: "b", sha: oid("5"), objectFormat: "sha1",
    appliesTo: [...DRIVERS], entries: [{ path: "link.sh", mode: "120000", oid: oid("1"), size: 9 }],
    verification: {},
  }],
  option3WarmScenario: null,
};
const WORKLOADS = new Map(UNITS.map((u) => [u, workloadFor(u, FILES)]));

const fidelityMatch = (driver: DriverId, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "fidelity", generatedAtIso: "t", frozenSurfaceDigest: DIGEST, fixture: "clone-symlink",
    driver, entry: "link.sh", outcome: "match", pass: true, ...over,
  });
const FIDELITY_ALL_MATCH = DRIVERS.map((d) => fidelityMatch(d));

// one complete matrix row + its attempt-keyed washout marker
interface RowSpec {
  pos: number;
  unit: string;
  driver: DriverId;
  rep: number;
  probe?: boolean;
  wallMs?: number;
  over?: Record<string, unknown>;
}
const rowLines = (spec: RowSpec): string[] => {
  const attemptId = `a-${spec.pos}`;
  const base = {
    type: "run", schemaVersion: 1, pos: spec.pos, attemptId, unit: spec.unit, driver: spec.driver,
    rep: spec.rep, probe: spec.probe === true, phase: "matrix", epilogue: false, acquisitionForm: null,
    startedAtIso: "2026-07-29T00:00:00Z", wallMs: spec.wallMs ?? 1000, segments: 1, outcome: "complete",
    failureCause: null, failureEvidence: null, requests: { "rest-content": 1 },
    okRequestClasses: ["rest-content"],
    attempts: { fivexx: 0, retries: 0, secondaryByKind: {} }, straddledReset: false, secondarySignals: 0,
    points: { measuredCostSum: 0, imputed: 0 },
    bucketDeltas: { core: { valid: true, used: 0 }, graphql: { valid: true, used: 0 } },
    bucketSnapshots: [], expectedConsumption: { core: 0, graphql: 0 },
    replayOfPos: null, replayKind: null, diskReclaimFailed: false, probeDivergences: 0,
    httpBodyBytes: 100, cloneObjectStoreBytes: null, diskSampledPeakBytes: 1000, diskSamples: 3,
    fallbackSpend: 0, routesDelivered: {}, g1Failures: 0, g2Failures: 0, g2PositiveFailures: 0,
    washoutAppliedMs: 60_000, washoutUntilEpochMs: 0, controlPlaneFailed: false,
    frozenSurfaceDigest: DIGEST,
    envManifestHash: IDENTITY.envManifestHash, harnessCommit: IDENTITY.harnessCommit,
    ...(spec.over ?? {}),
  };
  return [
    JSON.stringify(base),
    JSON.stringify({ type: "washout-done", forAttemptId: (base as Record<string, unknown>)["attemptId"], pos: spec.pos, rep: spec.rep, probe: spec.probe === true, phase: "matrix", unit: spec.unit, driver: spec.driver }),
  ];
};

// a full synthetic matrix: 2 units × 4 drivers × 5 reps + one T2a probe row per unit, with
// per-(unit, driver) wall control; `mutate` lets a test break exactly one thing
function synthBundle(
  wallOf: (unit: string, driver: DriverId) => number,
  mutate: (spec: RowSpec) => RowSpec = (s) => s,
  fidelityLines: readonly string[] = FIDELITY_ALL_MATCH,
): ScoreBundle {
  const rows: ScheduleRow[] = [];
  const lines: string[] = [];
  let pos = 1;
  for (const unit of UNITS) {
    for (let rep = 1; rep <= CFG.reps; rep++) {
      for (const driver of DRIVERS) {
        rows.push({ pos, unit, driver, rep, probe: false });
        lines.push(...rowLines(mutate({ pos, unit, driver, rep, wallMs: wallOf(unit, driver) })));
        pos++;
      }
    }
  }
  for (const unit of UNITS) {
    rows.push({ pos, unit, driver: "T2a", rep: CFG.reps + 1, probe: true });
    lines.push(...rowLines(mutate({ pos, unit, driver: "T2a", rep: CFG.reps + 1, probe: true, wallMs: 1000 })));
    pos++;
  }
  const cfg: BenchConfig = { ...CFG, schedule: { unitOrder: [...UNITS], rows } };
  return { cfg, corpus: CORPUS, workloads: WORKLOADS, runsLines: lines, fidelityLines: [...fidelityLines], noiseBand: 1.25, ratifiedDigest: DIGEST };
}

describe("scoreRun — §4.6's paired formula", () => {
  const raw = (over: Record<string, unknown>): Record<string, unknown> =>
    JSON.parse(rowLines({ pos: 1, unit: UNITS[0]!, driver: "T0", rep: 1, over })[0]!) as Record<string, unknown>;
  test("T pairs the run's own wall with its own consumption; zero-consumption buckets impose no ceiling", () => {
    // wall 36 s over 100 files → 10,000 files/h; core 200 units → ceiling 2,500 binds
    const r = scoreRun(raw({
      wallMs: 36_000,
      bucketDeltas: { core: { valid: true, used: 200 }, graphql: { valid: true, used: 0 } },
      expectedConsumption: { core: 180, graphql: 0 },
    }), 100, CFG);
    expect(r.wallThroughputPerHour).toBeCloseTo(10_000, 6);
    expect(r.unitsCore).toBe(200); // the larger governs (delta 200 > accounting 180)
    expect(r.tScore).toBeCloseTo(2_500, 6);
    expect(r.tScore15k).toBeCloseTo(7_500, 6); // the same run read off at a 15k credential
    const wallBound = scoreRun(raw({ wallMs: 36_000 }), 100, CFG);
    expect(wallBound.tScore).toBeCloseTo(10_000, 6); // no consumption → the wall term alone
  });
  test("the graphql explanatory sum is measured cost + 1-point imputations; the larger governs", () => {
    const r = scoreRun(raw({
      wallMs: 3_600_000,
      bucketDeltas: { core: { valid: true, used: 0 }, graphql: { valid: true, used: 3 } },
      points: { measuredCostSum: 4, imputed: 2 },
    }), 100, CFG);
    expect(r.unitsGraphql).toBe(6); // 4 + 2 > delta 3
    expect(r.tScore).toBeCloseTo(Math.min(100, (5000 * 100) / 6), 6);
  });
  test("an invalid delta on a terminal complete row is an engine-invariant violation, fail-closed", () => {
    expect(() => scoreRun(raw({ bucketDeltas: { core: { valid: false, used: null }, graphql: { valid: true, used: 0 } } }), 100, CFG)).toThrow(BenchScoreError);
  });
  test("medianOf: middle of odd, mean of middles of even", () => {
    expect(medianOf([5, 1, 3])).toBe(3);
    expect(medianOf([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("scoreMatrix — gates and the §4.7 rule", () => {
  test("clean matrix: everyone eligible; a beyond-band winner on one unit + ties elsewhere → dominator", () => {
    // U1: T2c wall 1000 (T 36k), rivals 2000 (T 18k) → ratio 2 > 1.25, T2c wins vs each.
    // U2: all 1500 → ties. T2c: ≥1 win, 0 losses vs every rival → dominates.
    const out = scoreMatrix(synthBundle((unit, driver) =>
      unit === UNITS[0] ? (driver === "T2c" ? 1000 : 2000) : 1500));
    expect(out.identity).toEqual(IDENTITY);
    expect(out.gates.every((g) => g.eligible)).toBe(true);
    expect(out.eligible).toEqual([...DRIVERS]);
    const u1 = out.cells.find((c) => c.unit === UNITS[0] && c.driver === "T2c")!;
    expect(u1.medianT).toBeCloseTo(3_600_000 * FILES / 1000, 6);
    expect(u1.worstT).toBeCloseTo(u1.medianT!, 6);
    expect(out.perRival.T2c.T0).toEqual({ wins: 1, ties: 1, losses: 0 });
    expect(out.dominators).toEqual(["T2c"]);
    expect(out.caseMapping).toEqual({ kind: "dominator", recommendation: "T2c" });
  });
  test("all within band everywhere → no dominator, no recommendation", () => {
    const out = scoreMatrix(synthBundle(() => 1500));
    expect(out.eligible.length).toBe(4);
    expect(out.dominators).toEqual([]);
    expect(out.caseMapping).toEqual({ kind: "no-dominator", recommendation: null });
  });
  test("split wins across units → no dominator even with clear per-unit winners", () => {
    // T0 wins U1, T1 wins U2 — each has a loss against the other somewhere
    const out = scoreMatrix(synthBundle((unit, driver) => {
      if (unit === UNITS[0]) return driver === "T0" ? 1000 : 2000;
      return driver === "T1" ? 1000 : 2000;
    }));
    expect(out.caseMapping.kind).toBe("no-dominator");
  });
  test("a G1 delivery failure disqualifies globally; sole survivor → sole-eligible with evidence attached", () => {
    const out = scoreMatrix(synthBundle(() => 1500, (spec) =>
      spec.driver === "T0" || spec.probe === true ? spec : { ...spec, over: { g1Failures: 1 } }));
    expect(out.eligible).toEqual(["T0"]);
    expect(out.caseMapping).toEqual({ kind: "sole-eligible", recommendation: "T0" });
    const t1 = out.gates.find((g) => g.driver === "T1")!;
    expect(t1.g1).toBe("fail");
    expect(t1.reasons.length).toBeGreaterThan(0);
  });
  test("every gate can zero the field → zero-eligible (remain-proposed path)", () => {
    const out = scoreMatrix(synthBundle(() => 1500, (spec) =>
      spec.probe === true ? spec : { ...spec, over: { diskSampledPeakBytes: CFG.protocol.diskGateBytes + 1 } }));
    expect(out.eligible).toEqual([]);
    expect(out.caseMapping).toEqual({ kind: "zero-eligible", recommendation: null });
    expect(out.gates.every((g) => g.g4 === "fail")).toBe(true);
  });
  test("a missing checkout-config probe row is missing evidence → G1 ineligibility, not a vacuous pass", () => {
    // drop T2a's probe rows from the LOG (they stay in the schedule)
    const bundle = synthBundle(() => 1500);
    const pruned = { ...bundle, runsLines: bundle.runsLines.filter((l) => !l.includes('"probe":true')) };
    const out = scoreMatrix(pruned);
    const t2a = out.gates.find((g) => g.driver === "T2a")!;
    expect(t2a.g1).toBe("fail");
    expect(t2a.reasons.some((r) => r.includes("probe"))).toBe(true);
    expect(out.gates.find((g) => g.driver === "T0")!.eligible).toBe(true); // no probe row applies to T0 here
  });
  test("G3: a missing rep fails stability; G4 secondary partition 0/1/≥2 = pass/warn/fail", () => {
    const missing = synthBundle(() => 1500);
    const withoutOneRep = { ...missing, runsLines: missing.runsLines.filter((l) => !(l.includes('"pos":1,') || l.includes('"pos":1}'))) };
    const g3 = scoreMatrix(withoutOneRep).gates.find((g) => g.driver === "T0")!;
    expect(g3.g3).toBe("fail");
    expect(g3.eligible).toBe(false);

    const warn = scoreMatrix(synthBundle(() => 1500, (spec) =>
      spec.driver === "T1" && spec.pos === 2 ? { ...spec, over: { secondarySignals: 1 } } : spec));
    const w = warn.gates.find((g) => g.driver === "T1")!;
    expect(w.g4).toBe("warn");
    expect(w.eligible).toBe(true); // pass with a recorded warning
    const fail2 = scoreMatrix(synthBundle(() => 1500, (spec) =>
      spec.driver === "T1" && (spec.pos === 2 || spec.pos === 6) ? { ...spec, over: { secondarySignals: 1 } } : spec));
    expect(fail2.gates.find((g) => g.driver === "T1")!.g4).toBe("fail");
  });
  test("probe divergences are findings, not disqualifications; probe rows are excluded from G4's census", () => {
    const out = scoreMatrix(synthBundle(() => 1500, (spec) =>
      spec.probe === true ? { ...spec, over: { probeDivergences: 3, secondarySignals: 5 } } : spec));
    const t2a = out.gates.find((g) => g.driver === "T2a")!;
    expect(t2a.eligible).toBe(true);
    expect(t2a.g4AttributableSignals).toBe(0); // probe traffic excluded (§4.7 G4)
    expect(t2a.probeDivergenceFindings.length).toBe(2);
  });
  test("a fidelity-battery mismatch is a G1 disqualification; an unattempted cell is G2", () => {
    const out = scoreMatrix(synthBundle(() => 1500, (s) => s, [
      ...DRIVERS.filter((d) => d !== "T1" && d !== "T2c").map((d) => fidelityMatch(d)),
      fidelityMatch("T1", { outcome: "mismatch", pass: false }),
      // T2c: never attempted
    ]));
    expect(out.gates.find((g) => g.driver === "T1")!.g1).toBe("fail");
    expect(out.gates.find((g) => g.driver === "T2c")!.g2).toBe("fail");
    expect(out.eligible).toEqual(["T0", "T2a"]);
  });
  test("an exhausted fidelity cell is G2 (incomplete evidence), not G1 (codex C0-R1 f.9)", () => {
    const out = scoreMatrix(synthBundle(() => 1500, (s) => s, [
      ...DRIVERS.filter((d) => d !== "T1").map((d) => fidelityMatch(d)),
      fidelityMatch("T1", { outcome: "attempt-error", pass: false }),
      fidelityMatch("T1", { outcome: "attempt-error", pass: false }),
    ]));
    const t1 = out.gates.find((g) => g.driver === "T1")!;
    expect(t1.g1).toBe("pass");
    expect(t1.g2).toBe("fail");
  });
  test("a terminal unit failure is a G2 completeness failure, not only a G3 gap (codex C0-R1 f.9)", () => {
    const out = scoreMatrix(synthBundle(() => 1500, (spec) =>
      spec.driver === "T1" && spec.pos === 2
        ? { ...spec, over: { outcome: "unit-failure", failureCause: "circuit breaker: 3 consecutive failed dispatches", failureEvidence: { kind: "unit" } } }
        : spec));
    const t1 = out.gates.find((g) => g.driver === "T1")!;
    expect(t1.g2).toBe("fail");
    expect(t1.g3).toBe("fail");
    expect(t1.reasons.some((r) => r.includes("circuit breaker"))).toBe(true);
  });
  test("G1 byte divergence and disk breaches on INVALIDATED attempts still disqualify (codex C0-R1 f.10)", () => {
    // an invalidated-foreign attempt with observed wrong bytes at pos 3, later replayed clean:
    // the wrong bytes were delivered by the driver and must not vanish with the invalidation
    const bundle = synthBundle(() => 1500);
    const invalidated = rowLines({
      pos: 3, unit: UNITS[0]!, driver: "T2a", rep: 1, wallMs: 1500,
      over: { attemptId: "a-3-bad", outcome: "invalidated-foreign", g1Failures: 2 },
    });
    const out = scoreMatrix({ ...bundle, runsLines: [...invalidated, ...bundle.runsLines] });
    const t2a = out.gates.find((g) => g.driver === "T2a")!;
    expect(t2a.g1).toBe("fail");
    expect(t2a.reasons.some((r) => r.includes("invalidated-foreign"))).toBe(true);
    // positive-kind G2 (duplicates, forbidden routes) on an invalidated attempt survives the
    // invalidation exactly like G1 — the count must be READ, not defaulted (review round 1 F5)
    const g2pos = rowLines({
      pos: 3, unit: UNITS[0]!, driver: "T2a", rep: 1, wallMs: 1500,
      over: { attemptId: "a-3-g2p", outcome: "invalidated-foreign", g2PositiveFailures: 1 },
    });
    const out2 = scoreMatrix({ ...bundle, runsLines: [...g2pos, ...bundle.runsLines] });
    const t2a2 = out2.gates.find((g) => g.driver === "T2a")!;
    expect(t2a2.g2).toBe("fail");
    // same for a disk breach on a replaced attempt
    const diskRow = rowLines({
      pos: 3, unit: UNITS[0]!, driver: "T2a", rep: 1, wallMs: 1500,
      over: { attemptId: "a-3-disk", outcome: "invalidated-foreign", diskSampledPeakBytes: CFG.protocol.diskGateBytes + 1 },
    });
    const diskOut = scoreMatrix({ ...bundle, runsLines: [...diskRow, ...bundle.runsLines] });
    expect(diskOut.gates.find((g) => g.driver === "T2a")!.g4).toBe("fail");
  });
});
