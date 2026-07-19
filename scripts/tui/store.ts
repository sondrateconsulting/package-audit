// store.ts — the TUI store (§U4 of PROMPT-TUI.md): a single mutable store folding
// ProgressEvents into a renderable snapshot. React-free; constructor injection for the clock
// (events are timeless — the store stamps arrival time). P1 lands the lifecycle-facing skeleton
// (dispatch/version/snapshot); the real per-variant folds land in P2.
import type { ProgressEvent } from "../progress.ts";

export interface TuiSnapshot {
  readonly logPath: string | null; // from the `divert` event — the ACTUAL opened path
}

export interface TuiStore {
  readonly version: number; // incremented per mutation (render-skip signal)
  snapshot(): TuiSnapshot;
  dispatch(e: ProgressEvent): void;
}

export function createTuiStore(nowMs: () => number): TuiStore {
  void nowMs; // P2: arrival-time stamping for spans/problems
  let version = 0;
  let logPath: string | null = null;
  return {
    get version() {
      return version;
    },
    snapshot(): TuiSnapshot {
      return { logPath };
    },
    dispatch(e: ProgressEvent): void {
      // P2 lands the full exhaustive fold; the P1 skeleton folds only what the lifecycle emits.
      if (e.type === "divert") logPath = e.path;
      version++;
    },
  };
}
