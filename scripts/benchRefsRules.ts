// benchRefsRules.ts — ADR-0002 Confirmation-1: the refs probe's PRE-REGISTERED rule executor.
// Pure functions over recorded tries — no client, no clock, no IO — so every gate, reducer,
// invalidation rule, and the selection rule are committed and reviewed BEFORE any measured try
// (a rule written after the data is not a pre-registration). The runner (benchRefsProbe.ts)
// dispatches and records; everything here is re-derivable from the journal forever.
//
// Sources of truth, in order: ADR-0002 "Confirmation" check 1 (the rule text), then the plan's
// §5 P1. Artifact schemas (corpus, journal row, result) live here as TypeScript types.

import { MAX_PAGES } from "./github.ts";
import { isIsoInstant } from "./isoDate.ts";

export class BenchRefsRulesError extends Error {
  constructor(message: string) {
    super(`BENCH REFS RULES: ${message}`);
    this.name = "BenchRefsRulesError";
  }
}

// ---- pre-registered constants (the rule's frozen parameters) ---------------------------------
export type RefsStratum = "p1" | "p2";

export const REFS_PROBE_CANDIDATE_BATCH_SIZES: readonly number[] = [10, 25];
export const REFS_PROBE_INFORMATIONAL_BATCH_SIZES: readonly number[] = [50];
export const REFS_PROBE_ALL_BATCH_SIZES: readonly number[] = [10, 25, 50];
export const REFS_PROBE_STRATA: readonly RefsStratum[] = ["p1", "p2"];
export const REFS_PROBE_TRIES_PER_CELL = 5;
// invalidation re-runs permitted per cell; one more (a third) commits the cell `invalid`
export const REFS_PROBE_INVALIDATION_RERUN_CAP = 2;
export const REFS_PROBE_WALL_GATE_MS = 5_000;
export const REFS_PROBE_PAIR_COST_GATE_MAX = 0.5;
// admission's conservative per-attempt point bound: the absolute gate tolerates 2 × the
// formula's 1-point batch pricing, and every dispatch shape in this matrix (batch at B ≤ 100,
// solo page) prices at 1 under the published formula — so 2 covers the tolerated worst.
export const REFS_PROBE_POINT_BOUND_PER_ATTEMPT = 2;
// github.com's documented primary window for user/PAT credentials (the probe's deployment
// premise; recorded in the artifact so a different tier is visibly a different premise)
export const REFS_PROBE_BUCKET_LIMIT_POINTS = 5_000;
// the production window's age-cap default (ADR design): the informational
// would-have-tripped-the-production-stop flag fires when a try's continuation phase exceeds
// half of this.
export const REFS_PROBE_AGE_CAP_MS = 10 * 60 * 1_000;
// the ship threshold: the corrected 8 × 750 estate page-1 floor must stay under 10% of one window
export const REFS_PROBE_SHIP_THRESHOLD_POINTS = 500;
export const REFS_PROBE_ESTATE_8X750_REPOS = 6_000;

// the absolute gate: ≤ 2 × max(1, round(B/100)) points per batch, both strata
export function absoluteGatePointsPerBatch(batchSize: number): number {
  return 2 * Math.max(1, Math.round(batchSize / 100));
}

// presentation rounding at micro-point precision: reducers are ratios, and IEEE754 products
// like 0.04 × 6000 must not leak a 240.00000000000003 into a committed artifact
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

// ---- probe-authored query documents ----------------------------------------------------------
// The solo walk document, transcribed from the production listBranchHeads query (github.ts) the
// way benchGh transcribes restGet: the probe's continuation and control dispatches must price
// the query production actually sends. A drift test pins this literal against the production
// module's source text.
export const SOLO_REFS_QUERY =
  "query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){defaultBranchRef{name}refs(refPrefix:\"refs/heads/\",first:100,after:$endCursor){pageInfo{hasNextPage endCursor}nodes{name target{...on Commit{oid committedDate tree{oid}}}}}}}";

// the probe's rider (per-call cost visibility, the boundary probe's per-call method)
export const REFS_PROBE_RATE_LIMIT_RIDER = "rateLimit{cost}";

// solo document + rider at the query root — the shape both probe arms dispatch for solo pages.
// Same insertion rule as buildBatchRefsQuery's rider so rider-on ≡ rider-off modulo the field.
export function buildProbeSoloQuery(rider: string): string {
  if (rider === "") return SOLO_REFS_QUERY;
  return `${SOLO_REFS_QUERY.slice(0, -1)} ${rider}}`;
}

// ---- shared shape helpers --------------------------------------------------------------------
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// sha1 (40) or sha256 (64) hex object ids — the production battery's rule, transcribed
const HEX_OBJECT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// ---- corpus schema + validation --------------------------------------------------------------
export interface RefsCorpusRepo {
  owner: string;
  name: string;
  frozenPages: number; // the invalidation baseline and the admission input
  frozenHeads: number; // informational
}

export interface RefsCorpusCell {
  batchSize: number;
  stratum: RefsStratum;
  feasible: boolean; // false = the stratum cannot furnish a full batch (committed infeasible)
  infeasibleCause: string | null;
  repos: RefsCorpusRepo[]; // kept order — the fixed corpus every try of this cell walks
}

export interface RefsProbeCorpus {
  version: 1;
  frozenAtIso: string;
  login: string;
  provenance: string; // the external operator construction procedure, verbatim
  cells: RefsCorpusCell[];
}

const repoKey = (owner: string, name: string): string => JSON.stringify([owner.toLowerCase(), name.toLowerCase()]);

