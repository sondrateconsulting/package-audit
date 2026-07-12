// report.ts — §7 consolidated report, generated DETERMINISTICALLY from SQLite ALONE. Entry point:
//   bun run scripts/report.ts [--config <path>] [--run-id <id>] [--html]
// Default (no --run-id): the latest COMPLETED run with non-empty tracked_packages; also overwrites
// <outputDir>/latest.json. A --run-id writes its JSON report ONLY to <outputDir>/run-<id>.json (never latest.json).
// Findings are joined through the per-run run_unit_head snapshot (never findings.run_id) filtered
// to runs.tracked_packages, and EVERY emitted array has a total, stable sort key so the output is
// byte-reproducible.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertContained } from "./readOnlyGuard.ts";
import { loadConfig, type Config } from "./config.ts";
import { AuditDb, type AuditDbReader, type RunRecord } from "./db.ts";
import { ArtifactBundle, writeFileAtomic, XRAY_DIR_NAME, XRAY_FORMAT_VERSION } from "./artifactWrite.ts";
import { dossierFilename, renderDossierDetailed, type DossierContext, type ScanScope, type PolicyBranchRow } from "./reportHtml.ts";
import { INDEX_FILENAME, renderIndex } from "./indexHtml.ts";
import { logLine, flushLogs } from "./log.ts";
import { isPolicyExcluded, isDefaultOverride, assertRunUnitHeadSound, policyStatusOrThrow } from "./policyDisposition.ts";
import { assertNever } from "./assertNever.ts";
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
interface HeadRow {
  organization: string; repository: string; branch: string; commit_sha: string; status: string;
  is_default_branch: number | null; // 1/0/NULL — NULL = unknown (pre-v3 run rows)
  policy_status: string | null; // 'excluded-by-deny' | 'excluded-by-allow' | NULL (PROMPT.md §3)
  policy_matched_pattern: string | null; // the causing deny pattern; NULL for allow-miss / no-policy
  scanned_commit_date: string | null; // NULL only for pre-v4 migrated rows → scan-scope provenance sentinel
}

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
  // Branch allow/deny (§5): the disjoint disposition partition. The four disposition counts partition the
  // run_unit_head rows this run RECORDED, exactly once each. (That clause is unconditional and exact.)
  // Together with branchesErrored they account for the branches that reached a TERMINAL outcome:
  //   discovered (terminal) = branchesScanned + branchesSkippedByCutoff + branchesExcludedByPolicy
  //                           + branchesPastCap + branchesErrored   — EXACT on a SINGLE-INVOCATION run.
  //   discovered (terminal) <= that sum                             — on a RESUMED run; see branchesErrored
  //                                                                   for exactly which branches inflate it.
  // branchesScanned INCLUDES scanned default-override rows (they WERE scanned). branchesSkippedByCutoff is
  // GENUINE cutoff only (policy_status IS NULL) — policy exclusions are their own bucket.
  branchesExcludedByPolicy: number;
  branchesPastCap: number;
  // Counts EXACTLY this: distinct (org, repo, branch) with a scope='scan' errors[] entry for this run
  // that hold NO run_unit_head disposition row. Read it as that, and not as "every branch whose scan
  // errored" — on a SINGLE-INVOCATION run the two coincide (a to-scan branch that reaches a TERMINAL
  // outcome gets a row or an errors[] entry; the one composite case is a step failing AFTER the
  // scanned row committed — the success-log write or the work-queue 'done' update — which can leave
  // an errors[] entry beside the row: the persisted row counts that branch under branchesScanned,
  // and the row-key exclusion below keeps it out of THIS count, so it still counts exactly once),
  // but on a RESUMED run they diverge in BOTH directions.
  //
  // A resumed run REUSES the run_id (db.startRun), so errors[] and run_unit_head both span invocations.
  // errors[] is append-only and is NEVER reconciled; run_unit_head rows ARE pruned (reconcileRunUnitHead).
  //
  //   MORE than the errored set: a branch that errored in an EARLIER invocation and reached no
  //   row-bearing disposition in the final one is still counted — whether it is now gone (deleted),
  //   deferred (throttle-requeued on retry), or unvisited (its repo's discovery failed). Stated as this
  //   membership rule on purpose: "overcounts by exactly the deleted branches" would be false.
  //
  //   LESS than the errored set: a branch holding a row from an EARLIER invocation that errors in a
  //   LATER one is NOT counted here — the row-key exclusion below drops it. That is deliberate and
  //   correct: its retained row already places it in that row's disposition bucket, and counting it here
  //   too would count one discovered branch TWICE and break the partition. This is the same-name
  //   stale-head case; see the reconciliation note in orchestrate.ts::processRepo.
  //
  // So the exclusion is what keeps every discovered branch counted at most once, which is why the
  // identity above stays an UPPER BOUND (never a double-count) rather than an equality on a resume.
  //
  // Throttle carve-out, precisely: a branch throttle-requeued with NO prior error has neither a row nor
  // an error — deferred, not terminal, finished next run — so it is in no count. That holds absolutely
  // only WITHIN a single invocation; after an earlier-invocation error the branch DOES carry an error
  // and so IS counted here, despite being deferred rather than terminal.
  branchesErrored: number;
  totalDependencyFindings: number;
  totalUsageFindings: number;
}

