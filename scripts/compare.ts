// compare.ts — deterministic run-to-run diff of usage sites, computed from SQLite ALONE (the
// §7 report's run-history counterpart). Entry point:
//   bun run scripts/compare.ts <runIdA> <runIdB> [--config <path>] [--help]
// Both runs must be status='completed' with non-empty tracked_packages; anything less renders a
// {"notComparable":…} notice on the stdout JSONL contract and exits 0 (consumers branch on the
// parsed field, not the exit code — the runReport precedent).
//
// Semantics (default-branch headline rule):
// - Each run's slice is usage_findings joined through the IMMUTABLE run_unit_head snapshot
//   (run_id = that run, a reportable head status — REPORTABLE_UNIT_STATUSES, matching
//   org/repo/branch/commit_sha — report.ts's join, NEVER findings.run_id) filtered to THAT run's
//   tracked_packages.
// - A usage site is keyed by (org, repo, branch, usage_type, export_name, file_path,
//   line_number, context). commit_sha is deliberately EXCLUDED — heads advance between runs, and
//   a site that merely moved commits is not a change. branch is deliberately INCLUDED.
// - Headline summary counts (usageSitesAdded/Removed, reposEntering/Leaving) count ONLY
//   sites/repos whose unit head has is_default_branch=1 in the RESPECTIVE run (B for
//   added/entering, A for removed/leaving); non-default sites stay visible in the detail arrays
//   with their tri-state flag. If EITHER run carries any NULL flag (pre-v3 rows), the headline
//   falls back to counting ALL branches — never a silent undercount — and says so in `note`.
// - Detail arrays are capped at COMPARE_DETAIL_CAP per package per direction; the summary keeps
//   the honest uncapped totals. Every array has a stable explicit sort, no wall clock and no env
//   reads touch the output, so same DB + same args → same bytes.

import { existsSync } from "node:fs";
import { loadConfig, type Config } from "./config.ts";
import { AuditDb, REPORTABLE_UNIT_STATUSES, type AuditDbReader, type PolicyStatus, type RunRecord } from "./db.ts";
import { isPolicyExcluded, isDefaultOverride, assertRunUnitHeadSound, policyStatusOrThrow } from "./policyDisposition.ts";
import { ArgsError, assertRunId } from "./args.ts";
import { renderFatal } from "./cliErrors.ts";

