import { expect, test, describe } from "bun:test";
import { buildPermalink, type PermalinkInput } from "./permalink.ts";

const SHA = "abc1230000000000000000000000000000000000"; // 40-hex
const base: Omit<PermalinkInput, "line"> = {
  githubHost: "github.com",
  org: "org-a",
  repo: "service-x",
  commitSha: SHA,
  path: "package.json",
};

describe("buildPermalink — happy path", () => {
  test("single line", () =>
    expect(buildPermalink({ ...base, line: 23 })).toBe(`https://github.com/org-a/service-x/blob/${SHA}/package.json#L23`));
  test("multi-line span", () =>
    expect(buildPermalink({ ...base, path: "package-lock.json", line: [451, 452] })).toBe(
      `https://github.com/org-a/service-x/blob/${SHA}/package-lock.json#L451-L452`,
    ));
  test("single-line span collapses to #Ln", () =>
    expect(buildPermalink({ ...base, line: [5, 5] })).toBe(`https://github.com/org-a/service-x/blob/${SHA}/package.json#L5`));
  test("nested path preserves '/' separators, encodes segments", () =>
    expect(buildPermalink({ ...base, path: "src/app/index.ts", line: 1 })).toBe(
      `https://github.com/org-a/service-x/blob/${SHA}/src/app/index.ts#L1`,
    ));
  test("path segment with space is percent-encoded", () =>
    expect(buildPermalink({ ...base, path: "src/my file.ts", line: 1 })).toContain("/src/my%20file.ts#L1"));
  test("scoped-looking segment '@x' is encoded per segment", () =>
    expect(buildPermalink({ ...base, path: "packages/@scope/x.ts", line: 2 })).toContain("/packages/%40scope/x.ts#L2"));
});

describe("buildPermalink — host handling", () => {
  test("GHES host works", () =>
    expect(buildPermalink({ ...base, githubHost: "git.example.com", line: 1 })).toBe(
      `https://git.example.com/org-a/service-x/blob/${SHA}/package.json#L1`,
    ));
  test("host with scheme + trailing slash is normalized", () =>
    expect(buildPermalink({ ...base, githubHost: "https://ghe.example.com/", line: 1 })).toBe(
      `https://ghe.example.com/org-a/service-x/blob/${SHA}/package.json#L1`,
    ));
  test("host:port preserved", () =>
    expect(buildPermalink({ ...base, githubHost: "ghe.example.com:8443", line: 1 })).toContain("https://ghe.example.com:8443/"));
});

describe("buildPermalink — validation throws", () => {
  const bad: Array<[string, Partial<PermalinkInput>]> = [
    ["branch-like commitSha", { commitSha: "main" }],
    ["short non-hex sha", { commitSha: "zzz" }],
    ["absolute path", { path: "/etc/passwd" }],
    ["trailing slash path", { path: "src/" }],
    ["double-slash path", { path: "src//x.ts" }],
    ["dotdot path", { path: "src/../x.ts" }],
    ["backslash path", { path: "src\\x.ts" }],
    ["empty path", { path: "" }],
    ["empty org", { org: "" }],
    ["org with slash", { org: "a/b" }],
    ["empty host", { githubHost: "" }],
    ["host with slash", { githubHost: "a/b.com" }],
    ["host with userinfo @", { githubHost: "evil.com@github.com" }],
    ["host with non-numeric port", { githubHost: "github.com:abc" }],
    ["host with out-of-range port", { githubHost: "github.com:99999" }],
    ["host with underscore/invalid char", { githubHost: "gh_e.com" }],
  ];
  for (const [name, patch] of bad)
    test(name, () => expect(() => buildPermalink({ ...base, line: 1, ...patch })).toThrow());

  test("line 0 throws", () => expect(() => buildPermalink({ ...base, line: 0 })).toThrow());
  test("negative line throws", () => expect(() => buildPermalink({ ...base, line: -3 })).toThrow());
  test("non-integer line throws", () => expect(() => buildPermalink({ ...base, line: 1.5 })).toThrow());
  test("reversed span throws (no silent swap)", () => expect(() => buildPermalink({ ...base, line: [9, 3] })).toThrow());
});

describe("buildPermalink — determinism", () => {
  test("same input yields identical output", () => {
    const a = buildPermalink({ ...base, path: "src/@scope/a b.ts", line: [10, 12] });
    const b = buildPermalink({ ...base, path: "src/@scope/a b.ts", line: [10, 12] });
    expect(a).toBe(b);
  });
});
