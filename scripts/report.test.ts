import { expect, test, describe, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditDb, nowIso } from "./db.ts";
import { buildNotReportableNotice, buildReport, emitDossiers, parseLockfileLines, runReport } from "./report.ts";
import { reportSchema, notReportableSchema, summarySchema } from "./reportSchema.ts";
import { XRAY_FORMAT_VERSION } from "./artifactWrite.ts";
import type { Config } from "./config.ts";

const mem = (): AuditDb => AuditDb.open({ sqlitePath: ":memory:" });

// Seed a COMPLETED run tracking `expo` with one scanned unit + one cutoff-skipped unit, a
// lockfile-resolved dependency finding, an import + a CLI usage, and an api surface for the
// resolved version. Returns the completed RunRecord.
function seed(db: AuditDb) {
  const { runId } = db.startRun({
    configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered",
    trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
  });
  const now = nowIso();
  const unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "abc123def" };
  db.upsertRunUnitHead({ runId, ...unit, status: "scanned", isDefaultBranch: null, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
  db.upsertRunUnitHead({ runId, organization: "org-a", repository: "svc", branch: "old", commitSha: "", status: "skipped-cutoff", isDefaultBranch: null, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
  db.upsertDependencyFinding({
    runId, ...unit, dateFetched: now, packageName: "expo", dependencyKey: "expo", dependencyType: "dependencies",
    manifestPath: "package.json", manifestLine: 5, manifestPermalink: "https://github.com/org-a/svc/blob/abc123def/package.json#L5",
    declaredVersion: "^50.0.0", lockfilePath: "package-lock.json", lockfileKind: "npm", lockfileLines: [10, 11],
    lockfilePermalink: "https://github.com/org-a/svc/blob/abc123def/package-lock.json#L10-L11",
    resolvedVersion: "50.0.7", resolvedVersionSource: "lockfile",
  });
  db.upsertUsageFinding({
    runId, ...unit, packageName: "expo", dependencyKey: "expo", usageType: "named-import", exportName: "registerRootComponent",
    context: "", filePath: "src/index.ts", lineNumber: 1, permalink: "https://github.com/org-a/svc/blob/abc123def/src/index.ts#L1", snippet: "import { registerRootComponent } from 'expo';", foundAt: now,
  });
  db.upsertUsageFinding({
    runId, ...unit, packageName: "expo", dependencyKey: "", usageType: "cli", exportName: "",
    context: "scripts.start", filePath: "package.json", lineNumber: 7, permalink: "https://github.com/org-a/svc/blob/abc123def/package.json#L7", snippet: "\"start\": \"expo start\"", foundAt: now,
  });
  db.writeApiSurface({ packageName: "expo", version: "50.0.7", versionSource: "lockfile", rows: [
    { exportName: "registerRootComponent", exportKind: "named", source: "index.d.ts" },
    { exportName: "AppConfig", exportKind: "type", source: "index.d.ts" },
    { exportName: "expo", exportKind: "cli-bin", source: "package.json#bin" },
  ] });
  db.completeRun(runId);
  return db.getRun(runId)!;
}

describe("buildReport (§7)", () => {
  test("assembles the full shape, filtered + sorted, from SQLite alone", () => {
    const db = mem();
    const run = seed(db);
    const report = buildReport(db, run) as any;

    expect(report.runId).toBe(run.runId);
    expect(report.generatedAt).toBe(run.completedAt); // COALESCE picks completed_at
    expect(report.config).toEqual({ packages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com", organizations: ["org-a"], organizationsSource: "discovered" });

    expect(report.packages.length).toBe(1);
    const pkg = report.packages[0];
    expect(pkg.name).toBe("expo");
    expect(pkg.versionsSeen).toEqual(["50.0.7"]);
    // apiSurface keyed by the marked version; exports sorted by (kind, name); cli bin surface
    expect(Object.keys(pkg.apiSurface)).toEqual(["50.0.7"]);
    expect(pkg.apiSurface["50.0.7"].exports).toEqual([
      { name: "registerRootComponent", kind: "named" },
      { name: "AppConfig", kind: "type" },
    ]);
    expect(pkg.apiSurface["50.0.7"].cli).toEqual({ hasCli: true, binNames: ["expo"] });

    expect(pkg.usageByRepo.length).toBe(1);
    const u = pkg.usageByRepo[0];
    expect(u).toMatchObject({ organization: "org-a", repository: "svc", branch: "main", commitSha: "abc123def" });
    expect(u.declarations[0]).toMatchObject({ dependencyType: "dependencies", resolvedVersion: "50.0.7", resolvedVersionSource: "lockfile" });
    expect(u.declarations[0].lockfile).toEqual({ path: "package-lock.json", lines: [10, 11], permalink: "https://github.com/org-a/svc/blob/abc123def/package-lock.json#L10-L11" });
    expect(u.apiUsage.map((x: any) => x.exportName)).toEqual(["registerRootComponent"]);
    expect(u.cliUsage.map((x: any) => x.context)).toEqual(["scripts.start"]);

    expect(report.summary).toEqual({
      organizationsScanned: 1, repositoriesScanned: 1, branchesScanned: 1,
      branchesSkippedByCutoff: 1, branchesExcludedByPolicy: 0, branchesPastCap: 0, branchesErrored: 0,
      totalDependencyFindings: 1, totalUsageFindings: 2,
    });
    // T8: new top-level report fields
    expect(report.formatVersion).toBe(XRAY_FORMAT_VERSION);
    expect(report.scanScope).toEqual({
      excludedByDeny: 0, excludedByAllow: 0, defaultBranchPolicyOverrides: 0, policyBranches: [], provenance: "complete",
    });
    db.close();
  });

  test("is byte-reproducible across builds", () => {
    const db = mem();
    const run = seed(db);
    const a = JSON.stringify(buildReport(db, run));
    const b = JSON.stringify(buildReport(db, run));
    expect(a).toBe(b);
    db.close();
  });

  test("units carry the tri-state isDefaultBranch from run_unit_head (true/false/null)", () => {
    const db = mem();
    const run = seed(db); // seed's unit writes isDefaultBranch: null
    const mk = (repository: string, isDefaultBranch: boolean | null): void => {
      db.upsertDependencyFinding({
        runId: run.runId, organization: "org-a", repository, branch: "main", commitSha: `sha-${repository}`,
        dateFetched: "2026-01-01T00:00:00.000Z", packageName: "expo", dependencyKey: "expo", dependencyType: "dependencies",
        manifestPath: "package.json", manifestLine: 1, manifestPermalink: `https://github.com/org-a/${repository}/blob/sha/package.json#L1`,
        declaredVersion: "^50.0.0",
      });
      db.upsertRunUnitHead({ runId: run.runId, organization: "org-a", repository, branch: "main", commitSha: `sha-${repository}`, status: "scanned", isDefaultBranch, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    };
    mk("r-default", true);
    mk("r-feature", false);
    const report = buildReport(db, run) as any;
    const flags = Object.fromEntries(
      report.packages[0].usageByRepo.map((u: any) => [u.repository, u.isDefaultBranch]),
    );
    expect(flags).toEqual({ svc: null, "r-default": true, "r-feature": false });
    db.close();
  });

  test("§5 disposition partition + scanScope across all four buckets (deny/allow/default-override/past-cap)", () => {
    const db = mem();
    const { runId } = db.startRun({
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    });
    const head = (branch: string, status: "scanned" | "skipped-cutoff" | "past-cap", extra: {
      isDefaultBranch?: boolean | null; policyStatus?: "excluded-by-deny" | "excluded-by-allow" | null; policyMatchedPattern?: string | null;
    } = {}): void => {
      db.upsertRunUnitHead({
        runId, organization: "org-a", repository: "svc", branch,
        commitSha: status === "scanned" ? `sha-${branch}` : "",
        status, isDefaultBranch: extra.isDefaultBranch ?? null,
        policyStatus: extra.policyStatus ?? null, policyMatchedPattern: extra.policyMatchedPattern ?? null,
        // required non-null on every write: scanned commit's date on a scanned row, discovered-head date otherwise
        scannedCommitDate: "2025-06-01T12:00:00Z",
      });
    };
    // 3 scanned (one a default-branch override that a deny pattern would otherwise exclude),
    // 1 genuine cutoff, 1 deny-excluded, 1 allow-miss-excluded, 1 past-cap → 7 heads total.
    head("main", "scanned", { isDefaultBranch: true });
    head("develop", "scanned", { isDefaultBranch: false });
    const hostilePattern = "release/<img src=x onerror=alert(1)>*"; // carried verbatim in the JSON model
    head("release/9.0", "scanned", { isDefaultBranch: true, policyStatus: "excluded-by-deny", policyMatchedPattern: hostilePattern });
    head("stale", "skipped-cutoff"); // genuine cutoff (no policy) — is_default_branch may stay null
    // policy-excluded + past-cap rows are known non-defaults → is_default_branch MUST be false
    head("feature/x", "skipped-cutoff", { isDefaultBranch: false, policyStatus: "excluded-by-deny", policyMatchedPattern: "feature/*" });
    head("wip/y", "skipped-cutoff", { isDefaultBranch: false, policyStatus: "excluded-by-allow", policyMatchedPattern: null }); // allow-list miss
    head("over-cap", "past-cap", { isDefaultBranch: false });
    db.completeRun(runId);
    const report = buildReport(db, db.getRun(runId)!) as any;

    const s = report.summary;
    expect(s).toMatchObject({
      branchesScanned: 3, // includes the default-override row
      branchesSkippedByCutoff: 1, // genuine cutoff ONLY (policy exclusions are their own bucket)
      branchesExcludedByPolicy: 2,
      branchesPastCap: 1,
    });
    // the four disposition buckets are a disjoint partition of every discovered head
    const totalHeads = 7;
    expect(s.branchesScanned + s.branchesSkippedByCutoff + s.branchesExcludedByPolicy + s.branchesPastCap).toBe(totalHeads);

    expect(report.scanScope).toEqual({
      excludedByDeny: 1, // feature/x — the default-override deny does NOT count as an exclusion
      excludedByAllow: 1, // wip/y
      defaultBranchPolicyOverrides: 1, // release/9.0
      policyBranches: [
        { organization: "org-a", repository: "svc", branch: "feature/x", disposition: "excluded", policyStatus: "excluded-by-deny", matchedPattern: "feature/*" },
        { organization: "org-a", repository: "svc", branch: "release/9.0", disposition: "scanned-default-override", policyStatus: "excluded-by-deny", matchedPattern: hostilePattern },
        { organization: "org-a", repository: "svc", branch: "wip/y", disposition: "excluded", policyStatus: "excluded-by-allow", matchedPattern: null },
      ],
      provenance: "complete", // every head carries a non-null scanned_commit_date
    });
    // hostile pattern is carried BYTE-VERBATIM in the data model — escaping is the HTML layer's job
    expect(report.scanScope.policyBranches[1].matchedPattern).toBe(hostilePattern);
    db.close();
  });

  test("§5 partition counts RECORDED disposition rows only — a scan-errored discovered branch is in errors[], not a bucket", () => {
    const db = mem();
    const { runId } = db.startRun({ configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" });
    // 'main' reached a terminal disposition (scanned). 'feature' was discovered + eligible but its scan
    // ERRORED — it writes NO run_unit_head row (only an errors[] entry), so it is in no disposition bucket.
    db.upsertRunUnitHead({ runId, organization: "org-a", repository: "svc", branch: "main", commitSha: "sha-main", status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T00:00:00Z" });
    db.insertError({ runId, scope: "scan", organization: "org-a", repository: "svc", branch: "feature", message: "tree fetch failed" });
    db.completeRun(runId);
    const report = buildReport(db, db.getRun(runId)!) as any;
    // the four disposition buckets sum to the RECORDED rows (1: main) — 'feature' is in none of them…
    expect(report.summary).toMatchObject({ branchesScanned: 1, branchesSkippedByCutoff: 0, branchesExcludedByPolicy: 0, branchesPastCap: 0 });
    // …it is counted as ERRORED instead, so the summary reconciles to BOTH discovered heads
    expect(report.summary.branchesErrored).toBe(1);
    const s = report.summary;
    expect(s.branchesScanned + s.branchesSkippedByCutoff + s.branchesExcludedByPolicy + s.branchesPastCap + s.branchesErrored).toBe(2);
    // and 'feature' carries its scan failure in errors[]
    expect(report.errors.some((e: any) => e.branch === "feature" && e.scope === "scan")).toBe(true);
    db.close();
  });

  test("§5 the scan-scope ledger FAILS CLOSED on a policy-bearing row that is neither excluded nor an override", () => {
    // The ledger must decide via BOTH shared predicates, never `isDefaultOverride(h) ? … : "excluded"` —
    // that binary form would re-define "excluded" as "policy-bearing but not an override", a second
    // definition competing with policyDisposition.ts. assertRunUnitHeadInvariants makes this shape
    // unreachable through the write path (a past-cap row must carry policy_status null), so it is forged
    // with a raw handle to prove the READ surface fails closed on its own rather than mislabelling.
    // Same ./data containment idiom as the provenance test below (§0 forbids writes outside ./data).
    const dataExistedBefore = existsSync("./data");
    const dbRoot = `./data/.reporttest-ledger-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      const sqlitePath = join(dbRoot, "audit.db");
      const db = AuditDb.open({ sqlitePath });
      const { runId } = db.startRun({ configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" });
      db.completeRun(runId);
      db.close();
      // forge past-cap + policy_status: the write path forbids it, the CHECK constraints permit it
      const forge = new Database(sqlitePath, { strict: true });
      forge.query(`INSERT INTO run_unit_head (run_id, organization, repository, branch, commit_sha, status, is_default_branch, policy_status, policy_matched_pattern, scanned_commit_date) VALUES (?, 'org-a', 'svc', 'weird', '', 'past-cap', 0, 'excluded-by-deny', 'weird', '2025-06-01T00:00:00Z')`).run(runId);
      forge.close();
      const db2 = AuditDb.open({ sqlitePath });
      expect(() => buildReport(db2, db2.getRun(runId)!)).toThrow(/neither a policy exclusion nor a default-branch override/);
      db2.close();
    } finally {
      rmSync(dbRoot, { recursive: true, force: true });
      if (!dataExistedBefore && existsSync("./data") && readdirSync("./data").length === 0) rmSync("./data", { recursive: true });
    }
  });

  test("§5 RESUME: a branch holding a RETAINED row that errors later is NOT in branchesErrored (no double-count)", () => {
    // The resumed-run shape the single-invocation test above cannot reach. A resumed run reuses the
    // run_id, so errors[] and run_unit_head both span invocations:
    //   invocation 1 — main scanned@A, writing a row.
    //   invocation 2 — main advanced to B; the re-scan errors. No new row, and §11's name-keyed prune
    //                  RETAINS invocation 1's row (main is still a live branch).
    // main therefore holds BOTH a row and a scan error. It is counted ONCE — in branchesScanned, via the
    // retained row — and NOT in branchesErrored. Deliberate: counting it in both would count one
    // discovered branch twice and break the partition. This is exactly why branchesErrored must be read
    // as "errored branches holding no row" and NOT as "every branch whose scan errored" (see report.ts).
    const db = mem();
    const { runId } = db.startRun({ configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" });
    db.upsertRunUnitHead({ runId, organization: "org-a", repository: "svc", branch: "main", commitSha: "sha-A", status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-05-01T00:00:00Z" });
    db.insertError({ runId, scope: "scan", organization: "org-a", repository: "svc", branch: "main", message: "tree boom at sha-B" });
    db.completeRun(runId);
    const report = buildReport(db, db.getRun(runId)!) as any;
    expect(report.summary.branchesErrored).toBe(0); // suppressed by the row-key exclusion — NOT a bug
    expect(report.summary.branchesScanned).toBe(1); // counted here instead, at the OLDER head
    // the error stays visible to a reader, so the tension is not hidden — only the COUNT omits it
    expect(report.errors.some((e: any) => e.branch === "main" && e.scope === "scan")).toBe(true);
    // and the branch is counted exactly ONCE across the buckets + errored (the partition holds)
    const s = report.summary;
    expect(s.branchesScanned + s.branchesSkippedByCutoff + s.branchesExcludedByPolicy + s.branchesPastCap + s.branchesErrored).toBe(1);
    db.close();
  });

  test("a completed run with ZERO heads has unverifiable provenance → 'pre-upgrade', never a false 'complete'", () => {
    const db = mem();
    const { runId } = db.startRun({
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    });
    db.completeRun(runId); // reportable, but no run_unit_head rows were ever written (e.g. all discovery failed)
    const report = buildReport(db, db.getRun(runId)!) as any;
    // zero heads carry NO sentinel, so `.some()` is vacuously false — must NOT be reported as complete
    expect(report.scanScope.provenance).toBe("pre-upgrade");
    expect(report.summary.branchesScanned).toBe(0);
    db.close();
  });

  test("a migrated pre-v4 run (NULL scanned_commit_date sentinel) marks scanScope provenance 'pre-upgrade'", () => {
    // file-backed: the forge trick (a NULL scanned_commit_date the write path forbids) needs a real
    // DB handle. Same ./data containment idiom as the runReport file tests below.
    const dataExistedBefore = existsSync("./data");
    const dbRoot = `./data/.reporttest-prov-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      const sqlitePath = join(dbRoot, "audit.db");
      const db = AuditDb.open({ sqlitePath });
      const run = seed(db); // heads carry non-null dates → a fresh run would be "complete"
      db.close();
      const forge = new Database(sqlitePath, { strict: true });
      forge.exec("UPDATE run_unit_head SET scanned_commit_date = NULL"); // the pre-v4 migration state
      forge.close();
      const db2 = AuditDb.open({ sqlitePath });
      const report = buildReport(db2, db2.getRun(run.runId)!) as any;
      expect(report.scanScope.provenance).toBe("pre-upgrade");
      // the counts still render (best-available) — provenance is what tells the reader they understate
      expect(report.summary.branchesScanned).toBe(1);
      db2.close();
    } finally {
      rmSync(dbRoot, { recursive: true, force: true });
      if (!dataExistedBefore && existsSync("./data") && readdirSync("./data").length === 0) rmSync("./data", { recursive: true });
    }
  });

  test("a version whose introspection FAILED (no marker) is omitted from apiSurface but kept in versionsSeen", () => {
    const db = mem();
    const run = seed(db);
    // add a second resolved version with NO completion marker
    db.upsertDependencyFinding({
      runId: run.runId, organization: "org-a", repository: "svc2", branch: "main", commitSha: "def456",
      dateFetched: nowIso(), packageName: "expo", dependencyKey: "expo", dependencyType: "dependencies",
      manifestPath: "package.json", manifestLine: 3, manifestPermalink: "https://github.com/org-a/svc2/blob/def456/package.json#L3",
      declaredVersion: "^49.0.0", resolvedVersion: "49.0.0", resolvedVersionSource: "lockfile",
    });
    db.upsertRunUnitHead({ runId: run.runId, organization: "org-a", repository: "svc2", branch: "main", commitSha: "def456", status: "scanned", isDefaultBranch: null, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    const report = buildReport(db, run) as any;
    const pkg = report.packages[0];
    expect(pkg.versionsSeen).toEqual(["49.0.0", "50.0.7"]); // both present, semver-sorted
    expect(Object.keys(pkg.apiSurface)).toEqual(["50.0.7"]); // only the marked one
    db.close();
  });
});

describe("reportSchema (§7 contract as a strict Zod schema)", () => {
  test("a fully-populated emitted report validates", () => {
    const db = mem();
    const run = seed(db);
    // add an error row so the errors[] branch of the schema is exercised too
    db.insertError({ runId: run.runId, scope: "introspection", packageName: "expo", version: "49.0.0", message: "tarball integrity mismatch" });
    const parsed = reportSchema.safeParse(buildReport(db, run));
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    db.close();
  });
  test("an empty run (no findings) still emits the full, schema-valid shape", () => {
    const db = mem();
    const { runId } = db.startRun({
      configHash: "h2", effectiveOwners: ["org-b"], ownersSource: "configured",
      trackedPackages: ["left-pad"], cutoffDate: "2024-01-01", githubHost: "ghe.corp.example",
    });
    db.completeRun(runId);
    const parsed = reportSchema.safeParse(buildReport(db, db.getRun(runId)!));
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    db.close();
  });
  test("strictness: an extra field on the report is rejected (drift fails loudly)", () => {
    const db = mem();
    const run = seed(db);
    const drifted = { ...buildReport(db, run), extraField: 1 };
    expect(reportSchema.safeParse(drifted).success).toBe(false);
    db.close();
  });
  test("formatVersion is PINNED to XRAY_FORMAT_VERSION — a mislabeled v-shape fails the discriminator", () => {
    const db = mem();
    const run = seed(db);
    const report = buildReport(db, run);
    expect(report.formatVersion).toBe(XRAY_FORMAT_VERSION);
    expect(reportSchema.safeParse(report).success).toBe(true); // the real version validates
    // a v2-shaped report mislabeled as another version must NOT pass the authoritative contract
    for (const wrong of [1, -1, 999]) {
      expect(reportSchema.safeParse({ ...report, formatVersion: wrong }).success).toBe(false);
    }
    db.close();
  });
  test("the REAL not-reportable notice (all three branches) matches its schema", () => {
    // the actual objects report.ts emits — not hand-written lookalikes
    const noRun = buildNotReportableNotice(null);
    const badId = buildNotReportableNotice("run-x");
    const noDb = buildNotReportableNotice(null, "./data/audit.db");
    expect(notReportableSchema.safeParse(noRun).success).toBe(true);
    expect(notReportableSchema.safeParse(badId).success).toBe(true);
    expect(notReportableSchema.safeParse(noDb).success).toBe(true);
    expect(noRun.reason).toBe("no completed reportable run yet");
    expect(badId.reason).toContain("run-x not found");
    expect(noDb.reason).toBe("no database at ./data/audit.db — run `bun run audit` first");
    // the missing-db reason takes precedence over the run-id reason
    expect(buildNotReportableNotice("run-x", "./data/audit.db").reason).toContain("no database at");
    // negative instance stays: the schema still rejects a wrong discriminant
    expect(notReportableSchema.safeParse({ notReportable: false, reason: "x" }).success).toBe(false);
  });
  test("buildReport's summary keys match summarySchema exactly (guards the done event + stderr summary)", () => {
    const db = mem();
    const run = seed(db);
    // orchestrate.ts derives its done event and human summary from report.summary via the
    // ReportSummary type — this pins the runtime keys to the schema so neither can drift alone.
    expect(Object.keys(buildReport(db, run).summary).sort()).toEqual(Object.keys(summarySchema.shape).sort());
    db.close();
  });

  test("schema strength: an apiSurface key NOT in versionsSeen is rejected (the documented subset invariant)", () => {
    const db = mem();
    const run = seed(db);
    const drifted = structuredClone(buildReport(db, run)) as any;
    drifted.packages[0].apiSurface["99.99.99"] = drifted.packages[0].apiSurface["50.0.7"];
    expect(reportSchema.safeParse(drifted).success).toBe(false);
    db.close();
  });
  test("schema strength: a non-canonical generatedAt is rejected", () => {
    const db = mem();
    const run = seed(db);
    const drifted = structuredClone(buildReport(db, run)) as any;
    drifted.generatedAt = "2026-07-09 12:00:00"; // space form — not the nowIso canonical shape
    expect(reportSchema.safeParse(drifted).success).toBe(false);
    db.close();
  });
  test("schema strength: a permalink that is not a commit-pinned https blob link is rejected", () => {
    const db = mem();
    const run = seed(db);
    const drifted = structuredClone(buildReport(db, run)) as any;
    drifted.packages[0].usageByRepo[0].apiUsage[0].permalink = "http://evil.example/x";
    expect(reportSchema.safeParse(drifted).success).toBe(false);
    db.close();
  });

  test("no production module imports reportSchema or zod — schema validation stays test-only (source scan)", () => {
    // §7 determinism guarantee: a schema bug must never be able to fail a completed scan's
    // report write, so validation runs in tests only. This scan keeps that comment TRUE the
    // same way the Bun-spawn chokepoint and cliErrors registry scans guard their invariants.
    // TYPE-ONLY imports are banned too — compile-time coupling invites runtime use later.
    // The specifier alternative covers any relative depth (./ ../ ../../) so a future subdir
    // layout can't slip a nested `../reportSchema` past the scan; the walk recurses for the
    // same reason.
    const BANNED_SPECIFIER = /(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s+)["'`](?:zod|(?:\.\.?\/)+reportSchema(?:\.ts)?)["'`]/;
    const offenders: string[] = [];
    for (const rel of readdirSync(import.meta.dir, { recursive: true }).map(String)) {
      if (!rel.endsWith(".ts") || rel.endsWith(".test.ts") || rel.endsWith("reportSchema.ts")) continue;
      const src = readFileSync(join(import.meta.dir, rel), "utf8");
      if (BANNED_SPECIFIER.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    // positive controls — the regex trips on every import form it must catch…
    expect(BANNED_SPECIFIER.test(readFileSync(join(import.meta.dir, "reportSchema.ts"), "utf8"))).toBe(true); // real zod import
    expect(BANNED_SPECIFIER.test('import type { X } from "../reportSchema.ts";')).toBe(true); // nested + type-only
    expect(BANNED_SPECIFIER.test('const s = require("./reportSchema");')).toBe(true);
    expect(BANNED_SPECIFIER.test('await import("zod");')).toBe(true);
    // …and stays quiet on prose that merely mentions the module
    expect(BANNED_SPECIFIER.test("// the contract lives in reportSchema.ts and is enforced in tests")).toBe(false);
  });
});

// runReport before any audit is a pure no-op: report.ts must NOT open (create) the database
// or mkdir the output dir when there is nothing to report yet (the boomerang finding — the old
// entrypoint materialized a migrated data/audit.db + a stub output/latest.json on first run).
describe("runReport zero-write on a missing database", () => {
  const config = (root: string): Config => ({
    concurrency: { branches: 1, organizations: 1, repositories: 1 },
    cutoffDate: "2024-01-01", excludeDirGlobs: [], githubHost: "github.com",
    includeArchived: false, includeForks: false, includePersonalNamespace: false,
    maxBranchesPerRepo: 25, maxReposPerOrg: null, organizations: null, excludeOrganizations: [],
    branches: null, excludeBranches: [],
    packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
    // both under root, which starts empty — any create/mkdir would leave a trace
    paths: { sqlitePath: join(root, "data", "audit.db"), outputDir: join(root, "output") },
  });

  test("prints the actionable notice and touches nothing (no data/, no output/, no db file)", () => {
    const root = mkdtempSync(join(tmpdir(), "report-nodb-"));
    const { line } = runReport(config(root), null);
    const notice = JSON.parse(line);
    expect(notice.notReportable).toBe(true);
    expect(notice.reason).toContain("run `bun run audit` first");
    expect(notReportableSchema.safeParse(notice).success).toBe(true);
    expect(readdirSync(root)).toEqual([]); // no data/audit.db created, no output/latest.json written
    rmSync(root, { recursive: true, force: true });
  });

  test("--run-id against a missing database still reports missing-db (precedence) and writes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "report-nodb-id-"));
    const { line } = runReport(config(root), "some-run-id");
    const notice = JSON.parse(line);
    expect(notice.notReportable).toBe(true);
    expect(notice.reason).toContain("no database at");
    expect(readdirSync(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  // Contrast case: when the database OPENS but holds no completed run, report must still write
  // the notice to output/latest.json — proving the missing-db guard only short-circuits the
  // genuinely-absent case and does not suppress a real (if empty) report. runReport now opens
  // READ-ONLY (CV5), which refuses :memory:, so the empty DB must be a real FILE — and §0
  // write-containment pins file DBs to ./data|./output relative to CWD, hence the db.test.ts
  // TEST_ROOT idiom here (created and removed carefully so fresh checkouts stay pristine).
  test("DB opens but no completed run: writes the notice to latest.json, no run file", () => {
    const dataExistedBefore = existsSync("./data");
    const dbRoot = `./data/.reporttest-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const root = mkdtempSync(join(tmpdir(), "report-emptydb-"));
    try {
      const sqlitePath = join(dbRoot, "audit.db");
      AuditDb.open({ sqlitePath }).close(); // a real, empty, cleanly-closed v3 database
      const cfg: Config = { ...config(root), paths: { sqlitePath, outputDir: join(root, "output") } };
      const { line } = runReport(cfg, null);
      expect(JSON.parse(line).reason).toBe("no completed reportable run yet");
      expect(readdirSync(join(root, "output"))).toEqual(["latest.json"]); // only latest.json, no run-<id>.json
      const written = JSON.parse(readFileSync(join(root, "output", "latest.json"), "utf8"));
      expect(notReportableSchema.safeParse(written).success).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dbRoot, { recursive: true, force: true });
      if (!dataExistedBefore && existsSync("./data") && readdirSync("./data").length === 0) rmSync("./data", { recursive: true });
    }
  });

  test("a too-old (v2) file database is refused through runReport with the migrate-first error", () => {
    const dataExistedBefore = existsSync("./data");
    const dbRoot = `./data/.reporttest-v2-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const root = mkdtempSync(join(tmpdir(), "report-v2db-"));
    try {
      // Faithful v2 file: a v3 create downgraded to the v2 SHAPE (drop the v3 column) before
      // the v2 stamp. openReadOnly's ownership check precedes its version gate, so a fixture
      // must actually BE a v2 database — a v3-shaped file merely wearing the stamp is a state
      // the tool never produces (migration stamps atomically with the ALTER) and is refused
      // as not-ours, which is a different test's contract.
      const sqlitePath = join(dbRoot, "audit.db");
      AuditDb.open({ sqlitePath }).close(); // create a real v3 db…
      const bump = new Database(sqlitePath, { strict: true });
      bump.exec("ALTER TABLE run_unit_head DROP COLUMN is_default_branch"); // …downgrade to the v2 shape
      bump.exec("PRAGMA user_version = 2"); // …then stamp it old
      bump.close();
      const cfg: Config = { ...config(root), paths: { sqlitePath, outputDir: join(root, "output") } };
      expect(() => runReport(cfg, null)).toThrow(/run `bun run audit` once to migrate/);
      expect(existsSync(join(root, "output"))).toBe(false); // refused before any artifact write
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dbRoot, { recursive: true, force: true });
      if (!dataExistedBefore && existsSync("./data") && readdirSync("./data").length === 0) rmSync("./data", { recursive: true });
    }
  });

  test(":memory: sqlitePath folds into the missing-db notice (nothing to read, nothing written)", () => {
    const root = mkdtempSync(join(tmpdir(), "report-mem-"));
    const cfg: Config = { ...config(root), paths: { sqlitePath: ":memory:", outputDir: join(root, "output") } };
    const { line } = runReport(cfg, null);
    const notice = JSON.parse(line);
    expect(notice.notReportable).toBe(true);
    expect(notice.reason).toContain("run `bun run audit` first");
    expect(readdirSync(root)).toEqual([]); // no output dir materialized
    rmSync(root, { recursive: true, force: true });
  });
});

describe("report --html wiring (emitDossiers + runReport integration)", () => {
  const config = (root: string): Config => ({
    concurrency: { branches: 1, organizations: 1, repositories: 1 },
    cutoffDate: "2024-01-01", excludeDirGlobs: [], githubHost: "github.com",
    includeArchived: false, includeForks: false, includePersonalNamespace: false,
    maxBranchesPerRepo: 25, maxReposPerOrg: null, organizations: null, excludeOrganizations: [],
    branches: null, excludeBranches: [],
    packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
    paths: { sqlitePath: join(root, "data", "audit.db"), outputDir: join(root, "output") },
  });

  test("emitDossiers writes one dossier per package + index + manifest, with visible observation status", () => {
    const db = mem();
    const run = seed(db);
    const report = buildReport(db, run);
    const out = mkdtempSync(join(tmpdir(), "dossier-wire-"));
    const chunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    try {
      const { dossiers, swept } = emitDossiers(report, out);
      expect(dossiers).toBe(1);
      expect(swept).toEqual([]);
      const xray = join(out, "xray");
      const files = readdirSync(xray).sort();
      expect(files).toEqual(["expo-dossier.html", "index.html", "manifest.json"]);
      const manifest = JSON.parse(readFileSync(join(xray, "manifest.json"), "utf8"));
      expect(manifest.runId).toBe(run.runId);
      expect(manifest.artifacts.every((a: any) => a.kind === "dossier")).toBe(true);
      // the dossier itself carries the escaped evidence, never a raw script breakout
      const html = readFileSync(join(xray, "expo-dossier.html"), "utf8");
      expect(html).toContain("registerRootComponent");
    } finally {
      spy.mockRestore();
      rmSync(out, { recursive: true, force: true });
      db.close();
    }
    const events = chunks.join("").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const dossierEvents = events.filter((e) => e.event === "dossier");
    expect(dossierEvents.length).toBe(1);
    expect(dossierEvents[0].package).toBe("expo");
    expect(["emitted", "omitted"]).toContain(dossierEvents[0].observations);
    const summary = events.filter((e) => e.event === "dossier-summary");
    expect(summary.length).toBe(1);
    expect(summary[0].dossiers).toBe(1);
  });

  test("runReport --html renders dossiers end-to-end from a file database (read-only open)", () => {
    const dataExistedBefore = existsSync("./data");
    const dbRoot = `./data/.reporttest-html-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const root = mkdtempSync(join(tmpdir(), "report-html-"));
    const chunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    try {
      const sqlitePath = join(dbRoot, "audit.db");
      const db = AuditDb.open({ sqlitePath });
      seed(db);
      db.close();
      const cfg: Config = { ...config(root), paths: { sqlitePath, outputDir: join(root, "output") } };
      const { line } = runReport(cfg, null, { html: true });
      expect(line).toContain("dossier(s) + index");
      const xray = join(root, "output", "xray");
      expect(readdirSync(xray).sort()).toEqual(["expo-dossier.html", "index.html", "manifest.json"]);
      // and WITHOUT --html nothing dossier-ish is produced on a fresh outputDir
      const root2 = mkdtempSync(join(tmpdir(), "report-nohtml-"));
      try {
        const cfg2: Config = { ...config(root2), paths: { sqlitePath, outputDir: join(root2, "output") } };
        runReport(cfg2, null, {});
        expect(existsSync(join(root2, "output", "xray"))).toBe(false);
      } finally {
        rmSync(root2, { recursive: true, force: true });
      }
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(dbRoot, { recursive: true, force: true });
      if (!dataExistedBefore && existsSync("./data") && readdirSync("./data").length === 0) rmSync("./data", { recursive: true });
    }
  });
});

// ---- dual-review round-2 regression (2026-07-11): raw outputDir mkdir must be canonical ----------
// A config-accepted outputDir containing a `..` chain (canonical resolution lands INSIDE the
// roots) must not cause recursive mkdir to create the chain's intermediate directories OUTSIDE
// them: mkdirSync creates each component physically, so `out/../evil/../out/sub` would create
// `evil/`. The emit path must mkdir the CANONICAL path only.
test("emitReportDetailed: a ..-chain outputDir creates no directories outside its canonical root", async () => {
  const { emitReportDetailed } = await import("./report.ts");
  const tmp = mkdtempSync(join(tmpdir(), "report-esc-"));
  try {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { runId } = db.startRun({
      configHash: "h", effectiveOwners: ["o"], ownersSource: "configured",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    });
    db.completeRun(runId);
    const run = db.getRun(runId)!;
    const outputDir = `${tmp}/out/../evil/../out/sub`; // canonical: <tmp>/out/sub
    emitReportDetailed(db, run, outputDir, { alsoLatest: false });
    db.close();
    expect(existsSync(join(tmp, "evil"))).toBe(false); // nothing outside the canonical root
    expect(existsSync(join(tmp, "out", "sub", `run-${runId}.json`))).toBe(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

describe("buildReport — run-scope head-join discrimination (M7)", () => {
  test("a finding whose run_id MOVED to a later run still appears in the older run's report", () => {
    // Load-bearing invariant (mirrors export.test.ts / compare.test.ts): buildReport scopes findings
    // through run_unit_head, NEVER findings.run_id. A finding's upsert OVERWRITES run_id (db.ts
    // ON CONFLICT ... SET run_id = excluded.run_id), so a later run re-scanning the SAME commit
    // steals the row's run_id. Run A's report must still contain the row via its immutable head
    // snapshot; a `WHERE df/uf.run_id = ?` regression in report.ts drops it and fails here.
    const db = mem();
    const input = {
      configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered" as const,
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    };
    const unit = { organization: "org-a", repository: "svc", branch: "main", commitSha: "ccc333def4567" };
    const usage = {
      ...unit, packageName: "expo", dependencyKey: "expo", usageType: "named-import" as const,
      exportName: "sharedExport", context: "", filePath: "src/shared.ts", lineNumber: 4,
      permalink: "https://github.com/org-a/svc/blob/ccc333def4567/src/shared.ts#L4", snippet: "import { sharedExport } from 'expo';",
      foundAt: "2026-01-01T00:00:00.000Z",
    };
    // A dependency finding on the SAME unit: buildReport joins dependency_findings and usage_findings
    // through run_unit_head via SEPARATE queries, so the test must move BOTH — a regression that
    // filters only ONE of the two on findings.run_id would otherwise slip through.
    const dep = {
      ...unit, dateFetched: "2026-01-01T00:00:00.000Z", packageName: "expo", dependencyKey: "expo",
      dependencyType: "dependencies" as const, manifestPath: "package.json", manifestLine: 3,
      manifestPermalink: "https://github.com/org-a/svc/blob/ccc333def4567/package.json#L3",
      declaredVersion: "^50.0.0", resolvedVersion: "50.0.9", resolvedVersionSource: "lockfile" as const,
    };
    const { runId: rA } = db.startRun(input);
    db.upsertRunUnitHead({ runId: rA, ...unit, status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    db.upsertUsageFinding({ runId: rA, ...usage });
    db.upsertDependencyFinding({ runId: rA, ...dep });
    db.completeRun(rA);
    Bun.sleepSync(2);
    const { runId: rB } = db.startRun(input);
    db.upsertRunUnitHead({ runId: rB, ...unit, status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    db.upsertUsageFinding({ runId: rB, ...usage }); // same UNIQUE key → uf.run_id moves to rB
    db.upsertDependencyFinding({ runId: rB, ...dep }); // same UNIQUE key → df.run_id moves to rB
    db.completeRun(rB);

    // Precondition: BOTH findings' run_ids really did move (otherwise this test discriminates nothing).
    const movedU = db.read("SELECT run_id FROM usage_findings WHERE file_path = 'src/shared.ts'").get() as { run_id: string };
    const movedD = db.read("SELECT run_id FROM dependency_findings WHERE manifest_path = 'package.json'").get() as { run_id: string };
    expect(movedU.run_id).toBe(rB);
    expect(movedD.run_id).toBe(rB);

    const report = buildReport(db, db.getRun(rA)!);
    const expo = report.packages.find((p) => p.name === "expo");
    // usage_findings join (a uf.run_id regression drops this)
    const files = expo?.usageByRepo.flatMap((u) => u.apiUsage.map((a) => a.file)) ?? [];
    expect(files).toContain("src/shared.ts");
    // dependency_findings join (a df.run_id regression drops this)
    const versions = expo?.usageByRepo.flatMap((u) => u.declarations.map((d) => d.resolvedVersion)) ?? [];
    expect(versions).toContain("50.0.9");
    db.close();
  });
});

describe("parseLockfileLines — corrupted self-produced data degrades to null, never throws (L5)", () => {
  test("null passes through; a valid integer array parses", () => {
    expect(parseLockfileLines(null)).toBeNull();
    expect(parseLockfileLines("[10, 11]")).toEqual([10, 11]);
    expect(parseLockfileLines("[]")).toEqual([]);
  });
  test("a corrupted cell (invalid JSON or wrong shape) degrades to null instead of throwing", () => {
    expect(parseLockfileLines("not json")).toBeNull(); // would have thrown SyntaxError before the guard
    expect(parseLockfileLines('{"a":1}')).toBeNull(); // parseable but not an array
    expect(parseLockfileLines('["10","11"]')).toBeNull(); // array of non-numbers
    expect(parseLockfileLines("42")).toBeNull(); // parseable but not an array
    expect(parseLockfileLines("[1.5]")).toBeNull(); // number-typed but not an integer line ref
    expect(parseLockfileLines("[1e400]")).toBeNull(); // parses to Infinity (typeof "number") — rejected
    expect(parseLockfileLines("[10, 2.5]")).toBeNull(); // one bad element rejects the whole array
    expect(parseLockfileLines("[0]")).toBeNull(); // 0 is not a 1-based line number
    expect(parseLockfileLines("[-3]")).toBeNull(); // negative
    expect(parseLockfileLines("[9007199254740993]")).toBeNull(); // > MAX_SAFE_INTEGER (unsafe)
  });
  test("a valid positive safe-integer array parses (including large in-range values)", () => {
    expect(parseLockfileLines("[1, 42, 999999]")).toEqual([1, 42, 999999]);
  });
});
