// benchCorpus.test.ts — strict corpus parsing + the pure §4.2 slot-verification predicates.
import { describe, expect, test } from "bun:test";
import {
  BenchCorpusError, parseCorpus, scheduleUnitsFrom, sharedBlobOidRatio,
  verifyC1, verifyC2, verifyC3, verifyC4, verifyC5, verifyC6NonUtf8, verifyC6Symlink,
} from "./benchCorpus.ts";

const sha = (c: string): string => c.repeat(40);
const unit = (slot: string, owner: string, repo: string, branch: string, c: string) => ({
  unitId: `${slot}:${owner}/${repo}@${branch}`, branch, sha: sha(c), treeOid: sha("f"),
});
const FIXTURE = {
  pinnedAtIso: "2026-07-28T00:00:00Z",
  pinnedByLogin: "someone",
  performance: [
    {
      slot: "C1", owner: "o", repo: "r1", objectFormat: "sha1", repoSizeKb: 10,
      units: [unit("C1", "o", "r1", "main", "1"), unit("C1", "o", "r1", "4.x", "2"), unit("C1", "o", "r1", "3.x", "3"), unit("C1", "o", "r1", "2.x", "4")],
      verification: {},
    },
    { slot: "C2", owner: "o", repo: "r2", objectFormat: "sha1", repoSizeKb: 10, units: [unit("C2", "o", "r2", "main", "5")], verification: {} },
    { slot: "C3", owner: "o", repo: "r3", objectFormat: "sha1", repoSizeKb: 10, units: [unit("C3", "o", "r3", "master", "6")], verification: {} },
    { slot: "C4", owner: "o", repo: "r4", objectFormat: "sha1", repoSizeKb: 99, units: [unit("C4", "o", "r4", "main", "7")], verification: {} },
    { slot: "C5", owner: "o", repo: "r5", objectFormat: "sha1", repoSizeKb: 10, units: [unit("C5", "o", "r5", "master", "8")], verification: {} },
  ],
  fidelity: [
    { kind: "api-only-symlink", owner: "nodejs", repo: "node", branch: null, sha: sha("9"), objectFormat: "sha1", appliesTo: ["T0", "T1"], entries: [{ path: "p", mode: "120000", oid: sha("a"), size: 17 }], verification: {} },
    { kind: "clone-symlink", owner: "o", repo: "r6", branch: "main", sha: sha("b"), objectFormat: "sha1", appliesTo: ["T0", "T1", "T2a", "T2c"], entries: [{ path: "link.sh", mode: "120000", oid: sha("c"), size: 9 }], verification: {} },
    { kind: "non-utf8-content", owner: "o", repo: "r6", branch: "main", sha: sha("b"), objectFormat: "sha1", appliesTo: ["T0", "T1", "T2a", "T2c"], entries: [{ path: "latin1.sh", mode: "100644", oid: sha("d"), size: 40 }], verification: {} },
  ],
};

describe("parseCorpus", () => {
  test("the fixture round-trips and yields schedule units for the performance corpus only", () => {
    const corpus = parseCorpus(JSON.stringify(FIXTURE));
    expect(corpus.performance.length).toBe(5);
    const units = scheduleUnitsFrom(corpus);
    expect(units.length).toBe(8); // 4 C1 + 4 singles; fidelity never scheduled
    expect(units.filter((u) => u.repoKey === "o/r1").length).toBe(4);
  });
  test("fail-closed: slot rules, unitId shape, oid formats, missing fixtures", () => {
    const mutate = (fn: (o: typeof FIXTURE) => void): (() => unknown) => {
      const o = structuredClone(FIXTURE);
      fn(o);
      return () => parseCorpus(JSON.stringify(o));
    };
    expect(mutate((o) => { o.performance[0]!.units = o.performance[0]!.units.slice(0, 3); })).toThrow(BenchCorpusError); // C1 < 4
    expect(mutate((o) => { o.performance[1]!.units.push(unit("C2", "o", "r2", "dev", "9")); })).toThrow(BenchCorpusError); // C2 must be single
    expect(mutate((o) => { o.performance[1]!.units[0]!.unitId = "C2:o/r2@other"; })).toThrow(BenchCorpusError); // unitId ≠ derived
    expect(mutate((o) => { o.performance[1]!.units[0]!.sha = "MAIN"; })).toThrow(BenchCorpusError);
    expect(mutate((o) => { o.performance[1]!.units[0]!.sha = sha("5").slice(2); })).toThrow(BenchCorpusError);
    expect(mutate((o) => { o.performance.pop(); })).toThrow(BenchCorpusError); // missing C5
    expect(mutate((o) => { o.fidelity.pop(); })).toThrow(BenchCorpusError); // missing a fixture kind
    expect(mutate((o) => { (o.performance[2] as { slot: string }).slot = "C2"; })).toThrow(BenchCorpusError); // dup slot
  });
});

