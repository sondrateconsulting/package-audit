// netEvents.ts — run-scoped network-event reporter (§4/§7 resilience — T7). github.ts emits
// retry/throttle/spawn-timeout through an INJECTED sink so it stays decoupled from the coordinator
// (no orchestrate import; the single-spawn chokepoint is unaffected). A large flaky-VPN run can
// produce a flood of retry attempts; emitting every one would drown the log, so this reporter:
//   - counts EVERY retry attempt (retryTotal) and every suppressed candidate (suppressed);
//   - rate-limits the retry/throttle flood to a global burst-1 / refill-1-per-second budget, so an
//     operator sees the first event after a quiet window plus a trickle, never a wall of lines;
//   - marks emitted retry/throttle lines DROPPABLE so the stdout backpressure buffer sheds them
//     FIRST under a slow consumer;
//   - is never rate-limited for spawn-timeout (rare, and individually load-bearing) — though like any
//     line it can still be shed if the stdout buffer is saturated entirely with non-droppable events.
// `suppressed` folds in BOTH this reporter's rate-limit drops and the writer's backpressure drops
// (which, when the backlog is all non-droppable, can include a lifecycle/unit line, not just
// telemetry), so the heartbeat/done counters account for every held-back line in one number.

import { logLine, loggerStats } from "./log.ts";

export type NetworkEvent =
  | { kind: "retry"; reason: "no-response" | "http-5xx"; endpoint: string; attempt: number; maxAttempts: number; nextWaitMs: number }
  | { kind: "throttle"; bucket: string; waitKind: "primary" | "secondary"; waitMs: number; untilMs: number; attempt: number }
  | { kind: "spawn-timeout"; bin: string; ms: number };

export interface NetworkReporterOptions {
  nowMs?: () => number;
  emit?: (e: Record<string, unknown>, opts?: { droppable?: boolean }) => void; // default logLine
  refillPerSec?: number; // token refill rate for the flood limiter (default 1)
  burst?: number; // token-bucket capacity (default 1)
  loggerDropped?: () => number; // default loggerStats().dropped — folded into `suppressed`
}

export interface NetworkReporter {
  emit(e: NetworkEvent): void;
  counters(): { retryTotal: number; suppressed: number };
}

export function createNetworkReporter(opts: NetworkReporterOptions = {}): NetworkReporter {
  const now = opts.nowMs ?? Date.now;
  const emit = opts.emit ?? logLine;
  const refillPerSec = opts.refillPerSec ?? 1;
  const burst = opts.burst ?? 1;
  const loggerDropped = opts.loggerDropped ?? (() => loggerStats().dropped);

  let retryTotal = 0;
  let rateLimited = 0;
  let tokens = burst;
  let lastRefillMs = now();
  // This reporter is RUN-SCOPED; the writer's dropped counter is process-lifetime. Snapshot it at
  // creation so `suppressed` reports the drops SINCE this run started, not any inherited from an
  // earlier in-process run (tests / the entrypoint harness reuse the process).
  const baselineDropped = loggerDropped();

  // Global burst/refill token bucket: true = a flood candidate (retry/throttle) may emit now.
  const takeToken = (): boolean => {
    const t = now();
    // clamp the elapsed delta at 0 so a backward wall-clock correction (NTP) can never DRAIN tokens.
    tokens = Math.min(burst, tokens + (Math.max(0, t - lastRefillMs) / 1000) * refillPerSec);
    // Advance the baseline forward-only: a backward reading must NOT move it earlier, or the next
    // forward reading would credit the whole inflated interval since that earlier point and
    // over-grant tokens (emitting telemetry the budget never earned).
    if (t > lastRefillMs) lastRefillMs = t;
    if (tokens >= 1) {
      tokens -= 1;
      return true;
    }
    return false;
  };

  return {
    emit(e: NetworkEvent): void {
      if (e.kind === "spawn-timeout") {
        // never rate-limited (rare, and each marks a child killed past its per-category,
        // operator-configurable deadline — the actual ms is carried in the event); emitted
        // non-droppable so the backpressure buffer sheds it only as a last resort.
        emit({ event: "spawn-timeout", bin: e.bin, ms: e.ms });
        return;
      }
      if (e.kind === "retry") retryTotal += 1;
      if (!takeToken()) {
        rateLimited += 1;
        return;
      }
      if (e.kind === "retry") {
        emit(
          { event: "retry", reason: e.reason, endpoint: e.endpoint, attempt: e.attempt, maxAttempts: e.maxAttempts, nextWaitMs: e.nextWaitMs },
          { droppable: true },
        );
      } else {
        emit(
          { event: "throttle", bucket: e.bucket, kind: e.waitKind, waitMs: e.waitMs, untilMs: e.untilMs, attempt: e.attempt },
          { droppable: true },
        );
      }
    },
    counters(): { retryTotal: number; suppressed: number } {
      // Normally the writer's dropped counter is monotonic, so the delta since our baseline is the
      // run-scoped drop count. If it is ever RESET below the baseline (only reachable via test-only
      // resetLogSink), a negative delta means the baseline is stale — fall back to the writer's
      // current absolute count rather than clamp the new drops away.
      const cur = loggerDropped();
      const drops = cur >= baselineDropped ? cur - baselineDropped : cur;
      return { retryTotal, suppressed: rateLimited + drops };
    },
  };
}
