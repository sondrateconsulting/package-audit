// report.ts — §7 consolidated report, generated DETERMINISTICALLY from SQLite ALONE. Entry point:
//   bun run scripts/report.ts [--config <path>] [--run-id <id>]
// Default (no --run-id): the latest COMPLETED run with non-empty tracked_packages; also overwrites
// <outputDir>/latest.json. A --run-id writes ONLY <outputDir>/run-<id>.json (never latest.json).
// Findings are joined through the IMMUTABLE run_unit_head snapshot (never findings.run_id) filtered
// to runs.tracked_packages, and EVERY emitted array has a total, stable sort key so the output is
// byte-reproducible.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { AuditDb, type RunRecord } from "./db.ts";
import { assertContained } from "./readOnlyGuard.ts";
import { parseSemver, compareForReport } from "./semver.ts";
import { parseReportArgs, REPORT_HELP, REPORT_USAGE } from "./args.ts";
import { renderFatal } from "./cliErrors.ts";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface DepRow {
  organization: string; repository: string; branch: string; commit_sha: string;
  package_name: string; dependency_key: string; dependency_type: string;
  manifest_path: string; manifest_line: number; manifest_permalink: string;
  declared_version: string; lockfile_path: string | null; lockfile_lines: string | null;
  lockfile_permalink: string | null; resolved_version: string | null; resolved_version_source: string | null;
  date_fetched: string;
}
interface UsageRowDb {
  organization: string; repository: string; branch: string; commit_sha: string;
  package_name: string; dependency_key: string; usage_type: string; export_name: string;
  context: string; file_path: string; line_number: number; permalink: string; snippet: string; found_at: string;
}
interface HeadRow { organization: string; repository: string; branch: string; commit_sha: string; status: string }

function unitKey(o: string, r: string, b: string, c: string): string {
  return `${o}\0${r}\0${b}\0${c}`;
}

// The report's §7 summary block — the ONE hand-written source for this shape. orchestrate.ts
// imports it for the done event + stderr summary, and reportSchema's summarySchema is key-synced
// to it by test, so the three can never silently disagree.
export interface ReportSummary {
  organizationsScanned: number;
  repositoriesScanned: number;
  branchesScanned: number;
  branchesSkippedByCutoff: number;
  totalDependencyFindings: number;
  totalUsageFindings: number;
}

// Top-level envelope of the emitted report. Leaf shapes (packages[], errors[]) stay untyped here
// on purpose — their contract lives in reportSchema.ts and is enforced in tests, never in this
// emit path. The envelope types exactly what orchestrate.ts's done event derives from.
export interface EmittedReport {
  runId: string;
  generatedAt: string;
  config: { packages: string[]; cutoffDate: string; githubHost: string; organizations: string[]; organizationsSource: string };
  packages: unknown[];
  errors: unknown[];
  summary: ReportSummary;
}

