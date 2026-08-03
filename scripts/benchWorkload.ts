// benchWorkload.ts — workload pinning + the route-expectation matrix (resolution plan §4.3).
// Pinning runs the REAL production selection (scanUnit + its helpers — reused, never
// reimplemented) under a RECORDING reader; the recorded read set plus the pipeline's no-read
// outcomes IS the workload. Ground truth is then typed per (entry, driver) over the COMPLETE
// route vocabulary: content routes carry an expected seam-string sha256 (the sha256 of the
// UTF-8 re-encoding of the string that route delivers — canonical blob bytes, REST-dereferenced
// bytes, or pinned baseline-config checkout bytes, whichever the route actually delivers);
// no-read routes carry verified non-acquisition. A delivered route outside the pinned permitted
// set is a G2 failure — no post-hoc relabeling.

import { createHash } from "node:crypto";
import { seamDecode } from "./gitFrame.ts";
import { scanUnit, type ReadFile, type TreeEntry, type UnitLocation } from "./unitPipeline.ts";
import { extractDependencyFacts, locateManifests, nearestLockfile, resolveOwningManifest, dirOf, type DependencyFact, type LockfileRef } from "./manifest.ts";
import { classifyFile } from "./cliScanner.ts";
import { makeExcluder } from "./unitPipeline.ts";
import { isFullOid, type BenchObjectFormat } from "./benchGrammar.ts";
import type { DriverId } from "./benchSchedule.ts";
import { DRIVERS } from "./benchSchedule.ts";

export class BenchWorkloadError extends Error {
  constructor(message: string) {
    super(`BENCH WORKLOAD: ${message}`);
    this.name = "BenchWorkloadError";
  }
}
const fail = (msg: string): never => {
  throw new BenchWorkloadError(msg);
};

// ---- seam semantics --------------------------------------------------------------------------
// The seam delivers STRINGS via UTF-8 replacement decode. Sourced from the production owner
// (gitFrame.ts, imported above) rather than re-implemented — T2c moved this into production —
// and re-exported so this module keeps its consumers' import path and its own internal uses.
export { seamDecode };
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
// sha256 of the delivered seam STRING (hashed as its UTF-8 re-encoding).
export function seamSha256(bytes: Uint8Array): string {
  return sha256Hex(Buffer.from(seamDecode(bytes), "utf8"));
}
export function seamStringSha256(delivered: string): string {
  return sha256Hex(Buffer.from(delivered, "utf8"));
}
export function countReplacementChars(bytes: Uint8Array): number {
  let n = 0;
  for (const ch of seamDecode(bytes)) if (ch === "�") n++;
  return n;
}

// ---- selection recording ---------------------------------------------------------------------
export type EntryClass = "manifest" | "lockfile" | "source" | "cli";
export type NoReadReason = "binary-lockfile-skip" | "size-gate-skip";

export interface RecordedSelection {
  // paths in FIRST-read order, deduplicated (production may legitimately read a path twice —
  // package.json as manifest then as CLI file; the workload entry is one, the metric side
  // counts requests)
  readPaths: string[];
  readCounts: Map<string, number>;
  classes: Map<string, EntryClass>;
  noReads: Array<{ path: string; reason: NoReadReason }>;
}

// mirror of unitPipeline.ts's gate inputs — SCANNABLE_EXT is module-local there; MAX_SCAN_BYTES is
// exported and CI-asserted against the frozen config (bench-config selection.maxScanBytes) — needed
// only to enumerate what the pipeline SKIPPED (it never calls the reader for those); the read
// set itself comes from the real pipeline, never from this mirror.
const SCANNABLE_EXT_MIRROR = /\.(mts|cts|ts|tsx|mjs|cjs|js|jsx)$/;

export interface RecordSelectionOptions {
  loc: UnitLocation;
  trackedPackages: string[];
  excludeDirGlobs: string[];
  maxScanBytes: number;
  entries: TreeEntry[];
  readFile: ReadFile; // the status-quo reader pinning supplies (REST for complete trees, checkout for C4)
}

