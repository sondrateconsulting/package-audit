// benchConfig.test.ts — the committed preregistration artifact must always parse, carry the
// plan-mandated literals, and stay in sync with the production constants it mirrors; the
// schedule generator must satisfy its own §4.5 properties.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPAWN_KILL_GRACE_MS, SPAWN_TIMEOUT_MS } from "./github.ts";
import { BenchConfigError, loadBenchConfig, noiseBandFrom, parseBenchConfig, restFallbackBudgetFor } from "./benchConfig.ts";
import {
  BenchScheduleError, DRIVERS, buildSchedule, interleaveUnits, probeDriversFor,
  validateSchedule, validateWilliamsRows, type ScheduleUnit,
} from "./benchSchedule.ts";

const CONFIG_PATH = join(import.meta.dir, "..", "docs", "adrs", "0001-benchmark", "bench-config.json");
const RAW = readFileSync(CONFIG_PATH, "utf8");
const CFG = loadBenchConfig(CONFIG_PATH);

describe("the committed bench-config.json", () => {
  test("parses strictly", () => {
    expect(CFG.githubHost).toBe("github.com");
    expect(CFG.drivers).toEqual(["T0", "T1", "T2a", "T2c"]);
  });
  test("carries the §4.4/§4.5/§4.7/§4.8 plan literals", () => {
    expect(CFG.reps).toBe(5); // K = 5
    expect(CFG.t1.aliasCap).toBe(250); // M2's measured point
    expect(CFG.t1.queryDocBytesCap).toBe(48 * 1024);
    expect(CFG.t1.batchContentBytesCap).toBe(Math.round(1.5 * 1024 * 1024));
    expect(CFG.t1.argvBytesCap).toBe(128 * 1024);
    expect(CFG.t1.split).toEqual({ maxDepth: 2, maxDescendantsPerOriginal: 4 });
    expect(CFG.t1.circuitBreakerConsecutiveFailedDispatches).toBe(3);
    expect(CFG.t1.splitTriggers.graphqlErrorType).toBe("TIMEOUT");
    expect(CFG.t1.splitTriggers.consecutive5xx).toEqual({ count: 2, statuses: [502, 503, 504], capUtilisationFloor: 0.8 });
    expect(CFG.restFallbackBudget).toEqual({ floor: 20, fractionOfSelected: 0.1 });
    expect(CFG.budget.pMaxPointsPerGraphqlAttempt).toBe(10); // never the 1-point floor
    expect(CFG.budget.headroomFactor).toBe(1.1);
    expect(CFG.budget.bucketCapacityPerHour).toBe(5000);
    expect(CFG.protocol.washoutFloorMs).toBe(60_000);
    expect(CFG.protocol.diskGateBytes).toBe(2 * 1024 * 1024 * 1024); // the 2 GiB G4 gate
    expect(CFG.protocol.g4).toEqual({ warnAtMost: 1, failAt: 2 });
    expect(CFG.noiseBand).toEqual({ floor: 1.25, roundUpTo: 0.05 });
    expect(CFG.pilot).toEqual({ driver: "T0", slot: "C2", reps: 5 });
    expect(CFG.protocol.tempPrefix).toBe("pa-bench-"); // NOT pkg-audit-* (production sweeps that)
  });
  test("mirrored production literals stay in sync where the symbol is exported", () => {
    expect(CFG.spawn.timeoutMs).toBe(SPAWN_TIMEOUT_MS);
    expect(CFG.spawn.killGraceMs).toBe(SPAWN_KILL_GRACE_MS);
    // module-local production literals, pinned by value (github.ts / unitPipeline.ts):
    expect(CFG.spawn.outputCapBytes).toBe(110 * 1024 * 1024); // MAX_SPAWN_OUTPUT_BYTES
    expect(CFG.rest.attemptCap).toBe(6); // MAX_ATTEMPTS
    expect(CFG.rest.secondaryBaseWaitMs).toBe(60_000);
    expect(CFG.rest.transientBaseWaitMs).toBe(2_000);
    expect(CFG.rest.rawAccept).toBe("application/vnd.github.raw+json");
    expect(CFG.selection.maxScanBytes).toBe(2 * 1024 * 1024); // MAX_SCAN_BYTES
    expect(CFG.frame.frameCeilingBytes).toBe(CFG.spawn.outputCapBytes);
    expect(CFG.frame.childPoolSize).toBe(8); // the subprocess semaphore's production default
  });
  test("the timeout-message regex compiles and matches the documented shapes", () => {
    const re = CFG.t1.splitTriggers.timeoutMessageRe;
    expect(re.test("Something went wrong… This may be the result of a timeout")).toBe(true);
    expect(re.test("the query TIMED OUT")).toBe(true);
    expect(re.test("time out")).toBe(true);
    expect(re.test("rate limited")).toBe(false);
  });
  test("the schedule member is the pinned literal table (benchArtifacts.test.ts validates it against the corpus)", () => {
    expect(CFG.schedule === null || CFG.schedule.rows.length > 0).toBe(true);
  });
});

