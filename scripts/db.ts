// db.ts — SQLite durability layer (§3): open/migrate the audit database, run lifecycle,
// work-queue state, and prepared-statement upserts for every finding/cache/surface table.
// SQLite is the source of truth. ALL timestamps are persisted in ONE canonical fixed-width
// ISO-8601 UTC form (nowIso), so lexicographic ordering equals chronological ordering (§3/§7).
// Single-writer: orchestrate.ts owns all writes; report.ts reads via the exposed handle.

import { Database, type Statement } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertContained } from "./readOnlyGuard.ts";
import { logLine } from "./log.ts";

export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbError";
  }
}
function fail(msg: string): never {
  throw new DbError(msg);
}

// Bump when the schema changes; older on-disk versions run the §3 VERSION-STEPPED migration
// chain — each step is one transaction that stamps its own target version, so a crash between
// steps leaves a valid intermediate database that the next open resumes from.
export const SCHEMA_VERSION = 3;
// Every migration step stamps its own PINNED target version — never the mutable
// SCHEMA_VERSION. (If a step stamped SCHEMA_VERSION, bumping the constant for v4 would make a
// crash between the v2→v3 step and the future v3→v4 step leave a v3-SHAPED database stamped 4,
// and every later open would skip the missing migration.)
// migrateLegacy's target. The legacy migration is QUARANTINED to user_version < 2: it rebuilds
// the run-scoped tables EMPTY (sound only for pre-v2 databases, whose findings are
// non-reportable) — routing a v2+ database through it would DESTROY reportable data.
const LEGACY_TARGET_VERSION = 2;
// migrateV2toV3's target.
const V3_TARGET_VERSION = 3;

// §7 SURFACE-CACHE EPOCH. Bumped when the introspection LOGIC changes (resolver correctness, parse
// bounds) so a package audited by an OLDER, buggier resolver does NOT keep its stale '__complete__'
// marker forever (hasCompletionMarker short-circuits BEFORE inspection, and even --fresh preserves
// package_api_surface). The epoch is stamped into the marker row's `source` column (no DDL change,
// so no destructive v2→v3 table migration): a marker whose stored epoch != this constant is treated
// as ABSENT → the version is re-inspected under the current resolver, and writeApiSurface REPLACES
// the version's whole row set. Start at 2 so every pre-epoch marker (source='__complete__') misses.
export const SURFACE_SCHEMA_VERSION = 2;
const COMPLETION_KIND = "__complete__";
// The marker row's `source` value: identifies the marker AND carries the surface epoch.
const markerSource = (epoch: number): string => `${COMPLETION_KIND}@${epoch}`;

export const nowIso = (): string => new Date().toISOString();

// §3: ALL persisted timestamps use ONE canonical fixed-width ISO-8601 UTC form so that
// lexicographic ordering equals chronological ordering (§7 relies on MAX over these).
// db.ts is the write boundary, so caller-supplied timestamps are validated here.
const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function assertCanonicalTimestamp(value: string, ctx: string): string {
  // Shape check first (fast reject), then a Date round-trip so a fixed-width-but-impossible
  // value (2024-99-99T99:99:99.999Z) or a rollover form (2024-06-31…) cannot slip through:
  // toISOString() output IS the canonical form, so round-trip equality is the authority.
  const ms = Date.parse(value);
  if (!CANONICAL_ISO_RE.test(value) || Number.isNaN(ms) || new Date(ms).toISOString() !== value)
    fail(`${ctx} must be canonical fixed-width ISO-8601 UTC (nowIso form), got: ${value}`);
  return value;
}

// ---- shared row/domain types --------------------------------------------------------------
export type OwnersSource = "configured" | "discovered";
export type RunStatus = "running" | "completed" | "failed";
export type WorkScope = "org" | "repo" | "branch";
export type WorkStatus = "pending" | "in_progress" | "done" | "skipped" | "error";
export type UnitHeadStatus = "scanned" | "skipped-cutoff";
export type DependencyType =
  | "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies"
  | "overrides" | "resolutions";
export type UsageType =
  | "named-import" | "default-import" | "namespace-import" | "require"
  | "dynamic-import" | "reexport" | "side-effect-import" | "cli";
export type ResolvedVersionSource = "lockfile" | "range-resolved";
export type ExportKind = "named" | "default" | "type" | "cli-bin";

export interface RunRecord {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  configHash: string;
  effectiveOwners: string[];
  ownersSource: OwnersSource;
  trackedPackages: string[];
  cutoffDate: string;
  githubHost: string;
  status: RunStatus;
}

export interface RunInput {
  configHash: string;
  effectiveOwners: string[];
  ownersSource: OwnersSource;
  trackedPackages: string[];
  cutoffDate: string;
  githubHost: string;
}

export interface StartRunResult {
  runId: string;
  resumed: boolean;
}

export interface WorkUnitKey {
  configHash: string;
  scope: WorkScope;
  organization: string;
  repository?: string; // '' sentinel for org scope (§3: NULLs don't dedupe)
  branch?: string; // '' sentinel for org/repo scope
}

export interface WorkUnit {
  id: number;
  configHash: string;
  createdRunId: string;
  lastRunId: string;
  scope: WorkScope;
  organization: string;
  repository: string;
  branch: string;
  lastCommitSha: string;
  lastCommitDate: string | null;
  status: WorkStatus;
  errorMessage: string | null;
  updatedAt: string;
}

