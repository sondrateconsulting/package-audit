// benchT1.test.ts — CI tests for T1's pure planning + the §4.4 exhaustive transition table.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadBenchConfig } from "./benchConfig.ts";
import { gitBlobOid, type BenchGraphqlDispatch } from "./benchGh.ts";
import {
  BenchT1Error, analyzeBatchResponse, buildBatchQuery, fivexxSplitConditionMet,
  packBatches, planRounds, splitEntries,
} from "./benchT1.ts";
import { buildUnitWorkload, seamStringSha256, type WorkloadEntry } from "./benchWorkload.ts";

const CFG = loadBenchConfig(join(import.meta.dir, "..", "docs", "adrs", "0001-benchmark", "bench-config.json"));
const sha = (c: string): string => c.repeat(40);

const entry = (path: string, over: Partial<WorkloadEntry> = {}): WorkloadEntry => ({
  path, mode: "100644", blobOid: sha("c"), size: 10, class: "source", read: true, noReadReason: null,
  canonicalSeamSha256: seamStringSha256("x"), rawSha256: seamStringSha256("x"),
  restDerefSeamSha256: null, checkoutSeamSha256: seamStringSha256("co"),
  gql: { isBinary: false, isTruncated: false, textNull: false },
  ...over,
});

describe("planRounds", () => {
  const workload = buildUnitWorkload({
    unit: "C2:o/r@main", sha: sha("0"), treeOid: sha("f"), objectFormat: "sha1",
    generatedAtIso: "2026-07-28T00:00:00Z", truncatedTree: false, escapeTripped: false,
    batchContentBytesCap: CFG.t1.batchContentBytesCap,
    entries: [
      entry("package.json", { class: "manifest" }),
      entry("run.sh", { class: "cli" }),
      entry("src/a.ts", { class: "source" }),
      entry("package-lock.json", { class: "lockfile" }),
      entry("link", { mode: "120000", restDerefSeamSha256: seamStringSha256("deref"), gql: null }),
      entry("img.png", { gql: { isBinary: true, isTruncated: false, textNull: true } }),
      entry("pkg/bun.lockb", { class: "lockfile", read: false, noReadReason: "binary-lockfile-skip", canonicalSeamSha256: null, rawSha256: null, checkoutSeamSha256: null, gql: null }),
    ],
  });
  test("two-round shape; ONLY tree-knowable facts pre-route (binary/truncated are response-discovered)", () => {
    const plan = planRounds(workload);
    expect(plan.round1.map((e) => e.path)).toEqual(["package.json", "run.sh"]);
    // img.png batches like any blob — its binary state is DISCOVERED in the response, never
    // read off the pinned expectation (the pin is ground truth, not a runtime oracle)
    expect(plan.round2.map((e) => e.path)).toEqual(["src/a.ts", "package-lock.json", "img.png"]);
    expect(plan.preRouted.map((p) => [p.entry.path, p.route])).toEqual([
      ["link", "symlink-fallback"],
    ]);
  });
  test("a lone entry above the content cap pre-routes as content-cap-singleton (tree-knowable)", () => {
    const big = buildUnitWorkload({
      unit: "C2:o/r@main", sha: sha("0"), treeOid: sha("f"), objectFormat: "sha1",
      generatedAtIso: "2026-07-28T00:00:00Z", truncatedTree: false, escapeTripped: false,
      batchContentBytesCap: CFG.t1.batchContentBytesCap,
      entries: [entry("huge.lock", { class: "lockfile", size: 2_000_000 })],
    });
    expect(planRounds(big).preRouted).toEqual([
      { entry: big.entries[0]!, route: "content-cap-singleton" },
    ]);
  });
});

