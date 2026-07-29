// benchT1.ts — Option 1's driver planning + response transition table, PURE (resolution plan
// §4.4). Two-round dispatch exactly as the production design forces (round 1: manifests +
// CLI-classifiable paths, knowable from the tree alone; round 2: source + lockfiles), greedy
// batch packing under the four preregistered caps, variable-bound query construction (never
// string interpolation — a legal path may contain quotes/backslashes/newlines, ADR §7), and an
// EXHAUSTIVE response transition table with a closed default — nothing is classified at
// observation time. The driver loop (benchDrivers) consumes these outcomes; everything here is
// CI-tested without a network.

import type { BenchConfig } from "./benchConfig.ts";
import type { BenchGraphqlDispatch } from "./benchGh.ts";
import { gitBlobOid } from "./benchGh.ts";
import type { WorkloadEntry, UnitWorkload } from "./benchWorkload.ts";
import type { BenchObjectFormat } from "./benchGrammar.ts";

export class BenchT1Error extends Error {
  constructor(message: string) {
    super(`BENCH T1: ${message}`);
    this.name = "BenchT1Error";
  }
}

// ---- rounds ----------------------------------------------------------------------------------
// Round 1 batches what the tree alone makes knowable (manifests + CLI-classifiable paths);
// round 2 batches the source files round 1's manifests made relevant plus the required nearest
// lockfiles (ADR "Rounds"). Pre-routed entries (symlink / binary / truncated-blob /
// content-cap-singleton per the pinned matrix) never enter a batch — they go straight to the
// REST fallback lane with their pinned cause.
export interface T1Plan {
  round1: WorkloadEntry[];
  round2: WorkloadEntry[];
  preRouted: Array<{ entry: WorkloadEntry; route: string }>;
}
export function planRounds(workload: UnitWorkload): T1Plan {
  const round1: WorkloadEntry[] = [];
  const round2: WorkloadEntry[] = [];
  const preRouted: Array<{ entry: WorkloadEntry; route: string }> = [];
  for (const entry of workload.entries) {
    if (!entry.read) continue; // no-read routes acquire nothing, by expectation
    // pre-route ONLY what the TREE alone knows (§4.4): symlinks by mode, content-cap
    // singletons by ls-tree size. Binary/truncated states are DISCOVERED in the timed GraphQL
    // response (isBinary/isTruncated/text) — the pinned gql facts are EXPECTATIONS for the
    // matrix, never a runtime oracle (codex R1 finding 4).
    if (entry.mode === "120000") {
      preRouted.push({ entry, route: "symlink-fallback" });
    } else if (entry.size > workload.batchContentBytesCap) {
      preRouted.push({ entry, route: "content-cap-singleton" });
    } else {
      (entry.class === "manifest" || entry.class === "cli" ? round1 : round2).push(entry);
    }
  }
  return { round1, round2, preRouted };
}

// ---- query construction ----------------------------------------------------------------------
export interface PlannedBatch {
  label: string; // e.g. "r1.b0"
  entries: WorkloadEntry[];
  query: string;
  fields: Record<string, string>; // owner/name + one variable per alias expression
  queryBytes: number;
  argvBytes: number;
  contentEstimateBytes: number;
}

