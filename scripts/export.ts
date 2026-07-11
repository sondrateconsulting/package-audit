// export.ts — deterministic, run-scoped snapshot exports of the four audit tables as CSV +
// JSONL under <outputDir>/xray/, written through the manifest-managed ArtifactBundle. Entry:
//   bun run scripts/export.ts [--config <path>] [--run-id <id>] [--raw] [--help]
// The DEFAULT export is a RUN-SCOPED SNAPSHOT: findings join through the IMMUTABLE
// run_unit_head snapshot (never findings.run_id — a later run's upsert moves that column) and
// filter to the run's tracked_packages, exactly like report.ts. `--raw` is the forensic
// escape hatch: full tables, every row verbatim. Column order and row order per table are
// pinned by the EXPORT REGISTRY below (the EXPORTS.md contract), so output is
// byte-reproducible: no wall clock, env, or locale anywhere in the emit path.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { AuditDb, type AuditDbReader, type RunRecord } from "./db.ts";
import { ArtifactBundle, XRAY_DIR_NAME } from "./artifactWrite.ts";
import { toCsv, type CsvCell } from "./csvWrite.ts";
import { parseSemver } from "./semver.ts";
import { logLine } from "./log.ts";
import { ArgsError, assertRunId } from "./args.ts";
import { renderFatal } from "./cliErrors.ts";

// ---- usage / help -----------------------------------------------------------------------------
export const EXPORT_USAGE =
  "Usage: bun run scripts/export.ts [--config <path>] [--run-id <id>] [--raw] [--help]";

export const EXPORT_HELP = `package-audit export — run-scoped CSV/JSONL snapshots of the four audit tables

${EXPORT_USAGE}

Flags:
  --config <path>     Config file to load (for sqlitePath/outputDir). Config path precedence: --config <path> > CONFIG_PATH env > ./config.json
  --run-id <id>       Export that run's snapshot instead of the default (the latest
                      completed reportable run).
  --raw               Forensic FULL-TABLE dump: every row verbatim, including completion
                      markers and rows from other runs/configs; artifacts are prefixed
                      raw-. The default run-scoped export is the supported contract.
  --help, -h          Show this help and exit.

Writes <table>.csv + <table>.jsonl for dependency_findings, package_api_surface, runs and
usage_findings into <outputDir>/xray/ through the manifest-managed artifact bundle; column
order and row order per table are pinned by the export column registry (EXPORTS.md).`;

// ---- argument parsing (local by design: args.ts stays untouched; same strict grammar) ----------
export interface ExportArgs {
  readonly configPath: string | null; // explicit --config; null → resolve via env/default in config.ts
  readonly runId: string | null; // --run-id <id>; null → latest completed reportable run
  readonly raw: boolean;
  readonly help: boolean; // --help/-h seen anywhere: print help, do nothing else
}

// Mirrors parseReportArgs exactly (help wins over invalid args; unknown flags REJECTED — a
// silently-ignored typo would fall through to the default export; `--flag=value` supported;
// a detached value that looks like a flag is a missing value). ArgsError keeps renderFatal's
// stack-free operator rendering without adding a new class to the cliErrors registry.
export function parseExportArgs(argv: string[]): ExportArgs {
  if (argv.some((a) => a === "--help" || a === "-h")) return { configPath: null, runId: null, raw: false, help: true };

  let configPath: string | null = null;
  let runId: string | null = null;
  let raw = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const attached = eq === -1 ? null : arg.slice(eq + 1);

    if (flag === "--raw") {
      if (attached !== null) throw new ArgsError("--raw takes no value");
      raw = true;
      continue;
    }
    if (flag !== "--config" && flag !== "--run-id") throw new ArgsError(`unknown argument '${arg}'`);
    const next = argv[i + 1];
    const value = attached !== null ? attached : next;
    if (value === undefined || value === "" || (attached === null && value.startsWith("-")))
      throw new ArgsError(`${flag} requires a value`);
    if (attached === null) i++;
    if (flag === "--config") {
      if (configPath !== null) throw new ArgsError("--config given more than once");
      configPath = value;
    } else {
      if (runId !== null) throw new ArgsError("--run-id given more than once");
      runId = assertRunId(value);
    }
  }
  return { configPath, runId, raw, help: false };
}

