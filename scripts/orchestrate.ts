// orchestrate.ts — the scan coordinator (§5, §8). Entry point:
//   bun run scripts/orchestrate.ts [--config <path>] [--plan] [--fresh [--purge-cache]] \
//                                  [--rescan-branch <org>/<repo>@<branch>]... [--help]
// Flow (§8): restate config → preflight (§2) → resolve effective owners (§1) → start/resume run
// (§3) → discover repos+branches and process each branch unit (§5.A-H) → reconcile introspection
// (§5.E) → BIN-term CLI pass (§5.G) → mark run completed. ALL SQLite writes happen through the ONE
// AuditDb connection opened here; per-unit reads fan out through the guarded github wrapper.
// Owners and (per repo) branch-units are fanned out through bounded pools (§5, concurrency.*), but
// no mutex is needed: bun:sqlite statements are synchronous and every DB read-modify-write below is
// an await-free block, so concurrent fibers never interleave mid-write and each unit's queue/head/
// finding rows are distinct. The ONE row two units can share — `api_cache` for identical-content
// branches (same SHA-pinned key) — is guarded separately (compare-and-delete tombstone + a
// refuse-to-clobber immutable put, github.ts), not by row distinctness. Determinism (§6) is the
// SAME-DB-SAME-RUN guarantee the spec makes (PROMPT.md: "Completion
// and DB-write order are unconstrained... determinism is guaranteed by sorting every emitted array on a
// TOTAL stable key"): report/export sort every emitted array by a total key, so RE-RENDERING a given
// completed run's DB is byte-identical no matter which fiber wrote each row first. Findings sort by
// CONTENT, so their ORDER is stable ACROSS runs that scanned the same commits (byte-identity is
// same-DB-same-run only — a report/export finding still carries per-run wall-clock fields like
// date_fetched/found_at that differ run-to-run). errors[] does NOT reproduce byte-for-byte across runs
// and is not claimed to: it sorts by the spec-mandated (occurred_at, id) — a chronological event log
// whose order and wall-clock timestamps are inherently per-run (occurred_at is wall-clock, so errors[]
// was never byte-identical across separate runs, fan-out or not; fan-out only changes WHICH order two
// same-instant errors take, exactly as their occurred_at already varied run-to-run).

import { readdirSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { AuditDb, nowIso, type WorkUnitKey } from "./db.ts";
import { GithubClient, GithubApiError, ThrottleExhausted, filterSortCapRepos, type RepoInfo, type BranchSnapshot, type BranchDiscoveryOutcome } from "./github.ts";
import { planRepoBranches, planPolicyDiagnostics, policyAttribution, type BranchDecision } from "./branchPlanner.ts";
import { PolicyMatchError, type CompiledBranchPolicy, type RepoPolicyCoverage } from "./branchPolicy.ts";
import { discovered, discoveryFailed, type DiscoveryOutcome } from "./discovery.ts";
import { computePolicyWarnings, isEmptyAllowlist, policyWarningLines, type PolicyWarning } from "./policyWarnings.ts";
import { assertContained } from "./readOnlyGuard.ts";
import { parseArgs, ORCHESTRATE_HELP, ORCHESTRATE_USAGE, type OrchestrateArgs } from "./args.ts";
import { renderFatal } from "./cliErrors.ts";
import { runPreflight } from "./preflight.ts";
import { resolveEffectiveOwners, type OwnersSource } from "./ownerResolve.ts";
import { scanUnit, type TreeEntry, type UnitLocation } from "./unitPipeline.ts";
import { parseSemver, maxSatisfying } from "./semver.ts";
import { parseAlias, type DependencyType } from "./manifest.ts";
import { introspectVersion, fetchPackument, resolveRangeToVersion, type Packument } from "./apiSurface.ts";
import { emitReportDetailed, type ReportSummary } from "./report.ts";
import type { CliTermSet } from "./cliScanner.ts";
import { boundedPool, Aborter, type AbortLike } from "./boundedPool.ts";
import { logLine } from "./log.ts";

// The three values that TOGETHER define one coherent scan/plan: the config, its hash, and the
// compiled branch policy. Threaded as ONE object through runScan/processOwner/processRepo/runPlan so
// the policy can never be dropped or mismatched against its config.
export interface AuditRuntime {
  readonly config: Config;
  readonly configHash: string;
  readonly branchPolicy: CompiledBranchPolicy;
}

// ---- per-unit read helpers ------------------------------------------------------------------
// API reader: SHA-pinned raw fetch (≤100MB) for blob entries. Non-blobs (submodule/symlink)
// and a 404 return null — the one genuinely-benign miss (the tree listed a path the contents
// API no longer serves, e.g. a force-push race), where skipping the file is correct. EVERY
// other failure RETHROWS: the unit was never fully read, and degrading to null would mark a
// partially-read head `done` (the §3 skip predicate then skips it forever) with its findings
// silently under-reported. A ThrottleExhausted reaches processRepo's requeue catch (§4,
// pending); a fatal GithubApiError (SSO/permission 403, exhausted no-response) lands as a
// visible scan error. SHA-pinned reads are served from api_cache with zero network on re-read.
function apiReader(client: GithubClient, org: string, repo: string, commitSha: string) {
  return async (path: string, entry: TreeEntry): Promise<string | null> => {
    if (entry.type !== "blob") return null;
    try {
      return await client.fetchFileRaw(org, repo, path, commitSha);
    } catch (e) {
      if (e instanceof GithubApiError && e.status === 404) return null;
      throw e;
    }
  };
}

// Clone-fallback reader: read a file from the walked clone dir, contained to that dir. Every failure
// PROPAGATES — unlike apiReader (whose 404→null models a benign force-push race), a file the walk
// just enumerated from a COMPLETED local clone is never legitimately absent, so any read error
// (ENOENT/EACCES/EISDIR/EIO/…) or containment violation means the snapshot was not fully read and
// must surface as a scan error, not degrade to null and mark a partially-read head `done`.
export function cloneReader(cloneDir: string) {
  return async (path: string, _entry: TreeEntry): Promise<string | null> => {
    const abs = join(cloneDir, path);
    assertContained(abs, [cloneDir]);
    return readFileSync(abs, "utf8");
  };
}

// Walk a cloned working tree into TreeEntry rows (blobs only; size from lstat). Skips .git and
// symlinks (never followed). Paths are repo-relative POSIX. A readdir/lstat failure PROPAGATES: on a
// completed clone it means the tree was not fully enumerated, and a silent skip would under-report
// the unit's files as `done` (the same fail-open hazard cloneReader closes on the read side).
export function walkClone(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel === "" ? root : join(root, rel);
    const names = readdirSync(abs);
    for (const name of names) {
      if (rel === "" && name === ".git") continue;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(join(root, childRel));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(childRel);
      else if (st.isFile()) out.push({ path: childRel, type: "blob", sha: "", size: st.size });
    }
  }
  return out;
}

// ---- coordinator ----------------------------------------------------------------------------
// argv is injectable (defaulting to the process argv) so the entrypoint tests can drive the
// REAL dispatch — help short-circuit, --plan's stop-before-DB early return — in-process.
export async function main(argv: string[] = Bun.argv.slice(2)): Promise<void> {
  const args: OrchestrateArgs = parseArgs(argv);
  if (args.help) {
    process.stdout.write(ORCHESTRATE_HELP + "\n");
    return;
  }
  const { config, configHash, branchPolicy } = await loadConfig(argv);
  const runtime: AuditRuntime = { config, configHash, branchPolicy };
  const trackedNames = config.packages.map((p) => p.name);

  logLine({ event: "config", packages: trackedNames, cutoffDate: config.cutoffDate, githubHost: config.githubHost, organizations: config.organizations, fresh: args.fresh, plan: args.plan });
  // §5 configured fan-out widths. Emitted for both audit and --plan; in --plan runPlan traverses
  // owners/repos SEQUENTIALLY, so organizations/branches are reported but not fanned out there (only
  // repositories, the gh/git/tar subprocess cap, applies in plan mode). `repositories` is the GLOBAL
  // in-flight subprocess cap, NOT a repo-loop degree — so at most `repositories` gh/git/tar run at
  // once no matter how organizations×branches compose. Set-vocabulary event (documented in README).
  logLine({ event: "concurrency", organizations: config.concurrency.organizations, branches: config.concurrency.branches, repositories: config.concurrency.repositories });

  // §2/§8: preflight runs BEFORE any work — especially before opening/migrating the DB or a
  // destructive --fresh drop. Preflight uses a cache-less client (a handful of one-shot calls).
  const preflightClient = new GithubClient({ githubHost: config.githubHost });
  const preflight = await runPreflight(preflightClient, config);
  logLine({ event: "preflight", login: preflight.githubLogin, tarFlavor: preflight.tarFlavor, coreRemaining: preflight.coreRemaining, graphqlRemaining: preflight.graphqlRemaining });

  // --plan: preview the scan scope and exit BEFORE the database is opened (§8). Everything past
  // this point in plan mode is read-only discovery through a CACHE-LESS client (db: null).
  if (args.plan) {
    const planClient = new GithubClient({ githubHost: config.githubHost, db: null, concurrency: config.concurrency.repositories });
    await runPlan(planClient, runtime, preflight.githubLogin);
    return;
  }

  // Only AFTER preflight passes do we touch the database (open/migrate/--fresh) and build the
  // caching client for the scan.
  const db = AuditDb.open({ sqlitePath: config.paths.sqlitePath, fresh: args.fresh, purgeCache: args.purgeCache });
  const client = new GithubClient({ githubHost: config.githubHost, db, concurrency: config.concurrency.repositories });

  try {
    await runScan(db, client, runtime, args, preflight.githubLogin);
  } finally {
    db.close();
  }
}