export function parseRefsProbeCorpus(jsonText: string): RefsProbeCorpus {
  let root: unknown;
  try {
    root = JSON.parse(jsonText);
  } catch {
    throw new BenchRefsRulesError("corpus is not valid JSON");
  }
  if (!isObject(root)) throw new BenchRefsRulesError("corpus root is not an object");
  if (root["version"] !== 1) throw new BenchRefsRulesError("corpus version must be 1");
  const frozenAtIso = root["frozenAtIso"];
  if (!isNonEmptyString(frozenAtIso) || !isIsoInstant(frozenAtIso))
    throw new BenchRefsRulesError("corpus frozenAtIso must be an ISO instant");
  const login = root["login"];
  if (!isNonEmptyString(login)) throw new BenchRefsRulesError("corpus login must be a non-empty string");
  const provenance = root["provenance"];
  if (!isNonEmptyString(provenance)) throw new BenchRefsRulesError("corpus provenance must be a non-empty string");
  const cellsRaw = root["cells"];
  if (!Array.isArray(cellsRaw)) throw new BenchRefsRulesError("corpus cells must be an array");

  const cells: RefsCorpusCell[] = cellsRaw.map((raw, i) => {
    if (!isObject(raw)) throw new BenchRefsRulesError(`cell ${i} is not an object`);
    const batchSize = raw["batchSize"];
    if (typeof batchSize !== "number" || !REFS_PROBE_ALL_BATCH_SIZES.includes(batchSize))
      throw new BenchRefsRulesError(`cell ${i} batchSize must be one of ${REFS_PROBE_ALL_BATCH_SIZES.join("/")}`);
    const stratum = raw["stratum"];
    if (stratum !== "p1" && stratum !== "p2") throw new BenchRefsRulesError(`cell ${i} stratum must be p1 or p2`);
    const feasible = raw["feasible"];
    if (typeof feasible !== "boolean") throw new BenchRefsRulesError(`cell ${i} feasible must be a boolean`);
    const infeasibleCause = raw["infeasibleCause"];
    const reposRaw = raw["repos"];
    if (!Array.isArray(reposRaw)) throw new BenchRefsRulesError(`cell ${i} repos must be an array`);
    if (!feasible) {
      if (!isNonEmptyString(infeasibleCause))
        throw new BenchRefsRulesError(`cell ${i} is infeasible but carries no cause`);
      if (reposRaw.length !== 0)
        throw new BenchRefsRulesError(`cell ${i} is infeasible but carries repos`);
      return { batchSize, stratum, feasible, infeasibleCause, repos: [] };
    }
    if (infeasibleCause !== null) throw new BenchRefsRulesError(`cell ${i} is feasible but carries an infeasibleCause`);
    if (reposRaw.length === 0) throw new BenchRefsRulesError(`cell ${i} is feasible but carries no repos`);
    const seen = new Set<string>();
    const repos: RefsCorpusRepo[] = reposRaw.map((r, j) => {
      if (!isObject(r)) throw new BenchRefsRulesError(`cell ${i} repo ${j} is not an object`);
      const owner = r["owner"];
      const name = r["name"];
      if (!isNonEmptyString(owner)) throw new BenchRefsRulesError(`cell ${i} repo ${j} owner must be non-empty`);
      if (!isNonEmptyString(name)) throw new BenchRefsRulesError(`cell ${i} repo ${j} name must be non-empty`);
      const frozenPages = r["frozenPages"];
      if (!isCount(frozenPages) || frozenPages < 1)
        throw new BenchRefsRulesError(`cell ${i} repo ${j} frozenPages must be a positive integer`);
      const frozenHeads = r["frozenHeads"];
      if (!isCount(frozenHeads)) throw new BenchRefsRulesError(`cell ${i} repo ${j} frozenHeads must be a nonnegative integer`);
      if (stratum === "p1" && frozenPages !== 1)
        throw new BenchRefsRulesError(`cell ${i} (p1) repo ${owner}/${name} has frozenPages ${frozenPages} — the p1 stratum is single-page`);
      if (stratum === "p2" && frozenPages < 2)
        throw new BenchRefsRulesError(`cell ${i} (p2) repo ${owner}/${name} has frozenPages ${frozenPages} — the p2 stratum paginates`);
      // the strata are DEFINED on heads (> 100 paginates; exactly 100 is one page), and the
      // frozen page count must agree with the frozen head count — a disagreement would make
      // the invalidation baseline internally inconsistent before any try runs
      if (stratum === "p1" && frozenHeads > 100)
        throw new BenchRefsRulesError(`cell ${i} (p1) repo ${owner}/${name} has ${frozenHeads} heads — the p1 stratum is at most 100`);
      if (stratum === "p2" && frozenHeads <= 100)
        throw new BenchRefsRulesError(`cell ${i} (p2) repo ${owner}/${name} has ${frozenHeads} heads — the p2 stratum needs more than 100`);
      const expectedPages = Math.ceil(Math.max(frozenHeads, 1) / 100);
      if (expectedPages !== frozenPages)
        throw new BenchRefsRulesError(`cell ${i} repo ${owner}/${name}: frozenPages ${frozenPages} disagrees with frozenHeads ${frozenHeads} (${expectedPages} pages expected)`);
      const key = repoKey(owner, name);
      if (seen.has(key)) throw new BenchRefsRulesError(`cell ${i} carries duplicate repo ${owner}/${name}`);
      seen.add(key);
      return { owner, name, frozenPages, frozenHeads };
    });
    // every tested batch size must be exercised by at least one FULL same-owner batch of
    // exactly B repositories (the ADR's corpus rule — a two-repository corpus cannot call
    // itself B = 25)
    if (!planOwnerChunks(repos, batchSize).some((c) => c.length === batchSize))
      throw new BenchRefsRulesError(
        `cell ${i} (B=${batchSize}, ${stratum}) furnishes no full same-owner batch of exactly ${batchSize} repositories`,
      );
    return { batchSize, stratum, feasible, infeasibleCause: null, repos };
  });

  // all six cells, each exactly once
  for (const b of REFS_PROBE_ALL_BATCH_SIZES) {
    for (const s of REFS_PROBE_STRATA) {
      const n = cells.filter((c) => c.batchSize === b && c.stratum === s).length;
      if (n !== 1) throw new BenchRefsRulesError(`corpus must carry exactly one (B=${b}, ${s}) cell, found ${n}`);
    }
  }
  return { version: 1, frozenAtIso, login, provenance, cells };
}

// per-owner kept-order chunks of ≤ B — the candidate arm's batch plan (owners grouped by first
// appearance, case-insensitively; within an owner, kept order)
export function planOwnerChunks(repos: readonly RefsCorpusRepo[], batchSize: number): RefsCorpusRepo[][] {
  if (batchSize < 1 || !Number.isSafeInteger(batchSize)) throw new BenchRefsRulesError(`batchSize ${batchSize} is not a positive integer`);
  const byOwner = new Map<string, RefsCorpusRepo[]>();
  for (const r of repos) {
    const key = r.owner.toLowerCase();
    const list = byOwner.get(key);
    if (list === undefined) byOwner.set(key, [r]);
    else list.push(r);
  }
  const chunks: RefsCorpusRepo[][] = [];
  for (const list of byOwner.values()) {
    for (let i = 0; i < list.length; i += batchSize) chunks.push(list.slice(i, i + batchSize));
  }
  return chunks;
}

// ---- the walk battery (pure transcription of the production validation) ----------------------
// Input: one repository-shaped object per observed page (the batched alias object for a
// candidate page 1 — its extra nameWithOwner key is inert here — and data.repository for solo
// pages). Applies the full fail-closed battery: per-page default re-assertion, node shape,
// duplicate names, cursor discipline, completeness, and end-of-walk coherence. An incomplete
// walk (hasNextPage still true on the last observed page — the frozen-depth bounded stop) is
// NOT a battery failure: it is the caller's page-count-drift evidence, and end-of-walk
// coherence is skipped because the default may live on an unseen page.
export type RefsWalkResult =
  | { ok: true; pages: number; complete: boolean; headCount: number; defaultBranch: string | null }
  | { ok: false; failure: string };

const fail = (failure: string): RefsWalkResult => ({ ok: false, failure });