// The reportable-head SQL fragment (`'scanned', 'reused'`), from the db.ts source of truth so this
// run-to-run diff's scanned-slice stays in lockstep with report.ts/export.ts (a reused skip-as-
// current unit carries a CURRENT head). Fixed enum literals → injection-safe.
const REPORTABLE_HEAD_SQL = REPORTABLE_UNIT_STATUSES.map((s) => `'${s}'`).join(", ");

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Evidence cap per package per direction (added/removed detail arrays only — the summary
// counts and totals are never capped).
export const COMPARE_DETAIL_CAP = 200;

const INCOMPLETE_NOTE = "default-branch attribution unknown for pre-v3 run(s); headline counts include all branches";

// ---- usage / help text ------------------------------------------------------------------------
export const COMPARE_USAGE =
  "Usage: bun run scripts/compare.ts <runIdA> <runIdB> [--config <path>] [--help]";

export const COMPARE_HELP = `package-audit compare — deterministic run-to-run usage diff from SQLite alone

${COMPARE_USAGE}

Arguments:
  <runIdA> <runIdB>   Two COMPLETED run ids; the diff reads B relative to A (added = in B only).

Flags:
  --config <path>     Config file to load (for sqlitePath). Config path precedence: --config <path> > CONFIG_PATH env > ./config.json
  --help, -h          Show this help and exit.

Output: ONE JSON line on stdout ({"compare":…} or {"notComparable":…}); a human-readable summary
goes to stderr. Note: \`--fresh\` erases run history — runs from before a --fresh cannot be
compared.`;

// ---- argument parsing (local — args.ts owns only the orchestrate/report grammars) --------------
export interface CompareArgs {
  readonly configPath: string | null; // explicit --config; null → resolve via env/default in config.ts
  readonly runIdA: string | null; // both non-null whenever help is false (the parser enforces it)
  readonly runIdB: string | null;
  readonly help: boolean;
}

// ArgsError (not a new class) so renderFatal appends the usage synopsis and the cliErrors
// registry meta-test stays satisfied without a registry edit.
function failArgs(msg: string): never {
  throw new ArgsError(msg);
}

// Strict parser: exactly two positional run ids, --config in detached/attached form, unknown
// flags rejected. `--help`/`-h` anywhere wins (checked first, so a malformed command line can
// still reach the help text — the args.ts convention).
export function parseCompareArgs(argv: string[]): CompareArgs {
  if (argv.some((a) => a === "--help" || a === "-h")) return { configPath: null, runIdA: null, runIdB: null, help: true };

  let configPath: string | null = null;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--config" || arg.startsWith("--config=")) {
      const attached = arg.startsWith("--config=") ? arg.slice("--config=".length) : null;
      const value = attached !== null ? attached : argv[i + 1];
      // A detached value that looks like a flag is a MISSING value (`--config --fresh` must not
      // swallow `--fresh` as the path); the attached form stays available for '-' paths.
      if (value === undefined || value === "" || (attached === null && value.startsWith("-")))
        failArgs("--config requires a value");
      if (configPath !== null) failArgs("--config given more than once");
      configPath = value;
      if (attached === null) i++;
      continue;
    }
    if (arg.startsWith("-")) failArgs(`unknown argument '${arg}'`);
    positionals.push(arg);
  }
  if (positionals.length !== 2) failArgs(`expected exactly two run ids, got ${positionals.length}`);
  return { configPath, runIdA: assertRunId(positionals[0]!), runIdB: assertRunId(positionals[1]!), help: false };
}

// ---- emitted shapes -----------------------------------------------------------------------------
export interface CompareRunInfo {
  runId: string;
  startedAt: string;
  completedAt: string | null;
}

export interface CompareSiteEntry {
  organization: string;
  repository: string;
  branch: string;
  isDefaultBranch: boolean | null; // tri-state from the RESPECTIVE run's head (null = pre-v3 unknown)
  usageType: string;
  exportName: string;
  filePath: string;
  lineNumber: number;
  context: string;
  permalink: string; // evidence from run B for added, run A for removed
  snippet: string;
}

export interface CompareRepoEntry {
  organization: string;
  repository: string;
}

export interface ComparePackageSummary {
  usageSitesAdded: number;
  usageSitesRemoved: number;
  reposEntering: number;
  reposLeaving: number;
  addedTotal: number; // honest all-branch totals — the caps below never touch these
  removedTotal: number;
  detailCapped?: true; // present only when a detail array exceeded COMPARE_DETAIL_CAP
  defaultBranchDataIncomplete?: true; // present only under the pre-v3 NULL-flag fallback
  note?: string;
}

export interface ComparePackage {
  name: string;
  summary: ComparePackageSummary;
  added: CompareSiteEntry[];
  removed: CompareSiteEntry[];
  reposEntering: CompareRepoEntry[];
  reposLeaving: CompareRepoEntry[];
}

// Branch allow/deny compare-format version — INDEPENDENT of XRAY_FORMAT_VERSION (a compare-only shape
// change bumps only this). v2 adds the top-level policyChurn dimension.
export const COMPARE_FORMAT_VERSION = 2 as const;

