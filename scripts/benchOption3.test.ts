// benchOption3.test.ts — CI tests for the offline duplicate-OID analysis (§4.4): per-unit
// distinct/duplicate arithmetic, the C1 pairwise share (the pinning measure over SELECTED
// reads), and the estate-wide cacheable-read upper bound. The warm-run scenario is
// network-bound and untested here.
import { describe, expect, test } from "bun:test";
import type { Corpus } from "./benchCorpus.ts";
import type { UnitWorkload, WorkloadEntry } from "./benchWorkload.ts";
import { BenchOption3Error, analyzeOidDuplication } from "./benchOption3.ts";

const oid = (c: string): string => c.repeat(40);
const readEntry = (path: string, blobOid: string): WorkloadEntry => ({
  path, mode: "100644", blobOid, size: 10, class: "source", read: true, noReadReason: null,
  canonicalSeamSha256: null, rawSha256: null, restDerefSeamSha256: null, checkoutSeamSha256: null, gql: null,
});
const workload = (unit: string, oids: readonly string[], noReads = 1): UnitWorkload => ({
  unit, sha: oid("0"), treeOid: oid("f"), objectFormat: "sha1", generatedAtIso: "t",
  truncatedTree: false, escapeTripped: false, batchContentBytesCap: 1,
  entries: [
    ...oids.map((o, i) => readEntry(`p${i}.ts`, o)),
    ...Array.from({ length: noReads }, (_, i) => ({ ...readEntry(`skip${i}`, oid("9")), read: false, noReadReason: "size-gate-skip" as const })),
  ],
  routes: {},
});

const corpusOf = (unitIds: readonly string[]): Corpus => ({
  pinnedAtIso: "t", pinnedByLogin: "test",
  performance: [{
    slot: "C1", owner: "o", repo: "r", objectFormat: "sha1", repoSizeKb: 1,
    units: unitIds.map((u) => ({ unitId: u, branch: "b", sha: oid("0"), treeOid: oid("f") })),
    verification: {},
  }],
  fidelity: [], option3WarmScenario: null,
});

describe("analyzeOidDuplication", () => {
  test("per-unit distinct/duplicate counts ignore no-read entries; pairwise share uses |A∩B|/min", () => {
    const corpus = corpusOf(["u1", "u2"]);
    const workloads = new Map([
      ["u1", workload("u1", [oid("a"), oid("b"), oid("b")])], // 3 reads, 2 distinct, 1 within-unit dup
      ["u2", workload("u2", [oid("b"), oid("c")])],
    ]);
    const r = analyzeOidDuplication(corpus, workloads);
    expect(r.perUnit).toEqual([
      { unit: "u1", readEntries: 3, distinctOids: 2, withinUnitDuplicateReads: 1 },
      { unit: "u2", readEntries: 2, distinctOids: 2, withinUnitDuplicateReads: 0 },
    ]);
    expect(r.c1Pairwise).toEqual([{ a: "u1", b: "u2", sharedOids: 1, minDistinct: 2, shareRatio: 0.5 }]);
    // estate: 5 reads over 3 distinct oids → an OID cache could serve 2
    expect(r.c1Estate).toEqual({ totalReads: 5, distinctOids: 3, cacheableReads: 2 });
    expect(r.corpusEstate).toEqual(r.c1Estate); // the corpus IS c1 here
  });
  test("a unit missing its workload fails closed", () => {
    expect(() => analyzeOidDuplication(corpusOf(["u1"]), new Map())).toThrow(BenchOption3Error);
  });
});
