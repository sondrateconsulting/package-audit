import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir, devNull } from "node:os";
import { join, dirname } from "node:path";
import {
  GithubClient, GithubApiError, ThrottleExhausted, MAX_PAGES, MAX_PAUSE_MS, SPAWN_TIMEOUT_MS, MAX_TOTAL_PAUSE_MS, SPAWN_KILL_GRACE_MS,
  parseGhApiOutput, parseLinkNext, nextEndpointFromLink, parseRetryAfterMs,
  classifyRest, classifyGraphql, parseGraphqlEnvelope, parseTreeResponse, encodeContentsPath, mapRestRepo, filterSortCapRepos,
  buildGhEnv, buildGitEnv, buildTarEnv, readCapped, makeRealSpawn, joinSpawnOutcome,
  type SpawnFn, type SpawnResult, type RepoInfo, type SpawnAbortSignal, type StreamReader,
} from "./github.ts";
import { ReadOnlyViolation } from "./readOnlyGuard.ts";
import { AuditDb } from "./db.ts";

const TEST_TMP = mkdtempSync(join(tmpdir(), "gh-test-"));
afterAll(() => rmSync(TEST_TMP, { recursive: true, force: true }));

const BINS = { gh: "/opt/bin/gh", git: "/opt/bin/git", tar: "/opt/bin/tar" };

const http = (status: number, headers: Record<string, string>, body: string, sep = "\r\n"): string =>
  [`HTTP/2.0 ${status} X`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)].join(sep) + sep + sep + body;

interface Call {
  bin: string;
  args: string[];
  opts: { env: Record<string, string>; cwd?: string };
}
function scripted(responses: Array<SpawnResult | ((call: Call) => SpawnResult)>): {
  spawn: SpawnFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const spawn: SpawnFn = async (bin, args, opts) => {
    const call = { bin, args, opts };
    calls.push(call);
    const next = responses[calls.length - 1];
    if (next === undefined) throw new Error(`unexpected spawn #${calls.length}: ${bin} ${args.join(" ")}`);
    return typeof next === "function" ? next(call) : next;
  };
  return { spawn, calls };
}
const ok = (stdout: string): SpawnResult => ({ exitCode: 0, stdout, stderr: "" });
const err = (stdout: string, stderr = "", exitCode = 1): SpawnResult => ({ exitCode, stdout, stderr });

function makeClient(
  responses: Array<SpawnResult | ((call: Call) => SpawnResult)>,
  extra: Partial<ConstructorParameters<typeof GithubClient>[0]> = {},
): { client: GithubClient; calls: Call[]; sleeps: number[] } {
  const { spawn, calls } = scripted(responses);
  const sleeps: number[] = [];
  // a fake ADVANCING clock: sleep moves time forward, so bucket pauses actually elapse
  let fakeNow = 1_000_000_000_000;
  const client = new GithubClient({
    githubHost: "github.com",
    spawnImpl: spawn,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
      fakeNow += ms;
    },
    nowImpl: () => fakeNow,
    env: { HOME: "/home/u", PATH: "/bin", GH_TOKEN: "tok", GIT_ASKPASS: "/evil", GH_DEBUG: "api", TAR_OPTIONS: "--evil" },
    binPaths: BINS,
    tempRoot: TEST_TMP,
    ...extra,
  });
  return { client, calls, sleeps };
}

// Instrument an AuditDb to COUNT api_cache reads/writes — proves a noStore path touches the DB
// zero times (not merely that its observable effects are absent). Wrap AFTER any test seeding so
// the seed's own putApiCache is not counted.
function countCacheAccess(db: AuditDb): { reads: number; writes: number } {
  const counters = { reads: 0, writes: 0 };
  const realGet = db.getApiCache.bind(db);
  const realPut = db.putApiCache.bind(db);
  db.getApiCache = (m: string, u: string, v: string) => { counters.reads++; return realGet(m, u, v); };
  db.putApiCache = (e: Parameters<typeof realPut>[0]) => { counters.writes++; realPut(e); };
  return counters;
}

// ---- pure parsers -----------------------------------------------------------------------
describe("parseGhApiOutput", () => {
  test("parses status, lowercases headers, joins duplicates (CRLF and LF)", () => {
    for (const sep of ["\r\n", "\n"]) {
      const res = parseGhApiOutput(http(200, { "X-RateLimit-Remaining": "42", Link: "<a>", link: "<b>" }, `{"x":1}`, sep));
      expect(res.status).toBe(200);
      expect(res.headers["x-ratelimit-remaining"]).toBe("42");
      expect(res.headers["link"]).toBe("<a>, <b>");
      expect(res.body).toBe(`{"x":1}`);
    }
  });

  test("headers-only response (304 with no body) parses", () => {
    const res = parseGhApiOutput(`HTTP/2.0 304 Not Modified\r\nEtag: W/"abc"`);
    expect(res.status).toBe(304);
    expect(res.headers["etag"]).toBe('W/"abc"');
    expect(res.body).toBe("");
  });

  test("a 200 body that itself starts with HTTP/ is NOT re-parsed as headers", () => {
    const rawFile = `HTTP/1.1 418 fake\n\nnot headers`;
    const res = parseGhApiOutput(http(200, { etag: "x" }, rawFile));
    expect(res.status).toBe(200);
    expect(res.body).toBe(rawFile);
  });

  test("a printed 3xx block followed by the final block resolves to the final response", () => {
    const out = http(301, { location: "elsewhere" }, "") + http(200, { etag: "y" }, "body2");
    const res = parseGhApiOutput(out);
    expect(res.status).toBe(200);
    expect(res.body).toBe("body2");
  });

  test("empty stdout yields status 0", () => {
    expect(parseGhApiOutput("").status).toBe(0);
  });
});

describe("parseLinkNext + nextEndpointFromLink", () => {
  test("extracts rel=next from a real GitHub Link header", () => {
    const link = `<https://api.github.com/user/orgs?per_page=1&page=2>; rel="next", <https://api.github.com/user/orgs?per_page=1&page=4>; rel="last"`;
    expect(parseLinkNext(link)).toBe("https://api.github.com/user/orgs?per_page=1&page=2");
  });
  test("quoted commas inside params do not mis-split; rel token lists work", () => {
    const link = `<https://api.github.com/a?page=2>; title="x, y"; rel="prev next"`;
    expect(parseLinkNext(link)).toBe("https://api.github.com/a?page=2");
  });
  test("a quoted param containing ', <url>' cannot hijack the next link", () => {
    const link = `<https://api.github.com/real?page=2>; rel="next"; title="x, <https://api.github.com/fake>", <https://api.github.com/last?page=9>; rel="last"`;
    expect(parseLinkNext(link)).toBe("https://api.github.com/real?page=2");
  });
  test("a backslash-escaped quote inside a param cannot terminate quote tracking early", () => {
    // the \" must NOT close the quote; the fake <url> stays inside the (still-open) string
    const link = `<https://api.github.com/real?page=2>; rel="next"; title="x\\", <https://api.github.com/fake>; rel=\\"next\\""`;
    expect(parseLinkNext(link)).toBe("https://api.github.com/real?page=2");
  });
  test("a quoted param VALUE containing '; rel=next' cannot spoof the rel parameter", () => {
    // only a real `rel=` param (split on ';' outside quotes) counts — the quoted title is inert
    const link = `<https://api.github.com/real?page=2>; rel="last"; title="; rel=next", <https://api.github.com/actual?page=3>; rel="next"`;
    expect(parseLinkNext(link)).toBe("https://api.github.com/actual?page=3");
  });
  test("no next → null", () => {
    expect(parseLinkNext(`<https://api.github.com/a>; rel="last"`)).toBeNull();
    expect(parseLinkNext(undefined)).toBeNull();
  });
  test("api.github.com URL recomposes to a relative endpoint", () => {
    expect(nextEndpointFromLink("https://api.github.com/orgs/x/repos?page=2&type=all", "github.com")).toBe(
      "orgs/x/repos?page=2&type=all",
    );
  });
  test("GHES /api/v3 prefix is stripped for the configured host", () => {
    expect(nextEndpointFromLink("https://ghe.corp.com/api/v3/orgs/x/repos?page=2", "ghe.corp.com")).toBe(
      "orgs/x/repos?page=2",
    );
  });
  test("host mismatch is a poisoned redirect → throws", () => {
    expect(() => nextEndpointFromLink("https://evil.example.com/orgs/x/repos?page=2", "github.com")).toThrow(
      GithubApiError,
    );
    // dotcom API Links only ever come from api.github.com — github.com itself is rejected
    expect(() => nextEndpointFromLink("https://github.com/orgs/x/repos?page=2", "github.com")).toThrow(GithubApiError);
    // GHES with a port must match exactly, and http downgrades are rejected
    expect(() => nextEndpointFromLink("https://ghe.corp.com:8443/api/v3/x?page=2", "ghe.corp.com")).toThrow(GithubApiError);
    expect(() => nextEndpointFromLink("http://api.github.com/x?page=2", "github.com")).toThrow(GithubApiError);
  });
});

