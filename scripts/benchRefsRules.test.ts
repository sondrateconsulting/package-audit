import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BenchRefsRulesError,
  REFS_PROBE_CANDIDATE_BATCH_SIZES,
  REFS_PROBE_INFORMATIONAL_BATCH_SIZES,
  REFS_PROBE_ALL_BATCH_SIZES,
  REFS_PROBE_TRIES_PER_CELL,
  REFS_PROBE_INVALIDATION_RERUN_CAP,
  REFS_PROBE_WALL_GATE_MS,
  REFS_PROBE_PAIR_COST_GATE_MAX,
  REFS_PROBE_POINT_BOUND_PER_ATTEMPT,
  REFS_PROBE_BUCKET_LIMIT_POINTS,
  REFS_PROBE_SHIP_THRESHOLD_POINTS,
  REFS_PROBE_ESTATE_8X750_REPOS,
  REFS_PROBE_RATE_LIMIT_RIDER,
  SOLO_REFS_QUERY,
  absoluteGatePointsPerBatch,
  buildProbeSoloQuery,
  parseRefsProbeCorpus,
  planOwnerChunks,
  assembleRefsWalk,
  checkAliasIdentity,
  hasResourceLimitSignal,
  dispatchUncleanCauses,
  evaluateTry,
  parseJournalRow,
  deriveCellState,
  reduceCell,
  evaluateCandidate,
  selectOutcome,
  admitTranche,
  presentCorrectedEstates,
  type RefsCorpusCell,
  type RefsCorpusRepo,
  type RefsProbeDispatchRecord,
  type RefsRepoWalkRecord,
  type RefsTryRow,
  type RefsArmSummary,
  type RefsCellReduction,
  type RefsCellOutcome,
  type RefsCandidateVerdict,
  type RefsProbeJournalRow,
  type RefsStratum,
} from "./benchRefsRules.ts";

// ---- fixture builders ------------------------------------------------------------------------

const repo = (owner: string, name: string, frozenPages: number, frozenHeads = frozenPages * 100): RefsCorpusRepo => ({
  owner, name, frozenPages, frozenHeads,
});

const cellOf = (batchSize: number, stratum: RefsStratum, repos: RefsCorpusRepo[]): RefsCorpusCell => ({
  batchSize, stratum, feasible: true, infeasibleCause: null, repos,
});

const p1Repos = (n: number, owner = "probe-owner"): RefsCorpusRepo[] =>
  Array.from({ length: n }, (_, i) => repo(owner, `refs-probe-p1-${i}`, 1, 2));
const p2Repos = (n: number, owner = "probe-owner", pages = 2): RefsCorpusRepo[] =>
  Array.from({ length: n }, (_, i) => repo(owner, `refs-probe-p2-${i}`, pages, 101));

const validCorpus = (): unknown => ({
  version: 1,
  frozenAtIso: "2026-08-05T00:00:00Z",
  login: "sondrateconsulting-ryan",
  provenance: "operator procedure text",
  cells: REFS_PROBE_ALL_BATCH_SIZES.flatMap((b) => [
    { batchSize: b, stratum: "p1", feasible: true, infeasibleCause: null, repos: p1Repos(b) },
    { batchSize: b, stratum: "p2", feasible: true, infeasibleCause: null, repos: p2Repos(b) },
  ]),
});

const oid = (seed: number): string => seed.toString(16).padStart(40, "0");

const node = (name: string, seed = 1): unknown => ({
  name,
  target: { oid: oid(seed), committedDate: "2026-01-02T03:04:05Z", tree: { oid: oid(seed + 1000) } },
});

interface PageOpts {
  defaultRef?: unknown; // the defaultBranchRef value; use "OMIT" to drop the property
  hasNextPage?: boolean;
  endCursor?: string | null;
  nameWithOwner?: string;
}
const page = (nodes: unknown[], opts: PageOpts = {}): unknown => {
  const repoObj: Record<string, unknown> = {
    defaultBranchRef: opts.defaultRef === undefined ? { name: "main" } : opts.defaultRef,
    refs: {
      pageInfo: { hasNextPage: opts.hasNextPage ?? false, endCursor: opts.endCursor ?? null },
      nodes,
    },
  };
  if (opts.defaultRef === "OMIT") delete repoObj["defaultBranchRef"];
  if (opts.nameWithOwner !== undefined) repoObj["nameWithOwner"] = opts.nameWithOwner;
  return repoObj;
};

const okDispatch = (over: Partial<RefsProbeDispatchRecord> = {}): RefsProbeDispatchRecord => ({
  arm: "candidate",
  callKind: "batch-page1",
  repo: null,
  batchOrdinal: 0,
  pageOrdinal: null,
  status: 200,
  exitCode: 0,
  classification: "ok",
  secondaryLike: false,
  secondarySignal: null,
  pointsCost: 1,
  remaining: 4_900,
  resetEpochSec: 1_800_000_000,
  wallMs: 800,
  bodyBytes: 10_000,
  errorTypes: [],
  errorMessages: [],
  malformedErrorEntries: 0,
  dispatchFailure: null,
  ...over,
});

const okWalk = (over: Partial<RefsRepoWalkRecord> = {}): RefsRepoWalkRecord => ({
  arm: "candidate",
  repo: "probe-owner/refs-probe-p1-0",
  pagesObserved: 1,
  complete: true,
  stoppedBy: "complete",
  batteryFailure: null,
  identityFailure: null,
  headCount: 2,
  defaultBranch: "main",
  ...over,
});

// a fully clean paired try over a cell: candidate batch(es) + continuations, control solo walk
function cleanTryParts(cell: RefsCorpusCell): { dispatches: RefsProbeDispatchRecord[]; walks: RefsRepoWalkRecord[] } {
  const dispatches: RefsProbeDispatchRecord[] = [];
  const walks: RefsRepoWalkRecord[] = [];
  const chunks = planOwnerChunks(cell.repos, cell.batchSize);
  chunks.forEach((_, b) => {
    dispatches.push(okDispatch({ batchOrdinal: b }));
  });
  for (const r of cell.repos) {
    const key = `${r.owner}/${r.name}`;
    for (let p = 2; p <= r.frozenPages; p++) {
      dispatches.push(okDispatch({ callKind: "solo-page", repo: key, batchOrdinal: null, pageOrdinal: p, wallMs: 400 }));
    }
    walks.push(okWalk({ repo: key, pagesObserved: r.frozenPages, headCount: r.frozenHeads }));
  }
  for (const r of cell.repos) {
    const key = `${r.owner}/${r.name}`;
    for (let p = 1; p <= r.frozenPages; p++) {
      dispatches.push(okDispatch({ arm: "control", callKind: "solo-page", repo: key, batchOrdinal: null, pageOrdinal: p, wallMs: 300 }));
    }
    walks.push(okWalk({ arm: "control", repo: key, pagesObserved: r.frozenPages, headCount: r.frozenHeads }));
  }
  return { dispatches, walks };
}

const cleanSummary = (over: Partial<RefsArmSummary> = {}): RefsArmSummary => ({
  clean: true,
  causes: [],
  page1Points: 1,
  continuationPoints: 0,
  totalPoints: 1,
  perBatchPoints: [1],
  reposCovered: 10,
  continuationPagesObserved: 0,
  page1MaxWallMs: 800,
  headerDelta: null,
  ...over,
});

