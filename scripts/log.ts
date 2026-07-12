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
  onClose?(cb: () => void): void; // register a callback the sink fires when the channel dies async
}

const DEFAULT_MAX_BUFFERED_LINES = 10_000;

class BufferedWriter {
  private readonly buffer: Array<{ line: string; droppable: boolean; terminal: boolean }> = [];
  private paused = false; // the sink returned false; we are waiting for a drain
  private drainArmed = false;
  private dropped = 0;
  private waiters: Array<() => void> = []; // flushLogs() promises awaiting a fully-flushed channel
  private hookClosed = false; // the sink fired its async close hook (works even without isClosed())
  private disposed = false; // swapped out by setLogSink/resetLogSink — must not touch the sink again

  constructor(
    private readonly sink: LogSink,
    private readonly maxBuffered: number = DEFAULT_MAX_BUFFERED_LINES,
  ) {
    // Wake this writer if the channel dies asynchronously (no 'drain' ever follows a broken pipe),
    // so a flushLogs() awaiting a paused/buffered writer resolves instead of hanging forever.
    this.sink.onClose?.(() => this.onClosed());
  }

  // The channel is unusable if the sink reports it OR it fired its async onClose hook — so a sink
  // that implements ONLY onClose (no isClosed) still un-hangs a pending flush.
  private get closed(): boolean {
    return this.hookClosed || this.sink.isClosed?.() === true;
  }

  write(line: string, droppable: boolean, terminal: boolean): void {
    // A dead channel (EPIPE) can deliver nothing — no-op, so a run that keeps logging after the pipe
    // died neither grows memory unboundedly nor pretends to buffer for a delivery that can't happen.
    if (this.closed || this.disposed) return;
    // Preserve ordering: anything already buffered (or a paused sink) queues this line behind it.
    // Only a clear channel (not paused AND nothing buffered) writes straight through.
    if (!this.paused && this.buffer.length === 0) this.pushToSink(line);
    else this.enqueue(line, droppable, terminal);
  }

  private pushToSink(line: string): void {
    if (this.sink.write(line) === false) {
      // sink.write() could (pathologically) have swapped/disposed this writer synchronously — if so,
      // don't arm a drain on the abandoned sink.
      if (this.disposed) return;
      this.paused = true;
      this.armDrain();
    }
  }

  private enqueue(line: string, droppable: boolean, terminal: boolean): void {
    // Terminal events (done/plan-summary/…) BYPASS the bound: there are only a handful per run, so
    // admitting them a few over the cap keeps memory bounded while guaranteeing they ship AND never
    // evict a counted line (which would leave their own inline suppressed count stale).
    if (this.buffer.length >= this.maxBuffered && !terminal) {
      const di = this.buffer.findIndex((p) => p.droppable);
      if (di >= 0) {
        // there is droppable telemetry to shed — drop the OLDEST of it, keep the incoming line.
        this.buffer.splice(di, 1);
        this.dropped++;
      } else if (droppable) {
        // the whole backlog is lifecycle AND the incoming line is itself droppable telemetry — drop
        // the INCOMING line rather than evict a lifecycle event (no priority inversion).
        this.dropped++;
        return;
      } else {
        // all lifecycle, incoming is lifecycle too — shed the oldest NON-TERMINAL line to stay
        // strictly bounded (the DB/report is the source of truth; stdout is live telemetry). A
        // buffered TERMINAL event is never evicted — an explicit invariant, not one that relies on
        // terminals being the last line (PR2 emits terminal events mid-run). All-terminal is
        // unreachable in practice (terminals are bounded), so admit over-cap in that case.
        const nonTerminalIdx = this.buffer.findIndex((p) => !p.terminal);
        if (nonTerminalIdx >= 0) {
          this.buffer.splice(nonTerminalIdx, 1);
          this.dropped++;
        }
      }
    }
    this.buffer.push({ line, droppable, terminal });
  }