// One branch's policy disposition on each side of the compare (§5). Present in exactly one churn category.
export interface PolicyChurnEntry {
  readonly organization: string;
  readonly repository: string;
  readonly branch: string;
  readonly runA: PolicyBranchState;
  readonly runB: PolicyBranchState;
}
// The top-level policy-churn dimension. `available:false` when EITHER run predates v4 (a migration-null
// scanned_commit_date = unknown policy provenance; a naive diff would fabricate churn). Only branch
// keys present in BOTH runs are classified; one-sided keys are counted, never churned.
export type PolicyChurn =
  // "pre-v4-policy-data": a run MIGRATED from before v4 (a NULL scanned_commit_date sentinel) — its policy
  // provenance is unknowable. "no-recorded-heads": a run that recorded no heads at all; it may be perfectly
  // native-v4, so it must NOT be labelled pre-v4 — there is simply nothing to compare.
  | { readonly available: false; readonly reason: "pre-v4-policy-data" | "no-recorded-heads" }
  | {
      readonly available: true;
      readonly summary: {
        readonly branchesCompared: number;
        readonly branchesOnlyInRunA: number;
        readonly branchesOnlyInRunB: number;
        readonly enteredExclusion: number;
        readonly leftExclusion: number;
        readonly reclassifiedExclusion: number;
        readonly defaultOverrideChanges: number;
        readonly detailCapped?: true; // any category's detail array truncated to COMPARE_DETAIL_CAP (totals stay full)
      };
      readonly enteredExclusion: readonly PolicyChurnEntry[]; // policy went from not-applied → applied
      readonly leftExclusion: readonly PolicyChurnEntry[]; //    applied → not-applied
      readonly reclassifiedExclusion: readonly PolicyChurnEntry[]; // applied both sides, deny/allow|pattern changed
      readonly defaultOverrideChanges: readonly PolicyChurnEntry[]; // not applied either side, counterfactual changed
    };

export interface CompareEnvelope {
  compare: {
    formatVersion: typeof COMPARE_FORMAT_VERSION;
    runA: CompareRunInfo;
    runB: CompareRunInfo;
    packages: ComparePackage[];
    policyChurn: PolicyChurn;
  };
}

// Two branch states share the same policy ATTRIBUTION iff both the policy_status
// (excluded-by-deny / excluded-by-allow / null) and the causing pattern match. Deliberately does NOT
// compare the row's `status` column (scanned / skipped-cutoff / policy-excluded / past-cap): the callers have already
// established the disposition via policyApplied/defaultOverride, and this answers the narrower
// question "did the policy verdict itself change" — e.g. a branch re-classified from allow-miss to an
// explicit deny, or a deny whose causing pattern was renamed.
function policyStateEq(a: PolicyBranchState, b: PolicyBranchState): boolean {
  return a.policyStatus === b.policyStatus && a.policyMatchedPattern === b.policyMatchedPattern;
}

