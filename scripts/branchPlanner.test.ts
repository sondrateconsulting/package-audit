import { expect, test, describe } from "bun:test";
import { planRepoBranches, planPolicyDiagnostics, policyAttribution, classifyBranchPlan, type RepoBranchPlan, type BranchDecision } from "./branchPlanner.ts";
import { compileBranchPolicy, PolicyMatchError, type PolicyResult, type CompiledPattern, type CompiledBranchPolicy } from "./branchPolicy.ts";
import type { BranchHead, BranchSnapshot } from "./github.ts";

// A glob that THROWS at match time — compileBranchPolicy is not KNOWN to produce one (no accepted
// pattern is known to throw at .match() on the exercised Bun versions; "[" merely returns false in
// the pin below), so the fail-closed test injects one.
const throwingGlob = (thrown: unknown): Bun.Glob => ({ match() { throw thrown; } }) as unknown as Bun.Glob;
const cp = (pattern: string, glob: Bun.Glob): CompiledPattern => ({ pattern, glob });
const rawPolicy = (include: readonly CompiledPattern[] | null, exclude: readonly CompiledPattern[]): CompiledBranchPolicy => ({ include, exclude });

const head = (name: string, date: string): BranchHead => ({ name, oid: `oid-${name}`, committedDate: date, treeOid: `tree-${name}` });
// heads newest-first (as listBranchHeads supplies), all after the 2024-01-01 cutoff unless noted.
const HEADS = [
  head("main", "2025-06-01T00:00:00Z"),
  head("feat-a", "2025-05-01T00:00:00Z"),
  head("feat-b", "2025-04-01T00:00:00Z"),
  head("stale", "2023-01-01T00:00:00Z"), // before cutoff
];
const names = (ds: ReadonlyArray<{ head: BranchHead }>): string[] => ds.map((d) => d.head.name);
const unrestricted = compileBranchPolicy(null, []);
// A §5.B snapshot: heads + the default resolved from the SAME GraphQL response (github.ts::BranchSnapshot).
// The default is stated EXPLICITLY rather than inferred from the head list — inferring it (e.g. "the
// first head", or a hardcoded "main") is exactly what would hide a default-resolution defect.
const snap = (heads: readonly BranchHead[], defaultBranch: string | null): BranchSnapshot => ({ heads, defaultBranch });

