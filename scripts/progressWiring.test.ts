// progressWiring.test.ts — PROMPT-TUI §U8.6–§U8.9: spawnLabel tables; github.ts wiring (spawn
// spans, waiter gauge, analyze-return rate-limit channel, throttle states); apiSurface +
// preflight fetch/introspect spans; orchestrate anchors (phases, brackets, unit lifecycle).
// Scripted-fake style throughout (injected SpawnFn / fetchImpl / clocks); the progress sink is
// restored in afterEach (§U8 hygiene).
import { expect, test, describe, afterEach, afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { GithubClient, ThrottleExhausted, GithubApiError, spawnLabel, makeRealSpawn, MAX_TOTAL_PAUSE_MS, type SpawnFn, type SpawnResult, type BranchSnapshot, type RepoInfo, type TreeResponse } from "./github.ts";
import { setProgressSink, resetTuiFailure, type ProgressEvent } from "./progress.ts";
import { setLogSink, setLogTap } from "./log.ts";
import { fetchPackument, introspectVersion, type FetchFn } from "./apiSurface.ts";
import { runPreflight } from "./preflight.ts";
import { AuditDb } from "./db.ts";
import { processRepo, runScan, type AuditRuntime } from "./orchestrate.ts";
import { compileBranchPolicy, PolicyMatchError } from "./branchPolicy.ts";
import { compileRepositoryPolicy } from "./repositoryPolicy.ts";
import type { Config } from "./config.ts";
import type { OrchestrateArgs } from "./args.ts";

const TEST_TMP = mkdtempSync(join(realpathSync(tmpdir()), "progress-wiring-"));
const BINS = { gh: "/opt/bin/tool", git: "/opt/bin/tool", tar: "/opt/bin/tool" }; // IDENTICAL on purpose (§U8.7)

afterAll(() => {
  rmSync(TEST_TMP, { recursive: true, force: true });
});

afterEach(() => {
  setProgressSink(null);
  setLogSink(null);
  setLogTap(null);
  resetTuiFailure();
});

const http = (status: number, headers: Record<string, string>, body: string): string =>
  [`HTTP/2.0 ${status} X`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)].join("\r\n") + "\r\n\r\n" + body;
const ok = (stdout: string): SpawnResult => ({ exitCode: 0, stdout, stderr: "" });

function captureProgress(): ProgressEvent[] {
  const seen: ProgressEvent[] = [];
  setProgressSink((e) => seen.push(e));
  return seen;
}

function scripted(responses: Array<SpawnResult | ((args: string[]) => SpawnResult)>): { spawn: SpawnFn; count: () => number } {
  let n = 0;
  const spawn: SpawnFn = async (_bin, args) => {
    const next = responses[n++];
    if (next === undefined) throw new Error(`unexpected spawn #${n}: ${args.join(" ")}`);
    return typeof next === "function" ? next(args) : next;
  };
  return { spawn, count: () => n };
}

function makeClient(responses: Array<SpawnResult | ((args: string[]) => SpawnResult)>, extra: Partial<ConstructorParameters<typeof GithubClient>[0]> = {}): GithubClient {
  const { spawn } = scripted(responses);
  let fakeNow = 1_000_000_000_000;
  return new GithubClient({
    githubHost: "github.com",
    spawnImpl: spawn,
    sleepImpl: async (ms) => {
      fakeNow += ms;
    },
    nowImpl: () => fakeNow,
    env: { HOME: "/home/u", PATH: "/bin" },
    binPaths: BINS,
    tempRoot: TEST_TMP,
    ...extra,
  });
}

const spans = (seen: ProgressEvent[], type: "spawn-start" | "fetch-start" | "introspect-start") => seen.filter((e) => e.type === type);
const ends = (seen: ProgressEvent[], type: "spawn-end" | "fetch-end" | "introspect-end") => seen.filter((e) => e.type === type);
const balanced = (seen: ProgressEvent[], start: "spawn-start" | "fetch-start" | "introspect-start", end: "spawn-end" | "fetch-end" | "introspect-end"): boolean => {
  const s = spans(seen, start).map((e) => (e as { id: number }).id);
  const e = ends(seen, end).map((ev) => (ev as { id: number }).id);
  return s.length === e.length && s.every((id) => e.includes(id));
};

