import { expect, test, describe } from "bun:test";
import { isValidPackageName, MAX_PACKAGE_NAME_LEN } from "./packageName.ts";

// A REAL backslash, built from its char code so no source-level escaping obscures the payload.
const BS = String.fromCharCode(92);

describe("isValidPackageName — accepts real npm names", () => {
  const accepted = ["lodash", "@scope/pkg", "@babel/core", "lodash.merge", "left-pad", "@types/node", "JSONStream"];
  for (const name of accepted)
    test(`accepts ${JSON.stringify(name)}`, () => expect(isValidPackageName(name)).toBe(true));
});

describe("isValidPackageName — rejects injecting / malformed names (fail-closed)", () => {
  const rejected = [
    `@x${BS}..${BS}admin`, // real backslashes → no "/" → scoped-without-slash
    "%2e%2e/%2e%2e/admin?x=1", // percent-encoded traversal + query
    "@x/../../admin?x=1", // dot-segment traversal in a scoped name
    "../../admin#f", // relative traversal + fragment
    "@a/b/c", // multi-slash scoped name (rest still contains "/")
    "pkg?x=1", // query injection
    "pkg#f", // fragment injection
    "_hidden", // leading underscore
    ".dot", // leading dot
    "", // empty
  ];
  for (const name of rejected)
    test(`rejects ${JSON.stringify(name)}`, () => expect(isValidPackageName(name)).toBe(false));
});

describe("isValidPackageName — length + type guards", () => {
  test("MAX_PACKAGE_NAME_LEN is 214", () => expect(MAX_PACKAGE_NAME_LEN).toBe(214));
  test("accepts a name exactly at the length cap", () =>
    expect(isValidPackageName("a".repeat(MAX_PACKAGE_NAME_LEN))).toBe(true));
  test("rejects a name one over the length cap", () =>
    expect(isValidPackageName("a".repeat(MAX_PACKAGE_NAME_LEN + 1))).toBe(false));
  test("rejects a non-string input", () => expect(isValidPackageName(null as unknown as string)).toBe(false));
});
