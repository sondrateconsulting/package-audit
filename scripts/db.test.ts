import { expect, test, describe, afterAll, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AuditDb, DbError, SCHEMA_VERSION, SURFACE_SCHEMA_VERSION, assertOwnedDatabase, initWritableConnection, isOwnedOrEmpty, mapReadOnlyOpenError, migrateV3toV4, normalizeCheck, nowIso, tableShapesAt, type RunInput, type RunUnitHeadInput, extractChecks } from "./db.ts";
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

  test("refuses to adopt a non-audit SQLite database WITHOUT mutating it (rejected on the read-only preflight)", () => {
    const path = nextFile();
    const raw = new Database(path, { create: true });
    raw.exec("CREATE TABLE not_audit (x TEXT)");
    const before = (raw.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    raw.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
    // Rejecting is only half the contract. The rejection must happen on the READ-ONLY preflight,
    // because a writable open runs `PRAGMA journal_mode = WAL`, which PERSISTS in the header and
    // creates -wal/-shm sidecars — mutating a file this tool just decided it does not own. Reaching
    // here needs no tampering, only a sqlitePath aimed at some other app's database. Asserting the
    // throw alone let that through; these assertions are what pin the zero-mutation guarantee.
    const ro = new Database(path, { readonly: true, strict: true });
    const after = (ro.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    ro.close();
    expect(after).toBe(before); // 'delete', not 'wal'
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  test("refuses a foreign database whose only objects are NON-TABLES (a view) — and does not mutate it", () => {
    // The `type='table'` blind spot, which was not theoretical: a view-only file read as non-foreign,
    // so the writable open WAL-converted it AND the adoption path CREATED the whole audit schema
    // inside someone else's database. Zero audit tables means the file is ours only if it is EMPTY.
    const path = nextFile();
    const raw = new Database(path, { create: true });
    raw.exec("CREATE TABLE t (x TEXT)");
    raw.exec("CREATE VIEW someones_view AS SELECT x FROM t");
    raw.exec("DROP TABLE t"); // leaves a file whose ONLY object is a view
    const before = (raw.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    raw.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
    const ro = new Database(path, { readonly: true, strict: true });
    const after = (ro.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    const objects = ro.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    ro.close();
    expect(after).toBe(before); // not WAL-converted
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(objects.map((o) => o.name)).toEqual(["someones_view"]); // no audit schema written into it
  });

  test("refuses a foreign database whose ONLY object COLLIDES with an audit table name (a view called 'runs')", () => {
    // The second half of the hole: name-matching against the audit set meant a foreign object NAMED
    // like one of ours counted as ours. Deliberately a backing-table-free view, so `runs` is the file's
    // ONLY object — otherwise a stray foreign table would make it foreign for the wrong reason and the
    // test would not discriminate. Under the old predicate this file looked adoptable, so it was
    // WAL-mutated and `CREATE TABLE runs` then failed against the existing view — a raw SQLiteError
    // AFTER the damage, not a clean DbError before it.
    const path = nextFile();
    const raw = new Database(path, { create: true });
    raw.exec("CREATE VIEW runs AS SELECT 1 AS x");
    const before = (raw.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    raw.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError); // rejected cleanly, on the preflight
    const ro = new Database(path, { readonly: true, strict: true });
    const after = (ro.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    const objects = ro.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    ro.close();
    expect(after).toBe(before);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(objects.map((o) => o.name)).toEqual(["runs"]); // their view, untouched
  });

  test("refuses a database stamped with a NEWER schema version", () => {
    const path = nextFile();
    const raw = new Database(path, { create: true });
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
  });
});

// ---- ownership predicate (§0: never write to a database this tool does not own) -------------
// The gate this suite defends used to fire ONLY when ZERO audit-named tables existed, so ONE
// generic audit-named table (`errors`, `work_queue`, …) read as proof of ownership and the
// migration's run-scoped reset then DESTROYED that table's rows. `toThrow()` alone is what let
// that ship — a raw SQLiteError thrown AFTER the writable open passes `toThrow(DbError)` never,
// but passes a bare `toThrow()` happily, and by then the file is already WAL-converted. So every
// case here asserts what must NOT have happened to the file: journal_mode unconverted, no
// -wal/-shm sidecars, user_version unstamped, objects and rows exactly as the other app left them.

// Restated here deliberately rather than imported from db.ts: a test that inherits the
// production list cannot notice the production list going wrong.
const AUDIT_TABLE_NAMES = [
  "runs", "work_queue", "dependency_findings", "package_api_surface",
  "usage_findings", "run_unit_head", "api_cache", "errors",
] as const;

// A second application's tables/index/view, and rows we must never touch.
const FOREIGN_SQL = `
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO customers (name) VALUES ('acme'), ('globex');
CREATE INDEX ix_customers_name ON customers(name);
CREATE VIEW v_customers AS SELECT name FROM customers;
`;

interface FileState {
  journalMode: string;
  userVersion: number;
  objects: string[];
  sidecars: string[];
}

function fileState(path: string): FileState {
  // Sidecars off the filesystem FIRST: a readonly open of a WAL database can itself create them.
  const sidecars = readdirSync(TEST_ROOT).filter((f) => f.startsWith(`${basename(path)}-`)).sort();
  const d = new Database(path, { readonly: true, strict: true });
  try {
    return {
      journalMode: (d.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      userVersion: (d.query("PRAGMA user_version").get() as { user_version: number }).user_version,
      objects: (
        d.query("SELECT type || ':' || name AS o FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY o").all() as Array<{ o: string }>
      ).map((r) => r.o),
      sidecars,
    };
  } finally {
    d.close();
  }
}

function rowCount(path: string, table: string): number {
  const d = new Database(path, { readonly: true, strict: true });
  try {
    return (d.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    d.close();
  }
}

// A database another application owns. `journal_mode=delete` is the non-WAL mode such a file
// realistically carries — and the mode our writable open would silently convert to WAL.
function buildForeignDb(path: string, opts: { auditName?: string; userVersion?: number } = {}): void {
  const d = new Database(path, { create: true, strict: true });
  d.exec("PRAGMA journal_mode = delete;");
  if (opts.auditName !== undefined) {
    d.exec(`CREATE TABLE ${opts.auditName} (id INTEGER PRIMARY KEY, note TEXT NOT NULL)`);
    d.exec(`INSERT INTO ${opts.auditName} (note) VALUES ('a'), ('b'), ('c')`);
  }
  d.exec(FOREIGN_SQL);
  d.exec(`PRAGMA user_version = ${opts.userVersion ?? 0}`);
  d.close();
}

// Corrupt the sqlite_schema btree root: zero page 1 past the 100-byte file header. The header
// stays valid — opens succeed and the header pragmas (user_version, application_id) still
// answer — but the first sqlite_master-backed statement hits the zeroed btree and throws
// SQLITE_CORRUPT. This is the damage shape the ownership probes can actually meet mid-check:
// they read schema metadata, never table interior pages, so corrupting a data page would
// exercise nothing here.
function corruptSchemaPage(path: string): void {
  const bytes = readFileSync(path);
  const raw16 = bytes.readUInt16BE(16); // header page-size field; the stored value 1 means 65536
  const pageSize = raw16 === 1 ? 65536 : raw16;
  bytes.fill(0, 100, Math.min(pageSize, bytes.length));
  writeFileSync(path, bytes);
}

// The whole-file assertion: refused cleanly, and the file is byte-for-byte as they left it.
function expectRefusedUnmutated(path: string, before: FileState): void {
  expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
  const after = fileState(path);
  expect(after.journalMode).toBe("delete"); // WAL conversion persists in the file header
  expect(after.sidecars).toEqual([]); // no -wal/-shm spawned beside a stranger's file
  expect(after.userVersion).toBe(before.userVersion);
  expect(after.objects).toEqual(before.objects); // no audit tables/indexes grafted on
  expect(rowCount(path, "customers")).toBe(2);
}

describe("ownership — a foreign database is refused BEFORE any writable open", () => {
  for (const name of AUDIT_TABLE_NAMES) {
    test(`one audit-named table (${name}) is NOT proof of ownership: refused, file unmutated`, () => {
      const path = nextFile();
      buildForeignDb(path, { auditName: name });
      const before = fileState(path);
      expectRefusedUnmutated(path, before);
      // The rows the run-scoped reset destroyed: dependency_findings/usage_findings/errors/
      // work_queue all read 0 under the old gate. This is the data-loss assertion proper.
      expect(rowCount(path, name)).toBe(3);
    });
  }

  test("a foreign database with no audit-named table at all is refused, file unmutated", () => {
    const path = nextFile();
    buildForeignDb(path);
    const before = fileState(path);
    expectRefusedUnmutated(path, before);
  });

  test("a foreign database that stamps user_version as a migration counter (Room/GRDB) is refused", () => {
    // user_version is not ours alone — Room and GRDB use it as a migration counter. A stamp in
    // our range must not by itself buy adoption; the absence of foreign objects is the conjunct.
    const path = nextFile();
    buildForeignDb(path, { auditName: "errors", userVersion: SCHEMA_VERSION });
    const before = fileState(path);
    expect(before.userVersion).toBe(SCHEMA_VERSION);
    expectRefusedUnmutated(path, before);
    expect(rowCount(path, "errors")).toBe(3);
  });

  test("a foreign WAL database is refused WITHOUT mutating its -wal/-shm sidecars", () => {
    // A plain readonly open of a WAL database is NOT filesystem-read-only: SQLite rewrites the
    // `-shm` wal-index to read it, so a plain-readonly probe would leave a stranger's sidecar
    // changed while claiming "nothing was modified". The preflight reads the file's BYTES instead
    // (no SQLite handle on the target at all) — every sidecar must survive byte-for-byte.
    // Sidecars are copied while the writer is still open: whether a clean CLOSE leaves them on
    // disk is platform-dependent (Linux bun removes them; macOS keeps them), but a LIVE WAL
    // connection always has both, so this construction is deterministic everywhere.
    const src = nextFile();
    const w = new Database(src, { create: true, strict: true });
    w.exec("PRAGMA journal_mode = wal;");
    w.exec("CREATE TABLE errors (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
    w.exec("INSERT INTO errors (note) VALUES ('a'), ('b'), ('c')");
    w.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    w.exec("INSERT INTO customers (name) VALUES ('acme'), ('globex')");
    w.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    w.exec("PRAGMA wal_checkpoint(FULL);"); // base file now carries the schema and rows
    const path = nextFile();
    copyFileSync(src, path);
    copyFileSync(`${src}-wal`, `${path}-wal`);
    copyFileSync(`${src}-shm`, `${path}-shm`);
    w.close();
    const walBefore = readFileSync(`${path}-wal`);
    const shmBefore = readFileSync(`${path}-shm`);
    const baseBefore = readFileSync(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    expect(Buffer.compare(readFileSync(path), baseBefore)).toBe(0); // base byte-for-byte intact
    expect(Buffer.compare(readFileSync(`${path}-wal`), walBefore)).toBe(0);
    expect(Buffer.compare(readFileSync(`${path}-shm`), shmBefore)).toBe(0);
    // Their rows are intact in the base (checkpointed above) — read them through an in-memory
    // image: a plain readonly open of a WAL-header file with copied-mid-connection sidecars is
    // not guaranteed to work, and byte-equality above was the real assertion.
    const rows = Buffer.from(baseBefore);
    if (rows[18] === 2) rows[18] = 1;
    if (rows[19] === 2) rows[19] = 1;
    const img = Database.deserialize(rows, true);
    expect((img.query("SELECT count(*) AS n FROM errors").get() as { n: number }).n).toBe(3);
    expect((img.query("SELECT count(*) AS n FROM customers").get() as { n: number }).n).toBe(2);
    img.close();
  });

  test("a SECOND invocation while a live audit still holds the database is refused with wait-first guidance", () => {
    // Early in a run — before the first auto-checkpoint — our OWN database looks exactly like a
    // crashed foreign WAL writer: zero-object base, schema wal-resident. A lock-free byte read
    // cannot tell those apart, so the refusal is correct — but its guidance must lead with
    // "wait and retry", never with deletion: an operator who deletes a live run's file destroys
    // that run. (Pre-fix, the concurrent second open simply raced the writer instead.)
    const path = nextFile();
    const live = AuditDb.open({ sqlitePath: path }); // connection held: schema sits in -wal
    try {
      const img = readFileSync(path);
      if (img[18] === 2) img[18] = 1;
      if (img[19] === 2) img[19] = 1;
      const base = Database.deserialize(img, true);
      expect(base.query("SELECT count(*) AS c FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()).toEqual({ c: 0 });
      base.close();

      expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/still be running.*wait for it/s);

      live.startRun(runInput()); // the live writer is unharmed by the refused second open
    } finally {
      live.close();
    }
    // Once the writer closes (checkpointing its WAL), a normal reopen succeeds.
    const reopened = AuditDb.open({ sqlitePath: path });
    try {
      expect(rowCount(path, "runs")).toBe(1);
    } finally {
      reopened.close();
    }
  });

  test("a non-SQLite junk file is refused fail-closed with an ownership-check message, untouched", () => {
    const path = nextFile();
    writeFileSync(path, "definitely not a database\n");
    const before = readFileSync(path);
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
    // Whether SQLite rejects the bytes at deserialize time or at the first query is a runtime
    // detail — either way the refusal must carry ownership-check context, not a raw SQLiteError.
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/not a readable SQLite database|could not inspect it/);
    expect(Buffer.compare(readFileSync(path), before)).toBe(0); // bytes untouched
    expect(readdirSync(TEST_ROOT).filter((f) => f.startsWith(`${basename(path)}-`))).toEqual([]);
  });

  test("a zero-object file stamped with a foreign application_id is refused byte-identical (before the empty arm)", () => {
    // The scenario readApplicationId's own comment names: another application initializes its
    // header — application_id stamped — before running any DDL. The empty arm ("an empty
    // database cannot belong to anyone") must never see this file: affirmative foreign
    // provenance is checked FIRST. Discriminating power (mutation-proven): moving the
    // application_id check after the empty arm adopts this file — WAL header conversion and
    // sidecars beside a stranger's file — before the backstop's own application_id line can
    // refuse the write. Byte-compare is the decisive assertion: it pins the journal-mode
    // header bytes, the application_id, the stamp, and everything else at once.
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA application_id = 252006674"); // the same nonzero stamp the backstop tests use
    d.close();
    const before = readFileSync(path);
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create/);
    expect(Buffer.compare(readFileSync(path), before)).toBe(0);
    expect(readdirSync(TEST_ROOT).filter((f) => f.startsWith(`${basename(path)}-`))).toEqual([]);
  });

  test("a zero-object base beside a non-empty rollback -journal is refused (crashed non-WAL writer)", () => {
    // The -journal arm of the pending-journal guard: same reasoning as -wal, for a rollback-mode
    // crashed writer. A 0-byte base file IS an empty database — only the hot journal blocks it.
    const path = nextFile();
    writeFileSync(path, "");
    writeFileSync(`${path}-journal`, "pretend-hot-journal");
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/-journal holds/);
    expect(statSync(path).size).toBe(0); // still empty — nothing created or recovered
    expect(readFileSync(`${path}-journal`, "utf8")).toBe("pretend-hot-journal");
    rmSync(`${path}-journal`); // and with the journal gone, the same path opens fresh
    AuditDb.open({ sqlitePath: path }).close();
  });

  test("a foreign database whose ONLY table is one generic audit name (no other objects) is refused", () => {
    // The narrowest disguise: a single table named `errors` and a migration counter in our range —
    // no customers table, no view, nothing else for the foreign-object check to catch. What
    // refuses it is the SHAPE requirement: any subset of audit-named tables can be ours (partial
    // restores must stay repairable), but only when every present table carries a stamped
    // schema's exact shape — and this `errors(id, note)` matches none.
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec("CREATE TABLE errors (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
    d.exec("INSERT INTO errors (note) VALUES ('a'), ('b'), ('c')");
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    const before = fileState(path);
    expect(before.objects).toEqual(["table:errors"]);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.userVersion).toBe(SCHEMA_VERSION);
    expect(after.objects).toEqual(before.objects);
    expect(rowCount(path, "errors")).toBe(3);
  });

  test("a table named with a LIKE-wildcard near-miss of the internal prefix (sqliteevil) is not invisible", () => {
    // SQLite reserves the LITERAL `sqlite_` prefix; `sqliteevil` is a legal user name. But in
    // LIKE, `_` matches ANY character, so an unescaped `NOT LIKE 'sqlite_%'` filter swallows it —
    // making a foreign database look EMPTY (zero objects → "ours to create"). The checks must
    // escape the underscore so only genuinely internal objects are exempt.
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec("CREATE TABLE sqliteevil (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
    d.exec("INSERT INTO sqliteevil (note) VALUES ('a'), ('b'), ('c')");
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.userVersion).toBe(0);
    expect(after.objects).toEqual(before.objects);
    expect(rowCount(path, "sqliteevil")).toBe(3);
  });

  test("a sqliteevil table hiding among a full audit set is still a foreign object", () => {
    // Same wildcard trap from the other side: on an otherwise-ours database the foreign-object
    // check must SEE `sqliteevil` (it is not internal), not silently exempt it.
    const path = nextFile();
    AuditDb.open({ sqlitePath: path }).close();
    const w = new Database(path, { strict: true });
    w.exec("PRAGMA journal_mode = delete;");
    w.exec("CREATE TABLE sqliteevil (id INTEGER PRIMARY KEY)");
    w.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual(before.sidecars);
    expect(after.objects).toEqual(before.objects);
  });

  test("a foreign database wearing BOTH --fresh-preserved cache names over foreign shapes is refused", () => {
    // The narrowest SET disguise: exactly {api_cache, package_api_surface} — the state a --fresh
    // crash legitimately leaves behind — under a Room-style migration counter in our range. These
    // are generic enough names for another application to have chosen. Matched by NAME alone this
    // was ADOPTED, and --fresh --purge-cache then DROPPED both foreign tables; ownership must
    // require the stamp's exact column shapes, which someone else's tables cannot carry.
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec("CREATE TABLE api_cache (cache_key TEXT PRIMARY KEY, payload BLOB, hits INTEGER NOT NULL DEFAULT 0)");
    d.exec("INSERT INTO api_cache (cache_key, payload) VALUES ('a', x'01'), ('b', x'02'), ('c', x'03')");
    d.exec("CREATE TABLE package_api_surface (pkg TEXT NOT NULL, region TEXT)");
    d.exec("INSERT INTO package_api_surface (pkg, region) VALUES ('x', 'eu'), ('y', 'us')");
    d.exec("PRAGMA user_version = 2"); // the oldest stamp we ever wrote — maximally plausible
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
    // The destructive caller that made this a data-loss bug, refused identically:
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true, purgeCache: true })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete"); // never WAL-converted
    expect(after.sidecars).toEqual([]);
    expect(after.userVersion).toBe(2); // never restamped
    expect(after.objects).toEqual(before.objects); // nothing grafted, nothing dropped
    expect(rowCount(path, "api_cache")).toBe(3); // the rows --purge-cache destroyed pre-fix
    expect(rowCount(path, "package_api_surface")).toBe(2);
  });

  test("a foreign database cloning ALL EIGHT audit table names over foreign shapes is refused", () => {
    // The full-set twin of the cache disguise. Matched by NAME alone this was adopted and
    // WAL-converted; --fresh then either dropped six tables wholesale or leaked a raw
    // `no such column: status` SQLiteError from its completed-runs count against the foreign
    // `runs` shape — AFTER the header conversion. Shapes refuse it before any of that.
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    for (const t of AUDIT_TABLE_NAMES) {
      d.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, note TEXT NOT NULL)`);
      d.exec(`INSERT INTO ${t} (note) VALUES ('keep-1'), ('keep-2')`);
    }
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`); // stamped exactly current
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.userVersion).toBe(SCHEMA_VERSION);
    expect(after.objects).toEqual(before.objects);
    for (const t of AUDIT_TABLE_NAMES) expect(rowCount(path, t)).toBe(2);
  });

  test("a database stamped NEWER than this tool is refused by the PREFLIGHT, header untouched", () => {
    // A rolled-back tool meeting its future database must say "upgrade the tool" — from the
    // read-only preflight, BEFORE the writable open whose WAL pragma rewrites the header. (The
    // writable open's own version check stands as the backstop for :memory: and races.) Shapes
    // of a future schema are unverifiable here, so this arm rests on the absence of foreign
    // objects alone — the legit case and a hypothetical high-stamped name-clone both get the
    // version refusal, and neither is touched.
    const path = nextFile();
    AuditDb.open({ sqlitePath: path }).close(); // a REAL current database…
    const w = new Database(path, { strict: true });
    w.exec("PRAGMA journal_mode = delete;"); // …as a plain rollback-mode file, to observe conversion
    w.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`); // …stamped by a future tool
    w.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/newer than this tool/);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete"); // the preflight refused; the WAL pragma never ran
    expect(after.sidecars).toEqual(before.sidecars);
    expect(after.userVersion).toBe(SCHEMA_VERSION + 1);
    expect(after.objects).toEqual(before.objects);

    // The zero-OBJECT flavor of the same file (a future tool's interrupted create, or a stamped
    // shell): nonzero bytes carrying only the stamp. The version check must fire BEFORE the
    // "no objects -> ours to create" arm, or the writable open converts the header first.
    const shell = nextFile();
    const s = new Database(shell, { create: true, strict: true });
    s.exec("PRAGMA journal_mode = delete;");
    s.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    s.close();
    expect(() => AuditDb.open({ sqlitePath: shell })).toThrow(/newer than this tool/);
    const shellAfter = fileState(shell);
    expect(shellAfter.journalMode).toBe("delete");
    expect(shellAfter.sidecars).toEqual([]);
    expect(shellAfter.userVersion).toBe(SCHEMA_VERSION + 1);
  });

  test("a foreign database whose schema lives ONLY in its uncheckpointed WAL is refused, untouched", () => {
    // The preflight's base-image read sees the BASE file alone — and a WAL database whose writer
    // crashed (or is still running) holds its entire committed schema in -wal frames over a
    // ZERO-object base. That must NOT read as "empty, ours to create": the writable open would
    // recover the WAL and graft the audit schema into a stranger's live file. Constructed by
    // copying base+wal while the writer is still open — a clean close would checkpoint the
    // frames into the base and hide exactly the state under test.
    const src = nextFile();
    const writer = new Database(src, { create: true, strict: true });
    writer.exec("PRAGMA journal_mode = wal;");
    writer.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    writer.exec("INSERT INTO customers (name) VALUES ('acme'), ('globex')");
    const path = nextFile();
    copyFileSync(src, path);
    copyFileSync(`${src}-wal`, `${path}-wal`);
    writer.close();

    // Prove the fixture is the hazardous state: zero objects in the base, schema wal-resident —
    // read the way the preflight reads (a deserialize of the bytes, journal-mode header bytes
    // patched on the copy because an in-memory database cannot run WAL).
    const imageBytes = readFileSync(path);
    if (imageBytes[18] === 2) imageBytes[18] = 1;
    if (imageBytes[19] === 2) imageBytes[19] = 1;
    const im = Database.deserialize(imageBytes, true);
    expect(im.query("SELECT count(*) AS c FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()).toEqual({ c: 0 });
    im.close();
    const baseBefore = readFileSync(path);
    const walBefore = readFileSync(`${path}-wal`);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    // Byte-for-byte: refused WITHOUT recovering the WAL, checkpointing, or building a wal-index.
    expect(Buffer.compare(readFileSync(path), baseBefore)).toBe(0);
    expect(Buffer.compare(readFileSync(`${path}-wal`), walBefore)).toBe(0);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  test("a VIEW named like an audit table does not read as ownership", () => {
    // ISOLATED deliberately: the view is the ONLY object, and the stamp is in our range, so the
    // single thing standing between this file and adoption is that an audit NAME must be an audit
    // TABLE. Add any other foreign object and this passes for the wrong reason — a name-only check
    // would read `runs` as familiar, and `CREATE TABLE runs` would then collide with the view.
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec("CREATE VIEW runs AS SELECT 1 AS run_id, 'completed' AS status");
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    const before = fileState(path);
    expect(before.objects).toEqual(["view:runs"]);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.objects).toEqual(before.objects);
  });

  test("a TRIGGER is foreign even on an otherwise-ours database", () => {
    // This tool creates no triggers, so any trigger belongs to someone else — and a trigger fires
    // writes of their choosing inside the migration/self-heal transactions we are about to run.
    // Refusing our own file over one is the fail-closed side of the trade, and is intended.
    const path = nextFile();
    AuditDb.open({ sqlitePath: path }).close();
    const w = new Database(path, { strict: true });
    w.exec("PRAGMA journal_mode = delete;");
    w.exec("CREATE TRIGGER t_runs AFTER INSERT ON runs BEGIN UPDATE runs SET status='failed'; END");
    w.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual(before.sidecars);
    expect(after.userVersion).toBe(before.userVersion);
    expect(after.objects).toEqual(before.objects);
  });

  test("a dump/restore that lost its header pragmas (v3 tables, user_version 0) is refused, not reset", () => {
    // `.dump`/restore replays the DDL but not the header, so a genuine v3 database comes back
    // stamped 0. It must REFUSE — silently treating it as pre-v2 would rebuild the run-scoped
    // tables empty and destroy reportable rows. Rejection is recoverable; that erasure is not.
    const path = nextFile();
    const db = AuditDb.open({ sqlitePath: path });
    db.startRun(runInput());
    db.close();
    const before = (() => {
      const w = new Database(path, { strict: true });
      w.exec("PRAGMA journal_mode = delete;"); // as a restored (non-WAL) file would arrive
      w.exec("PRAGMA user_version = 0");
      w.close();
      // Normalize the fixture to what a real .dump/restore produces: no sidecars. Building it
      // through AuditDb.open above necessarily passed through WAL, and that residue is the
      // test's own, not the product's — leaving it would blunt the assertion that matters.
      for (const s of readdirSync(TEST_ROOT).filter((f) => f.startsWith(`${basename(path)}-`)))
        rmSync(join(TEST_ROOT, s));
      return fileState(path);
    })();
    expect(before.userVersion).toBe(0);
    expect(before.sidecars).toEqual([]);
    expect(rowCount(path, "runs")).toBe(1);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.userVersion).toBe(0);
    expect(after.objects).toEqual(before.objects);
    expect(rowCount(path, "runs")).toBe(1); // the reportable row the old path would have kept…
    expect(rowCount(path, "work_queue")).toBe(0);
  });

  test("the refusal names the file and tells the operator what to do", () => {
    const path = nextFile();
    buildForeignDb(path, { auditName: "errors" });
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/refusing to write to .*sqlitePath/s);
  });
});

describe("ownership — every database this tool legitimately produces still opens", () => {
  test("a path that does not exist yet is created fresh at the current version", () => {
    const path = nextFile();
    expect(existsSync(path)).toBe(false);
    const db = AuditDb.open({ sqlitePath: path });
    try {
      expect((raw(db).query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      expect(db.latestReportableRun()).toBeNull();
    } finally {
      db.close();
    }
  });

  test("an existing 0-byte file is an empty database, not a foreign one", () => {
    // The writable open's own create path can leave this behind: the file is created before the
    // schema transaction commits. It has no objects, so it cannot belong to anyone.
    const path = nextFile();
    writeFileSync(path, "");
    expect(statSync(path).size).toBe(0);
    const db = AuditDb.open({ sqlitePath: path });
    try {
      expect((raw(db).query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  test("an operator-added CREATE INDEX on an audit table stays tolerated (writable AND read-only opens)", () => {
    // Pins the tolerance tableShape documents ("a stray operator CREATE INDEX stays
    // tolerated"): hasForeignObjects counts only tables/views/triggers, and the shape
    // fingerprint excludes origin-'c' indexes — so an operator's performance index on a
    // legitimately-produced database must never turn it "foreign". Discriminating power
    // (mutation-proven): removing the origin-'c' filter refuses this database as "did not
    // create" on both open paths.
    const path = nextFile();
    AuditDb.open({ sqlitePath: path }).close();
    const w = new Database(path, { strict: true });
    w.exec("CREATE INDEX ix_operator_errors_msg ON errors(message)");
    w.close();
    const writer = AuditDb.open({ sqlitePath: path });
    writer.close();
    expect(fileState(path).objects).toContain("index:ix_operator_errors_msg"); // survived self-heal, not dropped
    AuditDb.openReadOnly({ sqlitePath: path }).close();
  });

  // --fresh's drop is its own committed transaction, and SCHEMA_SQL re-creates the tables in a
  // LATER one — so "only the caches remain" is not an end state of a successful open, it is what
  // a crash BETWEEN those two transactions leaves on disk. Both fixtures below reproduce that
  // interrupted state directly (a completed --fresh would hide it behind the re-create).
  const dropTables = (path: string, tables: readonly string[]): void => {
    const w = new Database(path, { strict: true });
    w.exec("PRAGMA journal_mode = delete;"); // model a plain (non-WAL) file, as a restore leaves
    for (const t of tables) w.exec(`DROP TABLE IF EXISTS ${t}`);
    w.close();
  };

  test("a --fresh interrupted after the drop (only the preserved caches remain) reopens", () => {
    const path = nextFile();
    AuditDb.open({ sqlitePath: path }).close();
    // Exactly FRESH_DROP_ORDER, child-before-parent — the state where "require ALL audit tables"
    // and "require the distinctive `runs` table" would each wrongly reject our OWN file.
    dropTables(path, ["run_unit_head", "dependency_findings", "usage_findings", "errors", "work_queue", "runs"]);
    const d = new Database(path, { readonly: true, strict: true });
    const names = (d.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const uv = (d.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    d.close();
    expect(names).toEqual(["api_cache", "package_api_surface"]);
    expect(uv).toBe(SCHEMA_VERSION); // still stamped: only the tables went

    const db = AuditDb.open({ sqlitePath: path });
    try {
      expect((raw(db).query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      db.startRun(runInput()); // the self-heal re-created the dropped tables
    } finally {
      db.close();
    }
  });

  test("a --fresh --purge-cache interrupted after the drop (zero objects, still stamped) reopens", () => {
    const path = nextFile();
    AuditDb.open({ sqlitePath: path }).close();
    dropTables(path, [
      "run_unit_head", "dependency_findings", "usage_findings", "errors", "work_queue", "runs",
      "api_cache", "package_api_surface",
    ]);
    const d = new Database(path, { readonly: true, strict: true });
    expect(d.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()).toEqual([]);
    d.close();
    const db = AuditDb.open({ sqlitePath: path });
    try {
      expect((raw(db).query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  test("a v2-era --fresh interrupted after the drop (caches only, v2 stamp) migrates and reopens", () => {
    // The same crash window on a version-2 file: only the preserved caches remain, still stamped
    // 2. The cache tables' shapes are identical in every schema we ever stamped, so the shape
    // check must adopt this, and the open must then run the migration chain to current.
    const path = nextFile();
    buildV2Db(path);
    dropTables(path, ["run_unit_head", "dependency_findings", "usage_findings", "errors", "work_queue", "runs"]);

    const db = AuditDb.open({ sqlitePath: path });
    try {
      expect((raw(db).query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      expect(rowCount(path, "api_cache")).toBe(1); // the preserved cache rows survived adoption
      db.startRun(runInput()); // and the re-created run-scoped tables work
    } finally {
      db.close();
    }
  });

  test("a completed --fresh leaves a fully re-created database that reopens", () => {
    const path = nextFile();
    AuditDb.open({ sqlitePath: path }).close();
    captureStdout(() => AuditDb.open({ sqlitePath: path, fresh: true }).close());
    const db = AuditDb.open({ sqlitePath: path });
    try {
      expect((raw(db).query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      db.startRun(runInput());
    } finally {
      db.close();
    }
  });

  test("a current-version database reopens and keeps its rows", () => {
    const path = nextFile();
    const first = AuditDb.open({ sqlitePath: path });
    first.startRun(runInput());
    first.close();
    const db = AuditDb.open({ sqlitePath: path });
    try {
      expect(rowCount(path, "runs")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("a non-empty database stamped BELOW the oldest version we ever wrote is refused", () => {
    // db.ts has stamped >= 2 since its first commit, and `PRAGMA user_version` is transactional
    // (a crashed create rolls back the DDL and the stamp together, leaving zero objects). So a
    // non-empty database reading back < 2 was never produced by this tool — it is someone else's.
    const path = nextFile();
    AuditDb.open({ sqlitePath: path }).close();
    const w = new Database(path, { strict: true });
    w.exec("PRAGMA journal_mode = delete;");
    w.exec("PRAGMA user_version = 1");
    w.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual(before.sidecars);
    expect(after.userVersion).toBe(1);
    expect(after.objects).toEqual(before.objects);
  });

  test("a damaged OWN database (one audit table dropped externally) stays on the repair path", () => {
    // openReadOnly's documented remediation for a missing table is "run `bun run audit` once to
    // repair it" — so the ownership gate must recognize a PARTIAL current-version set as ours
    // when every present table carries the current schema's exact column shape, and the
    // self-heal branch must then actually re-create what is missing.
    const path = nextFile();
    const first = AuditDb.open({ sqlitePath: path });
    first.startRun(runInput());
    first.close();
    const w = new Database(path, { strict: true });
    w.exec("DROP TABLE errors");
    w.close();

    // The documented contract, end-to-end: read side names the table and the remediation…
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/missing the errors table.*bun run audit/s);
    // …and the remediation works: the writable open repairs instead of refusing.
    const repaired = AuditDb.open({ sqlitePath: path });
    try {
      expect(rowCount(path, "runs")).toBe(1); // existing data intact
      // errors re-created EMPTY in the current shape (an asserted equality, not a bare call —
      // a query that merely doesn't throw proves nothing about the rebuilt table's content)
      expect(raw(repaired).query("SELECT run_id FROM errors").all()).toEqual([]);
    } finally {
      repaired.close();
    }
    AuditDb.openReadOnly({ sqlitePath: path }).close(); // read side is whole again
  });

  test("a damaged v2 database (one table dropped externally) stays on the migrate-and-repair path", () => {
    // openReadOnly tells a v2 file's operator to "run `bun run audit` once to migrate it" — that
    // remediation must work even when the v2 file is ALSO missing a table, so the repair path
    // compares partial sets against the shape of the schema the STAMP names, not only the
    // current one. (A quarantine to uv === SCHEMA_VERSION made the advice a dead end that then
    // claimed the file was not ours.)
    const path = nextFile();
    buildV2Db(path);
    const w = new Database(path, { strict: true });
    w.exec("DROP TABLE errors");
    w.close();

    const db = AuditDb.open({ sqlitePath: path }); // migrates v2→v3 AND re-creates the dropped table
    try {
      expect((raw(db).query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      expect(rowCount(path, "runs")).toBe(2); // preserved v2 rows intact
      expect(raw(db).query("SELECT run_id FROM errors").all()).toEqual([]); // re-created, current shape
      expect(raw(db).query("SELECT is_default_branch FROM run_unit_head LIMIT 1").all().length).toBeGreaterThan(0); // v3 column arrived
    } finally {
      db.close();
    }
    AuditDb.openReadOnly({ sqlitePath: path }).close(); // the documented remediation now completes
  });

  // The frozen historical v3 run_unit_head body (narrow status CHECK, no policy columns), as a
  // rebuild — used to forge REAL predecessor-era shapes. A v4 table cannot be column-dropped
  // into an era shape: its table-level CHECKs reference the policy columns (SQLite refuses the
  // DROP) and no ALTER can un-widen the status CHECK, so a genuine era fixture must rebuild.
  // The v2 era is this rebuild plus a DROP of is_default_branch (no CHECK references it).
  const RUH_V3_ERA_REBUILD: readonly string[] = [
    `CREATE TABLE run_unit_head__era (
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      organization TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL,
      commit_sha TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'scanned'
        CHECK (status IN ('scanned','skipped-cutoff')),
      is_default_branch INTEGER,
      PRIMARY KEY (run_id, organization, repository, branch))`,
    `INSERT INTO run_unit_head__era (run_id, organization, repository, branch, commit_sha, status, is_default_branch)
       SELECT run_id, organization, repository, branch, commit_sha, status, is_default_branch FROM run_unit_head`,
    `DROP TABLE run_unit_head`,
    `ALTER TABLE run_unit_head__era RENAME TO run_unit_head`,
    `CREATE INDEX IF NOT EXISTS ix_ruh_loc ON run_unit_head(organization, repository, branch, commit_sha)`,
  ];

  test("a current-stamped database missing a table AND carrying a v2-era run_unit_head heals on one open (mixed-era shapes)", () => {
    // Externally damaged twice over: `errors` dropped AND run_unit_head regressed to its TRUE v2
    // era body, stamp still current. Each present table matches SOME stamped schema's shape (v2
    // for run_unit_head, v4 for the rest) — that mixture is provably ours and fully healable, so
    // the shape check accepts per-table matches across the stamped span rather than demanding one
    // uniform era. (Exact-at-stamp matching would refuse this file while openReadOnly still
    // advised "run `bun run audit`" for each half of the damage — a dead end.)
    const path = nextFile();
    const first = AuditDb.open({ sqlitePath: path });
    const { runId } = first.startRun(runInput());
    // A REAL head row must ride through the heal — an empty run_unit_head would let a faulty
    // drop-and-recreate "repair" pass every structural assertion while deleting report data.
    first.upsertRunUnitHead({ runId, organization: "o", repository: "r", branch: "main", commitSha: "s", status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    first.close();
    const w = new Database(path, { strict: true });
    w.exec("DROP TABLE errors");
    for (const sql of RUH_V3_ERA_REBUILD) w.exec(sql);
    w.exec("ALTER TABLE run_unit_head DROP COLUMN is_default_branch"); // v3 era → v2 era
    w.close();

    // The read path names the v2-era damage and its remediation BEFORE the writer heals it —
    // openReadOnly cannot repair, so silently succeeding here would be the dead-end class this
    // arbitration exists to prevent. The SPECIFIC policy-columns message is asserted (not the
    // generic repair phrasing): this fixture is also missing `errors`, whose missing-TABLE advice
    // matches the generic phrasing too, and would mask the exact-v2 disjunct being dropped.
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/missing the v4 policy columns/);

    const db = AuditDb.open({ sqlitePath: path });
    try {
      expect(rowCount(path, "runs")).toBe(1); // adopted and healed, not refused or reset
      expect(raw(db).query("SELECT run_id FROM errors").all()).toEqual([]); // re-created
      // The head row survived the heal; the restored columns read NULL (the external damage
      // destroyed the stored values — "unknown" is the only honest backfill).
      expect(raw(db).query("SELECT organization, repository, branch, commit_sha, status, is_default_branch, scanned_commit_date FROM run_unit_head").all())
        .toEqual([{ organization: "o", repository: "r", branch: "main", commit_sha: "s", status: "scanned", is_default_branch: null, scanned_commit_date: null }]);
    } finally {
      db.close();
    }
  });

  test("every historical schema shape under the CURRENT stamp self-heals to the current shape", () => {
    // The ownership check accepts a table carrying ANY stamped-era shape <= the stamp (the
    // externally-damaged-but-healable states). That span is sound ONLY while every accepted
    // older shape has an explicit, idempotent repair on the writable open — this test EXECUTES
    // that claim for each pre-current version. Bumping SCHEMA_VERSION without extending
    // DOWN_TRANSFORMS (and the self-heal that makes the new span entry true) fails here loudly,
    // by design.
    const DOWN_TRANSFORMS: Record<number, readonly string[]> = {
      2: [...RUH_V3_ERA_REBUILD, "ALTER TABLE run_unit_head DROP COLUMN is_default_branch"],
      3: RUH_V3_ERA_REBUILD,
    };
    for (let v = 2; v < SCHEMA_VERSION; v++) expect(DOWN_TRANSFORMS[v]?.length ?? 0).toBeGreaterThan(0);

    // Reference: the shapes a fresh current-version database carries. Restated with the FULL
    // production fingerprint surface (columns + rowid/STRICT + FKs + PK/UNIQUE indexes +
    // AUTOINCREMENT) — a heal that restored columns but lost a constraint would otherwise
    // pass here and strand the database as matching no era on its NEXT open.
    const shapeOf = (d: Database, t: string): string =>
      JSON.stringify({
        cols: d.query(`PRAGMA table_xinfo(${t})`).all(),
        meta: d.query("SELECT wr, strict FROM pragma_table_list WHERE schema='main' AND name = ?").get(t),
        fks: d.query(`PRAGMA foreign_key_list(${t})`).all(),
        idx: (d.query(`PRAGMA index_list(${t})`).all() as Array<{ name: string; origin: string }>)
          .filter((i) => i.origin !== "c")
          .map((i) => ({ i, cols: d.query(`PRAGMA index_xinfo(${JSON.stringify(i.name)})`).all() })),
        autoinc: /\bautoincrement\b/i.test(
          ((d.query("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(t) as { sql: string | null } | null)?.sql ?? "")
            .replace(/\/\*[\s\S]*?\*\//g, " ")
            .replace(/'(?:[^']|'')*'/g, "''")
            .replace(/"(?:[^"]|"")*"/g, '""'),
        ),
      });
    const refPath = nextFile();
    AuditDb.open({ sqlitePath: refPath }).close();
    const refDb = new Database(refPath, { readonly: true, strict: true });
    const refShapes = new Map(AUDIT_TABLE_NAMES.map((t) => [t, shapeOf(refDb, t)]));
    refDb.close();

    for (let v = 2; v < SCHEMA_VERSION; v++) {
      const path = nextFile();
      const seed = AuditDb.open({ sqlitePath: path }); // current schema…
      const { runId } = seed.startRun(runInput()); // …carrying REAL rows the heal must not lose
      seed.upsertRunUnitHead({ runId, organization: "o", repository: "r", branch: "main", commitSha: "s", status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
      seed.close();
      const w = new Database(path, { strict: true });
      for (const sql of DOWN_TRANSFORMS[v]!) w.exec(sql); // …downgraded to era-v shapes…
      w.close(); // …still under the CURRENT stamp
      // Teeth against a vacuous entry: the transform must actually produce a NON-current shape,
      // or this loop would assert nothing about healing that era.
      const downgraded = new Database(path, { readonly: true, strict: true });
      const changed = AUDIT_TABLE_NAMES.filter((t) => shapeOf(downgraded, t) !== refShapes.get(t));
      downgraded.close();
      expect(changed.length).toBeGreaterThan(0);

      AuditDb.open({ sqlitePath: path }).close(); // must adopt AND heal
      const healed = new Database(path, { readonly: true, strict: true });
      for (const t of AUDIT_TABLE_NAMES) expect(shapeOf(healed, t)).toBe(refShapes.get(t)!);
      // Rows rode through: the run survived and the head row kept its fields (a drop-and-recreate
      // "heal" would fail here). Columns the era-v transform destroyed read NULL — every era loses
      // the v4 policy columns (the seeded scanned_commit_date proves the loss is honest, never
      // refabricated); the v2 transform additionally loses is_default_branch, while the v3 era
      // KEEPS it (its body carries the column, so the heal must preserve the stored 1).
      expect((healed.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(1);
      expect(healed.query("SELECT branch, commit_sha, is_default_branch, scanned_commit_date FROM run_unit_head").all())
        .toEqual([{ branch: "main", commit_sha: "s", is_default_branch: v >= 3 ? 1 : null, scanned_commit_date: null }]);
      healed.close();
    }
  });

  test("a foreign table matching an audit table's column NAMES but not its types is refused", () => {
    // The repair path must prove same-TABLE, not same-names: identical column names with
    // all-INTEGER types, no NOT NULLs and no PK is someone else's table wearing our labels.
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec(`CREATE TABLE errors (id INTEGER, run_id INTEGER, scope INTEGER, organization INTEGER,
      repository INTEGER, branch INTEGER, package_name INTEGER, version INTEGER, message INTEGER, occurred_at INTEGER)`);
    d.exec("INSERT INTO errors (id) VALUES (1), (2), (3)");
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.objects).toEqual(before.objects);
    expect(rowCount(path, "errors")).toBe(3);
  });

  test("a WITHOUT ROWID clone of an audit table is refused despite identical columns", () => {
    // Same columns, types, constraints and PK as our api_cache — only the rowid-ness differs.
    // table_xinfo alone cannot see that; the shape check must include it.
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec(`CREATE TABLE api_cache (
      method TEXT NOT NULL, url TEXT NOT NULL, variant_hash TEXT NOT NULL,
      etag TEXT, response_body TEXT, cached_at TEXT NOT NULL,
      PRIMARY KEY (method, url, variant_hash)) WITHOUT ROWID`);
    d.exec(`INSERT INTO api_cache VALUES ('GET', 'https://x', '', NULL, '{}', '2026-01-01T00:00:00.000Z')`);
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.objects).toEqual(before.objects);
    expect(rowCount(path, "api_cache")).toBe(1);
  });

  // Constraint semantics count toward the shape: table_xinfo alone cannot see FOREIGN KEY
  // clauses, PK/UNIQUE index structure, or AUTOINCREMENT — a foreign table can match every
  // column tuple while missing all three. Each fixture below diverges in exactly ONE of them,
  // so each kills its own fingerprint component.
  test("an errors clone with exact columns but NO foreign key is refused", () => {
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec(`CREATE TABLE errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      organization TEXT, repository TEXT, branch TEXT,
      package_name TEXT, version TEXT,
      message TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    )`);
    d.exec(`INSERT INTO errors (run_id, scope, message, occurred_at) VALUES ('r','s','m','t'), ('r2','s','m','t')`);
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.objects).toEqual(before.objects);
    expect(rowCount(path, "errors")).toBe(2);
  });

  test("an errors clone with exact columns but NO AUTOINCREMENT is refused", () => {
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    // REFERENCES to a table absent from this file is legal SQLite (resolved lazily at DML
    // under PRAGMA foreign_keys, which is OFF here) — foreign_key_list still reports it.
    d.exec(`CREATE TABLE errors (
      id INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      scope TEXT NOT NULL,
      organization TEXT, repository TEXT, branch TEXT,
      package_name TEXT, version TEXT,
      message TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    )`);
    d.exec(`INSERT INTO errors (run_id, scope, message, occurred_at) VALUES ('r','s','m','t'), ('r2','s','m','t')`);
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.objects).toEqual(before.objects);
    expect(rowCount(path, "errors")).toBe(2);
  });

  test("a work_queue clone with exact columns but NO UNIQUE constraint is refused", () => {
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec(`CREATE TABLE work_queue (
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
      error_message TEXT, updated_at TEXT NOT NULL
    )`);
    d.exec(`INSERT INTO work_queue (config_hash, created_run_id, last_run_id, scope, organization, status, updated_at)
      VALUES ('h','r','r','org','o','pending','t'), ('h2','r','r','org','o','pending','t')`);
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.objects).toEqual(before.objects);
    expect(rowCount(path, "work_queue")).toBe(2);
  });

  test("a work_queue clone whose two FKs are fused into one COMPOSITE foreign key is refused", () => {
    // Constraint GROUPING counts, not just the flattened column pairs: our work_queue declares
    // two independent single-column FKs to runs(run_id); a composite
    // FOREIGN KEY(created_run_id, last_run_id) REFERENCES runs(run_id, run_id) yields the same
    // (from, to) pairs — only the grouping (foreign_key_list's id/seq) tells them apart, so the
    // signature must keep per-constraint structure while staying declaration-order-insensitive.
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec(`CREATE TABLE work_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_hash TEXT NOT NULL,
      created_run_id TEXT NOT NULL,
      last_run_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      organization TEXT NOT NULL,
      repository TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT '',
      last_commit_sha TEXT NOT NULL DEFAULT '',
      last_commit_date TEXT,
      status TEXT NOT NULL,
      error_message TEXT, updated_at TEXT NOT NULL,
      UNIQUE(config_hash, scope, organization, repository, branch),
      FOREIGN KEY(created_run_id, last_run_id) REFERENCES runs(run_id, run_id)
    )`);
    d.exec(`INSERT INTO work_queue (config_hash, created_run_id, last_run_id, scope, organization, status, updated_at)
      VALUES ('h','r','r','org','o','pending','t'), ('h2','r','r','org','o','pending','t')`);
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.objects).toEqual(before.objects);
    expect(rowCount(path, "work_queue")).toBe(2);
  });

  test("an AUTOINCREMENT spoofed as a COMMENT in the stored CREATE text is refused", () => {
    // The AUTOINCREMENT bit has no pragma, so it is probed as a token in the stored CREATE
    // text — which must not read `/* AUTOINCREMENT */` (a comment, no semantics: the rowid
    // reuse behavior genuinely differs) as the keyword. Comments are stripped before probing;
    // the remaining text-level vectors (the word inside a string DEFAULT or an identifier)
    // necessarily change a column tuple and fail the column signature instead.
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec(`CREATE TABLE errors (
      id INTEGER PRIMARY KEY /* AUTOINCREMENT */,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      scope TEXT NOT NULL,
      organization TEXT, repository TEXT, branch TEXT,
      package_name TEXT, version TEXT,
      message TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    )`);
    d.exec(`INSERT INTO errors (run_id, scope, message, occurred_at) VALUES ('r','s','m','t'), ('r2','s','m','t')`);
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.objects).toEqual(before.objects);
    expect(rowCount(path, "errors")).toBe(2);
  });

  test("an AUTOINCREMENT lookalike inside a CHECK string or a quoted constraint name is refused", () => {
    // The sibling vectors of the comment spoof: the token can also live in a string literal
    // inside a CHECK body, or as a QUOTED constraint name — none of which any structured
    // pragma reports. The probe must strip literals and quoted identifiers too (mirroring
    // read()'s stripping); SQLite's parser rejects the BARE keyword as an identifier, so a
    // token that survives the stripping can only be the real AUTOINCREMENT clause.
    const buildClone = (path: string, extraClause: string): void => {
      const d = new Database(path, { create: true, strict: true });
      d.exec("PRAGMA journal_mode = delete;");
      d.exec(`CREATE TABLE errors (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        scope TEXT NOT NULL,
        organization TEXT, repository TEXT, branch TEXT,
        package_name TEXT, version TEXT,
        message TEXT NOT NULL,
        occurred_at TEXT NOT NULL${extraClause}
      )`);
      d.exec(`INSERT INTO errors (run_id, scope, message, occurred_at) VALUES ('r','s','m','t'), ('r2','s','m','t')`);
      d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      d.close();
    };
    for (const clause of [",\n CHECK ('autoincrement' <> version)", ',\n CONSTRAINT "AUTOINCREMENT" CHECK (1)'] as const) {
      const path = nextFile();
      buildClone(path, clause);
      const before = fileState(path);

      expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

      const after = fileState(path);
      expect(after.journalMode).toBe("delete");
      expect(after.sidecars).toEqual([]);
      expect(after.objects).toEqual(before.objects);
      expect(rowCount(path, "errors")).toBe(2);
    }
  });

  test("an api_cache clone whose PRIMARY KEY sorts a column DESC is refused", () => {
    // index_info reports the key columns but not their SORT DIRECTION — a clone identical in
    // every other respect can invert an index order. index_xinfo's desc (and coll) close it.
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec(`CREATE TABLE api_cache (
      method TEXT NOT NULL, url TEXT NOT NULL, variant_hash TEXT NOT NULL,
      etag TEXT, response_body TEXT, cached_at TEXT NOT NULL,
      PRIMARY KEY (method DESC, url, variant_hash))`);
    d.exec(`INSERT INTO api_cache VALUES ('GET', 'https://x', '', NULL, '{}', '2026-01-01T00:00:00.000Z')`);
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.objects).toEqual(before.objects);
    expect(rowCount(path, "api_cache")).toBe(1);
  });

  test("a nonzero application_id is affirmative foreign provenance — refused even with PERFECT shapes", () => {
    // application_id is SQLite's designated file-type marker: another application stamps it
    // nonzero; this tool never writes it, and every database it ever produced reads 0. A
    // nonzero id therefore proves the file is someone else's, even when the schema is a
    // byte-perfect structural clone (built here by the tool itself, then re-marked).
    const path = nextFile();
    AuditDb.open({ sqlitePath: path }).close();
    const w = new Database(path, { strict: true });
    w.exec("PRAGMA journal_mode = delete;");
    w.exec("PRAGMA application_id = 252006674"); // 0x0F055112 — Fossil's registered id
    w.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true, purgeCache: true })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual(before.sidecars);
    expect(after.userVersion).toBe(SCHEMA_VERSION);
    expect(after.objects).toEqual(before.objects);
  });

  test("a delimiter-collision column name cannot forge an audit table's shape signature", () => {
    // Shape signatures must be INJECTIVE. A naive `name:type:...` join with `|` between columns
    // is not: one column legally named `<sig1>|<sig2-minus-its-tail>` serializes exactly like two
    // real columns. Craft that collision live against the REAL errors shape (derived from a fresh
    // database, so this cannot drift from the schema) and prove it no longer matches.
    const ref = nextFile();
    AuditDb.open({ sqlitePath: ref }).close();
    const r = new Database(ref, { readonly: true, strict: true });
    const cols = r.query("PRAGMA table_xinfo(errors)").all() as Array<{
      name: string; type: string | null; notnull: number; dflt_value: string | null; pk: number; hidden: number;
    }>;
    r.close();
    // The legacy (non-injective) encoding this collision defeats: per-column `:` join, `|` between.
    const legacyParts = cols
      .map((c) => `${c.name}:${(c.type ?? "").toUpperCase()}:${c.notnull}:${c.dflt_value ?? ""}:${c.pk}:${c.hidden}`)
      .sort();
    const joined = legacyParts.join("|");
    const tail = ":TEXT:0::0:0"; // the signature a plain nullable TEXT column contributes
    expect(joined.endsWith(tail)).toBe(true); // sorted-last errors column is nullable TEXT — precondition
    const craftedName = joined.slice(0, -tail.length);

    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec(`CREATE TABLE errors ("${craftedName}" TEXT)`);
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.objects).toEqual(before.objects);
  });

  test("a foreign partial set with audit NAMES but wrong column shapes is still refused", () => {
    // The repair path must not readmit the lone-generic-table disguise: audit names carrying
    // someone else's column shapes match no state this tool can produce.
    const path = nextFile();
    const d = new Database(path, { create: true, strict: true });
    d.exec("PRAGMA journal_mode = delete;");
    d.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY)"); // audit NAME, foreign shape
    d.exec("CREATE TABLE errors (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
    d.exec("INSERT INTO errors (note) VALUES ('a'), ('b'), ('c')");
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    const before = fileState(path);

    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(DbError);

    const after = fileState(path);
    expect(after.journalMode).toBe("delete");
    expect(after.sidecars).toEqual([]);
    expect(after.objects).toEqual(before.objects);
    expect(rowCount(path, "errors")).toBe(3);
  });

  test("an OWN WAL database copied without its -wal/-shm sidecars still reopens", () => {
    // A WAL database that is cleanly closed / checkpointed and then copied as the bare `.db`
    // (a common backup) arrives with NO sidecars. The ownership preflight must read it as OURS
    // and let the writable open recreate the sidecars — a plain readonly probe would instead hit
    // SQLITE_CANTOPEN and refuse a perfectly good database with the circular "run audit" error.
    const path = nextFile();
    const first = AuditDb.open({ sqlitePath: path }); // opens in WAL (open's journal_mode pragma)
    first.startRun(runInput());
    first.close();
    // Checkpoint into the base file, then strip the sidecars — the "copied only the .db" state.
    const w = new Database(path, { strict: true });
    w.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    w.close();
    for (const s of readdirSync(TEST_ROOT).filter((f) => f.startsWith(`${basename(path)}-`)))
      rmSync(join(TEST_ROOT, s));
    expect(readdirSync(TEST_ROOT).filter((f) => f.startsWith(`${basename(path)}-`))).toEqual([]);

    const db = AuditDb.open({ sqlitePath: path });
    try {
      expect(rowCount(path, "runs")).toBe(1); // the row survived; the db was not refused or reset
    } finally {
      db.close();
    }
  });
});

// The writable-open backstop's guard, tested directly: its live trigger is a checkpoint RACE
// between the preflight and the writable open, impractical to fabricate deterministically —
// the same reason mapReadOnlyOpenError is unit-tested as a pure function.
describe("isOwnedOrEmpty — the writable-open backstop's guard", () => {
  test("an empty database is adoptable (fresh creation must survive the backstop)", () => {
    const d = new Database(":memory:", { strict: true });
    expect(isOwnedOrEmpty(d)).toBe(true);
    d.close();
  });

  test("a full audit database passes", () => {
    const db = mem();
    expect(isOwnedOrEmpty(raw(db))).toBe(true);
    db.close();
  });

  test("a foreign table alongside the audit set fails", () => {
    const db = mem();
    raw(db).exec("CREATE TABLE customers (id INTEGER PRIMARY KEY)");
    expect(isOwnedOrEmpty(raw(db))).toBe(false);
    db.close();
  });

  test("a lone audit-named table with a plausible stamp fails (set + shape check applies)", () => {
    const d = new Database(":memory:", { strict: true });
    d.exec("CREATE TABLE errors (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    expect(isOwnedOrEmpty(d)).toBe(false);
    d.close();
  });

  test("a full audit set restamped user_version=0 fails (a dump/restore that lost its pragmas was never ours)", () => {
    // The backstop must enforce the same version floor as the preflight: our stamps are
    // transactional, so real audit tables under uv 0 mean the header pragmas were lost — the
    // preflight refuses that file (dump/restore test above), and the backstop must not be the
    // weaker gate that a checkpoint race could slip it through.
    const db = mem();
    raw(db).exec("PRAGMA user_version = 0");
    expect(isOwnedOrEmpty(raw(db))).toBe(false);
    db.close();
  });

  test("a full audit set stamped PAST this tool's version fails (no reference shape can verify it)", () => {
    const db = mem();
    raw(db).exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(isOwnedOrEmpty(raw(db))).toBe(false);
    db.close();
  });

  test("an object-free database stamped PAST this tool's version fails even the EMPTY arm", () => {
    // Lockstep with the preflight, which checks the version before its empty arm: a future
    // tool's stamped-but-empty shell is "upgrade the tool" territory, never "ours to create".
    // (Live, the writable open's own version gate fires before the backstop — this pins the
    // exported predicate itself.)
    const d = new Database(":memory:", { strict: true });
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(isOwnedOrEmpty(d)).toBe(false);
    d.close();
  });

  test("a nonzero application_id fails both arms (foreign provenance beats shapes AND emptiness)", () => {
    // The full-shape arm: a perfect structural clone marked by another application is theirs.
    const marked = mem();
    raw(marked).exec("PRAGMA application_id = 252006674");
    expect(isOwnedOrEmpty(raw(marked))).toBe(false);
    marked.close();
    // The EMPTY arm: an object-free file with a nonzero id is another application's freshly
    // initialized database (header written before any DDL), never "ours to create".
    const shell = new Database(":memory:", { strict: true });
    shell.exec("PRAGMA application_id = 252006674");
    expect(isOwnedOrEmpty(shell)).toBe(false);
    shell.close();
  });

  test("the --fresh-preserved caches pass with REAL shapes and fail with foreign shapes under the same names", () => {
    // Both halves of the fresh-preserved question, at the backstop: our own --fresh-crash
    // leftover must stay adoptable, a stranger's file wearing the same two names must not.
    const ours = mem();
    for (const t of ["run_unit_head", "dependency_findings", "usage_findings", "errors", "work_queue", "runs"])
      raw(ours).exec(`DROP TABLE ${t}`);
    expect(isOwnedOrEmpty(raw(ours))).toBe(true);
    ours.close();

    const forged = new Database(":memory:", { strict: true });
    forged.exec("CREATE TABLE api_cache (cache_key TEXT PRIMARY KEY, payload BLOB)");
    forged.exec("CREATE TABLE package_api_surface (pkg TEXT NOT NULL, region TEXT)");
    forged.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    expect(isOwnedOrEmpty(forged)).toBe(false);
    forged.close();
  });
});

describe("corrupted database files fail closed with OUR context, never a raw SQLiteError", () => {
  test("openReadOnly on a corrupted database surfaces a DbError, not a raw SQLITE_CORRUPT", () => {
    // The ownership probe's sqlite_master read is the first statement to touch the zeroed
    // schema btree; before mapReadOnlyOpenError classified the corrupt family, that raw
    // "database disk image is malformed" SQLiteError reached report/export callers verbatim.
    const path = nextFile();
    AuditDb.open({ sqlitePath: path }).close();
    corruptSchemaPage(path);
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(DbError);
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/corrupted or not a SQLite database/);
  });

  test("the writable init span (PRAGMAs + version gate + backstop) fails closed: DbError, handle closed", () => {
    // The live trigger is a file changing between the preflight and the writable open (the
    // documented checkpoint race the backstop exists for) — impractical to fabricate
    // deterministically end-to-end, the same rationale as isOwnedOrEmpty's own export. Called
    // directly on a corrupted file: EVERY raw throw inside the init span (here the corrupt
    // schema btree, met by the first statement that needs it) must come out as a DbError naming
    // the init span AND must close the handle — no leaked writable connection on a file whose
    // ownership could not be re-verified. (The message deliberately does NOT say "ownership
    // check": with the WAL pragma LAST in the span, a raw throw can also be a filesystem
    // problem met AFTER ownership was proven — see the finalize-failure test below.)
    const path = nextFile();
    AuditDb.open({ sqlitePath: path }).close();
    corruptSchemaPage(path);
    const db = new Database(path, { strict: true });
    let caught: unknown;
    try {
      initWritableConnection(db, path);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DbError);
    expect((caught as Error).message).toMatch(/writable connection could not be verified and initialized/);
    expect(() => db.query("SELECT 1 AS x").get()).toThrow(/closed database/);
  });

  test("a WAL-pragma failure AFTER the gates passed still fails closed — and is not blamed on the ownership check", () => {
    // The rebase moved journal_mode=WAL to the END of the init span (a rejection must never
    // persist a delete→wal flip), which created a new raw-throw class: an OWNED, compatible
    // database in a directory that became unwritable — the gates all pass, then the WAL pragma
    // (the first statement needing a write) throws. The wrap must close the handle and the
    // message must not claim ownership could not be verified (it WAS).
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const dir = join(TEST_ROOT, `ro-finalize-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "db.db");
    const seed = new Database(path, { create: true, strict: true });
    seed.exec("PRAGMA journal_mode = delete;"); // no sidecars, so the open below needs no recovery
    seed.close();
    chmodSync(dir, 0o500); // directory read-only: -wal/-shm creation (the WAL flip) must fail
    try {
      const db = new Database(path, { strict: true });
      let caught: unknown;
      try {
        initWritableConnection(db, path);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DbError);
      expect((caught as Error).message).toMatch(/writable connection could not be verified and initialized/);
      expect((caught as Error).message).not.toMatch(/ownership/);
      expect(() => db.query("SELECT 1 AS x").get()).toThrow(/closed database/);
    } finally {
      chmodSync(dir, 0o700); // restore so afterAll's rmSync can clean up
    }
    // The rejection changed nothing: still a rollback-journal database, no sidecars spawned.
    const check = new Database(path, { readonly: true, strict: true });
    expect((check.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).not.toBe("wal");
    check.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });
});

// Synchronous stdout JSONL capture (open() is sync — orchestrate.test.ts's helper is async).
// Keeps the fresh-drop warning out of the test runner's real stdout, and returns the
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
    db.upsertRunUnitHead({ runId: "r1", organization: "o", repository: "r", branch: "b", commitSha: "", status: "skipped-cutoff", isDefaultBranch: null, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    db.upsertRunUnitHead({ runId: "r1", organization: "o", repository: "r", branch: "b", commitSha: "sha2", status: "scanned", isDefaultBranch: null, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    const rows = raw(db).query("SELECT commit_sha, status FROM run_unit_head").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]!["commit_sha"]).toBe("sha2");
    expect(rows[0]!["status"]).toBe("scanned");
    db.close();
  });
});

