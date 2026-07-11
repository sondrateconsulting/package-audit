import { expect, test, describe, afterAll, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { rmSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditDb, DbError, SCHEMA_VERSION, SURFACE_SCHEMA_VERSION, mapReadOnlyOpenError, nowIso, type RunInput } from "./db.ts";
import { buildReport } from "./report.ts";
import { ReadOnlyViolation } from "./readOnlyGuard.ts";

// File-backed tests must live under ./data (§0 write containment is enforced by AuditDb.open).
const TEST_ROOT = `./data/.dbtest-${process.pid}-${Math.random().toString(36).slice(2)}`;
const DATA_EXISTED_BEFORE = existsSync("./data");
mkdirSync(TEST_ROOT, { recursive: true });
afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  // Leave the checkout the way we found it: on a fresh clone the recursive mkdir above created
  // ./data itself, and a leftover empty ./data pollutes the operator's zero-write verification
  // (a tree diff after `bun test` + `--plan` would show a dir the PRODUCT never made).
  if (!DATA_EXISTED_BEFORE && existsSync("./data") && readdirSync("./data").length === 0) rmSync("./data", { recursive: true });
});
let fileCounter = 0;
const nextFile = (): string => join(TEST_ROOT, `db-${fileCounter++}.db`);

const mem = (): AuditDb => AuditDb.open({ sqlitePath: ":memory:" });

// Test-only reach-in to the private connection: production code has NO writable raw handle
// (db.ts is the write boundary; reads go through the guarded read() facade) — fixtures here
// deliberately bypass it to set up states the public API refuses to create.
const raw = (db: AuditDb): Database => (db as unknown as { db: Database }).db;

const runInput = (overrides: Partial<RunInput> = {}): RunInput => ({
  configHash: "hash-1",
  effectiveOwners: ["org-a"],
  ownersSource: "discovered",
  trackedPackages: ["expo"],
  cutoffDate: "2024-01-01",
  githubHost: "github.com",
  ...overrides,
});

// Insert a runs row directly (for FK targets and startup-rule scenarios).
function rawRun(
  db: AuditDb,
  runId: string,
  status: string,
  configHash = "hash-1",
  startedAt = "2024-01-01T00:00:00.000Z",
): void {
  raw(db)
    .query(
      `INSERT INTO runs (run_id, started_at, config_hash, status) VALUES (?, ?, ?, ?)`,
    )
    .run(runId, startedAt, configHash, status);
}

const depFinding = (db: AuditDb, overrides: Record<string, unknown> = {}) =>
  db.upsertDependencyFinding({
    runId: "r1",
    organization: "org-a",
    repository: "repo",
    branch: "main",
    commitSha: "abc123",
    dateFetched: "2024-06-01T00:00:00.000Z",
    packageName: "expo",
    dependencyKey: "expo",
    dependencyType: "dependencies",
    manifestPath: "package.json",
    manifestLine: 12,
    manifestPermalink: "https://github.com/org-a/repo/blob/abc123/package.json#L12",
    declaredVersion: "^50.0.0",
    ...overrides,
  } as Parameters<AuditDb["upsertDependencyFinding"]>[0]);

describe("setRangeResolvedVersion (§5.E write-back)", () => {
  const key = {
    organization: "org-a", repository: "repo", branch: "main", commitSha: "abc123",
    packageName: "expo", dependencyKey: "expo", dependencyType: "dependencies" as const, manifestPath: "package.json",
  };
  test("writes a version onto a NULL-resolved row and marks it range-resolved", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    depFinding(db); // resolved_version defaults to null
    expect(db.setRangeResolvedVersion(key, "50.0.7")).toBe(true);
    const row = db.read(`SELECT resolved_version, resolved_version_source FROM dependency_findings`).get() as { resolved_version: string; resolved_version_source: string };
    expect(row).toEqual({ resolved_version: "50.0.7", resolved_version_source: "range-resolved" });
    db.close();
  });
  test("NEVER clobbers a lockfile-resolved row", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    depFinding(db, { resolvedVersion: "50.0.0", resolvedVersionSource: "lockfile" });
    expect(db.setRangeResolvedVersion(key, "99.9.9")).toBe(false); // guarded by resolved_version IS NULL
    const row = db.read(`SELECT resolved_version, resolved_version_source FROM dependency_findings`).get() as { resolved_version: string; resolved_version_source: string };
    expect(row).toEqual({ resolved_version: "50.0.0", resolved_version_source: "lockfile" });
    db.close();
  });
  test("does NOT range-resolve a row with a GOVERNING lockfile that left it unresolved (peer)", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    depFinding(db, { lockfilePath: "package-lock.json", lockfileKind: "npm" }); // resolved_version stays null
    expect(db.setRangeResolvedVersion(key, "50.0.7")).toBe(false); // guarded by lockfile_path IS NULL
    const row = db.read(`SELECT resolved_version FROM dependency_findings`).get() as { resolved_version: string | null };
    expect(row.resolved_version).toBeNull();
    db.close();
  });
});

