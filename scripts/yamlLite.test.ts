import { expect, test, describe } from "bun:test";
import {
  parseYamlLite, asMap, asScalar, getEntry, getChild, nodeLineSpan, YamlLiteError,
  type YamlMap,
} from "./yamlLite.ts";

describe("parseYamlLite — block mappings", () => {
  test("nested maps with scalar leaves", () => {
    const root = asMap(parseYamlLite(`a:\n  b: 1\n  c: two\nd: three\n`));
    expect(asScalar(getChild(asMap(getChild(root, "a")), "b"))).toBe("1");
    expect(asScalar(getChild(asMap(getChild(root, "a")), "c"))).toBe("two");
    expect(asScalar(getChild(root, "d"))).toBe("three");
  });
  test("quoted keys containing ':' '@' '/' are preserved", () => {
    const root = asMap(parseYamlLite(`'@babel/core@npm:^7.0.0':\n  version: 7.10.4\n`));
    const entry = getEntry(root, "@babel/core@npm:^7.0.0");
    expect(entry).not.toBeNull();
    expect(asScalar(getChild(asMap(entry!.value), "version"))).toBe("7.10.4");
  });
  test("quoted scalar values unwrap; '#' inside quotes is not a comment", () => {
    const root = asMap(parseYamlLite(`checksum: "abc#def"\nresolution: '@scope/x@npm:1.0.0'\n`));
    expect(asScalar(getChild(root, "checksum"))).toBe("abc#def");
    expect(asScalar(getChild(root, "resolution"))).toBe("@scope/x@npm:1.0.0");
  });
  test("inline comments and blank lines are ignored; whole-line comments too", () => {
    const root = asMap(parseYamlLite(`# header\na: 1  # trailing\n\nb: 2\n`));
    expect(asScalar(getChild(root, "a"))).toBe("1");
    expect(asScalar(getChild(root, "b"))).toBe("2");
  });
  test("empty flow collections {} and []", () => {
    const root = asMap(parseYamlLite(`deps: {}\nlist: []\n`));
    expect(getChild(root, "deps")).toEqual({ kind: "map", entries: [], line: 1 });
    expect(getChild(root, "list")).toEqual({ kind: "seq", items: [], line: 2 });
  });
});

describe("parseYamlLite — pnpm-ish shapes", () => {
  test("importers edge with object form", () => {
    const text = [
      `lockfileVersion: '6.0'`, //          1
      `importers:`, //                      2
      `  .:`, //                            3
      `    dependencies:`, //               4
      `      expo:`, //                     5
      `        specifier: ^50.0.0`, //      6
      `        version: 50.0.4`, //         7
    ].join("\n");
    const root = asMap(parseYamlLite(text));
    const importers = asMap(getChild(root, "importers"));
    const rootImporter = asMap(getChild(importers, "."));
    const deps = asMap(getChild(rootImporter, "dependencies"));
    const expo = asMap(getChild(deps, "expo"));
    expect(asScalar(getChild(expo, "specifier"))).toBe("^50.0.0");
    expect(asScalar(getChild(expo, "version"))).toBe("50.0.4");
  });
  test("line span of a dependency entry covers its whole block", () => {
    const text = [
      `dependencies:`, //   1
      `  expo:`, //         2
      `    specifier: ^50`, // 3
      `    version: 50.0.4`, // 4
      `  react:`, //        5
      `    version: 18.0.0`, // 6
    ].join("\n");
    const deps = asMap(getChild(asMap(parseYamlLite(text)), "dependencies"));
    const expo = getEntry(deps, "expo")!;
    expect(nodeLineSpan(expo)).toEqual([2, 4]);
  });
  test("string-form importer edge (older pnpm)", () => {
    const text = [`dependencies:`, `  expo: 50.0.4`, `specifiers:`, `  expo: ^50.0.0`].join("\n");
    const root = asMap(parseYamlLite(text));
    expect(asScalar(getChild(asMap(getChild(root, "dependencies")), "expo"))).toBe("50.0.4");
    expect(asScalar(getChild(asMap(getChild(root, "specifiers")), "expo"))).toBe("^50.0.0");
  });
});

describe("parseYamlLite — sequences", () => {
  test("inline scalar sequence items", () => {
    const root = asMap(parseYamlLite(`bin:\n  - cli.js\n  - other.js\n`));
    const seq = getChild(root, "bin");
    expect(seq?.kind).toBe("seq");
    if (seq !== undefined && seq.kind === "seq")
      expect(seq.items.map((i) => (i.kind === "scalar" ? i.value : ""))).toEqual(["cli.js", "other.js"]);
  });
});

describe("parseYamlLite — fail closed", () => {
  const bad: Array<[string, string]> = [
    ["anchors", `a: &anchor 1\nb: *anchor\n`],
    ["merge keys", `a:\n  <<: *base\n`],
    ["tags", `a: !!str 1\n`],
    ["block scalar |", `a: |\n  text\n`],
    ["block scalar >", `a: >\n  text\n`],
    ["tab indentation", `a:\n\tb: 1\n`],
    ["non-empty flow map", `a: {b: 1}\n`],
    ["non-empty flow seq", `a: [1, 2]\n`],
  ];
  for (const [name, text] of bad) test(name, () => expect(() => parseYamlLite(text)).toThrow(YamlLiteError));
});

describe("fail-closed boundary pins", () => {
  test("a URL value containing '&' and '*' mid-token is NOT mis-flagged as an anchor/alias", () => {
    const root = asMap(parseYamlLite(`resolved: "https://x/y?a=1&b=2*3"\nplain: git+https://h/r.git#a*b\n`));
    expect(asScalar(getChild(root, "resolved"))).toBe("https://x/y?a=1&b=2*3");
    expect(asScalar(getChild(root, "plain"))).toBe("git+https://h/r.git#a*b");
  });
  test("a block-sequence of block-maps throws (fail-closed skip, not mis-parse)", () => {
    expect(() => parseYamlLite(`items:\n  - name: a\n    ver: 1\n`)).toThrow(YamlLiteError);
  });
});

describe("navigation helpers", () => {
  test("asMap/asScalar/getEntry return null on mismatch", () => {
    const root = parseYamlLite(`a: 1\n`) as YamlMap;
    expect(asMap({ kind: "scalar", value: "x", line: 1 })).toBeNull();
    expect(asScalar(root)).toBeNull();
    expect(getEntry(root, "missing")).toBeNull();
    expect(getChild(root, "missing")).toBeUndefined();
  });
});