export function assembleRefsWalk(pages: readonly unknown[]): RefsWalkResult {
  if (pages.length === 0) throw new BenchRefsRulesError("assembleRefsWalk needs at least one page");
  if (pages.length > MAX_PAGES) return fail(`refs pagination exceeded ${MAX_PAGES} pages`);
  let defaultBranch: string | null | undefined = undefined;
  const seenNames = new Set<string>();
  const seenCursors = new Set<string>();
  let headCount = 0;
  let complete = false;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (!isObject(p)) return fail(`page ${i + 1} is not a repository object`);
    if (!Object.hasOwn(p, "defaultBranchRef")) return fail(`page ${i + 1} omits defaultBranchRef`);
    const ref = p["defaultBranchRef"];
    let pageDefault: string | null;
    if (ref === null) pageDefault = null;
    else if (isObject(ref) && isNonEmptyString(ref["name"])) pageDefault = ref["name"] as string;
    else return fail(`malformed defaultBranchRef on page ${i + 1}`);
    if (defaultBranch === undefined) defaultBranch = pageDefault;
    else if (defaultBranch !== pageDefault)
      return fail(`defaultBranchRef changed mid-pagination (${JSON.stringify(defaultBranch)} to ${JSON.stringify(pageDefault)})`);
    const refs = p["refs"];
    if (!isObject(refs)) return fail(`page ${i + 1} carries no refs object`);
    const nodes = refs["nodes"];
    if (!Array.isArray(nodes)) return fail(`page ${i + 1} missing a nodes array`);
    for (const nodeRaw of nodes) {
      if (!isObject(nodeRaw)) return fail(`malformed branch-head node on page ${i + 1}`);
      const n = nodeRaw as { name?: unknown; target?: { oid?: unknown; committedDate?: unknown; tree?: { oid?: unknown } } };
      if (
        !isNonEmptyString(n.name) ||
        typeof n.target?.oid !== "string" || !HEX_OBJECT_ID_RE.test(n.target.oid) ||
        typeof n.target.committedDate !== "string" || n.target.committedDate.length === 0 ||
        typeof n.target.tree?.oid !== "string" || !HEX_OBJECT_ID_RE.test(n.target.tree.oid)
      )
        return fail(`malformed branch-head node on page ${i + 1}`);
      if (!isIsoInstant(n.target.committedDate))
        return fail(`branch ${JSON.stringify(n.name)} has a non-ISO committedDate`);
      if (seenNames.has(n.name)) return fail(`duplicate branch ${JSON.stringify(n.name)} across pages`);
      seenNames.add(n.name);
      headCount++;
    }
    const pageInfo = refs["pageInfo"];
    const hasNextPage = isObject(pageInfo) ? pageInfo["hasNextPage"] : undefined;
    if (typeof hasNextPage !== "boolean") return fail(`refs pageInfo.hasNextPage missing/non-boolean on page ${i + 1}`);
    if (!hasNextPage) {
      if (i !== pages.length - 1) return fail(`pages recorded past a hasNextPage:false page (${i + 1})`);
      complete = true;
    } else {
      const next = isObject(pageInfo) ? pageInfo["endCursor"] : undefined;
      if (!isNonEmptyString(next)) return fail(`hasNextPage=true but no follow-up endCursor on page ${i + 1}`);
      if (seenCursors.has(next)) return fail(`refs pagination cursor cycle on page ${i + 1}`);
      seenCursors.add(next);
    }
  }
  if (defaultBranch === undefined) return fail("internal: defaultBranchRef unresolved");
  if (complete) {
    if (defaultBranch !== null && !seenNames.has(defaultBranch))
      return fail(`defaultBranchRef ${JSON.stringify(defaultBranch)} is absent from the discovered heads`);
    if (defaultBranch === null && headCount > 0)
      return fail(`defaultBranchRef is null but ${headCount} head(s) were discovered`);
  }
  return { ok: true, pages: pages.length, complete, headCount, defaultBranch };
}

// identity re-assertion for a batched alias (case-insensitive, the REST lane's rule): a swapped
// variable or alias mapping must fail closed, never attach a snapshot to the wrong repository
export function checkAliasIdentity(aliasValue: unknown, expectedOwner: string, expectedName: string): string | null {
  if (!isObject(aliasValue)) return "alias value is not an object";
  const nwo = aliasValue["nameWithOwner"];
  if (!isNonEmptyString(nwo)) return "alias nameWithOwner missing or malformed";
  if (nwo.toLowerCase() !== `${expectedOwner}/${expectedName}`.toLowerCase())
    return `alias identity ${JSON.stringify(nwo)} is not the requested ${expectedOwner}/${expectedName}`;
  return null;
}

// ---- dispatch + walk records (journal material) ----------------------------------------------
export type RefsProbeArm = "candidate" | "control";

export interface RefsProbeDispatchRecord {
  arm: RefsProbeArm;
  callKind: "batch-page1" | "solo-page";
  repo: string | null; // "owner/name" for solo pages; null for a batch
  batchOrdinal: number | null; // 0-based batch index within the try (batch calls only)
  pageOrdinal: number | null; // 1-based page number (solo calls only)
  status: number;
  exitCode: number;
  classification: string; // benchGh graphqlRecordClassification verdict
  secondaryLike: boolean;
  secondarySignal: string | null;
  pointsCost: number | null;
  remaining: number | null;
  resetEpochSec: number | null;
  wallMs: number;
  bodyBytes: number;
  errorTypes: string[];
  errorMessages: string[]; // truncated at record time; the resource-limit wording input
  malformedErrorEntries: number;
  dispatchFailure: string | null; // a transport-layer throw (no HTTP response row at all)
}

// WHY the walk stopped — the drift rule's provenance input. Only "frozen-bound" (still
// paginating at the frozen depth) and a complete walk at the wrong depth are POSITIVE drift
// evidence; a walk aborted by a failed dispatch or a shape violation proves nothing about the
// corpus and must never buy an invalidation re-run for a gate-deciding failure.
export type RefsWalkStop = "complete" | "frozen-bound" | "dispatch-failure" | "shape";

export interface RefsRepoWalkRecord {
  arm: RefsProbeArm;
  repo: string;
  pagesObserved: number;
  complete: boolean; // the walk reached hasNextPage:false within the frozen-depth bound
  stoppedBy: RefsWalkStop;
  batteryFailure: string | null;
  identityFailure: string | null; // batched page-1 identity re-assertion (candidate arm only)
  headCount: number;
  defaultBranch: string | null;
}

// GitHub's documented resource-limit family (node limit, resource exhaustion, timeout wording):
// any hit is an unclean signal for the probe, whatever the classification said.
const RESOURCE_LIMIT_TYPES = new Set(["MAX_NODE_LIMIT_EXCEEDED", "RESOURCE_LIMIT_EXCEEDED"]);
const RESOURCE_LIMIT_WORDING_RE = /node limit|resource limit|timeout|exceeds the (maximum|limit)/i;
export function hasResourceLimitSignal(errorTypes: readonly string[], messages: readonly string[]): boolean {
  if (errorTypes.some((t) => RESOURCE_LIMIT_TYPES.has(t))) return true;
  return messages.some((m) => RESOURCE_LIMIT_WORDING_RE.test(m));
}

const THROTTLE_ERROR_TYPES = new Set(["RATE_LIMITED", "RATE_LIMIT"]);