// §8 step 7's "concise human-readable summary": stderr only — stdout stays pure JSONL. The
// counters are the report's own §7 summary block (the imported ReportSummary type), labels
// matching the report field names.
export function runSummaryText(
  runId: string, s: ReportSummary, errorCount: number, reportPath: string, warnings: readonly PolicyWarning[] = [],
): string {
  return [
    "",
    `AUDIT COMPLETE — run ${runId}`,
    `  Organizations scanned:  ${s.organizationsScanned}`,
    `  Repositories scanned:   ${s.repositoriesScanned}`,
    `  Branches scanned:       ${s.branchesScanned} (${s.branchesSkippedByCutoff} skipped by cutoff · ${s.branchesExcludedByPolicy} excluded by policy · ${s.branchesPastCap} past cap · ${s.branchesErrored} scan-errored)`,
    `  Dependency findings:    ${s.totalDependencyFindings}`,
    `  Usage findings:         ${s.totalUsageFindings}`,
    `  Errors recorded:        ${errorCount} (fail-soft; details in the report's errors[])`,
    `  Report:                 ${reportPath} (+ latest.json)`,
    ...policyWarningLines(warnings),
    "",
  ].join("\n");
}

// Compute AND emit the advisory dead-rule warnings, then return the FULL advisory array for the
// summary. Shared by runScan and runPlan so their warning sets can never drift (run/plan parity is a
// load-bearing property). These events are logged here (pure set algebra over the coverage collected
// during discovery — no glob runs); the empty-allowlist event is emitted separately at mode
// entry, and re-listed first in the returned array for the human summary.
function emitPolicyWarnings(branchPolicy: CompiledBranchPolicy, coverages: readonly RepoPolicyCoverage[]): PolicyWarning[] {
  const dead = computePolicyWarnings(branchPolicy, coverages);
  for (const w of dead) logLine({ event: "policy-warning", ...w });
  return [...(isEmptyAllowlist(branchPolicy) ? [{ kind: "empty-allowlist" } as const] : []), ...dead];
}

// The full scan lifecycle (§0/§1/§3/§5/§8), after preflight opened the db + caching client.
// EXPORTED for tests: the site-(a) owner-discovery throttle contract — end cleanly WITHOUT
// starting a run — is pinned here (a run started on throttle would leave a phantom run row).
export async function runScan(
  db: AuditDb, client: GithubClient, runtime: AuditRuntime,
  args: OrchestrateArgs, personalLogin: string | null,
): Promise<void> {
  const { config, configHash } = runtime;
  // §0 startup: sweep stale temp dirs from a prior crash.
  client.sweepStaleTempDirs();

  // The empty-allowlist warning is UNCONDITIONAL — emit it at mode entry so it fires even if the
  // run then early-returns on an owner-discovery throttle. Retained for the end-of-run summary.
  if (isEmptyAllowlist(runtime.branchPolicy)) logLine({ event: "policy-warning", kind: "empty-allowlist" });

  // §1 effective owner resolution (discovery runs every invocation). A throttle here is
  // TRANSIENT (§4): end the run cleanly and let the next invocation re-discover, rather than
  // crashing the whole process with no report.
  const resolved = await resolveOwnersWithDiscovery(client, config, personalLogin);
  if (resolved === null) {
    logLine({ event: "owner-discovery-throttled", action: "retry-next-run" });
    return; // clean exit; the caller closes the db. No run started, nothing to report.
  }
  const { owners, source } = resolved;

  // tracked names derive from config.packages EVERYWHERE (run metadata here, the §5.E
  // reconciliation slice inside reconcileIntrospection) — a separately-passed list could
  // drift from the config that supplies each package's registry coordinates.
  const trackedNames = config.packages.map((p) => p.name);

  // §3 run lifecycle: start or resume.
  const { runId, resumed } = db.startRun({
    configHash, effectiveOwners: owners, ownersSource: source,
    trackedPackages: trackedNames, cutoffDate: config.cutoffDate, githubHost: config.githubHost,
  });
  const resume = db.resumeInfo(configHash);
  logLine({ event: "run", runId, resumed, counts: resume.counts });

  // §1 exclusion enforcement on RESUME: excludeOrganizations is matched case-insensitively (ownerResolve),
  // but config_hash hashes it exact-case (folding the hash would orphan legacy resumable work). So a run
  // that straddles the upgrade to case-insensitive exclusion could hold run_unit_head + errors rows for an
  // owner a case-variant exclude now removes — prune both so a resumed run's report never surfaces an owner
  // its own excludeOrganizations excludes. No-op on a fresh run and when excludeOrganizations is empty.
  const excludedPruned = db.pruneExcludedOwnerRows(runId, config.excludeOrganizations);
  if (excludedPruned.heads > 0 || excludedPruned.errors > 0)
    logLine({ event: "reconciliation", target: "excluded-owner", runId, action: "prune-excluded-owner", prunedHeads: excludedPruned.heads, prunedErrors: excludedPruned.errors });

  // §3 --rescan-branch: reset matching branch units to pending BEFORE discovery.
  for (const t of args.rescanBranches) {
    const reset = db.rescanBranch(configHash, t.organization, t.repository, t.branch);
    logLine({ event: "rescan-branch", target: `${t.organization}/${t.repository}@${t.branch}`, reset });
  }

  const nonRegistrySkipSeen = new Set<string>();
  // §5.A exclusivity backstop (P0): the canonical `org\0repo` key of every repo scheduled this run.
  // Owner case-folding (ownerResolve.ts) plus mapRestRepo's owner-scope enforcement (github.ts)
  // already make a repo reachable under exactly ONE effective owner, so this Set NEVER trips in
  // correct operation — it is the honest tripwire that makes "each branch-unit scheduled at most
  // once" provable rather than assumed, so a future regression that double-schedules a repo (and
  // would race two fibers on the same rows under fan-out) fails LOUD instead of corrupting silently.
  const scheduledRepoKeys = new Set<string>();

  // §5.G bin discovery: introspect each tracked package's LATEST published version ONCE up
  // front to learn its bin names, so the per-unit CLI scan runs specifier + bin terms in a
  // SINGLE pass (no fragile post-introspection re-scan). Bins are version-stable, and this also
  // covers a CLI-only package invoked with no manifest declaration (§5.G/§7 usageByRepo union).
  const cliTermSets = await discoverCliTerms(db, client, config, runId);
  logLine({ event: "cli-terms", terms: cliTermSets.map((t) => ({ name: t.name, bins: t.binNames })) });

  // §5.A/§5.B discover + process, fanned out across owners bounded by concurrency.organizations (§5).
  // A PolicyMatchError (a compiled branch matcher THREW at match time — fail-closed) is a GLOBAL
  // config defect — never a per-repo soft error — so it ABORTS the whole run: mark it failed (excluded
  // from latest selection) and rethrow the ORIGINAL operator-facing error unchanged (registered in
  // KNOWN_OPERATOR_ERRORS).
  //
  // boundedPool SETTLES ALL: an owner that throws never tears its siblings down, and every owner fiber
  // (with its nested per-repo branch pools) DRAINS before this returns — so main()'s finally
  // db.close() can never race a live writer. The per-run Aborter is tripped the instant ANY owner
  // escapes, so sibling owners stop dispatching NEW repos/units at once (boundary-only cancellation:
  // in-flight discovery/scans drain naturally, bounded by the per-spawn deadline; nothing throws an
  // AbortError, so no discovery fail-soft catch is ever mis-fired into a false error row).
  //
  // onFatal is threaded DOWN into each processRepo's branch pool so a fatal caught deep in a branch
  // worker trips this run Aborter PROMPTLY — not only when the owner worker's catch below runs (which
  // waits for that owner's whole branch pool to drain first). The owner catch is still needed for
  // fatals OUTSIDE the branch-worker path (discovery, duplicate scheduling, reconciliation). abort() is
  // idempotent, so the two paths compose without double-firing.
  const aborter = new Aborter();
  const onFatal = (): void => aborter.abort();
  const ownerResults = await boundedPool(owners, config.concurrency.organizations, async (owner) => {
    try {
      return await processOwner(db, client, runtime, runId, owner, personalLogin, cliTermSets, nonRegistrySkipSeen, scheduledRepoKeys, aborter, onFatal);
    } catch (e) {
      aborter.abort(); // trip so sibling owners stop dispatching new work immediately
      throw e; // captured by the pool; the run lifecycle is decided AFTER every owner has drained
    }
  }, { signal: aborter });

  // Coverage from the SUCCESSFUL owners, in deterministic owner order (positional pool results).
  const coverages: RepoPolicyCoverage[] = [];
  for (const r of ownerResults) if (r.status === "fulfilled") coverages.push(...r.value);

  // Fatal lifecycle over the collected REAL failures (rejections). Under boundary-only cancellation
  // nothing throws an AbortError, so every rejection is a genuine fatal. failRun iff ANY is a
  // PolicyMatchError (a config defect must exclude the run from latest) — even when a lower-index
  // generic escape is the one surfaced. A run with NO PolicyMatchError stays resumable (no failRun).
  // Rethrow the FIRST rejection in owner order (deterministic surfaced error) AFTER the full drain.
  //
  // ACCEPTED trade-off (prompt fan-out cancellation): the predicate sees only COLLECTED failures. A
  // generic fatal (a DB-write failure, the bucket-wiring assertion) in an earlier owner now trips the
  // run Aborter promptly (onFatal), which can SKIP a later sibling owner's would-be PolicyMatchError —
  // so that run stays resumable rather than failed. This is benign: a fatal run emits NO report (the
  // throw below precedes completeRun/emitReport) and is never served as "latest" (that filters
  // status='completed'), and the config defect is DETERMINISTIC — it recurs and fails the next run
  // THAT re-scans that branch (a run that never reaches it cannot surface it, but also emits no report
  // implicating that branch). Guaranteeing failRun on a masked-behind-a-generic-fatal PolicyMatchError
  // would need estate-wide up-front policy validation, out of scope here. The masking already existed
  // pre-fan-out (any abort stops siblings); onFatal only narrows the window.
  const failures = ownerResults.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
  if (failures.length > 0) {
    if (failures.some((reason) => reason instanceof PolicyMatchError)) db.failRun(runId);
    throw failures[0];
  }

  // Emit the unmatched-pattern warnings (before completeRun/done) and build the summary array.
  const warnings = emitPolicyWarnings(runtime.branchPolicy, coverages);

  // §5.E introspection reconciliation over the run's reportable slice.
  await reconcileIntrospection(db, client, config, runId);

  // §8 step 6: mark completed BEFORE the report reads (so generatedAt=completed_at).
  db.completeRun(runId);
  // §8 step 7: produce the consolidated §7 report (run-<id>.json + latest.json) from SQLite,
  // then the machine done-event (stdout) and the human summary (stderr) — BOTH derived from
  // the emitted report object itself, so the three can never disagree.
  const completedRun = db.getRun(runId)!;
  const emitted = emitReportDetailed(db, completedRun, config.paths.outputDir, { alsoLatest: true });
  const summary = emitted.report.summary;
  const errorCount = emitted.report.errors.length;
  logLine({ event: "done", runId, report: emitted.path, summary, errors: errorCount });
  process.stderr.write(runSummaryText(runId, summary, errorCount, emitted.path, warnings));
}

