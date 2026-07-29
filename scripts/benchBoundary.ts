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
import { benchGraphqlDispatch, type BenchGhContext } from "./benchGh.ts";
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
  resolvedAliases: number; // aliases that came back as readable objects in data.repository
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
  log: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const toEntry = (b: BoundaryBlob): WorkloadEntry => ({
  path: b.path, mode: "100644", blobOid: b.oid, size: b.size, class: "source",
  read: true, noReadReason: null, canonicalSeamSha256: null, rawSha256: null,
  restDerefSeamSha256: null, checkoutSeamSha256: null, gql: null,
});

export async function runBoundaryProbe(deps: BoundaryProbeDeps, cells: readonly BoundaryCellPlan[]): Promise<BoundaryCellResult[]> {
  const results: BoundaryCellResult[] = [];
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
          pointsCost: null, wallMs: 0, bodyBytes: 0, secondaryLike: false,
        });
        continue;
      }
      const startedAt = deps.now();
      const d = await benchGraphqlDispatch(deps.gh, batch.query, batch.fields, batch.label, t);
      const repo = d.data?.["repository"];
      const repoObj = typeof repo === "object" && repo !== null && !Array.isArray(repo) ? (repo as Record<string, unknown>) : null;
      let resolved = 0;
      for (let i = 0; i < cell.aliasCount; i++) {
        const alias = repoObj?.[`a${i}`];
        if (typeof alias === "object" && alias !== null) resolved++;
      }
      result.tries.push({
        tryOrdinal: t, dispatched: true, status: d.status, classification: d.classification,
        jsonParseable: d.jsonParseable,
        errorTypes: [...new Set(d.errors.map((e) => e.type ?? "?"))],
        malformedErrorEntries: d.malformedErrorEntries,
        resolvedAliases: resolved, pointsCost: d.pointsCost,
        wallMs: deps.now() - startedAt, bodyBytes: Buffer.byteLength(d.bodyText, "utf8"),
        secondaryLike: d.secondaryLike,
      });
      deps.log(`  try ${t}: HTTP ${d.status} (${d.classification}), ${resolved}/${cell.aliasCount} aliases resolved, cost ${d.pointsCost ?? "?"}`);
    }
    results.push(result);
  }
  return results;
}
