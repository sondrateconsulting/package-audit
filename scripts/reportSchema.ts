// reportSchema.ts — the authoritative, machine-checkable shape of the §7 report
// (run-<run_id>.json / latest.json). Every field carries a .describe() so this module doubles as
// the report's reference documentation; every object is .strict() so shape drift fails loudly.
// Validation runs in TESTS (report.test.ts), never in the emit path — a schema bug must not be
// able to fail a completed scan's report write (§7 determinism).
//
// DEPENDENCY JUSTIFICATION (§6 — minimize deps): zod is one of the repo's two devDependencies
// (with `@types/bun`) — test-only (`typescript`, used for .d.ts AST parsing, is the sole runtime dep).
// Justification: a schema-as-docs contract for the report consumed by downstream tooling, with
// validation errors that name the failing path — hand-rolling that (or maintaining prose docs
// against a moving shape) is strictly worse. zod v4 is dependency-free and pinned exactly.

import { z } from "zod";
// Type-only import — zero runtime coupling: the emit path never touches this module, and this
// module never touches the DB: the enum literals below are pinned to db.ts's unions at compile
// time, so a new/renamed member on either side fails `bun run typecheck` instead of drifting.
import type { ExportKind, RunOutcome, UsageType } from "./db.ts";
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

// The run's finalized outcome (§3.1b). Pinned to db.ts's RunOutcome union (all seven members — no
// exclusions) so a new/renamed outcome fails typecheck here. The report carries it verbatim.
export const runOutcomeEnumSchema = z
  .enum(["complete", "partial-deferred", "partial-degraded", "partial-budget", "fatal", "legacy-unknown", "legacy-failed"])
  .describe("runs.outcome — the run's coverage disposition");

// Bidirectional compile-time sync with db.ts (report enums = DB unions minus the CLI members,
// which surface via cliUsage / cli.binNames instead; runOutcome is the FULL union). Equal<> fails
// in BOTH drift directions.
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
export type UsageEnumSyncedWithDb = Expect<Equal<(typeof usageTypeSchema.options)[number], Exclude<UsageType, "cli">>>;
export type ExportEnumSyncedWithDb = Expect<Equal<(typeof exportKindSchema.options)[number], Exclude<ExportKind, "cli-bin">>>;
export type RunOutcomeEnumSyncedWithDb = Expect<Equal<(typeof runOutcomeEnumSchema.options)[number], RunOutcome>>;

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
    branchesScanned: z.number().int().min(0).describe("run_unit_head rows with a REPORTABLE status (scanned + reused/skip-as-current) — the findings-bearing slice; includes scanned default-override units"),
    branchesSkippedByCutoff: z.number().int().min(0).describe("GENUINE cutoff skips: run_unit_head rows with status='skipped-cutoff' (a policy exclusion is its own status, never counted here)"),
    branchesExcludedByPolicy: z.number().int().min(0).describe("Branch allow/deny exclusions: run_unit_head rows with status='policy-excluded'"),
    branchesPastCap: z.number().int().min(0).describe("Eligible branches past the per-repo cap (not scanned this run)"),
    branchesErrored: z.number().int().min(0).describe("DISTINCT branches whose scan FAILED this run — the UNION of two DISJOINT sets: (a) error-status run_unit_head heads (a permanent scan failure recorded at the observed commit when no prior reportable scan protected the head), and (b) branches carrying a scope='scan' errors[] entry that hold NO run_unit_head row (a failure BEFORE any disposition: discovery-time, or a resume whose earlier invocation errored before a row). An error head IS a row, so it is excluded from (b) — the two never double-count. A branch with a SCANNED row PLUS a scope='scan' errors[] entry (a post-persistence write throwing after the scanned row committed, OR a moved-head re-scan failure whose findings-preservation guard kept the prior scan) counts under branchesScanned, not here. A THROTTLE/network/service DEFERRAL is NOT a failure — un-covered, surfaced via runOutcome, excluded here. On a RESUMED run, (b) diverges from 'every branch whose scan errored' in BOTH directions: an earlier invocation's rowless error persists (errors[] is append-only — its one reconciliation is the excluded-owner prune) while rows are pruned/superseded"),
    totalDependencyFindings: z.number().int().min(0),
    totalUsageFindings: z.number().int().min(0),
  })
  .describe("Per-run disposition counts + finding totals, from the immutable run_unit_head snapshot. scanned + skippedByCutoff + excludedByPolicy + pastCap + errored account for every branch that reached a TERMINAL outcome this run (errored = error-status heads + rowless scan errors; see branchesErrored) — an EQUALITY on a single-invocation run, and an UPPER BOUND on a resumed run, where an earlier invocation's rowless error persists in errored even when the final invocation recorded NO row for it (the branch is now gone or unvisited; errors[] is append-only bar the excluded-owner prune, rows are pruned/superseded). A DEFERRED branch (deferred-throttle/network/service) is NOT terminal — un-covered, finished on a later run; it floors the run to partial-deferred (via a deferred-* row, or coverage_complete=0 when the deferral was preserved over a prior scan) and appears in no terminal count of its own — though a deferral PRESERVED over a prior scan is still counted in branchesScanned via that retained scan");

