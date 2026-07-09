import { expect, test, describe } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBranchPlan, planSummaryText, runPlan, runSummaryText } from "./orchestrate.ts";
import { GithubClient, type BranchHead } from "./github.ts";
import type { Config } from "./config.ts";

const head = (name: string, committedDate: string): BranchHead => ({ name, oid: `oid-${name}`, committedDate, treeOid: `tree-${name}` });

describe("classifyBranchPlan (§5.B cutoff + cap)", () => {
  test("splits cutoff-skipped, eligible, and past-cap preserving input order", () => {
    const heads = [
      head("main", "2025-06-01T10:00:00Z"),
      head("dev", "2025-05-01T10:00:00Z"),
      head("stale", "2023-12-31T23:59:59Z"), // before cutoff
      head("feature", "2025-04-01T10:00:00Z"), // past cap (cap=2)
    ];
    const p = classifyBranchPlan(heads, "2024-01-01", 2);
    expect(p.cutoffSkipped.map((h) => h.name)).toEqual(["stale"]);
    expect(p.eligible.map((h) => h.name)).toEqual(["main", "dev"]);
    expect(p.pastCap.map((h) => h.name)).toEqual(["feature"]);
  });
  test("EVERY pre-cutoff branch is recorded regardless of the cap", () => {
    const heads = [
      head("a", "2023-01-01T00:00:00Z"),
      head("b", "2023-02-01T00:00:00Z"),
      head("c", "2023-03-01T00:00:00Z"),
    ];
    const p = classifyBranchPlan(heads, "2024-01-01", 1);
    expect(p.cutoffSkipped).toHaveLength(3); // cap never limits cutoff records
    expect(p.eligible).toHaveLength(0);
    expect(p.pastCap).toHaveLength(0);
  });
  test("a commit ON the cutoff date is eligible (skip is strictly before cutoffDate)", () => {
    const p = classifyBranchPlan([head("edge", "2024-01-01T00:00:00Z")], "2024-01-01", 25);
    expect(p.eligible.map((h) => h.name)).toEqual(["edge"]);
    expect(p.cutoffSkipped).toHaveLength(0);
  });
  test("empty input yields empty groups", () => {
    expect(classifyBranchPlan([], "2024-01-01", 25)).toEqual({ cutoffSkipped: [], eligible: [], pastCap: [] });
  });
});

