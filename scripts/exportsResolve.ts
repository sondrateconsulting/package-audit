// exportsResolve.ts — pure resolution of a package's `exports`/`typesVersions`/`bin` fields
// (§5.E). Given a tarball's package.json, determine which TYPE-surface targets to read (the
// UNION of the import-condition and require-condition passes, so a dual-package surface is never
// collapsed to one mode), map a subpath specifier to its target (§5.F usage attribution), and
// normalize bin names. The actual .d.ts AST parse lives in apiSurface.ts; this module only does
// the field RESOLUTION. Zero-dep, never throws (malformed fields yield an empty/echo result).
//
// FAIL-CLOSED (§5.E): where the victim's exact tsc/Node pick is UNKNOWABLE from the manifest alone
// (unknown tsc version for typesVersions, first-existing fallback array, custom conditions), this
// module returns a BOUNDED UNION of all plausibly-real candidate declaration files. The caller's
// readContained drops the non-existent ones, so over-reporting is safe but a MISS (auditing a decoy
// while the real surface goes unread → an empty '__complete__' marker) is not. Truly unmodelable
// constructs (versioned conditions) are DETECTED here and thrown on by apiSurface.ts (this module
// never throws). CodeQL: star substitution NEVER uses `String.replace("*", <untrusted>)` — the
// typesVersions path uses substituteFirstStar (manual splice); the exports path uses the global
// regex+function replacer (verbatim, no $-expansion). Both are js/incomplete-sanitization-safe.

export type PkgJson = Record<string, unknown>;

// TypeScript's condition set for the type surface INCLUDES `types` alongside the resolution-mode
// runtime conditions. Two passes (import vs require) unioned, each traversed in OBJECT ORDER
// with the FIRST present condition winning (never a forced priority).
const IMPORT_CONDITIONS = new Set(["types", "import", "node", "default"]);
const REQUIRE_CONDITIONS = new Set(["types", "require", "node", "default"]);
// The full set of conditions this module models. A key that is NOT here (and not a subpath) is a
// custom/unknown condition (e.g. a TS `customConditions` entry) whose branch is UNIONED fail-closed.
const KNOWN_CONDITIONS = new Set(["types", "import", "require", "node", "default"]);

// Bounds (this module truncates rather than throwing — a superset is safe, and the base lookup is
// always retained). A multi-MB capture funneled through thousands of tiny "*" targets must not
// materialize gigabytes; realistic packages never approach these.
const MAX_TV_CANDIDATES = 4096;
const MAX_TV_SUBST_BYTES = 4 * 1024 * 1024;
const MAX_DECL_CANDIDATES = 8;

type ExportsNode = unknown;

// Node's exports resolution distinguishes THREE outcomes, threaded here as a candidate SET so a
// fallback ARRAY can carry MULTIPLE plausibly-real targets (not just the first):
//   targets → one or more resolved string targets (deduped, order-stable)
//   block   → the first matching condition is explicitly null (private) — STOP, do not fall
//             through to later sibling conditions
//   none    → no condition matched here — the caller keeps looking
// Conflating block and none would make `{ "types": null, "default": "./x" }` wrongly leak ./x even
// though `types` (the first present condition) blocks the type surface.
type ResolvedSet =
  | { kind: "targets"; targets: string[] }
  | { kind: "block" }
  | { kind: "none" };

function setTargets(r: ResolvedSet): string[] {
  return r.kind === "targets" ? r.targets : [];
}