// the per-dispatch cleanliness verdict: [] = clean; otherwise every cause found. Cleanliness is
// the ADR's: exactly one ok-classified response, zero throttle/secondary/resource-limit
// evidence in body or headers (HTTP 200 alone proves nothing), and a readable per-call cost
// (the gates need measured points, so an unreadable rider fails closed).
export function dispatchUncleanCauses(d: RefsProbeDispatchRecord): string[] {
  const causes: string[] = [];
  if (d.dispatchFailure !== null) causes.push(`transport failure: ${d.dispatchFailure}`);
  if (d.status === 0) causes.push("no-response (a dispatch with no response is unclean by construction)");
  if (d.status === 502 || d.status === 504) causes.push(`documented timeout status ${d.status}`);
  if (d.classification !== "ok") causes.push(`classification ${d.classification}`);
  if (d.secondaryLike || d.secondarySignal !== null) causes.push("secondary-limit signal observed");
  if (d.errorTypes.some((t) => THROTTLE_ERROR_TYPES.has(t))) causes.push("throttle-typed body error");
  if (d.remaining === 0) causes.push("x-ratelimit-remaining 0 (window exhausted during the try)");
  if (hasResourceLimitSignal(d.errorTypes, d.errorMessages)) causes.push("resource-limit signal observed");
  if (d.malformedErrorEntries > 0) causes.push(`${d.malformedErrorEntries} malformed error entrie(s)`);
  // gh exits nonzero BY DESIGN when the envelope carries errors (already unclean above), but a
  // nonzero exit under an ok-shaped success is the truncated-transfer precedent's territory —
  // for a measurement, fail closed
  if (d.status !== 0 && d.exitCode !== 0) causes.push(`nonzero gh exit ${d.exitCode} under an HTTP ${d.status} response`);
  if (d.classification === "ok" && d.pointsCost === null) causes.push("per-call cost unreadable on an ok response");
  return causes;
}

// ---- try evaluation (the pair verdict) -------------------------------------------------------
export interface RefsArmSummary {
  clean: boolean;
  causes: string[];
  page1Points: number | null; // summed page-1 (batch or solo page-1) costs; null when unreadable
  continuationPoints: number | null;
  totalPoints: number | null;
  perBatchPoints: Array<number | null>; // candidate batch costs in batch order (absolute gate input)
  reposCovered: number;
  continuationPagesObserved: number;
  page1MaxWallMs: number; // candidate: max batched page-1 wall; control: max solo page-1 wall
  headerDelta: number | null; // first remaining − last remaining (cross-check only)
}

export type RefsTryVerdict = "clean" | "unclean" | "invalidated" | "quarantine-unclean";

export interface RefsTryEvaluation {
  verdict: RefsTryVerdict;
  causes: string[];
  invalidationCause: string | null;
  candidate: RefsArmSummary;
  control: RefsArmSummary;
  pairRatio: number | null; // candidate total ÷ control total (gated in p1; recorded in p2)
}

const dispatchLabel = (d: RefsProbeDispatchRecord): string =>
  d.callKind === "batch-page1" ? `batch ${d.batchOrdinal ?? "?"}` : `${d.repo ?? "?"} page ${d.pageOrdinal ?? "?"}`;

function summarizeArm(
  arm: RefsProbeArm,
  cell: RefsCorpusCell,
  expectedBatches: number,
  dispatches: readonly RefsProbeDispatchRecord[],
  walks: readonly RefsRepoWalkRecord[],
): RefsArmSummary {
  const own = dispatches.filter((d) => d.arm === arm);
  const ownWalks = walks.filter((w) => w.arm === arm);
  const causes: string[] = [];
  for (const d of own) for (const c of dispatchUncleanCauses(d)) causes.push(`${arm} ${dispatchLabel(d)}: ${c}`);
  for (const w of ownWalks) {
    if (w.batteryFailure !== null) causes.push(`${arm} ${w.repo}: ${w.batteryFailure}`);
    if (w.identityFailure !== null) causes.push(`${arm} ${w.repo}: ${w.identityFailure}`);
  }
  // coverage: every cell repository must have a walk record in this arm; the candidate arm must
  // also have dispatched every planned batch
  const walked = new Set(ownWalks.map((w) => w.repo.toLowerCase()));
  for (const r of cell.repos) {
    const key = `${r.owner}/${r.name}`.toLowerCase();
    if (!walked.has(key)) causes.push(`${arm} arm incomplete: ${r.owner}/${r.name} has no recorded walk`);
  }
  if (arm === "candidate") {
    const batchCount = own.filter((d) => d.callKind === "batch-page1").length;
    if (batchCount !== expectedBatches)
      causes.push(`candidate arm incomplete: ${batchCount} of ${expectedBatches} planned batches dispatched`);
  }
  const sumCosts = (list: readonly RefsProbeDispatchRecord[]): number | null => {
    let total = 0;
    for (const d of list) {
      if (d.pointsCost === null) return null;
      total += d.pointsCost;
    }
    return total;
  };
  const batchDispatches = own.filter((d) => d.callKind === "batch-page1")
    .sort((a, b) => (a.batchOrdinal ?? 0) - (b.batchOrdinal ?? 0));
  const page1Solo = own.filter((d) => d.callKind === "solo-page" && d.pageOrdinal === 1);
  const continuation = own.filter((d) => d.callKind === "solo-page" && (d.pageOrdinal ?? 0) >= 2);
  const page1List = arm === "candidate" ? batchDispatches : page1Solo;
  const page1Points = sumCosts(page1List);
  const continuationPoints = sumCosts(continuation);
  const totalPoints = sumCosts(own);
  // the arm's spend as the headers tell it: (first remaining + first call's own cost) − last
  // remaining. A cross-check ONLY, valid within ONE reset window on a quiet credential — so it
  // is withheld (null) unless every readable record shares one non-null reset epoch; the
  // run-level before/after rate_limit snapshots are the real delta reference.
  const readable = own.filter((d) => d.remaining !== null);
  const first = readable[0];
  const last = readable[readable.length - 1];
  const oneEpoch = readable.length > 0 &&
    readable.every((d) => d.resetEpochSec !== null && d.resetEpochSec === readable[0]!.resetEpochSec);
  const headerDelta = oneEpoch && first !== undefined && last !== undefined
    ? (first.remaining as number) + (first.pointsCost ?? 0) - (last.remaining as number)
    : null;
  return {
    clean: causes.length === 0,
    causes,
    page1Points,
    continuationPoints,
    totalPoints,
    perBatchPoints: batchDispatches.map((d) => d.pointsCost),
    reposCovered: ownWalks.length,
    continuationPagesObserved: ownWalks.reduce((n, w) => n + Math.max(0, w.pagesObserved - 1), 0),
    page1MaxWallMs: page1List.reduce((m, d) => Math.max(m, d.wallMs), 0),
    headerDelta,
  };
}