// Build the whole §7 report object for a run from SQLite alone.
export function buildReport(db: AuditDb, run: RunRecord): EmittedReport {
  const runId = run.runId;
  const tracked = JSON.stringify(run.trackedPackages);

  // scanned snapshot heads for this run (skipped-cutoff carry commit_sha='' and no findings).
  const heads = db.read(`SELECT organization, repository, branch, commit_sha, status FROM run_unit_head WHERE run_id = ?`).all(runId) as HeadRow[];
  const scannedHeads = heads.filter((h) => h.status === "scanned");
  const scannedKeys = new Set(scannedHeads.map((h) => unitKey(h.organization, h.repository, h.branch, h.commit_sha)));

  // findings joined through the immutable snapshot, filtered to tracked_packages.
  const depRows = (db.read(
    `SELECT df.* FROM dependency_findings df
     JOIN run_unit_head ruh ON ruh.run_id = ? AND ruh.status='scanned'
       AND ruh.organization=df.organization AND ruh.repository=df.repository
       AND ruh.branch=df.branch AND ruh.commit_sha=df.commit_sha
     WHERE df.package_name IN (SELECT value FROM json_each(?))`,
  ).all(runId, tracked) as DepRow[]);
  const usageRows = (db.read(
    `SELECT uf.* FROM usage_findings uf
     JOIN run_unit_head ruh ON ruh.run_id = ? AND ruh.status='scanned'
       AND ruh.organization=uf.organization AND ruh.repository=uf.repository
       AND ruh.branch=uf.branch AND ruh.commit_sha=uf.commit_sha
     WHERE uf.package_name IN (SELECT value FROM json_each(?))`,
  ).all(runId, tracked) as UsageRowDb[]);

  const packages = run.trackedPackages
    .slice()
    .sort(cmp)
    .map((name) => buildPackage(db, name, depRows, usageRows, scannedKeys));

  const errors = (db.read(
    `SELECT scope, organization, repository, branch, package_name, version, message, occurred_at, id
     FROM errors WHERE run_id = ? ORDER BY occurred_at, id`,
  ).all(runId) as Array<Record<string, unknown>>).map((e) => ({
    scope: e["scope"], organization: e["organization"], repository: e["repository"], branch: e["branch"],
    packageName: e["package_name"], version: e["version"], message: e["message"], occurredAt: e["occurred_at"],
  }));

  return {
    runId,
    generatedAt: run.completedAt ?? run.startedAt, // §7: COALESCE(completed_at, started_at)
    config: {
      packages: run.trackedPackages, cutoffDate: run.cutoffDate, githubHost: run.githubHost,
      organizations: run.effectiveOwners, organizationsSource: run.ownersSource,
    },
    packages,
    errors,
    summary: buildSummary(scannedHeads, heads, depRows, usageRows),
  };
}

function buildSummary(scannedHeads: HeadRow[], allHeads: HeadRow[], depRows: DepRow[], usageRows: UsageRowDb[]): ReportSummary {
  const orgs = new Set(scannedHeads.map((h) => h.organization));
  const repos = new Set(scannedHeads.map((h) => `${h.organization}/${h.repository}`));
  return {
    organizationsScanned: orgs.size,
    repositoriesScanned: repos.size,
    branchesScanned: scannedHeads.length,
    branchesSkippedByCutoff: allHeads.filter((h) => h.status === "skipped-cutoff").length,
    totalDependencyFindings: depRows.length,
    totalUsageFindings: usageRows.length,
  };
}

function buildPackage(db: AuditDb, name: string, depRows: DepRow[], usageRows: UsageRowDb[], scannedKeys: Set<string>) {
  const deps = depRows.filter((d) => d.package_name === name);
  const usage = usageRows.filter((u) => u.package_name === name);

  // versionsSeen: DISTINCT valid-SEMVER resolved_version, sorted by precedence then raw string.
  const versionsSeen = [...new Set(deps.map((d) => d.resolved_version).filter((v): v is string => v !== null && parseSemver(v) !== null))]
    .sort(compareForReport);

  // apiSurface: only versions carrying a completion marker; keys in versionsSeen order.
  const apiSurface: Record<string, unknown> = {};
  for (const version of versionsSeen) {
    if (!db.hasCompletionMarker(name, version)) continue;
    const rows = db.read(`SELECT export_name, export_kind FROM package_api_surface WHERE package_name = ? AND version = ?`).all(name, version) as Array<{ export_name: string; export_kind: string }>;
    const exports = rows
      .filter((r) => r.export_kind !== "cli-bin" && r.export_kind !== "__complete__")
      .map((r) => ({ name: r.export_name, kind: r.export_kind }))
      .sort((a, b) => cmp(a.kind, b.kind) || cmp(a.name, b.name));
    const binNames = rows.filter((r) => r.export_kind === "cli-bin").map((r) => r.export_name).sort(cmp);
    apiSurface[version] = { exports, cli: { hasCli: binNames.length > 0, binNames } };
  }

  // usageByRepo: the UNION of dependency-finding and usage-finding units at the snapshot commit.
  const unitMap = new Map<string, { organization: string; repository: string; branch: string; commitSha: string }>();
  for (const d of deps) if (scannedKeys.has(unitKey(d.organization, d.repository, d.branch, d.commit_sha)))
    unitMap.set(unitKey(d.organization, d.repository, d.branch, d.commit_sha), { organization: d.organization, repository: d.repository, branch: d.branch, commitSha: d.commit_sha });
  for (const u of usage) if (scannedKeys.has(unitKey(u.organization, u.repository, u.branch, u.commit_sha)))
    unitMap.set(unitKey(u.organization, u.repository, u.branch, u.commit_sha), { organization: u.organization, repository: u.repository, branch: u.branch, commitSha: u.commit_sha });

  const usageByRepo = [...unitMap.values()]
    .sort((a, b) => cmp(a.organization, b.organization) || cmp(a.repository, b.repository) || cmp(a.branch, b.branch) || cmp(a.commitSha, b.commitSha))
    .map((unit) => buildUnit(unit, deps, usage));

  return { name, versionsSeen, apiSurface, usageByRepo };
}

