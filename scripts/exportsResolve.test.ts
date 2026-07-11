import { expect, test, describe } from "bun:test";
import {
  resolveSubpath, resolveTypeTargets, typeTargetToDts, binNames, exportsSubpathKeys,
  substituteFirstStar, declarationCandidates, isValidExportTarget, hasVersionedExportCondition,
  resolvePatternTargetTemplates,
} from "./exportsResolve.ts";

describe("resolveTypeTargets — root type surface (§5.E)", () => {
  test("string exports sugar (root only)", () => {
    expect(resolveTypeTargets({ exports: "./index.js" })).toEqual(["./index.js"]);
  });
  test("conditions object: types wins by object order per mode, unioned", () => {
    const pkg = {
      exports: { types: "./index.d.ts", import: "./index.mjs", require: "./index.cjs" },
    };
    // types is first and in both condition sets, so both passes resolve ./index.d.ts → union {one}
    expect(resolveTypeTargets(pkg)).toEqual(["./index.d.ts"]);
  });
  test("dual-package surface: import vs require type targets are UNIONED", () => {
    const pkg = {
      exports: {
        ".": {
          import: { types: "./index.d.mts", default: "./index.mjs" },
          require: { types: "./index.d.cts", default: "./index.cjs" },
        },
      },
    };
    expect(resolveTypeTargets(pkg).sort()).toEqual(["./index.d.cts", "./index.d.mts"]);
  });
  test("object order is honored (an earlier in-set key wins over types)", () => {
    // `node` precedes `types`; both are in the set, so object order picks node first
    const pkg = { exports: { node: "./node.js", types: "./index.d.ts" } };
    expect(resolveTypeTargets(pkg)).toEqual(["./node.js"]);
  });
  test("fallback array: UNION of ALL structurally-valid elements (#5a — TS continues past a MISSING first target)", () => {
    // The victim's tsc uses the FIRST target that EXISTS on disk; a filesystem-unaware resolver
    // that returns only the first structurally-valid target would drop the real one when the
    // decoy-first target is missing. Union both so readContained covers whichever exists.
    const pkg = { exports: { ".": [{ types: "./a.d.ts" }, "./b.js"] } };
    expect(resolveTypeTargets(pkg)).toEqual(["./a.d.ts", "./b.js"]);
  });
  test("an explicit null on the FIRST present condition BLOCKS — no fall-through to a sibling", () => {
    // `types` is present and null → the type surface is private; `default` must NOT leak
    expect(resolveTypeTargets({ exports: { types: null, default: "./index.js" } })).toEqual([]);
  });
  test("a non-matching nested condition falls through to the next sibling (undefined, not null)", () => {
    // `import`'s value has no matching sub-condition (only `browser`), so fall through to `require`
    const pkg = { exports: { import: { browser: "./b.mjs" }, require: "./index.cjs" } };
    expect(resolveTypeTargets(pkg)).toEqual(["./index.cjs"]);
  });
  test("a top-level exports array is a root fallback list (union of all valid, #5a)", () => {
    expect(resolveTypeTargets({ exports: ["./a.js", "./b.js"] })).toEqual(["./a.js", "./b.js"]);
  });
});

