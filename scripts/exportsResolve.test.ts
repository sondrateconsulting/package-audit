import { expect, test, describe } from "bun:test";
import { resolveSubpath, resolveTypeTargets, typeTargetToDts, binNames, exportsSubpathKeys } from "./exportsResolve.ts";

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
  test("fallback array: first valid element", () => {
    const pkg = { exports: { ".": [{ types: "./a.d.ts" }, "./b.js"] } };
    expect(resolveTypeTargets(pkg)).toEqual(["./a.d.ts"]);
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
  test("a top-level exports array is a root fallback list", () => {
    expect(resolveTypeTargets({ exports: ["./a.js", "./b.js"] })).toEqual(["./a.js"]);
  });
});

describe("resolveTypeTargets — no exports fallback", () => {
  test("types/typings then index.d.ts", () => {
    expect(resolveTypeTargets({ types: "./lib/index.d.ts" })).toEqual(["./lib/index.d.ts"]);
    expect(resolveTypeTargets({ typings: "./typings/main.d.ts" })).toEqual(["./typings/main.d.ts"]);
    expect(resolveTypeTargets({})).toEqual(["./index.d.ts"]);
  });
  test("typesVersions remap applies ONLY when exports is absent", () => {
    const pkg = {
      typesVersions: { ">=4.0": { "*": ["./ts4.0/*"] } },
      types: "./index.d.ts",
    };
    expect(resolveTypeTargets(pkg)).toEqual(["./ts4.0/index.d.ts"]);
    // with exports present, typesVersions is ignored
    const withExports = { ...pkg, exports: { types: "./exports.d.ts" } };
    expect(resolveTypeTargets(withExports)).toEqual(["./exports.d.ts"]);
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