describe("reconcileRunUnitHead (stale-row prune)", () => {
  const scanned = (db: AuditDb, runId: string, org: string, repo: string, branch: string): void =>
    db.upsertRunUnitHead({ runId, organization: org, repository: repo, branch, commitSha: `sha-${branch}`, status: "scanned", isDefaultBranch: false, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
  const branchesOf = (db: AuditDb, runId: string, org: string, repo: string): string[] =>
    (db.read("SELECT branch FROM run_unit_head WHERE run_id=? AND organization=? AND repository=? ORDER BY branch").all(runId, org, repo) as Array<{ branch: string }>).map((r) => r.branch);

  test("prunes branches absent from the discovered set, keeps the rest; returns the prune count", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    for (const b of ["a", "b", "c"]) scanned(db, "r1", "o", "repo", b);
    expect(db.reconcileRunUnitHead("r1", "o", "repo", ["a", "b"])).toBe(1); // c pruned
    expect(branchesOf(db, "r1", "o", "repo")).toEqual(["a", "b"]);
    db.close();
  });

  test("NEVER touches another run_id / repository / organization", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    rawRun(db, "r2", "running");
    scanned(db, "r1", "o", "repo", "x");
    scanned(db, "r2", "o", "repo", "x");          // other run
    scanned(db, "r1", "o", "other-repo", "x");    // other repo
    scanned(db, "r1", "other-org", "repo", "x");  // other org, SAME repo name
    expect(db.reconcileRunUnitHead("r1", "o", "repo", [])).toBe(1); // only (r1,o,repo,x)
    expect(branchesOf(db, "r1", "o", "repo")).toEqual([]);
    expect(branchesOf(db, "r2", "o", "repo")).toEqual(["x"]);
    expect(branchesOf(db, "r1", "o", "other-repo")).toEqual(["x"]);
    expect(branchesOf(db, "r1", "other-org", "repo")).toEqual(["x"]);
    db.close();
  });

  test("an empty discovered set prunes ALL of the scope's rows (the last branch was deleted)", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    scanned(db, "r1", "o", "repo", "a");
    scanned(db, "r1", "o", "repo", "b");
    expect(db.reconcileRunUnitHead("r1", "o", "repo", [])).toBe(2);
    expect(branchesOf(db, "r1", "o", "repo")).toEqual([]);
    db.close();
  });

  test("is idempotent: a second reconcile with the same live set prunes nothing (returns 0)", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    for (const b of ["a", "b", "c"]) scanned(db, "r1", "o", "repo", b);
    expect(db.reconcileRunUnitHead("r1", "o", "repo", ["a"])).toBe(2);
    expect(db.reconcileRunUnitHead("r1", "o", "repo", ["a"])).toBe(0);
    expect(branchesOf(db, "r1", "o", "repo")).toEqual(["a"]);
    db.close();
  });

  test("branch names with quotes, backslashes, slashes, commas, and Unicode survive JSON membership", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    const weird = ['feat/"quote"', "back\\slash", "dir/sub/leaf", "ünïcödé-π", "a,b"];
    for (const b of weird) scanned(db, "r1", "o", "repo", b);
    scanned(db, "r1", "o", "repo", "stale");
    expect(db.reconcileRunUnitHead("r1", "o", "repo", weird)).toBe(1); // ONLY "stale" pruned — every weird name is kept
    expect(branchesOf(db, "r1", "o", "repo").sort()).toEqual([...weird].sort());
    db.close();
  });
});