// ScanScope + PolicyBranchRow are defined in reportHtml.ts (the render layer, to avoid an import
// cycle) and imported above. Semantics (§5): excludedByDeny+excludedByAllow = branchesExcludedByPolicy;
// defaultBranchPolicyOverrides OVERLAPS branchesScanned (scanned default branches policy would have
// excluded). policyBranches lists every row carrying a policy_status, sorted (org, repo, branch).

// Top-level envelope of the emitted report. `packages` is typed as the exact shape buildPackage
// emits, which (by construction — see report.ts's apiSurface typing) stays assignable to the
// dossier renderer's DossierPackage contract. This is the compile-time link (review M5): if
// buildPackage/buildUnit rename or drop a field the renderer reads, emitDossiers' renderDossierDetailed
// call stops compiling here instead of throwing at render time. The full report shape (declarations,
// cli, dateFetched — a superset of the renderer's view) is preserved for run-<id>.json; its JSON
// contract is separately enforced by reportSchema.ts in tests. errors[] stays untyped (leaf only).
export interface EmittedReport {
  // PINNED to the constant, not a bare `number` (the COMPARE_FORMAT_VERSION precedent): this shape IS
  // v2, so a build that emitted some other version here would be mislabelling itself, and reportSchema
  // — the authoritative contract, but a TEST-ONLY one by design — would only catch it in the suite.
  formatVersion: typeof XRAY_FORMAT_VERSION; // the report/export/HTML artifact-set version
  runId: string;
  generatedAt: string;
  config: { packages: string[]; cutoffDate: string; githubHost: string; organizations: string[]; organizationsSource: string };
  packages: ReadonlyArray<ReturnType<typeof buildPackage>>;
  errors: unknown[];
  summary: ReportSummary;
  scanScope: ScanScope; // branch allow/deny diagnostics (§5) — separate from the disjoint summary counts
}

// Build the whole §7 report object for a run from SQLite alone. Works on the read-only handle;
// the whole build runs inside ONE deferred read transaction so its multiple statements see a
// single coherent snapshot even while a live audit commits concurrently.
export function buildReport(db: AuditDbReader, run: RunRecord): EmittedReport {
  return db.readTransaction(() => buildReportInner(db, run));
}

