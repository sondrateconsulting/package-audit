// lockfile.ts — resolve the concrete installed version of a tracked package PER (manifest,
// dependency_key) via the lockfile IMPORTER EDGE (§5.D). Pure, zero-dep. Each resolver returns
// the resolved version (a concrete semver for a registry-backed install, or the RAW reference
// for a non-registry spec), a registry/non-registry classification, and the 1-based line span
// of the matched entry (for a permalink). NEVER throws on a malformed lockfile — returns a
// non-match so the caller records the declaration without a resolved version and moves on.

import { parseJsoncObject, escapePointer, type JsonValue } from "./jsonc.ts";
import { parseYamlLite, asMap, asScalar, getEntry, getChild, nodeLineSpan, type YamlMap } from "./yamlLite.ts";

export type LockfileKind = "npm" | "yarn" | "pnpm" | "bun";

export interface LockResolution {
  matched: boolean; // an importer edge for this key was found
  resolvedVersion: string | null; // concrete semver (registry) OR raw reference (non-registry)
  isRegistry: boolean; // true → an introspectable semver; false → a non-registry spec (§5.E skip)
  realName: string | null; // the confirmed real package name where the lockfile exposes it
  lines: number[] | null; // 1-based line(s) of the matched entry
}

const NO_MATCH: LockResolution = { matched: false, resolvedVersion: null, isRegistry: false, realName: null, lines: null };

// A resolution reference is NON-registry when it carries one of these protocols (§5.D/§5.E),
// even if a sibling version looks like a semver. `npm:` and a bare range are registry-backed.
const NON_REGISTRY_PROTOCOL = /^(git\+|git:|file:|link:|portal:|patch:|workspace:|catalog:|github:|gitlab:|bitbucket:|gist:)/i;
const URL_PROTOCOL = /^(https?:)/i;

// Classify an npm v1 `dependencies.<key>.version` value: a protocol spec (git+/file:/…) OR a
// tarball URL is non-registry. (This is only applied to a v1 version STRING, never to a
// registry `resolved` tarball URL, which is not the value we classify on.)
function isNonRegistryRef(ref: string): boolean {
  const t = ref.trim();
  return NON_REGISTRY_PROTOCOL.test(t) || URL_PROTOCOL.test(t);
}

// ---- dispatch --------------------------------------------------------------------------------
export interface ResolveInput {
  kind: LockfileKind;
  text: string; // lockfile content (empty for bun.lockb — binary, unparseable)
  binary?: boolean; // bun.lockb: set kind='bun', skip line-level parse
  manifestDir: string; // workspace-relative dir of the OWNING manifest ('' for the repo root)
  dependencyKey: string; // the manifest key (may differ from registryName for an alias)
  registryName: string; // the tracked package's registry name
  declaredRange: string; // the declared version range (yarn multi-match disambiguation)
}

export function resolveFromLockfile(input: ResolveInput): LockResolution {
  try {
    if (input.binary === true) return NO_MATCH; // bun.lockb: recorded, but no line-level parse
    let result: LockResolution;
    switch (input.kind) {
      case "npm": result = resolveNpm(input); break;
      case "yarn": result = resolveYarn(input); break;
      case "pnpm": result = resolvePnpm(input); break;
      case "bun": result = resolveBun(input); break;
    }
    // §5.D real-name confirmation, centralized so no resolver can drift: when the lockfile
    // EXPOSES a real package name (an alias target) it MUST equal registryName, else the
    // manifest key resolved to a DIFFERENT package and this is not a finding for us.
    if (result.realName !== null && result.realName !== input.registryName) return NO_MATCH;
    return result;
  } catch {
    return NO_MATCH; // NEVER fail the run on an unparseable lockfile (§5.D)
  }
}