describe("classifyRest / classifyGraphql / parseRetryAfterMs", () => {
  const NOW = 1_000_000_000_000;
  test("primary is keyed on remaining==0, for both 403 and 429", () => {
    for (const status of [403, 429]) {
      const cls = classifyRest(status, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000000100" }, "", NOW);
      expect(cls.kind).toBe("primary");
      if (cls.kind === "primary") expect(cls.untilMs).toBe(1_000_000_100_000 + 5_000);
    }
  });
  test("secondary needs POSITIVE evidence: Retry-After, 429, or the documented abuse wording", () => {
    const withRetryAfter = classifyRest(403, { "x-ratelimit-remaining": "100", "retry-after": "120" }, "", NOW);
    expect(withRetryAfter).toEqual({ kind: "secondary", waitMs: 120_000 });
    const abuseBody = classifyRest(403, { "x-ratelimit-remaining": "100" }, `{"message":"You have exceeded a secondary rate limit"}`, NOW);
    expect(abuseBody).toEqual({ kind: "secondary", waitMs: null });
    const plain429 = classifyRest(429, { "x-ratelimit-remaining": "100" }, "{}", NOW);
    expect(plain429).toEqual({ kind: "secondary", waitMs: null });
  });
  test("a plain permission 403 (nonzero remaining, no throttle evidence) is FATAL, never retried as a throttle", () => {
    const cls = classifyRest(403, { "x-ratelimit-remaining": "100" }, `{"message":"Must have admin rights"}`, NOW);
    expect(cls.kind).toBe("fatal");
    if (cls.kind === "fatal") expect(cls.ssoRequired).toBe(false);
  });
  test("SSO enforcement is NON-retryable", () => {
    const cls = classifyRest(403, { "x-ratelimit-remaining": "100", "x-github-sso": "required; url=x" }, "", NOW);
    expect(cls.kind).toBe("fatal");
    if (cls.kind === "fatal") expect(cls.ssoRequired).toBe(true);
  });
  test("404 fatal; 503 transient; 200 ok", () => {
    expect(classifyRest(404, {}, "", NOW).kind).toBe("fatal");
    expect(classifyRest(503, {}, "", NOW).kind).toBe("transient");
    expect(classifyRest(200, {}, "", NOW).kind).toBe("ok");
  });
  test("only exactly 200 is ok — every other 2xx is FATAL, never consumable success", () => {
    // A non-200 2xx (206 Partial Content from a middlebox, 203 proxy-transformed content, …)
    // carries a body that cannot be trusted as complete; raw-content consumers would silently
    // scan it as file content. Fail closed at the classifier so EVERY restGet consumer —
    // current and future — inherits the gate from one site.
    expect(classifyRest(200, {}, "", NOW)).toEqual({ kind: "ok" });
    for (let status = 201; status <= 299; status++) {
      const cls = classifyRest(status, {}, "", NOW);
      expect(cls.kind).toBe("fatal");
      if (cls.kind === "fatal") {
        expect(cls.status).toBe(status);
        expect(cls.ssoRequired).toBe(false);
        expect(cls.message).toMatch(/only exactly 200/);
      }
    }
    // range boundaries: the statuses BRACKETING the 2xx range keep their existing paths — a
    // terminal 1xx (parseGhApiOutput can surface one when no final block follows) and a bare
    // 3xx are fatal via the CATCH-ALL. Asserting kind alone would still pass if the new branch
    // accidentally widened to swallow them (both branches return fatal), so pin the message.
    for (const status of [199, 300]) {
      const cls = classifyRest(status, {}, "", NOW);
      expect(cls.kind).toBe("fatal");
      // the exact catch-all message, not merely "some fatal" — an accidentally-widened 2xx
      // branch (or any rerouting) would change this wording
      if (cls.kind === "fatal") expect(cls.message).toBe(`HTTP ${status}`);
    }
  });
  test("a 2xx-non-200 is fatal even when throttle-looking headers ride along — never a retryable throttle", () => {
    // outcome pin, not a source-ordering proof (the 2xx and 403/429 predicates are disjoint, so
    // ordering is unobservable here): a poisoned 206 carrying exhausted-window headers or
    // Retry-After must classify fatal, never primary/secondary.
    const cls = classifyRest(206, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000000100", "retry-after": "30" }, "", NOW);
    expect(cls.kind).toBe("fatal");
  });
  test("parseRetryAfterMs: seconds, HTTP-date, garbage", () => {
    expect(parseRetryAfterMs("120", NOW)).toBe(120_000);
    const date = new Date(NOW + 30_000).toUTCString();
    expect(parseRetryAfterMs(date, NOW)).toBeGreaterThanOrEqual(29_000);
    expect(parseRetryAfterMs("soon", NOW)).toBeNull();
    expect(parseRetryAfterMs(undefined, NOW)).toBeNull();
  });
  test("graphql: RATE_LIMITED in a 200 body is a throttle (§4)", () => {
    const primary = classifyGraphql(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000000100" }, [{ type: "RATE_LIMITED" }], NOW);
    expect(primary.kind).toBe("primary");
    const secondary = classifyGraphql(200, { "x-ratelimit-remaining": "50" }, [{ type: "RATE_LIMITED" }], NOW);
    expect(secondary.kind).toBe("secondary");
  });
  test("graphql 403 disambiguation: Retry-After/abuse → secondary; sso/permission → fatal", () => {
    expect(classifyGraphql(403, { "x-ratelimit-remaining": "5", "retry-after": "30" }, [], NOW).kind).toBe("secondary");
    expect(classifyGraphql(403, { "x-ratelimit-remaining": "5" }, [{ message: "You have exceeded a secondary rate limit" }], NOW).kind).toBe("secondary");
    const sso = classifyGraphql(403, { "x-ratelimit-remaining": "5", "x-github-sso": "required" }, [], NOW);
    expect(sso.kind).toBe("fatal");
    expect(classifyGraphql(403, { "x-ratelimit-remaining": "5" }, [{ message: "Resource not accessible by integration" }], NOW).kind).toBe("fatal");
  });
  test("graphql 403: SSO disambiguation runs BEFORE the header-keyed primary shortcut", () => {
    const cls = classifyGraphql(403, { "x-ratelimit-remaining": "0", "x-github-sso": "required" }, [], NOW);
    expect(cls.kind).toBe("fatal"); // never retried as a rate-limit wait
    if (cls.kind === "fatal") expect(cls.ssoRequired).toBe(true);
    // …while a genuine header-exhausted 403 with no fatal evidence stays primary
    expect(classifyGraphql(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000000100" }, [], NOW).kind).toBe("primary");
  });
  test("graphql HTTP 429 with remaining==0 is PRIMARY, not a generic 429 secondary", () => {
    const cls = classifyGraphql(429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000000100" }, [], NOW);
    expect(cls.kind).toBe("primary");
    if (cls.kind === "primary") expect(cls.untilMs).toBe(1_000_000_100_000 + 5_000);
    // a 429 with remaining NONZERO is still secondary
    expect(classifyGraphql(429, { "x-ratelimit-remaining": "9" }, [], NOW).kind).toBe("secondary");
  });
  test("graphql SSO short-circuits even when a RATE_LIMITED body is also present", () => {
    const cls = classifyGraphql(403, { "x-ratelimit-remaining": "0", "x-github-sso": "required" }, [{ type: "RATE_LIMITED" }], NOW);
    expect(cls.kind).toBe("fatal");
    if (cls.kind === "fatal") expect(cls.ssoRequired).toBe(true);
  });
  test("graphql 200 with non-throttle errors is fatal; clean 200 is ok", () => {
    expect(classifyGraphql(200, {}, [{ type: "NOT_FOUND", message: "gone" }], NOW).kind).toBe("fatal");
    expect(classifyGraphql(200, {}, [], NOW).kind).toBe("ok");
  });
  test("poisoned far-future reset / Retry-After waits are clamped to MAX_PAUSE_MS (§4 hardening)", () => {
    // reset/Retry-After are RESPONSE-controlled; real GitHub resets are <= 1h — a poisoned
    // header must never command a multi-year pause. Kind stays throttle (retryable), wait clamps.
    const farReset = String(NOW / 1000 + 315_360_000); // 10 years ahead
    const primary = classifyRest(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": farReset }, "", NOW);
    expect(primary.kind).toBe("primary");
    if (primary.kind === "primary") expect(primary.untilMs).toBe(NOW + MAX_PAUSE_MS);
    expect(classifyRest(429, { "x-ratelimit-remaining": "9", "retry-after": "315360000" }, "{}", NOW))
      .toEqual({ kind: "secondary", waitMs: MAX_PAUSE_MS });
    const gqlPrimary = classifyGraphql(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": farReset }, [{ type: "RATE_LIMITED" }], NOW);
    expect(gqlPrimary.kind).toBe("primary");
    if (gqlPrimary.kind === "primary") expect(gqlPrimary.untilMs).toBe(NOW + MAX_PAUSE_MS);
    expect(classifyGraphql(200, { "x-ratelimit-remaining": "50", "retry-after": "315360000" }, [{ type: "RATE_LIMITED" }], NOW))
      .toEqual({ kind: "secondary", waitMs: MAX_PAUSE_MS });
    expect(classifyGraphql(429, { "x-ratelimit-remaining": "9", "retry-after": "315360000" }, [], NOW))
      .toEqual({ kind: "secondary", waitMs: MAX_PAUSE_MS });
  });
});

describe("path encoding + repo shaping", () => {
  test("encodeContentsPath encodes per segment, preserving '/'", () => {
    expect(encodeContentsPath("src dir/ü#?.ts")).toBe("src%20dir/%C3%BC%23%3F.ts");
  });
  test("mapRestRepo rejects a malformed identity OR a scope-steering field with an indexed, endpoint-scoped error", () => {
    const OK = { name: "r", owner: { login: "o" }, pushed_at: null, archived: false, fork: false, private: false };
    const bad: Array<[unknown, RegExp]> = [
      [null, /not an object/],
      ["str", /not an object/],
      // identity fields
      [{ ...OK, name: undefined }, /non-string name/],
      [{ ...OK, name: "" }, /non-string name/],
      [{ ...OK, name: 42 }, /non-string name/],
      [{ ...OK, owner: undefined }, /non-object owner/],
      [{ ...OK, owner: null }, /non-object owner/],
      [{ ...OK, owner: "x" }, /non-object owner/],
      [{ ...OK, owner: {} }, /owner\.login/],
      [{ ...OK, owner: { login: "" } }, /owner\.login/],
      [{ ...OK, owner: { login: 42 } }, /owner\.login/],   // non-string, non-null (was coerced to "42")
      [{ ...OK, owner: { login: "other" } }, /not the requested owner/], // well-formed but FOREIGN owner → scan redirect
      // non-canonical identity segments — a "." / ".." / separator / control / whitespace value in
      // `name` steers the clone URL + fs join + endpoint; real GitHub repo names carry none of these
      [{ ...OK, name: "." }, /name is not a canonical identity/],
      [{ ...OK, name: ".." }, /name is not a canonical identity/],
      [{ ...OK, name: "a/b" }, /name is not a canonical identity/],   // path separator
      [{ ...OK, name: "a\\b" }, /name is not a canonical identity/],  // backslash
      [{ ...OK, name: "a b" }, /name is not a canonical identity/],   // whitespace
      [{ ...OK, name: "a" + String.fromCharCode(0) + "b" }, /name is not a canonical identity/], // C0 control (NUL)
      [{ ...OK, name: "a" + String.fromCharCode(0x7f) + "b" }, /name is not a canonical identity/], // DEL
      [{ ...OK, name: "a" + String.fromCharCode(0x85) + "b" }, /name is not a canonical identity/], // C1 control (NEL)
      [{ ...OK, name: "a" + String.fromCharCode(0x9b) + "b" }, /name is not a canonical identity/], // C1 control (CSI)
      // scope-steering fields (silent under-report via sort/cap/filter if coerced)
      [{ ...OK, pushed_at: undefined }, /pushed_at/],       // missing (was coerced to null)
      [{ ...OK, pushed_at: 1700000000 }, /pushed_at/],      // number (was coerced to null → sinks in the cap)
      [{ ...OK, pushed_at: "not-a-date" }, /pushed_at/],    // garbage string (arbitrary lexical sort position)
      [{ ...OK, pushed_at: "2025-02-30T00:00:00Z" }, /pushed_at/], // impossible calendar date (Date.parse rolls it over)
      [{ ...OK, pushed_at: "2024-06-01T00:00:00-10:00" }, /canonical UTC/], // OFFSET form: valid instant, but sorts lexically WRONG vs Z-form → cap-sink
      [{ ...OK, pushed_at: "2024-06-01T00:00:00+00:00" }, /canonical UTC/], // even +00:00 (== Z) is rejected: only the literal Z form sorts correctly
      [{ ...OK, archived: "true" }, /archived is not a boolean/], // string (=== true was false → scanned + displaces)
      [{ ...OK, fork: 1 }, /fork is not a boolean/],
      [{ ...OK, private: null }, /private is not a boolean/],
    ];
    for (const [raw, re] of bad) {
      let caught: unknown;
      try { mapRestRepo(raw, "orgs/o/repos", 3, "o"); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(GithubApiError);
      expect((caught as GithubApiError).message).toMatch(/index 3/);
      expect((caught as GithubApiError).message).toMatch(re);
      expect((caught as GithubApiError).endpoint).toBe("orgs/o/repos");
    }
  });
  test("mapRestRepo rejects a non-canonical owner.login even when it equals the expected owner", () => {
    // expectedOwner=".." makes the case-insensitive cross-owner equality PASS, so this exercises the
    // identity-segment guard ITSELF — not the foreign-owner check. With expectedOwner="o" the foreign
    // check would throw first and silently mask a missing guard (the TDD trap).
    let caught: unknown;
    try {
      mapRestRepo({ name: "r", owner: { login: ".." }, pushed_at: null, archived: false, fork: false, private: false }, "orgs/x/repos", 0, "..");
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect((caught as GithubApiError).message).toMatch(/owner\.login is not a canonical identity/);
  });
  test("mapRestRepo accepts legitimate dotted identities (a .github repo under an a.b owner)", () => {
    // Only the EXACT dot segments "." / ".." are structurally special; interior dots are ordinary.
    const repo = mapRestRepo({ name: ".github", owner: { login: "a.b" }, pushed_at: null, archived: false, fork: false, private: false }, "orgs/a.b/repos", 0, "a.b");
    expect(repo.name).toBe(".github");
    expect(repo.organization).toBe("a.b");
  });
  test("mapRestRepo accepts pushed_at: null (a repo with no pushes) and maps it to pushedAt: null", () => {
    const repo = mapRestRepo({ name: "r", owner: { login: "o" }, pushed_at: null, archived: false, fork: false, private: false }, "orgs/o/repos", 0, "o");
    expect(repo).toEqual({ name: "r", organization: "o", pushedAt: null, archived: false, fork: false, isPrivate: false });
  });
  test("mapRestRepo maps the snake_case REST shape and IGNORES default_branch (a stale epoch)", () => {
    const repo = mapRestRepo({
      name: "r", owner: { login: "o" }, default_branch: "main",
      pushed_at: "2024-06-01T00:00:00Z", archived: false, fork: true, private: true,
    }, "orgs/o/repos", 0, "o");
    // toEqual is exact, so this pins the ABSENCE of any default-branch field: the REST listing is a
    // different (older) epoch than §5.B branch discovery, and letting its default_branch reach the
    // planner is what allowed a renamed default to be policy-excluded. The default comes from
    // listBranchHeads' snapshot instead — there is deliberately no REST fallback.
    expect(repo).toEqual({
      name: "r", organization: "o",
      pushedAt: "2024-06-01T00:00:00Z", archived: false, fork: true, isPrivate: true,
    });
    expect(Object.hasOwn(repo, "defaultBranch")).toBe(false);
  });
  test("filterSortCapRepos: client-side fork/archived policy, pushed_at DESC nulls last, cap", () => {
    const mk = (name: string, pushedAt: string | null, extra: Partial<RepoInfo> = {}): RepoInfo => ({
      name, organization: "o", pushedAt, archived: false, fork: false, isPrivate: false, ...extra,
    });
    const repos = [
      mk("old", "2023-01-01T00:00:00Z"),
      mk("new", "2024-06-01T00:00:00Z"),
      mk("nullpush", null),
      mk("forked", "2025-01-01T00:00:00Z", { fork: true }),
      mk("archived", "2025-01-01T00:00:00Z", { archived: true }),
    ];
    const filtered = filterSortCapRepos(repos, { includeArchived: false, includeForks: false, maxReposPerOrg: null });
    expect(filtered.map((r) => r.name)).toEqual(["new", "old", "nullpush"]);
    const withForks = filterSortCapRepos(repos, { includeArchived: true, includeForks: true, maxReposPerOrg: 2 });
    expect(withForks.map((r) => r.name)).toEqual(["archived", "forked"]);
  });
});

describe("sanitized env construction", () => {
  const base = {
    HOME: "/home/u", PATH: "/bin", GH_TOKEN: "tok", GH_DEBUG: "api", GIT_ASKPASS: "/evil",
    GIT_SSH_COMMAND: "evil", TAR_OPTIONS: "--evil", GH_CONFIG_DIR: "/cfg", XDG_CONFIG_HOME: "/xdg",
    EMPTY: "",
  };
  test("gh env: pins + auth passthrough, no debug/askpass leakage", () => {
    const env = buildGhEnv(base, "ghe.corp.com");
    expect(env["GH_HOST"]).toBe("ghe.corp.com");
    expect(env["GH_PROMPT_DISABLED"]).toBe("1");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["GH_TOKEN"]).toBe("tok");
    expect(env["GH_CONFIG_DIR"]).toBe("/cfg"); // auth state passthrough
    expect(env["GH_DEBUG"]).toBeUndefined();
    expect(env["GIT_ASKPASS"]).toBeUndefined();
  });
  test("git env: ALL config pinned; injection vectors never copied; gh auth survives for the helper", () => {
    const env = buildGitEnv(base, "/tmp/x/gitconfig");
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("/tmp/x/gitconfig");
    expect(env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(env["GIT_ALLOW_PROTOCOL"]).toBe("https");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["GIT_ASKPASS"]).toBeUndefined();
    expect(env["GIT_SSH_COMMAND"]).toBeUndefined();
    // the pinned credential helper runs `gh auth git-credential` under THIS env — token and
    // config-dir auth must survive for private clones
    expect(env["GH_TOKEN"]).toBe("tok");
    expect(env["GH_CONFIG_DIR"]).toBe("/cfg");
  });
  test("tar env: TAR_OPTIONS never copied; empty base values not copied", () => {
    const env = buildTarEnv(base);
    expect(env["TAR_OPTIONS"]).toBeUndefined();
    expect(env["EMPTY"]).toBeUndefined();
    expect(env["PATH"]).toBe("/bin");
  });
});

// ---- guard wiring (spawn must never be reached on a violation) ----------------------------
describe("guard wiring", () => {
  test("mutating gh/git/tar argv throws BEFORE spawning", async () => {
    const { client, calls } = makeClient([]);
    await expect(client.gh(["api", "-X", "DELETE", "repos/o/r"])).rejects.toThrow(ReadOnlyViolation);
    await expect(client.git(["push"])).rejects.toThrow(ReadOnlyViolation);
    await expect(client.tar(["-cf", "x.tar", "dir"])).rejects.toThrow(ReadOnlyViolation);
    expect(calls.length).toBe(0);
  });
  test("a denylisted package-manager binary is refused at the chokepoint", async () => {
    const { client, calls } = makeClient([], { binPaths: { ...BINS, gh: "/usr/local/bin/npm" } });
    await expect(client.gh(["api", "rate_limit"])).rejects.toThrow(ReadOnlyViolation);
    expect(calls.length).toBe(0);
  });
  test("the global semaphore caps EVERY gh spawn, including direct gh() calls (§4)", async () => {
    // concurrency 1: a second direct gh() must not spawn until the first releases.
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const spawn: SpawnFn = async (_bin, args) => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (args.includes("first")) await gate; // hold the slot until told to release
      active--;
      return ok(http(200, {}, "{}"));
    };
    const client = new GithubClient({
      githubHost: "github.com",
      spawnImpl: spawn,
      binPaths: BINS,
      tempRoot: TEST_TMP,
      concurrency: 1,
    });
    const p1 = client.gh(["api", "rate_limit", "first"]);
    const p2 = client.gh(["api", "rate_limit"]);
    await new Promise((r) => setTimeout(r, 5));
    expect(maxActive).toBe(1); // p2 is queued behind p1's single slot
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(maxActive).toBe(1);
  });
});

// ---- REST GET + cache -----------------------------------------------------------------------
describe("restGet caching + conditional requests", () => {
  test("200 is cached; second call rides If-None-Match; 304 serves the cached body", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient(
      [ok(http(200, { etag: 'W/"e1"', "x-ratelimit-remaining": "100" }, `{"a":1}`)), err(`HTTP/2.0 304 Not Modified\r\nEtag: W/"e1"`, "gh: HTTP 304")],
      { db },
    );
    const first = await client.restGet("user/orgs?per_page=100&page=1");
    expect(first.status).toBe(200);
    expect(first.body).toBe(`{"a":1}`);
    const second = await client.restGet("user/orgs?per_page=100&page=1");
    expect(second.status).toBe(200);
    expect(second.body).toBe(`{"a":1}`); // 304 (non-zero gh exit) treated as cache HIT
    expect(calls.length).toBe(2);
    expect(calls[1]!.args).toContain("If-None-Match: W/\"e1\"");
    db.close();
  });

  const SHA = "0123456789abcdef0123456789abcdef01234567"; // immutable caching requires a real object id

  test("immutable (SHA-pinned) URLs are served from cache with ZERO spawns", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient([ok(http(200, {}, "raw-contents"))], { db });
    const a = await client.fetchFileRaw("o", "r", "package.json", SHA);
    expect(a).toBe("raw-contents");
    const b = await client.fetchFileRaw("o", "r", "package.json", SHA);
    expect(b).toBe("raw-contents");
    expect(calls.length).toBe(1); // second read hit SQLite, not the network
    db.close();
  });

  test("an immutable cache HIT synthesizes an exact status 200 (the whole envelope is pinned, not just the body)", async () => {
    // restGet's zero-network immutable hit returns { status: 200, ... } literally; without this the
    // synthesized status is only proven INDIRECTLY (fetchTreeRecursive's own !=200 reject). Pin it
    // here so a mutation of the synthesized status (e.g. → 206) fails a direct assertion.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const ep = `repos/o/r/contents/package.json?ref=${SHA}`; // SHA-pinned → immutable eligible
    const { client, calls } = makeClient([ok(http(200, {}, "imm-body"))], { db });
    await client.restGet(ep, { immutable: true }); // primes the immutable row
    const hit = await client.restGet(ep, { immutable: true }); // served from cache, zero network
    expect(hit.status).toBe(200); // the SYNTHESIZED status, asserted directly
    expect(hit.body).toBe("imm-body");
    expect(calls.length).toBe(1); // second read hit SQLite, not the network
    db.close();
  });

  test("a NON-sha ref never earns the immutable zero-network path", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient(
      [ok(http(200, {}, "v1")), ok(http(200, {}, "v2"))],
      { db },
    );
    await client.fetchFileRaw("o", "r", "package.json", "main"); // branch name, mutable
    const second = await client.fetchFileRaw("o", "r", "package.json", "main");
    expect(calls.length).toBe(2); // revalidated on the network, not frozen into the cache
    expect(second).toBe("v2");
    db.close();
  });

  test("a DIRECT 2xx-non-200 response is IMMEDIATELY fatal — never returned, never retried, never persisted", async () => {
    // Closes the last 2xx hole: the persist gate + key epoch already stopped cache laundering,
    // but a direct 206 body was still RETURNED once to consumers with no status check of their
    // own (fetchFileRaw/fetchBlobRaw/fetchFileMeta) — partial file content silently scanned.
    // The classifier now fails it closed for every consumer at one site: no retry (a
    // transforming middlebox would just re-transform), no bucket pause, no cache row.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls, sleeps } = makeClient([ok(http(206, { etag: 'W/"p"' }, "partial-body"))], { db });
    let caught: unknown;
    try {
      await client.restGet("user/orgs?per_page=100&page=1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GithubApiError);
    const apiErr = caught as GithubApiError;
    expect(apiErr.status).toBe(206);
    expect(apiErr.endpoint).toBe("user/orgs?per_page=100&page=1");
    expect(apiErr.ssoRequired).toBe(false);
    expect(apiErr.message).toMatch(/only exactly 200/);
    expect(calls.length).toBe(1); // fatal on the spot — not the transient/throttle retry path
    expect(sleeps).toEqual([]);
    const rows = db.read("SELECT COUNT(*) AS n FROM api_cache").get() as { n: number };
    expect(rows.n).toBe(0); // and never persisted
    db.close();
  });

  test("fetchFileRaw: a direct 206 partial body is NEVER returned as file content, and nothing is cached", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient([ok(http(206, {}, "const partial = "))], { db });
    await expect(client.fetchFileRaw("o", "r", "index.ts", SHA)).rejects.toThrow(/only exactly 200/);
    expect(calls.length).toBe(1);
    const rows = db.read("SELECT COUNT(*) AS n FROM api_cache").get() as { n: number };
    expect(rows.n).toBe(0); // the SHA-pinned endpoint holds no row — the next call refetches
    db.close();
  });

  test("fetchBlobRaw: a direct 206 partial blob is NEVER returned", async () => {
    const { client } = makeClient([ok(http(206, {}, "partial blob bytes"))]);
    await expect(client.fetchBlobRaw("o", "r", SHA)).rejects.toThrow(/only exactly 200/);
  });

  test("fetchFileMeta: a 206 carrying VALID success-shaped JSON is still fatal — the gate is the status, not the parse", async () => {
    const { client } = makeClient([ok(http(206, {}, `{"type":"file","sha":"${SHA}","size":12}`))]);
    await expect(client.fetchFileMeta("o", "r", "package.json", SHA)).rejects.toThrow(/only exactly 200/);
  });

  test("rateLimit: a 206 carrying valid JSON is fatal, not consumed", async () => {
    const { client } = makeClient([ok(http(206, {}, `{"resources":{"core":{"remaining":100}}}`))]);
    await expect(client.rateLimit()).rejects.toThrow(/only exactly 200/);
  });

  test("a 304 with NO cached body stays fatal — the narrowing does not touch the revalidation flow", async () => {
    // If-None-Match is only ever sent when a cached etag+body exist, so a 304 arriving with no
    // usable cache row is anomalous and was already fatal; pin that the 2xx narrowing (which
    // sits just above it in the classifier) leaves this path exactly as it was.
    const { client } = makeClient([err(`HTTP/2.0 304 Not Modified\r\nEtag: W/"x"`, "gh: HTTP 304")]);
    await expect(client.restGet("user/orgs?per_page=100&page=1")).rejects.toThrow(/304/);
  });

  test("a 206 on revalidation leaves the previously-trusted exact-200 cache row UNTOUCHED", async () => {
    // The poisoned response must fail the call without destroying good state: the existing row
    // was written from a genuine exact-200 and stays serveable once the middlebox stops lying.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient(
      [ok(http(200, { etag: 'W/"good"' }, `{"a":1}`)), ok(http(206, {}, "partial"))],
      { db },
    );
    const first = await client.restGet("user/orgs?per_page=100&page=1");
    expect(first.body).toBe(`{"a":1}`);
    await expect(client.restGet("user/orgs?per_page=100&page=1")).rejects.toThrow(/only exactly 200/);
    expect(calls.length).toBe(2);
    const row = db.read("SELECT response_body AS body, etag FROM api_cache").get() as { body: string; etag: string };
    expect(row.body).toBe(`{"a":1}`); // not overwritten, not tombstoned
    expect(row.etag).toBe('W/"good"');
    db.close();
  });

  test("a parsed 200 from a FAILED gh process is a TRUNCATED transfer — transient retry, never consumed or persisted", async () => {
    // gh api -i streams the body AFTER printing the header block, so a mid-body transport
    // failure leaves a well-formed 200 head + partial body on stdout and a NONZERO exit —
    // invisible to every status gate. Persistent failure must exhaust the transient retries
    // and surface the stderr diagnostic, leaving nothing in the cache.
    const truncated = err(http(200, { etag: 'W/"t"' }, `{"half":`), "read: connection reset by peer");
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls, sleeps } = makeClient([truncated, truncated, truncated, truncated, truncated, truncated], { db });
    // the stderr diagnostic specifically — the wrapper's own "truncated" wording would match
    // even if stderr propagation were dropped
    await expect(client.restGet("user/orgs?per_page=100&page=1")).rejects.toThrow(/connection reset by peer/);
    expect(calls.length).toBe(6); // exactly MAX_ATTEMPTS spawns…
    expect(sleeps.length).toBe(5); // …with a backoff between each pair, none after the last
    const rows = db.read("SELECT COUNT(*) AS n FROM api_cache").get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });

  test("a truncated 200 recovers on retry — only the COMPLETE body is returned and persisted", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient(
      [err(http(200, {}, "partial"), "read: connection reset"), ok(http(200, { etag: 'W/"f"' }, "full-body"))],
      { db },
    );
    const res = await client.restGet("user/orgs?per_page=100&page=1");
    expect(res.body).toBe("full-body");
    expect(calls.length).toBe(2);
    const row = db.read("SELECT response_body AS body FROM api_cache").get() as { body: string };
    expect(row.body).toBe("full-body"); // the truncated attempt never touched the cache
    db.close();
  });

  test("fetchFileRaw: a truncated 200 can never poison the immutable cache (the reviewer-reproduced hole)", async () => {
    // Pre-gate, this exact sequence returned "partial" AND froze it into the SHA-pinned
    // immutable path — served forever with zero network. Now the failed transfer retries.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient(
      [err(http(200, {}, "partial"), "read: connection reset"), ok(http(200, {}, "full"))],
      { db },
    );
    const body = await client.fetchFileRaw("o", "r", "package.json", SHA);
    expect(body).toBe("full");
    expect(calls.length).toBe(2);
    const again = await client.fetchFileRaw("o", "r", "package.json", SHA);
    expect(again).toBe("full");
    expect(calls.length).toBe(2); // immutable hit serves the COMPLETE body, zero new spawns
    db.close();
  });

  test("gh2-era cache rows are quarantined by the gh3 epoch — a pre-exit-gate row may be a truncated 200", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const legacyEndpoint = `repos/o/r/contents/package.json?ref=${SHA}`;
    db.putApiCache({ method: "GET", url: `gh2:github.com:${legacyEndpoint}`, variantHash: "application/vnd.github.raw+json", etag: null, responseBody: "gh2-era-possibly-truncated" });
    const { client, calls } = makeClient([ok(http(200, {}, "fresh-full-body"))], { db });
    const body = await client.fetchFileRaw("o", "r", "package.json", SHA);
    expect(body).toBe("fresh-full-body"); // the network answered — never the gh2 row
    expect(calls.length).toBe(1);
    db.close();
  });

  test("legacy pre-epoch cache rows are quarantined — never served to ANY consumer", async () => {
    // Rows are statusless, survive --fresh, and pre-gate code cached any ok-classified 2xx. The
    // raw contents/blob consumers have no structural validation, so a legacy 206 body would ride
    // the immutable hit's synthesized 200 straight into the scan pipeline with ZERO network
    // calls. The key epoch makes every pre-gate row unreachable; --purge-cache reclaims them.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const SHA2 = "0123456789abcdef0123456789abcdef01234567";
    const legacyEndpoint = `repos/o/r/contents/package.json?ref=${SHA2}`;
    db.putApiCache({ method: "GET", url: `gh:github.com:${legacyEndpoint}`, variantHash: "application/vnd.github.raw+json", etag: null, responseBody: "partial-206-body" });
    const { client, calls } = makeClient([ok(http(200, {}, "full-body"))], { db });
    const body = await client.fetchFileRaw("o", "r", "package.json", SHA2);
    expect(body).toBe("full-body"); // the network answered — never the legacy row
    expect(calls.length).toBe(1);
    db.close();
  });

  test("the epoch namespace is DISJOINT from the legacy grammar even under host:port collisions", async () => {
    // githubHost accepts host:port and numeric hosts, so an epoch spelled INSIDE the old `gh:`
    // namespace (e.g. `gh:200.1:`) would collide: legacy host "200.1:443" and current host "443"
    // spell the same key. The prefix itself must be impossible under the old grammar — every
    // first-epoch key starts with the literal `gh:`, so a later epoch prefix (`gh2:`, `gh3:`, …)
    // can never match one.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const SHA2 = "0123456789abcdef0123456789abcdef01234567";
    const legacyEndpoint = `repos/o/r/contents/package.json?ref=${SHA2}`;
    // a legacy row written by PRE-gate code configured with githubHost "200.1:443"
    db.putApiCache({ method: "GET", url: `gh:200.1:443:${legacyEndpoint}`, variantHash: "application/vnd.github.raw+json", etag: null, responseBody: "poisoned-legacy-body" });
    const { client, calls } = makeClient([ok(http(200, {}, "full-body"))], { db, githubHost: "443" });
    const body = await client.fetchFileRaw("o", "r", "package.json", SHA2);
    expect(body).toBe("full-body");
    expect(calls.length).toBe(1);
    db.close();
  });

  test("restGetJson: an invalid-JSON 200 body does NOT poison the immutable cache — fetchFileMeta refetches, then the repaired row serves zero-network", async () => {
    // restGet persists the exact-200 body BEFORE restGetJson's JSON.parse validates it. Without the
    // tombstone, fetchFileMeta's SHA-pinned immutable row would re-serve the unparseable body forever
    // with ZERO network (JSON.parse failing on every later call). This pins restGetJson's invalid-JSON
    // tombstone (the twin of fetchTreeRecursive's) via a structured-JSON consumer — previously uncovered.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient(
      [ok(http(200, {}, `{bad json`)), ok(http(200, {}, `{"type":"file","sha":"${SHA}","size":12}`))],
      { db },
    );
    await expect(client.fetchFileMeta("o", "r", "package.json", SHA)).rejects.toThrow(/invalid JSON/);
    // the row is TOMBSTONED (NULL body AND NULL etag) — not merely deleted/absent. The NULL BODY is
    // what disables both cache-serving paths (the immutable hit and the 304 re-serve each require a
    // non-null body), forcing the refetch below; the NULL etag additionally suppresses If-None-Match.
    const tomb = db.read("SELECT COUNT(*) AS n FROM api_cache WHERE response_body IS NULL AND etag IS NULL").get() as { n: number };
    expect(tomb.n).toBe(1); // exactly one tombstone row
    const live = db.read("SELECT COUNT(*) AS n FROM api_cache WHERE response_body IS NOT NULL").get() as { n: number };
    expect(live.n).toBe(0); // and no live poisoned row
    const meta = await client.fetchFileMeta("o", "r", "package.json", SHA);
    expect((meta as { sha: string }).sha).toBe(SHA);
    expect(calls.length).toBe(2); // the immutable path did NOT serve the poison with zero network — it refetched
    const again = await client.fetchFileMeta("o", "r", "package.json", SHA);
    expect((again as { sha: string }).sha).toBe(SHA);
    expect(calls.length).toBe(2); // …and the REPAIRED exact-200 row now earns the immutable zero-network hit
    db.close();
  });

  test("restGet: noStore OVERRIDES immutable — a SHA-pinned pre-seeded row is neither served, revalidated, nor overwritten", async () => {
    // `immutable` alone would serve the seeded row with ZERO network; noStore must win — a plain
    // uncached fetch that touches the row in no way (no read, no If-None-Match, no persist). Pins the
    // documented precedence independently of pagination (the only in-tree noStore caller today).
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const ep = `repos/o/r/contents/package.json?ref=${SHA}`; // SHA-pinned → endpointIsShaPinned true
    db.putApiCache({ method: "GET", url: `gh3:github.com:${ep}`, variantHash: "", etag: 'W/"imm"', responseBody: "cached-immutable-body" });
    const spy = countCacheAccess(db); // prove noStore touches the DB zero times, not merely that its effects are absent
    const { client, calls } = makeClient([ok(http(200, { etag: 'W/"fresh"' }, "fresh-network-body"))], { db });
    const res = await client.restGet(ep, { immutable: true, noStore: true });
    expect(res.body).toBe("fresh-network-body"); // fetched fresh, NOT the seed — noStore beat immutable
    expect(calls.length).toBe(1); // network was hit; the immutable zero-network shortcut did not fire
    expect(calls[0]!.args.some((a) => a.toLowerCase().startsWith("if-none-match:"))).toBe(false); // no validator sent
    expect(spy.reads).toBe(0); // getApiCache was never CALLED — a read-then-discard mutant fails here
    expect(spy.writes).toBe(0); // putApiCache was never called — no persist over the seed
    const row = db.read(`SELECT response_body AS body, etag FROM api_cache WHERE url = 'gh3:github.com:${ep}'`).get() as { body: string; etag: string };
    expect(row.body).toBe("cached-immutable-body"); // seed unchanged — noStore did not persist over it
    expect(row.etag).toBe('W/"imm"');
    db.close();
  });

  test("restGet under noStore: an unsolicited 304 is fatal, never laundered through a bypassed cache row", async () => {
    // noStore never reads the cache, so a 304 (impossible without our If-None-Match) cannot be served
    // as a cached body — it falls through to classifyRest and fails loud.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const ep = `repos/o/r/contents/package.json?ref=${SHA}`;
    db.putApiCache({ method: "GET", url: `gh3:github.com:${ep}`, variantHash: "", etag: 'W/"imm"', responseBody: "seed" });
    const spy = countCacheAccess(db);
    const { client } = makeClient([err(`HTTP/2.0 304 Not Modified\r\nEtag: W/"imm"`, "gh: HTTP 304")], { db });
    await expect(client.restGet(ep, { noStore: true })).rejects.toThrow(/304/);
    expect(spy.reads).toBe(0); // even on the 304 branch, noStore read nothing…
    expect(spy.writes).toBe(0); // …and wrote nothing
    const row = db.read(`SELECT response_body AS body, etag FROM api_cache WHERE url = 'gh3:github.com:${ep}'`).get() as { body: string; etag: string };
    expect(row.body).toBe("seed"); // the seed row was neither consumed nor mutated
    expect(row.etag).toBe('W/"imm"');
    db.close();
  });

  test("restGet immutable:true is IGNORED for a non-sha-pinned endpoint (defense in depth)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient(
      [ok(http(200, { etag: 'W/"e"' }, "a")), ok(http(200, {}, "b"))],
      { db },
    );
    // a caller forcing immutable on a mutable branch-ref endpoint must NOT get a frozen cache hit
    await client.restGet("repos/o/r/contents/p?ref=main", { immutable: true });
    const second = await client.restGet("repos/o/r/contents/p?ref=main", { immutable: true });
    expect(calls.length).toBe(2); // revalidated, not served with zero network
    expect(second.body).toBe("b");
    db.close();
  });

  test("raw and default-JSON reads of one URL use distinct cache variants", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient(
      [ok(http(200, {}, "raw-body")), ok(http(200, {}, `{"type":"file"}`))],
      { db },
    );
    await client.fetchFileRaw("o", "r", "a.json", SHA);
    const meta = await client.fetchFileMeta("o", "r", "a.json", SHA);
    expect(calls.length).toBe(2); // no variant collision → second call really fetched
    expect((meta as { type: string }).type).toBe("file");
    db.close();
  });

  test("404 throws GithubApiError with status", async () => {
    const { client } = makeClient([err(http(404, {}, `{"message":"Not Found"}`), "gh: Not Found (HTTP 404)")]);
    await expect(client.restGet("repos/o/missing")).rejects.toThrow(GithubApiError);
  });

  test("primary throttle pauses the core bucket until reset, then retries", async () => {
    const NOW = 1_000_000_000_000;
    const reset = String(NOW / 1000 + 10);
    const { client, calls, sleeps } = makeClient([
      err(http(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, `{"message":"rate limit"}`)),
      ok(http(200, {}, `{"ok":true}`)),
    ]);
    const res = await client.restGet("rate_limit");
    expect(res.body).toBe(`{"ok":true}`);
    expect(calls.length).toBe(2);
    expect(sleeps.some((ms) => ms >= 10_000 && ms <= 20_000)).toBe(true); // reset + skew pad
  });

  test("secondary throttle honors Retry-After; ThrottleExhausted after persistent throttling", async () => {
    const throttle = err(http(429, { "x-ratelimit-remaining": "50", "retry-after": "7" }, "{}"));
    const { client, sleeps } = makeClient([throttle, throttle, throttle, throttle, throttle, throttle]);
    await expect(client.restGet("rate_limit")).rejects.toThrow(ThrottleExhausted);
    expect(sleeps.filter((ms) => ms === 7_000).length).toBeGreaterThanOrEqual(5);
  });

  test("no-HTTP-response spawn failures retry then surface stderr", async () => {
    const netfail = err("", "gh: could not connect");
    const { client, sleeps } = makeClient([netfail, netfail, netfail, netfail, netfail, netfail]);
    await expect(client.restGet("rate_limit")).rejects.toThrow(/could not connect/);
    expect(sleeps.length).toBeGreaterThanOrEqual(5);
  });
});

