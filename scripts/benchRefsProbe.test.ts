import { describe, expect, test } from "bun:test";
import type { BenchGraphqlDispatch, BenchHttpAttemptRecord, RateLimitSnapshot } from "./benchGh.ts";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { MAX_ATTEMPTS } from "./github.ts";
import {
  BENCH_CONFIG_EVIDENCE_PATH,
  BenchRefsRulesError,
  acquireProbeLock,
  assertProbeIdentity,
  classifyJournalTail,
  fileJournalAppender,
  journalPathFor,
  parseJournal,
  parseRefsProbeCorpus,
  probeConstantsFingerprint,
  probeLoginFromUserPayload,
  releaseProbeLock,
  repoRelativeEvidencePath,
  runRefsProbe,
  type RefsDispatchOutcome,
  type RefsProbeCorpus,
  type RefsProbeDeps,
  type RefsProbeJournalRow,
  type RefsProbeResult,
  type RefsTryRow,
} from "./benchRefsProbe.ts";

// ---- corpus fixtures -------------------------------------------------------------------------

const LOGIN = "sondrateconsulting-ryan";

function corpusJson(opts: { infeasible?: Array<[number, "p1" | "p2"]>; p2Pages?: number } = {}): RefsProbeCorpus {
  const infeasible = new Set((opts.infeasible ?? []).map(([b, s]) => `${b}/${s}`));
  const p2Pages = opts.p2Pages ?? 2;
  const cells = [10, 25, 50].flatMap((b) =>
    (["p1", "p2"] as const).map((s) => {
      if (infeasible.has(`${b}/${s}`))
        return { batchSize: b, stratum: s, feasible: false, infeasibleCause: "test infeasible", repos: [] };
      const pages = s === "p1" ? 1 : p2Pages;
      const heads = pages === 1 ? 2 : (pages - 1) * 100 + 1;
      return {
        batchSize: b,
        stratum: s,
        feasible: true,
        infeasibleCause: null,
        repos: Array.from({ length: b }, (_, i) => ({
          owner: "probe-owner",
          name: `refs-${s}-b${b}-${i}`,
          frozenPages: pages,
          frozenHeads: heads,
        })),
      };
    }),
  );
  return parseRefsProbeCorpus(JSON.stringify({
    version: 1, frozenAtIso: "2026-08-05T00:00:00Z", login: LOGIN, provenance: "test corpus", cells,
  }));
}

// ---- the scripted GitHub (answers batch + solo refs queries from the corpus) -----------------

interface ScriptedCall {
  ordinal: number;
  query: string;
  fields: Record<string, string>;
  label: string;
}

interface ScriptedOptions {
  // live page count per repo key (default: the frozen depth) — drift injection
  livePages?: (repoKey: string) => number;
  // full override for chosen calls; return null to use the scripted default
  intercept?: (call: ScriptedCall) => RefsDispatchOutcome | null;
}

const oidOf = (seed: string): string => {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(5);
};

function refsPage(repoKey: string, totalHeads: number, pageNo: number): unknown {
  const per = 100;
  const start = (pageNo - 1) * per;
  const count = Math.max(0, Math.min(per, totalHeads - start));
  const totalPages = Math.max(1, Math.ceil(totalHeads / per));
  return {
    defaultBranchRef: totalHeads === 0 ? null : { name: "b0" },
    refs: {
      pageInfo: { hasNextPage: pageNo < totalPages, endCursor: pageNo < totalPages ? `c${pageNo}` : null },
      nodes: Array.from({ length: count }, (_, i) => ({
        name: `b${start + i}`,
        target: {
          oid: oidOf(`${repoKey}:${start + i}`),
          committedDate: "2026-01-02T03:04:05Z",
          tree: { oid: oidOf(`t:${repoKey}:${start + i}`) },
        },
      })),
    },
  };
}

function okOutcome(data: Record<string, unknown>, label: string, ordinal: number): RefsDispatchOutcome {
  const bodyText = JSON.stringify({ data });
  const d: BenchGraphqlDispatch = {
    status: 200, exitCode: 0, headers: {}, bodyText,
    data, errors: [], malformedErrorEntries: 0, jsonParseable: true,
    classification: "ok", secondaryLike: false, primaryUntilMs: null,
    pointsCost: 1,
  };
  const rec: BenchHttpAttemptRecord = {
    type: "http-attempt", atMs: ordinal, wallMs: 40 + (ordinal % 3), kind: "graphql", requestClass: "graphql-batch",
    label, attempt: 1, status: 200, exitCode: 0, classification: "ok", secondarySignal: null,
    pointsCost: 1, remaining: 4_999 - (ordinal % 4_000), resetEpochSec: 1_900_000_000, servedFromCache: false,
    bodyBytes: Buffer.byteLength(bodyText, "utf8"),
  };
  return { d, rec };
}

export function faultOutcome(
  over: { status: number; classification?: string; label: string; ordinal: number; resetEpochSec?: number },
): RefsDispatchOutcome {
  const d: BenchGraphqlDispatch = {
    status: over.status, exitCode: 1, headers: {}, bodyText: "",
    data: null, errors: [], malformedErrorEntries: 0, jsonParseable: false,
    classification: over.classification ?? "transient", secondaryLike: false, primaryUntilMs: null,
    pointsCost: null,
  };
  const rec: BenchHttpAttemptRecord = {
    type: "http-attempt", atMs: over.ordinal, wallMs: 25, kind: "graphql", requestClass: "graphql-batch",
    label: over.label, attempt: 1, status: over.status, exitCode: 1,
    classification: over.classification ?? "transient", secondarySignal: null,
    pointsCost: null, remaining: 4_000, resetEpochSec: over.resetEpochSec ?? 1_900_000_000,
    servedFromCache: false, bodyBytes: 0,
  };
  return { d, rec };
}

