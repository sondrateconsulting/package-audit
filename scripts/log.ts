// log.ts — the ONE stdout JSONL writer (§6/§8 observability). stdout is machine-readable
// exclusively: one structured JSON event per line, safe to pipe; anything human-facing goes to
// stderr. Shared so every module that records a fail-soft failure can pair its DB error row
// with a live event (orchestrate.ts for discovery/unit events, apiSurface.ts for per-version
// introspection failures) without routing through the coordinator.
//
// ONE ATOMIC WRITE PER EVENT (load-bearing under fan-out): the complete line — JSON body + the single
// trailing "\n" — is assembled into ONE string and handed to the active sink in a SINGLE call, so
// logLine never splits an event across multiple writes. JSON.stringify escapes any interior newline, so
// the only real line break is the trailing one; each event is therefore exactly one line. This process
// is the sole writer to stdout (subprocess output is captured via pipes, never inherited to the parent
// fd) and Node/Bun stream writes are ordered, so concurrently-produced events queue and emit whole, one
// after another — they never interleave. This is NOT a kernel-level >PIPE_BUF atomicity claim (a lone
// >64KB write to a pipe shared with an INDEPENDENT process could still be split by the OS); it is the
// in-process guarantee that the JSONL a consumer parses is always whole lines. Enforced by log.test.ts.
//
// SINK/TAP SEAM (PROMPT-TUI §U1) — dependency-free, injected; this module imports nothing new.
// The default sink is process.stdout; an interactive TUI run may divert the IDENTICAL bytes to a
// log file by installing a sink. The tap observes the parsed event AFTER the durable write (a tap
// crash can never lose the line). Failure semantics:
//   - a THROWING SINK: logLine restores the stdout sink and re-emits the SAME line to stdout in
//     the same call (no event is lost); the reaction (seal/latch/degrade) belongs to the installed
//     sink closure, which runs before its rethrow reaches here (lifecycle.ts builds it).
//   - a THROWING TAP: self-clears (this module nulls it) and never escapes; the installed tap
//     closure likewise reports/degrades itself before anything reaches this backstop.
export type LogSink = (line: string) => void;
export type LogTap = (event: Readonly<Record<string, unknown>>) => void;

let activeSink: LogSink | null = null; // null = the stdout default
let activeTap: LogTap | null = null;

export function setLogSink(sink: LogSink | null): void {
  activeSink = sink;
}

export function setLogTap(tap: LogTap | null): void {
  activeTap = tap;
}

export function logLine(event: Record<string, unknown>): void {
  const line = JSON.stringify(event) + "\n";
  const sink = activeSink;
  if (sink === null) {
    process.stdout.write(line);
  } else {
    try {
      sink(line);
    } catch {
      // Divert-failure transition (§U1): the closure already sealed the frame and latched; here
      // the durable stream reroutes to stdout and the FAILING line is re-emitted — no loss.
      activeSink = null;
      process.stdout.write(line);
    }
  }
  const tap = activeTap;
  if (tap !== null) {
    try {
      tap(event);
    } catch {
      activeTap = null; // self-clear: a broken tap must not throw again on every later event
    }
  }
}
