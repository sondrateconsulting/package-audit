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
import { duBytes, duBytesStrict, extraBytes, extraBytesStrict } from "./benchDiskWalk.ts";

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
  // `some` skips holes, so a SPARSE array passed the check and was then cast to string[]
  if (!Array.isArray(extras) || extras.length !== Object.keys(extras).length) return null;
  if (!extras.every((x) => typeof x === "string")) return null;
  if (typeof strict !== "boolean") return null;
  return { seq, dir, extras: extras as string[], strict };
}

declare const self: Worker;

self.onmessage = (event: MessageEvent): void => {
  const req = parseDiskWalkRequest(event.data);
  if (req === null) {
    // When the malformed request still carries a routable seq, reply with an ERROR so the
    // requester fails immediately instead of waiting out its full reply deadline. With no
    // usable seq there is nothing to route — silence, and the requester deadlines.
    const seq = typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)["seq"]
      : undefined;
    if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0)
      postMessage({ seq, bytes: 0, error: "malformed disk-walk request" } satisfies DiskWalkReply);
    return;
  }
  try {
    // strict requests are RECORDED MEASUREMENTS end to end: the sidecar stats fail closed too
    // (a present-but-unreadable -wal must not silently shrink the figure), where sampled ticks
    // keep the tolerant walk on both terms
    const bytes = req.strict
      ? duBytesStrict(req.dir) + extraBytesStrict(req.extras)
      : duBytes(req.dir) + extraBytes(req.extras);
    postMessage({ seq: req.seq, bytes } satisfies DiskWalkReply);
  } catch (e) {
    postMessage({ seq: req.seq, bytes: 0, error: e instanceof Error ? e.message : String(e) } satisfies DiskWalkReply);
  }
};
