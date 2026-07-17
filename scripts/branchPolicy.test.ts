import { expect, test, describe } from "bun:test";
import {
  compileBranchPolicy, BranchPolicyError, PolicyMatchError, evaluateBranchPolicy, classifyBranch,
  isBranchPolicyEligible, coverageForName, patternMatchesBranch, type CompiledPattern, type CompiledBranchPolicy,
} from "./branchPolicy.ts";

const names = (list: readonly CompiledPattern[] | null): string[] | null =>
  list === null ? null : list.map((c) => c.pattern);

// A CompiledPattern whose glob THROWS at match time. compileBranchPolicy is not KNOWN to produce
// one (no accepted pattern is known to throw at .match() on the Bun versions this project
// exercises), so fail-closed tests build these by hand.
const throwingGlob = (thrown: unknown): Bun.Glob =>
  ({ match() { throw thrown; } }) as unknown as Bun.Glob;
const cp = (pattern: string, glob: Bun.Glob): CompiledPattern => ({ pattern, glob });
// Hand-build a policy so tests can inject throwing globs and control canonical order directly.
const policy = (
  include: readonly CompiledPattern[] | null,
  exclude: readonly CompiledPattern[],
): CompiledBranchPolicy => ({ include, exclude });

describe("compileBranchPolicy — structure + null/[] distinction", () => {
  test("include null stays null (unrestricted); exclude is always a list", () => {
    const p = compileBranchPolicy(null, []);
    expect(p.include).toBeNull();
    expect(p.exclude).toEqual([]);
  });
  test("include [] compiles to an empty list (distinct from null)", () => {
    const p = compileBranchPolicy([], []);
    expect(p.include).toEqual([]);
    expect(p.include).not.toBeNull();
  });
  test("each entry pairs the pattern string with a compiled Bun.Glob", () => {
    const p = compileBranchPolicy(["main"], ["dependabot/*"]);
    expect(names(p.include)).toEqual(["main"]);
    expect(names(p.exclude)).toEqual(["dependabot/*"]);
    expect(p.include![0]!.glob).toBeInstanceOf(Bun.Glob);
    expect(p.exclude[0]!.glob).toBeInstanceOf(Bun.Glob);
  });
});

describe("compileBranchPolicy — canonicalization (shared with config_hash)", () => {
  test("include patterns are sorted + deduped (canonical order)", () => {
    const p = compileBranchPolicy(["b", "a", "a", "c"], []);
    expect(names(p.include)).toEqual(["a", "b", "c"]);
  });
  test("exclude patterns are sorted + deduped", () => {
    const p = compileBranchPolicy(null, ["y", "x", "x"]);
    expect(names(p.exclude)).toEqual(["x", "y"]);
  });
  test("canonicalization is exact-string: no case-folding or trimming (code-unit order)", () => {
    // Three DISTINCT code-unit sequences; sorted by UTF-16 code unit: ' ' 0x20 < 'M' 0x4D < 'm' 0x6D.
    const p = compileBranchPolicy(["main", "Main", " main"], []);
    expect(names(p.include)).toEqual([" main", "Main", "main"]);
  });
});

describe("compileBranchPolicy — compiled globs carry live Bun semantics", () => {
  test("'*' does not cross '/', '**' does", () => {
    const p = compileBranchPolicy(["dependabot/*", "release/**"], []);
    const dep = p.include!.find((c) => c.pattern === "dependabot/*")!.glob;
    const rel = p.include!.find((c) => c.pattern === "release/**")!.glob;
    expect(dep.match("dependabot/npm")).toBe(true);
    expect(dep.match("dependabot/npm/sub")).toBe(false); // '*' does not cross '/'
    expect(rel.match("release/1/2")).toBe(true); // '**' crosses '/'
  });
});

// BranchPolicyError is the leaf error loadConfig() re-wraps as ConfigError. Bun.Glob accepts most
// malformed strings at construction (e.g. "[") and only fails at match time, so this construction
// catch is a defensive/forward-compat guard rather than the primary validation — the real
// protection is the classifier's fail-closed match-time handling. We assert the type is
// well-formed and throwable so the wrapping contract in config.ts is meaningful.
describe("BranchPolicyError", () => {
  test("is an Error subclass with a stable name", () => {
    const e = new BranchPolicyError("boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BranchPolicyError");
    expect(e.message).toBe("boom");
  });
});

