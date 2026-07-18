import { expect, test, describe, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { cloneReader, walkClone, discoverCliTerms, discoverOwnerRepos, planSummaryText, processOwner, processRepo, reconcileIntrospection, resolveOwnersWithDiscovery, runPlan, runScan, runSummaryText, type AuditRuntime, type PlanTotals } from "./orchestrate.ts";
import type { TreeEntry } from "./unitPipeline.ts";
import { classifyBranchPlan } from "./branchPlanner.ts";
import { compileBranchPolicy, PolicyMatchError } from "./branchPolicy.ts";
import { compileRepositoryPolicy } from "./repositoryPolicy.ts";
import { GithubApiError, GithubClient, ThrottleExhausted, type BranchHead, type BranchSnapshot, type RepoInfo, type SpawnFn } from "./github.ts";
import { AuditDb, nowIso, type WorkUnitKey } from "./db.ts";
import { Aborter } from "./boundedPool.ts";
import type { Config } from "./config.ts";
import type { OrchestrateArgs } from "./args.ts";

const head = (name: string, committedDate: string): BranchHead => ({ name, oid: `oid-${name}`, committedDate, treeOid: `tree-${name}` });

// listBranchHeads requires HEX object ids and fetchTreeRecursive requires a sha-echoing tree
// envelope (§5.B/§5.C fail-closed): derive a stable 40-hex oid from a readable seed, and answer
// a git-trees request with the oid it actually asked for.
const hexOid = (seed: string): string => Buffer.from(seed).toString("hex").padEnd(40, "0").slice(0, 40);
const treeBody = (args: string[], truncated = false): string => {
  const ep = args.find((a) => a.includes("/git/trees/")) ?? "";
  const sha = decodeURIComponent(ep.split("/git/trees/")[1]?.split("?")[0] ?? "");
  return `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ sha, truncated, tree: [] })}`;
};

// Build the AuditRuntime bundle from a Config — the branch policy is compiled from the config's own
// branch lists, so the default (`branches: null, excludeBranches: []`) is unrestricted and behaves
// exactly as before this feature. Tests exercising policy pass a config with populated lists.
const rt = (config: Config, configHash = "hash"): AuditRuntime => ({
  config,
  configHash,
  branchPolicy: compileBranchPolicy(config.branches, config.excludeBranches),
  repositoryPolicy: compileRepositoryPolicy(config.excludeRepositories),
});

// An empty repository denylist for the discoverOwnerRepos call sites that don't exercise repo policy.
const NO_DENY = compileRepositoryPolicy([]);

// Scripted client factory — every test client shares this boilerplate (offline binPaths, noop
// sleep, tempRoot under the test dir) and differs ONLY in its spawn script and cache role.
function makeClient(root: string, spawnImpl: SpawnFn, opts: { db?: AuditDb | null } = {}): GithubClient {
  return new GithubClient({
    githubHost: "github.com", db: opts.db ?? null, spawnImpl,
    sleepImpl: async () => {},
    env: { PATH: "/bin" }, binPaths: { gh: "/opt/bin/gh", git: "/opt/bin/git", tar: "/opt/bin/tar" }, tempRoot: root,
  });
}

describe("classifyBranchPlan (§5.B cutoff + cap)", () => {
  test("splits cutoff-skipped, eligible, and past-cap preserving input order", () => {
    const heads = [
      head("main", "2025-06-01T10:00:00Z"),
      head("dev", "2025-05-01T10:00:00Z"),
      head("stale", "2023-12-31T23:59:59Z"), // before cutoff
      head("feature", "2025-04-01T10:00:00Z"), // past cap (cap=2)
    ];
    const p = classifyBranchPlan(heads, "2024-01-01", 2, "");
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
    const p = classifyBranchPlan(heads, "2024-01-01", 1, "");
    expect(p.cutoffSkipped).toHaveLength(3); // cap never limits cutoff records
    expect(p.eligible).toHaveLength(0);
    expect(p.pastCap).toHaveLength(0);
  });
  test("a commit ON the cutoff date is eligible (skip is strictly before cutoffDate)", () => {
    const p = classifyBranchPlan([head("edge", "2024-01-01T00:00:00Z")], "2024-01-01", 25, "");
    expect(p.eligible.map((h) => h.name)).toEqual(["edge"]);
    expect(p.cutoffSkipped).toHaveLength(0);
  });
  test("empty input yields empty groups", () => {
    expect(classifyBranchPlan([], "2024-01-01", 25, "main")).toEqual({ cutoffSkipped: [], eligible: [], pastCap: [] });
  });
});

describe("classifyBranchPlan — the DEFAULT branch is always eligible (§5.B)", () => {
  test("a default branch OLDER than the cutoff is eligible, never cutoff-skipped", () => {
    const heads = [
      head("feature", "2025-06-01T00:00:00Z"),
      head("main", "2022-01-01T00:00:00Z"), // ancient default — dormant repo, active fork branches
    ];
    const p = classifyBranchPlan(heads, "2024-01-01", 25, "main");
    expect(p.eligible.map((h) => h.name)).toEqual(["feature", "main"]);
    expect(p.cutoffSkipped).toHaveLength(0);
  });
  test("a default branch beyond the cap position is eligible; the cap still bounds the rest", () => {
    const heads = [
      head("hotfix", "2025-06-01T00:00:00Z"),
      head("dev", "2025-05-01T00:00:00Z"),
      head("main", "2025-01-01T00:00:00Z"), // would be past-cap by recency alone (cap=2)
      head("old-feature", "2024-06-01T00:00:00Z"),
    ];
    const p = classifyBranchPlan(heads, "2024-01-01", 2, "main");
    expect(p.eligible.map((h) => h.name)).toEqual(["hotfix", "dev", "main"]); // input order kept
    expect(p.pastCap.map((h) => h.name)).toEqual(["old-feature"]);
  });
  test("the cap counts NON-default branches only; the default appears exactly once", () => {
    const heads = [
      head("main", "2025-06-01T00:00:00Z"), // default AND newest
      head("a", "2025-05-01T00:00:00Z"),
      head("b", "2025-04-01T00:00:00Z"),
      head("c", "2025-03-01T00:00:00Z"),
    ];
    const p = classifyBranchPlan(heads, "2024-01-01", 2, "main");
    expect(p.eligible.map((h) => h.name)).toEqual(["main", "a", "b"]); // default + 2 non-default
    expect(p.pastCap.map((h) => h.name)).toEqual(["c"]);
  });
  test("a defaultBranch not among the live heads changes nothing (no synthesis)", () => {
    const heads = [head("dev", "2025-05-01T00:00:00Z"), head("stale", "2023-06-01T00:00:00Z")];
    const p = classifyBranchPlan(heads, "2024-01-01", 25, "main");
    expect(p.eligible.map((h) => h.name)).toEqual(["dev"]);
    expect(p.cutoffSkipped.map((h) => h.name)).toEqual(["stale"]);
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
      { exitCode: 0, stderr: "", stdout: http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, refs: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          { name: "main", target: { oid: hexOid("o-main"), committedDate: "2025-06-01T00:00:00Z", tree: { oid: hexOid("t1") } } },
          { name: "stale", target: { oid: hexOid("o-stale"), committedDate: "2023-06-01T00:00:00Z", tree: { oid: hexOid("t2") } } },
        ],
      } } } })) },
    ];
    const calls: Array<{ bin: string; args: string[] }> = [];
    // cache-less (db: null): exactly how main() builds the plan client
    const client = makeClient(root, async (bin, args) => {
      calls.push({ bin, args });
      const r = responses[calls.length - 1];
      if (r === undefined) throw new Error(`unexpected spawn #${calls.length}: ${bin} ${args.join(" ")}`);
      return r;
    });
    const config: Config = {
      githubHost: "github.com",
      organizations: ["org-a"], // configured mode: no membership-discovery call
      excludeOrganizations: [],
      branches: null,
      excludeBranches: [],
      excludeRepositories: [],
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

    const totals = await runPlan(client, rt(config), "rvo");
    expect(totals).toEqual({
      owners: ["org-a"], ownersSource: "configured",
      reposDiscovered: 1, reposKept: 1,
      branchesEligible: 1, branchesSkippedByCutoff: 1, branchesPastCap: 0, branchesExcludedByPolicy: 0,
      excludedByDeny: 0, excludedByAllow: 0, defaultBranchPolicyOverrides: 0, discoveryErrors: 0,
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
    const client = makeClient(root, async () => responses[Math.min(n++, responses.length - 1)]!);
    const config: Config = {
      githubHost: "github.com", organizations: ["org-a"], excludeOrganizations: [], branches: null, excludeBranches: [], excludeRepositories: [], includePersonalNamespace: false,
      includeForks: false, includeArchived: false, maxReposPerOrg: null, maxBranchesPerRepo: 25, cutoffDate: "2024-01-01",
      concurrency: { organizations: 1, repositories: 1, branches: 1 },
      packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
      excludeDirGlobs: [], paths: { sqlitePath: join(root, "never.db"), outputDir: root },
    };
    const totals = await runPlan(client, rt(config), "rvo");
    expect(totals.discoveryErrors).toBe(1);
    expect(totals.branchesEligible).toBe(0);
    expect(readdirSync(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

// Shared minimal Config for the guard/wiring tests below (single configured org, cap via arg).
const testConfig = (root: string, maxBranchesPerRepo = 25): Config => ({
  githubHost: "github.com", organizations: ["org-a"], excludeOrganizations: [], branches: null, excludeBranches: [], excludeRepositories: [], includePersonalNamespace: false,
  includeForks: false, includeArchived: false, maxReposPerOrg: null, maxBranchesPerRepo, cutoffDate: "2024-01-01",
  concurrency: { organizations: 1, repositories: 1, branches: 1 },
  packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
  excludeDirGlobs: [], paths: { sqlitePath: join(root, "never.db"), outputDir: root },
});

// Capture stdout JSONL lines emitted during `fn`, returned parsed.
async function captureJsonl(fn: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const chunks: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("runPlan cache-less client guard (--plan zero-write)", () => {
  test("rejects a caching (db-backed) client before any discovery call", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-guard-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    let spawns = 0;
    // WRONG client for plan mode: it is db-backed, so the structural zero-DB guard must reject it up
    // front (independent of whether current discovery calls happen to write — they no longer do)
    const client = makeClient(root, async () => { spawns++; return { exitCode: 1, stderr: "never reached", stdout: "" }; }, { db });
    await expect(runPlan(client, rt(testConfig(root)), "rvo")).rejects.toThrow(/cache-less/);
    expect(spawns).toBe(0); // the guard fires before owner resolution / any gh call
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("processRepo discovery-failure observability (fail-soft, README log vocabulary)", () => {
  test("a branch-discovery failure emits a JSONL discovery event AND the DB error row", async () => {
    const root = mkdtempSync(join(tmpdir(), "disc-ev-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { runId } = db.startRun({
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "configured",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    });
    const client = makeClient(root, async () => ({ exitCode: 1, stderr: "gh: boom", stdout: "" }));
    const repo: RepoInfo = { name: "svc", organization: "org-a", pushedAt: "2025-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false };

    const events = await captureJsonl(async () => {
      await processRepo(db, client, rt(testConfig(root), "h"), runId, "org-a", repo, [], new Set());
    });

    const disc = events.find((e) => e["event"] === "discovery");
    expect(disc).toBeDefined();
    expect(disc?.["org"]).toBe("org-a");
    expect(disc?.["repo"]).toBe("svc");
    expect(String(disc?.["error"])).toContain("branch discovery failed");
    // fail-soft: the DB error row is still recorded alongside the live event
    const row = db.read(`SELECT scope, organization, repository, message FROM errors WHERE run_id = ?`).get(runId) as { scope: string; organization: string; repository: string; message: string };
    expect(row.scope).toBe("discovery");
    expect(row.message).toContain("branch discovery failed");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("discoverOwnerRepos (run-path org-level discovery, fail-soft — README log vocabulary)", () => {
  const http = (status: number, body: string): string => `HTTP/2.0 ${status} X\r\n\r\n${body}`;
  const startRun = (db: AuditDb): string =>
    db.startRun({
      configHash: "h", effectiveOwners: ["org-a", "org-b"], ownersSource: "configured",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    }).runId;

  test("a failing owner records the DB error row AND the org-scoped JSONL discovery event, then yields a failed outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "own-disc-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startRun(db);
    const client = makeClient(root, async () => ({ exitCode: 1, stderr: "gh: boom", stdout: "" }));

    let kept: unknown;
    const events = await captureJsonl(async () => {
      kept = await discoverOwnerRepos(db, client, testConfig(root), NO_DENY, runId, "org-a", false);
    });

    expect(kept).toEqual({ ok: false, reason: "failed" }); // fail-soft: a permanent-failure outcome, no partial items
    const disc = events.find((e) => e["event"] === "discovery");
    expect(disc).toBeDefined();
    expect(disc?.["org"]).toBe("org-a");
    expect(disc?.["repo"]).toBeUndefined(); // org-scoped event carries no repo field (README)
    expect(String(disc?.["error"])).toContain("repo discovery failed");
    const row = db.read(`SELECT scope, organization, repository, message FROM errors WHERE run_id = ?`).get(runId) as { scope: string; organization: string; repository: string | null; message: string };
    expect(row.scope).toBe("discovery");
    expect(row.organization).toBe("org-a");
    expect(row.repository).toBeNull();
    expect(row.message).toContain("repo discovery failed");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a failing owner does not poison the next: the follow-up owner still discovers, filtered and capped", async () => {
    const root = mkdtempSync(join(tmpdir(), "own-disc2-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startRun(db);
    // route by args, not call order, so retry counts can't skew the script
    const client = makeClient(root, async (_bin, args) => {
        const joined = args.join(" ");
        if (joined.includes("org-a")) return { exitCode: 1, stderr: "gh: boom", stdout: "" };
        return { exitCode: 0, stderr: "", stdout: http(200, JSON.stringify([
          { name: "svc", owner: { login: "org-b" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false },
          { name: "old", owner: { login: "org-b" }, default_branch: "main", pushed_at: "2024-01-01T00:00:00Z", archived: true, fork: false, private: false },
        ])) };
      });

    const events = await captureJsonl(async () => {
      const keptA = await discoverOwnerRepos(db, client, testConfig(root), NO_DENY, runId, "org-a", false);
      const keptB = await discoverOwnerRepos(db, client, testConfig(root), NO_DENY, runId, "org-b", false);
      expect(keptA).toEqual({ ok: false, reason: "failed" }); // permanent discovery failure
      expect(keptB.ok && keptB.items.map((r) => r.name)).toEqual(["svc"]); // archived repo filtered by config
    });
    expect(events.filter((e) => e["event"] === "discovery")).toHaveLength(1); // only org-a's failure
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("threads the repository denylist: a matching repo is dropped from the returned kept set", async () => {
    const root = mkdtempSync(join(tmpdir(), "own-disc-deny-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startRun(db);
    const client = makeClient(root, async () => ({ exitCode: 0, stderr: "", stdout: http(200, JSON.stringify([
      { name: "keep", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false },
      { name: "legacy-api", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-02-01T00:00:00Z", archived: false, fork: false, private: false },
    ])) }));
    // deny "org-a/legacy-*" (case-insensitive) — the newer repo, which would otherwise sort first.
    const policy = compileRepositoryPolicy(["ORG-A/legacy-*"]);
    const kept = await discoverOwnerRepos(db, client, testConfig(root), policy, runId, "org-a", false);
    expect(kept.ok && kept.items.map((r) => r.name)).toEqual(["keep"]); // legacy-api excluded by the denylist
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("isPersonal routes to the affiliation-scoped user listing, not the org endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "own-disc3-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startRun(db);
    const calls: string[][] = [];
    const client = makeClient(root, async (_bin, args) => {
        calls.push(args);
        // a real repo OWNED BY the expected personal login — exercises listUserRepos' cross-owner
        // validation through the orchestrate wiring (a wrong/absent owner threaded from here would throw)
        return { exitCode: 0, stderr: "", stdout: http(200, JSON.stringify([
          { name: "dotfiles", owner: { login: "rvo" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false },
        ])) };
      });

    const kept = await discoverOwnerRepos(db, client, testConfig(root), NO_DENY, runId, "rvo", true);
    expect(kept.ok && kept.items.map((r) => r.name)).toEqual(["dotfiles"]); // discovered via user/repos, owner "rvo" validated
    expect(calls).toHaveLength(1);
    expect(calls[0]!.join(" ")).toContain("user/repos?affiliation=owner");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("introspection-failure observability (fail-soft, README log vocabulary)", () => {
  const startRun = (db: AuditDb): string =>
    db.startRun({
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "configured",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    }).runId;
  const failingFetch = (async () => {
    throw new Error("registry down");
  }) as unknown as typeof fetch;

  test("a bin-discovery failure emits a JSONL introspection event AND the DB error row, degrading to specifier-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "cli-terms-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startRun(db);
    const client = makeClient(root, async () => { throw new Error("no spawn expected"); });
    const prevFetch = globalThis.fetch;
    globalThis.fetch = failingFetch; // fetchPackument rides global fetch
    try {
      const events = await captureJsonl(async () => {
        const sets = await discoverCliTerms(db, client, testConfig(root), runId);
        expect(sets).toEqual([{ packageName: "expo", name: "expo", binNames: [] }]); // fail-soft: specifier-only
      });
      const ev = events.find((e) => e["event"] === "introspection");
      expect(ev).toBeDefined();
      expect(ev?.["packageName"]).toBe("expo");
      expect(String(ev?.["error"])).toContain("bin discovery failed");
      const row = db.read(`SELECT scope, package_name, message FROM errors WHERE run_id = ?`).get(runId) as { scope: string; package_name: string; message: string };
      expect(row.scope).toBe("introspection");
      expect(row.package_name).toBe("expo");
      expect(row.message).toContain("bin discovery failed");
    } finally {
      globalThis.fetch = prevFetch;
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a packument-fetch failure during reconciliation emits the event AND the row; reconciliation completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startRun(db);
    const now = nowIso();
    const unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "abc123def" };
    db.upsertRunUnitHead({ runId, ...unit, status: "scanned", isDefaultBranch: null, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    // no lockfile + unresolved registry range → the §5.E range-resolution path needs the packument
    db.upsertDependencyFinding({
      runId, ...unit, dateFetched: now, packageName: "expo", dependencyKey: "expo", dependencyType: "dependencies",
      manifestPath: "package.json", manifestLine: 5, manifestPermalink: "https://github.com/org-a/svc/blob/abc123def/package.json#L5",
      declaredVersion: "^50.0.0", lockfilePath: null, lockfileKind: null, lockfileLines: null, lockfilePermalink: null,
      resolvedVersion: null, resolvedVersionSource: null,
    });
    const client = makeClient(root, async () => { throw new Error("no spawn expected"); });
    const prevFetch = globalThis.fetch;
    globalThis.fetch = failingFetch;
    try {
      const events = await captureJsonl(async () => {
        await reconcileIntrospection(db, client, testConfig(root), runId); // must not throw
      });
      const ev = events.find((e) => e["event"] === "introspection");
      expect(ev).toBeDefined();
      expect(ev?.["packageName"]).toBe("expo");
      expect(String(ev?.["error"])).toContain("packument fetch failed");
      const row = db.read(`SELECT scope, package_name, message FROM errors WHERE run_id = ?`).get(runId) as { scope: string; package_name: string; message: string };
      expect(row.scope).toBe("introspection");
      expect(row.message).toContain("packument fetch failed");
    } finally {
      globalThis.fetch = prevFetch;
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a scanned dependency row for a package absent from config.packages is ignored (no crash, no fetch)", async () => {
    // reconciliation's slice must derive from config.packages (the single source of truth for
    // registry coordinates) — a stale row from a prior run's different config must be skipped,
    // not dereferenced into a reportless TypeError at the final pipeline stage.
    const root = mkdtempSync(join(tmpdir(), "reconcile-rogue-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startRun(db);
    const now = nowIso();
    const unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "abc123def" };
    db.upsertRunUnitHead({ runId, ...unit, status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    // a RESOLVED version for a package no current config entry can supply a registry for
    db.upsertDependencyFinding({
      runId, ...unit, dateFetched: now, packageName: "rogue", dependencyKey: "rogue", dependencyType: "dependencies",
      manifestPath: "package.json", manifestLine: 5, manifestPermalink: "https://github.com/org-a/svc/blob/abc123def/package.json#L5",
      declaredVersion: "^1.0.0", lockfilePath: "bun.lock", lockfileKind: "bun", lockfileLines: null, lockfilePermalink: null,
      resolvedVersion: "1.2.3", resolvedVersionSource: "lockfile",
    });
    const client = makeClient(root, async () => { throw new Error("no spawn expected"); });
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("no fetch expected"); }) as unknown as typeof fetch;
    try {
      await reconcileIntrospection(db, client, testConfig(root), runId); // must not throw
      const rows = db.read(`SELECT message FROM errors WHERE run_id = ?`).all(runId) as Array<{ message: string }>;
      expect(rows).toEqual([]); // ignored entirely: no error rows, no introspection attempts
    } finally {
      globalThis.fetch = prevFetch;
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runPlan org-level discovery failure (fail-soft continue)", () => {
  const http = (status: number, body: string): string => `HTTP/2.0 ${status} X\r\n\r\n${body}`;

  test("a failing org's repo discovery is counted and the NEXT owner still runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-orgfail-"));
    // route by args, not call order, so retry counts can't skew the script:
    // org-a REST repo listing always fails; org-b succeeds; GraphQL (branch heads) succeeds.
    const client = makeClient(root, async (_bin, args) => {
        const joined = args.join(" ");
        if (joined.includes("graphql")) {
          return { exitCode: 0, stderr: "", stdout: http(200, JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, refs: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ name: "main", target: { oid: hexOid("o1"), committedDate: "2025-06-01T00:00:00Z", tree: { oid: hexOid("t1") } } }],
          } } } })) };
        }
        if (joined.includes("org-a")) return { exitCode: 1, stderr: "gh: boom", stdout: "" };
        return { exitCode: 0, stderr: "", stdout: http(200, JSON.stringify([
          { name: "svc", owner: { login: "org-b" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false },
        ])) };
      });
    const config = { ...testConfig(root), organizations: ["org-a", "org-b"] };

    let totals: Awaited<ReturnType<typeof runPlan>> | undefined;
    const events = await captureJsonl(async () => {
      totals = await runPlan(client, rt(config), "rvo");
    });

    expect(totals?.discoveryErrors).toBe(1);
    expect(totals?.reposDiscovered).toBe(1); // org-b's repo still counted after org-a failed
    expect(totals?.branchesEligible).toBe(1);
    const planError = events.find((e) => e["event"] === "plan" && e["error"] !== undefined);
    expect(planError?.["org"]).toBe("org-a");
    expect(String(planError?.["error"])).toContain("repo discovery failed");
    expect(readdirSync(root)).toEqual([]); // zero-write contract holds through the failure
    rmSync(root, { recursive: true, force: true });
  });
});

describe("processRepo wiring (§5.B/§3: cutoff-skip, skip-current reuse, past-cap untouched)", () => {
  // defaultBranch is REQUIRED and explicit: inferring it (a hardcoded "main", or "the first head")
  // would make a fixture agree with whatever the code resolved and hide a default-resolution defect.
  const graphqlHeads = (nodes: Array<{ name: string; oid: string; date: string }>, defaultBranch: string | null): string =>
    `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ data: { repository: {
      defaultBranchRef: defaultBranch === null ? null : { name: defaultBranch },
      refs: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: nodes.map((n) => ({ name: n.name, target: { oid: n.oid, committedDate: n.date, tree: { oid: hexOid(`t-${n.name}`) } } })),
      },
    } } })}`;

  test("classified groups land in the right DB states without scanning", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiring-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { runId } = db.startRun({
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "configured",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    });
    const key = (branch: string): WorkUnitKey => ({ configHash: "h", scope: "branch", organization: "org-a", repository: "svc", branch });
    // pre-seed "main" AND "dev" as done AT their live heads so the §3 skip-current path is
    // taken for both (no scanUnit; the scripted client only answers branch discovery)
    db.enqueueUnit(key("main"), runId);
    db.setUnitStatus(key("main"), { status: "done", runId, lastCommitSha: hexOid("o-main"), lastCommitDate: "2025-06-01T00:00:00Z" });
    db.enqueueUnit(key("dev"), runId);
    db.setUnitStatus(key("dev"), { status: "done", runId, lastCommitSha: hexOid("o-dev"), lastCommitDate: "2025-05-01T00:00:00Z" });

    const client = // heads newest-first; cap=1 counts NON-default branches: main default-exempt
    // (current), dev fills the cap (current), feat past-cap, stale pre-cutoff
    makeClient(root, async () => ({ exitCode: 0, stderr: "", stdout: graphqlHeads([
        { name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" },
        { name: "dev", oid: hexOid("o-dev"), date: "2025-05-01T00:00:00Z" },
        { name: "feat", oid: hexOid("o-feat"), date: "2025-04-01T00:00:00Z" },
        { name: "stale", oid: hexOid("o-stale"), date: "2023-06-01T00:00:00Z" },
      ], "main") }));
    const repo: RepoInfo = { name: "svc", organization: "org-a", pushedAt: "2025-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false };

    const events = await captureJsonl(async () => {
      await processRepo(db, client, rt(testConfig(root, 1), "h"), runId, "org-a", repo, [], new Set());
    });

    // run_unit_head: stale → skipped-cutoff (empty sha), main+dev → scanned at their live heads with
    // the REAL default-branch flag (1 for main, 0 otherwise), and feat → a NEW past-cap row (a
    // past-cap branch is now recorded for report visibility, though its work queue stays untouched).
    const headRows = db.read(`SELECT branch, commit_sha, status, is_default_branch FROM run_unit_head WHERE run_id = ? ORDER BY branch`).all(runId) as Array<Record<string, unknown>>;
    expect(headRows).toEqual([
      { branch: "dev", commit_sha: hexOid("o-dev"), status: "scanned", is_default_branch: 0 },
      { branch: "feat", commit_sha: "", status: "past-cap", is_default_branch: 0 },
      { branch: "main", commit_sha: hexOid("o-main"), status: "scanned", is_default_branch: 1 },
      { branch: "stale", commit_sha: "", status: "skipped-cutoff", is_default_branch: 0 },
    ]);
    // work-queue state: stale skipped, main+dev still done (reused), feat never enqueued (past-cap
    // retains prior queue state so a later cap-order promotion can reuse a done scan).
    expect(db.getUnit(key("stale"))?.status).toBe("skipped");
    expect(db.getUnit(key("main"))?.status).toBe("done");
    expect(db.getUnit(key("dev"))?.status).toBe("done");
    expect(db.getUnit(key("feat"))).toBeNull();
    // live JSONL: one skip-cutoff, two skip-current, one past-cap, nothing else unit-scoped
    const actions = events.filter((e) => e["event"] === "unit").map((e) => `${e["branch"]}:${e["action"]}`).sort();
    expect(actions).toEqual(["dev:skip-current", "feat:past-cap", "main:skip-current", "stale:skip-cutoff"]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the SCANNED path writes the real is_default_branch too (processUnit, empty tree)", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiring-scan-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { runId } = db.startRun({
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "configured",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    });
    // No pre-seeded work-queue rows → both branches go through processUnit's REAL scan.
    // The scripted client serves branch discovery (GraphQL) and an EMPTY tree (REST), so the
    // scan pipeline runs end-to-end with zero findings and the unit lands 'done'/'scanned'.
    const client = makeClient(root, async (_bin, args) => {
      const isGraphql = args.some((a) => a === "graphql");
      if (isGraphql)
        return { exitCode: 0, stderr: "", stdout: graphqlHeads([
          { name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" },
          { name: "dev", oid: hexOid("o-dev"), date: "2025-05-01T00:00:00Z" },
        ], "main") };
      return { exitCode: 0, stderr: "", stdout: treeBody(args) };
    });
    const repo: RepoInfo = { name: "svc", organization: "org-a", pushedAt: "2025-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false };

    await captureJsonl(async () => {
      await processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set());
    });

    const headRows = db.read(`SELECT branch, commit_sha, status, is_default_branch FROM run_unit_head WHERE run_id = ? ORDER BY branch`).all(runId) as Array<Record<string, unknown>>;
    expect(headRows).toEqual([
      { branch: "dev", commit_sha: hexOid("o-dev"), status: "scanned", is_default_branch: 0 },
      { branch: "main", commit_sha: hexOid("o-main"), status: "scanned", is_default_branch: 1 },
    ]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("P0 exclusivity backstop: a repo scheduled twice in one run fails LOUD (shared scheduledRepoKeys, case-insensitive)", async () => {
    const root = mkdtempSync(join(tmpdir(), "excl-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { runId } = db.startRun({
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "configured",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    });
    // pre-seed main done@head so the first pass is skip-current (no tree fetch), keeping the test
    // focused on the exclusivity claim rather than the scan pipeline.
    const key: WorkUnitKey = { configHash: "h", scope: "branch", organization: "org-a", repository: "svc", branch: "main" };
    db.enqueueUnit(key, runId);
    db.setUnitStatus(key, { status: "done", runId, lastCommitSha: hexOid("o-main"), lastCommitDate: "2025-06-01T00:00:00Z" });
    const client = makeClient(root, async () => ({ exitCode: 0, stderr: "", stdout: graphqlHeads([
      { name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" },
    ], "main") }));
    const repo: RepoInfo = { name: "svc", organization: "org-a", pushedAt: "2025-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false };
    const shared = new Set<string>();

    // first scheduling of org-a/svc succeeds and claims the canonical key
    await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set(), shared));
    // a SECOND scheduling of the same canonical (org, repo) with the SHARED set throws BEFORE any write
    await expect(
      processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set(), shared),
    ).rejects.toThrow(/scheduled twice/);
    // a case-variant owner spelling is caught too (the key is lowercased) — proves the fold cannot be evaded
    await expect(
      processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "ORG-A", { ...repo, organization: "ORG-A" }, [], new Set(), shared),
    ).rejects.toThrow(/scheduled twice/);
    // a DISTINCT repo in the SAME shared set is unaffected (no false positive — different canonical key)
    await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", { ...repo, name: "other" }, [], new Set(), shared));
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("processRepo / runScan — branch allow/deny wiring", () => {
  // defaultBranch is REQUIRED and explicit: inferring it (a hardcoded "main", or "the first head")
  // would make a fixture agree with whatever the code resolved and hide a default-resolution defect.
  const graphqlHeads = (nodes: Array<{ name: string; oid: string; date: string }>, defaultBranch: string | null): string =>
    `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ data: { repository: {
      defaultBranchRef: defaultBranch === null ? null : { name: defaultBranch },
      refs: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: nodes.map((n) => ({ name: n.name, target: { oid: n.oid, committedDate: n.date, tree: { oid: hexOid(`t-${n.name}`) } } })),
      },
    } } })}`;
  // heads via GraphQL, an EMPTY tree via REST so a scanned unit runs the pipeline to zero findings.
  const scanClient = (root: string, nodes: Array<{ name: string; oid: string; date: string }>, defaultBranch: string | null): GithubClient =>
    makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads(nodes, defaultBranch) };
      return { exitCode: 0, stderr: "", stdout: treeBody(args) };
    });
  const repo: RepoInfo = { name: "svc", organization: "org-a", pushedAt: "2025-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false };
  const startScanRun = (db: AuditDb): string =>
    db.startRun({ configHash: "h", effectiveOwners: ["org-a"], ownersSource: "configured", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" }).runId;
  const headRowsOf = (db: AuditDb, runId: string) =>
    db.read(`SELECT branch, status, commit_sha AS sha, is_default_branch AS d, policy_status AS ps, policy_matched_pattern AS pat, scanned_commit_date AS scd FROM run_unit_head WHERE run_id = ? ORDER BY branch`).all(runId);
  const key = (branch: string): WorkUnitKey => ({ configHash: "h", scope: "branch", organization: "org-a", repository: "svc", branch });
  const throwingGlob = (thrown: unknown): Bun.Glob => ({ match() { throw thrown; } }) as unknown as Bun.Glob;
  const badGlobError = new Error("bad glob"); // the exact injected cause — used to prove identity on rethrow
  const throwingPolicy = { include: null, exclude: [{ pattern: "boom*", glob: throwingGlob(badGlobError) }] };

  test("a denied NON-default branch persists as policy-excluded + policy attribution, and is never scanned", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-deny-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    const config = { ...testConfig(root, 25), excludeBranches: ["dev"] };
    const client = scanClient(root, [
      { name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" },
      { name: "dev", oid: hexOid("o-dev"), date: "2025-05-01T00:00:00Z" },
    ], "main");
    await captureJsonl(() => processRepo(db, client, rt(config, "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId)).toEqual([
      { branch: "dev", status: "policy-excluded", sha: "", d: 0, ps: "excluded-by-deny", pat: "dev", scd: "2025-05-01T00:00:00Z" },
      { branch: "main", status: "scanned", sha: hexOid("o-main"), d: 1, ps: null, pat: null, scd: "2025-06-01T00:00:00Z" },
    ]);
    expect(db.getUnit(key("dev"))?.status).toBe("skipped"); // enqueued but never scanned
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a denied DEFAULT branch is STILL scanned but records the policy counterfactual (the override)", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-default-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    const config = { ...testConfig(root, 25), excludeBranches: ["main"] }; // deny the DEFAULT branch
    const client = scanClient(root, [{ name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }], "main");
    await captureJsonl(() => processRepo(db, client, rt(config, "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId)).toEqual([
      { branch: "main", status: "scanned", sha: hexOid("o-main"), d: 1, ps: "excluded-by-deny", pat: "main", scd: "2025-06-01T00:00:00Z" },
    ]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("processRepo propagates a PolicyMatchError — NOT swallowed by the fail-soft discovery catch", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-throw-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    const client = scanClient(root, [{ name: "dev", oid: hexOid("o-dev"), date: "2025-05-01T00:00:00Z" }], "dev");
    const runtime: AuditRuntime = { config: testConfig(root, 25), configHash: "h", branchPolicy: throwingPolicy, repositoryPolicy: compileRepositoryPolicy([]) };
    await expect(processRepo(db, client, runtime, runId, "org-a", repo, [], new Set())).rejects.toThrow(PolicyMatchError);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a PolicyMatchError from INSIDE processUnit's scanned upsert is RETHROWN, never downgraded to a soft per-unit error", async () => {
    // The existing propagation tests force the throw from the PLANNER, BEFORE processRepo's per-unit
    // try/catch. The write-time attribution verifier can instead throw PolicyMatchError from
    // db.upsertRunUnitHead INSIDE processUnit — the exact path processRepo's `if (e instanceof
    // PolicyMatchError) throw e` (checked first in the per-unit catch, before the throttle/else arms)
    // guards. A coherent planner never writes a
    // mismatch, so inject it at the write boundary: wrap the SCANNED upsert to throw the fatal error.
    // No pre-seeded work-queue rows → the only scanned upsert is processUnit's (inside the catch), never
    // the skip-current write that sits outside it. RED without that branch: the generic arm swallows the
    // error (insertError + status:'error') and processRepo RESOLVES, failing both assertions below.
    const root = mkdtempSync(join(tmpdir(), "policy-inside-throw-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    const injected = new PolicyMatchError("excludeBranches", "x*", "main", new Error("simulated write-time attribution incoherence inside processUnit"));
    const realUpsert = db.upsertRunUnitHead.bind(db);
    (db as unknown as { upsertRunUnitHead: AuditDb["upsertRunUnitHead"] }).upsertRunUnitHead = (h) => {
      if (h.status === "scanned") throw injected; // processUnit's scanned write; delegate every other row
      return realUpsert(h);
    };
    const client = scanClient(root, [{ name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }], "main");
    let thrown: unknown;
    await captureJsonl(async () => {
      try {
        await processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set());
      } catch (e) {
        thrown = e;
      }
    });
    expect(thrown).toBe(injected); // the EXACT object, rethrown unchanged — not re-wrapped, not swallowed
    // a downgrade would have written a scope='scan' error row and flipped the unit to 'error'; neither may happen
    expect((db.read(`SELECT COUNT(*) AS n FROM errors WHERE run_id = ? AND scope = 'scan'`).get(runId) as { n: number }).n).toBe(0);
    expect(db.getUnit(key("main"))?.status).not.toBe("error");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("runScan marks the run FAILED on a PolicyMatchError and rethrows the original", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-failrun-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    // packages:[] so discoverCliTerms is a no-op (no registry fetch); the planner throws mid-run.
    const config = { ...testConfig(root, 25), organizations: ["org-a"], packages: [] };
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([{ name: "dev", oid: hexOid("o-dev"), date: "2025-05-01T00:00:00Z" }], "dev") };
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify([{ name: "svc", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false }])}` };
    });
    const noArgs: OrchestrateArgs = { configPath: null, plan: false, fresh: false, purgeCache: false, rescanBranches: [], help: false };
    const runtime: AuditRuntime = { config, configHash: "h", branchPolicy: throwingPolicy, repositoryPolicy: compileRepositoryPolicy([]) };
    let thrown: unknown = null;
    await captureJsonl(async () => {
      thrown = await runScan(db, client, runtime, noArgs, null).then(() => null, (e: unknown) => e);
    });
    // the ORIGINAL error is rethrown UNCHANGED (not re-wrapped): a PolicyMatchError carrying the
    // exact injected cause instance — object identity, not just the class.
    expect(thrown).toBeInstanceOf(PolicyMatchError);
    expect((thrown as { cause?: unknown }).cause).toBe(badGlobError);
    const run = db.read("SELECT status FROM runs ORDER BY started_at DESC LIMIT 1").get() as { status: string };
    expect(run.status).toBe("failed"); // the run boundary marked it failed before rethrowing
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("runPlan propagates a PolicyMatchError — its listBranchHeads catch never swallows it (the --plan fail-closed twin of runScan)", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-throw-"));
    // Branch discovery SUCCEEDS (so the shared planner runs), then the throwing exclude glob is evaluated.
    // runPlan try/catches ONLY its two discovery calls (repo discovery, then listBranchHeads);
    // planRepoBranches runs OUTSIDE both, so a match-time throw must abort the whole plan — NEVER degrade
    // into a per-repo "branch discovery failed" continue,
    // which would silently under-report the plan's excluded set. This pins for --plan the exact fail-closed
    // contract the real-scan path is tested for above; without it, a future widened catch would fail OPEN
    // untested (the bug class this feature's whole design exists to prevent).
    const config = { ...testConfig(root, 25), organizations: ["org-a"], packages: [] };
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([{ name: "dev", oid: hexOid("o-dev"), date: "2025-05-01T00:00:00Z" }], "dev") };
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify([{ name: "svc", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false }])}` };
    });
    const runtime: AuditRuntime = { config, configHash: "h", branchPolicy: throwingPolicy, repositoryPolicy: compileRepositoryPolicy([]) };
    let thrown: unknown = null;
    const events = await captureJsonl(async () => {
      thrown = await runPlan(client, runtime, "rvo").then(() => null, (e: unknown) => e);
    });
    // the ORIGINAL error propagates UNCHANGED (object identity on the injected cause), exactly like runScan
    expect(thrown).toBeInstanceOf(PolicyMatchError);
    expect((thrown as { cause?: unknown }).cause).toBe(badGlobError);
    // and it aborted MID-plan — a completed plan would have logged a plan-summary; a fail-open swallow
    // would have too (with the denied repo silently skipped). Its absence proves the fatal abort.
    expect(events.some((e) => e["event"] === "plan-summary")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("an allow-list MISS persists as excluded-by-allow with a NULL pattern", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-allow-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    const config = { ...testConfig(root, 25), branches: ["main"] }; // allowlist: only main (+ the default)
    const client = scanClient(root, [
      { name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" },
      { name: "feat", oid: hexOid("o-feat"), date: "2025-05-01T00:00:00Z" }, // not allowlisted → excluded-by-allow
    ], "main");
    await captureJsonl(() => processRepo(db, client, rt(config, "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId)).toEqual([
      { branch: "feat", status: "policy-excluded", sha: "", d: 0, ps: "excluded-by-allow", pat: null, scd: "2025-05-01T00:00:00Z" },
      { branch: "main", status: "scanned", sha: hexOid("o-main"), d: 1, ps: null, pat: null, scd: "2025-06-01T00:00:00Z" },
    ]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a past-cap branch keeps its prior 'done' work-queue state (reusable on a later cap-order promotion)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pastcap-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    db.enqueueUnit(key("feat"), runId); // a prior run scanned feat to done@o-feat
    db.setUnitStatus(key("feat"), { status: "done", runId, lastCommitSha: hexOid("o-feat"), lastCommitDate: "2025-04-01T00:00:00Z" });
    const client = scanClient(root, [ // cap=1: main default-exempt, dev fills the slot, feat past-cap
      { name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" },
      { name: "dev", oid: hexOid("o-dev"), date: "2025-05-01T00:00:00Z" },
      { name: "feat", oid: hexOid("o-feat"), date: "2025-04-01T00:00:00Z" },
    ], "main");
    await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 1), "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId).find((r) => (r as { branch: string }).branch === "feat")).toMatchObject({ status: "past-cap", sha: "", ps: null });
    const featUnit = db.getUnit(key("feat")); // work queue UNTOUCHED — the prior done scan survives
    expect(featUnit?.status).toBe("done");
    expect(featUnit?.lastCommitSha).toBe(hexOid("o-feat"));
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("clone-fallback with a MOVED branch: both run_unit_head AND work_queue pin the clone HEAD's sha+date", async () => {
    const root = mkdtempSync(join(tmpdir(), "clone-move-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    // discovery: main@o-main dated 2025-06-01. The tree is TRUNCATED → clone fallback, and the clone
    // HEAD has MOVED to o-moved dated 2025-06-15 (branch advanced between discovery and the clone).
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([{ name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }], "main") };
      if (args[0] === "clone") { const dest = args[args.length - 1]!; mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, "package.json"), "{}"); return { exitCode: 0, stderr: "", stdout: "" }; }
      if (args[0] === "rev-parse") return { exitCode: 0, stderr: "", stdout: hexOid("o-moved") + "\n" };
      if (args[0] === "show") return { exitCode: 0, stderr: "", stdout: "2025-06-15T09:00:00+00:00\n" };
      return { exitCode: 0, stderr: "", stdout: treeBody(args, true) }; // REST tree → truncated
    });
    await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
    // the durable row pins the SCANNED (clone) commit + its OWN date — never the stale discovered date
    expect(headRowsOf(db, runId)).toEqual([
      { branch: "main", status: "scanned", sha: hexOid("o-moved"), d: 1, ps: null, pat: null, scd: "2025-06-15T09:00:00+00:00" },
    ]);
    const unit = db.getUnit(key("main")); // the work-queue pair matches (the stale-date fix)
    expect(unit?.lastCommitSha).toBe(hexOid("o-moved"));
    expect(unit?.lastCommitDate).toBe("2025-06-15T09:00:00+00:00");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a clone HEAD that is NOT a hex object id fails the unit LOUD (never persisted as the scanned commit)", async () => {
    const root = mkdtempSync(join(tmpdir(), "clone-badsha-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([{ name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }], "main") };
      if (args[0] === "clone") { const dest = args[args.length - 1]!; mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, "package.json"), "{}"); return { exitCode: 0, stderr: "", stdout: "" }; }
      if (args[0] === "rev-parse") return { exitCode: 0, stderr: "", stdout: "not-a-hex-sha\n" }; // hostile/garbled clone HEAD
      if (args[0] === "show") return { exitCode: 0, stderr: "", stdout: "2025-06-15T09:00:00+00:00\n" };
      return { exitCode: 0, stderr: "", stdout: treeBody(args, true) }; // truncated → clone fallback
    });
    await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
    expect(db.getUnit(key("main"))?.status).toBe("error"); // rejected loud — never persisted as the scanned commit
    expect((db.read(`SELECT COUNT(*) AS n FROM errors WHERE run_id = ? AND scope = 'scan'`).get(runId) as { n: number }).n).toBeGreaterThan(0);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a walkClone failure on a TRUNCATED tree fails the unit LOUD and still reclaims the clone temp dir (no leak)", async () => {
    const root = mkdtempSync(join(tmpdir(), "clone-leak-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    // truncated tree → clone fallback; the clone "succeeds" but the dest dir is never materialized, so
    // walkClone's readdirSync throws (a deterministic stand-in for an EACCES/EIO walk failure on a real
    // large clone). Since walkClone now throws, the clone temp dir must be reclaimed by processUnit's
    // cleanup, not leaked until the next startup sweep.
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([{ name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }], "main") };
      if (args[0] === "clone") return { exitCode: 0, stderr: "", stdout: "" }; // exits 0 but creates no dest
      if (args[0] === "rev-parse") return { exitCode: 0, stderr: "", stdout: hexOid("o-moved") + "\n" };
      if (args[0] === "show") return { exitCode: 0, stderr: "", stdout: "2025-06-15T09:00:00+00:00\n" };
      return { exitCode: 0, stderr: "", stdout: treeBody(args, true) }; // truncated → clone fallback
    });
    await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
    expect(db.getUnit(key("main"))?.status).toBe("error"); // failed loud, never silently marked scanned
    expect((db.read(`SELECT COUNT(*) AS n FROM errors WHERE run_id = ? AND scope = 'scan'`).get(runId) as { n: number }).n).toBeGreaterThan(0);
    // the CLONE run temp dir (makeRunTempDir: pkg-audit-*) must be reclaimed; the pkg-audit-gitcfg-*
    // dir is a client-lifetime git-config resource, not a per-unit leak, so exclude it.
    const cloneLeftovers = readdirSync(root).filter((n) => n.startsWith("pkg-audit-") && !n.startsWith("pkg-audit-gitcfg-"));
    expect(cloneLeftovers).toEqual([]); // clone temp dir reclaimed — no leak
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a clone-cleanup FAILURE after a successful scan is surfaced as a warning, not swallowed", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const root = mkdtempSync(join(tmpdir(), "clone-cleanup-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    let runDir = "";
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([{ name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }], "main") };
      if (args[0] === "clone") {
        const dest = args[args.length - 1]!;
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, "package.json"), "{}");
        runDir = dirname(dest);
        chmodSync(runDir, 0o555); // read+exec but NOT writable → the finally's rmSync can't unlink → EACCES
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (args[0] === "rev-parse") return { exitCode: 0, stderr: "", stdout: hexOid("o-moved") + "\n" };
      if (args[0] === "show") return { exitCode: 0, stderr: "", stdout: "2025-06-15T09:00:00+00:00\n" };
      return { exitCode: 0, stderr: "", stdout: treeBody(args, true) }; // truncated → clone fallback
    });
    try {
      const events = await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
      expect(db.getUnit(key("main"))?.status).toBe("done"); // the scan itself SUCCEEDED (files readable), unit marked done
      const warnings = events.filter((e) => e.event === "warning" && e.reason === "clone-cleanup-failed");
      expect(warnings.length).toBe(1); // the failed reclaim is surfaced, not swallowed
    } finally {
      if (runDir !== "") chmodSync(runDir, 0o755); // restore so the outer rmSync can recurse
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runPlan uses the SAME shared planner — a denied branch counts as excludedByPolicy, not eligible", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-policy-"));
    const config = { ...testConfig(root, 25), organizations: ["org-a"], excludeBranches: ["dev"], packages: [] };
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([
        { name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" },
        { name: "dev", oid: hexOid("o-dev"), date: "2025-05-01T00:00:00Z" },
      ], "main") };
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify([{ name: "svc", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false }])}` };
    });
    let totals: Awaited<ReturnType<typeof runPlan>> | undefined;
    await captureJsonl(async () => { totals = await runPlan(client, rt(config, "h"), "rvo"); });
    expect(totals?.branchesEligible).toBe(1); // main only
    expect(totals?.branchesExcludedByPolicy).toBe(1); // dev denied — NOT counted eligible or cutoff
    expect(totals?.branchesSkippedByCutoff).toBe(0);
    expect(totals?.branchesPastCap).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("plan diagnostics: deny/allow sub-counts + default override, over all four dispositions", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-diag-"));
    // allowlist keep/* + deny deny-me, cap=1. main (default) is NOT in the allowlist → a scanned
    // default-branch OVERRIDE. deny-me → excluded-by-deny; other → excluded-by-allow. keep/a wins the
    // single cap slot; keep/b past-cap; keep/old (< cutoff) cutoff-skipped. Six heads, all four buckets.
    const config = { ...testConfig(root, 1), organizations: ["org-a"], branches: ["keep/*"], excludeBranches: ["deny-me"], packages: [] };
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([
        { name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" },      // default → override (not allow-listed)
        { name: "deny-me", oid: hexOid("o-deny"), date: "2025-06-01T00:00:00Z" },   // excluded-by-deny
        { name: "other", oid: hexOid("o-other"), date: "2025-06-01T00:00:00Z" },    // excluded-by-allow (allow-list miss)
        { name: "keep/a", oid: hexOid("o-ka"), date: "2025-05-01T00:00:00Z" },      // eligible (wins cap=1)
        { name: "keep/b", oid: hexOid("o-kb"), date: "2025-04-01T00:00:00Z" },      // past-cap
        { name: "keep/old", oid: hexOid("o-kold"), date: "2023-01-01T00:00:00Z" },  // cutoff-skipped (< 2024-01-01)
      ], "main") };
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify([{ name: "svc", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false }])}` };
    });
    let totals: PlanTotals | undefined;
    const events = await captureJsonl(async () => { totals = await runPlan(client, rt(config, "h"), "rvo"); });
    const t = totals!;
    // the four-way disjoint partition covers every discovered head
    expect(t.branchesEligible).toBe(2);        // main (override) + keep/a
    expect(t.branchesSkippedByCutoff).toBe(1); // keep/old
    expect(t.branchesPastCap).toBe(1);         // keep/b
    expect(t.branchesExcludedByPolicy).toBe(2); // deny-me + other
    expect(t.branchesEligible + t.branchesSkippedByCutoff + t.branchesPastCap + t.branchesExcludedByPolicy).toBe(6);
    // the plan diagnostic overlays
    expect(t.excludedByDeny).toBe(1);
    expect(t.excludedByAllow).toBe(1);
    expect(t.defaultBranchPolicyOverrides).toBe(1); // main
    // overlay invariants: sub-counts sum to the excluded bucket; overrides live INSIDE eligible
    expect(t.excludedByDeny + t.excludedByAllow).toBe(t.branchesExcludedByPolicy);
    expect(t.defaultBranchPolicyOverrides).toBeLessThanOrEqual(t.branchesEligible);
    // the per-repo plan event carries the same sub-counts (repo-level reconciliation)
    const repoEvent = events.find((e) => e["event"] === "plan" && e["repo"] === "svc")!;
    expect(repoEvent).toMatchObject({ branchesExcludedByPolicy: 2, excludedByDeny: 1, excludedByAllow: 1, defaultBranchPolicyOverrides: 1 });
    // and so does the plan-summary event
    const summary = events.find((e) => e["event"] === "plan-summary")!;
    expect(summary).toMatchObject({ excludedByDeny: 1, excludedByAllow: 1, defaultBranchPolicyOverrides: 1 });
    rmSync(root, { recursive: true, force: true });
  });

  // ---- policy warnings ----
  // A client serving one org repo (svc) + the given branch heads + an empty tree (so a scanned unit
  // runs to zero findings). Distinguishes the GraphQL head query, the git-trees fetch, and the repo list.
  const fullClient = (root: string, heads: Array<{ name: string; oid: string; date: string }>, defaultBranch: string | null): GithubClient =>
    makeClient(root, async (_bin, args) => {
      const j = args.join(" ");
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads(heads, defaultBranch) };
      if (j.includes("git/trees")) return { exitCode: 0, stderr: "", stdout: treeBody(args) };
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify([{ name: "svc", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false }])}` };
    });
  const noArgsT7: OrchestrateArgs = { configPath: null, plan: false, fresh: false, purgeCache: false, rescanBranches: [], help: false };
  const policyWarnEvents = (events: Array<Record<string, unknown>>) => events.filter((e) => e["event"] === "policy-warning");

  test("runPlan emits an unmatched-pattern warning (before plan-summary) for a deny pattern that matched no branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "warn-plan-"));
    const config = { ...testConfig(root, 25), organizations: ["org-a"], excludeBranches: ["release/*"], packages: [] };
    const events = await captureJsonl(async () => { await runPlan(fullClient(root, [{ name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }], "main"), rt(config, "h"), "rvo"); });
    expect(policyWarnEvents(events)).toEqual([{ event: "policy-warning", kind: "unmatched-pattern", direction: "deny", pattern: "release/*" }]);
    expect(events.findIndex((e) => e["event"] === "policy-warning")).toBeLessThan(events.findIndex((e) => e["event"] === "plan-summary"));
    rmSync(root, { recursive: true, force: true });
  });

  test("unmatched warnings are SUPPRESSED when zero repos were discovered (branch discovery failed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "warn-suppress-"));
    const config = { ...testConfig(root, 25), organizations: ["org-a"], excludeBranches: ["release/*"], packages: [] };
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 1, stderr: "gh: boom", stdout: "" }; // branch discovery FAILS
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify([{ name: "svc", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false }])}` };
    });
    const events = await captureJsonl(async () => { await runPlan(client, rt(config, "h"), "rvo"); });
    expect(policyWarnEvents(events)).toEqual([]); // suppressed
    rmSync(root, { recursive: true, force: true });
  });

  test("a SUCCESSFUL but EMPTY discovery (zero heads) does NOT suppress — only a FAILURE does", async () => {
    const root = mkdtempSync(join(tmpdir(), "warn-empty-"));
    const config = { ...testConfig(root, 25), organizations: ["org-a"], excludeBranches: ["release/*"], packages: [] };
    const events = await captureJsonl(async () => { await runPlan(fullClient(root, [], null), rt(config, "h"), "rvo"); }); // discovered, empty
    expect(policyWarnEvents(events)).toEqual([{ event: "policy-warning", kind: "unmatched-pattern", direction: "deny", pattern: "release/*" }]);
    rmSync(root, { recursive: true, force: true });
  });

  test("branches:[] emits empty-allowlist EVEN on the owner-discovery-throttle early return (unconditional)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const config = { ...testConfig("/tmp", 25), organizations: null, branches: [], packages: [] };
    const client = { sweepStaleTempDirs: () => [], listOrgMemberships: async () => { throw new ThrottleExhausted("core bucket"); } } as unknown as GithubClient;
    const events = await captureJsonl(async () => { await runScan(db, client, rt(config, "h"), noArgsT7, null); });
    expect(policyWarnEvents(events)).toEqual([{ event: "policy-warning", kind: "empty-allowlist" }]);
    expect(db.read("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 }); // no run started
    db.close();
  });

  test("branches:[] emits empty-allowlist EXACTLY ONCE on a normally-completing run (not double-counted)", async () => {
    const root = mkdtempSync(join(tmpdir(), "warn-empty-once-"));
    const config = { ...testConfig(root, 25), organizations: ["org-a"], branches: [], packages: [] };
    const events = await captureJsonl(async () => { await runPlan(fullClient(root, [{ name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }], "main"), rt(config, "h"), "rvo"); });
    const emptyAllow = events.filter((e) => e["event"] === "policy-warning" && e["kind"] === "empty-allowlist");
    expect(emptyAllow).toEqual([{ event: "policy-warning", kind: "empty-allowlist" }]); // once (at entry), never re-emitted at finalize
    rmSync(root, { recursive: true, force: true });
  });

  test("the SAME pattern in allow AND deny yields TWO direction-specific warnings end-to-end", async () => {
    const root = mkdtempSync(join(tmpdir(), "warn-both-"));
    const config = { ...testConfig(root, 25), organizations: ["org-a"], branches: ["shared"], excludeBranches: ["shared"], packages: [] };
    // only 'main' (default) is discovered — 'shared' matches nothing in either list
    const events = await captureJsonl(async () => { await runPlan(fullClient(root, [{ name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }], "main"), rt(config, "h"), "rvo"); });
    expect(policyWarnEvents(events)).toEqual([
      { event: "policy-warning", kind: "unmatched-pattern", direction: "deny", pattern: "shared" },
      { event: "policy-warning", kind: "unmatched-pattern", direction: "allow", pattern: "shared" },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test("runScan with a SHADOWED throwing coverage glob fails the run fatally, writing ZERO branch rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "warn-fatal-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const config = { ...testConfig(root, 25), organizations: ["org-a"], packages: [] };
    const badError = new Error("shadowed");
    // deny ['main' exact winner, 'z*' throwing]: classification wins on the exact 'main', but the
    // coverage sweep invokes z*.match('main') and throws — the run must fail with no branch rows.
    const runtime: AuditRuntime = { config, configHash: "h", branchPolicy: { include: null, exclude: [{ pattern: "main", glob: new Bun.Glob("main") }, { pattern: "z*", glob: throwingGlob(badError) }] }, repositoryPolicy: compileRepositoryPolicy([]) };
    let thrown: unknown = null;
    await captureJsonl(async () => { thrown = await runScan(db, fullClient(root, [{ name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }], "main"), runtime, noArgsT7, null).then(() => null, (e: unknown) => e); });
    expect(thrown).toBeInstanceOf(PolicyMatchError);
    expect((thrown as { cause?: unknown }).cause).toBe(badError); // the ORIGINAL error, unchanged
    expect(db.read("SELECT COUNT(*) AS n FROM run_unit_head").get()).toEqual({ n: 0 });
    const run = db.read("SELECT status FROM runs ORDER BY started_at DESC LIMIT 1").get() as { status: string };
    expect(run.status).toBe("failed");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("--plan and the real run emit IDENTICAL ordered policy-warning arrays for the same discovered heads", async () => {
    const root = mkdtempSync(join(tmpdir(), "warn-parity-"));
    const config = { ...testConfig(root, 25), organizations: ["org-a"], excludeBranches: ["release/*", "wip"], packages: [] };
    const heads = [{ name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }];
    const planEvents = await captureJsonl(async () => { await runPlan(fullClient(root, heads, "main"), rt(config, "h"), "rvo"); });
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runEvents = await captureJsonl(async () => { await runScan(db, fullClient(root, heads, "main"), rt(config, "h"), noArgsT7, null); });
    db.close();
    const expected = [
      { event: "policy-warning", kind: "unmatched-pattern", direction: "deny", pattern: "release/*" },
      { event: "policy-warning", kind: "unmatched-pattern", direction: "deny", pattern: "wip" },
    ];
    expect(policyWarnEvents(planEvents)).toEqual(expected);
    expect(policyWarnEvents(runEvents)).toEqual(expected); // identical to --plan
    rmSync(root, { recursive: true, force: true });
  });

  test("runScan SUPPRESSES warnings when branch discovery fails for every repo (the null-coverage seam)", async () => {
    const root = mkdtempSync(join(tmpdir(), "warn-scan-suppress-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const config = { ...testConfig(root, 25), organizations: ["org-a"], excludeBranches: ["release/*"], packages: [] };
    // repo list OK, but branch discovery FAILS → processRepo returns null → coverages empty → suppressed
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 1, stderr: "gh: boom", stdout: "" };
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify([{ name: "svc", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false }])}` };
    });
    const events = await captureJsonl(async () => { await runScan(db, client, rt(config, "h"), noArgsT7, null); });
    expect(policyWarnEvents(events)).toEqual([]); // suppressed via runScan's null-coverage path
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("runScan does NOT suppress on a successful EMPTY repo (empty coverage still counts as discovered)", async () => {
    const root = mkdtempSync(join(tmpdir(), "warn-scan-empty-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const config = { ...testConfig(root, 25), organizations: ["org-a"], excludeBranches: ["release/*"], packages: [] };
    const events = await captureJsonl(async () => { await runScan(db, fullClient(root, [], null), rt(config, "h"), noArgsT7, null); });
    expect(policyWarnEvents(events)).toEqual([{ event: "policy-warning", kind: "unmatched-pattern", direction: "deny", pattern: "release/*" }]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  // ---- stale-row reconciliation ----
  const staleHead = (db: AuditDb, runId: string, branch: string, over: Partial<Parameters<AuditDb["upsertRunUnitHead"]>[0]> = {}): void =>
    db.upsertRunUnitHead({ runId, organization: "org-a", repository: "svc", branch, commitSha: "", status: "skipped-cutoff", isDefaultBranch: false, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T00:00:00Z", ...over });

  test("reconciliation: a resumed repo prunes rows for branches deleted since a prior invocation, and logs it once", async () => {
    const root = mkdtempSync(join(tmpdir(), "recon-prune-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    staleHead(db, runId, "deleted"); // a prior invocation recorded it; this discovery no longer sees it
    const client = scanClient(root, [{ name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }], "main");
    const events = await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId).map((r) => (r as { branch: string }).branch)).toEqual(["main"]); // 'deleted' pruned
    expect(events.filter((e) => e["event"] === "reconciliation")).toEqual([
      { event: "reconciliation", target: "run_unit_head", runId, org: "org-a", repo: "svc", action: "prune-stale", pruned: 1 },
    ]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("reconciliation: a FAILED branch discovery skips reconciliation — prior rows are RETAINED (transient failure != deletion)", async () => {
    const root = mkdtempSync(join(tmpdir(), "recon-fail-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    staleHead(db, runId, "ghost");
    const failClient = makeClient(root, async (_bin, args) =>
      args.some((a) => a === "graphql") ? { exitCode: 1, stderr: "gh: boom", stdout: "" } : { exitCode: 0, stderr: "", stdout: treeBody(args) });
    const events = await captureJsonl(() => processRepo(db, failClient, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId).map((r) => (r as { branch: string }).branch)).toEqual(["ghost"]); // retained, NOT pruned
    expect(events.some((e) => e["event"] === "reconciliation")).toBe(false); // no prune ran
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("reconciliation: a still-live branch whose scan FAILS keeps its prior row (keep-set is live NAMES, not rows written)", async () => {
    const root = mkdtempSync(join(tmpdir(), "recon-scanfail-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    staleHead(db, runId, "main", { commitSha: "old-sha", status: "scanned", isDefaultBranch: true, scannedCommitDate: "2025-05-01T00:00:00Z" });
    // re-discovers main at a NEW commit, but the tree fetch (scan) FAILS → no new row written this attempt
    const scanFailClient = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([{ name: "main", oid: hexOid("new-sha"), date: "2025-06-01T00:00:00Z" }], "main") };
      if (args.some((a) => a.includes("git/trees"))) return { exitCode: 1, stderr: "gh: tree boom", stdout: "" };
      return { exitCode: 0, stderr: "", stdout: "HTTP/2.0 200 X\r\n\r\n[]" };
    });
    await captureJsonl(() => processRepo(db, scanFailClient, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
    // main is in the live keep-set → NOT pruned; its PRIOR row survives (the failed scan wrote no replacement)
    expect(headRowsOf(db, runId).find((r) => (r as { branch: string }).branch === "main")).toMatchObject({ branch: "main", status: "scanned", sha: "old-sha" });
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  // ---- the default branch is resolved from the §5.B snapshot, never the §5.A REST listing ---------
  // REGRESSION: the REST repo listing and branch discovery are different epochs. When the default is
  // renamed in between, trusting REST made the REAL default look non-default — and under a restrictive
  // policy the always-eligible exemption then missed it and the repo yielded ZERO scanned units,
  // silently. These pin the fix at BOTH consumers of the shared planner (the run and --plan), because
  // runPlan calls listBranchHeads directly and a shared-planner test cannot catch bad source wiring.
  test("a default RENAMED since the REST listing is still scanned under branches:[] (always scanned)", async () => {
    const root = mkdtempSync(join(tmpdir(), "stale-default-scan-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    // fullClient's REST repo listing hardcodes default_branch:"main" — but 'main' is GONE and GraphQL
    // reports 'trunk' as the default. branches:[] allow-lists NOTHING, so only the default survives.
    const config = { ...testConfig(root, 25), branches: [], packages: [] };
    const client = fullClient(root, [
      { name: "trunk", oid: hexOid("o-trunk"), date: "2025-06-01T00:00:00Z" }, // the REAL (renamed) default
      { name: "dev", oid: hexOid("o-dev"), date: "2025-05-01T00:00:00Z" },
    ], "trunk");
    await captureJsonl(() => processRepo(db, client, rt(config, "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId)).toEqual([
      // dev: a non-default allow-list miss → excluded, as before.
      { branch: "dev", status: "policy-excluded", sha: "", d: 0, ps: "excluded-by-allow", pat: null, scd: "2025-05-01T00:00:00Z" },
      // trunk: SCANNED and flagged default. Before the fix this row read
      // {status:"policy-excluded", d:0, ps:"excluded-by-allow"} — the repo's real default, dropped.
      // ps records the COUNTERFACTUAL (policy would have excluded it); the override keeps it eligible.
      { branch: "trunk", status: "scanned", sha: hexOid("o-trunk"), d: 1, ps: "excluded-by-allow", pat: null, scd: "2025-06-01T00:00:00Z" },
    ]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("--plan agrees: the renamed default counts as eligible + a policy override, not excluded", async () => {
    const root = mkdtempSync(join(tmpdir(), "stale-default-plan-"));
    const config = { ...testConfig(root, 25), organizations: ["org-a"], branches: [], packages: [] };
    const client = fullClient(root, [
      { name: "trunk", oid: hexOid("o-trunk"), date: "2025-06-01T00:00:00Z" },
      { name: "dev", oid: hexOid("o-dev"), date: "2025-05-01T00:00:00Z" },
    ], "trunk");
    let totals: PlanTotals | undefined;
    await captureJsonl(async () => { totals = await runPlan(client, rt(config, "h"), "rvo"); });
    expect(totals?.branchesEligible).toBe(1); // trunk — NOT zero
    expect(totals?.branchesExcludedByPolicy).toBe(1); // dev only
    expect(totals?.excludedByAllow).toBe(1);
    expect(totals?.defaultBranchPolicyOverrides).toBe(1); // trunk: kept despite the empty allowlist
    expect(totals?.discoveryErrors).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("--plan counts an INCOHERENT snapshot as a discovery error, not as an empty repo", async () => {
    // runPlan has its own try/catch around listBranchHeads, so the coherence rejection has to land in
    // discoveryErrors there. A plan that silently reported 0 eligible would understate the scope of a
    // repo it never actually resolved — the same silent under-report in preview form.
    const root = mkdtempSync(join(tmpdir(), "plan-incoherent-"));
    const config = { ...testConfig(root, 25), organizations: ["org-a"], branches: [], packages: [] };
    const client = fullClient(root, [{ name: "dev", oid: hexOid("o-dev"), date: "2025-05-01T00:00:00Z" }], null); // heads, no default
    let totals: PlanTotals | undefined;
    const events = await captureJsonl(async () => { totals = await runPlan(client, rt(config, "h"), "rvo"); });
    expect(totals?.discoveryErrors).toBe(1);
    expect(totals?.branchesEligible).toBe(0);
    expect(totals?.branchesExcludedByPolicy).toBe(0); // NOT planned at all — not "excluded"
    expect(events.some((e) => e["event"] === "plan" && String(e["error"] ?? "").includes("branch discovery failed"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  // Reconciliation boundary: an INCOHERENT snapshot must fail discovery, never reconcile. Pairs with the
  // legitimate-empty case below — together they prove the fix did not turn "empty" into "failed".
  test("reconciliation: a snapshot with heads but NO default fails discovery — prior rows retained, no prune", async () => {
    const root = mkdtempSync(join(tmpdir(), "recon-nodefault-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    staleHead(db, runId, "ghost"); // a prior invocation's row for a branch this discovery won't return
    const client = scanClient(root, [{ name: "dev", oid: hexOid("o-dev"), date: "2025-05-01T00:00:00Z" }], null);
    const events = await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId).map((r) => (r as { branch: string }).branch)).toEqual(["ghost"]); // retained
    expect(events.some((e) => e["event"] === "reconciliation")).toBe(false); // no prune ran
    expect(events.some((e) => e["event"] === "discovery" && String(e["error"] ?? "").includes("null but 1 head(s)"))).toBe(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("reconciliation: the legitimate EMPTY repo (no heads, no default) still reconciles and prunes", async () => {
    const root = mkdtempSync(join(tmpdir(), "recon-empty-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    staleHead(db, runId, "gone"); // every branch was deleted since the prior invocation
    const client = scanClient(root, [], null); // a repo with no commits: zero heads AND no default
    const events = await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId)).toEqual([]); // 'gone' pruned — a complete discovery, just empty
    expect(events.some((e) => e["event"] === "reconciliation")).toBe(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("runSummaryText", () => {
  test("prints the §7 counters with report-matching labels and the fail-soft note", () => {
    const text = runSummaryText("run-abc", {
      organizationsScanned: 2, repositoriesScanned: 7, branchesScanned: 88,
      branchesSkippedByCutoff: 13, branchesExcludedByPolicy: 5, branchesPastCap: 2, branchesErrored: 4,
      totalDependencyFindings: 104, totalUsageFindings: 994,
    }, 3, "output/run-run-abc.json");
    // labels + values pinned; column padding is cosmetic and free to change
    expect(text).toContain("AUDIT COMPLETE — run run-abc");
    expect(text).toMatch(/Organizations scanned:\s+2\b/);
    expect(text).toMatch(/Repositories scanned:\s+7\b/);
    expect(text).toMatch(/Branches scanned:\s+88 \(13 skipped by cutoff · 5 excluded by policy · 2 past cap · 4 scan-errored\)/);
    expect(text).toMatch(/Dependency findings:\s+104\b/);
    expect(text).toMatch(/Usage findings:\s+994\b/);
    expect(text).toMatch(/Errors recorded:\s+3 \(fail-soft/);
    expect(text).toContain("output/run-run-abc.json (+ latest.json)");
  });
});

describe("planSummaryText", () => {
  const config: Parameters<typeof planSummaryText>[0] = {
    cutoffDate: "2024-01-01",
    maxBranchesPerRepo: 25,
    packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
  };

  // a full PlanTotals with all-zero policy diagnostics; spread + override per test
  const totals: PlanTotals = {
    owners: ["org-a", "org-b"], ownersSource: "discovered",
    reposDiscovered: 42, reposKept: 37,
    branchesEligible: 210, branchesSkippedByCutoff: 58, branchesPastCap: 12, branchesExcludedByPolicy: 0,
    excludedByDeny: 0, excludedByAllow: 0, defaultBranchPolicyOverrides: 0, discoveryErrors: 0,
  };

  test("names the counts, the cutoff, the packages, and the no-writes guarantee", () => {
    const text = planSummaryText(config, { ...totals, branchesExcludedByPolicy: 3, excludedByDeny: 2, excludedByAllow: 1, defaultBranchPolicyOverrides: 1 });
    expect(text).toContain("PLAN — preview only");
    expect(text).toContain("no database opened");
    expect(text).toContain("org-a, org-b");
    expect(text).toContain("42 discovered, 37 kept");
    expect(text).toContain("210 eligible");
    expect(text).toContain("58 skipped by cutoff (< 2024-01-01)");
    expect(text).toContain("12 past the per-repo cap (25)");
    expect(text).toContain("3 excluded by branch policy");
    expect(text).toContain("expo");
    expect(text).toMatch(/Discovery errors:\s+0\b/);
  });

  test("policy detail line: shown with the deny/allow split + override count when policy removed branches", () => {
    const text = planSummaryText(config, { ...totals, branchesExcludedByPolicy: 3, excludedByDeny: 2, excludedByAllow: 1, defaultBranchPolicyOverrides: 1 });
    expect(text).toContain("Policy detail:        2 excluded by deny · 1 excluded as not allow-listed · 1 default-branch policy override(s) (already counted as eligible)");
  });

  test("policy detail line: shown for an override-only plan (no exclusions, but a policy would have excluded the default)", () => {
    const text = planSummaryText(config, { ...totals, defaultBranchPolicyOverrides: 2 });
    expect(text).toContain("0 excluded by deny · 0 excluded as not allow-listed · 2 default-branch policy override(s)");
  });

  test("policy detail line: SUPPRESSED when no policy activity (no exclusions, no overrides)", () => {
    const text = planSummaryText(config, totals); // all policy diagnostics zero
    expect(text).not.toContain("Policy detail:");
  });
});

// ---- §4 throttle-requeue policy (sites a-d: owner discovery, repo discovery, branch ----------
// ---- discovery, per-unit scan) ----------------------------------------------------------------

const repo: RepoInfo = {
  name: "r", organization: "o",
  pushedAt: "2026-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false,
};
const liveHead: BranchHead = {
  name: "main", oid: "a".repeat(40), committedDate: "2026-01-01T00:00:00Z", treeOid: "b".repeat(40),
};
// The §5.B snapshot these stubs return. Typed EXPLICITLY (not inferred): the client stubs below are
// `as unknown as GithubClient`, which erases the return type, so tsc cannot check their shape against
// listBranchHeads at all. Annotating the shared literal is what keeps them honest — without it, a stub
// returning a bare head array would compile and silently plan every repo with NO default branch.
const liveSnapshot: BranchSnapshot = { heads: [liveHead], defaultBranch: "main" };
// frozen: these 9 tests share one config; freezing forbids accidental cross-test mutation.
const config = Object.freeze({
  cutoffDate: "2000-01-01", maxBranchesPerRepo: 10, maxReposPerOrg: 10,
  includeArchived: true, includeForks: true, includePersonalNamespace: false,
  organizations: null, excludeOrganizations: [], excludeRepositories: [],
  concurrency: { organizations: 1, repositories: 1, branches: 1 }, // sequential in tests (derived stubs inherit)
}) as unknown as Config;
const KEY: WorkUnitKey = { configHash: "hash", scope: "branch", organization: "o", repository: "r", branch: "main" };

// only the methods each function touches before the injected failure fires.
const fakeClient = (failure: Error): GithubClient =>
  ({
    listBranchHeads: async () => liveSnapshot,
    fetchTreeRecursive: async () => { throw failure; },
  }) as unknown as GithubClient;

const openRun = (): { db: AuditDb; runId: string } => {
  const db = AuditDb.open({ sqlitePath: ":memory:" });
  const { runId } = db.startRun({
    configHash: "hash", effectiveOwners: ["o"], ownersSource: "discovered",
    trackedPackages: ["expo"], cutoffDate: "2000-01-01", githubHost: "github.com",
  });
  return { db, runId };
};

describe("processRepo throttle requeue (§4)", () => {
  test("ThrottleExhausted puts the unit back to PENDING with no permanent error row", async () => {
    const { db, runId } = openRun();
    await processRepo(db, fakeClient(new ThrottleExhausted("core bucket")), rt(config, "hash"), runId, "o", repo, [], new Set());
    expect(db.getUnit(KEY)?.status).toBe("pending"); // a later run retries it
    const errs = db.read("SELECT message FROM errors WHERE scope='scan'").all();
    expect(errs.length).toBe(0);
    db.close();
  });

  test("a GithubApiError still lands as a permanent ERROR with an errors row", async () => {
    const { db, runId } = openRun();
    await processRepo(db, fakeClient(new GithubApiError("boom", { endpoint: "x" })), rt(config, "hash"), runId, "o", repo, [], new Set());
    expect(db.getUnit(KEY)?.status).toBe("error");
    const errs = db.read("SELECT message FROM errors WHERE scope='scan'").all() as Array<{ message: string }>;
    expect(errs.length).toBe(1);
    expect(errs[0]!.message).toMatch(/boom/);
    db.close();
  });

  test("a ThrottleExhausted during a unit's CONTENT fetch requeues the unit — never a silent done", async () => {
    // the api reader degrades ONLY a status-404 to null (file treated as absent); a throttle
    // means the unit was never fully read, and marking it done would let the §3 skip
    // predicate skip this head FOREVER with silently missing findings.
    const scanConfig = {
      ...(config as unknown as Record<string, unknown>),
      githubHost: "github.com",
      packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
      excludeDirGlobs: [],
    } as unknown as Config;
    const { db, runId } = openRun();
    const client = {
      listBranchHeads: async () => liveSnapshot,
      fetchTreeRecursive: async () => ({ truncated: false, paths: [{ path: "package.json", type: "blob", sha: "c".repeat(40), size: 20 }] }),
      fetchFileRaw: async () => { throw new ThrottleExhausted("core bucket"); },
    } as unknown as GithubClient;
    await processRepo(db, client, rt(scanConfig, "hash"), runId, "o", repo, [], new Set());
    expect(db.getUnit(KEY)?.status).toBe("pending"); // requeued: a later run re-reads the head
    expect(db.read("SELECT message FROM errors").all().length).toBe(0);
    db.close();
  });

  test("a FATAL error during a unit's content fetch marks the unit error — never a silent done", async () => {
    // an SSO/permission 403 (or an exhausted no-response failure) on a per-file read is NOT
    // "file absent": completing the unit would permanently under-report its dependencies
    // with zero trace. It must land as a visible scan error (retried at the next head).
    const scanConfig = {
      ...(config as unknown as Record<string, unknown>),
      githubHost: "github.com",
      packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
      excludeDirGlobs: [],
    } as unknown as Config;
    const { db, runId } = openRun();
    const client = {
      listBranchHeads: async () => liveSnapshot,
      fetchTreeRecursive: async () => ({ truncated: false, paths: [{ path: "package.json", type: "blob", sha: "c".repeat(40), size: 20 }] }),
      fetchFileRaw: async () => { throw new GithubApiError("HTTP 403 (permission/forbidden) (repos/o/r/contents/package.json)", { status: 403 }); },
    } as unknown as GithubClient;
    await processRepo(db, client, rt(scanConfig, "hash"), runId, "o", repo, [], new Set());
    expect(db.getUnit(KEY)?.status).toBe("error");
    const errs = db.read("SELECT message FROM errors WHERE scope='scan'").all() as Array<{ message: string }>;
    expect(errs.length).toBe(1);
    expect(errs[0]!.message).toMatch(/403/);
    db.close();
  });

  test("a status-0 (no-HTTP-response) content-fetch failure also lands as a unit error", async () => {
    // pins that the benign degradation is BY STATUS (404 only), not by message shape — an
    // exhausted no-response failure (network plumbing, spawn timeout 124) must fail loud.
    const scanConfig = {
      ...(config as unknown as Record<string, unknown>),
      githubHost: "github.com",
      packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
      excludeDirGlobs: [],
    } as unknown as Config;
    const { db, runId } = openRun();
    const client = {
      listBranchHeads: async () => liveSnapshot,
      fetchTreeRecursive: async () => ({ truncated: false, paths: [{ path: "package.json", type: "blob", sha: "c".repeat(40), size: 20 }] }),
      fetchFileRaw: async () => { throw new GithubApiError("gh api produced no HTTP response: spawn timed out", { status: 0 }); },
    } as unknown as GithubClient;
    await processRepo(db, client, rt(scanConfig, "hash"), runId, "o", repo, [], new Set());
    expect(db.getUnit(KEY)?.status).toBe("error");
    expect(db.read("SELECT message FROM errors WHERE scope='scan'").all().length).toBe(1);
    db.close();
  });

  test("a 404 during a unit's content fetch stays benign (file treated as absent, unit done)", async () => {
    // the one genuinely-absent case: the tree listed a blob the contents API no longer
    // serves at that path (e.g. a force-push race) — skipping the file is correct.
    const scanConfig = {
      ...(config as unknown as Record<string, unknown>),
      githubHost: "github.com",
      packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
      excludeDirGlobs: [],
    } as unknown as Config;
    const { db, runId } = openRun();
    const client = {
      listBranchHeads: async () => liveSnapshot,
      fetchTreeRecursive: async () => ({ truncated: false, paths: [{ path: "package.json", type: "blob", sha: "c".repeat(40), size: 20 }] }),
      fetchFileRaw: async () => { throw new GithubApiError("HTTP 404 (repos/o/r/contents/package.json)", { status: 404 }); },
    } as unknown as GithubClient;
    await processRepo(db, client, rt(scanConfig, "hash"), runId, "o", repo, [], new Set());
    expect(db.getUnit(KEY)?.status).toBe("done");
    expect(db.read("SELECT message FROM errors").all().length).toBe(0);
    db.close();
  });
});

describe("same-name stale-head retention is DISPOSITION-AGNOSTIC", () => {
  test("a prior skipped-cutoff row survives a failed re-scan of the now-eligible advanced head", async () => {
    // Round-4 review finding: the retention docs used to describe the retained row as "scanned at
    // the old head" — but retention is name-keyed and disposition-agnostic. Invocation 1: the
    // non-default head sits BELOW the cutoff → a skipped-cutoff row (commit_sha='',
    // scanned_commit_date = discovered-head date). Invocation 2: the head ADVANCED past the cutoff
    // (now eligible, toScan) but its scan ERRORS → no replacement row is written, the name-keyed
    // prune keeps the branch (it is in the live keep-set), and the OLD skipped-cutoff row survives —
    // the report counts the branch in the cutoff bucket this run even though its live head is
    // eligible. Stale-not-wrong; the next run re-scans (unit left error).
    // branches/excludeBranches EXPLICIT: the shared frozen config omits them, and rt() would compile
    // the missing allowlist into [] (= default-only policy), silently policy-excluding `feat` in both
    // invocations — whose bucket rewrites its row every invocation, defeating the retention scenario.
    const cutoffConfig = { ...(config as unknown as Record<string, unknown>), cutoffDate: "2025-06-01", branches: null, excludeBranches: [] } as unknown as Config;
    // The persisted run cutoff matches the runtime's (startRun normally guarantees the pairing).
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { runId } = db.startRun({
      configHash: "hash", effectiveOwners: ["o"], ownersSource: "discovered",
      trackedPackages: ["expo"], cutoffDate: "2025-06-01", githubHost: "github.com",
    });
    let snapshot: BranchSnapshot = {
      heads: [
        { name: "main", oid: "a".repeat(40), committedDate: "2026-01-01T00:00:00Z", treeOid: "b".repeat(40) },
        { name: "feat", oid: "c".repeat(40), committedDate: "2025-01-01T00:00:00Z", treeOid: "d".repeat(40) }, // below cutoff
      ],
      defaultBranch: "main",
    };
    const treesRequested: string[] = [];
    const client = {
      listBranchHeads: async () => snapshot,
      fetchTreeRecursive: async (_o: string, _r: string, treeOid: string) => {
        treesRequested.push(treeOid);
        throw new GithubApiError("scan boom", { endpoint: "x" });
      },
    } as unknown as GithubClient;
    await processRepo(db, client, rt(cutoffConfig, "hash"), runId, "o", repo, [], new Set());
    const row1 = db.read("SELECT status, commit_sha, scanned_commit_date FROM run_unit_head WHERE branch='feat'").get() as { status: string };
    expect(row1.status).toBe("skipped-cutoff"); // invocation 1: recorded below the cutoff

    // invocation 2 (same run, resumed): feat's head ADVANCED past the cutoff, its scan errors.
    // Heads newest-first, as listBranchHeads supplies them.
    snapshot = {
      heads: [
        { name: "feat", oid: "e".repeat(40), committedDate: "2026-01-02T00:00:00Z", treeOid: "f".repeat(40) }, // ADVANCED past cutoff
        { name: "main", oid: "a".repeat(40), committedDate: "2026-01-01T00:00:00Z", treeOid: "b".repeat(40) },
      ],
      defaultBranch: "main",
    };
    await processRepo(db, client, rt(cutoffConfig, "hash"), runId, "o", repo, [], new Set());
    expect(treesRequested).toContain("f".repeat(40)); // the ADVANCED head really was scan-attempted (toScan, not re-skipped)
    const row2 = db.read("SELECT status, commit_sha, scanned_commit_date, policy_status, policy_matched_pattern FROM run_unit_head WHERE branch='feat'").get() as { status: string; commit_sha: string; scanned_commit_date: string; policy_status: string | null; policy_matched_pattern: string | null };
    expect(row2.status).toBe("skipped-cutoff"); // the PRIOR disposition survives — neither scanned nor pruned
    expect(row2.commit_sha).toBe(""); // still the non-scanned sentinel
    expect(row2.scanned_commit_date).toBe("2025-01-01T00:00:00Z"); // pinned to the OLDER evaluation's discovered date
    expect(row2.policy_status).toBeNull(); // a GENUINE cutoff row (the report's cutoff bucket), not a policy exclusion
    expect(row2.policy_matched_pattern).toBeNull();
    const featErrors = db.read("SELECT message FROM errors WHERE scope='scan' AND branch='feat'").all();
    expect(featErrors.length).toBe(1); // the failed re-scan is loud — the retained row is stale, not silent
    expect(db.getUnit({ configHash: "hash", scope: "branch", organization: "o", repository: "r", branch: "feat" })?.status).toBe("error"); // retryable: the next run re-scans
    db.close();
  });
});

describe("processRepo branch-discovery throttle (§4, site c)", () => {
  // client whose branch discovery (listBranchHeads) fails with the injected error.
  const branchDiscoveryFails = (failure: Error): GithubClient =>
    ({ listBranchHeads: async () => { throw failure; } }) as unknown as GithubClient;

  test("ThrottleExhausted is transient — no permanent discovery errors row", async () => {
    const { db, runId } = openRun();
    await processRepo(db, branchDiscoveryFails(new ThrottleExhausted("graphql bucket")), rt(config, "hash"), runId, "o", repo, [], new Set());
    const errs = db.read("SELECT message FROM errors WHERE scope='discovery'").all();
    expect(errs.length).toBe(0); // re-discovered next run, not a hard failure
    db.close();
  });

  test("a GithubApiError still records a permanent discovery errors row", async () => {
    const { db, runId } = openRun();
    await processRepo(db, branchDiscoveryFails(new GithubApiError("branch boom", { endpoint: "x" })), rt(config, "hash"), runId, "o", repo, [], new Set());
    const errs = db.read("SELECT message FROM errors WHERE scope='discovery'").all() as Array<{ message: string }>;
    expect(errs.length).toBe(1);
    expect(errs[0]!.message).toMatch(/branch discovery failed.*branch boom/);
    db.close();
  });
});

describe("processOwner repo-discovery throttle (§4, site b)", () => {
  const repoDiscoveryFails = (failure: Error): GithubClient =>
    ({ listOrgRepos: async () => { throw failure; } }) as unknown as GithubClient;

  test("ThrottleExhausted is transient — no permanent discovery errors row", async () => {
    const { db, runId } = openRun();
    await processOwner(db, repoDiscoveryFails(new ThrottleExhausted("core bucket")), rt(config, "hash"), runId, "o", null, [], new Set());
    const errs = db.read("SELECT message FROM errors WHERE scope='discovery'").all();
    expect(errs.length).toBe(0);
    db.close();
  });

  test("a GithubApiError still records a permanent discovery errors row", async () => {
    const { db, runId } = openRun();
    await processOwner(db, repoDiscoveryFails(new GithubApiError("repo boom", { endpoint: "x" })), rt(config, "hash"), runId, "o", null, [], new Set());
    const errs = db.read("SELECT message FROM errors WHERE scope='discovery'").all() as Array<{ message: string }>;
    expect(errs.length).toBe(1);
    expect(errs[0]!.message).toMatch(/repo discovery failed.*repo boom/);
    db.close();
  });
});

describe("resolveOwnersWithDiscovery owner-membership throttle (§4, site a)", () => {
  test("ThrottleExhausted returns null so the run ends cleanly (no crash)", async () => {
    const client = { listOrgMemberships: async () => { throw new ThrottleExhausted("core bucket"); } } as unknown as GithubClient;
    expect(await resolveOwnersWithDiscovery(client, config, null)).toBeNull();
  });

  test("a GithubApiError propagates (a genuine failure still crashes the run)", async () => {
    const client = { listOrgMemberships: async () => { throw new GithubApiError("membership boom", { endpoint: "x" }); } } as unknown as GithubClient;
    await expect(resolveOwnersWithDiscovery(client, config, null)).rejects.toThrow(/membership boom/);
  });

  test("success resolves the discovered owners", async () => {
    const client = { listOrgMemberships: async () => ["org-a", "org-b"] } as unknown as GithubClient;
    const resolved = await resolveOwnersWithDiscovery(client, config, null);
    expect(resolved?.owners).toEqual(["org-a", "org-b"]);
    expect(resolved?.source).toBe("discovered");
  });

  test("an empty owner set still throws (fatal, NOT swallowed as a transient throttle)", async () => {
    // configured-but-empty: the throttle catch rethrows every non-ThrottleExhausted error, so
    // resolveEffectiveOwners' EmptyOwnersError must propagate — a regression that swallowed it
    // (returning null) would silently end the run with no remediation message.
    const emptyConfig = { ...(config as object), organizations: [] } as unknown as Config;
    const client = { listOrgMemberships: async () => [] } as unknown as GithubClient;
    await expect(resolveOwnersWithDiscovery(client, emptyConfig, null)).rejects.toThrow();
  });
});

describe("runScan owner-discovery throttle (§4, site a — consumer wiring)", () => {
  const noArgs: OrchestrateArgs = { configPath: null, plan: false, fresh: false, purgeCache: false, rescanBranches: [], help: false };

  test("a throttle during owner discovery ends cleanly WITHOUT starting a run (no phantom run row)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    // sweepStaleTempDirs runs first; owner discovery then throttles, so nothing else is reached.
    const client = {
      sweepStaleTempDirs: () => [],
      listOrgMemberships: async () => { throw new ThrottleExhausted("core bucket"); },
    } as unknown as GithubClient;
    await runScan(db, client, rt(config, "hash"), noArgs, null); // must not throw
    const runs = db.read("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    expect(runs.n).toBe(0); // startRun was never reached — no run, no report
    db.close();
  });
});

describe("clone-fallback readers fail closed (§5.C)", () => {
  const dummyEntry: TreeEntry = { path: "x", type: "blob", sha: "", size: 0 };

  test("cloneReader PROPAGATES a read failure (a dir at the blob path → EISDIR) instead of degrading to null", async () => {
    // A file the walk just enumerated from a completed clone is never a benign 404; a read failure
    // means the snapshot was not fully read. The old blanket catch returned null → under-report.
    const dir = mkdtempSync(join(tmpdir(), "clonereader-"));
    mkdirSync(join(dir, "notafile"));
    try {
      await expect(cloneReader(dir)("notafile", dummyEntry)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("cloneReader returns a real file's contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clonereader-"));
    writeFileSync(join(dir, "f.txt"), "hello");
    try {
      expect(await cloneReader(dir)("f.txt", dummyEntry)).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("cloneReader fails loud on a containment violation (never reads outside the clone dir)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clonereader-"));
    try {
      await expect(cloneReader(dir)("../escape", dummyEntry)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("walkClone PROPAGATES a readdir failure on an unreadable subdir instead of silently skipping it", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const root = mkdtempSync(join(tmpdir(), "walkclone-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "deep.txt"), "x");
    chmodSync(join(root, "sub"), 0o111); // execute-only: readdir(sub) throws EACCES
    try {
      expect(() => walkClone(root)).toThrow();
    } finally {
      chmodSync(join(root, "sub"), 0o755); // restore so rmSync can recurse
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("walkClone enumerates a normal tree (blobs only; skips .git)", () => {
    const root = mkdtempSync(join(tmpdir(), "walkclone-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "src", "b.txt"), "bb");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "ignored");
    try {
      expect(walkClone(root).map((e) => e.path).sort()).toEqual(["a.txt", "src/b.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("processRepo branch fan-out (P4: concurrency.branches > 1)", () => {
  const heads = (nodes: Array<{ name: string; oid: string; date: string }>): string =>
    `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ data: { repository: {
      defaultBranchRef: { name: "main" },
      refs: { pageInfo: { hasNextPage: false, endCursor: null },
        nodes: nodes.map((n) => ({ name: n.name, target: { oid: n.oid, committedDate: n.date, tree: { oid: hexOid(`t-${n.name}`) } } })) },
    } } })}`;
  const repo: RepoInfo = { name: "svc", organization: "org-a", pushedAt: "2025-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false };
  const startRun = (db: AuditDb): string =>
    db.startRun({ configHash: "h", effectiveOwners: ["org-a"], ownersSource: "configured", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" }).runId;
  const fanoutConfig = (root: string) => ({ ...testConfig(root, 25), concurrency: { organizations: 1, repositories: 1, branches: 4 } });
  const nodesN = (n: number) => Array.from({ length: n }, (_, i) => ({ name: i === 0 ? "main" : `b${i}`, oid: hexOid(`o${i}`), date: "2025-06-01T00:00:00Z" }));

  test("N branches scan concurrently (branches:4) — every unit lands exactly once, no lost/corrupted rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "fanout-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startRun(db);
    const nodes = nodesN(8); // 1 default + 7 non-default, all within the cap of 25
    const client = makeClient(root, async (_bin, args) =>
      args.some((a) => a === "graphql") ? { exitCode: 0, stderr: "", stdout: heads(nodes) } : { exitCode: 0, stderr: "", stdout: treeBody(args) });
    await captureJsonl(() => processRepo(db, client, rt(fanoutConfig(root), "h"), runId, "org-a", repo, [], new Set()));
    const rows = db.read(`SELECT branch, status FROM run_unit_head WHERE run_id = ? ORDER BY branch`).all(runId) as Array<{ branch: string; status: string }>;
    expect(rows.length).toBe(8); // exactly one row per branch — no dupes, none lost
    expect(rows.every((r) => r.status === "scanned")).toBe(true);
    for (const n of nodes) // work queue: each unit reached 'done' exactly once
      expect(db.getUnit({ configHash: "h", scope: "branch", organization: "org-a", repository: "svc", branch: n.name })?.status).toBe("done");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a fatal from ONE unit fails the repo and STOPS dispatching further units (fail-fast, branches:1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "fanout-fatal-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startRun(db);
    const nodes = nodesN(6); // plan.toScan order: main, b1, b2, b3, b4, b5
    // inject a write-time PolicyMatchError from exactly ONE unit's scanned upsert (b3)
    const injected = new PolicyMatchError("excludeBranches", "x*", "b3", new Error("simulated write-time attribution incoherence"));
    const realUpsert = db.upsertRunUnitHead.bind(db);
    (db as unknown as { upsertRunUnitHead: AuditDb["upsertRunUnitHead"] }).upsertRunUnitHead = (h) => {
      if (h.status === "scanned" && h.branch === "b3") throw injected;
      return realUpsert(h);
    };
    const client = makeClient(root, async (_bin, args) =>
      args.some((a) => a === "graphql") ? { exitCode: 0, stderr: "", stdout: heads(nodes) } : { exitCode: 0, stderr: "", stdout: treeBody(args) });
    // branches:1 makes dispatch strictly sequential, so the fail-fast is deterministic: units BEFORE b3
    // drain, b3 throws the fatal → trips the local Aborter → no unit AFTER b3 is ever dispatched.
    const seqConfig = { ...testConfig(root, 25), concurrency: { organizations: 1, repositories: 1, branches: 1 } };
    let thrown: unknown;
    await captureJsonl(async () => {
      try { await processRepo(db, client, rt(seqConfig, "h"), runId, "org-a", repo, [], new Set()); }
      catch (e) { thrown = e; }
    });
    expect(thrown).toBe(injected); // the fatal is rethrown (deterministic: first rejection in plan.toScan order)
    // At width 1 dispatch is strictly ordered, so the fatal at b3 (index 2 of plan.toScan) means exactly
    // the 2 units BEFORE it scanned and the fatal branch was dispatched — 3 work-queue units total. Every
    // unit AFTER b3 was never dispatched (the local Aborter stopped the pool), so it has NO work-queue row.
    // This is the fail-fast the old sequential loop had — NOT the settle-all-continue that scanned all 5.
    const scannedCount = (db.read(`SELECT COUNT(*) AS n FROM run_unit_head WHERE run_id = ? AND status = 'scanned'`).get(runId) as { n: number }).n;
    expect(scannedCount).toBe(2); // only the units before b3 drained — NOT all 5 siblings
    const dispatched = ["main", "b1", "b2", "b3", "b4", "b5"].filter(
      (br) => db.getUnit({ configHash: "h", scope: "branch", organization: "org-a", repository: "svc", branch: br }) !== null);
    expect(dispatched.length).toBe(3); // exactly the 2 scanned + the fatal b3; the other 3 were skipped (no row)
    expect(dispatched).toContain("b3"); // the fatal unit WAS dispatched (enqueued, then threw mid-scan)
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a branch fatal trips the RUN-level Aborter via onFatal PROMPTLY — WHILE a sibling branch is still in flight, before the pool drains (§7)", async () => {
    // The fix for the deferred "branch-abort promptness" finding. A post-drain onFatal (calling it only
    // AFTER the whole branch pool drained) would reproduce the exact defect yet still leave the run
    // Aborter tripped by the end — so an end-of-run assertion is too weak. We prove it fires MID-DRAIN:
    // branches:2 dispatches the fatal branch AND a sibling that BLOCKS on a gate, so the pool cannot
    // drain. onFatal signals only AFTER it trips the run Aborter, so when `fatalHandled` resolves the
    // sibling is STILL blocked (pool not drained) and yet the run Aborter is ALREADY tripped — impossible
    // for a post-drain onFatal. Then we release the gate and confirm settle-all (the blocked sibling
    // still drains) plus the fatal rethrow.
    const root = mkdtempSync(join(tmpdir(), "fanout-onfatal-prompt-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startRun(db);
    const nodes = [
      { name: "main", oid: hexOid("o-main"), date: "2025-06-01T00:00:00Z" }, // the fatal branch
      { name: "slow", oid: hexOid("o-slow"), date: "2025-06-01T00:00:00Z" }, // a gated sibling — holds the drain open
    ];
    const injected = new PolicyMatchError("excludeBranches", "x*", "main", new Error("write-time incoherence"));
    const realUpsert = db.upsertRunUnitHead.bind(db);
    (db as unknown as { upsertRunUnitHead: AuditDb["upsertRunUnitHead"] }).upsertRunUnitHead = (h) => {
      if (h.status === "scanned" && h.branch === "main") throw injected; // fatal from main's scanned upsert
      return realUpsert(h);
    };
    let releaseSlow!: () => void;
    const gateSlow = new Promise<void>((r) => { releaseSlow = r; });
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: heads(nodes) };
      if (args.join(" ").includes(hexOid("t-slow"))) await gateSlow; // the 'slow' branch scan blocks until released
      return { exitCode: 0, stderr: "", stdout: treeBody(args) };
    });
    const cfg = { ...testConfig(root, 25), concurrency: { organizations: 1, repositories: 1, branches: 2 } };
    const runAborter = new Aborter();
    let onFatalCalls = 0;
    let signalHandled!: () => void;
    const fatalHandled = new Promise<void>((r) => { signalHandled = r; });
    const onFatal = (): void => { onFatalCalls++; runAborter.abort(); signalHandled(); }; // trip BEFORE signalling
    let thrown: unknown = "unset";
    const p = captureJsonl(async () => {
      try { await processRepo(db, client, rt(cfg, "h"), runId, "org-a", repo, [], new Set(), new Set(), runAborter, onFatal); thrown = null; }
      catch (e) { thrown = e; }
    });
    await fatalHandled; // onFatal has run (main's fatal was caught); the 'slow' sibling is STILL blocked on gateSlow
    expect(onFatalCalls).toBe(1);
    expect(runAborter.aborted).toBe(true); // tripped WHILE the pool is blocked mid-drain — a post-drain onFatal cannot do this
    releaseSlow();  // release the in-flight sibling so the pool can drain (settle-all)
    await p;
    expect(thrown).toBe(injected); // the fatal is rethrown after the FULL drain
    // settle-all: the blocked sibling drained to a terminal state despite the abort
    expect(db.getUnit({ configHash: "h", scope: "branch", organization: "org-a", repository: "svc", branch: "slow" })?.status).toBe("done");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("processRepo DROPS its run-Aborter callback after each pool settles — no accumulation over a large estate", async () => {
    // Fix 5 end-to-end: each processRepo registers a branchAbort-trip on the run-level Aborter and must
    // unsubscribe it (the .finally) once its branch pool settles, so a run over thousands of repos does
    // not leave a callback per completed repo on the run Aborter. We drive many repos against ONE shared
    // run Aborter and assert its callback list returns to empty after each — a broken unsubscribe would
    // grow it unbounded. (White-box on the private `callbacks`, mirroring boundedPool.test.ts's tripwire.)
    const root = mkdtempSync(join(tmpdir(), "fanout-unsub-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startRun(db);
    const nodes = nodesN(1); // just the default branch (main) — a clean, fatal-free scan
    const client = makeClient(root, async (_bin, args) =>
      args.some((a) => a === "graphql") ? { exitCode: 0, stderr: "", stdout: heads(nodes) } : { exitCode: 0, stderr: "", stdout: treeBody(args) });
    const cfg = { ...testConfig(root, 25), concurrency: { organizations: 1, repositories: 1, branches: 2 } };
    const runAborter = new Aborter();
    const internal = runAborter as unknown as { callbacks: unknown[] };
    await captureJsonl(async () => {
      for (let i = 0; i < 25; i++) {
        // a DISTINCT repo each iteration (fresh scheduledRepoKeys per call), like a large estate
        await processRepo(db, client, rt(cfg, "h"), runId, "org-a", { ...repo, name: `svc${i}` }, [], new Set(), new Set(), runAborter);
        expect(internal.callbacks.length).toBe(0); // this repo unsubscribed once its pool settled
      }
    });
    expect(runAborter.aborted).toBe(false); // no fatal occurred; the Aborter was only ever registered on and unsubscribed from
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("runScan owner fan-out + drain lifecycle (P5: concurrency.organizations > 1, §7)", () => {
  const heads = `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ data: { repository: {
    defaultBranchRef: { name: "main" },
    refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: "main", target: { oid: hexOid("o-main"), committedDate: "2025-06-01T00:00:00Z", tree: { oid: hexOid("t-main") } } }] },
  } } })}`;
  // A repo listing OWNED BY the requested org (mapRestRepo enforces owner-scope), one branch (main),
  // an empty tree. Lets two owners fan out and both scan to zero findings.
  const multiOwnerClient = (root: string): GithubClient =>
    makeClient(root, async (_bin, args) => {
      const j = args.join(" ");
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: heads };
      if (j.includes("git/trees")) return { exitCode: 0, stderr: "", stdout: treeBody(args) };
      const owner = /orgs\/([^/?]+)\/repos/.exec(j)?.[1] ?? "org-a";
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify([{ name: "svc", owner: { login: decodeURIComponent(owner) }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false }])}` };
    });
  const noArgs: OrchestrateArgs = { configPath: null, plan: false, fresh: false, purgeCache: false, rescanBranches: [], help: false };
  const twoOwnerConfig = (root: string) => ({ ...testConfig(root, 25), organizations: ["org-a", "org-b"], concurrency: { organizations: 2, repositories: 2, branches: 1 } });
  const runStatus = (db: AuditDb): string | undefined => (db.read(`SELECT status FROM runs`).get() as { status: string } | null)?.status ?? undefined;
  const scannedOrgs = (db: AuditDb): string[] =>
    (db.read(`SELECT DISTINCT organization FROM run_unit_head WHERE status='scanned' ORDER BY organization`).all() as Array<{ organization: string }>).map((r) => r.organization);
  // Inject a fatal thrown from a specific owner's reconcileRunUnitHead — an escape point AFTER that
  // owner's branch already scanned, so both owners are provably DRAINED (their scanned rows written)
  // before the fatal is surfaced. Errors thrown there escape processRepo → processOwner → the owner
  // worker (which trips the run Aborter and rethrows) → the pool, exactly the fatal path §7 governs.
  const injectReconcile = (db: AuditDb, byOrg: Record<string, Error>): void => {
    const real = db.reconcileRunUnitHead.bind(db);
    (db as unknown as { reconcileRunUnitHead: AuditDb["reconcileRunUnitHead"] }).reconcileRunUnitHead = (runId, org, repo, branches) => {
      const e = byOrg[org];
      if (e !== undefined) throw e;
      return real(runId, org, repo, branches);
    };
  };
  const runToError = async (db: AuditDb, root: string): Promise<unknown> => {
    let thrown: unknown = null;
    await captureJsonl(async () => { thrown = await runScan(db, multiOwnerClient(root), rt(twoOwnerConfig(root), "h"), noArgs, null).then(() => null, (e: unknown) => e); });
    return thrown;
  };

  test("two owners fan out and BOTH scan (concurrency.organizations:2), run completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "owner-fanout-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await captureJsonl(() => runScan(db, multiOwnerClient(root), rt(twoOwnerConfig(root), "h"), noArgs, null));
    expect(scannedOrgs(db)).toEqual(["org-a", "org-b"]);
    expect(runStatus(db)).toBe("completed");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a PolicyMatchError escaping ONE owner FAILS the run — sibling owner fully DRAINED first (§7)", async () => {
    const root = mkdtempSync(join(tmpdir(), "owner-policy-fatal-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const injected = new PolicyMatchError("excludeBranches", "x*", "main", new Error("org-b incoherence"));
    injectReconcile(db, { "org-b": injected });
    const thrown = await runToError(db, root);
    expect(thrown).toBe(injected); // the ORIGINAL policy error, surfaced unchanged
    expect(runStatus(db)).toBe("failed"); // failRun ran — a config defect excludes the run from latest
    expect(scannedOrgs(db)).toEqual(["org-a", "org-b"]); // BOTH drained (org-b scanned before its reconcile threw)
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a GENERIC escape leaves the run RESUMABLE (no failRun) — sibling owner still drains", async () => {
    const root = mkdtempSync(join(tmpdir(), "owner-generic-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const generic = new Error("org-b reconcile boom (transient/infra)");
    injectReconcile(db, { "org-b": generic });
    const thrown = await runToError(db, root);
    expect(thrown).toBe(generic);
    expect(runStatus(db)).toBe("running"); // NO failRun — a non-policy escape stays resumable (§7)
    expect(scannedOrgs(db)).toEqual(["org-a", "org-b"]); // both drained
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("Trap 2: failRun is keyed on ANY collected PolicyMatchError even when a lower-index GENERIC error is surfaced", async () => {
    const root = mkdtempSync(join(tmpdir(), "owner-trap2-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const generic = new Error("org-a generic (lower owner index)");
    const policy = new PolicyMatchError("excludeBranches", "x*", "main", new Error("org-b policy"));
    injectReconcile(db, { "org-a": generic, "org-b": policy });
    const thrown = await runToError(db, root);
    expect(thrown).toBe(generic); // surfaced = FIRST rejection in owner order (org-a), deterministic
    expect(runStatus(db)).toBe("failed"); // but failRun STILL ran, because org-b's PolicyMatchError was collected
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("onFatal is WIRED through runScan → processOwner: a BRANCH fatal in one owner stops a sibling owner's dispatch while the fatal repo is still draining (§7)", async () => {
    // The end-to-end regression for the deferred "branch-abort promptness" finding through the PRODUCTION
    // path (not a direct processRepo call): a branch-worker fatal in org-a must trip the RUN Aborter
    // PROMPTLY via the onFatal runScan threads down, so a CONCURRENT sibling owner (org-b) skips its
    // SECOND repo instead of scanning it during org-a's drain. Deterministic via gates: org-a's fatal
    // branch (main) is fast while a sibling branch (slow) holds org-a's pool open (gateSlow, released
    // only AFTER we assert); org-b's first repo (r1) is gated so org-b reaches the r2 decision only after
    // org-a's fatal has already tripped the run Aborter. If runScan/processOwner did NOT forward onFatal,
    // the run Aborter would trip only in org-a's owner-catch — which cannot run until gateSlow releases —
    // so org-b would dispatch r2. We assert r2 has NO run_unit_head row.
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const root = mkdtempSync(join(tmpdir(), "owner-onfatal-wire-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const branchHeads = (branches: Array<{ name: string; tree: string }>): string =>
      `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ data: { repository: {
        defaultBranchRef: { name: "main" },
        refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: branches.map((b) => ({
          name: b.name, target: { oid: hexOid(`o-${b.name}`), committedDate: "2025-06-01T00:00:00Z", tree: { oid: hexOid(b.tree) } } })) },
      } } })}`;
    const repoList = (owner: string, names: string[]): string =>
      `HTTP/2.0 200 X\r\n\r\n${JSON.stringify(names.map((n) => ({ name: n, owner: { login: owner }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false })))}`;
    const injected = new PolicyMatchError("excludeBranches", "x*", "main", new Error("org-a write-time incoherence"));
    let signalFatal!: () => void;
    const fatalThrown = new Promise<void>((r) => { signalFatal = r; });
    const realUpsert = db.upsertRunUnitHead.bind(db);
    (db as unknown as { upsertRunUnitHead: AuditDb["upsertRunUnitHead"] }).upsertRunUnitHead = (h) => {
      if (h.status === "scanned" && h.organization === "org-a" && h.branch === "main") { signalFatal(); throw injected; }
      return realUpsert(h);
    };
    let releaseSlow!: () => void; const gateSlow = new Promise<void>((r) => { releaseSlow = r; });
    let releaseR1!: () => void;   const gateR1 = new Promise<void>((r) => { releaseR1 = r; });
    const client = makeClient(root, async (_bin, args) => {
      const j = args.join(" ");
      if (j.includes("orgs/org-a/repos")) return { exitCode: 0, stderr: "", stdout: repoList("org-a", ["svc"]) };
      if (j.includes("orgs/org-b/repos")) return { exitCode: 0, stderr: "", stdout: repoList("org-b", ["r1", "r2"]) };
      if (args.some((a) => a === "graphql")) {
        if (j.includes("owner=org-a")) return { exitCode: 0, stderr: "", stdout: branchHeads([{ name: "main", tree: "t-a-main" }, { name: "slow", tree: "t-a-slow" }]) };
        if (j.includes("name=r1")) return { exitCode: 0, stderr: "", stdout: branchHeads([{ name: "main", tree: "t-b-r1" }]) };
        return { exitCode: 0, stderr: "", stdout: branchHeads([{ name: "main", tree: "t-b-r2" }]) }; // name=r2
      }
      if (j.includes(hexOid("t-a-slow"))) await gateSlow; // org-a's 'slow' branch holds org-a's pool open
      if (j.includes(hexOid("t-b-r1"))) await gateR1;     // org-b's r1 scan blocks until released
      return { exitCode: 0, stderr: "", stdout: treeBody(args) };
    });
    const cfg = { ...testConfig(root, 25), organizations: ["org-a", "org-b"], concurrency: { organizations: 2, repositories: 2, branches: 2 } };
    let thrown: unknown = "unset";
    const p = captureJsonl(async () => {
      try { await runScan(db, client, rt(cfg, "h"), noArgs, null); thrown = null; }
      catch (e) { thrown = e; }
    });
    await fatalThrown;   // org-a's main fatal is imminent; org-a's 'slow' and org-b's r1 are both blocked
    releaseR1();         // let org-b's r1 finish; by the time it does, onFatal has already tripped the run Aborter
    // wait for org-b to finish r1 and reach the r2 decision, WITHOUT releasing org-a's drain (gateSlow held)
    for (let i = 0; i < 1000 && db.getUnit({ configHash: "h", scope: "branch", organization: "org-b", repository: "r1", branch: "main" })?.status !== "done"; i++) await tick();
    for (let i = 0; i < 20; i++) await tick(); // let org-b's post-r1 aborted-check settle (a non-forwarded onFatal would dispatch r2 here)
    releaseSlow();       // now let org-a's 'slow' drain so the run can finish (org-a's owner-catch abort is far too late)
    await p;
    expect(thrown).toBe(injected); // the run failed with org-a's fatal, surfaced unchanged
    expect(runStatus(db)).toBe("failed");
    // r1 (org-b's first repo) DID scan (settle-all: it was in flight when the abort fired) …
    expect(db.getUnit({ configHash: "h", scope: "branch", organization: "org-b", repository: "r1", branch: "main" })?.status).toBe("done");
    // … but r2 (org-b's SECOND repo) was SKIPPED — never dispatched, so no work-queue row exists for it.
    expect(db.getUnit({ configHash: "h", scope: "branch", organization: "org-b", repository: "r2", branch: "main" })).toBeNull();
    expect(db.read(`SELECT COUNT(*) AS n FROM run_unit_head WHERE organization='org-b' AND repository='r2'`).get()).toEqual({ n: 0 });
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
