// benchDiskSampler.ts — the §4.6 peak-disk metric, sampled without BLOCKING the measured wall.
// Precisely: the walk no longer runs on the main thread inside the window, and the final snapshot
// is taken with the wall paused. It is NOT a claim that instrumentation costs the wall nothing —
// a walk on another thread still competes for CPU and disk bandwidth with the git subprocess
// under test. That residual is declared in the plan's §4.6 amendment.
//
// Two implementations behind one port:
//   WorkerDiskSampler — the default for TIMED runs. Each tick posts a request to a worker and
//                       returns immediately; the walk happens on another thread and the reply
//                       updates the peak. The main thread's per-tick cost is a postMessage.
//   InlineDiskSampler — the same accounting with a synchronous walk. Correct only where nothing
//                       is being timed (pinning, diagnostics) or where a test injects the walk.
import { duBytes, duBytesStrict, extraBytes, extraBytesStrict } from "./benchDiskWalk.ts";
import type { DiskWalkReply, DiskWalkRequest } from "./benchDiskWorker.ts";

export interface DiskSnapshot {
  peakBytes: number;
  samples: number;
  /** null when no clone store existed OR when its walk failed — a failed MEASUREMENT is never
   *  reported as a plausible 0. `sampleError` distinguishes the two. */
  cloneObjectStoreBytes: number | null;
  /** non-null when instrumentation itself failed. The run is still recorded: losing a measured
   *  row because the harness could not measure its own disk usage would be strictly worse. */
  sampleError: string | null;
}

export interface DiskSamplerPort {
  start(dir: string, hz: number): void;
  extraFiles(paths: readonly string[]): void;
  /** Stop sampling and return the final snapshot. Includes a last point sample of `dir`, plus
   *  the clone object-store size when `cloneGitDir` is given. Never runs inside a timed window. */
  finish(dir: string, cloneGitDir: string | null): Promise<DiskSnapshot>;
  /** The peak observed SO FAR, synchronously and infallibly. Used where a record must land
   *  before any fallible work (the R5 halt row) and cannot wait on a worker round-trip. */
  peek(): DiskSnapshot;
  /** Release the sampler WITHOUT taking a snapshot. Synchronous, infallible, idempotent — for
   *  the paths that peek() and then abandon the run (R5), which would otherwise leave the tick
   *  timer armed and the worker alive. */
  abandon(): void;
}

const intervalMsFor = (hz: number): number => Math.max(1, Math.round(1000 / hz));

/** Validate a worker reply rather than casting it. Returns null when the payload is not a
 *  well-formed { seq, bytes } pair of finite non-negative numbers. */
export function parseDiskWalkReply(data: unknown): DiskWalkReply | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  const { seq, bytes, error } = o;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (error !== undefined && typeof error !== "string") return null;
  return error === undefined ? { seq, bytes } : { seq, bytes, error };
}

abstract class BaseSampler implements DiskSamplerPort {
  protected peak = 0;
  protected samples = 0;
  protected extras: readonly string[] = [];
  protected timer: ReturnType<typeof setInterval> | null = null;
  extraFiles(paths: readonly string[]): void {
    this.extras = paths;
  }
  protected observe(bytes: number): void {
    this.samples++;
    if (bytes > this.peak) this.peak = bytes;
  }
  protected stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
  peek(): DiskSnapshot {
    return { peakBytes: this.peak, samples: this.samples, cloneObjectStoreBytes: null, sampleError: null };
  }
  abandon(): void {
    this.stopTimer();
  }
  abstract start(dir: string, hz: number): void;
  abstract finish(dir: string, cloneGitDir: string | null): Promise<DiskSnapshot>;
}