// Resolve a conditional exports NODE under one condition set into a candidate SET, traversing
// object keys in declared order. The FIRST present KNOWN condition wins (its targets or explicit
// null block); only a non-matching key (none) lets the search continue. A fallback ARRAY yields the
// UNION of ALL structurally-valid resolved targets (§5.E #5a: TS uses the first target that EXISTS
// on disk, so a filesystem-unaware resolver must cover every candidate, not just the first). When
// `validateFallback` is set, array-derived strings are filtered through isValidExportTarget (Node
// PATTERN_TARGET validity) — applied ONLY to fully-resolved fallback strings, never to `*`-templates.
function resolveConditionalSet(node: ExportsNode, conditions: Set<string>, validateFallback: boolean): ResolvedSet {
  if (node === null) return { kind: "block" }; // explicit block
  if (typeof node === "string") return { kind: "targets", targets: [node] };
  if (Array.isArray(node)) {
    const targets: string[] = [];
    for (const alt of node) {
      const r = resolveConditionalSet(alt, conditions, validateFallback);
      if (r.kind === "targets") {
        for (const t of r.targets) {
          if (validateFallback && !isValidExportTarget(t)) continue; // Node-invalid → skipped
          if (!targets.includes(t)) targets.push(t);
        }
      }
      // block / none inside an array → fall through to the next entry
    }
    return targets.length > 0 ? { kind: "targets", targets } : { kind: "none" };
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    let known: ResolvedSet = { kind: "none" };
    for (const key of Object.keys(obj)) {
      if (conditions.has(key)) {
        const r = resolveConditionalSet(obj[key], conditions, validateFallback);
        if (r.kind !== "none") { known = r; break; } // first PRESENT known condition wins
      }
    }
    // Fail-closed (§5.E #5b): a custom condition (a TS `customConditions` entry) can be picked by the
    // victim's tsc BEFORE our modeled types/default, hiding the real surface behind a decoy. UNION
    // every unknown-condition branch's targets — REGARDLESS of whether a known condition also matched
    // — so the real target is audited too. This closes the case where an object's ONLY branch is a
    // custom condition (`{ "mycustom": "./real.d.ts" }`): without the union it resolves to `none`,
    // yielding an empty '__complete__' marker on a surface a `customConditions` build actually
    // exposes. Over-reporting is safe (readContained drops the non-existent misses); a miss is not.
    const extra: string[] = [];
    for (const key of Object.keys(obj)) {
      if (key.startsWith(".") || KNOWN_CONDITIONS.has(key)) continue; // subpath key or already handled
      const r = resolveConditionalSet(obj[key], conditions, validateFallback);
      if (r.kind === "targets") for (const t of r.targets) if (!extra.includes(t)) extra.push(t);
    }
    if (extra.length > 0) {
      const merged = known.kind === "targets" ? [...known.targets] : [];
      for (const t of extra) if (!merged.includes(t)) merged.push(t);
      return { kind: "targets", targets: merged };
    }
    return known;
  }
  return { kind: "none" };
}

// TS `replaceFirstStar`, reproduced byte-for-byte WITHOUT `String.replace("*", <untrusted>)`
// (which would re-open CodeQL js/incomplete-sanitization). Models `target.replace("*", captured)`:
// the search string is the literal "*", so ECMAScript GetSubstitution expands $-tokens in the
// REPLACEMENT (`captured`) with an EMPTY capture list — $$ → '$', $& → the matched '*', $` → the
// text before the star, $' → the text after; $n/$nn/$<name> and a lone trailing $ stay literal
// (a string search has no capture groups). `captured` is untrusted (derives from package.json), so
// this divergence matters: a verbatim splice would read the WRONG file and miss the real surface.
export function substituteFirstStar(target: string, captured: string): string {
  const pos = target.indexOf("*");
  if (pos < 0) return target;
  const before = target.slice(0, pos);
  const after = target.slice(pos + 1);
  let out = "";
  let i = 0;
  while (i < captured.length) {
    const ch = captured[i];
    if (ch === "$" && i + 1 < captured.length) {
      const next = captured[i + 1];
      if (next === "$") { out += "$"; i += 2; continue; }
      if (next === "&") { out += "*"; i += 2; continue; } // matched substring is the literal star
      if (next === "`") { out += before; i += 2; continue; }
      if (next === "'") { out += after; i += 2; continue; }
      // $n / $nn / $<name> and any other → the '$' is literal; emit it and advance one
    }
    out += ch;
    i += 1;
  }
  return before + out + after;
}