describe("open — fresh create", () => {
  test("creates the full schema at SCHEMA_VERSION with WAL + FK on", () => {
    const db = AuditDb.open({ sqlitePath: nextFile() });
    const version = (raw(db).query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(version).toBe(SCHEMA_VERSION);
    const mode = (raw(db).query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    expect(mode).toBe("wal");
    const fk = (raw(db).query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
    expect(fk).toBe(1);
    const tables = (
      raw(db).query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
    ).map((r) => r.name).sort();
    expect(tables).toEqual([
      "api_cache", "dependency_findings", "errors", "package_api_surface",
      "run_unit_head", "runs", "usage_findings", "work_queue",
    ]);
    db.close();
  });

  test("WAL sidecar files land inside the contained directory", () => {
    const path = nextFile();
    const db = AuditDb.open({ sqlitePath: path });
    db.startRun(runInput()); // force a write so the -wal file exists
    expect(existsSync(`${path}-wal`)).toBe(true); // same contained dir as the main db file
    db.close();
  });

  test("reopen is idempotent and preserves rows", () => {
    const path = nextFile();
    const db1 = AuditDb.open({ sqlitePath: path });
    const { runId } = db1.startRun(runInput());
    db1.completeRun(runId);
    db1.close();
    const db2 = AuditDb.open({ sqlitePath: path });
    expect(db2.getRun(runId)?.status).toBe("completed");
    db2.close();
  });

  test("rejects a sqlite path outside ./data and ./output", () => {
    expect(() => AuditDb.open({ sqlitePath: "/tmp/escape.db" })).toThrow(ReadOnlyViolation);
    expect(() => AuditDb.open({ sqlitePath: "./escape.db" })).toThrow(ReadOnlyViolation);
  });

  test("refuses to adopt a non-audit SQLite database", () => {
    const path = nextFile();
    const raw = new Database(path, { create: true });
    raw.exec("CREATE TABLE not_audit (x TEXT)");
    raw.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
  });

  test("refuses a database stamped with a NEWER schema version", () => {
    const path = nextFile();
    const raw = new Database(path, { create: true });
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
  });
});

// ---- migration (§3 run-scoped-reset) --------------------------------------------------------
const LEGACY_DDL = `
CREATE TABLE runs (run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
  config_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('running','completed','failed')));
CREATE TABLE work_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
  organization TEXT NOT NULL, repository TEXT, branch TEXT, last_commit_sha TEXT,
  last_commit_date TEXT, status TEXT NOT NULL, error_message TEXT, updated_at TEXT NOT NULL);
CREATE TABLE dependency_findings (id INTEGER PRIMARY KEY AUTOINCREMENT, organization TEXT NOT NULL,
  repository TEXT NOT NULL, branch TEXT NOT NULL, commit_sha TEXT NOT NULL, date_fetched TEXT NOT NULL,
  package_name TEXT NOT NULL, dependency_key TEXT NOT NULL, dependency_type TEXT NOT NULL,
  manifest_path TEXT NOT NULL, manifest_line INTEGER NOT NULL, manifest_permalink TEXT NOT NULL,
  declared_version TEXT NOT NULL, lockfile_path TEXT, lockfile_kind TEXT, lockfile_lines TEXT,
  lockfile_permalink TEXT, resolved_version TEXT);
CREATE TABLE usage_findings (id INTEGER PRIMARY KEY AUTOINCREMENT, organization TEXT NOT NULL,
  repository TEXT NOT NULL, branch TEXT NOT NULL, commit_sha TEXT NOT NULL, package_name TEXT NOT NULL,
  dependency_key TEXT NOT NULL DEFAULT '', usage_type TEXT NOT NULL, export_name TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL, line_number INTEGER NOT NULL, permalink TEXT NOT NULL, snippet TEXT NOT NULL,
  found_at TEXT NOT NULL);
CREATE TABLE package_api_surface (id INTEGER PRIMARY KEY AUTOINCREMENT, package_name TEXT NOT NULL,
  version TEXT NOT NULL, export_name TEXT NOT NULL, export_kind TEXT NOT NULL, source TEXT NOT NULL,
  introspected_at TEXT NOT NULL, UNIQUE(package_name, version, export_name, export_kind));
CREATE TABLE run_unit_head (run_id TEXT NOT NULL REFERENCES runs(run_id), organization TEXT NOT NULL,
  repository TEXT NOT NULL, branch TEXT NOT NULL, commit_sha TEXT NOT NULL,
  PRIMARY KEY (run_id, organization, repository, branch));
CREATE TABLE api_cache (url TEXT PRIMARY KEY, etag TEXT, response_body TEXT, cached_at TEXT NOT NULL);
CREATE TABLE errors (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, organization TEXT,
  repository TEXT, branch TEXT, message TEXT NOT NULL, occurred_at TEXT NOT NULL);
`;

function buildLegacyDb(path: string): void {
  const raw = new Database(path, { create: true });
  raw.exec(LEGACY_DDL);
  raw.exec(`INSERT INTO runs VALUES ('old-running', '2024-01-01T00:00:00.000Z', NULL, 'h-old', 'running')`);
  raw.exec(`INSERT INTO runs VALUES ('old-done', '2024-01-02T00:00:00.000Z', '2024-01-02T01:00:00.000Z', 'h-old', 'completed')`);
  raw.exec(`INSERT INTO work_queue (scope, organization, status, updated_at) VALUES ('org', 'org-a', 'done', '2024-01-02T00:00:00.000Z')`);
  raw.exec(`INSERT INTO dependency_findings (organization, repository, branch, commit_sha, date_fetched,
    package_name, dependency_key, dependency_type, manifest_path, manifest_line, manifest_permalink, declared_version)
    VALUES ('org-a', 'r', 'main', 'sha1', '2024-01-02T00:00:00.000Z', 'expo', 'expo', 'dependencies', 'package.json', 1, 'x', '^1')`);
  raw.exec(`INSERT INTO usage_findings (organization, repository, branch, commit_sha, package_name,
    usage_type, file_path, line_number, permalink, snippet, found_at)
    VALUES ('org-a', 'r', 'main', 'sha1', 'expo', 'named-import', 'src/a.ts', 3, 'x', 's', '2024-01-02T00:00:00.000Z')`);
  raw.exec(`INSERT INTO package_api_surface (package_name, version, export_name, export_kind, source, introspected_at)
    VALUES ('expo', '50.0.0', 'registerRootComponent', 'named', 'build/Expo.d.ts', '2024-01-02T00:00:00.000Z')`);
  raw.exec(`INSERT INTO run_unit_head VALUES ('old-done', 'org-a', 'r', 'main', 'sha1')`);
  raw.exec(`INSERT INTO api_cache VALUES ('https://api.github.com/x', 'W/"etag1"', '{"a":1}', '2024-01-02T00:00:00.000Z')`);
  raw.exec(`INSERT INTO errors (scope, message, occurred_at) VALUES ('repo', 'boom', '2024-01-02T00:00:00.000Z')`);
  raw.exec("PRAGMA user_version = 1");
  raw.close();
}

describe("migration — legacy v1 → current", () => {
  const path = nextFile();
  buildLegacyDb(path);
  const db = AuditDb.open({ sqlitePath: path });
  afterAll(() => db.close());

  test("bumps user_version", () => {
    const v = (raw(db).query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBe(SCHEMA_VERSION);
  });

  test("api_cache rows are PRESERVED and backfilled (method='GET', variant_hash='')", () => {
    const entry = db.getApiCache("GET", "https://api.github.com/x", "");
    expect(entry).not.toBeNull();
    expect(entry!.etag).toBe('W/"etag1"');
    expect(entry!.responseBody).toBe('{"a":1}');
    expect(entry!.cachedAt).toBe("2024-01-02T00:00:00.000Z");
  });

  test("run-scoped tables are rebuilt EMPTY in the new shape", () => {
    for (const t of ["dependency_findings", "usage_findings", "errors", "work_queue"]) {
      const n = (raw(db).query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect(n).toBe(0);
    }
    // new-shape columns exist (would throw if missing)
    raw(db).query("SELECT run_id, resolved_version_source FROM dependency_findings").all();
    raw(db).query("SELECT run_id, context FROM usage_findings").all();
    raw(db).query("SELECT run_id, package_name, version FROM errors").all();
    raw(db).query("SELECT config_hash, created_run_id, last_run_id FROM work_queue").all();
  });

  test("runs are preserved; every pre-migration running run is failed; defaults applied", () => {
    const oldRunning = db.getRun("old-running");
    expect(oldRunning?.status).toBe("failed");
    const oldDone = db.getRun("old-done");
    expect(oldDone?.status).toBe("completed");
    expect(oldDone?.trackedPackages).toEqual([]); // '[]' — pre-migration runs are non-reportable
    expect(oldDone?.effectiveOwners).toEqual([]);
    expect(oldDone?.ownersSource).toBe("discovered");
    expect(oldDone?.githubHost).toBe("github.com");
  });

  test("package_api_surface preserved with version_source default 'lockfile'", () => {
    const row = raw(db)
      .query("SELECT version_source, export_name FROM package_api_surface WHERE package_name='expo'")
      .get() as { version_source: string; export_name: string };
    expect(row.version_source).toBe("lockfile");
    expect(row.export_name).toBe("registerRootComponent");
  });

  test("run_unit_head preserved with status default 'scanned'", () => {
    const row = raw(db)
      .query("SELECT status, commit_sha FROM run_unit_head WHERE run_id='old-done'")
      .get() as { status: string; commit_sha: string };
    expect(row.status).toBe("scanned");
    expect(row.commit_sha).toBe("sha1");
  });

  test("run_unit_head keeps its run_id FK to runs through the additive ALTER", () => {
    const fks = raw(db).query("PRAGMA foreign_key_list(run_unit_head)").all() as Array<{
      table: string;
      from: string;
    }>;
    expect(fks.some((fk) => fk.table === "runs" && fk.from === "run_id")).toBe(true);
  });

  test("pre-migration runs are NOT reportable (empty tracked_packages)", () => {
    expect(db.latestReportableRun()).toBeNull();
  });

  test("the chain continues past v2: preserved heads gain is_default_branch = NULL (unknown)", () => {
    const row = raw(db)
      .query("SELECT is_default_branch FROM run_unit_head WHERE run_id='old-done'")
      .get() as { is_default_branch: unknown };
    expect(row.is_default_branch).toBeNull();
  });
});

// Synchronous stdout JSONL capture (open() is sync — orchestrate.test.ts's helper is async).
// Keeps the E3 fresh-drop warning out of the test runner's real stdout, and returns the
// parsed events for the warning suites below.
function captureStdout(fn: () => void): Array<Record<string, unknown>> {
  const chunks: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("--fresh / --purge-cache", () => {
  test("--fresh drops run-scoped data but preserves the caches", () => {
    const path = nextFile();
    const db1 = AuditDb.open({ sqlitePath: path });
    const { runId } = db1.startRun(runInput());
    depFinding(db1, { runId });
    db1.putApiCache({ method: "GET", url: "u", variantHash: "", etag: "e", responseBody: "b" });
    db1.writeApiSurface({ packageName: "expo", version: "50.0.0", versionSource: "lockfile", rows: [] });
    db1.completeRun(runId);
    db1.close();

    let db2!: AuditDb;
    captureStdout(() => {
      db2 = AuditDb.open({ sqlitePath: path, fresh: true });
    });
    expect(db2.getRun(runId)).toBeNull();
    const deps = (raw(db2).query("SELECT COUNT(*) AS n FROM dependency_findings").get() as { n: number }).n;
    expect(deps).toBe(0);
    expect(db2.getApiCache("GET", "u", "")).not.toBeNull();
    expect(db2.hasCompletionMarker("expo", "50.0.0")).toBe(true);
    db2.close();
  });

  test("--fresh --purge-cache also drops api_cache and package_api_surface", () => {
    const path = nextFile();
    const db1 = AuditDb.open({ sqlitePath: path });
    db1.putApiCache({ method: "GET", url: "u", variantHash: "", etag: "e", responseBody: "b" });
    db1.writeApiSurface({ packageName: "expo", version: "50.0.0", versionSource: "lockfile", rows: [] });
    db1.close();

    const db2 = AuditDb.open({ sqlitePath: path, fresh: true, purgeCache: true });
    expect(db2.getApiCache("GET", "u", "")).toBeNull();
    expect(db2.hasCompletionMarker("expo", "50.0.0")).toBe(false);
    db2.close();
  });
});

describe("run lifecycle — startup rules (§3)", () => {
  test("new run persists the full config echo", () => {
    const db = mem();
    const { runId, resumed } = db.startRun(runInput());
    expect(resumed).toBe(false);
    const run = db.getRun(runId)!;
    expect(run.status).toBe("running");
    expect(run.completedAt).toBeNull();
    expect(run.configHash).toBe("hash-1");
    expect(run.effectiveOwners).toEqual(["org-a"]);
    expect(run.ownersSource).toBe("discovered");
    expect(run.trackedPackages).toEqual(["expo"]);
    expect(run.cutoffDate).toBe("2024-01-01");
    expect(run.githubHost).toBe("github.com");
    db.close();
  });

  test("same-hash running run is resumed; owners snapshot refreshed", () => {
    const db = mem();
    const first = db.startRun(runInput({ effectiveOwners: ["org-a"] }));
    const second = db.startRun(runInput({ effectiveOwners: ["org-a", "org-b"] }));
    expect(second.resumed).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(db.getRun(first.runId)?.effectiveOwners).toEqual(["org-a", "org-b"]);
    db.close();
  });

  test("most recent same-hash running run wins; older ones are failed", () => {
    const db = mem();
    rawRun(db, "run-old", "running", "hash-1", "2024-01-01T00:00:00.000Z");
    rawRun(db, "run-new", "running", "hash-1", "2024-01-02T00:00:00.000Z");
    const res = db.startRun(runInput());
    expect(res).toEqual({ runId: "run-new", resumed: true });
    expect(db.getRun("run-old")?.status).toBe("failed");
    db.close();
  });

  test("started_at tie breaks on run_id DESC for determinism", () => {
    const db = mem();
    rawRun(db, "run-aaa", "running", "hash-1", "2024-01-01T00:00:00.000Z");
    rawRun(db, "run-zzz", "running", "hash-1", "2024-01-01T00:00:00.000Z");
    const res = db.startRun(runInput());
    expect(res.runId).toBe("run-zzz");
    expect(db.getRun("run-aaa")?.status).toBe("failed");
    db.close();
  });

  test("running runs under a DIFFERENT config_hash are failed, never resumed", () => {
    const db = mem();
    rawRun(db, "run-other", "running", "hash-other");
    const res = db.startRun(runInput());
    expect(res.resumed).toBe(false);
    expect(db.getRun("run-other")?.status).toBe("failed");
    db.close();
  });

  test("self-healing: in_progress units of failed or resumed runs reset to pending", () => {
    const db = mem();
    rawRun(db, "run-dead", "failed", "hash-1");
    rawRun(db, "run-live", "running", "hash-1", "2024-02-01T00:00:00.000Z");
    rawRun(db, "run-done", "completed", "hash-1");
    // owned by an already-failed run (crash between fail-marking and reset)
    db.enqueueUnit({ configHash: "hash-1", scope: "org", organization: "o1" }, "run-dead");
    db.setUnitStatus({ configHash: "hash-1", scope: "org", organization: "o1" }, { status: "in_progress", runId: "run-dead" });
    // owned by the run about to be resumed
    db.enqueueUnit({ configHash: "hash-1", scope: "org", organization: "o2" }, "run-live");
    db.setUnitStatus({ configHash: "hash-1", scope: "org", organization: "o2" }, { status: "in_progress", runId: "run-live" });
    // owned by a completed run — NOT reset
    db.enqueueUnit({ configHash: "hash-1", scope: "org", organization: "o3" }, "run-done");
    db.setUnitStatus({ configHash: "hash-1", scope: "org", organization: "o3" }, { status: "in_progress", runId: "run-done" });
    // a different config's unit — NOT reset even though its owner failed
    db.enqueueUnit({ configHash: "hash-2", scope: "org", organization: "o4" }, "run-dead");
    db.setUnitStatus({ configHash: "hash-2", scope: "org", organization: "o4" }, { status: "in_progress", runId: "run-dead" });

    const res = db.startRun(runInput());
    expect(res).toEqual({ runId: "run-live", resumed: true });
    expect(db.getUnit({ configHash: "hash-1", scope: "org", organization: "o1" })?.status).toBe("pending");
    expect(db.getUnit({ configHash: "hash-1", scope: "org", organization: "o2" })?.status).toBe("pending");
    expect(db.getUnit({ configHash: "hash-1", scope: "org", organization: "o3" })?.status).toBe("in_progress");
    expect(db.getUnit({ configHash: "hash-2", scope: "org", organization: "o4" })?.status).toBe("in_progress");
    db.close();
  });

  test("completeRun sets completed_at; failRun leaves it NULL", () => {
    const db = mem();
    const a = db.startRun(runInput()).runId;
    db.completeRun(a);
    const doneRun = db.getRun(a)!;
    expect(doneRun.status).toBe("completed");
    expect(doneRun.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const b = db.startRun(runInput()).runId;
    db.failRun(b);
    const failedRun = db.getRun(b)!;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.completedAt).toBeNull();
    db.close();
  });

  test("latestReportableRun: completed + non-empty tracked_packages, latest first", () => {
    const db = mem();
    expect(db.latestReportableRun()).toBeNull();
    const a = db.startRun(runInput()).runId;
    db.completeRun(a);
    // an empty-tracked (pre-migration-shaped) completed run must never win
    raw(db)
      .query(
        `INSERT INTO runs (run_id, started_at, config_hash, tracked_packages, status)
         VALUES ('pre-migration', '2099-01-01T00:00:00.000Z', 'h', '[]', 'completed')`,
      )
      .run();
    expect(db.latestReportableRun()?.runId).toBe(a);
    db.close();
  });
});

describe("work_queue", () => {
  test("enqueue inserts pending with '' sentinels; re-enqueue keeps status and stored head", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    rawRun(db, "r2", "running");
    const key = { configHash: "hash-1", scope: "branch" as const, organization: "o", repository: "r", branch: "main" };
    db.enqueueUnit(key, "r1");
    db.setUnitStatus(key, { status: "done", runId: "r1", lastCommitSha: "sha-abc" });
    db.enqueueUnit(key, "r2"); // must NOT clobber status or the stored head (§3 skip predicate)
    const unit = db.getUnit(key)!;
    expect(unit.status).toBe("done");
    expect(unit.lastCommitSha).toBe("sha-abc");
    expect(unit.lastRunId).toBe("r2");
    expect(unit.createdRunId).toBe("r1");
    db.close();
  });

  test("scope-shape CHECK constraints reject malformed units", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    expect(() =>
      db.enqueueUnit({ configHash: "h", scope: "org", organization: "o", repository: "r" }, "r1"),
    ).toThrow();
    expect(() =>
      db.enqueueUnit({ configHash: "h", scope: "branch", organization: "o", repository: "r" }, "r1"),
    ).toThrow(); // branch scope requires branch<>''
    db.close();
  });

  test("setUnitStatus: sha/date update only when provided; errorMessage always overwrites", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    const key = { configHash: "h", scope: "branch" as const, organization: "o", repository: "r", branch: "b" };
    db.enqueueUnit(key, "r1");
    db.setUnitStatus(key, { status: "done", runId: "r1", lastCommitSha: "s1", lastCommitDate: "2024-01-01T00:00:00.000Z" });
    db.setUnitStatus(key, { status: "error", runId: "r1", errorMessage: "boom" });
    let unit = db.getUnit(key)!;
    expect(unit.lastCommitSha).toBe("s1"); // kept
    expect(unit.lastCommitDate).toBe("2024-01-01T00:00:00.000Z"); // kept
    expect(unit.errorMessage).toBe("boom");
    db.setUnitStatus(key, { status: "pending", runId: "r1", lastCommitDate: null });
    unit = db.getUnit(key)!;
    expect(unit.lastCommitDate).toBeNull(); // explicit null clears
    expect(unit.errorMessage).toBeNull(); // omitted errorMessage clears stale message
    db.close();
  });

  test("listUnits filters by status in insertion order", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    db.enqueueUnit({ configHash: "h", scope: "org", organization: "o1" }, "r1");
    db.enqueueUnit({ configHash: "h", scope: "org", organization: "o2" }, "r1");
    db.setUnitStatus({ configHash: "h", scope: "org", organization: "o2" }, { status: "done", runId: "r1" });
    expect(db.listUnits("h").map((u) => u.organization)).toEqual(["o1", "o2"]);
    expect(db.listUnits("h", "pending").map((u) => u.organization)).toEqual(["o1"]);
    expect(db.listUnits("other")).toEqual([]);
    db.close();
  });

  test("rescanBranch resets only the current config's branch row", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    const key = { configHash: "h1", scope: "branch" as const, organization: "o", repository: "r", branch: "main" };
    db.enqueueUnit(key, "r1");
    db.setUnitStatus(key, { status: "done", runId: "r1", lastCommitSha: "s" });
    db.enqueueUnit({ ...key, configHash: "h2" }, "r1");
    db.setUnitStatus({ ...key, configHash: "h2" }, { status: "done", runId: "r1" });
    expect(db.rescanBranch("h1", "o", "r", "main")).toBe(true);
    expect(db.getUnit(key)?.status).toBe("pending");
    expect(db.getUnit({ ...key, configHash: "h2" })?.status).toBe("done");
    expect(db.rescanBranch("h1", "o", "r", "nope")).toBe(false);
    db.close();
  });
});

describe("dependency_findings upserts", () => {
  test("upsert refreshes mutable fields without duplicating the row", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    rawRun(db, "r2", "running");
    depFinding(db, { runId: "r1" });
    depFinding(db, { runId: "r2", resolvedVersion: "50.0.1", resolvedVersionSource: "lockfile", lockfileLines: [10, 12] });
    const rows = raw(db).query("SELECT * FROM dependency_findings").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]!["run_id"]).toBe("r2");
    expect(rows[0]!["resolved_version"]).toBe("50.0.1");
    expect(rows[0]!["resolved_version_source"]).toBe("lockfile");
    expect(rows[0]!["lockfile_lines"]).toBe("[10,12]");
    db.close();
  });

  test("dependency_type participates in identity — peerDeps + devDeps are two findings", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    depFinding(db, { dependencyType: "peerDependencies" });
    depFinding(db, { dependencyType: "devDependencies" });
    const n = (raw(db).query("SELECT COUNT(*) AS n FROM dependency_findings").get() as { n: number }).n;
    expect(n).toBe(2);
    db.close();
  });

  test("foreign key to runs is enforced", () => {
    const db = mem();
    expect(() => depFinding(db, { runId: "ghost" })).toThrow();
    db.close();
  });
});

