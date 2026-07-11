import { expect, test, describe } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditDb, nowIso } from "./db.ts";
import { buildNotReportableNotice, buildReport, runReport } from "./report.ts";
import { reportSchema, notReportableSchema, summarySchema } from "./reportSchema.ts";
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
  db.upsertRunUnitHead({ runId, ...unit, status: "scanned", isDefaultBranch: null });
  db.upsertRunUnitHead({ runId, organization: "org-a", repository: "svc", branch: "old", commitSha: "", status: "skipped-cutoff", isDefaultBranch: null });
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
      branchesSkippedByCutoff: 1, totalDependencyFindings: 1, totalUsageFindings: 2,
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
    db.upsertRunUnitHead({ runId: run.runId, organization: "org-a", repository: "svc2", branch: "main", commitSha: "def456", status: "scanned", isDefaultBranch: null });
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
  // genuinely-absent case and does not suppress a real (if empty) report. An in-memory DB is a
  // real, empty database that opens without hitting §0 write-containment (which pins a FILE db to
  // ./data|./output and so rules out a temp-dir file db here); the notReportable branch is
  // identical regardless of DB backing, and outputDir stays a real temp dir we can assert on.
  test("DB opens but no completed run: writes the notice to latest.json, no run file", () => {
    const root = mkdtempSync(join(tmpdir(), "report-emptydb-"));
    const cfg: Config = { ...config(root), paths: { sqlitePath: ":memory:", outputDir: join(root, "output") } };
    const { line } = runReport(cfg, null);
    expect(JSON.parse(line).reason).toBe("no completed reportable run yet");
    expect(readdirSync(join(root, "output"))).toEqual(["latest.json"]); // only latest.json, no run-<id>.json
    const written = JSON.parse(readFileSync(join(root, "output", "latest.json"), "utf8"));
    expect(notReportableSchema.safeParse(written).success).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