export interface DependencyFindingInput {
  runId: string;
  organization: string;
  repository: string;
  branch: string;
  commitSha: string;
  dateFetched: string;
  packageName: string;
  dependencyKey: string;
  dependencyType: DependencyType;
  manifestPath: string;
  manifestLine: number;
  manifestPermalink: string;
  declaredVersion: string;
  lockfilePath?: string | null;
  lockfileKind?: "npm" | "yarn" | "pnpm" | "bun" | null;
  lockfileLines?: number[] | null;
  lockfilePermalink?: string | null;
  resolvedVersion?: string | null;
  resolvedVersionSource?: ResolvedVersionSource | null;
}

export interface RangeResolveKey {
  organization: string;
  repository: string;
  branch: string;
  commitSha: string;
  packageName: string;
  dependencyKey: string;
  dependencyType: DependencyType;
  manifestPath: string;
}

export interface UsageFindingInput {
  runId: string;
  organization: string;
  repository: string;
  branch: string;
  commitSha: string;
  packageName: string;
  dependencyKey?: string; // '' only for CLI/unattributable usage (§3)
  usageType: UsageType;
  exportName?: string; // '' sentinel when no single named export applies
  context?: string; // CLI only (script name / Dockerfile stage); '' for imports
  filePath: string;
  lineNumber: number;
  permalink: string;
  snippet: string;
  foundAt: string;
}

export interface ErrorInput {
  runId: string;
  scope: string;
  organization?: string | null;
  repository?: string | null;
  branch?: string | null;
  packageName?: string | null;
  version?: string | null; // concrete semver for registry failures; raw spec for non-registry skips (§5.E)
  message: string;
  occurredAt?: string;
}

export interface RunUnitHeadInput {
  runId: string;
  organization: string;
  repository: string;
  branch: string;
  commitSha: string; // '' for skipped-cutoff branches (never scanned)
  status: UnitHeadStatus;
  // Tri-state, REQUIRED (not optional — `undefined` must never silently become "not default"):
  // true/false when discovery knew the repo's default branch, null = unknown. Pre-v3 rows are
  // NULL by migration backfill; the report renders NULL as its own designed state, never as 0.
  isDefaultBranch: boolean | null;
}

export interface ApiCacheEntry {
  method: string;
  url: string;
  variantHash: string;
  etag: string | null;
  responseBody: string | null;
  cachedAt: string;
}

export interface ApiSurfaceRow {
  exportName: string;
  exportKind: ExportKind;
  source: string;
}

export interface ApiSurfaceInput {
  packageName: string;
  version: string; // the RESOLVED concrete version, never a declared range
  versionSource: ResolvedVersionSource;
  rows: ApiSurfaceRow[]; // export/bin rows only; db.ts appends the '__complete__' marker
}

// ---- schema (§3 SQL block, verbatim semantics) ---------------------------------------------
const SCHEMA_SQL = `
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
  is_default_branch INTEGER,
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

// Every table this tool owns. Used to distinguish a fresh DB from a legacy one and to
// refuse to adopt a foreign (non-audit) SQLite file.
const AUDIT_TABLES = [
  "runs", "work_queue", "dependency_findings", "package_api_surface",
  "usage_findings", "run_unit_head", "api_cache", "errors",
] as const;
const AUDIT_TABLE_SET = new Set<string>(AUDIT_TABLES);

// --fresh drop order: FK-safe CHILD-BEFORE-PARENT — every run-scoped table references
// runs(run_id), so runs is dropped LAST (§3; PRAGMA foreign_keys=OFF is a no-op in-txn).
const FRESH_DROP_ORDER = [
  "run_unit_head", "dependency_findings", "usage_findings", "errors", "work_queue", "runs",
] as const;

// The migration's run-scoped-reset tables: rebuilt EMPTY in their new shape (§3) — their
// legacy rows belong only to pre-migration (non-reportable) runs and are never copied.
const RUN_SCOPED_RESET = ["dependency_findings", "usage_findings", "errors", "work_queue"] as const;

// ---- low-level helpers ----------------------------------------------------------------------
function readUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

// PRAGMA statements cannot bind parameters — interpolate a validated non-negative integer.
function setUserVersion(db: Database, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) fail(`invalid schema version ${v}`);
  db.exec(`PRAGMA user_version = ${v}`);
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== null;
}

function hasForeignTables(db: Database): boolean {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.some((r) => !AUDIT_TABLE_SET.has(r.name));
}

// PRAGMA table_info cannot bind either; `table` is always one of AUDIT_TABLES (enforced).
function columnExists(db: Database, table: string, column: string): boolean {
  if (!AUDIT_TABLE_SET.has(table)) fail(`columnExists called for unknown table ${table}`);
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  if (!columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

// Translate the SQLite failure modes a READ-ONLY open can hit into actionable operator errors.
// Classified by result code (never message text). SQLITE_READONLY_RECOVERY is matched exactly
// (a crashed writer's WAL needs WRITABLE recovery — waiting won't help; the fix is one writable
// open); the BUSY and CANTOPEN families are matched by PREFIX so extended variants
// (SQLITE_BUSY_TIMEOUT, SQLITE_BUSY_SNAPSHOT, SQLITE_CANTOPEN_*) classify with their primary
// code. Anything else is rethrown verbatim. Exported for direct unit tests — the recovery/busy
// states are impractical to fabricate deterministically in a test fixture.
export function mapReadOnlyOpenError(e: unknown, path: string): unknown {
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string") return e;
  if (code === "SQLITE_READONLY_RECOVERY")
    return new DbError(
      `database at ${path} has a WAL needing writable recovery (a previous writer crashed) — ` +
        "run `bun run audit` once (the only writable command), then retry",
    );
  if (code.startsWith("SQLITE_BUSY"))
    return new DbError(`database at ${path} is busy — an audit appears to be in progress; retry when it finishes`);
  if (code.startsWith("SQLITE_CANTOPEN"))
    return new DbError(`cannot open database at ${path} — run \`bun run audit\` first`);
  return e;
}