function scriptedGithub(corpus: RefsProbeCorpus, opts: ScriptedOptions = {}) {
  const depthByKey = new Map<string, { frozenPages: number; frozenHeads: number }>();
  for (const cell of corpus.cells) {
    for (const r of cell.repos) depthByKey.set(`${r.owner}/${r.name}`.toLowerCase(), { frozenPages: r.frozenPages, frozenHeads: r.frozenHeads });
  }
  const headsFor = (key: string): number => {
    const frozen = depthByKey.get(key);
    if (frozen === undefined) throw new Error(`scripted github knows no repo ${key}`);
    const pages = opts.livePages === undefined ? frozen.frozenPages : opts.livePages(key);
    return pages === 1 ? 2 : (pages - 1) * 100 + 1;
  };
  const calls: ScriptedCall[] = [];
  const dispatch = async (query: string, fields: Record<string, string>, label: string): Promise<RefsDispatchOutcome> => {
    const call: ScriptedCall = { ordinal: calls.length, query, fields, label };
    calls.push(call);
    const custom = opts.intercept?.(call);
    if (custom !== null && custom !== undefined) return custom;
    if (query.includes("r0:repository")) {
      const data: Record<string, unknown> = { rateLimit: { cost: 1 } };
      for (let i = 0; `o${i}` in fields; i++) {
        const key = `${fields[`o${i}`]}/${fields[`n${i}`]}`;
        data[`r${i}`] = {
          nameWithOwner: key,
          ...(refsPage(key.toLowerCase(), headsFor(key.toLowerCase()), 1) as Record<string, unknown>),
        };
      }
      return okOutcome(data, label, call.ordinal);
    }
    const key = `${fields["owner"]}/${fields["name"]}`.toLowerCase();
    const cursor = fields["endCursor"];
    const pageNo = cursor === undefined ? 1 : Number(cursor.slice(1)) + 1;
    return okOutcome(
      { repository: refsPage(key, headsFor(key), pageNo), rateLimit: { cost: 1 } },
      label, call.ordinal,
    );
  };
  return { dispatch, calls };
}

// ---- deps harness ----------------------------------------------------------------------------

function makeDeps(corpus: RefsProbeCorpus, script: ReturnType<typeof scriptedGithub>, over: Partial<RefsProbeDeps> = {}) {
  let clock = 1_754_000_000_000;
  const journal: RefsProbeJournalRow[] = [];
  const results: RefsProbeResult[] = [];
  const sleeps: number[] = [];
  const events: string[] = []; // interleaved order of appends, sleeps, dispatches, and rate-limit reads
  const rl = (remaining: number): RateLimitSnapshot => ({
    core: { remaining: 5_000, reset: 1_900_000_000, used: 0 },
    graphql: { remaining, reset: 1_900_000_000, used: 5_000 - remaining },
    atMs: clock,
  });
  const deps: RefsProbeDeps = {
    corpus,
    corpusPath: "corpus.json",
    corpusSha256: "test-corpus-sha",
    outPath: "refs-probe.json",
    journalPath: "refs-probe-journal.jsonl",
    benchConfigPath: "bench-config.json",
    benchConfigSha256: "test-config-sha",
    existingJournalText: "",
    droppedTornTailBytes: null,
    appendJournal: (row) => {
      journal.push(row);
      events.push(`append:${row.rowKind}`);
    },
    writeResult: (r) => results.push(r),
    dispatchGraphql: (query, fields, label) => {
      events.push(`dispatch:${label}`);
      return script.dispatch(query, fields, label);
    },
    // default: no attempt records. The event marks WHERE a /rate_limit read fell in the
    // sequence — the quarantine fallback is the one site that must never need one.
    readRateLimit: async () => {
      events.push("rate-limit");
      return rl(4_900);
    },
    outstandingHorizonMs: () => 0,
    headroomFactor: 1.1,
    washoutFloorMs: 60_000,
    log: () => {},
    now: () => (clock += 10),
    sleep: async (ms) => {
      sleeps.push(ms);
      events.push(`sleep:${ms}`);
    },
    ...over,
  };
  return { deps, journal, results, sleeps, events };
}

// a valid header row for synthetic resume journals, matching makeDeps' fingerprints
const headerLine = (): string =>
  JSON.stringify({
    rowKind: "header", version: 1, atIso: "2026-08-05T00:00:00Z",
    corpusSha256: "test-corpus-sha", corpusPath: "corpus.json",
    benchConfigPath: "bench-config.json", benchConfigSha256: "test-config-sha",
    constantsFingerprint: probeConstantsFingerprint(),
  });

const tryRows = (journal: readonly RefsProbeJournalRow[]): RefsTryRow[] =>
  journal.filter((r): r is RefsTryRow => r.rowKind === "try");

// ---- tests -----------------------------------------------------------------------------------