describe("evaluateBranchPolicy — winner precedence + deny-before-allow", () => {
  test("exact match beats an earlier-sorting glob (canonical exclude: '*' before 'main')", () => {
    const p = compileBranchPolicy(null, ["*", "main"]);
    expect(evaluateBranchPolicy(p, "main")).toEqual({ kind: "excluded-by-deny", matchedPattern: "main" });
  });
  test("no exact; the FIRST canonical-order glob wins", () => {
    const p = compileBranchPolicy(null, ["feat*", "*-x"]); // canonical: ["*-x", "feat*"]
    expect(evaluateBranchPolicy(p, "feat-x")).toEqual({ kind: "excluded-by-deny", matchedPattern: "*-x" });
  });
  test("deny wins over allow when both match", () => {
    const p = compileBranchPolicy(["main"], ["main"]);
    expect(evaluateBranchPolicy(p, "main")).toEqual({ kind: "excluded-by-deny", matchedPattern: "main" });
  });
  test("include=null is unrestricted, but deny is still evaluated", () => {
    const p = compileBranchPolicy(null, ["dep*"]);
    expect(evaluateBranchPolicy(p, "dependabot").kind).toBe("excluded-by-deny");
    expect(evaluateBranchPolicy(p, "main")).toEqual({ kind: "no-exclusion" });
  });
  test("include=[] excludes every branch (excluded-by-allow, no matched pattern)", () => {
    const p = compileBranchPolicy([], []);
    expect(evaluateBranchPolicy(p, "feature")).toEqual({ kind: "excluded-by-allow" });
  });
  test("an allowlist match yields no-exclusion; a miss yields excluded-by-allow", () => {
    const p = compileBranchPolicy(["release/*"], []);
    expect(evaluateBranchPolicy(p, "release/1")).toEqual({ kind: "no-exclusion" });
    expect(evaluateBranchPolicy(p, "feature")).toEqual({ kind: "excluded-by-allow" });
  });
  test("matching is case-SENSITIVE: 'dependabot/*' denies 'dependabot/x' but NOT 'Dependabot/x'", () => {
    const p = compileBranchPolicy(null, ["dependabot/*"]);
    expect(evaluateBranchPolicy(p, "dependabot/x")).toEqual({ kind: "excluded-by-deny", matchedPattern: "dependabot/*" });
    expect(evaluateBranchPolicy(p, "Dependabot/x")).toEqual({ kind: "no-exclusion" }); // capital D → no match
  });
});

describe("classifyBranch — default override preserves the counterfactual", () => {
  test("a non-default denied branch is ineligible", () => {
    // "dep*" matches "dependabot" ('*' does not cross '/', so no slash in the name)
    const p = compileBranchPolicy(null, ["dep*"]);
    const c = classifyBranch(p, "dependabot", "main");
    expect(c).toEqual({
      isDefaultBranch: false,
      rawPolicyResult: { kind: "excluded-by-deny", matchedPattern: "dep*" },
    });
    expect(isBranchPolicyEligible(c)).toBe(false); // derived by the shared helper, no stored flag
  });
  test("a non-default denied branch using '**' matches across '/'", () => {
    // to deny slash-containing bot branches, the operator uses '**' (crosses '/')
    const p = compileBranchPolicy(null, ["dependabot/**"]);
    expect(isBranchPolicyEligible(classifyBranch(p, "dependabot/npm/x", "main"))).toBe(false);
    expect(classifyBranch(p, "dependabot/npm/x", "main").rawPolicyResult).toEqual({
      kind: "excluded-by-deny", matchedPattern: "dependabot/**",
    });
  });
  test("the default branch stays eligible even when policy WOULD deny it (raw result kept)", () => {
    const c = classifyBranch(compileBranchPolicy(null, ["main"]), "main", "main");
    expect(c.isDefaultBranch).toBe(true);
    expect(isBranchPolicyEligible(c)).toBe(true);
    expect(c.rawPolicyResult).toEqual({ kind: "excluded-by-deny", matchedPattern: "main" });
  });
  test("the default branch stays eligible under an allowlist it does not match", () => {
    const c = classifyBranch(compileBranchPolicy(["release/*"], []), "main", "main");
    expect(isBranchPolicyEligible(c)).toBe(true);
    expect(c.rawPolicyResult).toEqual({ kind: "excluded-by-allow" });
  });
  test("a non-default allowlisted branch is eligible", () => {
    expect(isBranchPolicyEligible(classifyBranch(compileBranchPolicy(["release/*"], []), "release/2", "main"))).toBe(true);
  });
});