// ---- owner resolution + branch classification (shared by the run and --plan paths) -----------
// §1 effective owner resolution: discovery re-runs every invocation through the given client.
async function resolveOwners(
  client: GithubClient, config: Config, personalLogin: string | null,
): Promise<{ owners: string[]; source: OwnersSource }> {
  const discoveredOrgs = config.organizations === null ? await client.listOrgMemberships() : [];
  const { owners, source } = resolveEffectiveOwners({
    organizations: config.organizations,
    excludeOrganizations: config.excludeOrganizations,
    includePersonalNamespace: config.includePersonalNamespace,
    discoveredOrgs,
    personalLogin: config.includePersonalNamespace ? personalLogin : null,
  });
  logLine({ event: "owners", owners, source });
  return { owners, source };
}

// §1 owner resolution with graceful throttle handling. A ThrottleExhausted during org-membership
// discovery is TRANSIENT (§4) — return null so the caller ends the run cleanly (the next run
// re-discovers) instead of crashing. Any OTHER error rethrows (a genuine failure — including an
// EmptyOwnersError from resolution itself — still fails the run). EXPORTED for tests: the
// transient-vs-fatal split must stay pinned.
export async function resolveOwnersWithDiscovery(
  client: GithubClient, config: Config, personalLogin: string | null,
): Promise<{ owners: string[]; source: OwnersSource } | null> {
  try {
    return await resolveOwners(client, config, personalLogin);
  } catch (e) {
    if (e instanceof ThrottleExhausted) return null;
    throw e;
  }
}

// Branch classification (policy → cutoff/cap) lives in ./branchPlanner.ts (the ONE shared planner
// used by BOTH processRepo and runPlan, so their dispositions/counts can never diverge). Repo
// discovery stays here.

// Discover ONE owner's repos and process each (§5.A). EXPORTED for tests: the repo-discovery
// throttle policy (inside discoverOwnerRepos) must stay pinned at this call boundary.
export async function processOwner(
  db: AuditDb, client: GithubClient, runtime: AuditRuntime, runId: string,
  owner: string, personalLogin: string | null, cliTermSets: CliTermSet[], nonRegistrySkipSeen: Set<string>,
  scheduledRepoKeys: Set<string> = new Set(), signal?: AbortLike, onFatal?: () => void,
): Promise<RepoPolicyCoverage[]> {
  // Personal-vs-org routing is CASE-INSENSITIVE to match ownerResolve's owner fold: a configured
  // "Alice" that collapsed onto personal login "alice" must still route through listUserRepos, not
  // the org endpoint. (personalLogin here is the resolved preflight login; includePersonalNamespace
  // gates whether personal routing applies — the `personalLogin !== null` check is just defensive.)
  const isPersonal = runtime.config.includePersonalNamespace && personalLogin !== null && owner.toLowerCase() === personalLogin.toLowerCase();
  const outcome = await discoverOwnerRepos(db, client, runtime.config, runId, owner, isPersonal);
  if (!outcome.ok) return []; // repo discovery failed/throttled — nothing to process, no coverage
  // Repos stay SEQUENTIAL within an owner (§4): each repo's discover→plan→scan→reconcile must be
  // atomic (branches fan out INSIDE processRepo). Check the run-level abort before each repo so a
  // fatal in a SIBLING owner stops this owner from dispatching more work promptly (boundary-only
  // cancellation — no throw, so partial coverage is fine; the run is failing anyway).
  const coverages: RepoPolicyCoverage[] = [];
  for (const repo of outcome.items) {
    if (signal?.aborted) break;
    const cov = await processRepo(db, client, runtime, runId, owner, repo, cliTermSets, nonRegistrySkipSeen, scheduledRepoKeys, signal, onFatal);
    if (cov !== null) coverages.push(cov);
  }
  return coverages;
}

// §5.A run-path repo discovery for one owner, fail-soft: a failure records the DB error row AND
// emits the matching JSONL `discovery` event (org-scoped — no `repo` field), then returns a FAILED
// DiscoveryOutcome so the owner loop simply moves on. A ThrottleExhausted is TRANSIENT (§4):
// discovery re-runs next invocation, so it logs a requeue event and returns a failed outcome with NO
// permanent errors row. Exported for tests (scripted client + real in-memory DB); processOwner is its
// only runtime caller. The --plan twin lives in runPlan, deliberately separate — plan mode has no DB
// and counts failures into its totals instead.
export async function discoverOwnerRepos(
  db: AuditDb, client: GithubClient, config: Config, runId: string, owner: string, isPersonal: boolean,
): Promise<DiscoveryOutcome<RepoInfo>> {
  let repos: RepoInfo[];
  try {
    repos = isPersonal ? await client.listUserRepos(owner) : await client.listOrgRepos(owner);
  } catch (e) {
    // §4: a throttle during repo discovery is TRANSIENT — no permanent errors row (discovery
    // re-runs next invocation). Any other error is a permanent discovery failure. Either way the
    // outcome is a FAILURE (never a genuinely-empty owner) — the caller must not treat it as "done".
    if (e instanceof ThrottleExhausted) {
      logLine({ event: "discovery", org: owner, action: "requeue-throttle", message: (e as Error).message });
      return discoveryFailed("throttled");
    }
    const message = `repo discovery failed: ${(e as Error).message}`;
    db.insertError({ runId, scope: "discovery", organization: owner, message });
    logLine({ event: "discovery", org: owner, error: message });
    return discoveryFailed("failed");
  }
  return discovered(filterSortCapRepos(repos, {
    includeArchived: config.includeArchived, includeForks: config.includeForks, maxReposPerOrg: config.maxReposPerOrg,
  }));
}

