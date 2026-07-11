import { expect, test, describe } from "bun:test";
import {
  enumerateDtsExports, joinRelative, createParseBudget,
  MAX_FOLLOW_FILES, MAX_EXPORTS_PER_FILE, MAX_PARSE_FILE_BYTES, MAX_PARSE_FILES, MAX_TOTAL_PARSE_BYTES,
  type DtsResolver,
} from "./dtsExports.ts";

const noFollow: DtsResolver = () => null;
const names = (src: string, resolver: DtsResolver = noFollow): string[] =>
  enumerateDtsExports(src, "index.d.ts", resolver).map((e) => e.name);

// Build a resolver over a files map keyed by the module base (spec sans leading "./"); the
// canonicalPath is that key (the "file it opened"), per the new DtsResolver contract.
const barrelResolver = (files: Record<string, string>): DtsResolver => (spec) => {
  const key = spec.replace("./", "");
  const text = files[key];
  return text === undefined ? null : { text, canonicalPath: key };
};

describe("enumerateDtsExports — declaration forms", () => {
  test("exported function/class/const/enum are named", () => {
    const src = `
      export declare function foo(): void;
      export declare class Bar {}
      export declare const baz: number;
      export declare enum E { A, B }
    `;
    expect(names(src).sort()).toEqual(["Bar", "E", "baz", "foo"]);
  });
  test("interfaces and type aliases are type exports", () => {
    const exp = enumerateDtsExports(`export interface I { x: number } export type T = string;`, "i.d.ts", noFollow);
    expect(exp).toEqual([
      { name: "I", kind: "type" },
      { name: "T", kind: "type" },
    ]);
  });
  test("export default (declaration) and export = record a default", () => {
    expect(enumerateDtsExports(`declare class C {} export default C;`, "d.d.ts", noFollow)).toContainEqual({ name: "", kind: "default" });
    expect(enumerateDtsExports(`declare class C {} export = C;`, "e.d.ts", noFollow)).toContainEqual({ name: "", kind: "default" });
    expect(enumerateDtsExports(`export default function f(): void;`, "f.d.ts", noFollow)).toContainEqual({ name: "", kind: "default" });
  });
  test("export { X as default } and export { default } record a default surface", () => {
    expect(enumerateDtsExports(`declare const X: 1; export { X as default };`, "a.d.ts", noFollow)).toContainEqual({ name: "", kind: "default" });
    // `export { default as Named }` is a NAMED export of Named, not a default
    expect(enumerateDtsExports(`export { default as Named } from "./m";`, "b.d.ts", noFollow)).toEqual([{ name: "Named", kind: "named" }]);
  });
});

describe("enumerateDtsExports — export clauses", () => {
  test("named export list with aliases", () => {
    expect(names(`declare const a: 1, b: 2; export { a, b as c };`).sort()).toEqual(["a", "c"]);
  });
  test("export * as ns binds one name", () => {
    expect(names(`export * as utils from "./utils";`)).toEqual(["utils"]);
  });
  test("type-only export marks kind type", () => {
    const exp = enumerateDtsExports(`declare type T = string; export type { T };`, "t.d.ts", noFollow);
    expect(exp).toEqual([{ name: "T", kind: "type" }]);
  });
  test("a value export outranks a same-name type export", () => {
    const exp = enumerateDtsExports(`export declare const X: number; export type { X };`, "x.d.ts", noFollow);
    expect(exp).toEqual([{ name: "X", kind: "named" }]);
  });
});