function buildUnit(
  unit: { organization: string; repository: string; branch: string; commitSha: string },
  deps: DepRow[], usage: UsageRowDb[],
) {
  const inUnit = <T extends { organization: string; repository: string; branch: string; commit_sha: string }>(r: T): boolean =>
    r.organization === unit.organization && r.repository === unit.repository && r.branch === unit.branch && r.commit_sha === unit.commitSha;
  const unitDeps = deps.filter(inUnit);
  const unitUsage = usage.filter(inUnit);

  // dateFetched = MAX over BOTH dependency_findings.date_fetched AND usage_findings.found_at (ISO
  // UTC, so lexicographic MAX = chronological latest).
  let dateFetched = "";
  for (const d of unitDeps) if (d.date_fetched > dateFetched) dateFetched = d.date_fetched;
  for (const u of unitUsage) if (u.found_at > dateFetched) dateFetched = u.found_at;

  const declarations = unitDeps
    .map((d) => ({
      dependencyType: d.dependency_type, dependencyKey: d.dependency_key, path: d.manifest_path, line: d.manifest_line,
      permalink: d.manifest_permalink, declaredVersion: d.declared_version,
      resolvedVersion: d.resolved_version, resolvedVersionSource: d.resolved_version_source,
      lockfile: d.lockfile_path === null ? null : {
        path: d.lockfile_path, lines: d.lockfile_lines === null ? null : (JSON.parse(d.lockfile_lines) as number[]), permalink: d.lockfile_permalink,
      },
    }))
    .sort((a, b) => cmp(a.dependencyType, b.dependencyType) || cmp(a.dependencyKey, b.dependencyKey) || cmp(a.path, b.path) || a.line - b.line);

  const apiUsage = unitUsage
    .filter((u) => u.usage_type !== "cli")
    .map((u) => ({ exportName: u.export_name, dependencyKey: u.dependency_key, usageType: u.usage_type, file: u.file_path, line: u.line_number, permalink: u.permalink, snippet: u.snippet }))
    .sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.usageType, b.usageType) || cmp(a.exportName, b.exportName) || cmp(a.dependencyKey, b.dependencyKey));

  const cliUsage = unitUsage
    .filter((u) => u.usage_type === "cli")
    .map((u) => ({ file: u.file_path, line: u.line_number, context: u.context, permalink: u.permalink, snippet: u.snippet }))
    .sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.context, b.context));

  return { organization: unit.organization, repository: unit.repository, branch: unit.branch, commitSha: unit.commitSha, dateFetched, declarations, apiUsage, cliUsage };
}