// ---- the export column registry (the EXPORTS.md contract) --------------------------------------
// Per table: the ORDERED column list (SCHEMA_SQL declaration order MINUS the AUTOINCREMENT id —
// ids are storage detail, not contract) and the total ORDER BY key chain (each chain is the
// table's UNIQUE/PRIMARY key set, so row order is fully determined). For the run_unit_head-joined
// tables the export carries the table's OWN columns only — no join columns.
export type ExportColumnType = "string" | "number" | "nullable-string" | "nullable-number";
export interface ExportColumn {
  readonly name: string;
  readonly type: ExportColumnType;
}

const DEPENDENCY_FINDINGS_COLUMNS = [
  { name: "run_id", type: "string" },
  { name: "organization", type: "string" },
  { name: "repository", type: "string" },
  { name: "branch", type: "string" },
  { name: "commit_sha", type: "string" },
  { name: "date_fetched", type: "string" },
  { name: "package_name", type: "string" },
  { name: "dependency_key", type: "string" },
  { name: "dependency_type", type: "string" },
  { name: "manifest_path", type: "string" },
  { name: "manifest_line", type: "number" },
  { name: "manifest_permalink", type: "string" },
  { name: "declared_version", type: "string" },
  { name: "lockfile_path", type: "nullable-string" },
  { name: "lockfile_kind", type: "nullable-string" },
  { name: "lockfile_lines", type: "nullable-string" },
  { name: "lockfile_permalink", type: "nullable-string" },
  { name: "resolved_version", type: "nullable-string" },
  { name: "resolved_version_source", type: "nullable-string" },
] as const satisfies readonly ExportColumn[];

const PACKAGE_API_SURFACE_COLUMNS = [
  { name: "package_name", type: "string" },
  { name: "version", type: "string" },
  { name: "version_source", type: "string" },
  { name: "export_name", type: "string" },
  { name: "export_kind", type: "string" },
  { name: "source", type: "string" },
  { name: "introspected_at", type: "string" },
] as const satisfies readonly ExportColumn[];

const RUNS_COLUMNS = [
  { name: "run_id", type: "string" },
  { name: "started_at", type: "string" },
  { name: "completed_at", type: "nullable-string" },
  { name: "config_hash", type: "string" },
  { name: "effective_owners", type: "string" },
  { name: "owners_source", type: "string" },
  { name: "tracked_packages", type: "string" },
  { name: "cutoff_date", type: "string" },
  { name: "github_host", type: "string" },
  { name: "status", type: "string" },
] as const satisfies readonly ExportColumn[];

const USAGE_FINDINGS_COLUMNS = [
  { name: "run_id", type: "string" },
  { name: "organization", type: "string" },
  { name: "repository", type: "string" },
  { name: "branch", type: "string" },
  { name: "commit_sha", type: "string" },
  { name: "package_name", type: "string" },
  { name: "dependency_key", type: "string" },
  { name: "usage_type", type: "string" },
  { name: "export_name", type: "string" },
  { name: "context", type: "string" },
  { name: "file_path", type: "string" },
  { name: "line_number", type: "number" },
  { name: "permalink", type: "string" },
  { name: "snippet", type: "string" },
  { name: "found_at", type: "string" },
] as const satisfies readonly ExportColumn[];

// ORDER BY key chains — typed against each table's own column-name union so a typo'd or
// non-exported key is a compile error, not a runtime SQL surprise.
const DEPENDENCY_FINDINGS_ORDER_BY: ReadonlyArray<(typeof DEPENDENCY_FINDINGS_COLUMNS)[number]["name"]> = [
  "organization", "repository", "branch", "commit_sha", "package_name", "dependency_key", "dependency_type", "manifest_path",
];
const PACKAGE_API_SURFACE_ORDER_BY: ReadonlyArray<(typeof PACKAGE_API_SURFACE_COLUMNS)[number]["name"]> = [
  "package_name", "version", "export_kind", "export_name",
];
const RUNS_ORDER_BY: ReadonlyArray<(typeof RUNS_COLUMNS)[number]["name"]> = ["run_id"];
const USAGE_FINDINGS_ORDER_BY: ReadonlyArray<(typeof USAGE_FINDINGS_COLUMNS)[number]["name"]> = [
  "organization", "repository", "branch", "commit_sha", "package_name", "dependency_key", "usage_type", "file_path", "line_number", "export_name", "context",
];