describe("usage_findings upserts", () => {
  const usage = (db: AuditDb, overrides: Record<string, unknown> = {}) =>
    db.upsertUsageFinding({
      runId: "r1",
      organization: "org-a",
      repository: "repo",
      branch: "main",
      commitSha: "abc123",
      packageName: "expo",
      dependencyKey: "expo",
      usageType: "named-import",
      exportName: "registerRootComponent",
      filePath: "src/index.ts",
      lineNumber: 3,
      permalink: "p",
      snippet: "s",
      foundAt: "2024-06-01T00:00:00.000Z",
      ...overrides,
    } as Parameters<AuditDb["upsertUsageFinding"]>[0]);

  test("upsert refreshes permalink/snippet/run_id without duplicating", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    rawRun(db, "r2", "running");
    usage(db);
    usage(db, { runId: "r2", snippet: "s2" });
    const rows = raw(db).query("SELECT run_id, snippet FROM usage_findings").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]!["run_id"]).toBe("r2");
    expect(rows[0]!["snippet"]).toBe("s2");
    db.close();
  });

  test("context distinguishes two CLI usages on one line (§3)", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    usage(db, { usageType: "cli", exportName: "", dependencyKey: "", context: "scripts.a" });
    usage(db, { usageType: "cli", exportName: "", dependencyKey: "", context: "scripts.b" });
    const n = (raw(db).query("SELECT COUNT(*) AS n FROM usage_findings").get() as { n: number }).n;
    expect(n).toBe(2);
    db.close();
  });

  test("defaults: dependency_key/export_name/context default to ''", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    usage(db, { dependencyKey: undefined, exportName: undefined, context: undefined, usageType: "side-effect-import" });
    const row = raw(db).query("SELECT dependency_key, export_name, context FROM usage_findings").get() as Record<string, string>;
    expect(row["dependency_key"]).toBe("");
    expect(row["export_name"]).toBe("");
    expect(row["context"]).toBe("");
    db.close();
  });
});

