// lifecycle.test.ts — §U8.4 (divert opener), §U8.12 (routing equivalence), §U8.13 (runWithTui
// with injected deps: mounts, io, streams, TIMERS), §U8.13a (sealable proxy). Deterministic:
// every impure edge is a scripted fake; the bounded-exit wait runs on injected fake timers.
import { expect, test, describe, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, readFileSync, symlinkSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logLine, setLogSink, setLogTap } from "../log.ts";
import { setProgressSink, hasProgressSink, emitProgress, reportTuiFailure, resetTuiFailure, tuiFailure, type ProgressEvent } from "../progress.ts";
import { ReadOnlyViolation } from "../readOnlyGuard.ts";
import { createTuiStore, type TuiStore } from "./store.ts";
import {
  logPathFor, utcLogStamp, makeDivertPathFor, realDivertIo, makeSealableStderr, runWithTui,
  DIVERT_OPEN_ATTEMPTS, type DivertIo, type TuiDeps,
} from "./lifecycle.ts";
import type { TuiHandle, MountableStore, MountTuiOptions } from "./mount.tsx";

const SHOW_CURSOR = "\u001B[?25h";

afterEach(() => {
  // §U8 hygiene: module-global seams must never leak across the suite
  setLogSink(null);
  setLogTap(null);
  setProgressSink(null);
  resetTuiFailure();
});

// ---- fakes -----------------------------------------------------------------------------------
class FakeStream extends EventEmitter {
  writes: string[] = [];
  isTTY = true;
  columns = 100;
  rows = 30;
  throwOnWrite: Error | null = null;
  write = (chunk: unknown, encodingOrCb?: unknown, maybeCb?: unknown): boolean => {
    const cb = typeof encodingOrCb === "function" ? (encodingOrCb as (e?: Error | null) => void) : typeof maybeCb === "function" ? (maybeCb as (e?: Error | null) => void) : undefined;
    if (this.throwOnWrite !== null) throw this.throwOnWrite;
    this.writes.push(String(chunk));
    cb?.();
    return true;
  };
  all(): string {
    return this.writes.join("");
  }
}

interface FakeHandle extends TuiHandle {
  calls: string[];
  resolveExit: () => void;
}
function makeFakeHandle(opts: { exitMode?: "immediate" | "manual" | "never"; onDispose?: () => void; onUnmount?: () => void } = {}): FakeHandle {
  const calls: string[] = [];
  let resolveExit: () => void = () => {};
  const exitPromise = new Promise<void>((r) => {
    resolveExit = r;
  });
  if ((opts.exitMode ?? "immediate") === "immediate") resolveExit();
  return {
    calls,
    resolveExit,
    requestUnmount(): void {
      calls.push("requestUnmount");
      opts.onUnmount?.();
      if (opts.exitMode === "manual") resolveExit();
    },
    waitUntilExit(): Promise<void> {
      calls.push("waitUntilExit");
      return exitPromise;
    },
    dispose(): void {
      calls.push("dispose");
      opts.onDispose?.();
    },
  };
}

interface MountCapture {
  store: MountableStore | null;
  opts: MountTuiOptions | null;
}
function makeFakeMount(handle: TuiHandle, capture: MountCapture, hooks: { beforeReturn?: (opts: MountTuiOptions) => void } = {}) {
  return async () => ({
    mountTui: (store: MountableStore, opts: MountTuiOptions): TuiHandle => {
      capture.store = store;
      capture.opts = opts;
      hooks.beforeReturn?.(opts);
      return handle;
    },
  });
}

interface FakeIo extends DivertIo {
  opened: string[];
  written: Array<{ fd: number; line: string }>;
  closed: number[];
}
function makeFakeIo(script: { openErrors?: Array<Error | null>; writeError?: (call: number) => Error | null; closeError?: Error | null } = {}): FakeIo {
  const opened: string[] = [];
  const written: Array<{ fd: number; line: string }> = [];
  const closed: number[] = [];
  let writeCalls = 0;
  return {
    opened,
    written,
    closed,
    open(path: string): number {
      const idx = opened.length;
      opened.push(path);
      const err = script.openErrors?.[idx] ?? null;
      if (err !== null && err !== undefined) throw err;
      return 100 + idx;
    },
    write(fd: number, line: string): void {
      const err = script.writeError?.(writeCalls++) ?? null;
      if (err !== null) throw err;
      written.push({ fd, line });
    },
    close(fd: number): void {
      if (script.closeError) throw script.closeError;
      closed.push(fd);
    },
  };
}