export const EXPORT_TABLE_NAMES = ["dependency_findings", "package_api_surface", "runs", "usage_findings"] as const;
export type ExportTableName = (typeof EXPORT_TABLE_NAMES)[number];

export interface ExportTableSpec {
  readonly columns: readonly ExportColumn[];
  readonly orderBy: readonly string[];
}

export const EXPORT_REGISTRY: Record<ExportTableName, ExportTableSpec> = {
  dependency_findings: { columns: DEPENDENCY_FINDINGS_COLUMNS, orderBy: DEPENDENCY_FINDINGS_ORDER_BY },
  package_api_surface: { columns: PACKAGE_API_SURFACE_COLUMNS, orderBy: PACKAGE_API_SURFACE_ORDER_BY },
  runs: { columns: RUNS_COLUMNS, orderBy: RUNS_ORDER_BY },
  usage_findings: { columns: USAGE_FINDINGS_COLUMNS, orderBy: USAGE_FINDINGS_ORDER_BY },
};

// ---- registry ↔ SCHEMA_SQL type sync (house precedent: reportSchema.ts's Equal<>) --------------
// The wire-row aliases below hand-transcribe db.ts's SCHEMA_SQL columns (minus id) as plain
// wire types (TEXT→string, INTEGER→number, nullable → | null). The Equal<> assertions fail
// `bun run typecheck` in BOTH drift directions: a registry column the row lacks, a row column
// the registry lacks, or a type mismatch between them. The runtime half (export.test.ts) pins
// the row aliases to the LIVE schema via PRAGMA table_info, closing the loop to SCHEMA_SQL.
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type ColumnTs<T extends ExportColumnType> =
  T extends "string" ? string : T extends "number" ? number : T extends "nullable-string" ? string | null : number | null;
type RegistryShape<Cols extends readonly ExportColumn[]> = {
  [N in Cols[number]["name"]]: ColumnTs<Extract<Cols[number], { name: N }>["type"]>;
};

// Type aliases (not interfaces) on purpose: aliases get the implicit index signature that lets
// typed rows flow into the generic Record-based renderers below.
export type DependencyFindingsExportRow = {
  run_id: string; organization: string; repository: string; branch: string; commit_sha: string;
  date_fetched: string; package_name: string; dependency_key: string; dependency_type: string;
  manifest_path: string; manifest_line: number; manifest_permalink: string; declared_version: string;
  lockfile_path: string | null; lockfile_kind: string | null; lockfile_lines: string | null;
  lockfile_permalink: string | null; resolved_version: string | null; resolved_version_source: string | null;
};
export type PackageApiSurfaceExportRow = {
  package_name: string; version: string; version_source: string; export_name: string;
  export_kind: string; source: string; introspected_at: string;
};
export type RunsExportRow = {
  run_id: string; started_at: string; completed_at: string | null; config_hash: string;
  effective_owners: string; owners_source: string; tracked_packages: string;
  cutoff_date: string; github_host: string; status: string;
};
export type UsageFindingsExportRow = {
  run_id: string; organization: string; repository: string; branch: string; commit_sha: string;
  package_name: string; dependency_key: string; usage_type: string; export_name: string;
  context: string; file_path: string; line_number: number; permalink: string; snippet: string;
  found_at: string;
};

export type DependencyFindingsRegistrySynced = Expect<Equal<RegistryShape<typeof DEPENDENCY_FINDINGS_COLUMNS>, DependencyFindingsExportRow>>;
export type PackageApiSurfaceRegistrySynced = Expect<Equal<RegistryShape<typeof PACKAGE_API_SURFACE_COLUMNS>, PackageApiSurfaceExportRow>>;
export type RunsRegistrySynced = Expect<Equal<RegistryShape<typeof RUNS_COLUMNS>, RunsExportRow>>;
export type UsageFindingsRegistrySynced = Expect<Equal<RegistryShape<typeof USAGE_FINDINGS_COLUMNS>, UsageFindingsExportRow>>;
// The spec-level guarantee stated separately: each registry's column-NAME union equals the
// row alias's keyof (the shape checks above subsume this, but the name-union contract is the
// one EXPORTS.md documents, so it gets its own assertion).
export type DependencyFindingsColumnNamesSynced = Expect<Equal<(typeof DEPENDENCY_FINDINGS_COLUMNS)[number]["name"], keyof DependencyFindingsExportRow>>;
export type PackageApiSurfaceColumnNamesSynced = Expect<Equal<(typeof PACKAGE_API_SURFACE_COLUMNS)[number]["name"], keyof PackageApiSurfaceExportRow>>;
export type RunsColumnNamesSynced = Expect<Equal<(typeof RUNS_COLUMNS)[number]["name"], keyof RunsExportRow>>;
export type UsageFindingsColumnNamesSynced = Expect<Equal<(typeof USAGE_FINDINGS_COLUMNS)[number]["name"], keyof UsageFindingsExportRow>>;

