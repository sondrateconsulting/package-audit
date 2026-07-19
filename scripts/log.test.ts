import { expect, test, describe, spyOn } from "bun:test";
import * as fs from "node:fs";
import { logLine, logActivitySeq, flushLogs, loggerStats, setLogSink, resetLogSink, type LogSink } from "./log.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { stripTs } from "./testEvents.test.ts";

// Capture the channel-closed diagnostic the writer emits via writeSync(2, …) (NOT process.stderr,
// so a merged 2>&1 dead pipe can't turn it into an async EPIPE that changes the exit code). Returns
// the fd-2 strings written during fn; other fds pass through untouched.
function captureFd2(fn: () => void): string[] {
  const out: string[] = [];
  const spy = spyOn(fs, "writeSync").mockImplementation(((fd: number, s: unknown) => {
    if (fd === 2) out.push(String(s));
    return 0;
  }) as typeof fs.writeSync);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

// Capture the raw stdout lines logLine writes (NOT ts-stripped — this file pins the ts itself).
function capture(fn: () => void): string[] {
  const chunks: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stdout.write);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("").split("\n").filter((l) => l.length > 0);
}

describe("logLine ts + activity counter (T6)", () => {
  test("stamps every event with an ISO-8601 UTC ts as the FIRST key", () => {
    const [line] = capture(() => logLine({ event: "unit", org: "o" }));
    const obj = JSON.parse(line!) as Record<string, unknown>;
    expect(Object.keys(obj)[0]).toBe("ts"); // first key, so a log tail is scannable by time
    expect(obj["ts"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // ISO-8601 UTC, ms precision
    expect(new Date(obj["ts"] as string).toISOString()).toBe(obj["ts"] as string); // round-trips = a real instant
    expect(obj["event"]).toBe("unit");
    expect(obj["org"]).toBe("o");
  });

  test("a caller-supplied ts is IGNORED — logLine owns it (never forged or duplicated)", () => {
    const [line] = capture(() => logLine({ ts: "1999-01-01T00:00:00.000Z", event: "x" }));
    const obj = JSON.parse(line!) as Record<string, unknown>;
    expect(obj["ts"]).not.toBe("1999-01-01T00:00:00.000Z"); // ours, not theirs
    expect(line!.match(/"ts":/g)).toHaveLength(1); // exactly one ts key — no duplicate
    expect(Object.keys(obj)[0]).toBe("ts"); // still first
    expect(obj["event"]).toBe("x");
  });

  test("preserves every non-ts field (values, nesting, arrays)", () => {
    const [line] = capture(() => logLine({ event: "done", runId: "r", nested: { a: 1 }, arr: [1, 2] }));
    const obj = JSON.parse(line!) as Record<string, unknown>;
    expect(obj["event"]).toBe("done");
    expect(obj["runId"]).toBe("r");
    expect(obj["nested"]).toEqual({ a: 1 });
    expect(obj["arr"]).toEqual([1, 2]);
  });

  test("the activity counter increments exactly once per write", () => {
    const before = logActivitySeq();
    capture(() => {
      logLine({ event: "a" });
      logLine({ event: "b" });
    });
    expect(logActivitySeq()).toBe(before + 2);
  });
});

describe("logLine — one atomic write per event (§6/§8 observability)", () => {
  // Each event MUST be emitted as EXACTLY ONE process.stdout.write of the complete line + trailing
  // newline. There is a SINGLE in-process stdout writer and stream writes are ordered, so two events
  // can never interleave; because the line is assembled BEFORE the write, one write == one whole event
  // (JSON.stringify escapes any interior newline, so the ONLY real newline is the trailing one). This is
  // the pipe-safe contract fan-out relies on — NOT a kernel-level >PIPE_BUF atomicity guarantee, but the
  // guarantee that logLine never splits an event across multiple writes (a split-write mutant fails here).
  function spyWrites(fn: () => void): string[] {
    const calls: string[] = [];
    const so = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
      calls.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    try {
      fn();
    } finally {
      so.mockRestore();
    }
    return calls;
  }

  test("emits exactly ONE write per event — the complete line + a single trailing newline", () => {
    // an event with an interior newline in a string field AND a >64KB (>PIPE_BUF) payload: the interior
    // "\n" must be JSON-escaped (not a real line break) and the large line must still be one write.
    const event = { event: "unit", org: "o", repo: "r", action: "error", message: "line1\nline2", payload: "z".repeat(70_000) };
    const calls = spyWrites(() => logLine(event));
    expect(calls.length).toBe(1); // one write, never split
    const line = calls[0]!;
    expect(line.endsWith("\n")).toBe(true);
    expect((line.match(/\n/g) ?? []).length).toBe(1); // exactly one real newline — interior "\n" is JSON-escaped
    // logLine now prepends its OWNED ts (T6); strip it and every caller field must round-trip verbatim.
    const { ts, ...rest } = JSON.parse(line.slice(0, -1)) as Record<string, unknown>;
    expect(typeof ts).toBe("string");
    expect(rest).toEqual(event); // one line still round-trips to the whole event
  });

  test("a minimal event is still one write ending in one newline", () => {
    const calls = spyWrites(() => logLine({ event: "done" }));
    expect(calls.length).toBe(1);
    const line = calls[0]!;
    expect(line.endsWith("\n")).toBe(true);
    expect((line.match(/\n/g) ?? []).length).toBe(1);
    const obj = JSON.parse(line.slice(0, -1)) as Record<string, unknown>;
    expect(Object.keys(obj)[0]).toBe("ts"); // ts first (T6)
    expect(obj["event"]).toBe("done");
  });
});

// A controllable sink standing in for process.stdout: write() returns `accept`, and a paused sink
// records lines it received (a real stream queues the chunk that triggered backpressure) while the
// writer holds SUBSEQUENT lines. resume() flips accept and fires the stored one-shot drain.
function fakeSink() {
  const received: string[] = [];
  let accept = true;
  let closed = false;
  let drainCb: (() => void) | null = null;
  let closeCb: (() => void) | null = null;
  const sink: LogSink = {
    write: (line) => {
      if (closed) return true;
      received.push(line);
      return accept;
    },
    onDrain: (cb) => {
      drainCb = cb;
    },
    isClosed: () => closed,
    onClose: (cb) => {
      closeCb = cb;
    },
  };
  return {
    sink,
    received,
    pause: () => {
      accept = false;
    },
    resume: () => {
      accept = true;
      const cb = drainCb;
      drainCb = null;
      if (cb) cb();
    },
    close: () => {
      closed = true;
      closeCb?.(); // mimic the sink firing its async close notification (the real 'error' handler)
    },
  };
}
const evName = (line: string): unknown => stripTs(JSON.parse(line) as Record<string, unknown>)["event"];

describe("stdout backpressure writer (T7)", () => {
  test("clear channel writes straight through (no buffering overhead)", () => {
    const f = fakeSink();
    setLogSink(f.sink);
    try {
      logLine({ event: "a" });
      logLine({ event: "b" });
      expect(f.received.map(evName)).toEqual(["a", "b"]);
    } finally {
      resetLogSink();
    }
  });

  test("buffers behind a backpressured sink and flushes on drain, in order", () => {
    const f = fakeSink();
    setLogSink(f.sink);
    try {
      logLine({ event: "a" }); // straight through
      f.pause();
      logLine({ event: "b" }); // reaches the sink, gets backpressure → writer pauses
      logLine({ event: "c" }); // buffered
      logLine({ event: "d" }); // buffered
      expect(f.received.map(evName)).toEqual(["a", "b"]);
      f.resume(); // drain → flush the buffer
      expect(f.received.map(evName)).toEqual(["a", "b", "c", "d"]);
    } finally {
      resetLogSink();
    }
  });

  test("over the bound, sheds only OLDEST droppable telemetry; keeps lifecycle events + order", () => {
    const f = fakeSink();
    setLogSink(f.sink, 2); // tiny buffer bound so the drop path is cheap
    const before = loggerStats().dropped;
    try {
      logLine({ event: "unit" }); // straight through
      f.pause();
      logLine({ event: "sink-full" }); // reaches sink, pauses the writer
      logLine({ event: "retry" }, { droppable: true }); // buffer [retry]
      logLine({ event: "throttle" }, { droppable: true }); // buffer [retry, throttle]
      logLine({ event: "done" }); // buffer full → drop OLDEST droppable (retry); enqueue done
      expect(loggerStats().dropped).toBe(before + 1);
      f.resume();
      const events = f.received.map(evName);
      expect(events).toContain("done"); // lifecycle event kept
      expect(events).toContain("throttle"); // only the OLDEST droppable was shed
      expect(events).not.toContain("retry"); // droppable telemetry shed
    } finally {
      resetLogSink();
    }
  });

  test("flushLogs resolves only after the buffer drains", async () => {
    const f = fakeSink();
    setLogSink(f.sink);
    try {
      logLine({ event: "a" });
      f.pause();
      logLine({ event: "b" }); // sink, pause
      logLine({ event: "c" }); // buffered
      let resolved = false;
      const p = flushLogs().then(() => {
        resolved = true;
      });
      await Promise.resolve(); // let any already-settled microtask run
      expect(resolved).toBe(false); // still buffered
      f.resume(); // drain flushes c and resolves the waiter
      await p;
      expect(resolved).toBe(true);
      expect(f.received.map(evName)).toEqual(["a", "b", "c"]);
    } finally {
      resetLogSink();
    }
  });

  test("flushLogs resolves (does not hang) if the pipe dies while the writer is paused", async () => {
    const f = fakeSink();
    setLogSink(f.sink);
    try {
      logLine({ event: "a" });
      f.pause();
      logLine({ event: "b" }); // reaches sink, pauses the writer
      logLine({ event: "c" }); // buffered, waiting for a drain that will never come
      f.close(); // the consumer went away
      await flushLogs(); // must resolve by abandoning the buffer, not wait forever
      expect(f.received.map(evName)).toEqual(["a", "b"]); // c was abandoned, but we didn't hang
    } finally {
      resetLogSink();
    }
  });

  test("over the bound with NO droppable lines, sheds the OLDEST lifecycle line (strict memory bound)", () => {
    const f = fakeSink();
    setLogSink(f.sink, 2); // tiny buffer bound
    const before = loggerStats().dropped;
    try {
      logLine({ event: "a" }); // straight through
      f.pause();
      logLine({ event: "b" }); // sink, pause
      logLine({ event: "u1" }); // buffer [u1] — all non-droppable lifecycle events
      logLine({ event: "u2" }); // buffer [u1,u2]
      logLine({ event: "u3" }); // buffer full → shed OLDEST (u1) → [u2,u3]
      expect(loggerStats().dropped).toBe(before + 1);
      f.resume();
      const events = f.received.map(evName);
      expect(events).not.toContain("u1"); // oldest lifecycle line shed to stay bounded
      expect(events).toContain("u2");
      expect(events).toContain("u3");
    } finally {
      resetLogSink();
    }
  });

  test("after the pipe dies while paused, further writes are no-ops (bounded, not buffered-then-discarded)", async () => {
    const f = fakeSink();
    setLogSink(f.sink, 5);
    try {
      logLine({ event: "a" });
      f.pause();
      logLine({ event: "b" }); // reaches sink, pauses
      f.close(); // pipe dies WHILE paused (no drain will ever come)
      for (let i = 0; i < 200; i++) logLine({ event: "unit", n: i }); // must NOT accumulate a backlog
      await flushLogs(); // resolves (does not hang), nothing left to lose
      expect(f.received.map(evName)).toEqual(["a", "b"]); // a dead pipe delivers nothing further
    } finally {
      resetLogSink();
    }
  });

  test("flushLogs waits for a paused sink to drain even when the buffer is empty (terminal line not lost)", async () => {
    const f = fakeSink();
    setLogSink(f.sink);
    try {
      logLine({ event: "a" });
      f.pause();
      logLine({ event: "done" }); // reaches the sink, returns false → paused, buffer EMPTY
      let resolved = false;
      const p = flushLogs().then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false); // must NOT resolve while the sink is still backpressured
      f.resume(); // drain
      await p;
      expect(resolved).toBe(true);
      expect(f.received.map(evName)).toEqual(["a", "done"]);
    } finally {
      resetLogSink();
    }
  });

  test("an ASYNC channel death wakes a flushLogs() already awaiting a paused/buffered writer", async () => {
    const f = fakeSink();
    setLogSink(f.sink);
    try {
      logLine({ event: "a" });
      f.pause();
      logLine({ event: "b" }); // sink, pause
      logLine({ event: "c" }); // buffered
      let resolved = false;
      const p = flushLogs().then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false); // waiting on the paused/buffered writer
      f.close(); // async death fires the sink's onClose → wakes the writer (no drain will come)
      await p; // must resolve, not hang
      expect(resolved).toBe(true);
    } finally {
      resetLogSink();
    }
  });

  test("a droppable line drops ITSELF (never evicts a lifecycle event) when the backlog is all lifecycle", () => {
    const f = fakeSink();
    setLogSink(f.sink, 2);
    const before = loggerStats().dropped;
    try {
      logLine({ event: "a" }); // straight through
      f.pause();
      logLine({ event: "b" }); // sink, pause
      logLine({ event: "u1" }); // buffer [u1] (lifecycle)
      logLine({ event: "u2" }); // buffer [u1,u2] full, all lifecycle
      logLine({ event: "hb" }, { droppable: true }); // full + incoming droppable → drops ITSELF, keeps u1/u2
      expect(loggerStats().dropped).toBe(before + 1);
      f.resume();
      const events = f.received.map(evName);
      expect(events).toContain("u1"); // lifecycle preserved (no priority inversion)
      expect(events).toContain("u2");
      expect(events).not.toContain("hb"); // the droppable telemetry self-dropped
    } finally {
      resetLogSink();
    }
  });

  test("a terminal event bypasses the bound — never evicted, admitted over-cap, everything delivered in order", () => {
    const f = fakeSink();
    setLogSink(f.sink, 2);
    const before = loggerStats().dropped;
    try {
      logLine({ event: "a" });
      f.pause();
      logLine({ event: "b" }); // sink, pause
      logLine({ event: "u1" }); // buffer [u1]
      logLine({ event: "u2" }); // buffer [u1,u2] full
      logLine({ event: "done" }, { terminal: true }); // bypasses bound → [u1,u2,done], evicts nothing
      expect(loggerStats().dropped).toBe(before);
      f.resume();
      expect(f.received.map(evName)).toEqual(["a", "b", "u1", "u2", "done"]);
    } finally {
      resetLogSink();
    }
  });

  test("a buffered terminal event is never evicted by later lifecycle lines (explicit invariant, for PR2 mid-run terminals)", () => {
    const f = fakeSink();
    setLogSink(f.sink, 2);
    try {
      logLine({ event: "a" }); // straight through
      f.pause();
      logLine({ event: "b" }); // sink, pause
      logLine({ event: "degraded" }, { terminal: true }); // bypasses bound → buffer [degraded]
      logLine({ event: "u1" }); // buffer [degraded, u1]
      logLine({ event: "u2" }); // full → shed oldest NON-terminal (u1); the terminal is protected
      f.resume();
      const events = f.received.map(evName);
      expect(events).toContain("degraded"); // terminal survived even though it was NOT the last line
      expect(events).not.toContain("u1"); // oldest non-terminal shed instead
      expect(events).toContain("u2");
    } finally {
      resetLogSink();
    }
  });

  // A line can be BOTH droppable and terminal (the two logLine flags are independent). The capacity
  // eviction has two arms; the lifecycle arm already excludes terminals, but the DROPPABLE arm must
  // too — otherwise a buffered droppable-terminal line is shed via the droppable path, breaking the
  // "terminals are never evicted for capacity" invariant. Latent today (no caller sets both). (6a)
  test("a buffered DROPPABLE terminal is never evicted via the droppable arm either", () => {
    const f = fakeSink();
    setLogSink(f.sink, 1);
    try {
      f.pause();
      logLine({ event: "b" }); // sink, writer pauses
      logLine({ event: "done" }, { droppable: true, terminal: true }); // both flags → bypasses the bound → buffer [done]
      logLine({ event: "u1" }); // full → eviction runs; the droppable arm must NOT pick the terminal
      f.resume();
      const events = f.received.map(evName);
      expect(events).toContain("done"); // droppable+terminal survived — terminal protection dominates droppability
      expect(events).toContain("u1"); // the incoming lifecycle line still shipped
    } finally {
      resetLogSink();
    }
  });

  test("a sink with onClose but NO isClosed still un-hangs a pending flushLogs on async close", async () => {
    const received: string[] = [];
    let accept = true;
    const closeRef: { cb: (() => void) | null } = { cb: null };
    const sink: LogSink = { write: (l) => { received.push(l); return accept; }, onDrain: () => {}, onClose: (cb) => { closeRef.cb = cb; } };
    setLogSink(sink);
    try {
      logLine({ event: "a" });
      accept = false;
      logLine({ event: "b" }); // sink, pause
      logLine({ event: "c" }); // buffered
      let resolved = false;
      const p = flushLogs().then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      closeRef.cb?.(); // async death signalled ONLY via onClose (no isClosed)
      await p; // must resolve, not hang
      expect(resolved).toBe(true);
    } finally {
      resetLogSink();
    }
  });

  test("swapping the sink stops a late drain on the old sink from flushing stale BUFFERED lines", () => {
    const f1 = fakeSink();
    setLogSink(f1.sink);
    logLine({ event: "a" }); // straight through
    f1.pause();
    logLine({ event: "b" }); // reaches sink, pauses
    logLine({ event: "stale" }); // BUFFERED on writer 1
    const f2 = fakeSink();
    setLogSink(f2.sink); // disposes writer 1 (buffer cleared, waiters resolved)
    logLine({ event: "new" }); // writer 2
    f1.resume(); // a LATE drain on the OLD sink — must NOT flush the abandoned "stale" line
    expect(f1.received.map(evName)).toEqual(["a", "b"]); // "stale" was abandoned by dispose
    expect(f2.received.map(evName)).toEqual(["new"]);
    resetLogSink();
  });

  test("a sink whose write() synchronously disposes the writer does not arm a drain on the abandoned sink", () => {
    const f2 = fakeSink();
    let swapped = false;
    const selfDisposing: LogSink = {
      write: () => {
        if (!swapped) {
          swapped = true;
          setLogSink(f2.sink); // synchronously dispose THIS writer mid-write, then report backpressure
          return false;
        }
        return true;
      },
      onDrain: () => {
        throw new Error("a disposed writer must not arm a drain on the abandoned sink");
      },
    };
    setLogSink(selfDisposing);
    try {
      // the disposed guard in pushToSink must prevent arming a drain (onDrain throws if reached).
      expect(() => logLine({ event: "x" })).not.toThrow();
    } finally {
      resetLogSink();
    }
  });

  test("a synchronous EPIPE from stdout degrades logging to a no-op (never crashes the run)", () => {
    resetLogSink(); // use the real process.stdout default sink
    const wsSpy = spyOn(fs, "writeSync").mockImplementation((() => 0) as typeof fs.writeSync); // swallow the fd-2 trace
    const spy = spyOn(process.stdout, "write").mockImplementation((() => {
      const e = new Error("write EPIPE") as NodeJS.ErrnoException;
      e.code = "EPIPE";
      throw e;
    }) as typeof process.stdout.write);
    try {
      expect(() => logLine({ event: "x" })).not.toThrow();
      expect(() => logLine({ event: "y" })).not.toThrow(); // stays a no-op after the pipe closed
    } finally {
      spy.mockRestore();
      wsSpy.mockRestore();
      resetLogSink(); // clears the EPIPE flag so later tests get a clean channel
    }
  });

  // Channel death is not EPIPE-only: a destroyed stream throws ERR_STREAM_DESTROYED, a reset pipe
  // ECONNRESET, etc. — all mean the channel is unusable, exactly like the async 'error' listener
  // already assumes. A non-EPIPE SYNC throw must degrade the same way, not crash the run / mask an
  // outer error via a finally-flush. (finding IMPORTANT-3)
  test("a synchronous NON-EPIPE stdout error also degrades to a no-op (channel death is not EPIPE-only)", async () => {
    resetLogSink(); // real process.stdout default sink
    const wsSpy = spyOn(fs, "writeSync").mockImplementation((() => 0) as typeof fs.writeSync); // swallow the fd-2 trace
    const spy = spyOn(process.stdout, "write").mockImplementation((() => {
      // a destroyed stream throws ERR_STREAM_DESTROYED SYNCHRONOUSLY — not code:"EPIPE"
      throw Object.assign(new Error("write after end"), { code: "ERR_STREAM_DESTROYED" });
    }) as typeof process.stdout.write);
    try {
      expect(() => logLine({ event: "x" })).not.toThrow(); // absorbed, not propagated up through logLine
      expect(loggerStats().closed).toBe(true); // channel marked closed, same as EPIPE
      expect(() => logLine({ event: "y" })).not.toThrow(); // stays a no-op afterward
      await expect(flushLogs()).resolves.toBeUndefined(); // the flush waiter still resolves — no hang, no mask
    } finally {
      spy.mockRestore();
      wsSpy.mockRestore();
      resetLogSink();
    }
  });
});

