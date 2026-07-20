// progress.test.ts — §U8.5: the hub's no-sink fast path, ordered delivery, the sink-throw
// backstop, the structured latch (first-cause-wins + independent divert flag), reset semantics,
// and the allocation-free tap gate.
import { expect, test, describe, afterEach } from "bun:test";
import {
  setProgressSink, hasProgressSink, emitProgress, nextProgressId,
  reportTuiFailure, reportDivertFailure, tuiFailure, resetTuiFailure,
  type ProgressEvent,
} from "./progress.ts";
import { setLogSink, setLogTap, logLine } from "./log.ts";

afterEach(() => {
  // §U8 hygiene: module-global seams must never leak across the suite
  setProgressSink(null);
  setLogSink(null);
  setLogTap(null);
  resetTuiFailure();
});

describe("emitProgress + sink discipline", () => {
  test("no sink installed: emit is a no-op and hasProgressSink gates work", () => {
    expect(hasProgressSink()).toBe(false);
    emitProgress({ type: "phase", phase: "scan" }); // must not throw, must not do anything
    expect(tuiFailure()).toBeNull();
  });

  test("ordered delivery to the installed sink", () => {
    const seen: ProgressEvent[] = [];
    setProgressSink((e) => seen.push(e));
    expect(hasProgressSink()).toBe(true);
    emitProgress({ type: "owner-start", owner: "acme" });
    emitProgress({ type: "repo-start", owner: "acme", repo: "api" });
    emitProgress({ type: "repo-end", owner: "acme", repo: "api" });
    expect(seen.map((e) => e.type)).toEqual(["owner-start", "repo-start", "repo-end"]);
  });

  test("first sink throw clears the sink, latches, and never escapes", () => {
    let calls = 0;
    setProgressSink(() => {
      calls++;
      throw new Error("fold bug");
    });
    emitProgress({ type: "phase", phase: "preflight" }); // must not throw
    expect(calls).toBe(1);
    expect(hasProgressSink()).toBe(false); // cleared — later emits are single null-checks again
    emitProgress({ type: "phase", phase: "scan" });
    expect(calls).toBe(1); // never called again
    expect(tuiFailure()).toEqual({ firstCause: "fold bug", divertFailedMidRun: false });
  });

  test("nextProgressId is monotonic (span pairing is exact even for identical labels)", () => {
    const a = nextProgressId();
    const b = nextProgressId();
    const c = nextProgressId();
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });
});

describe("the structured TUI-failure latch", () => {
  test("first cause wins; later reports do not overwrite it", () => {
    reportTuiFailure("first");
    reportTuiFailure("second");
    expect(tuiFailure()).toEqual({ firstCause: "first", divertFailedMidRun: false });
  });

  test("reportDivertFailure sets the flag even when it fires SECOND (independent of first cause)", () => {
    reportTuiFailure("tick crashed");
    reportDivertFailure("disk full");
    // the first cause is retained AND the divert flag is set — teardown can answer both questions
    expect(tuiFailure()).toEqual({ firstCause: "tick crashed", divertFailedMidRun: true });
  });

  test("reportDivertFailure firing FIRST is both the cause and the flag", () => {
    reportDivertFailure("disk full");
    expect(tuiFailure()).toEqual({ firstCause: "disk full", divertFailedMidRun: true });
  });

  test("reset clears the latch (fresh lifecycle start)", () => {
    reportDivertFailure("x");
    resetTuiFailure();
    expect(tuiFailure()).toBeNull();
  });

  test("the returned latch object is a copy — mutating it cannot corrupt the latch", () => {
    reportTuiFailure("cause");
    const snap = tuiFailure()!;
    snap.divertFailedMidRun = true;
    expect(tuiFailure()).toEqual({ firstCause: "cause", divertFailedMidRun: false });
  });
});

describe("the jsonl tap gate (§U1/§U0)", () => {
  test("the tap allocates nothing once the sink is cleared — hasProgressSink() gates the emit", () => {
    // the production tap shape: gate BEFORE building the progress event
    let builds = 0;
    setLogTap((ev) => {
      if (hasProgressSink()) {
        builds++;
        emitProgress({ type: "jsonl", event: ev });
      }
    });
    const seen: ProgressEvent[] = [];
    setProgressSink((e) => seen.push(e));
    const so = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = () => true;
    try {
      logLine({ event: "unit", action: "scanned" });
      setProgressSink(null); // sink gone → the tap must build nothing further
      logLine({ event: "unit", action: "scanned" });
    } finally {
      (process.stdout as unknown as { write: typeof so }).write = so;
    }
    expect(builds).toBe(1);
    expect(seen.length).toBe(1);
    expect(seen[0]!.type).toBe("jsonl");
  });
});

describe("throttle event type: reason is coupled to state (§U4)", () => {
  test("armed/waiting carry no reason; exhausted REQUIRES one (compile-time guard)", () => {
    // Positive: armed and waiting are valid WITHOUT a reason.
    const armed: ProgressEvent = { type: "throttle", bucket: "core", state: "armed", untilMs: null, budgetSpentMs: 0 };
    const waiting: ProgressEvent = { type: "throttle", bucket: "graphql", state: "waiting", untilMs: 1_000, budgetSpentMs: 0 };
    // Positive: exhausted WITH a reason is valid.
    const exhausted: ProgressEvent = { type: "throttle", bucket: "core", state: "exhausted", reason: "budget", untilMs: null, budgetSpentMs: 10 };
    expect([armed.type, waiting.type, exhausted.type]).toEqual(["throttle", "throttle", "throttle"]);

    // Negative (enforced by `tsc`, not by the runtime): an exhausted event with NO reason must be a
    // TYPE error, so the store fold can never silently route a future/forgotten exhaustion reason
    // into the transient retry counter instead of the sticky budget flag. The literal is annotated
    // as ProgressEvent so this exercises the union constraint, not excess-property inference.
    // @ts-expect-error exhausted throttle events require a `reason`
    const missingReason: ProgressEvent = { type: "throttle", bucket: "core", state: "exhausted", untilMs: null, budgetSpentMs: 0 };
    void missingReason;

    // Negative: armed/waiting must EXACTLY forbid a reason — including on a NON-FRESH object, where
    // structural assignability (not the fresh-literal excess-property check) governs. `reason?: never`
    // is what rejects it: without that, `nonFresh` carries all armed fields plus an extra reason and
    // would be assignable, silently defeating the state↔reason coupling.
    const nonFresh = { type: "throttle" as const, bucket: "core" as const, state: "armed" as const, reason: "budget" as const, untilMs: null, budgetSpentMs: 0 };
    // @ts-expect-error armed/waiting throttle events must not carry a reason
    const armedWithReason: ProgressEvent = nonFresh;
    void armedWithReason;
  });
});