export function buildBatchQuery(
  entries: readonly WorkloadEntry[],
  opts: { owner: string; repo: string; sha: string; aliasSelection: string; rateLimitRider: string; label: string },
): PlannedBatch {
  const varDecls: string[] = ["$owner:String!", "$name:String!"];
  const selections: string[] = [];
  const fields: Record<string, string> = { owner: opts.owner, name: opts.repo };
  entries.forEach((entry, i) => {
    const v = `v${i}`;
    varDecls.push(`$${v}:String!`);
    // variable-bound expression — the PATH never appears in the query document
    selections.push(`a${i}:${opts.aliasSelection.replace("$EXPR", `$${v}`)}`);
    fields[v] = `${opts.sha}:${entry.path}`;
  });
  const query = `query(${varDecls.join(",")}){repository(owner:$owner,name:$name){${selections.join(" ")}} ${opts.rateLimitRider}}`;
  const queryBytes = Buffer.byteLength(query, "utf8");
  // argv shape mirrors the production client: -f query=… plus one -f per variable (github.ts's
  // graphql argv); E2BIG binds on the SUM of argv bytes.
  let argvBytes = Buffer.byteLength(`query=${query}`, "utf8") + 2 * "-f".length;
  for (const [k, v] of Object.entries(fields)) argvBytes += Buffer.byteLength(`${k}=${v}`, "utf8") + "-f".length;
  const contentEstimateBytes = entries.reduce((n, e) => n + e.size, 0);
  return { label: opts.label, entries: [...entries], query, fields, queryBytes, argvBytes, contentEstimateBytes };
}

// Greedy contiguous packing under ALL FOUR caps (alias count, content estimate, query-document
// bytes, argv bytes). Deterministic; an entry that alone violates a byte cap is impossible here
// (content-cap singletons were pre-routed; a single path cannot overflow the 48 KiB document).
export function packBatches(
  entries: readonly WorkloadEntry[],
  cfg: BenchConfig,
  opts: { owner: string; repo: string; sha: string; roundLabel: string },
): PlannedBatch[] {
  const out: PlannedBatch[] = [];
  let start = 0;
  while (start < entries.length) {
    let take = Math.min(cfg.t1.aliasCap, entries.length - start);
    for (;;) {
      const slice = entries.slice(start, start + take);
      const batch = buildBatchQuery(slice, {
        owner: opts.owner, repo: opts.repo, sha: opts.sha,
        aliasSelection: cfg.t1.aliasSelection, rateLimitRider: cfg.t1.rateLimitRider,
        label: `${opts.roundLabel}.b${out.length}`,
      });
      const fits =
        slice.length <= cfg.t1.aliasCap &&
        batch.contentEstimateBytes <= cfg.t1.batchContentBytesCap &&
        batch.queryBytes <= cfg.t1.queryDocBytesCap &&
        batch.argvBytes <= cfg.t1.argvBytesCap;
      if (fits || take === 1) {
        if (!fits) throw new BenchT1Error(`entry ${slice[0]!.path} alone violates a T1 cap (pinning should have pre-routed it)`);
        out.push(batch);
        start += take;
        break;
      }
      take = Math.ceil(take / 2);
    }
  }
  return out;
}

// ---- the exhaustive transition table ---------------------------------------------------------
export type AliasOutcome =
  | { kind: "resolved"; index: number; text: string }
  | { kind: "binary-fallback"; index: number } // observed isBinary/text:null — routed, counted
  | { kind: "truncated-blob-fallback"; index: number } // observed isTruncated — routed, counted
  | { kind: "validation-fallback"; index: number; reason: string }
  | { kind: "timeout"; index: number } // alias-attributed TIMEOUT — feeds the split decision
  | { kind: "missing"; index: number } // a tree-listed expression reported absent (NOT_FOUND)
  | { kind: "unattributed"; index: number }; // in neither data nor errors[]

export type BatchAnalysis =
  | {
      kind: "http-failure"; // 5xx / no HTTP response / non-JSON body → whole-batch attempt failure
      fivexxSplitCandidate: boolean; // status ∈ pinned {502,503,504} with empty or non-JSON body
      rawCondition: string;
    }
  | { kind: "throttle-retry"; cause: "primary" | "secondary" | "rate-limited-body" } // whole-batch backoff retry
  | { kind: "batch-timeout" } // pathless TIMEOUT-type/-message error → split trigger evaluation
  | { kind: "default-failure"; rawCondition: string } // the CLOSED default clause
  | { kind: "per-alias"; outcomes: AliasOutcome[]; conflicts: number[] };