// ---- migrations (§3: version-stepped; each step ONE transaction stamping its target) --------
// migrateLegacy — the pre-v2 (legacy) step, QUARANTINED to user_version < LEGACY_TARGET_VERSION.
// Preserves the provenance tables (runs, run_unit_head) via additive ALTERs, preserves the
// caches (api_cache rebuilt WITH row copy; package_api_surface via ALTER), rebuilds the
// run-scoped tables EMPTY in their new shape, and marks every pre-existing 'running' run
// failed so the startup resume rule can never select a pre-migration run as the live run.
// ⚠️ NEVER route a v2+ database through this step: the run-scoped reset is sound ONLY for
// legacy databases (whose findings are non-reportable) — on a v2 database it destroys
// reportable data. It stamps exactly LEGACY_TARGET_VERSION; later steps take it from there.
function migrateLegacy(db: Database): void {
  db.transaction(() => {
    // 1. Additive ALTERs on the PRESERVED tables first (§3 ordering). Every added NOT NULL
    //    column carries a DEFAULT that satisfies its CHECK (SQLite rejects it otherwise).
    if (tableExists(db, "runs")) {
      addColumnIfMissing(db, "runs", "effective_owners", `TEXT NOT NULL DEFAULT '[]'`);
      addColumnIfMissing(
        db, "runs", "owners_source",
        `TEXT NOT NULL DEFAULT 'discovered' CHECK (owners_source IN ('configured','discovered'))`,
      );
      addColumnIfMissing(db, "runs", "tracked_packages", `TEXT NOT NULL DEFAULT '[]'`);
      addColumnIfMissing(db, "runs", "cutoff_date", `TEXT NOT NULL DEFAULT ''`);
      addColumnIfMissing(db, "runs", "github_host", `TEXT NOT NULL DEFAULT 'github.com'`);
    }
    if (tableExists(db, "package_api_surface")) {
      addColumnIfMissing(
        db, "package_api_surface", "version_source",
        `TEXT NOT NULL DEFAULT 'lockfile' CHECK (version_source IN ('lockfile','range-resolved'))`,
      );
    }
    // run_unit_head is PRESERVED via this additive ALTER alone (§3 lists exactly this, and
    // deliberately excludes run_unit_head from the FK-gaining rebuild list — the legacy shape
    // already carried run_id REFERENCES runs(run_id)). Do NOT "fix" this into a rebuild: a
    // rebuild of the provenance snapshot risks the data §3 orders preserved.
    if (tableExists(db, "run_unit_head")) {
      addColumnIfMissing(
        db, "run_unit_head", "status",
        `TEXT NOT NULL DEFAULT 'scanned' CHECK (status IN ('scanned','skipped-cutoff'))`,
      );
    }

    // 2. api_cache rebuild WITH row copy: legacy rows (PK url) predate GraphQL/variant
    //    support — backfill method='GET', variant_hash='' (§3 keeps --fresh-preserves-api_cache).
    if (tableExists(db, "api_cache") && !columnExists(db, "api_cache", "variant_hash")) {
      db.exec(`CREATE TABLE api_cache_migrated (
        method TEXT NOT NULL, url TEXT NOT NULL, variant_hash TEXT NOT NULL,
        etag TEXT, response_body TEXT, cached_at TEXT NOT NULL,
        PRIMARY KEY (method, url, variant_hash))`);
      db.exec(`INSERT INTO api_cache_migrated (method, url, variant_hash, etag, response_body, cached_at)
               SELECT 'GET', url, '', etag, response_body, cached_at FROM api_cache`);
      db.exec("DROP TABLE api_cache");
      db.exec("ALTER TABLE api_cache_migrated RENAME TO api_cache");
    }

    // 3. Run-scoped reset: rebuilt EMPTY — no legacy-row copy, no backfill, no orphan-run
    //    quarantine (§3). Dropping a child table is FK-safe even while parent rows exist.
    for (const t of RUN_SCOPED_RESET) db.exec(`DROP TABLE IF EXISTS ${t}`);

    // 4. Migration-boundary rule: every pre-existing running run is failed (any config_hash)
    //    so it can never be resumed as the live run with tracked_packages='[]'.
    if (tableExists(db, "runs")) db.exec(`UPDATE runs SET status='failed' WHERE status='running'`);

    // 5. New-shape CREATEs fill the emptied/missing tables + indexes, then stamp THIS step's
    //    target version (never SCHEMA_VERSION — the v2→v3 step still has to run; a crash
    //    between the steps leaves a valid v2-stamped database the next open resumes from).
    //    SCHEMA_SQL is the CURRENT schema, so freshly-created tables may already carry later
    //    columns — harmless: later steps use addColumnIfMissing, and preserved tables (the ones
    //    with data) get their new columns only from their own step's ALTER.
    db.exec(SCHEMA_SQL);
    setUserVersion(db, LEGACY_TARGET_VERSION);
  })();
}

// migrateV2toV3 — additive: run_unit_head gains nullable is_default_branch (INTEGER 1/0/NULL;
// NULL = unknown). Existing v2 rows are backfilled NULL by construction (ALTER ADD COLUMN),
// NEVER 0 — "unknown" and "not the default branch" are different report states. SCHEMA_SQL runs
// FIRST: a `--fresh` drop on a v2 database removes run_unit_head while the preserved caches
// keep the database non-empty, so this step must recreate missing tables (already v3-shaped)
// before the ALTER can assume run_unit_head exists.
function migrateV2toV3(db: Database): void {
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    addColumnIfMissing(db, "run_unit_head", "is_default_branch", "INTEGER");
    setUserVersion(db, V3_TARGET_VERSION);
  })();
}