// ---- npm (npm-shrinkwrap.json / package-lock.json) ------------------------------------------
// v2/v3: the `packages` map is primary. Resolve the install entry by walking the node_modules
// chain nearest-first from the manifest dir up to root. v1: `dependencies.<key>.version`.
function resolveNpm(input: ResolveInput): LockResolution {
  const { value, keyLines } = parseJsoncObject(input.text);
  const packages = value["packages"];
  if (packages !== undefined && packages !== null && typeof packages === "object" && !Array.isArray(packages)) {
    return resolveNpmV3(packages as Record<string, JsonValue>, keyLines, input);
  }
  const deps = value["dependencies"];
  if (deps !== undefined && deps !== null && typeof deps === "object" && !Array.isArray(deps)) {
    return resolveNpmV1(deps as Record<string, JsonValue>, keyLines, input);
  }
  return NO_MATCH;
}

// The nearest-first node_modules lookup keys for a manifest dir (§5.D + consult): for
// "apps/web" → apps/web/node_modules/<key>, apps/node_modules/<key>, node_modules/<key>.
function npmPackageKeys(manifestDir: string, key: string): string[] {
  const out: string[] = [];
  const segs = manifestDir === "" ? [] : manifestDir.split("/").filter((s) => s !== "");
  for (let i = segs.length; i >= 0; i--) {
    const prefix = segs.slice(0, i).join("/");
    out.push(prefix === "" ? `node_modules/${key}` : `${prefix}/node_modules/${key}`);
  }
  return out;
}

