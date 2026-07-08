import { expect, test, describe } from "bun:test";
import { scanUsage, matchSpecifier, type TrackedPackage, type UsageScanContext } from "./usageScanner.ts";

const ctx = (filePath = "src/index.ts"): UsageScanContext => ({
  githubHost: "github.com",
  organization: "org-a",
  repository: "repo",
  branch: "main",
  commitSha: "abc123def",
  filePath,
});
const expo: TrackedPackage[] = [{ packageName: "expo", installNames: new Set(["expo"]) }];
const scan = (code: string, packages = expo, path = "src/index.ts") =>
  scanUsage(code, ctx(path), packages).map((r) => ({ usageType: r.usageType, exportName: r.exportName, dependencyKey: r.dependencyKey, line: r.lineNumber }));

describe("matchSpecifier", () => {
  test("exact and subpath matches; longest install name wins", () => {
    const pkgs: TrackedPackage[] = [
      { packageName: "expo", installNames: new Set(["expo", "expo-router"]) },
    ];
    expect(matchSpecifier("expo", pkgs)).toEqual({ packageName: "expo", dependencyKey: "expo" });
    expect(matchSpecifier("expo/sub", pkgs)).toEqual({ packageName: "expo", dependencyKey: "expo" });
    expect(matchSpecifier("expo-router", pkgs)).toEqual({ packageName: "expo", dependencyKey: "expo-router" });
    expect(matchSpecifier("react", pkgs)).toBeNull();
    expect(matchSpecifier("expokit", pkgs)).toBeNull(); // not a subpath (no '/')
  });
});

describe("scanUsage — import forms (§5.F)", () => {
  test("named imports record the SOURCE export name (aliases resolved)", () => {
    expect(scan(`import { foo, bar as baz } from "expo";`)).toEqual([
      { usageType: "named-import", exportName: "bar", dependencyKey: "expo", line: 1 },
      { usageType: "named-import", exportName: "foo", dependencyKey: "expo", line: 1 },
    ]);
  });
  test("default import → export_name 'default'", () => {
    expect(scan(`import Expo from "expo";`)).toEqual([{ usageType: "default-import", exportName: "default", dependencyKey: "expo", line: 1 }]);
  });
  test("namespace import → export_name ''", () => {
    expect(scan(`import * as ns from "expo";`)).toEqual([{ usageType: "namespace-import", exportName: "", dependencyKey: "expo", line: 1 }]);
  });
  test("side-effect import → export_name ''", () => {
    expect(scan(`import "expo";`)).toEqual([{ usageType: "side-effect-import", exportName: "", dependencyKey: "expo", line: 1 }]);
  });
  test("default + named on one import records both", () => {
    const r = scan(`import Def, { named } from "expo";`);
    expect(r).toContainEqual({ usageType: "default-import", exportName: "default", dependencyKey: "expo", line: 1 });
    expect(r).toContainEqual({ usageType: "named-import", exportName: "named", dependencyKey: "expo", line: 1 });
  });
  test("type-only named imports are still recorded", () => {
    expect(scan(`import type { Config } from "expo";`)).toEqual([{ usageType: "named-import", exportName: "Config", dependencyKey: "expo", line: 1 }]);
  });
});

