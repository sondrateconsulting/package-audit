// benchDiskWalk.ts — the recursive apparent-size walk behind the §4.6 disk metric, isolated so
// the sampler worker and the inline sampler share ONE implementation.
//
// Tolerant by design: a run directory can vanish or churn under the walk (teardown races, git
// rewriting its own object store), and a sample is a sample, not an invariant. That tolerance is
// correct HERE and only here — a caller that needs a measurement rather than a sample must not
// reuse this function's swallow-and-continue behaviour to report a hard number.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function duBytes(dir: string): number {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // the dir may vanish mid-sample (teardown race) — a sample, not an invariant
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      const st = lstatSync(p);
      total += st.size;
      if (st.isDirectory()) total += duBytes(p);
    } catch {
      // vanished mid-walk
    }
  }
  return total;
}

// The sidecars a run's cache DB may leave beside it; absent ones contribute nothing.
export function extraBytes(paths: readonly string[]): number {
  let total = 0;
  for (const p of paths) {
    try {
      total += lstatSync(p).size;
    } catch {
      // absent sidecar
    }
  }
  return total;
}