describe("pruneExcludedOwnerHeads (§1 case-insensitive exclusion on resume)", () => {
  const scanned = (db: AuditDb, runId: string, org: string, repo: string): void =>
    db.upsertRunUnitHead({ runId, organization: org, repository: repo, branch: "main", commitSha: `sha-${org}-${repo}`, status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
  const orgsOf = (db: AuditDb, runId: string): string[] =>
    (db.read("SELECT DISTINCT organization FROM run_unit_head WHERE run_id=? ORDER BY organization").all(runId) as Array<{ organization: string }>).map((r) => r.organization);

  test("drops rows for an owner a CASE-VARIANT exclude now matches; keeps other owners and other runs", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    rawRun(db, "r2", "running");
    scanned(db, "r1", "acme", "a");  // API-canonical owner scanned before the old case-sensitive exclude was fixed
    scanned(db, "r1", "acme", "b");
    scanned(db, "r1", "bigco", "c"); // a different, non-excluded owner — must be kept
    scanned(db, "r2", "acme", "a");  // same owner, DIFFERENT run — must survive (the prune is run-scoped)
    // exclude "Acme" (config spelling) must match the canonical "acme" CASE-INSENSITIVELY
    expect(db.pruneExcludedOwnerHeads("r1", ["Acme"])).toBe(2);
    expect(orgsOf(db, "r1")).toEqual(["bigco"]); // acme rows gone, bigco kept
    expect(orgsOf(db, "r2")).toEqual(["acme"]); // the other run is untouched
    db.close();
  });

  test("no-op when the denylist is empty or matches no owner in the run (never over-prunes)", () => {
    const db = mem();
    rawRun(db, "r1", "running");
    scanned(db, "r1", "acme", "a");
    expect(db.pruneExcludedOwnerHeads("r1", [])).toBe(0); // empty denylist → no-op (the common case)
    expect(db.pruneExcludedOwnerHeads("r1", ["other-org"])).toBe(0); // no case-insensitive match → no-op
    expect(orgsOf(db, "r1")).toEqual(["acme"]); // a transiently-undiscovered-but-not-excluded owner keeps its rows
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
    // §5.E epoch: the marker's `source` carries the current surface schema version.
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

describe("package_api_surface — §5.E surface-cache epoch", () => {
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
// every one of them — most importantly the four run-scoped tables the since-removed legacy
// migration's reset would have destroyed).
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
  // The marker carries the CURRENT surface epoch (§5.E): this fixture models a v2 database
  // written by the current pre-v3 code, whose markers are epoch-stamped. (A PRE-epoch bare
  // '__complete__' marker deliberately reads as ABSENT — that shape has its own tests — and
  // using it here would silently drain the round-trip twin's apiSurface coverage.)
  raw.exec(`INSERT INTO package_api_surface (id, package_name, version, version_source, export_name, export_kind, source, introspected_at) VALUES
    (31, 'expo', '50.0.0', 'lockfile', 'registerRootComponent', 'named', 'build/Expo.d.ts', '2026-01-01T00:15:00.000Z'),
    (35, 'expo', '50.0.0', 'lockfile', '', '__complete__', '__complete__@${SURFACE_SCHEMA_VERSION}', '2026-01-01T00:15:00.000Z')`);
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

// A v3 twin of the v2 fixture: identical logical data, built independently with raw SQL
// (v2 schema + the additive ALTER + a v3 stamp — no db.ts migration code involved; note this
// mirrors the migration's ALTER mechanism rather than a fresh-CREATE column order, which is
// fine because the report never reads run_unit_head positionally). The
// CRITICAL round-trip test compares the MIGRATED v2 database's report byte-for-byte against
// this twin's: migration must be indistinguishable from having stored the data natively (with
// is_default_branch NULL, exactly the migration backfill). The report format itself now carries
// isDefaultBranch, so a pre-migration "before" report is no longer constructible — the twin IS
// the before-equivalent baseline.
function buildV3TwinDb(path: string): void {
  buildV2Db(path);
  const raw = new Database(path, { strict: true });
  raw.exec("ALTER TABLE run_unit_head ADD COLUMN is_default_branch INTEGER");
  // LITERAL 3, never SCHEMA_VERSION: this is a native v3-shaped fixture. Stamping SCHEMA_VERSION
  // would falsely claim the current version once the constant bumps (a v3-shaped table stamped v4
  // is treated as current-stamp DAMAGE and healed, not migrated). Opening it drives the real
  // v3→v4 migration, the same path the migrated-v2 database takes, so their reports stay
  // byte-identical.
  raw.exec("PRAGMA user_version = 3");
  raw.close();
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
  test("real v2 data opens under v3: everything preserved, old run's report byte-identical to a native-v3 twin", () => {
    const path = nextFile();
    buildV2Db(path);

    // Baseline projections from the UNMIGRATED v2 database (precondition-checked).
    const rawBefore = new Database(path, { strict: true });
    expect((rawBefore.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    const v2Cols = (rawBefore.query("PRAGMA table_info(run_unit_head)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(v2Cols).not.toContain("is_default_branch");
    const beforeProjections = new Map<string, unknown[]>();
    for (const [table, sql] of Object.entries(V2_PROJECTIONS)) beforeProjections.set(table, rawBefore.query(sql).all());
    rawBefore.close();

    // The report baseline: identical data stored NATIVELY in v3 shape (see buildV3TwinDb).
    const twinPath = nextFile();
    buildV3TwinDb(twinPath);
    const twin = AuditDb.open({ sqlitePath: twinPath });
    const expectedReport = JSON.stringify(buildReport(twin, twin.getRun("v2-run")!), null, 2);
    twin.close();

    // Migrate by opening through the production path.
    const db = AuditDb.open({ sqlitePath: path });
    try {
      const r = raw(db);
      expect((r.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      // Every v2 row survives, byte-for-byte on the v2 columns — with EXACTLY ONE intended field
      // change: the v3→v4 migration-boundary rule fails the pre-v4 running run (see migrateV3toV4).
      // status stays IN the projection so any other flip would still be caught.
      const expectedRuns = (beforeProjections.get("runs")! as Array<Record<string, unknown>>).map((row) =>
        row.run_id === "v2-running" ? { ...row, status: "failed" } : row,
      );
      for (const [table, sql] of Object.entries(V2_PROJECTIONS)) {
        expect(r.query(sql).all()).toEqual(table === "runs" ? expectedRuns : beforeProjections.get(table)!);
      }
      // The new column exists and is NULL (= unknown) on every migrated row — never 0.
      const flags = r.query("SELECT is_default_branch FROM run_unit_head").all() as Array<{ is_default_branch: unknown }>;
      expect(flags.length).toBe(2);
      for (const f of flags) expect(f.is_default_branch).toBeNull();
      // Referential integrity intact.
      expect(r.query("PRAGMA foreign_key_check").all()).toEqual([]);
      // The pre-v4 running run IS failed — by the v3→v4 migration-boundary rule, NOT by the
      // additive v2→v3 step: a run spanning pre-v4 and v4 semantics could report unverifiable
      // 'complete' provenance (see migrateV3toV4's boundary-rule note and the dedicated test below).
      expect(db.getRun("v2-running")?.status).toBe("failed");
      // The old run's report is byte-identical to the natively-stored twin's.
      const migratedReport = buildReport(db, db.getRun("v2-run")!);
      const afterReport = JSON.stringify(migratedReport, null, 2);
      expect(afterReport).toBe(expectedReport);
      expect(afterReport).toContain('"isDefaultBranch": null'); // pre-v3 rows render as unknown
      // apiSurface must be POPULATED, not silently drained: the fixture's epoch-stamped completion
      // marker is load-bearing. A bare/stale marker reads as ABSENT (§5.E epoch), so the surface would
      // empty out and the byte-identity above would still pass empty-vs-empty (both build from the
      // same fixture) — asserting NOTHING. This positive check makes that regression fail (see 4d0b42d).
      const migratedExpo = migratedReport.packages.find((p) => p.name === "expo");
      expect(migratedExpo?.apiSurface["50.0.0"]?.exports).toContainEqual({ name: "registerRootComponent", kind: "named" });
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

describe("--fresh drop-time warning", () => {
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
    db.upsertRunUnitHead({ ...base, branch: "main", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    db.upsertRunUnitHead({ ...base, branch: "dev", isDefaultBranch: false, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    db.upsertRunUnitHead({ ...base, branch: "old", isDefaultBranch: null, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    const flags = raw(db)
      .query("SELECT branch, is_default_branch AS f FROM run_unit_head ORDER BY branch")
      .all() as Array<{ branch: string; f: unknown }>;
    expect(flags).toEqual([
      { branch: "dev", f: 0 },
      { branch: "main", f: 1 },
      { branch: "old", f: null },
    ]);
    // conflict path: a later upsert of the SAME unit updates the flag (e.g. default moved)
    db.upsertRunUnitHead({ ...base, branch: "dev", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    const dev = raw(db).query("SELECT is_default_branch AS f FROM run_unit_head WHERE branch='dev'").get() as { f: unknown };
    expect(dev.f).toBe(1);
    db.close();
  });
});

describe("upsertRunUnitHead — branch allow/deny (§3 mapping, write-boundary guards, transitions)", () => {
  // Valid non-default scanned baseline; override per case. runId "r1" must exist for the FK.
  const seed = (db: AuditDb, over: Partial<RunUnitHeadInput> = {}): void =>
    db.upsertRunUnitHead({
      runId: "r1", organization: "o", repository: "r", branch: "b", commitSha: "sha1",
      status: "scanned", isDefaultBranch: false,
      policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-01-01T00:00:00Z",
      ...over,
    });
  const rowOf = (db: AuditDb, branch = "b"): Record<string, unknown> =>
    raw(db)
      .query(
        `SELECT status, is_default_branch AS d, policy_status AS ps, policy_matched_pattern AS pat,
                commit_sha AS sha, scanned_commit_date AS scd FROM run_unit_head WHERE branch = ?`,
      )
      .get(branch) as Record<string, unknown>;
  const fresh = (): AuditDb => {
    const db = mem();
    rawRun(db, "r1", "running");
    return db;
  };

  // ---- write-boundary guards (§3 mapping enforced at the single chokepoint) ----
  test.each([
    ["runId", { runId: new Uint8Array([120]) as unknown as string }],
    ["organization", { organization: new Uint8Array([120]) as unknown as string }],
    ["repository", { repository: new Uint8Array([120]) as unknown as string }],
    ["branch", { branch: new Uint8Array([120]) as unknown as string }],
    ["commitSha", { commitSha: new Uint8Array([120]) as unknown as string }],
  ])("G0: a non-string %s is rejected at the WRITE chokepoint (a BLOB row would poison or vanish from every read)", (_k, over) => {
    // Two reviewers independently proved the asymmetry by execution: the input type is erased at
    // runtime and the table is not STRICT, so a caller bug passing a Uint8Array stored a BLOB the
    // read gate then refused FOREVER (identity trio / commit_sha) — and a BLOB runId is worse:
    // run-scoped reads filter WHERE run_id = ?, so the row silently vanishes instead of throwing.
    const db = fresh();
    expect(() => seed(db, over)).toThrow(/must be a string at runtime/);
    db.close();
  });

  test("G0b: a BLOB policy field is rejected at the WRITE chokepoint (no raw TypeError, no laundering)", () => {
    // (a non-boolean isDefaultBranch is already rejected by the tri-state domain check — G2b pins it)
    const db = fresh();
    // a Uint8Array pattern has .length (passes non-empty) but no .startsWith — previously a raw TypeError
    expect(() => seed(db, { policyStatus: "excluded-by-deny", policyMatchedPattern: new Uint8Array([120]) as unknown as string, isDefaultBranch: true })).toThrow(/must be string or null at runtime/);
    db.close();
  });

  test("G1c: a deny pattern that does NOT match its branch is rejected at write — as the FATAL PolicyMatchError, never a downgradeable DbError", () => {
    // Semantic coherence, not just shape (consult option A): write time is the only point where the
    // matcher, the branch name, and the attribution coexist. The read gate stays glob-free by
    // design — re-evaluating history under a newer Bun could refuse rows that were true when
    // written — so the write chokepoint is the one verifier.
    const db = fresh();
    expect(() => seed(db, { status: "policy-excluded", isDefaultBranch: false, commitSha: "", policyStatus: "excluded-by-deny", policyMatchedPattern: "release/*" })).toThrow(/failed to match branch/);
    // the throw must be the fatal policy class (the run driver fails the whole run on it), not DbError
    try {
      seed(db, { status: "policy-excluded", isDefaultBranch: false, commitSha: "", policyStatus: "excluded-by-deny", policyMatchedPattern: "release/*" });
      throw new Error("unreachable: mismatched pattern was accepted");
    } catch (e) {
      expect((e as Error).name).toBe("PolicyMatchError");
    }
    // matching attributions still write: a real glob match…
    seed(db, { organization: "o", repository: "r", branch: "release/x", status: "policy-excluded", isDefaultBranch: false, commitSha: "", policyStatus: "excluded-by-deny", policyMatchedPattern: "release/*" });
    // …the scanned default-override (pattern must match the DEFAULT's name)…
    seed(db, { branch: "main", commitSha: "sha-main", status: "scanned", isDefaultBranch: true, policyStatus: "excluded-by-deny", policyMatchedPattern: "ma*" });
    // …and EXACT equality short-circuits without invoking the glob engine at all, so a
    // metacharacter-hostile spelling that names the branch literally verifies ("[" matches nothing
    // as a glob on the pinned Bun — only the exact-first pass can accept it).
    seed(db, { branch: "[", commitSha: "", status: "policy-excluded", isDefaultBranch: false, policyStatus: "excluded-by-deny", policyMatchedPattern: "[" });
    db.close();
  });

  test("G1c-override: a scanned default-override whose counterfactual pattern does not match the default is rejected", () => {
    const db = fresh();
    expect(() => seed(db, { branch: "main", commitSha: "sha-main", status: "scanned", isDefaultBranch: true, policyStatus: "excluded-by-deny", policyMatchedPattern: "rel*" })).toThrow(/failed to match branch/);
    db.close();
  });

  test("G1: excluded-by-deny with an empty or null pattern is rejected (the deny CHECK admits '')", () => {
    const db = fresh();
    expect(() => seed(db, { isDefaultBranch: true, policyStatus: "excluded-by-deny", policyMatchedPattern: "" })).toThrow(/non-empty policy_matched_pattern/);
    expect(() => seed(db, { isDefaultBranch: true, policyStatus: "excluded-by-deny", policyMatchedPattern: null })).toThrow(/non-empty policy_matched_pattern/);
    db.close();
  });

  test("G1b: a '!'-prefixed pattern is rejected at the WRITE chokepoint — the read gate refuses it, so storing it would poison the run", () => {
    // Reviewer-found asymmetry: the read gate (assertRunUnitHeadSound) refuses a stored '!' pattern,
    // but the chokepoint accepted it — so a buggy future writer could durably store a row that makes
    // every later report/compare/default-export throw FOREVER for that run. Fail at write instead.
    // (compileBranchPolicy already rejects leading-'!' at config load; this guards the DIRECT door.)
    const db = fresh();
    // Pinned to the CHOKEPOINT's message specifically (not an alternation with the read gate's) so a
    // future layer swap cannot let the wrong validator satisfy this write-path test.
    expect(() => seed(db, { isDefaultBranch: true, policyStatus: "excluded-by-deny", policyMatchedPattern: "!release/**" })).toThrow(/without the '!' config prefix/);
    db.close();
  });

  test("G2: a pattern without excluded-by-deny is rejected (allow-miss and no-exclusion carry none)", () => {
    const db = fresh();
    expect(() => seed(db, { isDefaultBranch: true, policyStatus: "excluded-by-allow", policyMatchedPattern: "feat/*" })).toThrow(/must be null unless excluded-by-deny/);
    expect(() => seed(db, { policyStatus: null, policyMatchedPattern: "feat/*" })).toThrow(/must be null unless excluded-by-deny/);
    db.close();
  });

  test("G2b: an OMITTED or undefined required field is rejected — undefined must never default silently", () => {
    // The field docs promise `undefined` can never silently become "not the default" / "no policy",
    // but the type is erased at runtime and the upsert's own binding would launder it:
    // `isDefaultBranch === null ? null : isDefaultBranch ? 1 : 0` maps undefined to 0 — `undefined
    // === null` is FALSE, and undefined is then falsy — durably recording "not the default branch"
    // for a branch whose default-ness was never established. A JS caller or a test double bypassing
    // the type is exactly how that arrives, so the chokepoint enforces the presence the docs claim
    // rather than trusting the compiler.
    const db = fresh();
    const base = (): Record<string, unknown> => ({
      runId: "r1", organization: "o", repository: "r", branch: "b", commitSha: "sha1",
      status: "scanned", isDefaultBranch: false,
      policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-01-01T00:00:00Z",
    });
    for (const k of ["isDefaultBranch", "policyStatus", "policyMatchedPattern", "scannedCommitDate"] as const) {
      const omitted = base();
      delete omitted[k];
      expect(() => db.upsertRunUnitHead(omitted as unknown as RunUnitHeadInput)).toThrow(new RegExp(`${k} is required \\(key omitted\\)`));
      const undef = { ...base(), [k]: undefined };
      expect(() => db.upsertRunUnitHead(undef as unknown as RunUnitHeadInput)).toThrow(new RegExp(`${k} is required, got undefined`));
    }
    // the tri-state is checked BY VALUE too, so a stray truthy/JSON-ish value cannot slip through to 1/0
    expect(() => seed(db, { isDefaultBranch: "true" as unknown as boolean })).toThrow(/is_default_branch must be true, false, or null/);
    expect(() => seed(db, { isDefaultBranch: 1 as unknown as boolean })).toThrow(/is_default_branch must be true, false, or null/);
    db.close();
  });

  test("G2c: a non-empty but NON-ISO scanned_commit_date is rejected — the field's contract is ISO, not truthy", () => {
    // A garbage date is worse than an empty one: it is accepted as authoritative and counts the run
    // as 'complete' provenance in report/compare (the STORED value is never re-read for selection —
    // but the same shared validator guards the discovery producer, where the live slice(0,10) cutoff
    // comparison IS selection). T24:00:00Z is the sharp case — a legal ISO end-of-day spelling that
    // Date.parse NORMALIZES to the next day, so a Date.parse-based guard would accept a value whose
    // date component names a different day than the instant it denotes.
    const db = fresh();
    for (const bad of ["not-a-date", "2025-06-01", "2025-02-30T00:00:00Z", "2025-06-01T24:00:00Z", "2025-99-99T99:99:99Z"])
      expect(() => seed(db, { scannedCommitDate: bad })).toThrow(/scanned_commit_date must be an ISO instant/);
    // the legitimate offset form still passes (git emits it; its UTC day may differ from the written one)
    expect(() => seed(db, { branch: "ok", scannedCommitDate: "2025-06-01T02:00:00+05:00" })).not.toThrow();
    db.close();
  });

  test("G3: a past-cap row carrying a policy_status is rejected (policy precedes the cap)", () => {
    const db = fresh();
    expect(() => seed(db, { status: "past-cap", commitSha: "", policyStatus: "excluded-by-deny", policyMatchedPattern: "b" })).toThrow(/past-cap rows must have policy_status null/);
    db.close();
  });

  test("G4: a scanned policy row that is not the KNOWN default is rejected", () => {
    const db = fresh();
    expect(() => seed(db, { policyStatus: "excluded-by-deny", policyMatchedPattern: "b", isDefaultBranch: false })).toThrow(/must be the default branch/);
    expect(() => seed(db, { policyStatus: "excluded-by-allow", isDefaultBranch: null })).toThrow(/must be the default branch/);
    db.close();
  });

  test("G5: a scanned row with an empty commit_sha is rejected", () => {
    const db = fresh();
    expect(() => seed(db, { commitSha: "" })).toThrow(/scanned row requires a non-empty commit_sha/);
    db.close();
  });

  test("G6: a non-scanned row with a non-empty commit_sha is rejected", () => {
    const db = fresh();
    expect(() => seed(db, { status: "skipped-cutoff", commitSha: "sha1" })).toThrow(/must have commit_sha=''/);
    expect(() => seed(db, { status: "past-cap", commitSha: "sha1" })).toThrow(/must have commit_sha=''/);
    db.close();
  });

  test("G7: a KNOWN default branch may not be non-scanned (the default is always scanned)", () => {
    const db = fresh();
    expect(() => seed(db, { status: "skipped-cutoff", commitSha: "", isDefaultBranch: true })).toThrow(/default branch is always scanned/);
    expect(() => seed(db, { status: "past-cap", commitSha: "", isDefaultBranch: true })).toThrow(/default branch is always scanned/);
    db.close();
  });

  test("G8: past-cap and policy-excluded rows must be a definite non-default (never null)", () => {
    const db = fresh();
    expect(() => seed(db, { status: "past-cap", commitSha: "", isDefaultBranch: null })).toThrow(/must have is_default_branch=false/);
    expect(() => seed(db, { status: "policy-excluded", commitSha: "", policyStatus: "excluded-by-allow", isDefaultBranch: null })).toThrow(/must have is_default_branch=false/);
    // a PLAIN cutoff-skip (no policy) may still be null — the pre-v3/unknown case — and is accepted.
    seed(db, { status: "skipped-cutoff", commitSha: "", isDefaultBranch: null });
    expect(rowOf(db).d).toBeNull();
    db.close();
  });

  test("a REJECTED upsert leaves a prior valid row for the same key unchanged (guard precedes the SQL)", () => {
    const db = fresh();
    seed(db, { commitSha: "good", scannedCommitDate: "2025-03-03T03:03:03Z" });
    expect(() => seed(db, { commitSha: "" })).toThrow(DbError);
    const row = rowOf(db);
    expect(row.sha).toBe("good");
    expect(row.scd).toBe("2025-03-03T03:03:03Z");
    db.close();
  });

  // ---- §3 disposition → persisted-row mapping (all eight rows) ----
  test("§3 mapping: every disposition persists the exact status/policy/pattern columns", () => {
    const db = fresh();
    seed(db, { branch: "d1", isDefaultBranch: true, commitSha: "s" }); //                                    default scanned, no-exclusion
    seed(db, { branch: "d2", isDefaultBranch: true, commitSha: "s", policyStatus: "excluded-by-deny", policyMatchedPattern: "d2" }); // default scanned, WOULD deny
    seed(db, { branch: "d3", isDefaultBranch: true, commitSha: "s", policyStatus: "excluded-by-allow" }); //   default scanned, WOULD allow-miss
    seed(db, { branch: "n1", isDefaultBranch: false, commitSha: "s" }); //                                     non-default scanned, no-exclusion
    seed(db, { branch: "n2", isDefaultBranch: false, status: "skipped-cutoff", commitSha: "" }); //            non-default cutoff-skipped
    seed(db, { branch: "n3", isDefaultBranch: false, status: "past-cap", commitSha: "" }); //                  non-default past-cap
    seed(db, { branch: "n4", isDefaultBranch: false, status: "policy-excluded", commitSha: "", policyStatus: "excluded-by-deny", policyMatchedPattern: "n*" }); // excluded by deny
    seed(db, { branch: "n5", isDefaultBranch: false, status: "policy-excluded", commitSha: "", policyStatus: "excluded-by-allow" }); //                               excluded by allow
    const all = raw(db)
      .query(`SELECT branch, status, policy_status AS ps, policy_matched_pattern AS pat FROM run_unit_head ORDER BY branch`)
      .all();
    expect(all).toEqual([
      { branch: "d1", status: "scanned", ps: null, pat: null },
      { branch: "d2", status: "scanned", ps: "excluded-by-deny", pat: "d2" },
      { branch: "d3", status: "scanned", ps: "excluded-by-allow", pat: null },
      { branch: "n1", status: "scanned", ps: null, pat: null },
      { branch: "n2", status: "skipped-cutoff", ps: null, pat: null },
      { branch: "n3", status: "past-cap", ps: null, pat: null },
      { branch: "n4", status: "policy-excluded", ps: "excluded-by-deny", pat: "n*" },
      { branch: "n5", status: "policy-excluded", ps: "excluded-by-allow", pat: null },
    ]);
    db.close();
  });

  // ---- always-overwrite transition matrix (§6): excluded.* clears stale values in every direction ----
  test("re-upsert ALWAYS overwrites policy fields — synthetic deny → no-exclusion clears them (never COALESCE)", () => {
    const db = fresh();
    seed(db, { isDefaultBranch: true, commitSha: "s", policyStatus: "excluded-by-deny", policyMatchedPattern: "b" });
    expect(rowOf(db).ps).toBe("excluded-by-deny");
    seed(db, { isDefaultBranch: true, commitSha: "s", policyStatus: null, policyMatchedPattern: null });
    expect(rowOf(db).ps).toBeNull();
    expect(rowOf(db).pat).toBeNull();
    db.close();
  });

  test("transition: scanned → past-cap clears the sha (a higher-ranked branch appeared, cap-order shift)", () => {
    const db = fresh();
    seed(db, { status: "scanned", commitSha: "sha-new", scannedCommitDate: "2025-06-06T00:00:00Z" });
    seed(db, { status: "past-cap", commitSha: "", scannedCommitDate: "2025-06-06T00:00:00Z" });
    const row = rowOf(db);
    expect(row.status).toBe("past-cap");
    expect(row.sha).toBe("");
    db.close();
  });

  test("transition: past-cap → scanned fills the sha (a higher-ranked branch vanished)", () => {
    const db = fresh();
    seed(db, { status: "past-cap", commitSha: "", scannedCommitDate: "2025-06-06T00:00:00Z" });
    seed(db, { status: "scanned", commitSha: "sha-promoted", scannedCommitDate: "2025-06-06T00:00:00Z" });
    const row = rowOf(db);
    expect(row.status).toBe("scanned");
    expect(row.sha).toBe("sha-promoted");
    db.close();
  });

  test("transition: the default flag flips (remote default changed) without disturbing the policy columns", () => {
    const db = fresh();
    seed(db, { isDefaultBranch: false, status: "scanned", commitSha: "s" });
    expect(rowOf(db).d).toBe(0);
    seed(db, { isDefaultBranch: true, status: "scanned", commitSha: "s" });
    expect(rowOf(db)).toMatchObject({ d: 1, ps: null });
    db.close();
  });

  test("transition: the branch's own head moved — both sha and scanned_commit_date refresh", () => {
    const db = fresh();
    seed(db, { commitSha: "sha-A", scannedCommitDate: "2025-01-01T00:00:00Z" });
    seed(db, { commitSha: "sha-B", scannedCommitDate: "2025-02-02T00:00:00Z" });
    expect(rowOf(db)).toMatchObject({ sha: "sha-B", scd: "2025-02-02T00:00:00Z" });
    db.close();
  });

  test("transition: a non-default DENIED branch that BECOMES default is scanned but RETAINS the deny counterfactual", () => {
    const db = fresh();
    seed(db, { isDefaultBranch: false, status: "policy-excluded", commitSha: "", policyStatus: "excluded-by-deny", policyMatchedPattern: "b" });
    // remote default moved onto this branch: now scanned (the default is always scanned), policy counterfactual retained.
    seed(db, { isDefaultBranch: true, status: "scanned", commitSha: "sha-now", policyStatus: "excluded-by-deny", policyMatchedPattern: "b", scannedCommitDate: "2025-07-07T00:00:00Z" });
    expect(rowOf(db)).toMatchObject({ status: "scanned", d: 1, ps: "excluded-by-deny", pat: "b", sha: "sha-now" });
    db.close();
  });

  test("same-status re-upserts refresh the date/pattern (cutoff→cutoff, excluded→excluded)", () => {
    const db = fresh();
    seed(db, { branch: "c", isDefaultBranch: false, status: "skipped-cutoff", commitSha: "", scannedCommitDate: "2020-01-01T00:00:00Z" });
    seed(db, { branch: "c", isDefaultBranch: false, status: "skipped-cutoff", commitSha: "", scannedCommitDate: "2020-02-02T00:00:00Z" });
    expect(rowOf(db, "c").scd).toBe("2020-02-02T00:00:00Z");
    seed(db, { branch: "e", isDefaultBranch: false, status: "policy-excluded", commitSha: "", policyStatus: "excluded-by-deny", policyMatchedPattern: "e*" });
    seed(db, { branch: "e", isDefaultBranch: false, status: "policy-excluded", commitSha: "", policyStatus: "excluded-by-deny", policyMatchedPattern: "e" });
    expect(rowOf(db, "e").pat).toBe("e");
    db.close();
  });

  test("a migration-like row with null policy/date columns is fully populated by a subsequent upsert", () => {
    const db = fresh();
    // Pre-v4 migrated rows are written DIRECTLY by the migration SQL (never through the non-null
    // upsert input), so simulate one with a raw insert carrying the backfilled NULLs. A later run's
    // upsert must then populate every column via excluded.* (never COALESCE onto the stale nulls).
    raw(db)
      .query(
        `INSERT INTO run_unit_head (run_id, organization, repository, branch, commit_sha, status,
           is_default_branch, policy_status, policy_matched_pattern, scanned_commit_date)
         VALUES ('r1','o','r','b','s0','scanned',NULL,NULL,NULL,NULL)`,
      )
      .run();
    seed(db, { isDefaultBranch: true, status: "scanned", commitSha: "s1", policyStatus: "excluded-by-deny", policyMatchedPattern: "b", scannedCommitDate: "2025-09-09T00:00:00Z" });
    expect(rowOf(db)).toMatchObject({ d: 1, sha: "s1", ps: "excluded-by-deny", pat: "b", scd: "2025-09-09T00:00:00Z" });
    db.close();
  });

  test("is_default_branch non-null → null is cleared on re-upsert (completes the excluded.* null-clearing proof for every mutable column)", () => {
    // A write-path overwrite (unreachable in a real run, where discovery always yields a definite
    // boolean) — but it proves the sixth mutable column also uses excluded.*, not COALESCE. The 9×9
    // matrix cannot cover this direction: a null-default row is invalid under G4/G8 in most cells.
    const db = fresh();
    seed(db, { commitSha: "s", isDefaultBranch: false });
    expect(rowOf(db).d).toBe(0);
    seed(db, { commitSha: "s", isDefaultBranch: null });
    expect(rowOf(db).d).toBeNull(); // a COALESCE on is_default_branch would keep the stale 0 and fail here
    db.close();
  });

  // Exhaustive proof of the §6 always-overwrite contract: from EVERY valid §3 state, re-upserting
  // any other valid §3 state makes the persisted row EXACTLY equal the new state — so no mutable
  // column can be COALESCE'd (a COALESCE would retain the old value whenever the new one is null:
  // policy_status, policy_matched_pattern, scanned_commit_date). This is a WRITE-PATH superset of
  // the reachable same-run transitions (a real run's config+name fix a branch's policy, but the
  // write path must clear stale values in every direction regardless).
  test("write-path overwrite matrix: any valid §3 state → any valid §3 state overwrites every mutable column (all 8×8 directions)", () => {
    const db = fresh();
    type State = Omit<RunUnitHeadInput, "runId" | "organization" | "repository" | "branch">;
    const states: ReadonlyArray<readonly [string, State]> = [
      ["scan-plain",    { status: "scanned",        commitSha: "sha-A", isDefaultBranch: false, policyStatus: null,                policyMatchedPattern: null, scannedCommitDate: "2025-01-01T00:00:00Z" }],
      ["scan-default",  { status: "scanned",        commitSha: "sha-B", isDefaultBranch: true,  policyStatus: null,                policyMatchedPattern: null, scannedCommitDate: "2025-02-02T00:00:00Z" }],
      ["scan-deny",     { status: "scanned",        commitSha: "sha-C", isDefaultBranch: true,  policyStatus: "excluded-by-deny",  policyMatchedPattern: "?*", scannedCommitDate: "2025-03-03T00:00:00Z" }],
      ["scan-allow",    { status: "scanned",        commitSha: "sha-D", isDefaultBranch: true,  policyStatus: "excluded-by-allow", policyMatchedPattern: null, scannedCommitDate: "2025-04-04T00:00:00Z" }],
      ["cutoff",        { status: "skipped-cutoff", commitSha: "",      isDefaultBranch: false, policyStatus: null,                policyMatchedPattern: null, scannedCommitDate: "2019-01-01T00:00:00Z" }],
      ["past-cap",      { status: "past-cap",       commitSha: "",      isDefaultBranch: false, policyStatus: null,                policyMatchedPattern: null, scannedCommitDate: "2018-01-01T00:00:00Z" }],
      ["excl-deny",     { status: "policy-excluded", commitSha: "",      isDefaultBranch: false, policyStatus: "excluded-by-deny",  policyMatchedPattern: "*", scannedCommitDate: "2017-01-01T00:00:00Z" }],
      ["excl-allow",    { status: "policy-excluded", commitSha: "",      isDefaultBranch: false, policyStatus: "excluded-by-allow", policyMatchedPattern: null, scannedCommitDate: "2016-01-01T00:00:00Z" }],
    ];
    const proj = (s: State) => ({
      status: s.status,
      d: s.isDefaultBranch === null ? null : s.isDefaultBranch ? 1 : 0,
      ps: s.policyStatus,
      pat: s.policyMatchedPattern,
      sha: s.commitSha,
      scd: s.scannedCommitDate,
    });
    for (let i = 0; i < states.length; i++) {
      for (let j = 0; j < states.length; j++) {
        const branch = `m_${i}_${j}`;
        seed(db, { branch, ...states[i]![1] });
        seed(db, { branch, ...states[j]![1] });
        expect(rowOf(db, branch)).toEqual(proj(states[j]![1]));
      }
    }
    db.close();
  });

  // ---- scanned_commit_date is the GitHub commit-date family, stored RAW ----
  test("scanned_commit_date is stored RAW — second-precision and offset-bearing commit forms round-trip verbatim", () => {
    const db = fresh();
    const zForm = "2025-06-01T12:34:56Z"; // GitHub committedDate form — NOT the nowIso millisecond form
    seed(db, { branch: "z", commitSha: "s", scannedCommitDate: zForm });
    expect(rowOf(db, "z").scd).toBe(zForm);
    const offsetForm = "2025-06-01T05:34:56-07:00"; // Git %cI form
    seed(db, { branch: "o", commitSha: "s", scannedCommitDate: offsetForm });
    expect(rowOf(db, "o").scd).toBe(offsetForm);
    db.close();
  });
});

describe("openReadOnly (read seam)", () => {
  // A cleanly-written CURRENT-version (v4) database with one completed run, for the happy paths
  // (AuditDb.open fresh-creates at SCHEMA_VERSION, so this tracks the current schema, not v3).
  function buildCurrentV4Db(path: string): string {
    const db = AuditDb.open({ sqlitePath: path });
    const { runId } = db.startRun(runInput());
    db.upsertRunUnitHead({ runId, organization: "o", repository: "r", branch: "main", commitSha: "s", status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    db.completeRun(runId);
    db.close();
    return runId;
  }

  test("reads a current (v4) database: getRun/read/readTransaction/hasCompletionMarker work", () => {
    const path = nextFile();
    const runId = buildCurrentV4Db(path);
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
    const runId = buildCurrentV4Db(path);
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
    buildCurrentV4Db(path);
    const bump = new Database(path, { strict: true });
    bump.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    bump.close();
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/upgrade the tool/);
  });

  test("a current-stamped file missing audit tables is refused up front, not mid-query", () => {
    // Stamped SCHEMA_VERSION deliberately (this is the CURRENT-stamp case; a genuinely
    // OLDER-stamped empty shell keeps the migrate-first message and has its own test) — the old
    // title said "v3-stamped", accurate only before the v4 bump.
    const path = nextFile();
    const forged = new Database(path, { create: true, strict: true });
    forged.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    forged.close();
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/missing the runs table/);
  });

  test("an object-free v2-stamped file keeps the migrate-first message (ownership's empty arm admits it)", () => {
    // A v2-era --fresh --purge-cache crash shell: zero objects, still stamped 2. Ownership
    // (which precedes the older-version gate) must not misread it as foreign — the migrate
    // advice is truthful here, because the writable open adopts and rebuilds an empty file.
    const path = nextFile();
    const shell = new Database(path, { create: true, strict: true });
    shell.exec("PRAGMA user_version = 2");
    shell.close();
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/once to migrate/);
  });

  test("a foreign file wearing audit table names over foreign shapes is refused as NOT OURS — never advised to run audit", () => {
    // Read-path parity with the ownership preflight. Pre-fix the caches-only clone got
    // "missing the runs table — run `bun run audit` once to repair it": dead-end advice, since
    // the audit's own preflight refuses the file. The full clone was worse — it passed every
    // up-front check and would only fail raw (or render garbage) mid-report.
    const cachesOnly = nextFile();
    let d = new Database(cachesOnly, { create: true, strict: true });
    d.exec("CREATE TABLE api_cache (cache_key TEXT PRIMARY KEY, payload BLOB)");
    d.exec("CREATE TABLE package_api_surface (pkg TEXT NOT NULL, region TEXT)");
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    expect(() => AuditDb.openReadOnly({ sqlitePath: cachesOnly })).toThrow(/did not create/);

    const fullClone = nextFile();
    d = new Database(fullClone, { create: true, strict: true });
    for (const t of AUDIT_TABLE_NAMES) d.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, note TEXT NOT NULL)`);
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    d.close();
    expect(() => AuditDb.openReadOnly({ sqlitePath: fullClone })).toThrow(/did not create/);

    // An OLDER-stamped foreign file must get the same ownership refusal, NOT the migrate-first
    // advice — "run `bun run audit` once to migrate it" is a dead end when the audit's own
    // preflight refuses the file. (Ownership therefore precedes the older-version gate; the
    // NEWER gate stays first — a future database is "upgrade the tool", never "not ours".)
    const v2Clone = nextFile();
    d = new Database(v2Clone, { create: true, strict: true });
    d.exec("CREATE TABLE api_cache (cache_key TEXT PRIMARY KEY, payload BLOB)");
    d.exec("PRAGMA user_version = 2");
    d.close();
    expect(() => AuditDb.openReadOnly({ sqlitePath: v2Clone })).toThrow(/did not create/);
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
    // The whole corrupt family plus NOTADB (SQLite's "file is encrypted or is not a database"):
    // damage met mid-probe must surface as OUR refusal with context — report/export callers were
    // getting a raw "database disk image is malformed" SQLiteError before this classification.
    for (const damaged of ["SQLITE_CORRUPT", "SQLITE_CORRUPT_INDEX", "SQLITE_CORRUPT_SEQUENCE", "SQLITE_CORRUPT_VTAB", "SQLITE_NOTADB"]) {
      const mapped = mapReadOnlyOpenError(err(damaged), "p");
      expect(mapped).toBeInstanceOf(DbError);
      expect(msg(mapped)).toContain("corrupted or not a SQLite database");
    }
    // unknown codes and non-Error shapes pass through VERBATIM (never swallowed)
    const raw = err("SQLITE_PERM");
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

describe("open — a corrupt v4 run_unit_head (missing a column) is REJECTED, never silently adopted", () => {
  test("a v4-stamped db lacking a run_unit_head column is rejected by both opens, and --fresh does NOT destroy it", () => {
    const path = nextFile();
    const db1 = AuditDb.open({ sqlitePath: path });
    const { runId } = db1.startRun(runInput());
    db1.upsertRunUnitHead({ runId, organization: "o", repository: "r", branch: "main", commitSha: "s", status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    db1.completeRun(runId);
    db1.close();
    // Forge a corrupt shape: current stamp, run_unit_head missing a column. An atomic migration can
    // never produce this, so the tool refuses it rather than guessing — the policy columns carry
    // CHECKs and cannot be addColumn-repaired, so partial-v4 repair is deliberately unsupported
    // (favouring the collision defence: anything not exactly ours-v4 is incompatible).
    const forge = new Database(path, { strict: true });
    forge.exec("ALTER TABLE run_unit_head DROP COLUMN is_default_branch");
    forge.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    forge.close();
    // Read-only, writer, AND --fresh all reject it. Critically, --fresh rejects BEFORE dropping
    // anything (shape-level ownership refuses on the READ-ONLY preflight, before the destructive
    // path), so the data survives. "v4 minus a column" matches NO stamped era — unlike a genuine
    // predecessor-era shape it is not healable, so refusal (not repair) is correct.
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/did not create|incompatible|not the expected v4 shape/);
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible/);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true, purgeCache: true })).toThrow(/did not create|incompatible/);
    const check = new Database(path, { readonly: true });
    expect((check.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(1); // untouched
    check.close();
    expect(runId.length).toBeGreaterThan(0);
  });
});

describe("migration — v3→v4 rebuild + v4 collision defense (CRITICAL data safety)", () => {
  const RUH_V4_COLS = ["run_id","organization","repository","branch","commit_sha","status","is_default_branch","policy_status","policy_matched_pattern","scanned_commit_date"];
  // Native v4 database (fresh-created at v4 by AuditDb.open) with one completed run + two heads.
  function buildNativeV4(path: string): string {
    const db = AuditDb.open({ sqlitePath: path });
    const { runId } = db.startRun(runInput());
    db.upsertRunUnitHead({ runId, organization: "o", repository: "r", branch: "main", commitSha: "s", status: "scanned", isDefaultBranch: true, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    db.upsertRunUnitHead({ runId, organization: "o", repository: "r", branch: "old", commitSha: "", status: "skipped-cutoff", isDefaultBranch: false, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: "2025-06-01T12:00:00Z" });
    db.completeRun(runId);
    db.close();
    return runId;
  }
  const cols = (db: Database, t: string): string[] =>
    (db.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  const uv = (db: Database): number => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

  test("fresh-create is exactly ours-v4: 10 cols, status admits {scanned,skipped-cutoff,policy-excluded,past-cap}, policy CHECKs enforced", () => {
    const path = nextFile();
    const db = AuditDb.open({ sqlitePath: path });
    const r = raw(db);
    expect(cols(r, "run_unit_head")).toEqual(RUH_V4_COLS);
    expect(uv(r)).toBe(SCHEMA_VERSION);
    const { runId } = db.startRun(runInput());
    // past-cap accepted; a foreign status ('reused', a sibling value) rejected.
    expect(() => r.exec(`INSERT INTO run_unit_head (run_id,organization,repository,branch,status) VALUES ('${runId}','o','r','b1','past-cap')`)).not.toThrow();
    expect(() => r.exec(`INSERT INTO run_unit_head (run_id,organization,repository,branch,status) VALUES ('${runId}','o','r','b2','reused')`)).toThrow();
    // deny requires a matched pattern; a foreign policy_status rejected; a valid deny+pattern OK.
    expect(() => r.exec(`INSERT INTO run_unit_head (run_id,organization,repository,branch,status,policy_status) VALUES ('${runId}','o','r','b3','policy-excluded','excluded-by-deny')`)).toThrow();
    expect(() => r.exec(`INSERT INTO run_unit_head (run_id,organization,repository,branch,status,policy_status,policy_matched_pattern) VALUES ('${runId}','o','r','b4','policy-excluded','excluded-by-deny','dep*')`)).not.toThrow();
    expect(() => r.exec(`INSERT INTO run_unit_head (run_id,organization,repository,branch,status,policy_status) VALUES ('${runId}','o','r','b5','policy-excluded','bogus')`)).toThrow();
    // status ↔ policy_status agreement, enforced IN SQL and not only at the write chokepoint: a
    // policy-excluded row must name the rule that dropped it, and a cutoff/cap row carries no verdict
    // at all (policy runs BEFORE cutoff/cap). These are the CHECKs that make "which rows are genuine
    // cutoff skips?" answerable by `status` alone — the point of giving the disposition its own token.
    expect(() => r.exec(`INSERT INTO run_unit_head (run_id,organization,repository,branch,status) VALUES ('${runId}','o','r','b6','policy-excluded')`)).toThrow();
    expect(() => r.exec(`INSERT INTO run_unit_head (run_id,organization,repository,branch,status,policy_status) VALUES ('${runId}','o','r','b7','skipped-cutoff','excluded-by-allow')`)).toThrow();
    expect(() => r.exec(`INSERT INTO run_unit_head (run_id,organization,repository,branch,status,policy_status) VALUES ('${runId}','o','r','b8','past-cap','excluded-by-allow')`)).toThrow();
    // ...but a SCANNED row still may: the default-branch override's counterfactual verdict (§3), which
    // is exactly why policy_status survives as its own column rather than collapsing into status.
    expect(() => r.exec(`INSERT INTO run_unit_head (run_id,organization,repository,branch,status,policy_status,policy_matched_pattern) VALUES ('${runId}','o','r','b9','scanned','excluded-by-deny','rel*')`)).not.toThrow();
    db.close();
  });

  test("v3→v4 migration preserves rows + is_default_branch backfill, sets new columns NULL, survives reopen", () => {
    const path = nextFile();
    buildV3TwinDb(path); // native v3 (literal stamp 3)
    const before = new Database(path, { readonly: true });
    const beforeCount = (before.query("SELECT COUNT(*) AS n FROM run_unit_head").get() as { n: number }).n;
    before.close();
    const db = AuditDb.open({ sqlitePath: path }); // drives v3→v4
    const r = raw(db);
    expect(uv(r)).toBe(SCHEMA_VERSION);
    expect(cols(r, "run_unit_head")).toEqual(RUH_V4_COLS);
    const rows = r.query("SELECT is_default_branch, policy_status, policy_matched_pattern, scanned_commit_date FROM run_unit_head").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(beforeCount); // every row preserved
    for (const row of rows) {
      expect(row.is_default_branch).toBeNull(); // v2/v3 backfill
      expect(row.policy_status).toBeNull();
      expect(row.policy_matched_pattern).toBeNull();
      expect(row.scanned_commit_date).toBeNull();
    }
    db.close();
    const reader = AuditDb.openReadOnly({ sqlitePath: path }); // still a valid v4
    expect(reader.read("SELECT COUNT(*) AS n FROM run_unit_head").get()).toBeDefined();
    reader.close();
  });

  test("an incompatible sibling v4 (runs.outcome) is rejected by open / --fresh / --fresh+purge / read-only — data preserved", () => {
    const path = nextFile();
    buildNativeV4(path);
    const forge = new Database(path, { strict: true });
    forge.exec("ALTER TABLE runs ADD COLUMN outcome TEXT"); // a DIFFERENT v4 (sibling branch), still stamped 4
    forge.close();
    // The extra runs column fails shape-level ownership on the READ-ONLY preflight ("did not
    // create", nothing mutated) — the classifier's runs.outcome discriminator remains the layered
    // in-gate + in-migration backstop for the same marker (pinned direct-drive elsewhere).
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible/);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true })).toThrow(/did not create|incompatible/);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true, purgeCache: true })).toThrow(/did not create|incompatible/);
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/did not create|incompatible with this tool build/);
    // NOTHING destroyed — the --fresh drops never ran (the gate rejects first).
    const check = new Database(path, { readonly: true });
    expect((check.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(1);
    expect(cols(check, "runs")).toContain("outcome");
    check.close();
  });

  test("a v4 stamp on a v3-shaped run_unit_head is HEALED by the writer open — rows ride through; the read path advises the repair", () => {
    // The chain itself cannot produce this state (each step stamps atomically with its reshape),
    // so it is EXTERNAL damage — and a recognized predecessor era under the current stamp is the
    // healable class the ownership span deliberately admits (the same arbitration that keeps the
    // pinned v2-era heals working). Rejecting it while openReadOnly said "run `bun run audit`"
    // would be a dead end.
    const path = nextFile();
    buildV3TwinDb(path); // v3 shape, stamp 3
    const forge = new Database(path, { strict: true });
    forge.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`); // lie: stamp v4 on a v3 shape
    forge.close();
    // openReadOnly cannot heal — it names the damage and the remediation…
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/run `bun run audit` once to repair/);
    // …and the writer open performs it: the same rebuild the real v3→v4 migration uses.
    const db = AuditDb.open({ sqlitePath: path });
    const r = raw(db);
    expect(uv(r)).toBe(SCHEMA_VERSION);
    expect(r.query("SELECT branch, commit_sha, status, is_default_branch, scanned_commit_date FROM run_unit_head ORDER BY branch").all())
      .toEqual([
        { branch: "main", commit_sha: "sha1", status: "scanned", is_default_branch: null, scanned_commit_date: null },
        { branch: "stale", commit_sha: "", status: "skipped-cutoff", is_default_branch: null, scanned_commit_date: null },
      ]);
    db.close();
    AuditDb.openReadOnly({ sqlitePath: path }).close(); // and reads work again
  });

  test("a physically-v4 database stamped v3 is stamped to v4 WITHOUT a rebuild — new-column values preserved", () => {
    const path = nextFile();
    buildNativeV4(path);
    const forge = new Database(path, { strict: true });
    forge.exec("UPDATE run_unit_head SET scanned_commit_date = '2024-05-05' WHERE branch='main'");
    forge.exec("PRAGMA user_version = 3"); // lie the stamp back below v4
    forge.close();
    const db = AuditDb.open({ sqlitePath: path }); // migrateV3toV4 sees ours-v4 -> preserve, stamp 4
    const r = raw(db);
    expect(uv(r)).toBe(SCHEMA_VERSION);
    expect((r.query("SELECT scanned_commit_date AS d FROM run_unit_head WHERE branch='main'").get() as { d: string }).d).toBe("2024-05-05");
    db.close();
  });

  test("a physically-v4 database stamped v2 fast-forwards through BOTH steps WITHOUT a rebuild — new-column values preserved", () => {
    // The stamp-2 half of the above-stamp acceptance (the ownership span's [2..SCHEMA_VERSION]
    // upper bound): the ownership preflight must admit v4 shapes under stamp 2, migrateV2toV3's
    // ALTER must be an addColumnIfMissing no-op, and migrateV3toV4 must classify ours-v4 →
    // preserve. Narrowing the span back toward the stamp would falsely refuse this file.
    const path = nextFile();
    buildNativeV4(path);
    const forge = new Database(path, { strict: true });
    forge.exec("UPDATE run_unit_head SET scanned_commit_date = '2024-05-05' WHERE branch='main'");
    forge.exec("PRAGMA user_version = 2"); // the earlier-build / crash-remnant stamp
    forge.close();
    const db = AuditDb.open({ sqlitePath: path });
    const r = raw(db);
    expect(uv(r)).toBe(SCHEMA_VERSION);
    expect((r.query("SELECT scanned_commit_date AS d FROM run_unit_head WHERE branch='main'").get() as { d: string }).d).toBe("2024-05-05");
    db.close();
  });

  test("gate order pin: a live rejection leaves a rollback-journal database UNFLIPPED (the WAL pragma runs after the gates)", () => {
    // Direct-drive pin for initWritableConnection's ordering (version ceiling → isOwnedOrEmpty →
    // assertOpenCompatible → journal_mode=WAL): through AuditDb.open, any file the live gates
    // would reject is caught by the read-only preflight first (same bytes), and the WAL-resident
    // sibling fixture is ALREADY in WAL mode by construction — so neither can detect the WAL
    // pragma migrating above the gates. Here the gates meet delete-mode files directly: if the
    // pragma ran first, each rejection would leave journal_mode=wal (and sidecars) behind.
    const journalMode = (p: string): string => {
      const c = new Database(p, { readonly: true, strict: true });
      const m = (c.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
      c.close();
      return m;
    };
    // (a) ownership rejector: a foreign delete-mode file.
    const foreign = nextFile();
    const f = new Database(foreign, { create: true, strict: true });
    f.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)");
    f.exec("PRAGMA user_version = 2");
    f.close();
    const fh = new Database(foreign, { strict: true });
    expect(() => initWritableConnection(fh, foreign)).toThrow(/did not create/);
    expect(journalMode(foreign)).not.toBe("wal");
    expect(existsSync(`${foreign}-wal`)).toBe(false);
    // (b) compatibility rejector: OWNED shapes, but a CHECK-set variant only the classifier can
    //     see through pragmas — since the whole-DB identity work, ownership's fingerprint reads
    //     the CHECK multiset too, so either layer may reject; the pinned PROPERTY (no WAL flip)
    //     is what matters — converted to a rollback journal first.
    const sib = nextFile();
    buildNativeV4(sib);
    const conv = new Database(sib, { strict: true });
    conv.exec("PRAGMA journal_mode = delete;");
    conv.exec("PRAGMA foreign_keys = OFF;");
    conv.exec("DROP TABLE run_unit_head");
    conv.exec(`CREATE TABLE run_unit_head (
      run_id TEXT NOT NULL REFERENCES runs(run_id), organization TEXT NOT NULL, repository TEXT NOT NULL,
      branch TEXT NOT NULL, commit_sha TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'scanned' CHECK (status IN ('scanned','skipped-cutoff','past-cap') OR status IN ('reused')),
      is_default_branch INTEGER,
      policy_status TEXT CHECK (policy_status IS NULL OR policy_status IN ('excluded-by-deny','excluded-by-allow')),
      policy_matched_pattern TEXT, scanned_commit_date TEXT,
      CHECK (policy_status <> 'excluded-by-deny' OR policy_matched_pattern IS NOT NULL),
      PRIMARY KEY (run_id, organization, repository, branch))`);
    conv.close();
    rmSync(`${sib}-wal`, { force: true });
    rmSync(`${sib}-shm`, { force: true });
    expect(journalMode(sib)).not.toBe("wal"); // fixture sanity: the conversion took
    const sh = new Database(sib, { strict: true });
    expect(() => initWritableConnection(sh, sib)).toThrow(/did not create|incompatible/);
    expect(journalMode(sib)).not.toBe("wal"); // the rejection did not flip it
    expect(existsSync(`${sib}-wal`)).toBe(false);
  });

  test("current-stamp self-heal: an orphaned run_unit_head row (FK violation committed out-of-band) fails the open loudly, rolled back", () => {
    // Reaches the self-heal arm's foreign_key_check teeth through the public API: shapes are
    // pristine ours-v4 (every gate passes), only the DATA violates the run_id→runs FK. The open
    // must fail rather than proceed on referentially-broken provenance — mirroring the v3→v4
    // migration's own orphan check — and the transaction must roll back, leaving the orphan in
    // place for the operator to inspect. (The shape half of the same teeth is a documented
    // structurally-unreachable backstop: the gates reject every non-ours-v4 shape first.)
    const path = nextFile();
    buildNativeV4(path);
    const f = new Database(path, { strict: true });
    f.exec("PRAGMA foreign_keys = OFF;");
    f.exec(`INSERT INTO run_unit_head (run_id, organization, repository, branch, commit_sha, status)
            VALUES ('ghost', 'o', 'r', 'b', '', 'skipped-cutoff')`);
    f.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/self-heal left 1 orphaned/);
    const check = new Database(path, { readonly: true });
    expect((check.query("SELECT COUNT(*) AS n FROM run_unit_head WHERE run_id='ghost'").get() as { n: number }).n).toBe(1);
    check.close();
  });

  test("--fresh on a native v3 db: run data dropped, result is a clean writable v4", () => {
    const path = nextFile();
    buildV3TwinDb(path); // v3, stamp 3, with run_unit_head rows
    const db = AuditDb.open({ sqlitePath: path, fresh: true });
    const r = raw(db);
    expect(uv(r)).toBe(SCHEMA_VERSION);
    expect(cols(r, "run_unit_head")).toEqual(RUH_V4_COLS);
    expect((r.query("SELECT COUNT(*) AS n FROM run_unit_head").get() as { n: number }).n).toBe(0); // run data gone
    db.close();
  });

  test("migration-boundary rule: a pre-v4 RUNNING run is FAILED by the v3→v4 step, never resumed under v4 semantics", () => {
    // Reviewer-C counterexample (verified by probe): a v3 repo whose scans all errored left ZERO
    // run_unit_head rows — nothing carries the NULL provenance sentinel — and a repo can drop from
    // the kept estate before any resume revisits it. A pre-v4 running run resumed under v4 could
    // then report scanScope.provenance='complete' (and compare policyChurn available) while its
    // pre-v4 scope is unknowable. So migrateV3toV4 enforces a migration-boundary rule: fail it;
    // the next invocation starts a NEW all-v4 run whose provenance is genuinely authoritative
    // (work_queue skip-as-current keeps that cheap — the config_hash is unchanged by design).
    const path = nextFile();
    buildV3TwinDb(path); // carries 'v2-running' (status running, config_hash h-v2) at stamp 3
    const db = AuditDb.open({ sqlitePath: path });
    expect(db.getRun("v2-running")?.status).toBe("failed"); // the boundary rule
    const res = db.startRun(runInput({ configHash: "h-v2" }));
    expect(res.resumed).toBe(false); // a NEW v4 run — the pre-v4 run is quarantined, not resumed
    expect(res.runId).not.toBe("v2-running");
    db.close();
  });

  test("a pre-existing migration scratch table aborts the open, leaving the v3 table + stamp untouched", () => {
    const path = nextFile();
    buildV3TwinDb(path); // v3, stamp 3
    const forge = new Database(path, { strict: true });
    forge.exec("CREATE TABLE run_unit_head__v4_new (x INTEGER)"); // not chain-producible (the migration is one transaction)
    forge.close();
    // The scratch name is not an audit table, so the ownership preflight refuses the file outright;
    // migrateV3toV4's own scratch-collision guard remains as the in-transaction backstop for a
    // scratch appearing after the preflight.
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/this tool did not create/);
    const check = new Database(path, { readonly: true });
    expect(uv(check)).toBe(3);
    expect(cols(check, "run_unit_head")).not.toContain("policy_status");
    check.close();
  });

  test("rollback AFTER the destructive swap: a post-rename failure restores the v3 rows, shape, and stamp", () => {
    // Drop the real ix_ruh_loc index and squat its name with a TABLE, so SCHEMA_SQL's
    // `CREATE INDEX ... ix_ruh_loc` fails AFTER the rebuild's DROP+RENAME already ran — proving the
    // destructive swap (and the boundary rule's running→failed flip, which precedes SCHEMA_SQL) is
    // inside the rolled-back transaction.
    //
    // Driven through migrateV3toV4 DIRECTLY (exported for tests — the isOwnedOrEmpty /
    // mapReadOnlyOpenError precedent): through AuditDb.open, every state that could make SCHEMA_SQL
    // fail post-swap is now intercepted before the migration runs (the ownership preflight refuses
    // committed non-audit tables/views/triggers, the writable backstop re-checks through any
    // recovered WAL, and classify-first rejects a wrong ix_ruh_loc index) — the interception is the
    // desired hardening, but it makes this rollback property unreachable from the public seam.
    const path = nextFile();
    buildV3TwinDb(path); // v3, stamp 3
    const dbx = new Database(path, { strict: true });
    dbx.exec("PRAGMA foreign_keys = ON;");
    const beforeRows = (dbx.query("SELECT COUNT(*) AS n FROM run_unit_head").get() as { n: number }).n;
    dbx.exec("DROP INDEX IF EXISTS ix_ruh_loc"); // classify-first reads this as 'absent' (repairable) — the rebuild proceeds
    dbx.exec("CREATE TABLE ix_ruh_loc (x INTEGER)"); // …until SCHEMA_SQL's CREATE INDEX collides post-RENAME
    expect(() => migrateV3toV4(dbx)).toThrow();
    dbx.close();
    const check = new Database(path, { readonly: true });
    expect(uv(check)).toBe(3); // stamp rolled back
    expect(cols(check, "run_unit_head")).not.toContain("policy_status"); // rename rolled back -> still v3
    expect((check.query("SELECT COUNT(*) AS n FROM run_unit_head").get() as { n: number }).n).toBe(beforeRows); // rows intact
    // The boundary rule's running→failed flip runs BEFORE SCHEMA_SQL in the same transaction, so
    // this induced post-swap failure proves it rolls back with the schema — no failed-run
    // quarantine ever escapes an aborted migration.
    expect((check.query("SELECT status FROM runs WHERE run_id='v2-running'").get() as { status: string }).status).toBe("running");
    check.close();
  });

  test("scratch-collision guard: a pre-existing run_unit_head__v4_new aborts migrateV3toV4 before any mutation", () => {
    // Direct-drive coverage for the in-transaction guard: through AuditDb.open the ownership
    // preflight refuses the non-audit scratch table first (pinned separately), so this guard is
    // reachable only for a scratch appearing AFTER the preflight — forge that by driving the
    // exported migrateV3toV4 on a raw connection. The message pattern discriminates the guard from
    // the bare CREATE TABLE collision that would fire without it.
    const path = nextFile();
    buildV3TwinDb(path); // v3, stamp 3
    const dbx = new Database(path, { strict: true });
    dbx.exec("PRAGMA foreign_keys = ON;");
    dbx.exec("CREATE TABLE run_unit_head__v4_new (x INTEGER)");
    expect(() => migrateV3toV4(dbx)).toThrow(/scratch table/);
    expect(uv(dbx)).toBe(3); // unstamped
    expect(cols(dbx, "run_unit_head")).not.toContain("policy_status"); // still v3 — nothing rebuilt
    expect((dbx.query("SELECT status FROM runs WHERE run_id='v2-running'").get() as { status: string }).status).toBe("running"); // boundary flip rolled back with the abort
    dbx.close();
  });

  test("unexpected-dependents guard: a trigger on run_unit_head makes migrateV3toV4 classify-and-refuse", () => {
    // Same layering as above: ownership refuses a committed trigger first (triggers are
    // always-foreign objects), so the classifier's dependents check is driven directly.
    const path = nextFile();
    buildV3TwinDb(path); // v3, stamp 3
    const dbx = new Database(path, { strict: true });
    dbx.exec("PRAGMA foreign_keys = ON;");
    dbx.exec("CREATE TRIGGER trg AFTER INSERT ON run_unit_head BEGIN SELECT 1; END");
    expect(() => migrateV3toV4(dbx)).toThrow(/unexpected trigger/);
    expect(uv(dbx)).toBe(3);
    expect(cols(dbx, "run_unit_head")).not.toContain("policy_status");
    dbx.close();
  });

  // ── Independent classifier coverage (PR #17 follow-up) ──────────────────────────────────────────
  // Since the whole-DB fingerprint work, isOwnedOrEmpty/tableShape refuse a COLLATE / ON CONFLICT /
  // DEFERRABLE / MATCH / duplicate-CHECK deviation as "did not create" BEFORE classifyRunUnitHead runs,
  // so the AuditDb.open pins for those reasons now accept EITHER layer's message (the widened
  // /did not create|…/ alternations further down). These tests keep classifyRunUnitHead's OWN per-reason
  // detection independently pinned by driving the exported migrateV3toV4 seam directly on a stamp-3
  // connection — the migration classifies the on-disk shape with no ownership preflight ahead of it — so
  // a regression in the classifier alone (ownership still correct) can no longer pass unnoticed. Mirrors
  // the "unexpected-dependents guard" test above. STRICT is deliberately absent: tableShape already
  // fingerprinted pragma_table_list.strict, so this PR did not newly shadow it (the classifier's STRICT
  // branch was never solely responsible for the AuditDb.open pin).
  //
  // Rebuild run_unit_head in-place from a mutated CREATE (rows copied, FK off), recreating the exact
  // ix_ruh_loc if the base had one, then re-stamp — so the ONLY difference from ours is `mutate`.
  function forgeRuhInPlace(path: string, mutate: (sql: string) => string, stamp: number): void {
    const f = new Database(path, { strict: true });
    const sql = (f.query("SELECT sql FROM sqlite_schema WHERE type='table' AND name='run_unit_head'").get() as { sql: string }).sql;
    const mutated = mutate(sql);
    if (mutated === sql) throw new Error("forgeRuhInPlace: mutation was a no-op");
    const idxSql = (f.query("SELECT sql FROM sqlite_schema WHERE type='index' AND name='ix_ruh_loc'").get() as { sql: string } | null)?.sql ?? null;
    f.exec("PRAGMA foreign_keys=OFF");
    f.exec(mutated.replace("CREATE TABLE run_unit_head", "CREATE TABLE run_unit_head__forge"));
    const cs = (f.query("SELECT name FROM pragma_table_info('run_unit_head')").all() as Array<{ name: string }>).map((c) => c.name).join(",");
    f.exec(`INSERT INTO run_unit_head__forge (${cs}) SELECT ${cs} FROM run_unit_head`);
    f.exec("DROP TABLE run_unit_head");
    f.exec("ALTER TABLE run_unit_head__forge RENAME TO run_unit_head");
    if (idxSql !== null) f.exec(idxSql);
    f.exec(`PRAGMA user_version = ${stamp}`);
    f.close();
  }

  // Each case: a single-token/CHECK deviation the ownership preflight now shadows, the SPECIFIC reason
  // classifyRunUnitHead must still name through migrateV3toV4, and the base builder — a v3 twin for the
  // token / v3-CHECK arms; a physically-v4 table left at stamp 3 for the v4-CHECK arm (classifyRunUnitHead's
  // "not the exact v4 CHECK set" at the v4-columns branch, which the v3 duplicate cannot reach).
  const CLASSIFIER_SEAM_CASES: ReadonlyArray<{
    name: string; base: (p: string) => void; mutate: (sql: string) => string; reason: RegExp;
  }> = [
    { name: "COLLATE on a non-PK column", base: buildV3TwinDb,
      mutate: (s) => s.replace("status TEXT NOT NULL DEFAULT 'scanned'", "status TEXT COLLATE NOCASE NOT NULL DEFAULT 'scanned'"),
      reason: /declares a COLLATE clause/ },
    { name: "ON CONFLICT on the primary key", base: buildV3TwinDb,
      mutate: (s) => s.replace("PRIMARY KEY (run_id, organization, repository, branch)", "PRIMARY KEY (run_id, organization, repository, branch) ON CONFLICT REPLACE"),
      reason: /declares an ON CONFLICT clause/ },
    { name: "DEFERRABLE foreign key", base: buildV3TwinDb,
      mutate: (s) => s.replace("REFERENCES runs(run_id)", "REFERENCES runs(run_id) DEFERRABLE INITIALLY DEFERRED"),
      reason: /declares a DEFERRABLE foreign key/ },
    { name: "MATCH foreign key", base: buildV3TwinDb,
      mutate: (s) => s.replace("REFERENCES runs(run_id)", "REFERENCES runs(run_id) MATCH FULL"),
      reason: /declares a MATCH clause/ },
    { name: "duplicated v3 CHECK (v3-columns arm)", base: buildV3TwinDb,
      mutate: (s) => s.replace("CHECK (status IN ('scanned','skipped-cutoff'))", "CHECK (status IN ('scanned','skipped-cutoff')) CHECK (status IN ('scanned','skipped-cutoff'))"),
      reason: /not the exact v3 CHECK set/ },
    { name: "duplicated v4 CHECK (v4-columns arm, physically-v4 under stamp 3)", base: (p) => buildNativeV4(p),
      mutate: (s) => s.replace(
        "CHECK (status IN ('scanned','skipped-cutoff','policy-excluded','past-cap'))",
        "CHECK (status IN ('scanned','skipped-cutoff','policy-excluded','past-cap')) CHECK (status IN ('scanned','skipped-cutoff','policy-excluded','past-cap'))"),
      reason: /not the exact v4 CHECK set/ },
  ];
  for (const c of CLASSIFIER_SEAM_CASES) {
    test(`classifier names its OWN reason via migrateV3toV4 (ownership preflight shadows it at AuditDb.open): ${c.name}`, () => {
      const path = nextFile();
      c.base(path);
      forgeRuhInPlace(path, c.mutate, 3); // leave it stamp-3 so migrateV3toV4 classifies (never a no-op rebuild)
      const dbx = new Database(path, { strict: true });
      dbx.exec("PRAGMA foreign_keys = ON;");
      const before = (dbx.query("SELECT COUNT(*) AS n FROM run_unit_head").get() as { n: number }).n;
      let msg = "";
      try {
        migrateV3toV4(dbx);
        throw new Error("unreachable: migrateV3toV4 accepted a shadowed deviation");
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(c.reason); // the classifier's OWN reason…
      expect(msg).not.toMatch(/did not create/); // …never delegated to the ownership layer's message
      expect(uv(dbx)).toBe(3); // classify-and-refuse: never stamped v4
      expect((dbx.query("SELECT COUNT(*) AS n FROM run_unit_head").get() as { n: number }).n).toBe(before); // rows intact
      dbx.close();
    });
  }

  // Replace run_unit_head with a FOREIGN shape at stamp 4 (same audit tables otherwise) to probe the
  // fingerprint's fail-closed properties.
  function forgeRuh(path: string, ruhCreate: string): void {
    buildNativeV4(path);
    const f = new Database(path, { strict: true });
    f.exec("PRAGMA foreign_keys = OFF;");
    f.exec("DROP TABLE run_unit_head");
    f.exec(ruhCreate);
    f.exec("PRAGMA user_version = 4");
    f.close();
  }

  // The CURRENT ours-v4 run_unit_head DDL, assembled from overridable parts. Every negative fixture
  // below builds from this and mutates EXACTLY the one property its test names, inheriting the rest.
  //
  // This helper exists because hand-copying the whole body per test silently rotted them: when the v4
  // CHECK set grew 'policy-excluded' plus the two status↔policy_status constraints, every hardcoded
  // copy became a CHECK mismatch — so each test still saw 'incompatible' and still passed, but for the
  // WRONG reason, and would have kept passing if the PK / column-type / GENERATED / UNIQUE / collation
  // guard it actually names had regressed. A shared source of truth makes that impossible: if the real
  // v4 shape changes again, these fixtures follow it and keep testing their own property.
  const V4_RUH_PARTS = {
    cols: `run_id TEXT NOT NULL REFERENCES runs(run_id), organization TEXT NOT NULL, repository TEXT NOT NULL,
      branch TEXT NOT NULL, commit_sha TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'scanned' CHECK (status IN ('scanned','skipped-cutoff','policy-excluded','past-cap')),
      is_default_branch INTEGER,
      policy_status TEXT CHECK (policy_status IS NULL OR policy_status IN ('excluded-by-deny','excluded-by-allow')),
      policy_matched_pattern TEXT, scanned_commit_date TEXT`,
    checks: `CHECK (policy_status <> 'excluded-by-deny' OR policy_matched_pattern IS NOT NULL),
      CHECK (status <> 'policy-excluded' OR policy_status IS NOT NULL),
      CHECK (status NOT IN ('skipped-cutoff','past-cap') OR policy_status IS NULL)`,
    pk: `PRIMARY KEY (run_id, organization, repository, branch)`,
  };
  const v4Ruh = (over: Partial<typeof V4_RUH_PARTS> = {}): string => {
    const p = { ...V4_RUH_PARTS, ...over };
    return `CREATE TABLE run_unit_head (\n      ${[p.cols, p.checks, p.pk].filter((x) => x !== "").join(",\n      ")})`;
  };

  // The CONTROL for every negative fixture below. If the helper's UNMUTATED output were not accepted as
  // ours-v4, each variant would be rejected by the helper's own drift rather than by the property its
  // test names, and the whole block would be vacuous — exactly what happened while the bodies were
  // hardcoded and the real v4 CHECK set moved out from under them. This test is what makes the
  // rejections below evidence rather than coincidence.
  test("control: the v4Ruh helper's UNMUTATED output IS ours-v4 (so each variant below is rejected only by its own mutation)", () => {
    const path = nextFile();
    forgeRuh(path, v4Ruh());
    const db = AuditDb.open({ sqlitePath: path }); // accepted: the shape equals SCHEMA_SQL's run_unit_head
    db.close();
  });

  test("CHECK tokenizer: a v4-shaped table whose status CHECK also admits 'reused' via an OR-clause is rejected", () => {
    const path = nextFile();
    // ONLY difference from ours-v4: the status CHECK is widened with an OR-clause admitting 'reused'.
    forgeRuh(path, v4Ruh({
      cols: V4_RUH_PARTS.cols.replace(
        "CHECK (status IN ('scanned','skipped-cutoff','policy-excluded','past-cap'))",
        "CHECK (status IN ('scanned','skipped-cutoff','policy-excluded','past-cap') OR status IN ('reused'))",
      ),
    }));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible/);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true })).toThrow(/did not create|incompatible/); // --fresh cannot destroy it
  });

  test("fingerprint: v4 columns + CHECKs but NO composite primary key is rejected (not silently adopted)", () => {
    const path = nextFile();
    forgeRuh(path, v4Ruh({ pk: "" })); // ONLY difference from ours-v4: no PRIMARY KEY
    // Shape-level ownership (colSig pk positions + the missing pk autoindex) refuses this on the
    // preflight as "did not create"; the classifier's PK checks remain the layered in-gate backstop.
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible/);
  });

  test("case-insensitive gate: a runs.OUTCOME (uppercase) sibling column is still detected and rejected", () => {
    const path = nextFile();
    buildNativeV4(path);
    const f = new Database(path, { strict: true });
    f.exec("ALTER TABLE runs ADD COLUMN OUTCOME TEXT"); // uppercase — SQLite resolves names case-insensitively
    f.close();
    // The extra runs column now also fails shape-level ownership on the preflight ("did not
    // create"); the classifier's case-insensitive outcome discriminator remains the layered
    // in-gate backstop for the same state (pinned direct-drive below).
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible/);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true })).toThrow(/did not create|incompatible/);
  });

  // Rebuild ONE audit table with a mutated CREATE (columns preserved, rows copied) inside an
  // otherwise-native file — the whole-DB sibling construction: identical to ours except where the
  // mutation says. FK enforcement off so the rebuild order never matters.
  function forgeAuditTable(path: string, table: string, mutate: (sql: string) => string): void {
    buildNativeV4(path);
    const f = new Database(path, { strict: true });
    const sql = (f.query("SELECT sql FROM sqlite_schema WHERE type='table' AND name = ?").get(table) as { sql: string }).sql;
    const mutated = mutate(sql);
    if (mutated === sql) throw new Error(`forgeAuditTable: mutation was a no-op for ${table}`);
    f.exec("PRAGMA foreign_keys=OFF");
    f.exec(mutated.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}__forge`));
    const cols = (f.query(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name).join(",");
    f.exec(`INSERT INTO ${table}__forge (${cols}) SELECT ${cols} FROM ${table}`);
    f.exec(`DROP TABLE ${table}`);
    f.exec(`ALTER TABLE ${table}__forge RENAME TO ${table}`);
    f.close();
  }

  test("whole-DB identity: a sibling `runs` whose status CHECK also admits 'archived' is refused untouched — CHECK bodies are identity on EVERY audit table", () => {
    // Reviewer-reproduced on the pre-fix tree: this sibling was ADOPTED and --fresh dropped its
    // rows (the CHECK body is invisible to every structural pragma; only the stored CREATE text
    // carries it). The columns are OURS exactly — the CHECK multiset is the only difference.
    const path = nextFile();
    forgeAuditTable(path, "runs", (sql) => sql.replace("'running','completed','failed'", "'running','completed','failed','archived'"));
    const seed = new Database(path, { strict: true });
    seed.exec("INSERT INTO runs (run_id, started_at, status, config_hash, effective_owners, owners_source, tracked_packages, cutoff_date, github_host) VALUES ('r-arch','2026-01-01T00:00:00.000Z','archived','h','[]','configured','[]','2024-01-01','github.com')");
    const before = (seed.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n; // forge base rows + the seeded sibling row
    seed.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create/);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true })).toThrow(/did not create/); // --fresh must refuse, not drop
    const check = new Database(path, { readonly: true });
    expect((check.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(before); // every sibling row intact
    expect((check.query("SELECT status FROM runs WHERE run_id='r-arch'").get() as { status: string }).status).toBe("archived"); // incl. the CHECK-widen-only row
    expect((check.query("SELECT sql FROM sqlite_schema WHERE name='runs'").get() as { sql: string }).sql).toContain("'archived'");
    check.close();
  });

  test("whole-DB identity: a sibling `package_api_surface` with a COLLATE NOCASE column is refused — pragma-invisible token on a non-run_unit_head table", () => {
    // The CHECK body is OURS verbatim; only a column collation differs — invisible to table_xinfo
    // AND to the CHECK multiset, exactly the residual the per-table token scan exists for.
    const path = nextFile();
    forgeAuditTable(path, "package_api_surface", (sql) => sql.replace("version_source TEXT", "version_source TEXT COLLATE NOCASE"));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create/);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true })).toThrow(/did not create/); // caches survive --fresh; a foreign one must not be adopted
  });

  test("whole-DB identity control: every era reference table is token-free and carries the PINNED CHECK counts (independent oracle)", () => {
    // The expected side of the fingerprint derives from the SAME extractChecks that reads the disk —
    // a circular oracle unless something independent pins what the references MUST contain. These
    // literals are hand-written from the schema, not derived: if SCHEMA_SQL's CHECKs change, this
    // test fails first and forces the pin (and the era references) to be re-examined deliberately.
    const EXPECTED_CHECK_COUNTS: Record<string, number> = {
      runs: 2, work_queue: 3, package_api_surface: 1, run_unit_head: 5,
      api_cache: 0, dependency_findings: 0, usage_findings: 0, errors: 0,
    };
    for (const version of [2, 3, 4]) {
      const shapes = tableShapesAt(version);
      for (const [table, shapeJson] of shapes) {
        const shape = JSON.parse(shapeJson) as { checks?: string[]; tokens?: string[] };
        expect(shape.tokens ?? ["MISSING"]).toEqual([]); // every reference era is token-free
        const expected = table === "run_unit_head" && version < 4 ? 1 : EXPECTED_CHECK_COUNTS[table]!; // v2 and v3 both carry the single RUH_V23 status CHECK; v4's 5 come from EXPECTED_CHECK_COUNTS
        expect({ table, version, n: (shape.checks ?? []).length }).toEqual({ table, version, n: expected });
      }
    }
    // and one body pinned literally (normalized): the runs status CHECK reviewers proved adoptable when widened
    const v4runs = JSON.parse(tableShapesAt(4).get("runs")!) as { checks: string[] };
    expect(v4runs.checks).toContain(normalizeCheck("status IN ('running','completed','failed')"));
  });

  test("tableShapesAt hands out a COPY on BOTH the cold and cached paths — a caller's mutation cannot corrupt the memoized ownership oracle", () => {
    // tableShapesAt is exported for tests but referenceShapesByVersion is the same cache production
    // hasOwnedTableSet reads; returning the live Map on EITHER path would let a caller poison ownership
    // for the rest of the process. hasOwnedTableSet only warms MIN_OWNED_VERSION..SCHEMA_VERSION, so a
    // higher key is guaranteed COLD here — this test owns its whole cache lifecycle and pins the cold
    // build (first call) AND the cached return (later calls) deterministically, independent of test
    // order (a cache warmed by an earlier test would otherwise hide a cold-path-only regression).
    const coldKey = SCHEMA_VERSION + 100;
    const cold = tableShapesAt(coldKey); // COLD path — the first build for this key
    const warm = tableShapesAt(coldKey); // CACHED path — served from the memoized entry
    expect(cold).not.toBe(warm); // both are fresh copies → distinct instances (RED if EITHER path hands back the memoized Map)
    const realRuns = cold.get("runs");
    expect(realRuns).toBeDefined();
    expect([...cold.entries()].sort()).toEqual([...warm.entries()].sort()); // …with identical contents
    // Tamper the COLD-path result: the memoized oracle a later call reads must be BYTE-IDENTICAL to the
    // real value (not merely "not TAMPERED" — that would also pass on an undefined regression).
    (cold as Map<string, string>).set("runs", "TAMPERED-COLD");
    expect(tableShapesAt(coldKey).get("runs")).toBe(realRuns);
    // Tamper a CACHED-path result too: same guarantee (this arm is what catches a cached-path-only regression).
    (tableShapesAt(coldKey) as Map<string, string>).set("runs", "TAMPERED-CACHED");
    expect(tableShapesAt(coldKey).get("runs")).toBe(realRuns);
  });

  test("inbound FK from a NON-audit table: the ownership preflight refuses the file before --fresh/migration", () => {
    const path = nextFile();
    buildV3TwinDb(path); // v3, stamp 3 — would otherwise migrate
    const f = new Database(path, { strict: true });
    f.exec("PRAGMA foreign_keys = OFF;");
    f.exec("CREATE TABLE ext (id INTEGER PRIMARY KEY, ruh TEXT REFERENCES run_unit_head(run_id) ON DELETE CASCADE)");
    f.close();
    // `ext` is not an audit table name, so assertOwnedDatabase refuses the whole file (fail-closed)
    // BEFORE the compat gate or --fresh can run — its CASCADE rows can never be reached by a DROP.
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/this tool did not create/);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true })).toThrow(/this tool did not create/);
    const check = new Database(path, { readonly: true });
    expect(uv(check)).toBe(3); // untouched
    check.close();
  });

  test("inbound FK from an AUDIT-NAMED table: refused on the preflight, nothing mutated", () => {
    // The audit-NAMED carrier no longer passes ownership (its rebuilt shape matches no era —
    // shape-level ownership replaced the old name-level match), so the preflight refuses the file
    // as "did not create" before anything can mutate; the inbound-FK gate (assertOpenCompatible
    // gate c) and the migration's in-transaction guard remain the layered backstops for the state
    // they exist for: the v3→v4 rebuild's DROP of run_unit_head would cascade-delete the
    // carrier's rows, and foreign_key_check on the rebuilt table cannot detect that loss. The
    // journal-mode assertion pins that the refusal precedes any WAL flip.
    const path = nextFile();
    buildV3TwinDb(path); // v3, stamp 3 — would otherwise migrate
    const f = new Database(path, { strict: true });
    f.exec("PRAGMA foreign_keys = OFF;");
    f.exec("DROP TABLE errors");
    f.exec("CREATE TABLE errors (id INTEGER PRIMARY KEY, ruh TEXT REFERENCES run_unit_head(run_id) ON DELETE CASCADE)");
    f.exec("INSERT INTO errors (id, ruh) VALUES (1, 'r1')");
    f.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|foreign key into run_unit_head/);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true })).toThrow(/did not create|foreign key into run_unit_head/);
    const check = new Database(path, { readonly: true });
    expect(uv(check)).toBe(3); // untouched
    expect((check.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).not.toBe("wal"); // never WAL-flipped
    expect((check.query("SELECT COUNT(*) AS n FROM errors").get() as { n: number }).n).toBe(1); // carrier rows intact
    check.close();
  });

  test("CHECK tokenizer: expected CHECK text hidden in a DEFAULT string does NOT satisfy the fingerprint", () => {
    const path = nextFile();
    // The DEFAULT string embeds the current 5-CHECK text. HONEST SCOPE: SQL doubles the quotes
    // inside the literal, so even a broken tokenizer that scanned string contents could not extract
    // an exact fingerprint match from here — this fixture proves only that CHECK-like text in a
    // DEFAULT does not corrupt classification of a CHECK-less table. The string-boundary property
    // itself is pinned DIRECTLY by the extractChecks unit tests below (found in review round 4:
    // a string-scanning extractChecks mutant still passed this fixture).
    const embedded = [
      "CHECK (status IN ('scanned','skipped-cutoff','policy-excluded','past-cap'))",
      "CHECK (policy_status IS NULL OR policy_status IN ('excluded-by-deny','excluded-by-allow'))",
      V4_RUH_PARTS.checks,
    ].join(", ").replace(/'/g, "''");
    forgeRuh(path, `CREATE TABLE run_unit_head (
      run_id TEXT NOT NULL REFERENCES runs(run_id), organization TEXT NOT NULL, repository TEXT NOT NULL,
      branch TEXT NOT NULL, commit_sha TEXT NOT NULL DEFAULT '${embedded}',
      status TEXT NOT NULL DEFAULT 'scanned', is_default_branch INTEGER,
      policy_status TEXT, policy_matched_pattern TEXT, scanned_commit_date TEXT,
      PRIMARY KEY (run_id, organization, repository, branch))`); // NO real CHECKs — text is only in a default
    // The forged DEFAULT also differs from ours, so shape-level ownership refuses first ("did not
    // create"); the quote-aware tokenizer itself stays pinned by the OR-clause test above and the
    // direct-drive classifier tests (same-DEFAULT, different-CHECK fixtures).
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible/);
  });

  test("CHECK case: a status CHECK with UPPERCASE literal values is rejected (would break lowercase writes)", () => {
    const path = nextFile();
    // ONLY difference from ours-v4: the status CHECK's literals are UPPERCASE. Everything else —
    // including both new status↔policy_status CHECKs — is the current shape, so rejection can only
    // come from literal case (normalizeCheck deliberately never case-folds literals).
    forgeRuh(path, v4Ruh({
      cols: V4_RUH_PARTS.cols.replace(
        "CHECK (status IN ('scanned','skipped-cutoff','policy-excluded','past-cap'))",
        "CHECK (status IN ('SCANNED','SKIPPED-CUTOFF','POLICY-EXCLUDED','PAST-CAP'))",
      ),
    }));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible/);
  });

  test("fingerprint: a v4 table with an extra GENERATED column is rejected (table_xinfo, not table_info)", () => {
    const path = nextFile();
    // ONLY difference from ours-v4: one extra GENERATED column (invisible to table_info).
    forgeRuh(path, v4Ruh({ cols: `${V4_RUH_PARTS.cols},
      extra TEXT GENERATED ALWAYS AS (branch) VIRTUAL` }));
    // Ownership's colSig reads table_xinfo too, so the hidden column now also fails the
    // preflight shape proof ("did not create"); the classifier remains the in-gate backstop.
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible/);
  });

  test("gate: run_unit_head absent while runs is present (a partial v4) is rejected — --fresh cannot destroy runs", () => {
    const path = nextFile();
    buildNativeV4(path);
    const f = new Database(path, { strict: true });
    f.exec("PRAGMA foreign_keys = OFF;");
    f.exec("DROP TABLE run_unit_head"); // runs survives -> NOT a real (atomic) post-fresh state
    f.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/incompatible|missing while the runs/);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true })).toThrow(/incompatible|missing while the runs/);
    const check = new Database(path, { readonly: true });
    expect((check.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(1); // runs untouched
    check.close();
  });

  test("index: a UNIQUE ix_ruh_loc (wrong definition) is rejected — not merely name-matched", () => {
    const path = nextFile();
    buildNativeV4(path);
    const f = new Database(path, { strict: true });
    f.exec("DROP INDEX ix_ruh_loc");
    f.exec("CREATE UNIQUE INDEX ix_ruh_loc ON run_unit_head(organization, repository, branch, commit_sha)");
    f.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/incompatible/);
  });

  test("dependent objects: a trigger on run_unit_head is rejected (a rebuild would silently drop it)", () => {
    const path = nextFile();
    buildV3TwinDb(path); // v3 -> would otherwise migrate
    const f = new Database(path, { strict: true });
    f.exec("CREATE TRIGGER trg AFTER INSERT ON run_unit_head BEGIN SELECT 1; END");
    f.close();
    // A trigger is an ALWAYS-foreign object (this tool creates none), so the ownership preflight
    // refuses the whole file before the compat gate runs; the classifier's unexpected-dependents
    // check remains the in-gate backstop for the same state.
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/this tool did not create/);
  });

  test("a v2-shaped run_unit_head stamped v3 is HEALED by the writer open (the skipped v2→v3 delta is repaired shape-keyed)", () => {
    // At stamp 3 the chain runs only migrateV3toV4, so a v2 shape means the v2→v3 delta is
    // missing — external damage (the chain stamps atomically with its ALTER). The migration's
    // exact-v2 arm heals it: restore is_default_branch (NULL = unknown, never 0), then rebuild
    // exactly like any v3 table. Rows ride through.
    const path = nextFile();
    buildV2Db(path); // v2 shape, stamp 2
    const f = new Database(path, { strict: true });
    f.exec("PRAGMA user_version = 3"); // lie: a v3 stamp on a v2 shape
    f.close();
    const db = AuditDb.open({ sqlitePath: path });
    const r = raw(db);
    expect(uv(r)).toBe(SCHEMA_VERSION);
    expect(r.query("SELECT branch, commit_sha, status, is_default_branch, scanned_commit_date FROM run_unit_head ORDER BY branch").all())
      .toEqual([
        { branch: "main", commit_sha: "sha1", status: "scanned", is_default_branch: null, scanned_commit_date: null },
        { branch: "stale", commit_sha: "", status: "skipped-cutoff", is_default_branch: null, scanned_commit_date: null },
      ]);
    db.close();
  });

  test("fingerprint: is_default_branch declared TEXT (wrong type) is rejected", () => {
    const path = nextFile();
    // ONLY difference from ours-v4: is_default_branch declared TEXT instead of INTEGER.
    forgeRuh(path, v4Ruh({ cols: V4_RUH_PARTS.cols.replace("is_default_branch INTEGER", "is_default_branch TEXT") }));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible/);
  });

  test("fingerprint: an extra table-level UNIQUE constraint (its autoindex) is rejected", () => {
    const path = nextFile();
    // ONLY difference from ours-v4: an extra table-level UNIQUE (and thus its autoindex).
    forgeRuh(path, v4Ruh({ checks: `${V4_RUH_PARTS.checks},
      UNIQUE(commit_sha)` }));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible/);
  });

  test("fingerprint: a NOCASE primary-key collation is rejected (would conflate case-distinct keys)", () => {
    const path = nextFile();
    // ONLY difference from ours-v4: a NOCASE collation on one primary-key column.
    forgeRuh(path, v4Ruh({ pk: "PRIMARY KEY (run_id, organization COLLATE NOCASE, repository, branch)" }));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible|collation/);
  });

  test("fingerprint: a NOCASE collation on a NON-PK column (status) is rejected — no structural probe can see it", () => {
    const path = nextFile();
    // ONLY difference from ours-v4: `status` declares COLLATE NOCASE. Under NOCASE, 'SCANNED'
    // satisfies the lowercase status CHECK — the uppercase-literal defense is moot on such a sibling
    // — and table_xinfo's declared type omits COLLATE, so only the CREATE-sql token scan catches it.
    // This shape was ACCEPTED before that scan existed (found by adversarial review, verified live).
    forgeRuh(path, v4Ruh({ cols: V4_RUH_PARTS.cols.replace(
      "status TEXT NOT NULL DEFAULT 'scanned'",
      "status TEXT COLLATE NOCASE NOT NULL DEFAULT 'scanned'",
    ) }));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|COLLATE clause/);
  });

  test("fingerprint: a DUPLICATED member of the exact CHECK set is rejected (multiset, never Set, comparison)", () => {
    const path = nextFile();
    // ONLY difference from ours-v4: one expected CHECK appears TWICE. Set-equality collapsed this
    // ({A,A,B,C,D,E} == {A..E}) and adopted a table whose constraint text was not ours.
    forgeRuh(path, v4Ruh({ checks: `${V4_RUH_PARTS.checks},
      CHECK (status NOT IN ('skipped-cutoff','past-cap') OR policy_status IS NULL)` }));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|not the exact v4 CHECK set/);
  });

  // Round-4 identity gaps, each demonstrated by ADOPTION before the fix. Every fixture is a v4Ruh
  // single-property mutation, anchored by the control above.
  // EVERY identity deviation below — pragma-visible (DEFAULT, FK action, STRICT, PK order) and
  // pragma-invisible (CHECK bodies, COLLATE/CONFLICT/DEFERRABLE/MATCH tokens) alike — is refused by
  // shape-level ownership on the preflight ("did not create") since the whole-DB identity work put
  // CHECK multisets + the five-token scan into the ownership fingerprint. The classifier's own
  // checks remain the layered migration-time backstop (verifyRunUnitHeadFingerprint drives them
  // after every rebuild), so the pins below accept EITHER layer's message: the property pinned is
  // refusal-without-mutation, not which layer names it first.
  test("fingerprint: a foreign column DEFAULT is rejected — defaults change what future INSERTs mean", () => {
    const path = nextFile();
    forgeRuh(path, v4Ruh({ cols: V4_RUH_PARTS.cols.replace("commit_sha TEXT NOT NULL DEFAULT ''", "commit_sha TEXT NOT NULL DEFAULT 'foreign-default'") }));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible/);
  });
  test("fingerprint: a foreign FK action (ON DELETE CASCADE) is rejected — it changes write semantics", () => {
    const path = nextFile();
    forgeRuh(path, v4Ruh({ cols: V4_RUH_PARTS.cols.replace("REFERENCES runs(run_id)", "REFERENCES runs(run_id) ON DELETE CASCADE") }));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|foreign key/);
  });
  test("fingerprint: a STRICT table is rejected — STRICT changes type-affinity semantics", () => {
    const path = nextFile();
    forgeRuh(path, v4Ruh() + " STRICT");
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|STRICT/);
  });
  test("index: a DESC column in ix_ruh_loc is rejected — same name, different scan semantics", () => {
    const path = nextFile();
    buildNativeV4(path);
    const f = new Database(path, { strict: true });
    f.exec("DROP INDEX ix_ruh_loc");
    f.exec("CREATE INDEX ix_ruh_loc ON run_unit_head(organization DESC, repository, branch, commit_sha)");
    f.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/wrong definition|incompatible/);
  });

  test("fingerprint: an ON CONFLICT clause is rejected — it silently changes constraint-violation behavior", () => {
    const path = nextFile();
    forgeRuh(path, v4Ruh({ pk: "PRIMARY KEY (run_id, organization, repository, branch) ON CONFLICT REPLACE" }));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|ON CONFLICT/);
  });
  test("fingerprint: a DEFERRABLE foreign key is rejected — enforcement deferred to COMMIT", () => {
    const path = nextFile();
    forgeRuh(path, v4Ruh({ cols: V4_RUH_PARTS.cols.replace("REFERENCES runs(run_id)", "REFERENCES runs(run_id) DEFERRABLE INITIALLY DEFERRED") }));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|DEFERRABLE/);
  });
  test("fingerprint: a MATCH clause on the foreign key is rejected — pragma-invisible, so only the token scan can see it", () => {
    // SQLite PARSES a MATCH clause but never enforces it, and pragma foreign_key_list reports
    // match='NONE' regardless — so the FK-tuple equality above it is structurally blind to this
    // clause and every pragma-based probe accepts the file. Reviewer-constructed before the fix:
    // the sibling was ADOPTED and --fresh DESTROYED its rows. Rows are seeded here so this pin
    // fails loudly on destruction, not just on classification.
    const path = nextFile();
    forgeRuh(path, v4Ruh({ cols: V4_RUH_PARTS.cols.replace("REFERENCES runs(run_id)", "REFERENCES runs(run_id) MATCH FULL") }));
    const seed = new Database(path, { strict: true });
    seed.exec("PRAGMA foreign_keys = OFF");
    seed.exec("INSERT INTO runs (run_id, started_at, status, config_hash, effective_owners, owners_source, tracked_packages, cutoff_date, github_host) VALUES ('r1','2026-01-01T00:00:00.000Z','completed','h','[]','configured','[]','2024-01-01','github.com')");
    seed.exec("INSERT INTO run_unit_head (run_id, organization, repository, branch, commit_sha, status, is_default_branch, policy_status, policy_matched_pattern, scanned_commit_date) VALUES ('r1','org','repo','main','sha','scanned',1,NULL,NULL,'2025-06-01T00:00:00Z')");
    seed.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|MATCH/);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true })).toThrow(/did not create|MATCH/); // --fresh must refuse, not destroy
    const check = new Database(path, { readonly: true });
    expect((check.query("SELECT COUNT(*) AS n FROM run_unit_head").get() as { n: number }).n).toBe(1); // rows intact
    expect((check.query("SELECT sql FROM sqlite_schema WHERE name='run_unit_head'").get() as { sql: string }).sql).toContain("MATCH FULL"); // shape untouched
    check.close();
  });
  test("fingerprint: a DESC member of the composite PRIMARY KEY is rejected", () => {
    const path = nextFile();
    forgeRuh(path, v4Ruh({ pk: "PRIMARY KEY (run_id, organization DESC, repository, branch)" }));
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|primary key|incompatible/);
  });

  // Direct pins for extractChecks' trivia handling — the property the DEFAULT-string fixture above
  // cannot reach (SQL quote-doubling makes exact-match acceptance impossible through a literal).
  test("extractChecks: CHECK-like text inside a string literal or comment yields NO checks; real ones are extracted with duplicates preserved", () => {
    expect(extractChecks("CREATE TABLE t (a TEXT DEFAULT 'CHECK (x IN (1))')")).toEqual([]);
    expect(extractChecks("CREATE TABLE t (a TEXT /* CHECK (x IN (1)) */, b TEXT -- CHECK (y IN (2))\n)")).toEqual([]);
    const two = extractChecks("CREATE TABLE t (a TEXT, CHECK (a <> ''), CHECK (a <> ''))");
    expect(two.length).toBe(2); // duplicates PRESERVED — the multiset comparison depends on it
  });

  test("index: an ix_ruh_loc on a DIFFERENT table (global name squat) is rejected, not treated as repairable-absent", () => {
    const path = nextFile();
    buildNativeV4(path);
    const f = new Database(path, { strict: true });
    f.exec("DROP INDEX ix_ruh_loc");
    f.exec("CREATE INDEX ix_ruh_loc ON runs(config_hash)"); // squat the schema-global index name
    f.close();
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/incompatible/);
  });

  test("CHECK tokenizer: comments as trivia (CHECK/* */( and status/* */IN, no surrounding spaces) still classify as ours", () => {
    const path = nextFile();
    forgeRuh(path, `CREATE TABLE run_unit_head (
      run_id TEXT NOT NULL REFERENCES runs(run_id), organization TEXT NOT NULL, repository TEXT NOT NULL,
      branch TEXT NOT NULL, commit_sha TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'scanned' CHECK/* g1 */(status/* g2 */IN ('scanned','skipped-cutoff','policy-excluded','past-cap')),
      is_default_branch INTEGER,
      policy_status TEXT CHECK (policy_status IS NULL OR policy_status IN ('excluded-by-deny','excluded-by-allow')),
      policy_matched_pattern TEXT, scanned_commit_date TEXT,
      CHECK (policy_status <> 'excluded-by-deny' OR policy_matched_pattern IS NOT NULL),
      CHECK (status <> 'policy-excluded' OR policy_status IS NOT NULL),
      CHECK (status NOT IN ('skipped-cutoff','past-cap') OR policy_status IS NULL),
      PRIMARY KEY (run_id, organization, repository, branch))`); // no ix_ruh_loc -> ours-v4-missing-index -> repaired
    const db = AuditDb.open({ sqlitePath: path }); // accepted (comments are trivia) + self-heals the index
    db.close();
  });

  test("openReadOnly: an inbound FK to run_unit_head is rejected — consistent with the writer gate", () => {
    const path = nextFile();
    buildNativeV4(path); // ours-v4, stamp 4
    const f = new Database(path, { strict: true });
    f.exec("PRAGMA foreign_keys = OFF;");
    f.exec("CREATE TABLE ext (id INTEGER PRIMARY KEY, ruh TEXT REFERENCES run_unit_head(run_id))");
    f.close();
    // `ext` is a non-audit table, so the read path's ownership parity gate refuses the file as
    // "did not create" — consistent with the writer; the inbound-FK discriminator remains the
    // layered backstop for an audit-named carrier that evades shape ownership.
    expect(() => AuditDb.openReadOnly({ sqlitePath: path })).toThrow(/did not create|incompatible|foreign key into run_unit_head/);
  });
});

describe("LIKE-wildcard table names vs the foreign-object/inbound-FK guards (santa round 5)", () => {
  test("a CASCADE child named sqliteevil blocks the v3→v4 rebuild — rejected on the read-only preflight, nothing mutated", () => {
    const path = nextFile();
    buildV3TwinDb(path); // v3, stamp 3, journal delete
    const forge = new Database(path, { strict: true });
    forge.exec(`CREATE TABLE sqliteevil (
      id INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL, organization TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL,
      FOREIGN KEY (run_id, organization, repository, branch)
        REFERENCES run_unit_head(run_id, organization, repository, branch) ON DELETE CASCADE)`);
    forge.exec(`INSERT INTO sqliteevil (run_id, organization, repository, branch)
                SELECT run_id, organization, repository, branch FROM run_unit_head LIMIT 1`);
    forge.close();
    // 'sqliteevil' is a LEGAL name (no literal 'sqlite_' prefix) that an UNescaped LIKE 'sqlite_%'
    // wildcard-matches ('_' matches 'e') — the rebuild's DROP TABLE run_unit_head would silently
    // CASCADE its rows away (observed 2→0 before the ESCAPE fix). The ownership preflight (whose
    // NOT_SQLITE_INTERNAL predicate carries the same ESCAPE) refuses the file first; the escaped
    // inbound-FK guard remains the layered backstop inside the compat gate and the migration.
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/this tool did not create/);
    const check = new Database(path, { readonly: true });
    expect((check.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3); // unstamped
    expect((check.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete"); // preflight reject: no WAL flip
    expect((check.query("SELECT COUNT(*) AS n FROM sqliteevil").get() as { n: number }).n).toBe(1); // rows intact
    check.close();
  });

  test("a foreign file whose ONLY table is sqliteevil is REJECTED, not silently adopted", () => {
    const path = nextFile();
    const raw = new Database(path, { create: true, strict: true });
    raw.exec("CREATE TABLE sqliteevil (id INTEGER PRIMARY KEY, secret TEXT)");
    raw.exec("INSERT INTO sqliteevil VALUES (1,'s1')");
    raw.close();
    // hasForeignObjects must count this LEGAL name as FOREIGN (zero audit tables + a foreign object
    // = someone else's database); the unescaped LIKE used to read it as internal and adopt the file.
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/this tool did not create/);
    const check = new Database(path, { readonly: true });
    expect((check.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete"); // never WAL-mutated
    expect((check.query("SELECT COUNT(*) AS n FROM sqliteevil").get() as { n: number }).n).toBe(1);
    check.close();
  });
});

describe("live compat backstop — states the base-image preflight cannot see", () => {
  test("a sibling v4 committed ONLY into -wal frames over a common v3 base is rejected before adoption or --fresh", () => {
    // The base-image counterexample: a sibling build (descended from the same v3) rebuilds
    // run_unit_head incompatibly and stamps 4, but its commit sits entirely in -wal frames over a
    // checkpointed common-v3 base. The deserialize preflight classifies the BASE (exact-v3, stamp
    // 3) and passes; the LIVE stamp reads 4, so without a live re-check the migration would
    // never reclassify — the sibling would be silently ADOPTED, and --fresh would DROP its
    // reshaped tables. The live backstops (isOwnedOrEmpty + assertOpenCompatible, both before
    // the WAL pragma and --fresh) must reject it.
    const path = nextFile();
    buildV3TwinDb(path); // checkpointed common v3 base, delete journal
    const snap = `${path}.snap`;
    const sib = new Database(path, { strict: true });
    sib.exec("PRAGMA journal_mode = WAL;");
    sib.exec("BEGIN");
    sib.exec("DROP TABLE run_unit_head");
    sib.exec("CREATE TABLE run_unit_head (run_id TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY (run_id))"); // sibling shape
    sib.exec("COMMIT");
    sib.exec("PRAGMA user_version = 4");
    // Snapshot base+wal while the writer is still open (nothing has checkpointed), then swap the
    // snapshot back so the on-disk state is exactly "clean v3 base + sibling-v4 -wal".
    copyFileSync(path, snap);
    copyFileSync(`${path}-wal`, `${snap}-wal`);
    sib.close();
    copyFileSync(snap, path);
    copyFileSync(`${snap}-wal`, `${path}-wal`);
    rmSync(snap, { force: true });
    rmSync(`${snap}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    expect(() => AuditDb.open({ sqlitePath: path })).toThrow(/did not create|incompatible/);
    expect(() => AuditDb.open({ sqlitePath: path, fresh: true })).toThrow(/did not create|incompatible/); // --fresh cannot drop it
    // The sibling's data survives (WAL recovery on their file is the documented residual cost —
    // data-preserving; adoption/drop is what must never happen).
    const check = new Database(path, { readonly: true });
    expect((check.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(4);
    expect((check.query("SELECT COUNT(*) AS n FROM pragma_table_xinfo('run_unit_head')").get() as { n: number }).n).toBe(2); // sibling shape intact
    check.close();
  });

  test("preflight: an EMPTY file stamped NEWER than this build is refused on the base image, before any writable handle", () => {
    // The rejection venue is unobservable through AuditDb.open (the post-open readUserVersion
    // check rejects the same state byte-cleanly with the same message — pinned elsewhere), so the
    // preflight's zero-handle guarantee is driven directly: assertOwnedDatabase itself must throw.
    const path = nextFile();
    const raw = new Database(path, { create: true, strict: true });
    raw.exec("PRAGMA user_version = 5"); // zero objects, stamp newer than SCHEMA_VERSION (4)
    raw.close();
    expect(() => assertOwnedDatabase(path)).toThrow(/newer than this tool's/);
    // …while an empty file at the CURRENT stamp stays adoptable — the exact on-disk state a
    // crashed `--fresh --purge-cache` leaves behind (all audit tables dropped, stamp retained).
    const path2 = nextFile();
    const raw2 = new Database(path2, { create: true, strict: true });
    raw2.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    raw2.close();
    expect(() => assertOwnedDatabase(path2)).not.toThrow();
  });

  test("isOwnedOrEmpty rejects a FULL-name-set database stamped below MIN_OWNED_VERSION", () => {
    // hasOwnedTableSet's FULL/FRESH_PRESERVED shortcut is name-level and checks the stamp only on
    // its PARTIAL-set repair path — the backstop must therefore carry the version conjunct itself,
    // or a foreign full-name-set file stamped 0/1 (a state this tool never produced) would pass.
    const db = new Database(":memory:", { strict: true });
    db.exec(V2_SCHEMA_SQL); // all eight audit table names
    db.exec("PRAGMA user_version = 1"); // below MIN_OWNED_VERSION
    expect(isOwnedOrEmpty(db)).toBe(false);
    db.exec("PRAGMA user_version = 2"); // at MIN_OWNED_VERSION the same set is owned
    expect(isOwnedOrEmpty(db)).toBe(true);
    db.close();
  });
});