export class InlineDiskSampler extends BaseSampler {
  private done: DiskSnapshot | null = null;
  constructor(
    private readonly walk: (dir: string, extras: readonly string[]) => number =
      (d, e) => duBytes(d) + extraBytes(e),
    // the RECORDED measurement gets the strict walker by default; only a test overrides it
    private readonly strictWalk: (dir: string) => number = duBytesStrict,
  ) {
    super();
  }
  start(dir: string, hz: number): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      try {
        this.observe(this.walk(dir, this.extras));
      } catch {
        // a lost SAMPLE is tolerable; finish()'s measurement is the one that must be honest
      }
    }, intervalMsFor(hz));
    this.timer.unref?.();
  }
  async finish(dir: string, cloneGitDir: string | null): Promise<DiskSnapshot> {
    if (this.done !== null) return this.done; // idempotent, matching WorkerDiskSampler
    this.stopTimer();
    let clone: number | null = null;
    let sampleError: string | null = null;
    try {
      if (cloneGitDir !== null) clone = this.strictWalk(cloneGitDir);
      // the FINAL sample is load-bearing (on a short run it may be the ONLY sample), and the
      // run dir is quiescent here — the driver has returned and reclamation has not started —
      // so tolerance would let an unreadable root record a plausible-looking 0-byte peak with
      // sampleError null. Strict on BOTH terms (a present-but-unreadable db sidecar must not
      // silently shrink the figure); ticks stay tolerant.
      this.observe(this.strictWalk(dir) + extraBytesStrict(this.extras));
    } catch (e) {
      sampleError = e instanceof Error ? e.message : String(e);
      clone = null;
    }
    this.done = { peakBytes: this.peak, samples: this.samples, cloneObjectStoreBytes: clone, sampleError };
    return this.done;
  }
}

/** A walk that failed rather than measured. cloneObjectStoreBytes is a RECORDED measurement, not
 *  a sample, so a failed walk must surface as null — never as a plausible-looking 0. */
export class DiskSamplerError extends Error {
  constructor(message: string) {
    super(`BENCH DISK SAMPLER: ${message}`);
    this.name = "DiskSamplerError";
  }
}