// ---- open ------------------------------------------------------------------------------------
export interface OpenDbOptions {
  sqlitePath: string;
  fresh?: boolean;
  purgeCache?: boolean;
}

// The narrowed READ surface returned by AuditDb.openReadOnly — the read commands (report,
// export, compare, --html) accept this instead of the full AuditDb, so a write call is a
// compile-time error, not a runtime SQLITE_READONLY surprise. In-process discipline, not a
// security boundary; a cast that bypasses it is a programming bug.
export interface AuditDbReader {
  read(sql: string): Statement;
  readTransaction<T>(fn: () => T): T;
  getRun(runId: string): RunRecord | null;
  latestReportableRun(): RunRecord | null;
  hasCompletionMarker(packageName: string, version: string): boolean;
  close(): void;
}

export class AuditDb {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  // Read-side SELECT composition for report.ts/orchestrate.ts. db.ts is the WRITE BOUNDARY
  // (timestamp validation, upsert keys, marker atomicity, GET-only cache), so the raw writable
  // Database is never exposed: this facade accepts exactly ONE read statement.
  // A SELECT/WITH prefix check alone is NOT enough — SQLite accepts CTE-prefixed DML
  // (`WITH x AS (SELECT 1) DELETE FROM runs`) — so after stripping string literals and quoted
  // identifiers, ANY write/DDL keyword anywhere rejects the statement. Our own read queries
  // never contain those words as bare tokens, so the fail-safe rejection has no false positive.
  // (The ';' rejection is likewise fail-safe: it also rejects a literal containing ';', which
  // our queries never need.) In-process discipline, not a security boundary — all callers are
  // this tool's own modules.
  read(sql: string): Statement {
    const trimmed = sql.trim();
    const stripped = trimmed
      .replace(/'(?:[^']|'')*'/g, "''") // string literals ('' = escaped quote)
      .replace(/"(?:[^"]|"")*"/g, '""') // quoted identifiers
      .replace(/`[^`]*`/g, "``") // MySQL-style identifiers SQLite also accepts
      .replace(/\[[^\]]*\]/g, "[]"); // bracket identifiers
    const hasWriteKeyword =
      /\b(insert|update|delete|replace|drop|alter|create|pragma|attach|detach|vacuum|reindex)\b/i.test(stripped);
    if (!/^(select|with)\b/i.test(trimmed) || stripped.includes(";") || hasWriteKeyword)
      fail(`read() accepts a single read-only SELECT/WITH statement, got: ${trimmed.slice(0, 80)}`);
    return this.db.query(trimmed);
  }

  // Run `fn`'s reads inside ONE deferred transaction so a multi-statement build (report,
  // export, compare) sees a single coherent snapshot even while a live audit commits between
  // its statements (WAL readers never block the writer; without this, two sequential SELECTs
  // can straddle a commit). Valid on read-only connections — a deferred BEGIN takes no write
  // lock unless something inside writes, which the readonly mode then rejects.
  readTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)() as T;
  }

  close(): void {
    this.db.close();
  }

  static open(opts: OpenDbOptions): AuditDb {
    let path = opts.sqlitePath;
    if (path !== ":memory:") {
      // §0 write containment: the SQLite file (and its -wal/-shm siblings, which live in the
      // same directory) must land under ./data or ./output. assertContained realpath-resolves.
      const roots = [resolve("./data"), resolve("./output")];
      const resolved = assertContained(path, roots);
      mkdirSync(dirname(resolved), { recursive: true });
      // Re-assert now that the parent exists: a symlink swapped in between the first check
      // and the mkdir would be followed by this second resolution and rejected.
      path = assertContained(resolved, roots);
    }
    // strict: throws on binding-count mismatches instead of silently binding NULLs.
    const db = new Database(path, { create: true, strict: true });
    // busy_timeout FIRST — it is per-connection and must protect the very next statement
    // (the WAL pragma takes a lock and would otherwise fail immediately under contention).
    // journal_mode is persistent (in the file header) but re-asserting is harmless;
    // foreign_keys is per-connection too. All three run OUTSIDE any transaction
    // (journal_mode cannot change inside one).
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    const userVersion = readUserVersion(db);
    if (userVersion > SCHEMA_VERSION) {
      db.close();
      fail(`database schema version ${userVersion} is newer than this tool's ${SCHEMA_VERSION} — upgrade the tool`);
    }

    if (opts.fresh === true) {
      // Count what --fresh erases INSIDE the drop transaction (a count taken outside could
      // race a concurrent writer), but warn only AFTER the transaction commits — the warning
      // must describe what actually happened, not what a rolled-back transaction intended.
      // Completed runs are the operator-meaningful loss: their per-run reports
      // (report --run-id) and any future run-to-run comparison history become unrecoverable.
      let completedDropped = 0;
      db.transaction(() => {
        if (tableExists(db, "runs")) {
          const row = db.query(`SELECT COUNT(*) AS n FROM runs WHERE status='completed'`).get() as { n: number };
          completedDropped = row.n;
        }
        for (const t of FRESH_DROP_ORDER) db.exec(`DROP TABLE IF EXISTS ${t}`);
        if (opts.purgeCache === true) {
          db.exec("DROP TABLE IF EXISTS api_cache");
          db.exec("DROP TABLE IF EXISTS package_api_surface");
        }
      })();
      if (completedDropped > 0) {
        logLine({
          event: "warning",
          reason: "fresh-dropped-completed-runs",
          completedRunsDropped: completedDropped,
          message: `--fresh dropped ${completedDropped} completed run(s) — their run history (report --run-id, run-to-run comparison) is unrecoverable`,
        });
      }
    }

    const existing = AUDIT_TABLES.filter((t) => tableExists(db, t));
    if (existing.length === 0) {
      if (hasForeignTables(db)) {
        db.close();
        fail(`refusing to adopt a non-audit SQLite database (foreign tables present, no audit tables)`);
      }
      // Fresh (or fully fresh-dropped) database: create at the current version.
      db.transaction(() => {
        db.exec(SCHEMA_SQL);
        setUserVersion(db, SCHEMA_VERSION);
      })();
    } else if (userVersion < SCHEMA_VERSION) {
      // Version-stepped chain: the quarantined legacy step first (pre-v2 only), then each
      // additive step gated on its own PINNED target. Every step stamps that target in its
      // own transaction, so a crash mid-chain resumes cleanly on the next open.
      if (userVersion < LEGACY_TARGET_VERSION) migrateLegacy(db);
      if (readUserVersion(db) < V3_TARGET_VERSION) migrateV2toV3(db);
    } else {
      // Idempotent self-heal for a current-version database: recreate any missing
      // table/index AND re-apply the additive column set transactionally. Without the
      // column repair, a v3-stamped file missing is_default_branch would be a dead end —
      // openReadOnly's "run `bun run audit`" remediation must actually fix it.
      db.transaction(() => {
        db.exec(SCHEMA_SQL);
        addColumnIfMissing(db, "run_unit_head", "is_default_branch", "INTEGER");
      })();
    }
    return new AuditDb(db);
  }

  // The read-command open seam (report/export/compare/--html): {readonly:true}, busy_timeout
  // FIRST, then version + schema sanity checks — no journal_mode pragma (a write attempt on a
  // readonly connection), no DDL, no migration, no mkdir. Callers exist-check the file BEFORE
  // calling (the runReport precedent), so a missing file is their notice, not our error.
  // NOT literally zero-filesystem-effect: SQLite may still create -wal/-shm sidecars for a
  // WAL database when they are absent and the directory is writable — which is why the §0
  // path containment applies to reads too (sidecars land beside the contained db file).
  static openReadOnly(opts: { sqlitePath: string }): AuditDbReader {
    if (opts.sqlitePath === ":memory:")
      fail("openReadOnly cannot open :memory: — a fresh in-memory database has nothing to read");
    const roots = [resolve("./data"), resolve("./output")];
    const path = assertContained(opts.sqlitePath, roots);
    let db: Database;
    try {
      db = new Database(path, { readonly: true, strict: true });
    } catch (e) {
      throw mapReadOnlyOpenError(e, path);
    }
    try {
      db.exec("PRAGMA busy_timeout = 5000;"); // FIRST — protects every later lock-taking read
      const userVersion = readUserVersion(db);
      if (userVersion > SCHEMA_VERSION)
        fail(`database schema version ${userVersion} is newer than this tool's ${SCHEMA_VERSION} — upgrade the tool`);
      if (userVersion < SCHEMA_VERSION)
        fail(
          `database schema version ${userVersion} is older than this tool's ${SCHEMA_VERSION} — ` +
            "run `bun run audit` once to migrate it, then retry",
        );
      // Schema sanity up front: a partial/foreign v3-stamped file must fail HERE with an
      // actionable message, not later with a raw "no such table" mid-query.
      for (const t of AUDIT_TABLES) {
        if (!tableExists(db, t))
          fail(`database is missing the ${t} table — run \`bun run audit\` once to repair it, then retry`);
      }
      if (!columnExists(db, "run_unit_head", "is_default_branch"))
        fail("database is missing the v3 is_default_branch column — run `bun run audit` once to migrate, then retry");
    } catch (e) {
      db.close();
      throw e instanceof DbError ? e : mapReadOnlyOpenError(e, path);
    }
    return new AuditDb(db);
  }

  // ---- run lifecycle (§3 resumability rules) ------------------------------------------------
  // Startup rule: fail every running run under a DIFFERENT config_hash; resume the most
  // recent same-hash running run (tie-break run_id DESC), failing older ones; else create a
  // new run persisting the full §7 config echo. Then self-heal in_progress work units.
  startRun(input: RunInput): StartRunResult {
    const now = nowIso();
    const tx = this.db.transaction((): StartRunResult => {
      this.db
        .query(`UPDATE runs SET status='failed' WHERE status='running' AND config_hash <> ?`)
        .run(input.configHash);
      const running = this.db
        .query(
          `SELECT run_id FROM runs WHERE status='running' AND config_hash = ?
           ORDER BY started_at DESC, run_id DESC`,
        )
        .all(input.configHash) as Array<{ run_id: string }>;

      let result: StartRunResult;
      if (running.length > 0) {
        const resumedId = running[0]!.run_id;
        this.db
          .query(`UPDATE runs SET status='failed' WHERE status='running' AND config_hash = ? AND run_id <> ?`)
          .run(input.configHash, resumedId);
        // Discovery re-runs every invocation (§1) — refresh the resumed run's owner snapshot.
        // tracked_packages/cutoff_date/github_host are hash-covered, so they are identical.
        this.db
          .query(`UPDATE runs SET effective_owners = ?, owners_source = ? WHERE run_id = ?`)
          .run(JSON.stringify(input.effectiveOwners), input.ownersSource, resumedId);
        result = { runId: resumedId, resumed: true };
      } else {
        const runId = randomUUID();
        this.db
          .query(
            `INSERT INTO runs (run_id, started_at, completed_at, config_hash, effective_owners,
               owners_source, tracked_packages, cutoff_date, github_host, status)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'running')`,
          )
          .run(
            runId, now, input.configHash, JSON.stringify(input.effectiveOwners),
            input.ownersSource, JSON.stringify(input.trackedPackages), input.cutoffDate,
            input.githubHost,
          );
        result = { runId, resumed: false };
      }

      // Self-healing recovery (§3): on EVERY startup reset to pending any in_progress unit of
      // the CURRENT config whose last_run_id is any run now failed (not just ones failed this
      // startup) OR is the run being resumed — heals a crash between fail-marking and reset.
      this.db
        .query(
          `UPDATE work_queue SET status='pending', updated_at = ?
           WHERE config_hash = ? AND status='in_progress'
             AND (last_run_id IN (SELECT run_id FROM runs WHERE status='failed') OR last_run_id = ?)`,
        )
        .run(now, input.configHash, result.runId);
      return result;
    });
    return tx();
  }

  completeRun(runId: string): void {
    this.db
      .query(`UPDATE runs SET status='completed', completed_at = ? WHERE run_id = ?`)
      .run(nowIso(), runId);
  }

  // completed_at stays NULL on failure — §7's generatedAt falls back to started_at.
  failRun(runId: string): void {
    this.db.query(`UPDATE runs SET status='failed' WHERE run_id = ?`).run(runId);
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.query(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as RunRow | null;
    return row === null ? null : mapRun(row);
  }

  // The default report target (§7): latest completed run with non-empty tracked_packages.
  latestReportableRun(): RunRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM runs WHERE status='completed' AND tracked_packages <> '[]'
         ORDER BY started_at DESC, run_id DESC LIMIT 1`,
      )
      .get() as RunRow | null;
    return row === null ? null : mapRun(row);
  }

  // Preflight resume echo (§2.8): row counts + the most recent run of the current config.
  // Safe to COUNT every AUDIT_TABLE: open() guarantees they all exist before returning.
  resumeInfo(configHash: string): { counts: Record<string, number>; lastRun: RunRecord | null } {
    const counts: Record<string, number> = {};
    for (const t of AUDIT_TABLES) {
      const row = this.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      counts[t] = row.n;
    }
    const last = this.db
      .query(`SELECT * FROM runs WHERE config_hash = ? ORDER BY started_at DESC, run_id DESC LIMIT 1`)
      .get(configHash) as RunRow | null;
    return { counts, lastRun: last === null ? null : mapRun(last) };
  }

  // ---- work queue -----------------------------------------------------------------------------
  // Insert-if-absent. An EXISTING row keeps its status and last_commit_sha (the skip predicate
  // compares the STORED head against the live head, §3 — overwriting it here would make every
  // unit skip-eligible); only last_run_id/updated_at refresh.
  enqueueUnit(key: WorkUnitKey, runId: string): void {
    this.db
      .query(
        `INSERT INTO work_queue (config_hash, created_run_id, last_run_id, scope, organization,
           repository, branch, last_commit_sha, last_commit_date, status, error_message, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', NULL, 'pending', NULL, ?)
         ON CONFLICT(config_hash, scope, organization, repository, branch)
         DO UPDATE SET last_run_id = excluded.last_run_id, updated_at = excluded.updated_at`,
      )
      .run(key.configHash, runId, runId, key.scope, key.organization, key.repository ?? "", key.branch ?? "", nowIso());
  }

  getUnit(key: WorkUnitKey): WorkUnit | null {
    const row = this.db
      .query(
        `SELECT * FROM work_queue
         WHERE config_hash = ? AND scope = ? AND organization = ? AND repository = ? AND branch = ?`,
      )
      .get(key.configHash, key.scope, key.organization, key.repository ?? "", key.branch ?? "") as WorkQueueRow | null;
    return row === null ? null : mapUnit(row);
  }

  listUnits(configHash: string, status?: WorkStatus): WorkUnit[] {
    const rows = (
      status === undefined
        ? this.db.query(`SELECT * FROM work_queue WHERE config_hash = ? ORDER BY id`).all(configHash)
        : this.db
            .query(`SELECT * FROM work_queue WHERE config_hash = ? AND status = ? ORDER BY id`)
            .all(configHash, status)
    ) as WorkQueueRow[];
    return rows.map(mapUnit);
  }

  // Single-statement (atomic) status transition. lastCommitSha/lastCommitDate update only when
  // provided (pass the freshly scanned head when marking done); errorMessage always overwrites
  // (null clears a stale message on recovery).
  setUnitStatus(
    key: WorkUnitKey,
    update: {
      status: WorkStatus;
      runId: string;
      lastCommitSha?: string;
      lastCommitDate?: string | null;
      errorMessage?: string | null;
    },
  ): void {
    this.db
      .query(
        `UPDATE work_queue SET
           status = ?, last_run_id = ?, updated_at = ?,
           last_commit_sha = COALESCE(?, last_commit_sha),
           last_commit_date = CASE WHEN ? THEN ? ELSE last_commit_date END,
           error_message = ?
         WHERE config_hash = ? AND scope = ? AND organization = ? AND repository = ? AND branch = ?`,
      )
      .run(
        update.status, update.runId, nowIso(),
        update.lastCommitSha ?? null,
        update.lastCommitDate === undefined ? 0 : 1, update.lastCommitDate ?? null,
        update.errorMessage ?? null,
        key.configHash, key.scope, key.organization, key.repository ?? "", key.branch ?? "",
      );
  }

  // --rescan-branch (§3): reset the matching branch-scope row of the CURRENT config_hash only.
  // Returns false when no row matched (orchestrate surfaces that to the user).
  rescanBranch(configHash: string, organization: string, repository: string, branch: string): boolean {
    const res = this.db
      .query(
        `UPDATE work_queue SET status='pending', updated_at = ?
         WHERE config_hash = ? AND scope='branch' AND organization = ? AND repository = ? AND branch = ?`,
      )
      .run(nowIso(), configHash, organization, repository, branch);
    return res.changes > 0;
  }

  // ---- findings (upserts keyed on the §3 UNIQUE constraints — never INSERT OR IGNORE) --------
  upsertDependencyFinding(f: DependencyFindingInput): void {
    this.db
      .query(
        `INSERT INTO dependency_findings (run_id, organization, repository, branch, commit_sha,
           date_fetched, package_name, dependency_key, dependency_type, manifest_path,
           manifest_line, manifest_permalink, declared_version, lockfile_path, lockfile_kind,
           lockfile_lines, lockfile_permalink, resolved_version, resolved_version_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization, repository, branch, commit_sha, package_name, dependency_key, dependency_type, manifest_path)
         DO UPDATE SET run_id = excluded.run_id, date_fetched = excluded.date_fetched,
           manifest_line = excluded.manifest_line, manifest_permalink = excluded.manifest_permalink,
           declared_version = excluded.declared_version, lockfile_path = excluded.lockfile_path,
           lockfile_kind = excluded.lockfile_kind, lockfile_lines = excluded.lockfile_lines,
           lockfile_permalink = excluded.lockfile_permalink, resolved_version = excluded.resolved_version,
           resolved_version_source = excluded.resolved_version_source`,
      )
      .run(
        f.runId, f.organization, f.repository, f.branch, f.commitSha,
        assertCanonicalTimestamp(f.dateFetched, "dependency_findings.date_fetched"),
        f.packageName, f.dependencyKey, f.dependencyType, f.manifestPath, f.manifestLine,
        f.manifestPermalink, f.declaredVersion, f.lockfilePath ?? null, f.lockfileKind ?? null,
        f.lockfileLines === undefined || f.lockfileLines === null ? null : JSON.stringify(f.lockfileLines),
        f.lockfilePermalink ?? null, f.resolvedVersion ?? null, f.resolvedVersionSource ?? null,
      );
  }

  // §5.E range-resolution write-back: for a repo that committed NO lockfile, the orchestrator
  // resolves the declared range against the packument (max-satisfying) and records that concrete
  // version on the dependency finding so the report can attribute a per-repo version. GUARDED by
  // `resolved_version IS NULL` so it NEVER clobbers a lockfile-resolved row (whose resolution is
  // authoritative). Returns true when a row was updated.
  setRangeResolvedVersion(key: RangeResolveKey, version: string): boolean {
    const res = this.db
      .query(
        `UPDATE dependency_findings
           SET resolved_version = ?, resolved_version_source = 'range-resolved'
         WHERE organization = ? AND repository = ? AND branch = ? AND commit_sha = ?
           AND package_name = ? AND dependency_key = ? AND dependency_type = ? AND manifest_path = ?
           AND resolved_version IS NULL AND resolved_version_source IS NULL
           AND lockfile_path IS NULL`,
      )
      .run(
        version, key.organization, key.repository, key.branch, key.commitSha,
        key.packageName, key.dependencyKey, key.dependencyType, key.manifestPath,
      );
    return res.changes > 0;
  }

  upsertUsageFinding(f: UsageFindingInput): void {
    this.db
      .query(
        `INSERT INTO usage_findings (run_id, organization, repository, branch, commit_sha,
           package_name, dependency_key, usage_type, export_name, context, file_path,
           line_number, permalink, snippet, found_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization, repository, branch, commit_sha, package_name, dependency_key, usage_type, file_path, line_number, export_name, context)
         DO UPDATE SET run_id = excluded.run_id, permalink = excluded.permalink,
           snippet = excluded.snippet, found_at = excluded.found_at`,
      )
      .run(
        f.runId, f.organization, f.repository, f.branch, f.commitSha, f.packageName,
        f.dependencyKey ?? "", f.usageType, f.exportName ?? "", f.context ?? "",
        f.filePath, f.lineNumber, f.permalink, f.snippet,
        assertCanonicalTimestamp(f.foundAt, "usage_findings.found_at"),
      );
  }

  // Plain INSERT by design: errors is an append-only per-run log (a registry-version failure
  // is RE-emitted every run its version stays in the slice, §5.E) — never dedupe/upsert it.
  insertError(e: ErrorInput): void {
    this.db
      .query(
        `INSERT INTO errors (run_id, scope, organization, repository, branch, package_name,
           version, message, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.runId, e.scope, e.organization ?? null, e.repository ?? null, e.branch ?? null,
        e.packageName ?? null, e.version ?? null, e.message,
        e.occurredAt === undefined ? nowIso() : assertCanonicalTimestamp(e.occurredAt, "errors.occurred_at"),
      );
  }

  // Per-run immutable snapshot row (§3 report-head invariant). Upserted both when a unit is
  // scanned and when it is skipped-as-current (same head), or skipped-cutoff (commit_sha='').
  // is_default_branch maps true/false/null → 1/0/NULL (tri-state; NULL = unknown, §5.B).
  upsertRunUnitHead(h: RunUnitHeadInput): void {
    this.db
      .query(
        `INSERT INTO run_unit_head (run_id, organization, repository, branch, commit_sha, status, is_default_branch)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, organization, repository, branch)
         DO UPDATE SET commit_sha = excluded.commit_sha, status = excluded.status,
           is_default_branch = excluded.is_default_branch`,
      )
      .run(
        h.runId, h.organization, h.repository, h.branch, h.commitSha, h.status,
        h.isDefaultBranch === null ? null : h.isDefaultBranch ? 1 : 0,
      );
  }

  // ---- api_cache (§3 caching rules; REST-GET only — GraphQL is never cached) -----------------
  getApiCache(method: string, url: string, variantHash: string): ApiCacheEntry | null {
    const row = this.db
      .query(`SELECT * FROM api_cache WHERE method = ? AND url = ? AND variant_hash = ?`)
      .get(method, url, variantHash) as ApiCacheRow | null;
    if (row === null) return null;
    return {
      method: row.method,
      url: row.url,
      variantHash: row.variant_hash,
      etag: row.etag,
      responseBody: row.response_body,
      cachedAt: row.cached_at,
    };
  }

  putApiCache(entry: { method: string; url: string; variantHash: string; etag: string | null; responseBody: string | null }): void {
    // §3: api_cache is REST-GET only — GraphQL is never cached (the skip predicate needs the
    // LIVE head). The method column exists for schema defensiveness, not for non-GET writes.
    if (entry.method !== "GET") fail(`api_cache is REST-GET only; refusing to cache method ${entry.method}`);
    this.db
      .query(
        `INSERT INTO api_cache (method, url, variant_hash, etag, response_body, cached_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(method, url, variant_hash)
         DO UPDATE SET etag = excluded.etag, response_body = excluded.response_body,
           cached_at = excluded.cached_at`,
      )
      .run(entry.method, entry.url, entry.variantHash, entry.etag, entry.responseBody, nowIso());
  }

  // ---- package_api_surface (§5.E durable introspection) ---------------------------------------
  // The per-version COMPLETION MARKER row (export_name='', export_kind='__complete__') is the
  // durable success record; it is written LAST in the SAME transaction as the export/bin rows,
  // so a partial/crashed introspection leaves NO marker and is re-attempted. The write REPLACES
  // the version's whole row set: a marker-less partial introspection may have left rows that
  // are no longer in the new surface, and upserting over them would orphan stale exports.
  // §7 EPOCH: a marker counts ONLY when its stored surface epoch (in `source`) equals the current
  // SURFACE_SCHEMA_VERSION — a stale-epoch marker (an OLD resolver's, or a pre-epoch bare
  // '__complete__') is treated as ABSENT, so this version is re-inspected under the current logic.
  hasCompletionMarker(packageName: string, version: string): boolean {
    return (
      this.db
        .query(
          `SELECT 1 AS x FROM package_api_surface
           WHERE package_name = ? AND version = ? AND export_name = '' AND export_kind = ? AND source = ?`,
        )
        .get(packageName, version, COMPLETION_KIND, markerSource(SURFACE_SCHEMA_VERSION)) !== null
    );
  }

  writeApiSurface(input: ApiSurfaceInput): void {
    for (const r of input.rows) {
      if ((r.exportKind as string) === COMPLETION_KIND)
        fail(`writeApiSurface rows must not contain the '${COMPLETION_KIND}' marker — db.ts appends it`);
    }
    const now = nowIso();
    const insert = this.db.query(
      `INSERT INTO package_api_surface (package_name, version, version_source, export_name,
         export_kind, source, introspected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(package_name, version, export_name, export_kind)
       DO UPDATE SET version_source = excluded.version_source, source = excluded.source,
         introspected_at = excluded.introspected_at`,
    );
    this.db.transaction(() => {
      // REPLACE the version's whole row set (drops any stale-epoch / marker-less partial rows) …
      this.db
        .query(`DELETE FROM package_api_surface WHERE package_name = ? AND version = ?`)
        .run(input.packageName, input.version);
      for (const r of input.rows)
        insert.run(input.packageName, input.version, input.versionSource, r.exportName, r.exportKind, r.source, now);
      // … then stamp the marker LAST with the CURRENT surface epoch in `source` (§7).
      insert.run(input.packageName, input.version, input.versionSource, "", COMPLETION_KIND, markerSource(SURFACE_SCHEMA_VERSION), now);
    })();
  }
}