describe("query construction + packing", () => {
  test("paths ride VARIABLES, never the query document (quotes/newlines cannot inject)", () => {
    const hostile = entry('a"b\\c\nnewline.ts');
    const batch = buildBatchQuery([hostile], {
      owner: "o", repo: "r", sha: sha("0"),
      aliasSelection: CFG.t1.aliasSelection, rateLimitRider: CFG.t1.rateLimitRider, label: "t.b0",
    });
    expect(batch.query).not.toContain("newline");
    expect(batch.query).toContain("a0:object(expression: $v0)");
    expect(batch.query).toContain(CFG.t1.rateLimitRider);
    expect(batch.fields["v0"]).toBe(`${sha("0")}:${hostile.path}`);
  });
  test("packing respects the alias cap and the per-batch content estimate", () => {
    const many = Array.from({ length: 600 }, (_, i) => entry(`f${i}.ts`));
    const batches = packBatches(many, CFG, { owner: "o", repo: "r", sha: sha("0"), roundLabel: "r2" });
    expect(batches.length).toBeGreaterThanOrEqual(3); // 600 / 250 cap
    for (const b of batches) {
      expect(b.entries.length).toBeLessThanOrEqual(CFG.t1.aliasCap);
      expect(b.queryBytes).toBeLessThanOrEqual(CFG.t1.queryDocBytesCap);
      expect(b.argvBytes).toBeLessThanOrEqual(CFG.t1.argvBytesCap);
    }
    expect(batches.flatMap((b) => b.entries.map((e) => e.path))).toEqual(many.map((e) => e.path)); // contiguous, complete
    const big = [entry("big1", { size: 1_000_000 }), entry("big2", { size: 1_000_000 }), entry("big3", { size: 1_000_000 })];
    const byContent = packBatches(big, CFG, { owner: "o", repo: "r", sha: sha("0"), roundLabel: "r2" });
    expect(byContent.length).toBeGreaterThanOrEqual(2); // 3 MB does not fit the 1.5 MiB estimate cap
  });
});

// ---- the transition table --------------------------------------------------------------------
const TEXT = "hello t1\n";
const goodEntry = entry("good.ts", { blobOid: gitBlobOid(Buffer.from(TEXT, "utf8"), "sha1"), size: Buffer.byteLength(TEXT) });
const BATCH = buildBatchQuery([goodEntry, entry("other.ts")], {
  owner: "o", repo: "r", sha: sha("0"),
  aliasSelection: CFG.t1.aliasSelection, rateLimitRider: CFG.t1.rateLimitRider, label: "t.b0",
});
const dispatch = (over: Partial<BenchGraphqlDispatch>): BenchGraphqlDispatch => ({
  status: 200, exitCode: 0, headers: {}, bodyText: "{}", data: {}, errors: [], malformedErrorEntries: 0,
  jsonParseable: true, classification: "ok", secondaryLike: false, primaryUntilMs: null, pointsCost: 1,
  ...over,
});
const aliasPayload = (text: string | null, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  __typename: "Blob", oid: goodEntry.blobOid, byteSize: goodEntry.size,
  isBinary: false, isTruncated: false, text, ...over,
});