describe("planRepoBranches — policy is applied BEFORE cutoff/cap", () => {
  test("no policy: matches the bare cutoff/cap split, policyExcluded empty", () => {
    const p = planRepoBranches(snap(HEADS, "main"), unrestricted, "2024-01-01", 25);
    expect(names(p.toScan)).toEqual(["main", "feat-a", "feat-b"]);
    expect(names(p.cutoffSkipped)).toEqual(["stale"]);
    expect(names(p.pastCap)).toEqual([]);
    expect(p.policyExcluded).toEqual([]);
    // every decision carries no-exclusion when the policy is unrestricted
    expect(p.toScan.every((d) => d.rawPolicyResult.kind === "no-exclusion")).toBe(true);
  });

  test("a DENIED newest non-default branch frees its cap slot for an allowed OLDER branch (the cap-slot proof)", () => {
    // cap = 1 non-default. Without policy, feat-a (newest non-default) would take the slot and feat-b
    // would be past-cap. Denying feat-a must instead admit feat-b — a denied branch consumes no slot.
    const policy = compileBranchPolicy(null, ["feat-a"]);
    const p = planRepoBranches(snap(HEADS, "main"), policy, "2024-01-01", 1);
    expect(names(p.toScan)).toEqual(["main", "feat-b"]); // feat-b PROMOTED into the freed slot
    expect(names(p.policyExcluded)).toEqual(["feat-a"]);
    expect(names(p.pastCap)).toEqual([]); // nothing stranded behind the cap
    expect(names(p.cutoffSkipped)).toEqual(["stale"]);
    expect(p.policyExcluded[0]!.rawPolicyResult).toEqual({ kind: "excluded-by-deny", matchedPattern: "feat-a" });
  });

  test("an allowlist (include) excludes every non-matching NON-default branch as excluded-by-allow", () => {
    const policy = compileBranchPolicy(["feat-a"], []); // only feat-a allowed (plus the default)
    const p = planRepoBranches(snap(HEADS, "main"), policy, "2024-01-01", 25);
    expect(names(p.toScan)).toEqual(["main", "feat-a"]); // default is always eligible
    // policy runs BEFORE cutoff, so stale (allow-missed) is policy-excluded, NOT cutoff-skipped — its
    // cutoff status is never evaluated once policy drops it (§1: cutoff/cap only over the eligible set).
    expect(names(p.policyExcluded)).toEqual(["feat-b", "stale"]);
    expect(p.policyExcluded.every((d) => d.rawPolicyResult.kind === "excluded-by-allow")).toBe(true);
    expect(names(p.cutoffSkipped)).toEqual([]);
  });

  test("an EMPTY allowlist (branches:[]) eliminates every non-default but KEEPS the default (always scanned)", () => {
    const policy = compileBranchPolicy([], []); // allow NOTHING
    const p = planRepoBranches(snap(HEADS, "main"), policy, "2024-01-01", 25);
    expect(names(p.toScan)).toEqual(["main"]); // ONLY the default survives
    expect(names(p.policyExcluded)).toEqual(["feat-a", "feat-b", "stale"]); // all non-defaults excluded-by-allow
    expect(p.policyExcluded.every((d) => d.rawPolicyResult.kind === "excluded-by-allow")).toBe(true);
    // the default carries the counterfactual (it too matched no allow entry)
    expect(p.toScan[0]!.rawPolicyResult.kind).toBe("excluded-by-allow");
  });

  test("the DEFAULT branch denied by policy STAYS eligible but records the counterfactual", () => {
    const policy = compileBranchPolicy(null, ["main", "feat-a"]); // deny includes the default
    const p = planRepoBranches(snap(HEADS, "main"), policy, "2024-01-01", 25);
    expect(names(p.toScan)).toContain("main"); // never dropped (the default is always scanned)
    const mainDecision = p.toScan.find((d) => d.head.name === "main")!;
    expect(mainDecision.isDefaultBranch).toBe(true);
    expect(mainDecision.rawPolicyResult).toEqual({ kind: "excluded-by-deny", matchedPattern: "main" }); // the "would have denied" fact
    expect(names(p.policyExcluded)).toEqual(["feat-a"]); // the non-default denied branch IS dropped
  });

  test("cutoff-skipped / past-cap decisions are always policy-eligible (no-exclusion)", () => {
    const policy = compileBranchPolicy(null, ["feat-b"]); // deny the oldest non-default
    const p = planRepoBranches(snap(HEADS, "main"), policy, "2024-01-01", 25);
    // feat-b denied → policyExcluded; stale still cutoff-skipped with no-exclusion
    expect(p.cutoffSkipped.every((d) => d.rawPolicyResult.kind === "no-exclusion")).toBe(true);
    expect(names(p.policyExcluded)).toEqual(["feat-b"]);
  });

  test("input (committed-date) order is preserved within every bucket — never re-sorted by name/pattern", () => {
    const policy = compileBranchPolicy(null, []);
    const p = planRepoBranches(snap(HEADS, "main"), policy, "2024-01-01", 25);
    expect(names(p.toScan)).toEqual(["main", "feat-a", "feat-b"]); // NOT alphabetized
  });

  test("a match-time glob throw propagates as PolicyMatchError (fail-closed) — never silently scans a denied branch", () => {
    // inject a throwing exclude glob (a real malformed pattern like "[" merely returns false in Bun)
    const policy = rawPolicy(null, [cp("boom*", throwingGlob(new Error("bad glob")))]);
    expect(() => planRepoBranches(snap([head("x", "2025-01-01T00:00:00Z")], "main"), policy, "2024-01-01", 25)).toThrow(PolicyMatchError);
  });

  test('a malformed pattern Bun ACCEPTS (deny "[") is NOT fatal: it matches nothing, denies nothing, and coverage reports it dead', () => {
    // Pins the OTHER half of the fail-closed contract's scope (branchPolicy.ts): the promise covers
    // globs that THROW at .match() time; "[" compiles and (as pinned here) matches neither the
    // default nor a feature head, so it must exclude nothing and land in NO coverage set — the advisory
    // unmatched-pattern warning is its surface.
    // Bun.Glob-VERSION-SENSITIVE (CI pins 1.3.14): if a Bun upgrade starts rejecting "[" at
    // construction, this test goes red so the load/validation story is re-decided consciously.
    const policy = compileBranchPolicy(null, ["["]);
    const p = planRepoBranches(snap([head("feature-x", "2025-01-01T00:00:00Z")], "main"), policy, "2024-01-01", 25);
    expect(names(p.toScan)).toEqual(["feature-x"]); // NOT denied — "[" matched nothing
    expect(p.policyExcluded).toEqual([]);
    expect(p.coverage.excludeBranches).toEqual([]); // "[" matched NO head → unmatched-pattern warning upstream
  });

  // The planner is the ONLY place a head's name and its default-ness are both in hand, so it is the
  // only place the non-default deny coverage can be collected (the default-only-deny warning's input).
  test("coverage splits deny matches into all-matches vs NON-DEFAULT matches", () => {
    const policy = compileBranchPolicy(null, ["main", "wip/*"]);
    const p = planRepoBranches(
      snap([head("main", "2025-01-01T00:00:00Z"), head("wip/x", "2025-01-02T00:00:00Z")], "main"),
      policy, "2024-01-01", 25,
    );
    // 'main' denied the DEFAULT (always scanned → excluded nothing); 'wip/*' denied a real branch.
    expect(names(p.toScan)).toEqual(["main"]);
    expect(names(p.policyExcluded)).toEqual(["wip/x"]);
    expect([...p.coverage.excludeBranches].sort()).toEqual(["main", "wip/*"]);
    expect(p.coverage.excludeBranchesMatchedByNonDefault).toEqual(["wip/*"]); // 'main' hit only the default
  });

  test("a deny pattern matching a NON-default branch of the same name IS non-default coverage", () => {
    // The predicate is about the branch's role, not its name: here 'main' is not the default.
    const policy = compileBranchPolicy(null, ["main"]);
    const p = planRepoBranches(
      snap([head("master", "2025-01-01T00:00:00Z"), head("main", "2025-01-02T00:00:00Z")], "master"),
      policy, "2024-01-01", 25,
    );
    expect(names(p.policyExcluded)).toEqual(["main"]);
    expect(p.coverage.excludeBranchesMatchedByNonDefault).toEqual(["main"]);
  });

  test("classifyBranchPlan still exported for the §5.B cutoff/cap unit tests", () => {
    const p = classifyBranchPlan(HEADS, "2024-01-01", 25, "main");
    expect(p.eligible.map((h) => h.name)).toEqual(["main", "feat-a", "feat-b"]);
  });

  // The snapshot invariant: heads + defaultBranch are a PAIR. listBranchHeads already rejects this
  // pairing, so reaching the planner with it means the two halves came from different sources — the
  // stale-epoch mistake BranchSnapshot exists to make unrepresentable. Refuse to plan rather than
  // silently exclude every branch (with no default, no head can win the always-eligible exemption).
  test("heads with a NULL default is refused (fail-closed) — never planned as 'nothing is default'", () => {
    const policy = compileBranchPolicy([], []); // branches:[] — the config that makes it catastrophic
    expect(() => planRepoBranches(snap(HEADS, null), policy, "2024-01-01", 25)).toThrow(/no default branch/);
  });

  test("heads with an OMITTED default key (undefined) is refused too — the guard is `== null`, loose", () => {
    // The shape this guard exists for is a hand-built double, and the commonest such shape is an
    // omitted key — `undefined`, not `null`. A strict `=== null` would MISS exactly the case it was
    // written for. Nothing downstream would catch it: `name === undefined` is false for every head, so
    // the classifier reads it as "not the default" and branches:[] excludes the whole repo silently.
    // The client stubs in orchestrate.test.ts are `as unknown as GithubClient`, which erases the return
    // type — tsc cannot flag such a double, so this guard is the only backstop.
    const doubleWithMissingKey = { heads: HEADS } as unknown as BranchSnapshot;
    expect(() => planRepoBranches(doubleWithMissingKey, compileBranchPolicy([], []), "2024-01-01", 25)).toThrow(/no default branch/);
  });

  test("the legitimate EMPTY snapshot (no heads, no default) plans to an empty result, not a throw", () => {
    const p = planRepoBranches(snap([], null), compileBranchPolicy([], []), "2024-01-01", 25);
    expect(p).toMatchObject({ toScan: [], cutoffSkipped: [], pastCap: [], policyExcluded: [] });
  });

  test("a default ABSENT from the heads still plans (no synthesis) — policy governs every live head", () => {
    // Not a throw here: listBranchHeads owns that rejection (it can see the wire response). The planner
    // only guards the pairing it can prove wrong on its own. With 'main' absent, no head is default.
    const p = planRepoBranches(snap([head("dev", "2025-05-01T00:00:00Z")], "main"), unrestricted, "2024-01-01", 25);
    expect(names(p.toScan)).toEqual(["dev"]);
    expect(p.toScan[0]!.isDefaultBranch).toBe(false);
  });
});

