// github.ts — the ONLY module that spawns gh/git/tar (§6 single chokepoint; grep-enforced by
// tests). Every spawn passes the matching readOnlyGuard assert on the argv ARRAY first, runs
// with a sanitized allowlist env, and every write target (clone dest, tar -C dir, gitconfig)
// is assertContained before the process starts (§0). Handles TS pagination via per-page
// `gh api -i` header parsing, the §4 rate-limit classes, api_cache integration (§3), the
// hardened clone fallback (§0/§5.C), and the startup pkg-audit-* temp sweep.

import { mkdtempSync, readdirSync, lstatSync, rmSync, unlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, devNull } from "node:os";
import { join } from "node:path";
import {
  assertReadOnlyGh, assertReadOnlyGit, assertReadOnlyTar, assertSpawnAllowed, assertContained,
} from "./readOnlyGuard.ts";
import type { AuditDb } from "./db.ts";

// ---- errors -----------------------------------------------------------------------------
// Non-retryable API failure (404, permission, SSO enforcement, poisoned redirect, …) — the
// orchestrator records an errors row for it.
export class GithubApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly ssoRequired: boolean;
  constructor(message: string, opts: { status?: number; endpoint?: string; ssoRequired?: boolean } = {}) {
    super(message);
    this.name = "GithubApiError";
    this.status = opts.status ?? 0;
    this.endpoint = opts.endpoint ?? "";
    this.ssoRequired = opts.ssoRequired ?? false;
  }
}
// Retryable throttle that outlived the wrapper's internal wait+retry budget (§4). The wrapper
// either slept through every window it was told about (attempt budget exhausted) or refused
// to start a sleep that would blow the client-lifetime cumulative pause budget (early escape
// from waitBucket). Either way the orchestrator treats it as TRANSIENT and defers to the
// NEXT invocation instead of recording a permanent failure:
// a mid-scan exhaustion resets that unit to `pending` with NO errors row (the §3 skip
// predicate only skips `done` units, so a later run retries it); a repo/branch discovery
// exhaustion logs a JSONL requeue event only (discovery re-runs every invocation anyway);
// and an owner-resolution exhaustion ends the run cleanly WITHOUT starting one (no phantom
// run row). --plan, which has no DB, instead counts a repo/branch discovery escape into its
// failure totals (a plan-mode OWNER-discovery escape stays fatal — plan mode has nothing to
// requeue into). Only NON-throttle errors at those sites are recorded or fatal — the
// remediation here is time, then re-run.
export class ThrottleExhausted extends Error {
  readonly endpoint: string;
  constructor(endpoint: string) {
    super(
      `rate-limit throttling persisted beyond the retry/pause budget for ${endpoint} — wait for the rate-limit window to reset, then re-run; a resumed run skips already-completed units`,
    );
    this.name = "ThrottleExhausted";
    this.endpoint = endpoint;
  }
}

// ---- spawn layer ------------------------------------------------------------------------
export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
// Minimal lib.dom-free abort plumbing (the tsconfig lib is ESNext-only, so the platform
// AbortSignal instance type is memberless here): the client flips it on deadline expiry and
// the spawn impl registers the child-kill. onAbort fires immediately if already aborted.
export interface SpawnAbortSignal {
  readonly aborted: boolean;
  onAbort(cb: () => void): void;
}
export type SpawnFn = (
  bin: string,
  args: string[],
  // `signal` aborts when the caller's wall-clock deadline expires — the impl must kill the child.
  opts: { env: Record<string, string>; cwd?: string; signal?: SpawnAbortSignal },
) => Promise<SpawnResult>;

const MAX_SPAWN_OUTPUT_BYTES = 110 * 1024 * 1024; // raw contents cap is 100 MB (§5.C) + slack
// §4 hardening: SIGTERM is refusable — a signal-trapping/wedged child, or a descendant that
// inherited the pipes, must not orphan the read loop or pin the event loop. This grace period
// after the deadline's SIGTERM ends in SIGKILL, a best-effort process-group kill (the spawn
// primitive cannot create a new group, so -pid only lands when the child leads one), reader
// cancellation, and an unref of the handle so an abandoned loser can never hold the loop.
export const SPAWN_KILL_GRACE_MS = 2_000;