function buildReportInner(db: AuditDbReader, run: RunRecord): EmittedReport {
  const runId = run.runId;
  const tracked = JSON.stringify(run.trackedPackages);

  // scanned snapshot heads for this run (skipped-cutoff carry commit_sha='' and no findings).
  const heads = db.read(`SELECT organization, repository, branch, commit_sha, status, is_default_branch, policy_status, policy_matched_pattern, scanned_commit_date FROM run_unit_head WHERE run_id = ?`).all(runId) as HeadRow[];
  const scannedHeads = heads.filter((h) => h.status === "scanned");
  const scannedKeys = new Set(scannedHeads.map((h) => unitKey(h.organization, h.repository, h.branch, h.commit_sha)));
  // Tri-state default-branch flag per scanned unit (§5.B): true/false from v3 runs, null for
  // pre-v3 rows — the renderer shows null as its own "(default branch unknown)" state.
  const defaultFlags = new Map<string, boolean | null>(
    scannedHeads.map((h) => [
      unitKey(h.organization, h.repository, h.branch, h.commit_sha),
      h.is_default_branch === null ? null : h.is_default_branch === 1,
    ]),
  );

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
    .map((name) => buildPackage(db, name, depRows, usageRows, scannedKeys, defaultFlags));

  const errors = (db.read(
    `SELECT scope, organization, repository, branch, package_name, version, message, occurred_at, id
     FROM errors WHERE run_id = ? ORDER BY occurred_at, id`,
  ).all(runId) as Array<Record<string, unknown>>).map((e) => ({
    scope: e["scope"], organization: e["organization"], repository: e["repository"], branch: e["branch"],
    packageName: e["package_name"], version: e["version"], message: e["message"], occurredAt: e["occurred_at"],
  }));

  // §5: branches DISCOVERED but holding no disposition row because their scan ERRORED this run — each has
  // a scope='scan' errors[] entry. Counted so the disposition buckets + branchesErrored reconcile to the
  // discovered heads. A branch with BOTH a scan error AND a row (e.g. scanned on an earlier resume attempt,
  // errored on this one) is already a disposition and is excluded here — hence the row-key exclusion.
  const headKeys = new Set(heads.map((h) => `${h.organization}\0${h.repository}\0${h.branch}`));
  const branchesErrored = new Set(
    errors
      .filter((e) => e.scope === "scan" && typeof e.branch === "string" && e.branch !== "")
      .map((e) => `${String(e.organization)}\0${String(e.repository)}\0${String(e.branch)}`)
      .filter((k) => !headKeys.has(k)),
  ).size;

  // Validate the WHOLE head set ONCE, then feed the SAME validated array to BOTH derivations below. This
  // replaces the old reliance on object-literal evaluation order (assertHeadsWellFormed ran INSIDE the
  // summary property while buildScanScope trusted the raw `heads`), so a property reorder can no longer
  // route an unguarded row into a count. assertHeadsWellFormed returns its input, so this is behaviourally
  // identical — it just makes "gate before trust" a data-flow fact instead of a source-order coincidence.
  const validatedHeads = assertHeadsWellFormed(heads);

  return {
    formatVersion: XRAY_FORMAT_VERSION,
    runId,
    generatedAt: run.completedAt ?? run.startedAt, // §7: COALESCE(completed_at, started_at)
    config: {
      packages: run.trackedPackages, cutoffDate: run.cutoffDate, githubHost: run.githubHost,
      organizations: run.effectiveOwners, organizationsSource: run.ownersSource,
    },
    packages,
    errors,
    // Both derivations consume the SAME validatedHeads (above) — NOT a filtered subset: the guard must
    // run over the WHOLE set or the two counts drift, which is exactly how it once broke (buildScanScope
    // guarded only policy-BEARING rows while buildSummary counted by status alone, so a 'policy-excluded'
    // row naming no rule was counted as an exclusion yet never guarded — branchesExcludedByPolicy=1 with
    // excludedByDeny+excludedByAllow=0). Sweeping the whole set makes the two impossible to drift apart.
    summary: buildSummary(scannedHeads, validatedHeads, depRows, usageRows, branchesErrored),
    scanScope: buildScanScope(validatedHeads),
  };
}

// The whole-set fail-closed sweep (PROMPT.md §7). Returns its input so it composes at the call site —
// there is no path to a derived count that skips it.
function assertHeadsWellFormed(heads: HeadRow[]): HeadRow[] {
  for (const h of heads) assertRunUnitHeadSound(h, `${h.organization}/${h.repository}@${h.branch}`);
  return heads;
}

function buildSummary(scannedHeads: HeadRow[], allHeads: HeadRow[], depRows: DepRow[], usageRows: UsageRowDb[], branchesErrored: number): ReportSummary {
  const orgs = new Set(scannedHeads.map((h) => h.organization));
  const repos = new Set(scannedHeads.map((h) => `${h.organization}/${h.repository}`));
  return {
    organizationsScanned: orgs.size,
    repositoriesScanned: repos.size,
    branchesScanned: scannedHeads.length,
    // The four dispositions partition allHeads by `status` alone (§5) — each row lands in exactly one
    // bucket, and a policy exclusion is no longer a cutoff skip wearing a disambiguator.
    branchesSkippedByCutoff: allHeads.filter((h) => h.status === "skipped-cutoff").length,
    branchesExcludedByPolicy: allHeads.filter(isPolicyExcluded).length,
    branchesPastCap: allHeads.filter((h) => h.status === "past-cap").length,
    branchesErrored,
    totalDependencyFindings: depRows.length,
    totalUsageFindings: usageRows.length,
  };
}

