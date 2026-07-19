// reportSchema.ts — the authoritative, machine-checkable shape of the §7 report
// (run-<run_id>.json / latest.json). Every field carries a .describe() so this module doubles as
// the report's reference documentation; every object is .strict() so shape drift fails loudly.
// Validation runs in TESTS (report.test.ts), never in the emit path — a schema bug must not be
// able to fail a completed scan's report write (§7 determinism).
//
// DEPENDENCY JUSTIFICATION (§6 — minimize deps): zod is test-only, one of the repo's
// devDependencies (alongside `@types/bun` and the dashboard's `@types/react` +
// `ink-testing-library`). The ANALYSIS path's sole runtime dependency remains `typescript`
// (.d.ts AST parsing); `ink`/`react` are display-layer-only runtime deps for the opt-outable
// dashboard (dynamic-import-only — see README "Runtime dependencies").
// Justification: a schema-as-docs contract for the report consumed by downstream tooling, with
// validation errors that name the failing path — hand-rolling that (or maintaining prose docs
// against a moving shape) is strictly worse. zod v4 is dependency-free and pinned exactly.

import { z } from "zod";
// Type-only import — zero runtime coupling: the emit path never touches this module, and this
// module never touches the DB: the enum literals below are pinned to db.ts's unions at compile
// time, so a new/renamed member on either side fails `bun run typecheck` instead of drifting.
import type { ExportKind, UsageType } from "./db.ts";
// Runtime value import — a plain numeric const, NO cycle (artifactWrite imports only node built-ins +
// readOnlyGuard). Pins formatVersion below so the schema is a TRUE shape discriminator: a v2-shaped
// report mislabeled formatVersion:1 must FAIL validation, and a version bump auto-updates the literal.
import { XRAY_FORMAT_VERSION } from "./artifactWrite.ts";

const semverish = z.string().min(1);
// The nowIso canonical form (db.ts validates writes against the same shape) — every timestamp
// the report emits comes from nowIso, so the fixed-width millisecond form is exact, not lax.
const isoUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "must be canonical fixed-width ISO-8601 UTC (nowIso form)")
  .describe("ISO-8601 UTC timestamp (fixed-width, lexicographically sortable)");
