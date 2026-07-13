import { expect, test, describe } from "bun:test";
import { createNetworkReporter, type NetworkEvent } from "./netEvents.ts";

// Drive the reporter with a frozen clock + capturing emit so the token bucket and counters are
// fully deterministic (no real logLine, no wall clock).
function harness(opts: { refillPerSec?: number; burst?: number } = {}) {
  let clockMs = 0;
  const emitted: Array<{ e: Record<string, unknown>; droppable: boolean }> = [];
  let loggerDropped = 0;
  const reporter = createNetworkReporter({
    nowMs: () => clockMs,
    emit: (e, o) => emitted.push({ e, droppable: o?.droppable === true }),
    loggerDropped: () => loggerDropped,
    refillPerSec: opts.refillPerSec,
    burst: opts.burst,
  });
  return {
    reporter,
    emitted,
    advance: (ms: number) => {
      clockMs += ms;
    },
    setLoggerDropped: (n: number) => {
      loggerDropped = n;
    },
  };
}

const retry = (attempt: number): NetworkEvent => ({ kind: "retry", reason: "no-response", endpoint: "x", attempt, maxAttempts: 6, nextWaitMs: 1000 });

describe("network reporter flood control + counters (T7)", () => {
  test("emits the first candidate, rate-limits the rest, counts every attempt + suppression", () => {
    const h = harness(); // burst 1, refill 1/s, clock frozen at 0 → only the first token exists
    h.reporter.emit(retry(0));
    h.reporter.emit(retry(1));
    h.reporter.emit(retry(2));
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]!.e).toMatchObject({ event: "retry", reason: "no-response", attempt: 0, maxAttempts: 6, nextWaitMs: 1000 });
    expect(h.emitted[0]!.droppable).toBe(true); // droppable so backpressure can shed it too
    expect(h.reporter.counters().retryTotal).toBe(3); // every attempt counted
    expect(h.reporter.counters().suppressed).toBe(2); // two rate-limited
  });

  test("a refilled token lets another line through after the cadence elapses", () => {
    const h = harness();
    h.reporter.emit(retry(0)); // emit (consumes the token)
    h.reporter.emit(retry(1)); // suppressed
    h.advance(1000); // one token refills at 1/s
    h.reporter.emit(retry(2)); // emit
    expect(h.emitted).toHaveLength(2);
    expect(h.reporter.counters()).toEqual({ retryTotal: 3, suppressed: 1 });
  });

  test("throttle is rate-limited + droppable; spawn-timeout is ALWAYS emitted (never dropped)", () => {
    const h = harness();
    h.reporter.emit({ kind: "throttle", bucket: "core", waitKind: "primary", waitMs: 5000, untilMs: 5000, attempt: 0 }); // emit (token)
    h.reporter.emit({ kind: "throttle", bucket: "core", waitKind: "secondary", waitMs: 1000, untilMs: 1000, attempt: 1 }); // suppressed
    h.reporter.emit({ kind: "spawn-timeout", bin: "gh", ms: 900_000 }); // ALWAYS
    h.reporter.emit({ kind: "spawn-timeout", bin: "git", ms: 900_000 }); // ALWAYS
    expect(h.emitted.map((x) => x.e["event"])).toEqual(["throttle", "spawn-timeout", "spawn-timeout"]);
    expect(h.emitted[0]!.e).toMatchObject({ event: "throttle", bucket: "core", kind: "primary", untilMs: 5000 });
    expect(h.emitted[0]!.droppable).toBe(true);
    expect(h.emitted[1]!.droppable).toBe(false); // spawn-timeout is not droppable
    expect(h.reporter.counters()).toEqual({ retryTotal: 0, suppressed: 1 }); // only the secondary throttle
  });

  test("suppressed folds in the stdout writer's backpressure drops", () => {
    const h = harness();
    h.reporter.emit(retry(0)); // emit
    h.reporter.emit(retry(1)); // rate-limit suppressed (1)
    h.setLoggerDropped(4); // the writer shed 4 droppable lines under backpressure
    expect(h.reporter.counters().suppressed).toBe(1 + 4);
  });

  test("suppressed is RUN-SCOPED: writer drops that predate the reporter aren't counted (in-process reuse)", () => {
    let dropped = 5; // an earlier in-process run already dropped 5 lines
    const reporter = createNetworkReporter({ nowMs: () => 0, emit: () => {}, loggerDropped: () => dropped });
    expect(reporter.counters().suppressed).toBe(0); // 5 predate this reporter → excluded
    dropped = 8; // 3 new drops during THIS run
    expect(reporter.counters().suppressed).toBe(3); // delta only
  });

  test("suppressed counts current drops when the writer was reset below the baseline (no drops lost)", () => {
    let dropped = 5; // baseline captured at 5
    const reporter = createNetworkReporter({ nowMs: () => 0, emit: () => {}, loggerDropped: () => dropped });
    dropped = 3; // the writer was reset (below baseline) and has since dropped 3
    expect(reporter.counters().suppressed).toBe(3); // count the current absolute drops, not clamp to 0
  });

  // The token-bucket boundaries were only exercised at exact 0ms / 1000ms cadences (PR1 review —
  // pr-test-analyzer). These pin the Math.min(burst,…) cap and the FULL-token (>=1) emit gate.
  test("tokens clamp at `burst` after a long idle — a same-instant flood emits at most `burst`", () => {
    const h = harness(); // burst 1, refill 1/s
    h.advance(10_000); // 10s idle → WITHOUT the cap this would accrue ~10 tokens
    for (let i = 0; i < 4; i++) h.reporter.emit(retry(i)); // burst+3 candidates at the same instant
    expect(h.emitted).toHaveLength(1); // capped at burst(1); dropping Math.min would emit all 4
    expect(h.reporter.counters().retryTotal).toBe(4);
  });

  test("a partial (sub-cadence) token does not emit — the gate is a FULL token (>=1, not >0)", () => {
    const h = harness(); // burst 1, refill 1/s
    h.reporter.emit(retry(0)); // consume the sole initial token → emits (tokens now 0)
    h.advance(500); // half a cadence → 0.5 token accrued
    h.reporter.emit(retry(1)); // 0.5 < 1 → suppressed; a `>0` gate would wrongly emit
    expect(h.emitted).toHaveLength(1); // only the first
  });

  // The elapsed delta is already clamped at 0 so a BACKWARD wall-clock correction (NTP) can't drain
  // tokens. But the refill BASELINE must also never retreat: if a backward reading moved lastRefillMs
  // earlier, the next forward reading would credit the whole (inflated) interval since that earlier
  // point — over-granting tokens and emitting telemetry the budget never actually earned.
  test("a backward clock correction never over-credits tokens after recovery (monotonic baseline)", () => {
    const h = harness(); // burst 1, refill 1/s, baseline lastRefillMs = 0, tokens = 1
    h.reporter.emit(retry(0)); // consumes the sole initial token → emits
    h.advance(-2000); // wall clock jumps 2s backward
    h.reporter.emit(retry(1)); // no token → suppressed; must NOT retreat the refill baseline to -2000
    h.advance(2001); // clock recovers to +1ms past the ORIGINAL baseline
    h.reporter.emit(retry(2)); // only ~1ms of real time elapsed since baseline → still under one token → suppressed
    expect(h.emitted).toHaveLength(1); // ONLY the first; a retreated baseline would credit ~2s and emit a 2nd
    expect(h.reporter.counters().retryTotal).toBe(3);
  });
});
