// benchCorpus.ts — corpus.json types, strict parsing, and the PURE slot-verification
// predicates (resolution plan §4.2). Live pinning (the CLI) gathers the raw evidence — trees,
// branch heads, checkout hashes — and these predicates decide "verified" fail-closed; a
// candidate that fails is SWAPPED, never forced. Every predicate returns its reasons so the
// pinning record carries the evidence, not just a boolean.

import { isFullOid, type BenchObjectFormat } from "./benchGrammar.ts";
import type { DriverId, ScheduleUnit } from "./benchSchedule.ts";

export class BenchCorpusError extends Error {
  constructor(message: string) {
    super(`BENCH CORPUS: ${message}`);
    this.name = "BenchCorpusError";
  }
}
const fail = (msg: string): never => {
  throw new BenchCorpusError(msg);
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ---- shapes ----------------------------------------------------------------------------------
export interface CorpusUnit {
  unitId: string; // "<slot>:<owner>/<repo>@<branch>"
  branch: string;
  sha: string; // the pinned commit oid (full, lowercase, repo's object format)
  treeOid: string;
}

export type PerformanceSlotId = "C1" | "C2" | "C3" | "C4" | "C5";
export const PERFORMANCE_SLOTS: readonly PerformanceSlotId[] = ["C1", "C2", "C3", "C4", "C5"];

export interface PerformanceSlot {
  slot: PerformanceSlotId;
  owner: string;
  repo: string;
  objectFormat: BenchObjectFormat;
  repoSizeKb: number; // the REST repository `size` field at pinning (T2a's escape input, §4.4)
  units: CorpusUnit[]; // C1: ≥4 branch units; C2–C5: exactly one
  verification: Record<string, unknown>; // slot evidence, recorded verbatim at pinning
}

export type C6FixtureKind = "api-only-symlink" | "clone-symlink" | "non-utf8-content";
export interface C6FixtureEntry {
  path: string;
  mode: string;
  oid: string;
  size: number;
}
export interface C6Fixture {
  kind: C6FixtureKind;
  owner: string;
  repo: string;
  branch: string | null; // null for API-only SHA pins
  sha: string;
  objectFormat: BenchObjectFormat;
  appliesTo: DriverId[]; // plan §4.2: the node M9 fixture applies to T0/T1 only
  entries: C6FixtureEntry[]; // the fixture's workload entries (fidelity battery, K = 1)
  verification: Record<string, unknown>;
}

export interface Corpus {
  pinnedAtIso: string;
  pinnedByLogin: string; // the gh identity's non-secret fingerprint (§4.8)
  performance: PerformanceSlot[];
  fidelity: C6Fixture[];
}

// ---- strict parse ----------------------------------------------------------------------------
function str(o: Record<string, unknown>, path: string, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) fail(`${path}.${key} must be a non-empty string`);
  return v as string;
}
function nonNegInt(o: Record<string, unknown>, path: string, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(`${path}.${key} must be a nonnegative safe integer`);
  return v as number;
}
function objectFormat(o: Record<string, unknown>, path: string): BenchObjectFormat {
  const v = str(o, path, "objectFormat");
  if (v !== "sha1" && v !== "sha256") fail(`${path}.objectFormat must be sha1 or sha256`);
  return v as BenchObjectFormat;
}

function parseUnit(v: unknown, path: string, format: BenchObjectFormat): CorpusUnit {
  if (!isObject(v)) fail(`${path} must be an object`);
  const o = v as Record<string, unknown>;
  const unit: CorpusUnit = {
    unitId: str(o, path, "unitId"),
    branch: str(o, path, "branch"),
    sha: str(o, path, "sha"),
    treeOid: str(o, path, "treeOid"),
  };
  if (!isFullOid(unit.sha, format)) fail(`${path}.sha is not a full lowercase ${format} object id`);
  if (!isFullOid(unit.treeOid, format)) fail(`${path}.treeOid is not a full lowercase ${format} object id`);
  return unit;
}