// Pinned to buildPermalink's output grammar (permalink.ts): https scheme, host[:port], org/repo,
// /blob/<hex sha>/, a non-empty path, and a #L{n} or #L{a}-L{b} line anchor — always present.
const permalink = z
  .string()
  .regex(/^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/blob\/[0-9a-f]{7,64}\/\S+#L[1-9]\d*(?:-L[1-9]\d*)?$/, "must be a commit-pinned https blob permalink with a line anchor")
  .describe("Commit-SHA-pinned permalink: https://{host}/{org}/{repo}/blob/{sha}/{path}#L{n} or #L{a}-L{b}");

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
    exportName: z.string().describe("The bound export; '' for forms with no single named binding (whole-module require/dynamic-import bindings, namespace/side-effect/reexport, unresolved subpaths)"),
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
    isDefaultBranch: z
      .boolean()
      .nullable()
      .describe(
        "Tri-state (§5.B): true/false when discovery recorded whether this is the repo's default branch; null on pre-v3 runs (unknown — renderers show it as its own state, never as false)",
      ),
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
  // Enforce the subset invariant the apiSurface description documents — a key with no matching
  // versionsSeen entry is drift (a stale surface surviving a version's disappearance), not data.
  .superRefine((pkg, ctx) => {
    for (const v of Object.keys(pkg.apiSurface)) {
      if (!pkg.versionsSeen.includes(v))
        ctx.addIssue({ code: "custom", path: ["apiSurface", v], message: `apiSurface key '${v}' is not in versionsSeen — apiSurface must be a subset` });
    }
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
    branchesScanned: z.number().int().min(0).describe("run_unit_head rows with status='scanned' (includes skipped-as-current + scanned default-override units)"),
    branchesSkippedByCutoff: z.number().int().min(0).describe("GENUINE cutoff skips: run_unit_head rows with status='skipped-cutoff' (a policy exclusion is its own status, never counted here)"),
    branchesExcludedByPolicy: z.number().int().min(0).describe("Branch allow/deny exclusions: run_unit_head rows with status='policy-excluded'"),
    branchesPastCap: z.number().int().min(0).describe("Eligible branches past the per-repo cap (not scanned this run)"),
    branchesErrored: z.number().int().min(0).describe("DISTINCT branches carrying a scope='scan' errors[] entry this run that hold NO run_unit_head disposition row — read it as exactly that, not as 'every branch whose scan errored'. The two coincide on a single-invocation run, except that a post-persistence step (the success-log write or the work-queue 'done' update) throwing after the scanned row committed can leave both a row and an errors[] entry for one branch — the persisted scanned row counts it under branchesScanned while the row-key exclusion keeps it out of branchesErrored, so the summary counts it exactly once; on a RESUMED run they diverge BOTH ways. More: a branch that errored in an earlier invocation and reached no row-bearing disposition in the final one (deleted, throttle-requeued, or its repo's discovery failed) is still counted, because errors[] is append-only and never reconciled. Less: a branch holding a row from an earlier invocation that errors in a later one is NOT counted — its retained row already places it in that row's disposition bucket, and counting it here too would count one discovered branch twice"),
    totalDependencyFindings: z.number().int().min(0),
    totalUsageFindings: z.number().int().min(0),
  })
  .describe("Per-run disposition counts + finding totals, from the immutable run_unit_head snapshot. The four disposition counts partition the RECORDED run_unit_head rows exactly once each (exact, unconditionally); together with branchesErrored they account for the branches that reached a TERMINAL outcome (scanned + skippedByCutoff + excludedByPolicy + pastCap + errored) — as an EQUALITY on a single-invocation run, and as an UPPER BOUND on a resumed run, where a branch that errored in an earlier invocation and reached no row-bearing disposition in the final one is still counted in errored (see branchesErrored, whose relationship to 'branches whose scan errored' is looser than its name suggests on a resume, in BOTH directions). A branch whose scan was THROTTLE-REQUEUED is deferred, not terminal — it holds no row and no error, and is finished on the next run, so it appears in no count here; that carve-out is absolute only within a single invocation, since a branch that errored in an earlier one carries an error and so is counted despite being deferred");

export const policyBranchSchema = z.strictObject({
  organization: z.string(),
  repository: z.string(),
  branch: z.string(),
  disposition: z.enum(["excluded", "scanned-default-override"]),
  policyStatus: z.enum(["excluded-by-deny", "excluded-by-allow"]),
  matchedPattern: z.string().nullable().describe("The stored deny-attribution pattern; null for an allow-miss / default-override-by-allow. Writes verify it matches the branch; the read gate does NOT re-match it — report/compare and JSONL export surface the stored value on otherwise-sound pre-verifier or externally-edited rows (the default CSV export still applies its formula-injection defense; malformed rows still fail the read gate on shape), so it is not read-time attested"),
});
export const scanScopeSchema = z
  .strictObject({
    excludedByDeny: z.number().int().min(0),
    excludedByAllow: z.number().int().min(0),
    defaultBranchPolicyOverrides: z.number().int().min(0).describe("OVERLAPPING diagnostic (within branchesScanned): scanned default branches policy would have excluded"),
    policyBranches: z.array(policyBranchSchema).describe("Every head with a policy_status, sorted (organization, repository, branch)"),
    provenance: z.enum(["complete", "pre-upgrade"]).describe("'complete' ONLY for a v4-native run with at least one recorded head. 'pre-upgrade' means the scan scope is UNVERIFIABLE, from either of two causes: the run was migrated from before v4 (a head carries a NULL scanned_commit_date, and pre-v4 runs never persisted past-cap branches and had no branch policy), OR the run recorded ZERO heads, so there is no sentinel row to judge provenance by at all. Either way the past-cap + policy counts may UNDERSTATE what the run omitted — the value is a warning that the counts are not authoritative, not a claim about which cause applies"),
  })
  .describe("Branch allow/deny scan-scope diagnostics (§5) — SEPARATE from the disjoint summary counts (subcounts overlap)");

export const reportSchema = z
  .strictObject({
    formatVersion: z.literal(XRAY_FORMAT_VERSION).describe("XRAY_FORMAT_VERSION — the report/export/HTML artifact-set version; PINNED so this schema is a true shape discriminator"),
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
    scanScope: scanScopeSchema,
  })
  .describe("The §7 consolidated report: deterministic, byte-reproducible, generated from SQLite alone");

export const notReportableSchema = z
  .strictObject({
    notReportable: z.literal(true),
    reason: z.string().describe("Why no report could be produced (no database yet, no completed run, or a pre-migration --run-id)"),
  })
  .describe("Emitted instead of a report when there is no database yet, no completed reportable run exists, or --run-id names a pre-migration run");

export type Report = z.infer<typeof reportSchema>;