// Classify per-branch policy churn between two run slices. Compares only branch keys present in BOTH
// runs (a branch absent from one run cannot be "entering/leaving" exclusion — absence has many causes).
function buildPolicyChurn(a: RunSlice, b: RunSlice): PolicyChurn {
  // A pre-v4 gap on EITHER side wins over a mere empty-run gap: it is the more specific (and more
  // actionable) explanation for why policy churn cannot be computed.
  const gap = a.policyProvenanceGap === "pre-v4-policy-data" || b.policyProvenanceGap === "pre-v4-policy-data"
    ? "pre-v4-policy-data"
    : (a.policyProvenanceGap ?? b.policyProvenanceGap);
  if (gap !== null) return { available: false, reason: gap };
  const entered: PolicyChurnEntry[] = [], left: PolicyChurnEntry[] = [];
  const reclassified: PolicyChurnEntry[] = [], overrideChanges: PolicyChurnEntry[] = [];
  let onlyA = 0, onlyB = 0, compared = 0;
  for (const key of b.policyByBranch.keys()) if (!a.policyByBranch.has(key)) onlyB++;
  for (const [key, sa] of a.policyByBranch) {
    const sb = b.policyByBranch.get(key);
    if (sb === undefined) { onlyA++; continue; }
    compared++;
    const parts = key.split("\0");
    const entry: PolicyChurnEntry = { organization: parts[0]!, repository: parts[1]!, branch: parts[2]!, runA: sa, runB: sb };
    if (!sa.policyApplied && sb.policyApplied) entered.push(entry);
    else if (sa.policyApplied && !sb.policyApplied) left.push(entry);
    else if (sa.policyApplied && sb.policyApplied) { if (!policyStateEq(sa, sb)) reclassified.push(entry); }
    else if (!policyStateEq(sa, sb)) overrideChanges.push(entry); // neither applied, but counterfactual changed
  }
  const sortE = (arr: PolicyChurnEntry[]): PolicyChurnEntry[] =>
    arr.sort((x, y) => cmp(x.organization, y.organization) || cmp(x.repository, y.repository) || cmp(x.branch, y.branch));
  // Sort BEFORE capping; per-category cap so one category can't consume another's allowance; the
  // summary totals stay UNCAPPED (honest), the detail arrays are truncated.
  const enteredFull = sortE(entered), leftFull = sortE(left), reclassFull = sortE(reclassified), overrideFull = sortE(overrideChanges);
  const cap = COMPARE_DETAIL_CAP;
  const detailCapped =
    enteredFull.length > cap || leftFull.length > cap || reclassFull.length > cap || overrideFull.length > cap;
  return {
    available: true,
    summary: {
      branchesCompared: compared, branchesOnlyInRunA: onlyA, branchesOnlyInRunB: onlyB,
      enteredExclusion: enteredFull.length, leftExclusion: leftFull.length,
      reclassifiedExclusion: reclassFull.length, defaultOverrideChanges: overrideFull.length,
      ...(detailCapped ? { detailCapped: true as const } : {}),
    },
    enteredExclusion: enteredFull.slice(0, cap),
    leftExclusion: leftFull.slice(0, cap),
    reclassifiedExclusion: reclassFull.slice(0, cap),
    defaultOverrideChanges: overrideFull.slice(0, cap),
  };
}

// ---- diff construction ---------------------------------------------------------------------------
interface UsageRowDb {
  organization: string; repository: string; branch: string; commit_sha: string;
  package_name: string; usage_type: string; export_name: string; context: string;
  file_path: string; line_number: number; permalink: string; snippet: string;
}
interface HeadRow {
  organization: string; repository: string; branch: string; commit_sha: string; status: string;
  is_default_branch: number | null; // 1/0/NULL — NULL = unknown (pre-v3 run rows)
  policy_status: string | null; // branch allow/deny (§5) — 'excluded-by-deny' | 'excluded-by-allow' | NULL
  policy_matched_pattern: string | null;
  scanned_commit_date: string | null; // NULL only for pre-v4 migrated rows → unknown policy provenance
}

function unitKey(o: string, r: string, b: string, c: string): string {
  return `${o}\0${r}\0${b}\0${c}`;
}

// The compare site key: commit_sha excluded (moved-commit ≠ change), dependency_key excluded
// (an alias re-declaration of the same physical site is not a usage change), branch included.
function siteKey(r: UsageRowDb): string {
  return [r.organization, r.repository, r.branch, r.usage_type, r.export_name, r.file_path, String(r.line_number), r.context].join("\0");
}

// The per-branch policy disposition state used by policy churn (keyed by org/repo/branch, NOT commit —
// churn tracks a branch's policy across runs regardless of the commit it pointed at).
interface PolicyBranchState {
  readonly status: string;
  readonly isDefaultBranch: boolean | null;
  // The CLOSED set, not a bare string: every value here is checked by policyStatusOrThrow at
  // construction, so the churn entries this feeds cannot carry a literal outside db.ts's union.
  readonly policyStatus: PolicyStatus | null;
  readonly policyMatchedPattern: string | null;
  readonly policyApplied: boolean; // isPolicyExcluded — actually dropped by policy
  readonly defaultOverride: boolean; // isDefaultOverride — scanned default carrying the counterfactual
}