describe("enumerateDtsExports — re-export following", () => {
  test("export * from './internal' hoists the target's named exports", () => {
    const files: Record<string, string> = {
      "internal": `export declare function fromInternal(): void; export declare const alsoInternal: number;`,
    };
    const resolver = barrelResolver(files);
    expect(names(`export * from "./internal"; export declare function local(): void;`, resolver).sort()).toEqual([
      "alsoInternal",
      "fromInternal",
      "local",
    ]);
  });
  test("export * from './m' hoists named/type exports but NOT the child's default", () => {
    const files: Record<string, string> = {
      "internal": `export declare const named: number;\nexport interface T {}\nexport default class Hidden {}`,
    };
    const resolver = barrelResolver(files);
    const out = enumerateDtsExports(`export * from "./internal";`, "index.d.ts", resolver);
    // the child's default must NOT appear as the barrel's default
    expect(out).not.toContainEqual({ name: "", kind: "default" });
    expect(out).toContainEqual({ name: "named", kind: "named" });
    expect(out).toContainEqual({ name: "T", kind: "type" });
  });
  test("the ROOT file's own default IS kept (only export-star edges drop the default)", () => {
    expect(enumerateDtsExports(`export default class C {}\nexport declare const x: 1;`, "index.d.ts", () => null)).toContainEqual({ name: "", kind: "default" });
  });
  test("external (non-relative) specifiers are NOT followed", () => {
    const resolver: DtsResolver = () => {
      throw new Error("should not resolve external");
    };
    expect(names(`export * from "react";`, resolver)).toEqual([]);
  });
  test("a re-export cycle terminates", () => {
    const files: Record<string, string> = {
      "a.d.ts": `export * from "./b"; export declare const fromA: number;`,
      "b.d.ts": `export * from "./a"; export declare const fromB: number;`,
    };
    const resolver: DtsResolver = (spec, from) => {
      const k1 = joinRelative(from, spec) + ".d.ts";
      const k2 = spec.replace("./", "") + ".d.ts";
      if (files[k1] !== undefined) return { text: files[k1]!, canonicalPath: k1 };
      if (files[k2] !== undefined) return { text: files[k2]!, canonicalPath: k2 };
      return null;
    };
    const out = enumerateDtsExports(files["a.d.ts"]!, "a.d.ts", resolver).map((e) => e.name);
    expect(out).toContain("fromA");
    // cycle does not hang; fromB is reached via the re-export
    expect(out).toContain("fromB");
  });
  test("a resolver returning null (unresolvable) is skipped without error", () => {
    expect(names(`export * from "./missing"; export declare const here: number;`, () => null)).toEqual(["here"]);
  });
});

describe("joinRelative", () => {
  test("collapses ./ and ../ against the importer dir", () => {
    expect(joinRelative("lib/index.d.ts", "./sub/mod")).toBe("lib/sub/mod");
    expect(joinRelative("lib/index.d.ts", "../other")).toBe("other");
    expect(joinRelative("index.d.ts", "./a/b/../c")).toBe("a/c");
  });
});

describe("enumerateDtsExports — output ordering", () => {
  test("sorted by (kind, name) deterministically", () => {
    const exp = enumerateDtsExports(
      `export declare const b: 1; export declare const a: 2; export interface Z {} export interface A {}`,
      "o.d.ts",
      noFollow,
    );
    expect(exp).toEqual([
      { name: "a", kind: "named" },
      { name: "b", kind: "named" },
      { name: "A", kind: "type" },
      { name: "Z", kind: "type" },
    ]);
  });
});

