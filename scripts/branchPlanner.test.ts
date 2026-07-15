import { expect, test, describe } from "bun:test";
import { planRepoBranches, planPolicyDiagnostics, policyAttribution, classifyBranchPlan, type RepoBranchPlan, type BranchDecision } from "./branchPlanner.ts";
import { compileBranchPolicy, PolicyMatchError, type PolicyResult, type CompiledPattern, type CompiledBranchPolicy } from "./branchPolicy.ts";
import type { BranchHead } from "./github.ts";

// A glob that THROWS at match time — compileBranchPolicy never produces one (no real pattern throws
// at Bun.Glob construction, and "[" merely returns false), so the fail-closed test injects one.
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

describe("planRepoBranches — policy is applied BEFORE cutoff/cap (§1/§12)", () => {
  test("no policy: matches the bare cutoff/cap split, policyExcluded empty", () => {
    const p = planRepoBranches(HEADS, unrestricted, "2024-01-01", 25, "main");
    expect(names(p.toScan)).toEqual(["main", "feat-a", "feat-b"]);
    expect(names(p.cutoffSkipped)).toEqual(["stale"]);
    expect(names(p.pastCap)).toEqual([]);
    expect(p.policyExcluded).toEqual([]);
    // every decision carries no-exclusion when the policy is unrestricted
    expect(p.toScan.every((d) => d.rawPolicyResult.kind === "no-exclusion")).toBe(true);
  });

  test("a DENIED newest non-default branch frees its cap slot for an allowed OLDER branch (the §12 proof)", () => {
    // cap = 1 non-default. Without policy, feat-a (newest non-default) would take the slot and feat-b
    // would be past-cap. Denying feat-a must instead admit feat-b — a denied branch consumes no slot.
    const policy = compileBranchPolicy(null, ["feat-a"]);
    const p = planRepoBranches(HEADS, policy, "2024-01-01", 1, "main");
    expect(names(p.toScan)).toEqual(["main", "feat-b"]); // feat-b PROMOTED into the freed slot
    expect(names(p.policyExcluded)).toEqual(["feat-a"]);
    expect(names(p.pastCap)).toEqual([]); // nothing stranded behind the cap
    expect(names(p.cutoffSkipped)).toEqual(["stale"]);
    expect(p.policyExcluded[0]!.rawPolicyResult).toEqual({ kind: "excluded-by-deny", matchedPattern: "feat-a" });
  });

  test("an allowlist (include) excludes every non-matching NON-default branch as excluded-by-allow", () => {
    const policy = compileBranchPolicy(["feat-a"], []); // only feat-a allowed (plus the default)
    const p = planRepoBranches(HEADS, policy, "2024-01-01", 25, "main");
    expect(names(p.toScan)).toEqual(["main", "feat-a"]); // default is always eligible
    // policy runs BEFORE cutoff, so stale (allow-missed) is policy-excluded, NOT cutoff-skipped — its
    // cutoff status is never evaluated once policy drops it (§1: cutoff/cap only over the eligible set).
    expect(names(p.policyExcluded)).toEqual(["feat-b", "stale"]);
    expect(p.policyExcluded.every((d) => d.rawPolicyResult.kind === "excluded-by-allow")).toBe(true);
    expect(names(p.cutoffSkipped)).toEqual([]);
  });

  test("the DEFAULT branch denied by policy STAYS eligible but records the counterfactual", () => {
    const policy = compileBranchPolicy(null, ["main", "feat-a"]); // deny includes the default
    const p = planRepoBranches(HEADS, policy, "2024-01-01", 25, "main");
    expect(names(p.toScan)).toContain("main"); // never dropped (Premise 6)
    const mainDecision = p.toScan.find((d) => d.head.name === "main")!;
    expect(mainDecision.isDefaultBranch).toBe(true);
    expect(mainDecision.rawPolicyResult).toEqual({ kind: "excluded-by-deny", matchedPattern: "main" }); // the "would have denied" fact
    expect(names(p.policyExcluded)).toEqual(["feat-a"]); // the non-default denied branch IS dropped
  });

  test("cutoff-skipped / past-cap decisions are always policy-eligible (no-exclusion)", () => {
    const policy = compileBranchPolicy(null, ["feat-b"]); // deny the oldest non-default
    const p = planRepoBranches(HEADS, policy, "2024-01-01", 25, "main");
    // feat-b denied → policyExcluded; stale still cutoff-skipped with no-exclusion
    expect(p.cutoffSkipped.every((d) => d.rawPolicyResult.kind === "no-exclusion")).toBe(true);
    expect(names(p.policyExcluded)).toEqual(["feat-b"]);
  });

  test("input (committed-date) order is preserved within every bucket — never re-sorted by name/pattern", () => {
    const policy = compileBranchPolicy(null, []);
    const p = planRepoBranches(HEADS, policy, "2024-01-01", 25, "main");
    expect(names(p.toScan)).toEqual(["main", "feat-a", "feat-b"]); // NOT alphabetized
  });

  test("a match-time glob throw propagates as PolicyMatchError (fail-closed) — never silently scans a denied branch", () => {
    // inject a throwing exclude glob (a real malformed pattern like "[" merely returns false in Bun)
    const policy = rawPolicy(null, [cp("boom*", throwingGlob(new Error("bad glob")))]);
    expect(() => planRepoBranches([head("x", "2025-01-01T00:00:00Z")], policy, "2024-01-01", 25, "main")).toThrow(PolicyMatchError);
  });

  test("classifyBranchPlan still exported for the §5.B cutoff/cap unit tests", () => {
    const p = classifyBranchPlan(HEADS, "2024-01-01", 25, "main");
    expect(p.eligible.map((h) => h.name)).toEqual(["main", "feat-a", "feat-b"]);
  });
});

