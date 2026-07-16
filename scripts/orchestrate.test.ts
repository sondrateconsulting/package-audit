import { expect, test, describe, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCliTerms, discoverOwnerRepos, planSummaryText, processOwner, processRepo, reconcileIntrospection, resolveOwnersWithDiscovery, runPlan, runScan, runSummaryText, type AuditRuntime, type PlanTotals } from "./orchestrate.ts";
import { classifyBranchPlan } from "./branchPlanner.ts";
import { compileBranchPolicy, PolicyMatchError } from "./branchPolicy.ts";
import { GithubApiError, GithubClient, ThrottleExhausted, type BranchHead, type RepoInfo, type SpawnFn } from "./github.ts";
import { AuditDb, nowIso, type WorkUnitKey } from "./db.ts";
import type { Config } from "./config.ts";
import type { OrchestrateArgs } from "./args.ts";

const head = (name: string, committedDate: string): BranchHead => ({ name, oid: `oid-${name}`, committedDate, treeOid: `tree-${name}` });

// Build the AuditRuntime bundle from a Config — the branch policy is compiled from the config's own
// branch lists, so the default (`branches: null, excludeBranches: []`) is unrestricted and behaves
// exactly as before this feature. Tests exercising policy pass a config with populated lists.
const rt = (config: Config, configHash = "hash"): AuditRuntime => ({
  config,
  configHash,
  branchPolicy: compileBranchPolicy(config.branches, config.excludeBranches),
});

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

