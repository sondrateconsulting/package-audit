// apiSurface.ts — registry packument + tarball introspection (§5.E). Fetches the packument and
// tarball with NATIVE fetch (NEVER npm/npx/install), verifies SRI/shasum over the RAW .tgz bytes
// BEFORE extraction, pre-scans tar headers (tarScan) and extracts via the guarded system tar
// (github.ts), then statically enumerates the .d.ts export surface (dtsExports) + bin names, and
// writes the durable surface + '__complete__' marker atomically (db.ts). Deduped globally by
// (packageName, resolvedVersion); a partial/failed introspection leaves no marker (re-attempted)
// and logs a version-keyed errors row instead.

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { assertContained } from "./readOnlyGuard.ts";
import type { GithubClient } from "./github.ts";
import type { AuditDb, ApiSurfaceRow, ResolvedVersionSource } from "./db.ts";
import { parseJsoncObject } from "./jsonc.ts";
import { resolveTypeTargets, typeTargetToDts, binNames, exportsSubpathKeys, resolveSubpath, type PkgJson } from "./exportsResolve.ts";
import { enumerateDtsExports, joinRelative, type DtsResolver } from "./dtsExports.ts";
import { maxSatisfying } from "./semver.ts";
import { scanTarball } from "./tarScan.ts";

export class IntrospectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntrospectionError";
  }
}

const MAX_TARBALL_BYTES = 100 * 1024 * 1024; // registry tarball hard cap, COMPRESSED (§5.C/§5.E)
const MAX_REDIRECTS = 5;
// UNCOMPRESSED cap: a registry .tgz is untrusted, and a decompression bomb (a tiny .tgz that
// inflates to gigabytes) must not exhaust memory. node:zlib enforces maxOutputLength INCREMENTALLY
// and throws before the cap is exceeded (Bun.gunzipSync has no such cap). Set above tarScan's
// 100MB cumulative-file cap (for headers/padding) so a legitimate under-cap package never
// false-rejects; tarScan's file-byte cap is the second line of defense.
export const MAX_INFLATED_BYTES = 150 * 1024 * 1024;

// Bounded gunzip: throws (→ scanTarball reports "gunzip failed") when the inflated output would
// exceed maxBytes, so allocation is capped on untrusted input.
export function inflateBounded(gz: Uint8Array, maxBytes: number = MAX_INFLATED_BYTES): Uint8Array {
  return gunzipSync(gz, { maxOutputLength: maxBytes });
}

// ---- SRI / integrity (pure) -----------------------------------------------------------------
export interface Integrity {
  algorithm: "sha512" | "sha384" | "sha256";
  digestB64: string;
}
const SRI_STRENGTH: Record<string, number> = { sha512: 3, sha384: 2, sha256: 1 };

// Parse an npm `dist.integrity` SRI string (whitespace-separated `algo-base64` tokens); return
// the STRONGEST supported hash, or null when none is supported/parseable (caller fails closed).
export function parseSRI(integrity: string): Integrity | null {
  let best: Integrity | null = null;
  for (const token of integrity.trim().split(/\s+/)) {
    if (token === "") continue;
    const dash = token.indexOf("-");
    const algo = dash === -1 ? token : token.slice(0, dash);
    if (!(algo in SRI_STRENGTH)) continue; // an UNsupported algo is ignored (a stronger one may follow)
    const digestB64 = dash === -1 ? "" : token.slice(dash + 1);
    // a SUPPORTED algorithm with a malformed digest is fail-closed: return null rather than
    // silently verifying against a weaker sibling token.
    if (digestB64 === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(digestB64)) return null;
    if (best === null || SRI_STRENGTH[algo]! > SRI_STRENGTH[best.algorithm]!)
      best = { algorithm: algo as Integrity["algorithm"], digestB64 };
  }
  return best;
}

