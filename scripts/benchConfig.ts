// benchConfig.ts — strict loader for docs/adrs/0001-benchmark/bench-config.json, the
// benchmark's preregistered-constants artifact (resolution plan §4.3 step 1). Every field is
// validated fail-closed (house posture: config.ts) — a preregistration that half-parses is a
// preregistration that can drift. The schedule member is null until corpus pinning writes the
// literal traversal table; when present it is validated against the §4.5 rules via
// benchSchedule's validators plus the corpus units the caller supplies.

import { readFileSync } from "node:fs";
import {
  DRIVERS, validateWilliamsRows,
  type DriverId, type Schedule, type ScheduleRow,
} from "./benchSchedule.ts";

export class BenchConfigError extends Error {
  constructor(message: string) {
    super(`BENCH CONFIG: ${message}`);
    this.name = "BenchConfigError";
  }
}
const fail = (msg: string): never => {
  throw new BenchConfigError(msg);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function section(o: Record<string, unknown>, key: string, path = key): Record<string, unknown> {
  const v = o[key];
  if (!isObject(v)) fail(`${path} must be an object`);
  return v as Record<string, unknown>;
}
function num(o: Record<string, unknown>, path: string, key: string, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${path}.${key} must be a finite number`);
  const n = v as number;
  if (opts.integer !== false && !Number.isSafeInteger(n)) fail(`${path}.${key} must be a safe integer`);
  if (opts.min !== undefined && n < opts.min) fail(`${path}.${key} must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) fail(`${path}.${key} must be <= ${opts.max}`);
  return n;
}
function fraction(o: Record<string, unknown>, path: string, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v >= 1) fail(`${path}.${key} must be a fraction in (0, 1)`);
  return v as number;
}
function str(o: Record<string, unknown>, path: string, key: string, opts: { nonEmpty?: boolean } = {}): string {
  const v = o[key];
  if (typeof v !== "string") fail(`${path}.${key} must be a string`);
  if (opts.nonEmpty !== false && (v as string).length === 0) fail(`${path}.${key} must be non-empty`);
  return v as string;
}
function strArray(o: Record<string, unknown>, path: string, key: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0))
    fail(`${path}.${key} must be an array of non-empty strings`);
  return v as string[];
}

export interface BenchScaffolding {
  tuples: {
    init: readonly string[];
    remoteAdd: readonly string[];
    fetch: readonly string[];
    checkoutDetach: readonly string[];
    lsRemoteProbe: readonly string[];
  };
  gitconfigBaseline: string;
  gitconfigProbeAutocrlfTrue: string;
}

export interface BenchConfig {
  githubHost: string;
  reps: number;
  drivers: readonly DriverId[];
  selection: {
    trackedPackages: string[];
    excludeDirGlobs: string[];
    maxScanBytes: number;
  };
  rest: {
    rawAccept: string;
    attemptCap: number;
    secondaryBaseWaitMs: number;
    transientBaseWaitMs: number;
  };
  restFallbackBudget: { floor: number; fractionOfSelected: number };
  t1: {
    aliasCap: number;
    queryDocBytesCap: number;
    batchContentBytesCap: number;
    argvBytesCap: number;
    aliasSelection: string;
    rateLimitRider: string;
    splitTriggers: {
      graphqlErrorType: string;
      timeoutMessageRe: RegExp;
      consecutive5xx: { count: number; statuses: number[]; capUtilisationFloor: number };
    };
    split: { maxDepth: number; maxDescendantsPerOriginal: number };
    circuitBreakerConsecutiveFailedDispatches: number;
  };
  t2a: { apiEscapeRepoSizeKb: number };
  spawn: { timeoutMs: number; killGraceMs: number; outputCapBytes: number };
  frame: {
    maxHeaderBytes: number;
    frameCeilingBytes: number;
    stderrRingBytes: number;
    readDeadlineMs: number;
    disposeDeadlineMs: number;
    childPoolSize: number;
  };
  lsTree: { maxEntries: number; maxRecordBytes: number; maxOutputBytes: number };
  protocol: {
    tempPrefix: string;
    washoutFloorMs: number;
    diskGateBytes: number;
    diskSamplerHz: number;
    g4: { warnAtMost: number; failAt: number };
    rerunAllowancePerUnitDriver: number;
  };
  budget: {
    pMaxPointsPerGraphqlAttempt: number;
    headroomFactor: number;
    bucketCapacityPerHour: number;
    fixedPerRunOverheadRequests: number;
  };
  noiseBand: { floor: number; roundUpTo: number };
  pilot: { driver: DriverId; slot: string; reps: number };
  williamsRows: readonly (readonly DriverId[])[];
  scaffolding: BenchScaffolding;
  schedule: Schedule | null;
}