export const policyBranchSchema = z.strictObject({
  organization: z.string(),
  repository: z.string(),
  branch: z.string(),
  disposition: z.enum(["excluded", "scanned-default-override", "attempted-default-override"]),
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

// §3.1b run coverage — a top-level block (NOT in summary) so a consumer can see, at a glance,
// whether the run covered the whole estate and, if not, what was deferred or failed. `units` counts
// every run_unit_head disposition in a FIXED key order so the emitted JSON stays byte-reproducible.
export const runOutcomeSchema = z
  .strictObject({
    outcome: runOutcomeEnumSchema.describe("runs.outcome — always present: an unfinalized run (outcome NULL) is served as notReportable, never as a report"),
    coverageComplete: z.boolean().nullable().describe("Did this run cover the whole estate: true=full, false=a coverage gap (a discovery gap OR a unit-level deferral — incl. a deferral preserved over a prior scan, which writes no deferred-* row), null=unknowable (migrated pre-v5 run — the column was added at schema v5)"),
    discoveryFailures: z.number().int().min(0).describe("Permanent owner/repo/branch discovery failures this run (each makes the denominator unknown)"),
    discoveryDeferrals: z.number().int().min(0).describe("Discovery enumerations deferred by rate-limiting this run (re-run to complete)"),
    units: z
      .strictObject({
        scanned: z.number().int().min(0).describe("Freshly scanned this run"),
        reused: z.number().int().min(0).describe("Skip-as-current: unchanged head, findings reused from the prior scan"),
        skippedCutoff: z.number().int().min(0).describe("Head predates cutoffDate — intentionally not scanned"),
        policyExcluded: z.number().int().min(0).describe("Dropped by the branch allow/deny policy (§5)"),
        pastCap: z.number().int().min(0).describe("Eligible branch past the per-repo cap — not scanned this run"),
        deferredThrottle: z.number().int().min(0).describe("Deferred by rate-limiting — re-run to finish"),
        deferredNetwork: z.number().int().min(0).describe("Deferred by a transport outage — re-run to finish"),
        deferredService: z.number().int().min(0).describe("Deferred by a GitHub service failure — re-run to finish"),
        error: z.number().int().min(0).describe("A permanent, terminal scan error (a covered, real result)"),
      })
      .describe("Per-run unit disposition counts from run_unit_head, in fixed enum order (byte-determinism)"),
  })
  .describe("§3.1 run coverage disposition — did this run cover the whole estate, and if not, what is outstanding");

export const reportSchema = z
  .strictObject({
    formatVersion: z.literal(XRAY_FORMAT_VERSION).describe("XRAY_FORMAT_VERSION — the report/export/HTML artifact-set version; PINNED so this schema is a true shape discriminator"),
    runId: z.string().describe("The reported run's identifier (report --run-id <id> re-emits it)"),
    generatedAt: isoUtc.describe("completed_at of the run (started_at fallback for a --run-id report of a non-completed run)"),
    runOutcome: runOutcomeSchema,
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