describe("pure helpers", () => {
  test("journalPathFor pairs each result artifact with its own journal", () => {
    expect(journalPathFor("docs/adrs/0002-benchmark/refs-probe.json")).toBe("docs/adrs/0002-benchmark/refs-probe-journal.jsonl");
    expect(journalPathFor("refs-probe-2.json")).toBe("refs-probe-2-journal.jsonl");
    expect(() => journalPathFor("refs-probe.txt")).toThrow(BenchRefsRulesError);
  });
  // The /user payload is untrusted `unknown` from restGetJson. The old cast+`?? "unknown"` turned
  // a malformed response into the literal login "unknown" — which a corpus could legitimately be
  // named, since the corpus parser accepts any non-empty login. Identity is evidence-critical:
  // fail on a malformed payload rather than silently substituting a login nobody authenticated as.
  test("probeLoginFromUserPayload validates the /user payload instead of casting it", () => {
    expect(probeLoginFromUserPayload({ login: LOGIN })).toBe(LOGIN);
    for (const bad of [{ login: 42 }, {}, { login: "" }, null, [], "nope", undefined]) {
      expect(() => probeLoginFromUserPayload(bad)).toThrow(BenchRefsRulesError);
    }
  });
  test("assertProbeIdentity refuses a foreign login", () => {
    const corpus = corpusJson();
    expect(() => assertProbeIdentity(LOGIN, corpus)).not.toThrow();
    expect(() => assertProbeIdentity("someone-else", corpus)).toThrow(/someone-else/);
  });
  test("parseJournal drops only a syntactically torn, non-newline-terminated tail", () => {
    const good = JSON.stringify({ rowKind: "washout", version: 1, atIso: "2026-08-05T00:00:00Z", sleptMs: 1 });
    const warns: string[] = [];
    // a torn append: the file ends mid-JSON with no trailing newline — dropped with a warning
    expect(parseJournal(`${good}\n{"rowKind":"washout","ver`, (l) => warns.push(l)).length).toBe(1);
    expect(warns.length).toBe(1);
    // a COMPLETE but schema-invalid last line (newline-terminated) is corruption, not a tear
    expect(() => parseJournal(`${good}\n{"rowKind":"mystery"}\n`, () => {})).toThrow(BenchRefsRulesError);
    // parseable-but-wrong JSON without a newline is still corruption (the write completed)
    expect(() => parseJournal(`${good}\n{"rowKind":"mystery"}`, () => {})).toThrow(BenchRefsRulesError);
    // mid-file corruption always throws
    expect(() => parseJournal(`{"broken\n${good}\n`, () => {})).toThrow(BenchRefsRulesError);
  });
  // Evidence must mean the same thing on any machine. The Stage-P run recorded an absolute
  // benchConfigPath naming an unrelated worktree, while its sibling corpusPath was repo-relative;
  // these pin the asymmetry closed for every future run. The committed artifacts are historical
  // evidence and are deliberately NOT rewritten — see the ADR's disclosure.
  test("recorded evidence paths are repo-relative, never machine-local", () => {
    expect(BENCH_CONFIG_EVIDENCE_PATH).toBe("docs/adrs/0001-benchmark/bench-config.json");
    expect(isAbsolute(BENCH_CONFIG_EVIDENCE_PATH)).toBe(false);
  });

  test("repoRelativeEvidencePath normalizes in-repo paths and refuses to record a path outside it", () => {
    const root = "/repo";
    expect(repoRelativeEvidencePath("docs/x.json", root)).toBe("docs/x.json");
    expect(repoRelativeEvidencePath("/repo/docs/x.json", root)).toBe("docs/x.json");
    expect(repoRelativeEvidencePath("./docs/../docs/x.json", root)).toBe("docs/x.json");
    // outside the repo there IS no portable form — refuse rather than bake in a machine path
    expect(() => repoRelativeEvidencePath("/tmp/x.json", root)).toThrow(BenchRefsRulesError);
    expect(() => repoRelativeEvidencePath("../x.json", root)).toThrow(BenchRefsRulesError);
  });

  test("repoRelativeEvidencePath refuses an in-repo SYMLINK that escapes the repo", () => {
    // a lexical resolve() is fooled by this: the path looks repo-relative while the bytes live
    // outside, so the evidence would claim portability it does not have
    const base = join(process.env["TMPDIR"] ?? "/tmp", `refs-probe-symlink-${process.pid}`);
    const repo = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "corpus.json"), "{}");
    symlinkSync(outside, join(repo, "escape"));
    expect(() => repoRelativeEvidencePath("escape/corpus.json", repo)).toThrow(BenchRefsRulesError);
    // a real in-repo file still resolves
    writeFileSync(join(repo, "real.json"), "{}");
    expect(repoRelativeEvidencePath("real.json", repo)).toBe("real.json");
    rmSync(base, { recursive: true, force: true });
  });

  // The identity preflight spends real REST-core budget before the lock, the journal header, or
  // the rate-limit baseline exist, so it can appear in none of the three artifacts. It cannot be
  // journalled after the fact: invocations that fail on a foreign identity, lose the lock race, or
  // crash still spent. The honest close is a NAMED exemption in the ADR — pinned here so the code
  // and the disclosure cannot drift apart.
  test("the ADR names the pre-lock identity call as an accepted traffic exemption", () => {
    const adr = readFileSync(join(import.meta.dir, "..", "docs", "adrs", "0002-branch-discovery-rate-limit-strategy.md"), "utf8");
    expect(adr).toContain("Accepted preflight traffic exemption");
    expect(adr).toContain("pre-lock `GET /user` REST-core attempt chain");
    // the bound it claims must be the real one the client enforces
    expect(adr).toContain(`\`MAX_ATTEMPTS\` = ${MAX_ATTEMPTS}`);
  });

  test("classifyJournalTail names what a crash left behind, without touching the file", () => {
    const good = JSON.stringify({ rowKind: "washout", version: 1, atIso: "2026-08-05T00:00:00Z", sleptMs: 1 });
    expect(classifyJournalTail("")).toBe("none");
    expect(classifyJournalTail(`${good}\n`)).toBe("none");
    // a complete record that lost only its newline — its content survived the crash
    expect(classifyJournalTail(`${good}\n${good}`)).toBe("sealable");
    // genuinely torn bytes — the write never completed
    expect(classifyJournalTail(`${good}\n{"rowKind":"was`)).toBe("malformed");
    // no newline anywhere AND malformed: truncating would empty the file, so it is refused
    expect(classifyJournalTail(`{"rowKind":"was`)).toBe("headless");
    // ...but a lone COMPLETE record that only lost its newline is still sealable. This is the
    // shape a crash right after the header write leaves, and deciding "headless" on the missing
    // newline alone would refuse that journal forever.
    expect(classifyJournalTail(good)).toBe("sealable");
  });

  // A crash mid-append leaves the journal's last line unterminated. parseJournal tolerates that
  // IN MEMORY, but the file itself still ends mid-record: the next appendFileSync writes at EOF
  // with no separator and GLUES its row onto the torn bytes, producing one permanently
  // unparseable line. Sealing/truncating on disk before the first append is what keeps the
  // append-only journal replayable — the same seal-vs-truncate split benchContentTransport.ts
  // already applies to the ADR-0001 evidence logs.
  describe("fileJournalAppender repairs a torn tail before its first append", () => {
    const tmpDir = join(process.env["TMPDIR"] ?? "/tmp", `refs-probe-journal-test-${process.pid}`);
    const row = { rowKind: "washout", version: 1, atIso: "2026-08-05T00:00:00Z", sleptMs: 7 } as const;
    const good = JSON.stringify({ rowKind: "washout", version: 1, atIso: "2026-08-05T00:00:00Z", sleptMs: 1 });
    const write = (name: string, body: string): string => {
      mkdirSync(tmpDir, { recursive: true });
      const p = join(tmpDir, name);
      writeFileSync(p, body);
      return p;
    };

    test("a complete record that lost only its newline is SEALED, never discarded", () => {
      const p = write("sealable.jsonl", `${good}\n${good}`);
      const append = fileJournalAppender(p, () => {});
      append(row as unknown as RefsProbeJournalRow);
      const text = readFileSync(p, "utf8");
      expect(text).toBe(`${good}\n${good}\n${JSON.stringify(row)}\n`);
      // the whole file replays: the crash cost nothing, and no line was glued
      expect(parseJournal(text, () => {}).length).toBe(3);
      rmSync(p, { force: true });
    });

    test("genuinely torn bytes are TRUNCATED so the next row starts its own line", () => {
      const p = write("malformed.jsonl", `${good}\n{"rowKind":"was`);
      const append = fileJournalAppender(p, () => {});
      append(row as unknown as RefsProbeJournalRow);
      const text = readFileSync(p, "utf8");
      expect(text).toBe(`${good}\n${JSON.stringify(row)}\n`);
      expect(parseJournal(text, () => {}).length).toBe(2);
      rmSync(p, { force: true });
    });

    test("repair happens once, not on every append", () => {
      const p = write("once.jsonl", `${good}\n${good}`);
      const logs: string[] = [];
      const append = fileJournalAppender(p, (l) => logs.push(l));
      append(row as unknown as RefsProbeJournalRow);
      append(row as unknown as RefsProbeJournalRow);
      expect(logs.filter((l) => l.includes("repaired")).length).toBe(1);
      expect(parseJournal(readFileSync(p, "utf8"), () => {}).length).toBe(4);
      rmSync(p, { force: true });
    });

    test("a lone complete record that lost its newline is sealed, not refused", () => {
      const p = write("lone.jsonl", good);
      const append = fileJournalAppender(p, () => {});
      append(row as unknown as RefsProbeJournalRow);
      expect(readFileSync(p, "utf8")).toBe(`${good}\n${JSON.stringify(row)}\n`);
      expect(parseJournal(readFileSync(p, "utf8"), () => {}).length).toBe(2);
      rmSync(p, { force: true });
    });

    test("a torn tail with no newline anywhere is refused, not silently emptied", () => {
      const p = write("headless.jsonl", `{"rowKind":"was`);
      const append = fileJournalAppender(p, () => {});
      expect(() => append(row as unknown as RefsProbeJournalRow)).toThrow(BenchRefsRulesError);
      // the bytes are left exactly as the crash left them for the operator to inspect
      expect(readFileSync(p, "utf8")).toBe(`{"rowKind":"was`);
      rmSync(p, { force: true });
    });
  });

  test("the probe lock is exclusive: second acquisition fails with remediation, release frees it", () => {
    const dir = join(process.env["TMPDIR"] ?? "/tmp", `refs-probe-lock-test-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, "refs-probe-journal.jsonl.lock");
    acquireProbeLock(lock);
    expect(() => acquireProbeLock(lock)).toThrow(/another/i);
    releaseProbeLock(lock);
    acquireProbeLock(lock);
    releaseProbeLock(lock);
  });
});

describe("runRefsProbe — the full matrix on a clean scripted estate", () => {
  test("pins B = 25, writes the result once at completion, journals every physical try", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus);
    const { deps, journal, results } = makeDeps(corpus, script);
    const result = await runRefsProbe(deps);

    expect(results.length).toBe(1);
    expect(result.outcome).toEqual({ kind: "default-pinned", defaultBatchSize: 25, page1PerRepo: 0.04, correctedFloor8x750: 240 });
    // a fresh journal begins with the binding header (corpus + rule fingerprints)
    expect(journal[0]!.rowKind).toBe("header");
    if (journal[0]!.rowKind === "header") {
      expect(journal[0]!.corpusSha256).toBe("test-corpus-sha");
      expect(journal[0]!.constantsFingerprint).toBe(probeConstantsFingerprint());
    }
    // every cell completed all five slots cleanly, so 30 try rows total
    const tries = tryRows(journal);
    expect(tries.length).toBe(30);
    expect(tries.every((t) => t.verdict === "clean")).toBe(true);
    // one admission row and one try-start intent per try, and the final washout row
    expect(journal.filter((r) => r.rowKind === "admission").length).toBe(30);
    expect(journal.filter((r) => r.rowKind === "try-start").length).toBe(30);
    expect(journal.filter((r) => r.rowKind === "washout").length).toBe(1);
    // per-try dispatch accounting on the B=10 p1 cell: 1 batch + 10 control pages
    const p1b10 = tries.find((t) => t.cellB === 10 && t.stratum === "p1")!;
    expect(p1b10.dispatches.length).toBe(11);
    expect(p1b10.pairRatio).toBeCloseTo(0.1, 10);
    // candidates: 10 and 25 pass; 50 informational
    expect(result.verdicts.filter((v) => v.candidate).map((v) => v.passed)).toEqual([true, true]);
    expect(result.estates).not.toBeNull();
    expect(result.cells.length).toBe(6);
    expect(result.before.graphql.remaining).toBe(4_900);
  });

  test("a p2 try prices continuations in both arms and records informational durations", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus);
    const { deps, journal } = makeDeps(corpus, script);
    await runRefsProbe(deps);
    const t = tryRows(journal).find((r) => r.cellB === 10 && r.stratum === "p2")!;
    // candidate: 1 batch + 10 continuations; control: 10 × 2 pages
    expect(t.dispatches.length).toBe(31);
    expect(t.candidate.continuationPagesObserved).toBe(10);
    expect(t.control.totalPoints).toBe(20);
    expect(t.informational.candidateFullSnapshotMs).toBeGreaterThan(0);
    expect(t.informational.wouldHaveTrippedProductionStop).toBe(false);
  });
});

describe("runRefsProbe — fault handling", () => {
  test("a 502 terminates the cell, quarantines to the reset epoch, and the run continues", async () => {
    const corpus = corpusJson();
    let fired = false;
    const script = scriptedGithub(corpus, {
      intercept: (call) => {
        if (!fired && call.label.startsWith("refs.B25.p1.s2.") && call.query.includes("r0:repository")) {
          fired = true;
          return faultOutcome({ status: 502, label: call.label, ordinal: call.ordinal });
        }
        return null;
      },
    });
    const { deps, journal, results, sleeps, events } = makeDeps(corpus, script);
    const result = await runRefsProbe(deps);
    expect(fired).toBe(true);
    const q = journal.filter((r) => r.rowKind === "quarantine");
    expect(q.length).toBe(1);
    // the quarantine slept to the reset epoch (scripted far future → a real sleep happened)
    expect(sleeps.some((ms) => ms >= 30_000)).toBe(true);
    // the obligation persists AT OBSERVATION, before even the try row: a crash anywhere
    // after the 504 — mid-try, before the try row, or mid-sleep — must resume into the
    // quarantine, never past it
    const qi = events.indexOf("append:quarantine");
    const tryAppends = events.map((e, i) => [e, i] as const).filter(([e]) => e === "append:try").map(([, i]) => i);
    const lastTryAppend = tryAppends[tryAppends.length - 1]!;
    expect(qi).toBeGreaterThanOrEqual(0);
    expect(qi).toBeLessThan(lastTryAppend); // observed-time durability: quarantine row precedes its try row
    const bigSleep = events.findIndex((e, i) => i > qi && e.startsWith("sleep:") && Number(e.slice(6)) >= 30_000);
    expect(bigSleep).toBeGreaterThan(qi);
    // the B=25 p1 cell is terminated; B=25 fails; B=10 passed alone → prefix eligible {10},
    // whose floor (6,000 × 0.1 = 600) trips the ship threshold → no-pass
    const cell = result.cells.find((c) => c.batchSize === 25 && c.stratum === "p1")!;
    expect(cell.status.kind).toBe("terminated-unclean");
    expect(result.outcome.kind).toBe("no-pass");
    expect(results.length).toBe(1); // the result still writes — committed with the cause
  });

  // A try dispatches from THREE phases — the candidate's batch page-1 loop, its continuation
  // walk, and the control arm — and a documented timeout can land in any of them. Only the first
  // site was pinned, so the quarantine contract at the other two rested on reading the code. All
  // three must behave identically: the obligation is journalled AT OBSERVATION (before the try
  // row, so a crash mid-sleep still resumes into it), the try stops dispatching immediately, the
  // verdict is terminal, and the sleep is priced from the fault's OWN reset hint — never from a
  // second /rate_limit read, which would be both a spend and a wrong (later) clock.
  describe("a documented-timeout quarantine behaves identically at every dispatch site", () => {
    const LABEL_BASE = "refs.B10.p2.s1.a1"; // cell B=10 stratum p2, slot 1, attempt 1
    // deliberately NOT the 1_900_000_000 the deps' /rate_limit snapshot reports, so a sleep
    // priced off the fallback snapshot is ~1.4e11 ms away from one priced off the hint
    const FAULT_RESET_EPOCH = 1_760_000_000;
    const CLOCK_START_MS = 1_754_000_000_000; // makeDeps' fake clock origin
    const sleepFromEpoch = (epochSec: number): number => epochSec * 1_000 + 5_000 - CLOCK_START_MS;

    const SITES = [
      // B=10 p2 is one chunk of ten 2-page repos: 1 batch call, then 10 continuations, then control
      { site: "the candidate's batch page 1", dispatchCount: 1, matches: (l: string) => l === `${LABEL_BASE}.b0` },
      { site: "the first candidate continuation", dispatchCount: 2, matches: (l: string) => l.startsWith(`${LABEL_BASE}.cont.`) },
      { site: "the first control dispatch", dispatchCount: 12, matches: (l: string) => l.startsWith(`${LABEL_BASE}.ctl.`) },
    ] as const;

    for (const { site, dispatchCount, matches } of SITES) {
      for (const status of [502, 504] as const) {
        test(`${status} at ${site}`, async () => {
          const corpus = corpusJson();
          let fired = false;
          const script = scriptedGithub(corpus, {
            intercept: (call) => {
              if (fired || !matches(call.label)) return null;
              fired = true;
              return faultOutcome({ status, label: call.label, ordinal: call.ordinal, resetEpochSec: FAULT_RESET_EPOCH });
            },
          });
          const { deps, journal, events } = makeDeps(corpus, script);
          await runRefsProbe(deps);
          expect(fired).toBe(true);

          // ---- exactly one obligation, carrying the FAULT's epoch, written before its try row ----
          const quarantines = journal.filter((r) => r.rowKind === "quarantine");
          expect(quarantines.length).toBe(1);
          expect(quarantines[0]).toMatchObject({
            cellB: 10, stratum: "p2", slot: 1, attempt: 1, untilEpochSec: FAULT_RESET_EPOCH,
          });
          const qi = events.indexOf("append:quarantine");
          expect(qi).toBeGreaterThanOrEqual(0);
          const tryAfter = events.indexOf("append:try", qi);
          expect(tryAfter).toBeGreaterThan(qi); // observed-time durability

          // ---- the try stops dispatching the instant the fault is observed ----
          expect(events.slice(qi, tryAfter).some((e) => e.startsWith("dispatch:"))).toBe(false);
          const faulted = tryRows(journal).filter((t) => t.verdict === "quarantine-unclean");
          expect(faulted.length).toBe(1);
          const row = faulted[0]!;
          expect([row.cellB, row.stratum, row.slot, row.attempt]).toEqual([10, "p2", 1, 1]);
          // the faulted call is the LAST one the try made — and the phase it landed in is pinned
          // by the count, so a fault that silently moved sites would fail here
          expect(row.dispatches.length).toBe(dispatchCount);
          expect(row.dispatches[row.dispatches.length - 1]!.status).toBe(status);
          expect(row.dispatches.filter((d) => d.status === status).length).toBe(1);

          // ---- the sleep is priced from the hint, and costs no second /rate_limit read ----
          const sleepIdx = events.findIndex((e, i) => i > tryAfter && e.startsWith("sleep:"));
          expect(sleepIdx).toBeGreaterThan(tryAfter);
          expect(events.slice(qi, sleepIdx)).not.toContain("rate-limit");
          const slept = Number(events[sleepIdx]!.slice("sleep:".length));
          expect(Math.abs(slept - sleepFromEpoch(FAULT_RESET_EPOCH))).toBeLessThan(100_000);
        });
      }
    }
  });

  test("persistent page-count drift invalidates three times and commits the cell invalid", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus, {
      // every B=10 p1 repo actually paginates (live depth 2 ≠ frozen 1) — every try drifts
      livePages: (key) => (key.includes("-p1-b10-") ? 2 : (depthDefault(corpus, key))),
    });
    const { deps, journal, results } = makeDeps(corpus, script);
    const result = await runRefsProbe(deps);
    const b10p1 = tryRows(journal).filter((t) => t.cellB === 10 && t.stratum === "p1");
    expect(b10p1.length).toBe(3); // slot 1 attempted three times, all invalidated
    expect(b10p1.every((t) => t.verdict === "invalidated")).toBe(true);
    const cell = result.cells.find((c) => c.batchSize === 10 && c.stratum === "p1")!;
    expect(cell.status.kind).toBe("invalid");
    // an invalid B=10 blocks the prefix while B=25 passes → the anomaly outcome
    expect(result.outcome.kind).toBe("anomaly");
    expect(results.length).toBe(1);
  });

  test("a candidate transient failure fails the cell early and skips the control arm", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus, {
      intercept: (call) =>
        call.label.startsWith("refs.B10.p1.s1.") && call.query.includes("r0:repository")
          ? faultOutcome({ status: 500, label: call.label, ordinal: call.ordinal })
          : null,
    });
    const { deps, journal, results } = makeDeps(corpus, script);
    const result = await runRefsProbe(deps);
    const rows = tryRows(journal).filter((t) => t.cellB === 10 && t.stratum === "p1");
    expect(rows.length).toBe(1);
    expect(rows[0]!.verdict).toBe("unclean");
    // the control arm never dispatched: the failed batch is the only dispatch
    expect(rows[0]!.dispatches.length).toBe(1);
    const cell = result.cells.find((c) => c.batchSize === 10 && c.stratum === "p1")!;
    expect(cell.status.kind).toBe("terminated-unclean");
    expect(results.length).toBe(1);
  });

  test("a thrown dispatch records a synthetic no-response row (unclean by construction)", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus);
    const throwing = async (query: string, fields: Record<string, string>, label: string): Promise<RefsDispatchOutcome> => {
      if (label.startsWith("refs.B10.p1.s1.")) throw new Error("output cap exceeded");
      return script.dispatch(query, fields, label);
    };
    const { deps, journal } = makeDeps(corpus, script, { dispatchGraphql: throwing });
    await runRefsProbe(deps);
    const row = tryRows(journal).find((t) => t.cellB === 10 && t.stratum === "p1")!;
    expect(row.verdict).toBe("unclean");
    expect(row.dispatches[0]!.status).toBe(0);
    expect(row.dispatches[0]!.dispatchFailure).toMatch(/output cap/);
  });
});

describe("runRefsProbe — admission", () => {
  test("a short window sleeps to the reset epoch before dispatching, and records it", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus);
    let reads = 0;
    const { deps, journal, sleeps } = makeDeps(corpus, script, {
      readRateLimit: async () => {
        reads++;
        const remaining = reads === 2 ? 10 : 4_900; // the first admission check hits a dry window
        return {
          core: { remaining: 5_000, reset: 1_900_000_000, used: 0 },
          graphql: { remaining, reset: 1_900_000_000, used: 5_000 - remaining },
          atMs: 0,
        };
      },
    });
    await runRefsProbe(deps);
    const admissions = journal.filter((r) => r.rowKind === "admission");
    expect(admissions.length).toBe(30);
    expect(admissions.some((a) => a.rowKind === "admission" && a.sleptMs > 0)).toBe(true);
    expect(sleeps.some((ms) => ms >= 30_000)).toBe(true);
  });

  test("an unfundable tranche is committed admission-infeasible, loudly, with the arithmetic", async () => {
    // frozen p2 depth 40 → the B=50 p2 tranche worst case exceeds the whole bucket
    const corpus = corpusJson({ p2Pages: 40 });
    const script = scriptedGithub(corpus);
    const { deps, journal, results } = makeDeps(corpus, script);
    const result = await runRefsProbe(deps);
    const infeasible = journal.filter((r) => r.rowKind === "admission-infeasible");
    expect(infeasible.length).toBeGreaterThanOrEqual(1);
    const cell = result.cells.find((c) => c.batchSize === 50 && c.stratum === "p2")!;
    expect(cell.status.kind).toBe("infeasible");
    // no dispatch ever went out for that cell
    expect(script.calls.some((c) => c.label.startsWith("refs.B50.p2."))).toBe(false);
    expect(results.length).toBe(1);
  });

  test("corpus-infeasible cells dispatch nothing and derive infeasible", async () => {
    const corpus = corpusJson({ infeasible: [[50, "p1"], [50, "p2"]] });
    const script = scriptedGithub(corpus);
    const { deps, results } = makeDeps(corpus, script);
    const result = await runRefsProbe(deps);
    expect(script.calls.some((c) => c.label.startsWith("refs.B50."))).toBe(false);
    expect(result.cells.filter((c) => c.batchSize === 50).every((c) => c.status.kind === "infeasible")).toBe(true);
    expect(results.length).toBe(1);
  });
});

describe("runRefsProbe — resume from the journal (crash-safe, no double-spend)", () => {
  test("completed cells are not re-dispatched; only the remainder runs", async () => {
    const corpus = corpusJson();
    const first = scriptedGithub(corpus);
    const run1 = makeDeps(corpus, first);
    await runRefsProbe(run1.deps);
    // replay journal rows for the two B=10 cells only — as if the run crashed after them
    const keepLines = [
      headerLine(),
      ...run1.journal.filter((r) => "cellB" in r && r.cellB === 10).map((r) => JSON.stringify(r)),
    ];
    const second = scriptedGithub(corpus);
    const run2 = makeDeps(corpus, second, { existingJournalText: `${keepLines.join("\n")}\n` });
    const result = await runRefsProbe(run2.deps);
    expect(result.resumedFromJournal).toBe(true);
    // no dispatch for the completed B=10 cells; the rest re-ran in full
    expect(second.calls.some((c) => c.label.startsWith("refs.B10."))).toBe(false);
    expect(second.calls.some((c) => c.label.startsWith("refs.B25."))).toBe(true);
    expect(tryRows(run2.journal).length).toBe(20); // 30 − the 10 replayed tries
    expect(result.outcome.kind).toBe("default-pinned");
  });

  test("a partially completed cell resumes at its next slot and attempt", async () => {
    const corpus = corpusJson();
    const first = scriptedGithub(corpus);
    const run1 = makeDeps(corpus, first);
    await runRefsProbe(run1.deps);
    const b10p1 = run1.journal.filter((r) => "cellB" in r && r.cellB === 10 && r.stratum === "p1" && r.rowKind === "try").slice(0, 2);
    const second = scriptedGithub(corpus);
    const run2 = makeDeps(corpus, second, {
      existingJournalText: `${[headerLine(), ...b10p1.map((r) => JSON.stringify(r))].join("\n")}\n`,
    });
    await runRefsProbe(run2.deps);
    const resumed = tryRows(run2.journal).filter((t) => t.cellB === 10 && t.stratum === "p1");
    expect(resumed.length).toBe(3); // slots 3..5 only
    expect(resumed.map((t) => t.slot)).toEqual([3, 4, 5]);
  });

  test("a resumed journal must open with a matching header (foreign journals refused)", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus);
    // no header at all
    const noHeader = makeDeps(corpus, script, {
      existingJournalText: `${JSON.stringify({ rowKind: "washout", version: 1, atIso: "2026-08-05T00:00:00Z", sleptMs: 1 })}\n`,
    });
    await expect(runRefsProbe(noHeader.deps)).rejects.toThrow(/header/i);
    // a header from a DIFFERENT corpus
    const foreign = JSON.parse(headerLine()) as Record<string, unknown>;
    foreign["corpusSha256"] = "someone-elses-corpus";
    const mismatch = makeDeps(corpus, script, { existingJournalText: `${JSON.stringify(foreign)}\n` });
    await expect(runRefsProbe(mismatch.deps)).rejects.toThrow(/corpus/i);
    // a header recorded under a DIFFERENT bench configuration
    const cfgDrift = JSON.parse(headerLine()) as Record<string, unknown>;
    cfgDrift["benchConfigSha256"] = "some-other-config";
    const cfgMismatch = makeDeps(corpus, script, { existingJournalText: `${JSON.stringify(cfgDrift)}\n` });
    await expect(runRefsProbe(cfgMismatch.deps)).rejects.toThrow(/config/i);
    // a LEGACY header (no config binding) still parses — the committed Stage-P journal must
    // stay readable forever — but a resume against it refuses: absence proves nothing
    const legacy = JSON.parse(headerLine()) as Record<string, unknown>;
    delete legacy["benchConfigSha256"];
    expect(parseJournal(`${JSON.stringify(legacy)}\n`, () => {}).length).toBe(1);
    const legacyResume = makeDeps(corpus, script, { existingJournalText: `${JSON.stringify(legacy)}\n` });
    await expect(runRefsProbe(legacyResume.deps)).rejects.toThrow(/config/i);
  });

  // The third of three symmetric resume bindings. Corpus and bench-config mismatches each have a
  // refusal test; this one had none, so a resume after a gate-constant edit could silently mix
  // rows evaluated under two different rule revisions into one "pre-registered" result.
  test("a journal recorded under different pre-registered constants is refused", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus);
    const drifted = JSON.parse(headerLine()) as Record<string, unknown>;
    drifted["constantsFingerprint"] = "a-different-rule-revision";
    const { deps } = makeDeps(corpus, script, { existingJournalText: `${JSON.stringify(drifted)}\n` });
    await expect(runRefsProbe(deps)).rejects.toThrow(/different pre-registered constants/i);
    // refused BEFORE any spend
    expect(script.calls.length).toBe(0);
  });

  test("a dangling try-start resumes the same slot at the next attempt (spend visible, no invalidation)", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus);
    const dangling = JSON.stringify({ rowKind: "try-start", version: 1, atIso: "2026-08-05T00:00:00Z", cellB: 10, stratum: "p1", slot: 1, attempt: 1 });
    const { deps, journal } = makeDeps(corpus, script, {
      existingJournalText: `${headerLine()}\n${dangling}\n`,
    });
    await runRefsProbe(deps);
    const b10p1 = tryRows(journal).filter((t) => t.cellB === 10 && t.stratum === "p1");
    expect(b10p1.map((t) => [t.slot, t.attempt])).toEqual([[1, 2], [2, 1], [3, 1], [4, 1], [5, 1]]);
  });

  // A quarantine row is appended BEFORE its sleep precisely so a crash mid-sleep cannot skip the
  // obligation. If that very append is what tore, the row is unparseable and gets dropped — and
  // with it the backoff. The dropped bytes are unrecoverable, so the runner cannot know what it
  // lost; it must assume the worst and back off before spending again.
  // benchGh builds an attempt record for every physical /rate_limit call so accounting can prove
  // zero unexplained traffic; the runner's base context used to discard them, so retries and
  // transient failures on that endpoint vanished. A completion-only counter would not do: the
  // result is written ONLY on success, so a chain that ends in exhaustion would leave no trace.
  test("every physical rate_limit attempt is journalled, even when the chain then fails", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus);
    const attempt = (n: number, status: number, classification: string): BenchHttpAttemptRecord => ({
      type: "http-attempt", atMs: n, wallMs: 12, kind: "rest", requestClass: "rest-meta",
      label: "rate_limit", attempt: n, status, exitCode: status === 200 ? 0 : 1, classification,
      secondarySignal: null, pointsCost: null, remaining: 4_900, resetEpochSec: 1_900_000_000,
      servedFromCache: false, bodyBytes: 10,
    });
    let call = 0;
    const { deps, journal, results } = makeDeps(corpus, script, {
      readRateLimit: async (record) => {
        call += 1;
        if (call === 1) {
          record(attempt(1, 200, "ok"));
          return {
            core: { remaining: 5_000, reset: 1_900_000_000, used: 0 },
            graphql: { remaining: 4_900, reset: 1_900_000_000, used: 100 },
            atMs: 1,
          };
        }
        // the admission read burns two physical attempts and then gives up
        record(attempt(1, 502, "transient"));
        record(attempt(2, 502, "transient"));
        throw new Error("rate_limit attempts exhausted");
      },
    });
    await expect(runRefsProbe(deps)).rejects.toThrow(/exhausted/);
    // no result on a failed run — which is exactly why a completion-only counter cannot work
    expect(results.length).toBe(0);
    const meta = journal.filter((r) => r.rowKind === "rest-meta");
    expect(meta.length).toBe(3);
    expect(meta.map((r) => (r as { attempt: number }).attempt)).toEqual([1, 1, 2]);
    expect(meta.every((r) => (r as { label: string }).label === "rate_limit")).toBe(true);
    // the baseline attempt is journalled after the header, never before it
    expect(journal[0]!.rowKind).toBe("header");
    // and the rows survive a round-trip through the parser
    const text = journal.map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(parseJournal(text, () => {}).filter((r) => r.rowKind === "rest-meta").length).toBe(3);
  });

  test("a dropped torn tail forces a conservative backoff before any dispatch", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus);
    const { deps, journal, events, sleeps } = makeDeps(corpus, script, {
      existingJournalText: `${headerLine()}\n`,
      droppedTornTailBytes: 42,
    });
    await runRefsProbe(deps);
    const recovered = journal.filter((r) => r.rowKind === "tear-recovered");
    expect(recovered.length).toBe(1);
    // the replacement must be at least what a real quarantine would have cost: sleep to the
    // graphql RESET (reset*1000 + 5s from now), not the far shorter washout floor. A floor-length
    // nap would read as conservative while still landing inside an active penalty window.
    const wait = (recovered[0] as { conservativeSleepMs: number }).conservativeSleepMs;
    expect(sleeps).toContain(wait); // the row records exactly the sleep that was taken
    // reset is far in the future relative to the fake clock, so a reset-based wait is enormous;
    // the washout floor is seconds. Pinning the ORDER OF MAGNITUDE proves which rule was used
    // without coupling to the clock's exact position when the tear was recovered.
    expect(wait).toBeGreaterThan(deps.washoutFloorMs * 1_000);
    const firstDispatch = events.findIndex((e) => e.startsWith("dispatch:"));
    const firstBigSleep = events.findIndex((e) => e.startsWith("sleep:") && Number(e.slice(6)) >= 30_000);
    expect(firstBigSleep).toBeGreaterThanOrEqual(0);
    expect(firstBigSleep).toBeLessThan(firstDispatch);
    // and the obligation is durable: the row is written before the sleep, so a second crash
    // during THIS backoff still leaves the evidence that a tear was recovered
    expect(journal.findIndex((r) => r.rowKind === "tear-recovered")).toBeLessThan(
      journal.findIndex((r) => r.rowKind === "admission"),
    );
  });

  test("a sealed (non-lossy) torn tail needs no backoff — nothing was dropped", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus);
    const { deps, journal } = makeDeps(corpus, script, {
      existingJournalText: `${headerLine()}\n`,
      droppedTornTailBytes: null,
    });
    await runRefsProbe(deps);
    expect(journal.filter((r) => r.rowKind === "tear-recovered").length).toBe(0);
  });

  test("an unexpired quarantine in the journal is honored before any resumed dispatch", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus);
    // untilEpochSec far past the fake clock start (1_754_000_000_000 ms → 1.754e9 s)
    const q = JSON.stringify({
      rowKind: "quarantine", version: 1, atIso: "2026-08-05T00:00:00Z",
      cellB: 10, stratum: "p1", slot: 1, attempt: 1, untilEpochSec: 1_754_000_600, plannedSleepMs: 600_000,
    });
    const { deps, events } = makeDeps(corpus, script, { existingJournalText: `${headerLine()}\n${q}\n` });
    await runRefsProbe(deps);
    const firstDispatch = events.findIndex((e) => e.startsWith("dispatch:"));
    const firstBigSleep = events.findIndex((e) => e.startsWith("sleep:") && Number(e.slice(6)) >= 30_000);
    expect(firstBigSleep).toBeGreaterThanOrEqual(0);
    expect(firstBigSleep).toBeLessThan(firstDispatch);
  });
});

describe("runRefsProbe — washout", () => {
  test("the run always ends with a washout of its own horizon, floored and journaled", async () => {
    const corpus = corpusJson();
    const script = scriptedGithub(corpus);
    const { deps, journal, sleeps } = makeDeps(corpus, script, {
      outstandingHorizonMs: () => 1_754_000_000_000 + 95_000, // ~95 s past the fake clock start
    });
    await runRefsProbe(deps);
    const washout = journal.find((r) => r.rowKind === "washout")!;
    expect(washout.rowKind === "washout" && washout.sleptMs >= 60_000).toBe(true);
    expect(sleeps[sleeps.length - 1]).toBeGreaterThanOrEqual(60_000);
  });
});

// helper: the default live depth for a repo key (its frozen depth from the corpus)
function depthDefault(corpus: RefsProbeCorpus, key: string): number {
  for (const cell of corpus.cells) {
    for (const r of cell.repos) {
      if (`${r.owner}/${r.name}`.toLowerCase() === key) return r.frozenPages;
    }
  }
  throw new Error(`unknown repo ${key}`);
}