export function evaluateTry(
  cell: RefsCorpusCell,
  dispatches: readonly RefsProbeDispatchRecord[],
  walks: readonly RefsRepoWalkRecord[],
): RefsTryEvaluation {
  const expectedBatches = planOwnerChunks(cell.repos, cell.batchSize).length;
  const candidate = summarizeArm("candidate", cell, expectedBatches, dispatches, walks);
  const control = summarizeArm("control", cell, expectedBatches, dispatches, walks);
  const frozenByRepo = new Map(cell.repos.map((r) => [`${r.owner}/${r.name}`.toLowerCase(), r.frozenPages]));
  // page-count drift needs POSITIVE evidence: a battery-clean COMPLETE walk at the wrong
  // depth, or a walk still paginating at the frozen bound (stoppedBy "frozen-bound"). A walk
  // aborted by a failed dispatch or a shape violation proves nothing about the corpus — the
  // failure itself decides the try, never an invalidation re-run.
  const drift: string[] = [];
  for (const w of walks) {
    if (w.batteryFailure !== null) continue;
    const frozen = frozenByRepo.get(w.repo.toLowerCase());
    if (frozen === undefined) {
      drift.push(`${w.arm} ${w.repo}: walked a repository absent from the frozen corpus`);
      continue;
    }
    if (w.complete && w.pagesObserved !== frozen)
      drift.push(`${w.arm} ${w.repo}: observed ${w.pagesObserved} page(s), frozen ${frozen}`);
    else if (!w.complete && w.stoppedBy === "frozen-bound")
      drift.push(`${w.arm} ${w.repo}: still paginating at the frozen depth ${frozen}`);
  }
  const pairRatio = candidate.totalPoints !== null && control.totalPoints !== null && control.totalPoints > 0
    ? candidate.totalPoints / control.totalPoints
    : null;
  const base = { candidate, control, pairRatio };
  // precedence: the documented-timeout quarantine first (terminal, any arm), then the control
  // prerequisite and the drift rule (both invalidate and re-run), then candidate cleanliness
  // (gate-deciding), then clean. One carve-out: a control arm that never STARTED is not a
  // dirty denominator — the runner may skip it once a candidate failure has already decided
  // the gate ("terminate early, its partial record committed with the cause"); the candidate
  // verdict then stands. A clean candidate with no control still invalidates (no denominator).
  const controlStarted = dispatches.some((d) => d.arm === "control") || walks.some((w) => w.arm === "control");
  if (dispatches.some((d) => d.status === 502 || d.status === 504)) {
    return {
      ...base, verdict: "quarantine-unclean", invalidationCause: null,
      causes: [...candidate.causes, ...control.causes],
    };
  }
  if (!control.clean && (controlStarted || candidate.clean)) {
    return {
      ...base, verdict: "invalidated",
      invalidationCause: `dirty-control: ${controlStarted ? control.causes[0] ?? "unclean" : "control arm never ran"}`,
      causes: control.causes,
    };
  }
  if (drift.length > 0) {
    return {
      ...base, verdict: "invalidated",
      invalidationCause: `page-count-drift: ${drift[0] ?? ""}`,
      causes: drift,
    };
  }
  if (!candidate.clean) {
    return { ...base, verdict: "unclean", invalidationCause: null, causes: candidate.causes };
  }
  return { ...base, verdict: "clean", invalidationCause: null, causes: [] };
}

// ---- journal rows ----------------------------------------------------------------------------
export interface RefsTryInformational {
  candidateFullSnapshotMs: number; // batch dispatch through last continuation response
  candidatePage1PhaseMs: number;
  continuationPhaseMs: number;
  controlArmMs: number;
  wouldHaveTrippedProductionStop: boolean; // continuation phase > half the age cap
}

export interface RefsTryRow {
  rowKind: "try";
  version: 1;
  atIso: string;
  cellB: number;
  stratum: RefsStratum;
  slot: number; // 1..REFS_PROBE_TRIES_PER_CELL (the logical pair ordinal)
  attempt: number; // 1..(1 + REFS_PROBE_INVALIDATION_RERUN_CAP) physical attempt of this slot
  dispatches: RefsProbeDispatchRecord[];
  walks: RefsRepoWalkRecord[];
  verdict: RefsTryVerdict;
  causes: string[];
  invalidationCause: string | null;
  candidate: RefsArmSummary;
  control: RefsArmSummary;
  pairRatio: number | null;
  informational: RefsTryInformational;
}

// The journal's first row binds every later row to ONE corpus (file sha256), ONE bench
// configuration (file sha256), and ONE pre-registered-constants revision (serialized), so a
// resumed run can never silently reuse rows recorded under a different corpus, config, or
// constants set. Scope, stated exactly: code revisions of the rules/runner/builder are NOT
// hashed here — code changes ride the PR review process, and rows recorded before a code
// change are only ever reused within one probe run of one committed tree.
export interface RefsHeaderRow {
  rowKind: "header";
  version: 1;
  atIso: string;
  corpusSha256: string;
  corpusPath: string;
  benchConfigPath: string;
  // absent on headers written before the whole-PR review added this binding (the committed
  // Stage-P journal is one) — such journals stay parseable forever, but a RESUME against one
  // refuses: absence cannot prove configuration identity. The runner always writes it.
  benchConfigSha256?: string;
  constantsFingerprint: string;
}

// the write-ahead intent for one paired try: appended BEFORE the first dispatch, so a crash
// mid-try leaves its spend visible in the journal (the matching try row never arrives — a
// "dangling" start) and the resumed run re-runs that slot at the NEXT attempt ordinal
export interface RefsTryStartRow {
  rowKind: "try-start";
  version: 1;
  atIso: string;
  cellB: number;
  stratum: RefsStratum;
  slot: number;
  attempt: number;
}

export interface RefsAdmissionRow {
  rowKind: "admission";
  version: 1;
  atIso: string;
  cellB: number;
  stratum: RefsStratum;
  slot: number;
  attempt: number;
  neededPoints: number;
  remainingObserved: number;
  sleptMs: number;
}

export interface RefsAdmissionInfeasibleRow {
  rowKind: "admission-infeasible";
  version: 1;
  atIso: string;
  cellB: number;
  stratum: RefsStratum;
  arithmetic: RefsTrancheAdmission;
}

// appended BEFORE its sleep (the obligation must survive a crash mid-sleep — resume honors an
// unexpired untilEpochSec before any further dispatch anywhere)
export interface RefsQuarantineRow {
  rowKind: "quarantine";
  version: 1;
  atIso: string;
  cellB: number;
  stratum: RefsStratum;
  slot: number;
  attempt: number;
  untilEpochSec: number | null;
  plannedSleepMs: number;
}

export interface RefsWashoutRow {
  rowKind: "washout";
  version: 1;
  atIso: string;
  sleptMs: number;
}

// Every physical /rate_limit attempt, recorded as it happens. These are control-plane reads, not
// measured GraphQL spend — they bill no primary point — but benchGh's recorder exists so accounting
// can prove ZERO unexplained traffic, and a discarded attempt proves nothing. Retries and transient
// failures on this endpoint are exactly what would otherwise vanish. Fields mirror
// BenchHttpAttemptRecord without importing it: the rule executor stays free of transport types.
export interface RefsRestMetaRow {
  rowKind: "rest-meta";
  version: 1;
  atIso: string;
  label: string; // the endpoint, never a token-bearing string
  requestClass: string;
  attempt: number; // 1-based physical attempt within one logical call
  status: number;
  classification: string;
  wallMs: number;
  remaining: number | null;
  resetEpochSec: number | null;
}