describe("errors + run_unit_head", () => {
  test("insertError stores nullable package/version keying (§5.E)", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    db.insertError({ runId: "r1", scope: "repo", organization: "o", repository: "r", message: "m1" });
    db.insertError({ runId: "r1", scope: "introspection", packageName: "expo", version: "50.0.0", message: "m2" });
    db.insertError({ runId: "r1", scope: "introspection", packageName: "expo", version: "git+ssh://x", message: "skip" });
    const rows = raw(db).query("SELECT package_name, version FROM errors ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(rows[0]!["package_name"]).toBeNull();
    expect(rows[1]!["version"]).toBe("50.0.0");
    expect(rows[2]!["version"]).toBe("git+ssh://x");
    db.close();
  });

  test("run_unit_head upserts per (run, unit); skipped-cutoff carries commit_sha=''", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    db.upsertRunUnitHead({ runId: "r1", organization: "o", repository: "r", branch: "b", commitSha: "", status: "skipped-cutoff", isDefaultBranch: null });
    db.upsertRunUnitHead({ runId: "r1", organization: "o", repository: "r", branch: "b", commitSha: "sha2", status: "scanned", isDefaultBranch: null });
    const rows = raw(db).query("SELECT commit_sha, status FROM run_unit_head").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]!["commit_sha"]).toBe("sha2");
    expect(rows[0]!["status"]).toBe("scanned");
    db.close();
  });
});

describe("api_cache", () => {
  test("variant_hash separates JSON-vs-raw reads of one URL", () => {
    const db = mem();
    db.putApiCache({ method: "GET", url: "u", variantHash: "json", etag: "e1", responseBody: "b1" });
    db.putApiCache({ method: "GET", url: "u", variantHash: "raw", etag: "e2", responseBody: "b2" });
    expect(db.getApiCache("GET", "u", "json")?.responseBody).toBe("b1");
    expect(db.getApiCache("GET", "u", "raw")?.responseBody).toBe("b2");
    expect(db.getApiCache("GET", "u", "")).toBeNull();
    db.close();
  });

  test("refuses non-GET writes (api_cache is REST-GET only, §3)", () => {
    const db = mem();
    expect(() =>
      db.putApiCache({ method: "POST", url: "u", variantHash: "", etag: null, responseBody: "b" }),
    ).toThrow(DbError);
    db.close();
  });

  test("put refreshes an existing entry", () => {
    const db = mem();
    db.putApiCache({ method: "GET", url: "u", variantHash: "", etag: "e1", responseBody: "b1" });
    db.putApiCache({ method: "GET", url: "u", variantHash: "", etag: "e2", responseBody: "b2" });
    const entry = db.getApiCache("GET", "u", "")!;
    expect(entry.etag).toBe("e2");
    expect(entry.responseBody).toBe("b2");
    const n = (raw(db).query("SELECT COUNT(*) AS n FROM api_cache").get() as { n: number }).n;
    expect(n).toBe(1);
    db.close();
  });
});

