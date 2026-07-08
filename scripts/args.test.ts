import { expect, test, describe } from "bun:test";
import { parseArgs, parseRescanTarget, ArgsError } from "./args.ts";

describe("parseRescanTarget", () => {
  test("splits org/repo@branch", () => {
    expect(parseRescanTarget("org-a/repo@main")).toEqual({ organization: "org-a", repository: "repo", branch: "main" });
  });
  test("preserves an '@' in the branch name (first-@ split)", () => {
    expect(parseRescanTarget("org/repo@feature/@scope")).toEqual({ organization: "org", repository: "repo", branch: "feature/@scope" });
  });
  test("preserves a '/' in the branch name", () => {
    expect(parseRescanTarget("org/repo@release/1.2")).toEqual({ organization: "org", repository: "repo", branch: "release/1.2" });
  });
  test("rejects a bare branch (no org/repo@)", () => {
    expect(() => parseRescanTarget("main")).toThrow(ArgsError);
  });
  test("rejects missing branch, missing repo, extra slash", () => {
    expect(() => parseRescanTarget("org/repo@")).toThrow(ArgsError);
    expect(() => parseRescanTarget("@main")).toThrow(ArgsError);
    expect(() => parseRescanTarget("org@main")).toThrow(ArgsError); // no '/' in repo spec
    expect(() => parseRescanTarget("a/b/c@main")).toThrow(ArgsError); // two slashes
    expect(() => parseRescanTarget("/repo@main")).toThrow(ArgsError);
  });
});

describe("parseArgs", () => {
  test("defaults with no args", () => {
    expect(parseArgs([])).toEqual({ configPath: null, fresh: false, purgeCache: false, rescanBranches: [] });
  });
  test("--config with space and = forms", () => {
    expect(parseArgs(["--config", "/a.json"]).configPath).toBe("/a.json");
    expect(parseArgs(["--config=/b.json"]).configPath).toBe("/b.json");
  });
  test("--fresh and --purge-cache together", () => {
    const a = parseArgs(["--fresh", "--purge-cache"]);
    expect(a.fresh).toBe(true);
    expect(a.purgeCache).toBe(true);
  });
  test("--purge-cache without --fresh is rejected", () => {
    expect(() => parseArgs(["--purge-cache"])).toThrow(ArgsError);
  });
  test("repeatable --rescan-branch accumulates, de-duplicated, order-stable", () => {
    const a = parseArgs([
      "--rescan-branch", "o/r@main",
      "--rescan-branch", "o/r@dev",
      "--rescan-branch", "o/r@main", // dup
    ]);
    expect(a.rescanBranches).toEqual([
      { organization: "o", repository: "r", branch: "main" },
      { organization: "o", repository: "r", branch: "dev" },
    ]);
  });
  test("rejects unknown flags and bool flags carrying a value", () => {
    expect(() => parseArgs(["--wat"])).toThrow(ArgsError);
    expect(() => parseArgs(["stray"])).toThrow(ArgsError);
    expect(() => parseArgs(["--fresh=1"])).toThrow(ArgsError);
  });
  test("rejects a value flag with no value and duplicate --config", () => {
    expect(() => parseArgs(["--config"])).toThrow(ArgsError);
    expect(() => parseArgs(["--config=", ""])).toThrow(ArgsError);
    expect(() => parseArgs(["--config", "/a", "--config", "/b"])).toThrow(ArgsError);
  });
});