// Emit a run's report files into outputDir (§7). Writes run-<id>.json always; the DEFAULT
// report also overwrites latest.json with a byte copy. Reused by orchestrate.ts (§8 step 6-7) so
// a full run ends with a report without a second command. Returns the path AND the report
// object, so the caller's done-event counters and human summary derive from the EXACT emitted
// report (never a separate re-query that could disagree with run-<id>.json).
export function emitReportDetailed(
  db: AuditDb, run: RunRecord, outputDir: string, opts: { alsoLatest: boolean },
): { path: string; report: EmittedReport } {
  mkdirSync(outputDir, { recursive: true });
  const report = buildReport(db, run);
  const runPath = join(outputDir, `run-${run.runId}.json`);
  writeJson(runPath, outputDir, report);
  if (opts.alsoLatest) writeJson(join(outputDir, "latest.json"), outputDir, report);
  return { path: runPath, report };
}
// The "nothing to report" notice (no completed reportable run, or an unknown/pre-migration
// --run-id). Exported so tests validate the REAL emitted object against notReportableSchema,
// not a hand-written lookalike.
export function buildNotReportableNotice(runIdArg: string | null, missingDbPath?: string): { notReportable: true; reason: string } {
  // A missing database is the most fundamental "nothing to report" cause and gets an actionable
  // reason (run the audit first); it takes precedence over the run-id/empty cases, which only
  // make sense once a database exists.
  return {
    notReportable: true,
    reason:
      missingDbPath !== undefined
        ? `no database at ${missingDbPath} — run \`bun run audit\` first`
        : runIdArg !== null
          ? `run ${runIdArg} not found or pre-migration (empty tracked_packages)`
          : "no completed reportable run yet",
  };
}

// The report flow minus argv/config parsing (main() below wires those in). Exported as a
// testable seam — like orchestrate.ts's runPlan — so the "no database yet" invariant is proven
// against a real temp dir, not just asserted. Returns the exact line main() writes to stdout.
//
// Invariant (the reason this seam exists): running `report` before any `audit` is a pure no-op.
// AuditDb.open would create data/audit.db (create:true) and the emit path would mkdir outputDir;
// a first report must touch NOTHING and just say so. So we exist-check before opening: a missing
// database short-circuits with the notReportable notice and zero filesystem effect.
export function runReport(config: Config, runIdArg: string | null): { line: string } {
  const sqlitePath = config.paths.sqlitePath;
  if (sqlitePath !== ":memory:" && !existsSync(sqlitePath)) {
    // Exit 0 (main() returns normally): notReportable is a well-formed, successful answer on the
    // stdout JSONL contract — consumers branch on the parsed `notReportable` field, not the exit
    // code — and this matches the exit-0 behavior of the DB-present notReportable cases below.
    return { line: `${JSON.stringify(buildNotReportableNotice(runIdArg, sqlitePath))}\n` };
  }
  const db = AuditDb.open({ sqlitePath });
  try {
    const run = runIdArg !== null ? db.getRun(runIdArg) : db.latestReportableRun();
    const outputDir = config.paths.outputDir;
    mkdirSync(outputDir, { recursive: true });

    if (run === null || run.trackedPackages.length === 0) {
      const notice = buildNotReportableNotice(runIdArg);
      const path = join(outputDir, runIdArg !== null ? `run-${runIdArg}.json` : "latest.json");
      writeJson(path, outputDir, notice);
      return { line: `${JSON.stringify(notice)}\n` };
    }

    const runPath = emitReportDetailed(db, run, outputDir, { alsoLatest: runIdArg === null }).path;
    return { line: `report written: ${runPath}${runIdArg === null ? " (+ latest.json)" : ""}\n` };
  } finally {
    db.close();
  }
}

// ---- entry point ----------------------------------------------------------------------------
// argv is injectable (defaulting to the process argv) so the entrypoint tests can drive the
// REAL dispatch — help short-circuit before config/DB, runReport wiring — in-process.
export async function main(argv: string[] = Bun.argv.slice(2)): Promise<void> {
  const rargs = parseReportArgs(argv); // strict: unknown flags / valueless --run-id are rejected
  if (rargs.help) {
    process.stdout.write(REPORT_HELP + "\n");
    return;
  }
  const { config } = await loadConfig(argv);
  process.stdout.write(runReport(config, rargs.runId).line);
}

function writeJson(path: string, outputDir: string, value: unknown): void {
  assertContained(path, [outputDir]); // §0 write containment
  Bun.write(path, JSON.stringify(value, null, 2) + "\n");
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(renderFatal(e, { command: "report", usage: REPORT_USAGE }));
    process.exit(1);
  });
}
