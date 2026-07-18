import { expect, test, describe } from "bun:test";
import {
  compileRepositoryPolicy, classifyRepository, RepositoryPolicyError, RepoPolicyMatchError,
  type CompiledRepositoryPattern, type CompiledRepositoryPolicy,
} from "./repositoryPolicy.ts";
import { toAsciiLower } from "./patternCanonical.ts";

const patterns = (p: CompiledRepositoryPolicy): string[] => p.map((c) => c.pattern);

// A CompiledRepositoryPattern whose glob THROWS at match time. compileRepositoryPolicy is not KNOWN
// to produce one (no accepted pattern throws at .match() on the Bun versions this project exercises),
// so fail-closed tests build these by hand — mirroring branchPolicy.test.ts's throwingGlob.
const throwingGlob = (thrown: unknown): Bun.Glob =>
  ({ match() { throw thrown; } }) as unknown as Bun.Glob;
const cp = (pattern: string, glob: Bun.Glob): CompiledRepositoryPattern => ({ pattern, glob });

describe("compileRepositoryPolicy — structure + ASCII-fold canonicalization", () => {
  test("empty patterns compile to an empty policy", () => {
    expect(compileRepositoryPolicy([])).toEqual([]);
  });
  test("each entry pairs the (folded) pattern string with a compiled Bun.Glob", () => {
    const p = compileRepositoryPolicy(["acme/legacy-*"]);
    expect(patterns(p)).toEqual(["acme/legacy-*"]);
    expect(p[0]!.glob).toBeInstanceOf(Bun.Glob);
  });
  test("patterns are ASCII-folded THEN sortedDedup — case-only duplicates collapse (shared with config_hash)", () => {
    // "ACME/*" and "acme/*" fold to the same string → one compiled pattern; canonical (code-unit) sort.
    const p = compileRepositoryPolicy(["ACME/*", "acme/*", "B/Legacy", "a/z"]);
    expect(patterns(p)).toEqual(["a/z", "acme/*", "b/legacy"]);
  });
  test("the fold is ASCII-only: a non-ASCII byte is preserved (never Unicode-folded)", () => {
    // Ä (U+00C4) is NOT in A-Z, so it survives the fold; the ASCII 'CME' lowercases.
    expect(patterns(compileRepositoryPolicy(["ÄCME/x"]))).toEqual(["Äcme/x"]);
  });
});

describe("compileRepositoryPolicy — compiled globs carry live Bun semantics", () => {
  test("'*' does not cross '/', '**' does", () => {
    const p = compileRepositoryPolicy(["acme/*", "acme/**"]);
    const star = p.find((c) => c.pattern === "acme/*")!.glob;
    const dstar = p.find((c) => c.pattern === "acme/**")!.glob;
    expect(star.match("acme/repo")).toBe(true);
    expect(star.match("acme/repo/sub")).toBe(false); // '*' does not cross '/'
    expect(dstar.match("acme/repo/sub")).toBe(true); // '**' crosses '/'
  });
});