describe("resolveTypeTargets — no exports fallback", () => {
  test("types/typings then index.d.ts", () => {
    expect(resolveTypeTargets({ types: "./lib/index.d.ts" })).toEqual(["./lib/index.d.ts"]);
    expect(resolveTypeTargets({ typings: "./typings/main.d.ts" })).toEqual(["./typings/main.d.ts"]);
    expect(resolveTypeTargets({})).toEqual(["./index.d.ts"]);
  });
  test("typesVersions remap applies ONLY when exports is absent (#3 — union of base + remap)", () => {
    // #3 fail-closed correction: the victim's tsc might not honor typesVersions (old TS, or a
    // range that does not match its version), so the UNREMAPPED base must always stay a candidate
    // alongside the remapped target. Assert the real remapped target is present in the union.
    const pkg = {
      typesVersions: { ">=4.0": { "*": ["./ts4.0/*"] } },
      types: "./index.d.ts",
    };
    const remapped = resolveTypeTargets(pkg);
    expect(remapped).toContain("./ts4.0/index.d.ts"); // the real remapped decl
    expect(remapped).toContain("./index.d.ts"); // the unremapped base (fail-closed superset)
    // with exports present, typesVersions is ignored
    const withExports = { ...pkg, exports: { types: "./exports.d.ts" } };
    expect(resolveTypeTargets(withExports)).toEqual(["./exports.d.ts"]);
  });
  test("typesVersions remap is TS-faithful for $-tokens in the captured path (#2 — no verbatim leak)", () => {
    // `captured` derives from untrusted package.json types/typings. TS does `target.replace('*',
    // captured)`, and JS EXPANDS $-tokens in the replacement: $& → the matched '*', $$ → '$'. A
    // verbatim splice diverges from tsc and reads the WRONG file (fail-open). substituteFirstStar
    // reproduces tsc byte-for-byte WITHOUT a `.replace('*', <untrusted>)` (CodeQL-safe).
    const pkg = { typesVersions: { ">=0": { "*": ["./ts/*"] } }, types: "./a$&b.d.ts" };
    expect(resolveTypeTargets(pkg)).toContain("./ts/a*b.d.ts"); // $& → the matched star
    const pkg2 = { typesVersions: { ">=0": { "*": ["./ts/*"] } }, types: "./c$$d.d.ts" };
    expect(resolveTypeTargets(pkg2)).toContain("./ts/c$d.d.ts"); // $$ → a literal '$'
  });
  test("typesVersions remap substitutes only the FIRST star (TypeScript-faithful)", () => {
    // TS's typesVersions/paths substitution fills only the first '*' in the target; a pathological
    // multi-star target keeps later stars literal (unresolvable, exactly as TS). The first-star
    // fill (`index.d.ts`) then flows through declarationCandidates; the second star stays literal.
    const pkg = { typesVersions: { ">=0": { "*": ["./ts/*/*"] } }, types: "./index.d.ts" };
    expect(resolveTypeTargets(pkg)).toContain("./ts/index.d.ts/*.d.ts"); // first star filled, second literal
  });
});

describe("resolveSubpath — subpath mapping (§5.F)", () => {
  test("exact subpath entry", () => {
    const pkg = { exports: { ".": "./index.js", "./config": { types: "./config.d.ts" } } };
    expect(resolveSubpath(pkg, "./config").targets).toEqual(["./config.d.ts"]);
    expect(resolveSubpath(pkg, "./config").resolved).toBe(true);
  });
  test("pattern subpath './*' with trailer substitution; longest prefix wins", () => {
    const pkg = {
      exports: {
        "./features/*": { types: "./dts/features/*.d.ts" },
        "./*": { types: "./dts/*.d.ts" },
      },
    };
    expect(resolveSubpath(pkg, "./features/x").targets).toEqual(["./dts/features/x.d.ts"]);
    expect(resolveSubpath(pkg, "./other").targets).toEqual(["./dts/other.d.ts"]);
  });
  test("pattern target substitutes EVERY star (Node exports semantics)", () => {
    // Node's PACKAGE_TARGET_RESOLVE replaces ALL '*' in the target with the capture,
    // "including if it contains any / separators" — not just the first.
    const pkg = { exports: { "./*": { types: "./dist/*/index-*.d.ts" } } };
    expect(resolveSubpath(pkg, "./foo").targets).toEqual(["./dist/foo/index-foo.d.ts"]);
  });
  test("captured trailer with $-replacement tokens is inserted literally", () => {
    // '$' is a legal subpath char; a string-arg .replace re-expands $&/$$ — must not.
    const pkg = { exports: { "./*": { types: "./dist/*.d.ts" } } };
    expect(resolveSubpath(pkg, "./a$&b").targets).toEqual(["./dist/a$&b.d.ts"]);
    expect(resolveSubpath(pkg, "./c$$d").targets).toEqual(["./dist/c$$d.d.ts"]);
  });
  test("private (null target) subpath is unresolved", () => {
    const pkg = { exports: { ".": "./index.js", "./secret": null } };
    expect(resolveSubpath(pkg, "./secret").resolved).toBe(false);
  });
  test("an unmapped subpath is unresolved", () => {
    const pkg = { exports: { ".": "./index.js" } };
    expect(resolveSubpath(pkg, "./nope").resolved).toBe(false);
  });
  test("no exports field → unresolved (caller uses the legacy fallback for root)", () => {
    expect(resolveSubpath({ types: "./index.d.ts" }, ".").resolved).toBe(false);
  });
});