let rowSeq = 0;
const tryRow = (over: Partial<RefsTryRow> = {}): RefsTryRow => ({
  rowKind: "try",
  version: 1,
  atIso: `2026-08-05T00:00:${String(rowSeq++ % 60).padStart(2, "0")}Z`,
  cellB: 10,
  stratum: "p1",
  slot: 1,
  attempt: 1,
  dispatches: [],
  walks: [],
  verdict: "clean",
  causes: [],
  invalidationCause: null,
  candidate: cleanSummary(),
  control: cleanSummary({ page1Points: 10, totalPoints: 10, perBatchPoints: [], reposCovered: 10 }),
  pairRatio: 0.1,
  informational: {
    candidateFullSnapshotMs: 1_000,
    candidatePage1PhaseMs: 800,
    continuationPhaseMs: 0,
    controlArmMs: 3_000,
    wouldHaveTrippedProductionStop: false,
  },
  ...over,
});

const completeOutcome = (rows: RefsTryRow[]): RefsCellOutcome => ({
  status: { kind: "complete" },
  reduction: reduceCell(rows),
  tryRows: rows,
});

// five clean rows for a cell, with per-row overrides applied by slot
function cleanRows(cellB: number, stratum: RefsStratum, over: (slot: number) => Partial<RefsTryRow> = () => ({})): RefsTryRow[] {
  return Array.from({ length: REFS_PROBE_TRIES_PER_CELL }, (_, i) =>
    tryRow({ cellB, stratum, slot: i + 1, ...over(i + 1) }),
  );
}

// ---- constants -------------------------------------------------------------------------------

describe("pre-registered constants", () => {
  test("candidates are exactly {10, 25}; 50 is informational; B = 1 is never a candidate", () => {
    expect([...REFS_PROBE_CANDIDATE_BATCH_SIZES]).toEqual([10, 25]);
    expect([...REFS_PROBE_INFORMATIONAL_BATCH_SIZES]).toEqual([50]);
    expect([...REFS_PROBE_ALL_BATCH_SIZES]).toEqual([10, 25, 50]);
    expect(REFS_PROBE_CANDIDATE_BATCH_SIZES).not.toContain(1);
    expect(REFS_PROBE_ALL_BATCH_SIZES).not.toContain(1);
  });
  test("the rule's frozen parameters", () => {
    expect(REFS_PROBE_TRIES_PER_CELL).toBe(5);
    expect(REFS_PROBE_INVALIDATION_RERUN_CAP).toBe(2);
    expect(REFS_PROBE_WALL_GATE_MS).toBe(5_000);
    expect(REFS_PROBE_PAIR_COST_GATE_MAX).toBe(0.5);
    expect(REFS_PROBE_POINT_BOUND_PER_ATTEMPT).toBe(2);
    expect(REFS_PROBE_BUCKET_LIMIT_POINTS).toBe(5_000);
    expect(REFS_PROBE_SHIP_THRESHOLD_POINTS).toBe(500);
    expect(REFS_PROBE_ESTATE_8X750_REPOS).toBe(6_000);
  });
  test("absolute gate: 2 × max(1, round(B/100)) points per batch", () => {
    expect(absoluteGatePointsPerBatch(10)).toBe(2);
    expect(absoluteGatePointsPerBatch(25)).toBe(2);
    expect(absoluteGatePointsPerBatch(50)).toBe(2);
    expect(absoluteGatePointsPerBatch(100)).toBe(2);
    expect(absoluteGatePointsPerBatch(150)).toBe(4);
  });
});

// ---- query documents -------------------------------------------------------------------------

describe("probe query documents", () => {
  test("SOLO_REFS_QUERY is the production listBranchHeads document, verbatim (drift pin)", () => {
    const src = readFileSync(join(import.meta.dir, "github.ts"), "utf8");
    expect(src).toContain(JSON.stringify(SOLO_REFS_QUERY));
  });
  test("buildProbeSoloQuery appends exactly the rider at the query root", () => {
    const withRider = buildProbeSoloQuery(REFS_PROBE_RATE_LIMIT_RIDER);
    expect(withRider).toBe(`${SOLO_REFS_QUERY.slice(0, -1)} ${REFS_PROBE_RATE_LIMIT_RIDER}}`);
    expect(buildProbeSoloQuery("")).toBe(SOLO_REFS_QUERY);
  });
});

// ---- corpus ----------------------------------------------------------------------------------

describe("parseRefsProbeCorpus", () => {
  test("a valid corpus parses and keeps cell order", () => {
    const c = parseRefsProbeCorpus(JSON.stringify(validCorpus()));
    expect(c.cells.length).toBe(6);
    expect(c.cells[0]!.batchSize).toBe(10);
    expect(c.login).toBe("sondrateconsulting-ryan");
  });
  test("all six cells must be present exactly once", () => {
    const c = validCorpus() as { cells: unknown[] };
    c.cells.pop();
    expect(() => parseRefsProbeCorpus(JSON.stringify(c))).toThrow(BenchRefsRulesError);
  });
  test("a p1 cell rejects a paginating repo (frozenPages ≠ 1)", () => {
    const c = validCorpus() as { cells: Array<{ stratum: string; repos: RefsCorpusRepo[] }> };
    c.cells[0]!.repos[0] = repo("probe-owner", "refs-probe-p1-0", 2);
    expect(() => parseRefsProbeCorpus(JSON.stringify(c))).toThrow(/p1/);
  });
  test("a p2 cell rejects a single-page repo (frozenPages < 2)", () => {
    const c = validCorpus() as { cells: Array<{ stratum: string; repos: RefsCorpusRepo[] }> };
    c.cells[1]!.repos[0] = repo("probe-owner", "refs-probe-p2-0", 1);
    expect(() => parseRefsProbeCorpus(JSON.stringify(c))).toThrow(/p2/);
  });
  test("a feasible cell must furnish at least one full same-owner batch of exactly B", () => {
    const c = validCorpus() as { cells: Array<{ batchSize: number; repos: RefsCorpusRepo[] }> };
    // B = 10 split 5 + 5 across two owners: no owner furnishes a full batch
    c.cells[0]!.repos = [...p1Repos(5, "owner-a"), ...p1Repos(5, "owner-b")];
    expect(() => parseRefsProbeCorpus(JSON.stringify(c))).toThrow(/full/i);
  });
  test("duplicate repos within a cell are rejected", () => {
    const c = validCorpus() as { cells: Array<{ repos: RefsCorpusRepo[] }> };
    c.cells[0]!.repos[1] = c.cells[0]!.repos[0]!;
    expect(() => parseRefsProbeCorpus(JSON.stringify(c))).toThrow(/duplicate/i);
  });
  test("an infeasible cell carries a cause and no repos", () => {
    const c = validCorpus() as { cells: Array<Record<string, unknown>> };
    c.cells[4] = { batchSize: 50, stratum: "p1", feasible: false, infeasibleCause: "estate cannot furnish 50", repos: [] };
    const parsed = parseRefsProbeCorpus(JSON.stringify(c));
    expect(parsed.cells[4]!.feasible).toBe(false);
  });
  test("a feasible cell with empty repos, or an infeasible cell without a cause, is rejected", () => {
    const a = validCorpus() as { cells: Array<Record<string, unknown>> };
    a.cells[0] = { ...a.cells[0]!, repos: [] };
    expect(() => parseRefsProbeCorpus(JSON.stringify(a))).toThrow(BenchRefsRulesError);
    const b = validCorpus() as { cells: Array<Record<string, unknown>> };
    b.cells[0] = { batchSize: 10, stratum: "p1", feasible: false, infeasibleCause: null, repos: [] };
    expect(() => parseRefsProbeCorpus(JSON.stringify(b))).toThrow(BenchRefsRulesError);
  });
  test("the p2 stratum requires more than 100 heads, and head/page counts must agree", () => {
    // > 100 heads is the registered paginating-stratum definition (exactly 100 is one page)
    const a = validCorpus() as { cells: Array<{ repos: RefsCorpusRepo[] }> };
    a.cells[1]!.repos[0] = { ...a.cells[1]!.repos[0]!, frozenHeads: 100 };
    expect(() => parseRefsProbeCorpus(JSON.stringify(a))).toThrow(/heads/);
    const b = validCorpus() as { cells: Array<{ repos: RefsCorpusRepo[] }> };
    b.cells[1]!.repos[0] = { ...b.cells[1]!.repos[0]!, frozenHeads: 250 }; // 250 heads ≠ 2 frozen pages
    expect(() => parseRefsProbeCorpus(JSON.stringify(b))).toThrow(/pages/i);
    const c = validCorpus() as { cells: Array<{ repos: RefsCorpusRepo[] }> };
    c.cells[0]!.repos[0] = { ...c.cells[0]!.repos[0]!, frozenHeads: 150 }; // p1 with paginating heads
    expect(() => parseRefsProbeCorpus(JSON.stringify(c))).toThrow(/heads/);
  });
  test("malformed shapes are rejected loudly", () => {
    expect(() => parseRefsProbeCorpus("not json")).toThrow(BenchRefsRulesError);
    expect(() => parseRefsProbeCorpus("[]")).toThrow(BenchRefsRulesError);
    const c = validCorpus() as Record<string, unknown>;
    c["login"] = "";
    expect(() => parseRefsProbeCorpus(JSON.stringify(c))).toThrow(/login/);
    const d = validCorpus() as { cells: Array<{ repos: Array<Record<string, unknown>> }> };
    d.cells[0]!.repos[0]!["frozenPages"] = 0;
    expect(() => parseRefsProbeCorpus(JSON.stringify(d))).toThrow(/frozenPages/);
  });
});

