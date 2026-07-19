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
import type { DiscoveryFailure } from "./discovery.ts";
import { isIsoInstant } from "./isoDate.ts";
import { logLine } from "./log.ts";
import { emitProgress, hasProgressSink, nextProgressId } from "./progress.ts";
import { classifyRepository, type CompiledRepositoryPolicy } from "./repositoryPolicy.ts";

// ---- errors -----------------------------------------------------------------------------
// Non-retryable API failure (404, permission, SSO enforcement, poisoned redirect, …) — the
// orchestrator records an errors row for it, with ONE exception: a status-404 on a per-file
// CONTENT read degrades to "file absent" (see orchestrate.ts apiReader), never a row.
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
// Minimal, purpose-built abort plumbing: a bespoke { aborted, onAbort } read side fit for the
// spawn-deadline use — the client flips it on deadline expiry and the spawn impl registers the
// child-kill — rather than the platform AbortSignal's EventTarget (add/removeEventListener) API.
// (The platform AbortController/AbortSignal ARE available under `types: ["bun"]`; this is a
// fit-for-purpose shape, not a missing type.) onAbort fires immediately if already aborted.
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

// The subprocess kinds the client spawns. Threaded EXPLICITLY through spawnBounded (PROMPT-TUI
// §U3.1): binPaths is injectable and tests point several tools at the same binary, so the tool
// can never be inferred from the path — each call site knows what it is.
export type SpawnTool = "gh" | "git" | "tar";

