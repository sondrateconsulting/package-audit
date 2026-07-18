// policyIntegration.test.ts — the branch allow/deny END-TO-END seam. Everything else tests one
// layer; this proves the layers COMPOSE. Two scenarios:
//   1. The policy classification seam: `runScan` (the real scan path, scripted GitHub client, empty
//      trees so scanned units run to zero findings) → the persisted run_unit_head dispositions →
//      buildReport (summary + scanScope) → exportRun (run_unit_head table) → buildCompare (policyChurn).
//      packages:[] keeps discoverCliTerms a no-op (no registry fetch) — the FEATURE under test is
//      branch policy, whose disposition rows are package-independent; finding EXTRACTION is covered by
//      unitPipeline/usageScanner tests and by scenario 2.
//   2. The read-model regression pin: a branch scanned in run A that becomes policy-excluded in run B
//      must NOT leak its stale findings into run B's report/export (the findings joins go through run
//      B's run_unit_head on status='scanned' + matching commit). A synthetic POISON row at commit_sha=''
//      makes the status='scanned' predicate load-bearing: drop it and the poison leaks. Direct-seeded
//      by design (the read-model join, not upsert*Finding, is what's under test here).
import { expect, test, describe, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditDb, nowIso, type RunRecord } from "./db.ts";
import { GithubClient, type SpawnFn } from "./github.ts";
import { runScan, type AuditRuntime } from "./orchestrate.ts";
import { compileBranchPolicy } from "./branchPolicy.ts";
import { compileRepositoryPolicy } from "./repositoryPolicy.ts";
import { buildReport } from "./report.ts";
import { exportRun } from "./export.ts";
import { buildCompare } from "./compare.ts";
import type { OrchestrateArgs } from "./args.ts";
import type { Config } from "./config.ts";

const NO_ARGS: OrchestrateArgs = { configPath: null, plan: false, fresh: false, purgeCache: false, rescanBranches: [], help: false };

// A full Config, policy fields overridable per scenario. packages default []: no registry fetch.
const mkConfig = (root: string, over: Partial<Config> = {}): Config => ({
  githubHost: "github.com", organizations: ["org-a"], excludeOrganizations: [],
  branches: null, excludeBranches: [], excludeRepositories: [], includePersonalNamespace: false, includeForks: false, includeArchived: false,
  maxReposPerOrg: null, maxBranchesPerRepo: 25, cutoffDate: "2024-01-01",
  concurrency: { organizations: 1, repositories: 1, branches: 1 },
  packages: [], excludeDirGlobs: [],
  paths: { sqlitePath: ":memory:", outputDir: root },
  ...over,
});

const rt = (config: Config, configHash: string): AuditRuntime =>
  ({ config, configHash, branchPolicy: compileBranchPolicy(config.branches, config.excludeBranches), repositoryPolicy: compileRepositoryPolicy(config.excludeRepositories) });

// One org repo `svc` (default main) + GraphQL heads + EMPTY trees; any git spawn is a failure (pins the
// no-clone assumption — a non-truncated tree never triggers cloneShallow).
interface Head { name: string; oid: string; date: string }
// The default branch is stated EXPLICITLY (never inferred from the head list): §5.B discovery resolves
// it from THIS response, so a fixture that derived it from its own heads could never disagree with the
// code and would hide a default-resolution defect.
const graphqlHeads = (nodes: Head[], defaultBranch: string | null): string =>
  `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ data: { repository: {
    defaultBranchRef: defaultBranch === null ? null : { name: defaultBranch },
    refs: {
      pageInfo: { hasNextPage: false, endCursor: null },
      // tree oid = the commit oid reversed: still 40-hex (§5.B requires hex ids), distinct from the commit
      nodes: nodes.map((n) => ({ name: n.name, target: { oid: n.oid, committedDate: n.date, tree: { oid: [...n.oid].reverse().join("") } } })),
    },
  } } })}`;
// NOTE the REST listing still carries default_branch — the shape is real, the auditor just ignores it.
const repoList = `HTTP/2.0 200 X\r\n\r\n${JSON.stringify([{ name: "svc", owner: { login: "org-a" }, default_branch: "main", pushed_at: "2025-01-01T00:00:00Z", archived: false, fork: false, private: false }])}`;