interface RunSlice {
  byPackage: Map<string, Map<string, UsageRowDb>>; // package → siteKey → representative row
  flags: Map<string, boolean | null>; // unitKey → tri-state default-branch flag (scanned heads)
  hasNullFlag: boolean; // ANY head row of the run with is_default_branch NULL (pre-v3)
  policyByBranch: Map<string, PolicyBranchState>; // (org\0repo\0branch) → policy disposition (policy churn)
  policyProvenanceGap: "pre-v4-policy-data" | "no-recorded-heads" | null; // why churn is unavailable; null = provenance sound
}

function loadRunSlice(db: AuditDbReader, run: RunRecord): RunSlice {
  const heads = db.read(
    `SELECT organization, repository, branch, commit_sha, status, is_default_branch, policy_status, policy_matched_pattern, scanned_commit_date FROM run_unit_head WHERE run_id = ?`,
  ).all(run.runId) as HeadRow[];
  const hasNullFlag = heads.some((h) => h.is_default_branch === null);
  // No positive v4 policy provenance, and the two causes are DISTINCT: a migrated pre-v4 run (the NULL
  // scanned_commit_date sentinel) vs a run with ZERO heads (e.g. all branch discovery failed) — the empty
  // case carries no sentinel row at all, so `.some()` alone would falsely report provenance as present,
  // and calling it "pre-v4" would misstate the schema of a perfectly native-v4 empty run.
  const policyProvenanceGap: "pre-v4-policy-data" | "no-recorded-heads" | null =
    heads.some((h) => h.scanned_commit_date === null)
      ? "pre-v4-policy-data"
      : heads.length === 0
        ? "no-recorded-heads"
        : null;
  const flags = new Map<string, boolean | null>(
    heads
      .filter((h) => (REPORTABLE_UNIT_STATUSES as readonly string[]).includes(h.status))
      .map((h) => [unitKey(h.organization, h.repository, h.branch, h.commit_sha), h.is_default_branch === null ? null : h.is_default_branch === 1]),
  );
  const policyByBranch = new Map<string, PolicyBranchState>(
    heads.map((h) => {
      // Fail closed on a policy-bearing row that is neither an exclusion nor a default override — the
      // same guard the report's scan-scope ledger applies, from the same shared definition. Without it
      // such a row gets policyApplied=false + defaultOverride=false, i.e. exactly the shape of an
      // ordinary unrestricted branch, and buildPolicyChurn's final else-branch would file it under
      // defaultOverrideChanges ("neither applied, but the counterfactual changed") — laundering a
      // malformed disposition into a plausible-looking churn entry.
      const where = `${h.organization}/${h.repository}@${h.branch}`;
      assertRunUnitHeadSound(h, where);
      return [
        `${h.organization}\0${h.repository}\0${h.branch}`,
        {
          status: h.status,
          isDefaultBranch: h.is_default_branch === null ? null : h.is_default_branch === 1,
          // The guard above settles the row's SHAPE and stops there; this settles the LITERAL, which
          // churn compares (policyStateEq) and emits. Null stays null and is checked no further — an
          // unrestricted branch is the common case, and only a policy-BEARING row makes a claim.
          policyStatus: h.policy_status === null ? null : policyStatusOrThrow(h, where),
          policyMatchedPattern: h.policy_matched_pattern,
          policyApplied: isPolicyExcluded(h),
          defaultOverride: isDefaultOverride(h),
        },
      ];
    }),
  );

  // The run-scoped slice: findings joined through the immutable snapshot (report.ts's join),
  // filtered to THIS run's tracked_packages. dependency_key is intentionally not selected — it
  // is outside the site key.
  const rows = db.read(
    `SELECT uf.organization, uf.repository, uf.branch, uf.commit_sha, uf.package_name,
            uf.usage_type, uf.export_name, uf.context, uf.file_path, uf.line_number,
            uf.permalink, uf.snippet
     FROM usage_findings uf
     JOIN run_unit_head ruh ON ruh.run_id = ? AND ruh.status IN (${REPORTABLE_HEAD_SQL})
       AND ruh.organization=uf.organization AND ruh.repository=uf.repository
       AND ruh.branch=uf.branch AND ruh.commit_sha=uf.commit_sha
     WHERE uf.package_name IN (SELECT value FROM json_each(?))`,
  ).all(run.runId, JSON.stringify(run.trackedPackages)) as UsageRowDb[];

  // Deterministic dedupe: multiple dependency_key declarations can share one site key, so sort
  // first (SQL row order is not guaranteed) and let the first row win the Map slot.
  rows.sort(
    (a, b) =>
      cmp(a.organization, b.organization) || cmp(a.repository, b.repository) || cmp(a.branch, b.branch) ||
      cmp(a.file_path, b.file_path) || a.line_number - b.line_number || cmp(a.usage_type, b.usage_type) ||
      cmp(a.export_name, b.export_name) || cmp(a.context, b.context) ||
      cmp(a.permalink, b.permalink) || cmp(a.snippet, b.snippet),
  );
  const byPackage = new Map<string, Map<string, UsageRowDb>>();
  for (const row of rows) {
    let sites = byPackage.get(row.package_name);
    if (sites === undefined) {
      sites = new Map<string, UsageRowDb>();
      byPackage.set(row.package_name, sites);
    }
    const key = siteKey(row);
    if (!sites.has(key)) sites.set(key, row);
  }
  return { byPackage, flags, hasNullFlag, policyByBranch, policyProvenanceGap };
}

