// orchestrate.ts — the single-writer coordinator (§5, §8). Entry point:
//   bun run scripts/orchestrate.ts [--config <path>] [--fresh] [--purge-cache] \
//                                  [--rescan-branch <org>/<repo>@<branch>]...
// Flow (§8): restate config → preflight (§2) → resolve effective owners (§1) → start/resume run
// (§3) → discover repos+branches and process each branch unit (§5.A-H) → reconcile introspection
// (§5.E) → BIN-term CLI pass (§5.G) → mark run completed. ALL SQLite writes happen HERE (single
// writer); per-unit reads fan out through the guarded github wrapper. Deterministic iteration
// order (owners/repos/branches sorted) so runs are reproducible.

import { readdirSync, lstatSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { AuditDb, nowIso, type WorkUnitKey } from "./db.ts";
import { GithubClient, filterSortCapRepos, type RepoInfo, type BranchHead } from "./github.ts";
import { assertContained } from "./readOnlyGuard.ts";
import { parseArgs, type OrchestrateArgs } from "./args.ts";
import { runPreflight } from "./preflight.ts";
import { resolveEffectiveOwners } from "./ownerResolve.ts";
import { scanUnit, type TreeEntry, type UnitLocation } from "./unitPipeline.ts";
import { parseSemver, maxSatisfying } from "./semver.ts";
import { parseAlias, type DependencyType } from "./manifest.ts";
import { introspectVersion, fetchPackument, resolveRangeToVersion, type Packument } from "./apiSurface.ts";
import { emitReport } from "./report.ts";
import type { CliTermSet } from "./cliScanner.ts";

// One structured JSON log line (§6/§8 observability).
function logLine(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// ---- per-unit read helpers ------------------------------------------------------------------
// API reader: SHA-pinned raw fetch (≤100MB) for blob entries; non-blobs (submodule/symlink) and
// failures return null. SHA-pinned reads are served from api_cache with zero network on re-read.
function apiReader(client: GithubClient, org: string, repo: string, commitSha: string) {
  return async (path: string, entry: TreeEntry): Promise<string | null> => {
    if (entry.type !== "blob") return null;
    try {
      return await client.fetchFileRaw(org, repo, path, commitSha);
    } catch {
      return null;
    }
  };
}

// Clone-fallback reader: read a file from the walked clone dir, contained to that dir.
function cloneReader(cloneDir: string) {
  return async (path: string, _entry: TreeEntry): Promise<string | null> => {
    try {
      const abs = join(cloneDir, path);
      assertContained(abs, [cloneDir]);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    } catch {
      return null;
    }
  };
}

// Walk a cloned working tree into TreeEntry rows (blobs only; size from lstat). Skips .git and
// symlinks (never followed). Paths are repo-relative POSIX.
function walkClone(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel === "" ? root : join(root, rel);
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of names) {
      if (rel === "" && name === ".git") continue;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      let st;
      try {
        st = lstatSync(join(root, childRel));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(childRel);
      else if (st.isFile()) out.push({ path: childRel, type: "blob", sha: "", size: st.size });
    }
  }
  return out;
}

// ---- coordinator ----------------------------------------------------------------------------
async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const args: OrchestrateArgs = parseArgs(argv);
  const { config, configHash } = await loadConfig(argv);
  const trackedNames = config.packages.map((p) => p.name);

  logLine({ event: "config", packages: trackedNames, cutoffDate: config.cutoffDate, githubHost: config.githubHost, organizations: config.organizations, fresh: args.fresh });

  // §2/§8: preflight runs BEFORE any work — especially before opening/migrating the DB or a
  // destructive --fresh drop. Preflight uses a cache-less client (a handful of one-shot calls).
  const preflightClient = new GithubClient({ githubHost: config.githubHost });
  const preflight = await runPreflight(preflightClient, config);
  logLine({ event: "preflight", login: preflight.githubLogin, tarFlavor: preflight.tarFlavor, coreRemaining: preflight.coreRemaining, graphqlRemaining: preflight.graphqlRemaining });

  // Only AFTER preflight passes do we touch the database (open/migrate/--fresh) and build the
  // caching client for the scan.
  const db = AuditDb.open({ sqlitePath: config.paths.sqlitePath, fresh: args.fresh, purgeCache: args.purgeCache });
  const client = new GithubClient({ githubHost: config.githubHost, db, concurrency: config.concurrency.repositories });

  try {
    // §0 startup: sweep stale temp dirs from a prior crash.
    client.sweepStaleTempDirs();

    // §1 effective owner resolution (discovery runs every invocation).
    const discoveredOrgs = config.organizations === null ? await client.listOrgMemberships() : [];
    const { owners, source } = resolveEffectiveOwners({
      organizations: config.organizations,
      excludeOrganizations: config.excludeOrganizations,
      includePersonalNamespace: config.includePersonalNamespace,
      discoveredOrgs,
      personalLogin: config.includePersonalNamespace ? preflight.githubLogin : null,
    });
    logLine({ event: "owners", owners, source });

    // §3 run lifecycle: start or resume.
    const { runId, resumed } = db.startRun({
      configHash, effectiveOwners: owners, ownersSource: source,
      trackedPackages: trackedNames, cutoffDate: config.cutoffDate, githubHost: config.githubHost,
    });
    const resume = db.resumeInfo(configHash);
    logLine({ event: "run", runId, resumed, counts: resume.counts });

    // §3 --rescan-branch: reset matching branch units to pending BEFORE discovery.
    for (const t of args.rescanBranches) {
      const reset = db.rescanBranch(configHash, t.organization, t.repository, t.branch);
      logLine({ event: "rescan-branch", target: `${t.organization}/${t.repository}@${t.branch}`, reset });
    }

    const nonRegistrySkipSeen = new Set<string>();

    // §5.G bin discovery: introspect each tracked package's LATEST published version ONCE up
    // front to learn its bin names, so the per-unit CLI scan runs specifier + bin terms in a
    // SINGLE pass (no fragile post-introspection re-scan). Bins are version-stable, and this also
    // covers a CLI-only package invoked with no manifest declaration (§5.G/§7 usageByRepo union).
    const cliTermSets = await discoverCliTerms(db, client, config, runId);
    logLine({ event: "cli-terms", terms: cliTermSets.map((t) => ({ name: t.name, bins: t.binNames })) });

    // §5.A/§5.B discover + process, deterministically.
    for (const owner of owners) {
      const isPersonal = config.includePersonalNamespace && owner === preflight.githubLogin;
      let repos: RepoInfo[];
      try {
        repos = isPersonal ? await client.listUserRepos() : await client.listOrgRepos(owner);
      } catch (e) {
        db.insertError({ runId, scope: "discovery", organization: owner, message: `repo discovery failed: ${(e as Error).message}` });
        continue;
      }
      const kept = filterSortCapRepos(repos, {
        includeArchived: config.includeArchived, includeForks: config.includeForks, maxReposPerOrg: config.maxReposPerOrg,
      });
      for (const repo of kept) {
        await processRepo(db, client, config, runId, configHash, owner, repo, cliTermSets, nonRegistrySkipSeen);
      }
    }

    // §5.E introspection reconciliation over the run's reportable slice.
    await reconcileIntrospection(db, client, config, runId, trackedNames);

    // §8 step 6: mark completed BEFORE the report reads (so generatedAt=completed_at).
    db.completeRun(runId);
    // §8 step 7: produce the consolidated §7 report (run-<id>.json + latest.json) from SQLite.
    const completedRun = db.getRun(runId)!;
    const reportPath = emitReport(db, completedRun, config.paths.outputDir, { alsoLatest: true });
    const head = db.read(`SELECT COUNT(*) AS n FROM run_unit_head WHERE run_id = ? AND status='scanned'`).get(runId) as { n: number };
    logLine({ event: "done", runId, unitsScanned: head.n, report: reportPath });
  } finally {
    db.close();
  }
}