// §4.4: the per-unit REST fallback budget, every driver — max(floor, ceil(fraction × selected)).
export function restFallbackBudgetFor(cfg: BenchConfig, selectedCount: number): number {
  return Math.max(cfg.restFallbackBudget.floor, Math.ceil(cfg.restFallbackBudget.fractionOfSelected * selectedCount));
}

// §4.7: band = max(floor, pilot spread rounded UP to the next roundUpTo step).
export function noiseBandFrom(cfg: BenchConfig, pilotSpread: number): number {
  if (!Number.isFinite(pilotSpread) || pilotSpread < 1) fail(`pilot spread must be a finite ratio >= 1, got ${pilotSpread}`);
  const step = cfg.noiseBand.roundUpTo;
  // integer-domain ceil to dodge float artifacts (1.3000000000000003 must not round to 1.35)
  const rounded = Math.ceil(Math.round(pilotSpread * 10_000) / (step * 10_000)) * step;
  return Math.max(cfg.noiseBand.floor, Number(rounded.toFixed(4)));
}

function parseDriverList(v: unknown, path: string): DriverId[] {
  if (!Array.isArray(v)) fail(`${path} must be an array`);
  const list = (v as unknown[]).map((d, i) => {
    if (typeof d !== "string" || !(DRIVERS as readonly string[]).includes(d)) fail(`${path}[${i}] must be one of ${DRIVERS.join(", ")}`);
    return d as DriverId;
  });
  return list;
}

function parseScheduleMember(v: unknown): Schedule | null {
  if (v === null) return null;
  if (!isObject(v)) fail("schedule must be null or an object");
  const o = v as Record<string, unknown>;
  const unitOrder = strArray(o, "schedule", "unitOrder");
  const rowsRaw = o["rows"];
  if (!Array.isArray(rowsRaw)) fail("schedule.rows must be an array");
  const rows: ScheduleRow[] = (rowsRaw as unknown[]).map((r, i) => {
    if (!isObject(r)) fail(`schedule.rows[${i}] must be an object`);
    const row = r as Record<string, unknown>;
    const driver = str(row, `schedule.rows[${i}]`, "driver");
    if (!(DRIVERS as readonly string[]).includes(driver)) fail(`schedule.rows[${i}].driver must be one of ${DRIVERS.join(", ")}`);
    const probe = row["probe"];
    if (typeof probe !== "boolean") return fail(`schedule.rows[${i}].probe must be a boolean`);
    return {
      pos: num(row, `schedule.rows[${i}]`, "pos", { min: 1 }),
      unit: str(row, `schedule.rows[${i}]`, "unit"),
      driver: driver as DriverId,
      rep: num(row, `schedule.rows[${i}]`, "rep", { min: 1 }),
      probe,
    };
  });
  return { unitOrder, rows };
}

