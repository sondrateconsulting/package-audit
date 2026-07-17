// testFixtures.ts — shared database fixtures for the TEST SUITE ONLY (imported by *.test.ts
// files; never by production code). Lives outside the test files themselves because importing
// one .test.ts from another would register its tests twice under `bun test`.

import { Database } from "bun:sqlite";

// Downgrade a freshly-created CURRENT-version audit database at `sqlitePath` into a FAITHFUL v2
// file: run_unit_head rebuilt to its TRUE v2 era body, then stamped 2. A current-schema table
// cannot be column-dropped into an era shape (its table-level CHECKs reference the policy
// columns and no ALTER can un-widen the status CHECK), and a non-era-shaped file is refused as
// not-ours — which is a different test's contract than the too-old refusal these fixtures
// exercise (ownership precedes the version gate on the read path).
export function downgradeToFaithfulV2(sqlitePath: string): void {
  const bump = new Database(sqlitePath, { strict: true });
  bump.exec(`CREATE TABLE run_unit_head__v2 (
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    organization TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'scanned'
      CHECK (status IN ('scanned','skipped-cutoff')),
    PRIMARY KEY (run_id, organization, repository, branch))`);
  bump.exec(`INSERT INTO run_unit_head__v2 (run_id, organization, repository, branch, commit_sha, status)
    SELECT run_id, organization, repository, branch, commit_sha, status FROM run_unit_head`);
  bump.exec("DROP TABLE run_unit_head");
  bump.exec("ALTER TABLE run_unit_head__v2 RENAME TO run_unit_head");
  bump.exec("CREATE INDEX IF NOT EXISTS ix_ruh_loc ON run_unit_head(organization, repository, branch, commit_sha)");
  bump.exec("PRAGMA user_version = 2");
  bump.close();
}
