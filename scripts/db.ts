// db.ts — SQLite durability layer (§3): open/migrate the audit database, run lifecycle,
// work-queue state, and prepared-statement upserts for every finding/cache/surface table.
// SQLite is the source of truth. Tool-generated timestamps (found_at/date_fetched/occurred_at) are
// persisted in ONE canonical fixed-width ISO-8601 UTC form (nowIso), so lexicographic ordering equals
// chronological ordering (§3/§7). Commit-INSTANT columns (work_queue.last_commit_date,
// run_unit_head.scanned_commit_date) instead hold what their producers supply — in production, GitHub
// committedDate / git-%cI instants (second-precision, offset preserved) verbatim, NOT the nowIso
// form — and runs.cutoff_date holds the operator-CONFIGURED bare YYYY-MM-DD cutoff (validated at
// config load; legacy-migrated rows carry ''). None of these participate in the nowIso MAX/ordering
// invariant (see assertCanonicalTimestamp).
// Single-writer: orchestrate.ts owns all writes; report.ts reads via the exposed handle.

import { Database, type Statement } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertContained } from "./readOnlyGuard.ts";
import { logLine } from "./log.ts";
import { isIsoInstant } from "./isoDate.ts";
import { PolicyMatchError, denyPatternMatchesBranch } from "./branchPolicy.ts"; // leaf import: write-time attribution coherence

export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbError";
  }
}
function fail(msg: string): never {
  throw new DbError(msg);
}

// Compile-time exhaustiveness backstop for a switch over a closed union. The `never` parameter IS the
// mechanism: the call typechecks only while every member is handled upstream, so ADDING one turns this
// call site into a build error instead of a silent no-op. The throw is only the runtime half —
// structurally unreachable — and is a plain Error rather than fail()/DbError because reaching it is a
// TOOL BUG with no operator remediation to offer (the artifactWrite.ts precedent: internal lifecycle
// violations keep their stacks; operator conditions get the registered error classes).
function assertNever(x: never, what: string): never {
  throw new Error(`internal: unhandled ${what}: ${JSON.stringify(x)}`);
}

// Bump when the schema changes; older on-disk versions run the §3 VERSION-STEPPED migration
// chain — each step is one transaction that stamps its own target version, so a crash between
// steps leaves a valid intermediate database that the next open resumes from.
export const SCHEMA_VERSION = 4;
// Every migration step stamps its own PINNED target version — never the mutable
// SCHEMA_VERSION. (If a step stamped SCHEMA_VERSION, bumping the constant would make a crash
// between two steps leave an intermediate-SHAPED database stamped at the new version, and every
// later open would skip the missing migration.)
// migrateV2toV3's target.
const V3_TARGET_VERSION = 3;
// migrateV3toV4's target (branch allow/deny: run_unit_head gains policy_status/policy_matched_pattern/
// scanned_commit_date and a WIDENED status CHECK). Unlike v2→v3 (additive), the CHECK widen needs a
// TABLE REBUILD, and the migration classifies the on-disk shape first to reject an incompatible v4
// (e.g. a sibling branch that also stamped 4 with a different run_unit_head) rather than adopting it.
const V4_TARGET_VERSION = 4;

// §0 OWNERSHIP PROOF. The OLDEST version this tool has ever stamped: db.ts shipped at
// SCHEMA_VERSION = 2 in its first commit and has stamped >= 2 ever since. `PRAGMA user_version`
// is TRANSACTIONAL, so a crash during the create/migrate transaction rolls the stamp back
// together with the DDL — there is no torn "audit tables present, user_version 0" state of ours.
// Therefore a NON-EMPTY database reading back < 2 was never produced by this tool, while a
// foreign SQLite file defaults to exactly 0. That asymmetry is what assertOwnedDatabase rests on.
// (Consequence: there is no pre-v2 migration. A database stamped below this is REFUSED, not
// adopted and rebuilt — see assertOwnedDatabase.)
const MIN_OWNED_VERSION = 2;

// §5.E SURFACE-CACHE EPOCH. Bumped when the introspection LOGIC changes (resolver correctness, parse
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

// §3: tool-GENERATED timestamps (found_at/date_fetched/occurred_at) use ONE canonical fixed-width
// ISO-8601 UTC form so that lexicographic ordering equals chronological ordering (§7 relies on MAX
// over these). db.ts is the write boundary, so caller-supplied tool timestamps are validated here.
// (Commit-instant columns are the GitHub committedDate / git-%cI family and are stored AS
// WRITTEN — never normalized to this canonical form, and NOT part of this ordering invariant.
// scanned_commit_date is nonetheless VALIDATED at the upsert chokepoint (isIsoInstant: a real
// ISO instant, judged on its components as written, offset preserved); work_queue.last_commit_date
// and runs.cutoff_date (the configured bare YYYY-MM-DD) remain raw and unvalidated in this module
// — their producers validate them upstream (github.ts discovery/clone capture; config.ts).)
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
// The DISJOINT disposition partition (§3). 'policy-excluded' is its OWN status rather than an
// overloaded 'skipped-cutoff': a branch dropped by branch allow/deny was not skipped by the cutoff,
// and the durable vocabulary must name the event the live JSONL stream already calls 'skip-policy'.
// The default-branch OVERRIDE is deliberately NOT a member — that branch IS scanned and carries only
// a counterfactual policy_status (see policyDisposition.ts::isDefaultOverride).
export type UnitHeadStatus = "scanned" | "skipped-cutoff" | "policy-excluded" | "past-cap";
// The ORTHOGONAL, counterfactual policy decision for a branch (branch allow/deny). Computed for
// EVERY discovered branch, including the default (whose scan is never blocked). NULL policy_status
// (the third state) means "no exclusion" and is represented as `null`, not a member here.
export type PolicyStatus = "excluded-by-deny" | "excluded-by-allow";
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
  commitSha: string; // '' for every NON-scanned disposition (skipped-cutoff / past-cap / policy-excluded)
  status: UnitHeadStatus;
  // Tri-state, REQUIRED (not optional — `undefined` must never silently become "not default"):
  // true/false when discovery knew the repo's default branch, null = unknown. Pre-v3 rows are
  // NULL by migration backfill; the report renders NULL as its own designed state, never as 0.
  isDefaultBranch: boolean | null;
  // Branch allow/deny (v4). ALL THREE are REQUIRED, not optional — same rationale as
  // isDefaultBranch: `undefined` must never silently become "no policy" / "no date". The upsert
  // ALWAYS overwrites these (never COALESCE), so a re-upsert in a later same-run attempt clears
  // stale values in every direction. Invariants enforced by assertRunUnitHeadInvariants.
  policyStatus: PolicyStatus | null; // null = no exclusion (the branch is policy-eligible)
  policyMatchedPattern: string | null; // non-empty ONLY when policyStatus === 'excluded-by-deny'
  // The commit date (GitHub committedDate / git-%cI family — an ISO instant, offset preserved,
  // stored RAW, NOT the nowIso millisecond form). scanned → the ACTUALLY-scanned commit's date (the clone HEAD's
  // own date under the clone fallback); non-scanned → the discovered head date. REQUIRED non-null:
  // every fresh upsert has a real date (the DB column stays nullable only for pre-v4 migrated rows,
  // which the migration writes directly, never through this input). A runtime guard rejects ''/null.
  scannedCommitDate: string;
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

// The run_unit_head column + constraint body (v4). Extracted so the v3→v4 REBUILD's scratch table
// and SCHEMA_SQL share ONE definition — they cannot drift, and the post-migration fingerprint would
// catch it if they did. Column ORDER here is load-bearing: the shape classifier compares the exact
// ordered column set (see classifyRunUnitHead).
const RUN_UNIT_HEAD_BODY = `
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  organization TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scanned'
    CHECK (status IN ('scanned','skipped-cutoff','policy-excluded','past-cap')),
  is_default_branch INTEGER,
  policy_status TEXT
    CHECK (policy_status IS NULL OR policy_status IN ('excluded-by-deny','excluded-by-allow')),
  policy_matched_pattern TEXT,
  scanned_commit_date TEXT,
  CHECK (policy_status <> 'excluded-by-deny' OR policy_matched_pattern IS NOT NULL),
  -- The status ↔ policy_status agreement, enforced in SQL so no writer (or a future one) can store a
  -- contradiction the read surfaces would have to guess about: a 'policy-excluded' row names WHICH
  -- rule dropped it, and a cutoff/cap row carries no policy verdict at all (policy runs BEFORE
  -- cutoff/cap, so those dispositions are only ever reached by policy-eligible branches). 'scanned'
  -- is unconstrained here — it is null for the ordinary case and non-null for the default-branch
  -- override's counterfactual, a distinction assertRunUnitHeadInvariants pins to the known default.
  CHECK (status <> 'policy-excluded' OR policy_status IS NOT NULL),
  CHECK (status NOT IN ('skipped-cutoff','past-cap') OR policy_status IS NULL),
  PRIMARY KEY (run_id, organization, repository, branch)
`;

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
CREATE TABLE IF NOT EXISTS run_unit_head (${RUN_UNIT_HEAD_BODY});
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

// ---- low-level helpers ----------------------------------------------------------------------
function readUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

// application_id is SQLite's designated FILE-TYPE marker (the header field `file(1)` reads).
// This tool NEVER writes it, and every database it ever produced therefore reads 0 — so a
// NONZERO id is affirmative proof another application claimed the file, trumping every
// structural signal (even a perfect schema clone) and even emptiness (an application can stamp
// its header before running any DDL). The converse is deliberately NOT relied on: 0 proves
// nothing, most applications never set it. (Stamping our own id on verified opens — which
// would let a FUTURE version refuse a 0-id clone — is recorded as possible follow-up
// hardening; requiring it today would refuse every existing legitimate database.)
function readApplicationId(db: Database): number {
  const row = db.query("PRAGMA application_id").get() as { application_id: number };
  return row.application_id;
}

// PRAGMA statements cannot bind parameters — interpolate a validated non-negative integer.
function setUserVersion(db: Database, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) fail(`invalid schema version ${v}`);
  db.exec(`PRAGMA user_version = ${v}`);
}

// SQLite resolves table/column identifiers CASE-INSENSITIVELY, so these catalog checks must too:
// a table physically named `RUN_UNIT_HEAD` still answers to `run_unit_head` in DROP/SELECT, and a
// case-sensitive miss here would let a case-variant object bypass the compatibility gate and then be
// dropped by `--fresh`.
function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ? COLLATE NOCASE").get(name) !== null;
}

// SQLite reserves the LITERAL prefix `sqlite_` for its internal objects (sqlite_sequence,
// sqlite_autoindex_*). In LIKE, `_` is a single-character WILDCARD — an unescaped
// `NOT LIKE 'sqlite_%'` also swallows legal user names like `sqliteXevil`, hiding a foreign
// object from the ownership checks. ESCAPE makes the underscore literal.
const NOT_SQLITE_INTERNAL = `name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`;

// Any object proving another application owns this file. Tables, views and triggers only:
// an INDEX cannot exist without its table (and SQLite makes its own sqlite_autoindex_* for every
// PK/UNIQUE), so the tables already answer the question — counting indexes would only reject our
// own file over a stray operator index. Views and triggers are ALWAYS foreign: this tool creates
// neither, and a trigger would execute writes of someone else's choosing during a migration.
// An audit NAME only counts as ours when it is genuinely a TABLE — a view named `runs` looks
// familiar to a name-only check while `CREATE TABLE runs` would then fail against it.
function hasForeignObjects(db: Database): boolean {
  const rows = db
    .query(`SELECT type, name FROM sqlite_master WHERE type IN ('table','view','trigger') AND ${NOT_SQLITE_INTERNAL}`)
    .all() as Array<{ type: string; name: string }>;
  return rows.some((r) => r.type !== "table" || !AUDIT_TABLE_SET.has(r.name));
}