const EMPTY_SITES: ReadonlyMap<string, UsageRowDb> = new Map();

function toEntry(row: UsageRowDb, flags: Map<string, boolean | null>): CompareSiteEntry {
  return {
    organization: row.organization,
    repository: row.repository,
    branch: row.branch,
    isDefaultBranch: flags.get(unitKey(row.organization, row.repository, row.branch, row.commit_sha)) ?? null,
    usageType: row.usage_type,
    exportName: row.export_name,
    filePath: row.file_path,
    lineNumber: row.line_number,
    context: row.context,
    permalink: row.permalink,
    snippet: row.snippet,
  };
}

const entryCmp = (a: CompareSiteEntry, b: CompareSiteEntry): number =>
  cmp(a.organization, b.organization) || cmp(a.repository, b.repository) || cmp(a.branch, b.branch) ||
  cmp(a.filePath, b.filePath) || a.lineNumber - b.lineNumber || cmp(a.usageType, b.usageType) ||
  cmp(a.exportName, b.exportName) || cmp(a.context, b.context);

// Repos with ≥1 in-scope usage site of the package in this slice. Scope = default-branch sites
// only (the default-branch headline rule), widened to all branches under the pre-v3 fallback.
function scopedRepos(sites: ReadonlyMap<string, UsageRowDb>, flags: Map<string, boolean | null>, incomplete: boolean): Map<string, CompareRepoEntry> {
  const repos = new Map<string, CompareRepoEntry>();
  for (const row of sites.values()) {
    const flag = flags.get(unitKey(row.organization, row.repository, row.branch, row.commit_sha)) ?? null;
    if (!incomplete && flag !== true) continue;
    const key = `${row.organization}\0${row.repository}`;
    if (!repos.has(key)) repos.set(key, { organization: row.organization, repository: row.repository });
  }
  return repos;
}

