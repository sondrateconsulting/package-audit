// lifecycle.ts — the ONE owner of the TUI lifecycle (§U1/§U6 of PROMPT-TUI.md): stream routing,
// the sealable stderr proxy, the divert opener, and the single-flight teardown. React-free —
// mount.tsx is loaded exclusively via dynamic import, so a broken display dependency can never
// break the audit and non-TUI runs never evaluate Ink/React.
//
// This file is the ONE permitted fs user in scripts/tui/ (the injected divertIo default) — the
// tui-purity scan scopes its write-API allowance to exactly this module.
import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { setLogSink, setLogTap } from "../log.ts";
import { setProgressSink, hasProgressSink, emitProgress, reportTuiFailure, reportDivertFailure, tuiFailure, resetTuiFailure } from "../progress.ts";
import { assertContained } from "../readOnlyGuard.ts";
import { sanitizeLine } from "./format.ts";
import { createTuiStore, type TuiStore } from "./store.ts";
import type { ActivationDecision } from "./activation.ts";
import type { mountTui, TuiHandle } from "./mount.tsx";

export const TEARDOWN_EXIT_WAIT_MS = 2_000; // §U6 step 2: bounded unmount wait (injected timers)
export const DIVERT_OPEN_ATTEMPTS = 10; // §U1: candidates attempt 0..9, then degrade
const SHOW_CURSOR = "\u001B[?25h";

// TOTAL: a hostile thrown value (throwing toString/message getter) must never make a guard or
// teardown step itself throw — cleanup runs to completion no matter what it is cleaning up
// after. SANITIZED: error text can embed child-process stderr (§U0), and these strings end up
// on the operator's terminal in our warning/exit lines — control bytes render inert.
const errText = (e: unknown): string => {
  try {
    if (e instanceof Error && typeof e.message === "string") return sanitizeLine(e.message);
    return sanitizeLine(String(e));
  } catch {
    return "unprintable error";
  }
};

// ---- divert log path (pure grammar + contained production builder) ---------------------------
// `<outputDir>/logs/audit-log-<UTC yyyyMMddTHHmmssZ>-p<pid>.jsonl` for attempt 0; `-2`, `-3`, …
// suffixes for retries. Pure and unit-tested; containment lives in makeDivertPathFor.
export function logPathFor(outputDir: string, stamp: string, pid: number, attempt: number): string {
  const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
  return join(outputDir, "logs", `audit-log-${stamp}-p${pid}${suffix}.jsonl`);
}

// UTC compact stamp for the log file name: 2026-07-18T21:15:30.123Z → 20260718T211530Z.
export function utcLogStamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

// The production candidate builder main() injects as deps.logPathFor: pure grammar → resolve →
// §0 containment under the configured outputDir. Returns the CANONICAL path assertContained
// resolved — the path actually opened, so a symlinked outputDir cannot smuggle the write out.
export function makeDivertPathFor(outputDir: string, stamp: string, pid: number): (attempt: number) => string {
  return (attempt: number) => assertContained(logPathFor(outputDir, stamp, pid, attempt), [outputDir]);
}

// ---- divert io (synchronous fd; the injectable impure edge) ----------------------------------
export interface DivertIo {
  open(path: string): number; // openSync "wx" (exclusive); throws EEXIST for retry-next
  write(fd: number, line: string): void; // whole-line delivery via a short-write loop
  close(fd: number): void;
}

// createWriteStream opens asynchronously and reports failures via a later 'error' event — the
// wrong shape for a sink that must be usable before the first event. The synchronous trio keeps
// open/write/close failures at the call site, where the §U6 transitions can see them.
// The short-write loop, factored over an injected write so the count semantics are directly
// table-testable (§U8.4): writeSync may write SHORT without throwing — loop until the WHOLE
// line is delivered (one logical write per event, ordering by construction). A nonpositive or
// non-integer count is a WRITE FAILURE, not a retry: an unchanged infinite retry would hang
// the audit (§U1).
export function writeAllSync(writeFn: (fd: number, buf: Buffer, offset: number) => number, fd: number, line: string): void {
  const buf = Buffer.from(line, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    const n = writeFn(fd, buf, offset);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`divert write made no progress (write returned ${n})`);
    offset += n;
  }
}