// Node PACKAGE_TARGET_RESOLVE substitutes EVERY '*' in an exports target with the capture. The
// regex+function replacer inserts `captured` VERBATIM (function replacements are never $-expanded)
// and, being a `/\*/g` regex (not a string arg), is js/incomplete-sanitization-safe.
function substituteAllStars(target: string, captured: string): string {
  return target.replace(/\*/g, () => captured);
}

// Is the top-level exports value a SUBPATHS map (keys begin with '.') vs a conditions object?
function isSubpathMap(exports: Record<string, unknown>): boolean {
  const keys = Object.keys(exports);
  return keys.length > 0 && keys.every((k) => k === "." || k.startsWith("./"));
}

// Node-faithful validity of a FULLY-RESOLVED fallback target string (PACKAGE_TARGET). Applied only
// to fallback-array strings, NEVER to `*`-templates: must start with './'; reject a '.'/'..' path
// SEGMENT, a backslash, a node_modules segment, and any percent-encoded dot/separator (%2e/%2f/%5c,
// case-insensitive). A structurally-invalid target is one Node would refuse, so it can never be the
// victim's real surface — dropping it keeps the union tight without risking a miss.
export function isValidExportTarget(target: string): boolean {
  if (!target.startsWith("./")) return false;
  if (target.includes("\\")) return false;
  const lower = target.toLowerCase();
  if (lower.includes("%2e") || lower.includes("%2f") || lower.includes("%5c")) return false;
  for (const seg of target.slice(2).split("/")) {
    const s = seg.toLowerCase();
    if (seg === "." || seg === ".." || s === "node_modules") return false;
  }
  return true;
}

// A key K denotes a TS VERSIONED condition (`types@>=5.0`, `types@<4.5`, or a bare `@<range>`) —
// unmodelable without the victim's tsc version. NOT any '@': `foo@bar` is an ordinary custom
// condition (GREEN). The range must START with a semver-range char right after '@'.
const VERSIONED_KEY_RE = /^types@|@[0-9<>=~^*vVxX]/;

// Recurse through OBJECTS and ARRAY elements (a versioned key can nest inside a fallback array),
// returning true if any CONDITION key (not a subpath key) matches the versioned pattern. apiSurface
// throws IntrospectionError when this is true (fail-closed: no marker for an unmodelable surface).
export function hasVersionedExportCondition(node: unknown): boolean {
  if (Array.isArray(node)) return node.some((el) => hasVersionedExportCondition(el));
  if (node !== null && typeof node === "object") {
    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (!key.startsWith(".") && VERSIONED_KEY_RE.test(key)) return true; // condition key only
      if (hasVersionedExportCondition((node as Record<string, unknown>)[key])) return true;
    }
  }
  return false;
}

// Resolve ONE subpath ('.' for the package root, or './sub') to its target SET under a condition
// set. Exact subpath keys win; then '*'-pattern keys ('./features/*') match with the captured
// trailer substituted into the target's '*' (every star, Node semantics). On EQUAL longest-prefix
// length the LONGER FULL key wins (Node PATTERN_KEY_COMPARE).
function resolveSubpathUnder(exports: unknown, subpath: string, conditions: Set<string>): string[] {
  if (typeof exports === "string") return subpath === "." ? [exports] : []; // sugar: root only
  // a TOP-LEVEL array is a root fallback list (Node permits `"exports": ["./a.js","./b.js"]`)
  if (Array.isArray(exports)) return subpath === "." ? setTargets(resolveConditionalSet(exports, conditions, true)) : [];
  if (exports === null || typeof exports !== "object") return [];
  const map = exports as Record<string, unknown>;
  if (!isSubpathMap(map)) {
    // a bare conditions object only defines the root
    return subpath === "." ? setTargets(resolveConditionalSet(map, conditions, true)) : [];
  }
  if (subpath in map) return setTargets(resolveConditionalSet(map[subpath], conditions, true));
  // pattern match: longest matching prefix before '*'; ties → the longer FULL key
  let best: { targets: string[]; prefixLen: number; keyLen: number } | null = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const captured = subpath.slice(prefix.length, subpath.length - suffix.length);
      // the pattern VALUE holds un-substituted templates; resolve without fallback validation
      // (isValidExportTarget is never applied to '*'-templates), then substitute every star.
      const templates = setTargets(resolveConditionalSet(map[key], conditions, false));
      if (templates.length === 0) continue;
      const substituted = templates.map((t) => substituteAllStars(t, captured));
      if (
        best === null ||
        prefix.length > best.prefixLen ||
        (prefix.length === best.prefixLen && key.length > best.keyLen)
      ) {
        best = { targets: substituted, prefixLen: prefix.length, keyLen: key.length };
      }
    }
  }
  return best?.targets ?? [];
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
    for (const t of resolveSubpathUnder(exports, subpath, conditions)) {
      if (!targets.includes(t)) targets.push(t);
    }
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