describe("planRepoBranches — coverage sweep", () => {
  test("coverage unions every pattern that matched ANY raw head; unmatched patterns are absent", () => {
    const policy = compileBranchPolicy(null, ["feat-a", "nope*"]); // deny feat-a; 'nope*' matches nothing
    const p = planRepoBranches(snap(HEADS, "main"), policy, "2024-01-01", 25);
    expect(p.coverage.excludeBranches).toEqual(["feat-a"]); // 'nope*' matched no head → absent
    expect(p.coverage.branches).toEqual([]); // unrestricted include
  });

  test("coverage includes a matched head from EVERY disposition bucket (default / to-scan / cutoff / past-cap)", () => {
    const heads = [
      head("main", "2025-06-01T00:00:00Z"),
      head("recent1", "2025-05-01T00:00:00Z"),
      head("recent2", "2025-04-01T00:00:00Z"),
      head("stale", "2023-01-01T00:00:00Z"),
    ];
    const policy = compileBranchPolicy(["main", "recent1", "recent2", "stale"], []); // allowlist = all four
    const p = planRepoBranches(snap(heads, "main"), policy, "2024-01-01", 1); // cap=1 (non-default)
    expect(p.toScan.map((d) => d.head.name)).toEqual(["main", "recent1"]); // default + one slot
    expect(p.pastCap.map((d) => d.head.name)).toEqual(["recent2"]);
    expect(p.cutoffSkipped.map((d) => d.head.name)).toEqual(["stale"]);
    // the sweep runs over EVERY raw head regardless of bucket, so every allow pattern matched
    expect(p.coverage.branches.slice().sort()).toEqual(["main", "recent1", "recent2", "stale"]);
  });

  test("a SHADOWED malformed glob (never the winner, invoked ONLY by coverage) fails fast", () => {
    // deny ['main' exact, 'z*' throwing]. For head 'main' the winner is the exact 'main' — z* is never
    // invoked for classification — but the coverage sweep DOES call z*.match('main') and it throws.
    const policy = rawPolicy(null, [cp("main", new Bun.Glob("main")), cp("z*", throwingGlob(new Error("shadowed")))]);
    expect(() => planRepoBranches(snap([head("main", "2025-01-01T00:00:00Z")], "main"), policy, "2024-01-01", 25)).toThrow(PolicyMatchError);
  });
});

