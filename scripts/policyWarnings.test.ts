import { expect, test, describe } from "bun:test";
import { computeUnmatchedWarnings, isEmptyAllowlist, policyWarningLines, type PolicyWarning } from "./policyWarnings.ts";
import { compileBranchPolicy, type PolicyCoverage } from "./branchPolicy.ts";

const cov = (branches: string[], excludeBranches: string[]): PolicyCoverage => ({ branches, excludeBranches });

describe("isEmptyAllowlist (§8)", () => {
  test("branches:[] → true; branches:null (unrestricted) → false; non-empty → false", () => {
    expect(isEmptyAllowlist(compileBranchPolicy([], []))).toBe(true);
    expect(isEmptyAllowlist(compileBranchPolicy(null, []))).toBe(false);
    expect(isEmptyAllowlist(compileBranchPolicy(["main"], []))).toBe(false);
  });
});

describe("computeUnmatchedWarnings (§8 pure set-difference)", () => {
  test("SUPPRESSED entirely when zero repos discovered (empty coverages)", () => {
    const p = compileBranchPolicy(null, ["never-matches"]);
    expect(computeUnmatchedWarnings(p, [])).toEqual([]);
  });
  test("a deny pattern that matched nothing → one deny warning", () => {
    const p = compileBranchPolicy(null, ["release/*", "hotfix"]);
    expect(computeUnmatchedWarnings(p, [cov([], ["hotfix"])])).toEqual([
      { kind: "unmatched-pattern", direction: "deny", pattern: "release/*" },
    ]);
  });
  test("an allow pattern that matched nothing → one allow warning; coverage unioned across repos", () => {
    const p = compileBranchPolicy(["main", "dev", "qa"], []);
    // repo A matched 'main', repo B matched 'dev'; 'qa' matched nowhere
    expect(computeUnmatchedWarnings(p, [cov(["main"], []), cov(["dev"], [])])).toEqual([
      { kind: "unmatched-pattern", direction: "allow", pattern: "qa" },
    ]);
  });
  test("deterministic order: deny patterns before allow, each in compiled-list order — NOT Set order", () => {
    const p = compileBranchPolicy(["a", "b"], ["x", "y"]);
    expect(computeUnmatchedWarnings(p, [cov([], [])])).toEqual([
      { kind: "unmatched-pattern", direction: "deny", pattern: "x" },
      { kind: "unmatched-pattern", direction: "deny", pattern: "y" },
      { kind: "unmatched-pattern", direction: "allow", pattern: "a" },
      { kind: "unmatched-pattern", direction: "allow", pattern: "b" },
    ]);
  });
  test("the SAME pattern in both lists yields TWO direction-specific warnings", () => {
    const p = compileBranchPolicy(["shared"], ["shared"]);
    expect(computeUnmatchedWarnings(p, [cov([], [])])).toEqual([
      { kind: "unmatched-pattern", direction: "deny", pattern: "shared" },
      { kind: "unmatched-pattern", direction: "allow", pattern: "shared" },
    ]);
  });
  test("no unmatched when every pattern matched somewhere", () => {
    const p = compileBranchPolicy(["main"], ["wip/*"]);
    expect(computeUnmatchedWarnings(p, [cov(["main"], ["wip/*"])])).toEqual([]);
  });
  test("an unrestricted include (null) never yields allow warnings", () => {
    const p = compileBranchPolicy(null, ["deny-me"]);
    expect(computeUnmatchedWarnings(p, [cov([], [])])).toEqual([
      { kind: "unmatched-pattern", direction: "deny", pattern: "deny-me" },
    ]);
  });
});

describe("policyWarningLines (advisory summary rendering)", () => {
  test("empty → no lines (the whole section is omitted)", () => {
    expect(policyWarningLines([])).toEqual([]);
  });
  test("compact header + one line per warning; patterns rendered via JSON.stringify", () => {
    const warnings: PolicyWarning[] = [
      { kind: "empty-allowlist" },
      { kind: "unmatched-pattern", direction: "deny", pattern: 'weird"quote' },
    ];
    const lines = policyWarningLines(warnings);
    expect(lines[0]).toBe("  Branch-policy warnings: 2 (advisory)");
    expect(lines[1]).toContain("empty allowlist: only repository default branches are policy-eligible");
    expect(lines[2]).toContain('deny pattern "weird\\"quote" matched no discovered branch'); // quote escaped by JSON.stringify
  });
});