export function parseCorpus(jsonText: string): Corpus {
  let root: unknown;
  try {
    root = JSON.parse(jsonText);
  } catch {
    fail("corpus.json is not valid JSON");
  }
  if (!isObject(root)) fail("corpus root must be an object");
  const o = root as Record<string, unknown>;
  const perfRaw = o["performance"];
  if (!Array.isArray(perfRaw)) fail("performance must be an array");
  const performance = (perfRaw as unknown[]).map((s, i) => {
    if (!isObject(s)) fail(`performance[${i}] must be an object`);
    const so = s as Record<string, unknown>;
    const slot = str(so, `performance[${i}]`, "slot");
    if (!(PERFORMANCE_SLOTS as readonly string[]).includes(slot)) fail(`performance[${i}].slot must be C1..C5`);
    const format = objectFormat(so, `performance[${i}]`);
    const unitsRaw = so["units"];
    if (!Array.isArray(unitsRaw) || unitsRaw.length === 0) fail(`performance[${i}].units must be a non-empty array`);
    const units = (unitsRaw as unknown[]).map((u, j) => parseUnit(u, `performance[${i}].units[${j}]`, format));
    if (slot === "C1" && units.length < 4) fail("C1 must pin at least 4 branch units (the concurrency probe needs 4 streams)");
    if (slot !== "C1" && units.length !== 1) fail(`${slot} must pin exactly one unit`);
    const verification = so["verification"];
    if (!isObject(verification)) fail(`performance[${i}].verification must be an object`);
    const parsed: PerformanceSlot = {
      slot: slot as PerformanceSlotId,
      owner: str(so, `performance[${i}]`, "owner"),
      repo: str(so, `performance[${i}]`, "repo"),
      objectFormat: format,
      repoSizeKb: nonNegInt(so, `performance[${i}]`, "repoSizeKb"),
      units,
      verification: verification as Record<string, unknown>,
    };
    for (const u of parsed.units) {
      const expected = `${parsed.slot}:${parsed.owner}/${parsed.repo}@${u.branch}`;
      if (u.unitId !== expected) fail(`unitId ${u.unitId} must be ${expected}`);
    }
    return parsed;
  });
  const slotIds = performance.map((p) => p.slot);
  if (new Set(slotIds).size !== slotIds.length) fail("duplicate performance slots");
  for (const required of PERFORMANCE_SLOTS) {
    if (!slotIds.includes(required)) fail(`missing performance slot ${required}`);
  }
  const fidRaw = o["fidelity"];
  if (!Array.isArray(fidRaw)) fail("fidelity must be an array");
  const fidelity = (fidRaw as unknown[]).map((f, i) => {
    if (!isObject(f)) fail(`fidelity[${i}] must be an object`);
    const fo = f as Record<string, unknown>;
    const kind = str(fo, `fidelity[${i}]`, "kind");
    if (kind !== "api-only-symlink" && kind !== "clone-symlink" && kind !== "non-utf8-content")
      fail(`fidelity[${i}].kind unknown: ${kind}`);
    const format = objectFormat(fo, `fidelity[${i}]`);
    const sha = str(fo, `fidelity[${i}]`, "sha");
    if (!isFullOid(sha, format)) fail(`fidelity[${i}].sha is not a full lowercase ${format} object id`);
    const branch = fo["branch"];
    if (branch !== null && typeof branch !== "string") fail(`fidelity[${i}].branch must be a string or null`);
    const appliesRaw = fo["appliesTo"];
    if (!Array.isArray(appliesRaw) || appliesRaw.length === 0) fail(`fidelity[${i}].appliesTo must be non-empty`);
    const appliesTo = (appliesRaw as unknown[]).map((d) => {
      if (d !== "T0" && d !== "T1" && d !== "T2a" && d !== "T2c") fail(`fidelity[${i}].appliesTo has unknown driver`);
      return d as DriverId;
    });
    const entriesRaw = fo["entries"];
    if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) fail(`fidelity[${i}].entries must be non-empty`);
    const entries = (entriesRaw as unknown[]).map((e, j) => {
      if (!isObject(e)) fail(`fidelity[${i}].entries[${j}] must be an object`);
      const eo = e as Record<string, unknown>;
      const entry: C6FixtureEntry = {
        path: str(eo, `fidelity[${i}].entries[${j}]`, "path"),
        mode: str(eo, `fidelity[${i}].entries[${j}]`, "mode"),
        oid: str(eo, `fidelity[${i}].entries[${j}]`, "oid"),
        size: nonNegInt(eo, `fidelity[${i}].entries[${j}]`, "size"),
      };
      if (!isFullOid(entry.oid, format)) fail(`fidelity[${i}].entries[${j}].oid is not a ${format} object id`);
      return entry;
    });
    const verification = fo["verification"];
    if (!isObject(verification)) fail(`fidelity[${i}].verification must be an object`);
    return {
      kind: kind as C6FixtureKind,
      owner: str(fo, `fidelity[${i}]`, "owner"),
      repo: str(fo, `fidelity[${i}]`, "repo"),
      branch: branch as string | null,
      sha,
      objectFormat: format,
      appliesTo,
      entries,
      verification: verification as Record<string, unknown>,
    };
  });
  const kinds = fidelity.map((f) => f.kind);
  for (const required of ["api-only-symlink", "clone-symlink", "non-utf8-content"] as const) {
    if (!kinds.includes(required)) fail(`missing fidelity fixture kind ${required}`);
  }
  return {
    pinnedAtIso: str(o, "", "pinnedAtIso"),
    pinnedByLogin: str(o, "", "pinnedByLogin"),
    performance,
    fidelity,
  };
}