describe("classifyBranchPlan — the DEFAULT branch is always eligible (§5.B/CV2)", () => {
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
      { exitCode: 0, stderr: "", stdout: http(200, {}, JSON.stringify({ data: { repository: { refs: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          { name: "main", target: { oid: "o-main", committedDate: "2025-06-01T00:00:00Z", tree: { oid: "t1" } } },
          { name: "stale", target: { oid: "o-stale", committedDate: "2023-06-01T00:00:00Z", tree: { oid: "t2" } } },
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
      githubHost: "github.com", organizations: ["org-a"], excludeOrganizations: [], branches: null, excludeBranches: [], includePersonalNamespace: false,
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
  githubHost: "github.com", organizations: ["org-a"], excludeOrganizations: [], branches: null, excludeBranches: [], includePersonalNamespace: false,
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

describe("runPlan cache-less client guard (§8 --plan zero-write)", () => {
  test("rejects a caching (db-backed) client before any discovery call", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-guard-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    let spawns = 0;
    // WRONG client for plan mode: it would cache into the DB
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
    const repo: RepoInfo = { name: "svc", organization: "org-a", defaultBranch: "main", pushedAt: "2025-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false };

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
      kept = await discoverOwnerRepos(db, client, testConfig(root), runId, "org-a", false);
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
      const keptA = await discoverOwnerRepos(db, client, testConfig(root), runId, "org-a", false);
      const keptB = await discoverOwnerRepos(db, client, testConfig(root), runId, "org-b", false);
      expect(keptA).toEqual({ ok: false, reason: "failed" }); // permanent discovery failure
      expect(keptB.ok && keptB.items.map((r) => r.name)).toEqual(["svc"]); // archived repo filtered by config
    });
    expect(events.filter((e) => e["event"] === "discovery")).toHaveLength(1); // only org-a's failure
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
        return { exitCode: 0, stderr: "", stdout: http(200, "[]") };
      });

    const kept = await discoverOwnerRepos(db, client, testConfig(root), runId, "rvo", true);
    expect(kept).toEqual({ ok: true, items: [] }); // discovered, genuinely empty
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
          return { exitCode: 0, stderr: "", stdout: http(200, JSON.stringify({ data: { repository: { refs: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ name: "main", target: { oid: "o1", committedDate: "2025-06-01T00:00:00Z", tree: { oid: "t1" } } }],
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
  const graphqlHeads = (nodes: Array<{ name: string; oid: string; date: string }>): string =>
    `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ data: { repository: { refs: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: nodes.map((n) => ({ name: n.name, target: { oid: n.oid, committedDate: n.date, tree: { oid: `t-${n.name}` } } })),
    } } } })}`;

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
    db.setUnitStatus(key("main"), { status: "done", runId, lastCommitSha: "o-main", lastCommitDate: "2025-06-01T00:00:00Z" });
    db.enqueueUnit(key("dev"), runId);
    db.setUnitStatus(key("dev"), { status: "done", runId, lastCommitSha: "o-dev", lastCommitDate: "2025-05-01T00:00:00Z" });

    const client = // heads newest-first; cap=1 counts NON-default branches: main default-exempt
    // (current), dev fills the cap (current), feat past-cap, stale pre-cutoff
    makeClient(root, async () => ({ exitCode: 0, stderr: "", stdout: graphqlHeads([
        { name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" },
        { name: "dev", oid: "o-dev", date: "2025-05-01T00:00:00Z" },
        { name: "feat", oid: "o-feat", date: "2025-04-01T00:00:00Z" },
        { name: "stale", oid: "o-stale", date: "2023-06-01T00:00:00Z" },
      ]) }));
    const repo: RepoInfo = { name: "svc", organization: "org-a", defaultBranch: "main", pushedAt: "2025-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false };

    const events = await captureJsonl(async () => {
      await processRepo(db, client, rt(testConfig(root, 1), "h"), runId, "org-a", repo, [], new Set());
    });

    // run_unit_head: stale → skipped-cutoff (empty sha), main+dev → scanned at their live heads with
    // the REAL default-branch flag (1 for main, 0 otherwise), and feat → a NEW past-cap row (T6: a
    // past-cap branch is now recorded for report visibility, though its work queue stays untouched).
    const headRows = db.read(`SELECT branch, commit_sha, status, is_default_branch FROM run_unit_head WHERE run_id = ? ORDER BY branch`).all(runId) as Array<Record<string, unknown>>;
    expect(headRows).toEqual([
      { branch: "dev", commit_sha: "o-dev", status: "scanned", is_default_branch: 0 },
      { branch: "feat", commit_sha: "", status: "past-cap", is_default_branch: 0 },
      { branch: "main", commit_sha: "o-main", status: "scanned", is_default_branch: 1 },
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
          { name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" },
          { name: "dev", oid: "o-dev", date: "2025-05-01T00:00:00Z" },
        ]) };
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ truncated: false, tree: [] })}` };
    });
    const repo: RepoInfo = { name: "svc", organization: "org-a", defaultBranch: "main", pushedAt: "2025-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false };

    await captureJsonl(async () => {
      await processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set());
    });

    const headRows = db.read(`SELECT branch, commit_sha, status, is_default_branch FROM run_unit_head WHERE run_id = ? ORDER BY branch`).all(runId) as Array<Record<string, unknown>>;
    expect(headRows).toEqual([
      { branch: "dev", commit_sha: "o-dev", status: "scanned", is_default_branch: 0 },
      { branch: "main", commit_sha: "o-main", status: "scanned", is_default_branch: 1 },
    ]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("processRepo / runScan — branch allow/deny wiring (T6)", () => {
  const graphqlHeads = (nodes: Array<{ name: string; oid: string; date: string }>): string =>
    `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ data: { repository: { refs: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: nodes.map((n) => ({ name: n.name, target: { oid: n.oid, committedDate: n.date, tree: { oid: `t-${n.name}` } } })),
    } } } })}`;
  // heads via GraphQL, an EMPTY tree via REST so a scanned unit runs the pipeline to zero findings.
  const scanClient = (root: string, nodes: Array<{ name: string; oid: string; date: string }>): GithubClient =>
    makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads(nodes) };
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ truncated: false, tree: [] })}` };
    });
  const repo: RepoInfo = { name: "svc", organization: "org-a", defaultBranch: "main", pushedAt: "2025-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false };
  const startScanRun = (db: AuditDb): string =>
    db.startRun({ configHash: "h", effectiveOwners: ["org-a"], ownersSource: "configured", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" }).runId;
  const headRowsOf = (db: AuditDb, runId: string) =>
    db.read(`SELECT branch, status, commit_sha AS sha, is_default_branch AS d, policy_status AS ps, policy_matched_pattern AS pat, scanned_commit_date AS scd FROM run_unit_head WHERE run_id = ? ORDER BY branch`).all(runId);
  const key = (branch: string): WorkUnitKey => ({ configHash: "h", scope: "branch", organization: "org-a", repository: "svc", branch });
  const throwingGlob = (thrown: unknown): Bun.Glob => ({ match() { throw thrown; } }) as unknown as Bun.Glob;
  const badGlobError = new Error("bad glob"); // the exact injected cause — used to prove identity on rethrow
  const throwingPolicy = { include: null, exclude: [{ pattern: "boom*", glob: throwingGlob(badGlobError) }] };

  test("a denied NON-default branch persists as skipped-cutoff + policy attribution, and is never scanned", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-deny-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    const config = { ...testConfig(root, 25), excludeBranches: ["dev"] };
    const client = scanClient(root, [
      { name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" },
      { name: "dev", oid: "o-dev", date: "2025-05-01T00:00:00Z" },
    ]);
    await captureJsonl(() => processRepo(db, client, rt(config, "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId)).toEqual([
      { branch: "dev", status: "skipped-cutoff", sha: "", d: 0, ps: "excluded-by-deny", pat: "dev", scd: "2025-05-01T00:00:00Z" },
      { branch: "main", status: "scanned", sha: "o-main", d: 1, ps: null, pat: null, scd: "2025-06-01T00:00:00Z" },
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
    const client = scanClient(root, [{ name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" }]);
    await captureJsonl(() => processRepo(db, client, rt(config, "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId)).toEqual([
      { branch: "main", status: "scanned", sha: "o-main", d: 1, ps: "excluded-by-deny", pat: "main", scd: "2025-06-01T00:00:00Z" },
    ]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("processRepo propagates a PolicyMatchError — NOT swallowed by the fail-soft discovery catch", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-throw-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    const client = scanClient(root, [{ name: "dev", oid: "o-dev", date: "2025-05-01T00:00:00Z" }]);
    const runtime: AuditRuntime = { config: testConfig(root, 25), configHash: "h", branchPolicy: throwingPolicy };
    await expect(processRepo(db, client, runtime, runId, "org-a", repo, [], new Set())).rejects.toThrow(PolicyMatchError);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("runScan marks the run FAILED on a PolicyMatchError and rethrows the original", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-failrun-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    // packages:[] so discoverCliTerms is a no-op (no registry fetch); the planner throws mid-run.
    const config = { ...testConfig(root, 25), organizations: ["org-a"], packages: [] };
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([{ name: "dev", oid: "o-dev", date: "2025-05-01T00:00:00Z" }]) };
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify([{ name: "svc", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false }])}` };
    });
    const noArgs: OrchestrateArgs = { configPath: null, plan: false, fresh: false, purgeCache: false, rescanBranches: [], help: false };
    const runtime: AuditRuntime = { config, configHash: "h", branchPolicy: throwingPolicy };
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

  test("an allow-list MISS persists as excluded-by-allow with a NULL pattern", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-allow-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    const config = { ...testConfig(root, 25), branches: ["main"] }; // allowlist: only main (+ the default)
    const client = scanClient(root, [
      { name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" },
      { name: "feat", oid: "o-feat", date: "2025-05-01T00:00:00Z" }, // not allowlisted → excluded-by-allow
    ]);
    await captureJsonl(() => processRepo(db, client, rt(config, "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId)).toEqual([
      { branch: "feat", status: "skipped-cutoff", sha: "", d: 0, ps: "excluded-by-allow", pat: null, scd: "2025-05-01T00:00:00Z" },
      { branch: "main", status: "scanned", sha: "o-main", d: 1, ps: null, pat: null, scd: "2025-06-01T00:00:00Z" },
    ]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a past-cap branch keeps its prior 'done' work-queue state (reusable on a later cap-order promotion)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pastcap-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    db.enqueueUnit(key("feat"), runId); // a prior run scanned feat to done@o-feat
    db.setUnitStatus(key("feat"), { status: "done", runId, lastCommitSha: "o-feat", lastCommitDate: "2025-04-01T00:00:00Z" });
    const client = scanClient(root, [ // cap=1: main default-exempt, dev fills the slot, feat past-cap
      { name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" },
      { name: "dev", oid: "o-dev", date: "2025-05-01T00:00:00Z" },
      { name: "feat", oid: "o-feat", date: "2025-04-01T00:00:00Z" },
    ]);
    await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 1), "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId).find((r) => (r as { branch: string }).branch === "feat")).toMatchObject({ status: "past-cap", sha: "", ps: null });
    const featUnit = db.getUnit(key("feat")); // work queue UNTOUCHED — the prior done scan survives
    expect(featUnit?.status).toBe("done");
    expect(featUnit?.lastCommitSha).toBe("o-feat");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("clone-fallback with a MOVED branch: both run_unit_head AND work_queue pin the clone HEAD's sha+date (P0)", async () => {
    const root = mkdtempSync(join(tmpdir(), "clone-move-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    // discovery: main@o-main dated 2025-06-01. The tree is TRUNCATED → clone fallback, and the clone
    // HEAD has MOVED to o-moved dated 2025-06-15 (branch advanced between discovery and the clone).
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([{ name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" }]) };
      if (args[0] === "clone") { const dest = args[args.length - 1]!; mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, "package.json"), "{}"); return { exitCode: 0, stderr: "", stdout: "" }; }
      if (args[0] === "rev-parse") return { exitCode: 0, stderr: "", stdout: "o-moved\n" };
      if (args[0] === "show") return { exitCode: 0, stderr: "", stdout: "2025-06-15T09:00:00+00:00\n" };
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ truncated: true, tree: [] })}` }; // REST tree → truncated
    });
    await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
    // the durable row pins the SCANNED (clone) commit + its OWN date — never the stale discovered date
    expect(headRowsOf(db, runId)).toEqual([
      { branch: "main", status: "scanned", sha: "o-moved", d: 1, ps: null, pat: null, scd: "2025-06-15T09:00:00+00:00" },
    ]);
    const unit = db.getUnit(key("main")); // the work-queue pair matches (the P0 fix: no stale date)
    expect(unit?.lastCommitSha).toBe("o-moved");
    expect(unit?.lastCommitDate).toBe("2025-06-15T09:00:00+00:00");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("runPlan uses the SAME shared planner — a denied branch counts as excludedByPolicy, not eligible", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-policy-"));
    const config = { ...testConfig(root, 25), organizations: ["org-a"], excludeBranches: ["dev"], packages: [] };
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([
        { name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" },
        { name: "dev", oid: "o-dev", date: "2025-05-01T00:00:00Z" },
      ]) };
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

  test("§5 plan diagnostics: deny/allow sub-counts + default override, over all four dispositions", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-diag-"));
    // allowlist keep/* + deny deny-me, cap=1. main (default) is NOT in the allowlist → a scanned
    // default-branch OVERRIDE. deny-me → excluded-by-deny; other → excluded-by-allow. keep/a wins the
    // single cap slot; keep/b past-cap; keep/old (< cutoff) cutoff-skipped. Six heads, all four buckets.
    const config = { ...testConfig(root, 1), organizations: ["org-a"], branches: ["keep/*"], excludeBranches: ["deny-me"], packages: [] };
    const client = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([
        { name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" },      // default → override (not allow-listed)
        { name: "deny-me", oid: "o-deny", date: "2025-06-01T00:00:00Z" },   // excluded-by-deny
        { name: "other", oid: "o-other", date: "2025-06-01T00:00:00Z" },    // excluded-by-allow (allow-list miss)
        { name: "keep/a", oid: "o-ka", date: "2025-05-01T00:00:00Z" },      // eligible (wins cap=1)
        { name: "keep/b", oid: "o-kb", date: "2025-04-01T00:00:00Z" },      // past-cap
        { name: "keep/old", oid: "o-kold", date: "2023-01-01T00:00:00Z" },  // cutoff-skipped (< 2024-01-01)
      ]) };
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
    // the §5 diagnostic overlays
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

  // ---- §8 policy warnings (T7) ----
  // A client serving one org repo (svc) + the given branch heads + an empty tree (so a scanned unit
  // runs to zero findings). Distinguishes the GraphQL head query, the git-trees fetch, and the repo list.
  const fullClient = (root: string, heads: Array<{ name: string; oid: string; date: string }>): GithubClient =>
    makeClient(root, async (_bin, args) => {
      const j = args.join(" ");
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads(heads) };
      if (j.includes("git/trees")) return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ truncated: false, tree: [] })}` };
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify([{ name: "svc", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false }])}` };
    });
  const noArgsT7: OrchestrateArgs = { configPath: null, plan: false, fresh: false, purgeCache: false, rescanBranches: [], help: false };
  const policyWarnEvents = (events: Array<Record<string, unknown>>) => events.filter((e) => e["event"] === "policy-warning");

  test("runPlan emits an unmatched-pattern warning (before plan-summary) for a deny pattern that matched no branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "warn-plan-"));
    const config = { ...testConfig(root, 25), organizations: ["org-a"], excludeBranches: ["release/*"], packages: [] };
    const events = await captureJsonl(async () => { await runPlan(fullClient(root, [{ name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" }]), rt(config, "h"), "rvo"); });
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
    const events = await captureJsonl(async () => { await runPlan(fullClient(root, []), rt(config, "h"), "rvo"); }); // discovered, empty
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
    const events = await captureJsonl(async () => { await runPlan(fullClient(root, [{ name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" }]), rt(config, "h"), "rvo"); });
    const emptyAllow = events.filter((e) => e["event"] === "policy-warning" && e["kind"] === "empty-allowlist");
    expect(emptyAllow).toEqual([{ event: "policy-warning", kind: "empty-allowlist" }]); // once (at entry), never re-emitted at finalize
    rmSync(root, { recursive: true, force: true });
  });

  test("the SAME pattern in allow AND deny yields TWO direction-specific warnings end-to-end", async () => {
    const root = mkdtempSync(join(tmpdir(), "warn-both-"));
    const config = { ...testConfig(root, 25), organizations: ["org-a"], branches: ["shared"], excludeBranches: ["shared"], packages: [] };
    // only 'main' (default) is discovered — 'shared' matches nothing in either list
    const events = await captureJsonl(async () => { await runPlan(fullClient(root, [{ name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" }]), rt(config, "h"), "rvo"); });
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
    const runtime: AuditRuntime = { config, configHash: "h", branchPolicy: { include: null, exclude: [{ pattern: "main", glob: new Bun.Glob("main") }, { pattern: "z*", glob: throwingGlob(badError) }] } };
    let thrown: unknown = null;
    await captureJsonl(async () => { thrown = await runScan(db, fullClient(root, [{ name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" }]), runtime, noArgsT7, null).then(() => null, (e: unknown) => e); });
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
    const heads = [{ name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" }];
    const planEvents = await captureJsonl(async () => { await runPlan(fullClient(root, heads), rt(config, "h"), "rvo"); });
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runEvents = await captureJsonl(async () => { await runScan(db, fullClient(root, heads), rt(config, "h"), noArgsT7, null); });
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
    const events = await captureJsonl(async () => { await runScan(db, fullClient(root, []), rt(config, "h"), noArgsT7, null); });
    expect(policyWarnEvents(events)).toEqual([{ event: "policy-warning", kind: "unmatched-pattern", direction: "deny", pattern: "release/*" }]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  // ---- §11 stale-row reconciliation ----
  const staleHead = (db: AuditDb, runId: string, branch: string, over: Partial<Parameters<AuditDb["upsertRunUnitHead"]>[0]> = {}): void =>
    db.upsertRunUnitHead({ runId, organization: "org-a", repository: "svc", branch, commitSha: "", status: "skipped-cutoff", isDefaultBranch: false, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T00:00:00Z", ...over });

  test("§11: a resumed repo prunes rows for branches deleted since a prior invocation, and logs it once", async () => {
    const root = mkdtempSync(join(tmpdir(), "recon-prune-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    staleHead(db, runId, "deleted"); // a prior invocation recorded it; this discovery no longer sees it
    const client = scanClient(root, [{ name: "main", oid: "o-main", date: "2025-06-01T00:00:00Z" }]);
    const events = await captureJsonl(() => processRepo(db, client, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId).map((r) => (r as { branch: string }).branch)).toEqual(["main"]); // 'deleted' pruned
    expect(events.filter((e) => e["event"] === "reconciliation")).toEqual([
      { event: "reconciliation", target: "run_unit_head", runId, org: "org-a", repo: "svc", action: "prune-stale", pruned: 1 },
    ]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("§11: a FAILED branch discovery skips reconciliation — prior rows are RETAINED (transient failure != deletion)", async () => {
    const root = mkdtempSync(join(tmpdir(), "recon-fail-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    staleHead(db, runId, "ghost");
    const failClient = makeClient(root, async (_bin, args) =>
      args.some((a) => a === "graphql") ? { exitCode: 1, stderr: "gh: boom", stdout: "" } : { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ truncated: false, tree: [] })}` });
    const events = await captureJsonl(() => processRepo(db, failClient, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
    expect(headRowsOf(db, runId).map((r) => (r as { branch: string }).branch)).toEqual(["ghost"]); // retained, NOT pruned
    expect(events.some((e) => e["event"] === "reconciliation")).toBe(false); // no prune ran
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("§11: a still-live branch whose scan FAILS keeps its prior row (keep-set is live NAMES, not rows written)", async () => {
    const root = mkdtempSync(join(tmpdir(), "recon-scanfail-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = startScanRun(db);
    staleHead(db, runId, "main", { commitSha: "old-sha", status: "scanned", isDefaultBranch: true, scannedCommitDate: "2025-05-01T00:00:00Z" });
    // re-discovers main at a NEW commit, but the tree fetch (scan) FAILS → no new row written this attempt
    const scanFailClient = makeClient(root, async (_bin, args) => {
      if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads([{ name: "main", oid: "new-sha", date: "2025-06-01T00:00:00Z" }]) };
      if (args.some((a) => a.includes("git/trees"))) return { exitCode: 1, stderr: "gh: tree boom", stdout: "" };
      return { exitCode: 0, stderr: "", stdout: "HTTP/2.0 200 X\r\n\r\n[]" };
    });
    await captureJsonl(() => processRepo(db, scanFailClient, rt(testConfig(root, 25), "h"), runId, "org-a", repo, [], new Set()));
    // main is in the live keep-set → NOT pruned; its PRIOR row survives (the failed scan wrote no replacement)
    expect(headRowsOf(db, runId).find((r) => (r as { branch: string }).branch === "main")).toMatchObject({ branch: "main", status: "scanned", sha: "old-sha" });
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

  // a full PlanTotals with all-zero §5 diagnostics; spread + override per test
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

  test("§5 policy detail line: shown with the deny/allow split + override count when policy removed branches", () => {
    const text = planSummaryText(config, { ...totals, branchesExcludedByPolicy: 3, excludedByDeny: 2, excludedByAllow: 1, defaultBranchPolicyOverrides: 1 });
    expect(text).toContain("Policy detail:        2 excluded by deny · 1 excluded as not allow-listed · 1 default-branch policy override(s) (already counted as eligible)");
  });

  test("§5 policy detail line: shown for an override-only plan (no exclusions, but a policy would have excluded the default)", () => {
    const text = planSummaryText(config, { ...totals, defaultBranchPolicyOverrides: 2 });
    expect(text).toContain("0 excluded by deny · 0 excluded as not allow-listed · 2 default-branch policy override(s)");
  });

  test("§5 policy detail line: SUPPRESSED when no policy activity (no exclusions, no overrides)", () => {
    const text = planSummaryText(config, totals); // all §5 diagnostics zero
    expect(text).not.toContain("Policy detail:");
  });
});

// ---- §4 throttle-requeue policy (sites a-d: owner discovery, repo discovery, branch ----------
// ---- discovery, per-unit scan) ----------------------------------------------------------------

const repo: RepoInfo = {
  name: "r", organization: "o", defaultBranch: "main",
  pushedAt: "2026-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false,
};
const liveHead: BranchHead = {
  name: "main", oid: "a".repeat(40), committedDate: "2026-01-01T00:00:00Z", treeOid: "b".repeat(40),
};
// frozen: these 9 tests share one config; freezing forbids accidental cross-test mutation.
const config = Object.freeze({
  cutoffDate: "2000-01-01", maxBranchesPerRepo: 10, maxReposPerOrg: 10,
  includeArchived: true, includeForks: true, includePersonalNamespace: false,
  organizations: null, excludeOrganizations: [],
}) as unknown as Config;
const KEY: WorkUnitKey = { configHash: "hash", scope: "branch", organization: "o", repository: "r", branch: "main" };

// only the methods each function touches before the injected failure fires.
const fakeClient = (failure: Error): GithubClient =>
  ({
    listBranchHeads: async () => [liveHead],
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
      listBranchHeads: async () => [liveHead],
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
      listBranchHeads: async () => [liveHead],
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
      listBranchHeads: async () => [liveHead],
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
      listBranchHeads: async () => [liveHead],
      fetchTreeRecursive: async () => ({ truncated: false, paths: [{ path: "package.json", type: "blob", sha: "c".repeat(40), size: 20 }] }),
      fetchFileRaw: async () => { throw new GithubApiError("HTTP 404 (repos/o/r/contents/package.json)", { status: 404 }); },
    } as unknown as GithubClient;
    await processRepo(db, client, rt(scanConfig, "hash"), runId, "o", repo, [], new Set());
    expect(db.getUnit(KEY)?.status).toBe("done");
    expect(db.read("SELECT message FROM errors").all().length).toBe(0);
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