describe("planOwnerChunks", () => {
  test("kept order, grouped per owner, chunks of at most B", () => {
    const repos = [
      repo("a", "r0", 1), repo("a", "r1", 1), repo("a", "r2", 1),
      repo("b", "s0", 1), repo("b", "s1", 1),
    ];
    const chunks = planOwnerChunks(repos, 2);
    expect(chunks.map((c) => c.map((r) => `${r.owner}/${r.name}`))).toEqual([
      ["a/r0", "a/r1"], ["a/r2"], ["b/s0", "b/s1"],
    ]);
  });
  test("a single full batch stays one chunk", () => {
    expect(planOwnerChunks(p1Repos(10), 10).length).toBe(1);
  });
});

// ---- walk battery ----------------------------------------------------------------------------

describe("assembleRefsWalk (the production battery, transcribed)", () => {
  test("one complete page resolves heads and default", () => {
    const w = assembleRefsWalk([page([node("main", 1), node("dev", 2)])]);
    expect(w).toEqual({ ok: true, pages: 1, complete: true, headCount: 2, defaultBranch: "main" });
  });
  test("a multi-page walk sums heads and re-asserts the default per page", () => {
    const w = assembleRefsWalk([
      page([node("main", 1)], { hasNextPage: true, endCursor: "c1" }),
      page([node("dev", 2)]),
    ]);
    expect(w).toEqual({ ok: true, pages: 2, complete: true, headCount: 2, defaultBranch: "main" });
  });
  test("a default flip mid-walk fails", () => {
    const w = assembleRefsWalk([
      page([node("main", 1)], { hasNextPage: true, endCursor: "c1" }),
      page([node("dev", 2)], { defaultRef: { name: "dev" } }),
    ]);
    expect(w).toEqual({ ok: false, failure: expect.stringMatching(/changed mid-pagination/) });
  });
  test("malformed nodes fail closed", () => {
    for (const bad of [
      { name: "", target: { oid: oid(1), committedDate: "2026-01-02T03:04:05Z", tree: { oid: oid(2) } } },
      { name: "x", target: { oid: "not-hex", committedDate: "2026-01-02T03:04:05Z", tree: { oid: oid(2) } } },
      { name: "x", target: { oid: oid(1), committedDate: "", tree: { oid: oid(2) } } },
      { name: "x", target: { oid: oid(1), committedDate: "2026-01-02T03:04:05Z", tree: { oid: "nope" } } },
      null,
    ]) {
      const w = assembleRefsWalk([page([bad])]);
      expect(w.ok).toBe(false);
    }
  });
  test("a non-ISO committedDate fails with its own message", () => {
    const bad = { name: "x", target: { oid: oid(1), committedDate: "yesterday", tree: { oid: oid(2) } } };
    const w = assembleRefsWalk([page([bad])]);
    expect(w).toEqual({ ok: false, failure: expect.stringMatching(/non-ISO/) });
  });
  test("duplicate branch names across pages fail", () => {
    const w = assembleRefsWalk([
      page([node("main", 1)], { hasNextPage: true, endCursor: "c1" }),
      page([node("main", 2)]),
    ]);
    expect(w).toEqual({ ok: false, failure: expect.stringMatching(/duplicate/) });
  });
  test("a page without the defaultBranchRef property fails (own-property contract)", () => {
    const w = assembleRefsWalk([page([node("main", 1)], { defaultRef: "OMIT" })]);
    expect(w).toEqual({ ok: false, failure: expect.stringMatching(/defaultBranchRef/) });
  });
  test("a null default with zero heads is legal", () => {
    expect(assembleRefsWalk([page([], { defaultRef: null })])).toEqual({
      ok: true, pages: 1, complete: true, headCount: 0, defaultBranch: null,
    });
  });
  test("a null default with heads fails (coherence)", () => {
    const w = assembleRefsWalk([page([node("main", 1)], { defaultRef: null })]);
    expect(w.ok).toBe(false);
  });
  test("a default absent from the discovered heads fails (coherence)", () => {
    const w = assembleRefsWalk([page([node("dev", 1)], { defaultRef: { name: "main" } })]);
    expect(w).toEqual({ ok: false, failure: expect.stringMatching(/absent/) });
  });
  test("hasNextPage=true on the last observed page is complete:false, not a failure", () => {
    const w = assembleRefsWalk([page([node("main", 1)], { hasNextPage: true, endCursor: "c1" })]);
    expect(w).toEqual({ ok: true, pages: 1, complete: false, headCount: 1, defaultBranch: "main" });
  });
  test("an incomplete walk skips end-of-walk coherence (the default may live on an unseen page)", () => {
    const w = assembleRefsWalk([page([node("dev", 1)], { hasNextPage: true, endCursor: "c1" })]);
    expect(w.ok).toBe(true);
  });
  test("hasNextPage=true with a missing or empty endCursor fails", () => {
    const w = assembleRefsWalk([page([node("main", 1)], { hasNextPage: true, endCursor: "" }), page([node("dev", 2)])]);
    expect(w.ok).toBe(false);
  });
  test("a cursor cycle fails", () => {
    const w = assembleRefsWalk([
      page([node("a", 1)], { hasNextPage: true, endCursor: "cX" }),
      page([node("b", 2)], { hasNextPage: true, endCursor: "cX" }),
      page([node("c", 3)]),
    ]);
    expect(w).toEqual({ ok: false, failure: expect.stringMatching(/cycle/) });
  });
  test("non-boolean hasNextPage, non-array nodes, and a non-object page all fail", () => {
    expect(assembleRefsWalk([page([node("main", 1)], { hasNextPage: undefined as unknown as boolean })]).ok).toBe(true); // builder defaults it; construct explicit bad shapes instead
    const badPageInfo = { defaultBranchRef: { name: "m" }, refs: { pageInfo: { hasNextPage: "yes", endCursor: null }, nodes: [node("m", 1)] } };
    expect(assembleRefsWalk([badPageInfo]).ok).toBe(false);
    const badNodes = { defaultBranchRef: { name: "m" }, refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: "nope" } };
    expect(assembleRefsWalk([badNodes]).ok).toBe(false);
    expect(assembleRefsWalk([null]).ok).toBe(false);
    expect(assembleRefsWalk([{ defaultBranchRef: { name: "m" } }]).ok).toBe(false); // refs missing
  });
  test("zero pages is a caller bug and throws", () => {
    expect(() => assembleRefsWalk([])).toThrow(BenchRefsRulesError);
  });
  test("a walk past MAX_PAGES fails closed (the production pagination bound)", () => {
    const many = Array.from({ length: 1_001 }, (_, i) =>
      page([node(`b${i}`, i + 1)], i < 1_000 ? { hasNextPage: true, endCursor: `c${i}`, defaultRef: { name: "b0" } } : { defaultRef: { name: "b0" } }),
    );
    const w = assembleRefsWalk(many);
    expect(w).toEqual({ ok: false, failure: expect.stringMatching(/page/) });
  });
});

