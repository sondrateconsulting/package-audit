// ciExportFixture.ts — generate a SYNTHETIC export fixture for the CI recipe job.
// Builds an in-memory audit database from made-up data (publish hygiene: nothing here
// derives from any real estate), then writes the real run-scoped exports into ./output/xray/
// through the production exportRun — the exact artifacts the README's "Analyze the exports"
// recipes read. CI then executes every recipe VERBATIM against these files with a SHA-pinned
// DuckDB CLI; recipe/registry identifier sync is enforced separately by exportsDoc.test.ts.
//
// Deliberately hostile cells are included (a formula-injection snippet, quotes, a comma) so
// the recipes run against CSV that exercises the quoting/defense rules, not just happy bytes.

import { AuditDb } from "./db.ts";
import { exportRun } from "./export.ts";

export function generateFixtureExports(outputDir: string): { runId: string } {
  const db = AuditDb.open({ sqlitePath: ":memory:" });
  try {
    const { runId } = db.startRun({
      configHash: "ci-fixture", effectiveOwners: ["acme"], ownersSource: "configured",
      trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com",
    });
    const T = "2026-01-01T00:00:00.000Z";
    const units = [
      { organization: "acme", repository: "web", branch: "main", commitSha: "1111111111111111111111111111111111111111", isDefault: true },
      { organization: "acme", repository: "mobile", branch: "main", commitSha: "2222222222222222222222222222222222222222", isDefault: true },
      { organization: "acme", repository: "mobile", branch: "feat-x", commitSha: "3333333333333333333333333333333333333333", isDefault: false },
    ];
    for (const u of units) {
      const { isDefault, ...unit } = u;
      db.upsertRunUnitHead({
        runId, ...unit, status: "scanned", isDefaultBranch: isDefault,
        policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z",
      });
      db.upsertDependencyFinding({
        runId, ...unit, dateFetched: T, packageName: "expo", dependencyKey: "expo",
        dependencyType: "dependencies", manifestPath: "package.json", manifestLine: 11,
        manifestPermalink: `https://github.com/${unit.organization}/${unit.repository}/blob/${unit.commitSha}/package.json#L11`,
        declaredVersion: "^50.0.0", lockfilePath: "bun.lock", lockfileKind: "bun",
        lockfileLines: [42], lockfilePermalink: `https://github.com/${unit.organization}/${unit.repository}/blob/${unit.commitSha}/bun.lock#L42`,
        resolvedVersion: unit.repository === "web" ? "50.0.7" : "50.0.4", resolvedVersionSource: "lockfile",
      });
      db.upsertUsageFinding({
        runId, ...unit, packageName: "expo", dependencyKey: "expo", usageType: "named-import",
        exportName: "registerRootComponent", context: "", filePath: "src/index.ts", lineNumber: 1,
        permalink: `https://github.com/${unit.organization}/${unit.repository}/blob/${unit.commitSha}/src/index.ts#L1`,
        snippet: 'import { registerRootComponent } from "expo";', foundAt: T,
      });
    }
    // Policy-bearing heads (no findings — an excluded/deferred branch is never scanned): a deny
    // exclusion with a causing pattern, an allow-list miss (NULL pattern), and a past-cap deferral.
    // These give the run_unit_head export + its recipe real branch-policy rows to read in CI.
    db.upsertRunUnitHead({
      runId, organization: "acme", repository: "web", branch: "wip/experiment", commitSha: "",
      status: "policy-excluded", isDefaultBranch: false, policyStatus: "excluded-by-deny",
      policyMatchedPattern: "wip/*", scannedCommitDate: "2025-06-01T12:00:00Z",
    });
    db.upsertRunUnitHead({
      runId, organization: "acme", repository: "mobile", branch: "sandbox", commitSha: "",
      status: "policy-excluded", isDefaultBranch: false, policyStatus: "excluded-by-allow",
      policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z",
    });
    db.upsertRunUnitHead({
      runId, organization: "acme", repository: "mobile", branch: "archive-2019", commitSha: "",
      status: "past-cap", isDefaultBranch: false, policyStatus: null,
      policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z",
    });
    // whole-module usage, a CLI invocation, and a HOSTILE snippet (formula + comma + quote)
    db.upsertUsageFinding({
      runId, organization: "acme", repository: "web", branch: "main",
      commitSha: "1111111111111111111111111111111111111111", packageName: "expo", dependencyKey: "expo",
      usageType: "namespace-import", exportName: "", context: "", filePath: "src/all.ts", lineNumber: 2,
      permalink: "https://github.com/acme/web/blob/1111111111111111111111111111111111111111/src/all.ts#L2",
      snippet: '=cmd|\' /C calc\'!A0, "quoted", import * as Expo from "expo";', foundAt: T,
    });
    db.upsertUsageFinding({
      runId, organization: "acme", repository: "web", branch: "main",
      commitSha: "1111111111111111111111111111111111111111", packageName: "expo", dependencyKey: "",
      usageType: "cli", exportName: "", context: "scripts.start", filePath: "package.json", lineNumber: 7,
      permalink: "https://github.com/acme/web/blob/1111111111111111111111111111111111111111/package.json#L7",
      snippet: '"start": "expo start"', foundAt: T,
    });
    for (const version of ["50.0.4", "50.0.7"]) {
      db.writeApiSurface({
        packageName: "expo", version, versionSource: "lockfile",
        rows: [
          { exportName: "registerRootComponent", exportKind: "named", source: "build/Expo.d.ts" },
          { exportName: "unusedHelper", exportKind: "named", source: "build/Expo.d.ts" },
          { exportName: "expo", exportKind: "cli-bin", source: "package.json#bin" },
        ],
      });
    }
    db.finalizeRun(runId, "complete"); // T5: the exported v4 run must be finalized (outcome='complete') to be valid
    exportRun(db, db.getRun(runId)!, outputDir, { raw: false });
    return { runId };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const { runId } = generateFixtureExports("./output");
  process.stderr.write(`fixture exports written to ./output/xray (run ${runId})\n`);
}