// structural (not the DOM/Bun-specific reader): the Bun subprocess reader is a superset, so a
// minimal read/cancel shape accepts it without dragging in lib.dom's incompatible declaration.
// EXPORTED (with readCapped) for the byte-cap unit tests; realSpawn is the only runtime caller.
export interface StreamReader {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

// Stream-read with a BYTE cap enforced per chunk — the process is killed the moment the cap
// is crossed, so an oversized response can never be fully buffered first. Takes the READER
// (not the stream) so the kill-escalation path can cancel it from outside.
export async function readCapped(reader: StreamReader, cap: number, onExceed: () => void): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) {
      total += value.byteLength;
      if (total > cap) {
        onExceed();
        throw new GithubApiError(`spawn output exceeds ${cap} bytes`, {});
      }
      chunks.push(value);
    }
    if (done) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Factory so the byte cap is injectable for tests (shipping 110MB through a real child to
// exercise the cap would be pure test tax); realSpawn — the production SpawnFn — is
// makeRealSpawn(MAX_SPAWN_OUTPUT_BYTES).
export function makeRealSpawn(cap: number): SpawnFn {
  return async (bin, args, opts) => {
    const proc = Bun.spawn({
      cmd: [bin, ...args],
      env: opts.env,
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const outReader = proc.stdout.getReader();
    const errReader = proc.stderr.getReader();
    const kill = (): void => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
      // Escalation fires UNCONDITIONALLY after the grace (all steps are no-ops on a clean
      // exit): SIGKILL cannot be trapped, and cancelling the readers unblocks readCapped even
      // when a surviving grandchild still holds the inherited pipes open.
      const escalate = setTimeout(() => {
        try {
          proc.kill(9); // SIGKILL
        } catch {
          // already exited
        }
        try {
          process.kill(-proc.pid, 9); // group kill, when the child leads a group
        } catch {
          // not a group leader / already gone
        }
        outReader.cancel().catch(() => {});
        errReader.cancel().catch(() => {});
        proc.unref();
      }, SPAWN_KILL_GRACE_MS);
      escalate.unref?.();
    };
    opts.signal?.onAbort(kill);
    return joinSpawnOutcome(
      readCapped(outReader, cap, kill),
      readCapped(errReader, cap, kill),
      proc.exited,
    );
  };
}

// Merge the two reader outcomes with the child's exit — NOT fail-fast: a byte-cap rejection
// fires kill() while the child is still dying, and callers treat the spawn promise's
// settlement as "the child is gone" (they may delete its working directory immediately).
// Capture the TEMPORALLY FIRST reader error as it lands (a later, secondary failure must not
// replace the original diagnostic), hold every outcome until the exit promise has resolved,
// THEN rethrow it. NOTE the direct child's exit is the strongest guarantee available: a
// descendant that survives the best-effort group kill could in principle still write
// afterwards — that residue is the startup sweep's job. EXPORTED for tests: deterministic
// two-failure ordering needs injected promises (a real child cannot produce two
// distinguishable reader errors on demand).
export async function joinSpawnOutcome(
  stdoutP: Promise<string>,
  stderrP: Promise<string>,
  exited: Promise<number>,
): Promise<SpawnResult> {
  let firstErr: unknown;
  let failed = false;
  const capture = (p: Promise<string>): Promise<string> =>
    p.catch((e: unknown) => {
      if (!failed) {
        failed = true;
        firstErr = e;
      }
      return "";
    });
  const [stdout, stderr, exitCode] = await Promise.all([capture(stdoutP), capture(stderrP), exited]);
  if (failed) throw firstErr;
  return { exitCode, stdout, stderr };
}
const realSpawn: SpawnFn = makeRealSpawn(MAX_SPAWN_OUTPUT_BYTES);

// ---- sanitized env (allowlist construction — dropped vars are simply never copied) --------
type Env = Record<string, string | undefined>;
// Auth-bearing/benign passthroughs. GH_CONFIG_DIR/XDG_CONFIG_HOME stay because the user's gh
// auth state may live there — preflight `gh auth status` runs under this SAME env, so auth
// that works at preflight keeps working. Git config is NOT reachable from these: git's config
// is pinned separately below.
// No TMPDIR (an inherited value could redirect child scratch writes outside the contained
// roots) and no USER/LOGNAME (unneeded) — children fall back to the OS default temp.
const GH_PASSTHROUGH = [
  "HOME", "PATH",
  "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
  "GH_CONFIG_DIR", "XDG_CONFIG_HOME",
] as const;
// git's env ALSO carries the gh auth passthroughs: the pinned credential helper runs
// `gh auth git-credential` as a child of git, so token/config-dir auth must survive.
const GIT_PASSTHROUGH = [
  "HOME", "PATH",
  "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
  "GH_CONFIG_DIR", "XDG_CONFIG_HOME",
] as const;
const TAR_PASSTHROUGH = ["HOME", "PATH"] as const;

export function buildGhEnv(base: Env, githubHost: string): Record<string, string> {
  const out: Record<string, string> = {
    GH_HOST: githubHost, // every gh call runs under the configured host (§1); no call site drifts
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
    TERM: "dumb",
    GIT_TERMINAL_PROMPT: "0", // gh shells out to git for some ops
  };
  for (const k of GH_PASSTHROUGH) if (base[k] !== undefined && base[k] !== "") out[k] = base[k]!;
  return out;
}

// git runs with ALL config pinned: GIT_CONFIG_SYSTEM→/dev/null and GIT_CONFIG_GLOBAL→our
// generated file, so a hostile ~/.gitconfig (url.insteadOf, credential.helper, core.fsmonitor,
// includes) can never inject into the hardened clone. Auth comes from the pinned credential
// helper (`gh auth git-credential`) written into that generated config.
export function buildGitEnv(base: Env, gitConfigPath: string): Record<string, string> {
  const out: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_ALLOW_PROTOCOL: "https", // insteadOf can't smuggle ssh/file even if config slipped
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    TERM: "dumb",
  };
  for (const k of GIT_PASSTHROUGH) if (base[k] !== undefined && base[k] !== "") out[k] = base[k]!;
  return out;
}

export function buildTarEnv(base: Env): Record<string, string> {
  const out: Record<string, string> = { NO_COLOR: "1", TERM: "dumb" }; // TAR_OPTIONS/TAPE never copied
  for (const k of TAR_PASSTHROUGH) if (base[k] !== undefined && base[k] !== "") out[k] = base[k]!;
  return out;
}

// ---- gh api -i parsing (pure) --------------------------------------------------------------
export interface HttpResponse {
  status: number;
  headers: Record<string, string>; // lowercased keys; duplicates joined with ", "
  body: string;
}

const STATUS_LINE_RE = /^HTTP\/[\d.]+ (\d{3})/;

// Parse ONE header block (status line + headers up to the first blank line), then treat the
// rest as body. gh's transport follows redirects internally, but if a 1xx/3xx block IS printed
// and the remainder starts with another status line, parse again — a 2xx body is never
// re-parsed, so raw file content beginning with "HTTP/…" cannot be eaten as headers.
export function parseGhApiOutput(stdout: string): HttpResponse {
  let rest = stdout;
  let status = 0;
  let headers: Record<string, string> = {};
  for (;;) {
    const m = STATUS_LINE_RE.exec(rest);
    if (!m || !rest.startsWith("HTTP/")) break;
    const lf = rest.indexOf("\n\n");
    const crlf = rest.indexOf("\r\n\r\n");
    let sepStart: number;
    let sepLen: number;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) {
      sepStart = crlf;
      sepLen = 4;
    } else if (lf !== -1) {
      sepStart = lf;
      sepLen = 2;
    } else {
      sepStart = rest.length; // headers only, no body (e.g. 304)
      sepLen = 0;
    }
    const head = rest.slice(0, sepStart);
    rest = rest.slice(sepStart + sepLen);
    status = Number(m[1]);
    headers = {};
    for (const line of head.split(/\r?\n/).slice(1)) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
    }
    const continueParsing = (status >= 100 && status < 200) || (status >= 300 && status < 400);
    if (!continueParsing || !STATUS_LINE_RE.test(rest)) break;
  }
  return { status, headers, body: rest };
}

