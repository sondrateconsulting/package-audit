# PROMPT-TUI — live terminal dashboard for `bun run audit` (Ink on stderr)

You are implementing a read-only, display-only terminal dashboard for this repository's
`bun run audit` command (scripts/orchestrate.ts), built on Ink (React for CLIs,
https://github.com/vadimdemedes/ink). The dashboard shows, live: every network operation
in progress, every unit of work in progress (owners, repos, branch units, registry
introspection), recent errors, and the current GitHub rate-limit / throttle / concurrency
state. It renders to **stderr**; **stdout remains the machine-readable JSONL stream,
byte-for-byte unchanged in every non-interactive invocation**.

This document is self-contained but SUBORDINATE to PROMPT.md: every §0–§8 invariant there
still binds. Section references written `§N` in the codebase and in this document refer to
PROMPT.md; this document's own sections are `§U0`–`§U12`. Where the two could be read to
conflict, PROMPT.md wins and the conflict is a bug in this document — stop and surface it.

Operator decisions already made (do not relitigate):
1. Deliverable: this TUI, display-only in v1 (no keybindings, no pause/resume).
2. Interactive runs (stdout is a TTY) divert the JSONL stream to a log file — identical
   bytes, different destination. Piped/redirected runs are untouched.
3. The limits panel covers all four surfaces: REST+GraphQL rate limits, throttle/pause
   state, orchestrator work occupancy, and the subprocess semaphore.
4. Runtime: Ink + React as real dependencies (exact-pinned). The README's dependency-count
   claim is updated honestly (§U9).

================================================================================
U0. NON-NEGOTIABLES (inherited invariants + this feature's own)
================================================================================
- **stdout JSONL purity (§6/§8).** stdout carries exclusively one-line JSON events via
  `logLine` (scripts/log.ts). The TUI writes NOTHING to stdout, ever. In every mode where
  stdout JSONL flows today, it continues to flow with IDENTICAL bytes: no new event
  types, no field changes, no reordering beyond what already varies run-to-run. The
  vocabulary freeze is enforced by scripts/logVocab.test.ts; this feature must not add,
  remove, or alter any `event:`/`action:` literal.
- **One sink call per event (log.ts).** The whole line — JSON + trailing `\n` — is one
  string handed to ONE sink invocation. The stdout sink is one `process.stdout.write`
  as today; the divert sink delivers the complete line to the fd via a short-write loop
  (§U1) — still one logical write per event, order-preserving by construction. Enforced
  by log.test.ts, extended in §U8.
- **github.ts stays the ONLY spawner (§6).** The TUI and its plumbing spawn nothing. The
  `Bun.spawn|spawnSync|$` source scan in github.test.ts already walks scripts/
  recursively and includes .tsx — the new files are in scope automatically; do not
  weaken it.
- **Read-only guard and write containment (§0).** The ONLY new write surface is the
  divert log file, which must live under the configured `outputDir` and pass
  `assertContained` (scripts/readOnlyGuard.ts) before opening. TUI modules perform no
  other filesystem writes (grep-enforced, §U8).
- **`--plan` writes nothing (§8).** Plan mode never diverts and never mounts the TUI in
  v1 (§U1, §U11). Its stdout/stderr behavior is byte-identical to today.
- **config_hash is untouchable.** NO new config.json keys. `config_hash` is computed from
  the normalized config content; adding a key changes the normalized form, which changes
  the hash, which orphans every resumable run. Activation is via CLI flags + runtime
  environment (TTY/TERM/CI/size) only.
- **The TUI must degrade, never kill the run — with no exceptions.** A failure anywhere
  in the dashboard — dependency load, mount, DIVERT OPEN, divert write, tick, render,
  event handling — disables the dashboard, reroutes JSONL to stdout where the divert was
  involved, and lets the audit continue. Teardown itself is total AND single-flight:
  every step is individually guarded, a teardown failure becomes a deferred warning
  line, a payload error already propagating is NEVER masked by cleanup, concurrent
  degrade/finally callers converge on ONE cached teardown, and the render stream is
  SEALED at teardown end so even a wedged Ink can never write over later output (§U6).
  The audit is the payload; the TUI is observability.
- **No timing changes on hot paths.** Every emission is a synchronous, O(1), no-await,
  no-throw call, and ALL derivation/allocation work (labels, snapshot objects) is gated
  behind `hasProgressSink()` — a run with no sink does zero extra work beyond that
  check. Nothing new is awaited inside the semaphore lease, the throttle arm/release
  window, or the unit RMW blocks orchestrate.ts documents as await-free.
- **Display-only.** No `useInput`, no raw mode, `exitOnCtrlC: false`. Ctrl+C keeps its
  current semantics: SIGINT kills the process and the run resumes next invocation (§3).
  THIS FEATURE'S CODE installs no signal handlers; Ink itself registers signal-exit
  cleanup (cursor restore) internally — that is accepted, and P0 verifies under Bun that
  a mid-render SIGINT still kills the process, leaves the terminal usable, and leaves
  the run resumable.
- **Rendered text is sanitized.** Every dynamic string the dashboard displays — spawn
  labels, error messages (which can embed child-process stderr), branch/repo names —
  passes `sanitizeLine` (§U5): C0/C1 controls and ANSI escape sequences stripped,
  newlines collapsed, ONE display line forced, before Ink truncation. Child output must
  never be able to inject terminal control through the dashboard.

================================================================================
U1. ACTIVATION & STREAM ROUTING
================================================================================
### Flags (scripts/args.ts)
Add `--ui` and `--no-ui` to `BOOL_FLAGS` and `OrchestrateArgs` (`ui: boolean | null`,
null = auto). Pure-parser rules, house style (fail fast, actionable):
- `--ui` and `--no-ui` together → `ArgsError("--ui and --no-ui are mutually exclusive")`.
- `--ui` with `--plan` → `ArgsError` ("plan mode has no dashboard; run --plan without
  --ui"). `--no-ui` with `--plan` is allowed (harmless explicit no-op). This is the ONE
  plan-mode UI rule; the matrix below lists plan rows as "off" for every non-rejected
  combination.
- Each rejects a `--flag=value` attached form, like the other BOOL_FLAGS.
Update `ORCHESTRATE_USAGE` + `ORCHESTRATE_HELP` (and the grammar comments atop args.ts
and orchestrate.ts) to name both flags.

### Activation decision — a PURE, table-tested function
```ts
// scripts/tui/activation.ts (React-free, Ink-free — importable from orchestrate.ts)
export interface ActivationInput {
  plan: boolean; uiFlag: boolean | null;           // from OrchestrateArgs
  stderrIsTTY: boolean; stdoutIsTTY: boolean;       // from the real streams
  columns: number | undefined; rows: number | undefined;  // stderr dimensions
  term: string | undefined; ci: boolean;            // TERM, and CI env truthiness
}
export type ActivationDecision =
  | { mode: "off" }
  | { mode: "on"; divert: boolean }
  | { mode: "error"; message: string };             // --ui in an ineligible environment
export function decideTuiActivation(i: ActivationInput): ActivationDecision;
```
Rules (normative; the function IS the matrix, unit-tested row by row):
- eligibility = `stderrIsTTY && term !== "dumb" && !ci && (columns ?? 0) >= 40 &&
  (rows ?? 0) >= 5`. CI is `CI` set and non-empty (Ink itself degrades under CI, and CI
  consumers expect stdout JSONL — auto mode must never divert there). Undefined
  dimensions are ineligible. A terminal that SHRINKS below the floor mid-run is a render
  concern (§U5), not an activation concern.
- `plan` → off (the `--ui`+`--plan` combination never reaches here — args.ts rejected it).
- `uiFlag === false` → off.
- `uiFlag === true && !eligible` → error, message naming the concrete blocker
  ("--ui requires an interactive stderr terminal: TTY, TERM not 'dumb', not CI, at
  least 40x5"). main() renders it through the existing operator-error path (cliErrors.ts
  house pattern), exit 1. An ineligible ENVIRONMENT is an operator error only when the
  operator explicitly demanded the UI; auto mode just runs without it.
- `uiFlag === true || (uiFlag === null && eligible)` → on; `divert = stdoutIsTTY`.
- NO_COLOR is NOT consulted: it affects styling only (chalk honors it), never routing.

| stderr TTY | stdout TTY | env               | flags     | TUI | JSONL destination      |
|-----------:|-----------:|-------------------|-----------|-----|------------------------|
| yes        | yes        | interactive       | auto/--ui | on  | **divert file**        |
| yes        | no (piped) | interactive       | auto/--ui | on  | stdout, unchanged      |
| yes        | any        | CI/dumb/too-small | auto      | off | stdout, unchanged      |
| yes        | any        | CI/dumb/too-small | --ui      | —   | fail fast (op. error)  |
| no         | any        | any               | auto      | off | stdout, unchanged      |
| no         | any        | any               | --ui      | —   | fail fast (op. error)  |
| any        | any        | any               | --no-ui   | off | stdout, unchanged      |
| any (--plan) | any      | any               | (no --ui) | off | stdout, unchanged      |

The divert exists for exactly one reason: with both streams on the same terminal, raw
JSONL would interleave with the dashboard frame. It fires ONLY when the TUI actually
mounts AND stdout is a TTY. Every other cell is byte-identical to today.

### Divert sink — synchronous fd, short-write-safe
`createWriteStream` opens asynchronously and reports failures via a later 'error'
event — wrong shape for a sink that must be usable before the first logLine. Use the
synchronous trio:
- Path: `logPathFor(outputDir, stamp, pid, attempt)` — a pure exported helper
  (unit-tested) yielding `<outputDir>/logs/audit-log-<UTC yyyyMMddTHHmmssZ>-p<pid>.jsonl`
  for attempt 0 and a `-2`, `-3` … suffix for retries. Before opening: resolve,
  `assertContained` under the configured `outputDir`, `mkdirSync(logsDir,
  { recursive: true })`.
- Open: the LIFECYCLE loops attempts 0..9 calling `divertIo.open(candidate)` —
  `openSync(path, "wx", 0o644)` underneath (synchronous, exclusive) — treating `EEXIST`
  as try-next; it records WHICH candidate succeeded (the actual path feeds the footer
  event and the exit line — a retried suffix must never be announced as the base name).
  ANY other open/mkdir failure, or exhaustion, DEGRADES per §U6: tear down the
  just-mounted dashboard, warn once, run bare with JSONL on stdout — never fatal, never
  silent-divert-to-terminal. (§U0's degrade rule has no exceptions; an unwritable
  outputDir will still fail the run honestly later, at report time, exactly as today.)
- Write: the sink loops `writeSync(fd, buf, offset)` until the WHOLE line is written
  (writeSync may write short without throwing) — one logical write per event, ordering
  and whole-line delivery by construction. A returned count `<= 0` (or any invalid
  count) is a WRITE FAILURE, not a retry — it enters the failure transition below (an
  unchanged infinite retry would hang the audit). A crash can still truncate the FINAL
  line mid-write; consumers of the file must tolerate a partial last line (documented,
  §U9). Sync-write latency on a local file is accepted and confined to the interactive
  case.
- Close: `closeSync(fd)` during teardown; a close failure warns, nothing more. No
  fsync — the DB, not the log, is the durable state.
- Mid-run write failure (disk full, fd revoked, nonpositive write count): logLine's
  sink wrapper, IN THE SAME CALL and in THIS order: (1) `sealEarly()` the render proxy
  — synchronous seal + immediate cursor-show compensation (§U1 proxy contract), so the
  frame stops writing BEFORE any JSONL reaches a same-terminal stdout (no interleaving
  window, not even one tick) and a SIGINT during the unmount wait cannot strand a
  hidden cursor; (2) restore the stdout sink and re-emit the failing line (no event is
  lost); (3) `reportDivertFailure`; (4) `degradeNow`. The exit line then reads
  `JSONL log (partial — divert failed mid-run, remainder went to stdout): <path>`.

### log.ts seam (dependency-free, injected — log.ts imports nothing new)
```ts
export type LogSink = (line: string) => void;
export function setLogSink(sink: LogSink | null): void;  // null restores stdout
export function setLogTap(tap: ((event: Readonly<Record<string, unknown>>) => void) | null): void;
```
`logLine` builds the ONE line exactly as today, hands it to the active sink (default
`process.stdout.write`), THEN calls the tap (the durable line can never be lost to a tap
crash). A throwing SINK triggers the divert-failure transition above (logLine catches,
reroutes to stdout re-emitting the line, and the sink CLOSURE — built by main, so log.ts
stays dependency-free — reports to the §U2 latch). A throwing TAP self-clears and
reports likewise. Neither ever escapes `logLine`.

### main() sequencing (normative — one lifecycle owner, one composition seam)
The TUI lifecycle is owned by an extracted, testable wrapper:
```ts
// scripts/tui/lifecycle.ts (React-free; dynamic-imports mount.tsx)
export interface TuiDeps {   // every impure edge injectable; production defaults provided
  decision: ActivationDecision;
  mountImpl?: () => Promise<{ mountTui: typeof mountTui }>;   // default: import("./mount.tsx")
  divertIo?: { open(path: string): number;                     // openSync "wx"; throws EEXIST
               write(fd: number, line: string): void;          // short-write loop inside
               close(fd: number): void };
  logPathFor?: (attempt: number) => string;                    // pure candidate builder
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  streams: { stderr: NodeJS.WriteStream };
  nowMs?: () => number;
}
export async function runWithTui<T>(deps: TuiDeps, body: () => Promise<T>): Promise<T>;
```
`runWithTui` performs, in order: `resetTuiFailure()` (a fresh lifecycle starts with a
clean latch) → wrap `deps.streams.stderr` in the SEALABLE PROXY (below) → mount against
the proxy (via dynamic import; §U5) → re-check the lifecycle state (a mount-time
degrade may have already torn down — see the reentrancy barrier, §U6): if teardown has
started, UNWIND the late-arriving handle — teardown ran its steps with a null handle,
so the unwind performs the handle-specific ones itself (`dispose()`, then
`requestUnmount()` + the bounded exit wait; the proxy is already sealed, so a late
frame cannot smear output — the unwind is about not leaking Ink's timers/hooks) — and
run bare → otherwise, on mount success ONLY: install the GUARDED progress sink —
`setProgressSink(e => { try { store.dispatch(e); } catch (err) {
setProgressSink(null); reportTuiFailure(String(err)); degradeNow(); } })` — the catch
CLEARS the sink synchronously (later emits must not keep throwing/allocating until
teardown reaches the seams) and the reaction lives HERE, where degradeNow exists: a
store fold bug degrades immediately, never waits for a tick → `setLogTap(ev => {
if (hasProgressSink()) emitProgress({ type: "jsonl", event: ev }); })` (the guard
keeps the tap allocation-free once the sink is gone — §U0) → divert mode only: run the
open loop, `setLogSink(divertSink)`, and `emitProgress({ type: "divert", path })` with
the ACTUAL opened path; an open failure AWAITS `teardownOnce()` before continuing (the
frame must be fully down BEFORE JSONL starts flowing to a same-terminal stdout —
fire-and-forget is only for mid-body sites that cannot await, like the logLine
closure) → FINAL state check: any setup step — including a synchronous one like that
divert-event emission tripping the guarded sink — may have started teardown; if so,
AWAIT `teardownOnce()` now, so `body()` always starts with the lifecycle either fully
ON or fully torn down, never mid-collapse → await `body()` → finally: await
`teardownOnce()` (§U6). The degrade channel is DIRECT, not
tick-dependent: runWithTui builds `degradeNow = () => void teardownOnce()` and hands it
to the sink closures, to `mountTui` as `onDegrade`, and (via mount) to the
waitUntilExit rejection handler and the error boundary; the App tick's latch check
(§U5) is belt-and-braces, not the mechanism. Any failure at any step degrades per §U6
and `body()` runs regardless. orchestrate's `main` calls `runWithTui` with production
deps around its existing post-loadConfig body; tests drive `runWithTui` directly with
fake mounts/io/streams/timers (§U8.13). The import.meta.main entrypoint (renderFatal +
exit 1) is unchanged and stays covered by the existing entrypoint tests.

### The sealable stderr proxy (owned by lifecycle.ts — Ink's whole world)
A minimal WriteStream facade with exactly three jobs, all load-bearing:
1. **Transparent while live**: forwards `write()` to the real stderr and DELEGATES
   `isTTY`, `columns`, `rows`, and `resize` listener registration (getter/passthrough)
   to the real stream — Ink must see a real interactive TTY (size tracking, §U5) and
   chalk must detect color exactly as before. Anything Ink reads that the proxy does
   not implement falls through to the real stream's value.
2. **Absorbing**: an underlying write's synchronous throw, callback error, or 'error'
   event is CONSUMED — latch (`reportTuiFailure`) + `degradeNow` + count it, always
   acknowledge Ink's callback as complete — a broken stderr must degrade the
   dashboard, never throw into React internals or kill the audit.
3. **Sealed**: after `seal()` (idempotent), writes are counted-and-dropped; delegated
   TTY properties keep answering. Sealing is SYNCHRONOUS and safe to call from any
   failure site. `sealEarly()` — the form every PRE-unmount seal site uses (the
   divert-failure transition, §U1) — seals and IMMEDIATELY writes the cursor-show
   escape (`ESC[?25h`) to the REAL stderr in the same synchronous step: Ink hid the
   cursor at mount and its own restore write would be dropped by the seal, and a
   SIGINT landing inside the unmount wait must not strand a hidden cursor. Idempotent;
   §U6's teardown treats it as already-compensated.

Order of operations in main: parseArgs → help? → loadConfig → `decideTuiActivation`
(inputs from the real streams/env) → wrap everything from the `config` logLine through
runScan in `runWithTui` → after it returns: the success summary. One refactor beyond
insertion points makes that ordering possible: `runScan` currently writes the human
summary itself (orchestrate.ts:339). Move the write to the caller — `runScan` returns
`{ runId, summary, errorCount, reportPath, warnings } | null` (null for the
owner-discovery-throttled clean exit) and `main` renders `runSummaryText` AFTER
teardown. On a thrown error, teardown runs in `runWithTui`'s finally and the existing
import.meta.main catch prints renderFatal below the terminated frame. `runSummaryText`
itself, the `done` event, and plan mode's `planSummaryText` are unchanged; update the
orchestrate tests that pin the old write site (the TEXT stays pinned by the existing
runSummaryText unit tests).

One-line preflight truthfulness fix (§U3.2): construct the preflight client WITH
`concurrency: config.concurrency.repositories`. Preflight's calls are sequential
one-shot awaits, so the semaphore width is never contended — zero behavioral change —
but the subprocess-cap gauge is then honest for the whole run.

================================================================================
U2. THE PROGRESS HUB (scripts/progress.ts — new, dependency-free)
================================================================================
One in-process, typed, push-only event hub, plus the single TUI-failure latch. The JSONL
stream stays the durable record; the hub is ephemeral display plumbing. It is NOT the
JSONL vocabulary: its discriminant key is `type` (never `event:`/`action:`), so the
logVocab scan cannot conflate them.

```ts
export type ProgressEvent =
  | { type: "phase"; phase: "preflight" | "resolve-owners" | "cli-terms" | "scan"
      | "reconcile" | "report" }
  | { type: "spawn-start"; id: number; tool: "gh" | "git" | "tar"; label: string }
  | { type: "spawn-end"; id: number }
  | { type: "spawn-queue"; waiting: number }        // semaphore waiter gauge
  | { type: "fetch-start"; id: number;
      kind: "packument" | "tarball" | "registry-probe"; label: string }
  | { type: "fetch-end"; id: number }
  | { type: "rate-limit"; resource: "core" | "graphql";
      remaining: number | null; limit: number | null; resetEpochSec: number | null }
  | { type: "rate-limit-seed"; resource: "core" | "graphql"; remaining: number | null }
  | { type: "throttle"; bucket: "core" | "graphql";
      state: "armed" | "waiting" | "exhausted";
      reason?: "budget" | "retries";                 // exhausted only
      untilMs: number | null; budgetSpentMs: number }
  | { type: "owner-start"; owner: string } | { type: "owner-end"; owner: string }
  | { type: "repo-start"; owner: string; repo: string }
  | { type: "repo-end"; owner: string; repo: string }
  | { type: "unit-dispatch"; owner: string; repo: string; branch: string }
  | { type: "unit-settle"; owner: string; repo: string; branch: string }
  | { type: "unit-start"; owner: string; repo: string; branch: string }  // scan began
  | { type: "introspect-start"; id: number; packageName: string; version: string }
  | { type: "introspect-end"; id: number }
  | { type: "divert"; path: string }   // the ACTUAL opened log path (post-retry suffix)
  | { type: "jsonl"; event: Readonly<Record<string, unknown>> };  // the logLine tap
```
Semantics worth pinning:
- `unit-dispatch`/`unit-settle` bracket the WHOLE branch-pool worker body (including
  skip-current and abort-return paths, via finally) — they are the truthful pool-slot
  occupancy signal. `unit-start` fires only when a real scan begins (just before the
  `in_progress` status write); the active-scan list keys off it and is CLEARED by
  `unit-settle`, never by tapped JSONL events (the `scanned` line fires before cleanup
  finishes, and fatal escapes emit no terminal unit line at all — settle is the only
  reliable end).
- There is deliberately NO `throttle: cleared` event: with concurrent callers the pause
  horizon can be extended while another caller wakes, so "cleared" cannot be emitted
  race-free. The store renders PAUSED while `untilMs > now` — time, not events, clears it.
- `exhausted` carries `reason`: `"budget"` (waitBucket's unfunded-tail throw — the
  cumulative pause budget is spent, a run-level condition) vs `"retries"` (a MAX_ATTEMPTS
  terminal throw — one call gave up). Only `"budget"` sets the sticky store flag.
- `rate-limit-seed` (from preflight's report) folds ONLY into a resource slot that has
  no live snapshot yet; a live `rate-limit` always wins (the preflight REST calls
  themselves already emit live snapshots through the §U3 seam — the seed must not
  clobber them with nulls).
- `id` comes from a module-local monotonic counter (`nextProgressId()`), so start/end
  pairing is exact even for identical labels.

API and discipline:
```ts
export function setProgressSink(sink: ((e: ProgressEvent) => void) | null): void;
export function hasProgressSink(): boolean;   // gate ALL derivation work behind this
export function emitProgress(e: ProgressEvent): void;
// The ONE TUI-failure latch (also fed by the log-sink/tap closures, §U1). Structured,
// because "first cause wins" alone cannot answer the question teardown must answer
// (is the divert file partial?) when the divert dies SECOND:
export function reportTuiFailure(cause: string): void;        // first cause retained
export function reportDivertFailure(cause: string): void;     // sets the flag AND reports
export function tuiFailure(): { firstCause: string; divertFailedMidRun: boolean } | null;
export function resetTuiFailure(): void;   // called by runWithTui at lifecycle start; tests
```
- With no sink installed (the permanent state of every non-TUI run), `emitProgress` is a
  single null-check; instrumentation sites gate argument construction behind
  `hasProgressSink()` (§U0).
- `emitProgress` NEVER throws: the sink call is wrapped; the first sink throw clears the
  sink and calls `reportTuiFailure`. The latch is the ONE channel every dashboard
  failure funnels through — sink, tap, divert write, tick, render — so the App's tick
  and `runWithTui`'s teardown observe a single source of truth (§U5/§U6), and the
  end-of-run warning names the first cause.
- Events carry NO timestamps. The store stamps arrival time with its injected clock
  (§U4) — instrumented modules gain no clock plumbing, and tests stay deterministic.

================================================================================
U3. INSTRUMENTATION SEAMS (exact anchors; smallest honest touch at each)
================================================================================
All emissions are hub events (§U2). None are logLine calls. None add awaits. Import
`emitProgress`/`hasProgressSink` from scripts/progress.ts (a leaf module — no cycles).

1. **Subprocesses — github.ts `spawnBounded`** (the one funnel every gh/git/tar spawn
   flows through, preflight and plan included). Because `binPaths` is injectable and
   tests point several tools at the same binary, the tool CANNOT be inferred from the
   path: thread an explicit discriminant — `spawnBounded(tool: "gh"|"git"|"tar", bin,
   args, opts)` — from its call sites (`gh()`, `git()`, `tar()`, `ghBucketedAttempt`),
   which each know what they are. Emit `spawn-start` immediately before `this.spawn(...)`
   and `spawn-end` in a finally around the attempt (deadline timeouts and byte-cap kills
   still end their span). Labels come from a PURE, TOTAL, never-throwing exported helper
   `spawnLabel(tool, args)` — `gh api <endpoint>` / `gh api graphql` / `gh <verb>` /
   `git clone <owner/repo>` (parsed from the URL positional) / `git <verb>` /
   `tar extract|list|--version` — capped at 100 chars, built ONLY when
   `hasProgressSink()`. argv never carries credentials (§6), but the label is still
   allowlist-shaped, not a raw argv join. Unit-test the helper directly.
2. **Semaphore pressure — github.ts `Semaphore`**: optional constructor callback
   `onWaitersChanged?: (waiting: number) => void`, invoked synchronously whenever the
   waiter queue grows or shrinks; GithubClient passes one that emits `spawn-queue`.
   In-flight count needs no event — it is the store's live spawn-span set. With the
   preflight client now constructed at the configured concurrency (§U1), the cap gauge
   is truthful from the first frame; both clients emit through the same hub — SPANS
   aggregate (id-keyed map entries), while the scalar waiter gauge is OVERWRITTEN by
   each emission and stays truthful because the clients' lifetimes are sequential
   (preflight completes before the scan client works).
3. **Rate-limit snapshots — via the analyze RETURN value, derived outside.** The
   response headers exist ONLY inside `restGet`/`graphql`'s per-attempt `analyze`
   closures, which `ghBucketedAttempt` documents as PURE — do not emit from inside
   them, and do not build snapshot objects unconditionally. Extend the analyze contract
   with DATA only: `{ outcome; pauseUntilMs; rateLimitHeaders?: Record<string,string> }`
   — each closure returns the headers object it ALREADY parsed (a reference, zero new
   allocation, purity intact; omit on the no-response path). `ghBucketedAttempt` —
   already impure — then, `if (pauseUntilMs !== null) arm; if (rateLimitHeaders !==
   undefined && hasProgressSink()) emit` the derived `rate-limit` event (never
   truthiness — a zero-valued injected horizon must not change the contract)
   (resource = the bucket,
   whose `label` field is retyped from `string` to `"core" | "graphql"`), all before
   releasing the slot. Coverage rule: the zero-network immutable-cache return emits
   nothing (no request happened), but a conditional 304 revalidation IS a live response
   with live headers — its snapshot is emitted like any other, on error/retry attempts
   as well as successes.
4. **Throttle state — github.ts.** Refactor `armBucketPause` to single-exit (its two
   early returns become one try/finally) and emit `state:"armed"` ONCE in the finally —
   after the horizon publish AND the funding logic — carrying the published horizon and
   the POST-funding `budgetSpentMs`, so the displayed budget is never one arm behind.
   `waitBucket` emits `state:"waiting"` (with the horizon it is about to sleep to)
   before its sleep. Every site that CONSTRUCTS `ThrottleExhausted` emits
   `state:"exhausted"` first: waitBucket's unfunded-tail throw with
   `reason:"budget"`; both MAX_ATTEMPTS terminal throws (REST and GraphQL loops) with
   `reason:"retries"`. No "cleared" exists (§U2).
5. **Registry network — apiSurface.ts + preflight.ts.** Three seams:
   the packument fetch in `fetchPackument` and the tarball fetch in `introspectVersion`
   wrap their `fetchFollowing` calls with `fetch-start`/`fetch-end` (finally); the
   §2.5 registry REACHABILITY probe in preflight.ts (native fetch — the one registry
   call outside apiSurface) gets the same pair with `kind:"registry-probe"`. A span
   covers the LOGICAL fetch including its internal redirect hops (hops are not
   individually emitted). Labels: `packument <name>` / `tarball <name>@<version>` /
   `registry probe` — never the URL (the registry may be private), never headers.
   Scope note: the fetch span is HTTP transfer only; verification/extraction/scanning
   after the tarball lands is WORK, surfaced by seam 7 — the network panel never
   pretends the whole introspection is a download.
6. **Orchestrator work — orchestrate.ts.**
   - `phase` events: "preflight" before runPreflight; "resolve-owners" before
     resolveOwnersWithDiscovery; "cli-terms" before discoverCliTerms; "scan" before the
     owner pool; "reconcile" before reconcileIntrospection; "report" before
     emitReportDetailed.
   - `owner-start`/`owner-end` wrap the `processOwner` call inside the owner-pool worker
     (end in finally). `repo-start`/`repo-end` wrap the `processRepo` call inside
     processOwner's repo loop (finally).
   - `unit-dispatch` first thing inside the branch-pool worker; `unit-settle` in a
     finally around the entire worker body; `unit-start` immediately before
     `db.setUnitStatus(key, { status: "in_progress", … })` (§U2 semantics).
   - After `runPreflight` returns, emit `rate-limit-seed` for core and graphql from the
     (nullable) `coreRemaining`/`graphqlRemaining` — fold-if-absent only (§U2).
7. **Introspection work — apiSurface.ts `introspectVersion`**: bracket the WHOLE
   operation (fetch → verify → extract → scan → persist) with
   `introspect-start`/`introspect-end` (finally), so "packages being introspected" is a
   first-class work row, distinct from its inner HTTP span. Its inner tar spawns are
   already covered by seam 1.
8. **boundedPool.ts is NOT touched.** Occupancy comes from the dispatch/settle and
   owner/repo brackets above. A shared concurrency primitive stays free of
   observability concerns.

================================================================================
U4. THE STORE (scripts/tui/store.ts — pure fold, React-free)
================================================================================
A single mutable store folds ProgressEvents into a renderable snapshot. Constructor
injection, house style: `createTuiStore(nowMs: () => number)`. main installs
`store.dispatch` as the progress sink (§U1); nothing else feeds the store.

State (all bounded — nothing grows with estate size):
- `phase`, `runId` and a `resumed: boolean` flag from the tapped `run` event — and
  NOTHING derived from its `counts` blob: `db.resumeInfo` counts are whole-database row
  totals (not per-config, not done/pending queue state), so the header shows
  `run <id8> (resumed)` / `(fresh)` and no invented queue numbers.
- `activeSpawns: Map<id, { tool; label; sinceMs }>`, `activeFetches: Map<id, …>`,
  `activeIntrospections: Map<id, { packageName; version; sinceMs }>`,
  `spawnWaiting: number`, `spawnCap: number | null` from the tapped `concurrency`
  event's `repositories` (truthful from the first spawn — §U1's preflight-client fix).
- `activeOwners: Set<string>`, `activeRepos: Set<"owner/repo">`,
  `unitWorkers: Map<"owner/repo@branch", { sinceMs }>` (dispatch→settle),
  `scanningUnits: Map<"owner/repo@branch", { sinceMs }>` (start→settle),
  `ownerCap`/`branchCap` from the tapped `concurrency` event (branchCap is PER-REPO —
  render `unit workers N (≤B per repo)`, never a global fraction).
- `logPath: string | null` from the `divert` event (the actual post-retry path — the
  footer renders it only once known; null in undiverted runs).
- `limits: { core, graphql } → { remaining; limit; resetEpochSec; asOfMs } | null`
  (live snapshots; `rate-limit-seed` folds only into null slots).
- `throttle: { core, graphql } → { horizonMs; budgetSpentMs } | null` — PAUSED is
  DERIVED at render: `horizonMs > nowMs()`. An `exhausted` with `reason:"budget"` sets
  a sticky `budgetExhausted` flag (it cannot un-happen within a run); `reason:"retries"`
  increments a `retryExhaustions` counter (transient, surfaced as a count).
- Counters folded from tapped `unit` events, labeled as THIS-SESSION activity (a
  resumed run's report includes prior sessions' work — the dashboard never claims
  report totals): scanned, skip-current, skip-cutoff, skip-policy, past-cap, errored,
  requeued; findings deps/usage/cli summed from `scanned` events' fields.
- `recentProblems: RingBuffer(50)` of `{ atMs; kind: "error" | "warning"; scope;
  target; message }` folded from tapped events with failure semantics: `unit` with
  `action:"error"` (error), `discovery` with `error` (error), `introspection` with
  `error` (error), `warning` (warning), `policy-warning` (warning). Plan events are NOT
  projected (plan mode never mounts — dead code is not written). Message sanitization
  happens at render (§U0/§U5); truncation at render.
- `version: number` incremented per mutation (render-skip signal).

`dispatch(e: ProgressEvent)` is total over the union (exhaustive switch with the repo's
`assertNever`) and O(1) per event. Tapped JSONL events are folded by a projection that
must never throw on ANY event shape — unknown events fold to nothing by design (the
vocabulary can grow without touching the TUI).

Ownership boundary: the store and everything React lives in scripts/tui/ (display
layer); the hub in scripts/progress.ts (core). Core modules never import from
scripts/tui/.

================================================================================
U5. THE INK APP (scripts/tui/ — display only)
================================================================================
### Mount adapter (scripts/tui/mount.tsx) — dynamic import only
orchestrate.ts and lifecycle.ts are `.ts` files: no JSX, and no static Ink/React import
anywhere reachable from a non-TUI run (a broken display dependency must not break the
audit, and help/--plan/CI runs must not pay the load cost). `runWithTui` does
`await import("./mount.tsx")` only when the decision is "on"; a rejected import is a
mount failure (§U6). The adapter owns all JSX/React:
```ts
export interface TuiHandle {
  requestUnmount(): void;
  waitUntilExit(): Promise<void>;
  dispose(): void;              // stops the tick + detaches App-side hooks; idempotent
}
export function mountTui(store: TuiStore, opts: {
  out: NodeJS.WriteStream;      // the lifecycle's SEALABLE stderr proxy — Ink's render target
  onDegrade: () => void;        // = lifecycle degradeNow; called DIRECTLY on any App failure
  nowMs?: () => number;
  scheduler?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  tickMs?: number;              // default 125; tests inject to drive frames deterministically
}): TuiHandle;
// inside: render(<App … />, {
//   stdout: opts.out,          // load-bearing: Ink's "stdout" IS our (sealable) stderr
//   stderr: opts.out,
//   exitOnCtrlC: false,        // §U0: SIGINT keeps its default kill-and-resume semantics
//   patchConsole: true,        // stray console.* (React warnings!) render ABOVE the frame
//                              // instead of smearing it — nothing of ours calls console
// });
```
`waitUntilExit()` gets a rejection handler attached AT MOUNT (an unhandled-rejection
crash would violate degrade-never-kill); a rejection calls `reportTuiFailure` AND
`onDegrade` directly — never only the latch (a dead React tree cannot be relied on to
poll it). The error boundary's fallback path does the same. No `useInput` anywhere →
Ink never enables raw mode. Ink's internal signal-exit cursor cleanup is accepted
(§U0); P0 proves the composite behavior under Bun.

### Render cadence — guarded tick (belt-and-braces observer, NOT the degrade channel)
A single interval (via `opts.scheduler`, `tickMs` default 125) whose callback is
WRAPPED in try/catch (a React error boundary cannot catch timer callbacks — the tick
guard is the real protection there; the boundary is belt-and-braces for render throws).
Degradation is driven DIRECTLY by the failing site calling `degradeNow`/`onDegrade`
(§U1/§U5 mount) — the tick's latch check is a second net for anything that only
latched: if `tuiFailure()` is non-null, stop the interval and call `onDegrade`. On the
tick's OWN throw: `reportTuiFailure`, stop the interval, `onDegrade`. Otherwise the
tick reads `store.snapshot()`; if `store.version` is unchanged AND no visible
elapsed/countdown digit would change (1s granularity), skip the setState.
Elapsed/countdown values derive from `nowMs()` at render; events are timeless (§U2).

### Layout (top to bottom; reference sketch, not pixel law)
```
 package-audit ▸ run 2f9c1a… (resumed)   phase: scan   elapsed 04:12
 limits  core 4,812/5,000 resets 12:34 · graphql 1,998/2,000 resets 03:11
         subprocs 3/6 (+2 queued) · pause budget 0m/480m
 [when throttled]  ⏸ core PAUSED — resumes in 04:57      [sticky if budget exhausted]
 work    owners 2/3: acme, initech · repos 5 · unit workers 9 (≤4/repo) · scanning 7
           acme/api@main            12s
           acme/web@release/2024    41s        (≤ WORK_ROWS=8, then "… +N more")
         introspect expo@52.0.0 8s
         session: scanned 143 · current 61 · skipped 27 · past-cap 4 · errored 2
         findings (session): 512 dep · 1,204 usage · 77 cli
 net     gh api repos/acme/api/git/trees/…      2.1s
         git clone acme/web                     41s
         registry packument expo                 0.8s   (≤ NET_ROWS=8, then "… +N more")
 problems 04:01 ✖ scan acme/api@dev — git clone failed: …   (last 5, newest first;
          03:58 ⚠ clone-cleanup-failed /tmp/pkg-audit-…      warnings dimmed)
 JSONL → output/logs/audit-log-20260718T211530Z-p4242.jsonl · Ctrl+C aborts (resumable)
```
Component split (house norms, ≤ ~400 lines/file): `App.tsx` (frame + tick + boundary),
`panels.tsx` (small function components), `format.ts` (pure: duration, countdown,
thousands, and `sanitizeLine` — strips C0/C1 controls + ANSI escapes, collapses
newlines, forces one line; applied to EVERY dynamic string before render; unit-tested
against hostile fixtures).

### Terminal-size discipline (a known Ink sharp edge)
A frame taller than the viewport cannot be fully erased on redraw and smears scrollback.
Measure columns/rows from the RENDER stream (Ink 7's window-size hook if P0 confirms it
under Bun, else a resize listener on the stream) and hard-cap the frame at `rows - 1` by
degrading in priority order: shrink NET_ROWS → shrink WORK_ROWS → drop the findings
line → collapse problems to a one-line count → (< 60 columns or < 12 rows) compact
mode: header + limits strip + counters + footer only → (below the §U1 floor mid-run,
but still ≥ 2 rows and ≥ 20 columns) a SINGLE-LINE frame: `package-audit · scanning ·
terminal too small` → (rows < 2, columns < 20, or dimensions undefined mid-run) an
EMPTY frame — render nothing at all; a fixed line cannot be guaranteed to occupy one
physical row in an unusable viewport. Never unmount on shrink (resize is transient;
unmount is one-way). Row
truncation uses INK's layout (`<Text wrap="truncate-end">` inside width-constrained
`<Box>`), never naive string slicing — org/repo/branch names can contain CJK/emoji
whose cell width chars can't measure. Colors via `<Text color/dimColor>`; NO_COLOR is
honored by Ink's chalk.

================================================================================
U6. LIFECYCLE & FAILURE POLICY (degrade, never kill — §U0)
================================================================================
States: `off → mounting → on → closing → closed`, owned by `runWithTui`. Failure
signaling is the §U2 structured latch; failure REACTION is `degradeNow` — a direct call
available to every failing site (§U1) — and both it and the body's finally converge on
ONE cached `teardownOnce()` promise: teardown is SINGLE-FLIGHT and idempotent by
construction (a degrade racing the finally cannot double-close the fd, double-print
warnings, or write after return — the second caller just awaits the first's promise).
Two race contracts make that real:
- **Publish-before-side-effects**: `teardownOnce` stores a DEFERRED promise before
  executing ANY step — the naive `promise ??= run()` is synchronously reentrant
  (`dispose()`/`requestUnmount()` can trigger `onDegrade` before the assignment lands)
  and would double-run. Tested with a synchronously-reentrant fake handle (§U8.13).
- **Mount-time barrier**: `degradeNow` is callable from the instant mounting begins —
  an error boundary can fire before `mountTui` even returns its handle. `teardownOnce`
  therefore tolerates a null handle (skips steps 1–2), and the §U1 setup path re-checks
  the state after every await: once teardown has started, setup installs NOTHING
  further and unwinds what it just created (dispose a late-arriving handle; never open
  the divert into a dead lifecycle).

- **Load/mount failure** (dynamic import rejects, mountTui throws): warn once on
  stderr, run with TUI off. Install order (§U1) guarantees the sink/tap/divert are
  installed only after a successful mount — so a mount failure leaves JSONL on stdout,
  the exact pre-feature behavior.
- **Divert open failure** (mkdir/openSync/retry exhausted): degrade — tear down the
  just-mounted dashboard (full teardown below), warn once naming the underlying error,
  run bare with JSONL on stdout. Never fatal (§U0), never JSONL-into-the-frame.
- **Divert write failure mid-run**: handled inside logLine's sink closure (§U1): stdout
  sink restored and the failing line re-emitted in the same call (no loss),
  `reportDivertFailure`, then `degradeNow` — teardown starts immediately. Exit line
  labels the file partial (from the structured latch's `divertFailedMidRun`, which is
  tracked independently of whichever failure latched FIRST).
- **Emit/tap/render/tick/exit-rejection failure**: every site both latches AND calls
  `degradeNow` directly where it can (§U1/§U5); the tick's latch check and the finally
  are the safety nets for anything that could only latch. The audit never observes any
  of it.
- **teardownOnce() (the ONE sequence — cached promise; degrade and finally both await
  it)** — each step individually guarded (a step's failure becomes a deferred warning;
  teardown NEVER throws, and a propagating payload error is never masked):
  1. `handle.dispose()` — stops the tick interval and App-side hooks (idempotent; the
     App may already have stopped itself; skipped when the handle never arrived);
  2. `requestUnmount()`; `await race(waitUntilExit(), timer)` using the INJECTED
     `deps.timers` (2s production default) — ALWAYS clearTimeout the loser;
  3. `seal()` the stderr proxy (idempotent — the divert-failure path seals earlier) —
     from here, NOTHING (including a wedged Ink, its queued renders, or its console
     patch) can reach the real stderr; sealed-off write attempts are counted and
     reported in the step-6 warning. This is what makes "below the terminated frame" a
     guarantee rather than a hope, timeout or not;
  4. `setProgressSink(null)`, `setLogTap(null)`, `setLogSink(null)` (restores stdout);
  5. `closeSync(fd)` if a divert opened (failure → warning), then print the
     `JSONL log: <path>` line — the ACTUAL opened path — with the partial-file wording
     whenever the file is incomplete for ANY reason: `divertFailedMidRun` (the write
     died) OR `divertClosedEarly` (teardown ran while the body was still in flight —
     lifecycle sets this flag by comparing teardown start against body completion; a
     tick/render/emit degrade also strands the file mid-stream, and announcing it as
     the complete log would be a lie);
  5a. if the seal preceded unmount and `sealEarly()`'s compensation did not run (a
     defensive impossibility — every pre-unmount seal site uses `sealEarly()`), write
     the cursor-show escape (ESC `[?25h`) once to the REAL stderr; best-effort,
     guarded, idempotent;
  6. print the ONE latched-failure warning (first cause + any sealed-write count), if
     the latch is non-null.
  Steps 5–6 write to the REAL stderr (the proxy is sealed; teardown holds the real
  stream). After teardown, `runWithTui` returns/rethrows; main prints the success
  summary, or the import.meta.main catch prints renderFatal — both below the
  terminated (and sealed) frame.
- **Signals**: this feature installs none (§U0). SIGINT mid-run kills the process
  (Ink's signal-exit restores the cursor); the terminal keeps the last frame — accepted
  cosmetic, documented in §U9; the run resumes next invocation.

================================================================================
U7. DEPENDENCIES & TOOLCHAIN
================================================================================
package.json (exact pins, house style — resolved 2026-07-18; re-resolve at
implementation time and record what you pinned in the PR body):
- dependencies: `ink@7.1.1`, `react@19.2.7` (ink 7 peers `react >=19.2.0`).
- devDependencies: `@types/react@19.2.17`, `ink-testing-library@4.0.0`.
- `react-devtools-core` is an optional peer — do not add it.
Supply-chain posture (feeds §U9's README honesty): exact pins + bun.lock; the project
lists no `trustedDependencies` — but Bun ALSO ships a default trusted allowlist, so "no
lifecycle scripts" is a claim to VERIFY at P0 (inspect `bun pm untrusted` / install
output for the resolved closure), not to assert. Document the verified state in the
README; if any dependency script would run, surface it and decide explicitly (e.g.
bunfig `ignoreScripts`) before P1. The new deps are display-layer only; the greps in
§U8 enforce they can never reach the spawn/write paths, and they load only via §U5's
dynamic import, so non-TUI runs never even evaluate them.

tsconfig.json: add `"jsx": "react-jsx"`; widen include to
`["scripts/**/*.ts", "scripts/**/*.tsx"]`. `bun test` and `tsc --noEmit` pick the .tsx
files up from there; CI needs no changes beyond passing.

New files: `scripts/progress.ts`, `scripts/tui/activation.ts`,
`scripts/tui/lifecycle.ts`, `scripts/tui/store.ts`, `scripts/tui/mount.tsx`,
`scripts/tui/App.tsx`, `scripts/tui/panels.tsx`, `scripts/tui/format.ts` (+ tests).

Runtime proof (P0, §U10) — two distinct gates, honestly separated:
- AUTOMATED (CI-safe): the real `mountTui` under Bun against capture streams — mount,
  tick, store-driven frame updates, unmount, bounded-exit path. Ink detects CI and may
  render non-interactively there; the automated gate asserts CONTENT and lifecycle, not
  interactive repaint. ink-testing-library@4 was built against older Ink; P0 verifies
  it drives ink@7 correctly, else panel tests mount via the real adapter against
  capture streams instead.
- MANUAL (recorded in the PR body as a checklist with observed results): a real
  terminal run — interactive repaint, resize (window-size hook vs listener verdict),
  SIGINT mid-render (process dies, cursor restored, terminal usable, run resumes).
  CI cannot prove these; pretending otherwise would be a fake gate.
If Ink 7 hits a REAL Bun incompatibility at P0: STOP. That invalidates this document's
Ink-7-specific API claims — the correct move is revising this plan (new review round),
not swapping to a different major behind a PR-body note.

================================================================================
U8. TESTS (bun test; deterministic; extend the enforcement scans)
================================================================================
Follow the repo's scripted-fake style (injected SpawnFn / fetchImpl / clocks / sinks).
Global hygiene rule: EVERY test file that touches `setLogSink`, `setLogTap`,
`setProgressSink`, or the failure latch restores all of them (`…(null)` ×3 +
`resetTuiFailure()`) in `afterEach` — module-global seams must never leak across the
existing suite (log.test.ts runs against real stdout).

1. **Activation**: `decideTuiActivation` table-tested over every §U1 matrix row,
   including CI, TERM=dumb, size floor, undefined dimensions, --ui error cells, plan.
2. **args**: --ui/--no-ui parsing, mutual exclusion, `--plan --ui` rejection,
   `--flag=value` rejection, help text names both.
3. **log.ts seam**: sink receives the ONE whole line per event (extend log.test.ts's
   write-counting harness to a custom sink); `setLogSink(null)` restores stdout; tap
   fires after the write; tap throw self-clears, reports, never escapes; SINK throw
   reroutes to stdout re-emitting the same line (no loss) and reports.
4. **Divert opener**: pure `logPathFor` (timestamp/pid/suffix grammar); EEXIST retry
   selects the suffixed candidate and the ACTUAL path propagates to the divert event
   and exit line; bounded exhaustion → degrade (not fatal); short-write loop delivers
   whole lines (fake io returning partial counts) and a `<= 0` count enters the
   failure transition instead of looping; containment — the CANONICAL path that passed
   `assertContained` is the path opened, with traversal and symlink-escape cases (reuse
   readOnlyGuard test helpers); close failure warns.
5. **progress.ts**: no-sink emit is a no-op and `hasProgressSink()` gates work; ordered
   delivery; first sink throw clears + reports + never escapes; latch first-cause-wins
   while `reportDivertFailure` still sets `divertFailedMidRun` when it fires SECOND;
   reset semantics; the jsonl tap closure allocates nothing once the sink is cleared.
6. **spawnLabel + sanitizeLine**: table-driven (gh api endpoint / graphql / git clone
   URL → owner/repo / tar --version; length cap; total on hostile argv). sanitizeLine
   against hostile fixtures: ANSI CSI/OSC, C0/C1, newlines, backspace/CR overwrite.
7. **github.ts wiring** (scripted SpawnFn): balanced spawn spans per attempt with the
   explicit tool discriminant (identical binPaths still label correctly);
   deadline-timeout and byte-cap paths still end spans; Semaphore waiter callback under
   contention; rate-limit snapshots emitted from the analyze-returned headers on 200s,
   on 304 revalidations, and on classified error/retry attempts (REST and GraphQL both)
   — none on the immutable-cache return, none when `hasProgressSink()` is false (assert
   zero derivation); armed emitted once per arm incl. unfunded overflow, with
   POST-funding budget; waiting before sleep; exhausted with reason:"budget" from
   waitBucket and reason:"retries" from both MAX_ATTEMPTS sites; overlapping-window
   sequence (arm → waiting → re-arm extends horizon) renders PAUSED until the LAST
   horizon.
8. **apiSurface + preflight wiring**: balanced fetch spans (packument, tarball,
   registry-probe) incl. failure paths; introspect span brackets the whole operation.
9. **orchestrate wiring** (existing scripted-client harness + captured sink): phase
   order incl. resolve-owners; owner/repo brackets balanced under throws;
   dispatch/settle balanced for scanned, skip-current, error, requeue, AND fatal-escape
   units; unit-start absent for skip-current; seed events fold-if-absent; preflight
   client constructed at configured concurrency.
10. **store**: per-variant folds; ring cap; session-counter math; PAUSED derivation
    from horizon vs injected now; sticky budget-exhausted vs retryExhaustions count;
    seed-vs-live precedence; unknown tapped events ignored; version bumps.
11. **format + panels**: formatter tables; panel frames over canned store states
    (empty, populated, overflow "+N more", compact mode, single-line too-small mode,
    EMPTY frame below the render floor / undefined dimensions, throttle banner, sticky
    exhausted, warnings-dimmed problems panel, footer with and without a known log
    path) via the P0-cleared harness (§U7); strip ANSI before asserting.
12. **Routing equivalence (the invariant test, deterministically)**: two full live runs
    can never byte-match (randomUUID run ids, wall-clock timestamps) — so replay ONE
    fixture event sequence through `logLine` under (a) the stdout sink and (b) a divert
    fd, and assert the captured bytes are identical; separately, drive a scripted run
    with the TUI mounted against capture streams and assert `process.stdout` received
    ONLY JSONL (undiverted case) / NOTHING (diverted case).
13. **Lifecycle (`runWithTui` with injected deps — mounts, io, streams, TIMERS)**:
    mount failure → body still runs, JSONL on stdout, one warning; divert open failure
    → teardown AWAITED before the body proceeds (no live-frame/stdout overlap); divert
    write failure mid-body → proxy sealed SYNCHRONOUSLY before the re-emit (assert no
    frame write lands after the rerouted JSONL line), stdout rerouted, line re-emitted,
    `degradeNow` starts teardown immediately, partial wording + actual path in exit
    line, cursor-show escape written on the early-seal path; a NON-divert degrade
    (tick/render/emit) mid-body also yields the partial-file wording
    (`divertClosedEarly`); teardown ordering (dispose → unmount → seal → seams cleared
    → close → log line → latched warning → THEN summary/fatal); bounded-exit timeout
    path is DETERMINISTIC via injected timers, clears the loser, and the sealed proxy
    drops and COUNTS a wedged mount's late writes (assert none reach the real stream
    and the count reaches the warning); teardown re-entry runs the sequence ONCE —
    including a SYNCHRONOUSLY-reentrant fake handle whose dispose/unmount call
    degradeNow before teardownOnce's promise would land (publish-before-side-effects),
    and a mount-time degrade firing before the handle exists (null-handle teardown +
    setup unwind: no sink/tap/divert ever installed into the dead lifecycle, and the
    LATE-ARRIVING handle is fully unwound — dispose AND requestUnmount + bounded wait,
    not dispose alone); the setup-final state check: a SYNCHRONOUS setup-time degrade
    (e.g. the divert event tripping a throwing guarded sink) means body() starts only
    AFTER the awaited teardown; a throwing teardown step defers to a warning and never
    masks a propagating body error; guarded progress sink: a THROWING store.dispatch
    CLEARS the sink synchronously (subsequent emits are no-ops, zero further
    throws/allocations), latches, and degrades immediately (no tick dependence); latch
    reset at lifecycle start.
13a. **Sealable proxy**: transparent delegation (isTTY/columns/rows/resize reach the
    real stream's values and listeners, live AND sealed); absorbing (underlying sync
    throw, callback error, and 'error' event are consumed, latched, degrade, callback
    acknowledged — nothing escapes into the caller); sealed counting; seal idempotence.
14. **Enforcement scans**: logVocab.test.ts walk becomes recursive
    (`readdirSync(SCRIPTS_DIR, { recursive: true })`) and includes `.tsx`, still
    excluding `*.test.*` — scripts/tui/ can never emit an undocumented stdout token.
    (The sole-spawner SPAWN_RE scan in github.test.ts ALREADY walks recursively and
    includes .tsx — verify, don't duplicate.) NEW tui-purity grep across
    scripts/progress.ts + scripts/tui/**: no `process.stdout`, no `logLine` import, no
    `Bun.spawn|spawnSync|$`, no fs/`Bun.write` write APIs (lifecycle.ts's injected
    divertIo default is the one permitted fs user — scope the grep accordingly), no
    `./db.ts` or `./github.ts` imports.
15. **Regression**: the full existing suite stays green — the summary-write relocation
    (§U1) is the one INTENDED behavioral edit to existing tests; enforcement-scan
    widenings and additive harness plumbing are expected and fine — plus
    `bun run typecheck` green, and a config fixture's hash asserted unchanged against a
    pre-feature literal (config_hash tripwire).

================================================================================
U9. DOCUMENTATION DELTAS
================================================================================
- README "Reading a run": add an **Interactive dashboard** subsection — activation
  matrix (§U1 table, condensed), the divert rule and file naming, the `JSONL log:` exit
  line (and its partial-failure form), Ctrl+C-keeps-resumability, the
  last-frame-persists cosmetic, crash truncation of the divert file's final line, and
  NO_COLOR/TERM=dumb/CI behavior. State explicitly: the JSONL contract (vocabulary,
  one-line-per-event) is unchanged; only the interactive destination moves.
- README "Exactly one runtime dependency": now false — rewrite honestly (e.g. "Runtime
  dependencies: typescript, plus ink+react for the opt-outable dashboard"), with the
  §U7 posture: exact pins, lockfile, the VERIFIED lifecycle-script state of the
  resolved closure (§U7 — do not hand-wave "no scripts"), dynamic-import-only,
  display-layer-only enforced by tests. The Trust section's claims must remain true and
  unweakened; if any sentence there can no longer be defended, revise it rather than
  shading it.
- args help text: both flags (§U1). PROMPT.md is NOT edited by this feature.

================================================================================
U10. IMPLEMENTATION PHASES (each lands green: bun test + typecheck)
================================================================================
- **P0 toolchain spike**: deps + tsconfig + minimal mount adapter; the two §U7 gates
  (automated capture-stream lifecycle; manual interactive checklist recorded in the PR
  body); ink-testing-library verdict; lifecycle-script verification of the resolved
  dependency closure. HARD STOP + plan revision if Ink 7 is Bun-incompatible.
- **P1 routing + lifecycle + failure design** (the architecture phase — failure
  semantics are load-bearing for everything after, so they land FIRST, not last):
  args flags; `decideTuiActivation`; log.ts sink+tap seams with rerouting semantics;
  divert opener (sync fd, short-write loop, retry, containment, open-failure degrade);
  progress.ts latch; `runWithTui` with injected deps and the full §U6 teardown; the
  runScan summary-return refactor; preflight-client concurrency fix. Gate: tests 1–5,
  12, 13.
- **P2 hub + store**: remaining progress.ts surface, store folds, session-counter
  semantics. Gate: tests 5 (extended), 10.
- **P3 instrumentation**: github.ts (tool-threaded spawn spans, semaphore gauge,
  analyze-return header channel + gated derivation, single-exit armBucketPause,
  exhausted reasons), apiSurface + preflight spans, introspect span, orchestrate
  anchors + seed. Gate: tests 6–9; hot-path review confirms no new awaits inside
  leases and `hasProgressSink()` gating everywhere.
- **P4 panels**: App tick loop (latch-watching), panels, format/sanitize, size
  discipline, compact + single-line modes. Gate: test 11; a real `--ui` run against a
  small fixture org eyeballed.
- **P5 enforcement + docs**: scan extensions, tui-purity grep, README/help deltas,
  config-hash tripwire, full-suite regression. Gate: tests 14–15, docs review.

Deviation rule (house protocol): an implementer may deviate from this document only
with a grounded reason recorded in the PR body, and never from §U0.

================================================================================
U11. NON-GOALS (v1) — parked, not rejected
================================================================================
Keybindings/interactivity (quit, pause admission, drill-down); a --plan dashboard;
alternate-screen buffer; scrollable panels; TUIs for report/export/compare; new JSONL
events or fields; config.json keys for the UI; per-redirect-hop fetch events; queue
done/pending totals in the header (db.resumeInfo does not provide them; a per-config
queue query is a v2 candidate); Windows terminal guarantees; persisting TUI state.

================================================================================
U12. ACCEPTANCE (operator-visible, all must hold)
================================================================================
1. `bun run audit > run.jsonl` — byte-identical JSONL vs. main, TUI on stderr when
   eligible; `--no-ui` restores today's behavior exactly; CI runs are untouched.
2. `bun run audit` in a plain terminal — dashboard renders; stdout receives nothing;
   the complete event stream is in the announced log file (routing-equivalent bytes per
   §U8.12; every line parses; vocabulary unchanged; final line may truncate only on a
   crash).
3. Limits panel updates on every live API response — 200s, 304 revalidations, and
   classified errors alike, excluding only zero-network cache hits; preflight numbers
   appear before the first scan spawn; a forced 403/remaining-0 fixture shows armed →
   waiting → (horizon passes) unpaused; budget exhaustion shows the sticky notice,
   retry exhaustion a count — never conflated.
4. Network panel shows every gh/git/tar spawn and every registry HTTP span (packument,
   tarball, preflight probe) with elapsed; work panel shows active owners/repos/unit
   workers/scans and introspections, with counters honestly labeled as session
   activity; hostile bytes in any displayed string render inert (§U0 sanitization).
5. Problems panel shows the last 5 errors/warnings with scope and target, warnings
   visually distinct.
6. Ctrl+C mid-run, rerun: resume works exactly as before; this feature installed no
   signal handlers.
7. Kill the TUI's legs (throwing sink / failing divert open or write / import failure
   in a test build): the audit completes bare with one warning; a divert-write failure
   reroutes JSONL to stdout without losing the failing line; a divert-open failure
   degrades rather than aborting — proving §U0's no-exceptions degrade guarantee.
8. Full test suite + typecheck green; enforcement scans cover the new files; the
   tui-purity grep passes; the config-hash tripwire passes.

--------------------------------------------------------------------------------
Review record (outside voice: codex CLI, gpt-5.6-sol @ ultra reasoning)
- R1 2026-07-18: 38 findings (26 P1) — VERDICT: REVISE. All incorporated (lifecycle
  ownership, sync-fd divert, CI eligibility, .tsx dynamic mount, analyze-return
  rate-limit channel, 304s, preflight probe + introspection spans, dispatch/settle
  occupancy, derived PAUSED, typed nullables, seed fold-if-absent, spawn tool
  discriminant, honest labels, resolve-owners phase, signal-exit wording, tick guard,
  Ink-layout truncation, DI activation, production-boundary P0, patchConsole true,
  failure design → P1, stale sole-spawner claim corrected).
- R2 2026-07-18: 23 findings (18 P1) — VERDICT: REVISE. All incorporated: preflight
  client at configured concurrency; run-event counts dropped (global rows, not queue);
  latch + onDegrade immediate-degrade channel; size floor + single-line mode;
  `runWithTui` DI seam; sink/tap wiring + clearing made explicit; divert-open failure
  → degrade (contradiction resolved); short-write loop; teardown total + bounded exit
  with cleared loser timer; replay-based routing-equivalence test (UUID determinism);
  single-exit armBucketPause post-funding emit; exhausted reason budget/retries;
  headers-reference analyze channel (no unconditional allocation); latch API with
  cause+reset; P0 gates split automated/manual; Ink-5 fallback removed (STOP+revise);
  sanitizeLine everywhere; Bun default-trusted-list verification; problems panel
  naming + dead plan projection cut; regression wording fixed; partial-file exit line.
- R3 2026-07-18: 13 findings (10 P1) — VERDICT: REVISE. All incorporated: degrade made
  DIRECT (degradeNow handed to sink closure, exit-rejection handler, error boundary —
  tick demoted to belt-and-braces); sealable stderr proxy (post-timeout wedged-Ink
  writes provably cannot reach the terminal; sealed writes counted into the warning);
  timers + scheduler/tickMs injected for deterministic lifecycle tests;
  single-flight cached teardownOnce with re-entry test; TuiHandle.dispose();
  divertIo open loop returns the ACTUAL suffixed path, which now reaches both the
  footer (new `divert` progress event + store.logPath) and the exit line; structured
  latch (divertFailedMidRun independent of first cause) + reset at lifecycle start;
  jsonl tap gated by hasProgressSink; writeSync `<= 0` → failure transition (no hang);
  `!== null` contract wording; rows<2/undefined → EMPTY frame; problems label unified.
- R4 2026-07-18: 8 findings (8 P1) — VERDICT: REVISE. All incorporated: guarded
  progress-sink closure (store.dispatch failure latches + degrades directly, no tick
  dependence); proxy contract expanded — TTY-transparent delegation
  (isTTY/columns/rows/resize) and absorbing semantics (underlying write errors
  consumed → latch + degrade, callbacks acknowledged); mount-time reentrancy barrier
  (null-handle teardown + setup re-checks state after every await and unwinds);
  divert-open failure AWAITS teardownOnce before the body proceeds;
  publish-before-side-effects deferred in teardownOnce (synchronous-reentry test);
  partial-file wording generalized via divertClosedEarly (any mid-body degrade, not
  only write failure); divert-failure transition seals the proxy SYNCHRONOUSLY before
  re-emitting to stdout (no interleaving window) with a cursor-show compensation
  (step 5a) for early-seal paths.
- R5 2026-07-18: 4 findings (4 P1) — VERDICT: REVISE. All incorporated: late-arriving
  handle unwound FULLY (dispose + requestUnmount + bounded wait, not dispose alone);
  guarded progress sink clears itself synchronously in its catch (no repeat
  throw/allocate until teardown); setup ends with a final state check so body() never
  starts mid-collapse (covers synchronous setup-time degrades); cursor compensation
  moved INTO `sealEarly()` (seal + cursor-show in one synchronous step — the SIGINT
  window between early seal and unmount can no longer strand a hidden cursor; step 5a
  demoted to a defensive no-op).
- R6 2026-07-18: 0 findings — VERDICT: APPROVE ("No unresolved or new
  implementation-changing findings."). Converged in 6 of the allotted 7 rounds
  (38 → 23 → 13 → 8 → 4 → 0).