describe("loader fail-closed behaviour", () => {
  const mutate = (fn: (o: Record<string, unknown>) => void): (() => unknown) => {
    const o = JSON.parse(RAW) as Record<string, unknown>;
    fn(o);
    return () => parseBenchConfig(JSON.stringify(o));
  };
  test("driver order, williams properties, ceiling coherence, and g4 partition are enforced", () => {
    expect(mutate((o) => { o["drivers"] = ["T1", "T0", "T2a", "T2c"]; })).toThrow(BenchConfigError);
    expect(mutate((o) => {
      const rows = o["williamsRows"] as string[][];
      rows[1] = rows[0]!; // duplicate row breaks digram balance
    })).toThrow(BenchConfigError);
    expect(mutate((o) => { (o["frame"] as Record<string, unknown>)["frameCeilingBytes"] = 1; })).toThrow(BenchConfigError);
    expect(mutate((o) => { ((o["protocol"] as Record<string, unknown>)["g4AttributableSecondarySignals"] as Record<string, unknown>)["failAt"] = 5; })).toThrow(BenchConfigError);
    expect(mutate((o) => { o["reps"] = 4; })).toThrow(BenchConfigError); // must equal declared orders
    expect(mutate((o) => { ((o["t1"] as Record<string, unknown>)["splitTriggers"] as Record<string, unknown>)["timeoutMessageRegex"] = "("; })).toThrow(BenchConfigError);
    expect(mutate((o) => { (o["restFallbackBudget"] as Record<string, unknown>)["rounding"] = "floor"; })).toThrow(BenchConfigError);
  });
});

describe("preregistered formulas", () => {
  test("restFallbackBudgetFor = max(20, ceil(10% of selected))", () => {
    expect(restFallbackBudgetFor(CFG, 0)).toBe(20);
    expect(restFallbackBudgetFor(CFG, 100)).toBe(20);
    expect(restFallbackBudgetFor(CFG, 200)).toBe(20);
    expect(restFallbackBudgetFor(CFG, 201)).toBe(21); // ceil, pinned
    expect(restFallbackBudgetFor(CFG, 500)).toBe(50);
  });
  test("noiseBandFrom = max(1.25, spread rounded UP to 0.05)", () => {
    expect(noiseBandFrom(CFG, 1.0)).toBe(1.25);
    expect(noiseBandFrom(CFG, 1.25)).toBe(1.25);
    expect(noiseBandFrom(CFG, 1.26)).toBe(1.3);
    expect(noiseBandFrom(CFG, 1.3000000000000003)).toBe(1.3); // float artifact must not bump a step
    expect(noiseBandFrom(CFG, 1.31)).toBe(1.35);
    expect(noiseBandFrom(CFG, 2.04)).toBe(2.05);
    expect(() => noiseBandFrom(CFG, 0.9)).toThrow(BenchConfigError);
  });
});

// ---- schedule generator ----------------------------------------------------------------------
const UNITS: ScheduleUnit[] = [
  { unitId: "C1:o/fastify@main", repoKey: "o/fastify", slot: "C1" },
  { unitId: "C1:o/fastify@4.x", repoKey: "o/fastify", slot: "C1" },
  { unitId: "C1:o/fastify@3.x", repoKey: "o/fastify", slot: "C1" },
  { unitId: "C1:o/fastify@2.x", repoKey: "o/fastify", slot: "C1" },
  { unitId: "C2:o/undici@main", repoKey: "o/undici", slot: "C2" },
  { unitId: "C3:o/nixpkgs@master", repoKey: "o/nixpkgs", slot: "C3" },
  { unitId: "C4:o/llvm@main", repoKey: "o/llvm", slot: "C4" },
  { unitId: "C5:o/pwsh@master", repoKey: "o/pwsh", slot: "C5" },
];

