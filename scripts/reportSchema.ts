// reportSchema.ts — the authoritative, machine-checkable shape of the §7 report
// (run-<run_id>.json / latest.json). Every field carries a .describe() so this module doubles as
// the report's reference documentation; every object is .strict() so shape drift fails loudly.
// Validation runs in TESTS (report.test.ts), never in the emit path — a schema bug must not be
// able to fail a completed scan's report write (§7 determinism).
//
// DEPENDENCY JUSTIFICATION (§6 — minimize deps): zod is the repo's second npm dependency
// (after `typescript`, used for .d.ts AST parsing). Justification: a schema-as-docs contract for
// the report consumed by downstream tooling, with validation errors that name the failing path —
// hand-rolling that (or maintaining prose docs against a moving shape) is strictly worse. zod v4
// is dependency-free and pinned exactly.

import { z } from "zod";
// Type-only import (zero runtime coupling — the emit path never touches this module, and this
// module never touches the DB): the enum literals below are pinned to db.ts's unions at compile
// time, so a new/renamed member on either side fails `bun run typecheck` instead of drifting.
import type { ExportKind, UsageType } from "./db.ts";

const semverish = z.string().min(1);
const isoUtc = z.string().describe("ISO-8601 UTC timestamp (fixed-width, lexicographically sortable)");
const permalink = z.string().describe("Commit-SHA-pinned permalink: https://{host}/{org}/{repo}/blob/{sha}/{path}#L{n} or #L{a}-L{b}");

export const usageTypeSchema = z
  .enum(["named-import", "default-import", "namespace-import", "require", "dynamic-import", "reexport", "side-effect-import"])
  .describe("§5.F import-usage classification (CLI usage lives in cliUsage, not here)");

export const exportKindSchema = z
  .enum(["named", "default", "type"])
  .describe("§5.E export classification ('cli-bin' rows surface as cli.binNames, the '__complete__' marker is never emitted)");

// Bidirectional compile-time sync with db.ts (report enums = DB unions minus the CLI members,
// which surface via cliUsage / cli.binNames instead). Equal<> fails in BOTH drift directions.
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
export type UsageEnumSyncedWithDb = Expect<Equal<(typeof usageTypeSchema.options)[number], Exclude<UsageType, "cli">>>;
export type ExportEnumSyncedWithDb = Expect<Equal<(typeof exportKindSchema.options)[number], Exclude<ExportKind, "cli-bin">>>;

const lockfileRefSchema = z
  .strictObject({
    path: z.string().describe("Lockfile path within the repo"),
    lines: z.array(z.number().int().min(1)).nullable().describe("1-based line span; null when the lockfile has no line-level parse (e.g. binary bun.lockb)"),
    permalink: permalink.nullable().describe("Commit-pinned link to the lockfile block; null when no line span exists"),
  })
  .describe("The lockfile evidence that resolved this declaration; null on the parent when the repo committed no usable lockfile");

