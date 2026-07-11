// exportsResolve.ts — pure resolution of a package's `exports`/`typesVersions`/`bin` fields
// (§5.E). Given a tarball's package.json, determine which TYPE-surface targets to read (the
// UNION of the import-condition and require-condition passes, so a dual-package surface is never
// collapsed to one mode), map a subpath specifier to its target (§5.F usage attribution), and
// normalize bin names. The actual .d.ts AST parse lives in apiSurface.ts; this module only does
// the field RESOLUTION. Zero-dep, never throws (malformed fields yield an empty/echo result).

export type PkgJson = Record<string, unknown>;

// TypeScript's condition set for the type surface INCLUDES `types` alongside the resolution-mode
// runtime conditions. Two passes (import vs require) unioned, each traversed in OBJECT ORDER
// with the FIRST present condition winning (never a forced priority).
const IMPORT_CONDITIONS = new Set(["types", "import", "node", "default"]);
const REQUIRE_CONDITIONS = new Set(["types", "require", "node", "default"]);

type ExportsNode = unknown;

// Node's exports resolution distinguishes THREE outcomes, and this module must too:
//   string   → a resolved target
//   null     → the first matching condition is explicitly BLOCKED (private) — STOP, do not
//              fall through to later sibling conditions
//   undefined→ no condition matched here — the caller keeps looking
// Conflating null and undefined would make `{ "types": null, "default": "./x" }` wrongly leak
// ./x even though `types` (first present condition) blocks the type surface.
type Resolved = string | null | undefined;

// Resolve a conditional exports NODE under one condition set, traversing object keys in declared
// order. The FIRST present condition wins: its result (a string OR an explicit null block) is
// returned; only a non-matching key (undefined) lets the search continue. A fallback ARRAY takes
// the first element that resolves to a string.
function resolveConditional(node: ExportsNode, conditions: Set<string>): Resolved {
  if (node === null) return null; // explicit block
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    for (const alt of node) {
      const r = resolveConditional(alt, conditions);
      if (typeof r === "string") return r; // arrays fall through blocks/misses to the next entry
    }
    return undefined;
  }
  if (typeof node === "object") {
    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (conditions.has(key)) {
        const r = resolveConditional((node as Record<string, unknown>)[key], conditions);
        if (r !== undefined) return r; // first PRESENT condition wins (string or explicit null)
      }
    }
  }
  return undefined; // no condition matched here
}

// Is the top-level exports value a SUBPATHS map (keys begin with '.') vs a conditions object?
function isSubpathMap(exports: Record<string, unknown>): boolean {
  const keys = Object.keys(exports);
  return keys.length > 0 && keys.every((k) => k === "." || k.startsWith("./"));
}

// Resolve ONE subpath ('.' for the package root, or './sub') to a target under a condition set.
// Exact subpath keys win; then '*'-pattern keys ('./features/*') match with the captured trailer
// substituted into the target's '*'.
function resolveSubpathUnder(exports: unknown, subpath: string, conditions: Set<string>): string | null {
  if (typeof exports === "string") return subpath === "." ? exports : null; // sugar: root only
  // a TOP-LEVEL array is a root fallback list (Node permits `"exports": ["./a.js","./b.js"]`)
  if (Array.isArray(exports)) return subpath === "." ? (resolveConditional(exports, conditions) ?? null) : null;
  if (exports === null || typeof exports !== "object") return null;
  const map = exports as Record<string, unknown>;
  if (!isSubpathMap(map)) {
    // a bare conditions object only defines the root; undefined (no match) → null
    return subpath === "." ? (resolveConditional(map, conditions) ?? null) : null;
  }
  if (subpath in map) return resolveConditional(map[subpath], conditions) ?? null;
  // pattern match: longest matching prefix before '*'
  let best: { target: string | null; prefixLen: number } | null = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const captured = subpath.slice(prefix.length, subpath.length - suffix.length);
      const rawTarget = resolveConditional(map[key], conditions);
      // Node's PACKAGE_TARGET_RESOLVE substitutes EVERY '*' in the target (global). The
      // function replacer inserts `captured` verbatim — `captured` is untrusted and a string
      // replacement would re-expand $&/$$/$` special patterns (matching Node's own impl).
      const target = typeof rawTarget === "string" ? rawTarget.replace(/\*/g, () => captured) : null;
      if (best === null || prefix.length > best.prefixLen) best = { target, prefixLen: prefix.length };
    }
  }
  return best?.target ?? null;
}

export interface SubpathResolution {
  targets: string[]; // union of import+require targets (deduped, order-stable); [] if unresolved
  resolved: boolean; // whether ANY mapping matched (false → private/unmapped subpath)
}

// Resolve a subpath specifier to its target set under BOTH modes, unioned (§5.E). When exports
// is present it is authoritative; the root ('.') under a legacy no-exports package falls back to
// typesVersions/types/typings/index.d.ts via resolveTypeTargets (callers use that for the root).
export function resolveSubpath(pkg: PkgJson, subpath: string): SubpathResolution {
  const exports = pkg["exports"];
  if (exports === undefined) return { targets: [], resolved: false };
  const targets: string[] = [];
  for (const conditions of [IMPORT_CONDITIONS, REQUIRE_CONDITIONS]) {
    const t = resolveSubpathUnder(exports, subpath, conditions);
    if (t !== null && !targets.includes(t)) targets.push(t);
  }
  return { targets, resolved: targets.length > 0 };
}

