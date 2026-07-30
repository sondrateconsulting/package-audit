// benchDiskSampler.ts — the §4.6 peak-disk metric, sampled without charging the measurement to
// the measured wall.
//
// Two implementations behind one port:
//   WorkerDiskSampler — the default for TIMED runs. Each tick posts a request to a worker and
//                       returns immediately; the walk happens on another thread and the reply
//                       updates the peak. The main thread's per-tick cost is a postMessage.
//   InlineDiskSampler — the same accounting with a synchronous walk. Correct only where nothing
//                       is being timed (pinning, diagnostics) or where a test injects the walk.
import { duBytes, duBytesStrict, extraBytes } from "./benchDiskWalk.ts";
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
      this.observe(this.walk(dir, this.extras));
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
  private inFlightTick = false;
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
      }
      else {
        this.inFlightTick = false;
        this.observe(reply.bytes); // an unawaited tick reply
      }
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
    this.timer = setInterval(() => {
      // the tick is O(1) on THIS thread — the walk happens in the worker. Coalesced: a tick is
      // skipped while one is still outstanding, so a slow walk cannot queue an unbounded backlog.
      if (this.failed !== null || this.done !== null || this.inFlightTick) return;
      this.inFlightTick = true;
      try {
        const w = this.ensureWorker();
        w.postMessage({ seq: ++this.seq, dir, extras: this.extras, strict: false } satisfies DiskWalkRequest);
      } catch {
        this.inFlightTick = false; // a failed tick is a lost SAMPLE, which the metric tolerates
      }
    }, intervalMsFor(hz));
    this.timer.unref?.();
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
      this.observe(await this.request(dir, this.extras, false)); // sample
    } catch (e) {
      // NEVER propagate: this runs between the driver returning and the run record being
      // appended, and an R5 halt record in particular is the evidence a freeze repair is
      // diagnosed from. Instrumentation failure degrades the disk fields; it does not eat the row.
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
