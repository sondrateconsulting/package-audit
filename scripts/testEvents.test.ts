import { expect, test } from "bun:test";

// Shared capture-helper for stdout JSONL assertions. logLine (T6) stamps every event with an
// ISO-8601 UTC `ts` as the FIRST key; these helpers assert its presence + shape, then DROP it so
// behavioral assertions stay ts-agnostic (the exact byte format is pinned in log.test.ts).
// Validating at every consumption point — not only in log.test.ts — means a regression where some
// event path skips logLine (and thus carries no ts) fails loudly where the event is read.
export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function stripTs(e: Record<string, unknown>): Record<string, unknown> {
  const { ts, ...rest } = e;
  expect(typeof ts).toBe("string");
  expect(ts as string).toMatch(ISO_UTC_RE);
  return rest;
}

// Parse a JSONL blob (one event per line) into ts-stripped event objects.
export function parseEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => stripTs(JSON.parse(l) as Record<string, unknown>));
}

test("stripTs validates + removes ts; parseEvents maps a JSONL blob", () => {
  expect(stripTs({ ts: "2026-07-12T00:00:00.000Z", event: "x", a: 1 })).toEqual({ event: "x", a: 1 });
  expect(() => stripTs({ event: "x" })).toThrow(); // missing ts fails loudly
  expect(() => stripTs({ ts: "not-a-timestamp", event: "x" })).toThrow(); // malformed ts fails
  expect(
    parseEvents(`{"ts":"2026-07-12T00:00:00.000Z","event":"a"}\n{"ts":"2026-07-12T00:00:00.000Z","event":"b","n":2}`),
  ).toEqual([{ event: "a" }, { event: "b", n: 2 }]);
});