export const declarationSchema = z
  .strictObject({
    dependencyType: z
      .enum(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"])
      .describe("Manifest section the package appears in (§5.D)"),
    dependencyKey: z.string().describe("The manifest KEY — equals the package name unless npm-aliased (\"key\": \"npm:<name>@range\")"),
    path: z.string().describe("Manifest path within the repo"),
    line: z.number().int().min(1).describe("1-based line of the declaration"),
    permalink,
    declaredVersion: z.string().describe("The exact declared range/spec, verbatim"),
    resolvedVersion: z.string().nullable().describe("Concrete resolved version; null when nothing resolved it (e.g. peer-only declaration, unparseable lockfile)"),
    resolvedVersionSource: z
      .enum(["lockfile", "range-resolved"])
      .nullable()
      .describe("'lockfile' = importer-edge lockfile resolution; 'range-resolved' = max-satisfying packument version (repo committed no lockfile); null = unresolved or a non-registry spec"),
    lockfile: lockfileRefSchema.nullable(),
  })
  .describe("One manifest declaration of the tracked package; a package declared in several sections/aliases of one manifest yields several declarations");

export const apiUsageSchema = z
  .strictObject({
    exportName: z.string().describe("The bound export; '' for forms with no single binding (namespace/side-effect/reexport, unresolved subpaths)"),
    dependencyKey: z.string().describe("The manifest key that resolved this specifier (the alias for aliased installs); never '' for imports"),
    usageType: usageTypeSchema,
    file: z.string().describe("Repo-relative source path"),
    line: z.number().int().min(1).describe("1-based line of the occurrence"),
    permalink,
    snippet: z.string().describe("Trimmed source line"),
  })
  .describe("One in-repo import/require occurrence attributed to the tracked package (§5.F)");

export const cliUsageSchema = z
  .strictObject({
    file: z.string().describe("Repo-relative path of the invoking file"),
    line: z.number().int().min(1).describe("1-based line of the invocation"),
    context: z.string().describe("Where the invocation lives: the script name (scripts.build), Dockerfile stage, workflow file kind, …"),
    permalink,
    snippet: z.string().describe("Trimmed invoking line"),
  })
  .describe("One CLI invocation of the package (runner, exec, or bare bin token; §5.G)");

export const usageByRepoSchema = z
  .strictObject({
    organization: z.string().describe("GitHub owner (org, or the personal login when includePersonalNamespace scanned it)"),
    repository: z.string().describe("Repository name"),
    branch: z.string().describe("Branch name"),
    commitSha: z.string().describe("The snapshot head this run REPORTED for the unit (run_unit_head) — all evidence below is pinned to it"),
    dateFetched: isoUtc.describe("MAX over the unit's dependency/usage timestamps"),
    declarations: z.array(declarationSchema),
    apiUsage: z.array(apiUsageSchema),
    cliUsage: z.array(cliUsageSchema),
  })
  .describe("One (org, repo, branch, commit) unit — the UNION of dependency-finding and usage-finding units, so a CLI-only package with no manifest declaration still appears");

export const apiSurfaceEntrySchema = z
  .strictObject({
    exports: z.array(z.strictObject({ name: z.string().describe("Export identifier"), kind: exportKindSchema })).describe("Sorted (kind, name); empty for a zero-export surface"),
    cli: z.strictObject({
      hasCli: z.boolean().describe("true when the version publishes at least one bin"),
      binNames: z.array(z.string()).describe("bin names from the package manifest, sorted"),
    }),
  })
  .describe("The introspected API surface of ONE published version");

export const packageReportSchema = z
  .strictObject({
    name: z.string().describe("The canonical npm registry name"),
    versionsSeen: z
      .array(semverish)
      .describe("DISTINCT valid-semver resolved versions in the run's slice, semver-precedence sorted. Non-registry specs (git+/file:/workspace:/…) are excluded"),
    apiSurface: z
      .record(z.string(), apiSurfaceEntrySchema)
      .describe("Keyed by version, in versionsSeen order. A SUBSET of versionsSeen: only versions introspected to completion appear — a versionsSeen version MISSING here is a registry-introspection FAILURE (see errors[]), not absent data"),
    usageByRepo: z.array(usageByRepoSchema).describe("Sorted (org, repo, branch, commitSha)"),
  })
  .describe("Everything the run knows about one tracked package");

export const reportErrorSchema = z
  .strictObject({
    scope: z.string().describe("Error domain: discovery | scan | introspection | …"),
    organization: z.string().nullable().describe("Set for org/repo/branch-scoped errors; null for package/network-scoped ones"),
    repository: z.string().nullable().describe("Set for repo/branch-scoped errors"),
    branch: z.string().nullable().describe("Set for branch-scoped errors"),
    packageName: z.string().nullable().describe("Set for package/introspection-scoped errors"),
    version: z.string().nullable().describe("Concrete semver for per-version introspection failures; the raw non-registry spec (git+/file:/…) for non-registry skips"),
    message: z.string().describe("What failed, with remediation where one exists"),
    occurredAt: isoUtc,
  })
  .describe("One fail-soft error recorded during the reported run (the run continues past these)");

export const summarySchema = z
  .strictObject({
    organizationsScanned: z.number().int().min(0).describe("DISTINCT orgs among the run's scanned branch snapshots"),
    repositoriesScanned: z.number().int().min(0).describe("DISTINCT org/repo among scanned snapshots"),
    branchesScanned: z.number().int().min(0).describe("run_unit_head rows with status='scanned' (includes skipped-as-current units)"),
    branchesSkippedByCutoff: z.number().int().min(0).describe("Still-live branches whose head predates cutoffDate this run"),
    totalDependencyFindings: z.number().int().min(0),
    totalUsageFindings: z.number().int().min(0),
  })
  .describe("Per-run totals derived from the immutable run_unit_head snapshot — never from the mutable work queue");

export const reportSchema = z
  .strictObject({
    runId: z.string().describe("The reported run's identifier (report --run-id <id> re-emits it)"),
    generatedAt: isoUtc.describe("completed_at of the run (started_at fallback for a --run-id report of a non-completed run)"),
    config: z.strictObject({
      packages: z.array(z.string()).describe("The run's tracked package names (runs.tracked_packages)"),
      cutoffDate: z.string().describe("The run's cutoff date (YYYY-MM-DD)"),
      githubHost: z.string().describe("Also the permalink host"),
      organizations: z.array(z.string()).describe("The EFFECTIVE owner list the run resolved (not the raw config value)"),
      organizationsSource: z.enum(["configured", "discovered"]),
    }),
    packages: z.array(packageReportSchema).describe("Sorted by name"),
    errors: z.array(reportErrorSchema).describe("Sorted (occurredAt, id)"),
    summary: summarySchema,
  })
  .describe("The §7 consolidated report: deterministic, byte-reproducible, generated from SQLite alone");

export const notReportableSchema = z
  .strictObject({
    notReportable: z.literal(true),
    reason: z.string().describe("Why no report could be produced (no completed run, or a pre-migration --run-id)"),
  })
  .describe("Emitted instead of a report when no completed reportable run exists (or --run-id names a pre-migration run)");

export type Report = z.infer<typeof reportSchema>;
