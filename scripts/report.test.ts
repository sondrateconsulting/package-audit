import { expect, test, describe } from "bun:test";
import { AuditDb, nowIso } from "./db.ts";
import { buildReport } from "./report.ts";

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
  db.upsertRunUnitHead({ runId, ...unit, status: "scanned" });
  db.upsertRunUnitHead({ runId, organization: "org-a", repository: "svc", branch: "old", commitSha: "", status: "skipped-cutoff" });
  db.upsertDependencyFinding({
    runId, ...unit, dateFetched: now, packageName: "expo", dependencyKey: "expo", dependencyType: "dependencies",
    manifestPath: "package.json", manifestLine: 5, manifestPermalink: "https://github.com/org-a/svc/blob/abc123def/package.json#L5",
    declaredVersion: "^50.0.0", lockfilePath: "package-lock.json", lockfileKind: "npm", lockfileLines: [10, 11],
    lockfilePermalink: "https://github.com/org-a/svc/blob/abc123def/package-lock.json#L10-L11",
    resolvedVersion: "50.0.7", resolvedVersionSource: "lockfile",
  });
  db.upsertUsageFinding({
    runId, ...unit, packageName: "expo", dependencyKey: "expo", usageType: "named-import", exportName: "registerRootComponent",
    context: "", filePath: "src/index.ts", lineNumber: 1, permalink: "p", snippet: "import { registerRootComponent } from 'expo';", foundAt: now,
  });
  db.upsertUsageFinding({
    runId, ...unit, packageName: "expo", dependencyKey: "", usageType: "cli", exportName: "",
    context: "scripts.start", filePath: "package.json", lineNumber: 7, permalink: "p2", snippet: "\"start\": \"expo start\"", foundAt: now,
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
    db.upsertRunUnitHead({ runId: run.runId, organization: "org-a", repository: "svc2", branch: "main", commitSha: "def456", status: "scanned" });
    const report = buildReport(db, run) as any;
    const pkg = report.packages[0];
    expect(pkg.versionsSeen).toEqual(["49.0.0", "50.0.7"]); // both present, semver-sorted
    expect(Object.keys(pkg.apiSurface)).toEqual(["50.0.7"]); // only the marked one
    db.close();
  });
});