describe("planRepoBranches — coverage sweep (§8/§12)", () => {
  test("coverage unions every pattern that matched ANY raw head; unmatched patterns are absent", () => {
    const policy = compileBranchPolicy(null, ["feat-a", "nope*"]); // deny feat-a; 'nope*' matches nothing
    const p = planRepoBranches(HEADS, policy, "2024-01-01", 25, "main");
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
    const p = planRepoBranches(heads, policy, "2024-01-01", 1, "main"); // cap=1 (non-default)
    expect(p.toScan.map((d) => d.head.name)).toEqual(["main", "recent1"]); // default + one slot
    expect(p.pastCap.map((d) => d.head.name)).toEqual(["recent2"]);
    expect(p.cutoffSkipped.map((d) => d.head.name)).toEqual(["stale"]);
    // the sweep runs over EVERY raw head regardless of bucket, so every allow pattern matched
    expect(p.coverage.branches.slice().sort()).toEqual(["main", "recent1", "recent2", "stale"]);
  });

  test("a SHADOWED malformed glob (never the winner, invoked ONLY by coverage) fails fast (§12)", () => {
    // deny ['main' exact, 'z*' throwing]. For head 'main' the winner is the exact 'main' — z* is never
    // invoked for classification — but the coverage sweep DOES call z*.match('main') and it throws.
    const policy = rawPolicy(null, [cp("main", new Bun.Glob("main")), cp("z*", throwingGlob(new Error("shadowed")))]);
    expect(() => planRepoBranches([head("main", "2025-01-01T00:00:00Z")], policy, "2024-01-01", 25, "main")).toThrow(PolicyMatchError);
  });
});

describe("planPolicyDiagnostics — §5 plan sub-counts (deny/allow split + default override)", () => {
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
    const p = planRepoBranches(heads, policy, "2024-01-01", 25, "main");
    expect(planPolicyDiagnostics(p)).toEqual({ excludedByDeny: 1, excludedByAllow: 1, defaultBranchPolicyOverrides: 1 });
  });

  test("an unrestricted policy yields all-zero diagnostics", () => {
    const p = planRepoBranches(HEADS, unrestricted, "2024-01-01", 25, "main");
    expect(planPolicyDiagnostics(p)).toEqual({ excludedByDeny: 0, excludedByAllow: 0, defaultBranchPolicyOverrides: 0 });
  });

  // fail-closed: the planner can never produce these, so hand-build the impossible plans directly.
  const emptyPlan: RepoBranchPlan = { toScan: [], cutoffSkipped: [], pastCap: [], policyExcluded: [], coverage: { branches: [], excludeBranches: [] } };
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
