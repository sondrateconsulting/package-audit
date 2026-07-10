// config.ts — load, validate, normalize the audit config and compute config_hash (§1, §2.6).
// The hash is over the SCAN/REPORT-DEFINING projection (what determines WHAT is scanned and
// reported), so tuning `concurrency` or `paths` (speed / storage location, not scanned work)
// never orphans resumable work (§3). Configured org fields participate; the DISCOVERED owner
// set never does (discovery re-runs every invocation).

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { assertContained } from "./readOnlyGuard.ts";

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

export interface Config {
  githubHost: string;
  organizations: string[] | null; // null = discover; [] = configured-empty; [..] = allowlist
  excludeOrganizations: string[];
  includePersonalNamespace: boolean;
  includeForks: boolean;
  includeArchived: boolean;
  maxReposPerOrg: number | null; // null = unlimited
  maxBranchesPerRepo: number;
  cutoffDate: string; // YYYY-MM-DD
  concurrency: Concurrency;
  packages: PackageConfig[];
  excludeDirGlobs: string[];
  paths: { sqlitePath: string; outputDir: string };
}

export interface LoadedConfig {
  config: Config;
  configHash: string;
  configPath: string;
}

const DEFAULT_GITHUB_HOST = "github.com";
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_EXCLUDE_DIR_GLOBS = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/vendor/**"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- input helpers (validate at the boundary; never trust external JSON) -----------------
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

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
function optStringArray(o: Record<string, unknown>, key: string, dflt: string[]): string[] {
  const v = o[key];
  if (v === undefined || v === null) return [...dflt];
  if (!Array.isArray(v) || !v.every(isString)) fail(`${key} must be an array of strings`);
  return v as string[];
}

// ---- unknown-key rejection (strict at every object level) ---------------------------------
// A typo'd key must fail LOUDLY: `"organization"` (missing s) would otherwise be silently
// ignored, leaving organizations=null — DISCOVERY MODE — and widening the scan to every org the
// token can see. Key sets are exported so the config.schema.json sync tests can assert the
// schema and the runtime agree. `$schema` is a root-only editor hint: allowed, type-checked,
// and excluded from config_hash (it never enters the hash projection).
export const CONFIG_ROOT_KEYS = [
  "$schema", "githubHost", "organizations", "excludeOrganizations", "includePersonalNamespace",
  "includeForks", "includeArchived", "maxReposPerOrg", "maxBranchesPerRepo", "cutoffDate",
  "concurrency", "packages", "excludeDirGlobs", "paths",
] as const;
export const CONFIG_CONCURRENCY_KEYS = ["organizations", "repositories", "branches"] as const;
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
  if (!Array.isArray(v) || !v.every(isString)) fail(`organizations must be null or an array of strings`);
  return v as string[]; // [] = configured-empty (distinct from null); [..] = allowlist
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
  if (!isObject(c)) fail(`concurrency must be an object`);
  rejectUnknownKeys(c, CONFIG_CONCURRENCY_KEYS, "$.concurrency");
  const read = (k: keyof Concurrency): number => {
    const v = (c as Record<string, unknown>)[k];
    if (!isPosInt(v)) fail(`concurrency.${k} must be a positive integer`);
    return v as number;
  };
  return { organizations: read("organizations"), repositories: read("repositories"), branches: read("branches") };
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
    cutoffDate,
    concurrency: normalizeConcurrency(o),
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

const sortedDedup = (a: string[]): string[] => [...new Set(a)].sort();

// The SCAN/REPORT-DEFINING projection. Arrays whose ORDER does not change what is scanned are
// sorted/deduped so reordering the file does not churn the hash. `concurrency` and `paths` are
// DELIBERATELY excluded (speed / storage location only), preserving resumability across tuning.
export function computeConfigHash(config: Config): string {
  const projection = {
    githubHost: config.githubHost,
    organizations: config.organizations === null ? null : sortedDedup(config.organizations),
    excludeOrganizations: sortedDedup(config.excludeOrganizations),
    includePersonalNamespace: config.includePersonalNamespace,
    includeForks: config.includeForks,
    includeArchived: config.includeArchived,
    maxReposPerOrg: config.maxReposPerOrg,
    maxBranchesPerRepo: config.maxBranchesPerRepo,
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
  return { config, configHash: computeConfigHash(config), configPath };
}