// The ledger's disposition for ONE policy-bearing row, via the shared predicates only. The fail-closed
// case lives in policyDisposition.ts (the ONE definition) so this surface and compare's policy churn
// cannot drift apart on what an unrecognised policy-bearing row means.
function dispositionOf(h: HeadRow): "scanned-default-override" | "excluded" {
  // Deliberately re-runs the gate even though buildReportInner's assertHeadsWellFormed already swept
  // every head: this function LABELS a row, and the label must never outlive a refactor that changes
  // which caller reaches it first. The gate is cheap, idempotent, and this is the defense-in-depth
  // layer review chose to keep rather than trust call-order.
  assertRunUnitHeadSound(h, `${h.organization}/${h.repository}@${h.branch}`);
  return isDefaultOverride(h) ? "scanned-default-override" : "excluded";
}

// Scan-scope diagnostics (PROMPT.md §7 scanScope). policyBranches lists every head with a policy_status (both the excluded
// rows and the scanned default-overrides), deterministically sorted by (org, repo, branch).
function buildScanScope(allHeads: HeadRow[]): ScanScope {
  const policyRows = allHeads.filter((h) => h.policy_status !== null);
  const policyBranches: PolicyBranchRow[] = policyRows
    .map((h) => ({
      organization: h.organization,
      repository: h.repository,
      branch: h.branch,
      // BOTH shared predicates, never a `policy_status !== null` ternary. A binary
      // `isDefaultOverride(h) ? override : excluded` would silently re-define "excluded" HERE as
      // "policy-bearing but not an override" — a second definition competing with
      // policyDisposition.ts, which exists precisely because that conflation is load-bearing
      // (invariant: a non-null policy_status does NOT mean excluded). The write-path invariants
      // (assertRunUnitHeadInvariants) make a third shape unreachable today — a past-cap row must carry
      // policy_status null, and a scanned policy-bearing row must be the default — but those run at the
      // WRITE chokepoint, not here, and a future disposition (e.g. an 'error' status) would land in the
      // ternary's else-branch and be mislabelled EXCLUDED. Fail closed instead of guessing.
      disposition: dispositionOf(h),
      // CHECKED, never `as`-cast: dispositionOf's guard above validates this row's SHAPE and stops
      // there, so the literal itself is only a promise until something reads it. See policyStatusOrThrow.
      policyStatus: policyStatusOrThrow(h, `${h.organization}/${h.repository}@${h.branch}`),
      matchedPattern: h.policy_matched_pattern,
    }))
    .sort((a, b) => cmp(`${a.organization}\0${a.repository}\0${a.branch}`, `${b.organization}\0${b.repository}\0${b.branch}`));
  // Deny/allow sub-counts via an EXHAUSTIVE switch over the NARROWED policy_status, never a raw-string
  // `=== "excluded-by-deny"` compare. The day PolicyStatus gains a member, a policy-excluded row carrying
  // it would silently count in branchesExcludedByPolicy (buildSummary) yet in NEITHER sub-count, breaking
  // the excludedByDeny+excludedByAllow == branchesExcludedByPolicy identity with no error — the compile-time
  // analog of the run path's planPolicyDiagnostics sum-check. assertNever makes that day a BUILD error.
  // policyStatusOrThrow narrows only the literal; the whole-row soundness gate already ran (validatedHeads
  // upstream), so every isPolicyExcluded row here is validated and its policy_status is a known member.
  let excludedByDeny = 0;
  let excludedByAllow = 0;
  for (const h of allHeads) {
    if (!isPolicyExcluded(h)) continue;
    const status = policyStatusOrThrow(h, `${h.organization}/${h.repository}@${h.branch}`);
    switch (status) {
      case "excluded-by-deny": excludedByDeny++; break;
      case "excluded-by-allow": excludedByAllow++; break;
      default: assertNever(status, "policy status");
    }
  }
  return {
    excludedByDeny,
    excludedByAllow,
    defaultBranchPolicyOverrides: allHeads.filter(isDefaultOverride).length,
    policyBranches,
    // Provenance is trustworthy ONLY for a v4-native run with at least one recorded head. A migrated
    // pre-v4 run (the NULL scanned_commit_date backfilled by migrateV3toV4) never persisted past-cap
    // branches and had no branch policy; a ZERO-head run carries no sentinel row at all, so its
    // provenance is simply unverifiable (same treatment as compare.ts loadRunSlice). Either way the
    // cap/policy counts may UNDERSTATE reality — flag it, don't present a false authoritative 0.
    provenance:
      allHeads.length === 0 || allHeads.some((h) => h.scanned_commit_date === null) ? "pre-upgrade" : "complete",
  };
}