// Run the PRODUCTION selection under a recording reader. The workload is exactly what the
// pipeline read, plus its two no-read outcomes: the elected-but-never-read binary lockfile
// (manifest.ts:172 / unitPipeline.ts:142) and the 2 MiB source/CLI size gate.
export async function recordSelection(opts: RecordSelectionOptions): Promise<RecordedSelection> {
  const readCounts = new Map<string, number>();
  const readPaths: string[] = [];
  const texts = new Map<string, string | null>();
  const recorder: ReadFile = async (path, entry) => {
    const n = readCounts.get(path) ?? 0;
    readCounts.set(path, n + 1);
    if (n === 0) readPaths.push(path);
    const text = await opts.readFile(path, entry);
    if (!texts.has(path)) texts.set(path, text);
    return text;
  };
  await scanUnit(
    opts.loc,
    { trackedPackages: opts.trackedPackages, excludeDirGlobs: opts.excludeDirGlobs },
    opts.entries,
    recorder,
    [], // CLI term sets empty: CLI-kind READS still happen (unitPipeline reads before scanning)
  );

  const isExcluded = makeExcluder(opts.excludeDirGlobs);
  const blobs = opts.entries.filter((e) => e.type === "blob");
  const { manifests, lockfiles } = locateManifests(blobs.map((e) => e.path), isExcluded);
  const manifestSet = new Set(manifests);
  const lockfileByPath = new Map(lockfiles.map((l) => [l.path, l]));

  const classes = new Map<string, EntryClass>();
  for (const path of readPaths) {
    if (manifestSet.has(path)) classes.set(path, "manifest");
    else if (lockfileByPath.has(path)) classes.set(path, "lockfile");
    else if (classifyFile(path) !== "other") classes.set(path, "cli");
    else classes.set(path, "source");
  }

  // no-read outcome (a): elected binary lockfiles — nearestLockfile elects them, resolution
  // proceeds on the binary flag, and the reader is never called (the bench must prove
  // NON-acquisition for these, §4.3).
  const factsByManifestDir = new Map<string, { manifestPath: string; facts: DependencyFact[] }>();
  for (const mPath of manifests) {
    const text = texts.get(mPath);
    if (text === undefined || text === null) continue;
    let facts: DependencyFact[];
    try {
      facts = extractDependencyFacts(text, opts.trackedPackages);
    } catch {
      continue; // the production pipeline ignores malformed manifests the same way
    }
    factsByManifestDir.set(dirOf(mPath), { manifestPath: mPath, facts });
  }
  const noReads: Array<{ path: string; reason: NoReadReason }> = [];
  const noReadSeen = new Set<string>();
  const electBinary = (lf: LockfileRef | null): void => {
    if (lf !== null && lf.binary && !noReadSeen.has(lf.path)) {
      noReadSeen.add(lf.path);
      noReads.push({ path: lf.path, reason: "binary-lockfile-skip" });
    }
  };
  for (const { manifestPath, facts } of factsByManifestDir.values()) {
    if (facts.length === 0) continue;
    electBinary(nearestLockfile(manifestPath, lockfiles));
  }

  // no-read outcome (b): the source/CLI 2 MiB gate (unitPipeline skips BEFORE reading; mirror
  // documented above). Source files count only when the tracked-package set resolves for them —
  // resolveOwningManifest/installNameSet are the production helpers.
  const tracksResolve = (filePath: string): boolean =>
    opts.trackedPackages.some((name) => {
      const owning = resolveOwningManifest(filePath, factsByManifestDir, name);
      return owning !== null && owning.installNames.size > 0;
    });
  for (const entry of blobs) {
    if (isExcluded(entry.path) || /(^|\/)node_modules\//.test(entry.path)) continue;
    if (entry.size === null || entry.size <= opts.maxScanBytes) continue;
    const isCli = classifyFile(entry.path) !== "other";
    const isSource = SCANNABLE_EXT_MIRROR.test(entry.path) && tracksResolve(entry.path);
    if ((isCli || isSource) && !noReadSeen.has(entry.path)) {
      noReadSeen.add(entry.path);
      noReads.push({ path: entry.path, reason: "size-gate-skip" });
    }
  }
  return { readPaths, readCounts, classes, noReads };
}

// ---- the route vocabulary and expectation matrix ---------------------------------------------
export const ROUTE_IDS = [
  "primary", "symlink-fallback", "binary-fallback", "truncated-blob-fallback",
  "content-cap-singleton", "missing-alias-fallback", "batch-error-fallback",
  "validation-fallback", "timeout-singleton", "api-escape",
  "binary-lockfile-skip", "size-gate-skip", "truncated-tree-checkout",
] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

export type RouteExpectedContent = { seamSha256: string } | { nonAcquisition: true };
export interface RouteExpectation {
  primary: RouteId;
  declaredCaveat: boolean; // only truncated-tree-checkout for T0/T1 (§4.3/§4.7 G1)
  permittedFallbacks: RouteId[];
  expected: Partial<Record<RouteId, RouteExpectedContent>>;
}

export interface WorkloadEntry {
  path: string;
  mode: string; // ls-tree mode at the pinned SHA (authoritative; REST drops it)
  blobOid: string;
  size: number; // canonical object size
  class: EntryClass;
  read: boolean;
  noReadReason: NoReadReason | null;
  canonicalSeamSha256: string | null; // seam hash of the canonical blob bytes
  rawSha256: string | null; // sha256 of the raw canonical bytes (report convenience; oid is the canonical check)
  restDerefSeamSha256: string | null; // symlinks: the REST-dereferenced delivery, measured at pinning
  checkoutSeamSha256: string | null; // pinned autocrlf=false checkout delivery, measured where a route needs it
  gql: { isBinary: boolean; isTruncated: boolean; textNull: boolean } | null; // GitHub's own judgment, measured at pinning
}

export interface UnitContext {
  truncatedTree: boolean; // C4: the REST recursive tree is truncated at the pinned SHA
  escapeTripped: boolean; // T2a's size-based api-escape (pinned repoSizeKb > threshold), §4.4
  batchContentBytesCap: number; // T1's per-batch content cap — a lone entry above it is content-cap-singleton
}

const T1_OPERATIONAL_FALLBACKS: RouteId[] = [
  "batch-error-fallback", "validation-fallback", "timeout-singleton", "missing-alias-fallback",
];

function need(value: string | null, what: string, path: string): string {
  if (value === null) fail(`${what} missing for ${path} (pinning must measure it before routes derive)`);
  return value as string;
}

// Derive one entry's per-driver route expectations from its pinned facts. PURE — CI re-derives
// the committed matrix from the committed facts and rejects drift.
export function deriveRoutes(entry: WorkloadEntry, ctx: UnitContext): Record<DriverId, RouteExpectation> {
  const out: Partial<Record<DriverId, RouteExpectation>> = {};
  if (!entry.read) {
    const reason = entry.noReadReason ?? fail(`unread entry ${entry.path} carries no noReadReason`);
    for (const d of DRIVERS) {
      out[d] = { primary: reason, declaredCaveat: false, permittedFallbacks: [], expected: { [reason]: { nonAcquisition: true } } };
    }
    return out as Record<DriverId, RouteExpectation>;
  }
  const isSymlink = entry.mode === "120000";
  const canonical = (): RouteExpectedContent => ({ seamSha256: need(entry.canonicalSeamSha256, "canonicalSeamSha256", entry.path) });
  const deref = (): RouteExpectedContent => ({ seamSha256: need(entry.restDerefSeamSha256, "restDerefSeamSha256", entry.path) });
  const checkout = (): RouteExpectedContent => ({ seamSha256: need(entry.checkoutSeamSha256, "checkoutSeamSha256", entry.path) });
  const t0Delivery = isSymlink ? deref : canonical; // status quo: REST contents, dereferenced for links

  // C4 (truncated tree): T0/T1 take the production checkout-clone fallback for EVERY read —
  // the declared-caveat route (§4.3); T2a's primary is checkout everywhere anyway; T2c
  // enumerates locally and never sees the cliff.
  const t0: RouteExpectation = ctx.truncatedTree
    ? { primary: "truncated-tree-checkout", declaredCaveat: true, permittedFallbacks: [], expected: { "truncated-tree-checkout": checkout() } }
    : { primary: "primary", declaredCaveat: false, permittedFallbacks: [], expected: { primary: t0Delivery() } };

  let t1: RouteExpectation;
  if (ctx.truncatedTree) {
    t1 = { primary: "truncated-tree-checkout", declaredCaveat: true, permittedFallbacks: [], expected: { "truncated-tree-checkout": checkout() } };
  } else if (isSymlink) {
    t1 = { primary: "symlink-fallback", declaredCaveat: false, permittedFallbacks: [], expected: { "symlink-fallback": deref() } };
  } else if (entry.size > ctx.batchContentBytesCap) {
    // MUST precede the pinned GraphQL facts: planRounds pre-routes over-cap entries by SIZE
    // alone (the tree knows it; the entry never enters a batch), so GitHub's isBinary/
    // isTruncated judgment is never observed for them at matrix time. Checking the gql facts
    // first pinned a route the driver could not deliver — a G2 failure by construction for any
    // over-cap entry GitHub also judges binary or truncated. (No committed workload carries an
    // over-cap read entry, so this reorder re-derives every committed matrix unchanged.)
    t1 = { primary: "content-cap-singleton", declaredCaveat: false, permittedFallbacks: [], expected: { "content-cap-singleton": canonical() } };
  } else {
    const gql = entry.gql ?? fail(`gql facts missing for ${entry.path} (pinning must probe GitHub's own judgment)`);
    // isTruncated FIRST, matching the runtime's validateAlias precedence exactly (benchT1.ts):
    // if GitHub ever reports a blob both truncated and binary/text-null, the driver delivers
    // truncated-blob-fallback — pinning the other label would manufacture a permanent G2
    // mismatch out of route-name disagreement over identical REST-fallback bytes. (No committed
    // workload carries the conflicting state, so every committed matrix re-derives unchanged.)
    if (gql.isTruncated) {
      // batched like any entry (the state is response-DISCOVERED), so every operational T1
      // outcome remains possible: an alias whose response fails validation, times out
      // unsplittably, goes missing, or drains with its batch must still deliver via the
      // counted REST lane — an empty permitted set converted such recoveries into G2 failures
      const expected: RouteExpectation["expected"] = { "truncated-blob-fallback": canonical() };
      for (const r of T1_OPERATIONAL_FALLBACKS) expected[r] = canonical();
      t1 = { primary: "truncated-blob-fallback", declaredCaveat: false, permittedFallbacks: [...T1_OPERATIONAL_FALLBACKS], expected };
    } else if (gql.isBinary || gql.textNull) {
      const expected: RouteExpectation["expected"] = { "binary-fallback": canonical() };
      for (const r of T1_OPERATIONAL_FALLBACKS) expected[r] = canonical();
      t1 = { primary: "binary-fallback", declaredCaveat: false, permittedFallbacks: [...T1_OPERATIONAL_FALLBACKS], expected };
    } else {
      const expected: RouteExpectation["expected"] = { primary: canonical() };
      for (const r of T1_OPERATIONAL_FALLBACKS) expected[r] = canonical();
      t1 = { primary: "primary", declaredCaveat: false, permittedFallbacks: [...T1_OPERATIONAL_FALLBACKS], expected };
    }
  }

  // T2a: checkout reads are the PRIMARY route (no caveat shelter, §4.3); the pinned api-escape
  // routes the whole unit to T0 semantics — except on truncated trees, which clone regardless
  // (the oversized-and-truncated hole is exhibited, §4.4).
  let t2a: RouteExpectation;
  if (ctx.escapeTripped && !ctx.truncatedTree) {
    t2a = { primary: "api-escape", declaredCaveat: false, permittedFallbacks: [], expected: { "api-escape": t0Delivery() } };
  } else if (isSymlink) {
    t2a = { primary: "symlink-fallback", declaredCaveat: false, permittedFallbacks: [], expected: { "symlink-fallback": deref() } };
  } else {
    t2a = { primary: "primary", declaredCaveat: false, permittedFallbacks: [], expected: { primary: checkout() } };
  }

  const t2c: RouteExpectation = isSymlink
    ? { primary: "symlink-fallback", declaredCaveat: false, permittedFallbacks: [], expected: { "symlink-fallback": deref() } }
    : { primary: "primary", declaredCaveat: false, permittedFallbacks: [], expected: { primary: canonical() } };

  out.T0 = t0;
  out.T1 = t1;
  out.T2a = t2a;
  out.T2c = t2c;
  return out as Record<DriverId, RouteExpectation>;
}

// ---- selected/*.json (de)serialisation -------------------------------------------------------
export interface UnitWorkload {
  unit: string;
  sha: string;
  treeOid: string;
  objectFormat: BenchObjectFormat;
  generatedAtIso: string;
  truncatedTree: boolean;
  escapeTripped: boolean;
  batchContentBytesCap: number;
  entries: WorkloadEntry[];
  routes: Record<string, Record<DriverId, RouteExpectation>>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseUnitWorkload(jsonText: string): UnitWorkload {
  let root: unknown;
  try {
    root = JSON.parse(jsonText);
  } catch {
    fail("workload json is not valid JSON");
  }
  if (!isObject(root)) fail("workload root must be an object");
  const o = root as Record<string, unknown>;
  const req = (key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || v.length === 0) fail(`${key} must be a non-empty string`);
    return v as string;
  };
  const formatRaw = req("objectFormat");
  const format: BenchObjectFormat = formatRaw === "sha1" || formatRaw === "sha256" ? formatRaw : fail("objectFormat must be sha1 or sha256");
  const entriesRaw = o["entries"];
  if (!Array.isArray(entriesRaw)) fail("entries must be an array");
  const optStr = (eo: Record<string, unknown>, key: string, path: string): string | null => {
    const v = eo[key];
    if (v === null) return null;
    // these fields are GROUND-TRUTH sha256 hashes: any non-hash string would make correct
    // delivered bytes mismatch and permanently disqualify a driver over a malformed artifact
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) fail(`${path}.${key} must be a 64-hex sha256 or null`);
    return v as string;
  };
  const seenPaths = new Set<string>();
  const entries: WorkloadEntry[] = (entriesRaw as unknown[]).map((e, i) => {
    if (!isObject(e)) fail(`entries[${i}] must be an object`);
    const eo = e as Record<string, unknown>;
    const path = `entries[${i}]`;
    const clsRaw = eo["class"];
    const cls: EntryClass =
      clsRaw === "manifest" || clsRaw === "lockfile" || clsRaw === "source" || clsRaw === "cli"
        ? clsRaw
        : fail(`${path}.class unknown`);
    const read = eo["read"];
    if (typeof read !== "boolean") return fail(`${path}.read must be a boolean`);
    const noReadReason = eo["noReadReason"];
    if (noReadReason !== null && noReadReason !== "binary-lockfile-skip" && noReadReason !== "size-gate-skip")
      fail(`${path}.noReadReason invalid`);
    const size = eo["size"];
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return fail(`${path}.size must be a nonnegative safe integer`);
    const gqlRaw = eo["gql"];
    let gql: WorkloadEntry["gql"] = null;
    if (gqlRaw !== null) {
      if (!isObject(gqlRaw)) return fail(`${path}.gql must be an object or null`);
      const g = gqlRaw as Record<string, unknown>;
      for (const k of ["isBinary", "isTruncated", "textNull"]) if (typeof g[k] !== "boolean") fail(`${path}.gql.${k} must be a boolean`);
      gql = { isBinary: g["isBinary"] as boolean, isTruncated: g["isTruncated"] as boolean, textNull: g["textNull"] as boolean };
    }
    const entry: WorkloadEntry = {
      path: (() => {
        const p = eo["path"];
        if (typeof p !== "string" || p.length === 0) return fail(`${path}.path must be a non-empty string`);
        return p;
      })(),
      mode: (() => {
        const m = eo["mode"];
        if (typeof m !== "string" || !/^\d{6}$/.test(m)) return fail(`${path}.mode must be a 6-digit mode`);
        return m;
      })(),
      blobOid: (() => {
        const b = eo["blobOid"];
        if (typeof b !== "string" || !isFullOid(b, format)) return fail(`${path}.blobOid must be a full ${format} oid`);
        return b;
      })(),
      size,
      class: cls,
      read,
      noReadReason: noReadReason as NoReadReason | null,
      canonicalSeamSha256: optStr(eo, "canonicalSeamSha256", path),
      rawSha256: optStr(eo, "rawSha256", path),
      restDerefSeamSha256: optStr(eo, "restDerefSeamSha256", path),
      checkoutSeamSha256: optStr(eo, "checkoutSeamSha256", path),
      gql,
    };
    if (seenPaths.has(entry.path)) fail(`duplicate workload entry ${entry.path}`);
    seenPaths.add(entry.path);
    if (entry.read === (entry.noReadReason !== null)) fail(`${path}: read/noReadReason incoherent for ${entry.path}`);
    return entry;
  });
  const truncatedTree = o["truncatedTree"];
  const escapeTripped = o["escapeTripped"];
  if (typeof truncatedTree !== "boolean" || typeof escapeTripped !== "boolean")
    return fail("truncatedTree/escapeTripped must be booleans");
  const cap = o["batchContentBytesCap"];
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1) return fail("batchContentBytesCap must be a positive safe integer");
  const routesRaw = o["routes"];
  if (!isObject(routesRaw)) return fail("routes must be an object");
  const workload: UnitWorkload = {
    unit: req("unit"),
    sha: req("sha"),
    treeOid: req("treeOid"),
    objectFormat: format,
    generatedAtIso: req("generatedAtIso"),
    truncatedTree,
    escapeTripped,
    batchContentBytesCap: cap,
    entries,
    routes: routesRaw as unknown as Record<string, Record<DriverId, RouteExpectation>>,
  };
  // committed-matrix integrity: the routes member must equal the pure re-derivation from the
  // committed facts — the matrix cannot drift from its own inputs.
  const ctx: UnitContext = { truncatedTree, escapeTripped, batchContentBytesCap: cap };
  for (const entry of entries) {
    const committed = workload.routes[entry.path];
    if (committed === undefined) return fail(`routes missing for ${entry.path}`);
    const derived = deriveRoutes(entry, ctx);
    if (JSON.stringify(committed) !== JSON.stringify(derived))
      fail(`routes for ${entry.path} do not re-derive from the committed facts (ground-truth drift)`);
  }
  for (const path of Object.keys(workload.routes)) {
    if (!seenPaths.has(path)) fail(`routes carries unknown path ${path}`);
  }
  return workload;
}

export function buildUnitWorkload(base: Omit<UnitWorkload, "routes">): UnitWorkload {
  const ctx: UnitContext = {
    truncatedTree: base.truncatedTree,
    escapeTripped: base.escapeTripped,
    batchContentBytesCap: base.batchContentBytesCap,
  };
  const routes: UnitWorkload["routes"] = {};
  for (const entry of base.entries) routes[entry.path] = deriveRoutes(entry, ctx);
  return { ...base, routes };
}
