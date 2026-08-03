// contentStore.test.ts — the T2c unit content store (ADR-0001 Confirmation checks 3, 6, 7).
// Everything here is fixture-driven (CI has no network): children are scripted structural
// fakes injected through the store's capability seam, and the two-pool tests run through the
// REAL GithubClient wiring with an injected interactive-launch seam. Fake pids sit far above
// the platform pid ceiling so the kill escalation's best-effort group signal can only ESRCH.

import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GithubClient, MAX_SPAWN_OUTPUT_BYTES,
  type LaunchedChild, type LaunchRequest, type SpawnFn, type StreamReader,
} from "./github.ts";
import { gitBlobOid, GitFrameError, type GitObjectFormat } from "./gitFrame.ts";
import {
  openUnitContentStore, ContentStoreError, DEFAULT_CONTENT_STORE_LIMITS,
  CONTENT_READ_DEADLINE_MS, CONTENT_DISPOSE_DEADLINE_MS, CONTENT_FRAME_HEADER_BYTES,
  CONTENT_STDERR_RING_BYTES, LS_TREE_MAX_ENTRIES, LS_TREE_MAX_RECORD_BYTES,
  type ContentStoreCaps, type ContentStoreLimits, type UnitContentStore,
} from "./contentStore.ts";
import type { TreeEntry } from "./unitPipeline.ts";

const TEST_TMP = mkdtempSync(join(tmpdir(), "content-store-test-"));
afterAll(() => rmSync(TEST_TMP, { recursive: true, force: true }));

const enc = new TextEncoder();
const SHA1: GitObjectFormat = "sha1";
// far above any real pid (macOS/Linux pid ceilings are 5-7 digits at most by default), so the
// escalation's group signal always lands on nothing
const FAKE_PID = 4_242_424;

// ---- scripted structural child ----------------------------------------------------------------

// A pull-queue byte stream matching the structural reader shape. `onDrained` fires ONCE, when a
// read first observes end-of-stream — the teardown-order tests use it to place "the pump joined"
// relative to permit release.
class FakeStream {
  private queue: Uint8Array[] = [];
  private pending: Array<(r: { done?: boolean; value?: Uint8Array }) => void> = [];
  private closed = false;
  private drainedNoted = false;
  constructor(private readonly onDrained?: () => void) {}
  feed(data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    const w = this.pending.shift();
    if (w !== undefined) w({ value: bytes });
    else this.queue.push(bytes);
  }
  close(): void {
    this.closed = true;
    for (const w of this.pending.splice(0)) this.deliverDone(w);
  }
  private deliverDone(w: (r: { done?: boolean }) => void): void {
    if (!this.drainedNoted) {
      this.drainedNoted = true;
      this.onDrained?.();
    }
    w({ done: true });
  }
  getReader(): StreamReader {
    return {
      read: () =>
        new Promise((resolve) => {
          const item = this.queue.shift();
          if (item !== undefined) return resolve({ value: item });
          if (this.closed) return this.deliverDone(resolve);
          this.pending.push(resolve);
        }),
      cancel: async () => this.close(),
    };
  }
}

interface FakeChildOpts {
  events?: string[]; // shared event log (tagged)
  tag?: string;
  // scripted reply to one stdin request line; default serves nothing (silent child)
  onStdinLine?: (line: string, fc: FakeChild) => void;
  // default: a well-behaved child exits 0 when its stdin closes
  onEnd?: (fc: FakeChild) => void;
  // default: a killed child dies promptly (keeps dispose waits off the escalation timers)
  onKill?: (signal: number | undefined, fc: FakeChild) => void;
  // the stdin write records the line and then never settles (a stalled structural sink)
  hangStdinWrite?: boolean;
}

class FakeChild {
  readonly events: string[];
  readonly stdinLines: string[] = [];
  readonly out: FakeStream;
  readonly errS: FakeStream;
  readonly child: LaunchedChild;
  private readonly tag: string;
  private exitResolve!: (code: number) => void;
  exitSettled = false;

  constructor(opts: FakeChildOpts = {}) {
    this.events = opts.events ?? [];
    this.tag = opts.tag ?? "";
    const ev = (name: string): void => {
      this.events.push(`${this.tag}${name}`);
    };
    this.out = new FakeStream(() => ev("stdout-drained"));
    this.errS = new FakeStream(() => ev("stderr-drained"));
    const exited = new Promise<number>((resolve) => {
      this.exitResolve = resolve;
    });
    const onEnd = opts.onEnd ?? ((fc: FakeChild) => fc.exit(0));
    const onKill = opts.onKill ?? ((_sig: number | undefined, fc: FakeChild) => fc.exit(137));
    this.child = {
      pid: FAKE_PID,
      stdout: { getReader: () => this.out.getReader() },
      stderr: { getReader: () => this.errS.getReader() },
      stdin: {
        write: (data: Uint8Array): number | Promise<number> => {
          const line = new TextDecoder().decode(data);
          this.stdinLines.push(line);
          if (opts.hangStdinWrite === true) return new Promise<number>(() => undefined);
          opts.onStdinLine?.(line, this);
          return data.byteLength;
        },
        flush: () => undefined,
        end: () => {
          ev("stdin-end");
          onEnd(this);
        },
      },
      exited,
      kill: (signal?: number) => {
        ev(signal === 9 ? "kill9" : "kill");
        opts.onKill === undefined ? onKill(signal, this) : opts.onKill(signal, this);
      },
      unref: () => undefined,
    };
  }

  exit(code: number): void {
    if (this.exitSettled) return;
    this.exitSettled = true;
    this.events.push(`${this.tag}exit`);
    this.exitResolve(code);
    this.out.close();
    this.errS.close();
  }

  serveFrame(oid: string, body: Uint8Array): void {
    this.out.feed(`${oid} blob ${body.byteLength}\n`);
    this.out.feed(body);
    this.out.feed("\n");
  }
}

// ---- fixtures ---------------------------------------------------------------------------------

const BODY_A = enc.encode("hello canonical content\n");
const OID_A = gitBlobOid(BODY_A, SHA1);
const BODY_B = enc.encode("#!/bin/sh\nexit 0\n");
const OID_B = gitBlobOid(BODY_B, SHA1);
const LINK_OID = "ab".repeat(20); // the link blob itself is never hashed on the fallback route
const TREE_OID = "12".repeat(20);
const GITLINK_OID = "34".repeat(20);