// Branch-head discovery for ONE repo as a typed outcome — extracted so both the run (here) and
// reconciliation consume the SAME failed-vs-genuinely-empty distinction. Same fail-soft policy: a throttle
// requeues with no errors row (transient); any other error records a permanent discovery-failure row.
export async function discoverBranchHeads(
  db: AuditDb, client: GithubClient, runId: string, repo: RepoInfo,
): Promise<BranchDiscoveryOutcome> {
  try {
    // listBranchHeads validates the snapshot's coherence INSIDE this try on purpose: an incoherent
    // snapshot must become a discovery FAILURE (errors row + retained rows + no reconcile), not an
    // exception escaping past the outcome boundary where no error is recorded and the run can be left
    // resumable-but-wrong.
    return { ok: true, snapshot: await client.listBranchHeads(repo.organization, repo.name) };
  } catch (e) {
    if (e instanceof ThrottleExhausted) {
      logLine({ event: "discovery", org: repo.organization, repo: repo.name, action: "requeue-throttle", message: (e as Error).message });
      return discoveryFailed("throttled");
    }
    const message = `branch discovery failed: ${(e as Error).message}`;
    db.insertError({ runId, scope: "discovery", organization: repo.organization, repository: repo.name, message });
    logLine({ event: "discovery", org: repo.organization, repo: repo.name, error: message });
    return discoveryFailed("failed");
  }
}

