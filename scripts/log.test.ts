import { expect, test, describe, spyOn } from "bun:test";
import { logLine } from "./log.ts";

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
