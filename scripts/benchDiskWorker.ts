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
import { duBytes, extraBytes } from "./benchDiskWalk.ts";

export interface DiskWalkRequest {
  seq: number;
  dir: string;
  extras: readonly string[];
}
export interface DiskWalkReply {
  seq: number;
  bytes: number;
}

declare const self: Worker;

self.onmessage = (event: MessageEvent): void => {
  const req = event.data as DiskWalkRequest;
  const reply: DiskWalkReply = { seq: req.seq, bytes: duBytes(req.dir) + extraBytes(req.extras) };
  postMessage(reply);
};