// PURE, TOTAL, never-throwing display label for a spawn span (PROMPT-TUI §U3.1). Allowlist-shaped
// — `gh api <endpoint>` / `gh api graphql` / `gh <verb>` / `git clone <owner/repo>` (parsed from
// the URL positional) / `git <verb>` / `tar extract|list|--version` — never a raw argv join, and
// capped at 100 chars. argv never carries credentials (§6), but the label still shows only the
// operation identity. Built ONLY when a progress sink is installed.
export const SPAWN_LABEL_MAX = 100;
export function spawnLabel(tool: SpawnTool, args: readonly string[]): string {
  const cap = (s: string): string => (s.length > SPAWN_LABEL_MAX ? s.slice(0, SPAWN_LABEL_MAX - 1) + "…" : s);
  try {
    const first = args[0] ?? "";
    if (tool === "gh") {
      if (first !== "api") return cap(first === "" ? "gh" : `gh ${first}`);
      // gh api [-i] <endpoint> …: the endpoint is the first non-flag after "api"
      for (let i = 1; i < args.length; i++) {
        const a = args[i]!;
        if (a === "-H" || a === "-f" || a === "-F") {
          i++; // value-taking flags: skip the value
          continue;
        }
        if (a.startsWith("-")) continue;
        return cap(a === "graphql" ? "gh api graphql" : `gh api ${a}`);
      }
      return "gh api";
    }
    if (tool === "git") {
      if (first !== "clone") return cap(first === "" ? "git" : `git ${first}`);
      // label the repo, never the full URL: find the https positional, take the last two path segments
      for (const a of args.slice(1)) {
        if (!a.startsWith("https://")) continue;
        const path = new URL(a).pathname.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
        const segments = path.split("/").filter((s) => s !== "");
        if (segments.length >= 2) return cap(`git clone ${segments.slice(-2).join("/")}`);
        break;
      }
      return "git clone";
    }
    // tar
    if (args.includes("--version")) return "tar --version";
    if (args.some((a) => a === "--extract" || /^-[A-Za-z]*x/.test(a))) return "tar extract";
    if (args.some((a) => a === "--list" || /^-[A-Za-z]*t/.test(a))) return "tar list";
    return "tar";
  } catch {
    return tool; // total on hostile argv — the label is display plumbing, never control flow
  }
}

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
    // ANY reader failure — not only the byte cap's own onExceed — must start the kill
    // escalation: a raw stream error otherwise leaves the child running and pins the
    // hold-until-exit wait until the caller's wall-clock deadline. kill() is re-entrant
    // (every step is a no-op on an already-dead child).
    const killOnFailure = (p: Promise<string>): Promise<string> => {
      p.catch(() => kill());
      return p;
    };
    return joinSpawnOutcome(
      killOnFailure(readCapped(outReader, cap, kill)),
      killOnFailure(readCapped(errReader, cap, kill)),
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
// MAX_PAUSE_MS bounds ONE sleep; this bounds the total WALL-CLOCK a bucket's pause windows may
// cover per client lifetime — their UNION, so concurrent callers waiting out the SAME window are
// charged once, not once per caller (the summed per-caller sleep time can exceed this; the funded
// wall-clock coverage cannot). Otherwise poison-then-succeed responses keep every call "succeeding"
// at 5 clamped naps per page, ~417 days across one MAX_PAGES listing. Once spent, further pending
// pauses fail as ThrottleExhausted instead of sleeping.
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
  if (status === 200) return { kind: "ok" };
  // §5.C: only EXACTLY 200 is success. A non-200 2xx (206 Partial Content from a middlebox,
  // 203 proxy-transformed content, …) carries a body that cannot be trusted as complete. The
  // raw consumers (fetchFileRaw/fetchBlobRaw) scan those bodies as file content with no
  // structural validation at all, and the structured consumers' validation cannot establish
  // transport completeness anyway — so ONE fatal here covers every consumer, current and
  // future. Non-retryable on purpose: a transforming middlebox would re-transform on retry,
  // and the transient path would
  // end in a misleading ThrottleExhausted that loses the status. Every REST endpoint this tool
  // calls returns exactly 200 on success; an endpoint with genuine 202/204 semantics would need
  // its own explicit handler, never a re-widening of this range. Bounds are exact (201-299) so
  // status 0 (no HTTP response — handled before classification) and a terminal 1xx (the -i
  // parser can surface one when no final block follows) keep their existing paths.
  if (status >= 201 && status < 300)
    return { kind: "fatal", status, ssoRequired: false, message: `HTTP ${status} — only exactly 200 is success (a non-200 2xx body cannot be trusted as complete)` };
  if (status === 403 || status === 429) {
    // PRIMARY is keyed on remaining==0, NOT the status code (§4). Checking it BEFORE the SSO
    // header is safe: a genuine SSO/permission 403 is not consuming the last request of the
    // window, so it arrives with nonzero remaining and falls through to the fatal branches.
    if (headers["x-ratelimit-remaining"] === "0")
      return { kind: "primary", untilMs: primaryUntilMs(headers, nowMs) };
    if (headers["x-github-sso"] !== undefined)
      return { kind: "fatal", status, ssoRequired: true, message: "SSO authorization required (x-github-sso). Remediate: gh auth refresh (see README § What the gh token needs)" };
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
    return { kind: "fatal", status, ssoRequired: true, message: "SSO authorization required (x-github-sso). Remediate: gh auth refresh (see README § What the gh token needs)" };
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

// ---- §4/§5.C response-envelope validation (pure) ---------------------------------------------
// sha1 (40) or sha256 (64) hex object ids — the only forms that may address SHA-pinned fetches.
const HEX_OBJECT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

// Non-null, non-array object guard (mirrors config.ts's isObject) — the same shape recurred across
// every envelope/tree/branch-head validator below; the type predicate also drops their `as Record` casts.
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// GraphQL spec (§7 Response): the body is a MAP carrying `data` and/or a NON-EMPTY `errors` list
// of maps. parseGraphqlEnvelope never throws: it reports the FIRST spec violation via `malformed`
// and returns whatever error evidence it could read, so graphql() can classify status/header/
// throttle semantics BEFORE deciding what a violation means for its path.
export interface GraphqlEnvelope {
  data: unknown; // the data member verbatim (undefined when absent)
  // Sanitized projections — only string-valued type/message survive, so downstream string
  // coercion (classifyGraphql's join / template literals) is total even on hostile entries.
  // CONTRACT: `errors` and `malformed` are INDEPENDENT — a non-null `malformed` (from one bad
  // sibling entry) can coexist with readable `errors` (e.g. a genuine RATE_LIMITED beside it).
  // A consumer must classify off `errors` FIRST and treat `malformed` only as "do not accept as
  // success", never as "the errors are worthless".
  errors: GraphqlErrorEntry[];
  malformed: string | null; // first spec violation, null when the envelope is well-formed
}
export function parseGraphqlEnvelope(bodyText: string): GraphqlEnvelope {
  let malformed: string | null = null;
  const note = (reason: string): void => {
    if (malformed === null) malformed = reason;
  };
  let root: unknown;
  try {
    root = JSON.parse(bodyText);
  } catch {
    return { data: undefined, errors: [], malformed: "unparseable JSON body" };
  }
  if (!isObject(root))
    return { data: undefined, errors: [], malformed: "non-object response root" };
  const obj = root;
  const hasData = Object.hasOwn(obj, "data");
  const hasErrors = Object.hasOwn(obj, "errors");
  if (!hasData && !hasErrors) note("response carries neither data nor errors");
  const errors: GraphqlErrorEntry[] = [];
  if (hasErrors) {
    const raw = obj["errors"];
    if (!Array.isArray(raw)) note("present errors member is not an array");
    else if (raw.length === 0) note("present errors member is an empty array (spec: non-empty)");
    else {
      for (const entry of raw) {
        if (!isObject(entry)) {
          note("errors[] contains a non-object entry");
          continue;
        }
        const e = entry;
        const proj: GraphqlErrorEntry = {};
        if (Object.hasOwn(e, "type")) {
          if (typeof e["type"] === "string") proj.type = e["type"];
          else note("errors[].type is not a string");
        }
        if (Object.hasOwn(e, "message")) {
          if (typeof e["message"] === "string") proj.message = e["message"];
          else note("errors[].message is not a string");
        }
        // An entry with NOTHING readable carries no classifiable signal. Keeping it would
        // fabricate "ERROR: " fatal text; dropping it SILENTLY would fail open — {"errors":[{}]}
        // would sanitize to no-errors and classify as success. Flag it, then drop it.
        if (proj.type === undefined && proj.message === undefined) {
          note("errors[] entry carries no readable type/message");
          continue;
        }
        errors.push(proj);
      }
    }
  }
  if (hasData) {
    const d = obj["data"];
    if (d === null) {
      // spec: data:null is the total-execution-failure shape and requires errors beside it —
      // alone it is indistinguishable from a swallowed failure signal.
      if (!hasErrors) note("data is null but no errors member is present");
    } else if (!isObject(d)) {
      note("data member is not an object");
    }
  }
  return { data: hasData ? obj["data"] : undefined, errors, malformed };
}

// GitHub git/trees (§5.C): the listing we act on must be PROVABLY complete and well-addressed,
// so every violation throws (→ a scan-scope errors row at the unit boundary). Before this guard,
// a missing `tree` member read as an EMPTY repo (zero findings, silently) and a missing
// `truncated` flag read as `false` — silently disabling the caller's clone fallback, its only
// escape hatch for over-limit repos.
// The git object types git/trees returns — the SINGLE source of truth for both the runtime check
// and the static TreeEntryType, so the two cannot drift. A future/unknown type must fail LOUD, not
// vanish through the downstream blob filter.
const TREE_ENTRY_TYPES = ["blob", "tree", "commit"] as const;
export type TreeEntryType = (typeof TREE_ENTRY_TYPES)[number];
const isTreeEntryType = (v: unknown): v is TreeEntryType => (TREE_ENTRY_TYPES as readonly unknown[]).includes(v);
// truncated:true carries NO paths (partial data is unusable — the caller clones); the discriminated
// union makes reading `paths` on a truncated tree a COMPILE error, not a silent empty-repo read.
export type TreeResponse =
  | { truncated: true }
  | { truncated: false; paths: Array<{ path: string; type: TreeEntryType; sha: string; size: number | null }> };
export function parseTreeResponse(json: unknown, endpoint: string, expectedSha: string | null): TreeResponse {
  const fail = (reason: string): GithubApiError =>
    new GithubApiError(`malformed git-tree response from ${endpoint}: ${reason}`, { status: 200, endpoint });
  if (!isObject(json)) throw fail("non-object response root");
  const obj = json;
  const truncated = obj["truncated"];
  if (typeof truncated !== "boolean") throw fail("truncated flag missing or non-boolean");
  const tree = obj["tree"];
  if (!Array.isArray(tree)) throw fail("tree member missing or non-array");
  if (expectedSha !== null) {
    const sha = obj["sha"];
    if (typeof sha !== "string" || sha.toLowerCase() !== expectedSha.toLowerCase())
      throw fail("response sha does not match the requested tree oid");
  }
  // A truncated listing is unusable partial data: the caller MUST fall back to a clone (§5.C)
  // and nothing may read these entries — validating junk we won't consume would only block that
  // fallback. Return the flag alone.
  if (truncated) return { truncated: true };
  const seen = new Set<string>();
  const paths = tree.map((entry: unknown, i) => {
    if (!isObject(entry)) throw fail(`tree[${i}] is not an object`);
    const e = entry;
    const path = e["path"];
    const type = e["type"];
    const sha = e["sha"];
    if (typeof path !== "string" || !isCanonicalTreePath(path)) throw fail(`tree[${i}] path missing or non-canonical`);
    if (!isTreeEntryType(type)) throw fail(`tree[${i}] has an unknown entry type`);
    if (typeof sha !== "string" || !HEX_OBJECT_ID_RE.test(sha)) throw fail(`tree[${i}] sha missing or non-hex`);
    if (seen.has(path)) throw fail(`duplicate path ${JSON.stringify(path)}`);
    seen.add(path);
    let size: number | null = null;
    if (Object.hasOwn(e, "size")) {
      const s = e["size"];
      // typeof-number alone admits Infinity (JSON "1e400") and fractions — either would corrupt
      // the downstream size gates instead of failing loud here.
      if (typeof s !== "number" || !Number.isSafeInteger(s) || s < 0) throw fail(`tree[${i}] size is not a non-negative safe integer`);
      size = s;
    } else if (type === "blob") {
      // The scan cap (unitPipeline) skips only entries whose size EXCEEDS the limit; a null-size blob
      // sails through it and gets fetched + scanned regardless. Real GitHub always emits size on blobs,
      // so a missing one is a malformed/hostile response — fail closed (tree/commit entries carry none).
      throw fail(`tree[${i}] blob entry is missing size`);
    }
    return { path, type, sha, size };
  });
  return { truncated: false, paths };
}
// git tree paths are repo-relative and canonical: no empty / "." / ".." segments (which also
// covers leading, trailing and doubled slashes) and no NUL — anything else misaddresses the
// contents fetch and the permalink.
function isCanonicalTreePath(p: string): boolean {
  if (p.length === 0 || p.includes("\u0000")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
// A GitHub org/repo identity is a single path segment consumed verbatim by API endpoint paths and the
// clone URL. Reject the dot segments "." / ".." (traversal), path separators,
// and any Unicode control (\p{Cc} — C0, C1, and DEL) or whitespace character — a real GitHub login or
// repo name contains none of these, while legitimate names like ".github" and "a.b" pass. This does
// NOT enforce the full GitHub name grammar (GHES/legacy differ); it only closes the structural
// scope-steering vectors — the same fail-closed posture isCanonicalTreePath applies to tree paths.
const IDENTITY_REJECT_RE = /[\p{Cc}\s/\\]/u;
export function isCanonicalIdentity(s: string): boolean {
  return s.length > 0 && s !== "." && s !== ".." && !IDENTITY_REJECT_RE.test(s);
}

// ---- §5.C path encoding (pure) --------------------------------------------------------------
// encodeURIComponent per PATH SEGMENT, preserving '/' — matches the permalink builder's rule.
export function encodeContentsPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// ---- §5.A repo shaping (pure) ---------------------------------------------------------------
// NOTE: RepoInfo deliberately carries NO default-branch name. The REST listing's `default_branch` is a
// DIFFERENT EPOCH from §5.B branch discovery — the owner loop lists every repo up-front, then discovers
// each repo's heads one at a time, so the REST value can be minutes-to-hours stale by the time a repo is
// planned. That staleness is not benign under branch policy: default-ness is decided by NAME equality
// (branchPolicy.ts::classifyBranch) and the default's ALWAYS-eligible exemption rides on it, so a default
// renamed in that window (main → trunk) would make the REAL default look non-default and a restrictive
// policy (e.g. `branches: []`) would exclude it — the repo would silently yield zero scanned units.
// The default branch is therefore resolved from the SAME GraphQL snapshot as the heads (BranchSnapshot,
// listBranchHeads). There is no REST fallback ON PURPOSE: a fallback would reintroduce the stale epoch
// at exactly the moment the authoritative source is unavailable, and keeping both sources would only add
// a "they disagree" decision tree without making either one true.
export interface RepoInfo {
  name: string;
  organization: string;
  pushedAt: string | null;
  archived: boolean;
  fork: boolean;
  isPrivate: boolean;
}
// Fail LOUD on a malformed repo listing entry (§5.A). EVERY RepoInfo field is now strictly validated,
// replacing the old String(raw.name ?? "")/String(owner?.login ?? "") coercion and the
// `?? "" / === true / typeof` defaults — the SCOPE-STEERING fields (name, owner.login, pushed_at,
// archived, fork) each silently mis-scoped the audit when coerced, and `private` is validated too for
// report integrity even though it does not steer selection:
//   • name / owner.login → a missing/empty/null/non-string value became "" or a coerced string
//     (e.g. 42 → "42"), a FABRICATED repo/owner id.
//   • pushed_at drives the DESC sort + `maxReposPerOrg` cap: a coerced-to-null (or garbage-string)
//     value sinks a repo to last, and the cap can then drop a genuinely-recent repo — a silent
//     UNDER-report. It must be explicitly `null` (never pushed) or a valid ISO instant.
//   • archived / fork drive the policy filter: a coerced-to-false value both scans an excluded repo
//     AND lets it displace an eligible one out of a finite cap (also an under-report). Must be bool.
// Anything malformed throws an indexed GithubApiError — same fail-closed posture as
// listOrgMemberships and listBranchHeads' committedDate.
export function mapRestRepo(raw: unknown, endpoint: string, index: number, expectedOwner: string): RepoInfo {
  const fail = (reason: string): GithubApiError =>
    new GithubApiError(`malformed repo listing at index ${index}: ${reason}`, { endpoint });
  if (!isObject(raw)) throw fail("not an object");
  const name = raw["name"];
  if (typeof name !== "string" || name.length === 0) throw fail("missing, empty, or non-string name");
  if (!isCanonicalIdentity(name)) throw fail("name is not a canonical identity segment");
  const owner = raw["owner"];
  if (!isObject(owner)) throw fail("missing or non-object owner");
  const login = owner["login"];
  if (typeof login !== "string" || login.length === 0) throw fail("missing, empty, or non-string owner.login");
  // Validate the segment BEFORE the cross-owner equality: a hostile "." / ".." / separator login must
  // fail loud even in the (degenerate) case where it equals expectedOwner, not slip past because the
  // equality happened to hold.
  if (!isCanonicalIdentity(login)) throw fail("owner.login is not a canonical identity segment");
  // Both listings pass their EXPECTED owner: an org listing passes the org; a user listing passes the
  // authenticated personal login (known at its orchestrate.ts call site). The row's owner MUST equal
  // it — case-insensitively (GitHub logins are), keeping the returned casing — or a foreign-owner row
  // would redirect the scan to a different account and mis-attribute every finding/permalink to it.
  if (login.toLowerCase() !== expectedOwner.toLowerCase())
    throw fail(`owner.login ${JSON.stringify(login)} is not the requested owner ${JSON.stringify(expectedOwner)}`);
  const pushed = raw["pushed_at"];
  let pushedAt: string | null;
  // pushed_at drives the DESC sort + maxReposPerOrg cap, and filterSortCapRepos compares the strings
  // LEXICALLY — which equals chronological order ONLY for the canonical UTC (Z) form GitHub's REST API
  // actually emits. isIsoInstant also accepts OFFSET forms (it is shared with git's %cI committedDate),
  // and an offset instant sorts lexically wrong (e.g. `…-10:00` is newer than a `…Z` value it sorts
  // before), so it could sink a genuinely-recent repo below the cap — a silent under-report. Require Z.
  if (pushed === null) pushedAt = null;
  else if (typeof pushed === "string" && pushed.endsWith("Z") && isIsoInstant(pushed)) pushedAt = pushed;
  else throw fail("pushed_at is not null or a canonical UTC (Z) ISO instant");
  const archived = raw["archived"], fork = raw["fork"], isPrivate = raw["private"];
  if (typeof archived !== "boolean") throw fail("archived is not a boolean");
  if (typeof fork !== "boolean") throw fail("fork is not a boolean");
  if (typeof isPrivate !== "boolean") throw fail("private is not a boolean");
  return { name, organization: login, pushedAt, archived, fork, isPrivate };
}
// Client-side policy (§5.A): the excludeRepositories denylist runs FIRST, then archived/fork filtering
// (never trusting a server-side filter), then sort pushed_at DESC (nulls last, name ASC tie-break) and
// cap at maxReposPerOrg. Returns { kept, excluded }: `kept` is the scanned/planned set; `excluded` is
// the ORIGINAL-case `owner/repo` names dropped SPECIFICALLY by the denylist (for --plan), in raw
// discovery order — the real scan ignores it, --plan surfaces it (T6).
//
// DENY-FIRST is load-bearing: applying it to the RAW list before archived/fork AND before the cap means
// a denylisted repo never consumes a maxReposPerOrg slot an eligible repo could use (the repo-grain
// analog of branch policy running before the cap). A SEPARATE first pass keeps `excluded` denylist-ONLY
// — archived/fork/past-cap drops are NOT policy exclusions and never appear in it. classifyRepository
// folds the `owner/repo` INTERNALLY (case-insensitive match), so this passes the ORIGINAL-case name
// straight through; the reported name in `excluded` keeps that original case.
export function filterSortCapRepos(
  repos: RepoInfo[],
  opts: { policy: CompiledRepositoryPolicy; includeArchived: boolean; includeForks: boolean; maxReposPerOrg: number | null },
): { readonly kept: readonly RepoInfo[]; readonly excluded: readonly string[] } {
  const excluded: string[] = [];
  const surviving: RepoInfo[] = [];
  for (const r of repos) {
    const ownerRepo = `${r.organization}/${r.name}`;
    // classifyRepository may throw a fatal RepoPolicyMatchError (a compiled glob threw at match time) —
    // fail-closed by contract, propagated to the run driver which fails the run and rethrows unchanged.
    if (classifyRepository(opts.policy, ownerRepo)) excluded.push(ownerRepo);
    else surviving.push(r);
  }
  const filtered = surviving.filter(
    (r) => (opts.includeArchived || !r.archived) && (opts.includeForks || !r.fork),
  );
  const sorted = [...filtered].sort((a, b) => {
    if (a.pushedAt === null && b.pushedAt === null) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    if (a.pushedAt === null) return 1;
    if (b.pushedAt === null) return -1;
    if (a.pushedAt !== b.pushedAt) return a.pushedAt < b.pushedAt ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const kept = opts.maxReposPerOrg === null ? sorted : sorted.slice(0, opts.maxReposPerOrg);
  return { kept, excluded };
}

export interface BranchHead {
  name: string;
  oid: string;
  committedDate: string;
  treeOid: string;
}

// §5.B: ONE repo's live branch state, from ONE GraphQL snapshot. `heads` and `defaultBranch` are a
// PAIR and must never be separated: the default's always-eligible exemption is decided by matching
// `defaultBranch` against a head NAME, so pairing a head list with a default resolved at a different
// moment is exactly the stale-epoch bug RepoInfo's note describes. Both fields are validated together
// and fail closed (listBranchHeads) — a snapshot that escapes is COMPLETE and internally coherent:
//   - `defaultBranch === null` ⇔ `heads` is EMPTY (a repo with no commits has no default branch).
//   - a non-null `defaultBranch` is guaranteed to NAME one of `heads` (validated post-pagination).
// Consumers therefore never synthesize, guess, or fall back to a default.
export interface BranchSnapshot {
  readonly heads: readonly BranchHead[];
  readonly defaultBranch: string | null;
}

// §5.B discovery outcome. A specialized success arm (a snapshot, not a bare list) unioned with the
// SHARED DiscoveryFailure, so the "a failed scope carries no partial data / is never reconciled" rule
// stays declared in exactly one place (discovery.ts) even though this scope's payload isn't a list.
export type BranchDiscoveryOutcome = { readonly ok: true; readonly snapshot: BranchSnapshot } | DiscoveryFailure;

// ---- semaphore ------------------------------------------------------------------------------
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  // Waiter-pressure gauge (PROMPT-TUI §U3.2): invoked SYNCHRONOUSLY whenever the waiter queue
  // grows or shrinks. The callback must never throw (the client passes a never-throwing
  // progress emit); in-flight count needs no callback — it is the store's live span set.
  private readonly onWaitersChanged: ((waiting: number) => void) | undefined;
  constructor(n: number, onWaitersChanged?: (waiting: number) => void) {
    this.available = n;
    this.onWaitersChanged = onWaitersChanged;
  }
  // The gauge callback is called through this guard so a throwing observer can NEVER corrupt
  // acquire/release accounting (orphan a queued waiter, leak a permit) — the semaphore's
  // correctness must not depend on an observer honoring its no-throw contract.
  private notifyWaiters(): void {
    try {
      this.onWaitersChanged?.(this.waiters.length);
    } catch {
      // observability only — never a participant
    }
  }
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
    } else {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        this.notifyWaiters();
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        this.notifyWaiters();
        next();
      } else {
        this.available++;
      }
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

// Rate-limit header → integer for the display snapshot; absent/non-numeric folds to null.
function headerInt(value: string | undefined): number | null {
  if (value === undefined || value === "" || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
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
  concurrency?: number; // GLOBAL in-flight cap on gh/git/tar subprocesses (§4/§5.6)
  spawnImpl?: SpawnFn;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
  spawnTimeoutMs?: number; // wall-clock kill deadline per spawn (default SPAWN_TIMEOUT_MS)
  env?: Env;
  binPaths?: { gh: string; git: string; tar: string };
  tempRoot?: string; // default realpath(os.tmpdir()); pkg-audit-* dirs live directly under it
}

interface Bucket {
  label: "core" | "graphql"; // also the progress-event resource discriminant (PROMPT-TUI §U3.3)
  // The published pause window end — every caller in this bucket sleeps until here (or, if the tail
  // is unfunded, throws). Published even on budget overflow so a queued caller can never inherit a
  // freed slot and spawn INTO an active rate-limit window (§4 admission).
  pausedUntilMs: number;
  // WALL-CLOCK budget accounting (not per-caller-slept): accountedUntilMs is how far the cumulative
  // pause budget has FUNDED, and budgetSpentMs is the total wall-clock ms charged (<= MAX_TOTAL_PAUSE_MS).
  // N concurrent callers waiting out ONE window charge it ONCE (the union tail), where the old
  // per-caller `totalPausedMs += wait` ledgered it N times and tripped the budget N× too early — wrong
  // for the fan-out caller this whole feature adds. A pause published beyond accountedUntilMs is the
  // UNFUNDED tail: waitBucket throws ThrottleExhausted for it rather than sleeping past the budget.
  accountedUntilMs: number;
  budgetSpentMs: number;
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
  private readonly core: Bucket = { label: "core", pausedUntilMs: 0, accountedUntilMs: 0, budgetSpentMs: 0 };
  private readonly graphqlBucket: Bucket = { label: "graphql", pausedUntilMs: 0, accountedUntilMs: 0, budgetSpentMs: 0 };
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
    if (!Number.isFinite(this.spawnTimeoutMs) || this.spawnTimeoutMs < 1)
      throw new Error(`spawnTimeoutMs must be >= 1 (got ${this.spawnTimeoutMs}) — a nonpositive deadline instantly times out every spawn`);
    const concurrency = opts.concurrency ?? 8;
    if (!Number.isFinite(concurrency) || concurrency < 1)
      throw new Error(`concurrency must be >= 1 (got ${concurrency}) — a zero-slot semaphore hangs the first acquire forever`);
    this.baseEnv = opts.env ?? process.env;
    this.bins = opts.binPaths ?? {
      gh: whichIn(this.baseEnv, "gh"),
      git: whichIn(this.baseEnv, "git"),
      tar: whichIn(this.baseEnv, "tar"),
    };
    this.ghEnv = buildGhEnv(this.baseEnv, this.githubHost);
    // PROMPT-TUI §U3.2: the waiter gauge. Both clients (preflight + scan) report their OWN
    // semaphore's queue depth through the one hub — each emission overwrites the scalar, and it
    // stays truthful because the clients' lifetimes are SEQUENTIAL (preflight completes before
    // the scan client works), so at any moment the gauge is the sole live semaphore's depth;
    // emitProgress never throws.
    this.sem = new Semaphore(concurrency, (waiting) => {
      if (hasProgressSink()) emitProgress({ type: "spawn-queue", waiting });
    });
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
    tool: SpawnTool,
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
    // PROMPT-TUI §U3.1: ONE span per attempt through the one funnel every gh/git/tar spawn flows
    // through (preflight and plan included). Synchronous, O(1), no-throw; label construction is
    // gated behind the sink check (§U0 — a bare run pays only this boolean).
    let spanId = 0;
    if (hasProgressSink()) {
      spanId = nextProgressId();
      emitProgress({ type: "spawn-start", id: spanId, tool, label: spawnLabel(tool, args) });
    }
    try {
      const spawned = this.spawn(bin, args, { ...opts, signal });
      // the settle observer doubles as the no-op catch (a late rejection is never unhandled)
      // AND records any rejection so the timeout branch can prefer the real diagnostic.
      let spawnRejected = false;
      let spawnRejection: unknown;
      const settled = spawned.then(
        () => undefined,
        (e: unknown) => {
          spawnRejected = true;
          spawnRejection = e;
        },
      );
      await Promise.race([settled, deadline]);
      // the flag (not race order) decides: a kill that settles the spawn in the same tick as
      // the deadline must still be reported as a timeout, not as the child's own exit.
      if (!timedOut) return spawned;
      const gaveUp = new Promise<void>((resolve) => {
        settleTimer = setTimeout(resolve, SPAWN_KILL_GRACE_MS + 1_000);
      });
      await Promise.race([settled, gaveUp]);
      // A rejection that settled the spawn is a REAL diagnostic (byte cap, stream failure) —
      // it must win over the synthetic timeout even when the deadline fired during the
      // hold-until-exit window: a synthetic 124 would misclassify it as a transient
      // no-response and re-drive the oversized request through every retry.
      if (spawnRejected) throw spawnRejection;
      return { exitCode: 124, stdout: "", stderr: `spawn timed out after ${this.spawnTimeoutMs}ms: ${bin}` };
    } finally {
      clearTimeout(timer);
      clearTimeout(settleTimer);
      // deadline timeouts and byte-cap kills still end their span (finally-scoped); the sink
      // gate keeps even the end-event allocation off a post-degrade path (§U0)
      if (spanId !== 0 && hasProgressSink()) emitProgress({ type: "spawn-end", id: spanId });
    }
  }

  // ---- guarded low-level spawns (the §6 chokepoint) ----
  // EVERY guarded subprocess — gh (incl. direct preflight `gh auth status`/`gh --version`), git
  // (clone), and tar (extract) — acquires the GLOBAL semaphore so §4's "cap TOTAL in-flight
  // subprocesses" holds for every path. `gh()` is the BARE form (no rate-limit bucket): it counts
  // against the cap but is not pause-aware. The pause-aware, bucketed path is ghBucketedAttempt
  // below (restGet/graphql), which arms any throttle pause INSIDE the lease so the slot is never
  // released into an about-to-open pause window.
  async gh(args: string[]): Promise<SpawnResult> {
    assertSpawnAllowed(this.bins.gh, args);
    assertReadOnlyGh(args);
    const release = await this.sem.acquire();
    try {
      return await this.spawnBounded("gh", this.bins.gh, args, { env: this.ghEnv });
    } finally {
      release();
    }
  }

  // ONE guarded, pause-aware gh attempt against a rate-limit bucket (the core of restGet/graphql's
  // retry loops). Acquire the slot waiting out any live pause → spawn → run the caller's PURE
  // `analyze` → ARM any throttle pause it reports, ALL before releasing the slot. Arm-before-release
  // is load-bearing under fan-out: with the old release-then-classify-then-arm order a queued caller
  // could inherit the freed slot and spawn straight into the window the first caller was about to
  // publish (§4 admission race). `analyze` is synchronous, so nothing yields between spawn, arm, and
  // release; `now` is read ONCE and shared by analyze's classification and the arm so both agree on
  // the clock. Returns analyze's control-flow outcome for the caller's loop to act on OUTSIDE the
  // lease (DB writes, transient backoff sleeps, return/throw).
  //
  // ATOMIC ADMISSION: acquireRespectingPause re-checks the pause AFTER acquiring the slot, but it
  // returns the release across an `await` — i.e. a MICROTASK boundary — so a SIBLING fiber holding a
  // DIFFERENT slot (concurrency ≥ 2) can armBucketPause in the gap between that check and the spawn
  // below, and this fiber would spawn straight INTO a just-armed rate-limit window (the arm-inside-
  // lease discipline only closes SAME-slot inheritance, not this different-slot post-check window).
  // The final re-check here is therefore SYNCHRONOUS and in the SAME tick as the spawn: spawnBounded
  // invokes this.spawn() synchronously before its first await, so with NO await between the re-check
  // and spawnBounded nothing can interleave to arm a pause. A pause seen live releases the slot and
  // re-loops (waitBucket sleeps it out, or ThrottleExhausted terminates the loop for an unfunded
  // budget-overflow tail — so the loop always makes progress).
  // Analyze contract extension (PROMPT-TUI §U3.3): the closures stay PURE and return DATA only —
  // `rateLimitHeaders` is the headers object each closure ALREADY parsed (a reference, zero new
  // allocation; omitted on the no-response path). ghBucketedAttempt — already impure — derives
  // and emits the rate-limit snapshot, gated on hasProgressSink(), inside the lease.
  private async ghBucketedAttempt<T>(
    args: string[], bucket: Bucket,
    analyze: (res: SpawnResult, now: number) => { outcome: T; pauseUntilMs: number | null; rateLimitHeaders?: Record<string, string> },
  ): Promise<T> {
    assertSpawnAllowed(this.bins.gh, args);
    assertReadOnlyGh(args);
    for (;;) {
      const release = await this.acquireRespectingPause(bucket);
      if (bucket.pausedUntilMs > this.now()) {
        release(); // a pause armed in the acquire→spawn gap — wait it out without holding the slot
        continue;  // re-loop: acquireRespectingPause sleeps the window, re-acquires, re-checks
      }
      try {
        const res = await this.spawnBounded("gh", this.bins.gh, args, { env: this.ghEnv });
        const now = this.now();
        const { outcome, pauseUntilMs, rateLimitHeaders } = analyze(res, now);
        // `!== null`/`!== undefined` on purpose, never truthiness: a zero-valued injected horizon
        // must not change the contract, and an empty headers object is still a live response.
        if (pauseUntilMs !== null) this.armBucketPause(bucket, pauseUntilMs, now);
        if (rateLimitHeaders !== undefined && hasProgressSink()) {
          emitProgress({
            type: "rate-limit",
            resource: bucket.label,
            remaining: headerInt(rateLimitHeaders["x-ratelimit-remaining"]),
            limit: headerInt(rateLimitHeaders["x-ratelimit-limit"]),
            resetEpochSec: headerInt(rateLimitHeaders["x-ratelimit-reset"]),
          });
        }
        return outcome;
      } finally {
        release();
      }
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
    // Count the clone against the GLOBAL in-flight cap (§4/§5.6): under fan-out a clone per branch-unit
    // would otherwise reach the composed organizations×branches degree and blow temp-dir/fd/memory.
    // Acquire HERE (not inside spawnBounded, which gh already wraps — a second acquire there would
    // deadlock gh at concurrency 1). Bare slot (no bucket): a clone is network work but consumes no
    // REST/GraphQL quota, so it sits OUTSIDE the rate-limit buckets — only the subprocess cap bounds it.
    const release = await this.sem.acquire();
    try {
      return await this.spawnBounded("git", this.bins.git, args, { env, cwd });
    } finally {
      release();
    }
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
    // Count the extraction against the GLOBAL in-flight cap (§4/§5.6), same as git — acquire once at
    // this level, never inside spawnBounded (gh already wraps it → double-acquire deadlock at 1).
    const release = await this.sem.acquire();
    try {
      return await this.spawnBounded("tar", this.bins.tar, args, { env: buildTarEnv(this.baseEnv) });
    } finally {
      release();
    }
  }

  // ---- REST GET with cache + throttle handling ----
  private cacheKey(endpoint: string): string {
    // KEY EPOCH `gh3`: rows are statusless and survive --fresh, so every strengthening of cache
    // WRITE provenance quarantines all older rows by making their keys unreachable (--purge-cache
    // reclaims the dead rows; the cost is a one-time refetch). gh:→gh2: closed rows written
    // before the exact-200 persist gate (any ok-classified 2xx body, e.g. a 206, could ride the
    // immutable/304 hits' synthesized 200 into the unvalidated raw consumers). gh2:→gh3: closed
    // rows written before the truncated-transfer exit gate (a parsed 200 from a FAILED gh
    // process could persist a mid-stream-cut body — same laundering, worse provenance). The
    // epoch lives in the PREFIX itself (next bump gh4:) because githubHost accepts host:port
    // and numeric hosts — an epoch spelled INSIDE the old `gh:` namespace could collide with a
    // legacy key across a host transition (`gh:200.1:443:` = legacy host "200.1:443" = current
    // host "443"). Every legacy key starts with the literal `gh:` or `gh2:`, and no string can
    // inhabit two of these grammars (they disagree at index 2: ':', '2', '3'). Bump whenever
    // cache WRITE-provenance guarantees change in a way reads rely on.
    return `gh3:${this.githubHost}:${endpoint}`; // host-scoped; never a hand-built API hostname
  }

  private async waitBucket(bucket: Bucket): Promise<void> {
    const wait = bucket.pausedUntilMs - this.now();
    if (wait <= 0) return; // no active pause
    // WALL-CLOCK budget (the single chokepoint every throttle pause sleeps through): sleep only
    // within the FUNDED horizon. A pause published BEYOND accountedUntilMs is the budget-overflow
    // tail that armBucketPause could not fund — fail EARLY here rather than sleep past
    // MAX_TOTAL_PAUSE_MS. Crucially, N concurrent callers all sleeping this ONE window is correct:
    // the window's wall-clock cost was charged ONCE when it was armed (the union tail), not once per
    // sleeper — fixing the old per-caller ledger that tripped the budget N× too early for the
    // concurrent caller this feature adds.
    if (bucket.pausedUntilMs > bucket.accountedUntilMs) {
      // reason "budget": the cumulative pause budget is spent — a RUN-level condition (PROMPT-TUI
      // §U3.4; the store's sticky flag), distinct from a single call's retries running out.
      this.emitThrottle(bucket, "exhausted", "budget");
      throw new ThrottleExhausted(`${bucket.label} bucket (cumulative pause budget ${MAX_TOTAL_PAUSE_MS}ms exceeded)`);
    }
    this.emitThrottle(bucket, "waiting"); // with the horizon it is about to sleep to
    await this.sleep(wait); // semaphore NOT held while sleeping
  }

  // Throttle-state display events (PROMPT-TUI §U3.4): synchronous, no-throw, fully gated — a run
  // with no sink pays one boolean. The event carries the PUBLISHED horizon and the CURRENT
  // (post-funding, for the armed emit) budget.
  private emitThrottle(bucket: Bucket, state: "armed" | "waiting" | "exhausted", reason?: "budget" | "retries"): void {
    if (!hasProgressSink()) return;
    emitProgress({
      type: "throttle",
      bucket: bucket.label,
      state,
      ...(reason !== undefined ? { reason } : {}),
      untilMs: bucket.pausedUntilMs > 0 ? bucket.pausedUntilMs : null,
      budgetSpentMs: bucket.budgetSpentMs,
    });
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

  // Arm a throttle pause on the bucket, WALL-CLOCK-budgeted for concurrent callers. Two things run
  // here, both under the caller's semaphore lease (ghBucketedAttempt), so a queued caller cannot
  // spawn between them:
  //   1. PUBLISH the window (pausedUntilMs = max) UNCONDITIONALLY — even the final attempt's pause
  //      (which the caller is about to ThrottleExhausted on) and even a budget-overflow pause. Under
  //      fan-out the final/overflow pause is bucket-global evidence every OTHER concurrent caller
  //      must see; the exhausted caller simply throws without sleeping it (its loop ends / waitBucket
  //      trips), but siblings must not spawn into a live rate-limit window.
  //   2. FUND only the uncovered UNION TAIL: delta = max(0, published horizon (pausedUntilMs) −
  //      max(now, accountedUntilMs)) — the horizon, NOT this candidate's raw untilMs (see the funding
  //      comment below for why). Two callers arming the SAME window charge it once WHEN it was funded
  //      (the second sees delta 0); if the first publication overflowed the budget the horizon is left
  //      unfunded, and a later arm re-computes the tail against the CURRENT now: while that tail still
  //      exceeds the remaining budget it re-overflows and funds nothing, but as now advances toward the
  //      horizon the tail shrinks, so once it fits a later arm DOES fund it (and waitBucket then sleeps
  //      it). If funding the tail
  //      would exceed MAX_TOTAL_PAUSE_MS, publish the pause but do NOT advance accountedUntilMs — the
  //      tail stays unfunded and waitBucket throws ThrottleExhausted for it instead of over-sleeping.
  // SINGLE-EXIT (PROMPT-TUI §U3.4): the early returns became one try/finally so the armed event
  // is emitted exactly ONCE per arm — after the horizon publish AND the funding logic — carrying
  // the published horizon and the POST-funding budgetSpentMs (the displayed budget is never one
  // arm behind), for funded, already-funded, and unfunded-overflow arms alike.
  private armBucketPause(bucket: Bucket, untilMs: number, now: number): void {
    try {
      bucket.pausedUntilMs = Math.max(bucket.pausedUntilMs, untilMs);
      // Fund toward the PUBLISHED horizon (pausedUntilMs), not this candidate's raw untilMs. Every
      // caller sleeps to pausedUntilMs — or throws — so that horizon is the only wall-clock a charge can
      // buy. Charging raw untilMs let a SHORTER pause arriving under an already-published-but-UNFUNDED
      // longer tail spend budget on coverage no caller ever sleeps (waitBucket throws for the WHOLE
      // window while the tail is unfunded): a phantom charge that, under fan-out where sibling callers
      // arm the shared bucket out of order, could drain the budget for time never actually paused.
      // Targeting the horizon also keeps the two invariants intact: N callers arming the SAME window
      // charge it once (the second sees delta 0), and an already-unfundable horizon stays unfunded WHILE
      // its tail exceeds the remaining budget (the delta re-overflows) — until enough wall-clock elapses
      // that the shrunken (horizon − now) tail fits, when a later arm funds it.
      const horizon = bucket.pausedUntilMs;
      const delta = Math.max(0, horizon - Math.max(now, bucket.accountedUntilMs));
      if (delta === 0) return; // horizon already funded or entirely in the past — nothing new to charge
      if (bucket.budgetSpentMs + delta > MAX_TOTAL_PAUSE_MS) return; // overflow: published, unfunded tail
      bucket.budgetSpentMs += delta;
      bucket.accountedUntilMs = horizon;
    } finally {
      this.emitThrottle(bucket, "armed");
    }
  }

  // MUST stay PURE (no state, no jitter, no counters): it is evaluated inside analyze closures whose
  // result may be discarded, and a side effect here would silently perturb the budget.
  private backoffWait(kind: "secondary" | "transient", attempt: number, waitMs: number | null): number {
    if (waitMs !== null) return waitMs;
    const base = kind === "secondary" ? SECONDARY_BASE_WAIT_MS : TRANSIENT_BASE_WAIT_MS;
    return base * 2 ** attempt;
  }

  // One REST GET. `immutable: true` (commit/tree/blob-SHA-pinned URLs) serves a cached body
  // with ZERO network request (§3); otherwise a cached ETag rides as If-None-Match and gh's
  // non-zero-exit 304 is a cache HIT. `noStore: true` OVERRIDES both — it disables the cache read
  // (so neither the immutable hit nor the If-None-Match/304 path can fire) and the persist, so a
  // `{ immutable, noStore }` combination resolves to a plain uncached fetch (noStore wins).
  // CONTRACT: a resolved response always has status EXACTLY 200 — direct (classifyRest fails
  // every non-200 2xx closed) or cache-synthesized (both cache-serving paths fabricate 200).
  // Consumers (fetchFileRaw/fetchBlobRaw/restGetJson/restGetPagedArray) rely on this and do
  // not re-check status; an endpoint with genuine 202/204 semantics must get its own handler.
  // An endpoint is only genuinely IMMUTABLE if it pins a git object id — a blob/tree SHA in
  // the path or a sha-shaped `?ref=`. This is defense-in-depth over the callers' own isSha
  // gate: a caller can never zero-network-freeze a mutable branch/tag URL by passing immutable.
  private static endpointIsShaPinned(endpoint: string): boolean {
    const [path, query = ""] = endpoint.split("?");
    if (/\/git\/(blobs|trees)\/[0-9a-f]{40}([0-9a-f]{24})?(\/|$)/i.test(path ?? "")) return true;
    const ref = new URLSearchParams(query).get("ref") ?? "";
    return HEX_OBJECT_ID_RE.test(ref); // same as isSha — a sha-shaped ?ref= pins an immutable object
  }

  async restGet(endpoint: string, opts: { accept?: string; immutable?: boolean; noStore?: boolean } = {}): Promise<HttpResponse> {
    const accept = opts.accept ?? "";
    const immutable = opts.immutable === true && GithubClient.endpointIsShaPinned(endpoint);
    const key = this.cacheKey(endpoint);
    // `noStore` fully opts OUT of the conditional cache: no read, no If-None-Match, no persist. The
    // cache stores body+ETag but NOT the Link header, so a paginated page served from a 304 that
    // omits Link would make restGetPagedArray stop early and silently under-report the listing — a
    // cache the caller cannot use correctly must not be used at all (§5.A completeness).
    const noStore = opts.noStore === true;
    const cached = noStore ? null : (this.db?.getApiCache("GET", key, accept) ?? null);
    if (immutable && cached !== null && cached.responseBody !== null)
      return { status: 200, headers: {}, body: cached.responseBody };

    const args = ["api", "-i", endpoint];
    if (accept !== "") args.push("-H", `Accept: ${accept}`);
    if (cached?.etag != null && cached.responseBody !== null) args.push("-H", `If-None-Match: ${cached.etag}`);

    // Each attempt spawns under the core bucket's lease and classifies + arms any throttle pause
    // INSIDE that lease (ghBucketedAttempt), so a queued fan-out caller can never inherit the freed
    // slot and spawn into the window this attempt just discovered. The caller acts on the returned
    // outcome OUTSIDE the lease (DB writes, transient backoff sleeps, return/throw). A `retry`
    // outcome means a pause was already armed — the NEXT attempt's acquire waits it out (or throws
    // ThrottleExhausted if it is an unfunded budget-overflow tail; the final attempt likewise falls
    // through to the throw below without sleeping the pause it published for its siblings).
    type RestOutcome =
      | { kind: "ok"; parsed: HttpResponse }
      | { kind: "not-modified"; headers: Record<string, string>; body: string }
      | { kind: "fatal"; status: number; ssoRequired: boolean; message: string }
      | { kind: "no-response"; stderr: string }
      | { kind: "truncated"; exitCode: number; stderr: string }
      | { kind: "retry" };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const outcome = await this.ghBucketedAttempt<RestOutcome>(args, this.core, (res, now) => {
        const parsed = parseGhApiOutput(res.stdout);
        // no HTTP response at all (network/auth plumbing failure; diagnostics on stderr) — the ONE
        // path with no rateLimitHeaders: no response happened, so there is no snapshot to report.
        if (parsed.status === 0) return { outcome: { kind: "no-response", stderr: res.stderr }, pauseUntilMs: null };
        // Every other branch is a LIVE response with live headers — its snapshot rides the return
        // as a reference (PROMPT-TUI §U3.3; purity intact, zero new allocation). The zero-network
        // immutable-cache return above this loop never gets here and emits nothing; a 304
        // revalidation IS a live response, snapshot included.
        if (parsed.status === 304 && cached !== null && cached.responseBody !== null)
          return { outcome: { kind: "not-modified", headers: parsed.headers, body: cached.responseBody }, pauseUntilMs: null, rateLimitHeaders: parsed.headers };
        // A parsed SUCCESS from a FAILED gh process is untrustworthy: gh api -i streams the body
        // AFTER the header block, so a mid-body transport cut leaves a well-formed 200 head + a
        // TRUNCATED body + a nonzero exit — invisible to every status gate. HTTP-error statuses also
        // arrive nonzero BY DESIGN (gh exits 1 on 4xx/5xx and on the 304 hit above) and classify
        // normally below; only a 200-with-nonzero-exit is the truncation shape. Same transient class
        // as no-response: retry, then surface stderr.
        if (parsed.status === 200 && res.exitCode !== 0)
          return { outcome: { kind: "truncated", exitCode: res.exitCode, stderr: res.stderr }, pauseUntilMs: null, rateLimitHeaders: parsed.headers };
        const cls = classifyRest(parsed.status, parsed.headers, parsed.body, now);
        if (cls.kind === "ok") return { outcome: { kind: "ok", parsed }, pauseUntilMs: null, rateLimitHeaders: parsed.headers };
        if (cls.kind === "fatal") return { outcome: { kind: "fatal", status: cls.status, ssoRequired: cls.ssoRequired, message: cls.message }, pauseUntilMs: null, rateLimitHeaders: parsed.headers };
        // primary → pause until the reset epoch; secondary/transient → now + backoff. Arming from
        // this pauseUntilMs happens inside the lease (ghBucketedAttempt), before the slot is released.
        const pauseUntilMs = cls.kind === "primary" ? cls.untilMs : now + this.backoffWait(cls.kind, attempt, cls.kind === "secondary" ? cls.waitMs : null);
        return { outcome: { kind: "retry" }, pauseUntilMs, rateLimitHeaders: parsed.headers };
      });
      if (outcome.kind === "no-response") {
        if (attempt < MAX_ATTEMPTS - 1) { await this.sleep(this.backoffWait("transient", attempt, null)); continue; }
        throw new GithubApiError(`gh api produced no HTTP response: ${outcome.stderr.trim().slice(0, 300)}`, { endpoint });
      }
      if (outcome.kind === "not-modified") {
        // A 304 means the cached row is still valid — it ALREADY holds this exact body+etag (the
        // If-None-Match we sent was read FROM it), so re-persisting it is pure redundancy. Skipping it
        // also removes the one shared-row cache write that would span the network await: a delayed 304
        // (old body/etag) rewriting the row could clobber a NEWER 200 a concurrent fiber wrote to the
        // same key. Today every fan-out cache key is SHA-pinned immutable (a clobber would be
        // byte-identical anyway), but keeping the cache RMW await-free holds even if a future
        // mutable+cached endpoint is ever fetched under fan-out. The served body is unchanged.
        return { status: 200, headers: outcome.headers, body: outcome.body };
      }
      if (outcome.kind === "truncated") {
        if (attempt < MAX_ATTEMPTS - 1) { await this.sleep(this.backoffWait("transient", attempt, null)); continue; }
        throw new GithubApiError(`gh exited ${outcome.exitCode} with an HTTP 200 response — the body may be truncated: ${outcome.stderr.trim().slice(0, 300)}`, { endpoint });
      }
      if (outcome.kind === "ok") {
        // Persist ONLY an exact-200 body (defense-in-depth over classifyRest's ok⇒200): both
        // cache-serving paths synthesize 200, so laundering any other 2xx into the cache would make
        // it a 'complete' 200 forever for SHA-pinned endpoints. Cache write provenance is a durable
        // invariant (rows are statusless and outlive --fresh), so it must hold locally. IMMUTABLE
        // (SHA-pinned) endpoints use the GUARDED put: this body is persisted BEFORE validation, so
        // under fan-out an unconditional overwrite could clobber a sibling's already-cached VALID body
        // of the same byte-stable SHA with a malformed transient. putApiCacheImmutable refuses to
        // overwrite a non-null DIFFERENT body (writing only absent/NULL/identical); the compare-and-
        // delete tombstone guards the other half. Mutable endpoints keep the unconditional put (a newer
        // 200 legitimately supersedes the old body).
        if (outcome.parsed.status === 200 && !noStore) {
          const entry = { method: "GET" as const, url: key, variantHash: accept, etag: outcome.parsed.headers["etag"] ?? null, responseBody: outcome.parsed.body };
          if (immutable) this.db?.putApiCacheImmutable(entry);
          else this.db?.putApiCache(entry);
        }
        return outcome.parsed;
      }
      if (outcome.kind === "fatal")
        throw new GithubApiError(`${outcome.message} (${endpoint})`, { status: outcome.status, endpoint, ssoRequired: outcome.ssoRequired });
      // outcome.kind === "retry": pause already armed inside the lease; loop again (next acquire waits it out).
    }
    this.emitThrottle(this.core, "exhausted", "retries"); // ONE call gave up (MAX_ATTEMPTS)
    throw new ThrottleExhausted(endpoint);
  }

  async restGetJson(endpoint: string, opts: { immutable?: boolean } = {}): Promise<unknown> {
    const res = await this.restGet(endpoint, { immutable: opts.immutable });
    try {
      return JSON.parse(res.body);
    } catch {
      this.tombstoneApiCache(endpoint, "", res.body); // the unparseable body was cached before we could see it
      throw new GithubApiError(`invalid JSON from ${endpoint}`, { status: res.status, endpoint });
    }
  }

  // A 200 body is cached by restGet before endpoint-level validation runs. When validation then
  // rejects it, null the row's body: both cache-serving paths (the immutable hit and the 304
  // If-None-Match revalidation) require a non-null cached body, so the next call goes back to the
  // network instead of re-serving the poisoned bytes until --purge-cache. The accept variant must
  // match the fetch that cached the row — a mismatched variant would tombstone the wrong row and
  // leave the poisoned one live. COMPARE-AND-DELETE: pass the exact bytes this fiber read as
  // malformed (`expectedBody`) so the null lands ONLY if that body is still stored — under fan-out
  // two fibers share the SAME immutable-SHA row, and a malformed-transient tombstone must not clobber
  // a sibling's newer VALID write of the same SHA (see db.tombstoneApiCacheIfBody).
  private tombstoneApiCache(endpoint: string, accept: string, expectedBody: string): void {
    this.db?.tombstoneApiCacheIfBody({ method: "GET", url: this.cacheKey(endpoint), variantHash: accept, expectedBody });
  }

  // TS pagination (§5.A): per-page `gh api -i`, follow Link rel="next" (host-verified,
  // recomposed relative) until absent, accumulating array pages. Pages are fetched with
  // `noStore` — the conditional cache preserves body+ETag but NOT the Link header, so a cached
  // page whose 304 revalidation omits Link would silently truncate the listing. With noStore a
  // paginated fetch never creates, overwrites, OR consumes a cache row (a pre-existing row from an
  // earlier version simply stays, unread), so it can neither be poisoned by nor poison the cache.
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
      const res = await this.restGet(ep, { noStore: true });
      let page: unknown;
      try {
        page = JSON.parse(res.body);
      } catch {
        throw new GithubApiError(`invalid JSON page from ${ep}`, { status: res.status, endpoint: ep });
      }
      if (!Array.isArray(page)) throw new GithubApiError(`expected a JSON array page from ${ep}`, { endpoint: ep });
      for (const item of page) acc.push(item); // iterative, not acc.push(...page): a huge page would blow the arg limit
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

    // Same lease discipline as restGet: spawn + classify + arm inside ghBucketedAttempt so a queued
    // caller never spawns into an about-to-open pause. GraphQL classification reads the HTTP-200 BODY
    // (RATE_LIMITED lives there, not just in headers), so parseGraphqlEnvelope + classifyGraphql run
    // INSIDE the lease; the ok-branch post-checks (exact-200, malformed-envelope) run in the caller.
    type GqlOutcome =
      | { kind: "ok"; data: unknown; malformed: string | null; status: number; exitCode: number; stderr: string }
      | { kind: "fatal"; status: number; ssoRequired: boolean; message: string }
      | { kind: "no-response"; stderr: string }
      | { kind: "retry" };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const outcome = await this.ghBucketedAttempt<GqlOutcome>(args, this.graphqlBucket, (res, now) => {
        const parsed = parseGhApiOutput(res.stdout);
        // no-response omits rateLimitHeaders (no response happened); every parsed response below
        // rides its already-parsed headers out as a reference (PROMPT-TUI §U3.3).
        if (parsed.status === 0) return { outcome: { kind: "no-response", stderr: res.stderr }, pauseUntilMs: null };
        // DELIBERATELY no broad restGet-style nonzero-exit truncation guard: gh exits 1 BY DESIGN after
        // a COMPLETE HTTP-200 envelope whose body carries `errors` (incl. genuine RATE_LIMITED), so a
        // nonzero exit under a parsed 200 is the NORMAL semantic-error shape, not truncation (a broad
        // guard would blind-retry real throttles). classifyGraphql runs FIRST on whatever error
        // evidence WAS readable: status/header semantics (5xx, throttle, SSO-fatal) are never
        // downgraded by a malformed body — malformation (and a 2xx-non-200 status) only preempts the
        // SUCCESS path, which the caller handles. Coercing a malformed envelope to "no errors" would be
        // fail-OPEN (an ok branch-discovery feeds the reconcile PRUNE), so it is surfaced, never eaten.
        const env = parseGraphqlEnvelope(parsed.body);
        const cls = classifyGraphql(parsed.status, parsed.headers, env.errors, now);
        if (cls.kind === "ok")
          return { outcome: { kind: "ok", data: env.data, malformed: env.malformed, status: parsed.status, exitCode: res.exitCode, stderr: res.stderr }, pauseUntilMs: null, rateLimitHeaders: parsed.headers };
        if (cls.kind === "fatal") return { outcome: { kind: "fatal", status: cls.status, ssoRequired: cls.ssoRequired, message: cls.message }, pauseUntilMs: null, rateLimitHeaders: parsed.headers };
        const pauseUntilMs = cls.kind === "primary" ? cls.untilMs : now + this.backoffWait(cls.kind, attempt, cls.kind === "secondary" ? cls.waitMs : null);
        return { outcome: { kind: "retry" }, pauseUntilMs, rateLimitHeaders: parsed.headers };
      });
      if (outcome.kind === "no-response") {
        if (attempt < MAX_ATTEMPTS - 1) { await this.sleep(this.backoffWait("transient", attempt, null)); continue; }
        throw new GithubApiError(`gh api graphql produced no HTTP response: ${outcome.stderr.trim().slice(0, 300)}`, { endpoint: "graphql" });
      }
      if (outcome.kind === "fatal")
        throw new GithubApiError(`graphql: ${outcome.message}`, { status: outcome.status, endpoint: "graphql", ssoRequired: outcome.ssoRequired });
      if (outcome.kind === "ok") {
        if (outcome.status !== 200)
          throw new GithubApiError(`graphql envelope: HTTP ${outcome.status} — only exactly 200 is success`, { status: outcome.status, endpoint: "graphql" });
        if (outcome.malformed !== null) {
          // A truncated transport leaves a well-formed HTTP-200 head + an unparseable body + a NONZERO
          // exit — a transient read failure, retried under the bounded transient budget. Scoped to
          // exactly that shape so a COMPLETE errors envelope (parses fine → malformed===null) is never
          // blind-retried; every other malformed reason is a real spec violation → fatal.
          if (outcome.malformed === "unparseable JSON body" && outcome.exitCode !== 0 && attempt < MAX_ATTEMPTS - 1) {
            await this.sleep(this.backoffWait("transient", attempt, null));
            continue;
          }
          throw new GithubApiError(
            `graphql envelope: ${outcome.malformed}${outcome.exitCode !== 0 ? ` (gh exit ${outcome.exitCode}: ${outcome.stderr.trim().slice(0, 300)})` : ""} — refusing to treat the response as success`,
            { status: outcome.status, endpoint: "graphql" },
          );
        }
        return outcome.data;
      }
      // outcome.kind === "retry": pause already armed inside the lease; loop again (next acquire waits it out).
    }
    this.emitThrottle(this.graphqlBucket, "exhausted", "retries"); // ONE call gave up (MAX_ATTEMPTS)
    throw new ThrottleExhausted("graphql");
  }

  // ---- discovery (§5.A / §5.B) ----
  // Map a flattened repo listing to validated RepoInfo, rejecting DUPLICATE (owner, name) identities:
  // a repeated repo (a pagination artifact when the listing shifts between pages, or a hostile row)
  // would take a maxReposPerOrg cap slot and silently drop a DISTINCT repo — a silent under-report,
  // the same hazard parseTreeResponse guards against for duplicate tree paths.
  private mapRepoPage(raw: unknown[], endpoint: string, expectedOwner: string): RepoInfo[] {
    const seen = new Set<string>();
    return raw.map((r, i) => {
      const repo = mapRestRepo(r, endpoint, i, expectedOwner);
      const key = JSON.stringify([repo.organization.toLowerCase(), repo.name.toLowerCase()]); // collision-proof tuple key (no separator ambiguity)
      if (seen.has(key)) throw new GithubApiError(`duplicate repo ${repo.organization}/${repo.name} in listing at index ${i}`, { endpoint });
      seen.add(key);
      return repo;
    });
  }

  async listOrgRepos(org: string): Promise<RepoInfo[]> {
    const raw = await this.restGetPagedArray(`orgs/${encodeURIComponent(org)}/repos?per_page=100&page=1&type=all`);
    return this.mapRepoPage(raw, `orgs/${org}/repos`, org);
  }

  // `user/repos?affiliation=owner` returns repos owned by the AUTHENTICATED user, so the caller's
  // known personal login is the expected owner — validate it too (a foreign-owner row would redirect
  // the personal scan / take a cap slot, exactly as for an org listing).
  async listUserRepos(expectedOwner: string): Promise<RepoInfo[]> {
    const raw = await this.restGetPagedArray(`user/repos?affiliation=owner&per_page=100&page=1`);
    return this.mapRepoPage(raw, "user/repos", expectedOwner);
  }

  async listOrgMemberships(): Promise<string[]> {
    const raw = await this.restGetPagedArray(`user/orgs?per_page=100&page=1`);
    // Fail LOUD on any malformed entry — the old `String(o.login ?? "")` + `.filter(s => s !== "")`
    // silently dropped a missing/empty/null login and string-COERCED a non-string one into a
    // fabricated org, either way understating or corrupting the discovered org set (§5.A). Same
    // fail-closed posture as listBranchHeads' malformed-node throw.
    return raw.map((o, i) => {
      if (!isObject(o)) throw new GithubApiError(`malformed org membership at index ${i}: not an object`, { endpoint: "user/orgs" });
      const login = o["login"];
      if (typeof login !== "string" || login.length === 0)
        throw new GithubApiError(`malformed org membership at index ${i}: missing, empty, or non-string login`, { endpoint: "user/orgs" });
      // No cross-owner check guards this listing (it PRODUCES the org set), so a "." / ".." / separator
      // / control-char login must be rejected here or it becomes a fabricated owner steering every scan.
      if (!isCanonicalIdentity(login))
        throw new GithubApiError(`malformed org membership at index ${i}: login is not a canonical identity segment`, { endpoint: "user/orgs" });
      return login;
    });
  }

  // §5.B: enumerate ALL ref pages (RefOrderField cannot order heads by commit date), then sort
  // committedDate DESC client-side. Cutoff filtering/capping is the orchestrator's job.
  //
  // `defaultBranchRef{name}` rides the ALREADY-queried `repository` node — no extra request, no extra
  // rate-limit cost — so the default branch is resolved from the SAME snapshot as the heads rather than
  // from the far older REST listing (see RepoInfo's note: a default renamed in that window would let a
  // restrictive policy silently exclude the repo's real default). This is the ONLY producer of the
  // default-branch name.
  async listBranchHeads(org: string, repo: string): Promise<BranchSnapshot> {
    const query =
      "query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){defaultBranchRef{name}refs(refPrefix:\"refs/heads/\",first:100,after:$endCursor){pageInfo{hasNextPage endCursor}nodes{name target{...on Commit{oid committedDate tree{oid}}}}}}}";
    const heads: BranchHead[] = [];
    // The default branch as of PAGE 1, then re-asserted identical on every later page. `undefined` = no
    // page read yet (distinct from a read `null`, which legitimately means "repo has no default").
    let defaultBranch: string | null | undefined = undefined;
    // same poisoned-pagination bound as restGetPagedArray: a response controls the next
    // cursor, so a repeated or endless cursor chain must fail closed, not loop unbounded.
    const seenCursors = new Set<string>();
    // FAIL-CLOSED completeness (load-bearing for run_unit_head reconciliation, which prunes rows
    // for branches ABSENT from this set): the returned name set must be the COMPLETE, exact branch
    // list. A silently-dropped node or a silently-truncated pagination would understate it and delete
    // a live branch's row. So a malformed node, a missing/non-boolean hasNextPage, a hasNextPage=true
    // with no follow-up cursor, or a duplicate name across pages all THROW (→ discovery 'failed' →
    // the repo is retained, never reconciled) rather than returning a partial list. The guarantee is
    // STRUCTURAL — every page followed to hasNextPage:false, every node well-formed. It rests on
    // GitHub's own pagination contract (hasNextPage:false ⇒ no more refs); a hypothetical GitHub-side
    // bug returning hasNextPage:false while omitting a live ref is outside this guard (and, if it ever
    // occurred, is transient and self-healing — findings persist and the next run re-discovers).
    const seenNames = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      // loop-top cap = at most MAX_PAGES fetches, the same semantics as restGetPagedArray
      // (seenCursors holds one cursor per follow-up, so size = pages already fetched - 1).
      if (seenCursors.size >= MAX_PAGES)
        throw new GithubApiError(`refs pagination exceeded ${MAX_PAGES} pages for ${org}/${repo}`, { endpoint: "graphql" });
      const fields: Record<string, string> = { owner: org, name: repo };
      if (cursor !== null) fields["endCursor"] = cursor; // omit entirely on the first page (§5.B)
      const data = (await this.graphql(query, fields)) as {
        repository?: {
          defaultBranchRef?: { name?: unknown } | null;
          refs?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: unknown[] };
        } | null;
      } | null;
      const repository = data?.repository;
      const refs = repository?.refs;
      if (refs === undefined || refs === null)
        throw new GithubApiError(`graphql returned no refs for ${org}/${repo}`, { endpoint: "graphql" });
      // --- default-branch resolution, fail-closed and page-consistent -------------------------------
      // ABSENT vs NULL are different failures and must not be conflated. We ASKED for the field, so a
      // clean 200 that omits it entirely is structurally malformed (stale fixture, proxy, or schema
      // drift) — a real permission/schema error would have surfaced in GraphQL `errors` and been
      // rejected by this.graphql() already. Object.hasOwn (not `in`) states the wire contract exactly:
      // an own property, not one inherited from a prototype.
      if (repository === undefined || repository === null || !Object.hasOwn(repository, "defaultBranchRef"))
        throw new GithubApiError(`refs page omits defaultBranchRef for ${org}/${repo}`, { endpoint: "graphql" });
      const ref = repository.defaultBranchRef;
      let pageDefault: string | null;
      // LEGAL — but "no commits" is not the only way to get here: an unborn/dangling HEAD also
      // yields null. The heads-vs-default coherence check below is what separates the two.
      if (ref === null) pageDefault = null;
      else if (typeof ref?.name === "string" && ref.name.length > 0) pageDefault = ref.name;
      else throw new GithubApiError(`malformed defaultBranchRef for ${org}/${repo}`, { endpoint: "graphql" });
      // Re-assert on EVERY page. Pagination is not atomic, so the default can be reassigned mid-walk;
      // unlike the (rejected) totalCount cross-check — which trips on unrelated branch churn and says
      // nothing about whether the collected names are valid — a default-name DISAGREEMENT means the
      // classification authority itself changed underneath us, which is precisely the fact the
      // always-eligible exemption depends on. Failing the rare administrative rename is the correct
      // trade: the repo is retained, never reconciled, and the next run reads one coherent snapshot.
      if (defaultBranch === undefined) defaultBranch = pageDefault;
      else if (defaultBranch !== pageDefault)
        throw new GithubApiError(
          `defaultBranchRef changed mid-pagination for ${org}/${repo} (${JSON.stringify(defaultBranch)} → ${JSON.stringify(pageDefault)})`,
          { endpoint: "graphql" },
        );
      if (!Array.isArray(refs.nodes))
        throw new GithubApiError(`refs page missing a nodes array for ${org}/${repo}`, { endpoint: "graphql" });
      for (const node of refs.nodes) {
        // a null/non-object node must fail here, not as a raw TypeError on the property reads below
        if (!isObject(node))
          throw new GithubApiError(`malformed branch-head node for ${org}/${repo}`, { endpoint: "graphql" });
        const n = node as { name?: string; target?: { oid?: string; committedDate?: string; tree?: { oid?: string } } };
        // Every refs/heads/* head is a complete Commit; a malformed/non-Commit node is anomalous and
        // must not be silently skipped (see the completeness note above). name must be a NON-EMPTY
        // string; both oids must be HEX OBJECT IDS — they flow into SHA-pinned fetches where a
        // ref-looking value ("main") would freeze a MUTABLE response into the immutable cache and
        // into skip-current persistence. An empty committedDate would otherwise classify as
        // cutoff-skipped and then trip upsertRunUnitHead's non-empty-date invariant OUTSIDE the
        // fail-soft discovery path, aborting the whole run.
        if (typeof n.name !== "string" || n.name.length === 0 ||
            typeof n.target?.oid !== "string" || !HEX_OBJECT_ID_RE.test(n.target.oid) ||
            typeof n.target.committedDate !== "string" || n.target.committedDate.length === 0 ||
            typeof n.target.tree?.oid !== "string" || !HEX_OBJECT_ID_RE.test(n.target.tree.oid))
          throw new GithubApiError(`malformed branch-head node for ${org}/${repo}`, { endpoint: "graphql" });
        // Non-empty is NOT enough for the DATE: it steers cutoff/cap selection lexically and is then
        // persisted, so an impossible value would silently change WHAT GETS SCANNED rather than fail
        // (see isIsoInstant). Same fail-closed posture as every other guard in this loop.
        if (!isIsoInstant(n.target.committedDate))
          throw new GithubApiError(
            `branch ${JSON.stringify(n.name)} of ${org}/${repo} has a non-ISO committedDate: ${JSON.stringify(n.target.committedDate.slice(0, 40))}`,
            { endpoint: "graphql" },
          );
        if (seenNames.has(n.name))
          throw new GithubApiError(`duplicate branch ${JSON.stringify(n.name)} across pages for ${org}/${repo}`, { endpoint: "graphql" });
        seenNames.add(n.name);
        heads.push({ name: n.name, oid: n.target.oid, committedDate: n.target.committedDate, treeOid: n.target.tree.oid });
      }
      const pageInfo = refs.pageInfo;
      if (typeof pageInfo?.hasNextPage !== "boolean")
        throw new GithubApiError(`refs pageInfo.hasNextPage missing/non-boolean for ${org}/${repo}`, { endpoint: "graphql" });
      if (!pageInfo.hasNextPage) break;
      const next = pageInfo.endCursor;
      if (typeof next !== "string" || next.length === 0)
        throw new GithubApiError(`refs hasNextPage=true but no follow-up endCursor for ${org}/${repo}`, { endpoint: "graphql" });
      if (seenCursors.has(next))
        throw new GithubApiError(`refs pagination cursor cycle for ${org}/${repo}`, { endpoint: "graphql" });
      seenCursors.add(next);
      cursor = next;
    }
    // The loop always executes at least once and every arm above either assigns or throws.
    if (defaultBranch === undefined)
      throw new GithubApiError(`internal: defaultBranchRef unresolved for ${org}/${repo}`, { endpoint: "graphql" });
    // --- snapshot coherence (fail-closed) --------------------------------------------------------
    // The two fields must describe the SAME repo state, because every downstream default-branch
    // decision is `headName === defaultBranch`. Both directions are checked, and BOTH throw rather
    // than degrade: a caller cannot tell a wrong default from a right one, so an incoherent snapshot
    // must not escape at all. Throwing yields discovery 'failed' → an errors row (LOUD, unlike the
    // silent mis-scan it replaces) → the repo is retained and never reconciled (the prune stays safe).
    if (defaultBranch !== null && !seenNames.has(defaultBranch))
      throw new GithubApiError(
        `defaultBranchRef ${JSON.stringify(defaultBranch)} is absent from the discovered heads of ${org}/${repo}`,
        { endpoint: "graphql" },
      );
    // A repo with heads but no default is anomalous (GitHub resolves HEAD to a live ref). We do NOT
    // claim it is impossible — an unborn/dangling HEAD on an imported or mirrored repo is the kind of
    // edge that would land here. Be precise about the cost: such a repo errors EVERY run and is never
    // scanned until an operator fixes it. That is loud and PERMANENT-until-remediated — NOT
    // self-healing (unlike a throttle or a transient API failure, no amount of re-running clears it).
    // Three options; the third is the one worth arguing:
    //   (1) plan it with NO default — rejected: no head wins the always-eligible exemption, so a
    //       restrictive policy drops the whole repo SILENTLY. Strictly worse than erroring.
    //   (2) fall back to the REST default — rejected: a stale epoch (see RepoInfo), and by
    //       construction it no longer reaches this layer at all.
    //   (3) scan every head, overriding policy AND cutoff AND cap, plus a warning — rejected on the
    //       merits, not by omission. Overriding policy alone would not even deliver the guarantee (the
    //       unknown default could still be cutoff-skipped or past-cap), so it must override all three
    //       — i.e. override an INTENTIONAL scope limiter (`branches: []` means "default only") and
    //       spend the operator's API quota, clone bandwidth and runtime on a repo they asked to
    //       narrow. It still could not record `is_default_branch` truthfully or identify the default's
    //       policy override, so it buys an under-specified scan at real cost.
    // So: fail closed. A loud error the operator can see and fix beats a silent under-report in an
    // auditor whose entire value is "we scanned your default branches".
    if (defaultBranch === null && heads.length > 0)
      throw new GithubApiError(
        `defaultBranchRef is null but ${heads.length} head(s) were discovered for ${org}/${repo}`,
        { endpoint: "graphql" },
      );
    heads.sort((a, b) =>
      a.committedDate !== b.committedDate ? (a.committedDate < b.committedDate ? 1 : -1) : a.name < b.name ? -1 : 1,
    );
    return { heads, defaultBranch };
  }

  // ---- contents / tree / blob (§5.C; SHA-pinned = immutable = zero-network cache hits) ----
  // Only a full hex object id earns the immutable zero-network path — a branch/tag name
  // passed by mistake must never freeze a MUTABLE response into the cache forever.
  private static isSha(ref: string): boolean {
    return HEX_OBJECT_ID_RE.test(ref); // sha1 (40) or sha256 (64) object ids
  }

  async fetchTreeRecursive(org: string, repo: string, treeOid: string): Promise<TreeResponse> {
    const endpoint = `repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeOid)}?recursive=1`;
    const immutable = GithubClient.isSha(treeOid);
    const res = await this.restGet(endpoint, { immutable });
    try {
      // Unreachable through restGet (its contract is exact-200), so this is DELIBERATE
      // defense-in-depth: a partial 206 body parsed here would read as a complete tree, and
      // tree completeness must not silently depend on a distant classifier's range staying
      // narrow. Exercised by a stubbed-restGet test; expected to survive mutation testing.
      if (res.status !== 200)
        throw new GithubApiError(`malformed git-tree response from ${endpoint}: HTTP ${res.status} — only exactly 200 is success`, { status: res.status, endpoint });
      let json: unknown;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw new GithubApiError(`invalid JSON from ${endpoint}`, { status: res.status, endpoint });
      }
      return parseTreeResponse(json, endpoint, immutable ? treeOid : null);
    } catch (e) {
      // restGet cached this body BEFORE validation could see it; for a SHA-pinned tree the
      // immutable path would re-serve the poisoned bytes forever (--purge-cache was the only
      // remedy). Tombstone the row so the next call goes back to the network — compare-and-delete on
      // the exact bytes read (res.body) so a sibling's concurrent VALID write of the same SHA is not
      // clobbered.
      this.tombstoneApiCache(endpoint, "", res.body);
      throw e;
    }
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

  async cloneShallow(org: string, repo: string, branch: string): Promise<{ dir: string; headSha: string; headCommittedDate: string }> {
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
      const headSha = rev.stdout.trim();
      // §5.C fail-closed: this clone HEAD is persisted as the scanned commit and built into every
      // permalink, so it must be a real object id — validate it exactly like the API path's oids (and
      // like the committer date below), never trust rev-parse's stdout verbatim.
      if (!HEX_OBJECT_ID_RE.test(headSha))
        throw new GithubApiError(`git rev-parse HEAD returned a non-hex object id in ${dest}: ${JSON.stringify(headSha.slice(0, 80))}`, { endpoint: url });
      // §4 (branch allow/deny): the ACTUAL scanned commit's date. The clone HEAD may be AHEAD of the
      // GraphQL-discovered head (the branch moved between discovery and clone), so its date must be
      // read from the clone — not reused from discovery. This exact argv is the ONLY `show` form
      // readOnlyGuard permits (--no-patch/--no-notes/--no-show-signature suppress diff/notes/GPG; %cI
      // is the strict-ISO committer date). A capture failure reclaims the tree via the catch below.
      const dateRes = await this.git(["show", "--no-patch", "--no-notes", "--no-show-signature", "--format=%cI", "HEAD"], dest);
      if (dateRes.exitCode !== 0)
        throw new GithubApiError(`git show HEAD committer date failed in ${dest}: ${dateRes.stderr.trim().slice(0, 300)}`, { endpoint: url });
      const headCommittedDate = dateRes.stdout.trim();
      // Exactly one strict-ISO line, offset preserved verbatim (NOT normalized to Z/ms — this joins
      // the committedDate family feeding scanned_commit_date). A garbled read would poison that
      // durable provenance. isIsoInstant, not a bare shape regex: the shape alone admits impossible
      // CALENDAR values (2025-02-30, which Date.parse silently rolls over rather than rejecting).
      // Planning already happened — the cutoff was judged on the DISCOVERED head date, never on this
      // value — so the poison risk here is the run's durable scan-scope ledger, not selection.
      if (!isIsoInstant(headCommittedDate))
        throw new GithubApiError(`git show HEAD returned a non-ISO committer date in ${dest}: ${JSON.stringify(headCommittedDate.slice(0, 80))}`, { endpoint: url });
      return { dir: dest, headSha, headCommittedDate };
    } catch (e) {
      // a failed/timed-out clone can leave a multi-GB partial tree — reclaim it NOW rather
      // than at the next run's startup sweep (the caller only cleans up on success). The
      // cleanup is BEST-EFFORT: force only suppresses ENOENT, and an EACCES/EBUSY here must
      // not replace the actionable git error (a stuck tree is the next sweep's problem).
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        // best-effort — the ORIGINAL clone/rev-parse/show error (thrown below) is the operator's
        // diagnostic and must NOT be masked, but the failed reclaim is still surfaced (a stuck tree the
        // next startup sweep must handle), consistent with processUnit's clone-cleanup-failed warning.
        logLine({ event: "warning", reason: "clone-cleanup-failed", target: runDir, message: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) });
      }
      throw e;
    }
  }

  // ---- startup sweep (§0): stale pkg-audit-* DIRECT children of the temp root only ----
  sweepStaleTempDirs(): string[] {
    const removed: string[] = [];
    // ENOENT here is benign (a dir vanished mid-sweep under concurrent cleanup); anything else
    // (EACCES/EBUSY/ENOTDIR/…) is a real failure that would otherwise leave stale multi-GB clones
    // accumulating with no signal — the sole caller discards the return value, so warn on stdout.
    const warnFailure = (operation: string, target: string, e: unknown, suppressENOENT: boolean): void => {
      // A PER-ENTRY dir vanishing mid-sweep (ENOENT) is a benign concurrent-cleanup race; a missing or
      // unreadable temp ROOT is not — it means the sweep could not run at all — so the root always warns.
      if (suppressENOENT && typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT") return;
      logLine({ event: "warning", reason: "temp-sweep-failed", operation, target, message: e instanceof Error ? e.message : String(e) });
    };
    let entries: string[];
    try {
      entries = readdirSync(this.tempRoot);
    } catch (e) {
      warnFailure("readdir", this.tempRoot, e, false); // root failure ALWAYS warns, incl. a missing root (ENOENT)
      return removed;
    }
    for (const name of entries) {
      if (!name.startsWith("pkg-audit-")) continue;
      const full = join(this.tempRoot, name);
      let st;
      try {
        st = lstatSync(full); // lstat: NEVER follow a symlink
      } catch (e) {
        warnFailure("lstat", full, e, true); // per-entry: a benign mid-sweep vanish (ENOENT) stays silent
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
      } catch (e) {
        warnFailure("remove", full, e, true); // per-entry: a dir vanishing mid-sweep (ENOENT) stays silent
      }
    }
    return removed;
  }
}