describe("exportsSubpathKeys — declared subpath enumeration (§5.E full surface)", () => {
  test("splits exact keys from '*'-pattern keys, excluding the root", () => {
    const pkg = { exports: { ".": "./index.js", "./config": "./config.js", "./features/*": "./features/*.js" } };
    expect(exportsSubpathKeys(pkg)).toEqual({ exact: ["./config"], patterns: ["./features/*"] });
  });
  test("a bare conditions object (no subpath map) yields nothing", () => {
    expect(exportsSubpathKeys({ exports: { types: "./index.d.ts", import: "./index.mjs" } })).toEqual({ exact: [], patterns: [] });
  });
  test("absent/string/array/null exports yield nothing", () => {
    expect(exportsSubpathKeys({})).toEqual({ exact: [], patterns: [] });
    expect(exportsSubpathKeys({ exports: "./index.js" })).toEqual({ exact: [], patterns: [] });
    expect(exportsSubpathKeys({ exports: ["./a.js"] })).toEqual({ exact: [], patterns: [] });
    expect(exportsSubpathKeys({ exports: null })).toEqual({ exact: [], patterns: [] });
  });
});

describe("typeTargetToDts", () => {
  test("maps runtime extensions to declaration files; keeps existing .d.ts", () => {
    expect(typeTargetToDts("./index.js")).toBe("./index.d.ts");
    expect(typeTargetToDts("./index.mjs")).toBe("./index.d.mts");
    expect(typeTargetToDts("./index.cjs")).toBe("./index.d.cts");
    expect(typeTargetToDts("./index.d.ts")).toBe("./index.d.ts");
    expect(typeTargetToDts("./index.d.mts")).toBe("./index.d.mts");
  });
});

describe("binNames (§5.G)", () => {
  test("object form → keys", () => {
    expect(binNames({ bin: { expo: "./cli.js", "expo-cli": "./cli2.js" } }).sort()).toEqual(["expo", "expo-cli"]);
  });
  test("string form → unscoped package name", () => {
    expect(binNames({ name: "expo", bin: "./cli.js" })).toEqual(["expo"]);
    expect(binNames({ name: "@scope/pkg", bin: "./cli.js" })).toEqual(["pkg"]);
  });
  test("no bin → empty", () => {
    expect(binNames({ name: "expo" })).toEqual([]);
  });
});

describe("substituteFirstStar (#2 — TS replaceFirstStar, CodeQL-safe)", () => {
  // Emulates `target.replace('*', captured)` byte-for-byte, expanding $-tokens in the REPLACEMENT
  // (captured) exactly as ECMAScript GetSubstitution does with an EMPTY capture list.
  test("no star in target → returned unchanged", () => {
    expect(substituteFirstStar("./ts/index.d.ts", "anything")).toBe("./ts/index.d.ts");
  });
  test("plain capture (no $-tokens) is inserted at the first star", () => {
    expect(substituteFirstStar("./ts/*", "index.d.ts")).toBe("./ts/index.d.ts");
  });
  test("$$ → a literal '$'", () => {
    expect(substituteFirstStar("./ts/*", "c$$d")).toBe("./ts/c$d");
  });
  test("$& → the matched substring (the star itself)", () => {
    expect(substituteFirstStar("./ts/*", "a$&b")).toBe("./ts/a*b");
  });
  test("$` → the portion of target BEFORE the star; $' → the portion AFTER", () => {
    expect(substituteFirstStar("A/*/B", "$`")).toBe("A/A//B"); // before = 'A/'
    expect(substituteFirstStar("A/*/B", "$'")).toBe("A//B/B"); // after = '/B'
  });
  test("$1 / $nn / $<name> are literal (a string search has NO capture groups)", () => {
    expect(substituteFirstStar("./ts/*", "$1")).toBe("./ts/$1");
    expect(substituteFirstStar("./ts/*", "$12")).toBe("./ts/$12");
    expect(substituteFirstStar("./ts/*", "$<name>")).toBe("./ts/$<name>");
  });
  test("mixed / adjacent tokens consume atomically ($$$& → '$' then the star)", () => {
    expect(substituteFirstStar("./ts/*", "$$$&")).toBe("./ts/$*");
  });
  test("a lone trailing $ is literal", () => {
    expect(substituteFirstStar("./ts/*", "x$")).toBe("./ts/x$");
  });
  test("only the FIRST star is a substitution site; later stars are literal target text", () => {
    expect(substituteFirstStar("./ts/*/*", "index.d.ts")).toBe("./ts/index.d.ts/*");
  });
});

