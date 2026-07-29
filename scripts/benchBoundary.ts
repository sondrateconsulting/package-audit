// benchBoundary.ts — the §4.4 boundary probe: a two-dimensional sweep on one mid-size repo
// (the pinned C2 unit) mapping the aliased-GraphQL failure boundary the frozen T1 caps
// deliberately stay clear of. Alias counts {250, 300, 350, 400, 425, 450, 475} at small fixed
// content test whether M4's 462-alias 502 is deterministic; alias×content pairs
// {150, 250} × {1.5 MiB, 3 MiB} probe the unmeasured alias×content interaction. 3 tries per
// cell. Informational and post-matrix: NOT scored, and it deliberately dispatches ABOVE the
// preregistered caps — so it builds queries directly instead of going through packBatches,
// whose whole job is refusing exactly these shapes. Evidence for the production caps ADR-0001
// requires; runs under the §8 freeze gate like every evidence-generating executor.

import type { BenchConfig } from "./benchConfig.ts";
import { benchGraphqlDispatch, outstandingHorizonMs, readRateLimit, type BenchGhContext, type RateLimitSnapshot } from "./benchGh.ts";
import { analyzeBatchResponse } from "./benchT1.ts";
import type { BenchObjectFormat } from "./benchGrammar.ts";
import { washoutMs } from "./benchProtocol.ts";
import { buildBatchQuery } from "./benchT1.ts";
import type { WorkloadEntry } from "./benchWorkload.ts";

export class BenchBoundaryError extends Error {
  constructor(message: string) {
    super(`BENCH BOUNDARY: ${message}`);
    this.name = "BenchBoundaryError";
  }
}

// the plan's pinned sweep (§4.4) — literals here are frozen via the module's presence in the
// §8 surface digest, exactly like bench-config constants
export const BOUNDARY_ALIAS_COUNTS: readonly number[] = [250, 300, 350, 400, 425, 450, 475];
export const BOUNDARY_ALIAS_CONTENT_PAIRS: ReadonlyArray<{ aliases: number; targetBytes: number }> = [
  { aliases: 150, targetBytes: 1_572_864 },
  { aliases: 150, targetBytes: 3_145_728 },
  { aliases: 250, targetBytes: 1_572_864 },
  { aliases: 250, targetBytes: 3_145_728 },
];
export const BOUNDARY_TRIES_PER_CELL = 3;
export const BOUNDARY_SMALL_BLOB_MAX_BYTES = 4096;
// a dispatch whose argv would plausibly exceed the OS arg-space limit is recorded as
// undispatchable instead of crashing the sweep mid-probe (macOS ARG_MAX is 1 MiB; stay clear)
export const BOUNDARY_ARGV_PHYSICAL_CEILING = 700 * 1024;
const TRY_GAP_MS = 15_000;
const CELL_GAP_MS = 60_000;

export interface BoundaryBlob {
  path: string;
  oid: string;
  size: number;
}

export interface BoundaryCellPlan {
  aliasCount: number;
  contentTargetBytes: number | null; // null = the small-content alias sweep
  actualContentBytes: number;
  blobs: BoundaryBlob[];
}

// Deterministic cell planning over the pinned tree's blobs — pure, CI-tested. Small-content
// cells take the N smallest blobs (size, then path); content cells take the N blobs closest to
// the per-alias ideal so the sum lands near the target (recorded as actualContentBytes — real
// repo content cannot hit a byte target exactly, and the probe reports what it actually sent).
export function planBoundaryCells(blobs: readonly BoundaryBlob[]): BoundaryCellPlan[] {
  const bySize = [...blobs].sort((a, b) => (a.size - b.size) || (a.path < b.path ? -1 : 1));
  const cells: BoundaryCellPlan[] = [];
  const maxAliases = Math.max(...BOUNDARY_ALIAS_COUNTS);
  const small = bySize.filter((b) => b.size <= BOUNDARY_SMALL_BLOB_MAX_BYTES);
  if (small.length < maxAliases)
    throw new BenchBoundaryError(`the pinned tree carries only ${small.length} blobs ≤ ${BOUNDARY_SMALL_BLOB_MAX_BYTES} B — the ${maxAliases}-alias cell needs that many distinct paths`);
  for (const aliasCount of BOUNDARY_ALIAS_COUNTS) {
    const take = small.slice(0, aliasCount);
    cells.push({
      aliasCount, contentTargetBytes: null,
      actualContentBytes: take.reduce((n, b) => n + b.size, 0),
      blobs: take,
    });
  }
  for (const pair of BOUNDARY_ALIAS_CONTENT_PAIRS) {
    if (blobs.length < pair.aliases)
      throw new BenchBoundaryError(`tree has ${blobs.length} blobs, cell needs ${pair.aliases}`);
    const ideal = pair.targetBytes / pair.aliases;
    const take = [...blobs]
      .sort((a, b) => (Math.abs(a.size - ideal) - Math.abs(b.size - ideal)) || (a.path < b.path ? -1 : 1))
      .slice(0, pair.aliases);
    cells.push({
      aliasCount: pair.aliases, contentTargetBytes: pair.targetBytes,
      actualContentBytes: take.reduce((n, b) => n + b.size, 0),
      blobs: take,
    });
  }
  return cells;
}