// Discover a repo's branches, apply policy + cutoff + cap, and process/skip each branch unit
// (PROMPT.md §5.B/§3). Returns the repo's policy COVERAGE on a successful discovery (folded into the run's
// unmatched-pattern warnings), or null when branch discovery failed/throttled. Exported for the wiring tests;
// processOwner is its only runtime caller.
export async function processRepo(
  db: AuditDb, client: GithubClient, runtime: AuditRuntime, runId: string,
  owner: string, repo: RepoInfo, cliTermSets: CliTermSet[], nonRegistrySkipSeen: Set<string>,
  scheduledRepoKeys: Set<string> = new Set(), signal?: AbortLike, onFatal?: () => void,
): Promise<RepoPolicyCoverage | null> {
  const { config, configHash, branchPolicy } = runtime;
  const outcome = await discoverBranchHeads(db, client, runId, repo);
  if (!outcome.ok) return null; // failed/throttled — this repo isn't "discovered"; contributes no coverage
  // §5.A exclusivity backstop (P0): claim this repo's canonical (org, repo) BEFORE any per-branch
  // write, so a double-scheduled repo fails LOUD rather than racing two fibers on the same rows
  // under fan-out. The check-then-add is synchronous (no await between .has and .add), so it stays
  // correct even when sibling processRepo calls run concurrently. Keyed on repo.organization (the
  // API-canonical owner.login, validated == the requested owner by mapRestRepo) so a case-variant
  // owner cannot evade it. This never trips in correct operation (owner fold + owner-scope
  // enforcement guarantee it); it is the honest proof, not a routine branch.
  const repoKey = `${repo.organization.toLowerCase()}\0${repo.name.toLowerCase()}`;
  if (scheduledRepoKeys.has(repoKey))
    throw new Error(`internal: repo ${repo.organization}/${repo.name} scheduled twice in one run — the owner-dedup/branch-exclusivity invariant was violated`);
  scheduledRepoKeys.add(repoKey);
  const heads = outcome.snapshot.heads;
  // Classify the WHOLE repo up-front (policy → cutoff/cap) via the ONE shared planner. This runs
  // OUTSIDE the discovery catch and BEFORE any per-branch write, so a match-time PolicyMatchError
  // aborts before this repo is half-classified (runScan then fails the run and rethrows).
  const plan = planRepoBranches(outcome.snapshot, branchPolicy, config.cutoffDate, config.maxBranchesPerRepo);
  // Discovery KNOWS the default branch (§5.B — resolved from the same snapshot as these heads), so
  // every head row this run writes carries a definite true/false — NULL is reserved for pre-v3 rows
  // where nothing ever recorded it.
  const keyFor = (branch: string): WorkUnitKey => ({ configHash, scope: "branch", organization: repo.organization, repository: repo.name, branch });

  // Policy-excluded (non-default, denied/allow-missed): its OWN run_unit_head disposition, named to
  // match the 'skip-policy' event emitted just below — the durable row and the live stream call this
  // one branch the same thing. Treated like a cutoff skip for the WORK QUEUE (enqueue + 'skipped'):
  // that queue models "no scan needed", not why. commit_sha='' (never scanned); date = discovered head.
  for (const d of plan.policyExcluded) {
    const h = d.head;
    const key = keyFor(h.name);
    const attr = policyAttribution(d.rawPolicyResult);
    db.enqueueUnit(key, runId);
    db.setUnitStatus(key, { status: "skipped", runId, lastCommitSha: "", lastCommitDate: h.committedDate });
    db.upsertRunUnitHead({ runId, organization: repo.organization, repository: repo.name, branch: h.name, commitSha: "", status: "policy-excluded", isDefaultBranch: d.isDefaultBranch, policyStatus: attr.policyStatus, policyMatchedPattern: attr.policyMatchedPattern, scannedCommitDate: h.committedDate });
    logLine({ event: "unit", org: repo.organization, repo: repo.name, branch: h.name, commit: "", action: "skip-policy", policyStatus: attr.policyStatus });
  }

  // Cutoff-skipped (policy-eligible, before cutoff): policy null (an eligible non-default branch is
  // by construction no-exclusion; the default is never cutoff-skipped).
  for (const d of plan.cutoffSkipped) {
    const h = d.head;
    const key = keyFor(h.name);
    db.enqueueUnit(key, runId);
    db.setUnitStatus(key, { status: "skipped", runId, lastCommitSha: "", lastCommitDate: h.committedDate });
    db.upsertRunUnitHead({ runId, organization: repo.organization, repository: repo.name, branch: h.name, commitSha: "", status: "skipped-cutoff", isDefaultBranch: d.isDefaultBranch, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: h.committedDate });
    logLine({ event: "unit", org: repo.organization, repo: repo.name, branch: h.name, commit: "", action: "skip-cutoff" });
  }

  // Past-cap (policy-eligible, after cutoff, past the cap): record ONLY a run_unit_head row for report
  // visibility — do NOT enqueue or touch the work queue, so a prior 'done' scan survives and a later
  // run can promote this branch (cap-order shift) without a re-scan.
  for (const d of plan.pastCap) {
    const h = d.head;
    db.upsertRunUnitHead({ runId, organization: repo.organization, repository: repo.name, branch: h.name, commitSha: "", status: "past-cap", isDefaultBranch: d.isDefaultBranch, policyStatus: null, policyMatchedPattern: null, scannedCommitDate: h.committedDate });
    logLine({ event: "unit", org: repo.organization, repo: repo.name, branch: h.name, commit: "", action: "past-cap" });
  }

  // To-scan (default + within-cap after-cutoff). Fan out through a per-repo pool bounded by
  // concurrency.branches (§5). Safe WITHOUT a mutex because each unit is a DISTINCT (org, repo,
  // branch) — so distinct work_queue / run_unit_head rows — and every DB write below is an await-free
  // synchronous block; bun:sqlite is fully synchronous, so no sibling fiber can interleave mid-block
  // and the units never race each other's rows. Repos stay SEQUENTIAL within an owner (§4): each
  // repo's discover→plan→scan→reconcile must be atomic, and this pool drains fully before the
  // reconcile below. Only the DEFAULT may carry a policy counterfactual (the override); a non-default
  // to-scan branch is necessarily no-exclusion (asserted, fail-closed).
  //
  // Fatal fail-fast: a LOCAL Aborter stops NEW unit dispatch the instant any unit throws a fatal
  // (PolicyMatchError or the internal bucket-wiring assertion), matching the run-level owner Aborter's
  // discipline one level down — so branches:1 reproduces the old sequential loop's fail-fast, and a
  // broken policy does not re-throw against every remaining branch. It is composed with the incoming
  // run-level signal (a sibling owner's fatal trips this pool too). Settle-all is preserved: units
  // already IN FLIGHT still drain (the drain-safety §7 depends on for db.close()); only undispatched
  // units are skipped.
  const branchAbort = new Aborter();
  // Register this repo's branchAbort-trip on the run-level Aborter, and DROP it (the .finally below)
  // once this branch pool settles. Without the unsubscribe every COMPLETED repo's callback would stay
  // on the run-level Aborter until the run ends — unbounded accumulation over a large estate. The
  // .finally runs whether the pool resolves or the fatal-rethrow path is taken, and unsubscribe is a
  // no-op if the callback already fired (a run-level abort).
  const unsubscribe = signal?.onAbort(() => branchAbort.abort()); // run-level fatal → stop this pool too (fires immediately if already aborted)
  const unitResults = await boundedPool(plan.toScan, config.concurrency.branches, async (d) => {
    if (branchAbort.aborted) return; // a fatal (this repo's own or a sibling owner's) tripped the run — dispatch no new units
    try {
      const h = d.head;
      if (!d.isDefaultBranch && d.rawPolicyResult.kind !== "no-exclusion")
        throw new Error(`internal: non-default scanned branch ${repo.organization}/${repo.name}@${h.name} carries policy ${d.rawPolicyResult.kind} (planner bucket-wiring bug)`);
      const key = keyFor(h.name);
      const attr = policyAttribution(d.rawPolicyResult); // (null, null) unless the default-branch override
      db.enqueueUnit(key, runId);
      const unit = db.getUnit(key);
      // §3 skip predicate: a done unit of THIS config whose stored head equals the LIVE head is reused
      // (skip-as-current) — the scanned commit is h.oid, so its date is h.committedDate. This
      // enqueue→get→upsert→setStatus RMW is await-free, so it runs to completion atomically vs siblings.
      if (unit !== null && unit.status === "done" && unit.lastCommitSha === h.oid) {
        db.upsertRunUnitHead({ runId, organization: repo.organization, repository: repo.name, branch: h.name, commitSha: h.oid, status: "scanned", isDefaultBranch: d.isDefaultBranch, policyStatus: attr.policyStatus, policyMatchedPattern: attr.policyMatchedPattern, scannedCommitDate: h.committedDate });
        db.setUnitStatus(key, { status: "done", runId, lastCommitSha: h.oid, lastCommitDate: h.committedDate });
        logLine({ event: "unit", org: repo.organization, repo: repo.name, branch: h.name, commit: h.oid, action: "skip-current" });
        return;
      }

      db.setUnitStatus(key, { status: "in_progress", runId });
      try {
        const scanned = await processUnit(db, client, config, runId, repo, d, cliTermSets, nonRegistrySkipSeen);
        db.setUnitStatus(key, { status: "done", runId, lastCommitSha: scanned.commitSha, lastCommitDate: scanned.committedDate, errorMessage: null });
      } catch (e) {
        // A PolicyMatchError is FATAL by contract — never downgraded to a per-unit scan error. It
        // escapes to the outer catch, which trips branchAbort; boundedPool captures it and processRepo
        // rethrows it below AFTER draining every in-flight sibling. Today it can arise from the write
        // chokepoint's attribution-coherence verification inside processUnit's upserts.
        if (e instanceof PolicyMatchError) throw e;
        if (e instanceof ThrottleExhausted) {
          // §4: throttle exhaustion is NOT a permanent unit failure — reset to pending so a LATER run
          // retries it. No same-run spin: the pool dispatches each fixed plan.toScan unit exactly once
          // and nothing re-reads pending units within the run. Handled here (not a fatal), so it never
          // trips branchAbort — one throttled branch must not cancel its siblings.
          db.setUnitStatus(key, { status: "pending", runId, errorMessage: (e as Error).message });
          logLine({ event: "unit", org: repo.organization, repo: repo.name, branch: h.name, commit: h.oid, action: "requeue-throttle", message: (e as Error).message });
        } else {
          db.insertError({ runId, scope: "scan", organization: repo.organization, repository: repo.name, branch: h.name, message: (e as Error).message });
          db.setUnitStatus(key, { status: "error", runId, errorMessage: (e as Error).message });
          logLine({ event: "unit", org: repo.organization, repo: repo.name, branch: h.name, commit: h.oid, action: "error", message: (e as Error).message });
        }
      }
    } catch (e) {
      // A fatal escaped this unit (PolicyMatchError, or the internal bucket-wiring assertion — the
      // handled throttle/scan-error cases above never reach here). Trip branchAbort so THIS pool
      // dispatches NO further units at once (fail-fast). Also trip the RUN-level Aborter PROMPTLY via
      // onFatal: without it the run Aborter is only tripped in runScan's owner-worker catch, which runs
      // AFTER this whole branch pool drains and processRepo rethrows — so during that drain sibling
      // OWNERS keep dispatching new repos. onFatal (= aborter.abort) stops sibling owners at their next
      // repo check and trips sibling repos' branchAborts at once. Settle-all is preserved: abort only
      // stops NEW dispatch; in-flight units still drain, so db.close() never races a live writer. Then
      // rethrow so boundedPool captures it and processRepo surfaces the first rejection after the drain.
      branchAbort.abort();
      onFatal?.();
      throw e;
    }
  }, { signal: branchAbort }).finally(() => unsubscribe?.()); // drop this repo's run-Aborter callback once the pool settles
  // A PolicyMatchError (or any other escaping fatal — the internal bucket-wiring assertion, a DB
  // write failure) from ANY unit is FATAL: branchAbort has already stopped new dispatch and every
  // IN-FLIGHT sibling has drained (settle-all), so surface a rejection here. runScan fails the run IFF
  // any collected escape is a PolicyMatchError, so we PREFER to surface a PolicyMatchError (the first,
  // for determinism) over a generic rejection — mirroring runScan's own failRun predicate one level
  // down, so a config-defect PolicyMatchError can never be masked behind an earlier generic escape.
  // (Belt-and-braces: a generic escape here is synchronous and trips branchAbort before any sibling
  // reaches its POST-await PolicyMatchError, so a co-occurring policy fatal is already lower-index
  // today — but preferring it keeps the failRun invariant robust to any future change in that timing.)
  // Absent a PolicyMatchError, surface the first rejection in plan.toScan order (deterministic). This
  // runs BEFORE reconciliation, exactly as the old sequential rethrow skipped it.
  const rejections = unitResults.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
  if (rejections.length > 0) throw rejections.find((reason) => reason instanceof PolicyMatchError) ?? rejections[0];
  // Stale-row reconciliation: this repo was discovered COMPLETELY (ok:true, reached only past the early
  // `!outcome.ok` return; listBranchHeads fails closed on any structural incompleteness, so `heads` is
  // the exact live branch set for THIS discovery snapshot). Prune this run's stale run_unit_head rows —
  // phantom branches a prior resume-invocation recorded that no longer exist. Scoped to this
  // (run_id, org, repo); a failed/throttled repo never reaches here and is retained. Reconciliation
  // reflects the DISCOVERY-TIME snapshot, not the state at this instant, so the keep-set can be stale
  // in both directions — an accepted TOCTOU for this single-user tool (no permanent data loss; the next
  // run re-discovers and re-reconciles). Membership in `heads` is what decides, so there are exactly
  // three cases:
  //   - PRESENT in the keep-set → the row is RETAINED, whatever happened after discovery. A branch
  //     deleted in that window keeps its row this run (a phantom the next run prunes).
  //   - ABSENT and it never had a row (created after discovery) → nothing to prune, nothing lost; it is
  //     simply recorded next run.
  //   - ABSENT but it DOES hold a row from an earlier invocation of this run → the row is PRUNED. This
  //     is the sharp edge, and it does not require the branch to still be gone: one deleted BEFORE this
  //     discovery and RECREATED before the DELETE below is live again by the time we prune, yet its
  //     prior row goes anyway (the keep-set no longer names it). Accepted: the row is re-recorded on the
  //     next run, and global findings persist — only the per-run disposition row lapses.
  // Note the direction: presence PROTECTS. Reconciliation can only delete rows for names discovery did
  // not return — so a stale keep-set errs toward retaining, except in that third case.
  //
  // SIBLING ACCEPTED-STALENESS (same-name stale head). On a RESUME: a branch whose head ADVANCED since a
  // prior invocation, whose re-scan then errors (the insertError arm above) or throttles (the requeue
  // arm), writes no row this attempt — and the name-keyed prune RETAINS the prior row, WHATEVER its
  // disposition, pinned to the OLDER evaluation. The report counts the branch under that PRIOR
  // disposition: scanned at the old head — or still skipped-cutoff/past-cap/policy-excluded from the
  // older evaluation, even though the head became eligible this attempt (cutoff-skip via an advanced
  // head; past-cap via a cap-order shift; policy-excluded only when the branch also BECAME the
  // default, the one override policy permits). Accepted, because:
  //   - it is stale, not wrong: a scanned row and its findings describe a real scan of a real commit —
  //     commit_sha + scanned_commit_date say WHICH (PROMPT.md's report-head invariant defines commit_sha
  //     as "the head it reported", never "the live head") — and a non-scanned row's commit_sha='' +
  //     discovered-head date describe the older evaluation it records.
  //   - it is NOT a regression: before reconciliation existed there was no prune at all, so the row was retained
  //     identically. The prune is a mitigation this feature ADDED (it removes deleted-branch phantoms
  //     that used to persist forever); it is not the cause.
  //   - it self-heals: the unit is left error/pending, never done, so the next run re-scans and re-upserts
  //     at the live head.
  // A head-SHA-aware prune is REJECTED: it would delete the clone-fallback path's legitimate rows (whose
  // commit_sha is the clone's real HEAD, deliberately != the discovered h.oid — see processUnit) and the
  // commit_sha='' sentinels the non-scanned dispositions rely on, hiding a real branch's real findings
  // entirely rather than reporting them one commit late.
  // Sharp edge worth knowing: the ERROR variant is loud (an errors[] row + a JSONL `action:"error"`
  // line, visible beside the stale row), but the THROTTLE variant writes neither — only a stdout
  // requeue line — so a completed run can present the old head with no in-report signal. Related: the
  // retained row also masks that branch from the report's branchesErrored, which counts only errored
  // branches holding NO row (see report.ts).
  const pruned = db.reconcileRunUnitHead(runId, repo.organization, repo.name, heads.map((h) => h.name));
  if (pruned > 0)
    logLine({ event: "reconciliation", target: "run_unit_head", runId, org: repo.organization, repo: repo.name, action: "prune-stale", pruned });

  return plan.coverage; // a SUCCESSFULLY-discovered repo (even if empty) — folds into the run's warnings
}