  private armDrain(): void {
    if (this.drainArmed) return;
    this.drainArmed = true;
    this.sink.onDrain(() => {
      this.drainArmed = false;
      if (this.disposed) return; // a swapped-away writer must not flush stale lines on a late drain
      this.paused = false;
      this.flushBuffer();
    });
  }

  private flushBuffer(): void {
    if (this.disposed) return;
    // The channel died while we were paused, so no 'drain' will ever come — abandon the buffered
    // lines (undeliverable) AND un-latch `paused` so subsequent writes take the no-op fast path
    // instead of re-buffering. flushLogs() then resolves instead of hanging.
    if (this.closed) {
      this.buffer.length = 0;
      this.paused = false;
      this.resolveWaiters();
      return;
    }
    while (!this.paused && this.buffer.length > 0) {
      this.pushToSink(this.buffer.shift()!.line);
    }
    // A flush is complete only when the buffer is empty AND the sink is accepting again — a paused
    // sink still holds our last written line in ITS own buffer, so we are not yet fully flushed.
    if (!this.paused && this.buffer.length === 0) this.resolveWaiters();
  }

  // Called by the sink owner when the channel dies ASYNCHRONOUSLY (an 'error' event with no drain to
  // follow) so a flushLogs() already awaiting a paused/buffered writer resolves instead of hanging.
  onClosed(): void {
    this.hookClosed = true;
    this.flushBuffer();
  }

  // Resolve when the buffer is drained AND the sink is accepting again. A clear channel resolves at
  // once; a paused/buffered one resolves on the next drain; a dead/disposed one resolves immediately
  // (nothing to deliver). REUSABLE — never permanently closes the writer.
  flush(): Promise<void> {
    this.flushBuffer();
    if (this.disposed || this.closed || (!this.paused && this.buffer.length === 0)) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  // Swapping the sink (setLogSink/resetLogSink) must not strand a pending flush on the abandoned
  // writer, nor let a late drain flush its stale backlog through the replaced sink.
  dispose(): void {
    this.disposed = true;
    this.buffer.length = 0;
    this.resolveWaiters();
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
// The current writer's wake callback (registered via onClose). Only one writer is active at a time,
// so the latest registration wins — no listener leak across setLogSink/resetLogSink.
let stdoutCloseCb: (() => void) | null = null;
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
  onClose: (cb) => {
    stdoutCloseCb = cb;
  },
};

// ANY stdout error (EPIPE from `… | head`, or otherwise) means the channel is unusable: mark it
// closed AND wake the writer so a flushLogs() awaiting a paused/buffered writer resolves instead of
// hanging forever (a broken pipe never emits 'drain'). Non-EPIPE errors degrade the same way.
process.stdout.on("error", () => {
  stdoutClosed = true;
  stdoutCloseCb?.();
});

let writer = new BufferedWriter(DEFAULT_SINK);

// Test seam: swap in a controllable sink (and an optional small buffer bound so the drop path is
// cheap to exercise). Both dispose the outgoing writer so a pending flush is never stranded.
export function setLogSink(sink: LogSink, maxBuffered?: number): void {
  writer.dispose();
  writer = new BufferedWriter(sink, maxBuffered);
}
export function resetLogSink(): void {
  writer.dispose();
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
// backpressure; lifecycle/unit events default to non-droppable and are never dropped. `terminal`
// marks the run's final event (done/plan-summary) — it bypasses the buffer bound so it is never
// evicted and its own inline counters stay exact.
export function logLine(event: Record<string, unknown>, opts?: { droppable?: boolean; terminal?: boolean }): void {
  // bump FIRST so the heartbeat sampler counts this write even if serialization below throws.
  activitySeq++;
  const line: Record<string, unknown> = { ts: new Date().toISOString() };
  for (const key of Object.keys(event)) if (key !== "ts") line[key] = event[key];
  writer.write(JSON.stringify(line) + "\n", opts?.droppable === true, opts?.terminal === true);
}

// Awaited by every entrypoint's finally so buffered events (above all the terminal `done`/summary
// lines) reach stdout before the process exits. Resolves immediately on a clear or dead channel.
export function flushLogs(): Promise<void> {
  return writer.flush();
}
