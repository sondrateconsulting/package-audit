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
export function logLine(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}