// ---- pure envelope validators ------------------------------------------------------------------
describe("parseGraphqlEnvelope / parseTreeResponse (pure)", () => {
  test("a well-formed data envelope: malformed null, data verbatim, no errors", () => {
    expect(parseGraphqlEnvelope(`{"data":{"x":1}}`)).toEqual({ data: { x: 1 }, errors: [], malformed: null });
  });
  test("junk beside a readable entry: the readable projection survives AND the violation is flagged", () => {
    const env = parseGraphqlEnvelope(`{"errors":[null,{"type":"RATE_LIMITED","message":"slow"},{"message":{"x":1}}]}`);
    expect(env.errors).toEqual([{ type: "RATE_LIMITED", message: "slow" }]);
    expect(env.malformed).not.toBeNull();
  });
  test("a non-string type is dropped from the projection but a string message on the SAME entry is kept", () => {
    const env = parseGraphqlEnvelope(`{"errors":[{"type":42,"message":"still readable"}]}`);
    expect(env.errors).toEqual([{ message: "still readable" }]);
    expect(env.malformed).toContain("type is not a string");
  });
  test("data:null beside valid errors is the legal total-failure shape — not malformed", () => {
    const env = parseGraphqlEnvelope(`{"data":null,"errors":[{"message":"boom"}]}`);
    expect(env.malformed).toBeNull();
    expect(env.data).toBeNull();
  });
  test("extra unknown envelope/entry keys are tolerated (strict on what we consume only)", () => {
    const env = parseGraphqlEnvelope(`{"data":{"x":1},"extensions":{"cost":1}}`);
    expect(env.malformed).toBeNull();
  });
  const SHA = "a".repeat(40);
  test("expectedSha null skips the root-sha check (non-SHA-pinned request)", () => {
    const res = parseTreeResponse({ truncated: false, tree: [] }, "ep", null);
    expect(res).toEqual({ truncated: false, paths: [] });
  });
  test("the root-sha comparison is case-insensitive (gh may echo either case)", () => {
    const res = parseTreeResponse({ sha: SHA.toUpperCase(), truncated: false, tree: [] }, "ep", SHA);
    expect(res.truncated).toBe(false);
  });
  test("size zero is legal; absent size maps to null", () => {
    const res = parseTreeResponse(
      { sha: SHA, truncated: false, tree: [{ path: "a", type: "blob", sha: "b".repeat(40), size: 0 }, { path: "b", type: "commit", sha: "c".repeat(40) }] },
      "ep", SHA,
    );
    if (res.truncated) throw new Error("expected a non-truncated tree");
    expect(res.paths.map((p) => p.size)).toEqual([0, null]);
  });
  test("a blob entry MISSING size fails closed — a null size would bypass the 2 MiB scan cap", () => {
    // unitPipeline skips only entries whose size EXCEEDS the cap; a null size sails through and the
    // (possibly huge) blob is fetched + scanned. Real GitHub always emits size for blobs, so require it.
    expect(() =>
      parseTreeResponse({ sha: SHA, truncated: false, tree: [{ path: "a", type: "blob", sha: "b".repeat(40) }] }, "ep", SHA),
    ).toThrow(/tree\[0\] blob entry is missing size/);
  });
});

// ---- fetchTreeRecursive envelope validation (§5.C fail-closed) --------------------------------
// A malformed 200 git/trees response must FAIL LOUD (→ a scan-scope errors row via processUnit's
// catch), never read as "no files in this branch": `json.tree ?? []` silently produced an empty
// tree, and a missing/malformed `truncated` flag silently suppressed the clone fallback that is
// the caller's ONLY complete-tree escape hatch (orchestrate §5.C).
describe("fetchTreeRecursive envelope validation (§5.C fail-closed)", () => {
  const TREE_SHA = "f".repeat(40);
  const tree = (body: string) => ok(http(200, {}, body));
  const blob = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ path: "package.json", type: "blob", sha: "a".repeat(40), size: 12, ...over });
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ sha: TREE_SHA, truncated: false, tree: [blob()], ...over });

  test("a 200 response MISSING the tree member fails closed — never an empty tree", async () => {
    const { client } = makeClient([tree(JSON.stringify({ sha: TREE_SHA, truncated: false }))]);
    await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(/tree member/);
  });
  test("a non-array tree member is a clean GithubApiError, not a raw TypeError", async () => {
    const { client } = makeClient([tree(body({ tree: "nope" }))]);
    await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(GithubApiError);
  });
  test("a MISSING or non-boolean truncated flag fails closed — false would silently disable the clone fallback", async () => {
    for (const b of [JSON.stringify({ sha: TREE_SHA, tree: [blob()] }), body({ truncated: "yes" })]) {
      const { client } = makeClient([tree(b)]);
      await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(/truncated/);
    }
  });
  test("a non-object JSON root (null/array/primitive) is a clean GithubApiError", async () => {
    for (const b of ["null", "[]", "42", `"tree"`]) {
      const { client } = makeClient([tree(b)]);
      await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(GithubApiError);
    }
  });
  test("a non-object tree entry fails closed", async () => {
    for (const entry of [null, "x", 7, [1]]) {
      const { client } = makeClient([tree(body({ tree: [entry] }))]);
      await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(GithubApiError);
    }
  });
  test("an entry with a missing/empty/non-canonical path fails closed — it would misaddress every downstream read", async () => {
    // leading/trailing/double slash and dot segments would silently become the swallowed contents
    // 404 (orchestrate apiReader); a NUL would corrupt the permalink and the contents URL.
    const bads: Array<Record<string, unknown>> = [
      { path: undefined }, { path: "" }, { path: 5 },
      { path: "/lead" }, { path: "trail/" }, { path: "a//b" }, { path: "a/./b" }, { path: "a/../b" }, { path: "a\u0000b" },
    ];
    for (const over of bads) {
      const { client } = makeClient([tree(body({ tree: [blob(over)] }))]);
      await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(GithubApiError);
    }
  });
  test("a DUPLICATE path fails closed — last-wins mapping downstream would let a later entry mask a manifest", async () => {
    const { client } = makeClient([tree(body({ tree: [blob(), blob({ type: "tree", size: undefined })] }))]);
    await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(/duplicate/);
  });
  test("an unknown entry type fails closed — the blob filter downstream would silently discard it", async () => {
    const { client } = makeClient([tree(body({ tree: [blob({ type: "symlink" })] }))]);
    await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(/type/);
  });
  test("a non-hex entry sha fails closed — it addresses the blob fetch", async () => {
    for (const sha of [undefined, "", "main", "zz".repeat(20)]) {
      const { client } = makeClient([tree(body({ tree: [blob({ sha })] }))]);
      await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(GithubApiError);
    }
  });
  test("a PRESENT size must be a non-negative safe integer — Infinity (1e400), negatives and fractions fail closed", async () => {
    // typeof-number alone admits JSON.parse("1e400") === Infinity, which would trip the silent
    // large-file skip downstream instead of failing loud.
    for (const raw of [`1e400`, `-1`, `1.5`, `"5"`, `null`]) {
      const { client } = makeClient([tree(`{"sha":"${TREE_SHA}","truncated":false,"tree":[{"path":"p","type":"blob","sha":"${"a".repeat(40)}","size":${raw}}]}`)]);
      await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(GithubApiError);
    }
  });
  test("a response whose root sha does not match the requested tree oid fails closed", async () => {
    const { client } = makeClient([tree(body({ sha: "e".repeat(40) }))]);
    await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(/does not match/);
  });
  test("HTTP 2xx-but-not-200 (e.g. 206 Partial Content) is NOT success — a partial tree must not read as complete", async () => {
    // now trips at classifyRest (restGet fails every non-200 2xx closed); the tree fetcher's own
    // inner gate is exercised independently by the stubbed-restGet test below.
    const { client } = makeClient([ok(http(206, {}, body()))]);
    await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(/only exactly 200/);
  });
  test("the tree fetcher's OWN exact-200 gate holds even if restGet were to leak a non-200 2xx (defense in depth)", async () => {
    // classifyRest already fails non-200 2xx closed, so this state is unreachable through the
    // spawn seam — stub restGet to prove tree completeness never silently depends on a distant
    // classifier's range staying narrow.
    const { client } = makeClient([]);
    client.restGet = async () => ({ status: 206, headers: {}, body: body() });
    await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(/only exactly 200/);
  });
  test("a valid response maps entries verbatim; absent size maps to null", async () => {
    const b = JSON.stringify({ sha: TREE_SHA, truncated: false, tree: [blob(), { path: "src", type: "tree", sha: "b".repeat(40) }] });
    const { client } = makeClient([tree(b)]);
    const res = await client.fetchTreeRecursive("o", "r", TREE_SHA);
    expect(res).toEqual({
      truncated: false,
      paths: [
        { path: "package.json", type: "blob", sha: "a".repeat(40), size: 12 },
        { path: "src", type: "tree", sha: "b".repeat(40), size: null },
      ],
    });
  });
  test("truncated:true returns NO paths — the partial list is unusable, and `paths` is a COMPILE error on it", async () => {
    // per-entry validation is deliberately skipped here: junk inside a partial list must not block
    // the clone fallback, and nothing downstream may read these entries anyway.
    const b = JSON.stringify({ sha: TREE_SHA, truncated: true, tree: [{ path: 42 }] });
    const { client } = makeClient([tree(b)]);
    const res = await client.fetchTreeRecursive("o", "r", TREE_SHA);
    expect(res).toEqual({ truncated: true });
    expect(Object.hasOwn(res, "paths")).toBe(false); // no `paths` key at runtime, not just at the type level
    if (res.truncated) {
      // @ts-expect-error — the discriminated union makes `paths` inaccessible on the truncated variant;
      // this line stops compiling (unused @ts-expect-error) if `paths` is ever added back, guarding the union.
      void res.paths;
    }
  });
  test("a malformed 200 body does NOT permanently poison the immutable cache — the next call refetches", async () => {
    // restGet caches the 200 body BEFORE validation sees it; without the tombstone the SHA-pinned
    // immutable path would serve the malformed body forever (until --purge-cache).
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient(
      [tree(JSON.stringify({ sha: TREE_SHA, truncated: false })), tree(body())],
      { db },
    );
    await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(/tree member/);
    const second = await client.fetchTreeRecursive("o", "r", TREE_SHA);
    if (second.truncated) throw new Error("expected a non-truncated tree");
    expect(second.paths.map((p) => p.path)).toEqual(["package.json"]);
    expect(calls.length).toBe(2); // call 2 went back to the network, not the poisoned cache row
    const third = await client.fetchTreeRecursive("o", "r", TREE_SHA);
    expect(third).toEqual(second);
    expect(calls.length).toBe(2); // …and the VALID body still earns the immutable zero-network hit
    db.close();
  });
  test("a direct 2xx-non-200 tree response is fatal, leaves NO cache row, and the next call refetches cleanly", async () => {
    // Laundering is doubly closed: restGet persists only exact-200 bodies AND classifyRest now
    // fails a direct non-200 2xx before any consumer sees it. Pin the recovery shape: the failed
    // call leaves no poisoned row behind, so the retry serves fresh valid bytes from the network.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient([ok(http(206, {}, body())), tree(body())], { db });
    await expect(client.fetchTreeRecursive("o", "r", TREE_SHA)).rejects.toThrow(/only exactly 200/);
    const afterFailure = db.read("SELECT COUNT(*) AS n FROM api_cache").get() as { n: number };
    expect(afterFailure.n).toBe(0); // restGet threw before the fetcher ran — not even a tombstone
    const second = await client.fetchTreeRecursive("o", "r", TREE_SHA);
    expect(second.truncated).toBe(false);
    expect(calls.length).toBe(2);
    db.close();
  });
});

