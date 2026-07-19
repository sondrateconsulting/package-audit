import { expect, test, describe, afterEach } from "bun:test";
import { startHeartbeat, activeHeartbeats, type HeartbeatController } from "./heartbeat.ts";

// Every controller a test creates is stopped afterEach, so the module's active-count never leaks
// between tests (and the entrypoint lifecycle test can assert a clean balance).
const created: HeartbeatController[] = [];
afterEach(() => {
  for (const c of created) c.stop();
  created.length = 0;
});

// Drive the controller with fully injected deps: a manual activity counter, a fake clock, a
// capturing emit that bumps the counter to mimic logLine, and a no-op interval so tests call
// tick() directly without real timers.
function harness(opts: { intervalMs?: number; extra?: () => Record<string, unknown> } = {}) {
  let seq = 0;
  let clockMs = 1_000_000;
  const events: Array<Record<string, unknown>> = [];
  let cleared = false;
  const hb = startHeartbeat({
    intervalMs: opts.intervalMs ?? 30_000,
    nowMs: () => clockMs,
    activitySeq: () => seq,
    emit: (e) => {
      events.push(e);
      seq++; // mimic logLine bumping the shared activity counter
    },
    setIntervalImpl: () => ({}), // tick() is driven manually
    clearIntervalImpl: () => {
      cleared = true;
    },
    extra: opts.extra,
  });
  created.push(hb);
  return {
    hb,
    events,
    logActivity: () => {
      seq++;
    }, // stands in for an unrelated logLine write
    advance: (ms: number) => {
      clockMs += ms;
    },
    wasCleared: () => cleared,
  };
}

describe("heartbeat controller (T6)", () => {
  test("emits on a QUIET tick and keeps emitting across consecutive quiet ticks", () => {
    const h = harness();
    h.hb.tick();
    h.hb.tick();
    expect(h.events).toHaveLength(2);
    expect(h.events[0]).toMatchObject({ event: "heartbeat", phase: "starting", unitsDone: 0 });
  });

  test("stays SILENT on a tick that follows real activity since the last tick", () => {
    const h = harness();
    h.hb.tick(); // quiet → emit (1)
    h.logActivity(); // an unrelated event was logged
    h.hb.tick(); // activity seen → suppressed
    expect(h.events).toHaveLength(1);
  });

  test("carries phase, current target, unitsDone, and elapsed seconds", () => {
    const h = harness();
    h.hb.setPhase("scan");
    h.hb.setTarget("org/repo@main");
    h.hb.setUnitsDone(7);
    h.advance(65_000);
    h.hb.tick();
    expect(h.events[0]).toMatchObject({ event: "heartbeat", phase: "scan", current: "org/repo@main", unitsDone: 7, elapsedSec: 65 });
  });

  test("emits `inFlight` only when siblings run alongside `current` (>1), never for a single unit", () => {
    const h = harness();
    h.hb.setPhase("scan");
    h.hb.setTarget("org/repo@a", 1); // exactly one unit in flight
    h.hb.tick();
    expect(h.events[0]).toMatchObject({ event: "heartbeat", current: "org/repo@a" });
    expect(h.events[0]!["inFlight"]).toBeUndefined(); // 1 is implied by `current` — README says inFlight is for >1
    h.hb.setTarget("org/repo@a", 3); // now three concurrent, oldest still `current`
    h.hb.tick();
    expect(h.events[1]).toMatchObject({ event: "heartbeat", current: "org/repo@a", inFlight: 3 });
  });

  test("omits `current` until a target is set", () => {
    const h = harness();
    h.hb.tick();
    expect(h.events[0]!["current"]).toBeUndefined();
  });

  test("merges extra() fields into every line (the T7 retryTotal/suppressed seam)", () => {
    const h = harness({ extra: () => ({ retryTotal: 3, suppressed: 1 }) });
    h.hb.tick();
    expect(h.events[0]).toMatchObject({ event: "heartbeat", retryTotal: 3, suppressed: 1 });
  });

  test("stop() clears the interval, is idempotent, and balances the active-count", () => {
    const before = activeHeartbeats();
    const h = harness();
    expect(activeHeartbeats()).toBe(before + 1);
    h.hb.stop();
    expect(h.wasCleared()).toBe(true);
    expect(activeHeartbeats()).toBe(before);
    h.hb.stop(); // idempotent — no double-decrement
    expect(activeHeartbeats()).toBe(before);
  });
});