interface LsRow {
  mode: string;
  type: string;
  oid: string;
  size: string;
  path: string;
}
const lsBytes = (rows: LsRow[]): Uint8Array =>
  enc.encode(rows.map((r) => `${r.mode} ${r.type} ${r.oid} ${r.size}\t${r.path}\0`).join(""));

const DEFAULT_ROWS: LsRow[] = [
  { mode: "100644", type: "blob", oid: OID_A, size: String(BODY_A.byteLength), path: "src/a.txt" },
  { mode: "100755", type: "blob", oid: OID_B, size: String(BODY_B.byteLength), path: "tools/run.sh" },
  { mode: "120000", type: "blob", oid: LINK_OID, size: "17", path: "link.txt" },
  { mode: "040000", type: "tree", oid: TREE_OID, size: "-", path: "src" },
  { mode: "160000", type: "commit", oid: GITLINK_OID, size: "-", path: "vendor/sub" },
];

const TEST_LIMITS: ContentStoreLimits = {
  maxHeaderBytes: 256,
  frameCeiling: MAX_SPAWN_OUTPUT_BYTES,
  stderrRingBytes: 64 * 1024,
  readDeadlineMs: 250,
  disposeDeadlineMs: 250,
  lsTree: { maxEntries: 1_000_000, maxRecordBytes: 64 * 1024 },
};

interface HarnessOpts {
  rows?: LsRow[];
  lsResult?: Partial<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array; timedOut: boolean }>;
  childOpts?: FakeChildOpts[]; // per-launch scripting, in launch order
  fallback?: (path: string, entry: TreeEntry) => Promise<string | null>;
  budget?: number;
  limits?: Partial<ContentStoreLimits>;
  manualPermits?: boolean; // permit grants queue until the test calls grantNextPermit()
}

function makeHarness(opts: HarnessOpts = {}) {
  const events: string[] = [];
  const launches: FakeChild[] = [];
  const fallbackCalls: string[] = [];
  const permits = { acquired: 0, released: 0 };
  const permitWaiters: Array<() => void> = [];
  const counts = { lsTree: 0 };
  const caps: ContentStoreCaps = {
    runLsTree: async () => {
      counts.lsTree++;
      return {
        exitCode: 0,
        stdout: lsBytes(opts.rows ?? DEFAULT_ROWS),
        stderr: new Uint8Array(0),
        timedOut: false,
        ...opts.lsResult,
      };
    },
    launchBatchChild: () => {
      const script = opts.childOpts?.[launches.length] ?? {
        onStdinLine: (line: string, fc: FakeChild) => {
          const oid = line.trim();
          if (oid === OID_A) fc.serveFrame(OID_A, BODY_A);
          else if (oid === OID_B) fc.serveFrame(OID_B, BODY_B);
          else fc.out.feed(`${oid} missing\n`);
        },
      };
      const fc = new FakeChild({ events, ...script });
      launches.push(fc);
      return fc.child;
    },
    acquireChildPermit: () =>
      new Promise<() => void>((resolve) => {
        const grant = (): void => {
          permits.acquired++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            permits.released++;
            events.push("permit-released");
          });
        };
        if (opts.manualPermits === true) permitWaiters.push(grant);
        else grant();
      }),
    readViaRestFallback: async (path, entry) => {
      fallbackCalls.push(path);
      return opts.fallback === undefined ? "DEREFERENCED TARGET CONTENT" : opts.fallback(path, entry);
    },
  };
  const open = () =>
    openUnitContentStore(caps, {
      cwd: join(TEST_TMP, "fake-clone"),
      format: SHA1,
      restFallbackBudget: opts.budget ?? 20,
      limits: { ...TEST_LIMITS, ...opts.limits },
    });
  const grantNextPermit = (): void => permitWaiters.shift()?.();
  return { caps, open, events, launches, fallbackCalls, permits, counts, grantNextPermit };
}

const entryOf = (store: UnitContentStore, path: string): TreeEntry => {
  const e = store.entries().find((x) => x.path === path);
  expect(e, `fixture entry ${path} must exist`).toBeDefined();
  return e!;
};

// index ordering helper for the teardown assertions: every event in `before` must appear, and
// strictly precede every event in `after`
const assertOrder = (events: string[], before: string[], after: string[]): void => {
  for (const b of before) {
    const bi = events.indexOf(b);
    expect({ event: b, present: bi !== -1 }).toEqual({ event: b, present: true });
    for (const a of after) {
      const ai = events.indexOf(a);
      expect({ before: b, after: a, ordered: ai !== -1 && bi < ai }).toEqual({ before: b, after: a, ordered: true });
    }
  }
};

// ---- ratified constants -----------------------------------------------------------------------

describe("ratified constants (rvo Q4: the bench trio + framed-child limits)", () => {
  test("the production values are the ratified ones", () => {
    expect(CONTENT_READ_DEADLINE_MS).toBe(60_000);
    expect(CONTENT_DISPOSE_DEADLINE_MS).toBe(10_000);
    expect(CONTENT_FRAME_HEADER_BYTES).toBe(256);
    expect(CONTENT_STDERR_RING_BYTES).toBe(64 * 1024);
    expect(LS_TREE_MAX_ENTRIES).toBe(1_000_000);
    expect(LS_TREE_MAX_RECORD_BYTES).toBe(64 * 1024);
  });
  test("the default limits wire those values, with the frame ceiling PINNED to the spawn-output cap", () => {
    expect(DEFAULT_CONTENT_STORE_LIMITS).toEqual({
      maxHeaderBytes: CONTENT_FRAME_HEADER_BYTES,
      frameCeiling: MAX_SPAWN_OUTPUT_BYTES, // the bill pins this to production's existing cap
      stderrRingBytes: CONTENT_STDERR_RING_BYTES,
      readDeadlineMs: CONTENT_READ_DEADLINE_MS,
      disposeDeadlineMs: CONTENT_DISPOSE_DEADLINE_MS,
      lsTree: { maxEntries: LS_TREE_MAX_ENTRIES, maxRecordBytes: LS_TREE_MAX_RECORD_BYTES },
    });
    expect(MAX_SPAWN_OUTPUT_BYTES).toBe(110 * 1024 * 1024);
  });
});