interface FakeTimers {
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  pending: Array<{ id: number; fn: () => void }>;
  cleared: number[];
  fireAll(): void;
}
function makeFakeTimers(): FakeTimers {
  const pending: Array<{ id: number; fn: () => void }> = [];
  const cleared: number[] = [];
  let nextId = 1;
  return {
    pending,
    cleared,
    timers: {
      setTimeout: ((fn: () => void) => {
        const id = nextId++;
        pending.push({ id, fn });
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: ((id: unknown) => {
        cleared.push(id as number);
        const i = pending.findIndex((p) => p.id === (id as number));
        if (i >= 0) pending.splice(i, 1);
      }) as typeof clearTimeout,
    },
    fireAll(): void {
      for (const p of pending.splice(0)) p.fn();
    },
  };
}

function spyStdout(fn: () => void | Promise<void>): { calls: string[]; done: Promise<void> } {
  const calls: string[] = [];
  const so = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
    calls.push(String(c));
    return true;
  }) as typeof process.stdout.write);
  const done = Promise.resolve()
    .then(() => fn())
    .finally(() => so.mockRestore());
  return { calls, done };
}

const codeErr = (code: string, msg = code): Error => Object.assign(new Error(msg), { code });

const until = async (cond: () => boolean, ms = 2000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
};

const makeStore = (): TuiStore => createTuiStore(() => 1_000);

// deps builder: everything faked; individual tests override
function makeDeps(over: Partial<TuiDeps> & { divert?: boolean } = {}): { deps: TuiDeps; stderr: FakeStream; io: FakeIo; timers: FakeTimers; capture: MountCapture; handle: FakeHandle } {
  const stderr = new FakeStream();
  const io = makeFakeIo();
  const timers = makeFakeTimers();
  const capture: MountCapture = { store: null, opts: null };
  const handle = makeFakeHandle();
  const deps: TuiDeps = {
    decision: { mode: "on", divert: over.divert ?? false },
    mountImpl: makeFakeMount(handle, capture),
    divertIo: io,
    logPathFor: (attempt) => `/fake/logs/audit-log-STAMP-p1${attempt === 0 ? "" : `-${attempt + 1}`}.jsonl`,
    timers: timers.timers,
    streams: { stderr: stderr as unknown as NodeJS.WriteStream },
    nowMs: () => 1_000,
    storeImpl: () => makeStore(),
    ...over,
  };
  return { deps, stderr, io, timers, capture, handle };
}