describe("declarationCandidates (#3/#4 — bounded superset of decl files)", () => {
  test("an already-.d.ts/.d.mts/.d.cts target is the sole candidate", () => {
    expect(declarationCandidates("./index.d.ts")).toEqual(["./index.d.ts"]);
    expect(declarationCandidates("./x.d.mts")).toEqual(["./x.d.mts"]);
    expect(declarationCandidates("./x.d.cts")).toEqual(["./x.d.cts"]);
  });
  test("a runtime .js target → the adjacent .d.ts (plus dir-index supersets)", () => {
    const c = declarationCandidates("./lib/entry.js");
    expect(c).toContain("./lib/entry.d.ts");
  });
  test("an extensionless/dir target → the directory index .d.ts", () => {
    expect(declarationCandidates("./types")).toContain("./types/index.d.ts");
    expect(declarationCandidates("./lib")).toContain("./lib/index.d.ts");
  });
  test("a .ts/.mts/.cts SOURCE target keeps itself as a surface candidate", () => {
    expect(declarationCandidates("./src/index.ts")).toContain("./src/index.ts");
  });
});

describe("resolveTypeTargets — legacy typings/types/main candidate expansion (#4)", () => {
  test("typings is checked BEFORE types (real is covered even when types is a decoy)", () => {
    const pkg = { types: "./decoy.d.ts", typings: "./real.d.ts" };
    expect(resolveTypeTargets(pkg)).toContain("./real.d.ts");
  });
  test("no types/typings → main's adjacent .d.ts is a candidate", () => {
    expect(resolveTypeTargets({ main: "./lib/entry.js" })).toContain("./lib/entry.d.ts");
  });
  test("no types/typings → an extensionless main gets a directory-index candidate", () => {
    // ship only lib/index.d.ts (real) — the resolver must reach it even though main is a dir
    expect(resolveTypeTargets({ main: "./lib" })).toContain("./lib/index.d.ts");
  });
  test("types pointing at a directory gets a directory-index candidate", () => {
    expect(resolveTypeTargets({ types: "./types" })).toContain("./types/index.d.ts");
  });
});

describe("resolveSubpath — fallback-array UNION + isValidExportTarget (#5a)", () => {
  test("a fallback array unions ALL structurally-valid targets (real covered past a missing decoy)", () => {
    const pkg = { exports: { ".": ["./missing.d.ts", "./real.d.ts"] } };
    expect(resolveSubpath(pkg, ".").targets).toEqual(["./missing.d.ts", "./real.d.ts"]);
  });
  test("Node-invalid fallback targets are skipped, valid ones kept", () => {
    const pkg = { exports: { ".": ["./../evil.d.ts", "./node_modules/x.d.ts", "./real.d.ts"] } };
    expect(resolveSubpath(pkg, ".").targets).toEqual(["./real.d.ts"]);
  });
  test("an unknown custom condition beside `types` is UNIONED so a decoy cannot hide the real surface (#5b)", () => {
    // a package built with customConditions:['mycond'] would pick mycond → real; we pick types →
    // decoy. Union the custom branch so real is audited too (fail-closed).
    const pkg = { exports: { ".": { mycond: "./real.d.ts", types: "./decoy.d.ts" } } };
    const targets = resolveSubpath(pkg, ".").targets;
    expect(targets).toContain("./real.d.ts");
    expect(targets).toContain("./decoy.d.ts");
  });
});

