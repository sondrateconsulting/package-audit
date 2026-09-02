// benchT1.ts — Option 1's driver planning + response transition table, PURE (resolution plan
// §4.4). Two-round dispatch exactly as the production design forces (round 1: manifests +
// CLI-classifiable paths, knowable from the tree alone; round 2: source + lockfiles),
// deterministic halving-based contiguous batch packing under the four preregistered caps,
// variable-bound query construction (never string interpolation — a legal path may contain
// quotes/backslashes/newlines, ADR §7), and an EXHAUSTIVE response transition table with a
// closed default — every observed response is classified through the preregistered table,
// with no discretionary post-hoc classes. The driver loop (benchDrivers) consumes these
// outcomes; everything here is CI-tested without a network.

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
// lockfiles (ADR "Rounds"). Pre-routing covers ONLY what the tree alone knows: symlinks (mode
// 120000) and content-cap singletons (ls-tree size above the per-batch content cap). Those never
// enter a batch — they go straight to the REST fallback lane with their pinned cause. Binary and
// truncated-blob are NOT pre-routed: GitHub's isBinary/isTruncated/text judgment is DISCOVERED in
// the timed GraphQL response and routed afterward (see the alias-outcome walk below).
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
  // graphql argv). This is a PREREGISTERED ADMISSION cap on the serialized argv PAYLOAD — a
  // deliberately conservative proxy for E2BIG, not kernel-accurate accounting: argv[0], the fixed
  // `api -i graphql` prefix, per-argument NUL terminators, the pointer array and the environment
  // block all sit outside it. The threshold, THIS byte-accounting rule, and the resulting
  // batch-size vector are all part of the ratified measurement surface (split-trigger geometry
  // depends on the vector), so none of them may change post-ratification without a §8 amendment.
  // ONE "-f" precedes the query field, exactly as github.ts/benchGh.ts build the argv and as the
  // paragraph above already describes; this counted two and overstated every batch by 2 B. The
  // amendment recorded for it ("argv field-flag accounting correction" in ratification.json)
  // shows the vector cannot move. Batch growth stops at whichever of the four caps binds first —
  // in this corpus that is often the CONTENT cap, not the alias cap: the round-level candidate
  // (up to 250 entries — planRounds partitions before packing, so C1's round-2 candidates run
  // 210-218 entries) exceeds the 1,572,864 B content cap in several committed workloads. At the
  // 250-alias
  // boundary-probe rows queryBytes is 28,530 B, under the 48 KiB document cap, so THAT cap is not
  // co-binding there. Among the RECORDED rows respecting the alias and document caps, the largest
  // argvBytes is 53,304 B under THIS formula (boundary-probe.json records 53,306 B for that row,
  // measured under the old one), i.e. 77,768 B clear of this 128 KiB cap. That is the recorded
  // maximum, not a proven bound over every constructible batch.
  let argvBytes = Buffer.byteLength(`query=${query}`, "utf8") + "-f".length;
  for (const [k, v] of Object.entries(fields)) argvBytes += Buffer.byteLength(`${k}=${v}`, "utf8") + "-f".length;
  const contentEstimateBytes = entries.reduce((n, e) => n + e.size, 0);
  return { label: opts.label, entries: [...entries], query, fields, queryBytes, argvBytes, contentEstimateBytes };
}

// Contiguous packing under ALL FOUR caps (alias count, content estimate, query-document bytes,
// argv bytes) by HALVING an oversized candidate window — deterministic and preregistered, but
// NOT maximal-greedy: a halved window can under-fill relative to the largest fitting prefix,
// and the resulting batch-size vector is part of the frozen behavior (split-trigger geometry
// depends on it), so it must not be "optimised" post-ratification. An entry that alone violates
// a byte cap is impossible here (content-cap singletons were pre-routed; a single path cannot
// overflow the 48 KiB document).
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
      kind: "http-failure"; // 5xx / no HTTP response / non-JSON-object body → whole-batch attempt failure
      fivexxSplitCandidate: boolean; // status ∈ pinned {502,503,504} with empty or non-JSON-object body
      rawCondition: string;
    }
  | { kind: "throttle-retry"; cause: "primary" | "secondary" | "rate-limited-body" } // whole-batch backoff retry
  | { kind: "batch-timeout" } // pathless TIMEOUT-type/-message error → split trigger evaluation
  | { kind: "default-failure"; rawCondition: string } // the CLOSED default clause
  | { kind: "per-alias"; outcomes: AliasOutcome[]; conflicts: number[] };