export const realDivertIo: DivertIo = {
  open(path: string): number {
    mkdirSync(dirname(path), { recursive: true });
    return openSync(path, "wx", 0o644);
  },
  write(fd: number, line: string): void {
    writeAllSync(writeSync, fd, line);
  },
  close(fd: number): void {
    closeSync(fd); // no fsync — the DB, not the log, is the durable state
  },
};

// ---- the sealable stderr proxy (§U1 — Ink's whole world) -------------------------------------
export interface SealableStderr {
  readonly stream: NodeJS.WriteStream; // hand THIS to Ink; delegates everything else to the real stream
  readonly sealed: boolean;
  readonly sealedDrops: number; // write attempts counted-and-dropped after seal
  readonly cursorCompensated: boolean; // the cursor-show escape was written on Ink's behalf
  seal(): void; // idempotent; writes stop reaching the real stream
  sealEarly(): void; // seal + cursor-show compensation in ONE synchronous step (§U1)
  compensateCursor(): void; // write the cursor-show escape once (idempotent; for post-seal paths
  //                           where Ink's own restore write was — or will be — dropped)
  detach(): void; // remove the 'error' absorber from the real stream (teardown)
}

type WriteCb = (err?: Error | null) => void;

// Three jobs, all load-bearing (§U1): transparent while live (Ink must see a real interactive
// TTY and register real resize listeners), absorbing (a broken stderr degrades the dashboard,
// never throws into React internals or kills the audit — Ink's callbacks are ALWAYS acknowledged
// as complete, or its flush-sync write("", cb) would hang waitUntilExit), and sealed (after
// seal(), counted-and-dropped — what makes "below the terminated frame" a guarantee).
export function makeSealableStderr(real: NodeJS.WriteStream, onWriteFailure: (cause: string) => void): SealableStderr {
  let sealed = false;
  let sealedDrops = 0;
  let cursorCompensated = false;

  const absorb = (cause: string): void => {
    try {
      onWriteFailure(cause);
    } catch {
      // the failure channel itself must never throw back into Ink
    }
  };
  const errorAbsorber = (err: unknown): void => absorb(`stderr 'error' event: ${errText(err)}`);
  real.on("error", errorAbsorber);

  const write = (chunk: unknown, encodingOrCb?: unknown, maybeCb?: unknown): boolean => {
    const cb: WriteCb | undefined =
      typeof encodingOrCb === "function" ? (encodingOrCb as WriteCb) : typeof maybeCb === "function" ? (maybeCb as WriteCb) : undefined;
    const encoding = typeof encodingOrCb === "string" ? (encodingOrCb as BufferEncoding) : undefined;
    if (sealed) {
      sealedDrops++;
      cb?.();
      return true;
    }
    // acknowledge WITHOUT the error: a broken stderr must degrade the dashboard, never surface
    // through React internals — the absorb path latches and degrades instead.
    const ack: WriteCb = (err) => {
      if (err != null) absorb(`stderr write callback error: ${errText(err)}`);
      cb?.();
    };
    try {
      return encoding !== undefined ? real.write(chunk as never, encoding, ack) : real.write(chunk as never, ack);
    } catch (e) {
      absorb(`stderr write threw: ${errText(e)}`);
      cb?.();
      return true;
    }
  };

  // Ink-facing dimension pin (a RECORDED DEVIATION from §U1's delegation letter, grounded in
  // §U0): ink's own layout calls its getWindowSize(stdout) helper at five internal sites, and
  // whenever `columns && rows` is falsy that helper falls through to the terminal-size package —
  // which can SHELL OUT (tput/resize helpers) — a spawn route outside github.ts, inside our
  // process. The proxy therefore never hands ink a non-renderable dimension: real positive
  // integers delegate untouched; everything else (undefined, 0, NaN, negatives, fractions,
  // Infinity — the falsy spawn triggers plus the nonsense numerics ink would misrender) pins to
  // ink's own documented 80x24 defaults. The App does NOT read the pinned values for layout:
  // getRawDims() exposes the real stream's actual values (undefined included), so §U5's
  // EMPTY-frame discipline still sees the truth.
  const pinDim = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback);
  const rawDim = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const getRawDims = (): { columns: number | undefined; rows: number | undefined } => ({
    columns: rawDim((real as { columns?: unknown }).columns),
    rows: rawDim((real as { rows?: unknown }).rows),
  });
  const overrides: Record<PropertyKey, unknown> = { write };
  const stream = new Proxy(real, {
    get(target, prop) {
      if (prop === "columns") return pinDim((target as { columns?: unknown }).columns, 80);
      if (prop === "rows") return pinDim((target as { rows?: unknown }).rows, 24);
      if (prop === "getRawDims") return getRawDims;
      if (prop in overrides) return overrides[prop];
      // receiver = target on purpose: getters (isTTY etc.) must read the REAL stream's state,
      // and returned methods are bound to it — true fallthrough delegation (§U1).
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as NodeJS.WriteStream;

  return {
    stream,
    get sealed() {
      return sealed;
    },
    get sealedDrops() {
      return sealedDrops;
    },
    get cursorCompensated() {
      return cursorCompensated;
    },
    seal(): void {
      sealed = true;
    },
    compensateCursor(): void {
      // Write the cursor-show escape ONCE on Ink's behalf — for any path where Ink's own
      // restore write was (or will be) dropped by the seal: sealEarly, a timed-out/failed
      // unmount, or a late-handle unwind against an already-sealed proxy. Idempotent;
      // best-effort (a dead stderr cannot be compensated, and must not throw here). A
      // redundant show when the cursor is already visible is a terminal no-op.
      if (cursorCompensated) return;
      cursorCompensated = true;
      try {
        real.write(SHOW_CURSOR, () => {});
      } catch {
        // best-effort only
      }
    },
    sealEarly(): void {
      // seal + cursor-show compensation in the SAME synchronous step: Ink hid the cursor at
      // mount and its own restore write would be dropped by the seal; a SIGINT landing inside
      // the unmount wait must not strand a hidden cursor (§U1). ALWAYS compensates — even when
      // a plain seal() got there first (a teardown racing a mount failure): the contract is
      // seal+show, and compensateCursor's own once-flag carries the idempotence, so a repeat
      // call still writes the escape at most once.
      sealed = true;
      this.compensateCursor();
    },
    detach(): void {
      real.off("error", errorAbsorber);
    },
  };
}

// ---- the lifecycle wrapper -------------------------------------------------------------------
export interface TuiDeps {
  decision: ActivationDecision;
  mountImpl?: () => Promise<{ mountTui: typeof mountTui }>; // default: import("./mount.tsx")
  divertIo?: DivertIo; // default: realDivertIo
  logPathFor?: (attempt: number) => string; // contained candidate builder (main injects makeDivertPathFor(...))
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  streams: { stderr: NodeJS.WriteStream };
  nowMs?: () => number;
  storeImpl?: (nowMs: () => number) => TuiStore; // test seam: fault-inject store.dispatch
}

// States: off → mounting → on → closing → closed (§U6). Failure SIGNALING is the §U2 latch;
// failure REACTION is degradeNow — handed to every failing site — and every path converges on
// ONE cached teardownOnce(): single-flight and idempotent by construction.
export async function runWithTui<T>(deps: TuiDeps, body: () => Promise<T>): Promise<T> {
  // off (plan/CI/--no-ui/non-TTY): byte-identical passthrough — no proxy, no seams, no cost.
  if (deps.decision.mode !== "on") return body();

  resetTuiFailure(); // a fresh lifecycle starts with a clean latch (§U1)
  const nowMs = deps.nowMs ?? Date.now;
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const io = deps.divertIo ?? realDivertIo;
  const realStderr = deps.streams.stderr;

  const state = {
    teardown: null as Promise<void> | null,
    handle: null as TuiHandle | null,
    divertFd: null as number | null,
    divertPath: null as string | null,
    divertClosedEarly: false,
    bodySettled: false,
  };

  // The degrade channel is DIRECT, not tick-dependent (§U1): handed to the sink closures, to
  // mountTui as onDegrade, and (via mount) to the exit-rejection handler and the error boundary.
  const degradeNow = (): void => {
    void teardownOnce();
  };
  const proxy = makeSealableStderr(realStderr, (cause) => {
    reportTuiFailure(cause);
    degradeNow();
  });

  const writeReal = (text: string): void => {
    // the noop callback routes an async write failure to the callback instead of a later
    // 'error' event — our own teardown lines can never seed a post-detach crash
    realStderr.write(text, () => {});
  };
  // Best-effort variant for every OUTSIDE-teardown warning site: a broken stderr must degrade
  // the dashboard, never throw into the setup path and kill the audit (§U0 has no exceptions).
  const warnReal = (text: string): void => {
    try {
      writeReal(text);
    } catch {
      // nowhere left to warn to — the audit still runs
    }
  };

  // waitUntilExit bounded by the INJECTED timers (§U6 step 2). TOTAL: never rejects, and a
  // throwing injected timer cannot hang it (a broken timer resolves the wait immediately —
  // skipping the grace beats an unbounded hang); ALWAYS clears the loser when the exit wins.
  // Returns HOW the wait ended — a non-"exited" outcome is a teardown fact the caller must
  // surface as a deferred warning, never silent success (a wedged Ink left a hidden cursor and
  // a sealed stream dropping its frames; the operator deserves the one line saying so).
  // The wait's OWN timer-plumbing failures surface through the optional `warn` collector too
  // (§U6: teardown-step failures become deferred warnings — bounded impact does not waive
  // observability; dynamic text goes through errText, the callers' join writes verbatim). Only
  // the clear-failure's EFFECT stays swallowed: the settled guard makes a later fire a no-op,
  // and the leaked one-shot is a ≤2s ref'd timer — a bounded exit delay, never a hang.
  type ExitOutcome = "exited" | "timeout" | "wait-rejected" | "wait-threw" | "timer-failed";
  const boundedExitWait = (h: TuiHandle, warn?: (msg: string) => void): Promise<ExitOutcome> =>
    new Promise<ExitOutcome>((resolve) => {
      let settled = false;
      const done = (outcome: ExitOutcome): void => {
        if (settled) return;
        settled = true;
        if (t !== null) {
          const timer = t;
          t = null;
          try {
            timers.clearTimeout(timer);
          } catch (e) {
            warn?.(`exit-wait: timer clear failed: ${errText(e)}`);
          }
        }
        resolve(outcome);
      };
      let t: ReturnType<typeof setTimeout> | null = null;
      let timerFailed = false;
      try {
        t = timers.setTimeout(() => done("timeout"), TEARDOWN_EXIT_WAIT_MS);
      } catch (e) {
        timerFailed = true; // no timer → no way to bound the wait → end it now (below)
        warn?.(`exit-wait: timer create failed: ${errText(e)}`);
      }
      try {
        h.waitUntilExit().then(
          () => done("exited"),
          () => done("wait-rejected"),
        );
      } catch {
        done("wait-threw");
      }
      if (timerFailed) done("timer-failed");
    });

  // The ONE teardown sequence (§U6) — cached promise; degrade and the finally both await it.
  // PUBLISH-BEFORE-SIDE-EFFECTS: the promise is stored before ANY step runs — the naive
  // `promise ??= run()` is synchronously reentrant (dispose()/requestUnmount() can trigger
  // onDegrade before the assignment lands) and would double-run.
  const teardownOnce = (): Promise<void> => {
    if (state.teardown !== null) return state.teardown;
    let resolveTeardown!: () => void;
    state.teardown = new Promise<void>((r) => {
      resolveTeardown = r;
    });
    // Teardown while the body is still in flight strands the divert file mid-stream — announcing
    // it as the complete log would be a lie (§U6 step 5).
    if (!state.bodySettled && state.divertFd !== null) state.divertClosedEarly = true;
    const stepWarnings: string[] = [];
    const guarded = (label: string, fn: () => void): void => {
      try {
        fn();
      } catch (e) {
        stepWarnings.push(`${label}: ${errText(e)}`);
      }
    };
    // TOTAL by construction: every step individually guarded, the awaited wait never rejects,
    // and the finally publishes completion no matter what — a teardown defect can never leave
    // the cached promise pending (which would hang the finally awaiting it: a kill, §U0).
    void (async () => {
      try {
        const h = state.handle;
        // 1. stop the tick + App-side hooks (skipped when the handle never arrived)
        guarded("dispose", () => h?.dispose());
        // 2. unmount + bounded exit wait. A non-"exited" outcome is NOT silent success: it is a
        // teardown fact the operator must see (a wedged Ink whose frames the seal will drop).
        const sealedBeforeUnmount = proxy.sealed;
        let exitOutcome: "exited" | "timeout" | "wait-rejected" | "wait-threw" | "timer-failed" | "no-handle" = "no-handle";
        if (h !== null) {
          try {
            h.requestUnmount();
          } catch (e) {
            stepWarnings.push(`unmount: ${errText(e)}`);
            // §U6-ORDER DEVIATION (failure path only; recorded in the PR): an unmount that
            // THREW forfeited its own cursor restore and its grace-window painting — seal NOW
            // (sealEarly shows the cursor in the same synchronous step) so a SIGINT inside the
            // bounded wait below cannot exit cursorless, and a queued Ink render cannot re-hide
            // what was just shown. The step-3 seal below stays idempotent.
            guarded("unmount-seal", () => proxy.sealEarly());
          }
          exitOutcome = await boundedExitWait(h, (m) => stepWarnings.push(m));
          if (exitOutcome !== "exited") stepWarnings.push(`exit-wait: unmount did not complete cleanly (${exitOutcome})`);
        }
        // 3. seal — from here NOTHING (a wedged Ink, queued renders, its console patch) can reach
        // the real stderr; sealed-off attempts are counted into the step-6 warning.
        guarded("seal", () => proxy.seal());
        // 4. clear the seams (restores stdout)
        guarded("clear-seams", () => {
          setProgressSink(null);
          setLogTap(null);
          setLogSink(null);
        });
        // 5. close the divert + announce the ACTUAL path, partial-file wording when incomplete
        if (state.divertFd !== null) {
          guarded("close-divert", () => io.close(state.divertFd!));
          const latch = tuiFailure();
          // the path is ours (contained, our grammar) — sanitized anyway: nothing dynamic
          // reaches the terminal unsanitized (§U0), operator-config bytes included
          const shownPath = sanitizeLine(state.divertPath ?? "");
          const exitLine =
            latch?.divertFailedMidRun === true
              ? `JSONL log (partial — divert failed mid-run, remainder went to stdout): ${shownPath}`
              : state.divertClosedEarly
                ? `JSONL log (partial — dashboard ended mid-run, remainder went to stdout): ${shownPath}`
                : `JSONL log: ${shownPath}`;
          guarded("exit-line", () => writeReal(exitLine + "\n"));
        }
        // 5a. cursor compensation for every path where Ink's own restore write did not land:
        // a seal that preceded unmount without sealEarly's compensation (a defensive
        // impossibility — every pre-unmount seal site uses sealEarly), and the REAL case a
        // bounded-exit failure leaves behind — a wedged/failed unmount never restored the
        // cursor, and the step-3 seal has closed the stream to any late restore attempt.
        if (!proxy.cursorCompensated && (sealedBeforeUnmount || (state.handle !== null && exitOutcome !== "exited")))
          guarded("cursor-show", () => proxy.compensateCursor());
        // 6. the ONE latched-failure warning (first cause + sealed-write count), if any
        const latch = tuiFailure();
        if (latch !== null) {
          const drops = proxy.sealedDrops > 0 ? ` (${proxy.sealedDrops} suppressed frame write${proxy.sealedDrops === 1 ? "" : "s"})` : "";
          // firstCause can carry error text from any failing site — sanitized at the ONE place
          // it reaches the terminal (§U0)
          guarded("failure-warning", () => writeReal(`package-audit: dashboard disabled — ${sanitizeLine(latch.firstCause)}${drops}\n`));
        }
        if (stepWarnings.length > 0) {
          try {
            writeReal(`package-audit: dashboard teardown warnings — ${stepWarnings.join("; ")}\n`);
          } catch {
            // teardown NEVER throws — a propagating payload error must not be masked
          }
        }
        // 7. the stderr error absorber deliberately STAYS attached: an asynchronous write
        // error from teardown's own step-5/6 lines (a dying pipe delivering EIO a tick later)
        // must never surface as an unhandled 'error' event and kill an otherwise completed
        // audit (§U0). The remaining window is teardown→process-exit — milliseconds — and the
        // absorber is inert observability by construction. (proxy.detach() exists for tests.)
      } finally {
        resolveTeardown();
      }
    })().catch(() => {
      // unreachable (the body is total), kept so a future defect degrades instead of surfacing
      // as an unhandled rejection
    });
    return state.teardown;
  };

  // ---- setup (§U1 normative order); any failure degrades per §U6 and body() runs regardless --
  let mounted = false;
  try {
    const load = deps.mountImpl ?? (() => import("./mount.tsx"));
    const mod = await load();
    // Reentrancy barrier (§U6): a mount-time degrade may have already torn down (an error
    // boundary can fire before mountTui even returns) — once teardown has started, setup
    // installs NOTHING further and unwinds what it just created.
    if (state.teardown === null) {
      const store = (deps.storeImpl ?? createTuiStore)(nowMs);
      const h = mod.mountTui(store, { out: proxy.stream, onDegrade: degradeNow, nowMs });
      if (state.teardown !== null) {
        // Teardown ran with a null handle — unwind the LATE-ARRIVING handle fully: dispose,
        // then unmount + bounded wait (the proxy is already sealed, so a late frame cannot
        // smear output; the unwind is about not leaking Ink's timers/hooks). Unwind failures
        // surface as a best-effort warning, never silently (§U6's deferred-warning rule).
        const unwindWarnings: string[] = [];
        // The teardown that ran ahead of this unwind sealed the proxy, so the late renderer's
        // OWN cursor restore was (or will be) dropped — compensate FIRST, before the unmount
        // and its bounded wait: a SIGINT inside that wait must not exit cursorless (§U1).
        // Plain compensate, not sealEarly — the proxy is already sealed; idempotent,
        // best-effort (compensateCursor is internally total).
        try {
          proxy.compensateCursor();
        } catch {
          // best-effort
        }
        try {
          h.dispose();
        } catch (e) {
          unwindWarnings.push(`dispose: ${errText(e)}`);
        }
        try {
          h.requestUnmount();
        } catch (e) {
          unwindWarnings.push(`unmount: ${errText(e)}`);
        }
        const unwindOutcome = await boundedExitWait(h, (m) => unwindWarnings.push(m));
        if (unwindOutcome !== "exited") unwindWarnings.push(`exit-wait: ${unwindOutcome}`);
        if (unwindWarnings.length > 0) warnReal(`package-audit: dashboard unwind warnings — ${unwindWarnings.join("; ")}\n`);
      } else {
        state.handle = h;
        mounted = true;
        // Install order (§U1): seams only after a successful mount — a mount failure leaves
        // JSONL on stdout, the exact pre-feature behavior.
        // The GUARDED progress sink: a store fold bug clears the sink SYNCHRONOUSLY (later
        // emits must not keep throwing/allocating until teardown reaches the seams) and
        // degrades immediately — never waits for a tick.
        setProgressSink((e) => {
          try {
            store.dispatch(e);
          } catch (err) {
            setProgressSink(null);
            reportTuiFailure(errText(err));
            degradeNow();
          }
        });
        // The tap: hasProgressSink() keeps it allocation-free once the sink is gone (§U0).
        // Self-reporting (§U1): a throwing tap clears itself, latches, and degrades — the
        // unified failure channel, not log.ts's dependency-free self-clear backstop. (In
        // practice emitProgress never throws; this is the contract made local.)
        setLogTap((ev) => {
          try {
            if (hasProgressSink()) emitProgress({ type: "jsonl", event: ev });
          } catch (err) {
            setLogTap(null);
            reportTuiFailure(errText(err));
            degradeNow();
          }
        });
        // Never open the divert into a dead lifecycle (§U6): a synchronous degrade between the
        // seam installs and here means teardown owns the collapse — install nothing further.
        if (deps.decision.divert && state.teardown === null) {
          let fd: number | null = null;
          let opened: string | null = null;
          let openErr: unknown = null;
          const pathFor = deps.logPathFor;
          if (pathFor === undefined) {
            openErr = new Error("divert requested but no log-path builder was provided");
          } else {
            for (let attempt = 0; attempt < DIVERT_OPEN_ATTEMPTS; attempt++) {
              let candidate: string;
              try {
                candidate = pathFor(attempt); // containment failure = open failure, degrade below
              } catch (e) {
                openErr = e;
                break;
              }
              try {
                fd = io.open(candidate);
                opened = candidate; // record WHICH candidate succeeded — it feeds the footer + exit line
                openErr = null;
                break;
              } catch (e) {
                openErr = e;
                if ((e as { code?: unknown }).code === "EEXIST") continue; // try the next suffix
                break; // any other open/mkdir failure degrades
              }
            }
          }
          if (fd === null || opened === null) {
            // Degrade, never fatal, never silent-divert-to-terminal (§U1): tear the just-mounted
            // dashboard down and AWAIT it — the frame must be fully down BEFORE JSONL starts
            // flowing to a same-terminal stdout.
            reportTuiFailure(`divert log open failed: ${errText(openErr)}`);
            await teardownOnce();
          } else {
            state.divertFd = fd;
            state.divertPath = opened;
            const divertFd = fd;
            setLogSink((line) => {
              try {
                io.write(divertFd, line);
              } catch (err) {
                // Mid-run divert write failure (§U1), one synchronous transition: seal the frame
                // BEFORE any JSONL can reach a same-terminal stdout (sealEarly also compensates
                // the cursor), latch the divert flag, start teardown, then rethrow — the log
                // seam restores stdout and re-emits this exact line (no event is lost).
                //
                // DOCUMENTED ORDER DEVIATION (recorded in the PR): §U1's numbered list reads
                // seal → restore+re-emit → report → degrade, but its own mechanism sentences
                // (the closure reports; the log seam — the one module allowed to touch the
                // machine stdout — restores and re-emits downstream of this rethrow) make that
                // literal order unimplementable. Actual order: seal, report, degrade, rethrow,
                // then the seam's restore+re-emit — still ONE synchronous call, and every
                // stated invariant holds: the seal precedes any stdout byte, the failing line
                // is re-emitted in the same call, and the flag is set long before teardown
                // reads it (teardown suspends at its first await before any of its output).
                proxy.sealEarly();
                reportDivertFailure(errText(err));
                degradeNow();
                throw err;
              }
            });
            emitProgress({ type: "divert", path: opened });
          }
        }
        // FINAL state check (§U1): any setup step — including a synchronous one like the divert
        // event tripping the guarded sink — may have started teardown; body() always starts with
        // the lifecycle either fully ON or fully torn down, never mid-collapse.
        if (state.teardown !== null) await teardownOnce();
      }
    }
  } catch (e) {
    // Load/mount failure (§U6): warn once on stderr, run with TUI off. Install order guarantees
    // no seam was installed — but a mountTui that threw AFTER Ink's render() succeeded could
    // leave a live renderer with no handle, so SEAL the proxy defensively: a leaked Ink can
    // never smear frames over the bare run (sealEarly also restores the cursor Ink may have
    // hidden before the throw; a stray cursor-show on a plain import failure is a no-op).
    // Both the seal and the warn are total — a broken stderr must degrade, never kill (§U0).
    try {
      proxy.sealEarly();
    } catch {
      // sealEarly is internally total; belt-and-braces only
    }
    // (When a degrade already started teardown, its step-6 warning covers the cause instead.)
    if (state.teardown === null) warnReal(`package-audit: dashboard disabled — ${errText(e)}\n`);
  }

  try {
    return await body();
  } finally {
    state.bodySettled = true;
    await teardownOnce();
  }
}