describe("benchSchedule", () => {
  test("the committed williams rows satisfy the design; a corrupted set does not", () => {
    expect(validateWilliamsRows(CFG.williamsRows, DRIVERS)).toEqual([]);
    const swapped = [CFG.williamsRows[0]!, CFG.williamsRows[0]!, CFG.williamsRows[2]!, CFG.williamsRows[3]!, CFG.williamsRows[4]!];
    expect(validateWilliamsRows(swapped, DRIVERS).length).toBeGreaterThan(0);
  });
  test("interleaving never places two same-repository units adjacently", () => {
    const order = interleaveUnits(UNITS);
    expect(order.length).toBe(UNITS.length);
    for (let i = 0; i + 1 < order.length; i++) expect(order[i]!.repoKey).not.toBe(order[i + 1]!.repoKey);
    // deterministic: same input, same order
    expect(interleaveUnits(UNITS).map((u) => u.unitId)).toEqual(order.map((u) => u.unitId));
  });
  test("infeasible interleaving throws instead of silently emitting an adjacent pair", () => {
    const bad: ScheduleUnit[] = [
      { unitId: "a1", repoKey: "r", slot: "C1" },
      { unitId: "a2", repoKey: "r", slot: "C1" },
      { unitId: "a3", repoKey: "r", slot: "C1" },
      { unitId: "b", repoKey: "s", slot: "C2" },
    ];
    expect(() => interleaveUnits(bad)).toThrow(BenchScheduleError);
  });
  test("buildSchedule emits the full main traversal plus the probe epilogue, and validates clean", () => {
    const schedule = buildSchedule(UNITS, CFG.williamsRows, CFG.reps);
    const main = schedule.rows.filter((r) => !r.probe);
    const probe = schedule.rows.filter((r) => r.probe);
    expect(main.length).toBe(UNITS.length * CFG.reps * DRIVERS.length); // 8 × 5 × 4 = 160
    // probe: T2a on all 8 units (scheduled regardless of C3's api-escape) + T0/T1 on C4 = 8 + 2
    expect(probe.length).toBe(10);
    expect(probeDriversFor(UNITS[6]!)).toEqual(["T0", "T1", "T2a"]); // the C4 unit
    expect(probeDriversFor(UNITS[0]!)).toEqual(["T2a"]);
    expect(probe.every((r) => r.rep === CFG.reps + 1)).toBe(true);
    expect(validateSchedule(schedule, UNITS, CFG.williamsRows, CFG.reps)).toEqual([]);
  });
  test("validateSchedule catches reordering, probe misplacement, and adjacency violations", () => {
    const schedule = buildSchedule(UNITS, CFG.williamsRows, CFG.reps);
    const swappedRows = structuredClone(schedule);
    const a = swappedRows.rows[0]!;
    const b = swappedRows.rows[1]!;
    swappedRows.rows[0] = { ...b, pos: 1 };
    swappedRows.rows[1] = { ...a, pos: 2 };
    expect(validateSchedule(swappedRows, UNITS, CFG.williamsRows, CFG.reps).length).toBeGreaterThan(0);

    const probeEarly = structuredClone(schedule);
    const firstProbe = probeEarly.rows.findIndex((r) => r.probe);
    probeEarly.rows[firstProbe]! .probe = false; // a probe row masquerading as a main row
    expect(validateSchedule(probeEarly, UNITS, CFG.williamsRows, CFG.reps).length).toBeGreaterThan(0);

    const adjacent = structuredClone(schedule);
    adjacent.unitOrder = UNITS.map((u) => u.unitId); // four C1 siblings back-to-back
    expect(validateSchedule(adjacent, UNITS, CFG.williamsRows, CFG.reps).length).toBeGreaterThan(0);
  });
});