// ---- §U8.6 spawnLabel ------------------------------------------------------------------------
describe("spawnLabel (§U8.6) — pure, total, allowlist-shaped", () => {
  test("gh forms", () => {
    expect(spawnLabel("gh", ["api", "-i", "repos/acme/api/git/trees/abc?recursive=1"])).toBe("gh api repos/acme/api/git/trees/abc?recursive=1");
    expect(spawnLabel("gh", ["api", "-i", "graphql", "-f", "query=q"])).toBe("gh api graphql");
    expect(spawnLabel("gh", ["api", "-i", "-H", "Accept: raw", "user"])).toBe("gh api user"); // value flag skipped
    expect(spawnLabel("gh", ["auth", "status", "--hostname", "github.com"])).toBe("gh auth");
    expect(spawnLabel("gh", ["--version"])).toBe("gh --version");
  });
  test("git forms — clone labels the owner/repo from the URL positional, never the whole URL", () => {
    expect(
      spawnLabel("git", ["clone", "--depth", "1", "--single-branch", "--branch", "main", "--no-tags", "--no-recurse-submodules", "--template=", "https://github.com/acme/api.git", "/tmp/x/clone"]),
    ).toBe("git clone acme/api");
    expect(spawnLabel("git", ["rev-parse", "HEAD"])).toBe("git rev-parse");
    expect(spawnLabel("git", ["--version"])).toBe("git --version");
    expect(spawnLabel("git", ["clone", "not-a-url", "/tmp/x"])).toBe("git clone"); // unparseable → verb only
  });
  test("tar forms", () => {
    expect(spawnLabel("tar", ["-xzf", "/tmp/pkg.tgz", "-C", "/tmp/extract", "--no-same-owner", "--no-same-permissions"])).toBe("tar extract");
    expect(spawnLabel("tar", ["-tzf", "/tmp/pkg.tgz"])).toBe("tar list");
    expect(spawnLabel("tar", ["--version"])).toBe("tar --version");
  });
  test("length cap at 100 chars", () => {
    const long = "repos/" + "a".repeat(200);
    const label = spawnLabel("gh", ["api", "-i", long]);
    expect(label.length).toBe(100);
    expect(label.endsWith("…")).toBe(true);
  });
  test("total on hostile argv — never throws, always a string", () => {
    for (const argv of [[], [""], ["clone"], ["clone", "https://"], ["api"], ["-xzf"], ["\u0000\u001B[2J"]]) {
      expect(typeof spawnLabel("gh", argv)).toBe("string");
      expect(typeof spawnLabel("git", argv)).toBe("string");
      expect(typeof spawnLabel("tar", argv)).toBe("string");
    }
  });
});

// ---- §U8.7 github.ts wiring ------------------------------------------------------------------
describe("github.ts spawn spans (§U8.7)", () => {
  test("balanced spans with the EXPLICIT tool discriminant — identical binPaths still label correctly", async () => {
    const seen = captureProgress();
    const client = makeClient([ok("gh version 2.0"), ok("git version 2.45.1"), ok("tar (GNU tar) 1.35")]);
    await client.gh(["--version"]);
    await client.git(["--version"]);
    await client.tar(["--version"]);
    const starts = spans(seen, "spawn-start") as Array<{ id: number; tool: string; label: string }>;
    expect(starts.map((s) => s.tool)).toEqual(["gh", "git", "tar"]); // the discriminant, never the (shared) bin path
    expect(starts.map((s) => s.label)).toEqual(["gh --version", "git --version", "tar --version"]);
    expect(balanced(seen, "spawn-start", "spawn-end")).toBe(true);
  });

  test("no sink installed → zero events and zero label work; spans only exist for sink-installed runs", async () => {
    const client = makeClient([ok("x"), ok("y")]);
    await client.gh(["--version"]); // NO sink: nothing may be emitted or queued
    const seen = captureProgress();
    await client.gh(["--version"]);
    expect(spans(seen, "spawn-start").length).toBe(1); // only the sink-installed call produced a span
    expect(balanced(seen, "spawn-start", "spawn-end")).toBe(true);
  });

  test("a REJECTING spawn (byte-cap shape) and a deadline timeout both still END their span", async () => {
    const seen = captureProgress();
    // rejection: the byte-cap path rejects the spawn promise
    const rejecting = makeClient([() => {
      throw new GithubApiError("spawn output exceeds 1 bytes", {});
    }]);
    await expect(rejecting.gh(["--version"])).rejects.toThrow(/exceeds/);
    // timeout: a spawn that only settles when the deadline kill aborts it
    const hanging = new GithubClient({
      githubHost: "github.com",
      spawnImpl: (_b, _a, opts) =>
        new Promise<SpawnResult>((resolve) => {
          opts.signal?.onAbort(() => resolve({ exitCode: 124, stdout: "", stderr: "killed" }));
        }),
      spawnTimeoutMs: 20,
      env: { PATH: "/bin" },
      binPaths: BINS,
      tempRoot: TEST_TMP,
    });
    const res = await hanging.gh(["--version"]);
    expect(res.exitCode).toBe(124);
    expect(spans(seen, "spawn-start").length).toBe(2);
    expect(balanced(seen, "spawn-start", "spawn-end")).toBe(true);
  });

  test("Semaphore waiter gauge under contention: waiting grows, then drains", async () => {
    const seen = captureProgress();
    let releaseFirst: (() => void) | null = null;
    let spawnCount = 0;
    const client = new GithubClient({
      githubHost: "github.com",
      concurrency: 1,
      spawnImpl: () =>
        new Promise<SpawnResult>((resolve) => {
          if (spawnCount++ === 0) releaseFirst = () => resolve(ok("slow")); // first spawn holds the slot
          else resolve(ok("fast"));
        }),
      env: { PATH: "/bin" },
      binPaths: BINS,
      tempRoot: TEST_TMP,
    });
    const first = client.gh(["--version"]);
    await new Promise((r) => setTimeout(r, 10)); // let the slow call take the ONE slot
    const second = client.gh(["--version"]); // queues → waiting 1
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toContainEqual({ type: "spawn-queue", waiting: 1 });
    releaseFirst!();
    await Promise.all([first, second]);
    const queueEvents = seen.filter((e) => e.type === "spawn-queue") as Array<{ waiting: number }>;
    expect(queueEvents.map((q) => q.waiting)).toEqual([1, 0]); // grew, then drained as the waiter got the slot
  });
});