describe("analyzeBatchResponse — gh exit semantics (gh exits 1 BY DESIGN on errored envelopes)", () => {
  // github.ts documents at its graphql() loop: gh exits 1 after a COMPLETE HTTP-200 envelope
  // whose body carries errors[], and on every non-2xx status. A broad `exitCode !== 0 →
  // http-failure` guard therefore preempted the ENTIRE transition table for exactly the
  // envelopes it classifies. These drive the production exit values gh actually produces.
  test("a 200 envelope with a pathless TIMEOUT and gh exit 1 still takes the split path", () => {
    expect(analyzeBatchResponse(dispatch({ exitCode: 1, errors: [{ type: "TIMEOUT", message: null, path: null }] }), BATCH, "sha1", CFG))
      .toEqual({ kind: "batch-timeout" });
  });
  test("a 200 RATE_LIMITED body with gh exit 1 still takes the throttle path", () => {
    expect(analyzeBatchResponse(dispatch({ exitCode: 1, errors: [{ type: "RATE_LIMITED", message: "slow down", path: null }] }), BATCH, "sha1", CFG))
      .toEqual({ kind: "throttle-retry", cause: "rate-limited-body" });
  });
  test("a 503 with empty body and gh exit 1 still arms the pinned 5xx split candidate", () => {
    expect(analyzeBatchResponse(dispatch({ exitCode: 1, status: 503, bodyText: "", jsonParseable: false, classification: "transient" }), BATCH, "sha1", CFG))
      .toMatchObject({ kind: "http-failure", fivexxSplitCandidate: true });
  });
  test("a 200 with partial data + an alias-attributed error and gh exit 1 resolves per alias", () => {
    const a = analyzeBatchResponse(dispatch({
      exitCode: 1,
      data: { repository: { a0: aliasPayload(TEXT) } },
      errors: [{ type: "NOT_FOUND", message: "gone", path: ["repository", "a1"] }],
    }), BATCH, "sha1", CFG);
    expect(a).toMatchObject({ kind: "per-alias" });
    if (a.kind !== "per-alias") throw new Error("unreachable");
    expect(a.outcomes[0]).toMatchObject({ kind: "resolved" });
    expect(a.outcomes[1]).toMatchObject({ kind: "missing" });
  });
  test("a recognized pathless TIMEOUT cannot mask a forbidden sibling — order-independent closed default", () => {
    const timeoutThenUnknown = [{ type: "TIMEOUT", message: null, path: null }, { type: "SOME_NEW_TYPE", message: "??", path: null }];
    expect(analyzeBatchResponse(dispatch({ errors: timeoutThenUnknown }), BATCH, "sha1", CFG)).toMatchObject({ kind: "default-failure" });
    expect(analyzeBatchResponse(dispatch({ errors: [...timeoutThenUnknown].reverse() }), BATCH, "sha1", CFG)).toMatchObject({ kind: "default-failure" });
    expect(analyzeBatchResponse(dispatch({ errors: [{ type: "TIMEOUT", message: null, path: null }, { type: "TIMEOUT", message: null, path: null }] }), BATCH, "sha1", CFG)).toEqual({ kind: "batch-timeout" });
  });
  test("alias attribution is STRICT: wrong subtree and leading-zero names are unattributable, not alias 0", () => {
    // ["rateLimit","a0"] names a different subtree; "a00" is not a generated alias name — both
    // previously attributed to alias 0, misrouting another alias's error
    const wrongSubtree = analyzeBatchResponse(dispatch({ errors: [{ type: "NOT_FOUND", message: null, path: ["rateLimit", "a0"] }] }), BATCH, "sha1", CFG);
    expect(wrongSubtree).toMatchObject({ kind: "default-failure" });
    const leadingZero = analyzeBatchResponse(dispatch({ errors: [{ type: "NOT_FOUND", message: null, path: ["repository", "a00"] }] }), BATCH, "sha1", CFG);
    expect(leadingZero).toMatchObject({ kind: "default-failure" });
    const genuine = analyzeBatchResponse(dispatch({ data: { repository: { a0: aliasPayload(TEXT) } }, errors: [{ type: "NOT_FOUND", message: null, path: ["repository", "a1"] }] }), BATCH, "sha1", CFG);
    expect(genuine).toMatchObject({ kind: "per-alias" });
  });
  test("the original finding stays closed: a SUCCESS-shaped 200 from a failed gh is http-failure", () => {
    const a = analyzeBatchResponse(dispatch({ exitCode: 1, data: { repository: { a0: aliasPayload(TEXT), a1: aliasPayload(TEXT) } } }), BATCH, "sha1", CFG);
    expect(a).toMatchObject({ kind: "http-failure", fivexxSplitCandidate: false });
    if (a.kind !== "http-failure") throw new Error("unreachable");
    expect(a.rawCondition).toContain("success-shaped");
  });
});