describe("§4.2 slot predicates", () => {
  test("C1: shared-blob-oid ratio and the ≥4-units / ≥80% requirements", () => {
    expect(sharedBlobOidRatio(["a", "b", "c", "d", "e"], ["a", "b", "c", "d", "x"])).toBe(0.8);
    expect(sharedBlobOidRatio([], ["a"])).toBe(0);
    const shared = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const ok = verifyC1(new Map([
      ["u1", shared],
      ["u2", [...shared.slice(0, 7), "z"]], // 7/8 = 87.5%
      ["u3", ["q", "r"]],
      ["u4", ["s", "t"]],
    ]));
    expect(ok.ok).toBe(true);
    expect((ok.evidence["bestPair"] as { ratio: number }).ratio).toBeGreaterThanOrEqual(0.8);
    expect(verifyC1(new Map([["u1", shared], ["u2", shared], ["u3", shared]])).ok).toBe(false); // only 3 units
    const disjoint = verifyC1(new Map([["u1", ["a"]], ["u2", ["b"]], ["u3", ["c"]], ["u4", ["d"]]]));
    expect(disjoint.ok).toBe(false);
    expect(disjoint.reasons.join(" ")).toContain("80%");
  });
  test("C2/C3/C4 stats predicates", () => {
    expect(verifyC2({ fileCount: 1500, truncated: false, manifestCount: 2 }).ok).toBe(true);
    expect(verifyC2({ fileCount: 999, truncated: false, manifestCount: 2 }).ok).toBe(false);
    expect(verifyC2({ fileCount: 1500, truncated: true, manifestCount: 2 }).ok).toBe(false);
    expect(verifyC2({ fileCount: 1500, truncated: false, manifestCount: 0 }).ok).toBe(false);
    const pathHeavy = { truncated: false, entryCount: 40_000, pathByteSum: 4_500_000, oidHexLength: 40, deepEntryCount: 30_000 };
    expect(verifyC3(pathHeavy).ok).toBe(true);
    expect(verifyC3({ ...pathHeavy, pathByteSum: 100_000 }).ok).toBe(false); // not path-dominated
    expect(verifyC3({ ...pathHeavy, deepEntryCount: 10 }).ok).toBe(false); // not deep
    expect(verifyC3({ ...pathHeavy, truncated: true }).ok).toBe(false); // "else it is a C4"
    expect(verifyC4({ truncated: true }).ok).toBe(true);
    expect(verifyC4({ truncated: false }).ok).toBe(false);
  });
  test("C5/C6 evidence predicates", () => {
    expect(verifyC5([
      { path: "a.ps1", sha256AutocrlfFalse: "x", sha256AutocrlfTrue: "y" },
      { path: "b", sha256AutocrlfFalse: "z", sha256AutocrlfTrue: "z" },
    ]).ok).toBe(true);
    expect(verifyC5([{ path: "b", sha256AutocrlfFalse: "z", sha256AutocrlfTrue: "z" }]).ok).toBe(false);
    expect(verifyC6Symlink([{ path: "RelNotes", mode: "120000", selected: false }, { path: "x.sh", mode: "120000", selected: true }]).ok).toBe(true);
    expect(verifyC6Symlink([{ path: "RelNotes", mode: "120000", selected: false }]).ok).toBe(false);
    expect(verifyC6NonUtf8({ path: "latin1.sh", replacementCount: 3 }).ok).toBe(true);
    expect(verifyC6NonUtf8({ path: "clean.sh", replacementCount: 0 }).ok).toBe(false);
  });
});