// a resumed run dropped genuinely torn bytes from the journal's tail. Their content is
// unrecoverable, so the runner cannot know what it lost — and one of the things it MIGHT have lost
// is a quarantine row, which is written before its sleep exactly so a crash cannot skip the
// obligation. This row records the conservative backoff taken in its place.
export interface RefsTearRecoveredRow {
  rowKind: "tear-recovered";
  version: 1;
  atIso: string;
  droppedBytes: number;
  conservativeSleepMs: number;
}

export type RefsProbeJournalRow =
  | RefsHeaderRow
  | RefsTryStartRow
  | RefsTryRow
  | RefsAdmissionRow
  | RefsAdmissionInfeasibleRow
  | RefsQuarantineRow
  | RefsRestMetaRow
  | RefsTearRecoveredRow
  | RefsWashoutRow;

const TRY_VERDICTS: readonly RefsTryVerdict[] = ["clean", "unclean", "invalidated", "quarantine-unclean"];

function requireFields(o: Record<string, unknown>, fields: Array<[string, (v: unknown) => boolean]>, kind: string): void {
  for (const [name, check] of fields) {
    if (!Object.hasOwn(o, name) || !check(o[name]))
      throw new BenchRefsRulesError(`journal ${kind} row field ${name} missing or malformed`);
  }
}

const isStr = (v: unknown): boolean => typeof v === "string";
const isNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const isNumOrNull = (v: unknown): boolean => v === null || isNum(v);
const isStratum = (v: unknown): boolean => v === "p1" || v === "p2";

export function parseJournalRow(line: string): RefsProbeJournalRow {
  let root: unknown;
  try {
    root = JSON.parse(line);
  } catch {
    throw new BenchRefsRulesError("journal line is not valid JSON");
  }
  if (!isObject(root)) throw new BenchRefsRulesError("journal line is not an object");
  if (root["version"] !== 1) throw new BenchRefsRulesError("journal row version must be 1");
  const kind = root["rowKind"];
  if (kind === "try") {
    requireFields(root, [
      ["atIso", isStr], ["cellB", isNum], ["stratum", isStratum], ["slot", isNum], ["attempt", isNum],
      ["dispatches", Array.isArray], ["walks", Array.isArray],
      ["verdict", (v) => TRY_VERDICTS.includes(v as RefsTryVerdict)],
      ["causes", Array.isArray], ["invalidationCause", (v) => v === null || isStr(v)],
      ["candidate", isObject], ["control", isObject], ["pairRatio", isNumOrNull], ["informational", isObject],
    ], "try");
    for (const armField of ["candidate", "control"] as const) {
      requireFields(root[armField] as Record<string, unknown>, [
        ["clean", (v) => typeof v === "boolean"], ["causes", Array.isArray],
        ["page1Points", isNumOrNull], ["continuationPoints", isNumOrNull], ["totalPoints", isNumOrNull],
        ["perBatchPoints", Array.isArray], ["reposCovered", isNum], ["continuationPagesObserved", isNum],
        ["page1MaxWallMs", isNum], ["headerDelta", isNumOrNull],
      ], `try ${armField} summary`);
    }
    return root as unknown as RefsTryRow;
  }
  if (kind === "header") {
    requireFields(root, [
      ["atIso", isStr], ["corpusSha256", isStr], ["corpusPath", isStr],
      ["benchConfigPath", isStr], ["constantsFingerprint", isStr],
    ], "header");
    // legacy headers (pre-binding) may omit it; when present it must be a string
    if (Object.hasOwn(root, "benchConfigSha256") && !isStr(root["benchConfigSha256"]))
      throw new BenchRefsRulesError("journal header row field benchConfigSha256 malformed");
    return root as unknown as RefsHeaderRow;
  }
  if (kind === "try-start") {
    requireFields(root, [
      ["atIso", isStr], ["cellB", isNum], ["stratum", isStratum], ["slot", isNum], ["attempt", isNum],
    ], "try-start");
    return root as unknown as RefsTryStartRow;
  }
  if (kind === "admission") {
    requireFields(root, [
      ["atIso", isStr], ["cellB", isNum], ["stratum", isStratum], ["slot", isNum], ["attempt", isNum],
      ["neededPoints", isNum], ["remainingObserved", isNum], ["sleptMs", isNum],
    ], "admission");
    return root as unknown as RefsAdmissionRow;
  }
  if (kind === "admission-infeasible") {
    requireFields(root, [
      ["atIso", isStr], ["cellB", isNum], ["stratum", isStratum], ["arithmetic", isObject],
    ], "admission-infeasible");
    return root as unknown as RefsAdmissionInfeasibleRow;
  }
  if (kind === "quarantine") {
    requireFields(root, [
      ["atIso", isStr], ["cellB", isNum], ["stratum", isStratum], ["slot", isNum], ["attempt", isNum],
      ["untilEpochSec", isNumOrNull], ["plannedSleepMs", isNum],
    ], "quarantine");
    return root as unknown as RefsQuarantineRow;
  }
  if (kind === "rest-meta") {
    requireFields(root, [
      ["atIso", isStr], ["label", isStr], ["requestClass", isStr], ["attempt", isNum],
      ["status", isNum], ["classification", isStr], ["wallMs", isNum],
      ["remaining", isNumOrNull], ["resetEpochSec", isNumOrNull],
    ], "rest-meta");
    return root as unknown as RefsRestMetaRow;
  }
  if (kind === "tear-recovered") {
    requireFields(root, [
      ["atIso", isStr], ["droppedBytes", isNum], ["conservativeSleepMs", isNum],
    ], "tear-recovered");
    return root as unknown as RefsTearRecoveredRow;
  }
  if (kind === "washout") {
    requireFields(root, [["atIso", isStr], ["sleptMs", isNum]], "washout");
    return root as unknown as RefsWashoutRow;
  }
  throw new BenchRefsRulesError(`unknown journal rowKind ${JSON.stringify(kind)}`);
}

// ---- cell state derivation (resume + terminal commitment) ------------------------------------
export type RefsCellStatus =
  | { kind: "pending"; nextSlot: number; nextAttempt: number; invalidationsUsed: number }
  | { kind: "complete" }
  | { kind: "terminated-unclean"; cause: string }
  | { kind: "invalid"; cause: string }
  | { kind: "infeasible"; cause: string };

