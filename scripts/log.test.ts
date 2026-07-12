import { expect, test, describe, spyOn } from "bun:test";
import { logLine, logActivitySeq } from "./log.ts";

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