// Discover a repo's branches, apply the cutoff + cap, and process/skip each branch unit (§5.B/§3).
async function processRepo(
  db: AuditDb, client: GithubClient, config: Config, runId: string, configHash: string,
  owner: string, repo: RepoInfo, cliTermSets: CliTermSet[], nonRegistrySkipSeen: Set<string>,
): Promise<void> {
  let heads: BranchHead[];
  try {
    heads = await client.listBranchHeads(repo.organization, repo.name);
  } catch (e) {
    db.insertError({ runId, scope: "discovery", organization: repo.organization, repository: repo.name, message: `branch discovery failed: ${(e as Error).message}` });
    return;
  }
  // §5.B ordering: heads arrive sorted committedDate DESC. Filter CUTOFF branches FIRST (record
  // EVERY still-live branch before cutoffDate as skipped-cutoff, regardless of the cap), THEN cap
  // the after-cutoff survivors at maxBranchesPerRepo (older survivors past the cap retain their
  // prior state and are not surfaced this run).
  let keptCount = 0;
  for (const h of heads) {
    const key: WorkUnitKey = { configHash, scope: "branch", organization: repo.organization, repository: repo.name, branch: h.name };
    if (h.committedDate.slice(0, 10) < config.cutoffDate) {
      db.enqueueUnit(key, runId);
      db.setUnitStatus(key, { status: "skipped", runId, lastCommitSha: "", lastCommitDate: h.committedDate });
      db.upsertRunUnitHead({ runId, organization: repo.organization, repository: repo.name, branch: h.name, commitSha: "", status: "skipped-cutoff" });
      logLine({ event: "unit", org: repo.organization, repo: repo.name, branch: h.name, commit: "", action: "skip-cutoff" });
      continue;
    }
    if (keptCount >= config.maxBranchesPerRepo) continue; // after-cutoff past the cap → retain prior state
    keptCount++;

    db.enqueueUnit(key, runId);
    const unit = db.getUnit(key);
    // §3 skip predicate: a done unit of THIS config whose stored head equals the LIVE head is
    // reused (skip-as-current) — still upsert run_unit_head for THIS run so the report includes it.
    if (unit !== null && unit.status === "done" && unit.lastCommitSha === h.oid) {
      db.upsertRunUnitHead({ runId, organization: repo.organization, repository: repo.name, branch: h.name, commitSha: h.oid, status: "scanned" });
      db.setUnitStatus(key, { status: "done", runId, lastCommitSha: h.oid, lastCommitDate: h.committedDate });
      logLine({ event: "unit", org: repo.organization, repo: repo.name, branch: h.name, commit: h.oid, action: "skip-current" });
      continue;
    }

    db.setUnitStatus(key, { status: "in_progress", runId });
    try {
      const scannedCommit = await processUnit(db, client, config, runId, repo, h, cliTermSets, nonRegistrySkipSeen);
      db.setUnitStatus(key, { status: "done", runId, lastCommitSha: scannedCommit, lastCommitDate: h.committedDate, errorMessage: null });
    } catch (e) {
      db.insertError({ runId, scope: "scan", organization: repo.organization, repository: repo.name, branch: h.name, message: (e as Error).message });
      db.setUnitStatus(key, { status: "error", runId, errorMessage: (e as Error).message });
      logLine({ event: "unit", org: repo.organization, repo: repo.name, branch: h.name, commit: h.oid, action: "error", message: (e as Error).message });
    }
  }
}

