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

  const instance = render(
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

  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastVersion = -1;
  let lastSecond = -1;
  // TOTAL: a throwing injected clearInterval must neither escape a caller (dispose, the tick's
  // own catch) nor mark the stop as done-without-clearing more than once — the timer slot is
  // nulled first, and the disposed flag makes a still-firing uncancellable interval a no-op.
  const stopTick = (): void => {
    if (timer === null) return;
    const t = timer;
    timer = null;
    try {
      scheduler.clearInterval(t);
    } catch {
      // a scheduler that cannot cancel leaves a firing interval; the disposed check below
      // makes every later tick a no-op, and teardown proceeds regardless
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
  timer = scheduler.setInterval(tick, tickMs);

  // Rejection handler attached AT MOUNT (§U5): an unhandled waitUntilExit rejection would violate
  // degrade-never-kill (§U0), and a dead React tree cannot be relied on to poll any latch.
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
      disposed = true;
      stopTick();
      frameListener = null;
    },
  };
}
