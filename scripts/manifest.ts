// manifest.ts — pure manifest/lockfile FACT extraction (§5.C discovery, §5.D dependency facts,
// §5.F owning-manifest + install-name set). No I/O: the caller supplies file paths (from the
// git tree) and file contents; this module locates manifests/lockfiles, extracts tracked-package
// declarations with 1-based key lines, classifies alias vs shadow, and resolves the owning
// manifest for an in-repo source file. Version RESOLUTION is delegated to lockfile.ts.

import { parseJsoncObject, escapePointer, type JsonValue } from "./jsonc.ts";
import type { LockfileKind } from "./lockfile.ts";

export type DependencyType =
  | "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies"
  | "overrides" | "resolutions";

const NORMAL_SECTIONS: DependencyType[] = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

export interface DependencyFact {
  packageName: string; // the tracked registry name this declaration resolves to
  dependencyKey: string; // the manifest key (= packageName unless aliased)
  dependencyType: DependencyType;
  declaredVersion: string; // the exact raw manifest value
  manifestLine: number; // 1-based line of the KEY token
  isAlias: boolean; // value was `npm:<name>@<range>`
  resolutionRange: string; // the range used for lockfile disambiguation / §5.E range fallback
}

// ---- alias parsing --------------------------------------------------------------------------
export interface AliasSpec {
  name: string; // the aliased registry name (scoped-safe)
  range: string; // the version range after the name ('' when omitted)
}

// Parse an `npm:<name>@<range>` alias value. Returns null when the value is not an npm alias.
export function parseAlias(value: string): AliasSpec | null {
  if (!value.startsWith("npm:")) return null;
  const rest = value.slice("npm:".length);
  // split at the LAST '@' that is not the scoped-name leading '@'
  const at = rest.lastIndexOf("@");
  if (at > 0) return { name: rest.slice(0, at), range: rest.slice(at + 1) };
  return { name: rest, range: "" }; // `npm:<name>` with no explicit range
}

// ---- dependency-fact extraction (§5.D) ------------------------------------------------------
// For each tracked registry name, a declaration "appears" when the KEY equals the name (and is
// not shadowed by an alias to a different package) OR the VALUE is an npm-alias targeting it.
export function extractDependencyFacts(text: string, trackedNames: Iterable<string>): DependencyFact[] {
  const tracked = new Set(trackedNames);
  const { value, keyLines } = parseJsoncObject(text);
  const facts: DependencyFact[] = [];
  const declaredNormally = new Set<string>(); // registryName seen in a NORMAL section (for overrides gating)

  for (const section of NORMAL_SECTIONS) {
    const sec = value[section];
    if (sec === undefined || sec === null || typeof sec !== "object" || Array.isArray(sec)) continue;
    for (const [key, raw] of Object.entries(sec as Record<string, JsonValue>)) {
      if (typeof raw !== "string") continue;
      const line = keyLines.get(`/${section}/${escapePointer(key)}`) ?? 0;
      const alias = parseAlias(raw);
      if (alias !== null) {
        // an alias resolves to alias.name — a finding iff we track that name (§5.D). Works for
        // a self-alias ("expo":"npm:expo@^50") and an alias under any other key.
        if (tracked.has(alias.name)) {
          facts.push({ packageName: alias.name, dependencyKey: key, dependencyType: section, declaredVersion: raw, manifestLine: line, isAlias: true, resolutionRange: alias.range });
          declaredNormally.add(alias.name);
        }
        // else: the key is shadowed to a package we don't track — never a finding for `key`.
      } else if (tracked.has(key)) {
        // direct install under the package's own (unshadowed) name.
        facts.push({ packageName: key, dependencyKey: key, dependencyType: section, declaredVersion: raw, manifestLine: line, isAlias: false, resolutionRange: raw });
        declaredNormally.add(key);
      }
    }
  }

  // overrides (npm) / resolutions (yarn/pnpm): RESOLUTION changes, recorded ONLY when the
  // package is also declared normally (best-effort, §5.D — never a standalone appearance).
  for (const [section, sectionKey] of [["overrides", "overrides"], ["resolutions", "resolutions"]] as const) {
    const sec = value[sectionKey];
    if (sec === undefined || sec === null || typeof sec !== "object" || Array.isArray(sec)) continue;
    for (const hit of scanOverrides(sec as Record<string, JsonValue>, `/${sectionKey}`, keyLines, tracked)) {
      if (declaredNormally.has(hit.packageName))
        facts.push({ packageName: hit.packageName, dependencyKey: hit.packageName, dependencyType: section, declaredVersion: hit.declaredVersion, manifestLine: hit.line, isAlias: false, resolutionRange: hit.declaredVersion });
    }
  }
  return facts;
}