const aliasIndexFromPath = (path: ReadonlyArray<string | number> | null, aliasCount: number): number | null => {
  if (path === null) return null;
  for (const seg of path) {
    if (typeof seg !== "string") continue;
    const m = /^a(\d+)$/.exec(seg);
    if (m !== null) {
      const idx = Number(m[1]);
      if (idx < aliasCount) return idx;
    }
  }
  return null;
};

export function analyzeBatchResponse(
  d: BenchGraphqlDispatch,
  batch: PlannedBatch,
  objectFormat: BenchObjectFormat,
  cfg: BenchConfig,
): BatchAnalysis {
  const isTimeoutError = (e: { type: string | null; message: string | null }): boolean =>
    e.type === cfg.t1.splitTriggers.graphqlErrorType ||
    (e.message !== null && cfg.t1.splitTriggers.timeoutMessageRe.test(e.message));
  // malformed errors[] members carry no attributable signal — the closed default, never a drop
  if (d.malformedErrorEntries > 0 && d.status === 200 && d.jsonParseable)
    return { kind: "default-failure", rawCondition: `${d.malformedErrorEntries} malformed errors[] member(s)` };
  // HTTP-level failure first: 5xx / no response / a 200 whose body is not JSON.
  if (d.status === 0 || d.status >= 500 || (d.status === 200 && !d.jsonParseable)) {
    const bodyEmptyOrNonJson = d.bodyText.trim() === "" || !d.jsonParseable;
    return {
      kind: "http-failure",
      fivexxSplitCandidate: cfg.t1.splitTriggers.consecutive5xx.statuses.includes(d.status) && bodyEmptyOrNonJson,
      rawCondition: `HTTP ${d.status}${d.jsonParseable ? "" : " non-JSON body"}`,
    };
  }
  // throttle semantics next (classifyGraphql already ran): primary/secondary/RATE_LIMITED body
  if (d.classification === "primary") return { kind: "throttle-retry", cause: "primary" };
  if (d.errors.some((e) => e.type === "RATE_LIMITED")) return { kind: "throttle-retry", cause: "rate-limited-body" };
  if (d.classification === "secondary") return { kind: "throttle-retry", cause: "secondary" };
  if (d.classification === "transient")
    return { kind: "http-failure", fivexxSplitCandidate: false, rawCondition: `transient classification at HTTP ${d.status}` };
  if (d.status !== 200)
    return { kind: "default-failure", rawCondition: `unhandled HTTP ${d.status} (classification ${d.classification})` };

  // pathless / unattributable errors: TIMEOUT-shaped → the split path; anything else → the
  // closed default clause (whole-batch attempt failure), even beside readable data.
  const aliasCount = batch.entries.length;
  const attributed = new Map<number, Array<{ type: string | null; message: string | null }>>();
  for (const e of d.errors) {
    const idx = aliasIndexFromPath(e.path, aliasCount);
    if (idx === null) {
      if (isTimeoutError(e)) return { kind: "batch-timeout" };
      return { kind: "default-failure", rawCondition: `pathless/batch-global error ${e.type ?? "?"}: ${(e.message ?? "").slice(0, 200)}` };
    }
    const list = attributed.get(idx) ?? [];
    list.push({ type: e.type, message: e.message });
    attributed.set(idx, list);
  }

  const repo = d.data?.["repository"];
  const repoObj = typeof repo === "object" && repo !== null && !Array.isArray(repo) ? (repo as Record<string, unknown>) : null;
  const outcomes: AliasOutcome[] = [];
  const conflicts: number[] = [];
  for (let i = 0; i < aliasCount; i++) {
    const entry = batch.entries[i]!;
    const aliasRaw = repoObj?.[`a${i}`];
    const errs = attributed.get(i);
    const hasData = aliasRaw !== undefined && aliasRaw !== null;
    if (hasData && errs !== undefined) conflicts.push(i); // treated as errored, conflict recorded
    if (hasData && errs === undefined) {
      outcomes.push(validateAlias(i, aliasRaw, entry, objectFormat));
      continue;
    }
    if (errs !== undefined) {
      if (errs.some(isTimeoutError)) {
        outcomes.push({ kind: "timeout", index: i });
      } else if (errs.every((e) => e.type === "NOT_FOUND")) {
        outcomes.push({ kind: "missing", index: i }); // tree-listed but reported absent
      } else {
        // an attributed error of any OTHER type is the closed default — a whole-batch attempt
        // failure, never a permitted absence (codex R1 finding 5)
        return { kind: "default-failure", rawCondition: `alias a${i} errored ${errs.map((e) => e.type ?? "?").join(",")}` };
      }
      continue;
    }
    // aliasRaw === null with no error: the expression resolved to nothing — reported absent
    if (aliasRaw === null) {
      outcomes.push({ kind: "missing", index: i });
      continue;
    }
    outcomes.push({ kind: "unattributed", index: i });
  }
  return { kind: "per-alias", outcomes, conflicts };
}