describe("throttle wait clamping (§4 hardening)", () => {
  // 10 years past the fake clock — a poisoned response must not command such a pause.
  const FAR_FUTURE_SEC = String(1_000_000_000 + 315_360_000);

  test("MAX_PAUSE_MS is 2 hours (independent literal pins the magnitude)", () => {
    // guards against a silent magnitude typo: every other clamp assertion is
    // self-referential against the imported constant and would scale with it.
    expect(MAX_PAUSE_MS).toBe(7_200_000);
  });

  test("a primary 403 with a far-future x-ratelimit-reset sleeps exactly MAX_PAUSE_MS, then retries", async () => {
    const { client, calls, sleeps } = makeClient([
      err(http(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": FAR_FUTURE_SEC }, `{"message":"rate limit"}`)),
      ok(http(200, {}, `{"ok":true}`)),
    ]);
    const res = await client.restGet("rate_limit");
    expect(res.body).toBe(`{"ok":true}`);
    expect(calls.length).toBe(2);
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sleeps)).toBe(MAX_PAUSE_MS);
  });

  test("a 429 with an absurd Retry-After sleeps exactly MAX_PAUSE_MS, then retries", async () => {
    const { client, calls, sleeps } = makeClient([
      err(http(429, { "x-ratelimit-remaining": "50", "retry-after": "315360000" }, "{}")),
      ok(http(200, {}, `{"ok":true}`)),
    ]);
    const res = await client.restGet("rate_limit");
    expect(res.body).toBe(`{"ok":true}`);
    expect(calls.length).toBe(2);
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sleeps)).toBe(MAX_PAUSE_MS);
  });

  test("a graphql RATE_LIMITED with a far-future reset sleeps exactly MAX_PAUSE_MS, then retries", async () => {
    // exit 1 on the throttle page: gh exits nonzero for a 200-with-errors envelope BY DESIGN
    const { client, sleeps } = makeClient([
      err(http(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": FAR_FUTURE_SEC }, `{"errors":[{"type":"RATE_LIMITED","message":"slow down"}]}`), "gh: GraphQL error"),
      ok(http(200, {}, `{"data":{"x":1}}`)),
    ]);
    const data = await client.graphql("query{x}", {});
    expect(data).toEqual({ x: 1 });
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sleeps)).toBe(MAX_PAUSE_MS);
  });

  test("graphql 200 with a PRESENT-but-non-array errors field fails closed — never coerced to 'no errors'", async () => {
    // GraphQL spec: a present `errors` member is an array. A response carrying coherent data plus
    // errors:"garbage" must NOT classify ok: the error signal we were meant to see is unreadable,
    // and an ok:true branch discovery feeds the reconcile PRUNE — a coerced-away failure
    // could turn a partial result into row deletion. Fail closed instead.
    // exit 1: gh reports a non-empty STRING errors value as a server error
    const { client } = makeClient([err(http(200, {}, `{"data":{"x":1},"errors":"garbage"}`), "gh: garbage")]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(GithubApiError);
  });

  test("a malformed errors field does NOT preempt status evidence: 503+garbage stays transient (retries to success)", async () => {
    // The malformed-envelope check must run AFTER classifyGraphql: a 5xx's retry semantics come from
    // the STATUS, and hardening the ok path must not convert a transient outage into a fatal error.
    const { client, sleeps } = makeClient([
      err(http(503, {}, `{"errors":"boom"}`), "gh: HTTP 503"), // gh exits 1 on any HTTP error status
      ok(http(200, {}, `{"data":{"x":1}}`)),
    ]);
    const data = await client.graphql("query{x}", {});
    expect(data).toEqual({ x: 1 });
    expect(sleeps.length).toBeGreaterThanOrEqual(1); // it actually took the transient retry path
  });

  test("a truncated graphql envelope (headers-only 200 + nonzero exit + unparseable body) is TRANSIENT, retried", async () => {
    // gh buffers the graphql JSON and aborts printing on a mid-stream read failure → a well-formed
    // HTTP-200 head + truncated (here empty) body + nonzero exit. That is transport truncation, not a
    // semantic malformation, so it retries under the transient budget — unlike a COMPLETE errors
    // envelope (RATE_LIMITED etc.), which parses fine and must never be blind-retried.
    const { client, calls, sleeps } = makeClient([
      err(http(200, {}, ""), "curl: (56) Recv failure: Connection reset by peer"), // truncated transport
      ok(http(200, {}, `{"data":{"x":1}}`)), // succeeds on retry
    ]);
    const data = await client.graphql("query{x}", {});
    expect(data).toEqual({ x: 1 });
    expect(calls.length).toBe(2); // exactly one retry
    expect(sleeps.length).toBe(1); // one transient backoff
  });
  test("an unparseable graphql body at EXIT 0 stays FATAL (gh succeeded but printed garbage — not truncation)", async () => {
    // Only a NONZERO exit marks transport truncation; an unparseable body at exit 0 is a genuine
    // malformation and must NOT be retried — proves the retry is scoped, not a blanket exit guard.
    const { client, calls } = makeClient([ok(http(200, {}, "<html>bad</html>"))]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(/graphql envelope/);
    expect(calls.length).toBe(1); // no retry
  });
  test("a PERSISTENT graphql transport truncation exhausts the retry budget and throws WITH gh stderr", async () => {
    const truncated = err(http(200, {}, ""), "curl: (56) Recv failure: Connection reset by peer");
    const { client, calls } = makeClient(Array.from({ length: 6 }, () => truncated)); // MAX_ATTEMPTS = 6
    let caught: unknown;
    try { await client.graphql("query{x}", {}); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect((caught as Error).message).toMatch(/unparseable JSON body/);
    expect((caught as Error).message).toMatch(/Connection reset by peer/); // final throw retains gh stderr
    expect(calls.length).toBe(6); // every attempt consumed
  });

  test("a malformed errors field does NOT preempt SSO evidence: 403+x-github-sso stays fatal WITH ssoRequired", async () => {
    const { client } = makeClient([
      err(http(403, { "x-ratelimit-remaining": "5", "x-github-sso": "required" }, `{"errors":"garbage"}`), "gh: HTTP 403"), // gh exits 1 on any HTTP error status
    ]);
    let caught: unknown;
    try {
      await client.graphql("query{x}", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect((caught as GithubApiError).ssoRequired).toBe(true); // the SSO remediation signal survives
  });

  test("MAX_TOTAL_PAUSE_MS is 8 hours (independent literal pins the magnitude)", () => {
    expect(MAX_TOTAL_PAUSE_MS).toBe(28_800_000);
  });

  test("cumulative bucket pause budget trips ThrottleExhausted instead of sleeping forever", async () => {
    // freshly-poisoned primary on every attempt: each response re-arms a 2h pause. The
    // per-bucket budget must stop the bleeding at MAX_TOTAL_PAUSE_MS total slept — and the
    // spent budget must persist, so the NEXT call in the bucket fails fast without sleeping.
    const poisoned = err(http(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": FAR_FUTURE_SEC }, `{"message":"rate limit"}`));
    const { client, calls, sleeps } = makeClient(Array.from({ length: 12 }, () => poisoned));
    await expect(client.restGet("rate_limit")).rejects.toThrow(ThrottleExhausted);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_TOTAL_PAUSE_MS);
    const callsBefore = calls.length;
    const sleepsBefore = sleeps.length;
    await expect(client.restGet("rate_limit")).rejects.toThrow(ThrottleExhausted);
    expect(calls.length).toBe(callsBefore); // fails fast: no new spawn
    expect(sleeps.length).toBe(sleepsBefore); // and no new sleep
  });

  test("the graphql bucket has its own cumulative pause budget", async () => {
    const poisoned = err(http(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": FAR_FUTURE_SEC }, `{"errors":[{"type":"RATE_LIMITED","message":"slow down"}]}`), "gh: GraphQL error");
    const { client, sleeps } = makeClient(Array.from({ length: 12 }, () => poisoned));
    await expect(client.graphql("query{x}", {})).rejects.toThrow(ThrottleExhausted);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_TOTAL_PAUSE_MS);
    const sleepsBefore = sleeps.length;
    await expect(client.graphql("query{x}", {})).rejects.toThrow(ThrottleExhausted);
    expect(sleeps.length).toBe(sleepsBefore);
  });

  test("the final attempt's classification does not arm a residual pause for the next call", async () => {
    // 6 secondary throttles exhaust the call; the LAST response must not tax the next,
    // possibly honest, call with an inherited pause.
    const throttle = err(http(429, { "x-ratelimit-remaining": "50", "retry-after": "7" }, "{}"));
    const { client, sleeps } = makeClient([...Array.from({ length: 6 }, () => throttle), ok(http(200, {}, `{"ok":1}`))]);
    await expect(client.restGet("rate_limit")).rejects.toThrow(ThrottleExhausted);
    const sleepsBefore = sleeps.length;
    const res = await client.restGet("rate_limit");
    expect(res.body).toBe(`{"ok":1}`);
    expect(sleeps.length).toBe(sleepsBefore); // no residual pause inherited
  });

  test("Retry-After numeric seconds has the same 1s floor as the HTTP-date form", () => {
    expect(parseRetryAfterMs("0", 1_000_000_000_000)).toBe(1000);
  });

  test("graphql: the final attempt's classification does not arm a residual pause either", async () => {
    const throttle = err(http(200, { "x-ratelimit-remaining": "50", "retry-after": "7" }, `{"errors":[{"type":"RATE_LIMITED","message":"slow down"}]}`), "gh: GraphQL error");
    const { client, sleeps } = makeClient([...Array.from({ length: 6 }, () => throttle), ok(http(200, {}, `{"data":{"x":1}}`))]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(ThrottleExhausted);
    const sleepsBefore = sleeps.length;
    const data = await client.graphql("query{x}", {});
    expect(data).toEqual({ x: 1 });
    expect(sleeps.length).toBe(sleepsBefore); // no residual pause inherited
  });

  test("restGet: the final attempt's PRIMARY classification does not arm a residual pause", async () => {
    // small GENUINE resets so all 6 primary attempts complete within budget; the LAST
    // response's far-future reset must not be armed for the follow-up call.
    const NOW_SEC = 1_000_000_000;
    const primaryAt = (sec: number) =>
      err(http(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW_SEC + sec) }, `{"message":"rate limit"}`));
    const { client, sleeps } = makeClient([
      primaryAt(100), primaryAt(300), primaryAt(500), primaryAt(700), primaryAt(900),
      primaryAt(999_999), // final attempt: would arm ~11 days if the guard regressed
      ok(http(200, {}, `{"ok":1}`)),
    ]);
    await expect(client.restGet("rate_limit")).rejects.toThrow(ThrottleExhausted);
    const sleepsBefore = sleeps.length;
    const res = await client.restGet("rate_limit");
    expect(res.body).toBe(`{"ok":1}`);
    expect(sleeps.length).toBe(sleepsBefore); // the poisoned final primary was not armed
  });

  test("a graphql SECONDARY (remaining>0) with an absurd Retry-After sleeps exactly MAX_PAUSE_MS", async () => {
    // the exact-equality assertion distinguishes a clamped Retry-After from the
    // exponential-backoff substitute that a nulled wait would produce (60s base).
    const { client, sleeps } = makeClient([
      err(http(200, { "x-ratelimit-remaining": "50", "retry-after": "315360000" }, `{"errors":[{"type":"RATE_LIMITED","message":"slow down"}]}`), "gh: GraphQL error"),
      ok(http(200, {}, `{"data":{"x":1}}`)),
    ]);
    const data = await client.graphql("query{x}", {});
    expect(data).toEqual({ x: 1 });
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sleeps)).toBe(MAX_PAUSE_MS);
  });
});

describe("constructor knob validation (fail-fast at the boundary)", () => {
  const base = { githubHost: "github.com", env: { HOME: "/tmp", PATH: "/bin" }, binPaths: BINS, tempRoot: TEST_TMP };
  test("concurrency < 1 throws instead of hanging the first acquire forever", () => {
    expect(() => new GithubClient({ ...base, concurrency: 0 })).toThrow(/concurrency must be >= 1/);
    expect(() => new GithubClient({ ...base, concurrency: -2 })).toThrow(/concurrency must be >= 1/);
  });
  test("spawnTimeoutMs < 1 throws instead of instantly expiring every spawn", () => {
    expect(() => new GithubClient({ ...base, spawnTimeoutMs: 0 })).toThrow(/spawnTimeoutMs must be >= 1/);
  });
});

describe("readCapped spawn-output byte cap (§4/§5.C)", () => {
  // readCapped gates EVERY gh/git/tar spawn's output at MAX_SPAWN_OUTPUT_BYTES — a fake
  // reader exercises the cap directly (a real 110MB subprocess would be pure test tax).
  const bytes = (n: number): Uint8Array => new Uint8Array(n);
  const scripted = (reads: Array<{ done?: boolean; value?: Uint8Array }>): { reader: StreamReader; readsIssued: () => number } => {
    let i = 0;
    return {
      reader: { read: async () => reads[i++] ?? { done: true }, cancel: async () => {} },
      readsIssued: () => i,
    };
  };

  test("kills the process the moment the cap is crossed and stops reading", async () => {
    let exceeded = 0;
    const { reader, readsIssued } = scripted([{ value: bytes(2) }, { value: bytes(2) }, { value: bytes(2) }]);
    await expect(readCapped(reader, 3, () => { exceeded++; })).rejects.toThrow(/spawn output exceeds 3 bytes/);
    expect(exceeded).toBe(1); // the kill fired exactly once
    expect(readsIssued()).toBe(2); // the crossing read was the LAST read — nothing buffered past it
  });

  test("a final done+value chunk is kept (Bun readers may deliver the last chunk with done)", async () => {
    const { reader } = scripted([{ done: true, value: new TextEncoder().encode("abc") }]);
    expect(await readCapped(reader, 3, () => { throw new Error("must not exceed"); })).toBe("abc");
  });

  test("a final done+value chunk is still cap-checked", async () => {
    let exceeded = 0;
    const { reader } = scripted([{ done: true, value: new TextEncoder().encode("abc") }]);
    await expect(readCapped(reader, 2, () => { exceeded++; })).rejects.toThrow(/spawn output exceeds 2 bytes/);
    expect(exceeded).toBe(1);
  });
});

describe("joinSpawnOutcome (reader/exit merge)", () => {
  const after = <T,>(ms: number, fn: () => T): Promise<T> =>
    new Promise((resolve, reject) => setTimeout(() => {
      try { resolve(fn()); } catch (e) { reject(e); }
    }, ms));

  test("the TEMPORALLY FIRST reader error wins, regardless of stream", async () => {
    // stderr fails first, stdout fails later — the earlier error is the diagnostic that
    // must surface (a later, secondary failure must not replace it).
    const stdoutP = after(25, (): string => { throw new Error("SECOND"); });
    const stderrP = after(5, (): string => { throw new Error("FIRST"); });
    await expect(joinSpawnOutcome(stdoutP, stderrP, after(30, () => 1))).rejects.toThrow(/FIRST/);
  });

  test("a reader error is HELD until the child has exited", async () => {
    let exited = false;
    const exitP = after(40, () => { exited = true; return 137; });
    const stdoutP = after(5, (): string => { throw new Error("cap"); });
    try {
      await joinSpawnOutcome(stdoutP, Promise.resolve(""), exitP);
      throw new Error("expected rejection");
    } catch (e) {
      expect((e as Error).message).toBe("cap");
      expect(exited).toBe(true); // the throw waited for proc.exited
    }
  });

  test("a clean run composes stdout/stderr/exitCode", async () => {
    expect(await joinSpawnOutcome(Promise.resolve("out"), Promise.resolve("err"), Promise.resolve(0)))
      .toEqual({ exitCode: 0, stdout: "out", stderr: "err" });
  });
});

describe("spawn wall-clock deadline (§4 hardening)", () => {
  // a poisoned endpoint can hang by PACING the response instead of via headers — every
  // spawn must carry a kill deadline so one wedged child cannot hold its semaphore slot
  // (gh) or the serial orchestrator (git) forever.
  test("SPAWN_TIMEOUT_MS is 15 minutes (independent literal pins the magnitude)", () => {
    expect(SPAWN_TIMEOUT_MS).toBe(900_000);
  });

  test("a never-resolving gh spawn times out, retries transiently, then surfaces an error instead of hanging", async () => {
    const signals: Array<SpawnAbortSignal | undefined> = [];
    const sleeps: number[] = [];
    let kills = 0;
    const client = new GithubClient({
      githubHost: "github.com",
      spawnImpl: (_bin, _args, opts) =>
        new Promise<SpawnResult>((resolve) => {
          signals.push(opts.signal);
          // stands in for realSpawn: the kill settles the spawn promise (readers cancelled)
          opts.signal?.onAbort(() => { kills++; resolve({ exitCode: 137, stdout: "", stderr: "killed" }); });
        }),
      sleepImpl: async (ms) => { sleeps.push(ms); },
      env: { HOME: "/home/u", PATH: "/bin" },
      binPaths: BINS,
      tempRoot: TEST_TMP,
      spawnTimeoutMs: 15,
    });
    await expect(client.restGet("rate_limit")).rejects.toThrow(/timed out/);
    expect(signals.length).toBe(6); // MAX_ATTEMPTS attempts, none hung forever
    expect(signals.every((s) => s?.aborted === true)).toBe(true);
    expect(kills).toBe(6); // the registered killer FIRED for every expired child
    expect(sleeps.length).toBeGreaterThanOrEqual(5); // transient backoff between attempts
  });

  test("a timed-out git spawn resolves with a nonzero exit instead of hanging", async () => {
    let signal: SpawnAbortSignal | undefined;
    const client = new GithubClient({
      githubHost: "github.com",
      spawnImpl: (_bin, _args, opts) =>
        new Promise<SpawnResult>((resolve) => {
          signal = opts.signal;
          opts.signal?.onAbort(() => resolve({ exitCode: 137, stdout: "", stderr: "killed" }));
        }),
      env: { HOME: "/home/u", PATH: "/bin" },
      binPaths: BINS,
      tempRoot: TEST_TMP,
      spawnTimeoutMs: 15,
    });
    const res = await client.git(["--version"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/timed out/);
    expect(res.stdout).toBe(""); // empty stdout is the contract: it parses as "no HTTP response"
    expect(signal?.aborted).toBe(true);
  });

  test("a timed-out tar spawn resolves with a nonzero exit instead of hanging", async () => {
    // tar extracts attacker-supplied registry tarballs — the most attacker-influenced spawn.
    let signal: SpawnAbortSignal | undefined;
    const client = new GithubClient({
      githubHost: "github.com",
      spawnImpl: (_bin, _args, opts) =>
        new Promise<SpawnResult>((resolve) => {
          signal = opts.signal;
          opts.signal?.onAbort(() => resolve({ exitCode: 137, stdout: "", stderr: "killed" }));
        }),
      env: { HOME: "/home/u", PATH: "/bin" },
      binPaths: BINS,
      tempRoot: TEST_TMP,
      spawnTimeoutMs: 15,
    });
    const res = await client.tar(["--version"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/timed out/);
    expect(res.stdout).toBe("");
    expect(signal?.aborted).toBe(true);
  });

  test("a fast spawn is unaffected by the default deadline", async () => {
    const { client } = makeClient([ok(http(200, {}, `{"ok":1}`))]);
    const res = await client.restGet("rate_limit");
    expect(res.body).toBe(`{"ok":1}`);
  });

  test("a timed-out spawn returns only after the killed child settles (no cleanup race)", async () => {
    // cloneShallow/introspectVersion delete the child's working directory the moment the
    // spawn call returns — so a timed-out spawn must not return while the (SIGTERMed but
    // not yet dead) child can still be writing into that tree.
    let settled = false;
    const client = new GithubClient({
      githubHost: "github.com",
      spawnImpl: (_bin, _args, opts) =>
        new Promise<SpawnResult>((resolve) => {
          opts.signal?.onAbort(() => {
            setTimeout(() => { settled = true; resolve({ exitCode: 137, stdout: "", stderr: "killed" }); }, 50);
          });
        }),
      env: { HOME: "/home/u", PATH: "/bin" },
      binPaths: BINS,
      tempRoot: TEST_TMP,
      spawnTimeoutMs: 15,
    });
    const res = await client.git(["--version"]);
    expect(res.stderr).toMatch(/timed out/);
    expect(settled).toBe(true); // the child had settled BEFORE the caller got control back
  });

  test("a spawn impl that never settles after the kill still returns once the escalation grace has passed", async () => {
    // the settle-wait must be BOUNDED: a wedged kill (or a fake that never resolves) cannot
    // convert the deadline into a hang. The fallback fires after SPAWN_KILL_GRACE_MS + margin.
    const start = Date.now();
    const client = new GithubClient({
      githubHost: "github.com",
      spawnImpl: () => new Promise<SpawnResult>(() => {}), // never settles, even when killed
      env: { HOME: "/home/u", PATH: "/bin" },
      binPaths: BINS,
      tempRoot: TEST_TMP,
      spawnTimeoutMs: 15,
    });
    const res = await client.git(["--version"]);
    expect(res.stderr).toMatch(/timed out/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(SPAWN_KILL_GRACE_MS); // waited out the escalation
    expect(elapsed).toBeLessThan(SPAWN_KILL_GRACE_MS + 4_000); // ...but stayed bounded
  }, 8_000);

  test("a REAL diagnostic rejection wins over the synthetic timeout (never masked as a retryable 124)", async () => {
    // a byte-cap/stream failure whose settlement crosses the deadline is still the true
    // diagnostic — reporting it as a synthetic 124 would classify it as a transient
    // no-response and re-drive the oversized request through every retry.
    const client = new GithubClient({
      githubHost: "github.com",
      spawnImpl: (_bin, _args, opts) =>
        new Promise<SpawnResult>((_resolve, reject) => {
          opts.signal?.onAbort(() => setTimeout(() => reject(new GithubApiError("spawn output exceeds 42 bytes", {})), 20));
        }),
      env: { HOME: "/home/u", PATH: "/bin" },
      binPaths: BINS,
      tempRoot: TEST_TMP,
      spawnTimeoutMs: 15,
    });
    await expect(client.git(["--version"])).rejects.toThrow(/spawn output exceeds 42 bytes/);
  });

  test("NaN knobs are rejected like nonpositive ones (NaN < 1 is false — the guard must be finite-aware)", () => {
    const base = { githubHost: "github.com", env: { HOME: "/tmp", PATH: "/bin" }, binPaths: BINS, tempRoot: TEST_TMP };
    expect(() => new GithubClient({ ...base, concurrency: Number.NaN })).toThrow(/concurrency must be >= 1/);
    expect(() => new GithubClient({ ...base, spawnTimeoutMs: Number.NaN })).toThrow(/spawnTimeoutMs must be >= 1/);
  });
});

describe("cloneShallow temp-dir cleanup on failure", () => {
  // the shared git-config dir (pkg-audit-gitcfg-*) is a per-client cached resource, NOT a
  // per-clone leak — the run temp dir holding the partial clone is what must be reclaimed.
  const cloneRunDirs = (root: string): string[] =>
    readdirSync(root).filter((n) => n.startsWith("pkg-audit-") && !n.startsWith("pkg-audit-gitcfg-"));

  test("a failed clone leaves no clone run dir behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "clone-fail-"));
    const { client } = makeClient([err("", "fatal: repository not found", 128)], { tempRoot: root });
    await expect(client.cloneShallow("o", "r", "main")).rejects.toThrow(/clone failed/);
    expect(cloneRunDirs(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
  test("a clone whose rev-parse fails also cleans up", async () => {
    const root = mkdtempSync(join(tmpdir(), "clone-fail-"));
    const { client } = makeClient([ok(""), err("", "fatal: bad revision", 128)], { tempRoot: root });
    await expect(client.cloneShallow("o", "r", "main")).rejects.toThrow(/rev-parse/);
    expect(cloneRunDirs(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
  test("a clone whose date-capture (show) fails also cleans up", async () => {
    const root = mkdtempSync(join(tmpdir(), "clone-fail-"));
    const { client } = makeClient([ok(""), ok("abc123def\n"), err("", "fatal: bad object", 128)], { tempRoot: root });
    await expect(client.cloneShallow("o", "r", "main")).rejects.toThrow(/committer date failed/);
    expect(cloneRunDirs(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
  test("a non-ISO committer date is rejected and cleans up (a garbled read must not poison provenance)", async () => {
    const root = mkdtempSync(join(tmpdir(), "clone-fail-"));
    const { client } = makeClient([ok(""), ok("abc123def\n"), ok("not-a-date\n")], { tempRoot: root });
    await expect(client.cloneShallow("o", "r", "main")).rejects.toThrow(/non-ISO committer date/);
    expect(cloneRunDirs(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a cleanup failure never masks the original clone error", async () => {
    // rmSync's force only suppresses ENOENT — an EACCES/EBUSY from the cleanup walk must not
    // replace the actionable git error (which carries git's stderr). The stuck tree is the
    // next run's startup sweep's problem; the ORIGINAL error is the operator's diagnostic.
    const root = mkdtempSync(join(tmpdir(), "clone-mask-"));
    let cloneDest = "";
    const spawnImpl: SpawnFn = async (_bin, args) => {
      cloneDest = args[args.length - 1]!; // clone dest is the final argv token
      mkdirSync(cloneDest, { recursive: true });
      writeFileSync(join(cloneDest, "partial"), "x");
      chmodSync(cloneDest, 0o555); // cleanup cannot unlink `partial` → rmSync throws EACCES
      return { exitCode: 128, stdout: "", stderr: "ORIGINAL_GIT_FAILURE" };
    };
    const client = new GithubClient({
      githubHost: "github.com", spawnImpl,
      env: { HOME: "/home/u", PATH: "/bin" }, binPaths: BINS, tempRoot: root,
    });
    try {
      await expect(client.cloneShallow("o", "r", "main")).rejects.toThrow(/ORIGINAL_GIT_FAILURE/);
    } finally {
      if (cloneDest !== "") chmodSync(cloneDest, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("spawn kill escalation (§4 hardening)", () => {
  test("SPAWN_KILL_GRACE_MS is 2s (independent literal pins the magnitude)", () => {
    expect(SPAWN_KILL_GRACE_MS).toBe(2000);
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return cond();
  };
  // a shell child that IGNORES SIGTERM and parks a background grandchild on the inherited
  // pipes — the exact shape that previously orphaned the read loop. The deadline must be
  // long enough that the trap is installed BEFORE the deadline's SIGTERM (otherwise the
  // signal lands during shell startup and kills it outright, defeating the point).
  const SPAWN_DEADLINE = 800;
  const makeTrappingScript = (dir: string): { script: string; pidFile: string } => {
    const pidFile = join(dir, "pid");
    const script = join(dir, "fake-git");
    writeFileSync(script, `#!/bin/sh\ntrap '' TERM\necho $$ > ${pidFile}\nsleep 300 &\nwait\n`);
    chmodSync(script, 0o755);
    return { script, pidFile };
  };

  test("a SIGTERM-trapping real child is SIGKILLed after the grace period", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kill-esc-"));
    const { script, pidFile } = makeTrappingScript(dir);
    const client = new GithubClient({
      githubHost: "github.com",
      binPaths: { gh: "/bin/echo", git: script, tar: "/bin/echo" },
      env: { HOME: "/tmp", PATH: "/bin:/usr/bin" },
      tempRoot: dir,
      spawnTimeoutMs: SPAWN_DEADLINE,
    });
    const res = await client.git(["--version"]); // real spawn, real deadline
    expect(res.exitCode).not.toBe(0);
    expect(await waitFor(() => existsSync(pidFile), 2000)).toBe(true);
    const shPid = Number(readFileSync(pidFile, "utf8").trim());
    // the child trapped the deadline's SIGTERM, so only the SIGKILL escalation can reap it —
    // and git() must NOT settle until that has happened: callers delete the child's working
    // directory the moment the call returns, which would race a still-writing child.
    expect(await waitFor(() => !alive(shPid), 500)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 12_000);

  test("a byte-cap rejection is held until the child has actually exited (no cleanup race)", async () => {
    // realSpawn must not settle — even by REJECTING — while the child is still alive:
    // callers treat settlement as "the child is gone" and immediately delete its working
    // directory. A SIGTERM-trapping child that spews past the cap forces the full
    // cap → kill → SIGKILL-escalation → exit sequence before the rejection may surface.
    const dir = mkdtempSync(join(tmpdir(), "cap-hold-"));
    const pidFile = join(dir, "pid");
    const script = join(dir, "spewer");
    writeFileSync(script, `#!/bin/sh\ntrap '' TERM\necho $$ > ${pidFile}\nhead -c 256 /dev/zero\nsleep 300 &\nwait\n`);
    chmodSync(script, 0o755);
    const spawn = makeRealSpawn(64);
    try {
      await expect(spawn(script, [], { env: { PATH: "/bin:/usr/bin" } })).rejects.toThrow(/spawn output exceeds 64 bytes/);
      const shPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(alive(shPid)).toBe(false); // the rejection arrived AFTER the child died
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 12_000);

  test("a standalone run survives the settle-wait even when nothing else holds the event loop", async () => {
    // the settle-wait window is exactly when every other handle may already be unref'd —
    // if the awaited timers were unref'd too, a standalone CLI process would drain its
    // event loop and exit MID-AWAIT (skipping cleanup and report finalization). exitCode
    // starts at 3 and only the post-await line resets it, so an early drain fails loudly.
    const dir = mkdtempSync(join(tmpdir(), "settle-ref-"));
    const runner = join(dir, "runner.ts");
    // Paths reach the child via env, not string-interpolated into the generated
    // source — building code from JSON.stringify'd values trips CodeQL's
    // js/bad-code-sanitization and is a fragile way to escape a string literal.
    writeFileSync(runner, [
      `const ghModule = process.env.GH_MODULE, runDir = process.env.RUN_DIR;`,
      `if (!ghModule || !runDir) throw new Error("runner env not set");`,
      `const { GithubClient } = await import(ghModule);`,
      `process.exitCode = 3; // stays 3 if the event loop drains mid-await`,
      `const client = new GithubClient({ githubHost: "github.com", spawnImpl: () => new Promise(() => {}), env: { HOME: "/tmp", PATH: "/bin:/usr/bin" }, binPaths: { gh: "/bin/echo", git: "/bin/echo", tar: "/bin/echo" }, tempRoot: runDir, spawnTimeoutMs: 50 });`,
      `const res = await client.git(["--version"]);`,
      `if (res.stderr.includes("timed out")) process.exitCode = 0;`,
    ].join("\n"));
    const proc = Bun.spawn({
      cmd: [process.execPath, runner],
      env: { ...process.env, GH_MODULE: join(import.meta.dir, "github.ts"), RUN_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const killer = setTimeout(() => proc.kill(9), 20_000);
    const code = await proc.exited;
    clearTimeout(killer);
    expect(code).toBe(0); // completed the post-timeout code — the loop was held through the wait
    rmSync(dir, { recursive: true, force: true });
  }, 25_000);

  test("the process can exit despite a pipe-holding grandchild (abandoned loser cannot pin the loop)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kill-exit-"));
    const { script } = makeTrappingScript(dir);
    const runner = join(dir, "runner.ts");
    // Paths reach the child via env, not string-interpolated into the generated
    // source (see the settle-wait runner above) — keeps CodeQL's
    // js/bad-code-sanitization quiet and the escaping robust.
    writeFileSync(runner, [
      `const ghModule = process.env.GH_MODULE, gitBin = process.env.GIT_BIN, runDir = process.env.RUN_DIR;`,
      `if (!ghModule || !gitBin || !runDir) throw new Error("runner env not set");`,
      `const { GithubClient } = await import(ghModule);`,
      `const client = new GithubClient({ githubHost: "github.com", binPaths: { gh: "/bin/echo", git: gitBin, tar: "/bin/echo" }, env: { HOME: "/tmp", PATH: "/bin:/usr/bin" }, tempRoot: runDir, spawnTimeoutMs: ${SPAWN_DEADLINE} });`,
      `const res = await client.git(["--version"]);`,
      `if (res.exitCode === 0) throw new Error("expected a timed-out result");`,
    ].join("\n"));
    const proc = Bun.spawn({
      cmd: [process.execPath, runner],
      env: { ...process.env, GH_MODULE: join(import.meta.dir, "github.ts"), GIT_BIN: script, RUN_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const killer = setTimeout(() => proc.kill(9), 20_000); // backstop: a pinned loop never exits
    const code = await proc.exited;
    clearTimeout(killer);
    expect(code).toBe(0); // exited on its own — readers cancelled, handle unref'd
    rmSync(dir, { recursive: true, force: true });
  }, 25_000);
});

describe("pagination", () => {
  test("MAX_PAGES is 1000 (independent literal pins the magnitude)", () => {
    expect(MAX_PAGES).toBe(1000);
  });

  test("follows Link rel=next across pages, recomposing relative endpoints", async () => {
    const { client, calls } = makeClient([
      ok(http(200, { link: `<https://api.github.com/orgs/x/repos?per_page=100&page=2&type=all>; rel="next"` }, `[{"name":"a"}]`)),
      ok(http(200, {}, `[{"name":"b"}]`)),
    ]);
    const rows = await client.restGetPagedArray("orgs/x/repos?per_page=100&page=1&type=all");
    expect(rows.length).toBe(2);
    expect(calls[0]!.args).toContain("orgs/x/repos?per_page=100&page=1&type=all");
    expect(calls[1]!.args).toContain("orgs/x/repos?per_page=100&page=2&type=all");
  });
  test("follows a canonical numeric organizations/<id>/repos Link next URL (§5.A)", async () => {
    // GitHub can emit the Link rel="next" for orgs/<login>/repos in the numeric
    // organizations/<id>/repos form — the recomposed relative endpoint must pass the guard.
    const { client, calls } = makeClient([
      ok(http(200, { link: `<https://api.github.com/organizations/143746735/repos?per_page=100&page=2&type=all>; rel="next"` }, `[{"name":"a"}]`)),
      ok(http(200, {}, `[{"name":"b"}]`)),
    ]);
    const rows = await client.restGetPagedArray("orgs/x/repos?per_page=100&page=1&type=all");
    expect(rows.length).toBe(2);
    expect(calls[0]!.args).toContain("orgs/x/repos?per_page=100&page=1&type=all");
    expect(calls[1]!.args).toContain("organizations/143746735/repos?per_page=100&page=2&type=all");
  });
  test("a poisoned Link to a non-repos organizations resource is a ReadOnlyViolation", async () => {
    // host-valid but path-poisoned Link: the recomposed follow-up endpoint must still hit
    // the guard — exactly one spawn (the first page), then fail closed.
    const { client, calls } = makeClient([
      ok(http(200, { link: `<https://api.github.com/organizations/143746735/members?page=2>; rel="next"` }, `[{"name":"a"}]`)),
    ]);
    await expect(client.restGetPagedArray("orgs/x/repos?per_page=100&page=1&type=all")).rejects.toThrow(ReadOnlyViolation);
    expect(calls.length).toBe(1);
  });
  test("a non-array page is an error", async () => {
    const { client } = makeClient([ok(http(200, {}, `{"not":"array"}`))]);
    await expect(client.restGetPagedArray("orgs/x/repos?page=1")).rejects.toThrow(/array/);
  });
  test("a 2xx-non-200 mid-chain page fails the WHOLE listing — no partial page is accumulated, no next page fetched", async () => {
    // page 2 is a valid-looking array WITH a rel="next" — the status alone must kill it: a 206
    // page silently accepted would understate the listing (repos silently out of scope).
    const { client, calls } = makeClient([
      ok(http(200, { link: `<https://api.github.com/orgs/x/repos?per_page=100&page=2&type=all>; rel="next"` }, `[{"name":"a"}]`)),
      ok(http(206, { link: `<https://api.github.com/orgs/x/repos?per_page=100&page=3&type=all>; rel="next"` }, `[{"name":"only-half-of-page-2"}]`)),
    ]);
    await expect(client.restGetPagedArray("orgs/x/repos?per_page=100&page=1&type=all")).rejects.toThrow(GithubApiError);
    expect(calls.length).toBe(2); // page 3 was never requested
  });
  test("a self-referential Link cycle throws instead of looping", async () => {
    // every page points rel="next" at the SAME URL — the second visit to an already-seen
    // endpoint must fail fast, after exactly two spawns (page 1, page 2), not spawn again.
    const cyclic = `<https://api.github.com/orgs/x/repos?per_page=100&page=2&type=all>; rel="next"`;
    const { client, calls } = makeClient([
      ok(http(200, { link: cyclic }, `[{"name":"a"}]`)),
      ok(http(200, { link: cyclic }, `[{"name":"b"}]`)),
    ]);
    await expect(client.restGetPagedArray("orgs/x/repos?per_page=100&page=1&type=all")).rejects.toThrow(GithubApiError);
    expect(calls.length).toBe(2);
  });
  test(`a non-repeating Link chain longer than MAX_PAGES throws`, async () => {
    // endless UNIQUE next URLs dodge cycle detection — the page cap must stop the chain.
    const { client, calls } = makeClient(
      Array.from({ length: MAX_PAGES + 1 }, (_, i) =>
        ok(http(200, { link: `<https://api.github.com/orgs/x/repos?page=${i + 2}>; rel="next"` }, `[]`))),
    );
    // the class matters: ThrottleExhausted would mean "re-queue", re-driving the poisoned chain.
    const rejection = client.restGetPagedArray("orgs/x/repos?page=1");
    await expect(rejection).rejects.toThrow(GithubApiError);
    await expect(rejection).rejects.toThrow(/exceeded/);
    expect(calls.length).toBe(MAX_PAGES); // cap checked BEFORE the fetch: exactly MAX_PAGES spawns
  });

  test("restGetPagedArray writes NO cache row (noStore) — no ETag row is ever created to drop a Link on a later 304", async () => {
    // Scope: this is about the restGetPagedArray (noStore) path ONLY — non-paginated restGet still
    // caches + revalidates normally (see the immutable/304 tests above). The cache stores body+ETag
    // but NOT the Link header, so a cached paginated page whose 304 omits Link would make the listing
    // stop early and silently under-report; closing that seam means paginated pages bypass the cache.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client } = makeClient([
      ok(http(200, { etag: 'W/"p1"', link: `<https://api.github.com/orgs/x/repos?per_page=100&page=2&type=all>; rel="next"` }, `[{"name":"a"}]`)),
      ok(http(200, { etag: 'W/"p2"' }, `[{"name":"b"}]`)),
    ], { db });
    const rows = await client.restGetPagedArray("orgs/x/repos?per_page=100&page=1&type=all");
    expect(rows.length).toBe(2);
    const n = db.read("SELECT COUNT(*) AS n FROM api_cache").get() as { n: number };
    expect(n.n).toBe(0); // the noStore paginated fetch wrote no row — a paginated page can never be re-served from cache
    db.close();
  });

  test("a PRE-SEEDED cache row can NEVER silently truncate a listing — pagination ignores it and sends no If-None-Match", async () => {
    // The realistic hazard is a page row left by the OLD caching code (or any future partial noStore
    // that skips writes but still READS): body+ETag with no stored Link. If pagination revalidated it
    // and got a 304 without Link, it would stop at page 1 and silently under-report. Seed exactly such
    // a current-epoch (gh3) row and prove pagination never reads it, never revalidates, and refetches.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const P1 = "orgs/x/repos?per_page=100&page=1&type=all";
    const P2 = "orgs/x/repos?per_page=100&page=2&type=all";
    const link2 = `<https://api.github.com/${P2}>; rel="next"`;
    db.putApiCache({ method: "GET", url: `gh3:github.com:${P1}`, variantHash: "", etag: 'W/"seed"', responseBody: `[{"name":"stale-seed"}]` });
    const spy = countCacheAccess(db); // prove pagination touches the DB zero times — no read-then-discard, no write
    const dispatch = (call: Call): SpawnResult => {
      const ep = call.args[2]; // ["api", "-i", <endpoint>, ...]
      // A client that read the seed would send If-None-Match; the server then 304s WITHOUT a Link —
      // the exact trap. A correct noStore client never sends the validator, so this arm is dead here.
      if (call.args.some((a) => a.startsWith("If-None-Match:"))) return err(`HTTP/2.0 304 Not Modified\r\nEtag: W/"seed"`, "gh: HTTP 304");
      if (ep === P1) return ok(http(200, { etag: 'W/"p1"', link: link2 }, `[{"name":"a"}]`));
      return ok(http(200, { etag: 'W/"p2"' }, `[{"name":"b"}]`)); // page 2, last page, no Link
    };
    const { client, calls } = makeClient(Array.from({ length: 8 }, () => dispatch), { db });
    const rows = await client.restGetPagedArray(P1);
    expect(rows).toEqual([{ name: "a" }, { name: "b" }]); // FRESH page 1 (not the stale seed), then page 2
    expect(calls.length).toBe(2); // both pages fetched fresh — page 2 was followed
    expect(calls.map((c) => c.args[2])).toEqual([P1, P2]); // exact endpoints, in order
    expect(calls.every((c) => !c.args.some((a) => a.toLowerCase().startsWith("if-none-match:")))).toBe(true); // never revalidated the seed
    expect(spy.reads).toBe(0); // getApiCache never CALLED — a read-then-discard noStore mutant fails here
    expect(spy.writes).toBe(0); // …and putApiCache never called, so no page row was created either
    const seed = db.read(`SELECT response_body AS body, etag FROM api_cache WHERE url = 'gh3:github.com:${P1}'`).get() as { body: string; etag: string };
    expect(seed.body).toBe(`[{"name":"stale-seed"}]`); // the seed row remains — bypassed, not read, revalidated, or overwritten
    expect(seed.etag).toBe('W/"seed"');
    db.close();
  });

  test("restGetPagedArray accumulates a page too large for acc.push(...page) without truncating", async () => {
    // acc.push(...page) throws once a page exceeds the engine's spread/stack argument limit — the exact
    // hard failure the iterative `for (const item of page) acc.push(item)` avoids. That limit is engine-
    // and stack-dependent (well above 65k on Bun/JSC), so DERIVE a size that genuinely overflows the
    // spread in THIS runtime, assert it does, then prove the paginator still accumulates every entry.
    const spreadOverflows = (len: number): boolean => {
      // require the SPECIFIC RangeError (arg/stack overflow) — a different error would be a bad probe
      try { const a: number[] = []; a.push(...new Array(len).fill(0)); return false; } catch (e) { return e instanceof RangeError; }
    };
    let n = 500_000;
    while (n < 8_000_000 && !spreadOverflows(n)) n *= 2;
    expect(spreadOverflows(n)).toBe(true); // guard against a false green: n is a size where acc.push(...page) RangeErrors
    const page = JSON.stringify(Array.from({ length: n }, (_, i) => i));
    const { client } = makeClient([ok(http(200, {}, page))]);
    const rows = await client.restGetPagedArray("orgs/x/repos?per_page=100&page=1&type=all");
    expect(rows.length).toBe(n); // every entry kept — a spread accumulator would have thrown at this size
    // sample start, midpoint, and end for order/identity — enough to catch length changes and any
    // corruption that shifts these positions; NOT an exhaustive per-element check (an isolated
    // equal-length swap at an unsampled index would pass, which is acceptable for this accumulator guard)
    expect(rows[0]).toBe(0);
    expect(rows[Math.floor(n / 2)]).toBe(Math.floor(n / 2));
    expect(rows[n - 1]).toBe(n - 1);
  });
});

describe("listOrgMemberships (§5.A fail-closed)", () => {
  test("maps well-formed membership entries to their logins", async () => {
    const { client } = makeClient([ok(http(200, {}, `[{"login":"acme"},{"login":"globex"}]`))]);
    await expect(client.listOrgMemberships()).resolves.toEqual(["acme", "globex"]);
  });
  test("a malformed membership entry fails LOUD with an indexed diagnostic — never silently dropped or coerced", async () => {
    // Under the old String(o.login ?? "") + .filter code, most of these silently became "" (dropped)
    // or a coerced string (a fabricated org); the null ITEM instead threw a raw TypeError. None
    // surfaced as a proper GithubApiError — so the discovered org set was silently shrunk/corrupted.
    // Each bad entry sits at index 0 here, so the diagnostic must name index 0 and the user/orgs endpoint.
    const bad = [
      `[{"login":""}]`,       // empty login → was dropped
      `[{"login":null}]`,     // null login → was coerced to "" and dropped
      `[{"login":42}]`,       // non-string login → was string-coerced to "42" (a fabricated org!)
      `[{}]`,                 // missing login → was dropped
      `[null]`,               // null item → threw a raw TypeError, not a GithubApiError
      `["not-an-object"]`,    // non-object item → login undefined → dropped
    ];
    for (const body of bad) {
      const { client } = makeClient([ok(http(200, {}, body))]);
      let caught: unknown;
      try { await client.listOrgMemberships(); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(GithubApiError);
      expect((caught as GithubApiError).message).toMatch(/malformed org membership at index 0/);
      expect((caught as GithubApiError).endpoint).toBe("user/orgs");
    }
  });
  test("a good entry BESIDE a malformed one fails the whole listing at the RIGHT index (no partial membership)", async () => {
    const { client } = makeClient([ok(http(200, {}, `[{"login":"acme"},{"login":""}]`))]);
    let caught: unknown;
    try { await client.listOrgMemberships(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect((caught as GithubApiError).message).toMatch(/index 1/); // the SECOND entry, not a partial success
  });
  test("a non-canonical login (dot segment / separator / control char) fails LOUD — a fabricated org can't steer discovery", async () => {
    // listOrgMemberships has NO cross-owner check (it PRODUCES the discovered org set), so a "." / ".."
    // / path-separator / control-char login must be rejected HERE or it becomes a fabricated owner fed
    // verbatim into every subsequent repo/branch scan.
    const bad = ["..", ".", "a/b", "a\\b", "a b", "a" + String.fromCharCode(0) + "b", "a" + String.fromCharCode(0x85) + "b"];
    for (const login of bad) {
      const { client } = makeClient([ok(http(200, {}, JSON.stringify([{ login }])))]);
      let caught: unknown;
      try { await client.listOrgMemberships(); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(GithubApiError);
      expect((caught as GithubApiError).message).toMatch(/malformed org membership at index 0/);
    }
  });
  test("a malformed entry on a LATER page is indexed GLOBALLY across the flattened pagination", async () => {
    // restGetPagedArray flattens all pages, so the index must be global (page-2 entry 0 → index 2),
    // not a per-page index — a per-page index would misreport WHICH org membership is broken.
    const link2 = `<https://api.github.com/user/orgs?per_page=100&page=2>; rel="next"`;
    const { client } = makeClient([
      ok(http(200, { link: link2 }, `[{"login":"acme"},{"login":"globex"}]`)),
      ok(http(200, {}, `[{"login":""}]`)), // the first entry of page 2 — global index 2
    ]);
    let caught: unknown;
    try { await client.listOrgMemberships(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect((caught as GithubApiError).message).toMatch(/index 2/);
  });
});

describe("listOrgRepos / listUserRepos (§5.A fail-closed)", () => {
  const good = `{"name":"r","owner":{"login":"o"},"pushed_at":"2024-06-01T00:00:00Z","archived":false,"fork":false,"private":false}`;
  test("maps a well-formed repo listing", async () => {
    const { client } = makeClient([ok(http(200, {}, `[${good}]`))]);
    const repos = await client.listOrgRepos("o");
    expect(repos).toEqual([{ name: "r", organization: "o", pushedAt: "2024-06-01T00:00:00Z", archived: false, fork: false, isPrivate: false }]);
  });
  test("a malformed identity OR scope-steering field fails LOUD — never silently coerced or mis-scoped", async () => {
    // Under the old code, a non-string/missing value became "" or a coerced string (a fabricated
    // repo/owner), a malformed pushed_at coerced to null (sinking the repo in the sort+cap), and a
    // malformed archived/fork coerced to false (scanning an excluded repo AND displacing an eligible
    // one out of the cap). Each is now an indexed GithubApiError at index 0. Endpoint carries too.
    const bad = [
      `[{"name":"","owner":{"login":"o"},"pushed_at":null,"archived":false,"fork":false,"private":false}]`,   // empty name
      `[{"name":42,"owner":{"login":"o"},"pushed_at":null,"archived":false,"fork":false,"private":false}]`,   // non-string name → "42"
      `[{"owner":{"login":"o"},"pushed_at":null,"archived":false,"fork":false,"private":false}]`,             // missing name
      `[{"name":"r","pushed_at":null,"archived":false,"fork":false,"private":false}]`,                        // missing owner
      `[{"name":"r","owner":{"login":""},"pushed_at":null,"archived":false,"fork":false,"private":false}]`,   // empty owner.login
      `[{"name":"r","owner":{"login":42},"pushed_at":null,"archived":false,"fork":false,"private":false}]`,   // non-string owner.login → "42"
      `[{"name":"r","owner":"nope","pushed_at":null,"archived":false,"fork":false,"private":false}]`,         // non-object owner
      `[{"name":"r","owner":{"login":"o"},"pushed_at":1700000000,"archived":false,"fork":false,"private":false}]`, // number pushed_at → null → cap sink
      `[{"name":"r","owner":{"login":"o"},"pushed_at":"not-a-date","archived":false,"fork":false,"private":false}]`, // garbage-string pushed_at
      `[{"name":"r","owner":{"login":"o"},"pushed_at":"2024-06-01T00:00:00-10:00","archived":false,"fork":false,"private":false}]`, // OFFSET pushed_at → lexical sort wrong vs Z
      `[{"name":"r","owner":{"login":"o"},"pushed_at":null,"archived":"true","fork":false,"private":false}]`, // string archived → false → scanned+displaces
      `[{"name":"r","owner":{"login":"o"},"pushed_at":null,"archived":false,"fork":1,"private":false}]`,      // non-bool fork
      `[null]`,                                                                                               // null item → was a raw TypeError
      `["not-an-object"]`,                                                                                    // non-object item → coerced to ""
    ];
    for (const body of bad) {
      const { client } = makeClient([ok(http(200, {}, body))]);
      let caught: unknown;
      try { await client.listOrgRepos("o"); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(GithubApiError);
      expect((caught as GithubApiError).message).toMatch(/malformed repo listing at index 0/);
      expect((caught as GithubApiError).endpoint).toBe("orgs/o/repos");
    }
  });
  test("listUserRepos runs the FULL validation chain (a malformed scope field, past the identity checks, fails loud)", async () => {
    // a fully-formed repo except a non-boolean `archived` — proves listUserRepos exercises the whole
    // validator (not just the first identity guard) and carries the user/repos endpoint.
    const { client } = makeClient([ok(http(200, {}, `[{"name":"r","owner":{"login":"u"},"pushed_at":null,"archived":"true","fork":false,"private":false}]`))]);
    let caught: unknown;
    try { await client.listUserRepos("u"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect((caught as GithubApiError).message).toMatch(/archived is not a boolean/);
    expect((caught as GithubApiError).endpoint).toBe("user/repos");
  });
  test("listUserRepos rejects a FOREIGN owner too (the authenticated login is known) and matches case-insensitively", async () => {
    const foreign = `[{"name":"r","owner":{"login":"someone-else"},"pushed_at":null,"archived":false,"fork":false,"private":false}]`;
    const { client } = makeClient([ok(http(200, {}, foreign))]);
    let caught: unknown;
    try { await client.listUserRepos("u"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect((caught as GithubApiError).message).toMatch(/not the requested owner/);
    // case-insensitive accept, canonical casing preserved
    const { client: c2 } = makeClient([ok(http(200, {}, `[{"name":"r","owner":{"login":"MyUser"},"pushed_at":null,"archived":false,"fork":false,"private":false}]`))]);
    const repos = await c2.listUserRepos("myuser");
    expect(repos[0]!.organization).toBe("MyUser");
  });
  test("a DUPLICATE (owner, name) repo fails loud — a cap slot must never silently drop a distinct repo", async () => {
    // pagination can legitimately return a repo twice when the listing shifts between pages; with a
    // maxReposPerOrg cap a duplicate would displace a distinct repo (silent under-report), so reject it.
    const { client } = makeClient([ok(http(200, {}, `[${good},${good}]`))]);
    let caught: unknown;
    try { await client.listOrgRepos("o"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect((caught as GithubApiError).message).toMatch(/duplicate repo o\/r .*index 1/);
  });
  test("a CASE-VARIED duplicate ACROSS PAGES is caught (the dedup key is case-normalized and global)", async () => {
    // page 1 has repo o/R; page 2 (global index 1) has o/r — same repo by GitHub's case-insensitive
    // identity, so it must be rejected at global index 1, not silently kept.
    const p1 = `{"name":"R","owner":{"login":"O"},"pushed_at":null,"archived":false,"fork":false,"private":false}`;
    const p2 = `{"name":"r","owner":{"login":"o"},"pushed_at":null,"archived":false,"fork":false,"private":false}`;
    const link2 = `<https://api.github.com/orgs/o/repos?per_page=100&page=2&type=all>; rel="next"`;
    const { client } = makeClient([ok(http(200, { link: link2 }, `[${p1}]`)), ok(http(200, {}, `[${p2}]`))]);
    let caught: unknown;
    try { await client.listOrgRepos("o"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect((caught as GithubApiError).message).toMatch(/duplicate repo o\/r in listing at index 1/);
  });
  test("listOrgRepos rejects a FOREIGN-owner repo — a /orgs/o/repos row owned by someone else would redirect the scan", async () => {
    const foreign = `{"name":"r","owner":{"login":"someone-else"},"pushed_at":null,"archived":false,"fork":false,"private":false}`;
    const { client } = makeClient([ok(http(200, {}, `[${foreign}]`))]);
    let caught: unknown;
    try { await client.listOrgRepos("o"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect((caught as GithubApiError).message).toMatch(/not the requested owner/);
  });
  test("listOrgRepos owner match is case-insensitive (GitHub logins are), keeping the returned casing", async () => {
    const { client } = makeClient([ok(http(200, {}, `[{"name":"r","owner":{"login":"MyOrg"},"pushed_at":null,"archived":false,"fork":false,"private":false}]`))]);
    const repos = await client.listOrgRepos("myorg");
    expect(repos[0]!.organization).toBe("MyOrg"); // canonical casing preserved
  });
  test("a good repo BESIDE a malformed one fails the whole listing at the RIGHT global index (across pages)", async () => {
    const good2 = `{"name":"r2","owner":{"login":"o"},"pushed_at":"2024-05-01T00:00:00Z","archived":false,"fork":false,"private":false}`;
    const link2 = `<https://api.github.com/orgs/o/repos?per_page=100&page=2&type=all>; rel="next"`;
    const { client } = makeClient([
      ok(http(200, { link: link2 }, `[${good},${good2}]`)), // two DISTINCT repos (not duplicates)
      ok(http(200, {}, `[{"name":"","owner":{"login":"o"},"pushed_at":null,"archived":false,"fork":false,"private":false}]`)), // page-2 entry 0 → global index 2
    ]);
    let caught: unknown;
    try { await client.listOrgRepos("o"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect((caught as GithubApiError).message).toMatch(/index 2/);
  });
});

describe("graphql", () => {
  test("RATE_LIMITED 200 body is retried; success returns data; never cached", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    // exit 1 on the throttle page: gh exits nonzero for a 200-with-errors envelope BY DESIGN
    const { client, calls } = makeClient(
      [
        err(http(200, { "x-ratelimit-remaining": "10" }, `{"errors":[{"type":"RATE_LIMITED","message":"slow down"}]}`), "gh: GraphQL error"),
        ok(http(200, {}, `{"data":{"x":1}}`)),
      ],
      { db },
    );
    const data = await client.graphql("query{x}", {});
    expect(data).toEqual({ x: 1 });
    expect(calls.length).toBe(2);
    expect(calls[0]!.args).toContain("query=query{x}");
    const cacheCount = db.read("SELECT COUNT(*) AS n FROM api_cache").get() as { n: number };
    expect(cacheCount.n).toBe(0); // GraphQL bypasses api_cache entirely (§3)
    db.close();
  });
  test("a variable named 'query' is rejected (would collide with the body field)", async () => {
    const { client, calls } = makeClient([]);
    await expect(client.graphql("query{x}", { query: "evil" })).rejects.toThrow(GithubApiError);
    expect(calls.length).toBe(0);
  });
  test("non-throttle graphql errors are fatal", async () => {
    const { client } = makeClient([err(http(200, {}, `{"errors":[{"type":"NOT_FOUND","message":"gone"}]}`), "gh: GraphQL error")]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(/NOT_FOUND/);
  });
});

// ---- graphql envelope validation (§4 spec hardening) ------------------------------------------
// The GraphQL spec pins the envelope shape: an object root; `data` and/or a NON-EMPTY `errors`
// array of maps. Anything else means the failure signal we were meant to read is unreadable —
// accepting it as success is fail-OPEN (an ok:true discovery feeds the §11 reconcile PRUNE).
// Classification still runs FIRST on whatever error evidence IS readable, so status/header
// semantics (5xx transient, SSO fatal, throttle retry) are never downgraded by a malformed body;
// malformation only preempts the SUCCESS path.
describe("graphql envelope validation (§4 spec hardening)", () => {
  test("errors:[] on 200 fails closed — the spec requires a present errors member be NON-EMPTY", async () => {
    const { client } = makeClient([ok(http(200, {}, `{"data":{"x":1},"errors":[]}`))]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(/graphql envelope/);
  });
  test("errors:[null] on 200 is a clean GithubApiError, not a raw TypeError from classifyGraphql", async () => {
    // exit 0: gh extracts no string message from a null entry, so it reports no error
    const { client } = makeClient([ok(http(200, {}, `{"errors":[null]}`))]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(GithubApiError);
  });
  test("a junk errors entry does NOT erase readable throttle evidence — RATE_LIMITED beside it still retries", async () => {
    const { client, calls } = makeClient([
      err(http(200, { "x-ratelimit-remaining": "10" }, `{"errors":[null,{"type":"RATE_LIMITED","message":"slow down"}]}`), "gh: GraphQL error"),
      ok(http(200, {}, `{"data":{"x":1}}`)),
    ]);
    const data = await client.graphql("query{x}", {});
    expect(data).toEqual({ x: 1 });
    expect(calls.length).toBe(2); // classified secondary from the readable entry, retried, succeeded
  });
  test("an envelope with NEITHER data nor errors on 200 fails closed instead of returning undefined", async () => {
    const { client } = makeClient([ok(http(200, {}, `{}`))]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(/graphql envelope/);
  });
  test("a non-object JSON root on 200 fails closed instead of returning undefined", async () => {
    // "null" is gh-realistic at exit 0; the array/string/number roots are DELIBERATELY SYNTHETIC
    // full bodies (gh's own unmarshal fails on them and would emit headers-only stdout + exit 1)
    // — they pin OUR non-object-root rejection against a hostile/changed transport.
    for (const b of ["null", "[]", `"x"`, "42"]) {
      const { client } = makeClient([ok(http(200, {}, b))]);
      await expect(client.graphql("query{x}", {})).rejects.toThrow(/graphql envelope/);
    }
  });
  test("an UNPARSEABLE 200 body fails closed instead of returning undefined", async () => {
    const { client } = makeClient([ok(http(200, {}, "<html>bad gateway</html>"))]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(/graphql envelope/);
  });
  test("data:null WITHOUT errors is malformed — the spec requires errors when data is null", async () => {
    const { client } = makeClient([ok(http(200, {}, `{"data":null}`))]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(/graphql envelope/);
  });
  test("data:null WITH valid errors is the LEGAL total-failure shape — classified fatal on the error text", async () => {
    const { client } = makeClient([err(http(200, {}, `{"data":null,"errors":[{"type":"NOT_FOUND","message":"gone"}]}`), "gh: GraphQL error")]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(/NOT_FOUND/);
  });
  test("a non-object data member (string/array) is malformed", async () => {
    for (const b of [`{"data":"nope"}`, `{"data":[1]}`]) {
      const { client } = makeClient([ok(http(200, {}, b))]);
      await expect(client.graphql("query{x}", {})).rejects.toThrow(/graphql envelope/);
    }
  });
  test("an errors entry with NOTHING readable must not sanitize into no-errors success", async () => {
    // {"errors":[{locations:[]}]} — object entry, but no type/message. Silent dropping would leave
    // errors=[] and the 200 would classify ok; the flag-and-drop rule is what fails it closed.
    // exit 0: gh extracts no string message from a message-less entry, so it reports no error
    const { client } = makeClient([ok(http(200, {}, `{"data":{"x":1},"errors":[{"locations":[]}]}`))]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(/no readable/);
  });
  test("a non-string nested error field cannot TypeError during message coercion — clean GithubApiError", async () => {
    // {"message":{"toString":null}} would throw inside classifyGraphql's template-literal join;
    // sanitized projections keep only string-valued fields, so coercion is total.
    // DELIBERATELY SYNTHETIC shape: gh's own parse fails on a non-string message and aborts
    // before copying the body, so gh never emits this full-body-plus-nonzero-exit combination.
    // The fixture pins OUR sanitizer's totality against a hostile/changed transport instead.
    const { client } = makeClient([err(http(200, {}, `{"data":{"x":1},"errors":[{"message":{"toString":null}}]}`), "gh: GraphQL error")]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(GithubApiError);
  });
  test("HTTP 2xx-but-not-200 with a pristine envelope is NOT graphql success", async () => {
    const { client } = makeClient([ok(http(206, {}, `{"data":{"x":1}}`))]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(/200/);
  });
  test("a RATE_LIMITED 200 envelope with gh EXIT 1 is a THROTTLE, never mistaken for a truncated transfer", async () => {
    // gh exits 1 BY DESIGN after printing a complete 200 envelope that carries `errors` — the
    // realistic wire shape for every GraphQL throttle. A restGet-style nonzero-exit guard here
    // would blind-retry this past its reset window and misreport it as truncation (reviewer-
    // caught regression); the exit code must never preempt classifyGraphql.
    const { client, calls, sleeps } = makeClient([
      err(http(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000000100" }, `{"errors":[{"type":"RATE_LIMITED","message":"wait"}]}`), "gh: GraphQL error"),
      ok(http(200, {}, `{"data":{"x":1}}`)),
    ]);
    const data = await client.graphql("query{x}", {});
    expect(data).toEqual({ x: 1 });
    expect(calls.length).toBe(2);
    expect(sleeps.some((ms) => ms >= 100_000)).toBe(true); // waited out the PRIMARY window (reset+skew), not blind backoff
  });
  test("a fatal-errors 200 envelope with gh EXIT 1 keeps its error text — no retries, no 'truncated' misreport", async () => {
    const { client, calls } = makeClient([
      err(http(200, {}, `{"data":null,"errors":[{"type":"NOT_FOUND","message":"gone"}]}`), "gh: GraphQL error"),
    ]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(/NOT_FOUND.*gone/);
    expect(calls.length).toBe(1);
  });
  test("a TRUNCATED graphql body (a mid-stream JSON-object prefix) is retried, then fails closed once the budget is spent", async () => {
    // DELIBERATELY SYNTHETIC stdout shape: gh buffers graphql JSON before printing, so a real read
    // failure yields headers-only stdout + exit 1; a mid-stream cut leaves an unclosed object that
    // never parses. That unparseable-body + nonzero-exit shape is transport truncation → retried
    // (transient), then fails closed after MAX_ATTEMPTS. The JSON-prefix property still holds: no
    // proper prefix of a top-level object is itself valid JSON, so it can never sanitize into success.
    const partial = err(http(200, {}, `{"data":{"x":1}`), "read: connection reset"); // brace never closes
    const { client, calls } = makeClient(Array.from({ length: 6 }, () => partial)); // MAX_ATTEMPTS = 6
    await expect(client.graphql("query{x}", {})).rejects.toThrow(/unparseable JSON/);
    expect(calls.length).toBe(6); // retried to exhaustion, then fail-closed
  });
  test("junk errors entries do NOT preempt SSO evidence: 403+x-github-sso stays fatal WITH ssoRequired", async () => {
    const { client } = makeClient([
      err(http(403, { "x-ratelimit-remaining": "5", "x-github-sso": "required" }, `{"errors":[null]}`), "gh: HTTP 403"), // gh exits 1 on any HTTP error status
    ]);
    let caught: unknown;
    try {
      await client.graphql("query{x}", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect((caught as GithubApiError).ssoRequired).toBe(true);
  });
});

describe("listBranchHeads (§5.B)", () => {
  test("paginates with endCursor (omitted on first page), sorts committedDate DESC, resolves the default", async () => {
    const page1 = {
      data: {
        repository: {
          defaultBranchRef: { name: "main" },
          refs: {
            pageInfo: { hasNextPage: true, endCursor: "CUR1" },
            nodes: [{ name: "old", target: { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "dddddddddddddddddddddddddddddddddddddddd" } } }],
          },
        },
      },
    };
    const page2 = {
      data: {
        repository: {
          defaultBranchRef: { name: "main" },
          refs: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ name: "main", target: { oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", committedDate: "2024-06-01T00:00:00Z", tree: { oid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" } } }],
          },
        },
      },
    };
    const { client, calls } = makeClient([ok(http(200, {}, JSON.stringify(page1))), ok(http(200, {}, JSON.stringify(page2)))]);
    const snapshot = await client.listBranchHeads("o", "r");
    expect(snapshot.heads.map((h) => h.name)).toEqual(["main", "old"]);
    expect(snapshot.heads[0]!.treeOid).toBe("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    expect(snapshot.defaultBranch).toBe("main"); // from the SAME snapshot as the heads, not the REST listing
    expect(calls[0]!.args.some((a) => a.startsWith("endCursor="))).toBe(false); // first page omits it
    expect(calls[1]!.args).toContain("endCursor=CUR1");
  });

  // Pins the QUERY, not just the response handling. A scripted fixture answers whatever it is asked, so
  // every assertion above would still pass if the query silently stopped requesting defaultBranchRef and
  // the field were served from a stale fixture — this is the only check that the wire request is right.
  test("the GraphQL query actually requests defaultBranchRef on the repository node", async () => {
    const { client, calls } = makeClient([
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: null, refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }))),
    ]);
    await client.listBranchHeads("o", "r");
    const queryArg = calls[0]!.args.find((a) => a.startsWith("query="))!;
    expect(queryArg).toContain("defaultBranchRef{name}");
  });

  // FAIL-CLOSED completeness (load-bearing for run_unit_head reconciliation): an understated branch set would
  // make the prune delete live branches, so a malformed node or a silently-truncated page must THROW
  // (→ discovery 'failed' → the repo is retained, never reconciled) rather than return a partial list.
  // `defaultBranchRef: null` (a repo with no commits) is the neutral default here so these fixtures
  // exercise the node/pagination guards rather than tripping the default-branch guards first.
  const refsPage = (over: Record<string, unknown>, repoOver: Record<string, unknown> = {}) =>
    ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: null, refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [], ...over }, ...repoOver } } })));
  test("a non-Commit / malformed node throws instead of being silently dropped", async () => {
    const { client } = makeClient([refsPage({ nodes: [{ name: "weird", target: {} }] })]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/malformed branch-head node/);
  });
  test("an EMPTY target string (oid/committedDate/tree.oid) is malformed — must not slip through as a valid head", async () => {
    // an empty committedDate would classify as cutoff-skipped then trip the non-empty-date write
    // invariant OUTSIDE the fail-soft path; an empty oid drives an invalid scan. Both must fail here.
    for (const target of [
      { oid: "", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "dddddddddddddddddddddddddddddddddddddddd" } },
      { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", committedDate: "", tree: { oid: "dddddddddddddddddddddddddddddddddddddddd" } },
      { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "" } },
    ]) {
      const { client } = makeClient([refsPage({ nodes: [{ name: "x", target }] })]);
      await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/malformed branch-head node/);
    }
  });
  test("a NULL node is a clean GithubApiError, not a raw TypeError", async () => {
    const { client } = makeClient([refsPage({ nodes: [null] })]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/malformed branch-head node/);
  });
  test("a non-hex oid / tree.oid is malformed — a ref-looking value would freeze MUTABLE reads into the immutable cache", async () => {
    // h.oid / h.treeOid flow into SHA-pinned fetches where isSha() earns the zero-network cache
    // path, and into skip-current persistence; "main" in an oid field must fail loud here.
    for (const target of [
      { oid: "main", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "d".repeat(40) } },
      { oid: "a".repeat(40), committedDate: "2024-01-01T00:00:00Z", tree: { oid: "refs/heads/x" } },
      { oid: "a".repeat(39), committedDate: "2024-01-01T00:00:00Z", tree: { oid: "d".repeat(40) } },
    ]) {
      const { client } = makeClient([refsPage({ nodes: [{ name: "x", target }] }, { defaultBranchRef: { name: "x" } })]);
      await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/malformed branch-head node/);
    }
  });
  test("hasNextPage=true with no follow-up cursor throws (would otherwise truncate silently)", async () => {
    const { client } = makeClient([refsPage({ pageInfo: { hasNextPage: true, endCursor: null } })]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/no follow-up endCursor/);
  });
  test("a missing/non-boolean hasNextPage throws (cannot prove the page set is complete)", async () => {
    const { client } = makeClient([refsPage({ pageInfo: { endCursor: null } })]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/hasNextPage missing\/non-boolean/);
  });
  test("a non-array nodes field throws (a page's branches cannot be treated as empty)", async () => {
    const { client } = makeClient([refsPage({ nodes: null })]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/missing a nodes array/);
  });
  test("a duplicate branch name across pages throws (unstable pagination)", async () => {
    const dup = { name: "main", target: { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "dddddddddddddddddddddddddddddddddddddddd" } } };
    const { client } = makeClient([
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, refs: { pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [dup] } } } }))),
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [dup] } } } }))),
    ]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/duplicate branch/);
  });

  // ---- default-branch resolution (§5.B): the snapshot's two halves must be coherent -------------
  // The default's ALWAYS-eligible exemption is decided by `headName === defaultBranch`, so a default
  // that is wrong, unresolved, or paired with the wrong head set would let a restrictive policy drop a
  // repo's real default SILENTLY. Every incoherence therefore fails closed (→ discovery 'failed' → an
  // errors row → the repo is retained and never reconciled) rather than degrading.
  test("a page that OMITS defaultBranchRef throws — absent is not the same as null", async () => {
    // We asked for the field; a clean 200 without it is structurally malformed (a real schema or
    // permission failure would have surfaced in GraphQL `errors` and been rejected upstream). Explicit
    // null is a legal answer ("this repo has no default"); silence is not.
    const { client } = makeClient([
      ok(http(200, {}, JSON.stringify({ data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }))),
    ]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/omits defaultBranchRef/);
  });
  test("defaultBranchRef null + ZERO heads is the legal empty repo (not an error)", async () => {
    const { client } = makeClient([refsPage({})]);
    await expect(client.listBranchHeads("o", "r")).resolves.toEqual({ heads: [], defaultBranch: null });
  });
  test("defaultBranchRef null + a live head throws (cannot plan a repo with no default)", async () => {
    // With no default, NO head can win the always-eligible exemption, so `branches: []` would exclude
    // every branch and the repo would silently yield zero units. A loud error beats that.
    const { client } = makeClient([
      refsPage({ nodes: [{ name: "dev", target: { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "dddddddddddddddddddddddddddddddddddddddd" } } }] }),
    ]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/null but 1 head\(s\) were discovered/);
  });
  test("a malformed defaultBranchRef (missing/empty name) throws", async () => {
    for (const ref of [{}, { name: "" }, { name: 42 }]) {
      const { client } = makeClient([refsPage({}, { defaultBranchRef: ref })]);
      await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/malformed defaultBranchRef/);
    }
  });
  test("a default branch ABSENT from the discovered heads throws (incoherent snapshot)", async () => {
    // e.g. the default is 'trunk' but no 'trunk' head came back — the two halves describe different
    // repo states, so no head could be classified default and policy would exclude the real one.
    const { client } = makeClient([
      refsPage({ nodes: [{ name: "dev", target: { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "dddddddddddddddddddddddddddddddddddddddd" } } }] }, { defaultBranchRef: { name: "trunk" } }),
    ]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/is absent from the discovered heads/);
  });
  test("a null→named defaultBranchRef transition mid-pagination throws (the null is not 'unset')", async () => {
    // The re-assertion compares against the FIRST page's value including an explicit null, so a repo
    // that gains a default mid-walk is caught too — null is a read answer, not "not yet known".
    const { client } = makeClient([
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: null, refs: { pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [] } } } }))),
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: "main", target: { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "dddddddddddddddddddddddddddddddddddddddd" } } }] } } } }))),
    ]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/changed mid-pagination/);
  });
  test("defaultBranchRef ABSENT on a LATER page throws (every page is validated, not just page 1)", async () => {
    const { client } = makeClient([
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, refs: { pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [{ name: "main", target: { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "dddddddddddddddddddddddddddddddddddddddd" } } }] } } } }))),
      ok(http(200, {}, JSON.stringify({ data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }))),
    ]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/omits defaultBranchRef/);
  });
  test("a non-ISO / impossible committedDate throws — it steers cutoff selection, so non-empty is not enough", async () => {
    // The date is compared LEXICALLY (`committedDate.slice(0,10) < cutoffDate`), so a malformed value
    // is never caught downstream: "2025-99-99…" simply sorts as far-future and the branch is silently
    // classified ELIGIBLE. 2025-02-30 is the case a bare Date.parse would MISS — it rolls over to
    // March 2 rather than failing, so an impossible calendar date would be recorded as real.
    // T24:00:00Z is the one a Date.parse-based check MISSES for the opposite reason: hour 24 is a legal
    // ISO end-of-day spelling that Date.parse NORMALIZES to 00:00 the next day — so the value would be
    // accepted while its slice(0,10) names a different day than the instant it denotes. Explicit
    // component bounds, not Date.parse, are what reject it. 2025-02-30 covers the rollover direction.
    for (const bad of ["2025-99-99T99:99:99Z", "2025-02-30T00:00:00Z", "2025-13-01T00:00:00Z", "2025-06-01T25:00:00Z", "2025-06-01T24:00:00Z", "2025-06-01T24:00:00+00:00", "2025-06-01T00:60:00Z", "2025-06-01T00:00:60Z", "2025-06-00T00:00:00Z", "2025-06-32T00:00:00Z", "2025-00-01T00:00:00Z", "2025-06-01T00:00:00+99:00", "2025-06-01T00:00:00+00:99", "2025-06-01", "yesterday"]) {
      const { client } = makeClient([
        refsPage({ nodes: [{ name: "dev", target: { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", committedDate: bad, tree: { oid: "dddddddddddddddddddddddddddddddddddddddd" } } }] }, { defaultBranchRef: { name: "dev" } }),
      ]);
      await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/non-ISO committedDate/);
    }
  });
  test("a legitimate OFFSET-bearing date is accepted (git emits them; the UTC day may differ)", async () => {
    // Guards against over-validating: comparing toISOString() would reject this, because 02:00+05:00
    // is the PREVIOUS day in UTC. Validity is judged on the components as written.
    const { client } = makeClient([
      refsPage({ nodes: [{ name: "dev", target: { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", committedDate: "2025-06-01T02:00:00+05:00", tree: { oid: "dddddddddddddddddddddddddddddddddddddddd" } } }] }, { defaultBranchRef: { name: "dev" } }),
    ]);
    const snap = await client.listBranchHeads("o", "r");
    expect(snap.heads[0]!.committedDate).toBe("2025-06-01T02:00:00+05:00"); // preserved verbatim, never normalized
  });

  test("a default branch that CHANGES mid-pagination throws (the classification authority moved)", async () => {
    // Membership alone cannot catch this when both names stay live: page 1 says main is default, page 2
    // says trunk, and both are in the head set. Unlike the rejected totalCount cross-check (which trips
    // on unrelated branch churn), a default disagreement means the authority itself changed mid-walk.
    const { client } = makeClient([
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, refs: { pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [{ name: "main", target: { oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "dddddddddddddddddddddddddddddddddddddddd" } } }] } } } }))),
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: { name: "trunk" }, refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: "trunk", target: { oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", committedDate: "2024-02-01T00:00:00Z", tree: { oid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" } } }] } } } }))),
    ]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/changed mid-pagination/);
  });

  // same poisoned-pagination class as restGetPagedArray: the cursor chain must be bounded.
  const cursorPage = (cursor: string) =>
    ok(http(200, {}, JSON.stringify({
      data: { repository: { defaultBranchRef: null, refs: { pageInfo: { hasNextPage: true, endCursor: cursor }, nodes: [] } } },
    })));
  test("a repeated endCursor throws instead of looping", async () => {
    const { client, calls } = makeClient([cursorPage("CUR1"), cursorPage("CUR1")]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(GithubApiError);
    expect(calls.length).toBe(2);
  });
  test("a non-repeating cursor chain longer than MAX_PAGES throws", async () => {
    const { client, calls } = makeClient(
      Array.from({ length: MAX_PAGES + 2 }, (_, i) => cursorPage(`CUR${i + 1}`)),
    );
    // the class matters: ThrottleExhausted would mean "re-queue", re-driving the poisoned chain.
    const rejection = client.listBranchHeads("o", "r");
    await expect(rejection).rejects.toThrow(GithubApiError);
    await expect(rejection).rejects.toThrow(/exceeded/);
    expect(calls.length).toBe(MAX_PAGES); // loop-top cap: exactly MAX_PAGES spawns, same as REST
  });
});