describe("checkAliasIdentity (the batched identity re-assertion)", () => {
  test("exact and case-insensitive matches pass", () => {
    expect(checkAliasIdentity(page([], { defaultRef: null, nameWithOwner: "acme/widget" }), "acme", "widget")).toBeNull();
    expect(checkAliasIdentity(page([], { defaultRef: null, nameWithOwner: "Acme/Widget" }), "acme", "widget")).toBeNull();
  });
  test("a swapped or foreign identity is reported", () => {
    expect(checkAliasIdentity(page([], { defaultRef: null, nameWithOwner: "other/repo" }), "acme", "widget")).toMatch(/other\/repo/);
  });
  test("a missing or malformed nameWithOwner is reported", () => {
    expect(checkAliasIdentity(page([], { defaultRef: null }), "acme", "widget")).toMatch(/nameWithOwner/);
    expect(checkAliasIdentity(null, "acme", "widget")).toMatch(/alias/);
    expect(checkAliasIdentity({ nameWithOwner: 42 }, "acme", "widget")).toMatch(/nameWithOwner/);
  });
});

// ---- dispatch cleanliness --------------------------------------------------------------------

describe("hasResourceLimitSignal", () => {
  test("documented resource-limit types and wording trip it", () => {
    expect(hasResourceLimitSignal(["MAX_NODE_LIMIT_EXCEEDED"], [])).toBe(true);
    expect(hasResourceLimitSignal(["RESOURCE_LIMIT_EXCEEDED"], [])).toBe(true);
    expect(hasResourceLimitSignal([], ["query exceeds the node limit of 500000"])).toBe(true);
    expect(hasResourceLimitSignal([], ["Resource limit exceeded"])).toBe(true);
    expect(hasResourceLimitSignal([], ["Something went wrong: timeout"])).toBe(true);
  });
  test("ordinary errors do not", () => {
    expect(hasResourceLimitSignal(["NOT_FOUND"], ["Could not resolve to a Repository"])).toBe(false);
    expect(hasResourceLimitSignal([], [])).toBe(false);
  });
});

describe("dispatchUncleanCauses", () => {
  test("a clean ok dispatch with a readable cost has no causes", () => {
    expect(dispatchUncleanCauses(okDispatch())).toEqual([]);
  });
  test("a no-response dispatch is unclean by construction", () => {
    const causes = dispatchUncleanCauses(okDispatch({ status: 0, classification: "no-response", pointsCost: null }));
    expect(causes.join(" ")).toMatch(/no-response/);
  });
  test("a transport-layer throw is unclean", () => {
    const causes = dispatchUncleanCauses(okDispatch({ status: 0, classification: "no-response", pointsCost: null, dispatchFailure: "stream error" }));
    expect(causes.join(" ")).toMatch(/stream error/);
  });
  test("every non-ok classification is unclean", () => {
    for (const cls of ["primary", "secondary", "transient", "fatal", "malformed-body", "unaccepted-2xx"]) {
      expect(dispatchUncleanCauses(okDispatch({ classification: cls, status: cls === "transient" ? 500 : 200 })).length).toBeGreaterThan(0);
    }
  });
  test("secondary evidence on an otherwise-ok response is unclean", () => {
    expect(dispatchUncleanCauses(okDispatch({ secondaryLike: true })).join(" ")).toMatch(/secondary/);
    expect(dispatchUncleanCauses(okDispatch({ secondarySignal: "graphql-rate-limited" })).join(" ")).toMatch(/secondary/);
  });
  test("a throttle-typed body error is unclean even beside ok-shaped data", () => {
    expect(dispatchUncleanCauses(okDispatch({ errorTypes: ["RATE_LIMITED"] })).join(" ")).toMatch(/throttle/);
  });
  test("an exhausted window header (remaining 0) is unclean", () => {
    expect(dispatchUncleanCauses(okDispatch({ remaining: 0 })).join(" ")).toMatch(/remaining/);
  });
  test("a resource-limit signal is unclean", () => {
    expect(dispatchUncleanCauses(okDispatch({ errorMessages: ["query exceeds the node limit"] })).join(" ")).toMatch(/resource-limit/);
  });
  test("an unreadable cost on an ok response is unclean (gates need measured points)", () => {
    expect(dispatchUncleanCauses(okDispatch({ pointsCost: null })).join(" ")).toMatch(/cost/);
  });
  test("a documented timeout status is named (the quarantine trigger)", () => {
    expect(dispatchUncleanCauses(okDispatch({ status: 502, classification: "transient", pointsCost: null })).join(" ")).toMatch(/502/);
    expect(dispatchUncleanCauses(okDispatch({ status: 504, classification: "transient", pointsCost: null })).join(" ")).toMatch(/504/);
  });
  test("malformed error entries are unclean", () => {
    expect(dispatchUncleanCauses(okDispatch({ malformedErrorEntries: 1 })).length).toBeGreaterThan(0);
  });
  test("a nonzero gh exit under an ok-shaped 200 is unclean (the truncated-transfer precedent)", () => {
    expect(dispatchUncleanCauses(okDispatch({ exitCode: 1 })).join(" ")).toMatch(/exit/);
  });
});

// ---- try evaluation --------------------------------------------------------------------------

