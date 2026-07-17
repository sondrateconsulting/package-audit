import { Database } from "bun:sqlite";
import { AuditDb } from "./scripts/db.ts";
import { buildReport } from "./scripts/report.ts";
import { buildCompare } from "./scripts/compare.ts";
import { exportRun } from "./scripts/export.ts";
import { mkdtempSync, rmSync, copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataExisted = existsSync("./data");
const advRoot = `./data/.advtest-${process.pid}`;
mkdirSync(advRoot, { recursive: true });

try {
const dbPath = join(advRoot, "base.db");

const db = AuditDb.open({ sqlitePath: dbPath });
const { runId } = db.startRun({ configHash: "h", effectiveOwners: ["org-a"], ownersSource: "discovered", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" });
db.upsertRunUnitHead({ runId, organization: "org-a", repository: "svc", branch: "main", commitSha: "abc123", status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
db.completeRun(runId);
db.close();

const shapes: [string, string, string, number|null, string|null, string|null, string|null][] = [
  ["cutoff-policy-null-date", "", "skipped-cutoff", 0, "excluded-by-deny", "test*", null],
  ["scanned-null-default-policy", "sha2", "scanned", null, "excluded-by-allow", null, "2025-01-01T00:00:00Z"],
  ["policy-excluded-null-date", "", "policy-excluded", 0, "excluded-by-deny", "x*", null],
  ["default-negative", "sha3", "scanned", -1, null, null, "2025-01-01T00:00:00Z"],
  ["scanned-no-commit", "", "scanned", 0, null, null, "2025-01-01T00:00:00Z"],
  ["past-cap-has-commit", "sha4", "past-cap", 0, null, null, "2025-01-01T00:00:00Z"],
  ["unknown-status", "", "deferred", 0, null, null, "2025-01-01T00:00:00Z"],
  ["policy-excluded-no-verdict", "", "policy-excluded", 0, null, null, "2025-01-01T00:00:00Z"],
  ["policy-excluded-default", "", "policy-excluded", 1, "excluded-by-deny", "rel*", "2025-01-01T00:00:00Z"],
  ["allow-with-pattern", "", "policy-excluded", 0, "excluded-by-allow", "rel*", "2025-01-01T00:00:00Z"],
  ["bogus-policy", "", "policy-excluded", 0, "excluded-by-vibes", null, "2025-01-01T00:00:00Z"],
  ["scanned-policy-not-default", "sha5", "scanned", 0, "excluded-by-deny", "rel*", "2025-01-01T00:00:00Z"],
  ["default-two", "sha6", "scanned", 2, null, null, "2025-01-01T00:00:00Z"],
  ["garbage-date", "sha7", "scanned", 0, null, null, "not-a-date"],
  ["empty-deny-pattern", "", "policy-excluded", 0, "excluded-by-deny", "", "2025-01-01T00:00:00Z"],
  ["past-cap-null-default", "", "past-cap", null, null, null, "2025-01-01T00:00:00Z"],
  ["cutoff-with-commit", "sha8", "skipped-cutoff", 0, null, null, "2025-01-01T00:00:00Z"],
  ["native-default-cutoff", "", "skipped-cutoff", 1, null, null, "2025-01-01T00:00:00Z"],
  ["policy-excluded-null-default", "", "policy-excluded", null, "excluded-by-deny", "rel*", "2025-01-01T00:00:00Z"],
];

let allPassed = true;
for (const [name, commitSha, status, isDefault, policyStatus, pattern, scd] of shapes) {
  const testDb = join(advRoot, `adv-${name}.db`);
  copyFileSync(dbPath, testDb);
  
  const forge = new Database(testDb, { strict: true });
  forge.exec("PRAGMA ignore_check_constraints = ON");
  try {
    forge.query(
      `INSERT INTO run_unit_head (run_id, organization, repository, branch, commit_sha, status, is_default_branch, policy_status, policy_matched_pattern, scanned_commit_date) VALUES (?, 'org-a', 'svc', 'forged', ?, ?, ?, ?, ?, ?)`
    ).run(runId, commitSha, status, isDefault, policyStatus, pattern, scd);
  } catch(e: any) {
    console.log(`[FORGE-FAIL] ${name}: ${e.message}`);
    forge.close();
    continue;
  }
  forge.close();
  
  const db2 = AuditDb.open({ sqlitePath: testDb });
  const run = db2.getRun(runId);
  try {
    buildReport(db2, run!);
    console.log(`[LEAK] ${name}: buildReport ACCEPTED a malformed row!`);
    allPassed = false;
  } catch(e: any) {
    console.log(`[BLOCKED] ${name}: ${e.message.slice(0, 150)}`);
  }
  db2.close();
}

console.log(allPassed ? "\nAll adversarial shapes blocked by buildReport." : "\nSOME SHAPES LEAKED!");

} finally {
  rmSync(advRoot, { recursive: true, force: true });
  if (!dataExisted && existsSync("./data") && readdirSync("./data").length === 0) rmSync("./data", { recursive: true });
}