describe("analyzeBatchResponse — exhaustive, closed-default", () => {
  test("HTTP-level failures: 5xx with empty/non-JSON body is the pinned split candidate", () => {
    const a = analyzeBatchResponse(dispatch({ status: 502, bodyText: "", jsonParseable: false, classification: "transient" }), BATCH, "sha1", CFG);
    expect(a).toMatchObject({ kind: "http-failure", fivexxSplitCandidate: true });
    const b = analyzeBatchResponse(dispatch({ status: 500, bodyText: "oops", jsonParseable: false, classification: "transient" }), BATCH, "sha1", CFG);
    expect(b).toMatchObject({ kind: "http-failure", fivexxSplitCandidate: false }); // 500 is not in the pinned {502,503,504}
    const c = analyzeBatchResponse(dispatch({ status: 200, bodyText: "<html>", jsonParseable: false }), BATCH, "sha1", CFG);
    expect(c).toMatchObject({ kind: "http-failure", fivexxSplitCandidate: false });
  });
  test("throttle semantics: primary pause, RATE_LIMITED body, secondary classification", () => {
    expect(analyzeBatchResponse(dispatch({ classification: "primary", primaryUntilMs: 99 }), BATCH, "sha1", CFG)).toEqual({ kind: "throttle-retry", cause: "primary" });
    expect(analyzeBatchResponse(dispatch({ errors: [{ type: "RATE_LIMITED", message: "slow down", path: null }] }), BATCH, "sha1", CFG)).toEqual({ kind: "throttle-retry", cause: "rate-limited-body" });
    expect(analyzeBatchResponse(dispatch({ classification: "secondary" }), BATCH, "sha1", CFG)).toEqual({ kind: "throttle-retry", cause: "secondary" });
  });
  test("pathless TIMEOUT (type or pinned message) → split path; pathless anything-else → closed default", () => {
    expect(analyzeBatchResponse(dispatch({ errors: [{ type: "TIMEOUT", message: null, path: null }] }), BATCH, "sha1", CFG)).toEqual({ kind: "batch-timeout" });
    expect(analyzeBatchResponse(dispatch({ errors: [{ type: null, message: "This may be the result of a timeout", path: null }] }), BATCH, "sha1", CFG)).toEqual({ kind: "batch-timeout" });
    expect(analyzeBatchResponse(dispatch({ errors: [{ type: "SOME_NEW_TYPE", message: "??", path: null }] }), BATCH, "sha1", CFG)).toMatchObject({ kind: "default-failure" });
  });
  test("per-alias resolution: valid data, validation failures, timeouts, absences, conflicts", () => {
    const d = dispatch({
      data: {
        repository: {
          a0: aliasPayload(TEXT),
          a1: null, // reported absent with no error → missing-alias
        },
      },
      errors: [],
    });
    const a = analyzeBatchResponse(d, BATCH, "sha1", CFG);
    if (a.kind !== "per-alias") throw new Error(`expected per-alias, got ${a.kind}`);
    expect(a.outcomes[0]).toEqual({ kind: "resolved", index: 0, text: TEXT });
    expect(a.outcomes[1]).toEqual({ kind: "missing", index: 1 });

    const bad = analyzeBatchResponse(
      dispatch({ data: { repository: { a0: aliasPayload(TEXT, { byteSize: 999 }), a1: aliasPayload(null, { oid: sha("c"), byteSize: 10 }) } } }),
      BATCH, "sha1", CFG,
    );
    if (bad.kind !== "per-alias") throw new Error("expected per-alias");
    expect(bad.outcomes[0]).toMatchObject({ kind: "validation-fallback", reason: "byteSize mismatch" });
    // observed text:null routes as the vocabulary's own binary-fallback, not a validation catch-all
    expect(bad.outcomes[1]).toEqual({ kind: "binary-fallback", index: 1 });
    const states = analyzeBatchResponse(
      dispatch({ data: { repository: { a0: aliasPayload(TEXT, { isTruncated: true }), a1: aliasPayload(null, { oid: sha("c"), byteSize: 10, isBinary: true }) } } }),
      BATCH, "sha1", CFG,
    );
    if (states.kind !== "per-alias") throw new Error("expected per-alias");
    expect(states.outcomes[0]).toEqual({ kind: "truncated-blob-fallback", index: 0 });
    expect(states.outcomes[1]).toEqual({ kind: "binary-fallback", index: 1 });

    const mixed = analyzeBatchResponse(
      dispatch({
        data: { repository: { a0: aliasPayload(TEXT) } },
        errors: [
          { type: "TIMEOUT", message: null, path: ["repository", "a1"] },
          { type: "NOT_FOUND", message: "could not resolve", path: ["repository", "a0"] }, // conflict with data
        ],
      }),
      BATCH, "sha1", CFG,
    );
    if (mixed.kind !== "per-alias") throw new Error("expected per-alias");
    expect(mixed.conflicts).toEqual([0]); // treated as errored, conflict recorded
    expect(mixed.outcomes[0]!.kind).toBe("missing"); // the error side wins
    expect(mixed.outcomes[1]).toEqual({ kind: "timeout", index: 1 });

    const nothing = analyzeBatchResponse(dispatch({ data: { repository: {} } }), BATCH, "sha1", CFG);
    if (nothing.kind !== "per-alias") throw new Error("expected per-alias");
    expect(nothing.outcomes.map((o) => o.kind)).toEqual(["unattributed", "unattributed"]);
  });
  test("attributed errors of any OTHER type hit the closed default; malformed members fail the batch", () => {
    const forbidden = analyzeBatchResponse(
      dispatch({ data: {}, errors: [{ type: "FORBIDDEN", message: "nope", path: ["repository", "a0"] }] }),
      BATCH, "sha1", CFG,
    );
    expect(forbidden).toMatchObject({ kind: "default-failure" }); // never a permitted absence
    const malformed = analyzeBatchResponse(dispatch({ malformedErrorEntries: 1 }), BATCH, "sha1", CFG);
    expect(malformed).toMatchObject({ kind: "default-failure" });
  });
  test("hash validation is real: a text whose blob hash mismatches the tree oid falls back", () => {
    const tampered = analyzeBatchResponse(
      dispatch({ data: { repository: { a0: aliasPayload("hello T1\n"), a1: aliasPayload(null) } } }),
      BATCH, "sha1", CFG,
    );
    if (tampered.kind !== "per-alias") throw new Error("expected per-alias");
    expect(tampered.outcomes[0]).toMatchObject({ kind: "validation-fallback", reason: "blob hash mismatch" });
  });
});

