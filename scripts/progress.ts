// progress.ts — the in-process progress hub + the ONE TUI-failure latch (§U2 of PROMPT-TUI.md).
// Dependency-free LEAF module (core code may import it; it imports nothing), push-only, ephemeral
// display plumbing: the stdout JSONL stream stays the durable record. This is NOT the JSONL
// vocabulary — the discriminant key is `type` (never the JSONL `event`/`action` keys), so the
// vocabulary scan cannot conflate the two.
//
// Discipline (§U0): with no sink installed — the permanent state of every non-TUI run —
// `emitProgress` is a single null-check, and instrumentation sites gate ALL argument/label
// construction behind `hasProgressSink()`, so a bare run does zero extra work beyond that check.

export type ProgressEvent =
  | { type: "phase"; phase: "preflight" | "resolve-owners" | "cli-terms" | "scan" | "reconcile" | "report" }
  | { type: "spawn-start"; id: number; tool: "gh" | "git" | "tar"; label: string }
  | { type: "spawn-end"; id: number }
  | { type: "spawn-queue"; waiting: number } // semaphore waiter gauge
  | { type: "fetch-start"; id: number; kind: "packument" | "tarball" | "registry-probe"; label: string }
  | { type: "fetch-end"; id: number }
  | { type: "rate-limit"; resource: "core" | "graphql"; remaining: number | null; limit: number | null; resetEpochSec: number | null }
  | { type: "rate-limit-seed"; resource: "core" | "graphql"; remaining: number | null }
  // Split by `state`: `reason` is REQUIRED for "exhausted" and rejected for "armed"/"waiting" (§U4).
  // The producer-side guarantee is the rest-tuple emitThrottle (github.ts): no call site can attach a
  // reason off "exhausted". On the type itself, `reason?: never` rejects any concrete reason VALUE
  // ("budget"/"retries") on armed/waiting, including non-fresh objects. (A present `reason: undefined`
  // is still accepted — the project's tsconfig omits exactOptionalPropertyTypes — but it is
  // semantically absent and the fold reads `reason` only for "exhausted".) Net: the store fold can
  // never route a forgotten/future exhaustion reason into the transient retry counter instead of the
  // sticky budget flag without a compile error.
  | { type: "throttle"; bucket: "core" | "graphql"; state: "armed" | "waiting"; reason?: never; untilMs: number | null; budgetSpentMs: number }
  | { type: "throttle"; bucket: "core" | "graphql"; state: "exhausted"; reason: "budget" | "retries"; untilMs: number | null; budgetSpentMs: number }
  | { type: "owner-start"; owner: string }
  | { type: "owner-end"; owner: string }
  | { type: "repo-start"; owner: string; repo: string }
  | { type: "repo-end"; owner: string; repo: string }
  | { type: "unit-dispatch"; owner: string; repo: string; branch: string }
  | { type: "unit-settle"; owner: string; repo: string; branch: string }
  | { type: "unit-start"; owner: string; repo: string; branch: string } // a real scan began
  | { type: "introspect-start"; id: number; packageName: string; version: string }
  | { type: "introspect-end"; id: number }
  | { type: "divert"; path: string } // the ACTUAL opened log path (post-retry suffix)
  | { type: "jsonl"; event: Readonly<Record<string, unknown>> }; // the log tap

// Events carry NO timestamps (§U2): the store stamps arrival with its own injected clock, so
// instrumented modules gain no clock plumbing and tests stay deterministic.

let activeSink: ((e: ProgressEvent) => void) | null = null;

export function setProgressSink(sink: ((e: ProgressEvent) => void) | null): void {
  activeSink = sink;
}

// Gate ALL derivation work (labels, snapshot objects) behind this (§U0 no-hot-path-cost rule).
export function hasProgressSink(): boolean {
  return activeSink !== null;
}

// TOTAL error rendering: even a hostile thrown value (a throwing toString/message getter) must
// not make the never-throws functions below throw. Exported as the ONE cause→string primitive:
// mount.tsx uses it as-is, lifecycle.ts wraps it in sanitizeLine. progress.ts stays a dependency-
// free leaf — this is an EXPORT, not a new import.
export function causeText(e: unknown): string {
  try {
    if (e instanceof Error && typeof e.message === "string") return e.message;
    return String(e);
  } catch {
    return "unprintable error";
  }
}

// NEVER throws: the first sink throw clears the sink (later emits are single null-checks again)
// and latches the failure — the reaction (degrade) belongs to the lifecycle's guarded sink
// closure, which catches its own store errors before they ever reach this backstop (§U1).
export function emitProgress(e: ProgressEvent): void {
  const sink = activeSink;
  if (sink === null) return;
  try {
    sink(e);
  } catch (err) {
    activeSink = null;
    reportTuiFailure(causeText(err));
  }
}

// Module-local monotonic id so start/end span pairing is exact even for identical labels (§U2).
let idCounter = 0;
export function nextProgressId(): number {
  return ++idCounter;
}

// ---- the ONE TUI-failure latch ---------------------------------------------------------------
// Structured, because "first cause wins" alone cannot answer the question teardown must answer
// (is the divert file partial?) when the divert dies SECOND (§U2). Every dashboard failure —
// sink, tap, divert write, tick, render, exit rejection — funnels through here, so the App's
// tick and the lifecycle's teardown observe a single source of truth and the end-of-run warning
// names the FIRST cause.
interface TuiFailureState {
  firstCause: string;
  divertFailedMidRun: boolean;
}
let failure: TuiFailureState | null = null;

export function reportTuiFailure(cause: string): void {
  if (failure === null) failure = { firstCause: cause, divertFailedMidRun: false };
}

// Sets the divert flag AND reports: tracked independently of whichever failure latched FIRST.
export function reportDivertFailure(cause: string): void {
  if (failure === null) failure = { firstCause: cause, divertFailedMidRun: true };
  else failure.divertFailedMidRun = true;
}

export function tuiFailure(): { firstCause: string; divertFailedMidRun: boolean } | null {
  return failure === null ? null : { ...failure };
}

// Called by runWithTui at lifecycle start (a fresh lifecycle starts with a clean latch) and by
// test teardown hygiene (§U8).
export function resetTuiFailure(): void {
  failure = null;
}