// S1: a dead stdout channel silently discards buffered telemetry — including the terminal `done`
// line — with the process still exiting 0. Without a signal on ANY channel, an operator can't tell
// a clean finish from lost output. The writer degrades to a no-op (correct — EPIPE can deliver
// nothing), but it must LEAVE A TRACE: exactly one best-effort trace via writeSync(2, …) + a
// queryable loggerStats().closed. The trace says telemetry "may be incomplete" (not that `done`
// definitely failed — it may already have shipped before the channel died). writeSync (not
// process.stderr.write) so a merged 2>&1 dead pipe can't turn it into an async EPIPE that exits 1.
describe("stdout channel closure surfaces a diagnostic (S1)", () => {
  test("channel closure exposes loggerStats().closed and emits exactly one stderr trace", () => {
    resetLogSink(); // real default sink, clean channel
    try {
      const warns = captureFd2(() => {
        expect(loggerStats().closed).toBe(false); // healthy channel reports open
        // The REAL async channel-death path: the module's process.stdout 'error' listener.
        (process.stdout as NodeJS.EventEmitter).emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
        expect(loggerStats().closed).toBe(true); // now observable as closed
        logLine({ event: "after-close" }); // a further write after closure must NOT re-warn (idempotent)
      });
      expect(warns.filter((l) => l.includes("stdout closed early"))).toHaveLength(1); // one trace, not per-write
    } finally {
      resetLogSink(); // clear the closed flag so later tests get a clean channel
    }
  });

  test("a synchronous EPIPE also surfaces the same one-shot stderr trace", () => {
    resetLogSink();
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    }) as typeof process.stdout.write);
    try {
      const warns = captureFd2(() => {
        logLine({ event: "x" }); // sync throw → markStdoutClosed → one trace
        logLine({ event: "y" }); // already closed → no second trace
      });
      expect(warns.filter((l) => l.includes("stdout closed early"))).toHaveLength(1);
      expect(loggerStats().closed).toBe(true);
    } finally {
      outSpy.mockRestore();
      resetLogSink();
    }
  });

  test("a synchronous NON-EPIPE stdout error surfaces the same one-shot stderr trace", () => {
    resetLogSink();
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => {
      throw Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" }); // reset pipe, not EPIPE
    }) as typeof process.stdout.write);
    try {
      const warns = captureFd2(() => {
        logLine({ event: "x" }); // sync non-EPIPE throw → markStdoutClosed → one trace
        logLine({ event: "y" }); // already closed → no second trace
      });
      expect(warns.filter((l) => l.includes("stdout closed early"))).toHaveLength(1);
      expect(loggerStats().closed).toBe(true);
    } finally {
      outSpy.mockRestore();
      resetLogSink();
    }
  });

  test("a dead stderr (writeSync throws EPIPE) is swallowed — the trace never escapes to change the exit code", () => {
    resetLogSink();
    // Simulate a MERGED closed pipe (`… 2>&1 | head`): the stderr fd write itself fails. The trace
    // must be swallowed synchronously — if it escaped, an unhandled EPIPE would exit the process
    // non-zero, regressing the exit code of a run whose consumer merely truncated the pipe.
    const wsSpy = spyOn(fs, "writeSync").mockImplementation((() => {
      throw Object.assign(new Error("EPIPE"), { code: "EPIPE" });
    }) as typeof fs.writeSync);
    try {
      expect(() =>
        (process.stdout as NodeJS.EventEmitter).emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })),
      ).not.toThrow();
      expect(loggerStats().closed).toBe(true);
      expect(() => logLine({ event: "after" })).not.toThrow();
    } finally {
      wsSpy.mockRestore();
      resetLogSink();
    }
  });
});

