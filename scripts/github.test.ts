import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir, devNull } from "node:os";
import { join } from "node:path";
import {
  GithubClient, GithubApiError, ThrottleExhausted,
  parseGhApiOutput, parseLinkNext, nextEndpointFromLink, parseRetryAfterMs,
  classifyRest, classifyGraphql, encodeContentsPath, mapRestRepo, filterSortCapRepos,
  buildGhEnv, buildGitEnv, buildTarEnv,
  type SpawnFn, type SpawnResult, type RepoInfo,
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
  test("a plain permission 403 (nonzero remaining, no throttle evidence) is FATAL, never requeued", () => {
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
    expect(cls.kind).toBe("fatal"); // never requeued as a rate-limit wait
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
});

describe("path encoding + repo shaping", () => {
  test("encodeContentsPath encodes per segment, preserving '/'", () => {
    expect(encodeContentsPath("src dir/ü#?.ts")).toBe("src%20dir/%C3%BC%23%3F.ts");
  });
  test("mapRestRepo maps the snake_case REST shape", () => {
    const repo = mapRestRepo({
      name: "r", owner: { login: "o" }, default_branch: "main",
      pushed_at: "2024-06-01T00:00:00Z", archived: false, fork: true, private: true,
    });
    expect(repo).toEqual({
      name: "r", organization: "o", defaultBranch: "main",
      pushedAt: "2024-06-01T00:00:00Z", archived: false, fork: true, isPrivate: true,
    });
  });
  test("filterSortCapRepos: client-side fork/archived policy, pushed_at DESC nulls last, cap", () => {
    const mk = (name: string, pushedAt: string | null, extra: Partial<RepoInfo> = {}): RepoInfo => ({
      name, organization: "o", defaultBranch: "main", pushedAt, archived: false, fork: false, isPrivate: false, ...extra,
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

describe("pagination", () => {
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
  test("a non-array page is an error", async () => {
    const { client } = makeClient([ok(http(200, {}, `{"not":"array"}`))]);
    await expect(client.restGetPagedArray("orgs/x/repos?page=1")).rejects.toThrow(/array/);
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
  test("paginates with endCursor (omitted on first page), sorts committedDate DESC, skips non-commits", async () => {
    const page1 = {
      data: {
        repository: {
          refs: {
            pageInfo: { hasNextPage: true, endCursor: "CUR1" },
            nodes: [
              { name: "old", target: { oid: "o1", committedDate: "2024-01-01T00:00:00Z", tree: { oid: "t1" } } },
              { name: "weird", target: {} }, // non-commit target — skipped
            ],
          },
        },
      },
    };
    const page2 = {
      data: {
        repository: {
          refs: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ name: "main", target: { oid: "o2", committedDate: "2024-06-01T00:00:00Z", tree: { oid: "t2" } } }],
          },
        },
      },
    };
    const { client, calls } = makeClient([ok(http(200, {}, JSON.stringify(page1))), ok(http(200, {}, JSON.stringify(page2)))]);
    const heads = await client.listBranchHeads("o", "r");
    expect(heads.map((h) => h.name)).toEqual(["main", "old"]);
    expect(heads[0]!.treeOid).toBe("t2");
    expect(calls[0]!.args.some((a) => a.startsWith("endCursor="))).toBe(false); // first page omits it
    expect(calls[1]!.args).toContain("endCursor=CUR1");
  });
});

describe("hardened clone (§0/§5.C)", () => {
  test("emits exactly the hardened argv, pins git config, and records the fetched SHA", async () => {
    const { client, calls } = makeClient([
      ok(""), // clone
      ok("abc123def\n"), // rev-parse HEAD
    ]);
    const { dir, headSha } = await client.cloneShallow("org-a", "repo-b", "release/1.x");
    expect(headSha).toBe("abc123def");
    expect(dir.startsWith(TEST_TMP)).toBe(true);

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
  // NOTE: this test's own titles/strings must not contain the spawn tokens it greps for.
  test("no file other than github.ts calls the spawn primitives; github.ts has exactly one spawn site", () => {
    // Walk the WHOLE repo (the locked guarantee is repo-wide), skipping only non-code dirs.
    const skip = new Set(["node_modules", ".git", "data", "output"]);
    const SPAWN_RE = /Bun\.(spawn|spawnSync|\$)/g;
    // node:child_process is another process-launch surface — no file may import or use it.
    const CHILD_PROC_RE = /(?:node:)?child_process|\b(?:execSync|execFileSync|execFile|spawnSync)\b/g;
    // meta-check: the patterns actually match known spawn forms (guards the test itself)
    expect("Bun.spawn(x); Bun.$`y`".match(SPAWN_RE)?.length).toBe(2);
    expect(`import { execSync } from "node:child_process"`.match(CHILD_PROC_RE)?.length).toBe(2);

    const srcFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) walk(join(dir, entry.name));
        } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
          srcFiles.push(join(dir, entry.name));
        }
      }
    };
    walk(".");
    expect(srcFiles.length).toBeGreaterThanOrEqual(6);
    for (const f of srcFiles) {
      const src = readFileSync(f, "utf8");
      const bunSpawn = src.match(SPAWN_RE) ?? [];
      const childProcess = src.match(CHILD_PROC_RE) ?? [];
      if (f.endsWith("scripts/github.ts")) {
        expect(bunSpawn.length).toBe(1); // the single realSpawn site
        expect({ file: f, childProcess: childProcess.length }).toEqual({ file: f, childProcess: 0 });
      } else if (f.endsWith("scripts/github.test.ts")) {
        // this test file names the patterns in its own assertions — exempt it from the scan
      } else {
        expect({ file: f, bun: bunSpawn.length, cp: childProcess.length }).toEqual({ file: f, bun: 0, cp: 0 });
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