export function parseBenchConfig(jsonText: string): BenchConfig {
  let root: unknown;
  try {
    root = JSON.parse(jsonText);
  } catch {
    fail("bench-config.json is not valid JSON");
  }
  if (!isObject(root)) fail("bench-config.json root must be an object");
  const o = root as Record<string, unknown>;

  const drivers = parseDriverList(o["drivers"], "drivers");
  if (drivers.join(",") !== DRIVERS.join(",")) fail(`drivers must be exactly [${DRIVERS.join(", ")}] in order`);

  const selection = section(o, "selection");
  const rest = section(o, "rest");
  const rfb = section(o, "restFallbackBudget");
  if (str(rfb, "restFallbackBudget", "rounding") !== "ceil") fail("restFallbackBudget.rounding must be \"ceil\" (the formula pins it)");
  const t1 = section(o, "t1");
  const splitTriggers = section(t1, "splitTriggers", "t1.splitTriggers");
  const c5xx = section(splitTriggers, "consecutive5xx", "t1.splitTriggers.consecutive5xx");
  const split = section(t1, "split", "t1.split");
  const t2a = section(o, "t2a");
  const spawn = section(o, "spawn");
  const frame = section(o, "frame");
  const lsTree = section(o, "lsTree");
  const protocol = section(o, "protocol");
  const g4 = section(protocol, "g4AttributableSecondarySignals", "protocol.g4AttributableSecondarySignals");
  const budget = section(o, "budget");
  const noiseBand = section(o, "noiseBand");
  const pilot = section(o, "pilot");
  const scaffolding = section(o, "scaffolding");
  const tuples = section(scaffolding, "tuples", "scaffolding.tuples");

  let timeoutMessageRe: RegExp;
  try {
    timeoutMessageRe = new RegExp(
      str(splitTriggers, "t1.splitTriggers", "timeoutMessageRegex"),
      str(splitTriggers, "t1.splitTriggers", "timeoutMessageRegexFlags", { nonEmpty: false }),
    );
  } catch {
    return fail("t1.splitTriggers.timeoutMessageRegex does not compile");
  }
  const statuses = c5xx["statuses"];
  if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some((s) => typeof s !== "number" || !Number.isSafeInteger(s) || s < 500 || s > 599))
    fail("t1.splitTriggers.consecutive5xx.statuses must be a non-empty array of 5xx codes");

  const williamsRaw = o["williamsRows"];
  if (!Array.isArray(williamsRaw)) fail("williamsRows must be an array");
  const williamsRows = (williamsRaw as unknown[]).map((row, i) => parseDriverList(row, `williamsRows[${i}]`));
  const williamsViolations = validateWilliamsRows(williamsRows, DRIVERS);
  if (williamsViolations.length > 0) fail(`williamsRows violate the Williams-design preregistration: ${williamsViolations.join("; ")}`);

  const reps = num(o, "", "reps", { min: 1 });
  if (reps !== williamsRows.length) fail(`reps (${reps}) must equal the number of declared driver orders (${williamsRows.length})`);

  const tuple = (key: string): string[] => {
    const t = strArray(tuples, "scaffolding.tuples", key);
    if (t.length === 0) fail(`scaffolding.tuples.${key} must be non-empty`);
    return t;
  };
  const pilotDriver = str(pilot, "pilot", "driver");
  if (!(DRIVERS as readonly string[]).includes(pilotDriver)) fail(`pilot.driver must be one of ${DRIVERS.join(", ")}`);

  const cfg: BenchConfig = {
    githubHost: str(o, "", "githubHost"),
    reps,
    drivers,
    selection: {
      trackedPackages: strArray(selection, "selection", "trackedPackages"),
      excludeDirGlobs: strArray(selection, "selection", "excludeDirGlobs"),
      maxScanBytes: num(selection, "selection", "maxScanBytes", { min: 1 }),
    },
    rest: {
      rawAccept: str(rest, "rest", "rawAccept"),
      attemptCap: num(rest, "rest", "attemptCap", { min: 1 }),
      secondaryBaseWaitMs: num(rest, "rest", "secondaryBaseWaitMs", { min: 0 }),
      transientBaseWaitMs: num(rest, "rest", "transientBaseWaitMs", { min: 0 }),
    },
    restFallbackBudget: {
      floor: num(rfb, "restFallbackBudget", "floor", { min: 0 }),
      fractionOfSelected: fraction(rfb, "restFallbackBudget", "fractionOfSelected"),
    },
    t1: {
      aliasCap: num(t1, "t1", "aliasCap", { min: 1 }),
      queryDocBytesCap: num(t1, "t1", "queryDocBytesCap", { min: 1 }),
      batchContentBytesCap: num(t1, "t1", "batchContentBytesCap", { min: 1 }),
      argvBytesCap: num(t1, "t1", "argvBytesCap", { min: 1 }),
      aliasSelection: str(t1, "t1", "aliasSelection"),
      rateLimitRider: str(t1, "t1", "rateLimitRider"),
      splitTriggers: {
        graphqlErrorType: str(splitTriggers, "t1.splitTriggers", "graphqlErrorType"),
        timeoutMessageRe,
        consecutive5xx: {
          count: num(c5xx, "t1.splitTriggers.consecutive5xx", "count", { min: 1 }),
          statuses: statuses as number[],
          capUtilisationFloor: fraction(c5xx, "t1.splitTriggers.consecutive5xx", "capUtilisationFloor"),
        },
      },
      split: {
        maxDepth: num(split, "t1.split", "maxDepth", { min: 1 }),
        maxDescendantsPerOriginal: num(split, "t1.split", "maxDescendantsPerOriginal", { min: 1 }),
      },
      circuitBreakerConsecutiveFailedDispatches: num(t1, "t1", "circuitBreakerConsecutiveFailedDispatches", { min: 1 }),
    },
    t2a: { apiEscapeRepoSizeKb: num(t2a, "t2a", "apiEscapeRepoSizeKb", { min: 1 }) },
    spawn: {
      timeoutMs: num(spawn, "spawn", "timeoutMs", { min: 1 }),
      killGraceMs: num(spawn, "spawn", "killGraceMs", { min: 1 }),
      outputCapBytes: num(spawn, "spawn", "outputCapBytes", { min: 1 }),
    },
    frame: {
      maxHeaderBytes: num(frame, "frame", "maxHeaderBytes", { min: 8 }),
      frameCeilingBytes: num(frame, "frame", "frameCeilingBytes", { min: 1 }),
      stderrRingBytes: num(frame, "frame", "stderrRingBytes", { min: 1 }),
      readDeadlineMs: num(frame, "frame", "readDeadlineMs", { min: 1 }),
      disposeDeadlineMs: num(frame, "frame", "disposeDeadlineMs", { min: 1 }),
      childPoolSize: num(frame, "frame", "childPoolSize", { min: 1 }),
    },
    lsTree: {
      maxEntries: num(lsTree, "lsTree", "maxEntries", { min: 1 }),
      maxRecordBytes: num(lsTree, "lsTree", "maxRecordBytes", { min: 64 }),
      maxOutputBytes: num(lsTree, "lsTree", "maxOutputBytes", { min: 1 }),
    },
    protocol: {
      tempPrefix: str(protocol, "protocol", "tempPrefix"),
      washoutFloorMs: num(protocol, "protocol", "washoutFloorMs", { min: 0 }),
      diskGateBytes: num(protocol, "protocol", "diskGateBytes", { min: 1 }),
      diskSamplerHz: num(protocol, "protocol", "diskSamplerHz", { min: 1 }),
      g4: {
        warnAtMost: num(g4, "protocol.g4", "warnAtMost", { min: 0 }),
        failAt: num(g4, "protocol.g4", "failAt", { min: 1 }),
      },
      rerunAllowancePerUnitDriver: num(protocol, "protocol", "rerunAllowancePerUnitDriver", { min: 0 }),
    },
    budget: {
      pMaxPointsPerGraphqlAttempt: num(budget, "budget", "pMaxPointsPerGraphqlAttempt", { min: 1 }),
      headroomFactor: num(budget, "budget", "headroomFactor", { min: 1, integer: false }),
      bucketCapacityPerHour: num(budget, "budget", "bucketCapacityPerHour", { min: 1 }),
      fixedPerRunOverheadRequests: num(budget, "budget", "fixedPerRunOverheadRequests", { min: 0 }),
    },
    noiseBand: {
      floor: num(noiseBand, "noiseBand", "floor", { min: 1, integer: false }),
      roundUpTo: num(noiseBand, "noiseBand", "roundUpTo", { min: 0.0001, integer: false }),
    },
    pilot: {
      driver: pilotDriver as DriverId,
      slot: str(pilot, "pilot", "slot"),
      reps: num(pilot, "pilot", "reps", { min: 1 }),
    },
    williamsRows,
    scaffolding: {
      tuples: {
        init: tuple("init"),
        remoteAdd: tuple("remoteAdd"),
        fetch: tuple("fetch"),
        checkoutDetach: tuple("checkoutDetach"),
        lsRemoteProbe: tuple("lsRemoteProbe"),
      },
      gitconfigBaseline: str(scaffolding, "scaffolding", "gitconfigBaseline"),
      gitconfigProbeAutocrlfTrue: str(scaffolding, "scaffolding", "gitconfigProbeAutocrlfTrue"),
    },
    schedule: parseScheduleMember(o["schedule"]),
  };

  // cross-field coherence the formulas rely on
  if (cfg.protocol.g4.failAt !== cfg.protocol.g4.warnAtMost + 1)
    fail("protocol.g4: failAt must be warnAtMost + 1 (pass/warn/fail is a partition)");
  if (cfg.frame.frameCeilingBytes !== cfg.spawn.outputCapBytes)
    fail("frame.frameCeilingBytes must equal spawn.outputCapBytes (the plan pins the ceiling to production's spawn cap)");
  if (cfg.pilot.reps !== cfg.reps) fail("pilot.reps must equal reps (the pilot calibrates the same K)");
  return cfg;
}

export function loadBenchConfig(path: string): BenchConfig {
  return parseBenchConfig(readFileSync(path, "utf8"));
}