describe("package_api_surface (§5.E durable introspection)", () => {
  test("writeApiSurface writes rows + marker atomically; zero-surface still earns a marker", () => {
    const db = mem();
    db.writeApiSurface({
      packageName: "expo",
      version: "50.0.0",
      versionSource: "lockfile",
      rows: [
        { exportName: "registerRootComponent", exportKind: "named", source: "build/Expo.d.ts" },
        { exportName: "expo", exportKind: "cli-bin", source: "package.json#bin" },
      ],
    });
    expect(db.hasCompletionMarker("expo", "50.0.0")).toBe(true);
    expect(db.hasCompletionMarker("expo", "51.0.0")).toBe(false);
    const rows = raw(db)
      .query("SELECT export_name, export_kind, source FROM package_api_surface ORDER BY export_kind")
      .all() as Array<Record<string, string>>;
    expect(rows.length).toBe(3); // 2 rows + marker
    const marker = rows.find((r) => r["export_kind"] === "__complete__")!;
    expect(marker["export_name"]).toBe("");
    // §7 epoch: the marker's `source` carries the current surface schema version.
    expect(marker["source"]).toBe(`__complete__@${SURFACE_SCHEMA_VERSION}`);

    db.writeApiSurface({ packageName: "empty-pkg", version: "1.0.0", versionSource: "range-resolved", rows: [] });
    expect(db.hasCompletionMarker("empty-pkg", "1.0.0")).toBe(true);
    db.close();
  });

  test("re-introspection REPLACES the version's row set (no stale exports)", () => {
    const db = mem();
    // simulate a marker-less partial introspection left by a crash
    raw(db)
      .query(
        `INSERT INTO package_api_surface (package_name, version, version_source, export_name, export_kind, source, introspected_at)
         VALUES ('expo', '50.0.0', 'lockfile', 'staleExport', 'named', 'old.d.ts', '2024-01-01T00:00:00.000Z')`,
      )
      .run();
    db.writeApiSurface({
      packageName: "expo",
      version: "50.0.0",
      versionSource: "lockfile",
      rows: [{ exportName: "freshExport", exportKind: "named", source: "new.d.ts" }],
    });
    const names = (
      raw(db).query("SELECT export_name FROM package_api_surface WHERE export_kind='named'").all() as Array<{ export_name: string }>
    ).map((r) => r.export_name);
    expect(names).toEqual(["freshExport"]);
    db.close();
  });

  test("a mid-write failure rolls back the WHOLE surface write (no marker, DELETE undone)", () => {
    const db = mem();
    // pre-existing marker-less partial row — must SURVIVE a failed replacement attempt
    raw(db)
      .query(
        `INSERT INTO package_api_surface (package_name, version, version_source, export_name, export_kind, source, introspected_at)
         VALUES ('expo', '50.0.0', 'lockfile', 'partialExport', 'named', 'old.d.ts', '2024-01-01T00:00:00.000Z')`,
      )
      .run();
    expect(() =>
      db.writeApiSurface({
        packageName: "expo",
        version: "50.0.0",
        versionSource: "bogus" as never, // violates the version_source CHECK mid-transaction
        rows: [{ exportName: "x", exportKind: "named", source: "s" }],
      }),
    ).toThrow();
    const rows = raw(db)
      .query("SELECT export_name FROM package_api_surface WHERE package_name='expo'")
      .all() as Array<{ export_name: string }>;
    expect(rows.map((r) => r.export_name)).toEqual(["partialExport"]); // DELETE rolled back
    expect(db.hasCompletionMarker("expo", "50.0.0")).toBe(false); // no marker survived
    db.close();
  });

  test("rejects caller-supplied '__complete__' rows", () => {
    const db = mem();
    expect(() =>
      db.writeApiSurface({
        packageName: "x",
        version: "1.0.0",
        versionSource: "lockfile",
        rows: [{ exportName: "", exportKind: "__complete__" as never, source: "x" }],
      }),
    ).toThrow(DbError);
    db.close();
  });
});

describe("package_api_surface — §7 surface-cache epoch", () => {
  test("SURFACE_SCHEMA_VERSION starts at 2 so every pre-epoch marker misses", () => {
    expect(SURFACE_SCHEMA_VERSION).toBe(2);
  });

  test("a stale-epoch marker is treated as ABSENT; the current epoch short-circuits", () => {
    const db = mem();
    // a legacy bare '__complete__' marker (no epoch), as an OLD resolver would have written it.
    raw(db)
      .query(
        `INSERT INTO package_api_surface (package_name, version, version_source, export_name, export_kind, source, introspected_at)
         VALUES ('expo', '1.0.0', 'lockfile', '', '__complete__', '__complete__', '2024-01-01T00:00:00.000Z')`,
      )
      .run();
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(false);
    // a DIFFERENT stale epoch ('@1') also misses.
    raw(db)
      .query(
        `INSERT INTO package_api_surface (package_name, version, version_source, export_name, export_kind, source, introspected_at)
         VALUES ('expo', '2.0.0', 'lockfile', '', '__complete__', '__complete__@1', '2024-01-01T00:00:00.000Z')`,
      )
      .run();
    expect(db.hasCompletionMarker("expo", "2.0.0")).toBe(false);
    // writeApiSurface stamps the CURRENT epoch → short-circuits.
    db.writeApiSurface({ packageName: "expo", version: "1.0.0", versionSource: "lockfile", rows: [] });
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(true);
    db.close();
  });

  test("re-inspection REPLACES a stale-epoch marker + rows (no stale marker/row survives)", () => {
    const db = mem();
    raw(db)
      .query(
        `INSERT INTO package_api_surface (package_name, version, version_source, export_name, export_kind, source, introspected_at)
         VALUES ('expo', '1.0.0', 'lockfile', 'staleExport', 'named', 'old.d.ts', '2024-01-01T00:00:00.000Z')`,
      )
      .run();
    raw(db)
      .query(
        `INSERT INTO package_api_surface (package_name, version, version_source, export_name, export_kind, source, introspected_at)
         VALUES ('expo', '1.0.0', 'lockfile', '', '__complete__', '__complete__', '2024-01-01T00:00:00.000Z')`,
      )
      .run();
    db.writeApiSurface({
      packageName: "expo",
      version: "1.0.0",
      versionSource: "lockfile",
      rows: [{ exportName: "fresh", exportKind: "named", source: "new.d.ts" }],
    });
    const markers = raw(db)
      .query("SELECT source FROM package_api_surface WHERE export_kind='__complete__'")
      .all() as Array<{ source: string }>;
    expect(markers).toEqual([{ source: `__complete__@${SURFACE_SCHEMA_VERSION}` }]); // exactly one, current epoch
    const named = (raw(db).query("SELECT export_name FROM package_api_surface WHERE export_kind='named'").all() as Array<{ export_name: string }>).map((r) => r.export_name);
    expect(named).toEqual(["fresh"]); // stale row replaced
    db.close();
  });
});

describe("misc", () => {
  test("nowIso is fixed-width ISO-8601 UTC", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("non-canonical caller timestamps are rejected at the write boundary (§3)", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    // seconds precision, date-only, and offset forms all break lexicographic == chronological
    expect(() => depFinding(db, { dateFetched: "2024-06-01T00:00:00Z" })).toThrow(DbError);
    expect(() => depFinding(db, { dateFetched: "2024-06-01" })).toThrow(DbError);
    expect(() =>
      db.upsertUsageFinding({
        runId: "r1", organization: "o", repository: "r", branch: "b", commitSha: "s",
        packageName: "expo", usageType: "cli", filePath: "f", lineNumber: 1,
        permalink: "p", snippet: "s", foundAt: "2024-06-01T00:00:00+02:00",
      }),
    ).toThrow(DbError);
    expect(() =>
      db.insertError({ runId: "r1", scope: "repo", message: "m", occurredAt: "yesterday" }),
    ).toThrow(DbError);
    // fixed-width but IMPOSSIBLE calendar values must not pass the shape check
    expect(() => depFinding(db, { dateFetched: "2024-99-99T99:99:99.999Z" })).toThrow(DbError);
    expect(() => depFinding(db, { dateFetched: "2024-06-31T00:00:00.000Z" })).toThrow(DbError);
    db.close();
  });

  test("read() permits a single SELECT/WITH statement and nothing else", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    const rows = db.read("SELECT run_id FROM runs ORDER BY run_id").all() as Array<{ run_id: string }>;
    expect(rows.map((r) => r.run_id)).toEqual(["r1"]);
    const cte = db.read("WITH x AS (SELECT 1 AS n) SELECT n FROM x").get() as { n: number };
    expect(cte.n).toBe(1);
    expect(() => db.read("DELETE FROM runs")).toThrow(DbError);
    expect(() => db.read("UPDATE runs SET status='failed'")).toThrow(DbError);
    expect(() => db.read("PRAGMA user_version = 9")).toThrow(DbError);
    expect(() => db.read("SELECT 1; DELETE FROM runs")).toThrow(DbError);
    // SQLite accepts CTE-prefixed DML — the facade must reject it despite the WITH prefix
    expect(() => db.read("WITH d AS (SELECT 1) DELETE FROM runs")).toThrow(DbError);
    expect(() => db.read("WITH d AS (SELECT 1) UPDATE runs SET status='failed'")).toThrow(DbError);
    expect(() => db.read("WITH d AS (SELECT 1) INSERT INTO runs (run_id) SELECT 'x'")).toThrow(DbError);
    // a string literal containing a write keyword is fine (stripped before the check)
    const lit = db.read("SELECT 'delete me' AS s").get() as { s: string };
    expect(lit.s).toBe("delete me");
    expect(db.getRun("r1")).not.toBeNull(); // nothing was deleted by the rejected statements
    db.close();
  });

  test("resumeInfo reports counts and the latest run of the config", () => {
    const db = mem();
    const { runId } = db.startRun(runInput());
    depFinding(db, { runId });
    const info = db.resumeInfo("hash-1");
    expect(info.counts["runs"]).toBe(1);
    expect(info.counts["dependency_findings"]).toBe(1);
    expect(info.lastRun?.runId).toBe(runId);
    expect(db.resumeInfo("other-hash").lastRun).toBeNull();
    db.close();
  });
});

