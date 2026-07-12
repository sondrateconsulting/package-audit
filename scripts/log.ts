// log.ts — the ONE stdout JSONL writer (§6/§8 observability). stdout is machine-readable
// exclusively: one structured JSON event per line, safe to pipe; anything human-facing goes to
// stderr. Shared so every module that records a fail-soft failure can pair its DB error row
// with a live event (orchestrate.ts for discovery/unit events, apiSurface.ts for per-version
// introspection failures) without routing through the coordinator.
//
// ONE ATOMIC WRITE PER EVENT (load-bearing under fan-out): the complete line — JSON body + the single
// trailing "\n" — is assembled into ONE string and handed to process.stdout.write in a SINGLE call, so
// logLine never splits an event across multiple writes. JSON.stringify escapes any interior newline, so
// the only real line break is the trailing one; each event is therefore exactly one line. This process
// is the sole writer to stdout (subprocess output is captured via pipes, never inherited to the parent
// fd) and Node/Bun stream writes are ordered, so concurrently-produced events queue and emit whole, one
// after another — they never interleave. This is NOT a kernel-level >PIPE_BUF atomicity claim (a lone
// >64KB write to a pipe shared with an INDEPENDENT process could still be split by the OS); it is the
// in-process guarantee that the JSONL a consumer parses is always whole lines. Enforced by log.test.ts.

// Monotonic activity counter, bumped on EVERY write. The run-scoped liveness heartbeat samples it
// to distinguish a genuine quiet stretch (nothing logged since its last tick) from active work, so
// it only speaks up when the run would otherwise be silent (§3 resilience — T6).
let activitySeq = 0;
export function logActivitySeq(): number {
  return activitySeq;
}

// ---- backpressure-aware writer (T7) --------------------------------------------------------
// A slow stdout consumer (`… | slow-thing`) makes process.stdout.write() return false; a naive
// writer would either block the audit loop or let the runtime's internal buffer grow unbounded.
// This bounded buffer absorbs backpressure: while the sink accepts writes they go straight through
// (zero overhead in the common case); once the sink signals backpressure we queue lines and flush
// them on 'drain'. Only explicitly DROPPABLE telemetry (retry/throttle/heartbeat floods) is shed
// when the queue exceeds its bound — every lifecycle/unit event is preserved, in order. A dead pipe
// (EPIPE, e.g. `… | head`) degrades logging to a no-op instead of crashing. The finalize path
// awaits flushLogs() so the terminal `done` event is never left buffered at exit.

// The sink is the seam that makes backpressure testable: the default wraps process.stdout; tests
// inject a fake whose write()/drain they drive deterministically.
export interface LogSink {
  write(line: string): boolean; // false = backpressure (queue behind me until onDrain fires)
  onDrain(cb: () => void): void; // one-shot: fires when the sink can accept more
  isClosed?(): boolean; // the channel is gone (EPIPE) — no drain will ever come; abandon the buffer
}

const DEFAULT_MAX_BUFFERED_LINES = 10_000;

class BufferedWriter {
  private readonly buffer: Array<{ line: string; droppable: boolean }> = [];
  private paused = false; // the sink returned false; we are waiting for a drain
  private drainArmed = false;
  private dropped = 0;
  private waiters: Array<() => void> = []; // flushLogs() promises awaiting an empty buffer

  constructor(
    private readonly sink: LogSink,
    private readonly maxBuffered: number = DEFAULT_MAX_BUFFERED_LINES,
  ) {}

  write(line: string, droppable: boolean): void {
    // Preserve ordering: anything already buffered (or a paused sink) means this line queues behind
    // it. Only a clear channel (not paused AND nothing buffered) writes straight through.
    if (!this.paused && this.buffer.length === 0) this.pushToSink(line);
    else this.enqueue(line, droppable);
  }

  private pushToSink(line: string): void {
    if (this.sink.write(line) === false) {
      this.paused = true;
      this.armDrain();
    }
  }