function resolveNpmV3(
  packages: Record<string, JsonValue>,
  keyLines: Map<string, number>,
  input: ResolveInput,
): LockResolution {
  // §5.D: the manifest's OWN packages entry (key = its dir, "" for root) lists dependency_key →
  // spec. When that entry exists but does NOT declare the key in a normal edge, any install
  // entry we'd find up the node_modules chain is transitive, not this manifest's direct dep —
  // so NO_MATCH. (When the entry is absent — an unusual/partial lockfile — trust the caller's
  // upstream declaration confirmation and fall through to install-entry resolution.)
  let declaredNonRegistry: string | null = null; // a non-registry declared spec, resolved after the install entry is located
  const own = packages[input.manifestDir];
  if (own !== undefined && own !== null && typeof own === "object" && !Array.isArray(own)) {
    const o = own as Record<string, JsonValue>;
    let declaredSpec: string | null = null;
    for (const sec of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const edge = o[sec];
      if (edge !== null && typeof edge === "object" && !Array.isArray(edge) && Object.hasOwn(edge as object, input.dependencyKey)) {
        const spec = (edge as Record<string, JsonValue>)[input.dependencyKey];
        if (typeof spec === "string") declaredSpec = spec;
        break;
      }
    }
    if (declaredSpec === null) return NO_MATCH; // key not directly declared here → transitive
    // a declared tarball-URL / non-registry spec is a §5.E skip even if the install entry has a
    // concrete version (npm records the fetched tarball's version, but the origin is off-registry).
    if (NON_REGISTRY_PROTOCOL.test(declaredSpec) || URL_PROTOCOL.test(declaredSpec)) declaredNonRegistry = declaredSpec;
  }
  for (const pkgKey of npmPackageKeys(input.manifestDir, input.dependencyKey)) {
    const entry = packages[pkgKey];
    if (entry === undefined || entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, JsonValue>;
    const line = keyLines.get(`/packages/${escapePointer(pkgKey)}`) ?? null;
    const lines = line === null ? null : [line];
    // entry.name is the alias target — carried on EVERY return (incl. non-registry) so the
    // centralized realName confirmation can reject an entry that resolves to another package.
    const realName = typeof e["name"] === "string" ? (e["name"] as string) : null;
    // a declared non-registry spec still confirms the install entry's real name (an install
    // entry proving a DIFFERENT package must be rejected centrally).
    if (declaredNonRegistry !== null)
      return { matched: true, resolvedVersion: declaredNonRegistry, isRegistry: false, realName, lines };
    // A workspace symlink (link:true) or a non-registry resolved reference is non-registry.
    const resolved = typeof e["resolved"] === "string" ? (e["resolved"] as string) : "";
    if (e["link"] === true) return { matched: true, resolvedVersion: `link:${pkgKey}`, isRegistry: false, realName, lines };
    if (resolved !== "" && (NON_REGISTRY_PROTOCOL.test(resolved) || resolved.startsWith("git+")))
      return { matched: true, resolvedVersion: resolved, isRegistry: false, realName, lines };
    const version = typeof e["version"] === "string" ? (e["version"] as string) : null;
    if (version === null) return { matched: true, resolvedVersion: null, isRegistry: false, realName, lines };
    return { matched: true, resolvedVersion: version, isRegistry: true, realName, lines };
  }
  // a declared non-registry spec with NO install entry (nothing to name-confirm) is still a
  // recorded non-registry finding at the manifest's own entry line.
  if (declaredNonRegistry !== null) {
    const line = keyLines.get(`/packages/${escapePointer(input.manifestDir)}`) ?? null;
    return { matched: true, resolvedVersion: declaredNonRegistry, isRegistry: false, realName: null, lines: line === null ? null : [line] };
  }
  return NO_MATCH;
}

function resolveNpmV1(
  deps: Record<string, JsonValue>,
  keyLines: Map<string, number>,
  input: ResolveInput,
): LockResolution {
  const entry = deps[input.dependencyKey];
  if (entry === undefined || entry === null || typeof entry !== "object" || Array.isArray(entry)) return NO_MATCH;
  const e = entry as Record<string, JsonValue>;
  const line = keyLines.get(`/dependencies/${escapePointer(input.dependencyKey)}`) ?? null;
  const lines = line === null ? null : [line];
  const rawVersion = typeof e["version"] === "string" ? (e["version"] as string) : null;
  if (rawVersion === null) return { matched: true, resolvedVersion: null, isRegistry: false, realName: null, lines };
  // v1 alias: version is `npm:<realName>@x.y.z` — extract the concrete version after the LAST @.
  if (rawVersion.startsWith("npm:")) {
    const spec = rawVersion.slice("npm:".length);
    const at = spec.lastIndexOf("@");
    if (at > 0) {
      return { matched: true, resolvedVersion: spec.slice(at + 1), isRegistry: true, realName: spec.slice(0, at), lines };
    }
  }
  if (isNonRegistryRef(rawVersion))
    return { matched: true, resolvedVersion: rawVersion, isRegistry: false, realName: null, lines };
  return { matched: true, resolvedVersion: rawVersion, isRegistry: true, realName: null, lines };
}

// ---- yarn (classic AND berry) ----------------------------------------------------------------
interface YarnEntry {
  descriptors: string[]; // the comma-joined descriptor keys of the block
  version: string | null; // sibling `version` field (classic `version "x"` / berry `version: x`)
  resolution: string | null; // berry `resolution:` (real-name confirmation)
  startLine: number;
  endLine: number;
}

// Parse a yarn.lock (v1 classic or berry) into descriptor blocks with their line spans. Both
// formats share the shape: a descriptor header line ending ':' then 2-space-indented fields.
function parseYarnLock(text: string): YarnEntry[] {
  const lines = text.split("\n");
  const entries: YarnEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const trimmedRight = raw.replace(/\r$/, "");
    // a descriptor header: column-0, non-comment, ends with ':'
    if (trimmedRight === "" || /^\s/.test(trimmedRight) || trimmedRight.startsWith("#") || !trimmedRight.endsWith(":")) {
      i++;
      continue;
    }
    if (trimmedRight.startsWith("__metadata")) {
      i++;
      continue;
    }
    const startLine = i + 1;
    const header = trimmedRight.slice(0, -1); // drop trailing ':'
    const descriptors = splitYarnDescriptors(header);
    let version: string | null = null;
    let resolution: string | null = null;
    let j = i + 1;
    let lastContentLine = startLine; // the block span must end at the last NON-blank body line
    for (; j < lines.length; j++) {
      const body = lines[j]!.replace(/\r$/, "");
      if (body === "") continue; // blank separator — not part of the span
      if (!/^\s/.test(body)) break; // dedent → next block
      lastContentLine = j + 1;
      const field = body.trim();
      const cv = /^version:?\s+"?([^"]+)"?$/.exec(field);
      if (cv) version = cv[1]!.trim();
      const cr = /^resolution:?\s+"?([^"]+)"?$/.exec(field);
      if (cr) resolution = cr[1]!.trim();
    }
    entries.push({ descriptors, version, resolution, startLine, endLine: lastContentLine });
    i = j;
  }
  return entries;
}