describe("scanUsage — reexport / dynamic / require", () => {
  test("reexport forms → export_name ''", () => {
    expect(scan(`export { foo } from "expo";`)).toEqual([{ usageType: "reexport", exportName: "", dependencyKey: "expo", line: 1 }]);
    expect(scan(`export * from "expo";`)).toEqual([{ usageType: "reexport", exportName: "", dependencyKey: "expo", line: 1 }]);
  });
  test("dynamic import → export_name '' (no callback dataflow)", () => {
    expect(scan(`const m = import("expo").then(x => x.foo);`)).toEqual([{ usageType: "dynamic-import", exportName: "", dependencyKey: "expo", line: 1 }]);
  });
  test("require destructuring records the property names", () => {
    expect(scan(`const { registerRootComponent, Foo: Bar } = require("expo");`)).toEqual([
      { usageType: "require", exportName: "Foo", dependencyKey: "expo", line: 1 },
      { usageType: "require", exportName: "registerRootComponent", dependencyKey: "expo", line: 1 },
    ]);
  });
  test("require member access records the member name", () => {
    expect(scan(`const x = require("expo").registerRootComponent;`)).toEqual([{ usageType: "require", exportName: "registerRootComponent", dependencyKey: "expo", line: 1 }]);
  });
  test("whole-module require → export_name ''", () => {
    expect(scan(`const expo = require("expo");`)).toEqual([{ usageType: "require", exportName: "", dependencyKey: "expo", line: 1 }]);
    expect(scan(`require("expo");`)).toEqual([{ usageType: "require", exportName: "", dependencyKey: "expo", line: 1 }]);
  });
  test("TS import-equals (`import x = require(...)`) is a require form", () => {
    expect(scan(`import expo = require("expo");`)).toEqual([{ usageType: "require", exportName: "", dependencyKey: "expo", line: 1 }]);
  });
  test("dynamic import is BINDABLE through await: destructure + member access map export names", () => {
    expect(scan(`const { foo, bar: baz } = await import("expo");`)).toEqual([
      { usageType: "dynamic-import", exportName: "bar", dependencyKey: "expo", line: 1 },
      { usageType: "dynamic-import", exportName: "foo", dependencyKey: "expo", line: 1 },
    ]);
    expect(scan(`const x = (await import("expo")).registerRootComponent;`)).toEqual([
      { usageType: "dynamic-import", exportName: "registerRootComponent", dependencyKey: "expo", line: 1 },
    ]);
  });
  test("a lexically SHADOWED `require` is not CommonJS require", () => {
    expect(scan(`function f(require: (s: string) => unknown) { require("expo"); }`)).toEqual([]);
    expect(scan(`{ const require = (s: string) => s; require("expo"); }`)).toEqual([]);
    // loop-scoped bindings named `require` also shadow
    expect(scan(`for (const require of loaders) { require("expo"); }`)).toEqual([]);
    expect(scan(`for (let require = mock; ok; step()) { require("expo"); }`)).toEqual([]);
    // an UNshadowed sibling scope still records
    expect(scan(`function f(require: unknown) {}\nrequire("expo");`)).toEqual([{ usageType: "require", exportName: "", dependencyKey: "expo", line: 2 }]);
  });
  test("string-literal element access on require / awaited dynamic-import maps the export name", () => {
    expect(scan(`const x = require("expo")["registerRootComponent"];`)).toEqual([
      { usageType: "require", exportName: "registerRootComponent", dependencyKey: "expo", line: 1 },
    ]);
    expect(scan(`const x = (await import("expo"))["registerRootComponent"];`)).toEqual([
      { usageType: "dynamic-import", exportName: "registerRootComponent", dependencyKey: "expo", line: 1 },
    ]);
  });
  test("a string-literal destructuring KEY maps the source export name", () => {
    expect(scan(`const { "registerRootComponent": r } = require("expo");`)).toEqual([
      { usageType: "require", exportName: "registerRootComponent", dependencyKey: "expo", line: 1 },
    ]);
    expect(scan(`const { "foo": f } = await import("expo");`)).toEqual([
      { usageType: "dynamic-import", exportName: "foo", dependencyKey: "expo", line: 1 },
    ]);
  });
  test("a rest element is NOT a named export (no false positive); it degrades to whole-module ''", () => {
    expect(scan(`const { ...rest } = require("expo");`)).toEqual([
      { usageType: "require", exportName: "", dependencyKey: "expo", line: 1 },
    ]);
    // a named element alongside a rest still maps the named one; rest is dropped
    expect(scan(`const { foo, ...rest } = require("expo");`)).toEqual([
      { usageType: "require", exportName: "foo", dependencyKey: "expo", line: 1 },
    ]);
  });
  test("destructuring ASSIGNMENT from require maps the export names", () => {
    expect(scan(`let x; ({ registerRootComponent: x } = require("expo"));`)).toEqual([
      { usageType: "require", exportName: "registerRootComponent", dependencyKey: "expo", line: 1 },
    ]);
    expect(scan(`let a; ({ a } = require("expo"));`)).toEqual([
      { usageType: "require", exportName: "a", dependencyKey: "expo", line: 1 },
    ]);
  });
  test("transparent TS wrappers (as / ! / satisfies / <T>) don't hide the binding", () => {
    expect(scan(`const x = (require("expo") as any).registerRootComponent;`)).toEqual([
      { usageType: "require", exportName: "registerRootComponent", dependencyKey: "expo", line: 1 },
    ]);
    expect(scan(`const { registerRootComponent } = require("expo") as any;`)).toEqual([
      { usageType: "require", exportName: "registerRootComponent", dependencyKey: "expo", line: 1 },
    ]);
    expect(scan(`const x = require("expo")!.foo;`)).toEqual([
      { usageType: "require", exportName: "foo", dependencyKey: "expo", line: 1 },
    ]);
    expect(scan(`const { foo } = (await import("expo")) satisfies any;`)).toEqual([
      { usageType: "dynamic-import", exportName: "foo", dependencyKey: "expo", line: 1 },
    ]);
  });
  test("a NUMERIC element/destructure key degrades to whole-module '' (never a numeric export)", () => {
    expect(scan(`const x = require("expo")[0];`)).toEqual([{ usageType: "require", exportName: "", dependencyKey: "expo", line: 1 }]);
    expect(scan(`const { 0: zero } = require("expo");`)).toEqual([{ usageType: "require", exportName: "", dependencyKey: "expo", line: 1 }]);
  });
  test("a computed element/destructure key degrades to whole-module ''", () => {
    expect(scan(`const k = "x"; const v = require("expo")[k];`)).toEqual([{ usageType: "require", exportName: "", dependencyKey: "expo", line: 1 }]);
  });
});