function buildPackageDiff(name: string, a: RunSlice, b: RunSlice, incomplete: boolean): ComparePackage {
  const sitesA = a.byPackage.get(name) ?? EMPTY_SITES;
  const sitesB = b.byPackage.get(name) ?? EMPTY_SITES;

  const added: CompareSiteEntry[] = [];
  for (const [key, row] of sitesB) if (!sitesA.has(key)) added.push(toEntry(row, b.flags));
  const removed: CompareSiteEntry[] = [];
  for (const [key, row] of sitesA) if (!sitesB.has(key)) removed.push(toEntry(row, a.flags));
  added.sort(entryCmp);
  removed.sort(entryCmp);

  // Headline counts run over the FULL diff (before capping): default-branch sites only, or all
  // branches under the fallback (never silently undercount).
  const headline = (entries: CompareSiteEntry[]): number =>
    incomplete ? entries.length : entries.filter((e) => e.isDefaultBranch === true).length;
  const addedTotal = added.length;
  const removedTotal = removed.length;

  const reposA = scopedRepos(sitesA, a.flags, incomplete);
  const reposB = scopedRepos(sitesB, b.flags, incomplete);
  const repoCmp = (x: CompareRepoEntry, y: CompareRepoEntry): number => cmp(x.organization, y.organization) || cmp(x.repository, y.repository);
  const reposEntering = [...reposB].filter(([key]) => !reposA.has(key)).map(([, repo]) => repo).sort(repoCmp);
  const reposLeaving = [...reposA].filter(([key]) => !reposB.has(key)).map(([, repo]) => repo).sort(repoCmp);

  const capped = addedTotal > COMPARE_DETAIL_CAP || removedTotal > COMPARE_DETAIL_CAP;
  return {
    name,
    summary: {
      usageSitesAdded: headline(added),
      usageSitesRemoved: headline(removed),
      reposEntering: reposEntering.length,
      reposLeaving: reposLeaving.length,
      addedTotal,
      removedTotal,
      ...(capped ? { detailCapped: true as const } : {}),
      ...(incomplete ? { defaultBranchDataIncomplete: true as const, note: INCOMPLETE_NOTE } : {}),
    },
    added: added.slice(0, COMPARE_DETAIL_CAP),
    removed: removed.slice(0, COMPARE_DETAIL_CAP),
    reposEntering,
    reposLeaving,
  };
}

// Build the whole diff for two runs from SQLite alone. ONE deferred read transaction so the
// multiple statements see a single coherent snapshot even while a live audit commits (the
// buildReport precedent).
export function buildCompare(db: AuditDbReader, runA: RunRecord, runB: RunRecord): CompareEnvelope {
  return db.readTransaction(() => {
    const a = loadRunSlice(db, runA);
    const b = loadRunSlice(db, runB);
    const incomplete = a.hasNullFlag || b.hasNullFlag;
    const runInfo = (run: RunRecord): CompareRunInfo => ({ runId: run.runId, startedAt: run.startedAt, completedAt: run.completedAt });
    const names = [...new Set([...runA.trackedPackages, ...runB.trackedPackages])].sort(cmp);
    return {
      compare: {
        formatVersion: COMPARE_FORMAT_VERSION,
        runA: runInfo(runA),
        runB: runInfo(runB),
        packages: names.map((name) => buildPackageDiff(name, a, b, incomplete)),
        policyChurn: buildPolicyChurn(a, b),
      },
    };
  });
}

// ---- notices + entry flow -----------------------------------------------------------------------
export type NotComparableCause =
  | { kind: "missing-db"; path: string }
  | { kind: "missing-run"; runId: string }
  | { kind: "not-completed"; runId: string; status: string };

// Exported so tests validate the REAL emitted objects (the buildNotReportableNotice precedent).
export function buildNotComparableNotice(cause: NotComparableCause): { notComparable: true; reason: string } {
  switch (cause.kind) {
    case "missing-db":
      return { notComparable: true, reason: `no database at ${cause.path} — run \`bun run audit\` first` };
    case "missing-run":
      // An id can vanish legitimately: --fresh drops the runs table, so pre-`--fresh` runs are gone.
      return {
        notComparable: true,
        reason: `run ${cause.runId} not found or pre-migration (empty tracked_packages) — note: \`--fresh\` erases run history; runs from before a --fresh cannot be compared`,
      };
    case "not-completed":
      return { notComparable: true, reason: `run ${cause.runId} is not completed (status: ${cause.status}) — only completed runs can be compared` };
  }
}