export function loadCorpus(jsonText: string): Corpus {
  return parseCorpus(jsonText);
}

// The performance units in schedule shape (C6 is untimed and never scheduled here).
export function scheduleUnitsFrom(corpus: Corpus): ScheduleUnit[] {
  const out: ScheduleUnit[] = [];
  for (const slot of corpus.performance) {
    for (const u of slot.units) out.push({ unitId: u.unitId, repoKey: `${slot.owner}/${slot.repo}`, slot: slot.slot });
  }
  return out;
}

export function findUnit(corpus: Corpus, unitId: string): { slot: PerformanceSlot; unit: CorpusUnit } {
  for (const slot of corpus.performance) {
    for (const unit of slot.units) if (unit.unitId === unitId) return { slot, unit };
  }
  return fail(`unknown unit ${unitId}`);
}

// ---- slot-verification predicates (§4.2), pure over gathered evidence ------------------------
export interface SlotVerdict {
  ok: boolean;
  reasons: string[]; // empty when ok
  evidence: Record<string, unknown>; // recorded into corpus.json verbatim
}

// C1: ≥4 branch units; ≥80% shared BLOB oids between two of them. The ratio is
// |A∩B| / min(|A|,|B|) over blob oid sets — the sharing measure recorded in the evidence.
export function sharedBlobOidRatio(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const oid of setA) if (setB.has(oid)) shared++;
  return shared / Math.min(setA.size, setB.size);
}
export function verifyC1(unitBlobOids: ReadonlyMap<string, readonly string[]>): SlotVerdict {
  const reasons: string[] = [];
  const ids = [...unitBlobOids.keys()];
  if (ids.length < 4) reasons.push(`needs ≥4 branch units, got ${ids.length}`);
  let best: { a: string; b: string; ratio: number } | null = null;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const ratio = sharedBlobOidRatio(unitBlobOids.get(ids[i]!)!, unitBlobOids.get(ids[j]!)!);
      if (best === null || ratio > best.ratio) best = { a: ids[i]!, b: ids[j]!, ratio };
    }
  }
  if (best === null || best.ratio < 0.8)
    reasons.push(`no unit pair shares ≥80% blob oids (best ${best === null ? "n/a" : `${best.a}↔${best.b} at ${(best.ratio * 100).toFixed(1)}%`})`);
  return {
    ok: reasons.length === 0,
    reasons,
    evidence: {
      measure: "shared = |A∩B| / min(|A|,|B|) over blob oid sets",
      units: ids.length,
      bestPair: best === null ? null : { a: best.a, b: best.b, ratio: Number(best.ratio.toFixed(4)) },
    },
  };
}

