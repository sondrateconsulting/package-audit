import { expect, test, describe, spyOn, afterEach } from "bun:test";
import { logLine, setLogSink, setLogTap } from "./log.ts";
import { resetTuiFailure, reportTuiFailure, tuiFailure } from "./progress.ts";

afterEach(() => {
  // §U8 hygiene: this file runs against real stdout — the seams must never leak across tests
  setLogSink(null);
  setLogTap(null);
  resetTuiFailure();
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
    expect(line).toBe(JSON.stringify(event) + "\n"); // whole event assembled BEFORE the single write
    expect(line.endsWith("\n")).toBe(true);
    expect((line.match(/\n/g) ?? []).length).toBe(1); // exactly one real newline — interior "\n" is JSON-escaped
    expect(JSON.parse(line.slice(0, -1))).toEqual(event); // the single line round-trips to the event
  });

  test("a minimal event is still one write ending in one newline", () => {
    const calls = spyWrites(() => logLine({ event: "done" }));
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(`{"event":"done"}\n`);
  });
});

describe("logLine sink/tap seam (PROMPT-TUI §U1 / §U8.3)", () => {
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

  test("an installed sink receives the ONE whole line per event; stdout receives nothing", () => {
    const sunk: string[] = [];
    setLogSink((line) => sunk.push(line));
    const event = { event: "unit", action: "scanned", message: "a\nb" };
    const stdoutCalls = spyWrites(() => logLine(event));
    expect(stdoutCalls).toEqual([]); // fully diverted
    expect(sunk.length).toBe(1); // ONE sink invocation per event
    expect(sunk[0]).toBe(JSON.stringify(event) + "\n"); // the complete line, trailing newline included
  });

  test("setLogSink(null) restores stdout", () => {
    setLogSink(() => {});
    setLogSink(null);
    const calls = spyWrites(() => logLine({ event: "done" }));
    expect(calls).toEqual([`{"event":"done"}\n`]);
  });

  test("the tap fires AFTER the durable write, with the parsed event", () => {
    const order: string[] = [];
    setLogSink(() => order.push("sink"));
    const tapped: unknown[] = [];
    setLogTap((ev) => {
      order.push("tap");
      tapped.push(ev);
    });
    logLine({ event: "preflight", login: "u" });
    expect(order).toEqual(["sink", "tap"]);
    expect(tapped).toEqual([{ event: "preflight", login: "u" }]);
  });

  test("a throwing TAP self-clears and never escapes; the durable line is already written", () => {
    const sunk: string[] = [];
    setLogSink((line) => sunk.push(line));
    let tapCalls = 0;
    setLogTap(() => {
      tapCalls++;
      throw new Error("tap bug");
    });
    expect(() => logLine({ event: "done" })).not.toThrow();
    expect(sunk.length).toBe(1); // the line was delivered before the tap ran
    logLine({ event: "done" });
    expect(tapCalls).toBe(1); // self-cleared: never called again
    expect(sunk.length).toBe(2);
  });

  test("a throwing SINK reroutes to stdout re-emitting the SAME line (no loss) and the closure reports", () => {
    // production shape: the closure latches (its own reaction) then rethrows; logLine restores
    // stdout and re-emits the failing line in the SAME call
    setLogSink(() => {
      reportTuiFailure("divert write died");
      throw new Error("EIO");
    });
    const event = { event: "unit", action: "error", message: "x" };
    const stdoutCalls = spyWrites(() => logLine(event));
    expect(stdoutCalls).toEqual([JSON.stringify(event) + "\n"]); // re-emitted, byte-identical
    expect(tuiFailure()?.firstCause).toBe("divert write died"); // the closure reported
    // the sink was cleared: the NEXT event flows straight to stdout with no sink involvement
    const next = spyWrites(() => logLine({ event: "done" }));
    expect(next).toEqual([`{"event":"done"}\n`]);
  });

  test("after a sink throw the tap STILL fires for that event (display can observe the rerouted line)", () => {
    setLogSink(() => {
      throw new Error("EIO");
    });
    const tapped: unknown[] = [];
    setLogTap((ev) => tapped.push(ev));
    spyWrites(() => logLine({ event: "done" }));
    expect(tapped).toEqual([{ event: "done" }]);
  });
});