// §8-style human summary, stderr only — stdout stays pure JSONL (the runSummaryText precedent).
export function compareSummaryText(result: CompareEnvelope): string {
  const c = result.compare;
  const lines = ["", `COMPARE — run ${c.runA.runId} → run ${c.runB.runId}`];
  for (const p of c.packages) {
    const s = p.summary;
    lines.push(
      `  ${p.name}: +${s.usageSitesAdded}/-${s.usageSitesRemoved} default-branch usage sites, ` +
        `${s.reposEntering} repo(s) entering, ${s.reposLeaving} leaving ` +
        `(all branches: ${s.addedTotal} added, ${s.removedTotal} removed${s.detailCapped === true ? `; detail capped at ${COMPARE_DETAIL_CAP}` : ""})`,
    );
    if (s.note !== undefined) lines.push(`    note: ${s.note}`);
  }
  lines.push("");
  return lines.join("\n");
}

// The compare flow minus argv/config parsing (main() wires those in) — the runReport seam.
// Returns the exact line main() writes to stdout. Guards mirror runReport: a missing database
// short-circuits BEFORE openReadOnly with zero filesystem effect; every notice is a well-formed
// exit-0 answer on the stdout JSONL contract. The success path writes the human summary to
// stderr HERE (not in main) so every caller of the seam keeps the stdout/stderr split.
export function runCompare(config: Config, runIdA: string, runIdB: string): { line: string } {
  const sqlitePath = config.paths.sqlitePath;
  // :memory: folds into the missing-db notice: a fresh in-memory database can never hold two
  // completed runs, and openReadOnly rightly refuses to open one.
  if (sqlitePath === ":memory:" || !existsSync(sqlitePath))
    return { line: `${JSON.stringify(buildNotComparableNotice({ kind: "missing-db", path: sqlitePath }))}\n` };

  // Pure READ — openReadOnly can never create, migrate, or write the database.
  const db = AuditDb.openReadOnly({ sqlitePath });
  try {
    const entries: Array<readonly [string, RunRecord | null]> = [
      [runIdA, db.getRun(runIdA)],
      [runIdB, db.getRun(runIdB)],
    ];
    // Two-phase (all missing-run checks before all not-completed checks — the error precedence the
    // notices/tests expect), but collect the narrowed runs into `loaded` so the second phase and the
    // buildCompare call carry NO cross-loop `run!` assertion: `run` here is a RunRecord, not
    // RunRecord|null, so a future edit can't silently reintroduce a null deref.
    const loaded: Array<[string, RunRecord]> = [];
    for (const [id, run] of entries) {
      if (run === null || run.trackedPackages.length === 0)
        return { line: `${JSON.stringify(buildNotComparableNotice({ kind: "missing-run", runId: id }))}\n` };
      loaded.push([id, run]);
    }
    for (const [id, run] of loaded)
      if (run.status !== "completed")
        return { line: `${JSON.stringify(buildNotComparableNotice({ kind: "not-completed", runId: id, status: run.status }))}\n` };

    const result = buildCompare(db, loaded[0]![1], loaded[1]![1]);
    process.stderr.write(compareSummaryText(result));
    return { line: `${JSON.stringify(result)}\n` };
  } finally {
    db.close();
  }
}

// ---- entry point ----------------------------------------------------------------------------
// argv is injectable (defaulting to the process argv) so tests drive the REAL dispatch — help
// short-circuit before config/DB, runCompare wiring — in-process (the report.ts precedent).
export async function main(argv: string[] = Bun.argv.slice(2)): Promise<void> {
  const cargs = parseCompareArgs(argv); // strict: unknown flags / wrong positional counts rejected
  if (cargs.help) {
    process.stdout.write(COMPARE_HELP + "\n");
    return;
  }
  const { config } = await loadConfig(argv);
  process.stdout.write(runCompare(config, cargs.runIdA!, cargs.runIdB!).line);
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(renderFatal(e, { command: "compare", usage: COMPARE_USAGE }));
    process.exit(1);
  });
}