// The RAW, un-substituted target TEMPLATES (each still containing '*') for ONE '*'-pattern key,
// unioned across both modes (§5.E #6a). apiSurface turns each into an anchored RegExp and matches
// it against the extracted file listing to enumerate the concrete surface. Fallback-array pattern
// values union their structurally-valid templates; a no-star target is returned verbatim (a single
// concrete file to enumerate).
export function resolvePatternTargetTemplates(pkg: PkgJson, patternKey: string): string[] {
  const exports = pkg["exports"];
  if (exports === null || typeof exports !== "object" || Array.isArray(exports)) return [];
  const map = exports as Record<string, unknown>;
  if (!isSubpathMap(map) || !(patternKey in map)) return [];
  const out: string[] = [];
  for (const conditions of [IMPORT_CONDITIONS, REQUIRE_CONDITIONS]) {
    for (const t of setTargets(resolveConditionalSet(map[patternKey], conditions, false))) {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

// The bounded SUPERSET of declaration files TS might use for a resolved legacy/type target (§5.E
// #3/#4). An already-.d.ts/.d.mts/.d.cts target is used as-is; otherwise the union of {the adjacent
// declaration; the target ITSELF when it is a .ts/.tsx/.mts/.cts source; the directory-index; and,
// for a target that carries a runtime/source extension, the extension-stripped directory-index}.
// readContained filters the non-existent ones, so a superset is safe; the count is bounded.
const DECL_EXT_RE = /\.d\.[cm]?ts$/;
const SOURCE_EXT_RE = /\.(tsx?|mts|cts)$/;
const RUNTIME_OR_SOURCE_EXT_RE = /\.(tsx?|mts|cts|jsx?|mjs|cjs)$/;

export function declarationCandidates(target: string): string[] {
  if (DECL_EXT_RE.test(target)) return [target];
  const out: string[] = [];
  const push = (c: string): void => {
    if (c !== "" && !out.includes(c) && out.length < MAX_DECL_CANDIDATES) out.push(c);
  };
  push(typeTargetToDts(target)); // adjacent declaration (.js→.d.ts, extensionless→+.d.ts)
  if (SOURCE_EXT_RE.test(target)) push(target); // a .ts/.tsx/.mts/.cts source IS a legit surface
  const noSlash = target.replace(/\/+$/, "");
  push(`${noSlash}/index.d.ts`); // directory-index (types:"./types" → ./types/index.d.ts)
  if (RUNTIME_OR_SOURCE_EXT_RE.test(noSlash)) {
    push(`${noSlash.replace(RUNTIME_OR_SOURCE_EXT_RE, "")}/index.d.ts`); // ext-stripped dir-index
  }
  return out;
}

// The ROOT type-surface targets. When `exports` is present it is authoritative (union of both
// modes). Otherwise (legacy), the union of typings/types/main + implicit root, each remapped through
// typesVersions (SUPERSET including the unremapped base) then expanded to declaration candidates.
export function resolveTypeTargets(pkg: PkgJson): string[] {
  const exports = pkg["exports"];
  if (exports !== undefined) {
    return resolveSubpath(pkg, ".").targets; // exports present → typesVersions is ignored (TS rule)
  }
  // no exports → legacy lookups. TS checks `typings` BEFORE `types`; if NEITHER is present it
  // derives the type surface from `main`'s adjacency and the implicit root declaration.
  const lookups: string[] = [];
  const typings = pkg["typings"];
  const types = pkg["types"];
  if (typeof typings === "string") lookups.push(typings);
  if (typeof types === "string") lookups.push(types);
  if (lookups.length === 0) {
    const main = pkg["main"];
    if (typeof main === "string") lookups.push(main);
    lookups.push("./index.d.ts"); // the implicit root declaration file
  }
  const out: string[] = [];
  for (const lookup of lookups) {
    for (const remapped of typesVersionsRemapAll(pkg, lookup)) {
      for (const cand of declarationCandidates(remapped)) {
        if (!out.includes(cand)) out.push(cand);
      }
    }
  }
  return out;
}

// Strip a trailing declaration or source/runtime extension so a typesVersions pattern can match the
// extensionless form (TS matches `index`, not `index.d.ts`).
function stripDeclOrSourceExt(rel: string): string {
  const decl = rel.replace(/\.d\.[cm]?ts$/, "");
  if (decl !== rel) return decl;
  return rel.replace(/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/, "");
}

// Apply `typesVersions` to a legacy lookup, returning the fail-closed UNION (§5.E #3) of: (a) the
// UNREMAPPED lookup itself — the victim's tsc may be too old to honor typesVersions, or its version
// may not satisfy any range, so the base must always stay a candidate; and (b) for EVERY range and
// EVERY pattern key matching the lookup (matched against BOTH the raw rel and its extensionless
// form), EVERY target in the fallback array — a wildcard key substitutes via substituteFirstStar
// (TS fills only the FIRST star), an exact key uses the target verbatim. Bounded by count/bytes.
function typesVersionsRemapAll(pkg: PkgJson, lookup: string): string[] {
  const out: string[] = [lookup]; // (a) the unremapped base is ALWAYS a candidate
  const tv = pkg["typesVersions"];
  if (tv === null || typeof tv !== "object" || Array.isArray(tv)) return out;
  const rel = lookup.replace(/^\.\//, "");
  const relNoExt = stripDeclOrSourceExt(rel);
  let bytes = 0;
  const push = (c: string): boolean => {
    if (out.length >= MAX_TV_CANDIDATES) return false;
    bytes += c.length;
    if (bytes > MAX_TV_SUBST_BYTES) return false;
    if (!out.includes(c)) out.push(c);
    return true;
  };
  for (const range of Object.keys(tv as Record<string, unknown>)) {
    const mapping = (tv as Record<string, unknown>)[range];
    if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) continue;
    for (const pattern of Object.keys(mapping as Record<string, unknown>)) {
      const targets = (mapping as Record<string, unknown>)[pattern];
      if (!Array.isArray(targets)) continue;
      const star = pattern.indexOf("*");
      for (const rawTgt of targets) {
        if (typeof rawTgt !== "string") continue;
        if (star === -1) {
          if (pattern === rel || pattern === relNoExt || pattern === lookup) {
            if (!push(normalizeRel(rawTgt))) return out; // verbatim (no capture to substitute)
          }
          continue;
        }
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        for (const cand of [rel, relNoExt]) {
          if (cand.startsWith(prefix) && cand.endsWith(suffix) && cand.length >= prefix.length + suffix.length) {
            const captured = cand.slice(prefix.length, cand.length - suffix.length);
            if (!push(normalizeRel(substituteFirstStar(rawTgt, captured)))) return out;
          }
        }
      }
    }
  }
  return out;
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
