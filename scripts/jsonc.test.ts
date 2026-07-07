import { expect, test, describe } from "bun:test";
import { parseJsonc, parseJsoncObject, escapePointer, JsoncError } from "./jsonc.ts";

describe("parseJsonc — standard JSON", () => {
  test("parses objects, arrays, scalars", () => {
    const { value } = parseJsonc(`{"a":1,"b":[true,null,"x"],"c":{"d":-2.5e3}}`);
    expect(value).toEqual({ a: 1, b: [true, null, "x"], c: { d: -2500 } });
  });
  test("matches JSON.parse on a realistic package.json", () => {
    const text = `{"name":"pkg","version":"1.0.0","dependencies":{"lodash":"^4.17.21"}}`;
    expect(parseJsonc(text).value).toEqual(JSON.parse(text));
  });
});

describe("parseJsonc — JSONC/JSON5 tolerance", () => {
  test("line and block comments", () => {
    const { value } = parseJsonc(`{
      // leading comment
      "a": 1, /* inline */ "b": 2
      /* trailing
         multiline */
    }`);
    expect(value).toEqual({ a: 1, b: 2 });
  });
  test("trailing commas in objects and arrays", () => {
    expect(parseJsonc(`{"a":1,"b":[1,2,],}`).value).toEqual({ a: 1, b: [1, 2] });
  });
  test("BOM is stripped", () => {
    expect(parseJsonc(`﻿{"a":1}`).value).toEqual({ a: 1 });
  });
  test("single-quoted strings and unquoted identifier keys", () => {
    expect(parseJsonc(`{a:'x',b:'y'}`).value).toEqual({ a: "x", b: "y" });
  });
  test("duplicate keys: last writer wins", () => {
    const { value, keyLines } = parseJsonc(`{\n"a":1,\n"a":2\n}`);
    expect(value).toEqual({ a: 2 });
    expect(keyLines.get("/a")).toBe(3); // the last key's line
  });
});

describe("parseJsonc — line tracking", () => {
  test("records the 1-based line of each dependency key", () => {
    const text = [
      `{`, //                             1
      `  "name": "pkg",`, //              2
      `  "dependencies": {`, //           3
      `    "lodash": "^4.17.21",`, //     4
      `    "@scope/pkg": "~2.0.0"`, //    5
      `  }`, //                           6
      `}`, //                             7
    ].join("\n");
    const { keyLines } = parseJsonc(text);
    expect(keyLines.get("/dependencies")).toBe(3);
    expect(keyLines.get("/dependencies/lodash")).toBe(4);
    expect(keyLines.get("/dependencies/@scope~1pkg")).toBe(5); // '/' escaped as ~1
  });
  test("block comments shift subsequent line numbers correctly", () => {
    const text = [
      `{`, //                          1
      `  /* two`, //                   2
      `     line */`, //               3
      `  "dependencies": {`, //        4
      `    "x": "1.0.0"`, //           5
      `  }`, //                        6
      `}`,
    ].join("\n");
    const { keyLines } = parseJsonc(text);
    expect(keyLines.get("/dependencies/x")).toBe(5);
  });
  test("nested paths (overrides) get pointer keys", () => {
    const text = [
      `{`,
      `  "overrides": {`,
      `    "foo": {`,
      `      "bar": "1.0.0"`,
      `    }`,
      `  }`,
      `}`,
    ].join("\n");
    const { keyLines } = parseJsonc(text);
    expect(keyLines.get("/overrides/foo/bar")).toBe(4);
  });
});

describe("escapePointer", () => {
  test("escapes ~ and / per RFC 6901", () => {
    expect(escapePointer("@scope/name")).toBe("@scope~1name");
    expect(escapePointer("a~b/c")).toBe("a~0b~1c");
  });
});

describe("parseJsonc — failures", () => {
  const bad = [
    ["unterminated string", `{"a":"x}`],
    ["unterminated block comment", `{"a":1} /* oops`],
    ["missing colon", `{"a" 1}`],
    ["trailing junk", `{"a":1} garbage`],
    ["bad number 1..2", `{"a":1..2}`],
    ["empty input", ``],
    // strict-number fail-closed (untrusted manifest content)
    ["leading zero", `{"a":01}`],
    ["unary plus", `{"a":+1}`],
    ["trailing dot", `{"a":1.}`],
    ["leading dot", `{"a":.5}`],
    ["bare exponent", `{"a":1e}`],
    ["overflow to Infinity", `{"a":1e9999}`],
    ["overflow to -Infinity", `{"a":-1e9999}`],
    ["NaN literal", `{"a":NaN}`],
    ["Infinity literal", `{"a":Infinity}`],
    ["-Infinity literal", `{"a":-Infinity}`],
    // strict-string fail-closed
    ["unknown escape", `{"a":"\\x"}`],
    ["raw newline in string", `{"a":"line1\nline2"}`],
    ["bareword literal with suffix truexyz", `{"a":truexyz}`],
    ["bareword literal nulll", `{"a":nulll}`],
  ];
  for (const [name, text] of bad)
    test(name!, () => expect(() => parseJsonc(text!)).toThrow(JsoncError));

  test("JsoncError carries a line number", () => {
    try {
      parseJsonc(`{\n  "a": ,\n}`);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(JsoncError);
      expect((e as JsoncError).line).toBe(2);
    }
  });
});

describe("prototype-pollution safety", () => {
  test("a __proto__ key is a normal own property, not a prototype mutation", () => {
    const { value } = parseJsonc(`{ "__proto__": { "polluted": true }, "a": 1 }`);
    const obj = value as Record<string, unknown>;
    expect(Object.getPrototypeOf(obj)).toBeNull(); // null-proto parse
    expect(Object.hasOwn(obj, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined(); // global proto untouched
  });
  test("a __proto__ section does not leak an inherited dependencies map", () => {
    // eslint-disable-next-line no-useless-escape
    const { value } = parseJsonc(`{ "__proto__": { "dependencies": { "expo": "^50" } } }`);
    const obj = value as Record<string, unknown>;
    expect(obj["dependencies"]).toBeUndefined(); // not inherited through the prototype
  });
});

describe("parseJsoncObject", () => {
  test("requires an object root", () => {
    expect(parseJsoncObject(`{"a":1}`).value).toEqual({ a: 1 });
    expect(() => parseJsoncObject(`[1,2]`)).toThrow(JsoncError);
    expect(() => parseJsoncObject(`"x"`)).toThrow(JsoncError);
  });
});
