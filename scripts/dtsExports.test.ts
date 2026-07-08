import { expect, test, describe } from "bun:test";
import { enumerateDtsExports, joinRelative, type DtsResolver } from "./dtsExports.ts";

const noFollow: DtsResolver = () => null;
const names = (src: string, resolver: DtsResolver = noFollow): string[] =>
  enumerateDtsExports(src, "index.d.ts", resolver).map((e) => e.name);

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
    const resolver: DtsResolver = (spec) => files[spec.replace("./", "")] ?? null;
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
    const resolver: DtsResolver = (spec) => files[spec.replace("./", "")] ?? null;
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
      const key = joinRelative(from, spec) + ".d.ts";
      return files[key] ?? files[spec.replace("./", "") + ".d.ts"] ?? null;
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