describe("rate-limit snapshots via the analyze-return channel (§U8.7)", () => {
  const rlHeaders = { "X-RateLimit-Remaining": "4750", "X-RateLimit-Limit": "5000", "X-RateLimit-Reset": "1700000000" };

  test("emitted on a 200 with the derived numbers", async () => {
    const seen = captureProgress();
    const client = makeClient([ok(http(200, rlHeaders, `{"a":1}`))]);
    await client.restGet("user");
    const rl = seen.filter((e) => e.type === "rate-limit");
    expect(rl).toEqual([{ type: "rate-limit", resource: "core", remaining: 4750, limit: 5000, resetEpochSec: 1700000000 }]);
  });

  test("emitted on a 304 revalidation (a live response) but NOT on the zero-network immutable-cache return", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    try {
      const sha = "a".repeat(40);
      const endpoint = `repos/o/r/git/blobs/${sha}`;
      const seen = captureProgress();
      // 1st fetch: 200 with etag — persists to the immutable cache; snapshot emitted
      const client = makeClient(
        [ok(http(200, { ...rlHeaders, ETag: 'W/"e1"' }, "body-bytes")), ok(http(304, { "X-RateLimit-Remaining": "4000" }, ""))],
        { db },
      );
      await client.restGet(endpoint, { immutable: true });
      // 2nd fetch of the SAME sha: served from the immutable cache with ZERO network → NO event
      await client.restGet(endpoint, { immutable: true });
      // a MUTABLE cached endpoint revalidates via If-None-Match → 304 → snapshot emitted
      const mutableClient = makeClient([ok(http(200, { ...rlHeaders, ETag: 'W/"e2"' }, `{"m":1}`)), ok(http(304, { "X-RateLimit-Remaining": "4000" }, ""))], { db });
      await mutableClient.restGet("user");
      await mutableClient.restGet("user");
      const rl = seen.filter((e) => e.type === "rate-limit") as Array<{ remaining: number | null }>;
      // 3 live responses total (200, 200, 304) — the immutable-cache hit emitted nothing
      expect(rl.map((r) => r.remaining)).toEqual([4750, 4750, 4000]);
    } finally {
      db.close();
    }
  });

  test("emitted on classified error/retry attempts — REST and GraphQL both, absent headers fold to null", async () => {
    const seen = captureProgress();
    // REST: one 500 (transient retry, NO rl headers) then a 200
    const rest = makeClient([ok(http(500, {}, "oops")), ok(http(200, rlHeaders, `{"a":1}`))]);
    await rest.restGet("user");
    // GraphQL: a fatal error envelope still carries its snapshot out
    const gql = makeClient([ok(http(403, { "X-RateLimit-Remaining": "9" }, JSON.stringify({ errors: [{ type: "FORBIDDEN", message: "permission denied to org" }] })))]);
    await expect(gql.graphql("query{x}", {})).rejects.toThrow(GithubApiError);
    const rl = seen.filter((e) => e.type === "rate-limit") as Array<{ resource: string; remaining: number | null }>;
    expect(rl).toEqual([
      { type: "rate-limit", resource: "core", remaining: null, limit: null, resetEpochSec: null }, // the 500 attempt: live response, headerless
      { type: "rate-limit", resource: "core", remaining: 4750, limit: 5000, resetEpochSec: 1700000000 },
      { type: "rate-limit", resource: "graphql", remaining: 9, limit: null, resetEpochSec: null },
    ] as unknown as typeof rl);
  });
});

