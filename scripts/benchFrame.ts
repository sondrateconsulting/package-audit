// benchFrame.ts — ADR-0001's T2c adoption MOVED the framed parsers this module prototyped
// into production (gitFrame.ts); this file is now the bench's re-export shim. It preserves
// the bench-era names — including class IDENTITY, so `instanceof` across benchSpawn's child
// manager and the drivers' failure taxonomy still holds — and every bench import keeps
// compiling unchanged. Parser behavior is production-owned; the bench's original test file
// (benchFrame.test.ts) keeps exercising it through this shim. NB this edit moves the live
// frozen-surface digest (disclosed in the adoption PR); any future gate-relevant bench run
// needs a fresh §8 amendment regardless, and the gate refuses a digest mismatch by design.

export {
  GitFrameError as BenchFrameError,
  BatchFrameParser,
  ByteRing,
  parseLsTreeZ,
  LS_TREE_MODES,
} from "./gitFrame.ts";
export type {
  BatchLimits,
  BatchExpectation,
  BatchFrame,
  LsTreeEntry,
  LsTreeLimits,
  LsTreeMode,
  LsTreeType,
} from "./gitFrame.ts";