describe("isValidExportTarget (#5a — Node-faithful fallback-string validation)", () => {
  test("accepts a normal relative target", () => {
    expect(isValidExportTarget("./real.d.ts")).toBe(true);
    expect(isValidExportTarget("./dist/sub/x.d.ts")).toBe(true);
  });
  test("rejects a non-relative target", () => {
    expect(isValidExportTarget("real.d.ts")).toBe(false);
    expect(isValidExportTarget("../evil.d.ts")).toBe(false);
  });
  test("rejects a '.'/'..' path segment, node_modules, backslash", () => {
    expect(isValidExportTarget("./../evil.d.ts")).toBe(false);
    expect(isValidExportTarget("./a/./b.d.ts")).toBe(false);
    expect(isValidExportTarget("./a/node_modules/b.d.ts")).toBe(false);
    expect(isValidExportTarget("./a\\b.d.ts")).toBe(false);
  });
  test("rejects percent-encoded dot/separator (case-insensitive)", () => {
    expect(isValidExportTarget("./a%2e%2e/b")).toBe(false);
    expect(isValidExportTarget("./a%2Fb")).toBe(false);
    expect(isValidExportTarget("./a%5Cb")).toBe(false);
  });
});

describe("hasVersionedExportCondition (#5b — precise versioned detection)", () => {
  test("detects a `types@<range>` versioned key", () => {
    expect(hasVersionedExportCondition({ "types@>=6": "./a.d.ts", types: "./b.d.ts" })).toBe(true);
    expect(hasVersionedExportCondition({ "types@<4.5": "./a.d.ts" })).toBe(true);
  });
  test("detects a versioned key nested inside a fallback ARRAY element", () => {
    expect(hasVersionedExportCondition({ ".": [{ "types@>=6": "./a.d.ts" }, { types: "./b.d.ts" }] })).toBe(true);
  });
  test("an ordinary `foo@bar` custom condition is NOT versioned (GREEN)", () => {
    expect(hasVersionedExportCondition({ "foo@bar": "./a.d.ts", types: "./b.d.ts" })).toBe(false);
  });
  test("plain conditions / subpaths are not versioned", () => {
    expect(hasVersionedExportCondition({ types: "./a.d.ts", import: "./a.mjs" })).toBe(false);
    expect(hasVersionedExportCondition({ ".": "./index.js", "./config": "./c.js" })).toBe(false);
  });
});

describe("resolveSubpathUnder tie-break (#6b — PATTERN_KEY_COMPARE, longer full key wins)", () => {
  test("equal prefix length → the longer FULL key wins", () => {
    const pkg = { exports: { "./*": { types: "./a/*.d.ts" }, "./*.js": { types: "./b/*.d.ts" } } };
    expect(resolveSubpath(pkg, "./x.js").targets).toEqual(["./b/x.d.ts"]);
  });
});

describe("resolvePatternTargetTemplates (#6a — raw un-substituted templates)", () => {
  test("returns the raw target template with its '*' intact, unioned across modes", () => {
    const pkg = { exports: { "./*": { types: "./dts/*.d.ts" } } };
    expect(resolvePatternTargetTemplates(pkg, "./*")).toEqual(["./dts/*.d.ts"]);
  });
  test("a no-star target template is returned verbatim (single-file enumeration)", () => {
    const pkg = { exports: { "./*": "./index.d.ts" } };
    expect(resolvePatternTargetTemplates(pkg, "./*")).toEqual(["./index.d.ts"]);
  });
  test("a fallback-array pattern value unions its structurally-valid templates", () => {
    const pkg = { exports: { "./*": [{ types: "./a/*.d.ts" }, "./b/*.d.ts"] } };
    expect(resolvePatternTargetTemplates(pkg, "./*")).toEqual(["./a/*.d.ts", "./b/*.d.ts"]);
  });
});