describe("throttle states (§U8.7)", () => {
  test("armed once per arm with the POST-funding budget; waiting before sleep; budget exhaustion carries reason 'budget'", async () => {
    const seen = captureProgress();
    // every response: primary throttle (403 remaining 0, reset far ahead) — each arm funds 2h
    // (MAX_PAUSE_MS clamp) until the 8h cumulative budget overflows, then waitBucket throws.
    const primary = ok(http(403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "9999999999" }, ""));
    const client = makeClient(Array.from({ length: 8 }, () => primary));
    await expect(client.restGet("user")).rejects.toThrow(ThrottleExhausted);
    const throttles = seen.filter((e) => e.type === "throttle") as Array<{ state: string; reason?: string; budgetSpentMs: number; untilMs: number | null }>;
    const armed = throttles.filter((t) => t.state === "armed");
    expect(armed.length).toBe(5); // 4 funded arms (2h each → 8h) + the 5th unfunded overflow arm
    expect(armed.map((a) => a.budgetSpentMs)).toEqual([
      MAX_TOTAL_PAUSE_MS / 4, MAX_TOTAL_PAUSE_MS / 2, (MAX_TOTAL_PAUSE_MS / 4) * 3, MAX_TOTAL_PAUSE_MS,
      MAX_TOTAL_PAUSE_MS, // the overflow arm: published, budget UNCHANGED (post-funding value)
    ]);
    const waits = throttles.filter((t) => t.state === "waiting");
    expect(waits.length).toBe(4); // one per funded window slept
    const exhausted = throttles.filter((t) => t.state === "exhausted");
    expect(exhausted).toEqual([
      { type: "throttle", bucket: "core", state: "exhausted", reason: "budget", untilMs: exhausted[0]!.untilMs, budgetSpentMs: MAX_TOTAL_PAUSE_MS },
    ] as unknown as typeof exhausted);
    expect(exhausted[0]!.untilMs).not.toBeNull(); // the published horizon rides along
    // ordering: every waiting is preceded by an armed; the exhausted event is LAST
    expect(throttles[throttles.length - 1]!.state).toBe("exhausted");
  });

  test("MAX_ATTEMPTS retries exhaustion carries reason 'retries' — REST and GraphQL sites both", async () => {
    const seen = captureProgress();
    // REST: 6 secondary throttles (Retry-After) — the loop runs out of attempts
    const secondary = ok(http(429, { "Retry-After": "1" }, ""));
    const rest = makeClient(Array.from({ length: 6 }, () => secondary));
    await expect(rest.restGet("user")).rejects.toThrow(ThrottleExhausted);
    // GraphQL: 6 transient 500s
    const gql = makeClient(Array.from({ length: 6 }, () => ok(http(500, {}, "boom"))));
    await expect(gql.graphql("query{x}", {})).rejects.toThrow(ThrottleExhausted);
    const exhausted = seen.filter((e) => e.type === "throttle" && (e as { state: string }).state === "exhausted") as Array<{ bucket: string; reason?: string }>;
    expect(exhausted.map((e) => ({ bucket: e.bucket, reason: e.reason }))).toEqual([
      { bucket: "core", reason: "retries" },
      { bucket: "graphql", reason: "retries" },
    ]);
  });
});