// STRICT attribution: the query's structure is exactly `repository.a<i>`, so only a path of
// that shape names an alias. Scanning every segment for anything alias-shaped accepted
// ["rateLimit","a0"] (a different subtree) and ["repository","a00"] (a DIFFERENT alias name —
// leading zeros never occur in generated names) as alias 0, misrouting another alias's error.
// Anything else is unattributable and takes the closed default via the caller's null branch.
const aliasIndexFromPath = (path: ReadonlyArray<string | number> | null, aliasCount: number): number | null => {
  // EXACTLY two segments: a deeper path (["repository","a0","text"]) names a subfield, and the
  // ratified strictness rationale is that only the alias-level shape is attributable — anything
  // else takes the closed default via the caller's null branch
  if (path === null || path.length !== 2 || path[0] !== "repository" || typeof path[1] !== "string") return null;
  const m = /^a(0|[1-9]\d*)$/.exec(path[1]);
  if (m === null) return null;
  const idx = Number(m[1]);
  return idx < aliasCount ? idx : null;
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
  // gh exits 1 BY DESIGN after a COMPLETE HTTP-200 envelope whose body carries errors[] — and
  // on every non-2xx status (github.ts documents exactly this at its graphql() attempt loop,
  // and deliberately avoids a broad nonzero-exit guard there because it would blind-retry real
  // throttles). An earlier fix here WAS that broad guard: it preempted the entire transition
  // table for exactly the envelopes the table exists to classify — a 200-with-TIMEOUT never
  // split, RATE_LIMITED never took the throttle path, and 502/503/504 (gh exit 1) could never
  // arm the 5xx split trigger. The exit code is transport-failure evidence only where the
  // parsed response does not already explain it: a SUCCESS-shaped 200 (parseable, no errors)
  // from a gh that failed is a truncated/poisoned transfer — the original finding the removed
  // guard was written for — and stays a whole-batch http-failure.
  if (d.exitCode !== 0 && d.status === 200 && d.jsonParseable && d.errors.length === 0 && d.malformedErrorEntries === 0)
    return { kind: "http-failure", fivexxSplitCandidate: false, rawCondition: `gh exited ${d.exitCode} with a success-shaped 200 envelope` };
  // HTTP-level failure first: 5xx / no response / a 200 whose body is not a JSON OBJECT.
  // jsonParseable is false for an unparseable body AND for one that parses to a non-object root
  // ([], null, a bare string/number) — none of which can carry a GraphQL envelope. That is the
  // pinned `bodies: "empty-or-non-json-object"` condition, named precisely: the earlier
  // "non-JSON" wording described a narrower predicate than the one measured at pinning.
  if (d.status === 0 || d.status >= 500 || (d.status === 200 && !d.jsonParseable)) {
    const bodyEmptyOrNonJsonObject = d.bodyText.trim() === "" || !d.jsonParseable;
    return {
      kind: "http-failure",
      fivexxSplitCandidate: cfg.t1.splitTriggers.consecutive5xx.statuses.includes(d.status) && bodyEmptyOrNonJsonObject,
      rawCondition: `HTTP ${d.status}${d.jsonParseable ? "" : " non-JSON-object body"}`,
    };
  }
  // throttle semantics next (classifyGraphql already ran): primary/secondary/RATE_LIMITED body.
  // NON-200 FATAL first — an SSO/permission 403 can carry a RATE_LIMITED body, and routing it
  // to the throttle path retried (and G4-counted) a condition production fails fast on; the
  // closed default bounds it by the attempt budget instead. Scoped to NON-200 statuses only:
  // production classifies EVERY 200 envelope carrying non-throttle errors[] as fatal (its own
  // design drops partial data), and an unscoped preempt dead-coded this table for exactly the
  // envelopes it exists to attribute — 200-with-TIMEOUT never split, alias NOT_FOUND never
  // took its fallback (the same table-preemption failure the exit-code guard had).
  if (d.classification === "fatal" && d.status !== 200)
    return { kind: "default-failure", rawCondition: `fatal classification at HTTP ${d.status} (e.g. SSO/permission enforcement) — never throttle-like` };
  if (d.classification === "primary") return { kind: "throttle-retry", cause: "primary" };
  if (d.errors.some((e) => e.type === "RATE_LIMITED")) return { kind: "throttle-retry", cause: "rate-limited-body" };
  if (d.classification === "secondary") return { kind: "throttle-retry", cause: "secondary" };
  if (d.classification === "transient")
    return { kind: "http-failure", fivexxSplitCandidate: false, rawCondition: `transient classification at HTTP ${d.status}` };
  if (d.status !== 200)
    return { kind: "default-failure", rawCondition: `unhandled HTTP ${d.status} (classification ${d.classification})` };

  // Malformed errors[] members carry no attributable signal — the closed default, never a silent
  // drop (codex R1 finding 5). It sits HERE, after every classification-derived branch, because
  // production's envelope contract makes `errors` and `malformed` INDEPENDENT (github.ts's
  // GraphqlEnvelope: "a consumer must classify off `errors` FIRST and treat `malformed` only as
  // 'do not accept as success', never as 'the errors are worthless'"), and production's graphql()
  // consults `malformed` only on the `ok` outcome. Preempting the whole table on it inverted that:
  // a readable RATE_LIMITED beside ONE junk sibling (errors:[null,{type:"RATE_LIMITED"}], or a
  // present message:null) took the closed default instead of the throttle path, turning a
  // secondary-limit condition into a permanent T1 driver failure — the transient-becomes-permanent
  // class again, from an ordering rather than a predicate. Every non-throttle outcome is unchanged:
  // a malformed 200 that classifies fatal, or carries no readable signal at all, still lands here.
  if (d.malformedErrorEntries > 0 && d.status === 200 && d.jsonParseable)
    return { kind: "default-failure", rawCondition: `${d.malformedErrorEntries} malformed errors[] member(s)` };
  // pathless / unattributable errors: collected FIRST, then classified as a set — returning on
  // the first member made the verdict order-dependent, so a recognized TIMEOUT could mask a
  // forbidden sibling that the closed default exists to catch (the same complete-set rule the
  // per-alias branch applies, codex R2 finding 12).
  const aliasCount = batch.entries.length;
  const attributed = new Map<number, Array<{ type: string | null; message: string | null }>>();
  const pathless: Array<{ type: string | null; message: string | null }> = [];
  for (const e of d.errors) {
    const idx = aliasIndexFromPath(e.path, aliasCount);
    if (idx === null) {
      pathless.push({ type: e.type, message: e.message });
      continue;
    }
    const list = attributed.get(idx) ?? [];
    list.push({ type: e.type, message: e.message });
    attributed.set(idx, list);
  }
  if (pathless.length > 0) {
    // the complete-set rule spans BOTH containers: a pathless all-TIMEOUT set must not mask an
    // attributed non-timeout sibling — this branch returns without ever running the per-alias
    // walk, so a forbidden alias error would ride a transient batch-timeout verdict into the
    // split/fallback path the closed default exists to deny (the same masking codex R2
    // finding 12 removed within each set)
    const attributedAll = [...attributed.values()].flat();
    const firstNonTimeout = pathless.find((e) => !isTimeoutError(e)) ?? attributedAll.find((e) => !isTimeoutError(e));
    if (firstNonTimeout === undefined) return { kind: "batch-timeout" };
    return { kind: "default-failure", rawCondition: `pathless/batch-global error set contains ${firstNonTimeout.type ?? "?"}: ${(firstNonTimeout.message ?? "").slice(0, 200)}` };
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
      // the COMPLETE attributed error set must belong to one permitted class — a recognized
      // member must not mask a forbidden sibling (codex R2 finding 12)
      if (errs.every(isTimeoutError)) {
        outcomes.push({ kind: "timeout", index: i });
      } else if (errs.every((e) => e.type === "NOT_FOUND")) {
        outcomes.push({ kind: "missing", index: i }); // tree-listed but reported absent
      } else {
        // any OTHER type — or a MIX of classes — is the closed default: a whole-batch attempt
        // failure, never a permitted absence (codex R1 finding 5, R2 finding 12)
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