describe("fail-closed matching — a match-time throw is FATAL, never false", () => {
  test("a glob match throw becomes PolicyMatchError (a denied branch is never let through)", () => {
    const p = policy(null, [cp("aaa", throwingGlob(new Error("boom"))), cp("zzz", new Bun.Glob("zzz"))]);
    expect(() => evaluateBranchPolicy(p, "something")).toThrow(PolicyMatchError);
  });
  test("the ALLOW-list (include) path also fails closed on a match throw (listKind='branches')", () => {
    // empty exclude -> deny finds nothing -> evaluate falls through to the include matchWinner
    const p = policy([cp("dep*", throwingGlob(new Error("boom")))], []);
    let caught: unknown;
    try {
      evaluateBranchPolicy(p, "x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PolicyMatchError);
    expect((caught as PolicyMatchError).listKind).toBe("branches");
  });
  test("an exact match short-circuits WITHOUT invoking that pattern's (throwing) glob", () => {
    const p = policy(null, [cp("main", throwingGlob(new Error("should not run")))]);
    expect(evaluateBranchPolicy(p, "main")).toEqual({ kind: "excluded-by-deny", matchedPattern: "main" });
  });
  test("an earlier throwing glob is fatal even though a later glob would have matched", () => {
    const p = policy(null, [cp("aaa", throwingGlob(new Error("boom"))), cp("zzz", new Bun.Glob("*"))]);
    expect(() => evaluateBranchPolicy(p, "zeta")).toThrow(PolicyMatchError);
  });
  test("classifying the DEFAULT branch still throws on a match failure (counterfactual eval runs)", () => {
    const p = policy(null, [cp("aaa", throwingGlob(new Error("boom")))]);
    expect(() => classifyBranch(p, "main", "main")).toThrow(PolicyMatchError);
  });
  test("PolicyMatchError carries list/pattern/branch; a non-Error cause is stringified", () => {
    const p = policy(null, [cp("dep*", throwingGlob("weird"))]);
    let caught: unknown;
    try {
      evaluateBranchPolicy(p, "x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PolicyMatchError);
    const pe = caught as PolicyMatchError;
    expect(pe.listKind).toBe("excludeBranches");
    expect(pe.pattern).toBe("dep*");
    expect(pe.branchName).toBe("x");
    expect(pe.message).toContain('"dep*"');
    expect(pe.message).toContain("excludeBranches");
    expect(pe.message).toContain("weird");
  });
});

describe("patternMatchesBranch — write-time attribution verifier (db.ts chokepoint)", () => {
  test("exact-first short-circuits before the glob engine — a metacharacter-hostile literal name verifies", () => {
    // "[" matches NOTHING as a glob on the pinned Bun, so only the exact-equality pass can accept it.
    expect(patternMatchesBranch("[", "[")).toBe(true);
    expect(patternMatchesBranch("=cmd|calc", "=cmd|calc")).toBe(true);
  });
  test("a real glob match returns true; a genuine mismatch returns false (never throws for a well-formed glob)", () => {
    expect(patternMatchesBranch("release/*", "release/9")).toBe(true);
    expect(patternMatchesBranch("release/*", "main")).toBe(false);
  });
  test("a CONSTRUCTION throw becomes the FATAL PolicyMatchError, never a raw error (fail-closed, guard completeness)", () => {
    // No pattern is known to throw at Bun.Glob CONSTRUCTION on the exercised Bun versions, so force
    // it deterministically. RED before the guard was added: the raw error escaped patternMatchesBranch
    // and the per-unit catch would have downgraded it to a soft scan error instead of failing the run.
    const original = Bun.Glob;
    try {
      (Bun as { Glob: unknown }).Glob = class {
        constructor() {
          throw new Error("forced construction failure");
        }
      };
      let caught: unknown;
      try {
        patternMatchesBranch("dep*", "x"); // pattern !== branch, so construction is reached
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PolicyMatchError);
      expect((caught as PolicyMatchError).pattern).toBe("dep*");
      expect((caught as PolicyMatchError).branchName).toBe("x");
      expect((caught as PolicyMatchError).listKind).toBe("excludeBranches");
    } finally {
      (Bun as { Glob: typeof Bun.Glob }).Glob = original;
    }
    // sanity: the global is restored, so normal matching works again
    expect(patternMatchesBranch("release/*", "release/1")).toBe(true);
  });
});

describe("coverageForName — every matching pattern per list, kept separate", () => {
  test("returns exact plus every glob match in canonical order", () => {
    const p = compileBranchPolicy(["main", "*", "m*"], []); // canonical: ["*", "m*", "main"]
    expect(coverageForName(p, "main").branches).toEqual(["*", "m*", "main"]);
  });
  test("include and exclude coverage are independent (the same string may be in both)", () => {
    const p = compileBranchPolicy(["main"], ["main"]);
    expect(coverageForName(p, "main")).toEqual({ branches: ["main"], excludeBranches: ["main"] });
  });
  test("unrestricted (include=null) has empty branches coverage", () => {
    const p = compileBranchPolicy(null, ["dep*"]);
    const cov = coverageForName(p, "dependabot");
    expect(cov.branches).toEqual([]);
    expect(cov.excludeBranches).toEqual(["dep*"]);
  });
  test("a throwing glob during coverage is fatal (no partial result)", () => {
    const p = policy([cp("*", new Bun.Glob("*")), cp("zzz", throwingGlob(new Error("boom")))], []);
    expect(() => coverageForName(p, "abc")).toThrow(PolicyMatchError);
  });
});