// ---- §U8.4 divert opener ---------------------------------------------------------------------
describe("divert opener (§U8.4)", () => {
  test("logPathFor grammar: base name for attempt 0, -2/-3… suffixes for retries", () => {
    expect(logPathFor("/out", "20260718T211530Z", 4242, 0)).toBe("/out/logs/audit-log-20260718T211530Z-p4242.jsonl");
    expect(logPathFor("/out", "20260718T211530Z", 4242, 1)).toBe("/out/logs/audit-log-20260718T211530Z-p4242-2.jsonl");
    expect(logPathFor("/out", "20260718T211530Z", 4242, 9)).toBe("/out/logs/audit-log-20260718T211530Z-p4242-10.jsonl");
  });

  test("utcLogStamp: compact UTC, no separators, second precision", () => {
    expect(utcLogStamp(new Date("2026-07-18T21:15:30.123Z"))).toBe("20260718T211530Z");
    expect(utcLogStamp(new Date("2026-01-02T03:04:05.000Z"))).toBe("20260102T030405Z");
  });

  test("EEXIST retries select the suffixed candidate; the ACTUAL path reaches the divert event and exit line", async () => {
    const { deps, stderr, capture } = makeDeps({ divert: true });
    const scripted = makeFakeIo({ openErrors: [codeErr("EEXIST"), codeErr("EEXIST"), null] });
    deps.divertIo = scripted;
    const divertEvents: string[] = [];
    deps.storeImpl = () => {
      const s = makeStore();
      const orig = s.dispatch.bind(s);
      s.dispatch = (e) => {
        if (e.type === "divert") divertEvents.push(e.path);
        orig(e);
      };
      return s;
    };
    await runWithTui(deps, async () => {});
    expect(scripted.opened.length).toBe(3);
    const actual = "/fake/logs/audit-log-STAMP-p1-3.jsonl"; // the THIRD candidate (attempt 2)
    expect(scripted.opened[2]).toBe(actual);
    expect(divertEvents).toEqual([actual]); // the footer sees the ACTUAL suffixed path
    expect(stderr.all()).toContain(`JSONL log: ${actual}`); // so does the exit line
    void capture;
  });

  test("bounded exhaustion (all EEXIST) degrades — body still runs bare with JSONL on stdout, never fatal", async () => {
    const scripted = makeFakeIo({ openErrors: Array.from({ length: DIVERT_OPEN_ATTEMPTS }, () => codeErr("EEXIST")) });
    const { deps, stderr, handle } = makeDeps({ divert: true });
    deps.divertIo = scripted;
    let bodyRan = false;
    const { calls, done } = spyStdout(async () => {
      await runWithTui(deps, async () => {
        bodyRan = true;
        logLine({ event: "done" });
      });
    });
    await done;
    expect(bodyRan).toBe(true);
    expect(scripted.opened.length).toBe(DIVERT_OPEN_ATTEMPTS);
    expect(calls).toContain(`{"event":"done"}\n`); // JSONL on stdout, not lost
    expect(stderr.all()).toContain("dashboard disabled"); // warned once
    expect(handle.calls).toContain("requestUnmount"); // the just-mounted dashboard was torn down
  });

  test("a non-EEXIST open failure degrades immediately without exhausting the attempts", async () => {
    const scripted = makeFakeIo({ openErrors: [codeErr("EACCES", "permission denied")] });
    const { deps, stderr } = makeDeps({ divert: true });
    deps.divertIo = scripted;
    const { done } = spyStdout(async () => {
      await runWithTui(deps, async () => {});
    });
    await done;
    expect(scripted.opened.length).toBe(1); // no pointless retries of a non-collision failure
    expect(stderr.all()).toContain("permission denied");
  });

  test("realDivertIo.write delivers whole lines through short writes and rejects a <=0 count", () => {
    // exercised against a REAL fd so the loop's writeSync contract stays honest
    const dir = mkdtempSync(join(tmpdir(), "tui-divert-"));
    try {
      const path = join(dir, "log.jsonl");
      const fd = realDivertIo.open(path);
      realDivertIo.write(fd, '{"event":"a"}\n');
      realDivertIo.write(fd, '{"event":"b"}\n');
      realDivertIo.close(fd);
      expect(readFileSync(path, "utf8")).toBe('{"event":"a"}\n{"event":"b"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("realDivertIo.open creates the logs dir and refuses to clobber (wx: EEXIST on collision)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-divert-"));
    try {
      const path = join(dir, "logs", "x.jsonl"); // logs/ does not exist yet
      const fd = realDivertIo.open(path);
      realDivertIo.close(fd);
      expect(() => realDivertIo.open(path)).toThrow(); // exclusive create
      try {
        realDivertIo.open(path);
      } catch (e) {
        expect((e as { code?: string }).code).toBe("EEXIST");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("makeDivertPathFor returns the CANONICAL contained path and rejects traversal/symlink escapes", () => {
    const root = mkdtempSync(join(tmpdir(), "tui-contain-"));
    try {
      const outDir = join(root, "out");
      mkdirSync(outDir, { recursive: true });
      const ok = makeDivertPathFor(outDir, "20260718T000000Z", 7)(0);
      // CANONICAL: symlinked parents (macOS /var → /private/var) resolve — the opened path is
      // the one that actually passed containment, not the lexical join
      expect(ok).toBe(join(realpathSync(outDir), "logs", "audit-log-20260718T000000Z-p7.jsonl"));
      // a symlinked logs dir pointing OUTSIDE the outputDir is followed and rejected — the
      // classic symlink+containment escape assertContained exists to close
      const evil = join(root, "elsewhere");
      mkdirSync(evil, { recursive: true });
      symlinkSync(evil, join(outDir, "logs"));
      expect(() => makeDivertPathFor(outDir, "S", 7)(0)).toThrow(ReadOnlyViolation);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a containment failure inside the open loop degrades (open failure), never fatal", async () => {
    const { deps, stderr } = makeDeps({ divert: true });
    deps.logPathFor = () => {
      throw new ReadOnlyViolation("READ-ONLY VIOLATION: escape");
    };
    let bodyRan = false;
    const { done } = spyStdout(async () => {
      await runWithTui(deps, async () => {
        bodyRan = true;
      });
    });
    await done;
    expect(bodyRan).toBe(true);
    expect(stderr.all()).toContain("dashboard disabled");
  });

  test("close failure at teardown warns, nothing more", async () => {
    const scripted = makeFakeIo({ closeError: codeErr("EBADF", "bad fd") });
    const { deps, stderr } = makeDeps({ divert: true });
    deps.divertIo = scripted;
    await runWithTui(deps, async () => {});
    expect(stderr.all()).toContain("teardown warnings");
    expect(stderr.all()).toContain("bad fd");
    expect(stderr.all()).toContain("JSONL log: "); // the exit line still printed
  });
});

// ---- §U8.13a sealable proxy ------------------------------------------------------------------
describe("sealable stderr proxy (§U8.13a)", () => {
  test("transparent delegation: isTTY/columns/rows and resize listeners reach the real stream, live AND sealed", () => {
    const real = new FakeStream();
    const proxy = makeSealableStderr(real as unknown as NodeJS.WriteStream, () => {});
    const s = proxy.stream as unknown as FakeStream;
    expect(s.isTTY).toBe(true);
    expect(s.columns).toBe(100);
    expect(s.rows).toBe(30);
    let resizes = 0;
    s.on("resize", () => resizes++);
    real.emit("resize");
    expect(resizes).toBe(1); // registered on the REAL stream
    proxy.seal();
    expect(s.isTTY).toBe(true); // delegated properties keep answering after seal
    expect(s.columns).toBe(100);
    real.emit("resize");
    expect(resizes).toBe(2);
    real.columns = 55;
    expect(s.columns).toBe(55); // live value, not a snapshot
    proxy.detach();
  });

  test("live writes pass through; sealed writes are counted-and-dropped with callbacks still acknowledged", () => {
    const real = new FakeStream();
    const proxy = makeSealableStderr(real as unknown as NodeJS.WriteStream, () => {});
    const s = proxy.stream as unknown as { write: (c: string, cb?: () => void) => boolean };
    s.write("frame-1");
    expect(real.all()).toBe("frame-1");
    proxy.seal();
    let acked = 0;
    expect(s.write("frame-2", () => acked++)).toBe(true);
    s.write("frame-3");
    expect(real.all()).toBe("frame-1"); // nothing reached the real stream
    expect(proxy.sealedDrops).toBe(2);
    expect(acked).toBe(1); // Ink's flush-sync callback must complete or waitUntilExit hangs
  });

  test("absorbing: a synchronous write throw is consumed, latched via the failure channel, callback acknowledged", () => {
    const real = new FakeStream();
    real.throwOnWrite = new Error("EIO");
    const causes: string[] = [];
    const proxy = makeSealableStderr(real as unknown as NodeJS.WriteStream, (c) => causes.push(c));
    const s = proxy.stream as unknown as { write: (c: string, cb?: () => void) => boolean };
    let acked = 0;
    expect(() => s.write("frame", () => acked++)).not.toThrow(); // nothing escapes into Ink/React
    expect(acked).toBe(1);
    expect(causes.length).toBe(1);
    expect(causes[0]).toContain("EIO");
    proxy.detach();
  });

  test("absorbing: a write-callback error is consumed and Ink's own callback still completes without it", () => {
    const real = new FakeStream();
    // a real stream reporting failure via the callback
    real.write = ((c: unknown, cb?: (e?: Error | null) => void): boolean => {
      cb?.(new Error("backpressure fail"));
      return true;
    }) as FakeStream["write"];
    const causes: string[] = [];
    const proxy = makeSealableStderr(real as unknown as NodeJS.WriteStream, (c) => causes.push(c));
    const s = proxy.stream as unknown as { write: (c: string, cb?: (e?: Error | null) => void) => boolean };
    const seen: Array<Error | null | undefined> = [];
    s.write("frame", (e) => seen.push(e));
    expect(seen).toEqual([undefined]); // acknowledged COMPLETE — the error never reaches Ink
    expect(causes[0]).toContain("backpressure fail");
    proxy.detach();
  });

  test("absorbing: a stream 'error' event is consumed (latched, no crash)", () => {
    const real = new FakeStream();
    const causes: string[] = [];
    const proxy = makeSealableStderr(real as unknown as NodeJS.WriteStream, (c) => causes.push(c));
    expect(() => real.emit("error", new Error("stream died"))).not.toThrow(); // absorbed by our listener
    expect(causes[0]).toContain("stream died");
    proxy.detach();
    // after detach the absorber is gone (the emitter would now throw on an unhandled 'error')
    expect(real.listenerCount("error")).toBe(0);
  });

  test("seal is idempotent; sealEarly seals AND writes the cursor-show escape ONCE to the real stream", () => {
    const real = new FakeStream();
    const proxy = makeSealableStderr(real as unknown as NodeJS.WriteStream, () => {});
    proxy.sealEarly();
    expect(proxy.sealed).toBe(true);
    expect(proxy.cursorCompensated).toBe(true);
    expect(real.all()).toBe(SHOW_CURSOR); // compensation in the SAME synchronous step
    proxy.sealEarly(); // idempotent: no second escape
    proxy.seal();
    expect(real.all()).toBe(SHOW_CURSOR);
    proxy.detach();
  });

  test("plain seal() does NOT write the cursor escape (unmount already restored it)", () => {
    const real = new FakeStream();
    const proxy = makeSealableStderr(real as unknown as NodeJS.WriteStream, () => {});
    proxy.seal();
    expect(proxy.cursorCompensated).toBe(false);
    expect(real.all()).toBe("");
    proxy.detach();
  });
});

// ---- §U8.13 lifecycle ------------------------------------------------------------------------
describe("runWithTui lifecycle (§U8.13)", () => {
  test("decision off is a pure passthrough: no proxy, no seams, body result returned", async () => {
    const { deps, stderr } = makeDeps();
    deps.decision = { mode: "off" };
    const { calls, done } = spyStdout(async () => {
      const r = await runWithTui(deps, async () => {
        logLine({ event: "done" });
        return 42;
      });
      expect(r).toBe(42);
    });
    await done;
    expect(calls).toEqual([`{"event":"done"}\n`]);
    expect(stderr.writes).toEqual([]);
    expect(hasProgressSink()).toBe(false);
  });

  test("clean mounted run: sink+tap installed, teardown ordering, THEN return (§U6 sequence)", async () => {
    const order: string[] = [];
    const handle = makeFakeHandle({ exitMode: "manual" });
    const origDispose = handle.dispose.bind(handle);
    handle.dispose = () => {
      order.push("dispose");
      origDispose();
    };
    const origUnmount = handle.requestUnmount.bind(handle);
    handle.requestUnmount = () => {
      order.push("unmount");
      origUnmount();
    };
    const capture: MountCapture = { store: null, opts: null };
    const io = makeFakeIo();
    const scriptedIo: DivertIo = {
      open: (p) => io.open(p),
      write: (fd, line) => io.write(fd, line),
      close: (fd) => {
        order.push("close");
        io.close(fd);
      },
    };
    const { deps, stderr } = makeDeps({ divert: true });
    deps.mountImpl = makeFakeMount(handle, capture);
    deps.divertIo = scriptedIo;
    const { calls, done } = spyStdout(async () => {
      await runWithTui(deps, async () => {
        expect(hasProgressSink()).toBe(true); // guarded sink installed
        logLine({ event: "unit", action: "scanned" }); // → divert file, tapped into the store
        emitProgress({ type: "phase", phase: "scan" });
        order.push("body");
      });
      order.push("returned");
    });
    await done;
    expect(calls).toEqual([]); // NOTHING on stdout in the diverted run
    expect(io.written.map((w) => w.line)).toEqual([`{"event":"unit","action":"scanned"}\n`]);
    expect(order).toEqual(["body", "dispose", "unmount", "close", "returned"]);
    expect(stderr.all()).toContain("JSONL log: "); // complete-file wording
    expect(stderr.all()).not.toContain("partial");
    expect(hasProgressSink()).toBe(false); // seams cleared
    expect(tuiFailure()).toBeNull(); // no warning in a clean run
    expect(stderr.all()).not.toContain("dashboard disabled");
  });

  test("mount failure (import rejects): body still runs, JSONL on stdout, ONE warning", async () => {
    const { deps, stderr } = makeDeps();
    deps.mountImpl = async () => {
      throw new Error("ink is broken");
    };
    let bodyRan = false;
    const { calls, done } = spyStdout(async () => {
      await runWithTui(deps, async () => {
        bodyRan = true;
        logLine({ event: "done" });
        expect(hasProgressSink()).toBe(false); // nothing installed after a mount failure
      });
    });
    await done;
    expect(bodyRan).toBe(true);
    expect(calls).toContain(`{"event":"done"}\n`);
    const warnings = stderr.writes.filter((w) => w.includes("dashboard disabled"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("ink is broken");
  });

  test("mountTui throwing synchronously is the same mount-failure path", async () => {
    const { deps, stderr } = makeDeps();
    deps.mountImpl = async () => ({
      mountTui: () => {
        throw new Error("render exploded");
      },
    });
    let bodyRan = false;
    await runWithTui(deps, async () => {
      bodyRan = true;
    });
    expect(bodyRan).toBe(true);
    expect(stderr.all()).toContain("render exploded");
  });

  test("divert open failure: teardown AWAITED before the body proceeds (no live-frame/stdout overlap)", async () => {
    const scripted = makeFakeIo({ openErrors: [codeErr("EACCES", "nope")] });
    const order: string[] = [];
    const handle = makeFakeHandle({ exitMode: "manual", onUnmount: () => order.push("unmount") });
    const capture: MountCapture = { store: null, opts: null };
    const { deps } = makeDeps({ divert: true });
    deps.divertIo = scripted;
    deps.mountImpl = makeFakeMount(handle, capture);
    const { done } = spyStdout(async () => {
      await runWithTui(deps, async () => {
        order.push("body");
      });
    });
    await done;
    expect(order).toEqual(["unmount", "body"]); // the frame came down BEFORE the body started
  });

  test("divert write failure mid-body: seal-before-re-emit, no loss, immediate teardown, partial wording, cursor escape", async () => {
    const scripted = makeFakeIo({ writeError: (call) => (call === 1 ? codeErr("ENOSPC", "disk full") : null) });
    const handle = makeFakeHandle({ exitMode: "manual" });
    const capture: MountCapture = { store: null, opts: null };
    const { deps, stderr } = makeDeps({ divert: true });
    deps.divertIo = scripted;
    deps.mountImpl = makeFakeMount(handle, capture);
    const { calls, done } = spyStdout(async () => {
      await runWithTui(deps, async () => {
        logLine({ event: "unit", action: "a" }); // write 0: lands in the file
        const framesBefore = stderr.writes.length;
        logLine({ event: "unit", action: "b" }); // write 1: ENOSPC → the whole transition
        // the transition was SYNCHRONOUS within that logLine call:
        expect(hasProgressSink()).toBe(true); // progress sink untouched by a DIVERT failure
        // ... the proxy sealed BEFORE the re-emit — a frame write after the failure is dropped:
        capture.opts!.out.write("late-frame");
        expect(stderr.writes.length).toBe(framesBefore + 1); // ONLY the cursor escape landed
        expect(stderr.writes[framesBefore]).toBe(SHOW_CURSOR); // sealEarly compensation
        expect(handle.calls).toContain("requestUnmount"); // teardown started immediately
        logLine({ event: "unit", action: "c" }); // post-failure events flow to stdout
      });
    });
    await done;
    // no event lost: a→file, b→stdout (re-emitted), c→stdout
    expect(scripted.written.map((w) => w.line)).toEqual([`{"event":"unit","action":"a"}\n`]);
    expect(calls).toEqual([`{"event":"unit","action":"b"}\n`, `{"event":"unit","action":"c"}\n`]);
    const exitLine = stderr.writes.find((w) => w.includes("JSONL log"));
    expect(exitLine).toContain("partial — divert failed mid-run");
    expect(exitLine).toContain("/fake/logs/audit-log-STAMP-p1.jsonl"); // the ACTUAL path
    expect(stderr.all()).toContain("dashboard disabled — "); // the ONE latched warning
    expect(stderr.all()).toContain("disk full");
  });

  test("a NON-divert degrade mid-body (throwing store.dispatch) clears the sink synchronously and yields the closed-early partial wording", async () => {
    const handle = makeFakeHandle({ exitMode: "manual" });
    const capture: MountCapture = { store: null, opts: null };
    const { deps, stderr } = makeDeps({ divert: true });
    deps.mountImpl = makeFakeMount(handle, capture);
    let dispatches = 0;
    deps.storeImpl = () => {
      const s = makeStore();
      return {
        get version() {
          return s.version;
        },
        snapshot: () => s.snapshot(),
        dispatch(e: ProgressEvent): void {
          dispatches++;
          if (e.type === "phase") throw new Error("fold bug");
          s.dispatch(e);
        },
      };
    };
    const { done } = spyStdout(async () => {
      await runWithTui(deps, async () => {
        emitProgress({ type: "phase", phase: "scan" }); // → dispatch throws
        expect(hasProgressSink()).toBe(false); // cleared SYNCHRONOUSLY in the guarded closure
        emitProgress({ type: "phase", phase: "report" }); // no-op: zero further dispatches
        expect(handle.calls).toContain("requestUnmount"); // degraded immediately, no tick involved
      });
    });
    await done;
    expect(dispatches).toBe(2); // the divert event + the throwing phase — nothing after the clear
    expect(tuiFailure()?.firstCause).toBe("fold bug");
    expect(tuiFailure()?.divertFailedMidRun).toBe(false); // NOT a divert failure…
    const exitLine = stderr.writes.find((w) => w.includes("JSONL log"));
    expect(exitLine).toContain("partial — dashboard ended mid-run"); // …but the file is still partial
  });

  test("bounded-exit timeout is DETERMINISTIC via injected timers; the sealed proxy drops and COUNTS a wedged mount's late writes into the warning", async () => {
    const handle = makeFakeHandle({ exitMode: "never" }); // waitUntilExit NEVER settles (wedged Ink)
    const capture: MountCapture = { store: null, opts: null };
    const { deps, stderr, timers } = makeDeps({ divert: true });
    // a "late Ink write" arriving DURING teardown (after the seal, before the warning): the
    // close step stands in for it — anything through the proxy at that point must be dropped
    // and COUNTED into the step-6 warning.
    deps.divertIo = {
      open: () => 7,
      write: () => {},
      close: () => {
        capture.opts!.out.write("late-frame-during-teardown");
      },
    };
    deps.mountImpl = makeFakeMount(handle, capture);
    let resolved = false;
    const p = runWithTui(deps, async () => {
      reportTuiFailure("wedged ink"); // latch a cause so the step-6 warning prints
    }).then(() => {
      resolved = true;
    });
    // teardown is now waiting on waitUntilExit, which never settles — ONLY the injected timer
    // can free it, making the timeout path fully deterministic
    await until(() => timers.pending.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false); // provably blocked on the injected timer
    timers.fireAll();
    await until(() => resolved);
    await p;
    expect(stderr.all()).not.toContain("late-frame-during-teardown"); // sealed off, never reached the stream
    expect(stderr.all()).toContain("dashboard disabled — wedged ink (1 suppressed frame write)"); // …and counted
  });

  test("exit wait clears the loser timer when the unmount settles first", async () => {
    const handle = makeFakeHandle({ exitMode: "manual" });
    const capture: MountCapture = { store: null, opts: null };
    const { deps, timers } = makeDeps();
    deps.mountImpl = makeFakeMount(handle, capture);
    await runWithTui(deps, async () => {});
    expect(timers.cleared.length).toBeGreaterThanOrEqual(1); // the loser timer was cleared
    expect(timers.pending.length).toBe(0); // nothing leaked
  });

  test("teardown re-entry: a SYNCHRONOUSLY-reentrant handle (dispose/unmount call degradeNow) runs the sequence ONCE", async () => {
    let degradeRef: (() => void) | null = null;
    const handle = makeFakeHandle({
      exitMode: "manual",
      onDispose: () => degradeRef?.(),
      onUnmount: () => degradeRef?.(),
    });
    const capture: MountCapture = { store: null, opts: null };
    const { deps } = makeDeps({ divert: true });
    const io = deps.divertIo as FakeIo;
    deps.mountImpl = makeFakeMount(handle, capture, {
      beforeReturn: (opts) => {
        degradeRef = opts.onDegrade; // the fake handle re-enters teardown from INSIDE its steps
      },
    });
    const { done } = spyStdout(async () => {
      await runWithTui(deps, async () => {});
    });
    await done;
    expect(handle.calls.filter((c) => c === "dispose").length).toBe(1);
    expect(handle.calls.filter((c) => c === "requestUnmount").length).toBe(1);
    expect(io.closed.length).toBe(1); // the fd closed exactly once
  });

  test("mount-time degrade before the handle exists: null-handle teardown + FULL unwind of the late handle, nothing installed", async () => {
    const handle = makeFakeHandle({ exitMode: "manual" });
    const capture: MountCapture = { store: null, opts: null };
    const { deps } = makeDeps({ divert: true });
    const io = deps.divertIo as FakeIo;
    deps.mountImpl = makeFakeMount(handle, capture, {
      beforeReturn: (opts) => {
        opts.onDegrade(); // an error boundary firing before mountTui returns its handle
      },
    });
    const seen = { sinkDuringBody: null as boolean | null };
    const { calls, done } = spyStdout(async () => {
      await runWithTui(deps, async () => {
        seen.sinkDuringBody = hasProgressSink();
        logLine({ event: "done" });
      });
    });
    await done;
    expect(seen.sinkDuringBody).toBe(false); // no sink/tap ever installed into the dead lifecycle
    expect(io.opened.length).toBe(0); // the divert was never opened
    expect(calls).toContain(`{"event":"done"}\n`); // JSONL stayed on stdout
    // the LATE-ARRIVING handle was fully unwound: dispose AND requestUnmount (+ bounded wait)
    expect(handle.calls).toContain("dispose");
    expect(handle.calls).toContain("requestUnmount");
  });

  test("setup-final state check: a synchronous setup-time degrade (divert event trips a throwing sink) means body() starts only after the awaited teardown", async () => {
    const order: string[] = [];
    const handle = makeFakeHandle({ exitMode: "manual", onUnmount: () => order.push("unmount") });
    const capture: MountCapture = { store: null, opts: null };
    const { deps } = makeDeps({ divert: true });
    deps.mountImpl = makeFakeMount(handle, capture);
    deps.storeImpl = () => {
      const s = makeStore();
      s.dispatch = (e: ProgressEvent): void => {
        if (e.type === "divert") throw new Error("setup-time fold bug"); // trips DURING setup
      };
      return s;
    };
    const { done } = spyStdout(async () => {
      await runWithTui(deps, async () => {
        order.push("body");
      });
    });
    await done;
    expect(order).toEqual(["unmount", "body"]); // never mid-collapse: teardown finished first
    expect(tuiFailure()?.firstCause).toBe("setup-time fold bug");
  });

  test("a throwing teardown step defers to a warning and never masks a propagating body error", async () => {
    const handle = makeFakeHandle({ exitMode: "manual" });
    handle.dispose = () => {
      handle.calls.push("dispose");
      throw new Error("dispose exploded");
    };
    const capture: MountCapture = { store: null, opts: null };
    const { deps, stderr } = makeDeps();
    deps.mountImpl = makeFakeMount(handle, capture);
    await expect(
      runWithTui(deps, async () => {
        throw new Error("payload error");
      }),
    ).rejects.toThrow("payload error"); // the body error survives teardown
    expect(stderr.all()).toContain("teardown warnings");
    expect(stderr.all()).toContain("dispose exploded");
  });

  test("latch reset at lifecycle start: a stale pre-existing latch does not poison a fresh run", async () => {
    reportTuiFailure("stale from a previous lifecycle");
    const { deps, stderr } = makeDeps();
    let latchDuringBody: unknown = "unset";
    await runWithTui(deps, async () => {
      latchDuringBody = tuiFailure();
    });
    expect(latchDuringBody).toBeNull();
    expect(stderr.all()).not.toContain("stale from a previous lifecycle");
  });

  test("undiverted mounted run: stdout receives ONLY JSONL; the frame goes to the (fake) stderr", async () => {
    const { deps } = makeDeps({ divert: false });
    const { calls, done } = spyStdout(async () => {
      await runWithTui(deps, async () => {
        logLine({ event: "config" });
        logLine({ event: "done" });
      });
    });
    await done;
    expect(calls).toEqual([`{"event":"config"}\n`, `{"event":"done"}\n`]);
  });
});

// ---- §U8.12 routing equivalence --------------------------------------------------------------
describe("routing equivalence (§U8.12)", () => {
  // Two full live runs can never byte-match (randomUUID run ids, wall-clock timestamps) — so
  // replay ONE fixture event sequence through logLine under both sinks and compare the bytes.
  const FIXTURE: Array<Record<string, unknown>> = [
    { event: "config", packages: ["expo"], cutoffDate: "2024-01-01" },
    { event: "concurrency", organizations: 2, branches: 4, repositories: 6 },
    { event: "preflight", login: "u", coreRemaining: 4999 },
    { event: "unit", org: "o", repo: "r", branch: "main", commit: "c", action: "scanned", deps: 3, usage: 9, cli: 1 },
    { event: "warning", reason: "clone-cleanup-failed", target: "/tmp/x", message: "EBUSY: [31mhostile[0m\nline2" },
    { event: "done", runId: "fixed-run-id", errors: 0 },
  ];

  test("the stdout sink and a REAL divert fd receive byte-identical streams", () => {
    const stdoutBytes: string[] = [];
    const so = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
      stdoutBytes.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    try {
      for (const ev of FIXTURE) logLine(ev);
    } finally {
      so.mockRestore();
    }

    const dir = mkdtempSync(join(tmpdir(), "tui-routing-"));
    try {
      const path = join(dir, "divert.jsonl");
      const fd = realDivertIo.open(path);
      setLogSink((line) => realDivertIo.write(fd, line));
      try {
        for (const ev of FIXTURE) logLine(ev);
      } finally {
        setLogSink(null);
        realDivertIo.close(fd);
      }
      const divertBytes = readFileSync(path, "utf8");
      expect(divertBytes).toBe(stdoutBytes.join("")); // IDENTICAL bytes, different destination
      expect(divertBytes.split("\n").filter(Boolean).length).toBe(FIXTURE.length); // every line parses
      for (const line of divertBytes.split("\n").filter(Boolean)) JSON.parse(line);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a scripted run with the REAL mount against capture streams: stdout gets ONLY JSONL (undiverted) / NOTHING (diverted)", async () => {
    // undiverted
    {
      const stderr = new FakeStream();
      const { calls, done } = spyStdout(async () => {
        await runWithTui(
          {
            decision: { mode: "on", divert: false },
            streams: { stderr: stderr as unknown as NodeJS.WriteStream },
            timers: { setTimeout, clearTimeout },
          },
          async () => {
            for (const ev of FIXTURE) logLine(ev);
            await new Promise((r) => setTimeout(r, 30)); // let the real Ink commit a frame
          },
        );
      });
      await done;
      expect(calls.length).toBe(FIXTURE.length);
      for (const c of calls) JSON.parse(c.slice(0, -1)); // every stdout write is one JSONL line
    }
    // diverted
    {
      const stderr = new FakeStream();
      const io = makeFakeIo();
      const { calls, done } = spyStdout(async () => {
        await runWithTui(
          {
            decision: { mode: "on", divert: true },
            streams: { stderr: stderr as unknown as NodeJS.WriteStream },
            divertIo: io,
            logPathFor: (a) => `/fake/l-${a}.jsonl`,
            timers: { setTimeout, clearTimeout },
          },
          async () => {
            for (const ev of FIXTURE) logLine(ev);
            await new Promise((r) => setTimeout(r, 30));
          },
        );
      });
      await done;
      expect(calls).toEqual([]); // process.stdout received NOTHING
      expect(io.written.length).toBe(FIXTURE.length); // the file got every line
    }
  });
});