export function deriveCellState(cell: RefsCorpusCell, rows: readonly RefsProbeJournalRow[]): RefsCellStatus {
  if (!cell.feasible)
    return { kind: "infeasible", cause: cell.infeasibleCause ?? "corpus-infeasible" };
  const own = rows.filter((r) => "cellB" in r && r.cellB === cell.batchSize && r.stratum === cell.stratum);
  const infeasibleRow = own.find((r) => r.rowKind === "admission-infeasible");
  if (infeasibleRow !== undefined)
    return { kind: "infeasible", cause: "admission worst case exceeds the bucket limit" };
  const tries = own.filter((r): r is RefsTryRow => r.rowKind === "try");
  let invalidationsUsed = 0;
  const cleanSlots = new Set<number>();
  // per-slot attempt high-water mark, fed by BOTH try rows and try-start intents: a dangling
  // start (crash mid-try) advances the attempt ordinal without counting as an invalidation
  const attemptHighBySlot = new Map<number, number>();
  const bump = (slot: number, attempt: number): void => {
    attemptHighBySlot.set(slot, Math.max(attemptHighBySlot.get(slot) ?? 0, attempt));
  };
  for (const r of own) {
    if (r.rowKind === "try-start") bump(r.slot, r.attempt);
  }
  for (const t of tries) {
    bump(t.slot, t.attempt);
    if (t.verdict === "unclean" || t.verdict === "quarantine-unclean")
      return { kind: "terminated-unclean", cause: t.causes[0] ?? t.verdict };
    if (t.verdict === "invalidated") {
      invalidationsUsed++;
      if (invalidationsUsed > REFS_PROBE_INVALIDATION_RERUN_CAP)
        return {
          kind: "invalid",
          cause: `invalidated ${invalidationsUsed} times (cap ${REFS_PROBE_INVALIDATION_RERUN_CAP} re-runs): ${t.invalidationCause ?? "unknown"}`,
        };
      continue;
    }
    cleanSlots.add(t.slot);
  }
  for (let slot = 1; slot <= REFS_PROBE_TRIES_PER_CELL; slot++) {
    if (!cleanSlots.has(slot))
      return { kind: "pending", nextSlot: slot, nextAttempt: (attemptHighBySlot.get(slot) ?? 0) + 1, invalidationsUsed };
  }
  return { kind: "complete" };
}

// ---- reducers --------------------------------------------------------------------------------
export interface RefsCellReduction {
  cleanTryCount: number;
  page1PerRepoMax: number | null; // max over clean tries of (candidate page-1 points ÷ repos covered)
  continuationPerPageMax: number | null; // max over clean tries of (continuation points ÷ pages observed)
  page1WallMaxMs: number | null; // max candidate batched page-1 wall over clean tries
}

export function reduceCell(rows: readonly RefsTryRow[]): RefsCellReduction {
  const clean = rows.filter((r) => r.verdict === "clean");
  let page1Max: number | null = null;
  let contMax: number | null = null;
  let wallMax: number | null = null;
  for (const r of clean) {
    if (r.candidate.page1Points !== null && r.candidate.reposCovered > 0) {
      const v = r.candidate.page1Points / r.candidate.reposCovered;
      page1Max = page1Max === null ? v : Math.max(page1Max, v);
    }
    if (r.candidate.continuationPoints !== null && r.candidate.continuationPagesObserved > 0) {
      const v = r.candidate.continuationPoints / r.candidate.continuationPagesObserved;
      contMax = contMax === null ? v : Math.max(contMax, v);
    }
    wallMax = wallMax === null ? r.candidate.page1MaxWallMs : Math.max(wallMax, r.candidate.page1MaxWallMs);
  }
  return { cleanTryCount: clean.length, page1PerRepoMax: page1Max, continuationPerPageMax: contMax, page1WallMaxMs: wallMax };
}

// ---- candidate gates + selection -------------------------------------------------------------
export interface RefsCellOutcome {
  status: RefsCellStatus;
  reduction: RefsCellReduction;
  tryRows: RefsTryRow[];
}

export interface RefsCandidateVerdict {
  batchSize: number;
  candidate: boolean; // false for informational sizes (B = 50) — never gated for selection
  passed: boolean;
  causes: string[]; // every failed gate / non-complete cell, named
}

export function evaluateCandidate(batchSize: number, p1: RefsCellOutcome, p2: RefsCellOutcome): RefsCandidateVerdict {
  const causes: string[] = [];
  const cells: Array<[RefsStratum, RefsCellOutcome]> = [["p1", p1], ["p2", p2]];
  for (const [label, outcome] of cells) {
    if (outcome.status.kind !== "complete")
      causes.push(`cell ${label} ${outcome.status.kind}${"cause" in outcome.status ? `: ${outcome.status.cause}` : ""}`);
  }
  if (causes.length === 0) {
    // wall gate: the maximum batched page-1 call duration in the candidate arm, either stratum
    for (const [label, outcome] of cells) {
      const wall = outcome.reduction.page1WallMaxMs;
      if (wall === null || wall > REFS_PROBE_WALL_GATE_MS)
        causes.push(`wall gate: ${label} batched page-1 maximum ${wall ?? "unreadable"} ms exceeds ${REFS_PROBE_WALL_GATE_MS} ms`);
    }
    // per-pair cost gate, p1 stratum only (the paginating stratum's ratio has an algebraic
    // floor above one half — gating it would reject batching where it claims no win)
    for (const r of p1.tryRows.filter((t) => t.verdict === "clean")) {
      if (r.pairRatio === null) causes.push(`pair gate: slot ${r.slot} ratio unreadable`);
      else if (r.pairRatio > REFS_PROBE_PAIR_COST_GATE_MAX)
        causes.push(`pair gate: slot ${r.slot} candidate/control ${r.pairRatio.toFixed(4)} exceeds ${REFS_PROBE_PAIR_COST_GATE_MAX}`);
    }
    // absolute gate: every clean try's measured batched page-1 cost per batch, both strata
    const limit = absoluteGatePointsPerBatch(batchSize);
    for (const [label, outcome] of cells) {
      for (const r of outcome.tryRows.filter((t) => t.verdict === "clean")) {
        r.candidate.perBatchPoints.forEach((points, i) => {
          if (points === null) causes.push(`absolute gate: ${label} slot ${r.slot} batch ${i} cost unreadable`);
          else if (points > limit)
            causes.push(`absolute gate: ${label} slot ${r.slot} batch ${i} cost ${points} exceeds ${limit}`);
        });
      }
    }
  }
  return {
    batchSize,
    candidate: REFS_PROBE_CANDIDATE_BATCH_SIZES.includes(batchSize),
    passed: causes.length === 0,
    causes,
  };
}

export type RefsProbeOutcome =
  | { kind: "default-pinned"; defaultBatchSize: number; page1PerRepo: number; correctedFloor8x750: number }
  | { kind: "no-pass"; causes: string[]; correctedFloor8x750: number | null }
  | { kind: "anomaly"; causes: string[] };

