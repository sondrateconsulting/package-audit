// unitPipeline.ts — the §5.C-H per-branch-unit engine. Given a resolved tree file list and an
// injected `readFile` (the orchestrator handles tree fetch, the raw/blob size split, and the
// truncated-tree clone fallback behind it), produce the structured findings for ONE unit:
// dependency facts (§5.D) with lockfile resolution, in-repo API usage (§5.F), and SPECIFIER-term
// CLI usage (§5.G part 1). BIN-term CLI usage (§5.G part 2) is a separate pass the orchestrator
// runs after introspection yields bin names. No db, no direct network — all I/O is injected, so
// the whole unit is deterministic and testable.

import { buildPermalink } from "./permalink.ts";
import {
  extractDependencyFacts, installNameSet, locateManifests, nearestLockfile, resolveOwningManifest,
  dirOf, type DependencyFact, type LockfileRef,
} from "./manifest.ts";
import { resolveFromLockfile, type LockResolution } from "./lockfile.ts";
import { scanUsage, type TrackedPackage, type UsageRow } from "./usageScanner.ts";
import { scanCli, classifyFile, type CliTermSet, type CliRow } from "./cliScanner.ts";
import type { DependencyType } from "./manifest.ts";
import type { TreeEntryType } from "./github.ts"; // type-only: the git object types, one source of truth

// A tree entry (from the git/trees API or a walked clone). `type` is the git object type — the
// same closed set github.ts validates git/trees against, so `e.type === "blob"` typos and fixture
// drift are compile errors.
export interface TreeEntry {
  path: string;
  type: TreeEntryType;
  sha: string; // blob SHA (for the raw/blob size split)
  size: number | null;
}

export interface UnitLocation {
  githubHost: string;
  organization: string;
  repository: string;
  branch: string;
  commitSha: string;
}

export interface UnitConfig {
  trackedPackages: string[]; // registry names
  excludeDirGlobs: string[];
}

// Injected reader: resolve a repo-relative path to its text, or null when it cannot be read
// (missing, oversized, binary, or a fetch failure — the caller decides). Async because the
// orchestrator may hit the network (SHA-pinned reads are served from cache with no request).
export type ReadFile = (path: string, entry: TreeEntry) => Promise<string | null>;

// ---- outputs (runId + timestamps are stamped by the coordinator) ----------------------------
export interface DependencyFindingFact {
  organization: string;
  repository: string;
  branch: string;
  commitSha: string;
  packageName: string;
  dependencyKey: string;
  dependencyType: DependencyType;
  manifestPath: string;
  manifestLine: number;
  manifestPermalink: string;
  declaredVersion: string;
  resolutionRange: string; // for §5.E range fallback when no lockfile resolved a version
  lockfilePath: string | null;
  lockfileKind: LockfileRef["kind"] | null;
  lockfileLines: number[] | null;
  lockfilePermalink: string | null;
  resolvedVersion: string | null;
  resolvedVersionSource: "lockfile" | null; // 'range-resolved' is written later by the coordinator
}

// A non-registry resolved spec (git+/file:/workspace:/…) that is recorded on the finding but
// EXCLUDED from versionsSeen; the coordinator logs a package-scoped skip error once (§5.E).
export interface NonRegistrySkip {
  packageName: string;
  rawSpec: string; // the raw non-registry resolved reference (for traceability)
}

export interface UnitResult {
  dependencyFindings: DependencyFindingFact[];
  usageFindings: UsageRow[]; // import/require/etc. (§5.F)
  cliFindings: CliRow[]; // CLI usage (§5.G) — specifier + (introspection-supplied) bin terms
  nonRegistrySkips: NonRegistrySkip[];
}

// A declared version is NON-registry when it carries a non-registry protocol (git+/file:/…) or a
// tarball URL — mirrors deriveRange's non-registry classification so a no-lockfile declaration of
// such a spec is a §5.E skip logged at SCAN time (only when the unit is actually scanned).
const NON_REGISTRY_DECLARED = /^(git\+|git:|file:|link:|portal:|patch:|workspace:|catalog:|github:|gitlab:|bitbucket:|gist:|https?:)/i;

