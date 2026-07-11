import { expect, test, describe, afterAll, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { GithubClient } from "./github.ts";
import { AuditDb } from "./db.ts";
import {
  parseSRI, verifyIntegrity, selectVersionDist, resolveRangeToVersion, encodePackageNameForUrl,
  introspectVersion, fetchPackument, inflateBounded, assertExtractedTreeSafe,
  readBodyCapped, FETCH_TIMEOUT_MS, MAX_PACKUMENT_BYTES, isValidPackageName,
  IntrospectionError, matchPatternTemplates, MAX_PATTERN_MATCHES, inspectExtracted,
  MAX_PKG_JSON_BYTES, MAX_EXACT_EXPORTS, MAX_BIN_NAMES, MAX_SURFACE_ROWS, MAX_NAME_BYTES,
  type FetchFn, type Packument,
} from "./apiSurface.ts";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, linkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

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
  test("encodePackageNameForUrl encodes EVERY slash (defense-in-depth for malformed names)", () => {
    // A valid scoped name has exactly one slash → unchanged; a malformed multi-slash name
    // gets all slashes encoded so none leak as literal registry-URL path separators.
    expect(encodePackageNameForUrl("@a/b/c")).toBe("@a%2Fb%2Fc");
    expect(encodePackageNameForUrl("@scope/pkg")).toBe("@scope%2Fpkg");
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

  test("a mid-stream read failure is labeled with what + bytes-so-far (not a raw stream error)", async () => {
    // connection reset / TLS failure mid-body: the operator-facing errors row must say WHAT
    // was being read and HOW FAR it got, like the sibling timeout/cap diagnostics do.
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        if (pulls === 1) c.enqueue(new Uint8Array(7));
        else c.error(new Error("conn reset"));
      },
    });
    await expect(readBodyCapped(stream, 10_000, 1_000, "tarball"))
      .rejects.toThrow(/tarball body read failed after 7 bytes: conn reset/);
  });

  test("a hop-level fetch failure carries the redacted hop URL", async () => {
    // the platform fetch rejects with a bare TimeoutError/network error carrying no URL —
    // the wrap must name the hop (redacted: origin+path only, never query/token).
    const fetchImpl: FetchFn = async () => { throw new Error("The operation timed out"); };
    await expect(fetchPackument({
      packageName: "expo", registryUrl: "https://registry.example.com", registryAuthEnvVar: null, fetchImpl,
    })).rejects.toThrow(/fetch failed at hop 0 \(https:\/\/registry\.example\.com\/expo\): The operation timed out/);
  });

  test("nonpositive deadlines/caps are rejected at the boundary (0 is not 'no limit')", async () => {
    await expect(readBodyCapped(neverEndingBody(), 0, 1_000, "x")).rejects.toThrow(/cap must be >= 1/);
    await expect(readBodyCapped(neverEndingBody(), 10, 0, "x")).rejects.toThrow(/timeoutMs must be >= 1/);
    const fetchImpl: FetchFn = async () => { throw new Error("unreachable"); };
    await expect(fetchPackument({
      packageName: "expo", registryUrl: "https://registry.example.com", registryAuthEnvVar: null, fetchImpl, fetchTimeoutMs: 0,
    })).rejects.toThrow(/fetchTimeoutMs must be >= 1/);
  });

  test("NaN deadlines/caps are rejected too (NaN slips a bare < 1 comparison)", async () => {
    await expect(readBodyCapped(neverEndingBody(), Number.NaN, 1_000, "x")).rejects.toThrow(/cap must be >= 1/);
    await expect(readBodyCapped(neverEndingBody(), 10, Number.NaN, "x")).rejects.toThrow(/timeoutMs must be >= 1/);
    const fetchImpl: FetchFn = async () => { throw new Error("unreachable"); };
    await expect(fetchPackument({
      packageName: "expo", registryUrl: "https://registry.example.com", registryAuthEnvVar: null, fetchImpl, fetchTimeoutMs: Number.NaN,
    })).rejects.toThrow(/fetchTimeoutMs must be >= 1/);
  });

  test("non-Error rejection reasons keep their diagnostic text in the labels", async () => {
    // streams and fetch impls may reject with a plain string — the label must carry it,
    // not "undefined" (or a TypeError from dereferencing .message on null).
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        if (pulls === 1) c.enqueue(new Uint8Array(3));
        else c.error("plain string reason");
      },
    });
    await expect(readBodyCapped(stream, 10_000, 1_000, "tarball"))
      .rejects.toThrow(/tarball body read failed after 3 bytes: plain string reason/);
    const fetchImpl = (async () => { throw "hop failed as string"; }) as unknown as FetchFn;
    await expect(fetchPackument({
      packageName: "expo", registryUrl: "https://registry.example.com", registryAuthEnvVar: null, fetchImpl,
    })).rejects.toThrow(/fetch failed at hop 0 .*: hop failed as string/);
  });

  test("a hop failure after a query-bearing redirect never leaks the query in the label", async () => {
    let calls = 0;
    const fetchImpl: FetchFn = async () => {
      calls++;
      if (calls === 1) {
        return {
          status: 302, ok: false,
          headers: { get: (n: string) => (n.toLowerCase() === "location" ? "https://registry.example.com/expo?token=SECRET" : null) },
          arrayBuffer: async () => new ArrayBuffer(0), text: async () => "",
        };
      }
      throw new Error("boom");
    };
    const err = await fetchPackument({
      packageName: "expo", registryUrl: "https://registry.example.com", registryAuthEnvVar: null, fetchImpl,
    }).then(() => null, (e: Error) => e.message);
    expect(err).toMatch(/fetch failed at hop 1 \(https:\/\/registry\.example\.com\/expo\): boom/);
    expect(err).not.toContain("SECRET");
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

describe("matchPatternTemplates (#6a — anchored template→RegExp matching)", () => {
  test("MAX_PATTERN_MATCHES is a high cap (not 256 — legit wildcard packages ship many decls)", () => {
    expect(MAX_PATTERN_MATCHES).toBeGreaterThanOrEqual(1024);
  });
  test("single-star template matches by anchored prefix/suffix; distinct files deduped", () => {
    const files = ["./dts/a.d.ts", "./dts/b.d.ts", "./other/c.d.ts", "./dts/a.js"];
    expect(matchPatternTemplates(["./dts/*.d.ts"], files, 100).sort()).toEqual(["./dts/a.d.ts", "./dts/b.d.ts"]);
  });
  test("multi-star template requires the SAME capture (named backref)", () => {
    const files = ["./dist/foo/index-foo.d.ts", "./dist/foo/index-bar.d.ts"];
    expect(matchPatternTemplates(["./dist/*/index-*.d.ts"], files, 100)).toEqual(["./dist/foo/index-foo.d.ts"]);
  });
  test("a no-star template matches exactly one concrete file", () => {
    expect(matchPatternTemplates(["./index.d.ts"], ["./index.d.ts", "./other.d.ts"], 100)).toEqual(["./index.d.ts"]);
  });
  test("regex metacharacters in the literal template parts are escaped (no ReDoS / mismatch)", () => {
    // '.' in the template must match a literal dot, not any char
    expect(matchPatternTemplates(["./a.b/*.d.ts"], ["./aXb/x.d.ts"], 100)).toEqual([]);
    expect(matchPatternTemplates(["./a.b/*.d.ts"], ["./a.b/x.d.ts"], 100)).toEqual(["./a.b/x.d.ts"]);
  });
  test("throws IntrospectionError when DISTINCT matches exceed the cap (fail-closed)", () => {
    const files = ["./dts/a.d.ts", "./dts/b.d.ts", "./dts/c.d.ts"];
    expect(() => matchPatternTemplates(["./dts/*.d.ts"], files, 2)).toThrow(IntrospectionError);
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

// Materialize a `package/` tree under TMP for direct inspectExtracted() coverage (nested paths ok).
let pkgCounter = 0;
function writePackage(files: Array<{ name: string; content: string }>): string {
  const root = join(TMP, `pkg-${pkgCounter++}`, "package");
  for (const f of files) {
    const abs = join(root, f.name);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return root;
}
// Test-only reach-in to seed a stale-epoch marker the public API refuses to create.
const rawDb = (db: AuditDb): Database => (db as unknown as { db: Database }).db;

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

  test("enumerates EXACT exports subpaths AND '*'-pattern subpaths from the swept tree (§5.E #6a full surface)", async () => {
    // The pattern key `./features/*` is NOT skipped: its target template is matched against the
    // extracted declaration files, so a decoy that hides its surface behind a wildcard export is
    // still audited. `hidden` (in features/a.d.ts) MUST appear.
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
              "./features/*": { types: "./features/*.d.ts" }, // pattern key — enumerated (#6a)
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
    expect(names).toEqual(["getConfig", "hidden", "root"]); // root + exact subpath + pattern subpath
    db.close();
  });

  test("a fallback array covers the REAL target past a missing decoy-first entry (#5a)", async () => {
    // TS uses the first target that EXISTS; ship ONLY real.d.ts. A resolver returning only the
    // first structurally-valid target would pick missing.d.ts → drop it → empty marker (fail-open).
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", exports: { ".": ["./missing.d.ts", "./real.d.ts"] } }) },
        { name: "real.d.ts", content: `export declare function realSurface(): void;` },
      ],
      db,
    );
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(true);
    const names = (db.read("SELECT export_name FROM package_api_surface WHERE export_kind='named'").all() as Array<{ export_name: string }>).map((r) => r.export_name);
    expect(names).toEqual(["realSurface"]);
    db.close();
  });

  test("legacy typings is checked BEFORE a decoy types field (#4)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", types: "./decoy.d.ts", typings: "./real.d.ts" }) },
        { name: "real.d.ts", content: `export declare function realTyping(): void;` },
        // decoy.d.ts intentionally NOT shipped — a types-first resolver would read nothing
      ],
      db,
    );
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(true);
    const names = (db.read("SELECT export_name FROM package_api_surface WHERE export_kind='named'").all() as Array<{ export_name: string }>).map((r) => r.export_name);
    expect(names).toEqual(["realTyping"]);
    db.close();
  });

  test("a VERSIONED export condition (types@>=6) is fail-closed: NO marker + errors row (#5b)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const { authHosts: _a } = await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", exports: { "types@>=6": "./real.d.ts", types: "./decoy.d.ts" } }) },
        { name: "real.d.ts", content: `export declare const real: number;` },
        { name: "decoy.d.ts", content: `` },
      ],
      db,
    );
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(false);
    expect((db.read("SELECT message FROM errors").get() as { message: string }).message).toContain("versioned");
    db.close();
  });

  test("a versioned condition NESTED in a fallback array is also fail-closed (#5b)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", exports: { ".": [{ "types@>=6": "./real.d.ts" }, { types: "./decoy.d.ts" }] } }) },
        { name: "real.d.ts", content: `export declare const real: number;` },
      ],
      db,
    );
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(false);
    expect((db.read("SELECT message FROM errors").get() as { message: string }).message).toContain("versioned");
    db.close();
  });

  test("an ordinary `foo@bar` custom condition is NOT versioned — the surface still resolves (#5b GREEN)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", exports: { ".": { "foo@bar": "./real.d.ts", types: "./real.d.ts" } } }) },
        { name: "real.d.ts", content: `export declare function ok(): void;` },
      ],
      db,
    );
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(true);
    const errs = db.read("SELECT message FROM errors").all() as Array<{ message: string }>;
    expect(errs).toEqual([]);
    db.close();
  });

  test("a '*'-pattern export is enumerated from the tree — a wildcard-hidden backdoor is caught (#6a)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", exports: { "./*": { types: "./dts/*.d.ts" } } }) },
        { name: "dts/secret.d.ts", content: `export declare function backdoor(): void;` },
      ],
      db,
    );
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(true);
    const names = (db.read("SELECT export_name FROM package_api_surface WHERE export_kind='named'").all() as Array<{ export_name: string }>).map((r) => r.export_name);
    expect(names).toContain("backdoor");
    db.close();
  });

  test("a MULTI-star pattern enumerates ONLY same-capture files (#6a)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", exports: { "./*": { types: "./dist/*/index-*.d.ts" } } }) },
        { name: "dist/foo/index-foo.d.ts", content: `export declare const matched: number;` }, // same capture 'foo'
        { name: "dist/foo/index-bar.d.ts", content: `export declare const notMatched: number;` }, // capture mismatch
      ],
      db,
    );
    const names = (db.read("SELECT export_name FROM package_api_surface WHERE export_kind='named' ORDER BY export_name").all() as Array<{ export_name: string }>).map((r) => r.export_name);
    expect(names).toContain("matched");
    expect(names).not.toContain("notMatched");
    db.close();
  });

  test("a template whose later star is followed by a digit uses NAMED backrefs (no \\1-ambiguity) (#6a)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", exports: { "./*": { types: "./t/*/v*2.d.ts" } } }) },
        { name: "t/x/vx2.d.ts", content: `export declare const digitBackref: number;` }, // capture 'x', then literal '2'
      ],
      db,
    );
    const names = (db.read("SELECT export_name FROM package_api_surface WHERE export_kind='named'").all() as Array<{ export_name: string }>).map((r) => r.export_name);
    expect(names).toContain("digitBackref");
    db.close();
  });

  test("a NO-star pattern target enumerates the single file (does not throw) (#6a)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", exports: { "./*": "./index.d.ts" } }) },
        { name: "index.d.ts", content: `export declare function single(): void;` },
      ],
      db,
    );
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(true);
    const names = (db.read("SELECT export_name FROM package_api_surface WHERE export_kind='named'").all() as Array<{ export_name: string }>).map((r) => r.export_name);
    expect(names).toEqual(["single"]);
    db.close();
  });

  test("pattern matches OVER the cap fail closed: NO marker + errors row (#6a)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", exports: { "./*": { types: "./dts/*.d.ts" } } }) },
        { name: "dts/a.d.ts", content: `export declare const a: 1;` },
        { name: "dts/b.d.ts", content: `export declare const b: 1;` },
        { name: "dts/c.d.ts", content: `export declare const c: 1;` },
      ],
      db,
      { maxPatternMatches: 2 }, // 3 files match → overflow
    );
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(false);
    expect((db.read("SELECT message FROM errors").get() as { message: string }).message.toLowerCase()).toContain("pattern");
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

  // ---- §D re-export CORRECTNESS (fail-open + wrong-dir bugs the review found) --------------
  test("re-export through a directory index resolves nested specifiers against the OPENED file's dir (§D2)", async () => {
    // `./index.d.ts` → `export * from "./dir"` opens `dir/index.d.ts`; its own `export * from
    // "./secret"` MUST resolve `dir/secret.d.ts` (the opened file's directory), NOT the root
    // decoy `./secret.d.ts`. The old follower recorded the REQUESTED specifier ('dir'), not the
    // file it OPENED ('dir/index.d.ts'), so nested relatives resolved one directory too high.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", types: "./index.d.ts" }) },
        { name: "index.d.ts", content: `export * from "./dir";` },
        { name: "dir/index.d.ts", content: `export * from "./secret";` },
        { name: "dir/secret.d.ts", content: `export declare const dirSecret: number;` },
        { name: "secret.d.ts", content: `export declare const rootDecoy: number;` }, // wrong-dir target
      ],
      db,
    );
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(true);
    const names = (db.read("SELECT export_name FROM package_api_surface WHERE export_kind='named'").all() as Array<{ export_name: string }>).map((r) => r.export_name);
    expect(names).toContain("dirSecret"); // resolved against dir/ (the canonical opened path)
    expect(names).not.toContain("rootDecoy"); // NOT root ./secret.d.ts
    db.close();
  });

  test("a `.js` re-export specifier resolves to the adjacent .d.ts (§D3 extension substitution)", async () => {
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", types: "./index.d.ts" }) },
        { name: "index.d.ts", content: `export * from "./m.js";` }, // runtime specifier
        { name: "m.d.ts", content: `export declare const fromM: number;` }, // its declaration
      ],
      db,
    );
    const names = (db.read("SELECT export_name FROM package_api_surface WHERE export_kind='named'").all() as Array<{ export_name: string }>).map((r) => r.export_name);
    expect(names).toContain("fromM");
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

  test("a temp-dir cleanup failure never masks the original extraction error", async () => {
    // rmSync's force only suppresses ENOENT — an EACCES from the cleanup walk must not
    // replace the actionable extraction error in the recorded errors row (finally-throw
    // semantics would otherwise swallow the primary error).
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    const tgz = buildTgz([{ name: "package.json", content: `{"name":"expo"}` }]);
    const packument = JSON.stringify({
      versions: { "1.0.0": { dist: { tarball: "https://registry.example.com/expo/-/expo-1.0.0.tgz", integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}` } } },
    });
    const runId = seedRun(db);
    const { fetchImpl } = mockRegistry(packument, tgz);
    let runDir = "";
    const spawnImpl = async (_bin: string, args: string[]) => {
      const extractRoot = args[args.indexOf("-C") + 1]!;
      runDir = dirname(extractRoot);
      chmodSync(runDir, 0o555); // cleanup cannot unlink pkg.tgz → rmSync throws EACCES
      return { exitCode: 2, stdout: "", stderr: "ORIGINAL_TAR_FAILURE" };
    };
    const client = new GithubClient({ githubHost: "github.com", tempRoot: TMP, spawnImpl });
    try {
      await introspectVersion({
        client, db, runId, packageName: "expo", registryUrl: "https://registry.example.com",
        registryAuthEnvVar: null, version: "1.0.0", versionSource: "lockfile", fetchImpl,
      });
      const err = db.read(`SELECT message FROM errors WHERE run_id='${runId}'`).get() as { message: string };
      expect(err.message).toContain("tar extraction failed");
      expect(err.message).toContain("ORIGINAL_TAR_FAILURE");
    } finally {
      if (runDir !== "") {
        chmodSync(runDir, 0o755);
        rmSync(runDir, { recursive: true, force: true }); // don't leak the blocked tree into TMP
      }
      db.close();
    }
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

  test("§7 surface epoch: a STALE-epoch marker is re-inspected; the fresh current-epoch marker then short-circuits", async () => {
    // A package audited by the OLD, buggy resolver left a bare '__complete__' marker (no epoch).
    // hasCompletionMarker must treat it as ABSENT so the fixed resolver re-audits the version.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    rawDb(db)
      .query(
        `INSERT INTO package_api_surface (package_name, version, version_source, export_name, export_kind, source, introspected_at)
         VALUES ('expo', '1.0.0', 'lockfile', '', '__complete__', '__complete__', '2024-01-01T00:00:00.000Z')`,
      )
      .run();
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(false); // stale epoch → treated as absent

    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", types: "./index.d.ts" }) },
        { name: "index.d.ts", content: `export declare const reaudited: number;` },
      ],
      db,
    );
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(true); // re-inspected → fresh current-epoch marker
    const names = (db.read("SELECT export_name FROM package_api_surface WHERE export_kind='named'").all() as Array<{ export_name: string }>).map((r) => r.export_name);
    expect(names).toEqual(["reaudited"]);

    // now the current-epoch marker short-circuits (no network work).
    let called = false;
    const runId = seedRun(db);
    const client = new GithubClient({ githubHost: "github.com", tempRoot: TMP });
    await introspectVersion({
      client, db, runId, packageName: "expo", registryUrl: "https://registry.example.com",
      registryAuthEnvVar: null, version: "1.0.0", versionSource: "lockfile",
      fetchImpl: async () => { called = true; throw new Error("should not fetch"); },
    });
    expect(called).toBe(false);
    db.close();
  });

  test("a thin-barrel chain over the parse-file budget is fail-closed: NO marker + errors row (§7)", async () => {
    // 4 barrels + a shared child = 5 parses; inject maxParseFiles=3 → DtsLimitError → errors row.
    const db = AuditDb.open({ sqlitePath: ":memory:" });
    await run(
      [
        { name: "package.json", content: JSON.stringify({ name: "expo", exports: { "./a": "./a.js", "./b": "./b.js", "./c": "./c.js", "./d": "./d.js" } }) },
        { name: "child.d.ts", content: `export declare const fromChild: number;` },
        { name: "a.d.ts", content: `export * from "./child";` },
        { name: "b.d.ts", content: `export * from "./child";` },
        { name: "c.d.ts", content: `export * from "./child";` },
        { name: "d.d.ts", content: `export * from "./child";` },
      ],
      db,
      { inspectCaps: { maxParseFiles: 3 } },
    );
    expect(db.hasCompletionMarker("expo", "1.0.0")).toBe(false);
    expect((db.read("SELECT message FROM errors").get() as { message: string }).message).toContain("parsed .d.ts files");
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

// ---- §7 cardinality / size caps (direct inspectExtracted coverage) ---------------------------
describe("inspectExtracted — §7 cardinality / size caps (fail-closed)", () => {
  test("the exported cap constants hold their documented defaults", () => {
    expect(MAX_PKG_JSON_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_EXACT_EXPORTS).toBe(16_384);
    expect(MAX_BIN_NAMES).toBe(4096);
    expect(MAX_SURFACE_ROWS).toBe(65_536);
    expect(MAX_NAME_BYTES).toBe(1024);
  });

  test("package.json over the byte cap throws BEFORE parse; just-under is accepted", () => {
    const root = writePackage([{ name: "package.json", content: JSON.stringify({ name: "expo", _pad: "x".repeat(400) }) }]);
    expect(() => inspectExtracted(root, { maxPkgJsonBytes: 50 })).toThrow(IntrospectionError);
    expect(() => inspectExtracted(root, { maxPkgJsonBytes: 10_000 })).not.toThrow();
  });

  test("exact export subpaths over the cap throw; at-cap is fine", () => {
    const exports: Record<string, string> = {};
    for (let i = 0; i < 3; i++) exports[`./e${i}`] = `./e${i}.d.ts`;
    const root = writePackage([{ name: "package.json", content: JSON.stringify({ name: "expo", exports }) }]);
    expect(() => inspectExtracted(root, { maxExactExports: 2 })).toThrow(IntrospectionError); // 3 > 2
    expect(() => inspectExtracted(root, { maxExactExports: 3 })).not.toThrow(); // 3 == cap
  });

  test("bin names over the cap throw; at-cap is fine", () => {
    const bin: Record<string, string> = { a: "./a.js", b: "./b.js", c: "./c.js" };
    const root = writePackage([{ name: "package.json", content: JSON.stringify({ name: "expo", bin }) }]);
    expect(() => inspectExtracted(root, { maxBinNames: 2 })).toThrow(IntrospectionError); // 3 > 2
    expect(() => inspectExtracted(root, { maxBinNames: 3 })).not.toThrow();
  });

  test("an over-long name (routes through pushRow) throws; at-cap is fine", () => {
    const longName = "b".repeat(40);
    const root = writePackage([{ name: "package.json", content: JSON.stringify({ name: "expo", bin: { [longName]: "./c.js" } }) }]);
    expect(() => inspectExtracted(root, { maxNameBytes: 10 })).toThrow(IntrospectionError); // 40 > 10
    expect(() => inspectExtracted(root, { maxNameBytes: 40 })).not.toThrow();
  });

  test("total surface rows over the cap throw; at-cap is fine", () => {
    const root = writePackage([
      { name: "package.json", content: JSON.stringify({ name: "expo", types: "./index.d.ts" }) },
      { name: "index.d.ts", content: `export declare const a: 1; export declare const b: 2; export declare const c: 3;` },
    ]);
    expect(() => inspectExtracted(root, { maxSurfaceRows: 2 })).toThrow(IntrospectionError); // 3 rows > 2
    expect(() => inspectExtracted(root, { maxSurfaceRows: 3 })).not.toThrow();
  });
});

// ---- §7 parse budgets (multi-dimensional, injectable — no 256MiB inputs) ----------------------
describe("inspectExtracted — §7 parse budgets", () => {
  test("a .d.ts over the per-file byte cap throws (checked BEFORE createSourceFile)", () => {
    const root = writePackage([
      { name: "package.json", content: JSON.stringify({ name: "expo", types: "./index.d.ts" }) },
      { name: "index.d.ts", content: `export declare const a: 1;`.padEnd(200, " ") },
    ]);
    expect(() => inspectExtracted(root, { maxParseFileBytes: 50 })).toThrow(/\.d\.ts file exceeds 50 bytes/);
    expect(() => inspectExtracted(root, { maxParseFileBytes: 10_000 })).not.toThrow();
  });

  test("ALIAS memoization: non-canonical subpath aliases of ONE .d.ts parse it once and SUCCEED under maxParseFiles=1", () => {
    // `.//index.js`, `./d/../index.js`, `././index.js` all canonicalize to index.d.ts. A broken
    // (non-canonical) memo would parse it 3× and blow maxParseFiles=1; canonical memoization
    // collapses the three subpath aliases to a SINGLE parse, so even a 1-parse budget succeeds.
    const root = writePackage([
      {
        name: "package.json",
        content: JSON.stringify({ name: "expo", exports: { "./a": ".//index.js", "./b": "./d/../index.js", "./c": "././index.js" } }),
      },
      { name: "index.d.ts", content: `export declare function shared(): void;` },
    ]);
    let surface!: ReturnType<typeof inspectExtracted>;
    expect(() => { surface = inspectExtracted(root, { maxParseFiles: 1 }); }).not.toThrow();
    expect(surface.rows.map((r) => r.exportName)).toContain("shared"); // parsed once, did NOT fail closed
  });

  test("THIN-BARREL exhaustion: many distinct barrels over maxParseFiles fail closed; at-cap passes", () => {
    const files = [
      { name: "package.json", content: JSON.stringify({ name: "expo", exports: { "./a": "./a.js", "./b": "./b.js", "./c": "./c.js", "./d": "./d.js" } }) },
      { name: "child.d.ts", content: `export declare const fromChild: number;` },
    ];
    for (const n of ["a", "b", "c", "d"]) files.push({ name: `${n}.d.ts`, content: `export * from "./child";` });
    const root = writePackage(files);
    expect(() => inspectExtracted(root, { maxParseFiles: 3 })).toThrow(/parsed \.d\.ts files exceed 3/); // 4 barrels + child = 5
    expect(() => inspectExtracted(root, { maxParseFiles: 5 })).not.toThrow(); // child memoized → exactly 5
  });

  test("the global cumulative parsed-BYTES budget fails closed independent of file count", () => {
    const big = `export declare const x: 1;`.padEnd(400, " ");
    const root = writePackage([
      { name: "package.json", content: JSON.stringify({ name: "expo", exports: { "./a": "./a.js", "./b": "./b.js" } }) },
      { name: "a.d.ts", content: big },
      { name: "b.d.ts", content: big },
    ]);
    // each file is under the per-file cap and the count cap, but together exceed the byte budget.
    expect(() => inspectExtracted(root, { maxParseFileBytes: 10_000, maxParseFiles: 10, maxTotalParseBytes: 500 })).toThrow(/total parsed \.d\.ts bytes exceed 500/);
    expect(() => inspectExtracted(root, { maxParseFileBytes: 10_000, maxParseFiles: 10, maxTotalParseBytes: 10_000 })).not.toThrow();
  });

  test("a MAX_FOLLOW_FILES+1 barrel chain THROWS (proves the silent-truncation fix)", () => {
    const files = [
      { name: "package.json", content: JSON.stringify({ name: "expo", types: "./index.d.ts" }) },
      { name: "index.d.ts", content: `export * from "./b1";` },
    ];
    for (let i = 1; i <= 4; i++) {
      files.push({ name: `b${i}.d.ts`, content: i < 4 ? `export * from "./b${i + 1}";` : `export declare const leaf: number;` });
    }
    const root = writePackage(files);
    expect(() => inspectExtracted(root, { maxFollowFiles: 3 })).toThrow(/follow limit 3 exceeded/); // 4 follows > 3
    expect(() => inspectExtracted(root, { maxFollowFiles: 4 })).not.toThrow();
  });
});

// ---- §5.E: hostile package name is fail-closed (the bearer token never leaves) ---------------
describe("fetchPackument — a hostile package name is rejected before any request", () => {
  const BS = String.fromCharCode(92); // a REAL backslash
  // `@x\..\..\admin?x=1` — with real backslashes, WHATWG `new URL` would fold the `\` into `/`
  // and normalize the packument URL to `https://r.example/npm/admin?x=1` on the SAME origin, so
  // fetchFollowing would attach the bearer token to that attacker-chosen target.
  const injecting = `@x${BS}..${BS}..${BS}admin?x=1`;

  // A fetch mock that RECORDS every call it sees and would otherwise answer with a valid empty
  // packument — so a missing guard resolves successfully (leaking the token) instead of erroring
  // for some unrelated reason.
  const recordingFetch = (calls: string[]): FetchFn => async (url) => {
    calls.push(url);
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => `{"versions":{}}`,
    };
  };

  test("rejects the injecting name with IntrospectionError and makes ZERO fetch calls", async () => {
    const calls: string[] = [];
    await expect(
      fetchPackument({
        packageName: injecting,
        registryUrl: "https://r.example/npm/team",
        registryAuthEnvVar: "TOKEN",
        env: { TOKEN: "secret-bearer" },
        fetchImpl: recordingFetch(calls),
      }),
    ).rejects.toThrow(IntrospectionError);
    expect(calls).toEqual([]); // fail-closed BEFORE the network → the bearer token never leaves
  });

  test("a valid name still fetches EXACTLY the on-target packument URL", async () => {
    const calls: string[] = [];
    await fetchPackument({
      packageName: "expo",
      registryUrl: "https://r.example/npm/team",
      registryAuthEnvVar: "TOKEN",
      env: { TOKEN: "secret-bearer" },
      fetchImpl: recordingFetch(calls),
    });
    expect(calls).toEqual(["https://r.example/npm/team/expo"]);
  });
});

describe("isValidPackageName (re-exported from apiSurface) — accept/reject table", () => {
  const BS = String.fromCharCode(92);
  test("accepts real npm names", () => {
    for (const name of ["lodash", "@scope/pkg", "@babel/core", "lodash.merge", "left-pad", "@types/node", "JSONStream"])
      expect(isValidPackageName(name)).toBe(true);
  });
  test("rejects injecting / malformed names (fail-closed)", () => {
    for (const name of [`@x${BS}..${BS}admin`, "%2e%2e/%2e%2e/admin?x=1", "@x/../../admin?x=1", "../../admin#f", "@a/b/c", "pkg?x=1", "pkg#f", "_hidden", ".dot", ""])
      expect(isValidPackageName(name)).toBe(false);
  });
});