// Coverage the pre-existing backpressure suite left open (PR1 review — pr-test-analyzer):
//   - the PRODUCTION default bound (every over-bound test shrinks it to 2, so 10_000 was unverified);
//   - the REAL async process.stdout 'error' listener waking a PENDING flush (only the sync path ran);
//   - heartbeat's DEFAULT emit droppable-marking (every heartbeat test injects its own emit).
describe("backpressure writer — production-default + real-listener coverage (T7)", () => {
  test("the DEFAULT buffer bound (no override) evicts exactly once past 10_000 buffered lines", () => {
    const f = fakeSink();
    setLogSink(f.sink); // NO maxBuffered override → the real DEFAULT_MAX_BUFFERED_LINES (10_000)
    const before = loggerStats().dropped;
    try {
      f.pause();
      logLine({ event: "latch" }); // reaches the sink, returns false → writer pauses; buffer still empty
      for (let i = 0; i < 10_001; i++) logLine({ event: "tel", i }, { droppable: true }); // fill to 10_000, +1 sheds one
      expect(loggerStats().dropped - before).toBe(1); // the REAL 10_000 bound shed exactly one (MAX_SAFE default → 0)
    } finally {
      resetLogSink();
    }
  });

  test("the real async process.stdout 'error' wakes a PENDING flushLogs (not merely isClosed)", async () => {
    resetLogSink(); // real default sink
    // Snapshot pre-existing 'drain' listeners so cleanup removes ONLY the one this test leaks (the
    // writer arms a real once('drain') that never fires here), not any unrelated global listener.
    const drainBefore = (process.stdout as NodeJS.EventEmitter).listeners("drain");
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => false) as typeof process.stdout.write); // always backpressure
    const wsSpy = spyOn(fs, "writeSync").mockImplementation((() => 0) as typeof fs.writeSync); // swallow the fd-2 trace
    try {
      logLine({ event: "buffered" }); // sink returns false → writer pauses, arms a real once('drain') that never fires
      let resolved = false;
      const flush = flushLogs().then(() => { resolved = true; });
      await Promise.resolve();
      await Promise.resolve(); // let microtasks settle — the flush must still be pending
      expect(resolved).toBe(false);
      (process.stdout as NodeJS.EventEmitter).emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
      await flush; // resolves ONLY via the async wake; would hang forever if stdoutCloseCb?.() were removed
      expect(loggerStats().closed).toBe(true);
      logLine({ event: "after" }); // no-op after closure
    } finally {
      outSpy.mockRestore();
      wsSpy.mockRestore();
      // remove only the drain listener(s) THIS test added — never touch unrelated global listeners.
      for (const l of (process.stdout as NodeJS.EventEmitter).listeners("drain"))
        if (!drainBefore.includes(l)) (process.stdout as NodeJS.EventEmitter).removeListener("drain", l);
      resetLogSink();
    }
  });

  test("startHeartbeat's DEFAULT emit marks heartbeats DROPPABLE (self-shed, never evict lifecycle)", () => {
    const f = fakeSink();
    setLogSink(f.sink, 2); // tiny bound
    const before = loggerStats().dropped;
    try {
      logLine({ event: "l0" }); // clear channel → straight to the sink
      f.pause();
      logLine({ event: "l1" }); // reaches the sink, returns false → writer pauses (l1 in sink, buffer empty)
      logLine({ event: "l2" }); // buffered  [l2]
      logLine({ event: "l3" }); // buffered  [l2, l3] → at bound
      // Start the heartbeat AFTER those writes so lastSeen == current activity → this tick is "quiet".
      const hb = startHeartbeat({ intervalMs: 1_000_000, setIntervalImpl: () => 0, clearIntervalImpl: () => {} });
      hb.tick(); // DEFAULT emit → logLine(heartbeat, {droppable:true}); full+all-lifecycle+droppable → drops ITSELF
      hb.stop();
      f.resume();
      const events = f.received.map((l) => stripTs(JSON.parse(l) as Record<string, unknown>)["event"]);
      expect(events).toEqual(["l0", "l1", "l2", "l3"]); // lifecycle intact; a NON-droppable heartbeat would evict l2
      expect(loggerStats().dropped - before).toBe(1); // exactly the heartbeat, self-shed
    } finally {
      resetLogSink();
    }
  });
});