// ---- store open -------------------------------------------------------------------------------

describe("store open (enumeration, fail-closed BEFORE parse)", () => {
  test("store open refuses a nonzero-exit enumeration BEFORE parsing — valid listing bytes with exit 1 still fail closed", async () => {
    // the stdout carries a perfectly parseable listing: if the exit check ran after (or never),
    // this would open as a healthy store — the codex round-4 silent-empty-repo hazard's sibling
    const h = makeHarness({ lsResult: { exitCode: 1, stderr: enc.encode("fatal: not a git repository") } });
    const err = await h.open().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("ls-tree-failed");
    expect((err as ContentStoreError).message).toContain("not a git repository");
  });
  test("store open refuses a nonzero-exit enumeration whose stdout is MALFORMED — the exit check demonstrably runs first", async () => {
    // valid-bytes-with-exit-1 cannot distinguish exit-first from parse-then-exit; malformed
    // bytes CAN: parse-first would surface GitFrameError, exit-first the enumeration failure
    const h = makeHarness({
      lsResult: { exitCode: 1, stdout: enc.encode("garbage that would fail the parser\0"), stderr: enc.encode("fatal: broken") },
    });
    const err = await h.open().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("ls-tree-failed");
  });
  test("store open refuses a timed-out enumeration before parsing", async () => {
    const h = makeHarness({ lsResult: { exitCode: 124, timedOut: true, stdout: new Uint8Array(0) } });
    const err = await h.open().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("ls-tree-failed");
    expect((err as ContentStoreError).message).toContain("timed out");
  });
  test("exit 0 with empty stdout is a LEGAL empty listing — zero entries, no error", async () => {
    const h = makeHarness({ lsResult: { stdout: new Uint8Array(0) } });
    const store = await h.open();
    expect(store.entries()).toEqual([]);
    await store.dispose();
  });
  test("malformed listing bytes fail closed at parse (exit 0)", async () => {
    const h = makeHarness({ lsResult: { stdout: enc.encode("not a listing\0") } });
    await expect(h.open()).rejects.toThrow(GitFrameError);
  });
  test("entries() maps the canonical index: blob/tree/commit types, oid as sha, ls-tree sizes", async () => {
    const h = makeHarness();
    const store = await h.open();
    expect(store.entries()).toEqual([
      { path: "src/a.txt", type: "blob", sha: OID_A, size: BODY_A.byteLength },
      { path: "tools/run.sh", type: "blob", sha: OID_B, size: BODY_B.byteLength },
      { path: "link.txt", type: "blob", sha: LINK_OID, size: 17 },
      { path: "src", type: "tree", sha: TREE_OID, size: null },
      { path: "vendor/sub", type: "commit", sha: GITLINK_OID, size: null },
    ]);
    await store.dispose();
  });
});

// ---- reads: canonical route, mode routing, budget --------------------------------------------