// Scan ONE branch unit: fetch the tree (clone fallback on truncation), run the §5.C-H pipeline,
// and WRITE every finding + the run_unit_head snapshot (single-writer).
async function processUnit(
  db: AuditDb, client: GithubClient, config: Config, runId: string,
  repo: RepoInfo, h: BranchHead, cliTermSets: CliTermSet[], nonRegistrySkipSeen: Set<string>,
): Promise<string> {
  const tree = await client.fetchTreeRecursive(repo.organization, repo.name, h.treeOid);
  let entries: TreeEntry[];
  let readFile: (path: string, entry: TreeEntry) => Promise<string | null>;
  let cloneDir: string | null = null;
  // The ACTUAL scanned commit: the discovery head (h.oid) for the API path, or the clone's real
  // HEAD for the fallback (the branch may have moved between GraphQL discovery and the clone; all
  // findings/permalinks/run_unit_head must pin to what was truly scanned, §5.C).
  let commitSha = h.oid;
  if (tree.truncated) {
    const cloned = await client.cloneShallow(repo.organization, repo.name, h.name);
    cloneDir = cloned.dir;
    commitSha = cloned.headSha;
    entries = walkClone(cloned.dir);
    readFile = cloneReader(cloned.dir);
  } else {
    entries = tree.paths.map((p) => ({ path: p.path, type: p.type, sha: p.sha, size: p.size }));
    readFile = apiReader(client, repo.organization, repo.name, h.oid);
  }
  const loc: UnitLocation = { githubHost: config.githubHost, organization: repo.organization, repository: repo.name, branch: h.name, commitSha };

  try {
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
      db.insertError({ runId, scope: "introspection", packageName: s.packageName, version: s.rawSpec, message: `non-registry spec skipped (not introspectable): ${s.rawSpec}` });
    }
    db.upsertRunUnitHead({ runId, organization: loc.organization, repository: loc.repository, branch: loc.branch, commitSha: loc.commitSha, status: "scanned" });

    logLine({ event: "unit", org: repo.organization, repo: repo.name, branch: h.name, commit: commitSha, action: "scanned", deps: result.dependencyFindings.length, usage: result.usageFindings.length, cli: result.cliFindings.length });
    return commitSha;
  } finally {
    if (cloneDir !== null) {
      // the clone lives under a run temp dir (pkg-audit-*/clone) — remove that temp dir, but
      // containment-check the target first so a future refactor can never rm outside tempRoot.
      try {
        const runTempDir = dirname(cloneDir);
        assertContained(runTempDir, [client.tempRoot]);
        rmSync(runTempDir, { recursive: true, force: true });
      } catch {
        // best-effort
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

async function reconcileIntrospection(db: AuditDb, client: GithubClient, config: Config, runId: string, trackedNames: string[]): Promise<void> {
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
      db.insertError({ runId, scope: "introspection", packageName: pkg, message: `packument fetch failed: ${(e as Error).message}` });
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
async function discoverCliTerms(db: AuditDb, client: GithubClient, config: Config, runId: string): Promise<CliTermSet[]> {
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
        const bins = db.read(`SELECT DISTINCT export_name FROM package_api_surface WHERE package_name = ? AND export_kind='cli-bin' AND version = ?`).all(pkg.name, latest) as Array<{ export_name: string }>;
        binNames = bins.map((b) => b.export_name).filter((b) => b !== "");
      }
    } catch (e) {
      db.insertError({ runId, scope: "introspection", packageName: pkg.name, message: `bin discovery failed: ${(e as Error).message}` });
    }
    sets.push({ packageName: pkg.name, name: pkg.name, binNames });
  }
  return sets;
}

// Entry point.
main().catch((e) => {
  process.stderr.write(`orchestrate failed: ${(e as Error).stack ?? (e as Error).message}\n`);
  process.exit(1);
});
