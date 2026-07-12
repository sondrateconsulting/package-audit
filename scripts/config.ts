// config.ts — load, validate, normalize the audit config and compute config_hash (§1, §2.6).
// The hash is over the SCAN/REPORT-DEFINING projection (what determines WHAT is scanned and
// reported), so tuning `concurrency` or `paths` (speed / storage location, not scanned work)
// never orphans resumable work (§3). Configured org fields participate; the DISCOVERED owner
// set never does (discovery re-runs every invocation).

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { assertContained } from "./readOnlyGuard.ts";
import { isValidPackageName } from "./packageName.ts";
import { sortedDedup, toAsciiLower } from "./patternCanonical.ts";
import { compileBranchPolicy, BranchPolicyError, type CompiledBranchPolicy } from "./branchPolicy.ts";
import { compileRepositoryPolicy, RepositoryPolicyError, type CompiledRepositoryPolicy } from "./repositoryPolicy.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
function fail(msg: string): never {
  throw new ConfigError(msg);
}

export interface PackageConfig {
  name: string;
  registryUrl: string;
  registryAuthEnvVar: string | null;
}

export interface Concurrency {
  organizations: number;
  repositories: number;
  branches: number;
}

// Per-category spawn + liveness deadlines, in SECONDS (§3 resilience — T11). Operational tuning
// only: like `concurrency`, EXCLUDED from config_hash so raising a timeout never orphans
// resumable work. Every field is optional in the file; omitted fields fall back to DEFAULT_TIMEOUTS.
export interface Timeouts {
  controlApiSeconds: number; // gh auth/version/rate_limit/user, GraphQL, listings — quick control calls
  bulkApiSeconds: number; // raw content GETs (file/blob/recursive-tree) — large, slow-link tolerant
  cloneSeconds: number; // git clone fallback
  tarSeconds: number; // registry tarball extraction
  probeSeconds: number; // T2 connectivity probe (wired in the outage-lifecycle PR)
  heartbeatSeconds: number; // liveness heartbeat cadence (orchestrate, not a spawn deadline)
}

export interface Config {
  githubHost: string;
  organizations: string[] | null; // null = discover; [] = configured-empty; [..] = allowlist
  excludeOrganizations: string[];
  includePersonalNamespace: boolean;
  includeForks: boolean;
  includeArchived: boolean;
  maxReposPerOrg: number | null; // null = unlimited
  maxBranchesPerRepo: number;
  // Branch-name allow/deny policy (exact name or Bun glob). null = unrestricted (every branch
  // eligible); [] = nothing but the default branch eligible; [..] = allowlist. excludeBranches is
  // a denylist that wins over `branches`; the default branch is NEVER excluded by policy.
  branches: string[] | null;
  excludeBranches: string[];
  // Repository-name denylist (Bun glob or exact name) over `owner/repo` full names, CASE-INSENSITIVE
  // (ASCII fold). Deny-only; default []. A leading "!" or empty entry is rejected at validation. Unlike
  // excludeBranches (case-SENSITIVE), repo matching is case-insensitive because GitHub repo identity is.
  excludeRepositories: string[];
  cutoffDate: string; // YYYY-MM-DD
  concurrency: Concurrency;
  timeouts: Timeouts;
  packages: PackageConfig[];
  excludeDirGlobs: string[];
  paths: { sqlitePath: string; outputDir: string };
}

export interface LoadedConfig {
  config: Config;
  configHash: string;
  configPath: string;
  // The compiled branch policy, built once here at load and threaded as the SINGLE instance
  // through plan + scan (do not recompile downstream). A resumed run in another process recompiles.
  branchPolicy: CompiledBranchPolicy;
  // The compiled repository denylist, built once here at load (same single-instance discipline). Empty
  // when excludeRepositories is []/omitted, in which case classifyRepository is a constant false.
  repositoryPolicy: CompiledRepositoryPolicy;
}