// RFC 8288-ish Link parsing via a small state machine: link-values are separated by commas
// that sit OUTSIDE quoted strings and outside <...> URL sections (a naive lookahead split is
// defeated by a quoted param like title="x, <https://…>"). Returns the URL whose rel token
// list contains "next".
export function parseLinkNext(link: string | undefined): string | null {
  if (link === undefined || link === "") return null;
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let inAngle = false;
  let escaped = false;
  for (const ch of link) {
    if (inQuote) {
      current += ch;
      if (escaped) escaped = false; // this char was escaped — never a delimiter
      else if (ch === "\\") escaped = true; // RFC quoted-pair: next char is literal
      else if (ch === '"') inQuote = false;
    } else if (inAngle) {
      current += ch;
      if (ch === ">") inAngle = false;
    } else if (ch === '"') {
      current += ch;
      inQuote = true;
    } else if (ch === "<") {
      current += ch;
      inAngle = true;
    } else if (ch === ",") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  for (const part of parts) {
    const m = /^<([^>]*)>(.*)$/s.exec(part.trim());
    if (!m) continue;
    // Split the trailing params on ';' OUTSIDE quotes so a quoted value like title="; rel=next"
    // cannot spoof the rel parameter; only an actual `rel=` param whose token list contains
    // "next" qualifies.
    for (const param of splitOutsideQuotes(m[2]!, ";")) {
      const rel = /^\s*rel\s*=\s*(.*)$/i.exec(param);
      if (!rel) continue;
      const value = rel[1]!.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      if (value.split(/\s+/).includes("next")) return m[1]!;
    }
  }
  return null;
}

// Split `s` on `delim` occurrences that sit OUTSIDE single/double-quoted strings (RFC
// quoted-pair aware for double quotes). Used for Link parameter separation.
function splitOutsideQuotes(s: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const ch of s) {
    if (inDouble) {
      cur += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
    } else if (inSingle) {
      cur += ch;
      if (ch === "'") inSingle = false;
    } else if (ch === '"') {
      cur += ch;
      inDouble = true;
    } else if (ch === "'") {
      cur += ch;
      inSingle = true;
    } else if (ch === delim) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// The guard only accepts relative endpoints, so a Link URL is VERIFIED against the configured
// host and recomposed into a relative endpoint. github.com API Links ONLY ever come from
// api.github.com — a Link pointing at github.com itself is rejected, not followed. GHES
// requires the EXACT configured host (incl. port) or its api. subdomain (subdomain isolation),
// with the /api/v3 path prefix stripped. A mismatched host is a poisoned redirect — throw.
export function nextEndpointFromLink(linkUrl: string, githubHost: string): string {
  let url: URL;
  try {
    url = new URL(linkUrl);
  } catch {
    throw new GithubApiError(`unparseable Link next URL: ${linkUrl}`, { endpoint: linkUrl });
  }
  if (url.protocol !== "https:")
    throw new GithubApiError(`Link next URL is not https: ${linkUrl}`, { endpoint: linkUrl });
  let allowed: boolean;
  if (githubHost === "github.com") {
    allowed = url.host === "api.github.com";
  } else {
    allowed = url.host === githubHost || url.host === `api.${githubHost}`;
  }
  if (!allowed)
    throw new GithubApiError(`Link next URL host ${url.host} does not match ${githubHost}`, { endpoint: linkUrl });
  let path = url.pathname.replace(/^\//, "");
  // the /api/v3 prefix only exists on GHES; dotcom never emits it
  if (githubHost !== "github.com" && path.startsWith("api/v3/")) path = path.slice("api/v3/".length);
  return `${path}${url.search}`;
}

// Hard ceiling on a Link rel="next" chain (§5.A): 1000 pages × per_page=100 = 100k rows,
// far beyond any real listing. Bounds the requests/memory a poisoned Link chain can drive.
export const MAX_PAGES = 1000;

// ---- §4 throttle classification (pure) -----------------------------------------------------
export type Classification =
  | { kind: "ok" }
  | { kind: "primary"; untilMs: number } // wait until the x-ratelimit-reset epoch
  | { kind: "secondary"; waitMs: number | null } // Retry-After if present, else caller backoff
  | { kind: "transient" } // 5xx / spawn-level network failure — bounded backoff retry
  | { kind: "fatal"; status: number; ssoRequired: boolean; message: string };

const CLOCK_SKEW_MS = 5_000;
// §4 hardening: reset/Retry-After are RESPONSE-controlled, so a poisoned header must not
// command an unbounded pause (real GitHub resets are <= 1h). Every throttle wait is clamped
// here at classification; the attempt loops stay bounded by MAX_ATTEMPTS, so the worst case
// per call is MAX_ATTEMPTS clamped pauses.
export const MAX_PAUSE_MS = 2 * 60 * 60 * 1000;
const clampPauseMs = (ms: number | null): number | null =>
  ms === null ? null : Math.min(ms, MAX_PAUSE_MS);
// MAX_PAUSE_MS bounds ONE sleep; this bounds the TOTAL a bucket may sleep per client
// lifetime — otherwise poison-then-succeed responses keep every call "succeeding" at
// 5 clamped naps per page, ~417 days across one MAX_PAGES listing. Once spent, further
// pending pauses fail as ThrottleExhausted instead of sleeping.
export const MAX_TOTAL_PAUSE_MS = 8 * 60 * 60 * 1000;

export function parseRetryAfterMs(value: string | undefined, nowMs: number): number | null {
  if (value === undefined || value === "") return null;
  // the numeric form gets the same 1s floor as the HTTP-date form: Retry-After: 0 must
  // not turn into a zero-length sleep + immediate retry.
  if (/^\d+$/.test(value.trim())) return Math.max(1000, Number(value.trim()) * 1000);
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) return Math.max(1000, asDate - nowMs);
  return null;
}

// Secondary/abuse 403s carry a documented message; a PERMISSION 403 does not — and §4 makes
// permission/SSO/404 NON-retryable. So a 403 with nonzero remaining is secondary ONLY on
// positive evidence (Retry-After header or the documented abuse wording); otherwise fatal.
const SECONDARY_BODY_RE = /secondary rate limit|abuse detection|abuse rate limit/i;

// Shared §4 PRIMARY-window computation (REST + GraphQL): reset epoch + skew, floored at
// nowMs+1s, clamped at nowMs+MAX_PAUSE_MS. ONE site, so the four embedded constants
// (CLOCK_SKEW_MS, the 60s no-header fallback, the 1s floor, MAX_PAUSE_MS) can never
// silently desync between the two classifiers.
function primaryUntilMs(headers: Record<string, string>, nowMs: number): number {
  const resetSec = Number(headers["x-ratelimit-reset"] ?? "0");
  const untilMs = Number.isFinite(resetSec) && resetSec > 0 ? resetSec * 1000 + CLOCK_SKEW_MS : nowMs + 60_000;
  return Math.min(Math.max(untilMs, nowMs + 1000), nowMs + MAX_PAUSE_MS);
}
// Retry-After, parsed then clamped — the §4 secondary-throttle wait wherever it appears.
const retryAfterClampedMs = (headers: Record<string, string>, nowMs: number): number | null =>
  clampPauseMs(parseRetryAfterMs(headers["retry-after"], nowMs));

export function classifyRest(
  status: number,
  headers: Record<string, string>,
  body: string,
  nowMs: number,
): Classification {
  if (status >= 200 && status < 300) return { kind: "ok" };
  if (status === 403 || status === 429) {
    // PRIMARY is keyed on remaining==0, NOT the status code (§4). Checking it BEFORE the SSO
    // header is safe: a genuine SSO/permission 403 is not consuming the last request of the
    // window, so it arrives with nonzero remaining and falls through to the fatal branches.
    if (headers["x-ratelimit-remaining"] === "0")
      return { kind: "primary", untilMs: primaryUntilMs(headers, nowMs) };
    if (headers["x-github-sso"] !== undefined)
      return { kind: "fatal", status, ssoRequired: true, message: "SSO authorization required (x-github-sso). Remediate: gh auth refresh (see README § Authentication)" };
    const retryAfter = retryAfterClampedMs(headers, nowMs);
    if (retryAfter !== null) return { kind: "secondary", waitMs: retryAfter };
    if (status === 429 || SECONDARY_BODY_RE.test(body)) return { kind: "secondary", waitMs: null };
    return { kind: "fatal", status, ssoRequired: false, message: `HTTP ${status} (permission/forbidden)` };
  }
  if (status >= 500) return { kind: "transient" };
  return { kind: "fatal", status, ssoRequired: false, message: `HTTP ${status}` };
}

interface GraphqlErrorEntry {
  type?: string;
  message?: string;
}
export function classifyGraphql(
  status: number,
  headers: Record<string, string>,
  bodyErrors: GraphqlErrorEntry[],
  nowMs: number,
): Classification {
  const primaryFromHeaders = (): Classification => ({ kind: "primary", untilMs: primaryUntilMs(headers, nowMs) });
  // SSO enforcement is ALWAYS fatal, never a retryable throttle — short-circuit on an error
  // status BEFORE the RATE_LIMITED body branch, so even a (hypothetical) 403 carrying both an
  // x-github-sso header and a RATE_LIMITED body stays fatal.
  if ((status === 403 || status === 429) && headers["x-github-sso"] !== undefined)
    return { kind: "fatal", status, ssoRequired: true, message: "SSO authorization required (x-github-sso). Remediate: gh auth refresh (see README § Authentication)" };
  // §4: GraphQL PRIMARY exhaustion is keyed on the BODY error (arrives as HTTP 200 with
  // errors[].type == 'RATE_LIMITED' and remaining 0) — never on the status code alone.
  const rateLimited = bodyErrors.some((e) => e.type === "RATE_LIMITED");
  if (rateLimited) {
    if (headers["x-ratelimit-remaining"] === "0") return primaryFromHeaders();
    return { kind: "secondary", waitMs: retryAfterClampedMs(headers, nowMs) };
  }
  if (status === 403 || status === 429) {
    // §4's GraphQL 403 disambiguation (SSO already handled above): a documented permission
    // failure is fatal; a genuine window exhaustion (remaining==0) is PRIMARY and must be
    // detected BEFORE the generic 429→secondary fallback.
    const text = bodyErrors.map((e) => e.message ?? "").join(" ");
    if (/permission|not accessible|forbidden/i.test(text) && headers["retry-after"] === undefined)
      return { kind: "fatal", status, ssoRequired: false, message: text };
    if (headers["x-ratelimit-remaining"] === "0") return primaryFromHeaders();
    if (headers["retry-after"] !== undefined || SECONDARY_BODY_RE.test(text) || status === 429)
      return { kind: "secondary", waitMs: retryAfterClampedMs(headers, nowMs) };
    return { kind: "fatal", status, ssoRequired: false, message: text || `HTTP ${status}` };
  }
  if (status >= 500) return { kind: "transient" };
  if (status >= 200 && status < 300) {
    if (bodyErrors.length > 0) {
      const text = bodyErrors.map((e) => `${e.type ?? "ERROR"}: ${e.message ?? ""}`).join("; ");
      return { kind: "fatal", status, ssoRequired: false, message: text };
    }
    return { kind: "ok" };
  }
  return { kind: "fatal", status, ssoRequired: false, message: `HTTP ${status}` };
}

// ---- §5.C path encoding (pure) --------------------------------------------------------------
// encodeURIComponent per PATH SEGMENT, preserving '/' — matches the permalink builder's rule.
export function encodeContentsPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// ---- §5.A repo shaping (pure) ---------------------------------------------------------------
export interface RepoInfo {
  name: string;
  organization: string;
  defaultBranch: string;
  pushedAt: string | null;
  archived: boolean;
  fork: boolean;
  isPrivate: boolean;
}
export function mapRestRepo(raw: Record<string, unknown>): RepoInfo {
  const owner = raw["owner"] as Record<string, unknown> | undefined;
  return {
    name: String(raw["name"] ?? ""),
    organization: String(owner?.["login"] ?? ""),
    defaultBranch: String(raw["default_branch"] ?? ""),
    pushedAt: typeof raw["pushed_at"] === "string" ? raw["pushed_at"] : null,
    archived: raw["archived"] === true,
    fork: raw["fork"] === true,
    isPrivate: raw["private"] === true,
  };
}
// Client-side policy (§5.A): archived/fork filtering never trusts a server-side filter, then
// sort pushed_at DESC (nulls last, name ASC tie-break) and cap at maxReposPerOrg.
export function filterSortCapRepos(
  repos: RepoInfo[],
  opts: { includeArchived: boolean; includeForks: boolean; maxReposPerOrg: number | null },
): RepoInfo[] {
  const filtered = repos.filter(
    (r) => (opts.includeArchived || !r.archived) && (opts.includeForks || !r.fork),
  );
  const sorted = [...filtered].sort((a, b) => {
    if (a.pushedAt === null && b.pushedAt === null) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    if (a.pushedAt === null) return 1;
    if (b.pushedAt === null) return -1;
    if (a.pushedAt !== b.pushedAt) return a.pushedAt < b.pushedAt ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return opts.maxReposPerOrg === null ? sorted : sorted.slice(0, opts.maxReposPerOrg);
}

export interface BranchHead {
  name: string;
  oid: string;
  committedDate: string;
  treeOid: string;
}

// ---- semaphore ------------------------------------------------------------------------------
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  constructor(n: number) {
    this.available = n;
  }
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    };
  }
}

// ---- client ---------------------------------------------------------------------------------
// Resolve a binary against the SAME env the children are spawned with, so an injected PATH
// (e.g. the entrypoint tests' offline shim dir) governs resolution too. Bare Bun.which reads
// the process's INITIAL environ and ignores runtime PATH changes, which would silently reach
// past an injected env to the machine's real binaries.
function whichIn(env: Env, bin: string): string {
  const path = env["PATH"];
  return (path !== undefined ? Bun.which(bin, { PATH: path }) : Bun.which(bin)) ?? bin;
}

const RAW_ACCEPT = "application/vnd.github.raw+json";
const MAX_ATTEMPTS = 6;
const SECONDARY_BASE_WAIT_MS = 60_000; // §4: no Retry-After → wait at LEAST 60s, then backoff
const TRANSIENT_BASE_WAIT_MS = 2_000;
// §4 hardening: a poisoned endpoint can hang by PACING the response (trickling bytes) instead
// of via headers — no byte cap or pause clamp fires when nothing arrives. Every spawn gets a
// wall-clock kill deadline, generous enough for a large shallow clone or tarball extract. On
// expiry the child is killed and the empty result flows into the transient retry path.
export const SPAWN_TIMEOUT_MS = 15 * 60 * 1000;

export interface GithubClientOptions {
  githubHost: string;
  db?: AuditDb | null; // api_cache home; null disables caching
  concurrency?: number; // GLOBAL in-flight gh cap (§4)
  spawnImpl?: SpawnFn;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
  spawnTimeoutMs?: number; // wall-clock kill deadline per spawn (default SPAWN_TIMEOUT_MS)
  env?: Env;
  binPaths?: { gh: string; git: string; tar: string };
  tempRoot?: string; // default realpath(os.tmpdir()); pkg-audit-* dirs live directly under it
}

interface Bucket {
  label: string;
  pausedUntilMs: number;
  totalPausedMs: number; // cumulative slept-for-throttle ms, capped by MAX_TOTAL_PAUSE_MS
}

export class GithubClient {
  readonly githubHost: string;
  readonly tempRoot: string;
  private readonly db: AuditDb | null;
  private readonly spawn: SpawnFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly spawnTimeoutMs: number;
  private readonly bins: { gh: string; git: string; tar: string };
  private readonly ghEnv: Record<string, string>;
  private readonly baseEnv: Env;
  private readonly sem: Semaphore;
  private readonly core: Bucket = { label: "core", pausedUntilMs: 0, totalPausedMs: 0 };
  private readonly graphqlBucket: Bucket = { label: "graphql", pausedUntilMs: 0, totalPausedMs: 0 };
  private gitConfigPath: string | null = null;

  // Observable cache-role: --plan's zero-write contract requires a cache-less client (db: null),
  // and runPlan guards on this rather than trusting its caller's construction.
  get cachesToDb(): boolean {
    return this.db !== null;
  }

  constructor(opts: GithubClientOptions) {
    this.githubHost = opts.githubHost;
    this.db = opts.db ?? null;
    this.spawn = opts.spawnImpl ?? realSpawn;
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.nowImpl ?? Date.now;
    this.spawnTimeoutMs = opts.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS;
    // fail-fast knob validation: 0/negative here does NOT mean "unlimited" — a zero-slot
    // semaphore hangs the first acquire forever (no exception, and the spawn deadline never
    // covers semaphore queueing), and a nonpositive deadline instantly expires every spawn.
    if (this.spawnTimeoutMs < 1)
      throw new Error(`spawnTimeoutMs must be >= 1 (got ${this.spawnTimeoutMs}) — a nonpositive deadline instantly times out every spawn`);
    const concurrency = opts.concurrency ?? 8;
    if (concurrency < 1)
      throw new Error(`concurrency must be >= 1 (got ${concurrency}) — a zero-slot semaphore hangs the first acquire forever`);
    this.baseEnv = opts.env ?? process.env;
    this.bins = opts.binPaths ?? {
      gh: whichIn(this.baseEnv, "gh"),
      git: whichIn(this.baseEnv, "git"),
      tar: whichIn(this.baseEnv, "tar"),
    };
    this.ghEnv = buildGhEnv(this.baseEnv, this.githubHost);
    this.sem = new Semaphore(concurrency);
    this.tempRoot = opts.tempRoot ?? realpathSync(tmpdir());
  }

  // Race a spawn against the wall-clock deadline. A REAL timer (never the injectable fake
  // clock — sleepImpl would resolve instantly under tests and expire every spawn) aborts the
  // signal, so the impl kills the child, and yields an EMPTY-stdout nonzero result that the
  // callers' existing no-HTTP-response transient path retries under MAX_ATTEMPTS. After the
  // deadline fires, the return additionally WAITS for the spawned promise to settle — callers
  // (cloneShallow, introspectVersion) delete the child's working directory the moment this
  // returns, and a SIGTERMed-but-not-yet-dead child could still be writing into that tree.
  // The wait is BOUNDED by the kill-escalation grace + margin so an impl that never settles
  // (or a wedged kill) cannot convert the deadline into a hang — on a timeout the caller's
  // semaphore slot is held up to that long extra, the deliberate price of race-free cleanup.
  // The loser promise gets a no-op catch so a late rejection (e.g. the byte cap) is never
  // unhandled.
  private async spawnBounded(
    bin: string,
    args: string[],
    opts: { env: Record<string, string>; cwd?: string },
  ): Promise<SpawnResult> {
    let aborted = false;
    const killers: Array<() => void> = [];
    const signal: SpawnAbortSignal = {
      get aborted() { return aborted; },
      onAbort(cb) { if (aborted) cb(); else killers.push(cb); },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    // Both the deadline and the settle-fallback timers stay REF'D: they are actively
    // awaited, and by the settle-wait the escalation may have unref'd every other handle —
    // an unref'd awaited timer would let a standalone CLI process drain its event loop and
    // exit MID-AWAIT, skipping the caller's cleanup and the run's report finalization.
    // Neither can leak: both are cleared in the finally below.
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        aborted = true;
        for (const kill of killers) kill();
        resolve();
      }, this.spawnTimeoutMs);
    });
    try {
      const spawned = this.spawn(bin, args, { ...opts, signal });
      spawned.catch(() => {});
      const settled = spawned.then(() => undefined, () => undefined);
      await Promise.race([settled, deadline]);
      // the flag (not race order) decides: a kill that settles the spawn in the same tick as
      // the deadline must still be reported as a timeout, not as the child's own exit.
      if (!timedOut) return spawned;
      const gaveUp = new Promise<void>((resolve) => {
        settleTimer = setTimeout(resolve, SPAWN_KILL_GRACE_MS + 1_000);
      });
      await Promise.race([settled, gaveUp]);
      return { exitCode: 124, stdout: "", stderr: `spawn timed out after ${this.spawnTimeoutMs}ms: ${bin}` };
    } finally {
      clearTimeout(timer);
      clearTimeout(settleTimer);
    }
  }

  // ---- guarded low-level spawns (the §6 chokepoint) ----
  // EVERY gh spawn — including direct preflight calls (`gh auth status`, `gh --version`) —
  // acquires the GLOBAL semaphore so §4's "cap TOTAL in-flight gh processes" holds for all
  // call paths, not just restGet/graphql. A `bucket` (core/graphql) makes acquisition
  // pause-aware; a bare call (no rate-limit bucket) still counts against the cap.
  async gh(args: string[], bucket?: Bucket): Promise<SpawnResult> {
    assertSpawnAllowed(this.bins.gh, args);
    assertReadOnlyGh(args);
    const release = bucket !== undefined ? await this.acquireRespectingPause(bucket) : await this.sem.acquire();
    try {
      return await this.spawnBounded(this.bins.gh, args, { env: this.ghEnv });
    } finally {
      release();
    }
  }

  async git(args: string[], cwd?: string): Promise<SpawnResult> {
    assertSpawnAllowed(this.bins.git, args);
    assertReadOnlyGit(args);
    // §0: git itself is the only process allowed to run with cwd inside a clone.
    if (cwd !== undefined) assertContained(cwd, [this.tempRoot]);
    // Clone DESTINATION containment lives HERE, not only in cloneShallow — the wrapper is the
    // chokepoint, so no caller can aim a hardened-looking clone outside the temp root. The
    // guard's grammar guarantees exactly two positionals: <url> <dest>.
    if (args[0] === "clone") {
      const positionals: string[] = [];
      for (let i = 1; i < args.length; i++) {
        const a = args[i]!;
        if (a.startsWith("--")) {
          if (!a.includes("=") && (a === "--depth" || a === "--branch" || a === "--template")) i++;
        } else {
          positionals.push(a);
        }
      }
      const dest = positionals[1] ?? "";
      assertContained(dest, [this.tempRoot]);
    }
    // The `--version` probe (§2 preflight — also --plan's ONLY git invocation) needs no
    // credential helper: point its global config at devNull instead of materializing the temp
    // gitconfig, so plan mode truly writes nothing and leaks no pkg-audit-gitcfg-* dir.
    const isVersionProbe = args.length === 1 && args[0] === "--version";
    const env = buildGitEnv(this.baseEnv, isVersionProbe ? devNull : this.ensureGitConfig());
    return this.spawnBounded(this.bins.git, args, { env, cwd });
  }

  async tar(args: string[]): Promise<SpawnResult> {
    assertSpawnAllowed(this.bins.tar, args);
    assertReadOnlyTar(args);
    // The argv guard proves read-only INTENT; the wrapper still containment-checks every
    // write/read target: each -C/--directory extraction dir and the -f/--file archive.
    // Short CLUSTERS matter: in `-xzf <archive>` the f consumes the NEXT operand, and a
    // cluster may contain several value-taking letters (f, C) consuming operands in order.
    const isExtract = args.some((a) => a === "--extract" || /^-[A-Za-z]*x/.test(a));
    const dirs: string[] = [];
    const archives: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-C" || a === "--directory") {
        dirs.push(args[++i] ?? "");
      } else if (a.startsWith("--directory=")) {
        dirs.push(a.slice("--directory=".length));
      } else if (a === "--file") {
        archives.push(args[++i] ?? "");
      } else if (a.startsWith("--file=")) {
        archives.push(a.slice("--file=".length));
      } else if (/^-[A-Za-z]/.test(a) && !a.startsWith("--")) {
        // Short cluster. getopt/tar: when a value-taking letter (f, C) has characters
        // REMAINING in the same token, those chars ARE the value and scanning stops; only a
        // letter at the very end consumes the NEXT argv. `-xzfvv` → f's value is "vv", not
        // the next operand — so we must not containment-check the wrong path.
        const letters = a.slice(1);
        for (let j = 0; j < letters.length; j++) {
          const ch = letters[j]!;
          if (ch === "f" || ch === "C") {
            const attached = letters.slice(j + 1);
            const value = attached !== "" ? attached : (args[++i] ?? "");
            if (ch === "f") archives.push(value);
            else dirs.push(value);
            break; // the rest of this token was consumed as the value
          }
        }
      }
    }
    // List/extract must name EXACTLY ONE contained archive — tar without -f would read a
    // tape device / stdin, and an unverified archive is outside the §0 story.
    const isList = args.some((a) => a === "--list" || /^-[A-Za-z]*t/.test(a));
    if ((isList || isExtract) && archives.length !== 1)
      throw new GithubApiError("tar list/extract requires exactly one contained -f archive", {});
    for (const archive of archives) assertContained(archive, [this.tempRoot]);
    if (isExtract) {
      // Without -C, tar extracts into the PROCESS CWD (the audit repo!) — require a contained
      // destination, and require the §5.E ownership/permission flags explicitly (GNU vs bsdtar
      // defaults differ, so convention is not enough).
      if (dirs.length === 0)
        throw new GithubApiError("tar extract requires an explicit contained -C/--directory", {});
      for (const dir of dirs) assertContained(dir, [this.tempRoot]);
      if (!args.includes("--no-same-owner") || !args.includes("--no-same-permissions"))
        throw new GithubApiError("tar extract requires --no-same-owner and --no-same-permissions", {});
    }
    return this.spawnBounded(this.bins.tar, args, { env: buildTarEnv(this.baseEnv) });
  }

  // ---- REST GET with cache + throttle handling ----
  private cacheKey(endpoint: string): string {
    return `gh:${this.githubHost}:${endpoint}`; // host-scoped; never a hand-built API hostname
  }

  private async waitBucket(bucket: Bucket): Promise<void> {
    const wait = bucket.pausedUntilMs - this.now();
    if (wait <= 0) return;
    // the single chokepoint every throttle pause sleeps through — enforce the budget here.
    // totalPausedMs is PER-CALLER-slept ms, not wall-clock: N concurrent callers sleeping one
    // window ledger N×W. That over-count is deliberate (fails EARLY, never late), as is the
    // accrue-BEFORE-sleep ordering — a concurrent caller must see the budget already committed.
    if (bucket.totalPausedMs + wait > MAX_TOTAL_PAUSE_MS)
      throw new ThrottleExhausted(`${bucket.label} bucket (cumulative pause budget ${MAX_TOTAL_PAUSE_MS}ms exceeded)`);
    bucket.totalPausedMs += wait;
    await this.sleep(wait); // semaphore NOT held while sleeping
  }

  // Acquire a slot with the pause re-checked AFTER acquisition: a caller queued on the
  // semaphore could otherwise spawn straight into a pause window another request just set.
  private async acquireRespectingPause(bucket: Bucket): Promise<() => void> {
    for (;;) {
      await this.waitBucket(bucket);
      const release = await this.sem.acquire();
      if (bucket.pausedUntilMs <= this.now()) return release;
      release(); // pause landed while we were queued — wait it out without holding the slot
    }
  }

  // §4: the FINAL attempt's classification must not arm the bucket — the call is about to
  // throw, and a residual pause would tax the next (possibly honest) call for free. ONE site
  // for the guard so restGet and graphql can never drift apart. Callers compute untilMs
  // eagerly; on the final attempt that spends one extra this.now() read and one discarded
  // backoffWait computation (both pure — the injected test clocks only advance on sleep).
  private armBucketPause(bucket: Bucket, attempt: number, untilMs: number): void {
    if (attempt < MAX_ATTEMPTS - 1) bucket.pausedUntilMs = Math.max(bucket.pausedUntilMs, untilMs);
  }

  // MUST stay PURE (no state, no jitter, no counters): armBucketPause callers evaluate it
  // even on the final attempt and discard the result — a side effect here would silently
  // start taxing that discarded call.
  private backoffWait(kind: "secondary" | "transient", attempt: number, waitMs: number | null): number {
    if (waitMs !== null) return waitMs;
    const base = kind === "secondary" ? SECONDARY_BASE_WAIT_MS : TRANSIENT_BASE_WAIT_MS;
    return base * 2 ** attempt;
  }

  // One REST GET. `immutable: true` (commit/tree/blob-SHA-pinned URLs) serves a cached body
  // with ZERO network request (§3); otherwise a cached ETag rides as If-None-Match and gh's
  // non-zero-exit 304 is a cache HIT.
  // An endpoint is only genuinely IMMUTABLE if it pins a git object id — a blob/tree SHA in
  // the path or a sha-shaped `?ref=`. This is defense-in-depth over the callers' own isSha
  // gate: a caller can never zero-network-freeze a mutable branch/tag URL by passing immutable.
  private static endpointIsShaPinned(endpoint: string): boolean {
    const [path, query = ""] = endpoint.split("?");
    if (/\/git\/(blobs|trees)\/[0-9a-f]{40}([0-9a-f]{24})?(\/|$)/i.test(path ?? "")) return true;
    const ref = new URLSearchParams(query).get("ref") ?? "";
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(ref);
  }

  async restGet(endpoint: string, opts: { accept?: string; immutable?: boolean } = {}): Promise<HttpResponse> {
    const accept = opts.accept ?? "";
    const immutable = opts.immutable === true && GithubClient.endpointIsShaPinned(endpoint);
    const key = this.cacheKey(endpoint);
    const cached = this.db?.getApiCache("GET", key, accept) ?? null;
    if (immutable && cached !== null && cached.responseBody !== null)
      return { status: 200, headers: {}, body: cached.responseBody };

    const args = ["api", "-i", endpoint];
    if (accept !== "") args.push("-H", `Accept: ${accept}`);
    if (cached?.etag != null && cached.responseBody !== null) args.push("-H", `If-None-Match: ${cached.etag}`);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // gh() acquires the (pause-aware) semaphore for the core bucket and releases it.
      const res = await this.gh(args, this.core);
      const parsed = parseGhApiOutput(res.stdout);
      if (parsed.status === 0) {
        // no HTTP response at all (network/auth plumbing failure; diagnostics on stderr)
        if (attempt < MAX_ATTEMPTS - 1) {
          await this.sleep(this.backoffWait("transient", attempt, null));
          continue;
        }
        throw new GithubApiError(`gh api produced no HTTP response: ${res.stderr.trim().slice(0, 300)}`, { endpoint });
      }
      if (parsed.status === 304 && cached !== null && cached.responseBody !== null) {
        this.db?.putApiCache({ method: "GET", url: key, variantHash: accept, etag: cached.etag, responseBody: cached.responseBody });
        return { status: 200, headers: parsed.headers, body: cached.responseBody };
      }
      const cls = classifyRest(parsed.status, parsed.headers, parsed.body, this.now());
      if (cls.kind === "ok") {
        this.db?.putApiCache({
          method: "GET", url: key, variantHash: accept,
          etag: parsed.headers["etag"] ?? null, responseBody: parsed.body,
        });
        return parsed;
      }
      if (cls.kind === "fatal")
        throw new GithubApiError(`${cls.message} (${endpoint})`, { status: cls.status, endpoint, ssoRequired: cls.ssoRequired });
      if (cls.kind === "primary") {
        this.armBucketPause(this.core, attempt, cls.untilMs);
        continue;
      }
      const waitMs = this.backoffWait(cls.kind, attempt, cls.kind === "secondary" ? cls.waitMs : null);
      this.armBucketPause(this.core, attempt, this.now() + waitMs);
    }
    throw new ThrottleExhausted(endpoint);
  }

  async restGetJson(endpoint: string, opts: { immutable?: boolean } = {}): Promise<unknown> {
    const res = await this.restGet(endpoint, { immutable: opts.immutable });
    try {
      return JSON.parse(res.body);
    } catch {
      throw new GithubApiError(`invalid JSON from ${endpoint}`, { status: res.status, endpoint });
    }
  }

  // TS pagination (§5.A): per-page `gh api -i`, follow Link rel="next" (host-verified,
  // recomposed relative) until absent, accumulating array pages.
  async restGetPagedArray(endpoint: string): Promise<unknown[]> {
    const acc: unknown[] = [];
    // A compromised/misbehaving API controls the Link chain: a repeated endpoint (cycle) or
    // an endless unique chain must fail closed, not loop unbounded (rate-limit/memory/hang).
    const seen = new Set<string>();
    let ep: string | null = endpoint;
    while (ep !== null) {
      if (seen.has(ep))
        throw new GithubApiError(`pagination Link cycle: ${ep} already fetched`, { endpoint: ep });
      if (seen.size >= MAX_PAGES)
        throw new GithubApiError(`pagination exceeded ${MAX_PAGES} pages following Link next`, { endpoint: ep });
      seen.add(ep);
      const res = await this.restGet(ep);
      let page: unknown;
      try {
        page = JSON.parse(res.body);
      } catch {
        throw new GithubApiError(`invalid JSON page from ${ep}`, { status: res.status, endpoint: ep });
      }
      if (!Array.isArray(page)) throw new GithubApiError(`expected a JSON array page from ${ep}`, { endpoint: ep });
      acc.push(...page);
      const nextUrl = parseLinkNext(res.headers["link"]);
      ep = nextUrl === null ? null : nextEndpointFromLink(nextUrl, this.githubHost);
    }
    return acc;
  }

  // ---- GraphQL (never cached — the §3 skip predicate needs the LIVE head) ----
  async graphql(query: string, fields: Record<string, string>): Promise<unknown> {
    if ("query" in fields)
      throw new GithubApiError("graphql variable named 'query' would collide with the query body field", {});
    const args = ["api", "-i", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(fields)) args.push("-f", `${k}=${v}`); // -f raw strings, never -F

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const res = await this.gh(args, this.graphqlBucket);
      const parsed = parseGhApiOutput(res.stdout);
      if (parsed.status === 0) {
        if (attempt < MAX_ATTEMPTS - 1) {
          await this.sleep(this.backoffWait("transient", attempt, null));
          continue;
        }
        throw new GithubApiError(`gh api graphql produced no HTTP response: ${res.stderr.trim().slice(0, 300)}`, { endpoint: "graphql" });
      }
      let body: { data?: unknown; errors?: GraphqlErrorEntry[] } = {};
      try {
        body = JSON.parse(parsed.body) as typeof body;
      } catch {
        body = {};
      }
      const errors = Array.isArray(body.errors) ? body.errors : [];
      // §4: GraphQL throttles can arrive as HTTP 200 with body errors — check BOTH.
      const cls = classifyGraphql(parsed.status, parsed.headers, errors, this.now());
      if (cls.kind === "ok") return body.data;
      if (cls.kind === "fatal")
        throw new GithubApiError(`graphql: ${cls.message}`, { status: cls.status, endpoint: "graphql", ssoRequired: cls.ssoRequired });
      if (cls.kind === "primary") {
        this.armBucketPause(this.graphqlBucket, attempt, cls.untilMs);
        continue;
      }
      const waitMs = this.backoffWait(cls.kind, attempt, cls.kind === "secondary" ? cls.waitMs : null);
      this.armBucketPause(this.graphqlBucket, attempt, this.now() + waitMs);
    }
    throw new ThrottleExhausted("graphql");
  }

  // ---- discovery (§5.A / §5.B) ----
  async listOrgRepos(org: string): Promise<RepoInfo[]> {
    const raw = await this.restGetPagedArray(`orgs/${encodeURIComponent(org)}/repos?per_page=100&page=1&type=all`);
    return raw.map((r) => mapRestRepo(r as Record<string, unknown>));
  }

  async listUserRepos(): Promise<RepoInfo[]> {
    const raw = await this.restGetPagedArray(`user/repos?affiliation=owner&per_page=100&page=1`);
    return raw.map((r) => mapRestRepo(r as Record<string, unknown>));
  }

  async listOrgMemberships(): Promise<string[]> {
    const raw = await this.restGetPagedArray(`user/orgs?per_page=100&page=1`);
    return raw.map((o) => String((o as Record<string, unknown>)["login"] ?? "")).filter((s) => s !== "");
  }

  // §5.B: enumerate ALL ref pages (RefOrderField cannot order heads by commit date), then sort
  // committedDate DESC client-side. Cutoff filtering/capping is the orchestrator's job.
  async listBranchHeads(org: string, repo: string): Promise<BranchHead[]> {
    const query =
      "query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){refs(refPrefix:\"refs/heads/\",first:100,after:$endCursor){pageInfo{hasNextPage endCursor}nodes{name target{...on Commit{oid committedDate tree{oid}}}}}}}";
    const heads: BranchHead[] = [];
    // same poisoned-pagination bound as restGetPagedArray: a response controls the next
    // cursor, so a repeated or endless cursor chain must fail closed, not loop unbounded.
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      // loop-top cap = at most MAX_PAGES fetches, the same semantics as restGetPagedArray
      // (seenCursors holds one cursor per follow-up, so size = pages already fetched - 1).
      if (seenCursors.size >= MAX_PAGES)
        throw new GithubApiError(`refs pagination exceeded ${MAX_PAGES} pages for ${org}/${repo}`, { endpoint: "graphql" });
      const fields: Record<string, string> = { owner: org, name: repo };
      if (cursor !== null) fields["endCursor"] = cursor; // omit entirely on the first page (§5.B)
      const data = (await this.graphql(query, fields)) as {
        repository?: { refs?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: unknown[] } } | null;
      } | null;
      const refs = data?.repository?.refs;
      if (refs === undefined || refs === null)
        throw new GithubApiError(`graphql returned no refs for ${org}/${repo}`, { endpoint: "graphql" });
      for (const node of refs.nodes ?? []) {
        const n = node as { name?: string; target?: { oid?: string; committedDate?: string; tree?: { oid?: string } } };
        if (n.name && n.target?.oid && n.target.committedDate && n.target.tree?.oid)
          heads.push({ name: n.name, oid: n.target.oid, committedDate: n.target.committedDate, treeOid: n.target.tree.oid });
      }
      if (refs.pageInfo?.hasNextPage === true && typeof refs.pageInfo.endCursor === "string") {
        const next = refs.pageInfo.endCursor;
        if (seenCursors.has(next))
          throw new GithubApiError(`refs pagination cursor cycle for ${org}/${repo}`, { endpoint: "graphql" });
        seenCursors.add(next);
        cursor = next;
      } else {
        break;
      }
    }
    return heads.sort((a, b) =>
      a.committedDate !== b.committedDate ? (a.committedDate < b.committedDate ? 1 : -1) : a.name < b.name ? -1 : 1,
    );
  }

  // ---- contents / tree / blob (§5.C; SHA-pinned = immutable = zero-network cache hits) ----
  // Only a full hex object id earns the immutable zero-network path — a branch/tag name
  // passed by mistake must never freeze a MUTABLE response into the cache forever.
  private static isSha(ref: string): boolean {
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(ref); // sha1 (40) or sha256 (64) object ids
  }

  async fetchTreeRecursive(org: string, repo: string, treeOid: string): Promise<{ truncated: boolean; paths: Array<{ path: string; type: string; sha: string; size: number | null }> }> {
    const endpoint = `repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeOid)}?recursive=1`;
    const json = (await this.restGetJson(endpoint, { immutable: GithubClient.isSha(treeOid) })) as {
      truncated?: boolean;
      tree?: Array<{ path?: string; type?: string; sha?: string; size?: number }>;
    };
    return {
      truncated: json.truncated === true,
      paths: (json.tree ?? []).map((e) => ({
        path: e.path ?? "",
        type: e.type ?? "",
        sha: e.sha ?? "",
        size: typeof e.size === "number" ? e.size : null,
      })),
    };
  }

  async fetchFileRaw(org: string, repo: string, path: string, refSha: string): Promise<string> {
    const endpoint = `repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/contents/${encodeContentsPath(path)}?ref=${encodeURIComponent(refSha)}`;
    const res = await this.restGet(endpoint, { accept: RAW_ACCEPT, immutable: GithubClient.isSha(refSha) });
    return res.body;
  }

  async fetchFileMeta(org: string, repo: string, path: string, refSha: string): Promise<unknown> {
    const endpoint = `repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/contents/${encodeContentsPath(path)}?ref=${encodeURIComponent(refSha)}`;
    return this.restGetJson(endpoint, { immutable: GithubClient.isSha(refSha) });
  }

  async fetchBlobRaw(org: string, repo: string, blobSha: string): Promise<string> {
    const endpoint = `repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(blobSha)}`;
    const res = await this.restGet(endpoint, { accept: RAW_ACCEPT, immutable: GithubClient.isSha(blobSha) });
    return res.body;
  }

  async rateLimit(): Promise<unknown> {
    return this.restGetJson("rate_limit"); // never cached as immutable; ETag varies per call
  }

  // ---- hardened clone fallback (§0 / §5.C) ----
  // All git config is pinned to this generated file: only a credential helper delegating to
  // the SAME gh binary/auth the rest of the tool uses. Written once per client, contained.
  private ensureGitConfig(): string {
    if (this.gitConfigPath !== null) return this.gitConfigPath;
    const dir = mkdtempSync(join(this.tempRoot, "pkg-audit-gitcfg-"));
    const path = join(dir, "gitconfig");
    assertContained(path, [this.tempRoot]);
    // The `!` helper is a SHELL command — single-quote the gh path unconditionally (with
    // '\'' escaping) so spaces/metacharacters in the path can never be shell-interpreted.
    const ghBin = `'${this.bins.gh.replace(/'/g, `'\\''`)}'`;
    writeFileSync(
      path,
      `[credential]\n\thelper = !${ghBin} auth git-credential\n[protocol]\n\tallow = never\n[protocol "https"]\n\tallow = always\n`,
      { mode: 0o600 },
    );
    this.gitConfigPath = path;
    return path;
  }

  makeRunTempDir(): string {
    const dir = mkdtempSync(join(this.tempRoot, "pkg-audit-"));
    assertContained(dir, [this.tempRoot]);
    return dir;
  }

  async cloneShallow(org: string, repo: string, branch: string): Promise<{ dir: string; headSha: string }> {
    const runDir = this.makeRunTempDir();
    const dest = join(runDir, "clone");
    assertContained(dest, [this.tempRoot]); // §0: clone dest containment BEFORE spawning
    const url = `https://${this.githubHost}/${encodeURIComponent(org)}/${encodeURIComponent(repo)}.git`;
    const args = [
      "clone", "--depth", "1", "--single-branch", "--branch", branch,
      "--no-tags", "--no-recurse-submodules", "--template=", url, dest,
    ];
    try {
      const res = await this.git(args);
      if (res.exitCode !== 0)
        throw new GithubApiError(`git clone failed for ${org}/${repo}@${branch}: ${res.stderr.trim().slice(0, 300)}`, { endpoint: url });
      // §0: record the fetched SHA. cwd inside the clone is permitted for git itself only.
      const rev = await this.git(["rev-parse", "HEAD"], dest);
      if (rev.exitCode !== 0)
        throw new GithubApiError(`git rev-parse HEAD failed in ${dest}: ${rev.stderr.trim().slice(0, 300)}`, { endpoint: url });
      return { dir: dest, headSha: rev.stdout.trim() };
    } catch (e) {
      // a failed/timed-out clone can leave a multi-GB partial tree — reclaim it NOW rather
      // than at the next run's startup sweep (the caller only cleans up on success). The
      // cleanup is BEST-EFFORT: force only suppresses ENOENT, and an EACCES/EBUSY here must
      // not replace the actionable git error (a stuck tree is the next sweep's problem).
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch {
        // the original error propagates below
      }
      throw e;
    }
  }

  // ---- startup sweep (§0): stale pkg-audit-* DIRECT children of the temp root only ----
  sweepStaleTempDirs(): string[] {
    const removed: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(this.tempRoot);
    } catch {
      return removed;
    }
    for (const name of entries) {
      if (!name.startsWith("pkg-audit-")) continue;
      const full = join(this.tempRoot, name);
      let st;
      try {
        st = lstatSync(full); // lstat: NEVER follow a symlink
      } catch {
        continue;
      }
      try {
        if (st.isSymbolicLink()) {
          unlinkSync(full); // remove the link itself, never its target
        } else if (st.isDirectory()) {
          rmSync(full, { recursive: true, force: true });
        } else {
          unlinkSync(full);
        }
        removed.push(name);
      } catch {
        // a dir vanishing mid-sweep (concurrent cleanup) is not an error
      }
    }
    return removed;
  }
}