describe("evaluateTry", () => {
  const p1cell = cellOf(10, "p1", p1Repos(10));
  const p2cell = cellOf(10, "p2", p2Repos(10));

  test("a fully clean p1 pair: clean verdict, priced arms, pair ratio", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    const ev = evaluateTry(p1cell, dispatches, walks);
    expect(ev.verdict).toBe("clean");
    expect(ev.causes).toEqual([]);
    expect(ev.candidate.page1Points).toBe(1);
    expect(ev.candidate.perBatchPoints).toEqual([1]);
    expect(ev.candidate.continuationPoints).toBe(0);
    expect(ev.candidate.reposCovered).toBe(10);
    expect(ev.control.totalPoints).toBe(10);
    expect(ev.pairRatio).toBeCloseTo(0.1, 10);
  });
  test("a fully clean p2 pair prices continuations per arm", () => {
    const { dispatches, walks } = cleanTryParts(p2cell);
    const ev = evaluateTry(p2cell, dispatches, walks);
    expect(ev.verdict).toBe("clean");
    expect(ev.candidate.continuationPoints).toBe(10); // one continuation page per repo at cost 1
    expect(ev.candidate.continuationPagesObserved).toBe(10);
    expect(ev.control.totalPoints).toBe(20);
    expect(ev.pairRatio).toBeCloseTo(11 / 20, 10);
  });
  test("a 502 in the candidate arm is quarantine-unclean", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    dispatches[0] = okDispatch({ status: 502, classification: "transient", pointsCost: null });
    expect(evaluateTry(p1cell, dispatches, walks).verdict).toBe("quarantine-unclean");
  });
  test("a 504 in the control arm is quarantine-unclean too (any arm)", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    const i = dispatches.findIndex((d) => d.arm === "control");
    dispatches[i] = { ...dispatches[i]!, status: 504, classification: "transient", pointsCost: null };
    expect(evaluateTry(p1cell, dispatches, walks).verdict).toBe("quarantine-unclean");
  });
  test("a dirty control invalidates the try (the denominator prerequisite)", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    const i = dispatches.findIndex((d) => d.arm === "control");
    dispatches[i] = { ...dispatches[i]!, status: 500, classification: "transient", pointsCost: null };
    const ev = evaluateTry(p1cell, dispatches, walks);
    expect(ev.verdict).toBe("invalidated");
    expect(ev.invalidationCause).toMatch(/control/);
  });
  test("page-count drift in the candidate arm invalidates (complete at the wrong depth)", () => {
    const { dispatches, walks } = cleanTryParts(p2cell);
    const i = walks.findIndex((w) => w.arm === "candidate");
    walks[i] = { ...walks[i]!, pagesObserved: 1, complete: true };
    const ev = evaluateTry(p2cell, dispatches, walks);
    expect(ev.verdict).toBe("invalidated");
    expect(ev.invalidationCause).toMatch(/drift/);
  });
  test("page-count drift in the control arm invalidates (still paginating at the frozen bound)", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    const i = walks.findIndex((w) => w.arm === "control");
    walks[i] = { ...walks[i]!, complete: false, stoppedBy: "frozen-bound" };
    const ev = evaluateTry(p1cell, dispatches, walks);
    expect(ev.verdict).toBe("invalidated");
    expect(ev.invalidationCause).toMatch(/drift/);
  });
  test("an incomplete walk from a failed dispatch is NOT drift — the candidate failure decides the gate", () => {
    // a transient 500 mid-continuation aborts the walk; misreading that as page-count
    // drift would buy an illegitimate re-run for a gate-deciding unclean try
    const { dispatches, walks } = cleanTryParts(p2cell);
    const di = dispatches.findIndex((d) => d.arm === "candidate" && d.callKind === "solo-page");
    dispatches[di] = { ...dispatches[di]!, status: 500, classification: "transient", pointsCost: null };
    const wi = walks.findIndex((w) => w.arm === "candidate" && w.repo === dispatches[di]!.repo);
    walks[wi] = { ...walks[wi]!, pagesObserved: 1, complete: false, stoppedBy: "dispatch-failure" };
    const ev = evaluateTry(p2cell, dispatches, walks);
    expect(ev.verdict).toBe("unclean");
  });
  test("a candidate-arm failure with a clean control fails the try unclean (gate-deciding)", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    const i = dispatches.findIndex((d) => d.arm === "candidate" && d.callKind === "batch-page1");
    dispatches[i] = { ...dispatches[i]!, status: 500, classification: "transient", pointsCost: null };
    const ev = evaluateTry(p1cell, dispatches, walks);
    expect(ev.verdict).toBe("unclean");
    expect(ev.causes.length).toBeGreaterThan(0);
  });
  test("a candidate battery failure is unclean", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    const i = walks.findIndex((w) => w.arm === "candidate");
    walks[i] = { ...walks[i]!, batteryFailure: "malformed branch-head node" };
    expect(evaluateTry(p1cell, dispatches, walks).verdict).toBe("unclean");
  });
  test("an identity re-assertion failure is unclean", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    const i = walks.findIndex((w) => w.arm === "candidate");
    walks[i] = { ...walks[i]!, identityFailure: "alias r0 carries other/repo" };
    expect(evaluateTry(p1cell, dispatches, walks).verdict).toBe("unclean");
  });
  test("missing candidate coverage is unclean; missing control coverage invalidates", () => {
    const full = cleanTryParts(p1cell);
    const noCandWalk = full.walks.filter((w, i) => !(w.arm === "candidate" && i === 0));
    expect(evaluateTry(p1cell, full.dispatches, noCandWalk).verdict).toBe("unclean");
    const again = cleanTryParts(p1cell);
    const noCtrlWalk = again.walks.filter((w) => !(w.arm === "control" && w.repo.endsWith("-0")));
    const ev = evaluateTry(p1cell, again.dispatches, noCtrlWalk);
    expect(ev.verdict).toBe("invalidated");
  });
  test("quarantine precedence beats drift and dirty control", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    const ci = dispatches.findIndex((d) => d.arm === "control");
    dispatches[ci] = { ...dispatches[ci]!, status: 502, classification: "transient", pointsCost: null };
    const wi = walks.findIndex((w) => w.arm === "candidate");
    walks[wi] = { ...walks[wi]!, complete: false };
    expect(evaluateTry(p1cell, dispatches, walks).verdict).toBe("quarantine-unclean");
  });
  test("dirty control takes precedence over a candidate failure (invalid before gate-deciding)", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    const ci = dispatches.findIndex((d) => d.arm === "control");
    dispatches[ci] = { ...dispatches[ci]!, status: 500, classification: "transient", pointsCost: null };
    const bi = dispatches.findIndex((d) => d.callKind === "batch-page1");
    dispatches[bi] = { ...dispatches[bi]!, status: 500, classification: "transient", pointsCost: null };
    expect(evaluateTry(p1cell, dispatches, walks).verdict).toBe("invalidated");
  });
  test("a candidate failure with a never-started control is unclean, not invalidated (the runner may skip the denominator once the gate is decided)", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    const candOnlyDispatches = dispatches.filter((d) => d.arm === "candidate");
    const candOnlyWalks = walks.filter((w) => w.arm === "candidate");
    const bi = candOnlyDispatches.findIndex((d) => d.callKind === "batch-page1");
    candOnlyDispatches[bi] = { ...candOnlyDispatches[bi]!, status: 500, classification: "transient", pointsCost: null };
    const ev = evaluateTry(p1cell, candOnlyDispatches, candOnlyWalks);
    expect(ev.verdict).toBe("unclean");
  });
  test("a clean candidate with a never-started control invalidates (no denominator, no verdict)", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    const candOnlyDispatches = dispatches.filter((d) => d.arm === "candidate");
    const candOnlyWalks = walks.filter((w) => w.arm === "candidate");
    const ev = evaluateTry(p1cell, candOnlyDispatches, candOnlyWalks);
    expect(ev.verdict).toBe("invalidated");
    expect(ev.invalidationCause).toMatch(/control/);
  });
  test("header deltas include the first request's own cost (cross-check only)", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    dispatches.forEach((d, i) => { dispatches[i] = { ...d, remaining: 5_000 - i }; });
    const ev = evaluateTry(p1cell, dispatches, walks);
    // control arm: 10 solo pages, remaining walks down by 1 each, every cost 1 —
    // (first.remaining + first.cost) − last.remaining = the arm's full spend, 10
    expect(ev.control.headerDelta).toBe(10);
    // candidate arm: a single batch — its own cost is the whole delta
    expect(ev.candidate.headerDelta).toBe(1);
  });
  test("a header delta spanning different reset epochs is withheld (misleading across windows)", () => {
    const { dispatches, walks } = cleanTryParts(p1cell);
    const i = dispatches.findIndex((d) => d.arm === "control");
    dispatches[i] = { ...dispatches[i]!, resetEpochSec: 1_800_003_600 };
    const ev = evaluateTry(p1cell, dispatches, walks);
    expect(ev.control.headerDelta).toBeNull();
  });
});

