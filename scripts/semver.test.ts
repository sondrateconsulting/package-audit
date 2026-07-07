import { expect, test, describe } from "bun:test";
import { parseSemver, compareSemver, compareForReport, parseRange, satisfies, maxSatisfying } from "./semver.ts";

const cmpRaw = (a: string, b: string): number => compareSemver(parseSemver(a)!, parseSemver(b)!);

describe("parseSemver", () => {
  test("parses core, prerelease (exact-string identifiers), build", () => {
    const v = parseSemver("1.2.3-alpha.7+build.11")!;
    expect([v.major, v.minor, v.patch]).toEqual([1, 2, 3]);
    expect(v.prerelease).toEqual(["alpha", "7"]); // exact strings — no Number coercion
    expect(v.build).toEqual(["build", "11"]);
  });
  test("accepts a leading v and surrounding whitespace", () => {
    expect(parseSemver(" v2.0.0 ")).not.toBeNull();
  });
  test("rejects non-versions (fail closed)", () => {
    for (const bad of ["latest", "1.2", "1.2.3.4", "01.2.3", "1.2.3-01", "", "git+ssh://x", "workspace:*", "^1.2.3"])
      expect(parseSemver(bad)).toBeNull();
  });
  test("rejects a core numeric identifier above 2^53-1 (no silent precision loss, matches node-semver)", () => {
    expect(parseSemver("9007199254740993.0.0")).toBeNull(); // > MAX_SAFE_INTEGER
    expect(parseSemver("9007199254740992.0.0")).toBeNull(); // == 2^53, not a safe integer
    expect(parseSemver("9007199254740991.0.0")).not.toBeNull(); // == MAX_SAFE_INTEGER, valid
    expect(satisfies("9007199254740993.0.0", "*")).toBe(false);
    expect(satisfies("2.0.0", ">9007199254740993")).toBe(false); // unparseable range → no match
  });
});