function buildPackage(
  db: AuditDbReader, name: string, depRows: DepRow[], usageRows: UsageRowDb[],
  scannedKeys: Set<string>, defaultFlags: Map<string, boolean | null>,
) {
  const deps = depRows.filter((d) => d.package_name === name);
  const usage = usageRows.filter((u) => u.package_name === name);

  // versionsSeen: DISTINCT valid-SEMVER resolved_version, sorted by precedence then raw string.
  const versionsSeen = [...new Set(deps.map((d) => d.resolved_version).filter((v): v is string => v !== null && parseSemver(v) !== null))]
    .sort(compareForReport);

  // apiSurface: only versions carrying a completion marker; keys in versionsSeen order. Typed
  // concretely (not Record<string, unknown>) so the emitted package stays statically assignable to
  // the dossier renderer's DossierApiSurfaceEntry — see the compile-time link on EmittedReport.packages.
  const apiSurface: Record<string, { exports: { name: string; kind: string }[]; cli: { hasCli: boolean; binNames: string[] } }> = {};
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
    .map((unit) => buildUnit(unit, deps, usage, defaultFlags.get(unitKey(unit.organization, unit.repository, unit.branch, unit.commitSha)) ?? null));

  return { name, versionsSeen, apiSurface, usageByRepo };
}

// lockfile_lines is self-produced (written via JSON.stringify at ingest), so this parse is not
// attacker-facing — but guard it anyway, matching artifactWrite.ts's guarded manifest parse: a
// corrupted DB cell degrades that one declaration's line refs to null instead of throwing and
// failing the ENTIRE report build (report/report --html/orchestrate's final step).
export function parseLockfileLines(json: string | null): number[] | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    // Line refs are 1-based POSITIVE SAFE integers (the report schema's contract); reject a corrupted
    // cell holding NaN/Infinity/floats/0/negatives/unsafe integers (all still `typeof "number"`) so
    // the report never carries a malformed line number.
    return Array.isArray(v) && v.every((n) => Number.isSafeInteger(n) && (n as number) > 0) ? (v as number[]) : null;
  } catch {
    return null;
  }
}

function buildUnit(
  unit: { organization: string; repository: string; branch: string; commitSha: string },
  deps: DepRow[], usage: UsageRowDb[], isDefaultBranch: boolean | null,
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
        path: d.lockfile_path, lines: parseLockfileLines(d.lockfile_lines), permalink: d.lockfile_permalink,
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

  return { organization: unit.organization, repository: unit.repository, branch: unit.branch, isDefaultBranch, commitSha: unit.commitSha, dateFetched, declarations, apiUsage, cliUsage };
}