// ---- journal parsing -------------------------------------------------------------------------

describe("parseJournalRow", () => {
  test("a try row round-trips", () => {
    const row = tryRow();
    expect(parseJournalRow(JSON.stringify(row))).toEqual(row);
  });
  test("operational rows round-trip", () => {
    const rows: RefsProbeJournalRow[] = [
      { rowKind: "header", version: 1, atIso: "2026-08-05T00:00:00Z", corpusSha256: "ab".repeat(32), corpusPath: "refs-corpus.json", benchConfigPath: "bench-config.json", benchConfigSha256: "cd".repeat(32), constantsFingerprint: "{}" },
      { rowKind: "admission", version: 1, atIso: "2026-08-05T00:00:00Z", cellB: 10, stratum: "p1", slot: 1, attempt: 1, neededPoints: 73, remainingObserved: 4_000, sleptMs: 0 },
      { rowKind: "try-start", version: 1, atIso: "2026-08-05T00:00:00Z", cellB: 10, stratum: "p1", slot: 1, attempt: 1 },
      { rowKind: "quarantine", version: 1, atIso: "2026-08-05T00:00:00Z", cellB: 10, stratum: "p1", slot: 2, attempt: 1, untilEpochSec: 1_800_000_000, plannedSleepMs: 60_000 },
      { rowKind: "washout", version: 1, atIso: "2026-08-05T00:00:00Z", sleptMs: 60_000 },
    ];
    for (const r of rows) expect(parseJournalRow(JSON.stringify(r))).toEqual(r);
  });
  test("garbage and unknown kinds are rejected", () => {
    expect(() => parseJournalRow("nope")).toThrow(BenchRefsRulesError);
    expect(() => parseJournalRow(JSON.stringify({ rowKind: "mystery" }))).toThrow(BenchRefsRulesError);
    expect(() => parseJournalRow(JSON.stringify({ rowKind: "try", version: 1 }))).toThrow(BenchRefsRulesError);
  });
});

// ---- cell state derivation -------------------------------------------------------------------

describe("deriveCellState", () => {
  const cell = cellOf(10, "p1", p1Repos(10));

  test("no rows: pending at slot 1, attempt 1", () => {
    expect(deriveCellState(cell, [])).toEqual({ kind: "pending", nextSlot: 1, nextAttempt: 1, invalidationsUsed: 0 });
  });
  test("a clean slot advances to the next", () => {
    expect(deriveCellState(cell, [tryRow({ slot: 1 })])).toEqual({ kind: "pending", nextSlot: 2, nextAttempt: 1, invalidationsUsed: 0 });
  });
  test("five clean slots complete the cell", () => {
    expect(deriveCellState(cell, cleanRows(10, "p1"))).toEqual({ kind: "complete" });
  });
  test("an invalidated attempt re-runs the same slot", () => {
    const rows = [tryRow({ slot: 1, verdict: "invalidated", invalidationCause: "page-count-drift" })];
    expect(deriveCellState(cell, rows)).toEqual({ kind: "pending", nextSlot: 1, nextAttempt: 2, invalidationsUsed: 1 });
  });
  test("more than two invalidations commit the cell invalid", () => {
    const rows = [
      tryRow({ slot: 1, attempt: 1, verdict: "invalidated", invalidationCause: "page-count-drift" }),
      tryRow({ slot: 1, attempt: 2, verdict: "clean" }),
      tryRow({ slot: 2, attempt: 1, verdict: "invalidated", invalidationCause: "dirty-control" }),
      tryRow({ slot: 2, attempt: 2, verdict: "invalidated", invalidationCause: "page-count-drift" }),
    ];
    const st = deriveCellState(cell, rows);
    expect(st.kind).toBe("invalid");
  });
  test("an unclean try terminates the cell with its cause", () => {
    const rows = [tryRow({ slot: 1, verdict: "unclean", causes: ["candidate transient"] })];
    expect(deriveCellState(cell, rows)).toEqual({ kind: "terminated-unclean", cause: "candidate transient" });
  });
  test("a quarantine-unclean try terminates the cell", () => {
    const rows = [tryRow({ slot: 2, verdict: "quarantine-unclean", causes: ["502"] })];
    const st = deriveCellState(cell, rows);
    expect(st.kind).toBe("terminated-unclean");
  });
  test("a corpus-infeasible cell derives infeasible", () => {
    const infeasible: RefsCorpusCell = { batchSize: 50, stratum: "p1", feasible: false, infeasibleCause: "cannot furnish 50", repos: [] };
    expect(deriveCellState(infeasible, [])).toEqual({ kind: "infeasible", cause: "cannot furnish 50" });
  });
  test("an admission-infeasible row derives infeasible", () => {
    const rows: RefsProbeJournalRow[] = [{
      rowKind: "admission-infeasible", version: 1, atIso: "2026-08-05T00:00:00Z", cellB: 10, stratum: "p1",
      arithmetic: admitTranche(cell, 2, 1.1),
    }];
    const st = deriveCellState(cell, rows);
    expect(st.kind).toBe("infeasible");
  });
  test("rows for other cells are ignored", () => {
    const rows = [tryRow({ cellB: 25, slot: 1 }), tryRow({ stratum: "p2", slot: 1 })];
    expect(deriveCellState(cell, rows)).toEqual({ kind: "pending", nextSlot: 1, nextAttempt: 1, invalidationsUsed: 0 });
  });
  test("a dangling try-start (a crash mid-try) advances the attempt without an invalidation", () => {
    const rows: RefsProbeJournalRow[] = [
      { rowKind: "try-start", version: 1, atIso: "2026-08-05T00:00:00Z", cellB: 10, stratum: "p1", slot: 1, attempt: 1 },
    ];
    expect(deriveCellState(cell, rows)).toEqual({ kind: "pending", nextSlot: 1, nextAttempt: 2, invalidationsUsed: 0 });
  });
  test("a try-start matched by its try row does not double-count the attempt", () => {
    const rows: RefsProbeJournalRow[] = [
      { rowKind: "try-start", version: 1, atIso: "2026-08-05T00:00:00Z", cellB: 10, stratum: "p1", slot: 1, attempt: 1 },
      tryRow({ slot: 1, attempt: 1 }),
    ];
    expect(deriveCellState(cell, rows)).toEqual({ kind: "pending", nextSlot: 2, nextAttempt: 1, invalidationsUsed: 0 });
  });
});

