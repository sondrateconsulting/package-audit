import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir, devNull } from "node:os";
import { join, dirname } from "node:path";
import {
  GithubClient, GithubApiError, ThrottleExhausted, MAX_PAGES, MAX_PAUSE_MS, SPAWN_TIMEOUT_MS, MAX_TOTAL_PAUSE_MS, SPAWN_KILL_GRACE_MS,
  parseGhApiOutput, parseLinkNext, nextEndpointFromLink, parseRetryAfterMs,
  classifyRest, classifyGraphql, encodeContentsPath, mapRestRepo, filterSortCapRepos,
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
  test("mapRestRepo maps the snake_case REST shape and IGNORES default_branch (a stale epoch)", () => {
    const repo = mapRestRepo({
      name: "r", owner: { login: "o" }, default_branch: "main",
      pushed_at: "2024-06-01T00:00:00Z", archived: false, fork: true, private: true,
    });
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
    const { client, sleeps } = makeClient([
      ok(http(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": FAR_FUTURE_SEC }, `{"errors":[{"type":"RATE_LIMITED","message":"slow down"}]}`)),
      ok(http(200, {}, `{"data":{"x":1}}`)),
    ]);
    const data = await client.graphql("query{x}", {});
    expect(data).toEqual({ x: 1 });
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sleeps)).toBe(MAX_PAUSE_MS);
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
    const poisoned = ok(http(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": FAR_FUTURE_SEC }, `{"errors":[{"type":"RATE_LIMITED","message":"slow down"}]}`));
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
    const throttle = ok(http(200, { "x-ratelimit-remaining": "50", "retry-after": "7" }, `{"errors":[{"type":"RATE_LIMITED","message":"slow down"}]}`));
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
      ok(http(200, { "x-ratelimit-remaining": "50", "retry-after": "315360000" }, `{"errors":[{"type":"RATE_LIMITED","message":"slow down"}]}`)),
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
});

describe("graphql", () => {
  test("RATE_LIMITED 200 body is retried; success returns data; never cached", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { client, calls } = makeClient(
      [
        ok(http(200, { "x-ratelimit-remaining": "10" }, `{"errors":[{"type":"RATE_LIMITED","message":"slow down"}]}`)),
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
    const { client } = makeClient([ok(http(200, {}, `{"errors":[{"type":"NOT_FOUND","message":"gone"}]}`))]);
    await expect(client.graphql("query{x}", {})).rejects.toThrow(/NOT_FOUND/);
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
            nodes: [{ name: "old", target: { oid: "o1", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "t1" } } }],
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
            nodes: [{ name: "main", target: { oid: "o2", committedDate: "2024-06-01T00:00:00Z", tree: { oid: "t2" } } }],
          },
        },
      },
    };
    const { client, calls } = makeClient([ok(http(200, {}, JSON.stringify(page1))), ok(http(200, {}, JSON.stringify(page2)))]);
    const snapshot = await client.listBranchHeads("o", "r");
    expect(snapshot.heads.map((h) => h.name)).toEqual(["main", "old"]);
    expect(snapshot.heads[0]!.treeOid).toBe("t2");
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

  // FAIL-CLOSED completeness (load-bearing for T11 reconciliation): an understated branch set would
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
      { oid: "", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "t" } },
      { oid: "o", committedDate: "", tree: { oid: "t" } },
      { oid: "o", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "" } },
    ]) {
      const { client } = makeClient([refsPage({ nodes: [{ name: "x", target }] })]);
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
    const dup = { name: "main", target: { oid: "o", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "t" } } };
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
      refsPage({ nodes: [{ name: "dev", target: { oid: "o", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "t" } } }] }),
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
      refsPage({ nodes: [{ name: "dev", target: { oid: "o", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "t" } } }] }, { defaultBranchRef: { name: "trunk" } }),
    ]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/is absent from the discovered heads/);
  });
  test("a null→named defaultBranchRef transition mid-pagination throws (the null is not 'unset')", async () => {
    // The re-assertion compares against the FIRST page's value including an explicit null, so a repo
    // that gains a default mid-walk is caught too — null is a read answer, not "not yet known".
    const { client } = makeClient([
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: null, refs: { pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [] } } } }))),
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: "main", target: { oid: "o", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "t" } } }] } } } }))),
    ]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/changed mid-pagination/);
  });
  test("defaultBranchRef ABSENT on a LATER page throws (every page is validated, not just page 1)", async () => {
    const { client } = makeClient([
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, refs: { pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [{ name: "main", target: { oid: "o", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "t" } } }] } } } }))),
      ok(http(200, {}, JSON.stringify({ data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }))),
    ]);
    await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/omits defaultBranchRef/);
  });
  test("a non-ISO / impossible committedDate throws — it steers cutoff selection, so non-empty is not enough", async () => {
    // The date is compared LEXICALLY (`committedDate.slice(0,10) < cutoffDate`), so a malformed value
    // is never caught downstream: "2025-99-99…" simply sorts as far-future and the branch is silently
    // classified ELIGIBLE. 2025-02-30 is the case a bare Date.parse would MISS — it rolls over to
    // March 2 rather than failing, so an impossible calendar date would be recorded as real.
    for (const bad of ["2025-99-99T99:99:99Z", "2025-02-30T00:00:00Z", "2025-13-01T00:00:00Z", "2025-06-01T25:00:00Z", "2025-06-01T00:00:00+99:00", "2025-06-01", "yesterday"]) {
      const { client } = makeClient([
        refsPage({ nodes: [{ name: "dev", target: { oid: "o", committedDate: bad, tree: { oid: "t" } } }] }, { defaultBranchRef: { name: "dev" } }),
      ]);
      await expect(client.listBranchHeads("o", "r")).rejects.toThrow(/non-ISO committedDate/);
    }
  });
  test("a legitimate OFFSET-bearing date is accepted (git emits them; the UTC day may differ)", async () => {
    // Guards against over-validating: comparing toISOString() would reject this, because 02:00+05:00
    // is the PREVIOUS day in UTC. Validity is judged on the components as written.
    const { client } = makeClient([
      refsPage({ nodes: [{ name: "dev", target: { oid: "o", committedDate: "2025-06-01T02:00:00+05:00", tree: { oid: "t" } } }] }, { defaultBranchRef: { name: "dev" } }),
    ]);
    const snap = await client.listBranchHeads("o", "r");
    expect(snap.heads[0]!.committedDate).toBe("2025-06-01T02:00:00+05:00"); // preserved verbatim, never normalized
  });

  test("a default branch that CHANGES mid-pagination throws (the classification authority moved)", async () => {
    // Membership alone cannot catch this when both names stay live: page 1 says main is default, page 2
    // says trunk, and both are in the head set. Unlike the rejected totalCount cross-check (which trips
    // on unrelated branch churn), a default disagreement means the authority itself changed mid-walk.
    const { client } = makeClient([
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, refs: { pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [{ name: "main", target: { oid: "o1", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "t1" } } }] } } } }))),
      ok(http(200, {}, JSON.stringify({ data: { repository: { defaultBranchRef: { name: "trunk" }, refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: "trunk", target: { oid: "o2", committedDate: "2024-02-01T00:00:00Z", tree: { oid: "t2" } } }] } } } }))),
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
