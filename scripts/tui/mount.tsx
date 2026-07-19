// mount.tsx — the ONE Ink/React mount adapter (§U5 of PROMPT-TUI.md). Everything JSX/React/Ink
// lives behind this module, which lifecycle.ts loads EXCLUSIVELY via dynamic import: a broken
// display dependency must never break the audit, and non-TUI runs (help/--plan/CI/piped) never
// pay the load cost.
//
// Display-only (§U0): no useInput anywhere (Ink never enables raw mode), exitOnCtrlC: false
// (SIGINT keeps its default kill-and-resume semantics; Ink's own signal-exit cursor cleanup is
// accepted), and nothing here can reach the machine stdout stream or the filesystem (the
// tuiPurity scan enforces both) — the render target is exactly `opts.out` (the lifecycle's
// sealable stderr proxy).
import { Component, type ReactNode } from "react";
import { render } from "ink";
import { reportTuiFailure, tuiFailure } from "../progress.ts";
import type { TuiStore } from "./store.ts";
import { App } from "./App.tsx";

export const DEFAULT_TICK_MS = 125;

// TOTAL error rendering: a hostile thrown value (throwing toString/message getter) must never
// make a failure handler itself throw into React or a timer callback.
function causeText(e: unknown): string {
  try {
    if (e instanceof Error && typeof e.message === "string") return e.message;
    return String(e);
  } catch {
    return "unprintable error";
  }
}

export interface TuiHandle {
  requestUnmount(): void;
  waitUntilExit(): Promise<void>;
  dispose(): void; // stops the tick + detaches the App-side frame hook; idempotent
}

// The store surface the adapter itself needs (the App consumes the full TuiStore).
export interface MountableStore {
  readonly version: number;
  snapshot(): unknown;
}

export interface MountTuiOptions {
  out: NodeJS.WriteStream; // the lifecycle's SEALABLE stderr proxy — Ink's render target
  onDegrade: () => void; // = lifecycle degradeNow; called DIRECTLY on any App failure (§U5)
  nowMs?: () => number; // elapsed/countdown derivation at render; events stay timeless
  scheduler?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  tickMs?: number; // default DEFAULT_TICK_MS; tests inject to drive frames deterministically
  renderImpl?: typeof render; // test seam (like lifecycle's storeImpl): rollback proof needs a
  //                             spy renderer that is CI-stable; production default is ink's render
}

// Belt-and-braces for RENDER throws (§U5): timer callbacks never reach a boundary — the guarded
// tick below is the real protection there. The fallback renders nothing; the crash handler
// latches AND degrades directly (a dead React tree cannot be relied on to poll the latch).
class Boundary extends Component<{ onCrash: (cause: string) => void; children: ReactNode }, { crashed: boolean }> {
  override state = { crashed: false };
  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }
  override componentDidCatch(error: unknown): void {
    this.props.onCrash(causeText(error));
  }
  override render(): ReactNode {
    return this.state.crashed ? null : this.props.children;
  }
}