// Emit a run's report files into outputDir (§7). Writes run-<id>.json always; the DEFAULT
// report also overwrites latest.json with a byte copy. Reused by orchestrate.ts (§8 step 6-7) so
// a full run ends with a report without a second command. Returns the path AND the report
// object, so the caller's done-event counters and human summary derive from the EXACT emitted
// report (never a separate re-query that could disagree with run-<id>.json).
export function emitReportDetailed(
  db: AuditDbReader, run: RunRecord, outputDir: string, opts: { alsoLatest: boolean },
): { path: string; report: EmittedReport } {
  mkdirCanonical(outputDir);
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
// `report --html`: render one self-contained dossier per tracked package plus the
// index, through the ArtifactBundle (kind "dossier" — export artifacts of the SAME run are
// adopted, never swept). One JSONL event per dossier, with the observations fallback
// VISIBLE (observations: "emitted"|"omitted"), then a dossier-summary event. The rendered
// dossier/index bytes are a pure function of the report object; the caller already holds it, so
// no re-query can disagree with run-<id>.json.
export function emitDossiers(report: EmittedReport, outputDir: string): { dossiers: number; swept: string[] } {
  const ctx: DossierContext = {
    runId: report.runId,
    generatedAt: report.generatedAt,
    config: report.config,
    summary: report.summary,
    formatVersion: report.formatVersion,
  };
  const bundle = new ArtifactBundle(outputDir, "dossier");
  let dossiers = 0;
  for (const pkg of report.packages) {
    // No cast: report.packages is typed as buildPackage's output, statically assignable to the
    // renderer's DossierPackage — a drift in the build shape fails to compile right here.
    const { html, observationsStatus, observationCount } = renderDossierDetailed(pkg, ctx);
    const name = dossierFilename(pkg.name);
    const record = bundle.write(name, html);
    dossiers++;
    logLine({
      event: "dossier", package: pkg.name, path: join(outputDir, XRAY_DIR_NAME, record.path),
      bytes: record.bytes, observations: observationsStatus, observationCount,
    });
  }
  bundle.write(INDEX_FILENAME, renderIndex(report, { formatVersion: report.formatVersion }));
  const { swept } = bundle.finalize({ runId: report.runId });
  logLine({ event: "dossier-summary", runId: report.runId, dossiers, index: join(outputDir, XRAY_DIR_NAME, INDEX_FILENAME), swept });
  return { dossiers, swept };
}

export function runReport(config: Config, runIdArg: string | null, opts: { html?: boolean } = {}): { line: string } {
  const sqlitePath = config.paths.sqlitePath;
  // :memory: folds into the missing-db notice: a fresh in-memory database can never hold a
  // completed run, and openReadOnly (below) rightly refuses to open one.
  if (sqlitePath === ":memory:" || !existsSync(sqlitePath)) {
    // Exit 0 (main() returns normally): notReportable is a well-formed, successful answer on the
    // stdout JSONL contract — consumers branch on the parsed `notReportable` field, not the exit
    // code — and this matches the exit-0 behavior of the DB-present notReportable cases below.
    return { line: `${JSON.stringify(buildNotReportableNotice(runIdArg, sqlitePath))}\n` };
  }
  // Report is a pure READ — it must never create, migrate, or write the database. A
  // too-old schema renders the actionable "run `bun run audit` once to migrate" DbError.
  const db = AuditDb.openReadOnly({ sqlitePath });
  try {
    const run = runIdArg !== null ? db.getRun(runIdArg) : db.latestReportableRun();
    const outputDir = config.paths.outputDir;
    mkdirCanonical(outputDir);

    if (run === null || run.trackedPackages.length === 0) {
      const notice = buildNotReportableNotice(runIdArg);
      const path = join(outputDir, runIdArg !== null ? `run-${runIdArg}.json` : "latest.json");
      writeJson(path, outputDir, notice);
      return { line: `${JSON.stringify(notice)}\n` };
    }

    const emitted = emitReportDetailed(db, run, outputDir, { alsoLatest: runIdArg === null });
    if (opts.html === true) {
      const { dossiers } = emitDossiers(emitted.report, outputDir);
      return {
        line: `report written: ${emitted.path}${runIdArg === null ? " (+ latest.json)" : ""} — ${dossiers} dossier(s) + index in ${join(outputDir, XRAY_DIR_NAME)}\n`,
      };
    }
    return { line: `report written: ${emitted.path}${runIdArg === null ? " (+ latest.json)" : ""}\n` };
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
  const rendered = runReport(config, rargs.runId, { html: rargs.html });
  // T7: runReport emits dossier events via logLine (buffered under a slow stdout consumer); drain
  // them before the summary line so ordering holds and nothing is left buffered at exit.
  await flushLogs();
  process.stdout.write(rendered.line);
}

// Atomic (temp+rename) and SYNC — the old Bun.write here discarded its Promise, a latent
// fire-and-forget that could lose the report on a fast exit. §0 containment lives inside
// writeFileAtomic (roots = [outputDir], the same contract as before).
function writeJson(path: string, outputDir: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", [outputDir]);
}

// mkdir the CANONICAL outputDir, never the raw configured string: recursive mkdirSync creates
// every path component physically, so a config-accepted `..` chain (canonical resolution lands
// inside the roots) would otherwise create its intermediate directories OUTSIDE them —
// `out/../evil/../out` must never create `evil/`. assertContained(dir, [dir]) is the resolving
// identity: it returns the symlink-aware canonical path (the writeFileAtomic precedent).
function mkdirCanonical(outputDir: string): void {
  mkdirSync(assertContained(outputDir, [outputDir]), { recursive: true });
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(renderFatal(e, { command: "report", usage: REPORT_USAGE }));
    process.exit(1);
  });
}
