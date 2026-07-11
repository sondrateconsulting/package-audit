import { expect, test, describe, afterAll, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { GithubClient } from "./github.ts";
import { AuditDb } from "./db.ts";
import {
  parseSRI, verifyIntegrity, selectVersionDist, resolveRangeToVersion, encodePackageNameForUrl,
  introspectVersion, fetchPackument, inflateBounded, assertExtractedTreeSafe,
  readBodyCapped, FETCH_TIMEOUT_MS, MAX_PACKUMENT_BYTES,
  IntrospectionError, type FetchFn, type Packument,
} from "./apiSurface.ts";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, linkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- pure helpers ---------------------------------------------------------------------------
describe("assertExtractedTreeSafe — post-extraction ground-truth sweep", () => {
  test("passes a tree of regular files + dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "safe-"));
    try {
      mkdirSync(join(root, "package/sub"), { recursive: true });
      writeFileSync(join(root, "package/index.d.ts"), "export const a = 1;");
      writeFileSync(join(root, "package/sub/b.d.ts"), "export const b = 2;");
      expect(() => assertExtractedTreeSafe(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("throws on ANY symlink in the tree (independent of the pre-scan)", () => {
    const root = mkdtempSync(join(tmpdir(), "sym-"));
    try {
      mkdirSync(join(root, "package"), { recursive: true });
      writeFileSync(join(root, "package/index.d.ts"), "export const a = 1;");
      symlinkSync("/etc/passwd", join(root, "package/evil"));
      expect(() => assertExtractedTreeSafe(root)).toThrow(IntrospectionError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("throws on a symlinked DIRECTORY before descending it", () => {
    const root = mkdtempSync(join(tmpdir(), "symdir-"));
    try {
      mkdirSync(join(root, "package"), { recursive: true });
      symlinkSync("/tmp", join(root, "package/linkdir"));
      expect(() => assertExtractedTreeSafe(root)).toThrow(IntrospectionError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("throws on a HARDLINKED regular file (surfaces to lstat as a plain file)", () => {
    const root = mkdtempSync(join(tmpdir(), "hard-"));
    try {
      mkdirSync(join(root, "package"), { recursive: true });
      writeFileSync(join(root, "package/a"), "x");
      linkSync(join(root, "package/a"), join(root, "package/b")); // hardlink → both have nlink=2
      expect(() => assertExtractedTreeSafe(root)).toThrow(IntrospectionError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("FAILS CLOSED on an unreadable directory (never silently skips a hidden member)", () => {
    const root = mkdtempSync(join(tmpdir(), "noread-"));
    const hidden = join(root, "package/hidden");
    try {
      mkdirSync(hidden, { recursive: true });
      writeFileSync(join(root, "package/index.d.ts"), "export const a = 1;");
      chmodSync(hidden, 0o111); // execute-only: readdir throws EACCES
      expect(() => assertExtractedTreeSafe(root)).toThrow(IntrospectionError);
    } finally {
      chmodSync(hidden, 0o755); // restore so rmSync can recurse
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("inflateBounded — decompression-bomb cap", () => {
  test("throws when the inflated output would exceed the cap (allocation bounded)", () => {
    const bomb = Bun.gzipSync(new Uint8Array(4 * 1024 * 1024)); // 4MB of zeros, tiny compressed
    expect(() => inflateBounded(bomb, 1024 * 1024)).toThrow(); // 1MB cap → rejected
  });
  test("inflates normally under the cap", () => {
    const gz = Bun.gzipSync(new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode(inflateBounded(gz, 1024))).toBe("hello");
  });
});

describe("parseSRI", () => {
  test("picks the strongest supported algorithm", () => {
    expect(parseSRI("sha256-AAA= sha512-BBBB= sha384-CCC=")).toEqual({ algorithm: "sha512", digestB64: "BBBB=" });
  });
  test("rejects unsupported/garbage tokens", () => {
    expect(parseSRI("md5-xxx")).toBeNull();
    expect(parseSRI("sha512-")).toBeNull();
    expect(parseSRI("")).toBeNull();
    expect(parseSRI("sha512-not*base64")).toBeNull();
  });
  test("a malformed SUPPORTED-algo token fails closed (never verifies a weaker sibling)", () => {
    expect(parseSRI("sha512-not*base64 sha256-QUJD")).toBeNull();
  });
  test("an UNsupported algo alongside a valid supported one is ignored", () => {
    expect(parseSRI("md5-xxx sha256-QUJD")).toEqual({ algorithm: "sha256", digestB64: "QUJD" });
  });
});

describe("verifyIntegrity", () => {
  const bytes = new TextEncoder().encode("hello world");
  const sri512 = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const shasum = createHash("sha1").update(bytes).digest("hex");
  test("passes a matching SRI", () => {
    expect(() => verifyIntegrity(bytes, sri512, undefined)).not.toThrow();
  });
  test("a present-but-mismatched SRI FAILS (never falls back to shasum)", () => {
    expect(() => verifyIntegrity(bytes, "sha512-AAAA=", shasum)).toThrow(IntrospectionError);
  });
  test("falls back to shasum only when integrity is absent", () => {
    expect(() => verifyIntegrity(bytes, undefined, shasum)).not.toThrow();
    expect(() => verifyIntegrity(bytes, undefined, "deadbeef")).toThrow(IntrospectionError);
  });
  test("throws when neither is present", () => {
    expect(() => verifyIntegrity(bytes, undefined, undefined)).toThrow(IntrospectionError);
  });
});

describe("selectVersionDist + resolveRangeToVersion + encodePackageNameForUrl", () => {
  const packument: Packument = {
    versions: {
      "1.0.0": { dist: { tarball: "https://r/x/-/x-1.0.0.tgz", integrity: "sha512-A=" } },
      "1.2.0": { dist: { tarball: "https://r/x/-/x-1.2.0.tgz" } },
      "2.0.0-rc.1": { dist: { tarball: "https://r/x/-/x-2.0.0-rc.1.tgz" } },
    },
  };
  test("selectVersionDist returns the dist or null", () => {
    expect(selectVersionDist(packument, "1.0.0")?.tarball).toContain("1.0.0");
    expect(selectVersionDist(packument, "9.9.9")).toBeNull();
  });
  test("resolveRangeToVersion excludes prereleases unless named", () => {
    expect(resolveRangeToVersion(packument, "^1.0.0")).toBe("1.2.0");
    expect(resolveRangeToVersion(packument, ">=2.0.0-rc.0 <3.0.0")).toBe("2.0.0-rc.1");
    expect(resolveRangeToVersion(packument, "^3.0.0")).toBeNull();
  });
  test("encodePackageNameForUrl slash-encodes scoped names only", () => {
    expect(encodePackageNameForUrl("@scope/pkg")).toBe("@scope%2Fpkg");
    expect(encodePackageNameForUrl("expo")).toBe("expo");
  });
});

// ---- checksummed tar builder (so REAL system tar extracts it) --------------------------------
const BLOCK = 512;
function tarHeader(name: string, size: number, type: string): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const enc = new TextEncoder();
  const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(name, 0, 100);
  put(octal(type === "5" ? 0o755 : 0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  h[156] = type.charCodeAt(0);
  for (let i = 148; i < 156; i++) h[i] = 0x20; // checksum field = spaces before summing
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}
function buildTgz(files: Array<{ name: string; content: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  blocks.push(tarHeader("package/", 0, "5"));
  for (const f of files) {
    const data = new TextEncoder().encode(f.content);
    blocks.push(tarHeader(`package/${f.name}`, data.length, "0"));
    const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
    padded.set(data);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(BLOCK), new Uint8Array(BLOCK));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    tar.set(b, off);
    off += b.length;
  }
  return Bun.gzipSync(tar);
}

// A mock fetch serving a packument at the name URL and a tarball at the dist URL, recording
// the Authorization header seen per host.
function mockRegistry(packumentJson: string, tgz: Uint8Array): { fetchImpl: FetchFn; authHosts: string[] } {
  const authHosts: string[] = [];
  const fetchImpl: FetchFn = async (url, init) => {
    if (init.headers["Authorization"] !== undefined) authHosts.push(new URL(url).host);
    const isTarball = url.endsWith(".tgz");
    return {
      status: 200,
      ok: true,
      headers: { get: (_n: string) => null },
      arrayBuffer: async () => tgz.buffer.slice(tgz.byteOffset, tgz.byteOffset + tgz.byteLength) as ArrayBuffer,
      text: async () => (isTarball ? "" : packumentJson),
    };
  };
  return { fetchImpl, authHosts };
}

describe("fetch timeouts + streamed byte caps (§5.E hardening)", () => {
  test("FETCH_TIMEOUT_MS is 60s and MAX_PACKUMENT_BYTES is 50MB (independent literals)", () => {
    expect(FETCH_TIMEOUT_MS).toBe(60_000);
    expect(MAX_PACKUMENT_BYTES).toBe(52_428_800);
  });

  // a test-side deadline so a regression that REMOVES the implementation's deadline fails
  // red in seconds instead of wedging the suite on an un-interruptible pending read.
  const withTestDeadline = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("test-deadline exceeded")), ms))]);

  const neverEndingBody = (onCancel?: () => void): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel() { onCancel?.(); },
    });

  test("readBodyCapped aborts a never-ending body at the deadline and cancels the stream", async () => {
    let cancelled = false;
    await expect(withTestDeadline(readBodyCapped(neverEndingBody(() => { cancelled = true; }), 1024, 20, "test"), 5000))
      .rejects.toThrow(/timed out/);
    expect(cancelled).toBe(true); // the source was released, not just abandoned
  });

  test("readBodyCapped fails a chunked over-cap body INCREMENTALLY, not after buffering", async () => {
    // no Content-Length anywhere in sight: the cap must trip per chunk as bytes arrive.
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulls++; c.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    await expect(readBodyCapped(stream, 2500, 1000, "test")).rejects.toThrow(/exceeds/);
    expect(pulls).toBeLessThanOrEqual(4); // stopped at the cap crossing — never drained the stream
    expect(cancelled).toBe(true);
  });

  test("readBodyCapped returns concatenated bytes for a normal body", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); },
    });
    expect(Array.from(await readBodyCapped(stream, 10, 1000, "test"))).toEqual([1, 2, 3]);
  });

  test("fetchPackument aborts a never-ending packument body at the deadline (injected fetch)", async () => {
    const signals: unknown[] = [];
    const fetchImpl: FetchFn = async (_url, init) => {
      signals.push(init.signal);
      return {
        status: 200, ok: true, headers: { get: () => null },
        body: neverEndingBody(),
        arrayBuffer: async () => new ArrayBuffer(0), text: async () => "",
      };
    };
    await expect(withTestDeadline(fetchPackument({
      packageName: "expo", registryUrl: "https://registry.example.com",
      registryAuthEnvVar: null, fetchImpl, fetchTimeoutMs: 20,
    }), 5000)).rejects.toThrow(/timed out/);
    // the header-phase deadline: every hop must carry a live AbortSignal (the body-read
    // deadline above cannot protect the connect/headers phase on the real fetch).
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });
});

const TMP = mkdtempSync(join(tmpdir(), "apisurf-"));
afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    // best-effort cleanup of extracted trees
  }
});

// Seed a runs row so errors.run_id (FK → runs) is satisfiable, returning the run id.
function seedRun(db: AuditDb): string {
  return db.startRun({
    configHash: "h",
    effectiveOwners: ["o"],
    ownersSource: "discovered",
    trackedPackages: ["expo"],
    cutoffDate: "2024-01-01",
    githubHost: "github.com",
  }).runId;
}

describe("introspectVersion — integration (real system tar)", () => {
  const makePackument = (tgz: Uint8Array): string =>
    JSON.stringify({
      versions: {
        "1.0.0": {
          dist: {
            tarball: "https://registry.example.com/expo/-/expo-1.0.0.tgz",
            integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}`,
          },
        },
      },
    });

  const run = async (files: Array<{ name: string; content: string }>, db: AuditDb, extra: Record<string, unknown> = {}) => {
    const runId = seedRun(db);
    const tgz = buildTgz(files);
    const { fetchImpl, authHosts } = mockRegistry(makePackument(tgz), tgz);
    const client = new GithubClient({ githubHost: "github.com", tempRoot: TMP });
    await introspectVersion({
      client, db, runId, packageName: "expo",
      registryUrl: "https://registry.example.com", registryAuthEnvVar: null,
      version: "1.0.0", versionSource: "lockfile", fetchImpl,
      ...extra,
    });
    return { authHosts };
  };

  test("extracts, enumerates the .d.ts surface + bins, writes the completion marker", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", types: "./index.d.ts", bin: { expo: "./cli.js" } }) },
        { name: "index.d.ts", content: `export declare function registerRootComponent(): void;\nexport interface AppConfig { name: string }` },
        { name: "cli.js", content: `#!/usr/bin/env node` },
      ],
      db,
    );
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(true);
    const rows = db
      .read("SELECT export_name, export_kind FROM package_api_surface WHERE package_name='expo' AND export_kind NOT IN ('__complete__') ORDER BY export_kind, export_name")
      .all() as Array<{ export_name: string; export_kind: string }>;
    expect(rows).toEqual([
      { export_name: "expo", export_kind: "cli-bin" },
      { export_name: "registerRootComponent", export_kind: "named" },
      { export_name: "AppConfig", export_kind: "type" },
    ]);
    db.close();
  });

  test("consumes STREAMED bodies via the capped reader (never the buffer fallback), signal on every hop", async () => {
    // the real fetch always has res.body: this pins that introspection actually takes the
    // streamed/capped path — the buffer methods THROW, so any silent fallback fails loudly.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = seedRun(db);
    const tgz = buildTgz([{ name: "package.json", content: JSON.stringify({ name: "expo" }) }]);
    const packumentJson = makePackument(tgz);
    const signals: unknown[] = [];
    const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
    const fetchImpl: FetchFn = async (url, init) => {
      signals.push(init.signal);
      const isTarball = url.endsWith(".tgz");
      return {
        status: 200, ok: true, headers: { get: () => null },
        body: streamOf(isTarball ? tgz : new TextEncoder().encode(packumentJson)),
        arrayBuffer: async (): Promise<ArrayBuffer> => { throw new Error("buffer fallback must not be used"); },
        text: async (): Promise<string> => { throw new Error("buffer fallback must not be used"); },
      };
    };
    const client = new GithubClient({ githubHost: "github.com", tempRoot: TMP });
    await introspectVersion({
      client, db, runId, packageName: "expo",
      registryUrl: "https://registry.example.com", registryAuthEnvVar: null,
      version: "1.0.0", versionSource: "lockfile", fetchImpl,
    });
    const errs = db.read("SELECT message FROM errors").all() as Array<{ message: string }>;
    expect(errs).toEqual([]); // a buffer-fallback throw or stream failure would land here
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(true);
    expect(signals.length).toBeGreaterThanOrEqual(2); // packument + tarball hops
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    db.close();
  });

  test("enumerates EXACT exports subpaths ('./config') beyond the root (§5.E full surface)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        {
          name: "package.json",
          content: JSON.stringify({
            name: "expo",
            exports: {
              ".": { types: "./index.d.ts" },
              "./config": { types: "./config.d.ts" },
              "./features/*": { types: "./features/*.d.ts" }, // pattern key — skipped (not enumerable)
            },
          }),
        },
        { name: "index.d.ts", content: `export declare const root: number;` },
        { name: "config.d.ts", content: `export declare function getConfig(): void;` },
        { name: "features/a.d.ts", content: `export declare const hidden: number;` },
      ],
      db,
    );
    const names = (db.read("SELECT export_name FROM package_api_surface WHERE export_kind IN ('named','type') ORDER BY export_name").all() as Array<{ export_name: string }>).map((r) => r.export_name);
    expect(names).toEqual(["getConfig", "root"]); // subpath surface included; pattern key skipped
    db.close();
  });

  test("unions the import+require type surfaces via exports", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        {
          name: "package.json",
          content: JSON.stringify({
            name: "expo",
            exports: { ".": { import: { types: "./index.d.mts" }, require: { types: "./index.d.cts" } } },
          }),
        },
        { name: "index.d.mts", content: `export declare const fromEsm: number;` },
        { name: "index.d.cts", content: `export declare const fromCjs: number;` },
      ],
      db,
    );
    const names = (db.read("SELECT export_name FROM package_api_surface WHERE export_kind='named' ORDER BY export_name").all() as Array<{ export_name: string }>).map((r) => r.export_name);
    expect(names).toEqual(["fromCjs", "fromEsm"]);
    db.close();
  });

  test("verifies via dist.shasum when dist.integrity is absent", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = seedRun(db);
    const tgz = buildTgz([{ name: "package.json", content: JSON.stringify({ name: "expo", types: "./index.d.ts" }) }, { name: "index.d.ts", content: "export declare const s: 1;" }]);
    const packument = JSON.stringify({
      versions: { "1.0.0": { dist: { tarball: "https://registry.example.com/expo/-/expo-1.0.0.tgz", shasum: createHash("sha1").update(tgz).digest("hex") } } },
    });
    const { fetchImpl } = mockRegistry(packument, tgz);
    const client = new GithubClient({ githubHost: "github.com", tempRoot: TMP });
    await introspectVersion({ client, db, runId, packageName: "expo", registryUrl: "https://registry.example.com", registryAuthEnvVar: null, version: "1.0.0", versionSource: "lockfile", fetchImpl });
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(true);
    db.close();
  });
  test("a zero-surface package still earns a completion marker", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run([{ name: "package.json", content: JSON.stringify({ name: "expo" }) }], db); // no types, no bin, no index.d.ts
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(true);
    const n = (db.read("SELECT COUNT(*) AS n FROM package_api_surface WHERE export_kind NOT IN ('__complete__')").get() as { n: number }).n;
    expect(n).toBe(0);
    db.close();
  });

  test("an integrity mismatch writes a version-keyed error, NO marker", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const tgz = buildTgz([{ name: "package.json", content: `{"name":"expo"}` }]);
    const badPackument = JSON.stringify({
      versions: { "1.0.0": { dist: { tarball: "https://registry.example.com/expo/-/expo-1.0.0.tgz", integrity: "sha512-WRONGWRONG=" } } },
    });
    const runId = seedRun(db);
    const { fetchImpl } = mockRegistry(badPackument, tgz);
    const client = new GithubClient({ githubHost: "github.com", tempRoot: TMP });
    await introspectVersion({
      client, db, runId, packageName: "expo", registryUrl: "https://registry.example.com",
      registryAuthEnvVar: null, version: "1.0.0", versionSource: "lockfile", fetchImpl,
    });
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(false);
    const err = db.read(`SELECT package_name, version, message FROM errors WHERE run_id='${runId}'`).get() as { package_name: string; version: string; message: string };
    expect(err.package_name).toBe("expo");
    expect(err.version).toBe("1.0.0");
    expect(err.message).toContain("integrity");
    db.close();
  });

  test("a per-version failure emits a JSONL introspection event beside the error row", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const tgz = buildTgz([{ name: "package.json", content: `{"name":"expo"}` }]);
    const badPackument = JSON.stringify({
      versions: { "1.0.0": { dist: { tarball: "https://registry.example.com/expo/-/expo-1.0.0.tgz", integrity: "sha512-WRONGWRONG=" } } },
    });
    const runId = seedRun(db);
    const { fetchImpl } = mockRegistry(badPackument, tgz);
    const client = new GithubClient({ githubHost: "github.com", tempRoot: TMP });
    const chunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    try {
      await introspectVersion({
        client, db, runId, packageName: "expo", registryUrl: "https://registry.example.com",
        registryAuthEnvVar: null, version: "1.0.0", versionSource: "lockfile", fetchImpl,
      });
    } finally {
      spy.mockRestore();
    }
    const events = chunks.join("").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
    const ev = events.find((e) => e["event"] === "introspection");
    expect(ev).toBeDefined();
    expect(ev?.["packageName"]).toBe("expo");
    expect(ev?.["version"]).toBe("1.0.0");
    expect(String(ev?.["error"])).toContain("integrity");
    db.close();
  });

  test("an off-origin tarball URL is rejected as an error", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const tgz = buildTgz([{ name: "package.json", content: `{"name":"expo"}` }]);
    const packument = JSON.stringify({
      versions: { "1.0.0": { dist: { tarball: "https://evil.example.com/expo-1.0.0.tgz", integrity: "sha512-A=" } } },
    });
    const runId = seedRun(db);
    const { fetchImpl } = mockRegistry(packument, tgz);
    const client = new GithubClient({ githubHost: "github.com", tempRoot: TMP });
    await introspectVersion({
      client, db, runId, packageName: "expo", registryUrl: "https://registry.example.com",
      registryAuthEnvVar: null, version: "1.0.0", versionSource: "lockfile", fetchImpl,
    });
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(false);
    expect((db.read("SELECT message FROM errors").get() as { message: string }).message).toContain("origin");
    db.close();
  });

  test("an off-origin redirect on the tarball fetch is rejected as an error", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const runId = seedRun(db);
    const tgz = buildTgz([{ name: "package.json", content: `{"name":"expo"}` }]);
    const packument = JSON.stringify({
      versions: { "1.0.0": { dist: { tarball: "https://registry.example.com/expo/-/expo-1.0.0.tgz", integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}` } } },
    });
    const fetchImpl: FetchFn = async (url) => {
      if (url.endsWith(".tgz")) {
        return { status: 302, ok: false, headers: { get: (n: string) => (n.toLowerCase() === "location" ? "https://cdn.evil.com/x.tgz" : null) }, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" };
      }
      return { status: 200, ok: true, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), text: async () => packument };
    };
    const client = new GithubClient({ githubHost: "github.com", tempRoot: TMP });
    await introspectVersion({ client, db, runId, packageName: "expo", registryUrl: "https://registry.example.com", registryAuthEnvVar: null, version: "1.0.0", versionSource: "lockfile", fetchImpl });
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(false);
    expect((db.read("SELECT message FROM errors").get() as { message: string }).message).toContain("off-origin redirect");
    db.close();
  });
  test("dedup: a version with an existing marker does no network work", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    db.writeApiSurface({ packageName: "expo", version: "1.0.0", versionSource: "lockfile", rows: [] });
    let called = false;
    const fetchImpl: FetchFn = async () => {
      called = true;
      throw new Error("should not fetch");
    };
    const runId = seedRun(db);
    const client = new GithubClient({ githubHost: "github.com", tempRoot: TMP });
    await introspectVersion({
      client, db, runId, packageName: "expo", registryUrl: "https://registry.example.com",
      registryAuthEnvVar: null, version: "1.0.0", versionSource: "lockfile", fetchImpl,
    });
    expect(called).toBe(false);
    db.close();
  });

  test("fetchPackument (exported for the orchestrator) parses, and fails closed on non-JSON / non-object", async () => {
    const mk = (body: string): FetchFn => async () => ({
      status: 200, ok: true, headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0), text: async () => body,
    });
    const req = { packageName: "expo", registryUrl: "https://registry.example.com", registryAuthEnvVar: null };
    expect((await fetchPackument({ ...req, fetchImpl: mk(`{"versions":{}}`) })).versions).toEqual({});
    expect(fetchPackument({ ...req, fetchImpl: mk("not json") })).rejects.toThrow(IntrospectionError);
    expect(fetchPackument({ ...req, fetchImpl: mk("null") })).rejects.toThrow(IntrospectionError);
    expect(fetchPackument({ ...req, fetchImpl: mk("[1]") })).rejects.toThrow(IntrospectionError);
  });

  test("a private-registry bearer token is sent ONLY to the registry origin", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { authHosts } = await run(
      [{ name: "package.json", content: `{"name":"expo"}` }],
      db,
      { registryAuthEnvVar: "MY_TOKEN", env: { MY_TOKEN: "secret" } },
    );
    // both packument and tarball are on registry.example.com → auth sent to that host only
    expect(new Set(authHosts)).toEqual(new Set(["registry.example.com"]));
    db.close();
  });
});