// ---- reducers --------------------------------------------------------------------------------

describe("reduceCell (both reducers, exactly as the ADR states them)", () => {
  test("page-1 reducer: max over clean tries of summed page-1 points ÷ repositories covered", () => {
    const rows = [
      tryRow({ slot: 1, candidate: cleanSummary({ page1Points: 1, reposCovered: 10 }) }),
      tryRow({ slot: 2, candidate: cleanSummary({ page1Points: 2, reposCovered: 10 }) }),
      tryRow({ slot: 3, verdict: "invalidated", invalidationCause: "x", candidate: cleanSummary({ page1Points: 9, reposCovered: 10 }) }),
    ];
    const red = reduceCell(rows);
    expect(red.cleanTryCount).toBe(2);
    expect(red.page1PerRepoMax).toBeCloseTo(0.2, 10);
  });
  test("continuation reducer: max over clean tries of continuation points ÷ pages observed", () => {
    const rows = [
      tryRow({ slot: 1, candidate: cleanSummary({ continuationPoints: 10, continuationPagesObserved: 10 }) }),
      tryRow({ slot: 2, candidate: cleanSummary({ continuationPoints: 15, continuationPagesObserved: 10 }) }),
    ];
    expect(reduceCell(rows).continuationPerPageMax).toBeCloseTo(1.5, 10);
  });
  test("a p1 cell (no continuation pages) reduces to null, never divides by zero", () => {
    expect(reduceCell([tryRow({})]).continuationPerPageMax).toBeNull();
  });
  test("wall reduction: max candidate page-1 wall over clean tries", () => {
    const rows = [
      tryRow({ slot: 1, candidate: cleanSummary({ page1MaxWallMs: 900 }) }),
      tryRow({ slot: 2, candidate: cleanSummary({ page1MaxWallMs: 4_400 }) }),
    ];
    expect(reduceCell(rows).page1WallMaxMs).toBe(4_400);
  });
  test("zero clean tries reduce to nulls", () => {
    const red = reduceCell([tryRow({ verdict: "unclean" })]);
    expect(red.cleanTryCount).toBe(0);
    expect(red.page1PerRepoMax).toBeNull();
    expect(red.page1WallMaxMs).toBeNull();
  });
});

// ---- candidate gates -------------------------------------------------------------------------

describe("evaluateCandidate (every gate, both strata)", () => {
  const p1rows = (): RefsTryRow[] => cleanRows(10, "p1");
  const p2rows = (): RefsTryRow[] => cleanRows(10, "p2", () => ({
    candidate: cleanSummary({ continuationPoints: 10, continuationPagesObserved: 10, totalPoints: 11 }),
    control: cleanSummary({ page1Points: 10, continuationPoints: 10, totalPoints: 20, perBatchPoints: [], reposCovered: 10, continuationPagesObserved: 10 }),
    pairRatio: 11 / 20,
  }));

  test("clean cells passing every gate pass the candidate", () => {
    const v = evaluateCandidate(10, completeOutcome(p1rows()), completeOutcome(p2rows()));
    expect(v).toEqual({ batchSize: 10, candidate: true, passed: true, causes: [] });
  });
  test("a non-complete cell fails with the cell's status named", () => {
    const p1 = { status: { kind: "invalid", cause: "3 invalidations" }, reduction: reduceCell([]), tryRows: [] } as RefsCellOutcome;
    const v = evaluateCandidate(10, p1, completeOutcome(p2rows()));
    expect(v.passed).toBe(false);
    expect(v.causes.join(" ")).toMatch(/invalid/);
  });
  test("the wall gate binds on the candidate batched page-1 maximum (≤ 5 s)", () => {
    const slow = cleanRows(10, "p2", (s) => (s === 3 ? { candidate: cleanSummary({ page1MaxWallMs: 5_001 }) } : {}));
    const v = evaluateCandidate(10, completeOutcome(p1rows()), completeOutcome(slow));
    expect(v.passed).toBe(false);
    expect(v.causes.join(" ")).toMatch(/wall/);
  });
  test("the pair gate binds per pair in the p1 stratum — one bad pair fails even when the mean would pass", () => {
    const rows = cleanRows(10, "p1", (s) => (s === 2 ? { pairRatio: 0.6 } : { pairRatio: 0.04 }));
    const v = evaluateCandidate(10, completeOutcome(rows), completeOutcome(p2rows()));
    expect(v.passed).toBe(false);
    expect(v.causes.join(" ")).toMatch(/pair/);
  });
  test("an inflated control tightens only its own pair, never loosens another's", () => {
    // slot 2's control is inflated (denominator huge → tiny ratio); slot 4 genuinely fails.
    const rows = cleanRows(10, "p1", (s) =>
      s === 2 ? { pairRatio: 0.001 } : s === 4 ? { pairRatio: 0.51 } : { pairRatio: 0.1 });
    const v = evaluateCandidate(10, completeOutcome(rows), completeOutcome(p2rows()));
    expect(v.passed).toBe(false); // the inflated pair cannot rescue slot 4
  });
  test("a ratio of exactly one half passes", () => {
    const rows = cleanRows(10, "p1", () => ({ pairRatio: 0.5 }));
    const v = evaluateCandidate(10, completeOutcome(rows), completeOutcome(p2rows()));
    expect(v.passed).toBe(true);
  });
  test("the pair gate does not bind in the p2 stratum (algebraic floor above one half)", () => {
    const rows = cleanRows(10, "p2", () => ({
      candidate: cleanSummary({ continuationPoints: 10, continuationPagesObserved: 10, totalPoints: 11 }),
      control: cleanSummary({ page1Points: 10, continuationPoints: 10, totalPoints: 20, perBatchPoints: [], reposCovered: 10, continuationPagesObserved: 10 }),
      pairRatio: 0.55,
    }));
    const v = evaluateCandidate(10, completeOutcome(p1rows()), completeOutcome(rows));
    expect(v.passed).toBe(true);
  });
  test("the absolute gate binds per batch in both strata", () => {
    const heavy = cleanRows(10, "p1", (s) => (s === 5 ? { candidate: cleanSummary({ page1Points: 3, perBatchPoints: [3] }) } : {}));
    const v = evaluateCandidate(10, completeOutcome(heavy), completeOutcome(p2rows()));
    expect(v.passed).toBe(false);
    expect(v.causes.join(" ")).toMatch(/absolute/);
    const heavyP2 = cleanRows(10, "p2", (s) => (s === 1 ? { candidate: cleanSummary({ page1Points: 3, perBatchPoints: [3], continuationPoints: 10, continuationPagesObserved: 10 }) } : {}));
    const v2 = evaluateCandidate(10, completeOutcome(p1rows()), completeOutcome(heavyP2));
    expect(v2.passed).toBe(false);
  });
  test("B = 50 evaluates as informational, never a candidate", () => {
    const v = evaluateCandidate(50, completeOutcome(cleanRows(50, "p1")), completeOutcome(cleanRows(50, "p2")));
    expect(v.candidate).toBe(false);
  });
});

