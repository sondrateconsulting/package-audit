// graphqlBatch.ts — ADR-0002's alias-batched refs page-1 query builder (pure, data-in/data-out).
// Stage P lands the builder alone so the Confirmation-1 probe prices the exact query production
// will ship (plan §4); Stage I adds partitionBatchEnvelope beside it. No client, no clock, no
// transport — callers dispatch through the existing gh lane.

export interface BatchRefsRepo {
  owner: string;
  name: string;
}

export interface BatchRefsQueryOptions {
  // the probe's per-call cost rider (e.g. "rateLimit{cost}"), appended at the query root and
  // nowhere else; absent/empty = the production document. The rider-equivalence test pins that
  // rider-on and rider-off differ by exactly this field.
  rateLimitRider?: string;
}

export interface BatchRefsExpectedAlias {
  alias: string;
  owner: string;
  name: string;
}

export interface BatchRefsQuery {
  query: string;
  fields: Record<string, string>;
  aliasCount: number;
  expected: BatchRefsExpectedAlias[];
  queryBytes: number;
  argvBytes: number;
}

// The solo listBranchHeads page selection (github.ts) minus the after-cursor argument: a batched
// alias covers page 1 only, and keeping the pageInfo/node shape byte-identical to the solo walk
// is what lets the existing fail-closed validation battery transfer unchanged (Confirmation 6).
const REFS_PAGE1_SELECTION =
  "refs(refPrefix:\"refs/heads/\",first:100){pageInfo{hasNextPage endCursor}nodes{name target{...on Commit{oid committedDate tree{oid}}}}}";

export class BatchRefsQueryError extends Error {
  constructor(message: string) {
    super(`graphql batch: ${message}`);
    this.name = "BatchRefsQueryError";
  }
}

export function buildBatchRefsQuery(repos: readonly BatchRefsRepo[], opts: BatchRefsQueryOptions): BatchRefsQuery {
  if (repos.length === 0) throw new BatchRefsQueryError("a batch needs at least one repository");
  const varDecls: string[] = [];
  const selections: string[] = [];
  const fields: Record<string, string> = {};
  const expected: BatchRefsExpectedAlias[] = [];
  // duplicate (owner,name) pairs are rejected case-insensitively — GitHub identities are — with
  // the same collision-proof tuple key mapRepoPage uses (no separator ambiguity).
  const seen = new Set<string>();
  // the registered batch shape is PER-OWNER ("page 1 for each of B repositories of one
  // owner"); cross-owner batching is deferred, not adopted, so a mixed batch is a wiring bug
  const firstOwner = repos[0]?.owner.toLowerCase() ?? "";
  repos.forEach((r, i) => {
    if (r.owner.length === 0) throw new BatchRefsQueryError(`owner is empty at index ${i}`);
    if (r.name.length === 0) throw new BatchRefsQueryError(`name is empty at index ${i}`);
    if (r.owner.toLowerCase() !== firstOwner)
      throw new BatchRefsQueryError(`batch spans multiple owners (${repos[0]!.owner}, ${r.owner}) — the registered shape is per-owner`);
    const key = JSON.stringify([r.owner.toLowerCase(), r.name.toLowerCase()]);
    if (seen.has(key)) throw new BatchRefsQueryError(`duplicate repository ${r.owner}/${r.name} at index ${i}`);
    seen.add(key);
    // identities bind as VARIABLES, never inline: isCanonicalIdentity deliberately admits
    // GraphQL metacharacters, so validation does not make interpolation safe (the ADR's rule).
    varDecls.push(`$o${i}:String!`, `$n${i}:String!`);
    selections.push(
      `r${i}:repository(owner:$o${i},name:$n${i}){nameWithOwner defaultBranchRef{name}${REFS_PAGE1_SELECTION}}`,
    );
    fields[`o${i}`] = r.owner;
    fields[`n${i}`] = r.name;
    expected.push({ alias: `r${i}`, owner: r.owner, name: r.name });
  });
  const rider = opts.rateLimitRider ?? "";
  const query = `query(${varDecls.join(",")}){${selections.join(" ")}${rider === "" ? "" : ` ${rider}`}}`;
  const queryBytes = Buffer.byteLength(query, "utf8");
  // argv accounting mirrors the gh raw-field shape the production client and the bench dispatch
  // layer both use (one query field + one field per variable) — the probe's admission input.
  // ONE "-f" precedes the query field, exactly as github.ts/benchGh.ts build the argv — the
  // long-standing benchT1.ts copy of this formula counts two and overstates every batch by 2 B
  let argvBytes = Buffer.byteLength(`query=${query}`, "utf8") + "-f".length;
  for (const [k, v] of Object.entries(fields)) argvBytes += Buffer.byteLength(`${k}=${v}`, "utf8") + "-f".length;
  return { query, fields, aliasCount: repos.length, expected, queryBytes, argvBytes };
}
