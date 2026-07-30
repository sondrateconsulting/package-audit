// benchDiskWorker.ts — the peak-disk sampler's walk, executed OFF the measured thread.
//
// Why a worker at all: `duBytes` is a synchronous recursive readdir/lstat walk whose cost scales
// with entry count. Run on the main thread inside the measured window it charged checkout-heavy
// drivers (T2a, and T0/T1 on the truncated-tree fallback) for work that `--no-checkout` T2c
// barely paid — a driver-correlated tax on the primary scored metric (§4.6).
//
// This removes the event-loop blocking, which is the dominant and clearly-directional part of
// that bias. It does NOT claim to remove all resource contention: a walk in another thread still
// competes for CPU and disk bandwidth with the git subprocess under test. The residual is
// second-order and is recorded as such in the plan amendment.
import { duBytes, duBytesStrict, extraBytes } from "./benchDiskWalk.ts";

export interface DiskWalkRequest {
  seq: number;
  dir: string;
  extras: readonly string[];
  /** true for a RECORDED measurement (cloneObjectStoreBytes): an unreadable entry must fail the
   *  walk rather than shrink the total. false for a sampled peak tick, where tolerance is right. */
  strict: boolean;
}
export interface DiskWalkReply {
  seq: number;
  bytes: number;
  /** set when a strict walk failed — the requester turns this into a null measurement */
  error?: string;
}

/** Validate the inbound request rather than casting it: the main thread is not more trustworthy
 *  than any other input source, and a malformed request would otherwise walk `undefined`. */
export function parseDiskWalkRequest(data: unknown): DiskWalkRequest | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  const { seq, dir, extras, strict } = o;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
  if (typeof dir !== "string" || dir === "") return null;
  if (!Array.isArray(extras) || extras.some((x) => typeof x !== "string")) return null;
  if (typeof strict !== "boolean") return null;
  return { seq, dir, extras: extras as string[], strict };
}

declare const self: Worker;

self.onmessage = (event: MessageEvent): void => {
  const req = parseDiskWalkRequest(event.data);
  if (req === null) return; // an unparseable request is answered by silence; the requester deadlines
  try {
    const bytes = req.strict
      ? duBytesStrict(req.dir) + extraBytes(req.extras)
      : duBytes(req.dir) + extraBytes(req.extras);
    postMessage({ seq: req.seq, bytes } satisfies DiskWalkReply);
  } catch (e) {
    postMessage({ seq: req.seq, bytes: 0, error: e instanceof Error ? e.message : String(e) } satisfies DiskWalkReply);
  }
};