function scanClient(root: string, heads: Head[], defaultBranch: string | null): GithubClient {
  const spawn: SpawnFn = async (bin, args) => {
    if (bin.endsWith("/git")) throw new Error(`unexpected git spawn (${args.join(" ")}) — non-truncated trees must never clone`);
    if (args.some((a) => a === "graphql")) return { exitCode: 0, stderr: "", stdout: graphqlHeads(heads, defaultBranch) };
    if (args.some((a) => a.includes("git/trees"))) {
      // §5.C envelope: echo the requested oid as the root sha (fetchTreeRecursive verifies it)
      const ep = args.find((a) => a.includes("/git/trees/")) ?? "";
      const sha = decodeURIComponent(ep.split("/git/trees/")[1]?.split("?")[0] ?? "");
      return { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 X\r\n\r\n${JSON.stringify({ sha, truncated: false, tree: [] })}` };
    }
    return { exitCode: 0, stderr: "", stdout: repoList };
  };
  return new GithubClient({
    githubHost: "github.com", db: null, spawnImpl: spawn, sleepImpl: async () => {},
    env: { PATH: "/bin" }, binPaths: { gh: "/opt/bin/gh", git: "/opt/bin/git", tar: "/opt/bin/tar" }, tempRoot: root,
  });
}

// Capture stdout JSONL emitted during fn (runScan's run/done events, exportRun's export events).
// fn may be async (runScan) or sync (exportRun); `await` handles both.
async function captureJsonl(fn: () => unknown): Promise<Array<Record<string, unknown>>> {
  const chunks: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write);
  try { await fn(); } finally { spy.mockRestore(); }
  return chunks.join("").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
}
const runIdOf = (events: Array<Record<string, unknown>>): string => {
  const ev = events.find((e) => e["event"] === "run");
  if (ev === undefined) throw new Error("no run event emitted");
  return ev["runId"] as string;
};
const headRows = (db: AuditDb, runId: string): Array<Record<string, unknown>> =>
  db.read(`SELECT branch, status, commit_sha AS sha, is_default_branch AS d, policy_status AS ps, policy_matched_pattern AS pat FROM run_unit_head WHERE run_id = ? ORDER BY branch`).all(runId) as Array<Record<string, unknown>>;

describe("branch allow/deny — end-to-end policy classification seam", () => {
  // Six heads, newest-first (as listBranchHeads supplies). allow-list keep/scan {feature/x, overflow,
  // ancient} + default main; cap=1 non-default. feature/x newer than overflow → wins the cap in run A.
  const HEADS: Head[] = [
    { name: "main", oid: "aaaa000000000000000000000000000000000001", date: "2025-06-01T00:00:00Z" },
    { name: "feature/x", oid: "aaaa000000000000000000000000000000000002", date: "2025-05-01T00:00:00Z" },
    { name: "overflow", oid: "aaaa000000000000000000000000000000000003", date: "2025-04-01T00:00:00Z" },
    { name: "deny-me", oid: "aaaa000000000000000000000000000000000004", date: "2025-03-01T00:00:00Z" },
    { name: "other", oid: "aaaa000000000000000000000000000000000005", date: "2025-02-01T00:00:00Z" },
    { name: "ancient", oid: "aaaa000000000000000000000000000000000006", date: "2023-01-01T00:00:00Z" }, // < cutoff
  ];
  const ALLOW = ["feature/x", "overflow", "ancient"];

  test("config → runScan → run_unit_head → report/export/compare all agree on the policy dispositions", async () => {
    const root = mkdtempSync(join(tmpdir(), "t10-seam-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    try {
      // ---- Run A: deny [deny-me] ----
      const cfgA = mkConfig(root, { branches: ALLOW, excludeBranches: ["deny-me"], maxBranchesPerRepo: 1 });
      const evA = await captureJsonl(() => runScan(db, scanClient(root, HEADS, "main"), rt(cfgA, "hashA"), NO_ARGS, null));
      const runIdA = runIdOf(evA);

      // the persisted disposition snapshot — the single source both report and export read
      expect(headRows(db, runIdA)).toEqual([
        { branch: "ancient", status: "skipped-cutoff", sha: "", d: 0, ps: null, pat: null },       // genuine cutoff (allow-listed but pre-cutoff)
        { branch: "deny-me", status: "policy-excluded", sha: "", d: 0, ps: "excluded-by-deny", pat: "deny-me" },
        { branch: "feature/x", status: "scanned", sha: HEADS[1]!.oid, d: 0, ps: null, pat: null },  // wins cap=1
        { branch: "main", status: "scanned", sha: HEADS[0]!.oid, d: 1, ps: "excluded-by-allow", pat: null }, // default override
        { branch: "other", status: "policy-excluded", sha: "", d: 0, ps: "excluded-by-allow", pat: null },    // allow-list miss
        { branch: "overflow", status: "past-cap", sha: "", d: 0, ps: null, pat: null },
      ]);

      const runA = db.getRun(runIdA)!;
      const reportA = buildReport(db, runA) as any;
      expect(reportA.summary).toMatchObject({ branchesScanned: 2, branchesSkippedByCutoff: 1, branchesExcludedByPolicy: 2, branchesPastCap: 1 });
      expect(reportA.scanScope).toMatchObject({ excludedByDeny: 1, excludedByAllow: 1, defaultBranchPolicyOverrides: 1, provenance: "complete" });
      // the four disposition buckets partition every discovered head
      const s = reportA.summary;
      expect(s.branchesScanned + s.branchesSkippedByCutoff + s.branchesExcludedByPolicy + s.branchesPastCap).toBe(6);
      // the emitted report file (written to outputDir by runScan) equals a fresh buildReport
      const emittedA = JSON.parse(readFileSync(join(root, `run-${runIdA}.json`), "utf8"));
      expect(emittedA).toEqual(JSON.parse(JSON.stringify(reportA)));

      // export carries every disposition with its policy attribution (run-scoped, all statuses)
      const exportEvents = await captureJsonl(() => exportRun(db, runA, root, { raw: false }));
      expect(exportEvents.some((e) => e["event"] === "export" && e["table"] === "run_unit_head")).toBe(true);
      const ruhJsonl = readFileSync(join(root, "xray", "run_unit_head.jsonl"), "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
      const byBranch = Object.fromEntries(ruhJsonl.map((r: any) => [r.branch, { status: r.status, ps: r.policy_status, pat: r.policy_matched_pattern }]));
      expect(byBranch["feature/x"]).toEqual({ status: "scanned", ps: null, pat: null });
      expect(byBranch["deny-me"]).toEqual({ status: "policy-excluded", ps: "excluded-by-deny", pat: "deny-me" });
      expect(byBranch["main"]).toEqual({ status: "scanned", ps: "excluded-by-allow", pat: null });

      // ---- Run B: additionally deny [feature/x] — overflow is PROMOTED into the freed cap slot ----
      const cfgB = mkConfig(root, { branches: ALLOW, excludeBranches: ["deny-me", "feature/x"], maxBranchesPerRepo: 1 });
      const evB = await captureJsonl(() => runScan(db, scanClient(root, HEADS, "main"), rt(cfgB, "hashB"), NO_ARGS, null));
      const runIdB = runIdOf(evB);
      const rowsB = Object.fromEntries(headRows(db, runIdB).map((r) => [r["branch"], r]));
      expect(rowsB["feature/x"]).toMatchObject({ status: "policy-excluded", sha: "", ps: "excluded-by-deny", pat: "feature/x" });
      expect(rowsB["overflow"]).toMatchObject({ status: "scanned", sha: HEADS[2]!.oid, ps: null }); // promoted
      const reportB = buildReport(db, db.getRun(runIdB)!) as any;
      expect(reportB.summary).toMatchObject({ branchesScanned: 2, branchesSkippedByCutoff: 1, branchesExcludedByPolicy: 3, branchesPastCap: 0 });

      // ---- Compare A→B: exactly one branch ENTERED exclusion (feature/x); overflow's promotion is NOT churn ----
      const churn = buildCompare(db, runA, db.getRun(runIdB)!).compare.policyChurn;
      if (churn.available !== true) throw new Error("policyChurn should be available (all rows carry a scanned_commit_date)");
      expect(churn.summary).toMatchObject({ enteredExclusion: 1, leftExclusion: 0, reclassifiedExclusion: 0, defaultOverrideChanges: 0, branchesOnlyInRunA: 0, branchesOnlyInRunB: 0 });
      expect(churn.enteredExclusion.map((e) => e.branch)).toEqual(["feature/x"]);
      expect(churn.enteredExclusion[0]!.runB).toMatchObject({ policyStatus: "excluded-by-deny", policyMatchedPattern: "feature/x" });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("branch allow/deny — a policy-excluded branch never leaks stale findings (regression pin)", () => {
  // Global finding rows are keyed by (org, repo, branch, commit) and shared across runs. Run A scanned
  // feature/x (findings at its real SHA); a POISON pair sits at commit_sha='' (the SHA a non-scanned
  // row carries). Run B excludes feature/x → its head row is policy-excluded + commit_sha=''. Run B's
  // report/export must surface NEITHER: the real finding fails the commit conjunct, the poison fails
  // ONLY the status='scanned' conjunct — so this test is what makes that predicate load-bearing.
  const ORG = "org-a", REPO = "svc";
  const FX_SHA = "f".repeat(40), MAIN_SHA = "a".repeat(40);
  const dep = (runId: string, branch: string, commitSha: string) => ({
    runId, organization: ORG, repository: REPO, branch, commitSha, dateFetched: nowIso(),
    packageName: "expo", dependencyKey: "expo", dependencyType: "dependencies" as const,
    manifestPath: "package.json", manifestLine: 3, manifestPermalink: `https://github.com/${ORG}/${REPO}/blob/${commitSha || "x"}/package.json#L3`,
    declaredVersion: "^50.0.0",
  });
  const use = (runId: string, branch: string, commitSha: string, file: string, line: number) => ({
    runId, organization: ORG, repository: REPO, branch, commitSha, packageName: "expo", dependencyKey: "expo",
    usageType: "named-import" as const, exportName: "registerRootComponent", context: "", filePath: file, lineNumber: line,
    permalink: `https://github.com/${ORG}/${REPO}/blob/${commitSha || "x"}/${file}#L${line}`,
    snippet: "import { registerRootComponent } from 'expo';", foundAt: nowIso(),
  });
  const scannedHead = (runId: string, branch: string, commitSha: string, isDefault: boolean) =>
    ({ runId, organization: ORG, repository: REPO, branch, commitSha, status: "scanned" as const, isDefaultBranch: isDefault, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T00:00:00Z" });

  test("run B (feature/x denied) surfaces the still-scanned branch's findings but not the excluded branch's (real OR poison)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const root = mkdtempSync(join(tmpdir(), "t10-regression-"));
    try {
      // Run A scanned BOTH main and feature/x → its report positively contains feature/x usage.
      const runIdA = db.startRun({ configHash: "a", effectiveOwners: [ORG], ownersSource: "configured", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" }).runId;
      // Global findings (run_id = A's, provenance only — run B reads them through the HEAD join, not run_id):
      // main (positive control), feature/x at its real SHA, feature/x POISON at commit_sha=''.
      for (const [branch, sha] of [["main", MAIN_SHA], ["feature/x", FX_SHA], ["feature/x", ""]] as const) {
        db.upsertDependencyFinding(dep(runIdA, branch, sha));
        db.upsertUsageFinding(use(runIdA, branch, sha, sha === "" ? "src/poison.ts" : `src/${branch.replace("/", "-")}.ts`, 1));
      }
      db.upsertRunUnitHead(scannedHead(runIdA, "main", MAIN_SHA, true));
      db.upsertRunUnitHead(scannedHead(runIdA, "feature/x", FX_SHA, false));
      db.completeRun(runIdA);
      const reportA = buildReport(db, db.getRun(runIdA)!) as any;
      const aBranches = new Set(reportA.packages[0].usageByRepo.map((u: any) => u.branch));
      expect(aBranches.has("feature/x")).toBe(true); // non-vacuous: feature/x DID have findings when scanned

      // Run B denies feature/x → policy-excluded + commit_sha='' (the poison's SHA). main stays scanned.
      const runIdB = db.startRun({ configHash: "b", effectiveOwners: [ORG], ownersSource: "configured", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" }).runId;
      db.upsertRunUnitHead(scannedHead(runIdB, "main", MAIN_SHA, true));
      db.upsertRunUnitHead({ runId: runIdB, organization: ORG, repository: REPO, branch: "feature/x", commitSha: "", status: "policy-excluded", isDefaultBranch: false, policyStatus: "excluded-by-deny", policyMatchedPattern: "feature/*", scannedCommitDate: "2025-06-01T00:00:00Z" });
      db.completeRun(runIdB);

      // report(B): the positive control surfaces, the excluded branch does NOT (real via commit mismatch,
      // poison via the status='scanned' predicate — the poison shares feature/x's blank commit with run B's head).
      const reportB = buildReport(db, db.getRun(runIdB)!) as any;
      const bBranches = reportB.packages[0].usageByRepo.map((u: any) => u.branch);
      expect(bBranches).toContain("main");
      expect(bBranches).not.toContain("feature/x");
      // usageByRepo is re-filtered through scannedKeys, so it hides a leak on its own — the LOAD-BEARING
      // assertion for report.ts's status='scanned' join is the RAW finding totals (depRows/usageRows,
      // unfiltered): only main's single dep + single usage. Drop status='scanned' and the commit=''
      // poison leaks into these counts (2/2), failing here.
      expect(reportB.summary.totalDependencyFindings).toBe(1);
      expect(reportB.summary.totalUsageFindings).toBe(1);

      // export(B): usage/dependency CSVs contain main's rows, and NO feature/x row of either kind.
      await captureJsonl(() => exportRun(db, db.getRun(runIdB)!, root, { raw: false }));
      const usageCsv = readFileSync(join(root, "xray", "usage_findings.csv"), "utf8");
      const depCsv = readFileSync(join(root, "xray", "dependency_findings.csv"), "utf8");
      expect(usageCsv).toContain(",main,");
      expect(usageCsv).not.toContain(",feature/x,");
      expect(usageCsv).not.toContain("src/poison.ts"); // the poison, specifically, is excluded by status='scanned'
      expect(depCsv).not.toContain(",feature/x,");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