// C2: 1k–3k files; JS/TS manifests present; REST tree truncated:false.
export function verifyC2(stats: { fileCount: number; truncated: boolean; manifestCount: number }): SlotVerdict {
  const reasons: string[] = [];
  if (stats.truncated) reasons.push("REST recursive tree is truncated");
  if (stats.fileCount < 1000 || stats.fileCount > 3000) reasons.push(`file count ${stats.fileCount} outside 1000..3000`);
  if (stats.manifestCount < 1) reasons.push("no package.json manifests located");
  return { ok: reasons.length === 0, reasons, evidence: { ...stats } };
}

// C3: path-heavy — a large deep tree whose enumeration cost is about MANY LONG PATHS, and
// truncated:false (else it is a C4, not a C3). Operationalisation — recalibrated at pinning
// against measured REST payloads: a fixed share-of-payload threshold is unreachable in the real
// wire format (each entry's `url` member alone carries ~100+ bytes and a second oid hex), so
// the predicate uses absolute path-heaviness instead: ≥20,000 entries, mean path length ≥ 55
// bytes, and ≥5,000 entries at directory depth ≥ 6. Measured calibration points (2026-07-28):
// kubernetes ~31.3k entries / mean ~67 B (passes); home-assistant/core mean ~47 B (fails);
// nixpkgs is REST-truncated (a C4 shape, fails here by design).
export function verifyC3(stats: { truncated: boolean; entryCount: number; pathByteSum: number; oidHexLength: number; deepEntryCount: number }): SlotVerdict {
  const reasons: string[] = [];
  const meanPathBytes = stats.entryCount === 0 ? 0 : stats.pathByteSum / stats.entryCount;
  if (stats.truncated) reasons.push("REST recursive tree is truncated — this candidate is a C4, not a C3");
  if (stats.entryCount < 20_000) reasons.push(`only ${stats.entryCount} entries (< 20000)`);
  if (meanPathBytes < 55) reasons.push(`mean path length ${meanPathBytes.toFixed(1)} B (< 55)`);
  if (stats.deepEntryCount < 5_000) reasons.push(`only ${stats.deepEntryCount} entries at depth ≥ 6 (< 5000)`);
  return { ok: reasons.length === 0, reasons, evidence: { ...stats, meanPathBytes: Number(meanPathBytes.toFixed(1)) } };
}

// C4: REST recursive tree truncated:true at the pinned SHA.
export function verifyC4(stats: { truncated: boolean }): SlotVerdict {
  return {
    ok: stats.truncated,
    reasons: stats.truncated ? [] : ["REST recursive tree is NOT truncated at the pinned SHA"],
    evidence: { ...stats },
  };
}

// C5: ≥1 SELECTED file whose checkout bytes differ between core.autocrlf=false and =true at the
// pinned SHA — the divergence the probe measures, not merely checkout-vs-blob (§4.2).
export function verifyC5(pairs: ReadonlyArray<{ path: string; sha256AutocrlfFalse: string; sha256AutocrlfTrue: string }>): SlotVerdict {
  const diverging = pairs.filter((p) => p.sha256AutocrlfFalse !== p.sha256AutocrlfTrue).map((p) => p.path);
  return {
    ok: diverging.length >= 1,
    reasons: diverging.length >= 1 ? [] : ["no selected file's checkout bytes differ between autocrlf=false and =true"],
    evidence: { comparedSelectedFiles: pairs.length, divergingPaths: diverging.slice(0, 20), divergingCount: diverging.length },
  };
}

// C6 clone fixture: the tree lists a mode-120000 SELECTED entry.
export function verifyC6Symlink(entries: ReadonlyArray<{ path: string; mode: string; selected: boolean }>): SlotVerdict {
  const hits = entries.filter((e) => e.mode === "120000" && e.selected).map((e) => e.path);
  return {
    ok: hits.length >= 1,
    reasons: hits.length >= 1 ? [] : ["no mode-120000 entry among the selected paths"],
    evidence: { symlinkSelectedPaths: hits.slice(0, 20) },
  };
}

// C6 non-UTF-8 fixture: the selected entry's bytes decode with replacement characters.
export function verifyC6NonUtf8(sample: { path: string; replacementCount: number }): SlotVerdict {
  return {
    ok: sample.replacementCount > 0,
    reasons: sample.replacementCount > 0 ? [] : [`${sample.path} decodes without replacement characters — not a non-UTF-8 fixture`],
    evidence: { ...sample },
  };
}