interface OverrideHit {
  packageName: string;
  declaredVersion: string;
  line: number;
}

// Recursively collect tracked-package hits in an overrides/resolutions subtree. A key matches a
// tracked name directly, or (resolutions glob like `**/foo` or `a/b/foo`) by its LAST '/'
// segment. A string value at that key is the override version; a nested object is descended.
function scanOverrides(
  node: Record<string, JsonValue>,
  path: string,
  keyLines: Map<string, number>,
  tracked: Set<string>,
): OverrideHit[] {
  const hits: OverrideHit[] = [];
  for (const [key, raw] of Object.entries(node)) {
    const name = matchedTrackedName(key, tracked); // scoped-safe: `**/@scope/pkg` → `@scope/pkg`
    const childPath = `${path}/${escapePointer(key)}`;
    if (name !== null && typeof raw === "string") {
      hits.push({ packageName: name, declaredVersion: raw, line: keyLines.get(childPath) ?? 0 });
    } else if (name !== null && raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      // nested form `{ "foo": { ".": "1.0.0" } }` — the "." entry is foo's OWN version. Only
      // emit when "." is present; a bare parent object (`{ "foo": { "bar": "..." } }` = "when
      // foo depends on bar") is NOT a direct override of foo and must not yield an empty fact.
      const dot = (raw as Record<string, JsonValue>)["."];
      if (typeof dot === "string") {
        // the version is on the "." key line, not the parent package key line
        const dotLine = keyLines.get(`${childPath}/${escapePointer(".")}`) ?? keyLines.get(childPath) ?? 0;
        hits.push({ packageName: name, declaredVersion: dot, line: dotLine });
      }
    }
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      hits.push(...scanOverrides(raw as Record<string, JsonValue>, childPath, keyLines, tracked));
    }
  }
  return hits;
}

// The tracked name an override/resolution KEY targets. An override/resolution key is a path of
// package identifiers (`**/@scope/pkg`, `a/b/pkg`); the TARGET package is its last identifier,
// which is scoped (`@scope/pkg`) when the penultimate `/`-segment starts with `@`, and may carry
// a version selector (`foo@^1`, `@scope/pkg@^1`). Matching the exact tail (never a loose `/pkg`
// suffix) prevents an UNSCOPED `pkg` from matching `@scope/pkg`.
function matchedTrackedName(key: string, tracked: Set<string>): string | null {
  if (tracked.has(key)) return key;
  const segs = key.split("/");
  const last = segs[segs.length - 1] ?? "";
  const prev = segs[segs.length - 2];
  const tail = prev !== undefined && prev.startsWith("@") ? `${prev}/${last}` : last;
  if (tracked.has(tail)) return tail;
  // strip a version selector (`foo@^1` → `foo`, `@scope/pkg@^1` → `@scope/pkg`)
  const at = tail.indexOf("@", tail.startsWith("@") ? 1 : 0);
  const stripped = at > 0 ? tail.slice(0, at) : tail;
  return tracked.has(stripped) ? stripped : null;
}

// ---- install-name set (§5.F) ----------------------------------------------------------------
// The set of dependency KEYS in a manifest that resolve to `registryName`, from NORMAL sections
// only (override/resolution-only entries are not importable names). Alias keys plus the bare
// registry name when directly (unshadowed) declared.
export function installNameSet(facts: DependencyFact[], registryName: string): Set<string> {
  const out = new Set<string>();
  for (const f of facts) {
    if (f.packageName !== registryName) continue;
    if (f.dependencyType === "overrides" || f.dependencyType === "resolutions") continue;
    out.add(f.dependencyKey);
  }
  return out;
}

// ---- manifest / lockfile location (§5.C) ----------------------------------------------------
export interface LockfileRef {
  path: string;
  kind: LockfileKind;
  binary: boolean; // bun.lockb
  dir: string; // POSIX dir of the lockfile ('' for repo root)
}