// RepositoryPolicyError is the leaf error loadConfig() re-wraps as ConfigError. Bun.Glob accepts every
// string tested at construction (even "["), failing only at match time, so this construction catch is a
// defensive/forward-compat guard — mirroring branchPolicy's BranchPolicyError. The forced test below
// swaps Bun.Glob for a throwing constructor to exercise the catch branch that no real pattern can hit.
describe("RepositoryPolicyError — construction-time guard", () => {
  test("is an Error subclass with a stable name", () => {
    const e = new RepositoryPolicyError("boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RepositoryPolicyError");
    expect(e.message).toBe("boom");
  });
  test("a Bun.Glob CONSTRUCTION throw becomes a RepositoryPolicyError naming the pattern", () => {
    const OriginalGlob = Bun.Glob;
    try {
      // Replace the global constructor so compileRepositoryPolicy's `new Bun.Glob(pattern)` throws.
      (Bun as { Glob: unknown }).Glob = class {
        constructor() { throw new Error("forced construction failure"); }
      };
      let caught: unknown;
      try { compileRepositoryPolicy(["acme/legacy-*"]); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(RepositoryPolicyError);
      expect((caught as Error).message).toContain("acme/legacy-*");
      expect((caught as Error).message).toContain("not a valid glob");
    } finally {
      (Bun as { Glob: typeof OriginalGlob }).Glob = OriginalGlob;
    }
  });
});

describe("RepoPolicyMatchError — fail-closed match-time error", () => {
  test("is an Error subclass carrying the pattern + ownerRepo, stable name", () => {
    const e = new RepoPolicyMatchError("acme/*", "acme/repo", new Error("boom"));
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RepoPolicyMatchError");
    expect(e.pattern).toBe("acme/*");
    expect(e.ownerRepo).toBe("acme/repo");
    expect(e.message).toContain("acme/*");
    expect(e.message).toContain("acme/repo");
    expect(e.message).toContain("boom");
  });
});

describe("classifyRepository — exact-first, glob, case-insensitive, fail-closed", () => {
  test("empty policy never excludes", () => {
    expect(classifyRepository(compileRepositoryPolicy([]), "acme/anything")).toBe(false);
  });
  test("exact name match excludes; a non-match does not", () => {
    const p = compileRepositoryPolicy(["acme/legacy-api"]);
    expect(classifyRepository(p, "acme/legacy-api")).toBe(true);
    expect(classifyRepository(p, "acme/service-a")).toBe(false);
  });
  test("matching is case-insensitive: a folded pattern excludes the caller's folded owner/repo", () => {
    // The pattern folds at compile; the CALLER folds the owner/repo with toAsciiLower before calling.
    const p = compileRepositoryPolicy(["ACME/Legacy-API"]);
    expect(classifyRepository(p, toAsciiLower("acme/legacy-api"))).toBe(true);
    expect(classifyRepository(p, toAsciiLower("AcMe/LEGACY-api"))).toBe(true);
  });
  test("'acme/*' excludes one org's direct repos but not nested paths or other orgs", () => {
    const p = compileRepositoryPolicy(["acme/*"]);
    expect(classifyRepository(p, "acme/foo")).toBe(true);
    expect(classifyRepository(p, "acme/foo/bar")).toBe(false); // '*' does not cross '/'
    expect(classifyRepository(p, "other/foo")).toBe(false);
  });
  test("'*/legacy-*' excludes a family across orgs", () => {
    const p = compileRepositoryPolicy(["*/legacy-*"]);
    expect(classifyRepository(p, "acme/legacy-api")).toBe(true);
    expect(classifyRepository(p, "widgets/legacy-portal")).toBe(true);
    expect(classifyRepository(p, "acme/service")).toBe(false);
  });
  test("['*'] matches nothing (every full name has a '/'); ['**'] matches everything", () => {
    expect(classifyRepository(compileRepositoryPolicy(["*"]), "acme/foo")).toBe(false);
    const all = compileRepositoryPolicy(["**"]);
    expect(classifyRepository(all, "acme/foo")).toBe(true);
    expect(classifyRepository(all, "a/b/c")).toBe(true);
  });
  test("EXACT-FIRST is fail-closed for a glob-metachar name: the literal is caught even though its glob would NOT match it", () => {
    // Bun.Glob("acme/repo[x]") treats [x] as a char class, so it does NOT match the literal
    // "acme/repo[x]" (it matches "acme/repox"). Without exact-equality-first this repo would fail OPEN.
    expect(new Bun.Glob("acme/repo[x]").match("acme/repo[x]")).toBe(false); // sanity: pure glob misses the literal
    const p = compileRepositoryPolicy(["acme/repo[x]"]);
    expect(classifyRepository(p, "acme/repo[x]")).toBe(true); // exact-equality catches it (fail-closed)
    expect(classifyRepository(p, "acme/repox")).toBe(true); // and the glob still matches "acme/repox"
  });
  test("exact-equality short-circuits BEFORE the SAME entry's glob: a throwing glob on an exact-named entry is never invoked", () => {
    // Pins exact-BEFORE-glob per pattern: if the exact check ran after (or instead of before) the glob,
    // this entry's throwing glob would fire and raise RepoPolicyMatchError instead of returning true.
    const p = [cp("acme/repo", throwingGlob(new Error("glob must not run for an exact-named entry")))];
    expect(classifyRepository(p, "acme/repo")).toBe(true);
  });
  test("a deny match at a LATER pattern still excludes (iterates the whole list)", () => {
    const p = compileRepositoryPolicy(["a/keep", "z/*"]);
    expect(classifyRepository(p, "z/dropme")).toBe(true);
  });
  test("a match-time throw is FATAL (RepoPolicyMatchError), never a false 'not excluded'", () => {
    const p = [cp("acme/*", throwingGlob(new Error("engine boom")))];
    let caught: unknown;
    try { classifyRepository(p, "acme/repo"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RepoPolicyMatchError);
    expect((caught as RepoPolicyMatchError).pattern).toBe("acme/*");
    expect((caught as RepoPolicyMatchError).ownerRepo).toBe("acme/repo");
  });
  test("SINGLE-pass fail-closed: an EARLIER throwing glob aborts even though a LATER exact would match", () => {
    // Locked semantic (design decision tree): classify checks each pattern's exact-equality then its
    // glob, in canonical order — it does NOT do a whole-list exact pass first like branchPolicy. So a
    // throwing glob that sorts before an exact-name entry makes the whole classification FATAL. This is
    // an availability difference from branchPolicy, not a fail-open regression: the repo is never let
    // through. "aaa" < "acme/x" (code-unit), so the throwing entry is reached first.
    const p = [cp("aaa", throwingGlob(new Error("boom"))), cp("acme/x", new Bun.Glob("acme/x"))];
    expect(() => classifyRepository(p, "acme/x")).toThrow(RepoPolicyMatchError);
  });
});