// ---- v2 → v3 migration (version-stepped, §3) --------------------------------------------------
// IMMUTABLE HISTORICAL FIXTURE: the exact v2 schema as shipped (pre-is_default_branch).
// Never update this for later schema versions — it IS the contract the v2→v3 step migrates from.
const V2_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
  config_hash TEXT NOT NULL,
  effective_owners TEXT NOT NULL DEFAULT '[]',
  owners_source TEXT NOT NULL DEFAULT 'discovered'
    CHECK (owners_source IN ('configured','discovered')),
  tracked_packages TEXT NOT NULL DEFAULT '[]',
  cutoff_date TEXT NOT NULL DEFAULT '',
  github_host TEXT NOT NULL DEFAULT 'github.com',
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed'))
);
CREATE TABLE IF NOT EXISTS work_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_hash TEXT NOT NULL,
  created_run_id TEXT NOT NULL REFERENCES runs(run_id),
  last_run_id TEXT NOT NULL REFERENCES runs(run_id),
  scope TEXT NOT NULL CHECK (scope IN ('org','repo','branch')),
  organization TEXT NOT NULL,
  repository TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  last_commit_sha TEXT NOT NULL DEFAULT '',
  last_commit_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','in_progress','done','skipped','error')),
  error_message TEXT, updated_at TEXT NOT NULL,
  CHECK ((scope='org'    AND repository='' AND branch='') OR
         (scope='repo'   AND repository<>'' AND branch='') OR
         (scope='branch' AND repository<>'' AND branch<>'')),
  UNIQUE(config_hash, scope, organization, repository, branch)
);
CREATE TABLE IF NOT EXISTS dependency_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  organization TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL, date_fetched TEXT NOT NULL,
  package_name TEXT NOT NULL,
  dependency_key TEXT NOT NULL,
  dependency_type TEXT NOT NULL,
  manifest_path TEXT NOT NULL, manifest_line INTEGER NOT NULL,
  manifest_permalink TEXT NOT NULL, declared_version TEXT NOT NULL,
  lockfile_path TEXT, lockfile_kind TEXT, lockfile_lines TEXT,
  lockfile_permalink TEXT, resolved_version TEXT,
  resolved_version_source TEXT,
  UNIQUE(organization, repository, branch, commit_sha, package_name, dependency_key, dependency_type, manifest_path)
);
CREATE TABLE IF NOT EXISTS package_api_surface (
  id INTEGER PRIMARY KEY AUTOINCREMENT, package_name TEXT NOT NULL,
  version TEXT NOT NULL,
  version_source TEXT NOT NULL DEFAULT 'lockfile'
    CHECK (version_source IN ('lockfile','range-resolved')),
  export_name TEXT NOT NULL,
  export_kind TEXT NOT NULL,
  source TEXT NOT NULL, introspected_at TEXT NOT NULL,
  UNIQUE(package_name, version, export_name, export_kind)
);
CREATE TABLE IF NOT EXISTS usage_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  organization TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL, package_name TEXT NOT NULL,
  dependency_key TEXT NOT NULL DEFAULT '',
  usage_type TEXT NOT NULL,
  export_name TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL, line_number INTEGER NOT NULL,
  permalink TEXT NOT NULL, snippet TEXT NOT NULL, found_at TEXT NOT NULL,
  UNIQUE(organization, repository, branch, commit_sha, package_name, dependency_key, usage_type, file_path, line_number, export_name, context)
);
CREATE TABLE IF NOT EXISTS run_unit_head (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  organization TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scanned'
    CHECK (status IN ('scanned','skipped-cutoff')),
  PRIMARY KEY (run_id, organization, repository, branch)
);
CREATE TABLE IF NOT EXISTS api_cache (
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  variant_hash TEXT NOT NULL,
  etag TEXT,
  response_body TEXT, cached_at TEXT NOT NULL,
  PRIMARY KEY (method, url, variant_hash)
);
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  scope TEXT NOT NULL,
  organization TEXT, repository TEXT, branch TEXT,
  package_name TEXT, version TEXT,
  message TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_usage_loc  ON usage_findings(organization, repository, branch, commit_sha);