// Reference column shapes for the ownership check: what each audit table looks like under a
// given stamped schema version, read from a throwaway :memory: build of SCHEMA_SQL (never
// hardcoded — a future migration changes this automatically). table_xinfo, not table_info: it
// also lists hidden and generated columns, so a foreign table cannot alias an audit shape through
// columns table_info omits. Built once per version, lazily, and cached for the process.
//
// run_unit_head is the exception to "derive by ALTERing the current build": its v4 body carries a
// TABLE-LEVEL CHECK referencing policy_status/policy_matched_pattern, and SQLite refuses to DROP a
// column a table-level CHECK mentions (verified by probe: DROP policy_status / DROP
// policy_matched_pattern both fail on the v4 table) — nor could any ALTER un-widen the status
// CHECK. So the v3 reference REBUILDS run_unit_head from a FROZEN literal of the historical v3
// body. Freezing it is sound where hardcoding the CURRENT shape is not: a stamped-v3 file's shape
// is history and can never change again (the v2 shape is then v3 minus is_default_branch, which IS
// derivable — no CHECK references that column).
const RUN_UNIT_HEAD_V3_BODY = `
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  organization TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scanned'
    CHECK (status IN ('scanned','skipped-cutoff')),
  is_default_branch INTEGER,
  PRIMARY KEY (run_id, organization, repository, branch)
`;
const referenceShapesByVersion = new Map<number, Map<string, string>>();
// Returns a COPY (never the memoized instance): referenceShapesByVersion is the ownership oracle
// hasOwnedTableSet reads, and this is exported for tests — handing out the live Map would let a caller
// mutate the oracle for the rest of the process. ReadonlyMap so read-only intent is also compiler-checked.
export function tableShapesAt(version: number): ReadonlyMap<string, string> {
  const cached = referenceShapesByVersion.get(version);
  if (cached !== undefined) return new Map(cached);
  const ref = new Database(":memory:", { strict: true });
  try {
    ref.exec(SCHEMA_SQL); // the CURRENT (v4) schema
    if (version < V4_TARGET_VERSION) {
      ref.exec("DROP TABLE run_unit_head");
      ref.exec(`CREATE TABLE run_unit_head (${RUN_UNIT_HEAD_V3_BODY});`);
      if (version < V3_TARGET_VERSION) ref.exec("ALTER TABLE run_unit_head DROP COLUMN is_default_branch");
    }
    const shapes = new Map(AUDIT_TABLES.map((t) => [t, tableShape(ref, t)]));
    referenceShapesByVersion.set(version, shapes);
    return new Map(shapes);
  } finally {
    ref.close();
  }
}
// Canonical shape string: the FULL table_xinfo row per column (name, type, NOT NULL, default,
// PK position, hidden/generated kind), sorted by name so ALTER-appended columns compare equal to
// inline-created ones, plus rowid-ness and STRICT-ness from table_list — matching NAMES alone
// would admit a foreign table whose columns merely share ours' names (all-INTEGER types, no
// constraints, or a WITHOUT ROWID clone). Constraint semantics table_xinfo cannot see count
// too, from STRUCTURED pragmas: FOREIGN KEY clauses (foreign_key_list), PK/UNIQUE index
// structure (index_list origin 'pk'/'u' + index_xinfo — origin 'c' is excluded, so a stray
// operator CREATE INDEX stays tolerated), and AUTOINCREMENT (the one bit with no pragma,
// probed as a token in the comment-stripped stored CREATE text) — without these, a foreign
// table matching every column tuple but missing our FK/UNIQUE/AUTOINCREMENT semantics would
// compare equal. Index/FK signatures deliberately drop declaration-order artifacts (autoindex
// numbering, the fk id itself) while KEEPING per-constraint grouping and in-constraint column
// order, sorted across constraints. CHECK constraint bodies and the pragma-invisible tokens
// (collations, STRICT, ON CONFLICT, FK deferrability, FK MATCH) ALSO count now — they join the
// fingerprint below via extractChecks + sqlHasBareToken over the stored CREATE text, so a sibling
// differing only in a CHECK body or one of those clauses no longer compares equal. The residual
// false-positive is now only a table matching columns, constraint structure, CHECK multiset AND
// token-freedom exactly (an exact clone). (PRAGMA cannot bind — `table` is validated against
// AUDIT_TABLE_SET, same contract as columnExists. Index names come from index_list's own
// output over those fixed audit table names, and an autoindex name embeds its table's name —
// so the names reaching index_xinfo contain no quote characters; they are interpolated with
// proper SQL identifier escaping ("" doubling) anyway, as defense in depth.)
function tableShape(db: Database, table: string): string {
  if (!AUDIT_TABLE_SET.has(table)) fail(`tableShape called for unknown table ${table}`);
  const cols = db.query(`PRAGMA table_xinfo(${table})`).all() as Array<{
    name: string; type: string | null; notnull: number; dflt_value: string | null; pk: number; hidden: number;
  }>;
  const meta = db
    .query("SELECT wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?")
    .get(table) as { wr: number; strict: number } | null;
  // Each tuple is JSON-encoded BEFORE joining: JSON strings are self-delimiting, so no
  // legally-quoted identifier or DEFAULT literal containing the join characters can make two
  // different shapes serialize identically (a plain `:`/`|` join is not injective — one column
  // named `a:TEXT:1::0:0|b` would read as two). JSON also keeps NULL default distinct from ''.
  const colSig = cols
    .map((c) => JSON.stringify([c.name, (c.type ?? "").toUpperCase(), c.notnull, c.dflt_value, c.pk, c.hidden]))
    .sort();
  // Grouped PER CONSTRAINT (foreign_key_list's id), columns in seq order within each: two
  // independent single-column FKs and one composite FK over the same columns flatten to the
  // SAME (from, to) pairs — only the grouping tells them apart. The id itself is dropped after
  // grouping (a declaration-order artifact), and the groups are sorted.
  const fkRows = db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    id: number; seq: number; table: string; from: string; to: string | null; on_update: string; on_delete: string; match: string;
  }>;
  const fkGroups = new Map<number, typeof fkRows>();
  for (const r of fkRows) {
    const group = fkGroups.get(r.id);
    if (group === undefined) fkGroups.set(r.id, [r]);
    else group.push(r);
  }
  const fkSig = [...fkGroups.values()]
    .map((rows) => {
      const ordered = rows.slice().sort((a, b) => a.seq - b.seq);
      const head = ordered[0]!;
      return JSON.stringify([head.table, head.on_update, head.on_delete, head.match, ordered.map((r) => [r.from, r.to])]);
    })
    .sort();
  const idxSig = (
    db.query(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number; origin: string; partial: number }>
  )
    .filter((i) => i.origin !== "c")
    .map((i) => {
      // index_xinfo, not index_info: it also reports each key column's SORT DIRECTION and
      // COLLATION (a clone with `PRIMARY KEY(method DESC, …)` or a NOCASE key column is a
      // different index). key=0 rows are the implementation's trailing rowid/payload columns
      // — not part of the declared constraint — and are excluded.
      const idxCols = (
        db.query(`PRAGMA index_xinfo("${i.name.replaceAll('"', '""')}")`).all() as Array<{
          seqno: number; name: string | null; desc: number; coll: string; key: number;
        }>
      )
        .filter((c) => c.key === 1)
        .sort((a, b) => a.seqno - b.seqno)
        .map((c) => [c.name, c.desc, c.coll]);
      return JSON.stringify([i.origin, i.unique, i.partial, idxCols]);
    })
    .sort();
  const sqlRow = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string | null }
    | null;
  // Comments, string literals AND quoted identifiers are all stripped BEFORE the token test
  // (the same stripping discipline as read()): `/* AUTOINCREMENT */`, a CHECK body's
  // 'autoincrement' string, and a CONSTRAINT "AUTOINCREMENT" name are not the keyword — rowid
  // reuse genuinely differs. SQLite's parser rejects the BARE word as an identifier in DDL, so
  // a token that survives the stripping can only be the real AUTOINCREMENT clause. Our own DDL
  // contains no comments and no such literals, so the stripping never misreads OURS.
  const ddl = (sqlRow?.sql ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, "``")
    .replace(/\[[^\]]*\]/g, "[]");
  const autoinc = /\bautoincrement\b/i.test(ddl) ? 1 : 0;
  // CHECK bodies + the pragma-invisible tokens join the fingerprint (review-reproduced: a sibling
  // `runs` whose status CHECK also admitted 'archived' — columns OURS exactly — was ADOPTED and
  // --fresh dropped its rows; a COLLATE NOCASE column on a cache table survived every structural
  // pragma). Both sides of the ownership comparison run THIS code — era reference schemas vs the
  // disk file — so the expected CHECK multisets stay era-coupled with no hand-maintained per-table
  // constants, and the independent control test pins the reference counts plus a literal body so
  // the oracle cannot go circular. Every reference era is token-FREE (control-pinned), so plain
  // equality forces the disk side token-free too; the token list is presence-of-any, never treated
  // as sufficient identity on its own. extractChecks output is already normalizeCheck'd; sorted so
  // declaration order can never matter (SQLite cannot ALTER-add a table CHECK, but sorting costs
  // nothing and guards a future rebuild that reorders).
  const rawSql = sqlRow?.sql ?? "";
  const checks = extractChecks(rawSql).slice().sort();
  const tokens = ["collate", "strict", "conflict", "deferrable", "match"].filter((t) => sqlHasBareToken(rawSql, t));
  return JSON.stringify({ wr: meta?.wr ?? 0, strict: meta?.strict ?? 0, autoinc, cols: colSig, fks: fkSig, idx: idxSig, checks, tokens });
}