const LOCKFILE_NAMES: Array<{ name: string; kind: LockfileKind; binary: boolean; priority: number }> = [
  { name: "npm-shrinkwrap.json", kind: "npm", binary: false, priority: 0 }, // precedes package-lock
  { name: "package-lock.json", kind: "npm", binary: false, priority: 1 },
  { name: "yarn.lock", kind: "yarn", binary: false, priority: 0 },
  { name: "pnpm-lock.yaml", kind: "pnpm", binary: false, priority: 0 },
  { name: "bun.lock", kind: "bun", binary: false, priority: 0 },
  { name: "bun.lockb", kind: "bun", binary: true, priority: 1 }, // text bun.lock precedes binary
];
const LOCKFILE_NAME_SET = new Set(LOCKFILE_NAMES.map((l) => l.name));

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
export function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

// Default directory globs always skipped even if not configured (§5.C).
const ALWAYS_SKIP = /(^|\/)node_modules\//;

export interface LocatedManifests {
  manifests: string[]; // package.json paths
  lockfiles: LockfileRef[];
}

// Partition a repo tree's file paths into manifests and lockfiles, skipping excluded dirs.
// `isExcluded` is supplied by the caller (built from config.excludeDirGlobs via Bun.Glob).
export function locateManifests(paths: string[], isExcluded: (path: string) => boolean): LocatedManifests {
  const manifests: string[] = [];
  const lockfiles: LockfileRef[] = [];
  for (const path of paths) {
    if (ALWAYS_SKIP.test(path) || isExcluded(path)) continue;
    const base = baseOf(path);
    if (base === "package.json") {
      manifests.push(path);
    } else if (LOCKFILE_NAME_SET.has(base)) {
      const meta = LOCKFILE_NAMES.find((l) => l.name === base)!;
      lockfiles.push({ path, kind: meta.kind, binary: meta.binary, dir: dirOf(path) });
    }
  }
  return { manifests, lockfiles };
}

// The lockfile governing a manifest: the one in the manifest's own dir or its NEAREST ANCESTOR
// (§5.D), choosing the highest-precedence name in that dir (npm-shrinkwrap > package-lock;
// bun.lock > bun.lockb). Returns null when no lockfile is found up the tree.
export function nearestLockfile(manifestPath: string, lockfiles: LockfileRef[]): LockfileRef | null {
  const byDir = new Map<string, LockfileRef[]>();
  for (const lf of lockfiles) {
    const list = byDir.get(lf.dir) ?? [];
    list.push(lf);
    byDir.set(lf.dir, list);
  }
  let dir = dirOf(manifestPath);
  for (;;) {
    const here = byDir.get(dir);
    if (here !== undefined && here.length > 0) {
      return [...here].sort((a, b) => lockfileRank(a) - lockfileRank(b))[0]!;
    }
    if (dir === "") break;
    dir = dirOf(dir);
  }
  return null;
}

function lockfileRank(lf: LockfileRef): number {
  const meta = LOCKFILE_NAMES.find((l) => l.name === baseOf(lf.path));
  return meta === undefined ? 99 : meta.priority;
}

// ---- owning-manifest resolution (§5.F) ------------------------------------------------------
// Walk UP from a source file to the repo root; the owning manifest is the NEAREST-ANCESTOR
// package.json whose install-name set for `registryName` is non-empty (workspace hoisting means
// a dependency declared only at the root still resolves for a nested file). Returns the manifest
// path and its resolving keys, or null when the entire ancestor chain declares none.
export interface OwningManifest {
  manifestPath: string;
  installNames: Set<string>;
}
export function resolveOwningManifest(
  filePath: string,
  factsByManifestDir: Map<string, { manifestPath: string; facts: DependencyFact[] }>,
  registryName: string,
): OwningManifest | null {
  let dir = dirOf(filePath);
  for (;;) {
    const entry = factsByManifestDir.get(dir);
    if (entry !== undefined) {
      const names = installNameSet(entry.facts, registryName);
      if (names.size > 0) return { manifestPath: entry.manifestPath, installNames: names };
    }
    if (dir === "") break;
    dir = dirOf(dir);
  }
  return null;
}