function constantTimeEqualB64(a: string, b: string): boolean {
  const ba = Buffer.from(a, "base64");
  const bb = Buffer.from(b, "base64");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Verify the tarball bytes against dist.integrity (preferred; a PRESENT-but-mismatched integrity
// FAILS — never falls back to shasum) or, when integrity is absent, dist.shasum (sha1 hex).
// Throws IntrospectionError on any mismatch / missing-both.
export function verifyIntegrity(bytes: Uint8Array, integrity: string | undefined, shasum: string | undefined): void {
  if (integrity !== undefined && integrity.trim() !== "") {
    const sri = parseSRI(integrity);
    if (sri === null) throw new IntrospectionError(`unsupported/invalid dist.integrity: ${integrity}`);
    const actual = createHash(sri.algorithm).update(bytes).digest("base64");
    if (!constantTimeEqualB64(actual, sri.digestB64))
      throw new IntrospectionError(`integrity mismatch (${sri.algorithm})`);
    return;
  }
  if (shasum !== undefined && shasum.trim() !== "") {
    const expected = shasum.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(expected)) throw new IntrospectionError("malformed dist.shasum");
    const actual = createHash("sha1").update(bytes).digest("hex");
    const a = Buffer.from(actual, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new IntrospectionError("shasum mismatch");
    return;
  }
  throw new IntrospectionError("no dist.integrity or dist.shasum to verify against");
}

// ---- packument (pure selection) -------------------------------------------------------------
export interface DistInfo {
  tarball: string;
  integrity?: string;
  shasum?: string;
}
export interface Packument {
  versions?: Record<string, { dist?: DistInfo }>;
}

export function selectVersionDist(packument: Packument, version: string): DistInfo | null {
  const v = packument.versions?.[version];
  const dist = v?.dist;
  if (dist === undefined || typeof dist.tarball !== "string" || dist.tarball === "") return null;
  return dist;
}

// §5.E range fallback: the MAX-satisfying PUBLISHED version for a declared range (semver-only;
// prereleases excluded unless the range names one). null when nothing satisfies.
export function resolveRangeToVersion(packument: Packument, range: string): string | null {
  const versions = Object.keys(packument.versions ?? {});
  return maxSatisfying(versions, range);
}

// SLASH-only encoding of a scoped package name for the packument URL: `@scope/name` →
// `@scope%2Fname` (NOT full encodeURIComponent, which would also encode the `@`).
export function encodePackageNameForUrl(name: string): string {
  return name.startsWith("@") ? name.replace("/", "%2F") : name;
}

// ---- fetch layer (injectable) ---------------------------------------------------------------
export type FetchFn = (url: string, init: { headers: Record<string, string>; redirect: "manual" }) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export interface IntrospectOptions {
  client: GithubClient;
  db: AuditDb;
  runId: string;
  packageName: string;
  registryUrl: string;
  registryAuthEnvVar: string | null;
  version: string;
  versionSource: ResolvedVersionSource;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchFn;
  packument?: Packument; // optional pre-fetched packument (the orchestrator caches per package)
}

const realFetch: FetchFn = (url, init) => fetch(url, { headers: init.headers, redirect: init.redirect }) as unknown as ReturnType<FetchFn>;

// Fetch a URL following redirects MANUALLY, re-verifying the per-hop origin and attaching the
// bearer token ONLY on hops whose origin equals the registry origin (never carrying it across a
// redirect to a different origin). Accept-Encoding: identity so the .tgz gzip bytes are not
// transparently decoded (SRI is over those exact bytes, and system tar needs them).
async function fetchFollowing(
  startUrl: string,
  registryOrigin: string,
  authToken: string | null,
  fetchImpl: FetchFn,
  wantBytes: boolean,
): Promise<{ bytes: Uint8Array; text: string }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const sameOrigin = new URL(current).origin === registryOrigin;
    const headers: Record<string, string> = { "Accept-Encoding": "identity" };
    if (authToken !== null && sameOrigin) headers["Authorization"] = `Bearer ${authToken}`;
    const res = await fetchImpl(current, { headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc === null) throw new IntrospectionError(`redirect ${res.status} without Location`);
      const next = new URL(loc, current);
      // §5.E: a redirect OFF the registry origin is rejected (never followed) — the tool only
      // ever fetches registry-origin resources, and this closes an off-origin exfiltration path.
      if (next.origin !== registryOrigin)
        throw new IntrospectionError(`off-origin redirect to ${next.origin} (registry is ${registryOrigin})`);
      current = next.href;
      continue;
    }
    if (!res.ok) throw new IntrospectionError(`HTTP ${res.status} fetching ${redactUrl(current)}`);
    if (wantBytes) {
      const enc = res.headers.get("content-encoding");
      if (enc !== null && enc.toLowerCase() !== "identity")
        throw new IntrospectionError(`unexpected content-encoding '${enc}' on tarball (would corrupt SRI)`);
      const lenHeader = res.headers.get("content-length");
      if (lenHeader !== null) {
        const len = Number(lenHeader);
        // an unparseable OR oversized content-length is rejected (defense in depth)
        if (Number.isNaN(len) || len > MAX_TARBALL_BYTES)
          throw new IntrospectionError(`invalid/oversized tarball content-length: ${lenHeader}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_TARBALL_BYTES) throw new IntrospectionError(`tarball exceeds ${MAX_TARBALL_BYTES} bytes`);
      return { bytes, text: "" };
    }
    return { bytes: new Uint8Array(), text: await res.text() };
  }
  throw new IntrospectionError(`too many redirects fetching ${redactUrl(startUrl)}`);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`; // drop any query/token
  } catch {
    return "<url>";
  }
}

// ---- surface extraction (uses github.ts tar + fs reads under the extracted root) -------------
interface ExtractedSurface {
  rows: ApiSurfaceRow[];
}

function inspectExtracted(packageRoot: string): ExtractedSurface {
  const pkgText = readContained(packageRoot, "package.json");
  if (pkgText === null) throw new IntrospectionError("package/package.json not found in tarball");
  let pkg: PkgJson;
  try {
    pkg = parseJsoncObject(pkgText).value as PkgJson;
  } catch (e) {
    throw new IntrospectionError(`invalid package.json: ${(e as Error).message}`);
  }

  const rows: ApiSurfaceRow[] = [];
  const seen = new Set<string>(); // dedup export rows across import+require targets

  // dtsExports resolver: map a relative `export * from './x'` to its declaration text, trying the
  // usual .d.ts resolution candidates. Paths are package-relative (dtsExports uses joinRelative).
  const resolver: DtsResolver = (spec, fromFile): string | null => {
    const base = joinRelative(fromFile, spec);
    for (const cand of [`${base}.d.ts`, `${base}.d.mts`, `${base}.d.cts`, `${base}/index.d.ts`, base]) {
      const text = readContained(packageRoot, cand);
      if (text !== null) return text;
    }
    return null;
  };

  const collectFromDts = (dtsRel: string): void => {
    const dts = readContained(packageRoot, dtsRel);
    if (dts === null) return;
    for (const exp of enumerateDtsExports(dts, dtsRel.replace(/^\.\//, ""), resolver)) {
      const key = `${exp.kind}\0${exp.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ exportName: exp.name, exportKind: exp.kind, source: dtsRel });
    }
  };

  // root surface (union of import+require targets)
  for (const target of resolveTypeTargets(pkg)) collectFromDts(typeTargetToDts(target));

  // exact `exports` subpaths ('./config' …) are part of the FULL public surface (§5.E), each
  // resolved under both modes and unioned. '*'-pattern keys are skipped: their concrete
  // expansions are not statically enumerable from the map alone.
  for (const subpath of exportsSubpathKeys(pkg).exact) {
    for (const target of resolveSubpath(pkg, subpath).targets) collectFromDts(typeTargetToDts(target));
  }

  // bin names (§5.G) — the cli-bin surface, deduped
  for (const bin of binNames(pkg)) {
    const key = `cli-bin\0${bin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ exportName: bin, exportKind: "cli-bin", source: "package.json#bin" });
  }
  return { rows };
}

// Post-extraction GROUND-TRUTH safety sweep (§5.E defense-in-depth). Walks the extracted tree
// with lstat (NEVER following a link) and throws on the FIRST symlink, hardlink, or non-regular/
// non-dir member — the definitive check on what `tar` actually materialized, independent of the
// pre-extraction header parser. A directory that is itself a symlink throws before it is descended.
// FAIL-CLOSED: a readdir/lstat error aborts the whole version (an archive-controlled unreadable
// directory must never let a member escape the sweep). This is safe because extraction runs with
// --no-same-permissions, so a legitimate npm tree never has an unreadable member; the tree is a
// fresh single-process mktemp (no TOCTOU). Hardlinks (`nlink > 1` on a regular file) are rejected
// too — they surface to lstat as ordinary files, so a smuggled hardlink would otherwise be missed.
export function assertExtractedTreeSafe(root: string): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      throw new IntrospectionError(`cannot read extracted dir (fail-closed): ${(e as Error).message}`);
    }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch (e) {
        throw new IntrospectionError(`cannot lstat extracted member ${name} (fail-closed): ${(e as Error).message}`);
      }
      if (st.isSymbolicLink()) throw new IntrospectionError(`extracted tree contains a symlink: ${name}`);
      else if (st.isDirectory()) stack.push(full);
      else if (!st.isFile()) throw new IntrospectionError(`extracted tree contains a non-regular member: ${name}`);
      else if (st.nlink > 1) throw new IntrospectionError(`extracted tree contains a hardlinked member: ${name}`);
    }
  }
}

// Synchronous CONTAINED read of a package-relative path under the PACKAGE root (§0/§5.E).
// Containment is scoped to packageRoot (the `package/` subtree), NOT the wider extract dir, so a
// `.d.ts`/types path with enough `../` cannot resolve to a sibling of `package/` — this holds
// even if the tar pre-scan were ever bypassed, rather than relying on it. assertContained follows
// symlinks (realpath), so a link can never redirect the read outside packageRoot either. Returns
// null on a missing file or any path escaping the root.
function readContained(packageRoot: string, rel: string): string | null {
  const abs = join(packageRoot, rel.replace(/^\.\//, ""));
  try {
    assertContained(abs, [packageRoot]);
  } catch {
    return null;
  }
  try {
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  } catch {
    return null;
  }
}

// ---- top-level introspection ----------------------------------------------------------------
export async function introspectVersion(opts: IntrospectOptions): Promise<void> {
  const { client, db, runId, packageName, registryUrl, version, versionSource } = opts;
  if (db.hasCompletionMarker(packageName, version)) return; // global (name,version) dedup (§5.E)

  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? realFetch;
  const authToken = opts.registryAuthEnvVar !== null ? (env[opts.registryAuthEnvVar] ?? null) : null;
  const registryOrigin = new URL(registryUrl).origin;

  try {
    const packument = opts.packument ?? (await fetchPackument(opts));
    const dist = selectVersionDist(packument, version);
    if (dist === null) throw new IntrospectionError(`version ${version} not present in packument`);
    // §5.E: the tarball origin MUST equal the registry origin (prevents off-origin token leaks).
    if (new URL(dist.tarball).origin !== registryOrigin)
      throw new IntrospectionError(`tarball origin ${new URL(dist.tarball).origin} != registry ${registryOrigin}`);

    const { bytes } = await fetchFollowing(dist.tarball, registryOrigin, authToken, fetchImpl, true);
    verifyIntegrity(bytes, dist.integrity, dist.shasum); // BEFORE extraction

    const scan = scanTarball(bytes, (b) => inflateBounded(b));
    if (!scan.ok) throw new IntrospectionError(`unsafe tarball: ${scan.reason}`);

    const dir = client.makeRunTempDir();
    try {
      const tgzPath = join(dir, "pkg.tgz");
      assertContained(tgzPath, [client.tempRoot]);
      await Bun.write(tgzPath, bytes);
      const extractRoot = join(dir, "extract");
      assertContained(extractRoot, [client.tempRoot]);
      mkdirSync(extractRoot, { recursive: true });
      const untar = await client.tar(["-xzf", tgzPath, "-C", extractRoot, "--no-same-owner", "--no-same-permissions"]);
      if (untar.exitCode !== 0)
        throw new IntrospectionError(`tar extraction failed (exit ${untar.exitCode}): ${untar.stderr.trim().slice(0, 200)}`);
      // Defense-in-depth (§5.E): the tarScan pre-scan rejects symlinks/traversal from an UNTRUSTED
      // archive, but it hand-matches libarchive's header semantics and any residual differential
      // would let a member slip through. So VERIFY the GROUND TRUTH of what tar actually wrote:
      // reject the version if the extracted tree contains any symlink or non-regular member.
      assertExtractedTreeSafe(extractRoot);
      // npm tarballs root everything under `package/`.
      const surface = inspectExtracted(join(extractRoot, "package"));
      // atomic surface + '__complete__' marker (durable success record, even for zero rows)
      db.writeApiSurface({ packageName, version, versionSource, rows: surface.rows });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    // per-version REGISTRY failure → version-keyed errors row (§5.E/§8), no marker written.
    db.insertError({ runId, scope: "introspection", packageName, version, message: (e as Error).message });
  }
}

export interface PackumentRequest {
  packageName: string;
  registryUrl: string;
  registryAuthEnvVar: string | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchFn;
}

// Fetch + parse a package's packument. EXPORTED for the orchestrator: the §5.E range-resolution
// fallback (no-lockfile repos) needs the packument BEFORE it can pick a concrete version for
// introspectVersion — it fetches once per package and passes it back via opts.packument. Applies
// the same origin-pinned redirect/auth rules as the tarball fetch. Throws IntrospectionError.
export async function fetchPackument(req: PackumentRequest): Promise<Packument> {
  const env = req.env ?? process.env;
  const fetchImpl = req.fetchImpl ?? realFetch;
  const authToken = req.registryAuthEnvVar !== null ? (env[req.registryAuthEnvVar] ?? null) : null;
  const registryOrigin = new URL(req.registryUrl).origin;
  const base = req.registryUrl.replace(/\/+$/, "");
  const url = `${base}/${encodePackageNameForUrl(req.packageName)}`;
  const { text } = await fetchFollowing(url, registryOrigin, authToken, fetchImpl, false);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IntrospectionError(`invalid packument JSON for ${req.packageName}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new IntrospectionError(`packument for ${req.packageName} is not an object`);
  return parsed as Packument;
}