// per-alias validation (ADR Decision cost #7): __typename Blob, oid echo, byteSize agreement,
// non-null non-truncated text whose UTF-8 length AND git blob hash both match the tree oid.
function validateAlias(index: number, raw: unknown, entry: WorkloadEntry, format: BenchObjectFormat): AliasOutcome {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { kind: "validation-fallback", index, reason: "alias payload is not an object" };
  const o = raw as Record<string, unknown>;
  if (o["__typename"] !== "Blob") return { kind: "validation-fallback", index, reason: `typename ${String(o["__typename"])}` };
  if (o["oid"] !== entry.blobOid) return { kind: "validation-fallback", index, reason: "oid mismatch" };
  if (o["byteSize"] !== entry.size) return { kind: "validation-fallback", index, reason: "byteSize mismatch" };
  // OBSERVED routing states, in the §4.3 vocabulary's own routes (never pre-routed from pins):
  if (o["isTruncated"] === true) return { kind: "truncated-blob-fallback", index };
  const text = o["text"];
  if (o["isBinary"] === true || text === null) return { kind: "binary-fallback", index };
  if (typeof text !== "string") return { kind: "validation-fallback", index, reason: "text non-string" };
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength !== entry.size) return { kind: "validation-fallback", index, reason: "utf8 length != byteSize" };
  if (gitBlobOid(bytes, format) !== entry.blobOid) return { kind: "validation-fallback", index, reason: "blob hash mismatch" };
  return { kind: "resolved", index, text };
}

// ---- splitting -------------------------------------------------------------------------------
// Binary split with descendant depth ≤ maxDepth and ≤ maxDescendantsPerOriginal per ORIGINAL
// batch, every dispatch drawing from the same shared attempt total (the driver enforces both
// budgets; this helper only halves).
export function splitEntries(entries: readonly WorkloadEntry[]): [WorkloadEntry[], WorkloadEntry[]] {
  if (entries.length < 2) throw new BenchT1Error("cannot split a singleton batch");
  const mid = Math.ceil(entries.length / 2);
  return [entries.slice(0, mid), entries.slice(mid)];
}

// the pinned 5xx split-trigger condition: N consecutive qualifying failures on a batch at
// ≥ the utilisation floor of EITHER admission cap (alias count or query bytes), §4.4.
export function fivexxSplitConditionMet(batch: PlannedBatch, consecutiveQualifying5xx: number, cfg: BenchConfig): boolean {
  if (consecutiveQualifying5xx < cfg.t1.splitTriggers.consecutive5xx.count) return false;
  const floor = cfg.t1.splitTriggers.consecutive5xx.capUtilisationFloor;
  return (
    batch.entries.length >= floor * cfg.t1.aliasCap ||
    batch.queryBytes >= floor * cfg.t1.queryDocBytesCap
  );
}