describe("scanUsage — attribution + matching", () => {
  test("subpath import attributes to the matched install name and keeps the named binding", () => {
    expect(scan(`import { useRouter } from "expo/router";`)).toEqual([{ usageType: "named-import", exportName: "useRouter", dependencyKey: "expo", line: 1 }]);
  });
  test("an ALIAS install: the alias key is the dependency_key; the bare name does NOT match", () => {
    const aliased: TrackedPackage[] = [{ packageName: "expo", installNames: new Set(["my-expo"]) }];
    expect(scan(`import { foo } from "my-expo";`, aliased)).toEqual([{ usageType: "named-import", exportName: "foo", dependencyKey: "my-expo", line: 1 }]);
    expect(scan(`import { foo } from "expo";`, aliased)).toEqual([]); // bare name not installed under alias
  });
  test("no owning manifest (empty install names) → no rows", () => {
    expect(scan(`import { foo } from "expo";`, [{ packageName: "expo", installNames: new Set() }])).toEqual([]);
  });
  test("untracked specifiers produce no rows; expo is not substring-matched", () => {
    expect(scan(`import { x } from "react";\nconst y = "export";`)).toEqual([]);
  });
  test("multiple lines get distinct line numbers", () => {
    const r = scan(`import { a } from "expo";\n\nimport { b } from "expo";`);
    expect(r.map((x) => x.line)).toEqual([1, 3]);
  });
});

describe("scanUsage — robustness + loaders", () => {
  test("TSX file with JSX parses", () => {
    expect(scan(`import { Foo } from "expo";\nconst x = <div/>;`, expo, "src/App.tsx")).toEqual([{ usageType: "named-import", exportName: "Foo", dependencyKey: "expo", line: 1 }]);
  });
  test("full row shape has a commit-pinned permalink and trimmed snippet", () => {
    const rows = scanUsage(`  import { foo } from "expo";`, ctx(), expo);
    expect(rows[0]!.permalink).toBe("https://github.com/org-a/repo/blob/abc123def/src/index.ts#L1");
    expect(rows[0]!.snippet).toBe(`import { foo } from "expo";`);
  });
  test("fails OPEN (no rows, no throw) on a path buildPermalink rejects", () => {
    expect(scanUsage(`import { foo } from "expo";`, ctx("src/we\\ird.ts"), expo)).toEqual([]);
    expect(scanUsage(`import { foo } from "expo";`, ctx("src/we\nird.ts"), expo)).toEqual([]);
    expect(scanUsage(`import { foo } from "expo";`, ctx("../escape.ts"), expo)).toEqual([]);
  });
  test("snippet stays aligned with TS's line map on exotic terminators (U+2028, lone \\r)", () => {
    const u2028 = scanUsage(`const a = 1;\u2028import { foo } from "expo";`, ctx(), expo);
    expect(u2028[0]!.lineNumber).toBe(2);
    expect(u2028[0]!.snippet).toBe(`import { foo } from "expo";`);
    const loneCr = scanUsage(`const a = 1;\rimport { foo } from "expo";`, ctx(), expo);
    expect(loneCr[0]!.lineNumber).toBe(2);
    expect(loneCr[0]!.snippet).toBe(`import { foo } from "expo";`);
  });
  test("CRLF content keeps clean snippets", () => {
    const rows = scanUsage(`const a = 1;\r\nimport { foo } from "expo";\r\n`, ctx(), expo);
    expect(rows[0]!.lineNumber).toBe(2);
    expect(rows[0]!.snippet).toBe(`import { foo } from "expo";`);
  });
});
