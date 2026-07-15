import { expect, test, describe } from "bun:test";
import { compileBranchPolicy, BranchPolicyError, type CompiledPattern } from "./branchPolicy.ts";

const names = (list: readonly CompiledPattern[] | null): string[] | null =>
  list === null ? null : list.map((c) => c.pattern);

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
// protection is the classifier's fail-closed match-time handling (T3). We assert the type is
// well-formed and throwable so the wrapping contract in config.ts is meaningful.
describe("BranchPolicyError", () => {
  test("is an Error subclass with a stable name", () => {
    const e = new BranchPolicyError("boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BranchPolicyError");
    expect(e.message).toBe("boom");
  });
});
