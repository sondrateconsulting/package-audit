// preflight.ts — §2 prerequisite checks (every invocation, before any work). Pure parsers
// (version tuples, tar-flavor, OAuth-scope evidence) are exported + unit-tested; the async
// runner composes them against the gh wrapper (§4) and native fetch, failing fast with
// actionable remediation. It verifies ACCESS + SCOPE EVIDENCE only — it does NOT resolve or
// persist the effective owner list (that is §8 step 3, after preflight).

import { isCanonicalIdentity, type GithubClient } from "./github.ts";
import type { Config } from "./config.ts";
import { FETCH_TIMEOUT_MS } from "./apiSurface.ts";
import { emitProgress, hasProgressSink, nextProgressId } from "./progress.ts";

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

export type TarFlavor = "gnu" | "bsd" | "unknown";

export interface PreflightReport {
  githubLogin: string;
  tarFlavor: TarFlavor;
  discoveryScopeEvidence: "present" | "unavailable" | "not-needed";
  coreRemaining: number | null;
  graphqlRemaining: number | null;
}

// ---- pure version handling ------------------------------------------------------------------
export type Version = [number, number, number];

// Extract the FIRST dotted numeric tuple from a version string (`git version 2.45.1` →
// [2,45,1]; `1.3.14` → [1,3,14]). Missing patch defaults to 0; major and minor are REQUIRED —
// a string without at least `X.Y` (even one carrying a bare number) returns null.
export function parseVersion(text: string): Version | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? "0")];
}

// FULL-tuple >= compare (so 2.45.0 < 2.45.1 and 2.100.0 >= 2.45.1). NOT string/major-only.
export function meetsMinimum(actual: Version, minimum: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (actual[i]! > minimum[i]!) return true;
    if (actual[i]! < minimum[i]!) return false;
  }
  return true; // equal
}

// GNU tar prints "tar (GNU tar) x.y"; bsdtar prints "bsdtar x.y - libarchive …". §5.E passes
// extraction flags explicitly regardless, but the flavor is recorded for diagnostics.
export function detectTarFlavor(versionOutput: string): TarFlavor {
  const lower = versionOutput.toLowerCase();
  if (lower.includes("gnu tar")) return "gnu";
  if (lower.includes("bsdtar") || lower.includes("libarchive")) return "bsd";
  return "unknown";
}

// A classic token's `X-OAuth-Scopes` header is a comma-separated scope list; `read:org` (or the
// broader `admin:org`) proves org-discovery is possible. A fine-grained/absent header returns
// false → the caller treats scope evidence as UNAVAILABLE (not proof of absence, §2.3).
export function hasReadOrgScope(scopesHeader: string | undefined): boolean {
  if (scopesHeader === undefined) return false;
  const scopes = scopesHeader.split(",").map((s) => s.trim());
  return scopes.includes("read:org") || scopes.includes("admin:org");
}

const MIN_GIT: Version = [2, 45, 1]; // CVE-2024-32002 et al. fixed in 2.45.1 (§2.4)
const MIN_BUN: Version = [1, 1, 0]; // bun:sqlite + shell/glob features required (§2.1)

// ---- async runner ---------------------------------------------------------------------------
export interface PreflightDeps {
  bunVersion?: string; // defaults to Bun.version
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number }>;
  registryFetchTimeoutMs?: number; // registry-probe deadline (default FETCH_TIMEOUT_MS)
  env?: Record<string, string | undefined>;
}