CREATE INDEX IF NOT EXISTS ix_usage_run  ON usage_findings(run_id);
CREATE INDEX IF NOT EXISTS ix_dep_run    ON dependency_findings(run_id);
CREATE INDEX IF NOT EXISTS ix_dep_loc    ON dependency_findings(organization, repository, branch, commit_sha);
CREATE INDEX IF NOT EXISTS ix_err_run    ON errors(run_id);
CREATE INDEX IF NOT EXISTS ix_wq_status  ON work_queue(config_hash, status);
CREATE INDEX IF NOT EXISTS ix_ruh_loc    ON run_unit_head(organization, repository, branch, commit_sha);
`;

// Seed a REAL v2 database: a sentinel row in every owned table (the migration must preserve
// every one of them — most importantly the four tables migrateLegacy would have destroyed).
function buildV2Db(path: string): void {
  const raw = new Database(path, { create: true, strict: true });
  raw.exec(V2_SCHEMA_SQL);
  raw.exec(`INSERT INTO runs VALUES
    ('v2-run', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 'h-v2', '["org-a"]', 'configured', '["expo"]', '2024-01-01', 'github.com', 'completed'),
    ('v2-running', '2026-01-02T00:00:00.000Z', NULL, 'h-v2', '["org-a"]', 'configured', '["expo"]', '2024-01-01', 'github.com', 'running')`);
  // Explicit NONCONTIGUOUS ids everywhere an id exists: a faulty rebuild that renumbers rows
  // would otherwise survive projection equality (and the id-dependent tie-breaks with it).
  raw.exec(`INSERT INTO work_queue (id, config_hash, created_run_id, last_run_id, scope, organization, repository, branch, last_commit_sha, last_commit_date, status, error_message, updated_at)
    VALUES (7, 'h-v2', 'v2-run', 'v2-run', 'branch', 'org-a', 'repo', 'main', 'sha1', '2026-01-01T00:00:00.000Z', 'done', NULL, '2026-01-01T00:30:00.000Z')`);
  raw.exec(`INSERT INTO dependency_findings (id, run_id, organization, repository, branch, commit_sha, date_fetched,
    package_name, dependency_key, dependency_type, manifest_path, manifest_line, manifest_permalink,
    declared_version, lockfile_path, lockfile_kind, lockfile_lines, lockfile_permalink, resolved_version, resolved_version_source)
    VALUES (13, 'v2-run', 'org-a', 'repo', 'main', 'sha1', '2026-01-01T00:10:00.000Z', 'expo', 'expo', 'dependencies',
    'package.json', 11, 'https://github.com/org-a/repo/blob/sha1/package.json#L11', '^50.0.0',
    'bun.lock', 'bun', '[42]', 'https://github.com/org-a/repo/blob/sha1/bun.lock#L42', '50.0.0', 'lockfile')`);
  raw.exec(`INSERT INTO usage_findings (id, run_id, organization, repository, branch, commit_sha, package_name,
    dependency_key, usage_type, export_name, context, file_path, line_number, permalink, snippet, found_at)
    VALUES (21, 'v2-run', 'org-a', 'repo', 'main', 'sha1', 'expo', 'expo', 'named-import', 'registerRootComponent', '',
    'index.js', 1, 'https://github.com/org-a/repo/blob/sha1/index.js#L1',
    'import { registerRootComponent } from "expo"', '2026-01-01T00:20:00.000Z')`);
  raw.exec(`INSERT INTO package_api_surface (id, package_name, version, version_source, export_name, export_kind, source, introspected_at) VALUES
    (31, 'expo', '50.0.0', 'lockfile', 'registerRootComponent', 'named', 'build/Expo.d.ts', '2026-01-01T00:15:00.000Z'),
    (35, 'expo', '50.0.0', 'lockfile', '', '__complete__', '__complete__', '2026-01-01T00:15:00.000Z')`);
  raw.exec(`INSERT INTO run_unit_head VALUES
    ('v2-run', 'org-a', 'repo', 'main', 'sha1', 'scanned'),
    ('v2-run', 'org-a', 'repo', 'stale', '', 'skipped-cutoff')`);
  raw.exec(`INSERT INTO api_cache VALUES ('GET', 'https://api.github.com/x', 'raw', 'W/"e1"', '{"a":1}', '2026-01-01T00:05:00.000Z')`);
  // TWO error rows with the SAME occurred_at: the report's errors[] tie-breaks on id, so a
  // renumbering rebuild would flip their order and fail the byte-identity comparison.
  raw.exec(`INSERT INTO errors (id, run_id, scope, organization, repository, branch, package_name, version, message, occurred_at) VALUES
    (43, 'v2-run', 'introspection', NULL, NULL, NULL, 'expo', '49.0.0', 'tarball fetch failed', '2026-01-01T00:25:00.000Z'),
    (47, 'v2-run', 'introspection', NULL, NULL, NULL, 'expo', '48.0.0', 'packument fetch failed', '2026-01-01T00:25:00.000Z')`);
  raw.exec("PRAGMA user_version = 2");
  raw.close();
}

// Test-only AuditDb view over an existing raw connection — lets the CRITICAL round-trip test
// build the "before" report from the UNMIGRATED v2 database with the real buildReport (opening
// it through AuditDb.open would migrate it first). Same deliberate reach-in as `raw` above.
function viewOver(rawDb: Database): AuditDb {
  const view = Object.create(AuditDb.prototype) as AuditDb;
  (view as unknown as { db: Database }).db = rawDb;
  return view;
}

// Explicit v2 column projections (stable order) — deliberately NOT SELECT *: the migration
// legitimately adds is_default_branch, so preservation is asserted on the v2 columns exactly.
const V2_PROJECTIONS: Record<string, string> = {
  runs: `SELECT run_id, started_at, completed_at, config_hash, effective_owners, owners_source,
         tracked_packages, cutoff_date, github_host, status FROM runs ORDER BY run_id`,
  work_queue: `SELECT id, config_hash, created_run_id, last_run_id, scope, organization, repository,
         branch, last_commit_sha, last_commit_date, status, error_message, updated_at
         FROM work_queue ORDER BY id`,
  dependency_findings: `SELECT id, run_id, organization, repository, branch, commit_sha, date_fetched,
         package_name, dependency_key, dependency_type, manifest_path, manifest_line,
         manifest_permalink, declared_version, lockfile_path, lockfile_kind, lockfile_lines,
         lockfile_permalink, resolved_version, resolved_version_source
         FROM dependency_findings ORDER BY id`,
  usage_findings: `SELECT id, run_id, organization, repository, branch, commit_sha, package_name,
         dependency_key, usage_type, export_name, context, file_path, line_number, permalink,
         snippet, found_at FROM usage_findings ORDER BY id`,
  package_api_surface: `SELECT id, package_name, version, version_source, export_name, export_kind,
         source, introspected_at FROM package_api_surface ORDER BY id`,
  run_unit_head: `SELECT run_id, organization, repository, branch, commit_sha, status
         FROM run_unit_head ORDER BY run_id, organization, repository, branch`,
  api_cache: `SELECT method, url, variant_hash, etag, response_body, cached_at
         FROM api_cache ORDER BY method, url, variant_hash`,
  errors: `SELECT id, run_id, scope, organization, repository, branch, package_name, version,
         message, occurred_at FROM errors ORDER BY id`,
};

describe("migration — v2 → v3 (version-stepped, CRITICAL round-trip)", () => {
  test("real v2 data opens under v3: everything preserved, old run's report byte-identical", () => {
    const path = nextFile();
    buildV2Db(path);

    // Baseline from the UNMIGRATED v2 database (precondition-checked).
    const rawBefore = new Database(path, { strict: true });
    expect((rawBefore.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    const v2Cols = (rawBefore.query("PRAGMA table_info(run_unit_head)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(v2Cols).not.toContain("is_default_branch");
    const before = viewOver(rawBefore);
    const beforeProjections = new Map<string, unknown[]>();
    for (const [table, sql] of Object.entries(V2_PROJECTIONS)) beforeProjections.set(table, rawBefore.query(sql).all());
    const beforeReport = JSON.stringify(buildReport(before, before.getRun("v2-run")!), null, 2);
    rawBefore.close();

    // Migrate by opening through the production path.
    const db = AuditDb.open({ sqlitePath: path });
    try {
      const r = raw(db);
      expect((r.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      // Every v2 row survives, byte-for-byte on the v2 columns.
      for (const [table, sql] of Object.entries(V2_PROJECTIONS)) {
        expect(r.query(sql).all()).toEqual(beforeProjections.get(table)!);
      }
      // The new column exists and is NULL (= unknown) on every migrated row — never 0.
      const flags = r.query("SELECT is_default_branch FROM run_unit_head").all() as Array<{ is_default_branch: unknown }>;
      expect(flags.length).toBe(2);
      for (const f of flags) expect(f.is_default_branch).toBeNull();
      // Referential integrity intact.
      expect(r.query("PRAGMA foreign_key_check").all()).toEqual([]);
      // v2 running runs are NOT failed by the additive step (that is the LEGACY boundary rule).
      expect(db.getRun("v2-running")?.status).toBe("running");
      // The old run's report is byte-identical through the migration.
      const afterReport = JSON.stringify(buildReport(db, db.getRun("v2-run")!), null, 2);
      expect(afterReport).toBe(beforeReport);
    } finally {
      db.close();
    }
  });

  test("--fresh on a v2 database migrates cleanly (caches survive their own drop of run_unit_head)", () => {
    const path = nextFile();
    buildV2Db(path);
    // --fresh drops run_unit_head while preserving the caches, so the v2→v3 step must recreate
    // missing tables BEFORE its ALTER — this is the regression that would throw otherwise.
    let db!: AuditDb;
    captureStdout(() => {
      db = AuditDb.open({ sqlitePath: path, fresh: true });
    });
    try {
      const r = raw(db);
      expect((r.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      expect(db.getApiCache("GET", "https://api.github.com/x", "raw")?.etag).toBe('W/"e1"');
      expect(db.hasCompletionMarker("expo", "50.0.0")).toBe(true);
      expect(db.getRun("v2-run")).toBeNull(); // run-scoped data dropped, as --fresh promises
      r.query("SELECT is_default_branch FROM run_unit_head").all(); // v3 shape (throws if missing)
    } finally {
      db.close();
    }
  });
});

describe("--fresh drop-time warning (E3)", () => {
  test("--fresh over completed runs emits ONE warning event with the dropped count", () => {
    const path = nextFile();
    const db1 = AuditDb.open({ sqlitePath: path });
    db1.completeRun(db1.startRun(runInput()).runId);
    db1.completeRun(db1.startRun(runInput({ configHash: "hash-2" })).runId);
    db1.close();

    let db2: AuditDb | null = null;
    const events = captureStdout(() => {
      db2 = AuditDb.open({ sqlitePath: path, fresh: true });
    });
    db2!.close();
    const warnings = events.filter((e) => e["event"] === "warning");
    expect(warnings.length).toBe(1);
    expect(warnings[0]!["reason"]).toBe("fresh-dropped-completed-runs");
    expect(warnings[0]!["completedRunsDropped"]).toBe(2);
    expect(String(warnings[0]!["message"])).toContain("unrecoverable");
  });

  test("--fresh over only failed/running runs is silent (nothing reportable was lost)", () => {
    const path = nextFile();
    const db1 = AuditDb.open({ sqlitePath: path });
    db1.failRun(db1.startRun(runInput()).runId);
    db1.close();
    const events = captureStdout(() => {
      AuditDb.open({ sqlitePath: path, fresh: true }).close();
    });
    expect(events.filter((e) => e["event"] === "warning")).toEqual([]);
  });

  test("--fresh on a brand-new database is silent (no runs table yet)", () => {
    const events = captureStdout(() => {
      AuditDb.open({ sqlitePath: nextFile(), fresh: true }).close();
    });
    expect(events.filter((e) => e["event"] === "warning")).toEqual([]);
  });
});

describe("upsertRunUnitHead — is_default_branch tri-state", () => {
  test("true → 1, false → 0, null → NULL; the conflict path updates it", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    const base = { runId: "r1", organization: "o", repository: "r", commitSha: "s", status: "scanned" as const };
    db.upsertRunUnitHead({ ...base, branch: "main", isDefaultBranch: true });
    db.upsertRunUnitHead({ ...base, branch: "dev", isDefaultBranch: false });
    db.upsertRunUnitHead({ ...base, branch: "old", isDefaultBranch: null });
    const flags = raw(db)
      .query("SELECT branch, is_default_branch AS f FROM run_unit_head ORDER BY branch")
      .all() as Array<{ branch: string; f: unknown }>;
    expect(flags).toEqual([
      { branch: "dev", f: 0 },
      { branch: "main", f: 1 },
      { branch: "old", f: null },
    ]);
    // conflict path: a later upsert of the SAME unit updates the flag (e.g. default moved)
    db.upsertRunUnitHead({ ...base, branch: "dev", isDefaultBranch: true });
    const dev = raw(db).query("SELECT is_default_branch AS f FROM run_unit_head WHERE branch='dev'").get() as { f: unknown };
    expect(dev.f).toBe(1);
    db.close();
  });
});

describe("openReadOnly (CV5 read seam)", () => {
  // A cleanly-written v3 database with one completed run, for the happy paths.
  function buildV3Db(path: string): string {
    const db = AuditDb.open({ sqlitePath: path });
    const { runId } = db.startRun(runInput());
    db.upsertRunUnitHead({ runId, organization: "o", repository: "r", branch: "main", commitSha: "s", status: "scanned", isDefaultBranch: true });
    db.completeRun(runId);
    db.close();
    return runId;
  }

  test("reads a v3 database: getRun/read/readTransaction/hasCompletionMarker work", () => {
    const path = nextFile();
    const runId = buildV3Db(path);
    const reader = AuditDb.openReadOnly({ sqlitePath: path });
    try {
      expect(reader.getRun(runId)?.status).toBe("completed");
      expect(reader.latestReportableRun()?.runId).toBe(runId);
      const heads = reader.read("SELECT branch, is_default_branch FROM run_unit_head").all();
      expect(heads).toEqual([{ branch: "main", is_default_branch: 1 }]);
      expect(reader.hasCompletionMarker("expo", "0.0.0")).toBe(false);
      const inTx = reader.readTransaction(() => reader.read("SELECT COUNT(*) AS n FROM runs").get() as { n: number });
      expect(inTx.n).toBe(1);
    } finally {
      reader.close();
    }
  });

  test("the connection is truly read-only at the SQLite level, and the main file's bytes never change", () => {
    const path = nextFile();
    const runId = buildV3Db(path);
    const hashBefore = createHash("sha256").update(readFileSync(path)).digest("hex");
    const reader = AuditDb.openReadOnly({ sqlitePath: path });
    try {
      expect((raw(reader as AuditDb).query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
      expect(() => raw(reader as AuditDb).query("INSERT INTO errors (run_id, scope, message, occurred_at) VALUES (?, 'x', 'x', 'x')").run(runId)).toThrow();
      reader.getRun(runId);
    } finally {
      reader.close();
    }
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(hashBefore);
  });

  test("a v2 database is refused with the migrate-first remediation (no migration attempted)", () => {
    const path = nextFile();
    buildV2Db(path);
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/run `bun run audit` once to migrate/);
    // …and it really did NOT migrate:
    const check = new Database(path, { readonly: true });
    expect((check.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    check.close();
  });

  test("a NEWER-versioned database is refused with the upgrade-the-tool message", () => {
    const path = nextFile();
    buildV3Db(path);
    const bump = new Database(path, { strict: true });
    bump.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    bump.close();
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/upgrade the tool/);
  });

  test("a v3-stamped file missing audit tables is refused up front, not mid-query", () => {
    const path = nextFile();
    const forged = new Database(path, { create: true, strict: true });
    forged.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    forged.close();
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/missing the runs table/);
  });

  test(":memory: is refused (nothing to read), and containment applies to reads too", () => {
    expect(() => AuditDb.openReadOnly({ sqlitePath: ":memory:" })).toThrow(DbError);
    expect(() => AuditDb.openReadOnly({ sqlitePath: "/tmp/escape.db" })).toThrow(ReadOnlyViolation);
  });

  test("a missing file maps to the actionable run-audit-first error (SQLITE_CANTOPEN)", () => {
    expect(() => AuditDb.openReadOnly({ sqlitePath: join(TEST_ROOT, "never-created.db") })).toThrow(
      /cannot open database .* run `bun run audit` first/,
    );
  });

  test("a reader coexists with a LIVE writer connection on the same WAL database", () => {
    const path = nextFile();
    const writer = AuditDb.open({ sqlitePath: path });
    try {
      const { runId } = writer.startRun(runInput());
      writer.completeRun(runId);
      // writer connection still open (live -wal/-shm) — the reader must see committed state
      const reader = AuditDb.openReadOnly({ sqlitePath: path });
      try {
        expect(reader.getRun(runId)?.status).toBe("completed");
        // …and later writer commits become visible to subsequent reads on the same reader
        const second = writer.startRun(runInput({ configHash: "hash-2" })).runId;
        writer.completeRun(second);
        expect(reader.getRun(second)?.status).toBe("completed");
      } finally {
        reader.close();
      }
    } finally {
      writer.close();
    }
  });

  test("mapReadOnlyOpenError classifies by result-code family (recovery/busy/cantopen states are impractical to fabricate live)", () => {
    const err = (code: unknown): Error & { code?: unknown } => Object.assign(new Error("x"), { code });
    const msg = (e: unknown): string => (e as Error).message;
    expect(msg(mapReadOnlyOpenError(err("SQLITE_READONLY_RECOVERY"), "p"))).toContain("writable recovery");
    for (const busy of ["SQLITE_BUSY", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_TIMEOUT", "SQLITE_BUSY_SNAPSHOT"]) {
      const mapped = mapReadOnlyOpenError(err(busy), "p");
      expect(mapped).toBeInstanceOf(DbError);
      expect(msg(mapped)).toContain("audit appears to be in progress");
    }
    for (const cant of ["SQLITE_CANTOPEN", "SQLITE_CANTOPEN_ISDIR"]) {
      expect(msg(mapReadOnlyOpenError(err(cant), "p"))).toContain("run `bun run audit` first");
    }
    // unknown codes and non-Error shapes pass through VERBATIM (never swallowed)
    const raw = err("SQLITE_CORRUPT");
    expect(mapReadOnlyOpenError(raw, "p")).toBe(raw);
    const noCode = new Error("plain");
    expect(mapReadOnlyOpenError(noCode, "p")).toBe(noCode);
  });
});

describe("open — version check precedes the --fresh drop", () => {
  test("a NEWER-versioned database is rejected by --fresh with all data intact", () => {
    const path = nextFile();
    const db1 = AuditDb.open({ sqlitePath: path });
    db1.completeRun(db1.startRun(runInput()).runId);
    db1.close();
    const bump = new Database(path, { strict: true });
    bump.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    bump.close();

    expect(() => AuditDb.open({ sqlitePath: path, fresh: true, purgeCache: true })).toThrow(/upgrade the tool/);
    // nothing was dropped before the rejection
    const check = new Database(path, { readonly: true });
    const n = (check.query("SELECT COUNT(*) AS n FROM runs WHERE status='completed'").get() as { n: number }).n;
    expect(n).toBe(1);
    check.close();
  });
});

describe("open — current-version self-heal repairs a missing v3 column", () => {
  test("a v3-stamped database lacking is_default_branch is repaired by the writer open, preserving data", () => {
    const path = nextFile();
    const db1 = AuditDb.open({ sqlitePath: path });
    const { runId } = db1.startRun(runInput());
    db1.completeRun(runId);
    db1.close();
    // Forge the dead-end state: v3 stamp, v2-shaped run_unit_head (no is_default_branch).
    const forge = new Database(path, { strict: true });
    forge.exec("ALTER TABLE run_unit_head DROP COLUMN is_default_branch");
    forge.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    forge.close();
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/is_default_branch/);

    // openReadOnly's remediation is "run bun run audit" — the writer open MUST actually fix it.
    const db2 = AuditDb.open({ sqlitePath: path });
    expect(db2.getRun(runId)?.status).toBe("completed"); // data preserved
    db2.close();
    const reader = AuditDb.openReadOnly({ sqlitePath: path }); // and reads work again
    expect(reader.getRun(runId)?.status).toBe("completed");
    reader.close();
  });
});