// Split a yarn descriptor header into individual descriptors, across all three serializations:
//   - classic unquoted:          lodash@^4.0.0, lodash@^4.17.0
//   - classic separately-quoted:  "lodash@^4.0.0", "lodash@^4.17.0"
//   - BERRY single-wrapped:       "lodash@npm:^4.0.0, lodash@npm:^4.17.21"  (commas INSIDE quotes)
// Berry (yarn 2/3/4) wraps the WHOLE comma-joined list in one quote pair because each descriptor
// contains a ':' (the npm: protocol); the commas are inside the quotes, so a quote-toggling split
// would treat the list as one descriptor. Detect that case (a single fully-quoted string with no
// interior quote) and split its interior on ', '; otherwise toggle on quotes as before.
function splitYarnDescriptors(header: string): string[] {
  const t = header.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"') && !t.slice(1, -1).includes('"')) {
    return t
      .slice(1, -1)
      .split(", ")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  const parts: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const ch of t) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === "," && !inQuote) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "") parts.push(cur.trim());
  return parts;
}

function resolveYarn(input: ResolveInput): LockResolution {
  const entries = parseYarnLock(input.text);
  const prefix = `${input.dependencyKey}@`;
  // A block can carry SEVERAL comma-joined descriptors for one key (yarn's dedup shape,
  // `lodash@^4.0.0, lodash@^4.17.0:`) — collect them ALL so disambiguation can match the
  // declared range against ANY descriptor of the block, not just the first.
  const matches: Array<{ entry: YarnEntry; rangeParts: string[] }> = [];
  for (const entry of entries) {
    const rangeParts = entry.descriptors.filter((d) => d.startsWith(prefix)).map((d) => d.slice(prefix.length));
    if (rangeParts.length > 0) matches.push({ entry, rangeParts });
  }
  if (matches.length === 0) return NO_MATCH;
  // Pick the block+descriptor whose declared RANGE equals the manifest's declaredRange (range-
  // only: after a leading `npm:` and, for an alias, the real name's `@`). Fall back to the first.
  const want = input.declaredRange.trim();
  let chosen = matches[0]!;
  let matchedRangePart = matches[0]!.rangeParts[0]!;
  for (const m of matches) {
    const rp = m.rangeParts.find((r) => yarnDescriptorRange(r) === want);
    if (rp !== undefined) {
      chosen = m;
      matchedRangePart = rp;
      break;
    }
  }
  const entry = chosen.entry;
  const lines = entry.endLine > entry.startLine ? rangeInclusive(entry.startLine, entry.endLine) : [entry.startLine];
  // Classify registry-vs-non-registry by the PROTOCOL of the matched descriptor's range part
  // (everything after the `<dependencyKey>@` prefix), NOT by lastIndexOf('@') on the whole
  // resolution (which mis-reads a patch:/workspace: protocol) and NOT by whether the version
  // looks like a semver. `npm:` and a bare range are registry-backed; patch:/workspace:/git:/
  // file:/link:/portal:/catalog: are not, even with a semver `version` sibling.
  // Even on a non-registry match, carry the real name from `resolution:` so a descriptor that
  // resolves to a DIFFERENT package (e.g. `my-x@patch:not-x@...`) is rejected centrally.
  if (NON_REGISTRY_PROTOCOL.test(matchedRangePart) || URL_PROTOCOL.test(matchedRangePart))
    return { matched: true, resolvedVersion: entry.resolution ?? matchedRangePart, isRegistry: false, realName: realNameFromResolution(entry.resolution), lines };
  // Real name (for the centralized alias-target confirmation): the classic form carries the
  // alias target in the DESCRIPTOR itself (`<key>@npm:<realName>@<range>`, no `resolution:`
  // field), so read it from the matched rangePart first, falling back to the berry `resolution:`.
  const realName = realNameFromRangePart(matchedRangePart) ?? realNameFromResolution(entry.resolution);
  if (entry.version === null) return { matched: true, resolvedVersion: null, isRegistry: false, realName, lines };
  return { matched: true, resolvedVersion: entry.version, isRegistry: true, realName, lines };
}