const DEFAULT_GITHUB_HOST = "github.com";
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_EXCLUDE_DIR_GLOBS = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/vendor/**"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// §5 concurrency: all three keys are OPTIONAL and default when absent. `repositories` is the global
// in-flight cap on gh/git/tar subprocesses; `organizations` and `branches` size the owner and
// per-repo branch-unit fan-out pools. A documented ceiling caps a pathological value (e.g. a huge
// `branches` would otherwise try to dispatch that many fibers). concurrency is EXCLUDED from
// config_hash, so defaulting/tuning it never changes the hash or orphans resumable work.
const DEFAULT_CONCURRENCY = { organizations: 3, repositories: 8, branches: 4 } as const;
const MAX_CONCURRENCY = 64;

// T11 defaults (seconds). control-API is deliberately tighter than bulk: a quick auth/version/
// rate-limit call has no reason to hang 15 min, but a raw blob/recursive-tree read over a slow VPN
// legitimately can — so bulk keeps the pre-T11 15-min budget while control drops to 5 min.
export const DEFAULT_TIMEOUTS: Timeouts = {
  controlApiSeconds: 300,
  bulkApiSeconds: 900,
  cloneSeconds: 900,
  tarSeconds: 900,
  probeSeconds: 10,
  heartbeatSeconds: 30,
};

// ---- input helpers (validate at the boundary; never trust external JSON) -----------------
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

// ---- sibling-key hints for the two names that exist at BOTH levels ---------------------------
// `organizations` and `branches` each name a root-level ALLOWLIST *and* a key under `concurrency` —
// two unrelated settings, one word. config.schema.json notes the collision inline, but nobody reads a
// schema description while staring at a startup failure, so the error itself says where the value
// belongs (the same "name where each thing goes" idea as the `!`-rejection below).
// Both hints fire ONLY when the value's shape actually fits the sibling: a wrong hint — telling
// someone they meant the other key when they simply mistyped this one — is worse than no hint.
// `concurrency.repositories` has no root-level twin and never hints.
// The hints name a DESTINATION, not behavior. All three concurrency keys ARE consumed now (§5 fan-out):
// `repositories` is the global in-flight cap on gh/git/tar subprocesses (github.ts), `organizations`
// sizes the owner fan-out pool, and `branches` the per-repo branch-unit pool. They are DISTINCT from
// the root-level `organizations`/`branches` allow-lists (which define WHAT is scanned) — same word,
// unrelated setting — which is exactly the collision these hints disambiguate.

// A LIST of non-empty names under `concurrency.<k>` can only have been meant as the root-level
// allowlist: a count is never a list. Unambiguous, so name the one key it must be.
// A '!'-prefixed entry gets no hint either (the predicate below filters it out): the branch
// allowlists reject a leading "!" outright (validateBranchPattern — glob negation is unsupported),
// while the organizations allowlist accepts "!acme" but then matches no real org. Either way,
// pointing at the root allowlist just trades one problem for another — stay silent instead.
function concurrencyListHint(key: string, v: unknown): string {
  if (key !== "organizations" && key !== "branches") return "";
  if (!Array.isArray(v) || !v.every((x) => isString(x) && x.length > 0 && !x.startsWith("!"))) return "";
  const noun = key === "branches" ? "branch" : "organization";
  return ` — for a list of ${noun} names you likely meant the root-level "${key}" allowlist`;
}

// A positive integer under a root-level allowlist key is the mirror-image mix-up. `organizations` has
// exactly one numeric twin; `branches` has TWO plausible ones and guessing between them would be a coin
// flip, so name both and let the operator pick (`maxBranchesPerRepo`, the per-repo branch cap, vs
// `concurrency.branches`, the per-repo branch fan-out width — both real, so both are offered).
// Any other numeric shape (0, negative, float) fits no sibling and gets no hint.
function allowlistNumberHint(key: "organizations" | "branches", v: unknown): string {
  if (!isPosInt(v)) return "";
  return key === "branches"
    ? ` — for a number you likely meant "maxBranchesPerRepo" (the per-repo branch cap) or "concurrency.branches"`
    : ` — for a number you likely meant "concurrency.organizations"`;
}

function reqString(o: Record<string, unknown>, key: string, ctx: string): string {
  const v = o[key];
  if (!isString(v) || v.length === 0) fail(`${ctx}.${key} must be a non-empty string`);
  return v as string;
}
function optString(o: Record<string, unknown>, key: string, dflt: string): string {
  const v = o[key];
  if (v === undefined || v === null) return dflt;
  if (!isString(v)) fail(`${key} must be a string`);
  return v;
}
function optBool(o: Record<string, unknown>, key: string, dflt: boolean): boolean {
  const v = o[key];
  if (v === undefined || v === null) return dflt;
  if (!isBool(v)) fail(`${key} must be a boolean`);
  return v;
}
// Items must be NON-EMPTY strings: config.schema.json declares minLength 1 on every array this
// helper backs (excludeOrganizations, excludeDirGlobs), and an empty org name or glob is always
// operator error — "" as a glob matches nothing and as an org name is unresolvable.
// ONE definition of the per-item rule every string-array config key shares (schema: items
// minLength 1). Four different array validators consume it (optStringArray,
// normalizeOrganizations, validateBranchPattern, validateRepoPattern) and the schema-sync test pins
// every constrained key against it, so the predicate and message cannot drift apart per key.
function assertNonEmptyStringItem(v: unknown, label: string, i: number): string {
  if (!isString(v) || v.length === 0) fail(`${label}[${i}] must be a non-empty string`);
  return v;
}

function optStringArray(o: Record<string, unknown>, key: string, dflt: string[]): string[] {
  const v = o[key];
  if (v === undefined || v === null) return [...dflt];
  if (!Array.isArray(v)) fail(`${key} must be an array of strings`);
  return (v as unknown[]).map((el, i) => assertNonEmptyStringItem(el, key, i));
}

// ---- unknown-key rejection (strict at every object level) ---------------------------------
// A typo'd key must fail LOUDLY: `"organization"` (missing s) would otherwise be silently
// ignored, leaving organizations=null — DISCOVERY MODE — and widening the scan to every org the
// token can see. Key sets are exported so the config.schema.json sync tests can assert the
// schema and the runtime agree. `$schema` is a root-only editor hint: allowed, type-checked,
// and excluded from config_hash (it never enters the hash projection).
export const CONFIG_ROOT_KEYS = [
  "$schema", "githubHost", "organizations", "excludeOrganizations", "includePersonalNamespace",
  "includeForks", "includeArchived", "maxReposPerOrg", "maxBranchesPerRepo", "branches",
  "excludeBranches", "excludeRepositories", "cutoffDate", "concurrency", "timeouts", "packages", "excludeDirGlobs", "paths",
] as const;
export const CONFIG_CONCURRENCY_KEYS = ["organizations", "repositories", "branches"] as const;
export const CONFIG_TIMEOUTS_KEYS = [
  "controlApiSeconds", "bulkApiSeconds", "cloneSeconds", "tarSeconds", "probeSeconds", "heartbeatSeconds",
] as const;
export const CONFIG_PATHS_KEYS = ["sqlitePath", "outputDir"] as const;
export const CONFIG_PACKAGE_KEYS = ["name", "registryUrl", "registryAuthEnvVar"] as const;

// Classic two-row Levenshtein — inputs are short config keys, so this stays trivial.
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

function rejectUnknownKeys(o: Record<string, unknown>, known: readonly string[], path: string): void {
  const knownSet = new Set<string>(known);
  for (const key of Object.keys(o)) {
    if (knownSet.has(key)) continue;
    const best = known.map((k) => ({ k, d: editDistance(key, k) })).sort((x, y) => x.d - y.d)[0];
    const hint = best !== undefined && best.d <= 2 ? ` — did you mean "${best.k}"?` : "";
    fail(`unknown config key ${path}.${key}${hint} (valid keys: ${[...known].sort().join(", ")})`);
  }
}

// ---- validation + normalization ----------------------------------------------------------
function normalizeGithubHost(o: Record<string, unknown>): string {
  const host = optString(o, "githubHost", DEFAULT_GITHUB_HOST);
  // non-empty bare host or host:port — no scheme, path, userinfo, or invalid port.
  const m = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(host);
  if (!m) fail(`githubHost must be a non-empty bare host or host:port: "${host}"`);
  const port = m[2];
  if (port !== undefined) {
    const n = Number(port);
    if (n < 1 || n > 65535) fail(`githubHost port out of range: ${host}`);
  }
  return host;
}

function normalizeOrganizations(o: Record<string, unknown>): string[] | null {
  const v = o["organizations"];
  if (v === undefined || v === null) return null; // discover mode
  if (!Array.isArray(v)) fail(`organizations must be null or an array of strings${allowlistNumberHint("organizations", v)}`);
  // [] = configured-empty (distinct from null); [..] = allowlist. Items must be non-empty
  // (schema: minLength 1) — an empty org name is always operator error.
  return (v as unknown[]).map((el, i) => assertNonEmptyStringItem(el, "organizations", i));
}

// A branch-policy pattern (exact name or Bun glob) at index i of `listName`. Rejects a non-string,
// an empty string, and any pattern starting with "!". Leading-"!" is Bun.Glob NEGATION; we reject
// it as a deliberate POLICY-LANGUAGE restriction so `"!main"` can never be mistaken for "not main"
// — git itself permits refs/heads/!main, so this is our rule, not git's. Documented consequence: a
// literal branch named "!foo" cannot be listed. The value is rendered via JSON.stringify so a
// control character in a pattern cannot corrupt the diagnostic. (Glob VALIDITY is not checked here:
// Bun.Glob accepts malformed patterns like "[" at construction, and no accepted pattern is known
// to throw at match time either — a pattern that matches nothing surfaces via the advisory
// unmatched-pattern warning, and the policy engine still fails closed on any match-time throw —
// see branchPolicy.ts.)
function validateBranchPattern(v: unknown, listName: string, i: number): string {
  const s = assertNonEmptyStringItem(v, listName, i);
  if (s.startsWith("!"))
    fail(`${listName}[${i}] must not start with "!" — glob negation is not supported; put branches to INCLUDE in "branches" and branches to EXCLUDE in "excludeBranches": ${JSON.stringify(s)}`);
  return s;
}

// branches: null/omitted = unrestricted; [] = only the default branch eligible; [..] = allowlist.
// The null-vs-[] distinction is meaningful and is preserved into the hash and the compiled policy.
function normalizeBranches(o: Record<string, unknown>): string[] | null {
  const v = o["branches"];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) fail(`branches must be null or an array of strings${allowlistNumberHint("branches", v)}`);
  return (v as unknown[]).map((el, i) => validateBranchPattern(el, "branches", i));
}

// excludeBranches: null/omitted = none ([]); [..] = denylist. null collapses to [] (an absent and
// an explicit-empty denylist mean the same thing), mirroring excludeOrganizations.
function normalizeExcludeBranches(o: Record<string, unknown>): string[] {
  const v = o["excludeBranches"];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`excludeBranches must be an array of strings`);
  return (v as unknown[]).map((el, i) => validateBranchPattern(el, "excludeBranches", i));
}

// A repository-denylist pattern (exact `owner/repo` name or Bun glob) at index i. Same structural
// restriction as validateBranchPattern — rejects a non-string, an empty string, and any leading "!"
// (Bun.Glob negation, unsupported as a policy-language choice so "!acme/x" can never read as "not
// acme/x") — but the remediation names excludeRepositories, not branches: a deny-only denylist has no
// sibling include list to redirect to. The value is JSON.stringify'd so a control character cannot
// corrupt the diagnostic. Glob VALIDITY is not checked here (Bun.Glob accepts malformed patterns at
// construction); compileRepositoryPolicy rejects a construction throw, and the matcher fails closed on
// a match-time throw (see repositoryPolicy.ts). Matching is case-insensitive, but the STORED pattern
// keeps its original case (the ASCII fold is applied only in the hash projection and at compile time).
function validateRepoPattern(v: unknown, i: number): string {
  const s = assertNonEmptyStringItem(v, "excludeRepositories", i);
  if (s.startsWith("!"))
    fail(`excludeRepositories[${i}] must not start with "!" — glob negation is not supported; list the repositories to EXCLUDE by their "owner/repo" name (exact or glob): ${JSON.stringify(s)}`);
  return s;
}

// excludeRepositories: null/omitted = none ([]); [..] = denylist. null collapses to [] (an absent and
// an explicit-empty denylist mean the same thing), mirroring excludeBranches/excludeOrganizations. The
// order is preserved as-written; the ASCII fold + sortedDedup are applied downstream (hash + compile).
function normalizeExcludeRepositories(o: Record<string, unknown>): string[] {
  const v = o["excludeRepositories"];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`excludeRepositories must be an array of strings`);
  return (v as unknown[]).map((el, i) => validateRepoPattern(el, i));
}

function validateRegistryUrl(url: string, pkgName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail(`packages["${pkgName}"].registryUrl is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") fail(`packages["${pkgName}"].registryUrl must be https://: ${url}`);
  if (parsed.username !== "" || parsed.password !== "")
    fail(`packages["${pkgName}"].registryUrl must not contain userinfo (user:pass@): ${url}`);
  // canonical form for the hash: origin + pathname with a single trailing-slash trimmed.
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

function normalizePackages(o: Record<string, unknown>, env: Record<string, string | undefined>): PackageConfig[] {
  const raw = o["packages"];
  if (!Array.isArray(raw) || raw.length === 0) fail(`packages is required and must be a non-empty array (minItems: 1)`);
  const seen = new Set<string>();
  const packages: PackageConfig[] = [];
  for (const [i, entry] of (raw as unknown[]).entries()) {
    if (!isObject(entry)) fail(`each packages[] entry must be an object`);
    rejectUnknownKeys(entry, CONFIG_PACKAGE_KEYS, `$.packages[${i}]`);
    const name = reqString(entry, "name", "packages[]");
    // Fail-closed at the boundary: a name that isn't a strictly valid npm package name could,
    // once embedded in a registry URL, normalize to an off-target same-origin path/query and
    // leak the registry bearer token (§5.E). Reject it before it ever reaches the fetch layer.
    if (!isValidPackageName(name)) fail(`packages["${name}"].name is not a valid npm package name`);
    if (seen.has(name)) fail(`packages[].name must be UNIQUE across the array — duplicate: ${name}`);
    seen.add(name);
    const registryUrl = validateRegistryUrl(optString(entry, "registryUrl", DEFAULT_REGISTRY_URL), name);
    let registryAuthEnvVar: string | null = null;
    const authRaw = entry["registryAuthEnvVar"];
    if (authRaw !== undefined && authRaw !== null) {
      if (!isString(authRaw) || authRaw.length === 0) fail(`packages["${name}"].registryAuthEnvVar must be a non-empty env var NAME`);
      const val = env[authRaw];
      if (val === undefined || val === "")
        fail(`packages["${name}"].registryAuthEnvVar names env var ${authRaw}, which is not SET or is empty`);
      registryAuthEnvVar = authRaw;
    }
    packages.push({ name, registryUrl, registryAuthEnvVar });
  }
  return packages;
}

function normalizeConcurrency(o: Record<string, unknown>): Concurrency {
  const c = o["concurrency"];
  if (c === undefined || c === null) return { ...DEFAULT_CONCURRENCY }; // whole block optional → all defaults
  if (!isObject(c)) fail(`concurrency must be an object`);
  rejectUnknownKeys(c, CONFIG_CONCURRENCY_KEYS, "$.concurrency");
  const read = (k: keyof Concurrency): number => {
    const v = (c as Record<string, unknown>)[k];
    if (v === undefined || v === null) return DEFAULT_CONCURRENCY[k]; // per-key optional → its default
    if (!isPosInt(v)) fail(`concurrency.${k} must be a positive integer${concurrencyListHint(k, v)}`);
    if (v > MAX_CONCURRENCY) fail(`concurrency.${k} must be <= ${MAX_CONCURRENCY} (got ${v}) — past this ceiling a larger value yields no throughput gain (organizations/branches only queue more fibers; repositories only raises the subprocess cap) and just risks exhausting memory/handles`);
    return v;
  };
  return { organizations: read("organizations"), repositories: read("repositories"), branches: read("branches") };
}

// timeouts is OPTIONAL and per-field defaulted: an operator may override just one knob (e.g.
// bulkApiSeconds on a slow VPN) and inherit the rest. An absent `timeouts` block yields all
// defaults. Each present field must be a positive integer (a nonpositive deadline would instantly
// expire every spawn — the github client also fail-fast validates this, but reject it here first
// with a config-shaped error).
function normalizeTimeouts(o: Record<string, unknown>): Timeouts {
  const raw = o["timeouts"];
  if (raw === undefined || raw === null) return { ...DEFAULT_TIMEOUTS };
  if (!isObject(raw)) fail(`timeouts must be an object`);
  rejectUnknownKeys(raw, CONFIG_TIMEOUTS_KEYS, "$.timeouts");
  const read = (k: keyof Timeouts): number => {
    const v = raw[k];
    if (v === undefined || v === null) return DEFAULT_TIMEOUTS[k];
    if (!isPosInt(v)) fail(`timeouts.${k} must be a positive integer (seconds)`);
    return v as number;
  };
  return {
    controlApiSeconds: read("controlApiSeconds"),
    bulkApiSeconds: read("bulkApiSeconds"),
    cloneSeconds: read("cloneSeconds"),
    tarSeconds: read("tarSeconds"),
    probeSeconds: read("probeSeconds"),
    heartbeatSeconds: read("heartbeatSeconds"),
  };
}

function normalizePaths(o: Record<string, unknown>): { sqlitePath: string; outputDir: string } {
  const p = o["paths"];
  if (!isObject(p)) fail(`paths must be an object`);
  rejectUnknownKeys(p, CONFIG_PATHS_KEYS, "$.paths");
  const sqlitePath = reqString(p, "sqlitePath", "paths");
  const outputDir = reqString(p, "outputDir", "paths");
  // §0 WRITE CONTAINMENT: the configured storage locations must resolve under an allowed root
  // (./data or ./output relative to cwd). assertContained realpath-checks (defeats symlink escape).
  const dataRoot = resolve("./data");
  const outputRoot = resolve("./output");
  // First reject a ./data or ./output that is ITSELF a symlink escaping the workspace — else it
  // would silently move the containment boundary outside cwd.
  assertContained(dataRoot, [process.cwd()]);
  assertContained(outputRoot, [process.cwd()]);
  assertContained(sqlitePath, [dataRoot, outputRoot]);
  assertContained(outputDir, [dataRoot, outputRoot]);
  return { sqlitePath, outputDir };
}

export function validateAndNormalize(raw: unknown, env: Record<string, string | undefined>): Config {
  if (!isObject(raw)) throw new ConfigError(`config root must be a JSON object`);
  const o: Record<string, unknown> = raw;
  rejectUnknownKeys(o, CONFIG_ROOT_KEYS, "$");
  const schemaHint = o["$schema"];
  if (schemaHint !== undefined && !isString(schemaHint)) fail(`$schema must be a string (editor hint)`);

  const cutoffDate = reqString(o, "cutoffDate", "config");
  if (!DATE_RE.test(cutoffDate)) fail(`cutoffDate must be YYYY-MM-DD: ${cutoffDate}`);
  const [y, m, d] = cutoffDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
    fail(`cutoffDate is not a real calendar date: ${cutoffDate}`);

  if (!isPosInt(o["maxBranchesPerRepo"])) fail(`maxBranchesPerRepo must be a positive integer`);
  const maxBranchesPerRepo = o["maxBranchesPerRepo"] as number;

  let maxReposPerOrg: number | null = null;
  const mrpo = o["maxReposPerOrg"];
  if (mrpo !== undefined && mrpo !== null) {
    if (!isPosInt(mrpo)) fail(`maxReposPerOrg must be null (unlimited) or a positive integer`);
    maxReposPerOrg = mrpo;
  }

  return {
    githubHost: normalizeGithubHost(o),
    organizations: normalizeOrganizations(o),
    excludeOrganizations: optStringArray(o, "excludeOrganizations", []),
    includePersonalNamespace: optBool(o, "includePersonalNamespace", false),
    includeForks: optBool(o, "includeForks", false),
    includeArchived: optBool(o, "includeArchived", false),
    maxReposPerOrg,
    maxBranchesPerRepo,
    branches: normalizeBranches(o),
    excludeBranches: normalizeExcludeBranches(o),
    excludeRepositories: normalizeExcludeRepositories(o),
    cutoffDate,
    concurrency: normalizeConcurrency(o),
    timeouts: normalizeTimeouts(o),
    packages: normalizePackages(o, env),
    excludeDirGlobs: optStringArray(o, "excludeDirGlobs", DEFAULT_EXCLUDE_DIR_GLOBS),
    paths: normalizePaths(o),
  };
}

// ---- config_hash -------------------------------------------------------------------------
// Recursively sort object keys so key order in the file never changes the hash.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

// The SCAN/REPORT-DEFINING projection. Arrays whose ORDER does not change what is scanned are
// sorted/deduped so reordering the file does not churn the hash. `concurrency`, `timeouts`, and
// `paths` are DELIBERATELY excluded (speed / deadlines / storage location only), preserving
// resumability across tuning — raising a timeout never orphans in-flight resumable work.
export function computeConfigHash(config: Config): string {
  // Branch policy is scan-defining, so a CONFIGURED policy must change the hash. But a policy-FREE config
  // (branches omitted → null, excludeBranches omitted → []) scans exactly what it scanned before this
  // feature existed, so it MUST keep its original hash: the work queue is keyed by config_hash, and
  // churning the hash for every legacy config on upgrade would orphan its completed units and force a
  // full rescan (and fail its running run). Hence the policy keys are present ONLY when a policy is
  // actually configured — which also preserves null (unrestricted) hashing distinctly from [] (only the
  // default branch), since [] itself makes the policy configured.
  const hasBranchPolicy = config.branches !== null || config.excludeBranches.length > 0;
  // Repository denylist is scan-defining too, but gated INDEPENDENTLY of hasBranchPolicy and folded as
  // its OWN top-level spread — never merged into the branch-policy spread. A repo-only policy must
  // still change the hash when no branch policy is set, and (critically) an empty excludeRepositories
  // must NOT leak `excludeRepositories: []` into an existing branch-policy projection, which would
  // churn every branch-policy user's config_hash on upgrade and orphan their work_queue. The projected
  // form is the ASCII-folded sortedDedup — NOT byte-identical to the raw config value — so two configs
  // differing only in case (which scan identically) hash identically (Premise 5/7).
  const hasRepoPolicy = config.excludeRepositories.length > 0;
  const projection = {
    githubHost: config.githubHost,
    organizations: config.organizations === null ? null : sortedDedup(config.organizations),
    excludeOrganizations: sortedDedup(config.excludeOrganizations),
    includePersonalNamespace: config.includePersonalNamespace,
    includeForks: config.includeForks,
    includeArchived: config.includeArchived,
    maxReposPerOrg: config.maxReposPerOrg,
    maxBranchesPerRepo: config.maxBranchesPerRepo,
    // Reordering/duplicating patterns does not change the hash (shared canonicalizer).
    ...(hasBranchPolicy
      ? {
          branches: config.branches === null ? null : sortedDedup(config.branches),
          excludeBranches: sortedDedup(config.excludeBranches),
        }
      : {}),
    // Own spread, own gate — see hasRepoPolicy above. Case-folded (ASCII) so a cosmetic case edit is
    // hash-stable; sortedDedup so reordering/duplicating is hash-stable.
    ...(hasRepoPolicy ? { excludeRepositories: sortedDedup(config.excludeRepositories.map(toAsciiLower)) } : {}),
    cutoffDate: config.cutoffDate,
    excludeDirGlobs: sortedDedup(config.excludeDirGlobs),
    // packages sorted by name (order does not change what is scanned; names are unique)
    packages: [...config.packages]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((p) => ({ name: p.name, registryUrl: p.registryUrl, registryAuthEnvVar: p.registryAuthEnvVar })),
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(projection))).digest("hex");
}

// ---- load --------------------------------------------------------------------------------
// Path precedence: --config <path> flag > CONFIG_PATH env > ./config.json. The hash is over
// CONTENT, never the path.
export function resolveConfigPath(argv: string[], env: Record<string, string | undefined>): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") {
      const p = argv[i + 1];
      if (p === undefined || p.startsWith("-")) fail(`--config requires a path argument`);
      return p;
    }
    // support (and never silently ignore) the `--config=<path>` equals form — otherwise a
    // typo'd flag would fall through to a DIFFERENT config and mis-resume via a different hash.
    if (a.startsWith("--config=")) {
      const p = a.slice("--config=".length);
      if (p === "") fail(`--config= requires a path value`);
      return p;
    }
  }
  const fromEnv = env["CONFIG_PATH"];
  if (fromEnv !== undefined) {
    // an explicitly-set-but-empty CONFIG_PATH is a user error, NOT a silent fall-through to
    // the default (which could load a different config and mis-resume via a different hash).
    if (fromEnv === "") fail(`CONFIG_PATH is set but empty — provide a path or unset it`);
    return fromEnv;
  }
  return "./config.json";
}

export async function loadConfig(
  argv: string[] = [],
  env: Record<string, string | undefined> = process.env,
): Promise<LoadedConfig> {
  const configPath = resolveConfigPath(argv, env);
  let text: string;
  try {
    text = await Bun.file(configPath).text();
  } catch {
    return fail(`config file not found or unreadable: ${configPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`config file is not valid JSON (${configPath}): ${(e as Error).message}`);
  }
  const config = validateAndNormalize(raw, env);
  // Eagerly compile the branch policy here — the single load-time preparation boundary — so a
  // glob REJECTED AT CONSTRUCTION surfaces as a ConfigError before any run is created/resumed,
  // never mid-run.
  // (This is best-effort: Bun.Glob accepts some malformed patterns at construction; the policy
  // engine fails closed on a match-time throw. See branchPolicy.ts.)
  let branchPolicy: CompiledBranchPolicy;
  try {
    branchPolicy = compileBranchPolicy(config.branches, config.excludeBranches);
  } catch (e) {
    if (e instanceof BranchPolicyError) return fail(e.message);
    throw e;
  }
  // Same eager-at-load boundary for the repository denylist: a glob REJECTED AT CONSTRUCTION surfaces as
  // a ConfigError before any run is created/resumed, never mid-run. Best-effort (Bun.Glob accepts some
  // malformed patterns at construction); classifyRepository fails closed on a match-time throw.
  let repositoryPolicy: CompiledRepositoryPolicy;
  try {
    repositoryPolicy = compileRepositoryPolicy(config.excludeRepositories);
  } catch (e) {
    if (e instanceof RepositoryPolicyError) return fail(e.message);
    throw e;
  }
  return { config, configHash: computeConfigHash(config), configPath, branchPolicy, repositoryPolicy };
}
