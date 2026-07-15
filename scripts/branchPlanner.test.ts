import { expect, test, describe } from "bun:test";
import { planRepoBranches, policyAttribution, classifyBranchPlan } from "./branchPlanner.ts";
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