// The alias target name from a yarn descriptor's range part `npm:<realName>@<range>` — the range
// never contains '@', so the LAST '@' separates it. A direct `npm:<range>` (no inner '@') or a
// non-npm range has no alias name.
function realNameFromRangePart(rangePart: string): string | null {
  if (!rangePart.startsWith("npm:")) return null;
  const r = rangePart.slice("npm:".length);
  const at = r.lastIndexOf("@");
  return at > 0 ? r.slice(0, at) : null;
}

// Normalize a yarn descriptor's range remainder to a bare version range for comparison against
// the manifest's declaredRange. Only an `npm:`-prefixed remainder is alias-aware: for an alias
// `npm:<realname>@<range>` drop the `<realname>@` (the range never contains '@'). A NON-npm
// remainder is a direct range and is returned AS-IS — it may legitimately contain '@' (e.g. a
// `git+ssh://git@host/…` descriptor), which must not be mangled.
function yarnDescriptorRange(rangePart: string): string {
  if (!rangePart.startsWith("npm:")) return rangePart;
  const r = rangePart.slice("npm:".length);
  const at = r.lastIndexOf("@");
  return at > 0 ? r.slice(at + 1) : r;
}

// The real package name from a berry `resolution:` "<name>@<protocol>:<ver>" — everything
// before the FIRST protocol-introducing `@`, robust for scoped names (which keep a leading @).
function realNameFromResolution(resolution: string | null): string | null {
  if (resolution === null) return null;
  // find the first '@' that is NOT the scoped-name leading '@'
  const at = resolution.indexOf("@", resolution.startsWith("@") ? 1 : 0);
  return at <= 0 ? null : resolution.slice(0, at);
}

// ---- pnpm (pnpm-lock.yaml v5/v6/v9) ---------------------------------------------------------
// Real pnpm-lock.yaml `packages:`/`snapshots:` sections carry inline flow collections
// (`resolution: {integrity: …}`, `engines: {node: …}`, `cpu: [x64]`) that yamlLite rejects.
// The resolver only needs the `importers:` edge (and, for v5, top-level dependencies/specifiers),
// all of which pnpm writes BEFORE those metadata sections — so slice the doc there and never
// parse the flow-heavy tail. If the tail is absent (importer-only lockfile), the whole text is kept.
function sliceToImporters(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^(packages|snapshots):\s*$/.test(line.replace(/\r$/, ""))) break;
    out.push(line);
  }
  return out.join("\n");
}

function resolvePnpm(input: ResolveInput): LockResolution {
  const root = asMap(parseYamlLite(sliceToImporters(input.text)));
  if (root === null) return NO_MATCH;
  const importers = asMap(getChild(root, "importers"));
  // v5 single-package lockfiles put dependencies/specifiers at the TOP level (no importers).
  const importerDir = input.manifestDir === "" ? "." : input.manifestDir;
  const importer = importers !== null ? asMap(getChild(importers, importerDir)) : root;
  if (importer === null) return NO_MATCH;

  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const sec = asMap(getChild(importer, section));
    if (sec === null) continue;
    const entry = getEntry(sec, input.dependencyKey);
    if (entry === null) continue;
    const [spanStart, spanEnd] = nodeLineSpan(entry);
    const lineSpan = spanStart === spanEnd ? [spanStart] : [spanStart, spanEnd];
    // OBJECT form {specifier, version} (v6+) vs STRING form (older, range in a sibling
    // `specifiers` map at the importer/root level). Either way the DECLARED specifier gates the
    // §5.E non-registry classification.
    let resolvedRef: string | null = null;
    let specifier: string | null = null;
    if (entry.value.kind === "map") {
      resolvedRef = asScalar(getChild(asMap(entry.value), "version"));
      specifier = asScalar(getChild(asMap(entry.value), "specifier"));
    } else if (entry.value.kind === "scalar") {
      resolvedRef = entry.value.value;
      const specEntry = getEntry(asMap(getChild(importer, "specifiers")), input.dependencyKey);
      specifier = specEntry === null ? null : asScalar(specEntry.value);
    }
    // A non-registry DECLARED range (catalog:/workspace:/…) is a §5.E skip even if pnpm resolved
    // it to a concrete `version` — the origin is not a plain registry install. Still parse the
    // resolved reference for its real name so an alias to a DIFFERENT package is rejected centrally.
    if (specifier !== null && (NON_REGISTRY_PROTOCOL.test(specifier) || URL_PROTOCOL.test(specifier))) {
      const realName = resolvedRef !== null && resolvedRef !== "" ? classifyPnpmRef(resolvedRef, lineSpan).realName : null;
      return { matched: true, resolvedVersion: specifier, isRegistry: false, realName, lines: lineSpan };
    }
    if (resolvedRef === null || resolvedRef === "") return { matched: true, resolvedVersion: null, isRegistry: false, realName: null, lines: lineSpan };
    return classifyPnpmRef(resolvedRef, lineSpan);
  }
  return NO_MATCH;
}