// ---- §U8.8 apiSurface + preflight wiring ------------------------------------------------------
describe("apiSurface + preflight fetch/introspect spans (§U8.8)", () => {
  const packumentJson = JSON.stringify({ name: "expo", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { dist: { tarball: "https://registry.npmjs.org/expo/-/expo-1.0.0.tgz" } } } });
  const fetchOk = (body: string): FetchFn =>
    (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      text: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as FetchFn;

  test("packument span balanced on success AND on a failing fetch", async () => {
    const seen = captureProgress();
    await fetchPackument({ packageName: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null, fetchImpl: fetchOk(packumentJson) });
    await expect(
      fetchPackument({
        packageName: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null,
        fetchImpl: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as FetchFn,
      }),
    ).rejects.toThrow(/fetch failed/);
    const starts = spans(seen, "fetch-start") as Array<{ kind: string; label: string }>;
    expect(starts.map((s) => ({ kind: s.kind, label: s.label }))).toEqual([
      { kind: "packument", label: "packument expo" },
      { kind: "packument", label: "packument expo" },
    ]);
    expect(balanced(seen, "fetch-start", "fetch-end")).toBe(true);
  });

  test("introspect span brackets the WHOLE operation (fail-soft catch included); the inner tarball span nests; the dedup return opens NO span", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    try {
      const { runId } = db.startRun({ configHash: "hash", effectiveOwners: ["org-a"], ownersSource: "configured", trackedPackages: ["expo"], cutoffDate: "2024-01-01", githubHost: "github.com" });
      const seen = captureProgress();
      const client = makeClient([]);
      // tarball fetch rejects → the version-keyed fail-soft catch records the error; both spans close
      const so = spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
      try {
        await introspectVersion({
          client, db, runId, packageName: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null,
          version: "1.0.0", versionSource: "lockfile",
          packument: JSON.parse(packumentJson) as never,
          fetchImpl: (async () => {
            throw new Error("tarball down");
          }) as unknown as FetchFn,
        });
      } finally {
        so.mockRestore();
      }
      const order = seen.map((e) => e.type);
      expect(order).toEqual(["introspect-start", "fetch-start", "fetch-end", "introspect-end"]);
      const fetchStart = spans(seen, "fetch-start")[0] as { kind: string; label: string };
      expect(fetchStart.kind).toBe("tarball");
      expect(fetchStart.label).toBe("tarball expo@1.0.0");
      expect(balanced(seen, "introspect-start", "introspect-end")).toBe(true);
      // dedup: pre-marked (name, version) returns before any span opens
      db.writeApiSurface({ packageName: "expo", version: "2.0.0", versionSource: "lockfile", rows: [] });
      const seen2 = captureProgress();
      await introspectVersion({
        client, db, runId, packageName: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null,
        version: "2.0.0", versionSource: "lockfile",
      });
      expect(seen2).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("the preflight §2.5 registry probe gets a registry-probe span, balanced incl. the failure path", async () => {
    const gh200 = (body: string): SpawnResult => ok(http(200, {}, body));
    const preflightScript = (): Array<SpawnResult | ((args: string[]) => SpawnResult)> => [
      ok("gh version 2.62.0"), // gh --version
      ok(""), // gh auth status
      ok("git version 2.45.1"), // git --version
      ok("tar (GNU tar) 1.35"), // tar --version
      gh200(JSON.stringify({ login: "tester" })), // gh api user
      gh200(JSON.stringify({ resources: { core: { remaining: 100 }, graphql: { remaining: 200 } } })), // rate_limit
    ];
    const config = {
      githubHost: "github.com", organizations: ["org-a"], packages: [{ name: "expo", registryUrl: "https://registry.npmjs.org", registryAuthEnvVar: null }],
    } as unknown as Config;
    const seen = captureProgress();
    await runPreflight(makeClient(preflightScript()), config, { fetchImpl: async () => ({ ok: true, status: 200 }) });
    const probes = (spans(seen, "fetch-start") as Array<{ kind: string; label: string }>).filter((s) => s.kind === "registry-probe");
    expect(probes.length).toBe(1);
    expect(probes[0]).toMatchObject({ type: "fetch-start", kind: "registry-probe", label: "registry probe" });
    expect(balanced(seen, "fetch-start", "fetch-end")).toBe(true);
    // failure path: DNS-level rejection still closes the span
    const seen2 = captureProgress();
    await expect(
      runPreflight(makeClient(preflightScript()), config, {
        fetchImpl: async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        },
      }),
    ).rejects.toThrow(/unreachable/);
    expect(balanced(seen2, "fetch-start", "fetch-end")).toBe(true);
  });
});

// ---- §U8.9 orchestrate wiring -----------------------------------------------------------------
const hexOid = (seed: string): string => Buffer.from(seed).toString("hex").padEnd(40, "0").slice(0, 40);

const testConfig = (root: string): Config => ({
  githubHost: "github.com", organizations: ["org-a"], excludeOrganizations: [], branches: null, excludeBranches: [], excludeRepositories: [], includePersonalNamespace: false,
  includeForks: false, includeArchived: false, maxReposPerOrg: null, maxBranchesPerRepo: 25, cutoffDate: "2024-01-01",
  concurrency: { organizations: 1, repositories: 1, branches: 1 },
  packages: [],
  excludeDirGlobs: [], paths: { sqlitePath: join(root, "never.db"), outputDir: root },
} as unknown as Config);

const rt = (config: Config, configHash = "hash"): AuditRuntime => ({
  config,
  configHash,
  branchPolicy: compileBranchPolicy(config.branches, config.excludeBranches),
  repositoryPolicy: compileRepositoryPolicy(config.excludeRepositories),
});

const ARGS: OrchestrateArgs = { configPath: null, plan: false, fresh: false, purgeCache: false, ui: null, rescanBranches: [], help: false };

const snapshot = (branches: string[]): BranchSnapshot => ({
  heads: branches.map((name) => ({ name, oid: hexOid(name), committedDate: "2025-06-01T10:00:00Z", treeOid: hexOid(`t-${name}`) })),
  defaultBranch: branches[0] ?? null,
});
const REPO: RepoInfo = { name: "svc", organization: "org-a", pushedAt: "2025-01-01T00:00:00Z", archived: false, fork: false, isPrivate: false };

// silence the stdout JSONL the drivers emit
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const so = spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  try {
    return await fn();
  } finally {
    so.mockRestore();
  }
}