describe("compareSemver — spec §11 precedence", () => {
  test("the canonical spec chain orders correctly", () => {
    const chain = [
      "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
      "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0",
    ];
    for (let i = 0; i < chain.length - 1; i++)
      expect(cmpRaw(chain[i]!, chain[i + 1]!)).toBe(-1);
  });
  test("numeric identifiers sort before alphanumeric; longer prerelease wins a shared prefix", () => {
    expect(cmpRaw("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(cmpRaw("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
  });
  test("build metadata is ignored for precedence", () => {
    expect(cmpRaw("1.0.0+a", "1.0.0+b")).toBe(0);
  });
  test("large numeric prerelease identifiers keep full precision (beyond 2^53)", () => {
    expect(cmpRaw("1.0.0-9007199254740992", "1.0.0-9007199254740993")).toBe(-1);
    expect(cmpRaw("1.0.0-9007199254740993", "1.0.0-9007199254740992")).toBe(1);
    expect(cmpRaw("1.0.0-2", "1.0.0-10")).toBe(-1); // length-then-lex: 2 < 10
  });
  test("release outranks any prerelease of the same core", () => {
    expect(cmpRaw("1.0.0-rc.99", "1.0.0")).toBe(-1);
  });
});

describe("compareForReport — §7 total order", () => {
  test("semver precedence first, raw string tie-break for build variants", () => {
    expect(compareForReport("1.0.0+a", "1.0.0+b")).toBe(-1);
    expect(compareForReport("1.0.0+b", "1.0.0+a")).toBe(1);
    expect(compareForReport("2.0.0", "10.0.0")).toBe(-1); // numeric, not lexicographic
  });
});

describe("satisfies — primitive and x-ranges", () => {
  test("exact, inequality, AND-space sets", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.3", "=1.2.3")).toBe(true);
    expect(satisfies("1.2.4", ">=1.2.3 <2.0.0")).toBe(true);
    expect(satisfies("2.0.0", ">=1.2.3 <2.0.0")).toBe(false);
    expect(satisfies("1.2.3", ">= 1.2.3")).toBe(true); // space after operator
  });
  test("x-ranges and star", () => {
    expect(satisfies("1.2.9", "1.2.x")).toBe(true);
    expect(satisfies("1.3.0", "1.2.x")).toBe(false);
    expect(satisfies("1.9.9", "1.x")).toBe(true);
    expect(satisfies("2.0.0", "1.x")).toBe(false);
    expect(satisfies("0.5.0", "*")).toBe(true);
    expect(satisfies("5.0.0", "")).toBe(true); // empty range = any
  });
  test("partial inequality comparators desugar like node-semver", () => {
    expect(satisfies("1.3.0", ">1.2")).toBe(true);
    expect(satisfies("1.2.9", ">1.2")).toBe(false);
    expect(satisfies("2.0.0", ">1")).toBe(true);
    expect(satisfies("1.9.9", ">1")).toBe(false);
    expect(satisfies("1.1.9", "<1.2")).toBe(true);
    expect(satisfies("1.2.0", "<1.2")).toBe(false);
    expect(satisfies("1.2.9", "<=1.2")).toBe(true);
    expect(satisfies("1.3.0", "<=1.2")).toBe(false);
  });
  test("partial `>` lower bounds are STABLE — a prerelease does not satisfy `>1` (node-semver)", () => {
    // >1 desugars to >=2.0.0 (NOT >=2.0.0-0), so 2.0.0-alpha must NOT satisfy it
    expect(satisfies("2.0.0-alpha", ">1")).toBe(false);
    expect(satisfies("2.0.0", ">1")).toBe(true);
    expect(satisfies("1.3.0-alpha", ">1.2")).toBe(false);
    expect(satisfies("1.3.0", ">1.2")).toBe(true);
  });
});

describe("satisfies — tilde and caret", () => {
  test("tilde", () => {
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("1.2.0", "~1.2")).toBe(true);
    expect(satisfies("1.3.0", "~1.2")).toBe(false);
    expect(satisfies("1.9.0", "~1")).toBe(true);
    expect(satisfies("2.0.0", "~1")).toBe(false);
    expect(satisfies("0.2.9", "~0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "~0.2.3")).toBe(false);
  });
  test("caret — the 0.x rules", () => {
    expect(satisfies("1.9.9", "^1.2.3")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfies("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
    expect(satisfies("1.9.0", "^1.x")).toBe(true);
    expect(satisfies("0.0.5", "^0.0.x")).toBe(true);
    expect(satisfies("0.1.0", "^0.0.x")).toBe(false);
    expect(satisfies("0.5.0", "^0.x")).toBe(true);
    expect(satisfies("1.0.0", "^0.x")).toBe(false);
  });
  test("exclusive upper bounds keep their -0 (asymmetry with the stable > lower bounds)", () => {
    // `<2` → `<2.0.0-0` excludes 2.0.0-0; `<=1.2` → `<1.3.0-0` excludes the boundary prerelease
    expect(satisfies("2.0.0-0", "<2")).toBe(false);
    expect(satisfies("1.9.9", "<2")).toBe(true);
    expect(satisfies("1.3.0-0", "<=1.2")).toBe(false);
  });
  test("caret/tilde with a prerelease lower bound", () => {
    expect(satisfies("1.2.3-beta.4", "^1.2.3-beta.2")).toBe(true);
    expect(satisfies("1.2.3-alpha", "^1.2.3-beta.2")).toBe(false);
    expect(satisfies("1.2.4", "^1.2.3-beta.2")).toBe(true);
  });
});

describe("satisfies — hyphen ranges and OR alternatives", () => {
  test("hyphen ranges incl. partial bounds", () => {
    expect(satisfies("1.5.0", "1.2.3 - 2.3.4")).toBe(true);
    expect(satisfies("2.3.4", "1.2.3 - 2.3.4")).toBe(true);
    expect(satisfies("2.3.5", "1.2.3 - 2.3.4")).toBe(false);
    expect(satisfies("2.3.9", "1.2.3 - 2.3")).toBe(true); // upper partial → <2.4.0
    expect(satisfies("2.4.0", "1.2.3 - 2.3")).toBe(false);
    expect(satisfies("2.9.9", "1.2.3 - 2")).toBe(true); // → <3.0.0
    expect(satisfies("1.2.0", "1.2 - 2.3.4")).toBe(true); // lower partial fills zeros
  });
  test("|| alternatives", () => {
    expect(satisfies("1.9.0", "^1.0.0 || ^2.0.0")).toBe(true);
    expect(satisfies("2.9.0", "^1.0.0 || ^2.0.0")).toBe(true);
    expect(satisfies("3.0.0", "^1.0.0 || ^2.0.0")).toBe(false);
  });
});

describe("satisfies — npm's prerelease rule", () => {
  test("a prerelease only satisfies when the range names a prerelease on the SAME tuple", () => {
    expect(satisfies("1.3.0-alpha", "^1.2.3")).toBe(false);
    expect(satisfies("2.0.0-alpha", "^1.2.3")).toBe(false);
    expect(satisfies("1.2.3-beta.3", ">=1.2.3-beta.2")).toBe(true);
    expect(satisfies("1.2.4-beta", ">=1.2.3-beta.2")).toBe(false); // different tuple
    expect(satisfies("0.0.0-alpha", "*")).toBe(false); // star never admits prereleases
  });
});

describe("fail-closed range parsing", () => {
  test("non-ranges return null / never satisfy", () => {
    for (const notRange of ["latest", "git+ssh://x", "file:../y", "workspace:*", "npm:foo@^1", "https://x/t.tgz", "catalog:"]) {
      expect(parseRange(notRange)).toBeNull();
      expect(satisfies("1.2.3", notRange)).toBe(false);
    }
  });
});

describe("maxSatisfying — the §5.E fallback", () => {
  const published = ["1.0.0", "1.2.0", "1.2.5", "1.3.0-beta.1", "1.3.0", "2.0.0", "2.1.0-rc.1"];
  test("picks the max satisfying stable version", () => {
    expect(maxSatisfying(published, "^1.2.0")).toBe("1.3.0");
    expect(maxSatisfying(published, "~1.2.0")).toBe("1.2.5");
    expect(maxSatisfying(published, ">=2.0.0")).toBe("2.0.0"); // 2.1.0-rc.1 excluded
    expect(maxSatisfying(published, "*")).toBe("2.0.0");
  });
  test("prereleases only when the range names one on the tuple", () => {
    expect(maxSatisfying(published, ">=2.1.0-rc.0 <2.2.0")).toBe("2.1.0-rc.1");
  });
  test("no match → null; unparseable versions skipped", () => {
    expect(maxSatisfying(published, "^3.0.0")).toBeNull();
    expect(maxSatisfying(["not-a-version", "1.0.0"], "^1.0.0")).toBe("1.0.0");
  });
  test("build-variant precedence ties break on the raw string deterministically", () => {
    expect(maxSatisfying(["1.0.0+a", "1.0.0+b"], "^1.0.0")).toBe("1.0.0+b");
  });
});
