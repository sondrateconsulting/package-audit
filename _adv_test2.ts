import { Database } from "bun:sqlite";
import { AuditDb } from "./scripts/db.ts";
import { buildCompare } from "./scripts/compare.ts";
import { exportRun } from "./scripts/export.ts";
import { rmSync, copyFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataExisted = existsSync("./data");
const advRoot = `./data/.advtest2-${process.pid}`;
mkdirSync(advRoot, { recursive: true });

try {
const dbPath = join(advRoot, "base.db");

const db = AuditDb.open({ sqlitePath: dbPath });
const { runId: runIdA } = db.startRun({ configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" });
db.upsertRunUnitHead({ runId: runIdA, organization: "org-a", repository: "svc", branch: "main", commitSha: "abc123", status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
db.completeRun(runIdA);
const { runId: runIdB } = db.startRun({ configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" });
db.upsertRunUnitHead({ runId: runIdB, organization: "org-a", repository: "svc", branch: "main", commitSha: "abc456", status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-07-01T12:00:00Z" });
db.completeRun(runIdB);
db.close();

// Test a few representative shapes against compare and export
const shapes: [string, string, string, number|null, string|null, string|null, string|null][] = [
  ["unknown-status", "", "deferred", 0, null, null, "2025-01-01T00:00:00Z"],
  ["scanned-no-commit", "", "scanned", 0, null, null, "2025-01-01T00:00:00Z"],
  ["policy-excluded-default", "", "policy-excluded", 1, "excluded-by-deny", "rel*", "2025-01-01T00:00:00Z"],
  ["default-two", "sha6", "scanned", 2, null, null, "2025-01-01T00:00:00Z"],
];

let allPassed = true;
for (const [name, commitSha, status, isDefault, policyStatus, pattern, scd] of shapes) {
  // Test against buildCompare
  const testDb = join(advRoot, `cmp-${name}.db`);
  copyFileSync(dbPath, testDb);
  
  const forge = new Database(testDb, { strict: true });
  forge.exec("PRAGMA ignore_check_constraints = ON");
  try {
    forge.query(
      `INSERT INTO run_unit_head (run_id, organization, repository, branch, commit_sha, status, is_default_branch, policy_status, policy_matched_pattern, scanned_commit_date) VALUES (?, 'org-a', 'svc', 'forged', ?, ?, ?, ?, ?, ?)`
    ).run(runIdB, commitSha, status, isDefault, policyStatus, pattern, scd);
  } catch(e: any) {
    console.log(`[FORGE-FAIL] compare-${name}: ${e.message}`);
    forge.close();
    continue;
  }
  forge.close();
  
  const db2 = AuditDb.open({ sqlitePath: testDb });
  const runA = db2.getRun(runIdA)!;
  const runB = db2.getRun(runIdB)!;
  try {
    buildCompare(db2, runA, runB);
    console.log(`[LEAK] compare-${name}: buildCompare ACCEPTED a malformed row!`);
    allPassed = false;
  } catch(e: any) {
    console.log(`[BLOCKED] compare-${name}: ${e.message.slice(0, 120)}`);
  }
  db2.close();

  // Test against exportRun (non-raw)
  const testDb2 = join(advRoot, `exp-${name}.db`);
  copyFileSync(dbPath, testDb2);
  const forge2 = new Database(testDb2, { strict: true });
  forge2.exec("PRAGMA ignore_check_constraints = ON");
  try {
    forge2.query(
      `INSERT INTO run_unit_head (run_id, organization, repository, branch, commit_sha, status, is_default_branch, policy_status, policy_matched_pattern, scanned_commit_date) VALUES (?, 'org-a', 'svc', 'forged', ?, ?, ?, ?, ?, ?)`
    ).run(runIdB, commitSha, status, isDefault, policyStatus, pattern, scd);
  } catch(e: any) {
    console.log(`[FORGE-FAIL] export-${name}: ${e.message}`);
    forge2.close();
    continue;
  }
  forge2.close();
  
  const db3 = AuditDb.open({ sqlitePath: testDb2 });
  const runE = db3.getRun(runIdB)!;
  const out = mkdtempSync(join(tmpdir(), "export-adv-"));
  try {
    exportRun(db3, runE, out, { raw: false });
    console.log(`[LEAK] export-${name}: exportRun ACCEPTED a malformed row!`);
    allPassed = false;
  } catch(e: any) {
    console.log(`[BLOCKED] export-${name}: ${e.message.slice(0, 120)}`);
  }
  db3.close();
  rmSync(out, { recursive: true, force: true });
  
  // Verify --raw escape hatch PASSES
  const db4 = AuditDb.open({ sqlitePath: testDb2 });
  const runR = db4.getRun(runIdB)!;
  const out2 = mkdtempSync(join(tmpdir(), "export-raw-adv-"));
  try {
    exportRun(db4, runR, out2, { raw: true });
    console.log(`[RAW-OK] export-raw-${name}: --raw correctly allowed the forged row`);
  } catch(e: any) {
    console.log(`[RAW-BLOCKED] export-raw-${name}: ${e.message.slice(0, 120)}`);
    allPassed = false;
  }
  db4.close();
  rmSync(out2, { recursive: true, force: true });
}

console.log(allPassed ? "\nAll surfaces blocked + raw escape works." : "\nSOME SURFACES LEAKED!");

} finally {
  rmSync(advRoot, { recursive: true, force: true });
  if (!dataExisted && existsSync("./data") && readdirSync("./data").length === 0) rmSync("./data", { recursive: true });
}