// Scan ONE branch unit: fetch the tree (clone fallback on truncation), run the §5.C-H pipeline,
// and WRITE every finding + the run_unit_head snapshot. All writes here are an await-free synchronous
// block AFTER the last await (scanUnit), and target THIS unit's distinct rows — so under branch
// fan-out they never race a sibling unit's writes.
async function processUnit(
  db: AuditDb, client: GithubClient, config: Config, runId: string,
  repo: RepoInfo, decision: BranchDecision, cliTermSets: CliTermSet[], nonRegistrySkipSeen: Set<string>,
): Promise<{ commitSha: string; committedDate: string }> {
  const h = decision.head;
  const tree = await client.fetchTreeRecursive(repo.organization, repo.name, h.treeOid);
  let cloneDir: string | null = null;
  // The ACTUAL scanned commit + its date: the discovery head (h.oid / h.committedDate) for the API
  // path, or the clone's real HEAD for the fallback (the branch may have moved between GraphQL
  // discovery and the clone; all findings/permalinks/run_unit_head AND the persisted
  // scanned_commit_date must pin to what was truly scanned, §5.C/§4).
  let commitSha = h.oid;
  let committedDate = h.committedDate;
  // The clone-fallback setup (cloneShallow → walkClone → cloneReader) runs INSIDE this try so a
  // walkClone/reader throw AFTER cloneShallow succeeds still reaches the finally's (best-effort,
  // warns-on-failure) clone-dir reclaim — otherwise a completed (multi-GB) clone would be left for the
  // next startup sweep instead. cloneShallow's own failure path cleans up before it sets cloneDir, so
  // the finally correctly no-ops there.
  try {
    let entries: TreeEntry[];
    let readFile: (path: string, entry: TreeEntry) => Promise<string | null>;
    if (tree.truncated) {
      const cloned = await client.cloneShallow(repo.organization, repo.name, h.name);
      cloneDir = cloned.dir;
      commitSha = cloned.headSha;
      committedDate = cloned.headCommittedDate;
      entries = walkClone(cloned.dir);
      readFile = cloneReader(cloned.dir);
    } else {
      entries = tree.paths.map((p) => ({ path: p.path, type: p.type, sha: p.sha, size: p.size }));
      readFile = apiReader(client, repo.organization, repo.name, h.oid);
    }
    const loc: UnitLocation = { githubHost: config.githubHost, organization: repo.organization, repository: repo.name, branch: h.name, commitSha };
    const result = await scanUnit(loc, { trackedPackages: config.packages.map((p) => p.name), excludeDirGlobs: config.excludeDirGlobs }, entries, readFile, cliTermSets);
    const now = nowIso();
    for (const d of result.dependencyFindings) {
      db.upsertDependencyFinding({
        runId, organization: d.organization, repository: d.repository, branch: d.branch, commitSha: d.commitSha,
        dateFetched: now, packageName: d.packageName, dependencyKey: d.dependencyKey, dependencyType: d.dependencyType,
        manifestPath: d.manifestPath, manifestLine: d.manifestLine, manifestPermalink: d.manifestPermalink,
        declaredVersion: d.declaredVersion, lockfilePath: d.lockfilePath, lockfileKind: d.lockfileKind,
        lockfileLines: d.lockfileLines, lockfilePermalink: d.lockfilePermalink,
        resolvedVersion: d.resolvedVersion, resolvedVersionSource: d.resolvedVersionSource,
      });
    }
    for (const u of result.usageFindings) {
      db.upsertUsageFinding({
        runId, organization: loc.organization, repository: loc.repository, branch: loc.branch, commitSha: loc.commitSha,
        packageName: u.packageName, dependencyKey: u.dependencyKey, usageType: u.usageType, exportName: u.exportName,
        context: "", filePath: u.filePath, lineNumber: u.lineNumber, permalink: u.permalink, snippet: u.snippet, foundAt: now,
      });
    }
    for (const c of result.cliFindings) {
      db.upsertUsageFinding({
        runId, organization: loc.organization, repository: loc.repository, branch: loc.branch, commitSha: loc.commitSha,
        packageName: c.packageName, dependencyKey: "", usageType: "cli", exportName: "", context: c.context,
        filePath: c.filePath, lineNumber: c.lineNumber, permalink: c.permalink, snippet: c.snippet, foundAt: now,
      });
    }
    // §5.E non-registry skip: log ONCE per (package, raw spec) this run (only on the scan run).
    for (const s of result.nonRegistrySkips) {
      const skipKey = `${s.packageName}\0${s.rawSpec}`;
      if (nonRegistrySkipSeen.has(skipKey)) continue;
      nonRegistrySkipSeen.add(skipKey);
      const skipMessage = `non-registry spec skipped (not introspectable): ${s.rawSpec}`;
      db.insertError({ runId, scope: "introspection", packageName: s.packageName, version: s.rawSpec, message: skipMessage });
      logLine({ event: "introspection", packageName: s.packageName, version: s.rawSpec, error: skipMessage });
    }
    // Scanned snapshot with policy attribution (§3): only the DEFAULT branch may carry a policy
    // counterfactual (the override) — a non-default to-scan branch is no-exclusion, so map() yields
    // (null, null). scanned_commit_date is the ACTUAL scanned commit's date (the clone HEAD's own
    // date under fallback, never the possibly-stale discovered date).
    const attr = policyAttribution(decision.rawPolicyResult);
    db.upsertRunUnitHead({
      runId, organization: loc.organization, repository: loc.repository, branch: loc.branch,
      commitSha: loc.commitSha, status: "scanned", isDefaultBranch: decision.isDefaultBranch,
      policyStatus: attr.policyStatus, policyMatchedPattern: attr.policyMatchedPattern,
      scannedCommitDate: committedDate,
    });

    logLine({ event: "unit", org: repo.organization, repo: repo.name, branch: h.name, commit: commitSha, action: "scanned", deps: result.dependencyFindings.length, usage: result.usageFindings.length, cli: result.cliFindings.length });
    return { commitSha, committedDate };
  } finally {
    if (cloneDir !== null) {
      // the clone lives under a run temp dir (pkg-audit-*/clone) — remove that temp dir, but
      // containment-check the target first so a future refactor can never rm outside tempRoot.
      try {
        const runTempDir = dirname(cloneDir);
        assertContained(runTempDir, [client.tempRoot]);
        rmSync(runTempDir, { recursive: true, force: true });
      } catch (e) {
        // Best-effort reclaim, but NOT silent: a failed cleanup leaves a (multi-GB) clone until the
        // next startup sweep, so surface it — without masking any primary scan error already
        // propagating out of the try (the throw continues; this only adds an observability line).
        logLine({ event: "warning", reason: "clone-cleanup-failed", target: cloneDir, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}

// ---- §5.E introspection reconciliation ------------------------------------------------------
interface SliceRow {
  organization: string;
  repository: string;
  branch: string;
  commit_sha: string;
  package_name: string;
  dependency_key: string;
  dependency_type: string;
  manifest_path: string;
  declared_version: string;
  lockfile_path: string | null;
  resolved_version: string | null;
  resolved_version_source: string | null;
}

// Exported for the introspection-observability tests (scripted client + real in-memory DB);
// runScan is its only runtime caller. The slice filter derives from config.packages — the
// single source of truth for registry coordinates — so a stale dependency row for a package
// no longer in the config is simply never selected (it cannot reach the pkgConfig lookups).
export async function reconcileIntrospection(db: AuditDb, client: GithubClient, config: Config, runId: string): Promise<void> {
  const trackedNames = config.packages.map((p) => p.name);
  const rows = db
    .read(
      `SELECT df.organization, df.repository, df.branch, df.commit_sha, df.package_name,
              df.dependency_key, df.dependency_type, df.manifest_path, df.declared_version,
              df.lockfile_path, df.resolved_version, df.resolved_version_source
       FROM dependency_findings df
       JOIN run_unit_head ruh ON ruh.run_id = ? AND ruh.status = 'scanned'
         AND ruh.organization = df.organization AND ruh.repository = df.repository
         AND ruh.branch = df.branch AND ruh.commit_sha = df.commit_sha
       WHERE df.package_name IN (SELECT value FROM json_each(?))`,
    )
    .all(runId, JSON.stringify(trackedNames)) as SliceRow[];

  const pkgConfig = new Map(config.packages.map((p) => [p.name, p]));
  const packumentCache = new Map<string, Packument | null>(); // per package, fetched at most once

  const getPackument = async (pkg: string): Promise<Packument | null> => {
    if (packumentCache.has(pkg)) return packumentCache.get(pkg)!;
    const cfg = pkgConfig.get(pkg)!;
    let pk: Packument | null = null;
    try {
      pk = await fetchPackument({ packageName: pkg, registryUrl: cfg.registryUrl, registryAuthEnvVar: cfg.registryAuthEnvVar });
    } catch (e) {
      const message = `packument fetch failed: ${(e as Error).message}`;
      db.insertError({ runId, scope: "introspection", packageName: pkg, message });
      logLine({ event: "introspection", packageName: pkg, error: message });
    }
    packumentCache.set(pkg, pk);
    return pk;
  };

  // 1. range-resolve the NO-LOCKFILE rows (§5.E), writing a concrete version back. A lockfile
  // that governs the manifest but did not resolve the dep (e.g. a peer with no installed edge) is
  // NOT range-resolved — the spec limits the fallback to repos with no governing lockfile. A
  // no-lockfile NON-registry declared spec (deriveRange → null) is NOT logged here: unitPipeline
  // already logged it at scan time (so a later skip-as-current run never re-emits it, §5.E).
  for (const r of rows) {
    if (r.resolved_version !== null) continue; // lockfile or a raw non-registry spec already set
    if (r.lockfile_path !== null) continue; // a governing lockfile exists but left it unresolved → leave null
    const range = deriveRange(r.declared_version, r.package_name);
    if (range === null) continue; // non-registry declared — the scan pass logged the skip
    const packument = await getPackument(r.package_name);
    if (packument === null) continue;
    const version = maxSatisfying(Object.keys(packument.versions ?? {}), range);
    if (version === null) continue;
    db.setRangeResolvedVersion(
      { organization: r.organization, repository: r.repository, branch: r.branch, commitSha: r.commit_sha, packageName: r.package_name, dependencyKey: r.dependency_key, dependencyType: r.dependency_type as DependencyType, manifestPath: r.manifest_path },
      version,
    );
    r.resolved_version = version; // reflect the write-back locally so versionsSeen sees it
    r.resolved_version_source = "range-resolved";
  }

  // 2. versionsSeen = distinct (package, valid-semver resolved_version), preferring a lockfile
  // source for the introspection versionSource (informational).
  const versions = new Map<string, { pkg: string; version: string; source: "lockfile" | "range-resolved" }>();
  for (const r of rows) {
    if (r.resolved_version === null || parseSemver(r.resolved_version) === null) continue;
    const key = `${r.package_name}\0${r.resolved_version}`;
    const existing = versions.get(key);
    const source = r.resolved_version_source === "range-resolved" ? "range-resolved" : "lockfile";
    if (existing === undefined || (existing.source === "range-resolved" && source === "lockfile"))
      versions.set(key, { pkg: r.package_name, version: r.resolved_version, source });
  }

  // 3. introspect each versionsSeen version lacking a completion marker (§5.E reconciliation).
  for (const { pkg, version, source } of versions.values()) {
    if (db.hasCompletionMarker(pkg, version)) continue;
    const cfg = pkgConfig.get(pkg)!;
    await introspectVersion({
      client, db, runId, packageName: pkg, registryUrl: cfg.registryUrl, registryAuthEnvVar: cfg.registryAuthEnvVar,
      version, versionSource: source, packument: (await getPackument(pkg)) ?? undefined,
    });
  }
}

// The registry-resolvable RANGE a declared version implies, or null when the declared spec is
// non-registry (git+/file:/workspace:/… or an alias to a package we don't track).
function deriveRange(declaredVersion: string, packageName: string): string | null {
  const alias = parseAlias(declaredVersion);
  if (alias !== null) return alias.name === packageName ? (alias.range === "" ? "*" : alias.range) : null;
  if (/^(git\+|git:|file:|link:|portal:|patch:|workspace:|catalog:|github:|gitlab:|bitbucket:|gist:|https?:)/i.test(declaredVersion.trim())) return null;
  return declaredVersion.trim() === "" ? "*" : declaredVersion.trim();
}

// ---- §5.G bin discovery (before scanning) ---------------------------------------------------
// Build the CLI term set per tracked package: the specifier term ALWAYS, plus bin names learned
// by introspecting the package's LATEST published version once. A bin-discovery failure degrades
// to specifier-only (still correct, just no bin terms). Introspecting one version up front lets
// every unit's CLI scan run in a single pass (no post-introspection re-scan of files).
// Exported for the introspection-observability tests (scripted client + real in-memory DB);
// main() is its only runtime caller.
export async function discoverCliTerms(db: AuditDb, client: GithubClient, config: Config, runId: string): Promise<CliTermSet[]> {
  const sets: CliTermSet[] = [];
  for (const pkg of config.packages) {
    let binNames: string[] = [];
    try {
      const packument = await fetchPackument({ packageName: pkg.name, registryUrl: pkg.registryUrl, registryAuthEnvVar: pkg.registryAuthEnvVar });
      const latest = resolveRangeToVersion(packument, "*"); // max published stable version
      if (latest !== null) {
        if (!db.hasCompletionMarker(pkg.name, latest)) {
          await introspectVersion({
            client, db, runId, packageName: pkg.name, registryUrl: pkg.registryUrl, registryAuthEnvVar: pkg.registryAuthEnvVar,
            version: latest, versionSource: "range-resolved", packument,
          });
        }
        // ORDER BY so the emitted cli-terms event's `bins` array is byte-stable: the JSONL vocabulary
        // is set-based (order-independent by contract), but a total, content-derived order keeps the
        // line reproducible run-to-run and never depends on SQLite's implementation-defined row order.
        const bins = db.read(`SELECT DISTINCT export_name FROM package_api_surface WHERE package_name = ? AND export_kind='cli-bin' AND version = ? ORDER BY export_name`).all(pkg.name, latest) as Array<{ export_name: string }>;
        binNames = bins.map((b) => b.export_name).filter((b) => b !== "");
      }
    } catch (e) {
      const message = `bin discovery failed: ${(e as Error).message}`;
      db.insertError({ runId, scope: "introspection", packageName: pkg.name, message });
      logLine({ event: "introspection", packageName: pkg.name, error: message });
    }
    sets.push({ packageName: pkg.name, name: pkg.name, binNames });
  }
  return sets;
}

// ---- --plan: preview the scan scope with ZERO writes ------------------------------------------
// No DB open (so no api_cache reads/writes), no content fetches, no clones, and no registry
// packument/tarball fetches — preflight's registry REACHABILITY probe (§2.5) is the only registry
// contact, and it carries no auth beyond the configured header. The caller passes a CACHE-LESS
// client (db: null). `branchesEligible` is the pre-database view: a real run may still skip some
// of these units as already-current (§3 skip predicate) — that state lives in the DB, which plan
// mode deliberately never opens. Returns the totals (integration-tested with a scripted client).
export interface PlanTotals {
  readonly owners: readonly string[];
  readonly ownersSource: OwnersSource;
  readonly reposDiscovered: number;
  readonly reposKept: number;
  readonly branchesEligible: number;
  readonly branchesSkippedByCutoff: number;
  readonly branchesPastCap: number;
  readonly branchesExcludedByPolicy: number;
  // Branch-policy diagnostics (the plan-mode analog of the report's scanScope sub-counts).
  // OVERLAYS, not partition buckets: excludedByDeny + excludedByAllow === branchesExcludedByPolicy;
  // defaultBranchPolicyOverrides <= branchesEligible (default branches a policy would have excluded).
  readonly excludedByDeny: number;
  readonly excludedByAllow: number;
  readonly defaultBranchPolicyOverrides: number;
  readonly discoveryErrors: number;
}
export async function runPlan(client: GithubClient, runtime: AuditRuntime, personalLogin: string): Promise<PlanTotals> {
  const { config, branchPolicy } = runtime;
  // Warning parity: the empty-allowlist warning is emitted at mode entry, unconditionally, exactly as in
  // runScan — so --plan and the real run produce identical policy-warning events for the same config.
  if (isEmptyAllowlist(branchPolicy)) logLine({ event: "policy-warning", kind: "empty-allowlist" });
  // The zero-write contract is enforced STRUCTURALLY, not assumed. Plan discovery today writes no
  // api_cache rows anyway — its listings are paginated (noStore: cache fully bypassed) and branch
  // discovery is GraphQL (never cached) — but the contract must NOT depend on that staying true: a
  // db-backed client plus any future discovery call that caches would silently write into the DB in
  // plan mode. Rejecting a db-backed client up front keeps "--plan writes nothing" a durable
  // invariant. An internal contract violation (a bug, not an operator error), so a plain Error with
  // a stack is the right rendering.
  if (client.cachesToDb) throw new Error("runPlan requires a cache-less client (db: null) — plan mode must not write api_cache");
  const { owners, source } = await resolveOwners(client, config, personalLogin);

  let reposDiscovered = 0, reposKept = 0, branchesEligible = 0, branchesSkippedByCutoff = 0, branchesPastCap = 0, branchesExcludedByPolicy = 0, discoveryErrors = 0;
  let excludedByDeny = 0, excludedByAllow = 0, defaultBranchPolicyOverrides = 0; // policy diagnostics (overlays)
  const coverages: RepoPolicyCoverage[] = []; // per successfully-discovered repo, for the warning finalizer
  for (const owner of owners) {
    const isPersonal = config.includePersonalNamespace && owner === personalLogin;
    let repos: RepoInfo[];
    try {
      repos = isPersonal ? await client.listUserRepos(owner) : await client.listOrgRepos(owner);
    } catch (e) {
      discoveryErrors++;
      logLine({ event: "plan", org: owner, error: `repo discovery failed: ${(e as Error).message}` });
      continue;
    }
    reposDiscovered += repos.length;
    const kept = filterSortCapRepos(repos, {
      includeArchived: config.includeArchived, includeForks: config.includeForks, maxReposPerOrg: config.maxReposPerOrg,
    });
    reposKept += kept.length;
    for (const repo of kept) {
      // --plan has no DB, so it consumes the client directly rather than via discoverBranchHeads. It
      // must still take the default branch from the SAME snapshot as the heads (§5.B) — a --plan that
      // sourced it differently from the run would report a scan scope the run would not produce.
      let snapshot: BranchSnapshot;
      try {
        snapshot = await client.listBranchHeads(repo.organization, repo.name);
      } catch (e) {
        discoveryErrors++;
        logLine({ event: "plan", org: repo.organization, repo: repo.name, error: `branch discovery failed: ${(e as Error).message}` });
        continue;
      }
      // The SAME shared planner the real run uses, so --plan and the run can never disagree (§5).
      // branchesEligible counts toScan (default + within-cap after-cutoff); policy-excluded is its own
      // disjoint bucket. A match-time PolicyMatchError propagates FATAL (no DB to mark; main exits 1).
      const p = planRepoBranches(snapshot, branchPolicy, config.cutoffDate, config.maxBranchesPerRepo);
      const diag = planPolicyDiagnostics(p); // fail-closed deny/allow split + default-override count
      coverages.push(p.coverage); // this repo was discovered successfully (even if empty) — warning coverage
      branchesEligible += p.toScan.length;
      branchesSkippedByCutoff += p.cutoffSkipped.length;
      branchesPastCap += p.pastCap.length;
      branchesExcludedByPolicy += p.policyExcluded.length;
      excludedByDeny += diag.excludedByDeny;
      excludedByAllow += diag.excludedByAllow;
      defaultBranchPolicyOverrides += diag.defaultBranchPolicyOverrides;
      logLine({
        event: "plan", org: repo.organization, repo: repo.name,
        branchesEligible: p.toScan.length, branchesSkippedByCutoff: p.cutoffSkipped.length,
        branchesPastCap: p.pastCap.length, branchesExcludedByPolicy: p.policyExcluded.length,
        excludedByDeny: diag.excludedByDeny, excludedByAllow: diag.excludedByAllow,
        defaultBranchPolicyOverrides: diag.defaultBranchPolicyOverrides,
      });
    }
  }

  // Emit the unmatched-pattern warnings (before plan-summary) — identical to runScan's set.
  const warnings = emitPolicyWarnings(branchPolicy, coverages);

  const totals: PlanTotals = { owners, ownersSource: source, reposDiscovered, reposKept, branchesEligible, branchesSkippedByCutoff, branchesPastCap, branchesExcludedByPolicy, excludedByDeny, excludedByAllow, defaultBranchPolicyOverrides, discoveryErrors };
  logLine({ event: "plan-summary", ...totals });
  process.stderr.write(planSummaryText(config, totals, warnings));
  return totals;
}

// The human-facing plan block goes to STDERR so stdout stays pure JSONL for pipes/agents.
// The param names only the three config fields the text actually reads (interface segregation —
// tests can pass the narrow literal instead of forging a full Config).
export function planSummaryText(
  config: Pick<Config, "cutoffDate" | "maxBranchesPerRepo" | "packages">, t: PlanTotals, warnings: readonly PolicyWarning[] = [],
): string {
  const lines = [
    "",
    "PLAN — preview only: no database opened, nothing scanned, nothing written",
    `  Owners (${t.ownersSource}):  ${t.owners.join(", ")}`,
    `  Repos:                ${t.reposDiscovered} discovered, ${t.reposKept} kept after archive/fork filters and caps`,
    `  Branches:             ${t.branchesEligible} eligible to scan (a real run may skip already-current ones)`,
    `                        ${t.branchesSkippedByCutoff} skipped by cutoff (< ${config.cutoffDate}) · ${t.branchesPastCap} past the per-repo cap (${config.maxBranchesPerRepo}) · ${t.branchesExcludedByPolicy} excluded by branch policy`,
    // Policy breakdown, shown only when policy actually removed or overrode branches. Wording avoids
    // "scanned" (the plan header promises nothing is scanned); overrides are flagged as already-eligible.
    ...(t.branchesExcludedByPolicy > 0 || t.defaultBranchPolicyOverrides > 0
      ? [`  Policy detail:        ${t.excludedByDeny} excluded by deny · ${t.excludedByAllow} excluded as not allow-listed · ${t.defaultBranchPolicyOverrides} default-branch policy override(s) (already counted as eligible)`]
      : []),
    `  Packages tracked:     ${config.packages.map((p) => p.name).join(", ")}`,
    `  Discovery errors:     ${t.discoveryErrors}`,
    ...policyWarningLines(warnings),
    // Names the two coarse POSITIVE selectors for the dimensions the block above actually reports —
    // owners and branches. Deliberately not a lever inventory: excludeOrganizations, excludeBranches,
    // cutoffDate, maxReposPerOrg and maxBranchesPerRepo all narrow too, but they refine a universe
    // rather than define it, and a hint listing every lever tells you nothing. "organizations" stays
    // first because it is the real blast radius (discovery mode enumerates every org the token can
    // see); branch policy never shrinks the repo set and cannot exclude a default branch.
    `  Next:                 bun run audit   (if broader than intended, narrow the root-level allowlists first: "organizations" and/or "branches")`,
    "",
  ];
  return lines.join("\n");
}

// Entry point (guarded so importing this module — e.g. from tests — never launches an audit).
if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(renderFatal(e, { command: "orchestrate", usage: ORCHESTRATE_USAGE }));
    process.exit(1);
  });
}