describe("orchestrate unit lifecycle events (§U8.9)", () => {
  const startRun = (db: AuditDb): string =>
    db.startRun({ configHash: "hash", effectiveOwners: ["org-a"], ownersSource: "configured", trackedPackages: [], cutoffDate: "2024-01-01", githubHost: "github.com" }).runId;

  function patchedClient(root: string, treeFor: (treeOid: string) => TreeResponse | Error): GithubClient {
    const client = makeClient([], { tempRoot: root });
    client.listBranchHeads = async () => snapshot(["main", "dev", "boom", "slow"]);
    client.fetchTreeRecursive = async (_o, _r, treeOid) => {
      const t = treeFor(treeOid);
      if (t instanceof Error) throw t;
      return t;
    };
    return client;
  }

  test("dispatch/settle balanced for scanned, skip-current, error, requeue; unit-start absent for skip-current", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiring-units-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    try {
      const runId = startRun(db);
      // pre-seed dev as done at the LIVE head → skip-current
      const devKey = { configHash: "hash", scope: "branch" as const, organization: "org-a", repository: "svc", branch: "dev" };
      db.enqueueUnit(devKey, runId);
      db.setUnitStatus(devKey, { status: "done", runId, lastCommitSha: hexOid("dev"), lastCommitDate: "2025-06-01T10:00:00Z" });
      const client = patchedClient(root, (treeOid) => {
        if (treeOid === hexOid("t-main")) return { truncated: false, paths: [] };
        if (treeOid === hexOid("t-boom")) return new GithubApiError("tree fetch failed", { status: 500 });
        if (treeOid === hexOid("t-slow")) return new ThrottleExhausted("repos/org-a/svc/git/trees");
        return { truncated: false, paths: [] };
      });
      const seen = captureProgress();
      await quietly(() => processRepo(db, client, rt(testConfig(root)), runId, "org-a", REPO, [], new Set()));
      const by = (t: ProgressEvent["type"]) => seen.filter((e) => e.type === t) as Array<{ branch: string }>;
      expect(by("unit-dispatch").map((e) => e.branch).sort()).toEqual(["boom", "dev", "main", "slow"]);
      expect(by("unit-settle").map((e) => e.branch).sort()).toEqual(["boom", "dev", "main", "slow"]); // EVERY worker settles
      // unit-start fires only when a REAL scan begins: main (scanned), boom (errored mid-scan),
      // slow (requeued mid-scan) — and NOT for dev (skip-current)
      expect(by("unit-start").map((e) => e.branch).sort()).toEqual(["boom", "main", "slow"]);
      // per-branch pairing: each dispatched branch settled exactly once
      for (const b of ["main", "dev", "boom", "slow"]) {
        expect(by("unit-dispatch").filter((e) => e.branch === b).length).toBe(1);
        expect(by("unit-settle").filter((e) => e.branch === b).length).toBe(1);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a FATAL-escape unit (PolicyMatchError) still settles — dispatch/settle balanced under the rethrow", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiring-fatal-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    try {
      const runId = startRun(db);
      const client = makeClient([], { tempRoot: root });
      client.listBranchHeads = async () => snapshot(["main"]);
      // the write chokepoint throws a policy fatal the worker's inner catch RETHROWS
      db.enqueueUnit = () => {
        throw new PolicyMatchError("excludeBranches", "dep*", "main", new Error("boom"));
      };
      const seen = captureProgress();
      await expect(quietly(() => processRepo(db, client, rt(testConfig(root)), runId, "org-a", REPO, [], new Set()))).rejects.toThrow(PolicyMatchError);
      expect(seen.filter((e) => e.type === "unit-dispatch").length).toBe(1);
      expect(seen.filter((e) => e.type === "unit-settle").length).toBe(1); // the fatal path still settled
      expect(seen.filter((e) => e.type === "unit-start").length).toBe(0); // it never reached a real scan
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("owner/repo brackets balanced under throws; runScan phase order incl. resolve-owners", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiring-phases-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    try {
      // one owner, one repo listing (empty page) → discovery succeeds with zero repos
      const emptyRepos = ok(http(200, {}, "[]"));
      const client = makeClient([emptyRepos], { tempRoot: root, db });
      const seen = captureProgress();
      const outcome = await quietly(() => runScan(db, client, rt(testConfig(root)), ARGS, null));
      expect(outcome).not.toBeNull(); // completed with a report
      const phases = seen.filter((e) => e.type === "phase") as Array<{ phase: string }>;
      expect(phases.map((p) => p.phase)).toEqual(["resolve-owners", "cli-terms", "scan", "reconcile", "report"]);
      const ownerStarts = seen.filter((e) => e.type === "owner-start") as Array<{ owner: string }>;
      expect(ownerStarts.map((o) => o.owner)).toEqual(["org-a"]);
      expect(seen.filter((e) => e.type === "owner-end").length).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repo bracket closes even when processRepo throws (fatal path)", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiring-repo-throw-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    try {
      const runId = startRun(db);
      const client = makeClient([], { tempRoot: root });
      client.listOrgRepos = async () => [REPO];
      client.listBranchHeads = async () => snapshot(["main"]);
      db.enqueueUnit = () => {
        throw new PolicyMatchError("excludeBranches", "dep*", "main", new Error("boom"));
      };
      const { processOwner } = await import("./orchestrate.ts");
      const seen = captureProgress();
      await expect(quietly(() => processOwner(db, client, rt(testConfig(root)), runId, "org-a", null, [], new Set()))).rejects.toThrow(PolicyMatchError);
      expect(seen.filter((e) => e.type === "repo-start").length).toBe(1);
      expect(seen.filter((e) => e.type === "repo-end").length).toBe(1); // finally-closed under the throw
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preflight client options carry the CONFIGURED subprocess width (gauge truthfulness)", async () => {
    // main() constructs the preflight GithubClient from exactly this exported seam, so pinning
    // its output pins the constructed width (the behavioral half — waiters aggregating through
    // one hub — is the semaphore-gauge test above).
    const { preflightClientOptions } = await import("./orchestrate.ts");
    const cfg = { ...testConfig("/tmp/x"), githubHost: "ghe.example.com" };
    (cfg.concurrency as { repositories: number }).repositories = 11;
    expect(preflightClientOptions(cfg)).toEqual({ githubHost: "ghe.example.com", concurrency: 11 });
  });
});

// ---- escalation-remediation coverage (reviewer-named gaps) ------------------------------------
const untilTrue = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("reviewer-named coverage gaps (escalation remediation)", () => {
  test("the REAL byte-cap kill path still balances its spawn span (readCapped-driven, end to end)", async () => {
    // The synthetic-rejection test above proves span balance for a rejected spawn promise; this
    // drives the REAL pipeline — readCapped crossing → kill → SIGKILL escalation → exit — via
    // makeRealSpawn and a TERM-trapping spewer child (github.test.ts's real-child pattern).
    const dir = mkdtempSync(join(tmpdir(), "wiring-cap-"));
    const pidFile = join(dir, "pid");
    const script = join(dir, "spewer");
    writeFileSync(script, `#!/bin/sh\ntrap '' TERM\necho $$ > ${pidFile}\nhead -c 256 /dev/zero\nsleep 300 &\nwait\n`);
    chmodSync(script, 0o755);
    const seen = captureProgress();
    const client = new GithubClient({
      githubHost: "github.com",
      spawnImpl: makeRealSpawn(64),
      env: { PATH: "/bin:/usr/bin" },
      binPaths: { gh: script, git: script, tar: script },
      tempRoot: TEST_TMP,
    });
    try {
      await expect(client.gh(["--version"])).rejects.toThrow(/spawn output exceeds 64 bytes/);
      expect(spans(seen, "spawn-start").length).toBe(1);
      expect(balanced(seen, "spawn-start", "spawn-end")).toBe(true); // the byte-cap kill still ended its span
      const shPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(alive(shPid)).toBe(false); // the rejection arrived AFTER the child died (composes 1908's hold guarantee)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 12_000);

  test("GraphQL retry→success emits ONE snapshot per parsed attempt (the fatal-only coverage gap)", async () => {
    const seen = captureProgress();
    const gql = makeClient([
      ok(http(500, { "X-RateLimit-Remaining": "11" }, "boom")), // transient retry attempt — live parsed response
      ok(http(200, { "X-RateLimit-Remaining": "9", "X-RateLimit-Limit": "2000", "X-RateLimit-Reset": "1700000000" }, JSON.stringify({ data: { x: 1 } }))),
    ]);
    await gql.graphql("query{x}", {});
    const rl = seen.filter((e) => e.type === "rate-limit") as Array<{ resource: string; remaining: number | null }>;
    expect(rl).toEqual([
      { type: "rate-limit", resource: "graphql", remaining: 11, limit: null, resetEpochSec: null },
      { type: "rate-limit", resource: "graphql", remaining: 9, limit: 2000, resetEpochSec: 1700000000 },
    ] as unknown as typeof rl);
  });

  test("no-sink zero-DERIVATION on the analyze-return path: zero header reads without a sink, exactly three with one (§U8.7)", async () => {
    // Zero-delivery alone cannot catch a gating regression (emitProgress discards sinklessly
    // either way) — so the derivation itself is observed through proxy-backed headers driven
    // through the REAL private seam.
    const reads: string[] = [];
    const headers = new Proxy({} as Record<string, string>, {
      get(_t, prop) {
        reads.push(String(prop));
        return undefined;
      },
    });
    const direct = makeClient([ok("ignored"), ok("ignored")]);
    type Analyze = (res: SpawnResult, now: number) => { outcome: string; pauseUntilMs: number | null; rateLimitHeaders?: Record<string, string> };
    const seam = direct as unknown as { core: unknown; ghBucketedAttempt: (args: string[], bucket: unknown, analyze: Analyze) => Promise<string> };
    const call = (): Promise<string> => seam.ghBucketedAttempt(["--version"], seam.core, () => ({ outcome: "ok", pauseUntilMs: null, rateLimitHeaders: headers }));
    await call(); // NO sink installed
    expect(reads).toEqual([]); // zero derivation — not a single header read
    const seen = captureProgress();
    await call(); // WITH a sink
    expect([...reads].sort()).toEqual(["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]);
    expect(seen.filter((e) => e.type === "rate-limit").length).toBe(1);
    // and the behavioral integration half: a full restGet with rate-limit headers, sinkless,
    // leaves nothing queued for a later sink
    setProgressSink(null);
    const integration = makeClient([ok(http(200, { "X-RateLimit-Remaining": "4750" }, `{"a":1}`))]);
    await integration.restGet("user");
    const late = captureProgress();
    expect(late.length).toBe(0); // nothing was emitted or deferred while no sink existed
  });

  test("an owner-bracket throw at the runScan level: the pool rethrows, runScan rejects, brackets stay balanced", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiring-owner-throw-"));
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    try {
      const client = makeClient([], { tempRoot: root });
      client.listOrgRepos = async () => [REPO];
      client.listBranchHeads = async () => snapshot(["main"]);
      db.enqueueUnit = () => {
        throw new PolicyMatchError("excludeBranches", "dep*", "main", new Error("boom"));
      };
      const seen = captureProgress();
      await expect(quietly(() => runScan(db, client, rt(testConfig(root)), ARGS, null))).rejects.toThrow(PolicyMatchError);
      expect(seen.filter((e) => e.type === "owner-start").length).toBe(1);
      expect(seen.filter((e) => e.type === "owner-end").length).toBe(1); // finally-closed through the pool rethrow
      expect(seen.filter((e) => e.type === "repo-start").length).toBe(1);
      expect(seen.filter((e) => e.type === "repo-end").length).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("REAL concurrent arm→wait→re-arm against ONE bucket: two armed horizons, every waiting matches the latest armed at its emission", async () => {
    const seen = captureProgress();
    // Manual-resolution sleep gate: each sleep parks with its ABSOLUTE target; releasing
    // advances the clock to max(now, target) — never a relative add, so overlapping waits on
    // one horizon cannot double-count time.
    let fakeNow = 1_000_000_000_000;
    const parked: Array<{ targetMs: number; release: () => void }> = [];
    const sleepImpl = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        parked.push({ targetMs: fakeNow + ms, release: resolve });
      });
    const releasePark = (i: number): void => {
      const p = parked[i]!;
      fakeNow = Math.max(fakeNow, p.targetMs);
      p.release();
    };
    const nowSec = Math.floor(fakeNow / 1000);
    const primary = (resetSec: number): SpawnResult => ok(http(403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(resetSec) }, ""));
    // spawn order is fully gated by the sleep releases below, so the response QUEUE is the
    // caller key: A's first attempt, A's retry, then the two successes
    const client = new GithubClient({
      githubHost: "github.com",
      spawnImpl: scripted([primary(nowSec + 600), primary(nowSec + 1200), ok(http(200, {}, `{"a":1}`)), ok(http(200, {}, `{"b":2}`))]).spawn,
      sleepImpl,
      nowImpl: () => fakeNow,
      env: { HOME: "/home/u", PATH: "/bin" },
      binPaths: BINS,
      tempRoot: TEST_TMP,
    });
    const throttles = (): Array<{ state: string; untilMs: number | null }> => seen.filter((e) => e.type === "throttle") as never;
    const armedH = (): number[] => throttles().filter((t) => t.state === "armed").map((t) => t.untilMs ?? -1);
    const a = client.restGet("user"); // attempt 1 arms H1, then A parks on waitBucket(H1)
    expect(await untilTrue(() => armedH().length === 1 && parked.length === 1)).toBe(true);
    const b = client.restGet("user"); // B observes the LIVE pause: waits without spawning
    expect(await untilTrue(() => parked.length === 2)).toBe(true);
    releasePark(0); // A wakes past H1 → retry spawns → re-arm extends to H2 → A re-parks
    expect(await untilTrue(() => armedH().length === 2 && parked.length === 3)).toBe(true);
    const [h1, h2] = armedH();
    expect(h2!).toBeGreaterThan(h1!); // the horizon EXTENDED
    releasePark(1); // B's H1 sleep releases — the pause is now H2, so B must RE-PARK at H2
    expect(await untilTrue(() => parked.length === 4)).toBe(true); // B re-parked while A's H2 sleep (index 2) is STILL parked — B's identity is structural
    try {
      // the emission-order record IS the assertion: each waiting carries the horizon of the
      // latest armed AT ITS EMISSION (H1, H1, then H2 after the re-arm — never retroactive)
      expect(throttles().map((t) => ({ state: t.state, untilMs: t.untilMs }))).toEqual([
        { state: "armed", untilMs: h1! },
        { state: "waiting", untilMs: h1! }, // A
        { state: "waiting", untilMs: h1! }, // B
        { state: "armed", untilMs: h2! },
        { state: "waiting", untilMs: h2! }, // A re-parks
        { state: "waiting", untilMs: h2! }, // B re-parks
      ]);
    } finally {
      // drain every sleeper (re-releasing an already-resolved park is a no-op) so a failing
      // assertion cannot leak pending promises
      for (const p of parked.splice(0)) {
        fakeNow = Math.max(fakeNow, p.targetMs);
        p.release();
      }
    }
    await a; // both calls complete once the horizons pass — a rejection would fail the test
    await b;
    expect(armedH().length).toBe(2); // exactly two arms — single-exit per arm, no phantom re-emits
  });
});