describe("planPolicyDiagnostics — plan sub-counts (deny/allow split + default override)", () => {
  test("derives the deny/allow split and default-branch override from a real plan", () => {
    // allowlist keep/* + deny deny-me. main (default) is not allow-listed → override; deny-me → deny;
    // other → allow-miss; keep/a → eligible.
    const policy = compileBranchPolicy(["keep/*"], ["deny-me"]);
    const heads = [
      head("main", "2025-06-01T00:00:00Z"),
      head("deny-me", "2025-06-01T00:00:00Z"),
      head("other", "2025-06-01T00:00:00Z"),
      head("keep/a", "2025-05-01T00:00:00Z"),
    ];
    const p = planRepoBranches(snap(heads, "main"), policy, "2024-01-01", 25);
    expect(planPolicyDiagnostics(p)).toEqual({ excludedByDeny: 1, excludedByAllow: 1, defaultBranchPolicyOverrides: 1 });
  });

  test("an unrestricted policy yields all-zero diagnostics", () => {
    const p = planRepoBranches(snap(HEADS, "main"), unrestricted, "2024-01-01", 25);
    expect(planPolicyDiagnostics(p)).toEqual({ excludedByDeny: 0, excludedByAllow: 0, defaultBranchPolicyOverrides: 0 });
  });

  // fail-closed: the planner can never produce these, so hand-build the impossible plans directly.
  const emptyPlan: RepoBranchPlan = {
    toScan: [], cutoffSkipped: [], pastCap: [], policyExcluded: [],
    coverage: { branches: [], excludeBranches: [], excludeBranchesMatchedByNonDefault: [] },
  };
  const decision = (name: string, isDefaultBranch: boolean, rawPolicyResult: BranchDecision["rawPolicyResult"]): BranchDecision =>
    ({ head: head(name, "2025-06-01T00:00:00Z"), isDefaultBranch, rawPolicyResult });

  test("throws when policyExcluded carries a no-exclusion decision (bucket-wiring bug)", () => {
    const bad: RepoBranchPlan = { ...emptyPlan, policyExcluded: [decision("x", false, { kind: "no-exclusion" })] };
    expect(() => planPolicyDiagnostics(bad)).toThrow(/policyExcluded carries a default\/no-exclusion/);
  });

  test("throws when policyExcluded carries a default branch (a default is never excluded)", () => {
    const bad: RepoBranchPlan = { ...emptyPlan, policyExcluded: [decision("main", true, { kind: "excluded-by-deny", matchedPattern: "main" })] };
    expect(() => planPolicyDiagnostics(bad)).toThrow(/policyExcluded carries a default\/no-exclusion/);
  });

  test("throws when a NON-default scanned (toScan) branch carries a policy exclusion (only the default may override)", () => {
    const bad: RepoBranchPlan = { ...emptyPlan, toScan: [decision("feat", false, { kind: "excluded-by-deny", matchedPattern: "feat" })] };
    expect(() => planPolicyDiagnostics(bad)).toThrow(/non-default toScan branch/);
  });
});

describe("policyAttribution — RAW policy → persisted (status, pattern) pair (§3)", () => {
  test("excluded-by-deny carries the matched pattern", () => {
    const r: PolicyResult = { kind: "excluded-by-deny", matchedPattern: "release/*" };
    expect(policyAttribution(r)).toEqual({ policyStatus: "excluded-by-deny", policyMatchedPattern: "release/*" });
  });
  test("excluded-by-allow carries a null pattern", () => {
    expect(policyAttribution({ kind: "excluded-by-allow" })).toEqual({ policyStatus: "excluded-by-allow", policyMatchedPattern: null });
  });
  test("no-exclusion carries neither", () => {
    expect(policyAttribution({ kind: "no-exclusion" })).toEqual({ policyStatus: null, policyMatchedPattern: null });
  });
});