export class WorkerDiskSampler extends BaseSampler {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (b: number) => void; reject: (e: Error) => void }>();
  private failed: Error | null = null;
  private done: DiskSnapshot | null = null;
  private tickSeq: number | null = null; // the ONE outstanding tick, by sequence
  constructor(private readonly replyTimeoutMs = 120_000) {
    super();
  }
  /** Fail every awaited request and stop accepting new ones. A worker that died or never loaded
   *  must not leave finish() awaiting a reply that can never arrive. */
  private failAll(err: Error): void {
    this.failed = err;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    this.disposeWorker();
  }
  private disposeWorker(): void {
    try {
      this.worker?.terminate();
    } catch {
      // terminate is best-effort; the handle is dropped either way
    }
    this.worker = null;
  }
  private ensureWorker(): Worker {
    if (this.worker !== null) return this.worker;
    const w = new Worker(new URL("./benchDiskWorker.ts", import.meta.url).href);
    w.onmessage = (event: MessageEvent): void => {
      // a cross-thread payload is untrusted input like any other: validate before use rather
      // than casting, or a malformed reply silently becomes NaN in the peak
      const reply = parseDiskWalkReply(event.data);
      if (reply === null) {
        this.failAll(new DiskSamplerError("worker sent a malformed reply"));
        return;
      }
      const settle = this.pending.get(reply.seq);
      this.pending.delete(reply.seq);
      // a strict walk that failed inside the worker comes back as an ERROR, not a smaller number
      if (settle !== undefined) {
        if (reply.error !== undefined) settle.reject(new DiskSamplerError(reply.error));
        else settle.resolve(reply.bytes);
        return;
      }
      // Only the ONE outstanding tick may fold into the peak. Previously any well-shaped reply
      // with an unrecognised sequence was accepted as a sample, so a duplicate, stale, or
      // unsolicited message could fabricate a peak the filesystem never held.
      if (this.tickSeq !== null && reply.seq === this.tickSeq) {
        this.tickSeq = null;
        if (reply.error === undefined) this.observe(reply.bytes);
        return;
      }
      this.failAll(new DiskSamplerError(`worker replied with an unexpected sequence ${reply.seq}`));
    };
    // a worker that fails to load, or throws outside the walk's own guards, must fail LOUDLY
    w.onerror = (e: ErrorEvent): void => this.failAll(new DiskSamplerError(`worker error: ${e.message}`));
    w.onmessageerror = (): void => this.failAll(new DiskSamplerError("worker sent an undeserializable message"));
    this.worker = w;
    return w;
  }
  private request(dir: string, extras: readonly string[], strict: boolean): Promise<number> {
    if (this.failed !== null) return Promise.reject(this.failed);
    const w = this.ensureWorker();
    const req: DiskWalkRequest = { seq: ++this.seq, dir, extras, strict };
    return new Promise<number>((resolve, reject) => {
      // NOT unref'd: an awaited walk is the only thing keeping the process alive between the
      // driver returning and the run record landing. Unref'ing let a terminated worker drop the
      // event loop to empty and exit 0 with no snapshot and no row (reproduced in review).
      const timer = setTimeout(() => {
        this.pending.delete(req.seq);
        reject(new DiskSamplerError(`walk of ${dir} did not reply within ${this.replyTimeoutMs}ms`));
      }, this.replyTimeoutMs);
      this.pending.set(req.seq, {
        resolve: (b) => { clearTimeout(timer); resolve(b); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        w.postMessage(req);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(req.seq);
        reject(new DiskSamplerError(`postMessage failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }
  start(dir: string, hz: number): void {
    this.stopTimer();
    // EAGER worker construction: start() runs before the wall opens, and constructing the
    // Worker lazily meant the FIRST tick paid the synchronous construction cost wherever it
    // happened to land — inside short-preflight rows' measured walls, outside longer ones' —
    // row-correlated noise on the primary metric. A construction failure surfaces through
    // failAll and degrades the disk fields at finish, never silently retried per tick.
    try {
      this.ensureWorker();
    } catch (e) {
      this.failAll(new DiskSamplerError(`worker construction failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    this.timer = setInterval(() => {
      // the tick is O(1) on THIS thread — the walk happens in the worker. Coalesced: a tick is
      // skipped while one is still outstanding, so a slow walk cannot queue an unbounded backlog.
      if (this.failed !== null || this.done !== null || this.tickSeq !== null) return;
      const seq = ++this.seq;
      this.tickSeq = seq;
      try {
        this.ensureWorker().postMessage({ seq, dir, extras: this.extras, strict: false } satisfies DiskWalkRequest);
      } catch {
        this.tickSeq = null; // a failed tick is a lost SAMPLE, which the metric tolerates
      }
    }, intervalMsFor(hz));
    this.timer.unref?.();
  }
  override abandon(): void {
    // R5 peeks and then throws: without this the tick timer stays armed and the worker stays
    // alive for the rest of the process, since finish() (the only other disposer) never runs.
    // Pending requests are REJECTED rather than merely dropped — their deadline timers are
    // deliberately referenced (so a dead worker cannot let the process exit mid-measurement),
    // and clearing the map without settling them would leave those timers holding the loop.
    this.stopTimer();
    this.tickSeq = null;
    this.failAll(new DiskSamplerError("sampler abandoned before this walk completed"));
  }
  private finishing: Promise<DiskSnapshot> | null = null;
  finish(dir: string, cloneGitDir: string | null): Promise<DiskSnapshot> {
    if (this.done !== null) return Promise.resolve(this.done);
    // single-flight: the in-progress promise is stored BEFORE the first await, so concurrent
    // callers join it rather than racing two snapshots through one shared worker
    if (this.finishing !== null) return this.finishing;
    this.finishing = this.runFinish(dir, cloneGitDir);
    return this.finishing;
  }
  private async runFinish(dir: string, cloneGitDir: string | null): Promise<DiskSnapshot> {
    this.stopTimer();
    let clone: number | null = null;
    let sampleError: string | null = null;
    try {
      // cloneObjectStoreBytes is a MEASUREMENT: a failed walk yields null, never a fabricated 0
      if (cloneGitDir !== null) clone = await this.request(cloneGitDir, [], true); // MEASUREMENT
      // the FINAL sample is strict too: on a short run it may be the ONLY sample, the run dir
      // is quiescent (driver returned, reclamation not started), and a tolerant walk of an
      // unreadable root would record a plausible 0-byte peak with sampleError null
      this.observe(await this.request(dir, this.extras, true));
    } catch (e) {
      // NEVER propagate: this runs between the driver returning and the run record being
      // appended (finishMeasuredRun), on a run that has already been measured and reclaimed.
      // Instrumentation failure degrades the disk fields; it does not eat the row. (The R5 halt
      // path never reaches here: it peek()s, appends, and abandon()s — see benchProtocol.)
      sampleError = e instanceof Error ? e.message : String(e);
      clone = null;
    } finally {
      this.disposeWorker();
      this.pending.clear();
    }
    this.done = { peakBytes: this.peak, samples: this.samples, cloneObjectStoreBytes: clone, sampleError };
    return this.done;
  }
}