// Parse a pnpm resolved reference: strip the peer suffix (v6+ parens AND v5 underscore), then
// split an optional alias `name@version` (scoped-safe), then classify by protocol.
export function classifyPnpmRef(ref: string, lines: number[]): LockResolution {
  const t = ref.trim();
  if (NON_REGISTRY_PROTOCOL.test(t) || URL_PROTOCOL.test(t))
    return { matched: true, resolvedVersion: t, isRegistry: false, realName: null, lines };
  const noPeer = stripPeerSuffix(t); // strip v6+ paren peers first
  // The version is a leading semver; a v5 peer is a trailing `_<name>@<ver>`, and a package
  // NAME can itself contain '_'. `SEMVER_HEAD` captures the version up to the first `_`/`(`, so:
  //   - a ref STARTING with a semver is a bare `version[_peer]` (v5 string form) → no alias name
  //   - otherwise it is `name@version[_peer]` → the name precedes the version's `@`
  // This resolves `type_fest@1.0.0_typescript@4` (underscore name + peer) correctly.
  const SEMVER_HEAD = /^(\d+\.\d+\.\d+[^_(]*)/;
  const NAME_VER = /^(.+?)@(\d+\.\d+\.\d+[^_(]*)/;
  // slash-shaped v5 key: /pkg/1.2.3 or /@scope/name/1.2.3 (+ possible v5 `_peer` on the version)
  if (noPeer.startsWith("/")) {
    const lastSlash = noPeer.lastIndexOf("/");
    const name = noPeer.slice(1, lastSlash);
    const versionPart = noPeer.slice(lastSlash + 1);
    const vm = SEMVER_HEAD.exec(versionPart);
    return { matched: true, resolvedVersion: vm ? vm[1]! : versionPart, isRegistry: true, realName: name, lines };
  }
  const bare = SEMVER_HEAD.exec(noPeer);
  if (bare) return { matched: true, resolvedVersion: bare[1]!, isRegistry: true, realName: null, lines };
  const nv = NAME_VER.exec(noPeer);
  if (nv) return { matched: true, resolvedVersion: nv[2]!, isRegistry: true, realName: nv[1]!, lines };
  // no semver: an alias whose VERSION part is itself a protocol (`foo@catalog:...`, `foo@file:`)
  const at = noPeer.lastIndexOf("@");
  if (at > 0) {
    const version = noPeer.slice(at + 1);
    if (NON_REGISTRY_PROTOCOL.test(version) || URL_PROTOCOL.test(version))
      return { matched: true, resolvedVersion: ref.trim(), isRegistry: false, realName: noPeer.slice(0, at), lines };
  }
  return { matched: true, resolvedVersion: noPeer, isRegistry: true, realName: null, lines };
}

// Remove a trailing peer suffix — one OR MORE balanced `(...)` groups running to end-of-string
// (`1.2.3(bar@2)`, `1.2.3(a@1)(b@2)`, nested `1.2.3(bar@2(baz@3))`) → `1.2.3`. A package name
// or version never contains '(', so the first '(' always begins the suffix.
function stripPeerSuffix(ref: string): string {
  const open = ref.indexOf("(");
  if (open === -1) return ref;
  let depth = 0;
  for (let i = open; i < ref.length; i++) {
    if (ref[i] === "(") depth++;
    else if (ref[i] === ")") {
      depth--;
      if (depth < 0) return ref; // malformed — leave it
    }
  }
  return depth === 0 ? ref.slice(0, open) : ref; // only strip a fully-balanced tail
}

// ---- bun (bun.lock JSONC) --------------------------------------------------------------------
// The importer edge `workspaces.<dir>.dependencies` maps key→spec; `packages.<key>` carries a
// [<realname>@<ver>, …] tuple whose first element is the resolved id.
function resolveBun(input: ResolveInput): LockResolution {
  const { value, keyLines } = parseJsoncObject(input.text);
  const workspaces = value["workspaces"];
  const dir = input.manifestDir === "" ? "" : input.manifestDir;
  let edge: Record<string, JsonValue> | null = null;
  let edgeSection = "";
  if (workspaces !== undefined && workspaces !== null && typeof workspaces === "object" && !Array.isArray(workspaces)) {
    const ws = (workspaces as Record<string, JsonValue>)[dir];
    if (ws !== undefined && ws !== null && typeof ws === "object" && !Array.isArray(ws)) {
      for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        const sec = (ws as Record<string, JsonValue>)[section];
        if (sec !== undefined && sec !== null && typeof sec === "object" && !Array.isArray(sec) && Object.hasOwn(sec as object, input.dependencyKey)) {
          edge = sec as Record<string, JsonValue>;
          edgeSection = section;
          break;
        }
      }
    }
  }
  if (edge === null) return NO_MATCH;
  const edgeLine = keyLines.get(`/workspaces/${escapePointer(dir)}/${edgeSection}/${escapePointer(input.dependencyKey)}`) ?? null;

  // Resolve via the packages map: packages.<key> = [ "<realname>@<ver>", … ].
  const packages = value["packages"];
  let resolvedVersion: string | null = null;
  let realName: string | null = null;
  let pkgLine: number | null = null;
  if (packages !== undefined && packages !== null && typeof packages === "object" && !Array.isArray(packages)) {
    const tuple = (packages as Record<string, JsonValue>)[input.dependencyKey];
    if (Array.isArray(tuple) && tuple.length > 0 && typeof tuple[0] === "string") {
      const id = tuple[0] as string;
      // a bun tuple id is `<realname>@<spec>` — the protocol is AFTER the name separator, so
      // classify on the spec (scoped-safe split), not the start of the whole id.
      const at = id.indexOf("@", id.startsWith("@") ? 1 : 0);
      if (at > 0) {
        const name = id.slice(0, at);
        const spec = id.slice(at + 1);
        if (NON_REGISTRY_PROTOCOL.test(spec) || URL_PROTOCOL.test(spec))
          // carry the real name so an id resolving to a DIFFERENT package is rejected centrally
          return { matched: true, resolvedVersion: id, isRegistry: false, realName: name, lines: lineList(edgeLine) };
        realName = name;
        resolvedVersion = spec;
      } else if (NON_REGISTRY_PROTOCOL.test(id) || URL_PROTOCOL.test(id)) {
        return { matched: true, resolvedVersion: id, isRegistry: false, realName: null, lines: lineList(edgeLine) };
      }
      pkgLine = keyLines.get(`/packages/${escapePointer(input.dependencyKey)}`) ?? null;
    }
  }
  const lines = [edgeLine, pkgLine].filter((n): n is number => n !== null).sort((a, b) => a - b);
  if (resolvedVersion === null) return { matched: true, resolvedVersion: null, isRegistry: false, realName, lines: lines.length ? lines : null };
  return { matched: true, resolvedVersion, isRegistry: true, realName, lines: lines.length ? lines : null };
}

// ---- small helpers ---------------------------------------------------------------------------
function rangeInclusive(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
function lineList(n: number | null): number[] | null {
  return n === null ? null : [n];
}