export function mountTui(store: TuiStore, opts: MountTuiOptions): TuiHandle {
  const scheduler = opts.scheduler ?? { setInterval, clearInterval };
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const nowMs = opts.nowMs ?? Date.now;
  const renderImpl = opts.renderImpl ?? render;

  // One-listener frame bus: the tick (outside React) wakes the App (inside React) without the
  // scheduler ever living in a component — dispose() can then stop everything non-reentrantly.
  let frameListener: (() => void) | null = null;
  const subscribe = (fn: () => void): (() => void) => {
    frameListener = fn;
    return () => {
      if (frameListener === fn) frameListener = null;
    };
  };

  const onCrash = (cause: string): void => {
    reportTuiFailure(cause);
    opts.onDegrade(); // the degrade channel is DIRECT, never tick-dependent (§U5)
  };

  // ---- adapter cleanup state + routines, declared BEFORE the render so the rollback catch can
  // never hit a temporal-dead-zone reference no matter which tail statement threw ----
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastVersion = -1;
  let lastSecond = -1;
  // TOTAL: a throwing injected clearInterval must not escape a caller (dispose, the tick's own
  // catch) — the timer slot is nulled first. When the clear itself fails, the interval's WORK is
  // already inert (disposed/tick guards), but a still-live REF'D interval would hold the event
  // loop open and hang the process at exit — a hang is a kill (§U0) — so the catch also tries
  // unref() where the timer token supports it. A collector, when given, records the failure for
  // the §U6 deferred-warning channel.
  const stopTick = (collect?: (msg: string) => void): void => {
    if (timer === null) return;
    const t = timer;
    timer = null;
    try {
      scheduler.clearInterval(t);
    } catch (e) {
      collect?.(`clear-tick: ${causeText(e)}`);
      try {
        (t as unknown as { unref?: () => void }).unref?.();
      } catch {
        // best-effort only
      }
    }
  };
  // Guarded tick (§U5): a React error boundary cannot catch timer callbacks — this try/catch is
  // the real protection here. The latch check is belt-and-braces, NOT the degrade channel (every
  // failing site calls degradeNow directly); it is the second net for anything that only latched.
  // Wake React when the store moved OR a visible 1s-granularity digit (elapsed/countdown) would
  // change; otherwise skip the setState entirely.
  const tick = (): void => {
    try {
      if (disposed) return; // an uncancellable interval still firing after dispose does nothing
      if (tuiFailure() !== null) {
        stopTick();
        opts.onDegrade();
        return;
      }
      const second = Math.floor(nowMs() / 1000);
      if (store.version !== lastVersion || second !== lastSecond) {
        lastVersion = store.version;
        lastSecond = second;
        frameListener?.();
      }
    } catch (err) {
      stopTick();
      onCrash(causeText(err));
    }
  };
  // Resize wake channel, OWNED HERE (not an App effect) so cleanup detaches it deterministically
  // even when a wedged/failed unmount never runs React's effect cleanup — no post-teardown
  // re-renders, no listener left doing work against a sealed stream. It rides the same frame bus
  // as the tick. (Deliberately not ink's useWindowSize — see App.tsx.)
  const onResize = (): void => {
    try {
      if (!disposed) frameListener?.();
    } catch {
      // waking React is best-effort; a resize can never become a crash channel
    }
  };
  // The ONE cleanup routine, shared by dispose() and the rollback catch. Order is load-bearing:
  // callbacks are inerted FIRST (disposed flag + frame bus cleared) so a tick or resize firing
  // mid-cleanup does nothing, then the timer and listener are best-effort released with every
  // failure COLLECTED — §U6 makes teardown-step failures deferred warnings, never silence.
  const cleanup = (): string[] => {
    const failures: string[] = [];
    disposed = true;
    frameListener = null;
    stopTick((m) => failures.push(m));
    try {
      opts.out.off("resize", onResize);
    } catch (e) {
      failures.push(`detach-resize: ${causeText(e)}`);
    }
    return failures;
  };

  const instance = renderImpl(
    <Boundary onCrash={onCrash}>
      <App store={store} subscribe={subscribe} nowMs={nowMs} mountedAtMs={nowMs()} />
    </Boundary>,
    {
      stdout: opts.out, // load-bearing: Ink's "stdout" IS our (sealable) stderr proxy
      stderr: opts.out,
      exitOnCtrlC: false, // §U0 display-only: SIGINT keeps its default kill-and-resume semantics
      patchConsole: true, // stray console.* (React warnings!) render ABOVE the frame, never smear it
      // `stdin` is deliberately ABSENT (not `stdin: undefined`): Ink spreads the caller's options
      // over its defaults, so an explicit undefined CLOBBERS the default stream and silently wedges
      // rendering (P0 finding). Display-only — nothing here ever reads input.
    },
  );

  // Everything AFTER the render is wrapped so a failure here (a throwing injected scheduler, a
  // broken listener registration, a throwing waitUntilExit at the rejection-handler attach) can
  // never leak the live renderer, a ref'd interval, or the resize hook: run the SHARED cleanup
  // (its failures deliberately DISCARDED — the original mount error must reach the lifecycle's
  // mount-failure path unmasked), best-effort unmount, then rethrow.
  try {
    timer = scheduler.setInterval(tick, tickMs);
    opts.out.on("resize", onResize);
    // Rejection handler attached AT MOUNT (§U5): an unhandled waitUntilExit rejection would
    // violate degrade-never-kill (§U0), and a dead React tree cannot be relied on to poll any
    // latch.
    instance.waitUntilExit().catch((e: unknown) => {
      onCrash(causeText(e));
    });

    return {
      requestUnmount(): void {
        instance.unmount();
      },
      waitUntilExit(): Promise<void> {
        return instance.waitUntilExit().then(() => undefined);
      },
      dispose(): void {
        if (disposed) return;
        const failures = cleanup();
        // §U6: teardown-step failures become deferred warnings — the aggregate is thrown AFTER
        // the full cleanup ran, and teardownOnce's guarded("dispose") turns it into the warning
        // line. A repeat dispose() early-returns above, so idempotence holds.
        if (failures.length > 0) throw new Error(`adapter cleanup: ${failures.join("; ")}`);
      },
    };
  } catch (e) {
    cleanup();
    try {
      instance.unmount(); // roll the live renderer back before surfacing the mount failure
    } catch {
      // best-effort rollback
    }
    throw e;
  }
}