// ---- §7 parse budgets + per-file caps (injectable, deterministic) ---------------------------
describe("enumerateDtsExports — §7 fail-closed bounds", () => {
  test("the exported budget defaults hold their documented values", () => {
    expect(MAX_FOLLOW_FILES).toBe(200);
    expect(MAX_EXPORTS_PER_FILE).toBe(65_536);
    expect(MAX_PARSE_FILE_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_PARSE_FILES).toBe(4096);
    expect(MAX_TOTAL_PARSE_BYTES).toBe(256 * 1024 * 1024);
  });

  test("§C per-file export cap: a file over the cap throws fail-closed; at-cap succeeds", () => {
    const three = `export declare const a: 1; export declare const b: 2; export declare const c: 3;`;
    expect(() => enumerateDtsExports(three, "x.d.ts", noFollow, createParseBudget({ maxExportsPerFile: 2 }))).toThrow(/exports exceed 2/);
    const ok = enumerateDtsExports(`export declare const a: 1; export declare const b: 2;`, "x.d.ts", noFollow, createParseBudget({ maxExportsPerFile: 2 }));
    expect(ok.map((e) => e.name).sort()).toEqual(["a", "b"]);
  });

  test("§B1 per-file byte cap: a source over the cap throws BEFORE createSourceFile; under passes", () => {
    const src = `export declare const x: 1;`.padEnd(100, " ");
    expect(() => enumerateDtsExports(src, "big.d.ts", noFollow, createParseBudget({ maxParseFileBytes: 10 }))).toThrow(/\.d\.ts file exceeds 10 bytes/);
    expect(() => enumerateDtsExports(src, "big.d.ts", noFollow, createParseBudget({ maxParseFileBytes: 1000 }))).not.toThrow();
  });

  test("§B2 global parse-COUNT cap fails closed across followed files; at-cap passes", () => {
    const resolver = barrelResolver({ child: `export declare const c: number;` });
    // root + child = 2 parses
    expect(() => enumerateDtsExports(`export * from "./child";`, "root.d.ts", resolver, createParseBudget({ maxParseFiles: 1 }))).toThrow(/parsed \.d\.ts files exceed 1/);
    expect(() => enumerateDtsExports(`export * from "./child";`, "root.d.ts", resolver, createParseBudget({ maxParseFiles: 2 }))).not.toThrow();
  });

  test("§B3 global cumulative parsed-BYTES budget fails closed independent of count", () => {
    const child = `export declare const c: 1;`.padEnd(300, " ");
    const resolver = barrelResolver({ child });
    const root = `export * from "./child";`; // small root + big child
    expect(() => enumerateDtsExports(root, "root.d.ts", resolver, createParseBudget({ maxTotalParseBytes: 100 }))).toThrow(/total parsed \.d\.ts bytes exceed 100/);
    expect(() => enumerateDtsExports(root, "root.d.ts", resolver, createParseBudget({ maxTotalParseBytes: 10_000 }))).not.toThrow();
  });

  test("§B4 CANONICAL memo: a root parsed via a shared budget is memoized across enumerateDtsExports calls", () => {
    // models inspectExtracted's subpath aliases funneling the SAME canonical root through the shared
    // budget: the second call is a memo hit (this is what lets many subpath aliases parse once).
    const budget = createParseBudget();
    const src = `export declare const a: 1;`;
    enumerateDtsExports(src, "index.d.ts", noFollow, budget);
    enumerateDtsExports(src, "index.d.ts", noFollow, budget);
    expect(budget.filesParsed).toBe(1);
  });

  test("§B4 CANONICAL memo: a child re-exported from two barrels is parsed EXACTLY once (shared budget)", () => {
    const resolver = barrelResolver({
      b1: `export * from "./child";`,
      b2: `export * from "./child";`,
      child: `export declare const c: number;`,
    });
    const budget = createParseBudget();
    const out = enumerateDtsExports(`export * from "./b1"; export * from "./b2";`, "root.d.ts", resolver, budget);
    expect(budget.filesParsed).toBe(4); // root + b1 + b2 + child(once, deduped)
    expect(out.map((e) => e.name)).toContain("c"); // child surface still collected
  });

  test("§D1 re-export follow cap THROWS on the (limit+1)-th edge (no silent truncation)", () => {
    const resolver = barrelResolver({ b1: `export * from "./b2";`, b2: `export declare const leaf: number;` });
    // root→b1→b2 = 2 follows
    expect(() => enumerateDtsExports(`export * from "./b1";`, "root.d.ts", resolver, createParseBudget({ maxFollowFiles: 1 }))).toThrow(/follow limit 1 exceeded/);
    expect(() => enumerateDtsExports(`export * from "./b1";`, "root.d.ts", resolver, createParseBudget({ maxFollowFiles: 2 }))).not.toThrow();
  });
});