export interface BoundaryTryResult {
  tryOrdinal: number;
  dispatched: boolean; // false = undispatchable (argv over the physical ceiling), recorded not sent
  status: number;
  classification: string;
  jsonParseable: boolean;
  errorTypes: string[]; // distinct errors[].type values observed
  malformedErrorEntries: number;
  // an alias counts as RESOLVED only when it passes T1's OWN per-alias validation (typename,
  // oid echo, byteSize, hash — analyzeBatchResponse), so error-shaped, conflicted, or
  // null-content aliases can never be laundered into successes (codex C0-R1/R2 finding 14)
  resolvedAliases: number;
  objectAliases: number; // any non-null object came back (the raw shape count, for contrast)
  analysisKind: string; // the exhaustive transition table's verdict on the whole envelope
  aliasConflicts: number; // aliases present in BOTH data and errors[]
  pointsCost: number | null;
  wallMs: number;
  bodyBytes: number;
  secondaryLike: boolean;
}

export interface BoundaryCellResult {
  aliasCount: number;
  contentTargetBytes: number | null;
  actualContentBytes: number;
  queryBytes: number;
  argvBytes: number;
  tries: BoundaryTryResult[];
}

export interface BoundaryProbeDeps {
  gh: BenchGhContext;
  cfg: BenchConfig;
  owner: string;
  repo: string;
  sha: string;
  objectFormat: BenchObjectFormat;
  log: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface BoundaryProbeRun {
  before: RateLimitSnapshot;
  after: RateLimitSnapshot;
  finalWashoutMs: number;
  cells: BoundaryCellResult[];
}

const toEntry = (b: BoundaryBlob): WorkloadEntry => ({
  path: b.path, mode: "100644", blobOid: b.oid, size: b.size, class: "source",
  read: true, noReadReason: null, canonicalSeamSha256: null, rawSha256: null,
  restDerefSeamSha256: null, checkoutSeamSha256: null, gql: null,
});

export async function runBoundaryProbe(deps: BoundaryProbeDeps, cells: readonly BoundaryCellPlan[]): Promise<BoundaryProbeRun> {
  // admission before the sweep (codex C0-R1 finding 14): reserve the worst plausible spend —
  // every dispatch at the frozen P_max bound — and sleep to the reset epoch when short, so an
  // above-cap sweep cannot start into a bucket another consumer needs
  const dispatches = cells.length * BOUNDARY_TRIES_PER_CELL;
  const needGraphql = Math.ceil(dispatches * deps.cfg.budget.pMaxPointsPerGraphqlAttempt * deps.cfg.budget.headroomFactor);
  for (;;) {
    const snap = await readRateLimit(deps.gh);
    deps.log(`boundary admission: need graphql ${needGraphql} (have ${snap.graphql.remaining})`);
    if (snap.graphql.remaining >= needGraphql) break;
    const wait = Math.max(snap.graphql.reset * 1000 + 5000 - deps.now(), 30_000);
    deps.log(`boundary admission: headroom short — sleeping ${Math.ceil(wait / 1000)}s to the reset epoch`);
    await deps.sleep(wait);
  }
  const before = await readRateLimit(deps.gh);
  const results: BoundaryCellResult[] = [];
  try {
    for (const [cellIndex, cell] of cells.entries()) {
    if (cellIndex > 0) await deps.sleep(CELL_GAP_MS);
    const batch = buildBatchQuery(cell.blobs.map(toEntry), {
      owner: deps.owner, repo: deps.repo, sha: deps.sha,
      aliasSelection: deps.cfg.t1.aliasSelection, rateLimitRider: deps.cfg.t1.rateLimitRider,
      label: `boundary.a${cell.aliasCount}.c${cell.contentTargetBytes ?? 0}`,
    });
    const result: BoundaryCellResult = {
      aliasCount: cell.aliasCount, contentTargetBytes: cell.contentTargetBytes,
      actualContentBytes: cell.actualContentBytes, queryBytes: batch.queryBytes, argvBytes: batch.argvBytes,
      tries: [],
    };
    deps.log(`boundary cell ${cellIndex + 1}/${cells.length}: ${cell.aliasCount} aliases, ${cell.actualContentBytes} content bytes, argv ${batch.argvBytes} B`);
    for (let t = 1; t <= BOUNDARY_TRIES_PER_CELL; t++) {
      if (t > 1) await deps.sleep(TRY_GAP_MS);
      if (batch.argvBytes > BOUNDARY_ARGV_PHYSICAL_CEILING) {
        result.tries.push({
          tryOrdinal: t, dispatched: false, status: 0, classification: "undispatchable",
          jsonParseable: false, errorTypes: [], malformedErrorEntries: 0, resolvedAliases: 0,
          objectAliases: 0, analysisKind: "undispatched", aliasConflicts: 0,
          pointsCost: null, wallMs: 0, bodyBytes: 0, secondaryLike: false,
        });
        continue;
      }
      const startedAt = deps.now();
      const d = await benchGraphqlDispatch(deps.gh, batch.query, batch.fields, batch.label, t);
      const repo = d.data?.["repository"];
      const repoObj = typeof repo === "object" && repo !== null && !Array.isArray(repo) ? (repo as Record<string, unknown>) : null;
      let objects = 0;
      for (let i = 0; i < cell.aliasCount; i++) {
        const alias = repoObj?.[`a${i}`];
        if (typeof alias === "object" && alias !== null) objects++;
      }
      // T1's OWN exhaustive transition table judges the envelope; resolved = fully validated
      const analysis = analyzeBatchResponse(d, batch, deps.objectFormat, deps.cfg);
      const resolved = analysis.kind === "per-alias" ? analysis.outcomes.filter((o) => o.kind === "resolved").length : 0;
      const conflicts = analysis.kind === "per-alias" ? analysis.conflicts.length : 0;
      result.tries.push({
        tryOrdinal: t, dispatched: true, status: d.status, classification: d.classification,
        jsonParseable: d.jsonParseable,
        errorTypes: [...new Set(d.errors.map((e) => e.type ?? "?"))],
        malformedErrorEntries: d.malformedErrorEntries,
        resolvedAliases: resolved, objectAliases: objects, analysisKind: analysis.kind, aliasConflicts: conflicts,
        pointsCost: d.pointsCost,
        wallMs: deps.now() - startedAt, bodyBytes: Buffer.byteLength(d.bodyText, "utf8"),
        secondaryLike: d.secondaryLike,
      });
      deps.log(`  try ${t}: HTTP ${d.status} (${d.classification}/${analysis.kind}), ${resolved}/${cell.aliasCount} aliases validated (${objects} objects), cost ${d.pointsCost ?? "?"}`);
    }
    results.push(result);
    }
  } finally {
    // the sweep ALWAYS ends with a full washout of its own throttle horizon — even on a thrown
    // dispatch — so an above-cap burst cannot bleed into the next executor's window (codex
    // C0-R1/R2 finding 14)
    const finalWashoutMs = washoutMs(deps.cfg, outstandingHorizonMs(deps.gh), deps.now());
    deps.log(`boundary probe winding down — final washout ${Math.ceil(finalWashoutMs / 1000)}s`);
    await deps.sleep(finalWashoutMs);
  }
  const after = await readRateLimit(deps.gh);
  const finalWashoutMs = washoutMs(deps.cfg, 0, deps.now());
  return { before, after, finalWashoutMs, cells: results };
}