// ---- snapshot collection ------------------------------------------------------------------------
// A collected table: the registry-ordered rows, already in ORDER BY order (explicit in SQL).
type ExportRowWire = Readonly<Record<string, string | number | null>>;
interface ExportSnapshot {
  readonly table: ExportTableName;
  readonly rows: readonly ExportRowWire[];
}

const selectList = (columns: readonly ExportColumn[], alias = ""): string =>
  columns.map((c) => `${alias}${c.name}`).join(", ");
const orderByClause = (orderBy: readonly string[], alias = ""): string =>
  orderBy.map((k) => `${alias}${k}`).join(", ");

// ALL reads run inside ONE deferred read transaction so the four tables come from a single
// coherent snapshot even while a live audit commits concurrently (the report.ts precedent).
function collectSnapshots(db: AuditDbReader, run: RunRecord, raw: boolean): readonly ExportSnapshot[] {
  return db.readTransaction(() => (raw ? collectRaw(db) : collectRunScoped(db, run)));
}

// DEFAULT scope — the load-bearing decision, inherited from report.ts VERBATIM: findings join
// through run_unit_head (run_id = selected run, status='scanned', matching unit columns) and
// filter to the run's tracked_packages. NEVER filter by findings.run_id: upserts move run_id
// to the latest writer, but the head snapshot is immutable per run.
function collectRunScoped(db: AuditDbReader, run: RunRecord): ExportSnapshot[] {
  const tracked = JSON.stringify(run.trackedPackages);

  const dep = db.read(
    `SELECT ${selectList(DEPENDENCY_FINDINGS_COLUMNS, "df.")} FROM dependency_findings df
     JOIN run_unit_head ruh ON ruh.run_id = ? AND ruh.status='scanned'
       AND ruh.organization=df.organization AND ruh.repository=df.repository
       AND ruh.branch=df.branch AND ruh.commit_sha=df.commit_sha
     WHERE df.package_name IN (SELECT value FROM json_each(?))
     ORDER BY ${orderByClause(DEPENDENCY_FINDINGS_ORDER_BY, "df.")}`,
  ).all(run.runId, tracked) as DependencyFindingsExportRow[];

  const usage = db.read(
    `SELECT ${selectList(USAGE_FINDINGS_COLUMNS, "uf.")} FROM usage_findings uf
     JOIN run_unit_head ruh ON ruh.run_id = ? AND ruh.status='scanned'
       AND ruh.organization=uf.organization AND ruh.repository=uf.repository
       AND ruh.branch=uf.branch AND ruh.commit_sha=uf.commit_sha
     WHERE uf.package_name IN (SELECT value FROM json_each(?))
     ORDER BY ${orderByClause(USAGE_FINDINGS_ORDER_BY, "uf.")}`,
  ).all(run.runId, tracked) as UsageFindingsExportRow[];

  // versionsSeen per package: DISTINCT valid-semver resolved_version over the run's joined
  // dependency rows — the same derivation as report.ts buildPackage. The api-surface slice is
  // tracked packages × those versions, EXCLUDING the '__complete__' marker rows (durability
  // bookkeeping, not surface data).
  const versionsSeen = new Map<string, Set<string>>();
  for (const d of dep) {
    const v = d.resolved_version;
    if (v === null || parseSemver(v) === null) continue;
    const set = versionsSeen.get(d.package_name) ?? new Set<string>();
    set.add(v);
    versionsSeen.set(d.package_name, set);
  }
  const surface = (
    db.read(
      `SELECT ${selectList(PACKAGE_API_SURFACE_COLUMNS)} FROM package_api_surface
       WHERE package_name IN (SELECT value FROM json_each(?))
       ORDER BY ${orderByClause(PACKAGE_API_SURFACE_ORDER_BY)}`,
    ).all(tracked) as PackageApiSurfaceExportRow[]
  ).filter(
    (r) =>
      r.export_kind !== "__complete__" &&
      versionsSeen.get(r.package_name)?.has(r.version) === true &&
      // Mirror report.ts: only versions whose introspection COMPLETED (marker present) are
      // surface data — a markerless row set (legacy migration preserves rows without
      // backfilling markers) is a partial capture, not an export.
      db.hasCompletionMarker(r.package_name, r.version),
  );

  // runs export = exactly the selected run's row.
  const runs = db.read(`SELECT ${selectList(RUNS_COLUMNS)} FROM runs WHERE run_id = ?`).all(run.runId) as RunsExportRow[];

  return [
    { table: "dependency_findings", rows: dep },
    { table: "package_api_surface", rows: surface },
    { table: "runs", rows: runs },
    { table: "usage_findings", rows: usage },
  ];
}