// ---- selection -------------------------------------------------------------------------------

describe("selectOutcome (contiguous prefix, cheapest measured, smaller-B ties)", () => {
  const verdict = (b: number, passed: boolean, candidate = true): RefsCandidateVerdict => ({
    batchSize: b, candidate, passed, causes: passed ? [] : ["some gate"],
  });
  const reductions = (m: Record<number, number | null>): Map<number, RefsCellReduction> =>
    new Map(Object.entries(m).map(([b, v]) => [Number(b), {
      cleanTryCount: 5, page1PerRepoMax: v, continuationPerPageMax: 1, page1WallMaxMs: 900,
    }]));

  test("both candidates pass: the cheapest measured per-repository page-1 cost wins", () => {
    const out = selectOutcome([verdict(10, true), verdict(25, true)], reductions({ 10: 0.1, 25: 0.04 }));
    expect(out).toEqual({ kind: "default-pinned", defaultBatchSize: 25, page1PerRepo: 0.04, correctedFloor8x750: 240 });
  });
  test("ties go to the smaller B — largest-passing is not a selection rule", () => {
    const out = selectOutcome([verdict(10, true), verdict(25, true)], reductions({ 10: 0.04, 25: 0.04 }));
    expect(out.kind).toBe("default-pinned");
    if (out.kind === "default-pinned") expect(out.defaultBatchSize).toBe(10);
  });
  test("B = 10 passing alone pins 10", () => {
    const out = selectOutcome([verdict(10, true), verdict(25, false)], reductions({ 10: 0.05, 25: null }));
    expect(out.kind).toBe("default-pinned");
    if (out.kind === "default-pinned") expect(out.defaultBatchSize).toBe(10);
  });
  test("B = 10 failing while B = 25 passes is the non-monotone anomaly", () => {
    const out = selectOutcome([verdict(10, false), verdict(25, true)], reductions({ 10: null, 25: 0.04 }));
    expect(out.kind).toBe("anomaly");
  });
  test("an invalid B = 10 cell blocks the prefix the same way (fails like a failing one)", () => {
    const v10: RefsCandidateVerdict = { batchSize: 10, candidate: true, passed: false, causes: ["cell p1 invalid: 3 invalidations"] };
    const out = selectOutcome([v10, verdict(25, true)], reductions({ 10: null, 25: 0.04 }));
    expect(out.kind).toBe("anomaly");
  });
  test("no candidate passing is the no-pass outcome", () => {
    const out = selectOutcome([verdict(10, false), verdict(25, false)], reductions({ 10: null, 25: null }));
    expect(out.kind).toBe("no-pass");
  });
  test("the ship threshold fires no-pass when the corrected floor reaches 10% of a window", () => {
    // reducer 0.1 → corrected 8×750 floor = 6,000 × 0.1 = 600 ≥ 500 → the default must not ship
    const out = selectOutcome([verdict(10, true), verdict(25, false)], reductions({ 10: 0.1, 25: null }));
    expect(out.kind).toBe("no-pass");
    if (out.kind === "no-pass") expect(out.correctedFloor8x750).toBe(600);
  });
  test("a passing informational B = 50 changes nothing", () => {
    const out = selectOutcome(
      [verdict(10, false), verdict(25, false), verdict(50, true, false)],
      reductions({ 10: null, 25: null, 50: 0.02 }),
    );
    expect(out.kind).toBe("no-pass");
  });
  test("a B = 1 verdict is a wiring bug and throws (never gated as a candidate)", () => {
    expect(() => selectOutcome([verdict(1, true)], reductions({ 1: 0.5 }))).toThrow(BenchRefsRulesError);
  });
});

// ---- admission -------------------------------------------------------------------------------

describe("admitTranche (per-tranche worst case; the tranche is the try)", () => {
  test("p1 minimum topology: batches + control pages at the conservative bound", () => {
    const cell = cellOf(10, "p1", p1Repos(10));
    const a = admitTranche(cell, 2, 1.1);
    expect(a.batches).toBe(1);
    expect(a.candidateContinuations).toBe(0);
    expect(a.controlPages).toBe(10);
    expect(a.dispatchesPerTry).toBe(11);
    expect(a.rerunMultiplier).toBe(3);
    expect(a.neededPoints).toBe(Math.ceil(11 * 2 * 1.1 * 3)); // 73
    expect(a.feasible).toBe(true);
  });
  test("a paginating cell counts continuations in both arms", () => {
    const cell = cellOf(50, "p2", p2Repos(50, "probe-owner", 4));
    const a = admitTranche(cell, 2, 1.1);
    expect(a.batches).toBe(1);
    expect(a.candidateContinuations).toBe(150);
    expect(a.controlPages).toBe(200);
    expect(a.dispatchesPerTry).toBe(351);
  });
  test("spent re-runs shrink the multiplier", () => {
    const cell = cellOf(10, "p1", p1Repos(10));
    expect(admitTranche(cell, 0, 1.1).rerunMultiplier).toBe(1);
  });
  test("multi-owner corpora count chunks per owner", () => {
    const repos = [...p1Repos(10, "owner-a"), ...p1Repos(4, "owner-b")];
    const cell = cellOf(10, "p1", repos);
    expect(admitTranche(cell, 2, 1.1).batches).toBe(2);
  });
  test("a tranche whose worst case exceeds the bucket limit is infeasible (fail loudly)", () => {
    const cell = cellOf(50, "p2", p2Repos(50, "probe-owner", 40));
    const a = admitTranche(cell, 0, 1.1);
    // 1 batch + 50×39 continuations + 50×40 control = 3,951 dispatches × 2 × 1.1 ≈ 8,693
    expect(a.feasible).toBe(false);
    expect(a.neededPoints).toBeGreaterThan(REFS_PROBE_BUCKET_LIMIT_POINTS);
  });
});

// ---- corrected-estate presentation -----------------------------------------------------------

describe("presentCorrectedEstates", () => {
  test("measured reducers replace formula prices; single-repo owners keep the 1-point floor", () => {
    const rows = presentCorrectedEstates(25, 0.04, 1);
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by["8 orgs x 750"]).toEqual({
      label: "8 orgs x 750", keptRepos: 6_000, todayPage1Points: 6_000,
      measuredPage1Points: 240, allSinglePageTotal: 240, uniformP2Total: 6_240,
    });
    expect(by["1,000 owners x 1"]!.measuredPage1Points).toBe(1_000); // batching buys nothing there
    expect(by["1 org x 1,000"]!.measuredPage1Points).toBe(40);
  });
  test("a missing continuation reducer falls back to the formula's one point per page", () => {
    const rows = presentCorrectedEstates(25, 0.04, null);
    const r = rows.find((x) => x.label === "8 orgs x 750")!;
    expect(r.uniformP2Total).toBe(240 + 6_000);
  });
});
