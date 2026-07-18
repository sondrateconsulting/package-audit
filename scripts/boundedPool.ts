// boundedPool.ts — the orchestrator's fan-out primitive (§5 concurrency). A hand-rolled bounded
// worker pool + a lib-agnostic abort signal, matching github.ts's Semaphore style (no external
// dependency; the repo ships only `typescript`). Used by runScan (owner pool) and processRepo
// (per-repo branch-unit pool). Deliberately SEPARATE from github.ts's gh-spawn Semaphore: this
// bounds how many owner/branch UNITS are dispatched at once, while that bounds how many network
// subprocesses run at once — the two caps compose (see PROMPT.md §4).

// Minimal abort plumbing (mirrors github.ts's SpawnAbortSignal): the tsconfig lib is ESNext-only, so
// the platform AbortController/AbortSignal instance types are unavailable here. `Aborter` is the
// producer a run creates and trips on the first escaping error; `AbortLike` is the read side threaded
// into workers and the pool so cancellation is observable without dragging in lib.dom.
export interface AbortLike {
  readonly aborted: boolean;
  onAbort(cb: () => void): void; // fires immediately if already aborted
}

export class Aborter implements AbortLike {
  private isAborted = false;
  private callbacks: Array<() => void> = [];
  get aborted(): boolean {
    return this.isAborted;
  }
  onAbort(cb: () => void): void {
    if (this.isAborted) cb();
    else this.callbacks.push(cb);
  }
  // Idempotent: the first call latches `aborted` and fires every registered callback ONCE; later
  // calls are no-ops. Callbacks are drained (not re-run) so a re-abort cannot double-fire them.
  abort(): void {
    if (this.isAborted) return;
    this.isAborted = true;
    const cbs = this.callbacks;
    this.callbacks = [];
    for (const cb of cbs) cb();
  }
}

// Per-item outcome, positionally aligned with the input `items` — results[i] is items[i]'s outcome
// regardless of completion order, so a caller's downstream logic (fatal precedence, coverage
// collection) stays deterministic under fan-out. `skipped` = never dispatched because the pool was
// aborted before this item's turn (distinct from a worker that ran and rejected).
export type PoolResult<R> =
  | { readonly status: "fulfilled"; readonly value: R }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "skipped" };

// Run `worker(item, index)` over `items` with at most `limit` in flight. SETTLE-ALL: a worker that
// throws is captured as a `rejected` result — it NEVER aborts its siblings and the returned promise
// NEVER rejects, so the caller can drain every in-flight worker before deciding what an escape means
// (fail the run / rethrow / record). This is the structured drain §7 depends on: the alternative
// (bare Promise.all fail-fast) would resolve while sibling fibers still write to the DB, racing
// db.close(). On abort, in-flight workers DRAIN (their results are kept) and undispatched items are
// left `skipped` — dispatch stops at the next pull, never mid-worker.
export async function boundedPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  opts: { signal?: AbortLike } = {},
): Promise<Array<PoolResult<R>>> {
  const results = new Array<PoolResult<R>>(items.length);
  const signal = opts.signal;
  let next = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return; // stop pulling; remaining items stay `skipped`
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await worker(items[i]!, i) };
      } catch (reason) {
        // captured, not propagated — a sibling's failure must not tear down the whole pool
        results[i] = { status: "rejected", reason };
      }
    }
  };
  const width = items.length === 0 ? 0 : Math.min(Math.max(1, limit), items.length);
  // runner() never throws (worker errors are captured), so this Promise.all never rejects — it is a
  // pure "await every runner to settle" barrier, the structured-drain guarantee this file exists for.
  await Promise.all(Array.from({ length: width }, () => runner()));
  for (let i = 0; i < items.length; i++) if (results[i] === undefined) results[i] = { status: "skipped" };
  return results;
}
