// heartbeat.ts — run-scoped liveness heartbeat (§3 resilience, T6). A large audit spends long
// stretches inside a single await (a throttle pause, a slow clone, a big paged listing) with
// nothing to log; an operator watching stdout can't distinguish that from a wedge. The heartbeat
// samples log.ts's activity counter on a fixed cadence and, ONLY when nothing has been logged
// since its last tick, emits one {event:"heartbeat"} line carrying the current phase/target and
// elapsed seconds. It is RUN-SCOPED (an object, not a module global): started before preflight,
// stopped in ONE outer finally so it never outlives the run or dangles a timer.
//
// Single-thread caveat (documented, NOT engineered away): Bun is one JS thread, so a SYNCHRONOUS
// burst — gunzip of a <=150MB tarball, a scanUnit pass, a big SQLite write — blocks the event loop
// and the timer cannot fire during it. The heartbeat proves liveness at AWAIT boundaries only.
import { logLine, logActivitySeq } from "./log.ts";

export interface HeartbeatController {
  setPhase(phase: string): void;
  setTarget(target: string | null): void; // e.g. "org/repo@branch" currently in flight
  setUnitsDone(n: number): void;
  tick(): void; // the interval calls this; exposed so tests drive it without real timers
  stop(): void;
}

// Active-heartbeat balance counter. A test asserts it returns to 0 after every run, proving the
// controller is stopped on EVERY exit path (success, --plan return, thrown error) — the "cleared in
// one outer finally" contract. Not a runtime signal; purely a leak tripwire.
let activeCount = 0;
export function activeHeartbeats(): number {
  return activeCount;
}

export interface HeartbeatOptions {
  intervalMs: number;
  nowMs?: () => number;
  emit?: (e: Record<string, unknown>) => void; // default logLine
  activitySeq?: () => number; // default logActivitySeq
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  // Extra fields merged into every heartbeat line (T7 wires retryTotal/suppressed counters here).
  extra?: () => Record<string, unknown>;
}

export function startHeartbeat(opts: HeartbeatOptions): HeartbeatController {
  const nowMs = opts.nowMs ?? Date.now;
  // heartbeats are pure telemetry: mark them DROPPABLE so the stdout backpressure buffer sheds them
  // (not lifecycle events) under a sustained slow consumer (T7).
  const emit = opts.emit ?? ((e: Record<string, unknown>) => logLine(e, { droppable: true }));
  const activity = opts.activitySeq ?? logActivitySeq;
  // Default timers are REF'D on purpose (codex): an unref'd awaited heartbeat would let a
  // standalone CLI drain its event loop and exit mid-await, skipping cleanup/finalization.
  const setIv = opts.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms));
  const clearIv = opts.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const extra = opts.extra ?? (() => ({}));

  const startedAt = nowMs();
  let phase = "starting";
  let target: string | null = null;
  let unitsDone = 0;
  let lastSeen = activity();
  let stopped = false;

  const tick = (): void => {
    if (activity() === lastSeen) {
      // genuinely quiet since the last tick — speak up.
      const line: Record<string, unknown> = { event: "heartbeat", phase };
      if (target !== null) line["current"] = target;
      line["unitsDone"] = unitsDone;
      line["elapsedSec"] = Math.round((nowMs() - startedAt) / 1000);
      Object.assign(line, extra());
      emit(line);
    }
    // Snapshot AFTER: a heartbeat we just emitted itself bumped the activity counter, so the next
    // tick must compare against the post-heartbeat value — otherwise every subsequent tick would
    // see "activity" (our own line) and never speak again during a long quiet stretch.
    lastSeen = activity();
  };

  activeCount++;
  const handle = setIv(tick, opts.intervalMs);

  return {
    setPhase(p) {
      phase = p;
    },
    setTarget(t) {
      target = t;
    },
    setUnitsDone(n) {
      unitsDone = n;
    },
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      activeCount--;
      clearIv(handle);
    },
  };
}
