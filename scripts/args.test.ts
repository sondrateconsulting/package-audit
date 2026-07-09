import { expect, test, describe } from "bun:test";
import { parseArgs, parseReportArgs, parseRescanTarget, ArgsError, ORCHESTRATE_HELP, REPORT_HELP } from "./args.ts";

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
    expect(parseArgs([])).toEqual({ configPath: null, plan: false, fresh: false, purgeCache: false, rescanBranches: [], help: false });
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
  test("--plan parses; rejects a value", () => {
    expect(parseArgs(["--plan"]).plan).toBe(true);
    expect(() => parseArgs(["--plan=1"])).toThrow(ArgsError);
  });
  test("--plan rejects DB/cache mutation flags (plan mode opens no database)", () => {
    expect(() => parseArgs(["--plan", "--fresh"])).toThrow(ArgsError);
    expect(() => parseArgs(["--plan", "--fresh", "--purge-cache"])).toThrow(ArgsError);
    expect(() => parseArgs(["--plan", "--rescan-branch", "o/r@main"])).toThrow(ArgsError);
  });
  test("bare --plan --purge-cache names the PLAN conflict, not the purge/fresh coupling", () => {
    // the plan-conflict check is deliberately ordered before the purge-requires-fresh check —
    // this pins that ordering so a reorder regresses loudly
    expect(() => parseArgs(["--plan", "--purge-cache"])).toThrow(/--plan cannot be combined/);
  });
  test("--plan combines with --config", () => {
    const a = parseArgs(["--plan", "--config", "/c.json"]);
    expect(a.plan).toBe(true);
    expect(a.configPath).toBe("/c.json");
  });
  test("--help/-h wins over everything, even invalid arguments", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--wat", "--help"]).help).toBe(true); // no throw: help wins
    expect(parseArgs(["--purge-cache", "-h"]).help).toBe(true); // conflict check skipped under help
  });
});

describe("parseReportArgs", () => {
  test("defaults with no args", () => {
    expect(parseReportArgs([])).toEqual({ configPath: null, runId: null, help: false });
  });
  test("--run-id with space and = forms", () => {
    expect(parseReportArgs(["--run-id", "r-1"]).runId).toBe("r-1");
    expect(parseReportArgs(["--run-id=r-2"]).runId).toBe("r-2");
  });
  test("--config with space and = forms", () => {
    expect(parseReportArgs(["--config", "/a.json"]).configPath).toBe("/a.json");
    expect(parseReportArgs(["--config=/b.json"]).configPath).toBe("/b.json");
  });
  test("rejects unknown flags — a typo must NEVER silently fall back to the default report", () => {
    expect(() => parseReportArgs(["--runid", "r-1"])).toThrow(ArgsError);
    expect(() => parseReportArgs(["stray"])).toThrow(ArgsError);
  });
  test("rejects a valueless or empty --run-id (would silently overwrite latest.json)", () => {
    expect(() => parseReportArgs(["--run-id"])).toThrow(ArgsError);
    expect(() => parseReportArgs(["--run-id="])).toThrow(ArgsError);
  });
  test("rejects duplicate --run-id and duplicate --config", () => {
    expect(() => parseReportArgs(["--run-id", "a", "--run-id", "b"])).toThrow(ArgsError);
    expect(() => parseReportArgs(["--config", "/a", "--config", "/b"])).toThrow(ArgsError);
  });
  test("--help/-h wins over everything", () => {
    expect(parseReportArgs(["--help"]).help).toBe(true);
    expect(parseReportArgs(["--wat", "-h"]).help).toBe(true);
  });
});

describe("help text", () => {
  test("orchestrate help names every flag", () => {
    for (const flag of ["--config", "--plan", "--fresh", "--purge-cache", "--rescan-branch", "--help"])
      expect(ORCHESTRATE_HELP).toContain(flag);
  });
  test("report help names every flag and the config precedence", () => {
    for (const flag of ["--config", "--run-id", "--help"]) expect(REPORT_HELP).toContain(flag);
    expect(REPORT_HELP).toContain("CONFIG_PATH");
  });
});