describe("runPlan (integration, scripted client — zero-write contract)", () => {
  const http = (status: number, headers: Record<string, string>, body: string): string =>
    [`HTTP/2.0 ${status} X`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)].join("\r\n") + "\r\n\r\n" + body;

  test("computes totals from discovery alone; writes nothing under tempRoot; spawns only gh", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-int-"));
    const responses = [
      // 1) listOrgRepos("org-a") — single REST page (no Link header)
      { exitCode: 0, stderr: "", stdout: http(200, {}, JSON.stringify([
        { name: "svc", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false },
      ])) },
      // 2) listBranchHeads("org-a","svc") — single GraphQL page: one eligible + one pre-cutoff head
      { exitCode: 0, stderr: "", stdout: http(200, {}, JSON.stringify({ data: { repository: { refs: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          { name: "main", target: { oid: "o-main", committedDate: "2025-06-01T00:00:00Z", tree: { oid: "t1" } } },
          { name: "stale", target: { oid: "o-stale", committedDate: "2023-06-01T00:00:00Z", tree: { oid: "t2" } } },
        ],
      } } } })) },
    ];
    const calls: Array<{ bin: string; args: string[] }> = [];
    const client = new GithubClient({
      githubHost: "github.com",
      db: null, // cache-less: exactly how main() builds the plan client
      spawnImpl: async (bin, args) => {
        calls.push({ bin, args });
        const r = responses[calls.length - 1];
        if (r === undefined) throw new Error(`unexpected spawn #${calls.length}: ${bin} ${args.join(" ")}`);
        return r;
      },
      env: { PATH: "/bin" },
      binPaths: { gh: "/opt/bin/gh", git: "/opt/bin/git", tar: "/opt/bin/tar" },
      tempRoot: root,
    });
    const config: Config = {
      githubHost: "github.com",
      organizations: ["org-a"], // configured mode: no membership-discovery call
      excludeOrganizations: [],
      includePersonalNamespace: false,
      includeForks: false,
      includeArchived: false,
      maxReposPerOrg: null,
      maxBranchesPerRepo: 25,
      cutoffDate: "2024-01-01",
      concurrency: { organizations: 1, repositories: 1, branches: 1 },
      packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
      excludeDirGlobs: [],
      paths: { sqlitePath: join(root, "never-created.db"), outputDir: root },
    };

    const totals = await runPlan(client, config, "rvo");
    expect(totals).toEqual({
      owners: ["org-a"], ownersSource: "configured",
      reposDiscovered: 1, reposKept: 1,
      branchesEligible: 1, branchesSkippedByCutoff: 1, branchesPastCap: 0, discoveryErrors: 0,
    });
    // the zero-write contract: no db file, no gitconfig, no pkg-audit-* dir — nothing at all
    expect(readdirSync(root)).toEqual([]);
    // discovery is gh-only: no git, no tar, no clone, no content fetch
    expect(calls.map((c) => c.bin)).toEqual(["/opt/bin/gh", "/opt/bin/gh"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a branch-discovery failure is counted fail-soft, not fatal", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-int2-"));
    const responses = [
      { exitCode: 0, stderr: "", stdout: http(200, {}, JSON.stringify([
        { name: "svc", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false },
      ])) },
      { exitCode: 1, stderr: "gh: boom", stdout: "" },
      { exitCode: 1, stderr: "gh: boom", stdout: "" },
      { exitCode: 1, stderr: "gh: boom", stdout: "" },
      { exitCode: 1, stderr: "gh: boom", stdout: "" },
      { exitCode: 1, stderr: "gh: boom", stdout: "" },
      { exitCode: 1, stderr: "gh: boom", stdout: "" },
    ];
    let n = 0;
    const client = new GithubClient({
      githubHost: "github.com", db: null,
      spawnImpl: async () => responses[Math.min(n++, responses.length - 1)]!,
      sleepImpl: async () => {},
      env: { PATH: "/bin" }, binPaths: { gh: "/opt/bin/gh", git: "/opt/bin/git", tar: "/opt/bin/tar" }, tempRoot: root,
    });
    const config: Config = {
      githubHost: "github.com", organizations: ["org-a"], excludeOrganizations: [], includePersonalNamespace: false,
      includeForks: false, includeArchived: false, maxReposPerOrg: null, maxBranchesPerRepo: 25, cutoffDate: "2024-01-01",
      concurrency: { organizations: 1, repositories: 1, branches: 1 },
      packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
      excludeDirGlobs: [], paths: { sqlitePath: join(root, "never.db"), outputDir: root },
    };
    const totals = await runPlan(client, config, "rvo");
    expect(totals.discoveryErrors).toBe(1);
    expect(totals.branchesEligible).toBe(0);
    expect(readdirSync(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("runSummaryText", () => {
  test("prints the §7 counters with report-matching labels and the fail-soft note", () => {
    const text = runSummaryText("run-abc", {
      organizationsScanned: 2, repositoriesScanned: 7, branchesScanned: 88,
      branchesSkippedByCutoff: 13, totalDependencyFindings: 104, totalUsageFindings: 994,
    }, 3, "output/run-run-abc.json");
    expect(text).toContain("AUDIT COMPLETE — run run-abc");
    expect(text).toContain("Organizations scanned:  2");
    expect(text).toContain("Repositories scanned:   7");
    expect(text).toContain("Branches scanned:       88 (13 skipped by cutoff)");
    expect(text).toContain("Dependency findings:    104");
    expect(text).toContain("Usage findings:         994");
    expect(text).toContain("Errors recorded:        3 (fail-soft");
    expect(text).toContain("output/run-run-abc.json (+ latest.json)");
  });
});

describe("planSummaryText", () => {
  const config = {
    cutoffDate: "2024-01-01",
    maxBranchesPerRepo: 25,
    packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
  } as unknown as Parameters<typeof planSummaryText>[0];

  test("names the counts, the cutoff, the packages, and the no-writes guarantee", () => {
    const text = planSummaryText(config, {
      owners: ["org-a", "org-b"], ownersSource: "discovered",
      reposDiscovered: 42, reposKept: 37,
      branchesEligible: 210, branchesSkippedByCutoff: 58, branchesPastCap: 12, discoveryErrors: 0,
    });
    expect(text).toContain("PLAN — preview only");
    expect(text).toContain("no database opened");
    expect(text).toContain("org-a, org-b");
    expect(text).toContain("42 discovered, 37 kept");
    expect(text).toContain("210 eligible");
    expect(text).toContain("58 skipped by cutoff (< 2024-01-01)");
    expect(text).toContain("12 past the per-repo cap (25)");
    expect(text).toContain("expo");
    expect(text).toContain("Discovery errors:     0");
  });
});