// Source extensions the import scanner understands (§5.F). Other blobs are not import-scanned.
const SCANNABLE_EXT = /\.(mts|cts|ts|tsx|mjs|cjs|js|jsx)$/;
const MAX_SCAN_BYTES = 2 * 1024 * 1024; // skip a huge (minified/generated) file — not real source

// Build a path-exclusion predicate from config.excludeDirGlobs using Bun.Glob.
export function makeExcluder(globs: string[]): (path: string) => boolean {
  const matchers = globs.map((g) => new Bun.Glob(g));
  return (path: string) => matchers.some((m) => m.match(path));
}

// `cliTermSets` carries the specifier term plus any introspection-supplied bin names per tracked
// package (built once by orchestrate before scanning — §5.G), so CLI usage is found in ONE pass.
export async function scanUnit(loc: UnitLocation, cfg: UnitConfig, entries: TreeEntry[], readFile: ReadFile, cliTermSets: CliTermSet[]): Promise<UnitResult> {
  const isExcluded = makeExcluder(cfg.excludeDirGlobs);
  const blobs = entries.filter((e) => e.type === "blob");
  const { manifests, lockfiles } = locateManifests(blobs.map((e) => e.path), isExcluded);
  const entryByPath = new Map(entries.map((e) => [e.path, e]));

  // 1. dependency facts per manifest (§5.D)
  const factsByManifestDir = new Map<string, { manifestPath: string; facts: DependencyFact[] }>();
  const manifestFactList: Array<{ path: string; facts: DependencyFact[] }> = [];
  for (const mPath of manifests) {
    const entry = entryByPath.get(mPath);
    if (entry === undefined) continue;
    const text = await readFile(mPath, entry);
    if (text === null) continue;
    let facts: DependencyFact[];
    try {
      facts = extractDependencyFacts(text, cfg.trackedPackages);
    } catch {
      continue; // a malformed manifest never fails the unit (§5.D)
    }
    factsByManifestDir.set(dirOf(mPath), { manifestPath: mPath, facts });
    manifestFactList.push({ path: mPath, facts });
  }

  // 2. resolve each fact against its nearest lockfile → dependency findings
  const dependencyFindings: DependencyFindingFact[] = [];
  const nonRegistrySkips: NonRegistrySkip[] = [];
  const lockfileTextCache = new Map<string, string | null>();
  const readLockfile = async (lf: LockfileRef): Promise<string | null> => {
    if (lockfileTextCache.has(lf.path)) return lockfileTextCache.get(lf.path)!;
    const entry = entryByPath.get(lf.path);
    const text = entry === undefined || lf.binary ? null : await readFile(lf.path, entry);
    lockfileTextCache.set(lf.path, text);
    return text;
  };

  for (const { path: mPath, facts } of manifestFactList) {
    for (const fact of facts) {
      const lf = nearestLockfile(mPath, lockfiles);
      let resolution: LockResolution | null = null;
      if (lf !== null) {
        const text = lf.binary ? "" : await readLockfile(lf);
        if (lf.binary || text !== null) {
          resolution = resolveFromLockfile({
            kind: lf.kind, text: text ?? "", binary: lf.binary,
            manifestDir: dirOf(mPath), dependencyKey: fact.dependencyKey,
            registryName: fact.packageName, declaredRange: fact.resolutionRange,
          });
        }
      }
      const resolved = resolution !== null && resolution.matched ? resolution : null;
      // §5.E non-registry skips, logged at SCAN time (so a later skip-as-current run never
      // re-emits them): (a) a LOCKFILE resolution to a non-registry ref, or (b) a NO-lockfile
      // declaration of a non-registry protocol spec (git+/file:/… — never introspectable).
      const isNonRegistryResolved = resolved !== null && !resolved.isRegistry && resolved.resolvedVersion !== null;
      if (isNonRegistryResolved) {
        nonRegistrySkips.push({ packageName: fact.packageName, rawSpec: resolved!.resolvedVersion! });
      } else if (lf === null && resolved === null && NON_REGISTRY_DECLARED.test(fact.declaredVersion.trim())) {
        nonRegistrySkips.push({ packageName: fact.packageName, rawSpec: fact.declaredVersion });
      }

      dependencyFindings.push({
        organization: loc.organization, repository: loc.repository, branch: loc.branch, commitSha: loc.commitSha,
        packageName: fact.packageName, dependencyKey: fact.dependencyKey, dependencyType: fact.dependencyType,
        manifestPath: mPath, manifestLine: fact.manifestLine,
        manifestPermalink: buildPermalink({ githubHost: loc.githubHost, org: loc.organization, repo: loc.repository, commitSha: loc.commitSha, path: mPath, line: fact.manifestLine }),
        declaredVersion: fact.declaredVersion, resolutionRange: fact.resolutionRange,
        lockfilePath: lf?.path ?? null, lockfileKind: lf?.kind ?? null,
        lockfileLines: resolved?.lines ?? null,
        lockfilePermalink: lf !== null && resolved?.lines != null && resolved.lines.length > 0
          ? buildPermalink({ githubHost: loc.githubHost, org: loc.organization, repo: loc.repository, commitSha: loc.commitSha, path: lf.path, line: spanOf(resolved.lines) })
          : null,
        // a REGISTRY resolution contributes an introspectable semver; a non-registry spec is
        // recorded raw but its source stays null (excluded from versionsSeen, §5.E).
        resolvedVersion: resolved !== null ? resolved.resolvedVersion : null,
        resolvedVersionSource: resolved !== null && resolved.isRegistry && resolved.resolvedVersion !== null ? "lockfile" : null,
      });
    }
  }

  // 3. in-repo API usage (§5.F) + CLI usage (§5.G, specifier + bin terms in one pass)
  const usageFindings: UsageRow[] = [];
  const cliFindings: CliRow[] = [];

  for (const entry of blobs) {
    if (isExcluded(entry.path) || /(^|\/)node_modules\//.test(entry.path)) continue;
    if (entry.size !== null && entry.size > MAX_SCAN_BYTES) continue;

    // import/usage scan (source files only)
    if (SCANNABLE_EXT.test(entry.path)) {
      const packages = trackedPackagesForFile(entry.path, cfg.trackedPackages, factsByManifestDir);
      if (packages.length > 0) {
        const text = await readFile(entry.path, entry);
        if (text !== null) {
          usageFindings.push(...scanUsage(text, { ...loc, filePath: entry.path }, packages));
        }
      }
    }

    // CLI scan (§5.G file kinds) — one pass with specifier + bin terms.
    if (classifyFile(entry.path) !== "other") {
      const text = await readFile(entry.path, entry);
      if (text !== null) cliFindings.push(...scanCli(text, { ...loc, filePath: entry.path }, cliTermSets));
    }
  }

  return { dependencyFindings, usageFindings, cliFindings, nonRegistrySkips };
}

// The tracked packages that RESOLVE for a source file, each with the owning manifest's install
// names (§5.F). A package with no owning manifest in the file's ancestor chain is dropped.
function trackedPackagesForFile(
  filePath: string,
  trackedPackages: string[],
  factsByManifestDir: Map<string, { manifestPath: string; facts: DependencyFact[] }>,
): TrackedPackage[] {
  const out: TrackedPackage[] = [];
  for (const name of trackedPackages) {
    const owning = resolveOwningManifest(filePath, factsByManifestDir, name);
    if (owning !== null && owning.installNames.size > 0) out.push({ packageName: name, installNames: owning.installNames });
  }
  return out;
}

// A lockfile line list → the permalink LineSpan (single line collapses to #Ln, a contiguous
// block to #La-Lb using its min/max).
function spanOf(lines: number[]): number | readonly [number, number] {
  const min = Math.min(...lines);
  const max = Math.max(...lines);
  return min === max ? min : [min, max];
}

// Re-export the install-name helper so the orchestrator can build subpath attribution if needed.
export { installNameSet };