export async function runPreflight(client: GithubClient, config: Config, deps: PreflightDeps = {}): Promise<PreflightReport> {
  const env = deps.env ?? process.env;

  // 1. bun >= 1.1
  const bunVer = parseVersion(deps.bunVersion ?? Bun.version);
  if (bunVer === null || !meetsMinimum(bunVer, MIN_BUN))
    throw new PreflightError(`bun >= 1.1 required (found ${deps.bunVersion ?? Bun.version})`);

  // 2. gh --version succeeds
  const ghVer = await client.gh(["--version"]);
  if (ghVer.exitCode !== 0) throw new PreflightError(`gh --version failed: ${ghVer.stderr.trim().slice(0, 200)}`);

  // 3. gh auth status (authenticated, read-capable)
  const auth = await client.gh(["auth", "status", "--hostname", config.githubHost]);
  if (auth.exitCode !== 0)
    throw new PreflightError(
      `not authenticated to ${config.githubHost}. Remediate: gh auth login -h ${config.githubHost} (see README § What the gh token needs)\n${auth.stderr.trim().slice(0, 300)}`,
    );

  // 4. git >= 2.45.1 and tar present (+ flavor)
  const gitVer = await client.git(["--version"]);
  const gv = parseVersion(gitVer.stdout);
  if (gitVer.exitCode !== 0 || gv === null || !meetsMinimum(gv, MIN_GIT))
    throw new PreflightError(
      `git >= 2.45.1 required (found '${gitVer.stdout.trim()}') — older releases carry the May-2024 clone CVEs. Remediate: brew upgrade git (macOS) / apt-get install --only-upgrade git (Debian/Ubuntu)`,
    );
  const tarVer = await client.tar(["--version"]);
  if (tarVer.exitCode !== 0) throw new PreflightError(`tar --version failed: ${tarVer.stderr.trim().slice(0, 200)}`);
  const tarFlavor = detectTarFlavor(tarVer.stdout);
  // §5.E: the pre-extraction scan's resync/secure-symlink reasoning only holds for GNU tar and
  // bsdtar/libarchive. A tar that is neither (e.g. busybox/toybox) could materialize a member the
  // scan believed it rejected, so fail closed rather than extract with an unvetted implementation.
  if (tarFlavor === "unknown")
    throw new PreflightError(
      `unsupported tar implementation (found '${tarVer.stdout.trim().slice(0, 80)}') — the §5.E pre-extraction scan requires GNU tar or bsdtar/libarchive. Remediate: install GNU tar or bsdtar (libarchive) and ensure it is first on PATH`,
    );

  // 5. discovery scope evidence (only in discovery mode) + capture login
  const userRes = await client.restGet("user");
  let parsedUser: unknown;
  try {
    parsedUser = JSON.parse(userRes.body);
  } catch {
    throw new PreflightError("could not parse `gh api user` response");
  }
  // Validate, don't String()-coerce: a non-string login (e.g. {login:42}) previously became the
  // fabricated login "42", and this PR feeds this value to listUserRepos(owner) as the personal-scan
  // owner authority. Require a non-array object carrying a non-empty string login; fail loud otherwise.
  const rawLogin =
    typeof parsedUser === "object" && parsedUser !== null && !Array.isArray(parsedUser)
      ? (parsedUser as Record<string, unknown>)["login"]
      : undefined;
  if (typeof rawLogin !== "string" || rawLogin === "")
    throw new PreflightError("`gh api user` returned no valid login (expected a non-empty string)");
  // The login becomes an effective scan owner (ownerResolve). Reject a non-canonical value (dot
  // segment / separator / control / whitespace) at the source: it would otherwise flow in as a
  // fabricated authority, and an empty user/repos listing would then produce a SILENT zero-repo run
  // rather than a loud failure. Same isCanonicalIdentity guard mapRestRepo/listOrgMemberships apply.
  if (!isCanonicalIdentity(rawLogin))
    throw new PreflightError("`gh api user` returned a non-canonical login — refusing to use it as a scan owner");
  const login = rawLogin;
  const discoveryMode = config.organizations === null;
  let scopeEvidence: PreflightReport["discoveryScopeEvidence"] = "not-needed";
  if (discoveryMode) {
    scopeEvidence = hasReadOrgScope(userRes.headers["x-oauth-scopes"]) ? "present" : "unavailable";
    // 'unavailable' is NOT fatal here (§2.3): a fine-grained token can still discover; the
    // empty-effective-list fail-fast fires in §8 step 3 if discovery truly yields nothing.
  }

  // 6. config already validated by config.ts; re-assert every configured registryAuthEnvVar is SET
  for (const pkg of config.packages) {
    if (pkg.registryAuthEnvVar !== null) {
      const val = env[pkg.registryAuthEnvVar];
      if (val === undefined || val === "")
        throw new PreflightError(`registryAuthEnvVar '${pkg.registryAuthEnvVar}' for ${pkg.name} is not set`);
    }
  }

  // 7. gh api rate_limit (network reachability + record quotas)
  let coreRemaining: number | null = null;
  let graphqlRemaining: number | null = null;
  try {
    const rl = (await client.rateLimit()) as { resources?: { core?: { remaining?: number }; graphql?: { remaining?: number } } };
    coreRemaining = rl.resources?.core?.remaining ?? null;
    graphqlRemaining = rl.resources?.graphql?.remaining ?? null;
  } catch (e) {
    throw new PreflightError(`gh api rate_limit failed (network to ${config.githubHost}?): ${(e as Error).message}`);
  }

  // 8. registry reachability (runs LAST, after the gh checks) — ANY HTTP response counts
  // (private registries may 401 a probe); only DNS/TLS/connect failures are fatal.
  const fetchImpl = deps.fetchImpl ?? (async (url: string) => {
    // deadline: a wedged registry must fail the probe, not hang preflight (§5.E hardening)
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(deps.registryFetchTimeoutMs ?? FETCH_TIMEOUT_MS) });
    return { ok: res.ok, status: res.status };
  });
  for (const registryUrl of new Set(config.packages.map((p) => p.registryUrl))) {
    // The §2.5 reachability probe is the ONE registry call outside apiSurface — it gets the same
    // fetch span (PROMPT-TUI §U3.5). Label: never the URL (the registry may be private).
    let spanId = 0;
    if (hasProgressSink()) {
      spanId = nextProgressId();
      emitProgress({ type: "fetch-start", id: spanId, kind: "registry-probe", label: "registry probe" });
    }
    try {
      await fetchImpl(registryUrl);
    } catch (e) {
      throw new PreflightError(`registry ${registryUrl} unreachable (DNS/TLS/connect): ${(e as Error).message}`);
    } finally {
      if (spanId !== 0) emitProgress({ type: "fetch-end", id: spanId });
    }
  }

  return { githubLogin: login, tarFlavor, discoveryScopeEvidence: scopeEvidence, coreRemaining, graphqlRemaining };
}