  private enqueue(line: string, droppable: boolean): void {
    if (this.buffer.length >= this.maxBuffered) {
      // shed the OLDEST droppable telemetry to stay bounded; keep lifecycle events + ordering.
      const i = this.buffer.findIndex((p) => p.droppable);
      if (i >= 0) {
        this.buffer.splice(i, 1);
        this.dropped++;
      }
      // if nothing droppable is queued, enqueue anyway — lifecycle events are bounded in count.
    }
    this.buffer.push({ line, droppable });
  }

  private armDrain(): void {
    if (this.drainArmed) return;
    this.drainArmed = true;
    this.sink.onDrain(() => {
      this.drainArmed = false;
      this.paused = false;
      this.flushBuffer();
    });
  }

  private flushBuffer(): void {
    // If the channel died (EPIPE) while we were paused, no 'drain' will ever come — abandon the
    // buffered lines rather than wait forever, so flushLogs() at finalize resolves instead of hanging.
    if (this.sink.isClosed?.()) {
      this.buffer.length = 0;
      this.resolveWaiters();
      return;
    }
    while (!this.paused && this.buffer.length > 0) {
      this.pushToSink(this.buffer.shift()!.line);
    }
    if (this.buffer.length === 0) this.resolveWaiters();
  }

  // Resolve when the buffer has drained. A clear/empty channel resolves immediately; a paused one
  // resolves once 'drain' flushes the queue. REUSABLE — never permanently closes the writer, so an
  // in-process caller that runs a second time keeps logging.
  flush(): Promise<void> {
    this.flushBuffer();
    if (this.buffer.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private resolveWaiters(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  stats(): { dropped: number } {
    return { dropped: this.dropped };
  }
}

function isEpipe(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "EPIPE";
}

// Default sink: process.stdout with EPIPE swallowed. The reader closing the pipe (`… | head`)
// surfaces as an 'error' event OR a synchronous throw depending on platform; either way we flip to
// a no-op that reports "accepted" so a closed consumer degrades logging instead of crashing the run.
let stdoutClosed = false;
process.stdout.on("error", (e: unknown) => {
  if (isEpipe(e)) stdoutClosed = true;
});
const DEFAULT_SINK: LogSink = {
  write: (line) => {
    if (stdoutClosed) return true;
    try {
      return process.stdout.write(line);
    } catch (e) {
      if (isEpipe(e)) {
        stdoutClosed = true;
        return true;
      }
      throw e;
    }
  },
  onDrain: (cb) => {
    process.stdout.once("drain", cb);
  },
  isClosed: () => stdoutClosed,
};

let writer = new BufferedWriter(DEFAULT_SINK);

// Test seam: swap in a controllable sink (and an optional small buffer bound so the drop-droppable
// path is cheap to exercise). resetLogSink restores the process.stdout sink.
export function setLogSink(sink: LogSink, maxBuffered?: number): void {
  writer = new BufferedWriter(sink, maxBuffered);
}
export function resetLogSink(): void {
  stdoutClosed = false; // restore a clean default channel (also clears a test-induced EPIPE)
  writer = new BufferedWriter(DEFAULT_SINK);
}

export function loggerStats(): { dropped: number } {
  return writer.stats();
}

// logLine OWNS `ts` (ISO-8601 UTC, ALWAYS the first key). H1/L2: every audit/plan stdout event is
// timestamped so a stalled run stays legible in the log. A caller-supplied `ts` is ignored (never
// forwarded) so the timestamp can be neither forged nor duplicated — the format is pinned in
// log.test.ts and every capture helper strips it before asserting on the other fields.
// `droppable` marks pure telemetry (retry/throttle/heartbeat) the writer may shed under sustained
// backpressure; lifecycle/unit/terminal events default to non-droppable and are never dropped.
export function logLine(event: Record<string, unknown>, opts?: { droppable?: boolean }): void {
  // bump FIRST so the heartbeat sampler counts this write even if serialization below throws.
  activitySeq++;
  const line: Record<string, unknown> = { ts: new Date().toISOString() };
  for (const key of Object.keys(event)) if (key !== "ts") line[key] = event[key];
  writer.write(JSON.stringify(line) + "\n", opts?.droppable === true);
}

// Awaited by every entrypoint's finally so buffered events (above all the terminal `done`/summary
// lines) reach stdout before the process exits. Resolves immediately on a clear or dead channel.
export function flushLogs(): Promise<void> {
  return writer.flush();
}