export function selectOutcome(
  verdicts: readonly RefsCandidateVerdict[],
  p1ReductionsByB: ReadonlyMap<number, RefsCellReduction>,
): RefsProbeOutcome {
  for (const v of verdicts) {
    if (v.batchSize === 1) throw new BenchRefsRulesError("B = 1 is the control, never gated as a candidate");
    if (v.candidate && !REFS_PROBE_CANDIDATE_BATCH_SIZES.includes(v.batchSize))
      throw new BenchRefsRulesError(`verdict marks B = ${v.batchSize} as a candidate outside the pre-registered set`);
  }
  const byB = new Map(verdicts.filter((v) => v.candidate).map((v) => [v.batchSize, v]));
  // contiguous prefix from the smallest candidate: a candidate is eligible only if every
  // smaller candidate also passed
  const eligible: number[] = [];
  let prefixIntact = true;
  for (const b of REFS_PROBE_CANDIDATE_BATCH_SIZES) {
    const v = byB.get(b);
    if (v === undefined || !v.passed) {
      prefixIntact = false;
      continue;
    }
    if (prefixIntact) eligible.push(b);
  }
  if (eligible.length > 0) {
    // cheapest measured per-repository page-1 cost in the p1 stratum; ties to the smaller B
    let chosen: number | null = null;
    let chosenCost: number | null = null;
    for (const b of eligible) {
      const cost = p1ReductionsByB.get(b)?.page1PerRepoMax ?? null;
      if (cost === null) throw new BenchRefsRulesError(`eligible B = ${b} has no p1 page-1 reduction`);
      if (chosenCost === null || cost < chosenCost) {
        chosen = b;
        chosenCost = cost;
      }
    }
    if (chosen === null || chosenCost === null) throw new BenchRefsRulesError("internal: empty eligible selection");
    const floor = round6(REFS_PROBE_ESTATE_8X750_REPOS * chosenCost);
    if (floor >= REFS_PROBE_SHIP_THRESHOLD_POINTS) {
      return {
        kind: "no-pass",
        causes: [
          `ship threshold: corrected 8x750 page-1 floor ${floor} points is not under ${REFS_PROBE_SHIP_THRESHOLD_POINTS} (10% of one window)`,
        ],
        correctedFloor8x750: floor,
      };
    }
    return { kind: "default-pinned", defaultBatchSize: chosen, page1PerRepo: chosenCost, correctedFloor8x750: floor };
  }
  // non-monotone anomaly: a larger candidate passed while a smaller one did not (an invalid or
  // infeasible smaller cell fails the prefix the same way)
  const anyLargerPassed = [...byB.values()].some((v) => v.passed);
  if (anyLargerPassed) {
    const failed = [...byB.values()].filter((v) => !v.passed).map((v) => `B=${v.batchSize}: ${v.causes[0] ?? "did not pass"}`);
    return {
      kind: "anomaly",
      causes: [`non-monotone result falsifies the operator range's monotonicity assumption`, ...failed],
    };
  }
  return {
    kind: "no-pass",
    causes: [...byB.values()].map((v) => `B=${v.batchSize}: ${v.causes[0] ?? "did not pass"}`),
    correctedFloor8x750: null,
  };
}

// ---- admission arithmetic --------------------------------------------------------------------
export interface RefsTrancheAdmission {
  batches: number;
  candidateContinuations: number;
  controlPages: number;
  dispatchesPerTry: number;
  perAttemptPointBound: number;
  headroomFactor: number;
  rerunMultiplier: number; // 1 + the cell's remaining permitted invalidation re-runs
  neededPoints: number;
  bucketLimitPoints: number;
  feasible: boolean; // false = worst case exceeds the bucket limit itself (fail loudly)
}

export function admitTranche(cell: RefsCorpusCell, remainingReruns: number, headroomFactor: number): RefsTrancheAdmission {
  if (!cell.feasible) throw new BenchRefsRulesError("admitTranche called on a corpus-infeasible cell");
  if (!Number.isSafeInteger(remainingReruns) || remainingReruns < 0)
    throw new BenchRefsRulesError(`remainingReruns ${remainingReruns} must be a nonnegative integer`);
  const batches = planOwnerChunks(cell.repos, cell.batchSize).length;
  const candidateContinuations = cell.repos.reduce((n, r) => n + (r.frozenPages - 1), 0);
  const controlPages = cell.repos.reduce((n, r) => n + r.frozenPages, 0);
  const dispatchesPerTry = batches + candidateContinuations + controlPages;
  const rerunMultiplier = 1 + remainingReruns;
  const neededPoints = Math.ceil(dispatchesPerTry * REFS_PROBE_POINT_BOUND_PER_ATTEMPT * headroomFactor * rerunMultiplier);
  return {
    batches,
    candidateContinuations,
    controlPages,
    dispatchesPerTry,
    perAttemptPointBound: REFS_PROBE_POINT_BOUND_PER_ATTEMPT,
    headroomFactor,
    rerunMultiplier,
    neededPoints,
    bucketLimitPoints: REFS_PROBE_BUCKET_LIMIT_POINTS,
    feasible: neededPoints <= REFS_PROBE_BUCKET_LIMIT_POINTS,
  };
}

// ---- corrected-estate presentation (the P4 bill, computed by the pre-registered rule) --------
export interface RefsEstateShape {
  label: string;
  owners: number;
  reposPerOwner: number;
}

export const REFS_WORKED_ESTATES: readonly RefsEstateShape[] = [
  { label: "1 org x 1,000", owners: 1, reposPerOwner: 1_000 },
  { label: "8 orgs x 750", owners: 8, reposPerOwner: 750 },
  { label: "25 orgs x 400", owners: 25, reposPerOwner: 400 },
  { label: "1,000 owners x 1", owners: 1_000, reposPerOwner: 1 },
];

export interface RefsEstateRow {
  label: string;
  keptRepos: number;
  todayPage1Points: number; // formula: one point per repository
  measuredPage1Points: number; // measured per-repo reducer × batched repos + solo formula floor
  allSinglePageTotal: number; // page-1 term only (premise: no repository paginates)
  uniformP2Total: number; // page-1 term + one continuation page per repo at the measured per-page cost
}

// Per owner: ceil(n/B) batches; each batch prices at the measured per-repository reducer times
// its repository count, floored at the formula's 1-point minimum per query (the reason the
// 1,000-owners-x-1 row buys nothing — the worked table's honest degenerate case).
export function presentCorrectedEstates(
  batchSize: number,
  page1PerRepo: number,
  continuationPerPage: number | null,
): RefsEstateRow[] {
  if (batchSize < 1 || !Number.isSafeInteger(batchSize)) throw new BenchRefsRulesError(`batchSize ${batchSize} is not a positive integer`);
  if (!(page1PerRepo > 0)) throw new BenchRefsRulesError(`page1PerRepo ${page1PerRepo} must be positive`);
  const perPage = continuationPerPage ?? 1; // formula-priced one-point calls when unmeasured
  return REFS_WORKED_ESTATES.map((e) => {
    const keptRepos = e.owners * e.reposPerOwner;
    let perOwner = 0;
    let n = e.reposPerOwner;
    while (n > 0) {
      const take = Math.min(batchSize, n);
      perOwner += Math.max(1, page1PerRepo * take);
      n -= take;
    }
    const measuredPage1Points = round6(e.owners * perOwner);
    const uniformP2Total = round6(measuredPage1Points + keptRepos * perPage);
    return {
      label: e.label,
      keptRepos,
      todayPage1Points: keptRepos,
      measuredPage1Points,
      allSinglePageTotal: measuredPage1Points,
      uniformP2Total,
    };
  });
}