describe("reads (canonical child route + mode routing + fallback budget)", () => {
  test("a regular blob is served by the child, self-verified, and seam-decoded; stdin carries EXACTLY the oid line", async () => {
    const h = makeHarness();
    const store = await h.open();
    const text = await store.read("src/a.txt", entryOf(store, "src/a.txt"));
    expect(text).toBe("hello canonical content\n");
    expect(h.launches.length).toBe(1);
    expect(h.launches[0]!.stdinLines).toEqual([`${OID_A}\n`]);
    expect(store.counters.localCanonicalReads).toBe(1);
    expect(store.counters.restFallbackReads.symlink).toBe(0);
    await store.dispose();
  });
  test("a non-UTF-8 canonical body arrives as the deliberate replacement decode", async () => {
    const body = new Uint8Array([0x61, 0xff, 0x62]); // a, invalid byte, b
    const oid = gitBlobOid(body, SHA1);
    const h = makeHarness({
      rows: [{ mode: "100644", type: "blob", oid, size: "3", path: "bin.dat" }],
      childOpts: [{ onStdinLine: (_line, fc) => fc.serveFrame(oid, body) }],
    });
    const store = await h.open();
    expect(await store.read("bin.dat", entryOf(store, "bin.dat"))).toBe("a�b");
    await store.dispose();
  });
  test("mode 120000 routes to the injected REST fallback and never touches the child", async () => {
    const h = makeHarness();
    const store = await h.open();
    const text = await store.read("link.txt", entryOf(store, "link.txt"));
    expect(text).toBe("DEREFERENCED TARGET CONTENT");
    expect(h.fallbackCalls).toEqual(["link.txt"]);
    expect(h.launches.length).toBe(0); // no child, no child permit
    expect(h.permits.acquired).toBe(0);
    expect(store.counters.restFallbackReads.symlink).toBe(1);
    expect(store.counters.fallbackBudgetSpend).toBe(1);
    await store.dispose();
  });
  test("the fallback's null (the 404 force-push parity) passes through as null", async () => {
    const h = makeHarness({ fallback: async () => null });
    const store = await h.open();
    expect(await store.read("link.txt", entryOf(store, "link.txt"))).toBeNull();
    expect(store.counters.fallbackBudgetSpend).toBe(1); // the request was still spent
    await store.dispose();
  });
  test("tree and commit modes return null (reader parity), spending nothing", async () => {
    const h = makeHarness();
    const store = await h.open();
    expect(await store.read("src", entryOf(store, "src"))).toBeNull();
    expect(await store.read("vendor/sub", entryOf(store, "vendor/sub"))).toBeNull();
    expect(h.fallbackCalls).toEqual([]);
    expect(h.launches.length).toBe(0);
    expect(store.counters.fallbackBudgetSpend).toBe(0);
    await store.dispose();
  });
  test("an unknown path fails closed — the local index cannot race, so absence is a wiring bug, never a benign null", async () => {
    const h = makeHarness();
    const store = await h.open();
    const entry: TreeEntry = { path: "ghost.txt", type: "blob", sha: OID_A, size: 1 };
    const err = await store.read("ghost.txt", entry).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("unknown-path");
    await store.dispose();
  });
  test("`<oid> missing` for an enumerated oid fails the unit CLOSED — never the seam's benign null, and never a respawn", async () => {
    const h = makeHarness({
      childOpts: [{ onStdinLine: (line, fc) => fc.out.feed(`${line.trim()} missing\n`) }],
    });
    const store = await h.open();
    const err = await store.read("src/a.txt", entryOf(store, "src/a.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("object-missing");
    expect((err as ContentStoreError).message).toContain("corruption");
    expect(h.launches.length).toBe(1); // a missing record is a VALID frame — no respawn
    expect(store.counters.childRespawns).toBe(0);
    await store.dispose();
  });
  test("frame bytes that do not hash to the enumerated oid fail closed BEFORE any seam decode", async () => {
    const wrong = enc.encode("jello canonical content\n"); // same length as BODY_A, different bytes
    expect(wrong.byteLength).toBe(BODY_A.byteLength);
    const h = makeHarness({
      childOpts: [{ onStdinLine: (_line, fc) => fc.serveFrame(OID_A, wrong) }],
    });
    const store = await h.open();
    const err = await store.read("src/a.txt", entryOf(store, "src/a.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("hash-mismatch");
    expect(store.counters.childRespawns).toBe(0); // a store-level verification failure, not a child death
    await store.dispose();
  });
  test("a declared size beyond the absolute ceiling is refused BEFORE any request is written or child spawned", async () => {
    const h = makeHarness({
      rows: [{ mode: "100644", type: "blob", oid: OID_A, size: "9", path: "big.bin" }],
      limits: { frameCeiling: 8 },
    });
    const store = await h.open();
    const err = await store.read("big.bin", entryOf(store, "big.bin")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("over-ceiling");
    expect(h.launches.length).toBe(0); // refused before the child exists
    await store.dispose();
  });
  test("the fallback budget trips with a DISTINCT message and the tripped read never reaches REST", async () => {
    const h = makeHarness({
      rows: [
        { mode: "120000", type: "blob", oid: LINK_OID, size: "17", path: "l1" },
        { mode: "120000", type: "blob", oid: LINK_OID.replace(/^ab/, "cd"), size: "17", path: "l2" },
      ],
      budget: 1,
    });
    const store = await h.open();
    expect(await store.read("l1", entryOf(store, "l1"))).toBe("DEREFERENCED TARGET CONTENT");
    const err = await store.read("l2", entryOf(store, "l2")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("fallback-budget");
    expect((err as ContentStoreError).message).toContain("budget");
    expect(h.fallbackCalls).toEqual(["l1"]); // the tripped read spent nothing
    expect(store.counters.fallbackBudgetSpend).toBe(1);
    await store.dispose();
  });
  test("counters separate canonical reads, fallback reads by cause, and budget spend", async () => {
    const h = makeHarness();
    const store = await h.open();
    await store.read("src/a.txt", entryOf(store, "src/a.txt"));
    await store.read("tools/run.sh", entryOf(store, "tools/run.sh"));
    await store.read("link.txt", entryOf(store, "link.txt"));
    expect(store.counters).toEqual({
      localCanonicalReads: 2,
      restFallbackReads: { symlink: 1 },
      fallbackBudgetSpend: 1,
      childRespawns: 0,
    });
    await store.dispose();
  });
});

// ---- child lifecycle --------------------------------------------------------------------------

describe("child lifecycle (check 6: deadline, respawn-once, ordered teardown, abort)", () => {
  test("the per-read deadline kills the child; the single respawn serves the retried read", async () => {
    const h = makeHarness({
      childOpts: [
        {}, // child 1: silent — the deadline must fire
        { onStdinLine: (_line, fc) => fc.serveFrame(OID_A, BODY_A) }, // child 2 serves
      ],
      limits: { readDeadlineMs: 25 },
    });
    const store = await h.open();
    const text = await store.read("src/a.txt", entryOf(store, "src/a.txt"));
    expect(text).toBe("hello canonical content\n");
    expect(h.launches.length).toBe(2);
    expect(h.launches[0]!.events).toContain("kill"); // the deadline killed child 1
    expect(store.counters.childRespawns).toBe(1);
    expect(h.permits.acquired).toBe(1); // the permit is held ACROSS the respawn, not re-acquired
    const disposal = await store.dispose();
    expect(disposal.clean).toBe(true); // the surviving child closed clean
  });
  test("a second child death fails the unit with the FIRST child's diagnosis retained", async () => {
    const die = (marker: string) => ({
      onStdinLine: (_line: string, fc: FakeChild) => {
        fc.errS.feed(`fatal: ${marker}\n`);
        fc.exit(128);
      },
    });
    const h = makeHarness({ childOpts: [die("first child bad object store"), die("second child boom")] });
    const store = await h.open();
    const err = await store.read("src/a.txt", entryOf(store, "src/a.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("child-died-twice");
    // the FIRST child's disposal diagnosis (its own stderr) survives into the failure
    expect((err as ContentStoreError).message).toContain("first child bad object store");
    expect(h.launches.length).toBe(2);
    expect(store.counters.childRespawns).toBe(1);
    await store.dispose();
  });
  test("unsolicited child bytes poison the store — the disposal verdict is unclean with the protocol diagnosis", async () => {
    const h = makeHarness();
    const store = await h.open();
    await store.read("src/a.txt", entryOf(store, "src/a.txt")); // spawn the child
    h.launches[0]!.out.feed("garbage nobody asked for\n");
    await new Promise((r) => setTimeout(r, 5)); // let the pump observe it
    const disposal = await store.dispose();
    expect(disposal.clean).toBe(false);
    expect(disposal.detail).toMatch(/no request in flight|framing violation/);
  });
  test("abort mid-read rejects the read (never a respawn) and teardown still runs ordered", async () => {
    const h = makeHarness({ childOpts: [{}] }); // silent child: the read stays pending
    const store = await h.open();
    const pending = store.read("src/a.txt", entryOf(store, "src/a.txt"));
    await new Promise((r) => setTimeout(r, 5)); // the request line is written, the frame never comes
    store.abort("branch aborted");
    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("aborted");
    expect(h.launches.length).toBe(1); // an abort must not burn the respawn allowance on a retry
    expect(store.counters.childRespawns).toBe(0);
    const disposal = await store.dispose();
    expect(disposal.clean).toBe(false); // the aborted child is not a clean close
    assertOrder(h.events, ["exit"], ["permit-released"]);
    expect(h.permits.released).toBe(1);
  });
  test("teardown is ORDERED — stdin close → exit → stream drain → permit release — and idempotent", async () => {
    const h = makeHarness();
    const store = await h.open();
    await store.read("src/a.txt", entryOf(store, "src/a.txt"));
    const first = store.dispose();
    const second = store.dispose();
    expect(first === second).toBe(true); // ONE teardown, shared by every caller
    const disposal = await first;
    expect(disposal.clean).toBe(true);
    assertOrder(h.events, ["stdin-end"], ["exit"]);
    assertOrder(h.events, ["exit"], ["stdout-drained", "stderr-drained"]);
    assertOrder(h.events, ["stdout-drained", "stderr-drained"], ["permit-released"]);
    expect(h.permits.released).toBe(1);
  });
  test("a read after dispose is refused", async () => {
    const h = makeHarness();
    const store = await h.open();
    await store.dispose();
    const err = await store.read("src/a.txt", entryOf(store, "src/a.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("store-disposed");
  });
  test("a store whose reads never needed a child disposes clean, holding no permit", async () => {
    const h = makeHarness();
    const store = await h.open();
    await store.read("link.txt", entryOf(store, "link.txt")); // fallback only
    const disposal = await store.dispose();
    expect(disposal).toEqual({ clean: true, detail: null });
    expect(h.permits.acquired).toBe(0);
    expect(h.permits.released).toBe(0);
  });
  test("abort while a read is QUEUED on a saturated child pool rejects it, launches NOTHING, and hands the late-granted permit straight back", async () => {
    const h = makeHarness({ manualPermits: true });
    const store = await h.open();
    const outcome = store.read("src/a.txt", entryOf(store, "src/a.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 5)); // the read is now waiting on the permit
    store.abort("branch aborted");
    h.grantNextPermit(); // the pool frees only AFTER the abort landed
    const err = await outcome;
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("aborted");
    expect(h.launches.length).toBe(0); // a post-abort launch would outlive every teardown
    expect(h.permits.acquired).toBe(1);
    expect(h.permits.released).toBe(1); // granted and immediately handed back — never leaked
    const disposal = await store.dispose();
    expect(disposal).toEqual({ clean: true, detail: null }); // no child ever existed
  });
  test("dispose while a read is QUEUED on a saturated pool: the late grant launches nothing and leaks nothing", async () => {
    const h = makeHarness({ manualPermits: true });
    const store = await h.open();
    const outcome = store.read("src/a.txt", entryOf(store, "src/a.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 5));
    const disposal = await store.dispose(); // resolves with no child — the read is still queued
    expect(disposal).toEqual({ clean: true, detail: null });
    h.grantNextPermit();
    const err = await outcome;
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("store-disposed");
    expect(h.launches.length).toBe(0); // a launch here would be a child nothing ever disposes
    expect(h.permits.acquired).toBe(1);
    expect(h.permits.released).toBe(1);
  });
  test("abort during an in-flight symlink fallback rejects the read — a post-abort result is never delivered", async () => {
    let resolveFallback!: (v: string | null) => void;
    const h = makeHarness({ fallback: () => new Promise((r) => (resolveFallback = r)) });
    const store = await h.open();
    const outcome = store.read("link.txt", entryOf(store, "link.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 5)); // the fallback request is in flight
    store.abort("branch aborted");
    resolveFallback("TOO LATE");
    const err = await outcome;
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("aborted");
    expect(store.counters.fallbackBudgetSpend).toBe(1); // the request was already issued — spend stands
  });
  test("a hung stdin write cannot hold the read past the deadline — the deadline still governs and the respawn serves", async () => {
    const h = makeHarness({
      childOpts: [
        { hangStdinWrite: true }, // child 1: the request line is recorded but the sink never settles
        { onStdinLine: (_line, fc) => fc.serveFrame(OID_A, BODY_A) },
      ],
      limits: { readDeadlineMs: 25 },
    });
    const store = await h.open();
    const text = await store.read("src/a.txt", entryOf(store, "src/a.txt"));
    expect(text).toBe("hello canonical content\n");
    expect(store.counters.childRespawns).toBe(1);
    expect(h.launches[0]!.events).toContain("kill"); // the deadline killed the stalled child
    const disposal = await store.dispose();
    expect(disposal.clean).toBe(true);
  });
  test("an abort landing during the dead child's own teardown stops the respawn — no second launch", async () => {
    const holder: { store: UnitContentStore | null } = { store: null };
    const h = makeHarness({
      childOpts: [
        {
          onStdinLine: (_line, fc) => {
            fc.errS.feed("fatal: boom\n");
            fc.exit(128);
          },
          // the dead child's dispose() closes stdin — the abort lands INSIDE that teardown
          onEnd: (fc) => {
            holder.store?.abort("abort during teardown");
            fc.exit(0);
          },
        },
      ],
    });
    const store = await h.open();
    holder.store = store;
    const err = await store.read("src/a.txt", entryOf(store, "src/a.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("aborted");
    expect(h.launches.length).toBe(1); // the replacement was never launched
    expect(store.counters.childRespawns).toBe(1); // the allowance was consumed, then the abort stopped it
    await store.dispose();
  });
  test("an abort during the REPLACEMENT child's read surfaces as the abort — never relabelled a double death", async () => {
    const h = makeHarness({
      childOpts: [
        {
          onStdinLine: (_line, fc) => {
            fc.errS.feed("fatal: first death\n");
            fc.exit(128);
          },
        },
        {}, // child 2: silent — the retried read is pending when the abort lands
      ],
    });
    const store = await h.open();
    const outcome = store.read("src/a.txt", entryOf(store, "src/a.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 15)); // child 1 died, the respawned read is now in flight
    expect(h.launches.length).toBe(2);
    store.abort("branch aborted");
    const err = await outcome;
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("aborted"); // the abort is its own outcome
    expect(store.counters.childRespawns).toBe(1);
    await store.dispose();
  });
  test("an ABORT-INDUCED transport failure surfaces the abort as the label, carrying the transport failure as diagnosis", async () => {
    // models the production shape: the abort reaches the REST layer, whose in-flight call
    // then fails BECAUSE of it — the transport rejection arrives already-aborted, and the
    // read's label must be the abort, with the induced failure riding along as diagnosis
    const holder: { store: UnitContentStore | null } = { store: null };
    const h = makeHarness({
      fallback: async () => {
        holder.store?.abort("branch aborted");
        throw new Error("transport torn down");
      },
    });
    const store = await h.open();
    holder.store = store;
    const err = await store.read("link.txt", entryOf(store, "link.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("aborted");
    expect((err as ContentStoreError).message).toContain("transport torn down"); // the induced failure rides along
  });
  test("teardown ordering holds for a child whose exit is ASYNCHRONOUS (not tied to the stdin close tick)", async () => {
    const h = makeHarness({
      childOpts: [
        {
          onStdinLine: (_line, fc) => fc.serveFrame(OID_A, BODY_A),
          onEnd: (fc) => {
            setTimeout(() => fc.exit(0), 15); // the real child's EOF-then-exit is never same-tick
          },
        },
      ],
    });
    const store = await h.open();
    await store.read("src/a.txt", entryOf(store, "src/a.txt"));
    const disposal = await store.dispose();
    expect(disposal.clean).toBe(true); // the bounded exit wait genuinely waited
    assertOrder(h.events, ["stdin-end"], ["exit"]);
    assertOrder(h.events, ["exit"], ["stdout-drained", "stderr-drained"]);
    assertOrder(h.events, ["stdout-drained", "stderr-drained"], ["permit-released"]);
  });
  test("teardown ordering holds on the FAILURE path too — the second child's teardown is ordered after a double death", async () => {
    const die = (tag: string) => ({
      tag,
      onStdinLine: (_line: string, fc: FakeChild) => {
        fc.errS.feed("fatal: died\n");
        fc.exit(128);
      },
    });
    const h = makeHarness({ childOpts: [die("c1-"), die("c2-")] });
    const store = await h.open();
    const err = await store.read("src/a.txt", entryOf(store, "src/a.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as ContentStoreError).code).toBe("child-died-twice");
    const disposal = await store.dispose();
    expect(disposal.clean).toBe(false); // the second child died — never a clean verdict
    // A child that died BEFORE teardown drains at its death, so stdin-end legitimately comes
    // after the drains here. The failure path's guarantee is the TAIL of the order: the
    // teardown still closes stdin, still joins the (already-settled) pumps, and releases the
    // permit strictly LAST — after every child-2 lifecycle event.
    assertOrder(h.events, ["c2-exit", "c2-stdout-drained", "c2-stderr-drained", "c2-stdin-end"], ["permit-released"]);
    expect(h.permits.released).toBe(1);
  });
  test("a manager-construction failure after the launch kills the child, surfaces RAW, and never burns the respawn allowance", async () => {
    const killed: string[] = [];
    const h = makeHarness();
    const caps = {
      ...h.caps,
      launchBatchChild: (): ReturnType<typeof h.caps.launchBatchChild> => {
        const fc = new FakeChild({ onKill: (_sig, self) => {
          killed.push("killed");
          self.exit(137);
        } });
        // a hostile/broken handle: reader acquisition throws AFTER the launch succeeded
        return {
          ...fc.child,
          stdout: {
            getReader: (): never => {
              throw new Error("reader acquisition failed");
            },
          },
        };
      },
    };
    const store = await openUnitContentStore(caps, {
      cwd: join(TEST_TMP, "fake-clone"),
      format: SHA1,
      restFallbackBudget: 20,
      limits: TEST_LIMITS,
    });
    const err = await store.read("src/a.txt", entryOf(store, "src/a.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    // a setup failure is NOT a child death: it surfaces as itself, never as a double death,
    // and the single respawn allowance stays intact for a real child failure
    expect((err as Error).message).toContain("reader acquisition failed");
    expect(store.counters.childRespawns).toBe(0);
    expect(killed.length).toBe(1); // exactly one launch, killed rather than orphaned
    await store.dispose();
    expect(h.permits.released).toBe(h.permits.acquired); // the permit still came back
  });
  test("dispose runs the clone-deletion hook BETWEEN the child teardown and the permit release (check 6's letter)", async () => {
    const h = makeHarness();
    const store = await h.open();
    await store.read("src/a.txt", entryOf(store, "src/a.txt"));
    const disposal = await store.dispose({
      beforePermitRelease: () => {
        h.events.push("clone-deleted");
      },
    });
    expect(disposal.clean).toBe(true);
    assertOrder(h.events, ["stdin-end", "exit", "stdout-drained", "stderr-drained"], ["clone-deleted"]);
    assertOrder(h.events, ["clone-deleted"], ["permit-released"]);
  });
  test("a throwing clone-deletion hook rejects dispose() but NEVER leaks the permit", async () => {
    const h = makeHarness();
    const store = await h.open();
    await store.read("src/a.txt", entryOf(store, "src/a.txt"));
    const first = store.dispose({
      beforePermitRelease: () => {
        throw new Error("deletion failed");
      },
    });
    const err = await first.then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain("deletion failed");
    expect(h.permits.released).toBe(1); // released in the hook's finally — never leaked
    expect(store.dispose() === first).toBe(true); // still one memoized teardown
  });
  test("an abort rejects a fallback read whose transport NEVER settles — promptly, not at the transport's bound", async () => {
    const h = makeHarness({ fallback: () => new Promise(() => undefined) }); // a hung transport
    const store = await h.open();
    const outcome = store.read("link.txt", entryOf(store, "link.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 5));
    store.abort("branch aborted");
    const err = await outcome; // resolves NOW — the teardown gate rejected the race
    expect(err).toBeInstanceOf(ContentStoreError);
    expect((err as ContentStoreError).code).toBe("aborted");
  });
  test("an abort landing during the dead child's own teardown leaves an HONEST disposal verdict — the dead child, not 'clean'", async () => {
    const holder: { store: UnitContentStore | null } = { store: null };
    const h = makeHarness({
      childOpts: [
        {
          onStdinLine: (_line, fc) => {
            fc.errS.feed("fatal: died before teardown\n");
            fc.exit(128);
          },
          onEnd: (fc) => {
            holder.store?.abort("abort during teardown");
            fc.exit(0);
          },
        },
      ],
    });
    const store = await h.open();
    holder.store = store;
    const err = await store.read("src/a.txt", entryOf(store, "src/a.txt")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as ContentStoreError).code).toBe("aborted");
    const disposal = await store.dispose();
    expect(disposal.clean).toBe(false); // the LAST child that existed died at exit 128
    expect(disposal.detail).toContain("128");
  });
  test("invalid FRAME limits are refused at store OPEN — before any process exists, the enumeration included", async () => {
    const h = makeHarness({ limits: { maxHeaderBytes: 4 } }); // below the parser's floor
    await expect(h.open()).rejects.toThrow(GitFrameError);
    expect(h.counts.lsTree).toBe(0); // the probe runs BEFORE the enumeration capability
    expect(h.launches.length).toBe(0);
    expect(h.permits.acquired).toBe(0);
  });
  test("a protocol fault observed while DRAINING during teardown makes the disposal unclean — never masked by the teardown poison", async () => {
    const h = makeHarness({
      childOpts: [
        {
          onStdinLine: (_line, fc) => fc.serveFrame(OID_A, BODY_A),
          onEnd: (fc) => {
            fc.out.feed("late garbage nobody asked for\n"); // arrives while dispose() drains
            fc.exit(0); // and the child still exits 0 — the fault is the ONLY dirt
          },
        },
      ],
    });
    const store = await h.open();
    await store.read("src/a.txt", entryOf(store, "src/a.txt"));
    const disposal = await store.dispose();
    expect(disposal.clean).toBe(false);
    expect(disposal.detail).toMatch(/framing violation|no request in flight/);
  });
});

// ---- check 5: byte-level reader fixtures (raw reader output, never UnitResult) ----------------

describe("check 5: byte-level reader fixtures", () => {
  test("M9 symlink: mode-routed to REST, delivers EXACTLY the 2,513 dereferenced bytes — never the 17-byte link payload", async () => {
    const target = "x".repeat(2513); // the dereferenced target's synthesized body (the M9 measurement)
    const h = makeHarness({
      rows: [{ mode: "120000", type: "blob", oid: LINK_OID, size: "17", path: "m9-link" }],
      fallback: async () => target,
    });
    const store = await h.open();
    const text = await store.read("m9-link", entryOf(store, "m9-link"));
    expect(text).toBe(target);
    expect(text!.length).toBe(2513);
    expect(h.launches.length).toBe(0); // the 17-byte link blob is never read canonically
    expect(store.counters.restFallbackReads.symlink).toBe(1);
    await store.dispose();
  });
  test("a BINARY blob survives the frame + hash check byte-exactly; the seam applies the deliberate replacement decode", async () => {
    // a PNG-ish prefix: NULs and high bytes that any transcode would mangle
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0xfe]);
    const oid = gitBlobOid(body, SHA1);
    const h = makeHarness({
      rows: [{ mode: "100644", type: "blob", oid, size: String(body.byteLength), path: "img.png" }],
      childOpts: [{ onStdinLine: (_l, fc) => fc.serveFrame(oid, body) }],
    });
    const store = await h.open();
    const text = await store.read("img.png", entryOf(store, "img.png"));
    // the RATIFIED expectation: the UTF-8-with-replacement decode of the CANONICAL bytes —
    // derived from the standard (seamDecode over the fixture bytes), never from what any
    // incumbent transport happened to deliver
    expect(text).toBe(new TextDecoder("utf-8").decode(body));
    await store.dispose();
  });
  test("a non-UTF-8 blob's seam string equals the canonical replacement decode (the battery's pinned expectation)", async () => {
    const body = new Uint8Array([0x6c, 0x61, 0x74, 0x69, 0x6e, 0x31, 0x3a, 0xe9, 0xe8, 0x0a]); // latin1 bytes, invalid UTF-8
    const oid = gitBlobOid(body, SHA1);
    const h = makeHarness({
      rows: [{ mode: "100644", type: "blob", oid, size: String(body.byteLength), path: "latin1.txt" }],
      childOpts: [{ onStdinLine: (_l, fc) => fc.serveFrame(oid, body) }],
    });
    const store = await h.open();
    const text = await store.read("latin1.txt", entryOf(store, "latin1.txt"));
    expect(text).toBe(new TextDecoder("utf-8").decode(body)); // canonical decode, replacement chars included
    expect(text).toContain("�");
    await store.dispose();
  });
  test("paths containing quote, backslash, TAB, and newline round-trip through the parser and a full read", async () => {
    // the record splits at the FIRST TAB — path bytes may legally contain TAB and LF themselves
    const weird = 'we"ird\\back\tslash\npath.ts';
    const h = makeHarness({
      rows: [{ mode: "100644", type: "blob", oid: OID_A, size: String(BODY_A.byteLength), path: weird }],
    });
    const store = await h.open();
    expect(store.entries().map((e) => e.path)).toEqual([weird]);
    expect(await store.read(weird, entryOf(store, weird))).toBe("hello canonical content\n");
    await store.dispose();
  });
  test("an UNKNOWN mode is fatal at open — never treated as a regular blob", async () => {
    const h = makeHarness({
      rows: [{ mode: "100645", type: "blob", oid: OID_A, size: "5", path: "odd.bin" }],
    });
    await expect(h.open()).rejects.toThrow(GitFrameError);
  });
  test("a record with MISSING mode/fields is fatal at open", async () => {
    const h = makeHarness({
      lsResult: { stdout: enc.encode(`blob ${OID_A} 5\tno-mode.txt\0`) }, // three fields, no mode
    });
    await expect(h.open()).rejects.toThrow(GitFrameError);
  });
});

// ---- two-pool discipline through the REAL client seam (check 7) -------------------------------

// Build the store capabilities from a REAL GithubClient (fake one-shot + interactive seams), so
// the deadlock/fan-out claims hold for the wiring production will use, not for a test double.
function makeClientHarness(opts: {
  concurrency: number;
  interactiveDelayMs?: number;
  spawnResponses?: Array<{ exitCode: number; stdout: string; stderr: string }>;
}) {
  const launchCalls: Array<{ args: readonly string[]; req: LaunchRequest }> = [];
  const interactive: FakeChild[] = [];
  let liveInteractive = 0;
  let maxLiveInteractive = 0;
  const spawnCalls: string[][] = [];
  const spawn: SpawnFn = async (_bin, args) => {
    spawnCalls.push([...args]);
    const next = opts.spawnResponses?.[spawnCalls.length - 1];
    if (next === undefined) throw new Error(`unexpected one-shot spawn: ${args.join(" ")}`);
    return next;
  };
  const launchImpl = (bin: string, args: readonly string[], req: LaunchRequest): LaunchedChild => {
    launchCalls.push({ args, req });
    if (args[0] === "ls-tree") {
      const fc = new FakeChild({});
      fc.out.feed(lsBytes(DEFAULT_ROWS));
      fc.exit(0);
      return fc.child;
    }
    expect(bin.length).toBeGreaterThan(0);
    const fc = new FakeChild({
      onStdinLine: (line, self) => {
        const oid = line.trim();
        const body = oid === OID_A ? BODY_A : oid === OID_B ? BODY_B : null;
        const serve = (): void => {
          if (body === null) self.out.feed(`${oid} missing\n`);
          else self.serveFrame(oid, body);
        };
        if (opts.interactiveDelayMs === undefined) serve();
        else setTimeout(serve, opts.interactiveDelayMs);
      },
    });
    interactive.push(fc);
    liveInteractive++;
    maxLiveInteractive = Math.max(maxLiveInteractive, liveInteractive);
    fc.child.exited.then(() => {
      liveInteractive--;
    });
    return fc.child;
  };
  const client = new GithubClient({
    githubHost: "github.com",
    spawnImpl: spawn,
    launchImpl,
    env: { HOME: "/home/u", PATH: "/bin" },
    binPaths: { gh: "/opt/bin/gh", git: "/opt/bin/git", tar: "/opt/bin/tar" },
    tempRoot: TEST_TMP,
    concurrency: opts.concurrency,
  });
  // the exact capability wiring production's processUnit will use (P4) — built from the REAL
  // client methods, so these tests hold for the wiring, not for a double
  const capsFor = (): ContentStoreCaps => ({
    runLsTree: (cwd) => client.gitBytes(["ls-tree", "-r", "-z", "-l", "--full-tree", "HEAD"], cwd),
    launchBatchChild: (cwd) => client.launchBatchChild(cwd),
    acquireChildPermit: () => client.acquireChildPermit(),
    readViaRestFallback: async (path) => client.fetchFileRaw("o", "r", path, "f".repeat(40)),
  });
  const openStoreAt = (cloneDir: string) =>
    openUnitContentStore(capsFor(), { cwd: cloneDir, format: SHA1, restFallbackBudget: 20, limits: TEST_LIMITS });
  return { client, openStoreAt, launchCalls, interactive, spawnCalls, maxLive: () => maxLiveInteractive };
}

describe("two-pool discipline (check 7, through the real GithubClient seam)", () => {
  const httpRaw = (body: string): string => `HTTP/2.0 200 OK\r\ncontent-type: text/plain\r\n\r\n${body}`;

  test("DEADLOCK: both pools at capacity 1 — a symlink REST fallback completes while a child is LIVE", async () => {
    const cloneDir = join(TEST_TMP, "deadlock-clone");
    mkdirSync(cloneDir, { recursive: true });
    const h = makeClientHarness({
      concurrency: 1,
      spawnResponses: [{ exitCode: 0, stdout: httpRaw("SYMLINK TARGET BYTES"), stderr: "" }],
    });
    const store = await h.openStoreAt(cloneDir);
    // 1. a canonical read spawns the unit-lived child — it now holds the ONLY child permit
    expect(await store.read("src/a.txt", entryOf(store, "src/a.txt"))).toBe("hello canonical content\n");
    const catFile = h.launchCalls.filter((c) => c.args[0] === "cat-file");
    expect(catFile.length).toBe(1);
    expect(h.interactive[0]!.exitSettled).toBe(false); // the child is LIVE right now
    // 2. the symlink fallback needs the ONLY one-shot permit — if the live child held it, this
    //    await would never resolve. Completing IS the deadlock-freedom demonstration.
    expect(await store.read("link.txt", entryOf(store, "link.txt"))).toBe("SYMLINK TARGET BYTES");
    const disposal = await store.dispose();
    expect(disposal.clean).toBe(true);
  }, 10_000);

  test("fan-out bound: child pool 2, four concurrent units → exactly two children live at peak, never more", async () => {
    const dirs = [0, 1, 2, 3].map((i) => {
      const d = join(TEST_TMP, `fanout-${i}`);
      mkdirSync(d, { recursive: true });
      return d;
    });
    const h = makeClientHarness({ concurrency: 2, interactiveDelayMs: 15 });
    await Promise.all(
      dirs.map(async (d) => {
        const store = await h.openStoreAt(d);
        expect(await store.read("src/a.txt", entryOf(store, "src/a.txt"))).toBe("hello canonical content\n");
        const disposal = await store.dispose();
        expect(disposal.clean).toBe(true);
      }),
    );
    const catFileLaunches = h.launchCalls.filter((c) => c.args[0] === "cat-file");
    expect(catFileLaunches.length).toBe(4); // every unit got its child eventually…
    expect(h.maxLive()).toBe(2); // …but never more than the pool size at once
  }, 10_000);

  test("the interactive child is launched with a stdin pipe and the sanitized git env carrying GIT_NO_REPLACE_OBJECTS=1", async () => {
    const cloneDir = join(TEST_TMP, "env-clone");
    mkdirSync(cloneDir, { recursive: true });
    const h = makeClientHarness({ concurrency: 1 });
    const store = await h.openStoreAt(cloneDir);
    await store.read("src/a.txt", entryOf(store, "src/a.txt"));
    const lsTree = h.launchCalls.find((c) => c.args[0] === "ls-tree")!;
    const catFile = h.launchCalls.find((c) => c.args[0] === "cat-file")!;
    expect(lsTree.req.stdin).toBe("ignore");
    expect(catFile.req.stdin).toBe("pipe");
    expect([...catFile.args]).toEqual(["cat-file", "--batch"]);
    for (const call of [lsTree, catFile]) {
      expect(call.req.env["GIT_NO_REPLACE_OBJECTS"]).toBe("1"); // check 4, asserted at the launch seam
      expect(call.req.env["GIT_TERMINAL_PROMPT"]).toBe("0"); // the sanitized git env, not a raw passthrough
      expect(call.req.cwd).toBe(cloneDir);
    }
    await store.dispose();
  });
});