describe("hardened clone (§0/§5.C)", () => {
  test("emits exactly the hardened argv, pins git config, and records the fetched SHA + committer date", async () => {
    const { client, calls } = makeClient([
      ok(""), // clone
      ok("abc123def\n"), // rev-parse HEAD
      ok("2025-06-01T12:34:56+00:00\n"), // show --format=%cI HEAD (the scanned commit's date)
    ]);
    const { dir, headSha, headCommittedDate } = await client.cloneShallow("org-a", "repo-b", "release/1.x");
    expect(headSha).toBe("abc123def");
    expect(headCommittedDate).toBe("2025-06-01T12:34:56+00:00"); // strict-ISO, offset preserved verbatim
    expect(dir.startsWith(TEST_TMP)).toBe(true);
    // a SUCCESSFUL clone must keep its run dir (the failure-only cleanup must not be a finally):
    // downstream walkClone/cloneReader read this dir, so deleting it would silently zero findings.
    expect(existsSync(dirname(dir))).toBe(true);

    const clone = calls[0]!;
    expect(clone.bin).toBe(BINS.git);
    expect(clone.args).toEqual([
      "clone", "--depth", "1", "--single-branch", "--branch", "release/1.x",
      "--no-tags", "--no-recurse-submodules", "--template=",
      "https://github.com/org-a/repo-b.git", dir,
    ]);
    expect(clone.opts.env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(clone.opts.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(clone.opts.env["GIT_ASKPASS"]).toBeUndefined();
    const cfgPath = clone.opts.env["GIT_CONFIG_GLOBAL"]!;
    expect(cfgPath.startsWith(TEST_TMP)).toBe(true);
    const cfg = readFileSync(cfgPath, "utf8");
    expect(cfg).toContain("auth git-credential"); // pinned helper, no ambient config
    expect(cfg).toContain("allow = never");

    const rev = calls[1]!;
    expect(rev.args).toEqual(["rev-parse", "HEAD"]);
    expect(rev.opts.cwd).toBe(dir); // §0: git itself may run with cwd inside the clone

    const showDate = calls[2]!;
    // the EXACT commit-date tuple readOnlyGuard permits — cwd inside the clone, no argv -C
    expect(showDate.args).toEqual(["show", "--no-patch", "--no-notes", "--no-show-signature", "--format=%cI", "HEAD"]);
    expect(showDate.opts.cwd).toBe(dir);
  });
  test("clone failure surfaces stderr as a GithubApiError", async () => {
    const { client } = makeClient([err("", "fatal: repository not found")]);
    await expect(client.cloneShallow("o", "r", "main")).rejects.toThrow(/repository not found/);
  });
  test("the PUBLIC git() wrapper itself contains a clone destination (chokepoint, not just cloneShallow)", async () => {
    const { client, calls } = makeClient([]);
    await expect(
      client.git([
        "clone", "--depth", "1", "--single-branch", "--branch", "main",
        "--no-tags", "--no-recurse-submodules", "--template=",
        "https://github.com/o/r.git", "/tmp-outside/steal",
      ]),
    ).rejects.toThrow(ReadOnlyViolation);
    expect(calls.length).toBe(0);
  });
  test("git --version probe writes NOTHING: no temp gitconfig materialized, global config pinned to devNull", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitver-test-"));
    const { client, calls } = makeClient([ok("git version 2.45.1\n")], { tempRoot: root });
    const res = await client.git(["--version"]);
    expect(res.stdout).toContain("2.45.1");
    // --plan's only git invocation must not leak a pkg-audit-gitcfg-* dir (plan mode never sweeps)
    expect(readdirSync(root)).toEqual([]);
    expect(calls[0]!.opts.env["GIT_CONFIG_GLOBAL"]).toBe(devNull);
    expect(calls[0]!.opts.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    rmSync(root, { recursive: true, force: true });
  });
  test("a non-version git call still materializes the pinned credential-helper gitconfig", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitcfg-test-"));
    const { client, calls } = makeClient([ok("abc123\n")], { tempRoot: root });
    await client.git(["rev-parse", "HEAD"], undefined);
    const cfgPath = calls[0]!.opts.env["GIT_CONFIG_GLOBAL"]!;
    expect(cfgPath.startsWith(root)).toBe(true);
    expect(readFileSync(cfgPath, "utf8")).toContain("auth git-credential");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("tar containment (§0)", () => {
  test("extraction -C dir and -f archive must be inside the temp root", async () => {
    const inside = join(TEST_TMP, "pkg-audit-x", "out");
    const archive = join(TEST_TMP, "pkg-audit-x", "pkg.tgz");
    mkdirSync(join(TEST_TMP, "pkg-audit-x"), { recursive: true });
    writeFileSync(archive, "x");
    const { client, calls } = makeClient([ok("")]);
    await client.tar(["-xzf", archive, "-C", inside, "--no-same-owner", "--no-same-permissions"]);
    expect(calls.length).toBe(1);
    await expect(client.tar(["-xzf", archive, "-C", "/tmp-outside/esc", "--no-same-owner", "--no-same-permissions"])).rejects.toThrow(ReadOnlyViolation);
    await expect(client.tar(["-xzf", "/etc/hosts", "-C", inside, "--no-same-owner", "--no-same-permissions"])).rejects.toThrow(ReadOnlyViolation);
    expect(calls.length).toBe(1); // violations never reached the spawn
  });
  test("extraction WITHOUT -C (would land in process cwd) is refused, as is missing --no-same-*", async () => {
    const archive = join(TEST_TMP, "pkg-audit-x", "pkg.tgz");
    const inside = join(TEST_TMP, "pkg-audit-x", "out");
    const { client, calls } = makeClient([]);
    await expect(client.tar(["-xzf", archive, "--no-same-owner", "--no-same-permissions"])).rejects.toThrow(/contained -C/);
    await expect(client.tar(["-xzf", archive, "-C", inside])).rejects.toThrow(/--no-same-owner/);
    expect(calls.length).toBe(0);
  });
  test("list mode still requires the archive to be contained", async () => {
    const archive = join(TEST_TMP, "pkg-audit-x", "pkg.tgz");
    const { client, calls } = makeClient([ok("member.txt\n")]);
    const res = await client.tar(["-tzf", archive]);
    expect(res.stdout).toContain("member.txt");
    expect(calls.length).toBe(1);
  });
  test("attached short-option value (-xzfvv) is read as the archive per real getopt, not the next operand", async () => {
    // real tar: in -xzfvv the f takes 'vv' as its value → 'vv' is the archive (uncontained → reject).
    // The bug would be checking the NEXT operand (a contained path) while tar uses 'vv'.
    const inside = join(TEST_TMP, "pkg-audit-x", "out");
    const { client, calls } = makeClient([]);
    await expect(
      client.tar(["-xzfvv", inside, "--no-same-owner", "--no-same-permissions"]),
    ).rejects.toThrow(ReadOnlyViolation);
    expect(calls.length).toBe(0);
  });
  test("attached -C<path> forms are refused (the guard reads the path chars as option letters)", async () => {
    // The tool only ever uses the separate `-C <dir>` form. An attached `-C/some/path`
    // trips the guard's short-cluster letter check on '/', so it fails closed before spawn.
    const archive = join(TEST_TMP, "pkg-audit-x", "pkg.tgz");
    const { client, calls } = makeClient([]);
    await expect(
      client.tar(["-xzf", archive, `-C${join(TEST_TMP, "pkg-audit-x", "out2")}`, "--no-same-owner", "--no-same-permissions"]),
    ).rejects.toThrow(ReadOnlyViolation);
    expect(calls.length).toBe(0);
  });
  test("list/extract WITHOUT an -f archive (tape/stdin fallback) is refused; --version still passes", async () => {
    const { client, calls } = makeClient([ok("bsdtar 3.5.3\n")]);
    await expect(client.tar(["-t"])).rejects.toThrow(/exactly one contained -f archive/);
    const version = await client.tar(["--version"]);
    expect(version.stdout).toContain("bsdtar");
    expect(calls.length).toBe(1);
  });
});

describe("temp sweep (§0)", () => {
  test("removes only pkg-audit-* direct children; symlinks unlinked, never followed", () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-test-"));
    const staleDir = join(root, "pkg-audit-stale1");
    mkdirSync(join(staleDir, "nested"), { recursive: true });
    writeFileSync(join(root, "pkg-audit-file"), "x");
    const target = mkdtempSync(join(tmpdir(), "sweep-target-"));
    writeFileSync(join(target, "precious.txt"), "keep me");
    symlinkSync(target, join(root, "pkg-audit-link"));
    mkdirSync(join(root, "unrelated-dir"));

    const { client } = makeClient([], { tempRoot: root });
    const removed = client.sweepStaleTempDirs().sort();
    expect(removed).toEqual(["pkg-audit-file", "pkg-audit-link", "pkg-audit-stale1"]);
    expect(existsSync(join(root, "unrelated-dir"))).toBe(true);
    expect(existsSync(join(target, "precious.txt"))).toBe(true); // symlink target untouched
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
});

// ---- the §6 single-chokepoint guarantee (grep-enforced) --------------------------------------
describe("single chokepoint (grep-enforced)", () => {
  // A best-effort textual tripwire, NOT a semantic proof. It fails on the common direct routes
  // to a spawn surface — a dotted/optional-chained/whitespaced `Bun.spawn|spawnSync|$`; a
  // `"bun"`-module import (quote or backtick); `Bun` aliased, parenthesized, bracket-indexed,
  // or reached via `globalThis.Bun`; `child_process` in any form; and a dynamic import whose
  // specifier is a bare variable/expression or is built with `+`/`${}`. What it CANNOT catch,
  // and what the trust dossier therefore does not claim: tokens split across comments, a module
  // name assembled by other means (`.concat`, char codes), or the Bun global routed through
  // several intermediate bindings (`const g = globalThis; const b = g.Bun; b.spawn(...)`).
  // Defense against those deliberately-evasive forms is code review, not this grep. This file
  // is exempt from the scan — it must name the very tokens it asserts about.
  test("no file other than github.ts reaches a spawn surface; github.ts has exactly one spawn site", () => {
    // Walk the WHOLE repo (the locked guarantee is repo-wide), skipping only non-code dirs.
    const skip = new Set(["node_modules", ".git", "data", "output"]);
    // dotted call, tolerating whitespace and optional chaining before the member (Bun?.spawn,
    // `Bun . spawn`); the captured member is still one of the three primitives, so widening the
    // separator cannot false-positive on Bun.file/Bun.env/etc.
    const SPAWN_RE = /Bun\s*\??\s*\.\s*(spawn|spawnSync|\$)/g;
    // node:child_process is another process-launch surface — no file may import or use it.
    const CHILD_PROC_RE = /(?:node:)?child_process|\b(?:execSync|execFileSync|execFile|spawnSync)\b/g;
    // the same primitives are importable from the plain "bun" module (static, dynamic, or
    // require form; single-, double-, or backtick-quoted) — no file may import it at all
    // ("bun:sqlite"/"bun:test" do not match; the quote must hug the bare name).
    const BUN_MODULE_RE = /(?:from|import|require)\s*\(?\s*["'`]bun["'`]/g;
    // reaching the primitives without the dotted token: destructuring / `const B = Bun` /
    // `= (Bun)`, a parenthesized `(Bun)`, computed `Bun[...]` or `Bun?.[...]`, any `["Bun"]`
    // property access, and the `globalThis.Bun` global. None appear in real code (the tool
    // always writes `Bun.<member>`).
    const BUN_INDIRECT_RE = /\bBun\s*(?:\?\.)?\s*\[|=\s*\(?\s*Bun\b(?!\s*\.)|\(\s*Bun\s*\)|\[\s*["']Bun["']\s*\]|globalThis\s*\.\s*Bun\b/g;
    // a dynamic import/require whose specifier is ASSEMBLED with `+` or `${}` can smuggle the
    // module name past the literal-token regexes above; literal specifiers stay allowed.
    const DYN_ASSEMBLY_RE = /\b(?:import|require)\s*\(\s*(?:(["'])[^"'\n]*\1\s*\+|[^)"'`\n]*\+|`[^`\n]*\$\{)/g;
    // a dynamic import/require whose first specifier char is not a quote/backtick is non-literal
    // (a variable or expression) — not statically verifiable, so flag it. `\s*` before `(` keeps
    // parity with DYN_ASSEMBLY_RE (a space, `import (spec)`, must not evade); the only prose that
    // would otherwise collide (a comment reading `import (word`) was reworded out of the tree.
    const DYN_NONLITERAL_RE = /\b(?:import|require)\s*\(\s*[^)"'`.\s]/g;

    // meta-checks: the patterns match the spawn forms they must (guards the test itself)…
    expect("Bun.spawn(x); Bun.$`y`".match(SPAWN_RE)?.length).toBe(2);
    expect(`import { execSync } from "node:child_process"`.match(CHILD_PROC_RE)?.length).toBe(2);
    const trips = (re: RegExp) => (s: string) => expect({ s, hit: (s.match(re) ?? []).length > 0 }).toEqual({ s, hit: true });
    // …every direct-route evasion surfaced in dual review trips its rule…
    [`Bun.spawn(c)`, `Bun?.spawn(c)`, `Bun . spawn(c)`, "Bun\n.spawn(c)", `Bun.spawnSync(c)`].forEach(trips(SPAWN_RE));
    [`import { spawn } from "bun"`, `import { $ } from "bun"`, `await import("bun")`, `require("bun")`, "import(`bun`)"].forEach(trips(BUN_MODULE_RE));
    [`const { spawn } = Bun;`, `Bun["spawn"](c)`, `Bun?.["spawn"](c)`, `const B = Bun;`, `const B = (Bun);`, `(Bun).spawn(c)`, `(Bun)["spawn"](c)`, `globalThis.Bun.spawn(c)`, `globalThis["Bun"].x`, `const { spawn } = globalThis.Bun;`].forEach(trips(BUN_INDIRECT_RE));
    [`await import("node:child_" + "process")`, `require("child_" + "process")`, "import(`node:child_${x}`)", `import(prefix + "process")`].forEach(trips(DYN_ASSEMBLY_RE));
    [`import(spec)`, `require(spec)`, `import( spec )`, `await import (spec)`, `require (spec)`].forEach(trips(DYN_NONLITERAL_RE));
    // …and the codebase's real legitimate forms trip NOTHING (false-positive guards).
    const allRe = [SPAWN_RE, CHILD_PROC_RE, BUN_MODULE_RE, BUN_INDIRECT_RE, DYN_ASSEMBLY_RE, DYN_NONLITERAL_RE];
    for (const s of [`Bun.file(p)`, `const f = Bun.env;`, `Bun.which("gh")`, `new Bun.Glob(g)`, `Bun.gzipSync(b)`, `import { Database } from "bun:sqlite"`, `import { test } from "bun:test"`, `import("expo")`, `require("node:fs")`, `import("./local.ts")`, `a require(...)/import(...) expression`])
      expect({ s, hits: allRe.reduce((n, re) => n + (s.match(re) ?? []).length, 0) }).toEqual({ s, hits: 0 });

    const srcFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) walk(join(dir, entry.name));
        } else if (/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(entry.name)) {
          // every extension Bun executes is scanned — .mts/.cts/.jsx must not be a blind spot
          srcFiles.push(join(dir, entry.name));
        }
      }
    };
    walk(".");
    expect(srcFiles.length).toBeGreaterThanOrEqual(6);
    for (const f of srcFiles) {
      const src = readFileSync(f, "utf8");
      const counts = {
        bun: (src.match(SPAWN_RE) ?? []).length,
        cp: (src.match(CHILD_PROC_RE) ?? []).length,
        bunModule: (src.match(BUN_MODULE_RE) ?? []).length,
        bunIndirect: (src.match(BUN_INDIRECT_RE) ?? []).length,
        dynAssembly: (src.match(DYN_ASSEMBLY_RE) ?? []).length,
        dynNonliteral: (src.match(DYN_NONLITERAL_RE) ?? []).length,
      };
      const zero = { bun: 0, cp: 0, bunModule: 0, bunIndirect: 0, dynAssembly: 0, dynNonliteral: 0 };
      if (f.endsWith("scripts/github.ts")) {
        // the single realSpawn site; zero on every other surface
        expect({ file: f, ...counts }).toEqual({ file: f, ...zero, bun: 1 });
      } else if (f.endsWith("scripts/github.test.ts")) {
        // this test file names the patterns in its own assertions — exempt it from the scan
      } else {
        expect({ file: f, ...counts }).toEqual({ file: f, ...zero });
      }
    }
  });
  test("every spawn in github.ts flows through a guard-calling wrapper", () => {
    const src = readFileSync("./scripts/github.ts", "utf8");
    // each of gh()/git()/tar() must call assertSpawnAllowed + its read-only guard
    expect(src.match(/assertSpawnAllowed\(/g)?.length).toBe(3);
    for (const guard of ["assertReadOnlyGh", "assertReadOnlyGit", "assertReadOnlyTar"])
      expect(src.includes(`${guard}(args)`)).toBe(true);
  });
});

describe("sweepStaleTempDirs observability (§0)", () => {
  // Capture stdout JSONL for the duration of fn(), restoring the real writer afterward.
  const captureStdout = (fn: () => void): Record<string, unknown>[] => {
    const lines: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { lines.push(s); return true; };
    try { fn(); } finally { (process.stdout as unknown as { write: typeof real }).write = real; }
    return lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  test("a temp root that can't be listed emits a structured warning, not a silent empty sweep", () => {
    // A regular file as tempRoot makes readdirSync throw ENOTDIR — a real listing failure. Without the
    // warning, stale multi-GB clones would accumulate with zero operator signal (the caller discards
    // the return value).
    const file = join(TEST_TMP, "sweep-not-a-dir");
    writeFileSync(file, "x");
    const { client } = makeClient([], { tempRoot: file });
    let removed: string[] = ["sentinel"];
    const events = captureStdout(() => { removed = client.sweepStaleTempDirs(); });
    rmSync(file, { force: true });
    expect(removed).toEqual([]);
    const warnings = events.filter((e) => e.event === "warning" && e.reason === "temp-sweep-failed");
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.operation).toBe("readdir");
  });
});
