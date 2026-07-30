// benchDiskSampler.ts — the §4.6 peak-disk metric, sampled without charging the measurement to
// the measured wall.
//
// Two implementations behind one port:
//   WorkerDiskSampler — the default for TIMED runs. Each tick posts a request to a worker and
//                       returns immediately; the walk happens on another thread and the reply
//                       updates the peak. The main thread's per-tick cost is a postMessage.
//   InlineDiskSampler — the same accounting with a synchronous walk. Correct only where nothing
//                       is being timed (pinning, diagnostics) or where a test injects the walk.
import { duBytes, extraBytes } from "./benchDiskWalk.ts";
import type { DiskWalkReply, DiskWalkRequest } from "./benchDiskWorker.ts";

export interface DiskSnapshot {
  peakBytes: number;
  samples: number;
  cloneObjectStoreBytes: number | null;
}

export interface DiskSamplerPort {
  start(dir: string, hz: number): void;
  extraFiles(paths: readonly string[]): void;
  /** Stop sampling and return the final snapshot. Includes a last point sample of `dir`, plus
   *  the clone object-store size when `cloneGitDir` is given. Never runs inside a timed window. */
  finish(dir: string, cloneGitDir: string | null): Promise<DiskSnapshot>;
}

const intervalMsFor = (hz: number): number => Math.max(1, Math.round(1000 / hz));

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
  abstract start(dir: string, hz: number): void;
  abstract finish(dir: string, cloneGitDir: string | null): Promise<DiskSnapshot>;
}

export class InlineDiskSampler extends BaseSampler {
  constructor(private readonly walk: (dir: string, extras: readonly string[]) => number =
    (d, e) => duBytes(d) + extraBytes(e)) {
    super();
  }
  start(dir: string, hz: number): void {
    this.stopTimer();
    this.timer = setInterval(() => this.observe(this.walk(dir, this.extras)), intervalMsFor(hz));
    this.timer.unref?.();
  }
  async finish(dir: string, cloneGitDir: string | null): Promise<DiskSnapshot> {
    this.stopTimer();
    const clone = cloneGitDir === null ? null : this.walk(cloneGitDir, []);
    this.observe(this.walk(dir, this.extras));
    return { peakBytes: this.peak, samples: this.samples, cloneObjectStoreBytes: clone };
  }
}

export class WorkerDiskSampler extends BaseSampler {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, (bytes: number) => void>();
  private ensureWorker(): Worker {
    if (this.worker !== null) return this.worker;
    const w = new Worker(new URL("./benchDiskWorker.ts", import.meta.url).href);
    w.onmessage = (event: MessageEvent): void => {
      const reply = event.data as DiskWalkReply;
      const settle = this.pending.get(reply.seq);
      this.pending.delete(reply.seq);
      if (settle !== undefined) settle(reply.bytes);
      else this.observe(reply.bytes); // an unawaited tick reply
    };
    this.worker = w;
    return w;
  }
  private post(dir: string, extras: readonly string[], awaited: boolean): Promise<number> {
    const w = this.ensureWorker();
    const req: DiskWalkRequest = { seq: ++this.seq, dir, extras };
    const p = new Promise<number>((resolve) => {
      if (awaited) this.pending.set(req.seq, resolve);
      else resolve(0); // fire-and-forget: the onmessage handler folds the reply into the peak
    });
    w.postMessage(req);
    return p;
  }
  start(dir: string, hz: number): void {
    this.stopTimer();
    // the tick itself is O(1) on this thread — the walk happens in the worker
    this.timer = setInterval(() => void this.post(dir, this.extras, false), intervalMsFor(hz));
    this.timer.unref?.();
  }
  async finish(dir: string, cloneGitDir: string | null): Promise<DiskSnapshot> {
    this.stopTimer();
    const clone = cloneGitDir === null ? null : await this.post(cloneGitDir, [], true);
    this.observe(await this.post(dir, this.extras, true));
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    return { peakBytes: this.peak, samples: this.samples, cloneObjectStoreBytes: clone };
  }
}