// The ownership question for a NON-EMPTY database: is every table present one of OURS, in a
// shape this tool actually leaves on disk? Set membership alone is NOT proof — the cache
// tables' names (`api_cache`, `package_api_surface`, exactly what a --fresh crash legitimately
// leaves behind) are generic enough for another application to have chosen, and a full
// eight-name clone is only more of the same; matched by NAME alone such a file was ADOPTED,
// and --fresh --purge-cache then DROPPED its tables. So every present table must carry the
// EXACT column shape (tableShape: full table_xinfo tuples + rowid/STRICT-ness) of a schema
// this tool has stamped, and the stamp itself must be one we ever wrote:
//   • below MIN_OWNED_VERSION was never ours (the transactional-stamp argument above);
//   • above SCHEMA_VERSION has no reference schema here to verify against — false, so the
//     writable-open backstop fails closed too (assertOwnedDatabase refuses that file earlier,
//     with the accurate "newer — upgrade the tool" message);
//   • a table may match the shape of ANY stamped version (2..SCHEMA_VERSION), evaluated PER
//     TABLE. BELOW the stamp: an older shape under a newer stamp is the
//     externally-damaged-but-HEALABLE state the migration/self-heal chain repairs (the pinned
//     case: a stamped run_unit_head missing later-era columns — openReadOnly's remediation for
//     it is "run `bun run audit`", which must keep working; a damaged file can even mix eras
//     per table). ABOVE the stamp: a NEWER recognized shape under an older stamp is the tool's
//     OWN crash remnant — migrateV2toV3 commits current-shape (v4) CREATEs together with stamp
//     3, so a crash before migrateV3toV4's transaction leaves a physically-v4 run_unit_head
//     under stamp 3 on disk; refusing it would brick the tool's own mid-upgrade database
//     (assertOpenCompatible and the migration's classify-first arms vet the same states
//     per-stamp downstream). The span is sound only while every accepted older shape has an
//     idempotent repair on the writable open — the "historical schema shape self-heals" test
//     executes that claim and trips on a SCHEMA_VERSION bump by design — and while every
//     accepted newer shape fast-forwards (the chain's remaining ALTERs are addColumnIfMissing
//     no-ops and the v3→v4 step PRESERVES a physically-v4 table).
// Any SUBSET of audit tables passes this predicate (a partial restore must stay repairable —
// openReadOnly documents "run `bun run audit` once to repair it", and every DDL batch here
// re-creates what is missing), SUBJECT to the downstream compatibility gates: one deliberate
// exception is run_unit_head missing while runs survives, which is OWNED by this predicate but
// rejected by the compatibility gate on both opens (see assertOpenCompatible gate b). What a
// subset can never do is carry a non-audit shape. A real database of ours matches by
// construction: creates, migrations and self-heals all run the same SCHEMA_SQL the
// references derive from. (Shape now includes CHECK bodies and the pragma-invisible tokens —
// collations, STRICT, ON CONFLICT, FK deferrability, FK MATCH — alongside FKs, PK/UNIQUE structure
// and AUTOINCREMENT; see tableShape. hasForeignObjects separately rejects every
// non-table object kind and every non-audit table name, so what remains adoptable is exactly:
// audit-named tables in owned shapes under an owned stamp.)
function hasOwnedTableSet(db: Database): boolean {
  const present = (
    db.query(`SELECT name FROM sqlite_master WHERE type='table' AND ${NOT_SQLITE_INTERNAL}`).all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (present.length === 0) return false; // zero tables is the empty branch's case, never ours
  const uv = readUserVersion(db);
  if (uv < MIN_OWNED_VERSION || uv > SCHEMA_VERSION) return false;
  const eras: Array<ReadonlyMap<string, string>> = [];
  for (let v = MIN_OWNED_VERSION; v <= SCHEMA_VERSION; v++) eras.push(tableShapesAt(v));
  return present.every((t) => {
    if (!AUDIT_TABLE_SET.has(t)) return false;
    const shape = tableShape(db, t);
    return eras.some((era) => era.get(t) === shape);
  });
}

// The ownedness test the writable open re-runs as its BACKSTOP: empty (a just-created file has
// no owner to protect — this arm keeps fresh creation alive), or foreign-free with an
// owned-shaped table set. The version bounds and the shape proof live INSIDE hasOwnedTableSet,
// so this stays in lockstep with assertOwnedDatabase by construction — the backstop must never
// be the weaker gate (a full name-clone at user_version 0 once passed here while the preflight
// refused it). Exported for direct unit tests — the backstop's live trigger is a checkpoint
// RACE between the preflight and the writable open, impractical to fabricate deterministically
// in a test fixture (the same rationale as mapReadOnlyOpenError's export).
export function isOwnedOrEmpty(db: Database): boolean {
  // Affirmative foreign provenance first — it trumps both arms (see readApplicationId).
  if (readApplicationId(db) !== 0) return false;
  const isEmpty = db.query(`SELECT 1 AS x FROM sqlite_master WHERE ${NOT_SQLITE_INTERNAL} LIMIT 1`).get() === null;
  // The empty arm carries the same version ceiling as the preflight (which checks the stamp
  // BEFORE its empty arm): an object-free shell stamped beyond SCHEMA_VERSION belongs to a
  // future tool, not to "anyone may create here". Live, the writable open's own version gate
  // fires before this backstop — the ceiling keeps the exported predicate itself honest.
  if (isEmpty) return readUserVersion(db) <= SCHEMA_VERSION;
  return !hasForeignObjects(db) && hasOwnedTableSet(db);
}

// PRAGMA table_info cannot bind either; `table` is always one of AUDIT_TABLES (enforced).
function columnExists(db: Database, table: string, column: string): boolean {
  if (!AUDIT_TABLE_SET.has(table)) fail(`columnExists called for unknown table ${table}`);
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const target = column.toLowerCase();
  return rows.some((r) => r.name.toLowerCase() === target); // column names resolve case-insensitively
}

function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  if (!columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

// Translate the SQLite failure modes a READ-ONLY open can hit into actionable operator errors.
// Classified by result code (never message text). SQLITE_READONLY_RECOVERY is matched exactly
// (a crashed writer's WAL needs WRITABLE recovery — waiting won't help; the fix is one writable
// open); the BUSY and CANTOPEN families are matched by PREFIX so extended variants
// (SQLITE_BUSY_TIMEOUT, SQLITE_BUSY_SNAPSHOT, SQLITE_CANTOPEN_*) classify with their primary
// code. The CORRUPT family and NOTADB (SQLite's "file is encrypted or is not a database")
// classify too: openReadOnly's ownership probe reads sqlite_master before any report query, so
// a damaged file surfaces HERE — as our refusal with context, not a raw "database disk image
// is malformed" mid-report. (Damage met LATER, by reader queries after a successful open, is a
// documented residual: the open-gate cannot vouch for pages it never read.) Anything else is
// rethrown verbatim. Exported for direct unit tests — the recovery/busy states are impractical
// to fabricate deterministically in a test fixture.
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
  if (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB")
    return new DbError(
      `database at ${path} is corrupted or not a SQLite database (${(e as Error).message}) — ` +
        "restore it from a backup or point `sqlitePath` at an existing audit database",
    );
  return e;
}

// ---- ownership (§0: never write to a database this tool does not own) -----------------------
// Proves the file at `path` is OURS, on a READ-ONLY handle, BEFORE any writable open. The order
// matters: `PRAGMA journal_mode = WAL` rewrites the file header and spawns -wal/-shm siblings, so
// by the time a writable connection exists we have already mutated a database we may not own. A
// misdirected `sqlitePath` — an ordinary operator typo onto another app's .db — must cost nothing.
//
// The predicate, first match wins:
//   1. No file, or a zero-byte file -> ours to create; it is also what our own interrupted
//      create leaves behind.
//   2. application_id != 0 -> REFUSE: another application's file-type stamp is affirmative
//      foreign provenance, trumping every structural signal and even emptiness (this tool
//      never writes it; every database it produced reads 0 — see readApplicationId).
//   3. user_version > SCHEMA_VERSION and nothing foreign-looking -> refuse as "newer than this
//      tool — upgrade": a future schema's shapes are unverifiable here, and the legitimate case
//      (a rolled-back tool meeting its own future database) deserves the accurate message.
//      Checked BEFORE the empty arm — a zero-OBJECT image carrying only a future stamp must not
//      be adopted-as-empty and header-converted before the writable open's version check fires.
//   4. A file with NO objects at all -> ours to create. An empty database cannot belong to
//      anyone (its journal sidecars permitting — see assertNoPendingJournal).
//   5. No foreign objects AND an owned-shaped table set (hasOwnedTableSet: stamp within
//      [MIN_OWNED_VERSION, SCHEMA_VERSION], every present table carrying a stamped schema's
//      exact column shape) -> ours. NO single conjunct is sufficient: user_version is not ours
//      exclusively (Room and GRDB use it as a migration counter), audit table NAMES are generic
//      enough to collide, and shapes without the foreign-object check would overlook extra
//      tables/views/triggers riding along.
//   6. Anything else -> REFUSE, untouched.
//
// Rejected alternatives, each disproved against a database this tool legitimately produces:
//   • "an audit-named table exists" — ONE generic table (`errors`, `work_queue`) is not proof;
//     that was the first bug, and the migration's run-scoped reset destroyed that table's rows.
//   • "a DISTINCTIVE table (`runs`) exists" / "ALL audit tables exist" — a --fresh interrupted
//     after its drop transaction legitimately leaves ONLY api_cache + package_api_surface.
//   • name-level SET membership (the full set, or the --fresh-preserved cache pair) — the
//     second bug: a set match says nothing about WHOSE tables those are, so a foreign file
//     wearing exactly those generic names was adopted and --fresh --purge-cache DROPPED its
//     tables. Only the per-table shape proof answers the ownership question.
//   • shape matching as the SOLE criterion — still rejected: extra objects must refuse the
//     file outright, and matching shapes under a stamp we never wrote is not a state of ours.
//     Shapes are one conjunct, not the predicate.
// A legitimate database we cannot PROVE is ours is refused too: the operator repoints
// `sqlitePath` at a new file and loses nothing, whereas a wrong adoption destroys a stranger's
// data. That asymmetry decides every ambiguous case here.
//
// The preflight never opens a SQLite file handle on the target at all: it reads the file's bytes
// (readFileSync) and inspects the BASE IMAGE in memory via Database.deserialize — zero filesystem
// mutation by construction. The obvious alternatives both fail: a plain `readonly:true` open of a
// WAL-mode database is NOT filesystem-read-only (SQLite creates a missing `-shm` wal-index and
// mutates an existing one to read, and fails with SQLITE_CANTOPEN on an OWN WAL database whose
// sidecars were dropped — a bare-`.db` backup); and SQLite's `immutable=1` URI needs `file:` URI
// support, which bun 1.3.x does NOT parse (it treats the URI as a literal filename, refusing every
// existing database — observed on CI). Base-image semantics means live `-wal` frames are invisible;
// that staleness is HARMLESS for our own database (never foreign, never stamped below
// MIN_OWNED_VERSION, so under-reporting cannot flip it to refused; the writable open re-reads the
// true state through the WAL and self-heals) and the zero-objects wal-guard below covers the
// foreign wal-resident case.
//
// An in-memory database cannot run WAL (no shared memory), and SQLite refuses to deserialize a
// WAL-header image outright — so the journal-mode header bytes (offsets 18/19: 2 = WAL,
// 1 = rollback) are patched on OUR PRIVATE COPY of the bytes. Pages are mode-independent; the
// patch changes no content, and the on-disk file is never touched.
function readBaseImage(path: string): Buffer {
  const bytes = readFileSync(path);
  if (bytes.length >= 20) {
    if (bytes[18] === 2) bytes[18] = 1;
    if (bytes[19] === 2) bytes[19] = 1;
  }
  return bytes;
}
// The zero-objects escape hatch is provable only when no journal could be hiding a schema: the
// base image alone is inspected, and a WAL database whose writer crashed (or is still running)
// can hold its entire committed schema in -wal frames — a foreign file in exactly that state
// would otherwise read as "empty, ours to create", and the writable open would then graft the
// audit schema into it THROUGH the recovered WAL. A non-empty rollback -journal is the same
// story for a non-WAL crashed writer.
//
// This state is also what OUR OWN live audit looks like to a SECOND invocation before the first
// auto-checkpoint (the writer holds one connection for the whole run, so early on the schema sits
// only in -wal over a zero-object base) — and a lock-free byte read cannot tell that apart from a
// crashed foreign writer. The refusal is still correct (fail-closed), but its FIRST remediation
// must be "wait and retry"; deletion comes LAST, explicitly conditioned on no audit process being
// alive — an operator who deletes a live run's database destroys that run, which is the exact
// loss this preflight exists to prevent.
function assertNoPendingJournal(path: string): void {
  for (const sidecar of [`${path}-wal`, `${path}-journal`] as const) {
    // One stat, ENOENT-tolerant — an existsSync-then-statSync pair races a concurrent process
    // removing the sidecar (e.g. another invocation finishing its checkpoint), and a vanished
    // sidecar means exactly "no frames to hide", not an error.
    let size = 0;
    try {
      size = statSync(sidecar).size;
    } catch (e) {
      if ((e as { code?: unknown }).code === "ENOENT") continue;
      throw e;
    }
    if (size > 0)
      fail(
        `refusing to write to ${path}: it has no committed schema but ${sidecar} holds ` +
          "frames the read-only ownership check cannot inspect. If another `bun run audit` may " +
          "still be running against this path, wait for it to finish and retry; if this is " +
          "another application's database, point `sqlitePath` elsewhere; only if it is a " +
          "crashed fresh audit database (no audit process alive) delete the file and its " +
          "sidecars and retry (nothing was modified)",
      );
  }
}
// Exported for direct unit tests (the isOwnedOrEmpty / mapReadOnlyOpenError / migrateV3toV4
// precedent): the rejection VENUE — preflight image vs post-open check — is unobservable through
// AuditDb.open (both reject byte-cleanly with the same message), so "this seam refuses it before
// AuditDb.open constructs its writable connection" is only pinnable by driving the function
// directly.
export function assertOwnedDatabase(path: string): void {
  if (!existsSync(path)) return; // nothing on disk — the writable open creates it
  let bytes: Buffer;
  try {
    bytes = readBaseImage(path);
  } catch (e) {
    fail(`cannot read ${path} for the ownership check (${(e as Error).message}) — refusing to open it writable unverified`);
  }
  // A 0-byte file is an empty database (SQLite treats it as one; deserialize refuses an empty
  // buffer, so it is decided here) — ours to create, unless a journal says otherwise.
  if (bytes.length === 0) {
    assertNoPendingJournal(path);
    return;
  }
  let db: Database;
  try {
    // Options overload, NOT the positional boolean: only it can also pass strict — the same
    // silent-NULL-binding protection every other handle in this file gets, on the one handle
    // that inspects potentially foreign bytes.
    db = Database.deserialize(bytes, { readonly: true, strict: true });
  } catch (e) {
    // Not a readable SQLite image (junk bytes, torn mid-write copy, corruption): fail CLOSED —
    // what cannot be inspected cannot be proven ours.
    fail(
      `refusing to write to ${path}: it is not a readable SQLite database (${(e as Error).message}) — ` +
        "point `sqlitePath` at a new or existing audit database instead (nothing was modified)",
    );
  }
  try {
    // Affirmative foreign provenance first (see readApplicationId): a NONZERO application_id
    // is another application's file-type stamp — refused before the version and empty arms
    // can say anything friendlier, and regardless of how perfect the schema looks.
    if (readApplicationId(db) !== 0)
      fail(
        `refusing to write to ${path}: it is a SQLite database this tool did not create — ` +
          "point `sqlitePath` at a new or existing audit database instead (nothing was modified)",
      );
    // Version next, even before the empty check — see predicate step 3. Only OUR OWN stamped
    // provenance (not written today) could tell a future OURS from a high-stamped name-clone;
    // both get this refusal, equally untouched, and the message keeps the legitimate case
    // actionable. Known message asymmetry, deliberately accepted: a future schema that ADDS a
    // table reads as foreign here ("did not create") while openReadOnly's unconditional
    // newer-first gate says "upgrade" — any gate admitting unknown table names would equally
    // mis-message foreign files that stamp high migration counters; both are refusals, and
    // guidance for files we cannot verify is best-effort by construction.
    const uv = readUserVersion(db);
    if (uv > SCHEMA_VERSION && !hasForeignObjects(db))
      fail(`database schema version ${uv} is newer than this tool's ${SCHEMA_VERSION} — upgrade the tool`);
    // Every object type, so an interrupted create (0 objects) is told apart from a live database.
    const isEmpty = db.query(`SELECT 1 AS x FROM sqlite_master WHERE ${NOT_SQLITE_INTERNAL} LIMIT 1`).get() === null;
    if (isEmpty) {
      assertNoPendingJournal(path);
      // A zero-(non-internal-)object image is ours to CREATE — but a stamp NEWER than this build
      // makes it incompatible regardless: refuse here, on the image, before any writable SQLite
      // handle exists (mirroring the owned arm's check below). Stamps <= SCHEMA_VERSION are
      // adopted-as-empty — creation re-stamps in its own transaction, and the tool's own crashed
      // `--fresh --purge-cache` remnant legitimately reads as empty (only internal objects
      // remain) at its retained pre-drop stamp (--fresh does not touch user_version, so that is
      // CURRENT only for a current-version input).
      const uvEmpty = readUserVersion(db);
      if (uvEmpty > SCHEMA_VERSION)
        fail(`database schema version ${uvEmpty} is newer than this tool's ${SCHEMA_VERSION} — upgrade the tool`);
      return;
    }
    // The version bounds live inside hasOwnedTableSet, shared with the writable backstop.
    if (!hasForeignObjects(db) && hasOwnedTableSet(db)) {
      // The file is provably OURS — now prove the MIGRATION can accept it, on the SAME base image
      // (still no SQLite handle on the target): a run_unit_head whose classified shape is outside
      // the stamp's allowed set (e.g. a SIBLING tool's v4 — same audit table names, so ownership
      // alone cannot tell it apart) is refused here, before the writable open's WAL pragma can
      // touch the file. (A too-new stamp was already refused before the empty arm above.)
      // Base-image staleness is harmless for the same reason as above: any committed prior state
      // of OUR OWN database classifies as compatible, and the writable open re-checks on its own
      // connection (isOwnedOrEmpty + assertOpenCompatible inside initWritableConnection; the
      // migration classifies again inside its transaction) through any recovered WAL.
      assertOpenCompatible(db, uv); // uv read above; the deserialized image is read-only, so it cannot have changed
      return;
    }
    fail(
      `refusing to write to ${path}: it is a SQLite database this tool did not create — ` +
        "point `sqlitePath` at a new or existing audit database instead (nothing was modified)",
    );
  } catch (e) {
    // Anything the image inspection throws that is not already our refusal (a corrupt page
    // surfacing mid-query, an unexpected pragma failure) is fail-CLOSED with context, never a
    // raw SQLiteError and never a misleading "run bun run audit" remediation.
    throw e instanceof DbError
      ? e
      : new DbError(`refusing to write to ${path}: the ownership check could not inspect it (${(e as Error).message})`);
  } finally {
    db.close();
  }
}

// ---- migrations (§3: version-stepped; each step ONE transaction stamping its target) --------
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

// ---- v3→v4: on-disk run_unit_head shape classification + migration (§3.1 branch allow/deny) ---
// The shape fingerprint is STRUCTURAL, not a string match: PRAGMA table_xinfo (columns + NOT NULL +
// composite PK), PRAGMA foreign_key_list (the run_id→runs FK), the ix_ruh_loc index, and the FULL
// set of CHECK constraints (paren-balanced, comment/quote-aware extraction — never a naive
// first-fragment substring match, which a crafted foreign CHECK could satisfy). This is the v4
// COLLISION DEFENSE: a sibling branch that also stamped user_version=4 with a different
// run_unit_head/runs is classified `incompatible` and rejected — never adopted, and (because the
// gate runs on a READ-ONLY preflight before any drop) never destroyed by --fresh.

interface ColSpec { readonly name: string; readonly type: string; readonly notnull: 0 | 1; readonly pk: number; readonly dflt: string | null; }
// Ordered column specs per version. pk = 1-based position in the composite PRIMARY KEY, else 0. `type`
// is validated too: e.g. an `is_default_branch TEXT` foreign column would store the bound integer as
// '1' and break the report's strict `=== 1` check.
// dflt is the DECLARED default's literal SQL text via table_xinfo (round-4: a sibling with
// commit_sha DEFAULT 'foreign-default' was structurally identical everywhere else and was ADOPTED —
// after which --fresh would have destroyed it. Defaults change what future INSERTs mean, so they are
// part of the identity.)
const RUH_V4_COLSPEC: readonly ColSpec[] = [
  { name: "run_id", type: "TEXT", notnull: 1, pk: 1, dflt: null }, { name: "organization", type: "TEXT", notnull: 1, pk: 2, dflt: null },
  { name: "repository", type: "TEXT", notnull: 1, pk: 3, dflt: null }, { name: "branch", type: "TEXT", notnull: 1, pk: 4, dflt: null },
  { name: "commit_sha", type: "TEXT", notnull: 1, pk: 0, dflt: "''" }, { name: "status", type: "TEXT", notnull: 1, pk: 0, dflt: "'scanned'" },
  { name: "is_default_branch", type: "INTEGER", notnull: 0, pk: 0, dflt: null }, { name: "policy_status", type: "TEXT", notnull: 0, pk: 0, dflt: null },
  { name: "policy_matched_pattern", type: "TEXT", notnull: 0, pk: 0, dflt: null }, { name: "scanned_commit_date", type: "TEXT", notnull: 0, pk: 0, dflt: null },
];
const RUH_V3_COLSPEC: readonly ColSpec[] = RUH_V4_COLSPEC.slice(0, 7); // through is_default_branch
const RUH_V2_COLSPEC: readonly ColSpec[] = RUH_V4_COLSPEC.slice(0, 6); // through status (pre is_default_branch)

// All pragma reads below use the table-valued pragma FUNCTIONS with a BOUND argument
// (pragma_table_xinfo(?), pragma_foreign_key_list(?), …) rather than interpolating the table name
// into `PRAGMA foo(name)`. An interpolated name is a SQL-injection vector when the name comes from
// the catalog (e.g. a maliciously named child table in the inbound-FK scan).
interface ColInfo { readonly name: string; readonly type: string; readonly notnull: number; readonly pk: number; readonly hidden: number; readonly dflt: string | null; }
// Columns via table_xinfo (NOT table_info) so GENERATED/hidden columns are visible: a foreign table
// with our 10 ordinary columns plus an extra generated column, or a generated runs.outcome, must not
// pass as ours. Names + declared types lowercased/uppercased for case-insensitive comparison.
function tableXinfo(db: Database, table: string): ColInfo[] {
  return (db.query('SELECT name, type, "notnull" AS nn, pk, hidden, dflt_value AS dflt FROM pragma_table_xinfo(?)').all(table) as Array<{
    name: string; type: string; nn: number; pk: number; hidden: number; dflt: string | null;
  }>).map((r) => ({ name: r.name.toLowerCase(), type: (r.type ?? "").toUpperCase(), notnull: r.nn, pk: r.pk, hidden: r.hidden, dflt: r.dflt }));
}
// Every column must be ORDINARY (hidden === 0) AND match the spec by name / declared type / NOT NULL
// / PK position.
function colsMatch(actual: ColInfo[], spec: readonly ColSpec[]): boolean {
  return actual.length === spec.length &&
    actual.every((a) => a.hidden === 0) &&
    spec.every((s, i) => actual[i]!.name === s.name && actual[i]!.type === s.type && actual[i]!.notnull === s.notnull && actual[i]!.pk === s.pk && actual[i]!.dflt === s.dflt);
}

// on_update/on_delete are part of the identity: an ON DELETE CASCADE sibling silently deletes child
// rows on run pruning — adopting it changes write semantics without any structural difference the
// colspec could see (round-4 class).
function foreignKeys(db: Database, table: string): Array<{ from: string; table: string; to: string; onUpdate: string; onDelete: string; match: string }> {
  return (db.query('SELECT "from" AS "from", "table" AS "table", "to" AS "to", on_update AS ou, on_delete AS od, "match" AS m FROM pragma_foreign_key_list(?)').all(table) as Array<{
    from: string; table: string; to: string | null; ou: string; od: string; m: string;
  }>).map((r) => ({ from: r.from.toLowerCase(), table: r.table.toLowerCase(), to: (r.to ?? "").toLowerCase(), onUpdate: r.ou.toUpperCase(), onDelete: r.od.toUpperCase(), match: r.m.toUpperCase() }));
}

// ix_ruh_loc's state ON run_unit_head: "ok" = OUR index (non-UNIQUE, explicitly created, over exactly
// organization/repository/branch/commit_sha); "absent" = repairable (recreate it); "wrong" = a
// different index of that name (UNIQUE, or over different columns — which would even reject legitimate
// re-scans), which is incompatible. pragma_index_list('run_unit_head') only lists indexes on that
// table, so a same-named index on a DIFFERENT table reads as absent (the migration's CREATE INDEX
// would then fail and roll back — fail-safe, not silent).
function ruhIndexState(db: Database): "ok" | "absent" | "wrong" {
  const list = db
    .query("SELECT \"unique\" AS uniq, origin, partial FROM pragma_index_list('run_unit_head') WHERE name = 'ix_ruh_loc' COLLATE NOCASE")
    .get() as { uniq: number; origin: string; partial: number } | null;
  if (list === null) {
    // Absent ON run_unit_head — but index names are schema-GLOBAL, so if an ix_ruh_loc exists on
    // ANOTHER table, `CREATE INDEX IF NOT EXISTS ix_ruh_loc` would silently NO-OP, leaving us
    // permanently without the index. That is not a repairable "absent" — it is incompatible.
    const global = db.query("SELECT 1 FROM sqlite_schema WHERE type='index' AND name = 'ix_ruh_loc' COLLATE NOCASE").get();
    return global === null ? "absent" : "wrong";
  }
  if (list.uniq !== 0 || list.origin !== "c" || list.partial !== 0) return "wrong"; // UNIQUE / auto / PARTIAL
  // Columns IN ORDER (seqno), exactly (organization, repository, branch, commit_sha) — a reversed
  // index has different query coverage.
  // index_xinfo, not index_info: names alone accepted a DESC (or re-collated) index of the right
  // columns — different scan order/comparison semantics under the same name (round-4 class).
  const c = (db.query("SELECT name, \"desc\" AS d, coll FROM pragma_index_xinfo('ix_ruh_loc') WHERE key = 1 ORDER BY seqno").all() as Array<{ name: string; d: number; coll: string | null }>);
  const namesOk = c.length === 4 && c[0]!.name.toLowerCase() === "organization" && c[1]!.name.toLowerCase() === "repository" && c[2]!.name.toLowerCase() === "branch" && c[3]!.name.toLowerCase() === "commit_sha";
  return namesOk && c.every((x) => x.d === 0 && (x.coll ?? "BINARY").toUpperCase() === "BINARY") ? "ok" : "wrong";
}

// run_unit_head must carry NO unexpected dependent objects: a trigger, or any index other than the
// PK autoindex (origin='pk') and our explicit ix_ruh_loc (origin='c'), would be SILENTLY dropped by
// the rebuild's DROP (SCHEMA_SQL only recreates ix_ruh_loc). A table-level UNIQUE constraint's
// autoindex (origin='u', NULL sql) is likewise unexpected — and would also wrongly reject legitimate
// multi-branch upserts if adopted — so it is rejected via origin, not a sql-IS-NULL filter.
function ruhHasUnexpectedDependents(db: Database): boolean {
  const trig = db.query("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name = 'run_unit_head' COLLATE NOCASE").get() as { n: number };
  if (trig.n > 0) return true;
  const idx = db.query("SELECT name, origin FROM pragma_index_list('run_unit_head')").all() as Array<{ name: string; origin: string }>;
  return idx.some((r) => !(r.origin === "pk" || (r.origin === "c" && r.name.toLowerCase() === "ix_ruh_loc")));
}

// The composite primary key columns must all use BINARY (default) collation. A NOCASE PK would
// conflate case-distinct branch/org/repo names and silently merge upserts. The PK autoindex
// (origin='pk') records each key column's collation via pragma_index_xinfo.
function ruhPkBinaryCollation(db: Database): boolean {
  const pk = db.query("SELECT name FROM pragma_index_list('run_unit_head') WHERE origin='pk'").get() as { name: string } | null;
  if (pk === null) return false; // no composite-PK autoindex — not our shape
  const cols = db.query('SELECT coll, "desc" AS d FROM pragma_index_xinfo(?) WHERE key = 1').all(pk.name) as Array<{ coll: string | null; d: number }>;
  // desc joined coll in round 5: a DESC PK member is a different scan order under the same key set.
  return cols.length === 4 && cols.every((c) => (c.coll ?? "BINARY").toUpperCase() === "BINARY" && c.d === 0);
}

// Does ANY other table declare a foreign key REFERENCING `target`? A rebuild that DROPs `target` with
// foreign_keys=ON would implicitly cascade/mutate those external rows, and foreign_key_check on the
// rebuilt table cannot detect that loss — so an inbound FK makes the rebuild unsafe (reject). The
// internal-name exemption reuses NOT_SQLITE_INTERNAL (escaped '_') rather than an inline copy: an
// unescaped 'sqlite_%' once skipped LEGAL names like `sqliteevil`, whose CASCADE child rows the
// v3→v4 DROP then silently deleted (verified by probe, 2→0, migration committed clean) — and a
// duplicated literal is exactly what let that predicate drift.
function hasInboundForeignKey(db: Database, target: string): boolean {
  const t = target.toLowerCase();
  const tables = (db.query(`SELECT name FROM sqlite_schema WHERE type='table' AND ${NOT_SQLITE_INTERNAL}`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
  return tables.some((tbl) => tbl.toLowerCase() !== t && foreignKeys(db, tbl).some((fk) => fk.table === t));
}

// If sql[i] opens a quoted token ('…' string, "…"/`…`/[…] identifier), return the index just PAST
// the closing quote (handling doubled '' / "" / `` escapes); else return i unchanged. Used to make
// the CHECK scan and normalization quote-aware — a ')' or the text "CHECK" inside a string literal
// or identifier must never be treated as SQL.
function skipQuoted(sql: string, i: number): number {
  const open = sql[i];
  if (open !== "'" && open !== '"' && open !== "`" && open !== "[") return i;
  const close = open === "[" ? "]" : open;
  let j = i + 1;
  for (; j < sql.length; j++) {
    if (sql[j] !== close) continue;
    if (open !== "[" && sql[j + 1] === close) {
      j++; // doubled escape ('' / "" / ``) — consume both, stay inside
      continue;
    }
    return j + 1; // past the closing quote
  }
  return sql.length; // unterminated — consume the rest
}

// Normalize a CHECK expression for set comparison: lowercase the UNQUOTED tokens and drop comments,
// but preserve single-quoted string LITERALS (and quoted identifiers) verbatim — their case is
// significant to SQLite's default BINARY comparison ('SCANNED' is a different value than 'scanned').
export function normalizeCheck(expr: string): string {
  let out = "";
  let i = 0;
  const n = expr.length;
  while (i < n) {
    const c = expr[i]!;
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const end = skipQuoted(expr, i);
      out += expr.slice(i, end); // verbatim (case-preserving)
      i = end;
    } else if (c === "-" && expr[i + 1] === "-") {
      while (i < n && expr[i] !== "\n") i++;
      out += " "; // comment -> a whitespace SEPARATOR (SQLite treats a comment as whitespace, so
      //             `status/* */in` must normalize to `status in`, never `statusin`)
    } else if (c === "/" && expr[i + 1] === "*") {
      i += 2;
      while (i < n && !(expr[i] === "*" && expr[i + 1] === "/")) i++;
      i += 2;
      out += " "; // comment -> whitespace separator (see above)
    } else {
      out += c.toLowerCase();
      i++;
    }
  }
  // Whitespace/punctuation-normalize. (Our expected literals contain no spaces or ( ) , so this
  // never alters them; a foreign literal that it did alter would still be a different value set.)
  return out.replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").trim();
}

// Extract EVERY top-level CHECK(...) expression from a table's stored CREATE sql. Fully quote/
// comment-aware: `CHECK (`, `)`, and quotes inside string literals or identifiers are ignored, so a
// foreign table cannot smuggle the expected CHECK text through a DEFAULT string. Returns EVERY
// normalized body, DUPLICATES PRESERVED — a Set here once collapsed a doubled CHECK into the exact
// expected set, so a foreign table whose constraint text was not ours could classify as ours.
export function extractChecks(sql: string): string[] {  // exported for direct unit tests (quote/comment-skip pins)
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      i = skipQuoted(sql, i);
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // A `check` keyword outside quotes, on a word boundary, followed by '('.
    if ((c === "c" || c === "C") && sql.slice(i, i + 5).toLowerCase() === "check" && !/\w/.test(sql[i - 1] ?? " ")) {
      // Skip whitespace AND comments between `check` and `(` — SQLite treats a comment as trivia, so
      // `CHECK/* note */(...)` is a legal constraint we must still recognize.
      let j = i + 5;
      for (;;) {
        if (j < n && /\s/.test(sql[j]!)) { j++; continue; }
        if (sql[j] === "-" && sql[j + 1] === "-") { while (j < n && sql[j] !== "\n") j++; continue; }
        if (sql[j] === "/" && sql[j + 1] === "*") { j += 2; while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j++; j += 2; continue; }
        break;
      }
      if (sql[j] === "(") {
        let depth = 1;
        let k = j + 1;
        const start = k;
        for (; k < n && depth > 0; ) {
          const cc = sql[k]!;
          if (cc === "'" || cc === '"' || cc === "`" || cc === "[") {
            k = skipQuoted(sql, k);
            continue;
          }
          if (cc === "-" && sql[k + 1] === "-") {
            while (k < n && sql[k] !== "\n") k++;
            continue;
          }
          if (cc === "/" && sql[k + 1] === "*") {
            k += 2;
            while (k < n && !(sql[k] === "*" && sql[k + 1] === "/")) k++;
            k += 2;
            continue;
          }
          if (cc === "(") depth++;
          else if (cc === ")") depth--;
          k++;
        }
        out.push(normalizeCheck(sql.slice(start, k - 1)));
        i = k;
        continue;
      }
    }
    i++;
  }
  return out;
}
// Does the CREATE sql contain a bare COLLATE token outside strings/comments/quoted identifiers?
// Same trivia-skipping walk as extractChecks, so a DEFAULT string containing the word cannot trip
// it. Our own DDL (every version) declares NO collation anywhere — the PK's BINARY is the implicit
// default — so ANY occurrence is a foreign shape. This is the only witness for a NON-PK column
// collation: table_xinfo's declared type omits COLLATE, and only the PK autoindex exposes one via
// pragma_index_xinfo — a `status TEXT COLLATE NOCASE` sibling (under which 'SCANNED' satisfies the
// lowercase CHECK) was accepted by every structural probe until this scan.
// A STRICT table changes type-affinity semantics; our DDL never declares it. (WITHOUT ROWID needs no
// scan: it drops the PK autoindex, so ruhPkBinaryCollation already rejects it as "missing".)
function hasStrictToken(sql: string): boolean { return sqlHasBareToken(sql, "strict"); }
function hasCollateToken(sql: string): boolean { return sqlHasBareToken(sql, "collate"); }
function sqlHasBareToken(sql: string, token: string): boolean {
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`" || c === "[") { i = skipQuoted(sql, i); continue; }
    if (c === "-" && sql[i + 1] === "-") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") { i += 2; while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++; i += 2; continue; }
    if (sql.slice(i, i + token.length).toLowerCase() === token && !/\w/.test(sql[i - 1] ?? " ") && !/\w/.test(sql[i + token.length] ?? " ")) return true;
    i++;
  }
  return false;
}

// Expected CHECK MULTISETS, normalized through the SAME function so our own spacing never matters.
// Arrays compared as sorted sequences, never Sets: set-equality collapsed a duplicated foreign CHECK
// into the exact expected set.
const RUH_V4_CHECKS: readonly string[] = [
  normalizeCheck("status IN ('scanned','skipped-cutoff','policy-excluded','past-cap')"),
  normalizeCheck("policy_status IS NULL OR policy_status IN ('excluded-by-deny','excluded-by-allow')"),
  normalizeCheck("policy_status <> 'excluded-by-deny' OR policy_matched_pattern IS NOT NULL"),
  normalizeCheck("status <> 'policy-excluded' OR policy_status IS NOT NULL"),
  normalizeCheck("status NOT IN ('skipped-cutoff','past-cap') OR policy_status IS NULL"),
];
const RUH_V23_CHECKS: readonly string[] = [normalizeCheck("status IN ('scanned','skipped-cutoff')")];
const checksEqual = (actual: readonly string[], expected: readonly string[]): boolean => {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.every((x, i) => x === b[i]);
};

function tableCreateSql(db: Database, table: string): string | null {
  const row = db.query("SELECT sql FROM sqlite_schema WHERE type='table' AND name = ? COLLATE NOCASE").get(table) as
    | { sql: string | null }
    | null;
  return row?.sql ?? null;
}

// The on-disk run_unit_head shape, classified for migration / read-only decisions. ONE shared
// READ-ONLY check (no writes, no sentinel inserts — works on a read-only connection) so the open
// preflight, openReadOnly, and the migration all agree.
type RuhClass =
  | { kind: "ours-v4" } //               exact v4 shape — accept
  | { kind: "ours-v4-missing-index" } // v4 shape, ix_ruh_loc absent — repairable (recreate index)
  | { kind: "exact-v3" } //             exact v3 shape — migrate via rebuild
  | { kind: "exact-v2" } //             exact v2 shape (pre is_default_branch) — migrate via v2→v3→v4
  | { kind: "absent" } //               run_unit_head does not exist (fresh, or post---fresh cache-only)
  | { kind: "incompatible"; reason: string }; // anything else — reject

function classifyRunUnitHead(db: Database): RuhClass {
  // Sibling discriminator FIRST: a runs.outcome column is a foreign v4 regardless of run_unit_head.
  // Read via table_xinfo so a GENERATED outcome column cannot evade the check.
  if (tableExists(db, "runs") && tableXinfo(db, "runs").some((c) => c.name === "outcome"))
    return {
      kind: "incompatible",
      reason: "the runs table has an 'outcome' column — a different v4 schema; use the matching tool build or a new database path",
    };
  if (!tableExists(db, "run_unit_head")) return { kind: "absent" };
  const cols = tableXinfo(db, "run_unit_head");
  const sql = tableCreateSql(db, "run_unit_head");
  const checks = sql === null ? [] : extractChecks(sql);
  const fks = foreignKeys(db, "run_unit_head");
  const fkOk = fks.length === 1 && fks[0]!.from === "run_id" && fks[0]!.table === "runs" && fks[0]!.to === "run_id" &&
    fks[0]!.onUpdate === "NO ACTION" && fks[0]!.onDelete === "NO ACTION" && fks[0]!.match === "NONE";
  // NB the pragma match leg above is NOT a witness for a declared MATCH clause — SQLite reports
  // 'NONE' even for MATCH FULL DDL (parsed, never enforced). The bare-token scan below is the
  // real defense; the pragma leg stays only for a future SQLite that surfaces the clause.
  if (!fkOk)
    return { kind: "incompatible", reason: "run_unit_head lacks the exact run_id→runs(run_id) foreign key" };
  // Unexpected triggers or extra secondary indexes would be SILENTLY dropped by the rebuild — refuse
  // any recognized shape that carries them, rather than lose them.
  if (ruhHasUnexpectedDependents(db))
    return { kind: "incompatible", reason: "run_unit_head has an unexpected trigger or secondary index (a rebuild would drop it)" };
  // The composite PK must exist and use BINARY collation (a NOCASE PK would conflate case-distinct
  // keys). ruhPkBinaryCollation covers both "no composite PK" and "present but non-BINARY".
  if (!ruhPkBinaryCollation(db))
    return { kind: "incompatible", reason: "run_unit_head's composite primary key is missing or uses a non-BINARY collation" };
  // COLLATE anywhere in the CREATE sql = foreign, on EVERY recognized shape (no version of our DDL
  // ever declared one). Ordered AFTER the PK probe so an index-level PK collation keeps its own
  // dedicated rejection (and its fixture keeps exercising that probe, not this scan).
  if (sql !== null && hasCollateToken(sql))
    return { kind: "incompatible", reason: "run_unit_head declares a COLLATE clause — our shape never does (a non-BINARY collation changes CHECK and comparison semantics)" };
  if (sql !== null && hasStrictToken(sql))
    return { kind: "incompatible", reason: "run_unit_head is declared STRICT — our shape never is (STRICT changes type-affinity semantics)" };
  // ON CONFLICT clauses (e.g. PK/NOT NULL ... ON CONFLICT REPLACE) silently turn constraint hits
  // into row replacement/mutation, and DEFERRABLE FKs defer enforcement to COMMIT — both change
  // write semantics invisibly to every structural probe (round-5, each demonstrated as adopted).
  // Our DDL never declares either token.
  if (sql !== null && sqlHasBareToken(sql, "conflict"))
    return { kind: "incompatible", reason: "run_unit_head declares an ON CONFLICT clause — our shape never does (it silently changes constraint-violation behavior)" };
  if (sql !== null && sqlHasBareToken(sql, "deferrable"))
    return { kind: "incompatible", reason: "run_unit_head declares a DEFERRABLE foreign key — our shape never does (it defers enforcement to COMMIT)" };
  // MATCH is the third pragma-invisible token: SQLite PARSES a foreign-key MATCH clause but never
  // enforces it, and foreign_key_list reports match='NONE' regardless — so the FK-tuple equality
  // above is blind to it and a MATCH FULL sibling passed every structural probe (reviewer-
  // constructed: adopted, then --fresh destroyed its rows). Our DDL never declares the token; the
  // bare-token walk cannot be tripped by the policy_matched_pattern identifier (word-boundary guard).
  if (sql !== null && sqlHasBareToken(sql, "match"))
    return { kind: "incompatible", reason: "run_unit_head declares a MATCH clause — our shape never does (SQLite parses but ignores it, so no pragma can witness it)" };
  if (colsMatch(cols, RUH_V4_COLSPEC)) {
    if (!checksEqual(checks, RUH_V4_CHECKS))
      return { kind: "incompatible", reason: "run_unit_head has the v4 columns but not the exact v4 CHECK set" };
    const idx = ruhIndexState(db);
    if (idx === "wrong")
      return { kind: "incompatible", reason: "run_unit_head has an ix_ruh_loc index with the wrong definition (UNIQUE or wrong columns)" };
    return idx === "ok" ? { kind: "ours-v4" } : { kind: "ours-v4-missing-index" };
  }
  // A recognized PREDECESSOR (v2/v3) with a wrong ix_ruh_loc would have that index SILENTLY dropped
  // by the v3→v4 rebuild — reject it (the migration recreates only OUR ix_ruh_loc). "absent" is fine
  // (the predecessor may legitimately lack it; the rebuild recreates it).
  const predIdxWrong = ruhIndexState(db) === "wrong";
  if (colsMatch(cols, RUH_V3_COLSPEC)) {
    if (!checksEqual(checks, RUH_V23_CHECKS))
      return { kind: "incompatible", reason: "run_unit_head has the v3 columns but not the exact v3 CHECK set" };
    if (predIdxWrong)
      return { kind: "incompatible", reason: "run_unit_head (v3) has an ix_ruh_loc index with the wrong definition" };
    return { kind: "exact-v3" };
  }
  if (colsMatch(cols, RUH_V2_COLSPEC)) {
    if (!checksEqual(checks, RUH_V23_CHECKS))
      return { kind: "incompatible", reason: "run_unit_head has the v2 columns but not the exact v2 CHECK set" };
    if (predIdxWrong)
      return { kind: "incompatible", reason: "run_unit_head (v2) has an ix_ruh_loc index with the wrong definition" };
    return { kind: "exact-v2" };
  }
  return { kind: "incompatible", reason: `run_unit_head has an unrecognized shape (${cols.length} columns)` };
}

// migrateV3toV4 — run_unit_head gains policy_status/policy_matched_pattern/scanned_commit_date and a
// WIDENED status CHECK. SQLite cannot ALTER a CHECK, so this REBUILDS the table (unlike the additive
// v2→v3). ONE transaction: atomic across crashes — there is NO committed interval where
// run_unit_head is absent (a crash before commit restores the v3 table+rows+index+stamp; after
// commit exposes complete v4). It classifies the on-disk shape FIRST and branches, so it never
// blindly rebuilds (which would erase a physical-v4 table's new-column data or mask an incompatible
// shape). foreign_keys stays ON: run_unit_head is a leaf child, safe to DROP (implicit child-row
// delete cannot violate the outgoing ref to runs); toggling the pragma inside a transaction is a
// no-op anyway.
// Exported for direct unit tests (the isOwnedOrEmpty / mapReadOnlyOpenError precedent): through
// AuditDb.open, every state that could make this transaction fail AFTER its destructive swap is
// now intercepted earlier (ownership preflight, live backstops, classify-first), so the
// rollback-after-swap property is only pinnable by driving the function on a raw connection.
// The shape-keyed run_unit_head heal, shared by migrateV3toV4 and the current-stamp self-heal
// (AuditDb.open's else arm). Classifies the on-disk shape and brings any RECOGNIZED
// predecessor era to the v4 body, rows riding through; the v4 forms and `absent` are no-ops
// here (the caller's SCHEMA_SQL recreates what is missing). Runs INSIDE the caller's
// transaction — a failure rolls the whole step back.
function healRunUnitHeadShape(db: Database): void {
  const cls = classifyRunUnitHead(db);
  switch (cls.kind) {
    case "ours-v4":
    case "ours-v4-missing-index":
      break; // physically v4 already (shape upgraded, stamp equal or lagged): preserve every value, no rebuild
    case "exact-v2":
      // A v2 shape reaching this step means migrateV2toV3 did not run for it — either the file
      // is stamped >= 3 with a damaged-away column (external damage; the chain itself stamps
      // atomically with its ALTER, so it never produces this) or the shape regressed after the
      // v2→v3 step. Both are the healable class the ownership span admits: heal the missing
      // column FIRST — is_default_branch backfills NULL (= unknown), never 0, exactly like the
      // real v2→v3 migration — then rebuild like any exact-v3 table (fall through).
      addColumnIfMissing(db, "run_unit_head", "is_default_branch", "INTEGER");
    // fall through — the table is now exact-v3-shaped
    case "exact-v3":
      // A DROP with foreign_keys=ON does an implicit child-row delete that would CASCADE to any
      // external table referencing run_unit_head — silently mutating rows the later
      // foreign_key_check cannot detect. Refuse to rebuild in that (unexpected) mixed shape.
      if (hasInboundForeignKey(db, "run_unit_head"))
        fail("run_unit_head has an inbound foreign key — refusing to rebuild it (a DROP would cascade to external rows)");
      // Rebuild: new v4-shaped table, copy the 7 v3 columns EXPLICITLY. New columns default NULL, and a
      // v3 row's 'scanned'/'skipped-cutoff' status stays valid AND correct under the widened v4 CHECK:
      // v3 predates branch policy, so no migrated row can be a policy exclusion mislabelled as a
      // cutoff skip — the null policy_status it inherits is the truth, not a lossy default.
      if (tableExists(db, "run_unit_head__v4_new"))
        fail("migration scratch table run_unit_head__v4_new already exists — aborting rather than clobber it");
      db.exec(`CREATE TABLE run_unit_head__v4_new (${RUN_UNIT_HEAD_BODY});`);
      db.exec(
        `INSERT INTO run_unit_head__v4_new
           (run_id, organization, repository, branch, commit_sha, status, is_default_branch)
         SELECT run_id, organization, repository, branch, commit_sha, status, is_default_branch
         FROM run_unit_head`,
      );
      db.exec("DROP TABLE run_unit_head");
      db.exec("ALTER TABLE run_unit_head__v4_new RENAME TO run_unit_head");
      break;
    case "absent":
      break; // recognized post---fresh cache-only state: the caller's SCHEMA_SQL creates run_unit_head at v4
    case "incompatible":
      // Structurally unreachable through AuditDb.open (the preflight + live compat gates reject
      // an unrecognized shape first) — kept as the transaction-internal backstop.
      fail(`run_unit_head is incompatible with this tool build (${cls.reason})`);
    default:
      // The heal is void-returning, so TS2366 can never police this switch: a 7th RuhClass era would
      // fall straight out of it, heal NOTHING, and let the caller's SCHEMA_SQL step see rows in a shape
      // it never migrated — silently, since every arm above still "handled" its own case. `cls` narrows
      // to never here ONLY while all six eras are handled, so adding one makes this the build error that
      // forces the decision (heal it, or state why it needs no heal). NB the exact-v2 arm's fall-through
      // into exact-v3 is deliberate and unaffected: this arm is reachable only past every named case.
      assertNever(cls, "run_unit_head class");
  }
}

export function migrateV3toV4(db: Database): void {
  db.transaction(() => {
    healRunUnitHeadShape(db);
    // Migration-boundary rule: every pre-v4 RUNNING run is failed —
    // inside this same transaction — so it can never be resumed under v4 semantics. A pre-v4 run's
    // scope may have left NO run_unit_head rows at all (v3 never recorded past-cap rows, and a repo
    // whose scans all errored/throttled wrote nothing): such a repo carries no NULL
    // scanned_commit_date sentinel, and if it drops from the kept estate the repo-scoped
    // reconciliation never revisits it — a RESUMED run could then report scanScope.provenance
    // 'complete' (and compare policyChurn available) while its pre-v4 scope is unknowable. Failing
    // the run makes the next invocation start a NEW all-v4 run whose provenance is genuinely
    // authoritative; the config_hash is unchanged by design, so completed work_queue units still
    // skip-as-current (estate/branch discovery reruns; content rescans do not).
    if (tableExists(db, "runs")) db.exec(`UPDATE runs SET status='failed' WHERE status='running'`);
    verifyRunUnitHeadFingerprint(db, "v3→v4 migration");
    setUserVersion(db, V4_TARGET_VERSION);
  })();
}

// The post-heal verification shared by migrateV3toV4 and the current-stamp self-heal: recreate
// any missing object (idempotent — AFTER the table-specific step so a rebuild's fresh table gets
// its index here), then fingerprint + FK integrity before the caller commits/stamps: the step
// MUST have produced OUR exact v4 shape, with no orphaned rows. Runs INSIDE the caller's
// transaction. ONE definition on purpose — the two callers' teeth must never drift apart (the
// self-heal copy previously duplicated this block verbatim).
function verifyRunUnitHeadFingerprint(db: Database, label: string): void {
  db.exec(SCHEMA_SQL);
  const after = classifyRunUnitHead(db);
  if (after.kind !== "ours-v4")
    fail(`${label} did not produce the expected run_unit_head shape (got '${after.kind}')`);
  const orphans = db.query(`PRAGMA foreign_key_check(run_unit_head)`).all();
  if (orphans.length > 0)
    fail(`${label} left ${orphans.length} orphaned run_unit_head row(s) — aborting`);
}

// Throw (fail) if the on-disk shape is INCOMPATIBLE with its stamp — a foreign/sibling database that
// must be neither adopted NOR destroyed. Runs up to TWICE per open, on states the ownership
// predicate has already accepted (so the database is empty, or foreign-object-free and stamped >=
// MIN_OWNED_VERSION — a pre-v2 non-empty file is refused as not-ours first; there is no pre-v2
// migration):
//   1. on the OWNERSHIP preflight's deserialized base image (see assertOwnedDatabase) — for a
//      NON-EMPTY owned image only (an empty image has no shapes to check and skips this call;
//      its too-new stamp is refused separately in that arm); a rejection here happens with no
//      SQLite handle ever opened on the target (only a byte read);
//   2. on the WRITABLE connection, as the live backstop, on every writable AuditDb.open that
//      reaches it — through any recovered WAL, catching an incompatible state the base image
//      could not see (see AuditDb.open); a no-op on an empty/new database (no tables yet).
// Recognizes legitimate predecessors, so a real v2/v3 database is NOT rejected: every RECOGNIZED
// era shape (exact-v2/exact-v3/ours-v4 ± the repairable missing ix_ruh_loc) is accepted at every
// owned stamp — below-stamp shapes because the writable open HEALS them shape-keyed, above-stamp
// recognized shapes because they are the tool's own crash remnants (see the in-body comment).
// What rejects here is an UNRECOGNIZED shape or a broken cross-table invariant. Both call sites
// run BEFORE the WAL pragma and BEFORE --fresh, so a DETECTED incompatibility is rejected before
// --fresh can drop anything.
function assertOpenCompatible(db: Database, userVersion: number): void {
  const reject = (why: string): never => fail(`refusing to open an incompatible database (stamped v${userVersion}): ${why}`);
  // Cross-table invariants first (they hold at every accepted stamp):
  // (a) a runs.outcome column is a foreign v4 (table_xinfo, so a GENERATED outcome is caught);
  if (tableExists(db, "runs") && tableXinfo(db, "runs").some((c) => c.name === "outcome"))
    reject("the runs table has an 'outcome' column — a different v4 schema; use the matching tool build or a new database path");
  const ruhPresent = tableExists(db, "run_unit_head");
  // (b) run_unit_head absent while runs is present is never a legitimate (atomic) post-fresh state.
  //     Deliberately NOT left to the self-heal/repair path: recreating an EMPTY provenance table
  //     under surviving runs would silently un-scope those runs' reports. openReadOnly rejects the
  //     same state as incompatible BEFORE its missing-table repair advice, so "run `bun run audit`
  //     once to repair it" is never suggested for a state the writer would refuse (no dead end).
  if (!ruhPresent && tableExists(db, "runs"))
    reject("run_unit_head is missing while the runs table is present");
  // (c) an inbound FK into run_unit_head would make a --fresh DROP (or the rebuild) cascade to
  //     external rows — reject before either can run. With ownership already proven, the FK carrier
  //     is necessarily an audit-NAMED table (any other table is a foreign object refused earlier) —
  //     a state only out-of-band edits produce, but one whose rows a rebuild's DROP would silently
  //     delete, so it is refused rather than risked.
  if (ruhPresent && hasInboundForeignKey(db, "run_unit_head"))
    reject("an external table has a foreign key into run_unit_head — a DROP would cascade to its rows");
  if (!ruhPresent) return; // absent + runs also absent -> genuine fresh / post-fresh cache-only state
  const cls = classifyRunUnitHead(db);
  if (cls.kind === "incompatible") reject(cls.reason);
  // Every RECOGNIZED era shape is accepted at every owned stamp — in BOTH stamp directions,
  // each for its own reason, mirroring hasOwnedTableSet's span:
  //   • a shape OLDER than its stamp (a v2/v3-shaped run_unit_head under stamp 3/4) is
  //     externally-damaged-but-HEALABLE: the writable open repairs it shape-keyed (the
  //     migration's exact-v2/exact-v3 arms and the current-stamp self-heal run the same
  //     rebuild), rows riding through — the "historical schema shape self-heals" test executes
  //     that claim per era, so this acceptance can never silently outrun the repair;
  //   • a RECOGNIZED shape NEWER than its stamp is the tool's OWN crash remnant: migrateV2toV3
  //     commits current-shape (v4) CREATEs together with stamp 3, so a crash before
  //     migrateV3toV4's transaction leaves a physically-v4 table under stamp 3 (earlier
  //     multi-step builds could leave the same under stamp 2). Accepting it is safe: the
  //     remaining steps' ALTERs are addColumnIfMissing no-ops, and the v3→v4 step classifies a
  //     physically-v4 table as ours-v4 (preserved, no rebuild).
  // What this gate REFUSES, at every stamp, is an UNRECOGNIZED shape (cls.kind 'incompatible',
  // rejected above: a sibling build's different v4, wrong CHECK set, foreign constraints…) — no
  // heal can be responsible for a shape the tool never produced. After that rejection every
  // remaining kind is a recognized era form (the ours-v4-missing-index form is NOT
  // chain-producible — SCHEMA_SQL creates ix_ruh_loc in the same transaction as the table — and
  // is accepted as REPAIRABLE), so the fall-through here IS the acceptance.
}

// ---- open ------------------------------------------------------------------------------------
export interface OpenDbOptions {
  sqlitePath: string;
  fresh?: boolean;
  purgeCache?: boolean;
}

// The writable connection's INIT span — per-connection PRAGMAs, the version ceiling, then the
// ownership and compatibility BACKSTOPS, under ONE failure discipline. The backstops are
// normally unreachable: assertOwnedDatabase already refused every foreign or incompatible file
// it could prove. They run the SAME ownedness + compatibility tests (isOwnedOrEmpty,
// assertOpenCompatible) on the WRITABLE connection, which reads THROUGH any recovered WAL (for
// a non-empty preflighted image this is a RE-run; empty/new/:memory: databases meet them here
// first, where they are no-ops) —
// closing what the base-image preflight cannot see: a foreign checkpoint landing between the
// preflight and this open, and — the decisive case — an incompatible state committed ONLY into
// -wal frames over a compatible base (e.g. a SIBLING build's v4 rebuild + stamp on a common v3
// file: the base classifies exact-v3, the live stamp reads 4 so the migration would never
// reclassify, and --fresh would DROP the sibling's reshaped tables). The version ceiling and
// both backstops run BEFORE the journal_mode pragma persists a delete→wal flip in the file
// header and BEFORE --fresh can drop anything — so a rejection here never converts the file;
// reaching them still costs sidecar recovery on the file and normally a checkpoint on close —
// data-preserving, and strictly better than adopting or dropping someone else's tables (the
// residual mutation class is documented at assertOwnedDatabase; it exists for exactly the
// states a lock-free byte read cannot judge).
// The discipline exists because EVERY statement in this span can throw raw (SQLITE_CORRUPT and
// friends) on a file that changed since the preflight. Same contract as assertOwnedDatabase's
// catch: close the handle (no leaked half-initialized writer), fail CLOSED, never a raw
// SQLiteError; our own DbError refusals pass through unwrapped. The wrapped message names the
// whole INIT span, not "the ownership check" — with the WAL pragma now LAST, a raw throw here
// can also be a plain filesystem problem (read-only directory, disk full) hit AFTER ownership
// was already proven, and an ownership-flavoured message would misdirect the operator. Returns
// the verified user_version so open() decides create-vs-migrate-vs-heal without re-reading.
// Exported for direct unit tests — the live trigger is the same checkpoint race that justifies
// isOwnedOrEmpty's export.
export function initWritableConnection(db: Database, path: string): number {
  try {
    // busy_timeout FIRST — it is per-connection and must protect every later lock-taking
    // statement in this span. journal_mode runs LAST, after the gates (it is what persists a
    // delete→wal conversion in the file header); foreign_keys is per-connection. All pragmas
    // run OUTSIDE any transaction (journal_mode cannot change inside one).
    db.exec("PRAGMA busy_timeout = 5000;");
    const userVersion = readUserVersion(db);
    if (userVersion > SCHEMA_VERSION)
      fail(`database schema version ${userVersion} is newer than this tool's ${SCHEMA_VERSION} — upgrade the tool`);
    if (!isOwnedOrEmpty(db))
      fail(
        `refusing to write to ${path}: it is a SQLite database this tool did not create — ` +
          "point `sqlitePath` at a new or existing audit database instead",
      );
    assertOpenCompatible(db, userVersion); // no-op on an empty/new database (no tables yet)
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    return userVersion;
  } catch (e) {
    try {
      db.close();
    } catch {
      // the refusal below is the primary error — a close failure on an already-broken
      // handle must not mask it
    }
    throw e instanceof DbError
      ? e
      : new DbError(
          `refusing to write to ${path}: the writable connection could not be verified and initialized (${(e as Error).message})`,
        );
  }
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

// Write-boundary invariants for run_unit_head (the PROMPT.md §3 row mapping). The DB CHECKs are
// necessary but NOT sufficient (e.g. the deny CHECK admits policy_matched_pattern=''); these guards
// run at the single write chokepoint (upsertRunUnitHead), so no row that violates the §3 mapping is
// ever persisted regardless of caller. All fail-fast. scanned_commit_date is REQUIRED non-null on
// every fresh upsert (the clone fallback captures the clone HEAD's own date) — only pre-v4 migrated
// rows carry NULL, and those are written directly by the migration, never through this input.
function assertRunUnitHeadInvariants(h: RunUnitHeadInput): void {
  const where = `${h.organization}/${h.repository}@${h.branch}`;
  // PRESENCE first, before any semantic rule. The input type declares these REQUIRED precisely so
  // `undefined` can never silently mean "not the default" / "no policy" — but the type is erased at
  // runtime, and the upsert's own binding would quietly launder it: `isDefaultBranch === null ? null
  // : isDefaultBranch ? 1 : 0` maps undefined to 0 (`undefined === null` is FALSE, and undefined is
  // then falsy), and an undefined policy column binds as NULL. Both are exactly the durable
  // mis-attribution the field docs promise cannot happen, so enforce it at this one chokepoint
  // instead of documenting a guarantee nothing checks. (`in` separates an omitted key from an
  // explicit undefined — both rejected, but the message says which.)
  for (const k of ["isDefaultBranch", "policyStatus", "policyMatchedPattern", "scannedCommitDate"] as const) {
    if (!(k in h)) fail(`run_unit_head ${where}: ${k} is required (key omitted) — it must never default silently`);
    if (h[k] === undefined) fail(`run_unit_head ${where}: ${k} is required, got undefined — it must never default silently`);
  }
  // RUNTIME types, mirroring the read gate (policyDisposition.ts::assertRunUnitHeadSound — keep the
  // two in lockstep): the input type is erased at runtime and the table is not STRICT, so a caller
  // bug passing a Uint8Array (or any non-string) would durably STORE a BLOB the read gate then
  // refuses forever — and a BLOB runId is worse: run-scoped reads filter WHERE run_id = ?, so the
  // row silently VANISHES from every report instead of throwing. Status/policy DOMAINS need no
  // mirror here: their SQL CHECKs reject any non-member (including BLOBs) at INSERT.
  for (const k of ["runId", "organization", "repository", "branch", "commitSha"] as const) {
    if (typeof h[k] !== "string")
      fail(`run_unit_head ${where}: ${k} must be a string at runtime (got ${typeof h[k]}) — a foreign type would be stored as a BLOB the read gate refuses`);
  }
  // (isDefaultBranch needs no mirror here: the tri-state domain check below already rejects every
  // non-true/false/null value at this chokepoint, and G2b pins it.)
  if (
    (h.policyStatus !== null && typeof h.policyStatus !== "string") ||
    (h.policyMatchedPattern !== null && typeof h.policyMatchedPattern !== "string") ||
    (h.scannedCommitDate !== null && typeof h.scannedCommitDate !== "string")
  ) {
    fail(`run_unit_head ${where}: policy/date fields must be string or null at runtime — a foreign type would be stored as a BLOB the read gate refuses`);
  }
  if (h.isDefaultBranch !== true && h.isDefaultBranch !== false && h.isDefaultBranch !== null)
    fail(`run_unit_head ${where}: is_default_branch must be true, false, or null (got ${JSON.stringify(h.isDefaultBranch)})`);
  // scanned_commit_date is REQUIRED on every fresh upsert (§4): the type enforces non-null, and this
  // also rejects '' / a JS caller that bypassed the type — an empty date would poison the durable
  // provenance and is indistinguishable from "unknown".
  //
  // Non-empty is not the contract, though: the field is specified as an ISO instant, and NULL carries a
  // load-bearing meaning of its own (a v3→v4-migrated row, the sentinel that makes a run's scan-scope
  // provenance unverifiable). A non-empty GARBAGE date would be accepted as authoritative and counted
  // as 'complete' provenance by the read surfaces (report scanScope, compare policyChurn availability).
  // The STORED value is never re-read for cutoff or selection decisions — later runs judge freshly
  // DISCOVERED head dates, where the same shared validator is what protects the live slice(0, 10)
  // cutoff comparison. The producers (github.ts discovery + the clone-date read) already validate
  // with the same isIsoInstant, so this enforces the documented semantic at the chokepoint rather than
  // trusting every caller to have done it, exactly as the presence checks above do.
  if (!h.scannedCommitDate) fail(`run_unit_head ${where}: a non-empty scanned_commit_date is required`);
  if (!isIsoInstant(h.scannedCommitDate))
    fail(`run_unit_head ${where}: scanned_commit_date must be an ISO instant (got ${JSON.stringify(h.scannedCommitDate.slice(0, 40))})`);
  // Policy pattern (PROMPT.md §3): a deny row MUST name a real, NON-EMPTY causing pattern (the deny CHECK
  // only enforces IS NOT NULL, and '' passes it). Every non-deny disposition carries NO pattern. The
  // '!' rejection MIRRORS the read gate (policyDisposition.ts::assertRunUnitHeadSound) exactly: a '!'
  // prefix is config syntax, never a stored pattern (compileBranchPolicy rejects it at load), and the
  // gate refuses it on read — so accepting it HERE would durably store a row every later
  // report/compare/default-export throws on. The chokepoint and the gate must agree, or the tool can
  // poison its own database; keep the two predicates in lockstep.
  if (h.policyStatus === "excluded-by-deny") {
    if (h.policyMatchedPattern === null || h.policyMatchedPattern.length === 0 || h.policyMatchedPattern.startsWith("!"))
      fail(`run_unit_head ${where}: excluded-by-deny requires a non-empty policy_matched_pattern without the '!' config prefix (got ${JSON.stringify(h.policyMatchedPattern)})`);
    // SEMANTIC coherence, not just shape (external consult, option A): the stored pattern must
    // actually MATCH the branch it claims to have excluded — and the scanned default-override's
    // counterfactual pattern must match the default's name the same way. Verified HERE because
    // write time is the only point where the matcher, the branch name, and the attribution
    // coexist; the read gate stays deliberately glob-free (re-evaluating history under a NEWER
    // Bun could refuse rows that were true when written — rows written before this verifier are
    // legacy-unattested, readable, never re-matched). A mismatch throws PolicyMatchError — the
    // FATAL class the run driver fails the whole run on — never DbError, which the per-unit
    // catch would downgrade to an ordinary scan error.
    if (!denyPatternMatchesBranch(h.policyMatchedPattern, h.branch))
      throw new PolicyMatchError(
        "excludeBranches",
        h.policyMatchedPattern,
        h.branch,
        new Error("stored policy_matched_pattern does not match the branch it claims to have excluded (write-time attribution incoherence)"),
      );
  } else if (h.policyMatchedPattern !== null) {
    fail(`run_unit_head ${where}: policy_matched_pattern must be null unless excluded-by-deny (policy_status=${h.policyStatus ?? "null"})`);
  }
  // status ↔ policy_status agreement (§3). The SQL CHECKs enforce the same two rules; these carry the
  // diagnosis. A 'policy-excluded' row that named no rule would be the exact state the fail-closed read
  // guard (policyDisposition.ts) cannot classify — reject it at the write chokepoint instead.
  if (h.status === "policy-excluded" && h.policyStatus === null)
    fail(`run_unit_head ${where}: a policy-excluded row requires a policy_status naming the rule that dropped it`);
  // Cutoff/cap are outcomes over the policy-ELIGIBLE set — policy is applied FIRST, so an excluded
  // branch never reaches either. Neither disposition ever carries a policy verdict.
  if ((h.status === "skipped-cutoff" || h.status === "past-cap") && h.policyStatus !== null)
    fail(`run_unit_head ${where}: ${h.status} rows must have policy_status null (policy is applied before cutoff/cap)`);
  // Default-branch override (the default is always scanned): the ONLY way a policy-excluded branch is still scanned is
  // the default-branch exemption. A scanned row bearing a policy_status MUST be the KNOWN default.
  if (h.status === "scanned" && h.policyStatus !== null && h.isDefaultBranch !== true)
    fail(`run_unit_head ${where}: a scanned row with a policy_status must be the default branch (is_default_branch=${h.isDefaultBranch ?? "null"})`);
  // commit_sha ↔ scanned (§3): only a scanned row pins a real commit; every non-scanned disposition
  // stores '' (the report/export joins on status='scanned' depend on this partition).
  if (h.status === "scanned") {
    if (h.commitSha === "") fail(`run_unit_head ${where}: a scanned row requires a non-empty commit_sha`);
  } else if (h.commitSha !== "") {
    fail(`run_unit_head ${where}: a ${h.status} row must have commit_sha='' (got ${JSON.stringify(h.commitSha)})`);
  }
  // Default is always scanned (PROMPT.md §3): classifyBranchPlan always keeps the default in the
  // eligible set, so a known-default branch is never cutoff-skipped or past-cap.
  if (h.isDefaultBranch === true && h.status !== "scanned")
    fail(`run_unit_head ${where}: the default branch is always scanned, never ${h.status}`);
  // Non-default certainty for cap/policy exclusions (§3): past-cap and policy-excluded rows are, by
  // construction, non-default branches that discovery KNEW about — so is_default_branch is a definite
  // false, never null. (A plain cutoff-skip may still be null for a pre-v3/unknown row.)
  if ((h.status === "past-cap" || h.status === "policy-excluded") && h.isDefaultBranch !== false)
    fail(`run_unit_head ${where}: past-cap / policy-excluded rows must have is_default_branch=false (got ${h.isDefaultBranch ?? "null"})`);
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
      // §0 ownership + migration compatibility: prove the file is ours AND acceptable to the
      // migration BEFORE the writable open below, whose WAL pragma would already have rewritten a
      // stranger's header. Both checks run on the same deserialized BASE IMAGE (the shape check
      // only for a non-empty image — an empty one has no shapes, and its too-new stamp is refused
      // in the same preflight) — no SQLite handle on the target (only a byte read), so a
      // rejection cannot mutate the file, its sidecars, or its journal mode.
      // (:memory: needs no proof — a fresh in-memory database is empty by construction and shares
      // nothing with the filesystem.)
      // ACCEPTED LIMITATION (documented, not fixed): a concurrent process could replace the file
      // between this preflight and the writable open below (a TOCTOU window). This tool is
      // single-user (one audit process per database), so concurrent modification of the same file
      // mid-open is outside the threat model; the isOwnedOrEmpty backstop below re-checks on the
      // writable connection, which reads through any recovered WAL.
      assertOwnedDatabase(path);
    }
    // strict: throws on binding-count mismatches instead of silently binding NULLs.
    // NOTE: `safeIntegers` is intentionally left OFF (the default). With it off, bun:sqlite returns
    // JS `number` for INTEGER columns (not bigint), which the report/export/compare row typings
    // (`… as { …: number }[]`) rely on. Turning it ON would silently mistype those and break
    // JSON.stringify / numeric sort comparators / csvCell's number branch — revisit those cast sites
    // first before ever enabling it.
    const db = new Database(path, { create: true, strict: true });
    // Version ceiling, LIVE ownership + compatibility backstops, then the WAL/foreign_keys
    // pragmas — one fail-closed discipline, in that ORDER (a rejection must fire before the
    // journal_mode pragma persists a delete→wal flip): see initWritableConnection (extracted so
    // its failure contract is directly unit-testable).
    //
    // What the preflight above guarantees before this writable open — stated NARROWLY: it runs only
    // for a non-:memory: path (an absent file skips straight to creation), inspects the file's BASE
    // IMAGE via deserialize (no SQLite handle on the target), and REFUSES — before this
    // connection's `journal_mode = WAL` pragma and before the --fresh drop — every file it can
    // prove is not ours to write. What it does NOT guarantee: the base image is a byte snapshot,
    // possibly STALE (uncheckpointed -wal frames are invisible; a NON-EMPTY sidecar over a
    // zero-object base is refused as unverifiable) — a state change landing between the preflight
    // and this open, or visible only through a recovered WAL, is caught by the live user-version
    // check and the two LIVE backstops inside initWritableConnection — isOwnedOrEmpty and
    // assertOpenCompatible, re-run on the writable connection, which reads through the recovered
    // WAL (the WAL-only sibling-v4 case is assertOpenCompatible's catch: name-level ownedness
    // passes, and live stamp 4 would skip the migration). Those gates run BEFORE journal_mode=WAL
    // and BEFORE --fresh, so a rejection by one of them never performs a delete→wal conversion;
    // states that pass them and reach v3→v4 are re-classified inside the migration transaction,
    // AFTER WAL setup and any --fresh. A recovered-WAL rejection may still rebuild/modify sidecars
    // and, on a normal last close, checkpoint the already-WAL file. Later migration-internal
    // failures (the v3→v4 scratch-table collision, the shape asserts, the post-migration shape/FK
    // fingerprints, or any SQL error) fire AFTER this point, on databases the preflight accepted
    // as compatible; WAL-converting such a database is normal operation — a SUCCESSFUL v3→v4
    // upgrade is preceded by the identical delete→wal flip — and each failing step rolls back its
    // OWN transaction only: the WAL conversion and any EARLIER committed step (--fresh) are not
    // undone.
    const userVersion = initWritableConnection(db, path);

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
      // Fresh (or fully fresh-dropped) database: create at the current version. assertOwnedDatabase
      // already established this file is ours to write — a foreign database never reaches here.
      db.transaction(() => {
        db.exec(SCHEMA_SQL);
        setUserVersion(db, SCHEMA_VERSION);
      })();
    } else if (userVersion < SCHEMA_VERSION) {
      // Version-stepped chain: each additive step gated on its own PINNED target, stamping that
      // target in its own transaction, so a crash mid-chain resumes cleanly on the next open.
      // There is no pre-v2 step: assertOwnedDatabase refuses a non-empty database stamped below
      // MIN_OWNED_VERSION rather than adopting and rebuilding it, so userVersion is >= 2 here.
      if (readUserVersion(db) < V3_TARGET_VERSION) migrateV2toV3(db);
      if (readUserVersion(db) < V4_TARGET_VERSION) migrateV3toV4(db);
    } else {
      // Current-stamp (v4) self-heal, SHAPE-keyed: the compatibility gate already rejected every
      // UNRECOGNIZED shape, but a recognized PREDECESSOR era under the current stamp (external
      // damage — e.g. a partial restore that regressed run_unit_head to its v2/v3 body) is
      // deliberately admitted as healable, per the ownership span's contract. The heal runs the
      // same rebuild the v3→v4 migration uses (rows riding through; damaged-away values honestly
      // read NULL); verifyRunUnitHeadFingerprint then recreates any missing table/index and runs
      // the SAME post-heal fingerprint + FK teeth as the migration (one definition, no drift).
      // This is a repair, NOT a version crossing — the stamp is already current, so no run is
      // failed here (the migration-boundary rule belongs to migrateV3toV4 alone).
      db.transaction(() => {
        healRunUnitHeadShape(db);
        verifyRunUnitHeadFingerprint(db, "self-heal");
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
      // safeIntegers intentionally off — see the read-write open: INTEGER columns must stay JS
      // `number` for the report/export/compare row casts.
      db = new Database(path, { readonly: true, strict: true });
    } catch (e) {
      throw mapReadOnlyOpenError(e, path);
    }
    try {
      db.exec("PRAGMA busy_timeout = 5000;"); // FIRST — protects every later lock-taking read
      const userVersion = readUserVersion(db);
      if (userVersion > SCHEMA_VERSION)
        fail(`database schema version ${userVersion} is newer than this tool's ${SCHEMA_VERSION} — upgrade the tool`);
      // Ownership parity with the write path (the preflight/backstop predicate, shared via
      // isOwnedOrEmpty): a file wearing audit table NAMES over foreign shapes must be refused
      // as NOT OURS here too — otherwise the advice below would dead-end. It runs AFTER the
      // newer gate (a future database is "upgrade the tool", never "not ours" — its shapes are
      // unverifiable here) but BEFORE the older-migrate advice AND the missing-table messages:
      // a v2-stamped foreign file told to "run `bun run audit` once to migrate it" — like a
      // v3-stamped name-clone told to "repair" — meets the audit's own refusal, and a full
      // name-clone would otherwise sail past every up-front check into the report queries and
      // fail raw mid-render. The empty-but-stamped file keeps its targeted messages
      // (isOwnedOrEmpty's empty arm), and every healable damage state still reaches its
      // specific remediation below.
      if (!isOwnedOrEmpty(db))
        fail(
          `database at ${path} is a SQLite database this tool did not create — ` +
            "point `sqlitePath` at an existing audit database",
        );
      if (userVersion < SCHEMA_VERSION)
        fail(
          `database schema version ${userVersion} is older than this tool's ${SCHEMA_VERSION} — ` +
            "run `bun run audit` once to migrate it, then retry",
        );
      // Schema sanity up front: an INCOMPATIBLE database — a sibling/foreign run_unit_head shape,
      // the known runs.outcome sibling marker, an inbound FK into run_unit_head, or run_unit_head
      // missing beside runs — or one missing an audit table must fail HERE with an actionable
      // message, not later with a raw "no such table"/"no such column" mid-query. Ownership was
      // already re-proven above (isOwnedOrEmpty — shape-level, and since the whole-DB identity work
      // its tableShape fingerprints CHECK bodies + the five tokens too, so most foreign/sibling files
      // are refused there as "did not create"); THIS discriminator is now defense-in-depth for the
      // run_unit_head shape plus the cross-table invariants it alone owns (the runs.outcome sibling
      // marker, an inbound FK into run_unit_head, run_unit_head missing beside runs).
      // openReadOnly cannot migrate, so it DISTINGUISHES an INCOMPATIBLE database (a
      // different-build v4 — use the matching build or a new db path) from a merely
      // under-repaired one (run `bun run audit` once). The stamp is == SCHEMA_VERSION here (both
      // < and > are rejected above); a PRESENT run_unit_head in a RECOGNIZED predecessor era is
      // the healable class (repair advice below), while an unrecognized shape is a genuine
      // mismatch.
      // The INCOMPATIBILITY discriminator runs FIRST — a database caught by these gates must get
      // the incompatible message even when it is ALSO missing an audit table, because "run bun
      // run audit" cannot repair it (the writer open rejects the same file). Only after that does
      // the missing-table advice fire.
      const incompatible = (why: string): never =>
        fail(`database is incompatible with this tool build (${why}) — use the matching tool build or a new database path`);
      const cls = classifyRunUnitHead(db);
      if (cls.kind === "incompatible") incompatible(cls.reason);
      // The stamp is == SCHEMA_VERSION (4) here (older/newer both rejected above). Mirror the writer
      // gate's cross-table invariants BEFORE the missing-table advice — "run bun run audit" cannot
      // repair THESE (the writer open rejects the same file):
      if (!tableExists(db, "run_unit_head") && tableExists(db, "runs"))
        incompatible("run_unit_head is missing while the runs table is present");
      if (tableExists(db, "run_unit_head") && hasInboundForeignKey(db, "run_unit_head"))
        incompatible("an external table has a foreign key into run_unit_head"); // consistent with the writer gate
      // A RECOGNIZED predecessor era under the current stamp is the healable-damage class the
      // ownership span admits — the WRITER repairs it (shape-keyed self-heal), so the read path
      // advises the repair rather than declaring the file incompatible (openReadOnly itself
      // cannot migrate or heal).
      if (tableExists(db, "run_unit_head") && (cls.kind === "exact-v3" || cls.kind === "exact-v2"))
        fail("database run_unit_head is missing the v4 policy columns — run `bun run audit` once to repair it, then retry");
      for (const t of AUDIT_TABLES) {
        if (!tableExists(db, t))
          fail(`database is missing the ${t} table — run \`bun run audit\` once to repair it, then retry`);
      }
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
  // `resolved_version IS NULL AND resolved_version_source IS NULL AND lockfile_path IS NULL`: the
  // first two ensure it NEVER clobbers a lockfile-resolved row (whose resolution is authoritative);
  // `lockfile_path IS NULL` is independently load-bearing — a dependency with a GOVERNING lockfile
  // that left it unresolved (e.g. an uninstalled peer) has resolved_version NULL, but its absence
  // from that lockfile is the finding, so it must NOT be guessed from the range. Returns true when
  // a row was updated.
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

  // Per-run immutable snapshot row (§3 report-head invariant). Upserted for a discovered branch in
  // each disposition: scanned, skip-as-current (same head, scanned), cutoff-skipped, past-cap, and
  // policy-excluded (commit_sha='' for every non-scanned disposition). NOTE: a scanned row is written
  // only when its scan SUCCEEDS this invocation — a throttled/errored scan writes no row (so the set of
  // rows written is NOT every discovered branch; reconcileRunUnitHead therefore keys on the live-name
  // set, not on rows-written). is_default_branch maps true/false/null → 1/0/NULL (tri-state; NULL =
  // unknown, §5.B). The ON CONFLICT ALWAYS overwrites all six mutable columns from `excluded` (never
  // COALESCE) so a re-upsert in a later same-run attempt clears stale policy/date/status in every
  // direction (§6 transition matrix).
  upsertRunUnitHead(h: RunUnitHeadInput): void {
    assertRunUnitHeadInvariants(h); // fail-closed at the single write chokepoint (§3 row mapping)
    this.db
      .query(
        `INSERT INTO run_unit_head
           (run_id, organization, repository, branch, commit_sha, status, is_default_branch,
            policy_status, policy_matched_pattern, scanned_commit_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, organization, repository, branch)
         DO UPDATE SET commit_sha = excluded.commit_sha, status = excluded.status,
           is_default_branch = excluded.is_default_branch,
           policy_status = excluded.policy_status,
           policy_matched_pattern = excluded.policy_matched_pattern,
           scanned_commit_date = excluded.scanned_commit_date`,
      )
      .run(
        h.runId, h.organization, h.repository, h.branch, h.commitSha, h.status,
        h.isDefaultBranch === null ? null : h.isDefaultBranch ? 1 : 0,
        h.policyStatus, h.policyMatchedPattern, h.scannedCommitDate,
      );
  }

  // Stale-row reconciliation (schema-neutral): after a repo's branches are COMPLETELY re-discovered
  // (BranchDiscoveryOutcome ok:true, whose snapshot listBranchHeads guarantees is the exact live set), prune this
  // run's run_unit_head rows for branches no longer present — the phantom rows a resume leaves when a
  // branch is deleted between invocations. Scoped to (run_id, org, repo): it can NEVER touch another
  // run or another repo, and the sole caller (processRepo) reaches it only on successful discovery, so
  // a failed/throttled repo is retained, never pruned (a transient failure must not delete a live
  // branch). `discoveredBranches` is the COMPLETE live-name keep-set (all discovered heads, every
  // disposition) — NOT merely rows rewritten this invocation, so a live branch whose scan failed this
  // attempt keeps its prior row.
  //
  // The prune is NAME-keyed BY DESIGN, so a same-name STALE HEAD is retained, not pruned: if a branch's
  // head advanced since a prior invocation and this attempt's re-scan errored or throttled, no
  // replacement row is written and the prior row — WHATEVER its disposition, pinned to the OLDER
  // evaluation — survives. The report counts the branch under that PRIOR disposition: a prior scanned
  // row reads "scanned at the old head" (commit_sha + scanned_commit_date name the commit actually
  // scanned, and its findings came from that real scan); a prior NON-scanned row (say skipped-cutoff,
  // recorded when the old head sat below the cutoff) keeps the branch in its old bucket even though the
  // advanced head became eligible — its commit_sha='' and discovered-head date describe that older
  // evaluation. This is STALE, not WRONG: every retained row is truthful about what its own invocation
  // decided, and the work_queue unit is left error/pending so the next run re-scans and refreshes it.
  // Accepted, not overlooked — see processRepo's reconciliation note for the rejected alternative.
  //
  // SCOPE, stated precisely because the surrounding docs used to over-claim it: the caller invokes this
  // ONCE PER RE-DISCOVERED REPO, so what it guarantees is "a re-discovered repo's rows match its live
  // branches" — never "the run's rows match the live estate". A repo that dropped out of this run's kept
  // set entirely (deleted, renamed, newly archived/fork-filtered, or displaced past maxReposPerOrg) never
  // reaches this call at all, so ALL of its prior rows survive untouched.
  //
  // Returns the number of rows pruned.
  reconcileRunUnitHead(runId: string, organization: string, repository: string, discoveredBranches: readonly string[]): number {
    const res = this.db
      .query(
        `DELETE FROM run_unit_head
         WHERE run_id = ? AND organization = ? AND repository = ?
           AND branch NOT IN (SELECT value FROM json_each(?))`,
      )
      .run(runId, organization, repository, JSON.stringify(discoveredBranches));
    return res.changes;
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
  // §5.E EPOCH: a marker counts ONLY when its stored surface epoch (in `source`) equals the current
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
      // … then stamp the marker LAST with the CURRENT surface epoch in `source` (§5.E).
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