describe("split machinery", () => {
  test("splitEntries halves contiguously; singletons cannot split", () => {
    const five = [entry("a"), entry("b"), entry("c"), entry("d"), entry("e")];
    const [l, r] = splitEntries(five);
    expect(l.map((e) => e.path)).toEqual(["a", "b", "c"]);
    expect(r.map((e) => e.path)).toEqual(["d", "e"]);
    expect(() => splitEntries([entry("a")])).toThrow(BenchT1Error);
  });
  test("the pinned 5xx split condition needs BOTH the streak and ≥80% cap utilisation", () => {
    const smallBatch = buildBatchQuery([entry("a")], { owner: "o", repo: "r", sha: sha("0"), aliasSelection: CFG.t1.aliasSelection, rateLimitRider: CFG.t1.rateLimitRider, label: "s" });
    expect(fivexxSplitConditionMet(smallBatch, 2, CFG)).toBe(false); // tiny batch — never split on 5xx
    const bigBatch = buildBatchQuery(Array.from({ length: 200 }, (_, i) => entry(`f${i}`)), { owner: "o", repo: "r", sha: sha("0"), aliasSelection: CFG.t1.aliasSelection, rateLimitRider: CFG.t1.rateLimitRider, label: "b" });
    expect(fivexxSplitConditionMet(bigBatch, 1, CFG)).toBe(false); // streak not reached
    expect(fivexxSplitConditionMet(bigBatch, 2, CFG)).toBe(true); // 200 ≥ 0.8 × 250
  });
});

describe("analyzeBatchResponse — a failed subprocess is not data (santa round 4)", () => {
  // benchGraphqlDispatch records `gh`'s exit code, and the analyzer ignored it. A subprocess that
  // FAILED but happened to emit a parseable 200-shaped body therefore produced resolved aliases —
  // content accepted from a call that did not succeed. The exit code is now checked first.
  const TXT = "hello t1\n";
  const okEntry = entry("good.ts", { blobOid: gitBlobOid(Buffer.from(TXT, "utf8"), "sha1"), size: Buffer.byteLength(TXT) });
  const B = buildBatchQuery([okEntry], {
    owner: "o", repo: "r", sha: sha("0"),
    aliasSelection: CFG.t1.aliasSelection, rateLimitRider: CFG.t1.rateLimitRider, label: "x.b0",
  });
  test("a non-zero gh exit is an http-failure even when the body parses as a clean 200", () => {
    const good = dispatch({ data: { repository: { a0: aliasPayload(TXT) } } });
    // sanity: with exitCode 0 this exact body resolves
    expect(analyzeBatchResponse({ ...good, exitCode: 0 }, B, "sha1", CFG).kind).toBe("per-alias");
    // the ONLY difference is the subprocess exit code
    const failed = analyzeBatchResponse({ ...good, exitCode: 1 }, B, "sha1", CFG);
    expect(failed.kind).toBe("http-failure");
    if (failed.kind !== "http-failure") throw new Error("unreachable");
    expect(failed.rawCondition).toContain("exited 1");
    expect(failed.fivexxSplitCandidate).toBe(false); // not a 5xx shape — never a split trigger
  });
});