// ---- row mapping ------------------------------------------------------------------------------
interface RunRow {
  run_id: string; started_at: string; completed_at: string | null; config_hash: string;
  effective_owners: string; owners_source: OwnersSource; tracked_packages: string;
  cutoff_date: string; github_host: string; status: RunStatus;
}
interface WorkQueueRow {
  id: number; config_hash: string; created_run_id: string; last_run_id: string;
  scope: WorkScope; organization: string; repository: string; branch: string;
  last_commit_sha: string; last_commit_date: string | null; status: WorkStatus;
  error_message: string | null; updated_at: string;
}
interface ApiCacheRow {
  method: string; url: string; variant_hash: string; etag: string | null;
  response_body: string | null; cached_at: string;
}

function parseJsonArray(text: string, ctx: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(`${ctx} is not valid JSON: ${text}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string"))
    fail(`${ctx} is not a JSON string array: ${text}`);
  return parsed as string[];
}

function mapRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    configHash: row.config_hash,
    effectiveOwners: parseJsonArray(row.effective_owners, "runs.effective_owners"),
    ownersSource: row.owners_source,
    trackedPackages: parseJsonArray(row.tracked_packages, "runs.tracked_packages"),
    cutoffDate: row.cutoff_date,
    githubHost: row.github_host,
    status: row.status,
  };
}

function mapUnit(row: WorkQueueRow): WorkUnit {
  return {
    id: row.id,
    configHash: row.config_hash,
    createdRunId: row.created_run_id,
    lastRunId: row.last_run_id,
    scope: row.scope,
    organization: row.organization,
    repository: row.repository,
    branch: row.branch,
    lastCommitSha: row.last_commit_sha,
    lastCommitDate: row.last_commit_date,
    status: row.status,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
  };
}
