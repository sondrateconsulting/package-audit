import { expect, test, describe } from "bun:test";
import { computePolicyWarnings, isEmptyAllowlist, policyWarningLines, type PolicyWarning } from "./policyWarnings.ts";
import { compileBranchPolicy, type RepoPolicyCoverage } from "./branchPolicy.ts";

// One repo's coverage. `excludeNonDefault` defaults to excludeBranches — i.e. every deny match
// landed on a NON-default branch, the ordinary case — so a test that only cares about unmatched
// detection reads the same as before and never trips the default-only-deny predicate. The
// default-only tests below pass it explicitly.
const cov = (branches: string[], excludeBranches: string[], excludeNonDefault: string[] = excludeBranches): RepoPolicyCoverage =>
  ({ branches, excludeBranches, excludeBranchesMatchedByNonDefault: excludeNonDefault });

describe("isEmptyAllowlist", () => {
  test("branches:[] → true; branches:null (unrestricted) → false; non-empty → false", () => {
    expect(isEmptyAllowlist(compileBranchPolicy([], []))).toBe(true);
    expect(isEmptyAllowlist(compileBranchPolicy(null, []))).toBe(false);
    expect(isEmptyAllowlist(compileBranchPolicy(["main"], []))).toBe(false);
  });
});

describe("computePolicyWarnings (pure set algebra)", () => {
  test("SUPPRESSED entirely when zero repos discovered (empty coverages)", () => {
    const p = compileBranchPolicy(null, ["never-matches"]);
    expect(computePolicyWarnings(p, [])).toEqual([]);
  });
  test("a deny pattern that matched nothing → one deny warning", () => {
    const p = compileBranchPolicy(null, ["release/*", "hotfix"]);
    expect(computePolicyWarnings(p, [cov([], ["hotfix"])])).toEqual([
      { kind: "unmatched-pattern", direction: "deny", pattern: "release/*" },
    ]);
  });
  test("an allow pattern that matched nothing → one allow warning; coverage unioned across repos", () => {
    const p = compileBranchPolicy(["main", "dev", "qa"], []);
    // repo A matched 'main', repo B matched 'dev'; 'qa' matched nowhere
    expect(computePolicyWarnings(p, [cov(["main"], []), cov(["dev"], [])])).toEqual([
      { kind: "unmatched-pattern", direction: "allow", pattern: "qa" },
    ]);
  });
  test("deterministic order: deny patterns before allow, each in compiled-list order — NOT Set order", () => {
    const p = compileBranchPolicy(["a", "b"], ["x", "y"]);
    expect(computePolicyWarnings(p, [cov([], [])])).toEqual([
      { kind: "unmatched-pattern", direction: "deny", pattern: "x" },
      { kind: "unmatched-pattern", direction: "deny", pattern: "y" },
      { kind: "unmatched-pattern", direction: "allow", pattern: "a" },
      { kind: "unmatched-pattern", direction: "allow", pattern: "b" },
    ]);
  });
  test("the SAME pattern in both lists yields TWO direction-specific warnings", () => {
    const p = compileBranchPolicy(["shared"], ["shared"]);
    expect(computePolicyWarnings(p, [cov([], [])])).toEqual([
      { kind: "unmatched-pattern", direction: "deny", pattern: "shared" },
      { kind: "unmatched-pattern", direction: "allow", pattern: "shared" },
    ]);
  });
  test("no warnings when every pattern matched a branch it could act on", () => {
    const p = compileBranchPolicy(["main"], ["wip/*"]);
    expect(computePolicyWarnings(p, [cov(["main"], ["wip/*"])])).toEqual([]);
  });
  test("an unrestricted include (null) never yields allow warnings", () => {
    const p = compileBranchPolicy(null, ["deny-me"]);
    expect(computePolicyWarnings(p, [cov([], [])])).toEqual([
      { kind: "unmatched-pattern", direction: "deny", pattern: "deny-me" },
    ]);
  });

  // default-only-deny: the dead rule that MATCHED. Observed live — `excludeBranches: ["main"]` over a
  // 7-repo org excluded nothing on all 6 repos whose default is `main`, because the default is always
  // scanned. Without this the operator's only signal is a count they may not connect to the pattern.
  test("a deny pattern matching ONLY default branches → default-only-deny, never unmatched", () => {
    const p = compileBranchPolicy(null, ["main"]);
    expect(computePolicyWarnings(p, [cov([], ["main"], [])])).toEqual([
      { kind: "default-only-deny", pattern: "main" },
    ]);
  });
  test("GLOBAL, not per-repo: ONE non-default match anywhere makes the pattern live and silent", () => {
    const p = compileBranchPolicy(null, ["main"]);
    // repo A: 'main' hit only the default. repo B: a non-default branch is also named 'main'.
    expect(computePolicyWarnings(p, [cov([], ["main"], []), cov([], ["main"], ["main"])])).toEqual([]);
  });
  test("the two deny predicates are mutually exclusive — a pattern yields at most ONE warning", () => {
    const p = compileBranchPolicy(null, ["main", "gone"]);
    // Emission follows the COMPILED canonical order (sortedDedup: 'gone' < 'main'), not config order.
    expect(computePolicyWarnings(p, [cov([], ["main"], [])])).toEqual([
      { kind: "unmatched-pattern", direction: "deny", pattern: "gone" },
      { kind: "default-only-deny", pattern: "main" },
    ]);
  });
  test("default-only-deny keeps canonical deny order and still precedes allow warnings", () => {
    const p = compileBranchPolicy(["nope"], ["x", "y"]);
    expect(computePolicyWarnings(p, [cov([], ["x", "y"], ["y"])])).toEqual([
      { kind: "default-only-deny", pattern: "x" },
      { kind: "unmatched-pattern", direction: "allow", pattern: "nope" },
    ]);
  });
  test("an ALLOW pattern matching only defaults is NOT warned (it is not a deny; it restricts nothing)", () => {
    const p = compileBranchPolicy(["main"], []);
    expect(computePolicyWarnings(p, [cov(["main"], [], [])])).toEqual([]);
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
  test("default-only-deny explains WHY it did nothing, and does not claim the pattern caused an override", () => {
    const lines = policyWarningLines([{ kind: "default-only-deny", pattern: "main" }]);
    expect(lines[1]).toBe(
      '    deny pattern "main" matched only discovered default branches — the default branch is always scanned, so it excluded nothing',
    );
  });
});