// --raw: full-table forensic dump — every row verbatim, including '__complete__' markers and
// rows from other runs/configs. Same registry columns (ids stay excluded — storage detail
// either way) and same total ORDER BY chains, so even the raw dump is byte-reproducible.
function collectRaw(db: AuditDbReader): ExportSnapshot[] {
  return EXPORT_TABLE_NAMES.map((table) => {
    const { columns, orderBy } = EXPORT_REGISTRY[table];
    const rows = db.read(`SELECT ${selectList(columns)} FROM ${table} ORDER BY ${orderByClause(orderBy)}`).all() as ExportRowWire[];
    return { table, rows };
  });
}

// ---- rendering ----------------------------------------------------------------------------------
// A registry column missing from a fetched row is registry↔query drift — a bug, loudly, with a
// stack (the SELECT lists are generated FROM the registry, so this cannot fire in practice).
function cellOf(row: ExportRowWire, column: string): CsvCell {
  const value = row[column];
  if (value === undefined) throw new Error(`export registry drift: fetched row is missing column ${column}`);
  return value;
}

function renderCsv(columns: readonly ExportColumn[], rows: readonly ExportRowWire[]): string {
  return toCsv(
    columns.map((c) => c.name),
    rows.map((row) => columns.map((c) => cellOf(row, c.name))),
  );
}

// JSONL: one JSON object per row per line, keys inserted in REGISTRY order (JSON.stringify
// preserves insertion order). BYTE-FAITHFUL by contract: no formula-injection defense here
// (that lives in the CSV writer only), NULLs as JSON null, numbers as JSON numbers.
function renderJsonl(columns: readonly ExportColumn[], rows: readonly ExportRowWire[]): string {
  let out = "";
  for (const row of rows) {
    const ordered: Record<string, CsvCell> = {};
    for (const c of columns) ordered[c.name] = cellOf(row, c.name);
    out += JSON.stringify(ordered) + "\n";
  }
  return out;
}

// ---- emit ---------------------------------------------------------------------------------------
export const RAW_EXPORT_WARNING = {
  event: "warning",
  reason: "raw-export",
  message:
    "--raw dumps FULL tables — rows may span multiple runs/configs and include stale data; the default run-scoped export is the supported contract",
} as const;

// The export flow given an OPEN reader and a SELECTED run — the testable seam below runExport
// (report.ts's buildReport/emitReportDetailed layering). Emits one stdout JSONL event per
// artifact via logLine as it goes, writes the human summary to STDERR, and RETURNS the final
// export-summary line for main() to write — stdout stays pure JSONL throughout.
export function exportRun(db: AuditDbReader, run: RunRecord, outputDir: string, opts: { raw: boolean }): { line: string } {
  const snapshots = collectSnapshots(db, run, opts.raw);
  if (opts.raw) logLine({ ...RAW_EXPORT_WARNING });

  // ONE bundle for the whole generation; finalize({runId}) writes manifest.json LAST and
  // sweeps stale unmanifested files inside xray/ (cross-kind dossier adoption is handled
  // inside ArtifactBundle). --raw still stamps the SELECTED run's id on the manifest.
  const bundle = new ArtifactBundle(outputDir, "export");
  const prefix = opts.raw ? "raw-" : "";
  const counts: Array<{ table: ExportTableName; rows: number }> = [];
  let written = 0;
  for (const { table, rows } of snapshots) {
    const { columns } = EXPORT_REGISTRY[table];
    counts.push({ table, rows: rows.length });
    for (const format of ["csv", "jsonl"] as const) {
      const name = `${prefix}${table}.${format}`;
      const content = format === "csv" ? renderCsv(columns, rows) : renderJsonl(columns, rows);
      const record = bundle.write(name, content);
      written++;
      logLine({ event: "export", table, format, path: join(outputDir, XRAY_DIR_NAME, name), rows: rows.length, bytes: record.bytes });
    }
  }
  const result = bundle.finalize({ runId: run.runId });

  process.stderr.write(exportSummaryText(run.runId, opts.raw, counts, outputDir));
  // artifacts = what THIS export wrote (adopted other-kind manifest entries are not ours to count).
  const summary = { event: "export-summary", runId: run.runId, raw: opts.raw, artifacts: written, swept: result.swept };
  return { line: `${JSON.stringify(summary)}\n` };
}