// The declared subpath KEYS in `exports` (excluding the root '.'), split into exact keys and
// '*'-pattern keys. Used by apiSurface to enumerate the FULL public type surface (§5.E), not
// just the root — a package's `./config` etc. exports are part of its surface.
export function exportsSubpathKeys(pkg: PkgJson): { exact: string[]; patterns: string[] } {
  const exports = pkg["exports"];
  if (exports === null || typeof exports !== "object" || Array.isArray(exports)) return { exact: [], patterns: [] };
  const map = exports as Record<string, unknown>;
  if (!isSubpathMap(map)) return { exact: [], patterns: [] };
  const exact: string[] = [];
  const patterns: string[] = [];
  for (const key of Object.keys(map)) {
    if (key === ".") continue;
    (key.includes("*") ? patterns : exact).push(key);
  }
  return { exact, patterns };
}

// The ROOT type-surface targets (union of both modes). Falls back, ONLY when `exports` is
// ABSENT, to typesVersions remap → types/typings → index.d.ts (§5.E: TS ignores typesVersions
// once exports is present).
export function resolveTypeTargets(pkg: PkgJson): string[] {
  const exports = pkg["exports"];
  if (exports !== undefined) {
    const root = resolveSubpath(pkg, ".");
    return root.targets;
  }
  // no exports → base types path (types/typings/index.d.ts) then a typesVersions remap of THAT
  // path (typesVersions maps declaration-file paths, e.g. "*" → "ts4.0/*", not the '.' subpath).
  const typesField = pkg["types"] ?? pkg["typings"];
  const base = typeof typesField === "string" ? typesField : "./index.d.ts";
  const remapped = typesVersionsRemap(pkg, base);
  return [remapped ?? base];
}

// Apply the `typesVersions` remap to a declaration-file path (best-effort — first matching
// version range's first matching mapping). typesVersions maps a TS-version range to
// { "<pattern>": ["<target>"] } where <pattern>/<target> share a '*' capture.
function typesVersionsRemap(pkg: PkgJson, basePath: string): string | null {
  const tv = pkg["typesVersions"];
  if (tv === null || typeof tv !== "object" || Array.isArray(tv)) return null;
  const rel = basePath.replace(/^\.\//, ""); // strip a leading './' for pattern matching
  for (const range of Object.keys(tv as Record<string, unknown>)) {
    const mapping = (tv as Record<string, unknown>)[range];
    if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) continue;
    for (const pattern of Object.keys(mapping as Record<string, unknown>)) {
      const targets = (mapping as Record<string, unknown>)[pattern];
      if (!Array.isArray(targets) || targets.length === 0 || typeof targets[0] !== "string") continue;
      const star = pattern.indexOf("*");
      if (star === -1) {
        if (pattern === rel || pattern === basePath) return normalizeRel(targets[0] as string);
      } else {
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (rel.startsWith(prefix) && rel.endsWith(suffix)) {
          const captured = rel.slice(prefix.length, rel.length - suffix.length);
          // TypeScript substitutes only the FIRST '*' in the target (unlike Node exports
          // above, which is global). A manual splice is TS-faithful AND inserts `captured`
          // verbatim — a string-arg .replace would re-expand $&/$$/$` from untrusted input.
          const tgt = targets[0] as string;
          const si = tgt.indexOf("*");
          return normalizeRel(si < 0 ? tgt : tgt.slice(0, si) + captured + tgt.slice(si + 1));
        }
      }
    }
  }
  return null;
}

function normalizeRel(target: string): string {
  return target.startsWith("./") || target.startsWith("../") ? target : `./${target}`;
}

// Map a resolved runtime target to its ADJACENT .d.ts (§5.E: if the matched target is already a
// .d.ts use it, else the declaration file beside the runtime target). .js→.d.ts, .mjs→.d.mts,
// .cjs→.d.cts; an already-declaration target is returned unchanged.
export function typeTargetToDts(target: string): string {
  if (/\.d\.[cm]?ts$/.test(target)) return target;
  if (target.endsWith(".mjs")) return target.slice(0, -4) + ".d.mts";
  if (target.endsWith(".cjs")) return target.slice(0, -4) + ".d.cts";
  if (target.endsWith(".js")) return target.slice(0, -3) + ".d.ts";
  if (target.endsWith(".jsx")) return target.slice(0, -4) + ".d.ts";
  if (target.endsWith(".ts") || target.endsWith(".tsx")) return target.replace(/\.tsx?$/, ".d.ts");
  return target + ".d.ts";
}

// Normalize the `bin` field to a set of bin names (§5.G). Object form → its keys; string form →
// named after the UNSCOPED package name (`@scope/pkg` → `pkg`).
export function binNames(pkg: PkgJson): string[] {
  const bin = pkg["bin"];
  const name = typeof pkg["name"] === "string" ? (pkg["name"] as string) : "";
  const unscoped = name.startsWith("@") && name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  if (typeof bin === "string") return unscoped === "" ? [] : [unscoped];
  if (bin !== null && typeof bin === "object" && !Array.isArray(bin)) return Object.keys(bin as Record<string, unknown>);
  return [];
}