// The "nothing to export" notice — same reasons and precedence as report.ts's
// buildNotReportableNotice (missing DB first, then run-id, then no-completed-run), under the
// export discriminant. A notice is a well-formed successful answer: stdout JSON line, exit 0.
export function buildNotExportableNotice(runIdArg: string | null, missingDbPath?: string): { notExportable: true; reason: string } {
  return {
    notExportable: true,
    reason:
      missingDbPath !== undefined
        ? `no database at ${missingDbPath} — run \`bun run audit\` first`
        : runIdArg !== null
          ? `run ${runIdArg} not found or pre-migration (empty tracked_packages)`
          : "no completed reportable run yet",
  };
}

// The export flow minus argv/config parsing — guards mirror runReport verbatim. Invariant:
// running `export` before any `audit` is a pure no-op — a missing (or :memory:) database
// short-circuits with the notExportable notice BEFORE any open, mkdir, or bundle write, so
// the filesystem is untouched. Unlike report (which persists its notice as latest.json),
// export writes notices to stdout ONLY: the xray/ bundle holds manifested artifacts, and a
// notice is not one.
export function runExport(config: Config, opts: { runId: string | null; raw: boolean }): { line: string } {
  const sqlitePath = config.paths.sqlitePath;
  if (sqlitePath === ":memory:" || !existsSync(sqlitePath)) {
    return { line: `${JSON.stringify(buildNotExportableNotice(opts.runId, sqlitePath))}\n` };
  }
  // CV5: export is a pure READ — openReadOnly never creates, migrates, or writes the database.
  const db = AuditDb.openReadOnly({ sqlitePath });
  try {
    const run = opts.runId !== null ? db.getRun(opts.runId) : db.latestReportableRun();
    if (run === null || run.trackedPackages.length === 0) {
      return { line: `${JSON.stringify(buildNotExportableNotice(opts.runId))}\n` };
    }
    return exportRun(db, run, config.paths.outputDir, { raw: opts.raw });
  } finally {
    db.close();
  }
}

// stderr-only human summary (orchestrate.ts runSummaryText style); stdout stays pure JSONL.
export function exportSummaryText(
  runId: string, raw: boolean, counts: ReadonlyArray<{ table: ExportTableName; rows: number }>, outputDir: string,
): string {
  const label = (text: string): string => `  ${text}`.padEnd(25);
  return [
    "",
    raw ? `RAW EXPORT — run ${runId} (FULL TABLES: rows may span multiple runs/configs)` : `EXPORT COMPLETE — run ${runId}`,
    ...counts.map((c) => `${label(`${c.table}:`)}${c.rows} row${c.rows === 1 ? "" : "s"}`),
    `${label("Artifacts:")}${counts.length * 2} files + manifest.json in ${join(outputDir, XRAY_DIR_NAME)}`,
    "",
  ].join("\n");
}

// ---- entry point --------------------------------------------------------------------------------
// argv is injectable (defaulting to the process argv) so tests can drive the REAL dispatch —
// help short-circuit before config/DB, runExport wiring — in-process (the report.ts idiom).
export async function main(argv: string[] = Bun.argv.slice(2)): Promise<void> {
  const eargs = parseExportArgs(argv); // strict: unknown flags / valueless --run-id are rejected
  if (eargs.help) {
    process.stdout.write(EXPORT_HELP + "\n");
    return;
  }
  const { config } = await loadConfig(argv);
  process.stdout.write(runExport(config, { runId: eargs.runId, raw: eargs.raw }).line);
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(renderFatal(e, { command: "export", usage: EXPORT_USAGE }));
    process.exit(1);
  });
}
