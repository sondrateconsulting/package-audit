// benchContentTransport.test.ts — CI tests for the harness entrypoint's fail-closed seams:
// the §8 freeze gate's git-state evaluation, harness-commit provenance acquisition, the
// fidelity battery's live-enumeration classification, and the pinning probe's batch atomicity.
//
// The cases target paths where a FAILED subprocess or a partially-errored response could be
// read as a valid observation, plus the resume/ledger/washout reconstruction and the
// append-only freeze invariants. The harness's output is the evidence a one-way architecture
// decision rests on, so each of these must fail closed rather than fabricate.
import { describe, expect, test } from "bun:test";
import {
  BenchOperationalError, assertFreezeGitState, classifyFidelityAbort,
  classifyFidelityEnumeration, harnessCommitFromGitResult, loginFromUserPayload, parseProbeBatch,
} from "./benchContentTransport.ts";
import { RePinRequired, UnitFailure, describeDisposal } from "./benchDrivers.ts";
import { BenchHttpError, replayRank } from "./benchGh.ts";
import { BenchSpawnError } from "./benchSpawn.ts";
import type { WorkloadEntry } from "./benchWorkload.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const gitOk = (stdout = ""): { exitCode: number; stdout: Uint8Array; stderr: Uint8Array } =>
  ({ exitCode: 0, stdout: bytes(stdout), stderr: bytes("") });
const gitFail = (code: number, stderr = "fatal: boom"): { exitCode: number; stdout: Uint8Array; stderr: Uint8Array } =>
  ({ exitCode: code, stdout: bytes(""), stderr: bytes(stderr) });

const APPEND_ONLY = ["docs/adrs/0001-benchmark/runs.jsonl", "docs/adrs/0001-benchmark/fidelity.jsonl", "data/"];

describe("assertFreezeGitState — the §8 dirty-tree leg must fail closed (F2)", () => {
  // The bug: `git status`'s exit code was unchecked, so a status-ONLY failure yielded empty
  // stdout -> dirty=[] -> "clean tree". A GLOBAL git failure was already caught, because
  // `ls-files` runs next under the same pinned env and ITS exit is checked — which is why the
  // both-fail case below is deliberately NOT the regression test.
  test("a status-only failure refuses instead of reporting a clean tree", () => {
    expect(() => assertFreezeGitState(gitFail(128), gitOk(), APPEND_ONLY))
      .toThrow(/git status --porcelain failed/);
  });
  test("the refusal carries the exit code and a bounded stderr excerpt for the operator", () => {
    let msg = "";
    try {
      assertFreezeGitState(gitFail(128, "fatal: detected dubious ownership"), gitOk(), APPEND_ONLY);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("128");
    expect(msg).toContain("dubious ownership");
  });
  test("a timed-out status (124, empty stdout) refuses — the deadline path's exact shape", () => {
    expect(() => assertFreezeGitState({ exitCode: 124, stdout: bytes(""), stderr: bytes("") }, gitOk(), APPEND_ONLY))
      .toThrow(/git status --porcelain failed/);
  });
  test("an untracked ratification.json still refuses (the pre-existing leg is preserved)", () => {
    expect(() => assertFreezeGitState(gitOk(), gitFail(1), APPEND_ONLY)).toThrow(/not TRACKED/);
  });
  test("dirty tracked files outside the append-only set refuse", () => {
    expect(() => assertFreezeGitState(gitOk(" M scripts/benchProtocol.ts\n"), gitOk(), APPEND_ONLY))
      .toThrow(/dirty tracked files/);
  });
  test("append-only outputs and a clean tree pass", () => {
    expect(() => assertFreezeGitState(gitOk(" M docs/adrs/0001-benchmark/runs.jsonl\n"), gitOk(), APPEND_ONLY)).not.toThrow();
    expect(() => assertFreezeGitState(gitOk(""), gitOk(), APPEND_ONLY)).not.toThrow();
  });
});

describe("harnessCommitFromGitResult — provenance must never be empty (F3)", () => {
  // The bug: rev-parse's result was .trim()ed with no exit check and no shape check, so a
  // failure produced "". Every row then recorded harnessCommit:"" and the resume guard's
  // `rec.harnessCommit !== currentCommit` became "" !== "" -> false, silently merging rows
  // produced by DIFFERENT harness revisions into one matrix.
  const sha1 = "a".repeat(40);
  const sha256 = "b".repeat(64);
  test("a failed rev-parse throws rather than yielding an empty commit", () => {
    expect(() => harnessCommitFromGitResult(gitFail(128))).toThrow(/rev-parse HEAD failed/);
  });
  test("exit 0 with empty stdout throws — success is not enough, the value must be usable", () => {
    expect(() => harnessCommitFromGitResult(gitOk(""))).toThrow(/not a full object id/);
  });
  test("a short, non-hex, or uppercase oid throws", () => {
    expect(() => harnessCommitFromGitResult(gitOk("a1b2c3\n"))).toThrow(/not a full object id/);
    expect(() => harnessCommitFromGitResult(gitOk("z".repeat(40)))).toThrow(/not a full object id/);
    expect(() => harnessCommitFromGitResult(gitOk("A".repeat(40)))).toThrow(/not a full object id/);
  });
  test("a full sha1 or sha256 oid is accepted and trimmed", () => {
    expect(harnessCommitFromGitResult(gitOk(`${sha1}\n`))).toBe(sha1);
    expect(harnessCommitFromGitResult(gitOk(`${sha256}\n`))).toBe(sha256);
  });
});

describe("classifyFidelityEnumeration — a git failure is never a fidelity verdict (F4)", () => {
  // The bug: the fidelity battery fed ls-tree's stdout straight to parseLsTreeZ with no exit
  // check. The deadline path returns {exitCode:124, stdout: EMPTY}; parseLsTreeZ([]) returns []
  // WITHOUT throwing, so the entry became "missing-from-live-enumeration" -> pass:false, was
  // appended to the APPEND-ONLY fidelity.jsonl, and per §4.7 disqualified the driver GLOBALLY —
  // a permanent, never-rerunnable verdict manufactured from a transient local failure.
  const limits = { maxEntries: 1000, maxRecordBytes: 4096 };
  test("a timed-out enumeration raises an operational error, not an absence verdict", () => {
    expect(() => classifyFidelityEnumeration({ exitCode: 124, stdout: bytes(""), stderr: bytes("") }, "sha1", limits))
      .toThrow(BenchOperationalError);
  });
  test("the operational error is distinguishable from a divergence and carries the exit code", () => {
    let err: unknown;
    try {
      classifyFidelityEnumeration(gitFail(128, "fatal: bad object"), "sha1", limits);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BenchOperationalError);
    const msg = (err as Error).message;
    expect(msg).toContain("128");
    // the whole point: this must NOT be reportable as a route/byte finding
    expect(msg).not.toContain("missing-from-live-enumeration");
    expect((err as BenchOperationalError).rerunnable).toBe(true);
  });
  test("a successful enumeration parses normally", () => {
    const oid = "c".repeat(40);
    const line = `100644 blob ${oid}      12\tsrc/a.ts\0`;
    const out = classifyFidelityEnumeration(gitOk(line), "sha1", limits);
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe("src/a.ts");
  });
});

describe("describeDisposal — the batch child's teardown verdict survives", () => {
  // dispose() returns the fatal condition that poisoned the child plus git's retained stderr —
  // the ByteRing exists solely to hold it — and every caller threw the whole thing away. A
  // poisoned or wedged `cat-file --batch` teardown could therefore accompany a reported success,
  // and on the double-death path the surviving message was the SECOND failure's, not the cause.
  const disposal = (over: Partial<Parameters<typeof describeDisposal>[0]> = {}) => ({
    exitCode: 128, stderrTail: new TextEncoder().encode("fatal: unable to read object\n"),
    stderrDroppedBytes: 0, protocolError: null, ...over,
  });
  test("renders the protocol fault, the exit code, and git's own stderr", () => {
    const s = describeDisposal(disposal({ protocolError: "poisoned: size-shape" }));
    expect(s).toContain("poisoned: size-shape");
    expect(s).toContain("128");
    expect(s).toContain("fatal: unable to read object");
  });
  test("a child that never settled says so rather than printing a misleading code", () => {
    expect(describeDisposal(disposal({ exitCode: null }))).toContain("never settled");
  });
  test("dropped stderr bytes are disclosed, never silently omitted", () => {
    expect(describeDisposal(disposal({ stderrDroppedBytes: 4096 }))).toContain("4096B dropped");
  });
});

describe("UnitFailure.annotateTeardown — the cause2 field it sets", () => {
  // The engine writes `failureCause = e.cause2`, not `e.message`. A previous fix annotated
  // `message` only, so the batch child's disposal diagnosis was preserved in an error nobody
  // read and still absent from runs.jsonl — the exact discard it was meant to fix.
  test("the annotation lands on cause2", () => {
    const f = new UnitFailure("batch child died twice: deadline expired");
    f.annotateTeardown("batch child teardown was also unclean: protocol fault: poisoned");
    expect(f.cause2).toContain("died twice");
    expect(f.cause2).toContain("teardown was also unclean");
    expect(f.message).toContain("teardown was also unclean"); // message stays consistent
  });
  test("httpEvidence survives annotation — the typed R1/R2 evidence is not collateral", () => {
    const ev = { code: "no-response", lastClassification: "transient", requestClass: "graphql-batch" };
    const f = new UnitFailure("breaker tripped", ev);
    f.annotateTeardown("teardown unclean");
    expect(f.httpEvidence).toEqual(ev);
    expect(f.cause2.startsWith("breaker tripped")).toBe(true);
  });
});

describe("parseProbeBatch — pinned GraphQL facts are all-or-nothing (F5)", () => {
  // The bug: probeGqlFacts retried only on WHOLE-response failure. A per-alias error inside an
  // otherwise-200 response was coerced to the positive fact {isBinary:true}, which deriveRoutes
  // freezes as primary "binary-fallback" with NO permitted alternative. At matrix time T1
  // delivers that file normally via primary -> G2 -> T1 globally ineligible, on an artifact of
  // one flaky alias. Facts must therefore commit per BATCH, only when every alias is sound.
  const entryOf = (path: string): WorkloadEntry => ({
    path, mode: "100644", blobOid: "c".repeat(40), size: 10, class: "source", read: true,
    noReadReason: null, canonicalSeamSha256: "x", rawSha256: "y", restDerefSeamSha256: null,
    checkoutSeamSha256: null, gql: null,
  });
  const entries = [entryOf("a.ts"), entryOf("b.ts")];
  const blob = (over: Record<string, unknown> = {}) => ({ __typename: "Blob", oid: "c".repeat(40), byteSize: 10, isBinary: false, isTruncated: false, text: "hi", ...over });

  test("a fully-resolved batch commits its facts", () => {
    const r = parseProbeBatch({ repository: { a0: blob(), a1: blob({ isBinary: true, text: null }) } }, entries, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.facts.get("a.ts")).toEqual({ isBinary: false, isTruncated: false, textNull: false });
    expect(r.facts.get("b.ts")).toEqual({ isBinary: true, isTruncated: false, textNull: true });
  });
  test("an alias-attributed error rejects the WHOLE batch — it never becomes isBinary", () => {
    const r = parseProbeBatch(
      { repository: { a0: blob(), a1: null } }, entries,
      [{ type: "TIMEOUT", path: ["repository", "a1"] }],
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/error/i);
  });
  test("a missing/opaque alias with NO errors[] also rejects — absence is not a measurement", () => {
    const r = parseProbeBatch({ repository: { a0: blob() } }, entries, undefined);
    expect(r.ok).toBe(false);
  });
  test("a Blob for a DIFFERENT object rejects — identity is checked, not just shape", () => {
    // the selection requests oid and byteSize precisely so this is checkable: a wrong-object
    // Blob with isBinary:true would otherwise permanently pin binary-fallback for this entry
    const wrongOid = parseProbeBatch({ repository: { a0: blob({ oid: "d".repeat(40), isBinary: true }), a1: blob() } }, entries, undefined);
    expect(wrongOid.ok).toBe(false);
    if (wrongOid.ok) throw new Error("unreachable");
    expect(wrongOid.reason).toMatch(/different object/);
    const wrongSize = parseProbeBatch({ repository: { a0: blob({ byteSize: 11 }), a1: blob() } }, entries, undefined);
    expect(wrongSize.ok).toBe(false);
    if (wrongSize.ok) throw new Error("unreachable");
    expect(wrongSize.reason).toMatch(/byteSize/);
  });
  test("a non-object repository rejects instead of fabricating facts for every entry", () => {
    const r = parseProbeBatch({ repository: null }, entries, undefined);
    expect(r.ok).toBe(false);
  });
  test("any errors[] at all rejects, even when every alias looks resolved", () => {
    const r = parseProbeBatch(
      { repository: { a0: blob(), a1: blob() } }, entries,
      [{ type: "SERVICE_UNAVAILABLE", path: ["repository"] }],
    );
    expect(r.ok).toBe(false);
  });
  test("an UNATTRIBUTABLE (malformed) error entry rejects — it must not read as no-errors", () => {
    const r = parseProbeBatch({ repository: { a0: blob(), a1: blob() } }, entries, [], 1);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/malformed/);
  });
});

describe("loginFromUserPayload — the §8 credential identity cannot degrade to a literal", () => {
  // An unvalidated cast let a malformed /user payload become the string "unknown", which then
  // hashes into the environment manifest every timed row binds to — provenance that reads as
  // real but names nobody.
  test("a usable login is returned", () => {
    expect(loginFromUserPayload({ login: "sondrateconsulting-ryan" })).toBe("sondrateconsulting-ryan");
  });
  test("a missing, empty, non-string, or non-object payload refuses", () => {
    expect(() => loginFromUserPayload({})).toThrow(/no usable login/);
    expect(() => loginFromUserPayload({ login: "" })).toThrow(/no usable login/);
    expect(() => loginFromUserPayload({ login: "   " })).toThrow(/no usable login/);
    expect(() => loginFromUserPayload({ login: 42 })).toThrow(/no usable login/);
    expect(() => loginFromUserPayload(null)).toThrow(/no object/);
    expect(() => loginFromUserPayload([{ login: "x" }])).toThrow(/no object/);
  });
});

// ---- the resume reconstruction (§4.5/§4.8) ---------------------------------------------------
import { assertAppendOnlyPrefix, classifyFidelityLog, reconstructResumeState, evidenceIsRerunnable } from "./benchContentTransport.ts";

describe("reconstructResumeState — resume must honour the frozen §4.5 discipline exactly", () => {
  const DIGEST = "f".repeat(64);
  const ENV_HASH = "abcd1234abcd1234";
  const UNIT = "C2:o/r@main";
  const KEY = `${UNIT}|T0`;
  // the frozen schedule identity the rows must match: rep = pos for these fixtures
  const SCHED = new Map(
    Array.from({ length: 9 }, (_, i) => [i + 1, { unit: UNIT, driver: "T0", rep: i + 1, probe: false }] as const),
  );
  const runRow = (over: Record<string, unknown>): string => {
    const pos = typeof over["pos"] === "number" ? (over["pos"] as number) : 1;
    return JSON.stringify({
      type: "run", schemaVersion: 1, phase: "matrix", pos, unit: UNIT, driver: "T0", rep: pos,
      probe: false, epilogue: false, outcome: "complete", failureEvidence: null, requests: {},
      acquisitionForm: null, replayKind: null, washoutAppliedMs: 60_000,
      harnessCommit: "c".repeat(40), frozenSurfaceDigest: DIGEST, envManifestHash: ENV_HASH,
      ...over,
    });
  };
  const marker = (pos: number): string => JSON.stringify({ type: "washout-done", phase: "matrix", pos });
  const state = (lines: string[]) => reconstructResumeState(lines, DIGEST, ENV_HASH, SCHED);
  const R1_EVIDENCE = { kind: "http", code: "no-response", lastClassification: "no-response", requestClass: "rest-content" };
  const R2_EVIDENCE = { kind: "http", code: "attempts-exhausted", lastClassification: "transient", requestClass: "rest-content" };

  test("a washed-out R1-rerunnable failure is OWED its replay, never terminal", () => {
    // The defect: the failed row's washout marker landed, then the process died anywhere inside
    // the (minutes-long) replay run. The old resume terminalized the pos and silently forfeited
    // the mandated in-slot replay — the recorded failure stood, G3 failed, and a transient
    // interrupt became a permanent driver disqualification (instance #7 of the class).
    const s = state([runRow({ pos: 5, outcome: "unit-failure", failureEvidence: R1_EVIDENCE }), marker(5)]);
    expect(s.terminalPos.has(5)).toBe(false);
    expect(s.owedReplays.get(5)).toBe(KEY);
    expect(s.owedWashout).toBeNull();
  });
  test("R2 is evaluated against the ledger AS OF the failure — later completions never authorize", () => {
    const failure = runRow({ pos: 5, outcome: "unit-failure", failureEvidence: R2_EVIDENCE });
    const completedBefore = runRow({ pos: 3, outcome: "complete", requests: { "rest-content": 3 }, okRequestClasses: ["rest-content"] });
    const completedAfter = runRow({ pos: 7, outcome: "complete", requests: { "rest-content": 3 }, okRequestClasses: ["rest-content"] });
    const owed = state([completedBefore, marker(3), failure, marker(5)]);
    expect(owed.owedReplays.get(5)).toBe(KEY);
    // the same completion recorded AFTER the failure must not retroactively grant the replay —
    // §4.5's "evaluated at failure time" is order-stable, and the live loop decided "no rerun"
    const notOwed = state([failure, marker(5), completedAfter, marker(7)]);
    expect(notOwed.owedReplays.size).toBe(0);
    expect(notOwed.terminalPos.has(5)).toBe(true);
  });
  test("a spent allowance is never re-granted: the landed replay row settles the pos", () => {
    const s = state([
      runRow({ pos: 5, outcome: "unit-failure", failureEvidence: R1_EVIDENCE }), marker(5),
      runRow({ pos: 5, outcome: "complete", replayKind: "r1r2", requests: { "rest-content": 2 }, okRequestClasses: ["rest-content"] }), marker(5),
    ]);
    expect(s.terminalPos.has(5)).toBe(true);
    expect(s.owedReplays.size).toBe(0);
    expect(s.rerunUsed.has(KEY)).toBe(true);
  });
  test("an interrupted washout is OWED as idle time — the measured attempt is never re-run", () => {
    // The earlier design re-ran any row whose marker was missing, which duplicated a completed
    // measurement, consumed live budget for an owed IDLE period, and (because the re-run added
    // one row and one marker) left the marker count permanently one behind the row count — the
    // position could never terminalize across any number of resumes.
    const s = state([
      runRow({ pos: 5, outcome: "unit-failure", failureEvidence: R1_EVIDENCE }), marker(5),
      runRow({ pos: 5, outcome: "complete", replayKind: "r1r2", requests: { "rest-content": 2 }, okRequestClasses: ["rest-content"], washoutAppliedMs: 90_000 }),
    ]);
    expect(s.owedWashout).toEqual({ pos: 5, ms: 90_000 }); // the caller sleeps this, then appends the marker
    expect(s.terminalPos.has(5)).toBe(true); // the replay STANDS — it measured; only its washout is owed
    expect(s.owedReplays.size).toBe(0);
    expect(s.rerunUsed.has(KEY)).toBe(true);
  });
  test("only the FINAL event may be unmarked — an interior unmarked row refuses as a violated invariant", () => {
    expect(() => state([
      runRow({ pos: 4, outcome: "complete" }), // no marker
      runRow({ pos: 5, outcome: "complete" }), marker(5),
    ])).toThrow(/row\/marker invariant/);
  });
  test("a stray or mismatched washout marker refuses — the live engine cannot have written it", () => {
    expect(() => state([marker(3)])).toThrow(/row\/marker invariant/);
    expect(() => state([runRow({ pos: 4, outcome: "complete" }), marker(6)])).toThrow(/row\/marker invariant/);
  });
  test("rows are validated against the FROZEN schedule — wrong identity or unknown pos refuses", () => {
    expect(() => state([runRow({ pos: 99 })])).toThrow(/schedule does not contain/);
    expect(() => state([runRow({ pos: 2, driver: "T1" })])).toThrow(/does not match the frozen schedule/);
    expect(() => state([runRow({ pos: 2, rep: 1 })])).toThrow(/does not match the frozen schedule/);
    expect(() => state([runRow({ pos: 2, outcome: "made-up-outcome" })])).toThrow(/unknown outcome/);
  });
  test("two recorded R4 straddles on one unit refuse — the live traversal already halted for freeze repair", () => {
    expect(() => state([
      runRow({ pos: 2, outcome: "invalidated-straddle" }), marker(2),
      runRow({ pos: 2, outcome: "invalidated-straddle" }), marker(2),
    ])).toThrow(/R4 straddles/);
  });
  test("{kind:'unit'} evidence is never owed a replay — the frozen predicate accepts only http shapes", () => {
    const s = state([runRow({ pos: 5, outcome: "unit-failure", failureEvidence: { kind: "unit" } }), marker(5)]);
    expect(s.terminalPos.has(5)).toBe(true);
    expect(s.owedReplays.size).toBe(0);
  });
  test("a corrupted evidence line REFUSES resume — a skipped line could hide a terminal halt row", () => {
    expect(() => state([runRow({ pos: 1 }), "{not json"])).toThrow(/corrupted/);
  });
  test("halt-r5/re-pin rows, foreign surfaces, and foreign environments all refuse", () => {
    expect(() => state([runRow({ pos: 1, outcome: "halt-r5-breach" })])).toThrow(/freeze-repair/);
    expect(() => state([runRow({ pos: 1, outcome: "re-pin-required" })])).toThrow(/freeze-repair/);
    expect(() => reconstructResumeState([runRow({ pos: 1 })], "0".repeat(64), ENV_HASH, SCHED)).toThrow(/changed measurement surface/);
    expect(() => reconstructResumeState([runRow({ pos: 1 })], DIGEST, "other-env", SCHED)).toThrow(/REFUSING to resume/);
  });
  test("a class that only ever FAILED inside a completed rep never authorizes R2", () => {
    // `requests` counts attempts; §4.5 R2 needs SUCCESS — a completed run whose batches all
    // drained to fallback carries graphql-batch attempts with zero successes
    const completed = runRow({ pos: 3, outcome: "complete", requests: { "graphql-batch": 6, "rest-fallback": 4 }, okRequestClasses: ["rest-fallback"] });
    const failure = runRow({ pos: 5, outcome: "unit-failure", failureEvidence: { kind: "http", code: "attempts-exhausted", lastClassification: "transient", requestClass: "graphql-batch" } });
    const s = state([completed, marker(3), failure, marker(5)]);
    expect(s.owedReplays.size).toBe(0); // graphql-batch never SUCCEEDED — no R2
    expect(s.terminalPos.has(5)).toBe(true);
  });
  test("a completed rep implies rest-meta success — a pre-run rate_limit exhaustion stays R2-rerunnable", () => {
    // rest-meta is control-plane and excluded from `requests`, so the only ledger that can
    // authorize an R2 replay never saw it succeed — even though every completed run's
    // accounting read rate_limit before and after by construction
    const completed = runRow({ pos: 3, outcome: "complete", requests: { "rest-content": 3 }, okRequestClasses: ["rest-content"] });
    const metaFailure = runRow({ pos: 5, outcome: "unit-failure", failureEvidence: { kind: "http", code: "attempts-exhausted", lastClassification: "transient", requestClass: "rest-meta" } });
    const s = state([completed, marker(3), metaFailure, marker(5)]);
    expect(s.successLedger.has(`${KEY}|rest-meta`)).toBe(true);
    expect(s.owedReplays.get(5)).toBe(KEY);
  });
  test("the binding is the frozen-surface DIGEST, never the commit — an evidence-only commit must not orphan rows", () => {
    // rows carry a different harnessCommit (HEAD moved when the evidence log was committed)
    // but the SAME digest — the frozen surface is unchanged and resume must accept them
    const s = state([runRow({ pos: 1, harnessCommit: "d".repeat(40), requests: { "rest-content": 1 }, okRequestClasses: ["rest-content"] }), marker(1)]);
    expect(s.terminalPos.has(1)).toBe(true);
  });
  test("an R3/R4-invalidated last row owes its IN-SLOT replay with r3r4 bookkeeping", () => {
    // a resumed re-execution previously ran unmarked, losing §4.5's physical-predecessor record
    const s = state([runRow({ pos: 3, outcome: "invalidated-foreign" }), marker(3)]);
    expect(s.owedInSlotReplays.has(3)).toBe(true);
    expect(s.terminalPos.has(3)).toBe(false);
    const straddle = state([runRow({ pos: 3, outcome: "invalidated-straddle" }), marker(3)]);
    expect(straddle.owedInSlotReplays.has(3)).toBe(true);
    expect(straddle.straddled.has(UNIT)).toBe(true);
  });
  test("a second invalidated-finalisation at one pos refuses — persistent accounting failure is not a silent retry loop", () => {
    expect(() => state([
      runRow({ pos: 4, outcome: "invalidated-finalisation" }), marker(4),
      runRow({ pos: 4, outcome: "invalidated-finalisation" }), marker(4),
    ])).toThrow(/failing persistently/);
    // one is fine: re-run (unmarked as any §4.5 category — the accounting simply never landed)
    const one = state([runRow({ pos: 4, outcome: "invalidated-finalisation" }), marker(4)]);
    expect(one.terminalPos.has(4)).toBe(false);
    expect(one.owedInSlotReplays.has(4)).toBe(false);
  });
  test("an epilogue R1/R2 failure of a DRIFTED unit is still owed its replay", () => {
    const s = state([
      runRow({ pos: 1, outcome: "drift-restart", acquisitionForm: "production" }), marker(1),
      runRow({ pos: 2, outcome: "unit-failure", epilogue: true, acquisitionForm: "scaffolding", failureEvidence: R1_EVIDENCE }), marker(2),
    ]);
    expect(s.owedReplays.get(2)).toBe(KEY);
    expect(s.terminalPos.has(2)).toBe(false);
  });
  test("drift bookkeeping: main rows of a drifted unit never terminalize; its form is scaffolding", () => {
    const s = state([
      runRow({ pos: 1, outcome: "complete", acquisitionForm: "production", requests: { "rest-content": 1 }, okRequestClasses: ["rest-content"] }), marker(1),
      runRow({ pos: 2, outcome: "drift-restart", acquisitionForm: "production" }), marker(2),
    ]);
    expect(s.driftedUnits.has(UNIT)).toBe(true);
    expect(s.terminalPos.has(1)).toBe(false); // discarded reps — the epilogue re-runs the whole unit
    expect(s.resumeForms.get(UNIT)).toBe("scaffolding");
    expect(s.successLedger.has(`${KEY}|rest-content`)).toBe(false); // discarded reps are not evidence
    expect(s.owedReplays.size).toBe(0);
  });
});

describe("classifyFidelityLog — the battery's own append-only discipline (§4.2)", () => {
  const DIGEST = "d".repeat(64);
  const row = (over: Record<string, unknown>): string =>
    JSON.stringify({ type: "fidelity", frozenSurfaceDigest: DIGEST, fixture: "clone-symlink", driver: "T2c", entry: "a/b.sh", pass: true, ...over });
  test("passes are skippable, failures are recorded, aborts are counted — at THIS surface only", () => {
    const s = classifyFidelityLog([
      row({}),
      row({ driver: "T2a", pass: false }),
      JSON.stringify({ type: "fidelity-operational-abort", frozenSurfaceDigest: DIGEST, fixture: "clone-symlink", driver: "T1" }),
      row({ frozenSurfaceDigest: "e".repeat(64), driver: "T0", pass: false }), // another surface — ignored
    ], DIGEST);
    expect(s.passed.has("clone-symlink|T2c|a/b.sh")).toBe(true);
    expect(s.failed.has("clone-symlink|T2a|a/b.sh")).toBe(true);
    expect(s.failed.has("clone-symlink|T0|a/b.sh")).toBe(false);
    expect(s.operationalAborts.get("clone-symlink|T1")).toBe(1);
  });
  test("a corrupted line refuses — evidence logs are never silently skimmed", () => {
    expect(() => classifyFidelityLog(["{nope"], DIGEST)).toThrow(/corrupted/);
  });
  test("driver-failure rows are durable and distinct from rerunnable aborts", () => {
    // §4.5: store corruption / coherence / fatal HTTP are DRIVER failures, no rerun — recording
    // them as rerunnable aborts would let re-invocations launder them into a pass
    const s = classifyFidelityLog([
      JSON.stringify({ type: "fidelity-driver-failure", frozenSurfaceDigest: DIGEST, fixture: "clone-symlink", driver: "T2c", reason: "object-store corruption" }),
    ], DIGEST);
    expect(s.driverFailures.has("clone-symlink|T2c")).toBe(true);
    expect(s.operationalAborts.size).toBe(0);
  });
});

describe("evidenceIsRerunnable — the frozen R1/R2 predicate over typed evidence", () => {
  test("R1: no-response is rerunnable with no ledger; R2 needs a transient shape AND a ledger hit", () => {
    expect(evidenceIsRerunnable({ kind: "http", code: "no-response", lastClassification: null, requestClass: null }, "u|T0", new Set())).toBe(true);
    const r2 = { kind: "http", code: "http-failure", lastClassification: "transient", requestClass: "rest-content" };
    expect(evidenceIsRerunnable(r2, "u|T0", new Set())).toBe(false);
    expect(evidenceIsRerunnable(r2, "u|T0", new Set(["u|T0|rest-content"]))).toBe(true);
  });
  test("everything else refuses: unit kind, null, secondary-shaped, unknown codes", () => {
    expect(evidenceIsRerunnable({ kind: "unit" }, "u|T0", new Set())).toBe(false);
    expect(evidenceIsRerunnable(null, "u|T0", new Set())).toBe(false);
    expect(evidenceIsRerunnable({ kind: "http", code: "attempts-exhausted", lastClassification: "secondary", requestClass: "rest-content" }, "u|T0", new Set(["u|T0|rest-content"]))).toBe(false);
    expect(evidenceIsRerunnable({ kind: "http", code: "truncated-transfer", lastClassification: "truncated", requestClass: "rest-content" }, "u|T0", new Set(["u|T0|rest-content"]))).toBe(false);
  });
});

describe("replayRank — the T1 breaker's streak rule (santa-2 R2/R3)", () => {
  // The breaker throw carried only the LAST dispatch's evidence, so a streak of
  // {RATE_LIMITED, closed default, status 0} surfaced as bare "no-response" and bought an
  // unconditional R1 replay. R2 made it sticky — but as a BOOLEAN, which conflated the two
  // admitted shapes: {transient, transient, status 0} still surfaced as R1 and escaped the
  // ledger gate both transient members required. The rank orders them so the streak can carry
  // its WEAKEST member.
  test("R1 (no-response) outranks R2 (transient) — they are admitted but NOT interchangeable", () => {
    expect(replayRank("no-response")).toBe(2);
    expect(replayRank("transient")).toBe(1);
    expect(replayRank("no-response") > replayRank("transient")).toBe(true);
  });
  test("a null-evidence dispatch (throttle, batch-timeout, closed default) ranks 0 — poison", () => {
    expect(replayRank(null)).toBe(0);
    expect(replayRank(undefined)).toBe(0);
  });
  test("non-null but never-replayable shapes rank 0 too — a later transient must not relabel them", () => {
    for (const cls of ["secondary", "primary", "non-json", "truncated", "fatal", "malformed-body", "unaccepted-2xx"])
      expect(replayRank(cls)).toBe(0);
  });
  test("a REST chain's weakest attempt governs too — the same rule, the other call site", () => {
    // {429 secondary, status 0, status 0} threw bare no-response and bought an unconditional R1
    // replay; the SAME attempts ending on the 429 were correctly refused. Order alone decided it.
    const weakest = (chain: readonly string[]): number => Math.min(...chain.map(replayRank));
    expect(weakest(["secondary", "no-response", "no-response"])).toBe(0);
    expect(weakest(["transient", "no-response"])).toBe(1);
    expect(weakest(["no-response", "no-response"])).toBe(2);
  });
  test("the weakest member of a mixed streak is the one that governs", () => {
    // the exact streaks the last two rounds found: the first must carry NO evidence, the second
    // must carry transient (ledger-gated), NOT the final dispatch's unconditional no-response
    const weakest = (streak: readonly (string | null)[]): number => Math.min(...streak.map(replayRank));
    expect(weakest(["secondary", null, "no-response"])).toBe(0);
    expect(weakest(["transient", "transient", "no-response"])).toBe(1);
    expect(weakest(["no-response", "no-response", "no-response"])).toBe(2);
  });
  test("it stays in lockstep with evidenceIsRerunnable over synthetic run-record evidence pairs", () => {
    // NB evidenceIsRerunnable keys R1 on the CODE and R2 on the lastClassification. runT1 moves
    // the two together (status 0 sets BOTH to "no-response"), so the streak rule can key on the
    // classification alone — but the pairing is the thing under test, not the classification in
    // isolation.
    const ledger = new Set(["u|T1|graphql-batch"]);
    const ev = (code: string, cls: string): Record<string, unknown> =>
      ({ kind: "http", code, lastClassification: cls, requestClass: "graphql-batch" });
    expect(evidenceIsRerunnable(ev("no-response", "no-response"), "u|T1", ledger)).toBe(true);
    expect(evidenceIsRerunnable(ev("http-failure", "transient"), "u|T1", ledger)).toBe(true);
    for (const cls of ["secondary", "primary", "non-json", "truncated"])
      expect(evidenceIsRerunnable(ev("http-failure", cls), "u|T1", ledger)).toBe(false);
    // and every shape the streak rule calls poison is one the predicate also refuses
    for (const cls of ["secondary", "primary", "non-json", "truncated", "fatal"])
      expect(replayRank(cls) > 0 || evidenceIsRerunnable(ev("http-failure", cls), "u|T1", ledger)).toBe(false);
  });
});

describe("assertFreezeGitState — append-only exemptions are exact, and renames always refuse", () => {
  const gitOk2 = (stdout = ""): { exitCode: number; stdout: Uint8Array; stderr: Uint8Array } =>
    ({ exitCode: 0, stdout: new TextEncoder().encode(stdout), stderr: new TextEncoder().encode("") });
  test("a stray sibling of an exempt file refuses — prefix matching let runs.jsonl.bak through", () => {
    expect(() => assertFreezeGitState(gitOk2("?? docs/adrs/0001-benchmark/runs.jsonl.bak\n"), gitOk2(), APPEND_ONLY))
      .toThrow(/dirty tracked files/);
  });
  test("a staged RENAME of an evidence log refuses — its porcelain payload starts with the exempt path", () => {
    expect(() => assertFreezeGitState(gitOk2("R  docs/adrs/0001-benchmark/runs.jsonl -> README.md\n"), gitOk2(), APPEND_ONLY))
      .toThrow(/dirty tracked files/);
  });
  test("directory exemptions still match by prefix; exact files still pass", () => {
    expect(() => assertFreezeGitState(gitOk2("?? data/bench-run-caches/x.sqlite\n M docs/adrs/0001-benchmark/fidelity.jsonl\n"), gitOk2(), APPEND_ONLY)).not.toThrow();
  });
});

describe("assertAppendOnlyPrefix — the exemption's append-only CLAIM is verified, not assumed", () => {
  const b = (s: string): Uint8Array => new TextEncoder().encode(s);
  test("appending passes; identity passes", () => {
    expect(() => assertAppendOnlyPrefix("runs.jsonl", b("a\nb\n"), b("a\nb\nc\n"))).not.toThrow();
    expect(() => assertAppendOnlyPrefix("runs.jsonl", b("a\nb\n"), b("a\nb\n"))).not.toThrow();
  });
  test("truncation refuses — deleting prior evidence is not appending", () => {
    expect(() => assertAppendOnlyPrefix("runs.jsonl", b("a\nb\n"), b("a\n"))).toThrow(/truncated or rewritten/);
  });
  test("an edited byte refuses — rewriting prior evidence is not appending", () => {
    expect(() => assertAppendOnlyPrefix("runs.jsonl", b("a\nb\n"), b("a\nX\nc\n"))).toThrow(/edited, not appended/);
  });
});

describe("classifyFidelityAbort — fail-closed §4.2 abort taxonomy (continuation loop R1)", () => {
  // The bug: the marker construction enumerated the harness's typed error classes and mapped
  // everything else to NO marker at all — an untyped throw (e.g. a launch failure surfacing
  // straight from the runtime) aborted the battery invisibly, so re-invocations were never
  // countable against the ≤1 rerun allowance.
  test("operational classes and R1-shaped no-response failures are operational aborts", () => {
    expect(classifyFidelityAbort(new BenchOperationalError("teardown was not clean"))).toBe("operational-abort");
    expect(classifyFidelityAbort(new BenchHttpError("no-response", "curl-level failure", 0))).toBe("operational-abort");
  });
  test("typed driver classes are durable driver failures", () => {
    expect(classifyFidelityAbort(new UnitFailure("object-store corruption"))).toBe("driver-failure");
    expect(classifyFidelityAbort(new BenchSpawnError("wall-deadline", "child overran the deadline"))).toBe("driver-failure");
    expect(classifyFidelityAbort(new BenchHttpError("attempts-exhausted", "HTTP 500 exhausted the cap", 500))).toBe("driver-failure");
  });
  test("an UNKNOWN error shape is a counted operational abort, never invisible", () => {
    expect(classifyFidelityAbort(new Error("launch ENOENT surfaced untyped"))).toBe("operational-abort");
    expect(classifyFidelityAbort(new TypeError("undefined is not a function"))).toBe("operational-abort");
    expect(classifyFidelityAbort("string throw")).toBe("operational-abort");
  });
  test("a re-pin condition is neither an abort nor a driver failure — no marker, digest-gated", () => {
    expect(classifyFidelityAbort(new RePinRequired("fixture commit gone")))
      .toBe("re-pin-required");
  });
});

// ---- the 2026-08-02 decision batch -----------------------------------------------------------
import {
  orderEpilogueRows, readObjectWithOneRespawn, reclaimBenchRoot, type FidelityRespawnState,
} from "./benchContentTransport.ts";
import { classifyGitTransportFailure } from "./benchDrivers.ts";
import type { BatchChildDisposal } from "./benchSpawn.ts";
import type { BatchFrame } from "./benchFrame.ts";
import type { ScheduleRow, ScheduleUnit } from "./benchSchedule.ts";

describe("classifyGitTransportFailure — §4.5's typed git-transport variant is strictly scoped", () => {
  // The gap: a settled network-shaped clone/fetch/probe failure carried NO typed evidence, so
  // {kind:"unit"} permanently disqualified the driver for a condition §4.5's R1 prose already
  // named rerunnable (DNS/TLS/connect/reset). The classifier types EXACTLY that subset and
  // fails closed on everything else — an over-wide match would let an auth or secondary-limit
  // condition become replayable, the inverse defect.
  const settled = (exitCode: number, stderr: string, timedOut = false) =>
    ({ exitCode, timedOut, stderr: bytes(stderr) });
  test("the harness's synthetic deadline shape (124 + timedOut) is timeout evidence", () => {
    expect(classifyGitTransportFailure("clone", settled(124, "", true)))
      .toEqual({ op: "clone", exitCode: 124, networkClass: "timeout" });
  });
  test("exit 124 WITHOUT the timedOut flag is not evidence — only the synthetic shape counts", () => {
    expect(classifyGitTransportFailure("clone", settled(124, "anything"))).toBeNull();
  });
  test("exit 128 with a DNS failure classifies as dns for every network-facing op", () => {
    const stderr = "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com";
    for (const op of ["clone", "scaffold-fetch", "ls-remote-probe"] as const) {
      expect(classifyGitTransportFailure(op, settled(128, stderr))).toEqual({ op, exitCode: 128, networkClass: "dns" });
    }
  });
  test("TLS and connect failures classify to their groups, case-insensitively", () => {
    expect(classifyGitTransportFailure("clone", settled(128, "fatal: unable to access 'https://x/': gnutls_handshake() failed: terminated")))
      .toEqual({ op: "clone", exitCode: 128, networkClass: "tls" });
    expect(classifyGitTransportFailure("clone", settled(128, "fatal: unable to access 'https://x/': FAILED TO CONNECT to github.com port 443: Connection refused")))
      .toEqual({ op: "clone", exitCode: 128, networkClass: "connect" });
  });
  test("a mid-transfer reset classifies as reset — curl-numbered RPC failures carry no status", () => {
    const stderr = "error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: early EOF";
    expect(classifyGitTransportFailure("clone", settled(128, stderr))?.networkClass).toBe("reset");
  });
  test("an HTTP-status-bearing failure is excluded FIRST, even beside a network-class detail", () => {
    // a secondary-limit 403 over the git transport prints exactly this shape — §4.5 forbids it
    // from ever becoming replayable, so the status guard outranks every positive pattern
    expect(classifyGitTransportFailure("clone", settled(128, "fatal: unable to access 'https://x/': The requested URL returned error: 403"))).toBeNull();
    expect(classifyGitTransportFailure("clone", settled(128, "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502\nfatal: early EOF"))).toBeNull();
    // older git's status shape carries no "requested URL" text — the second frozen needle
    expect(classifyGitTransportFailure("clone", settled(128, "error: RPC failed; result=22, HTTP code = 502\nfatal: early EOF"))).toBeNull();
  });
  test("the status guard outranks the deadline arm too: a timed-out child with a status line is NOT timeout evidence", () => {
    // a slow-walled 403/5xx that stalls past the spawn deadline settles as the synthetic 124
    // with its status line retained in stderr — the status is the governing shape, and typing
    // it as timeout would launder a secondary/budget condition into an R1 replay
    expect(classifyGitTransportFailure("clone", settled(124, "fatal: unable to access 'https://x/': The requested URL returned error: 403", true))).toBeNull();
    expect(classifyGitTransportFailure("scaffold-fetch", settled(124, "error: RPC failed; result=22, HTTP code = 429", true))).toBeNull();
  });
  test("an HTTP/2 protocol breakage carries no status and stays in the admitted reset class", () => {
    // "RPC failed; HTTP/2 stream …" must NOT be swallowed by the status guard — it is a
    // mid-transfer network breakage, exactly the condition §4.5's reset class admits
    const stderr = "error: RPC failed; HTTP/2 stream 0 was not closed cleanly: CANCEL (err 8)\nfatal: early EOF";
    expect(classifyGitTransportFailure("clone", settled(128, stderr))).toEqual({ op: "clone", exitCode: 128, networkClass: "reset" });
  });
  test("unrecognised stderr and non-124/128 exits fail closed to null", () => {
    expect(classifyGitTransportFailure("clone", settled(128, "fatal: repository 'https://x/' not found"))).toBeNull();
    expect(classifyGitTransportFailure("clone", settled(128, "fatal: Authentication failed for 'https://x/'"))).toBeNull();
    expect(classifyGitTransportFailure("clone", settled(1, "Could not resolve host: github.com"))).toBeNull();
    expect(classifyGitTransportFailure("clone", settled(0, ""))).toBeNull();
  });
});

describe("evidenceIsRerunnable — the git-transport kind is R1, validated fail-closed", () => {
  const ledger = new Set<string>(); // R1 is unconditional: the empty ledger must not matter
  test("every mintable (op × networkClass × exitCode) shape is rerunnable with no prior evidence", () => {
    // the classifier mints EXACTLY these pairings: timeout only as the synthetic 124, the
    // stderr-classified shapes only as 128 — the predicate honours the same pairing
    for (const op of ["clone", "scaffold-fetch", "ls-remote-probe"]) {
      expect(evidenceIsRerunnable({ kind: "git-transport", op, exitCode: 124, networkClass: "timeout" }, "u|T2a", ledger)).toBe(true);
      for (const networkClass of ["dns", "tls", "connect", "reset"]) {
        expect(evidenceIsRerunnable({ kind: "git-transport", op, exitCode: 128, networkClass }, "u|T2a", ledger)).toBe(true);
      }
    }
  });
  test("values outside the frozen vocabularies are refused — resume re-decides from persisted rows", () => {
    expect(evidenceIsRerunnable({ kind: "git-transport", op: "rev-parse", exitCode: 128, networkClass: "dns" }, "u|T2a", ledger)).toBe(false);
    expect(evidenceIsRerunnable({ kind: "git-transport", op: "clone", exitCode: 128, networkClass: "secondary" }, "u|T2a", ledger)).toBe(false);
    expect(evidenceIsRerunnable({ kind: "git-transport" }, "u|T2a", ledger)).toBe(false);
  });
  test("a mismatched (class, exit) pairing is refused — the classifier can never mint it", () => {
    expect(evidenceIsRerunnable({ kind: "git-transport", op: "clone", exitCode: 128, networkClass: "timeout" }, "u|T2a", ledger)).toBe(false);
    expect(evidenceIsRerunnable({ kind: "git-transport", op: "clone", exitCode: 124, networkClass: "dns" }, "u|T2a", ledger)).toBe(false);
    expect(evidenceIsRerunnable({ kind: "git-transport", op: "clone", exitCode: 0, networkClass: "reset" }, "u|T2a", ledger)).toBe(false);
    expect(evidenceIsRerunnable({ kind: "git-transport", op: "clone", networkClass: "reset" }, "u|T2a", ledger)).toBe(false);
  });
  test("a persisted git-transport unit-failure row reconstructs as an OWED replay, not terminal", () => {
    // the row-level proof that the amendment reaches resume: before it, this row's evidence was
    // {kind:"unit"} and the pos terminalized — a transient network failure became a permanent
    // driver disqualification across an interrupt
    const DIGEST = "f".repeat(64);
    const ENV_HASH = "abcd1234abcd1234";
    const UNIT = "C2:o/r@main";
    const sched = new Map([[5, { unit: UNIT, driver: "T2a", rep: 5, probe: false }]]);
    const row = JSON.stringify({
      type: "run", schemaVersion: 1, phase: "matrix", pos: 5, unit: UNIT, driver: "T2a", rep: 5,
      probe: false, epilogue: false, outcome: "unit-failure",
      failureEvidence: { kind: "git-transport", op: "clone", exitCode: 124, networkClass: "timeout" },
      requests: {}, acquisitionForm: "production", replayKind: null, washoutAppliedMs: 60_000,
      harnessCommit: "c".repeat(40), frozenSurfaceDigest: DIGEST, envManifestHash: ENV_HASH,
    });
    const marker = JSON.stringify({ type: "washout-done", phase: "matrix", pos: 5 });
    const s = reconstructResumeState([row, marker], DIGEST, ENV_HASH, sched);
    expect(s.terminalPos.has(5)).toBe(false);
    expect(s.owedReplays.get(5)).toBe(`${UNIT}|T2a`);
  });
});

describe("orderEpilogueRows — the R6 epilogue preserves §4.5's repository interleaving", () => {
  // The defect (recorded confirmedButNotFixed in the santa-loop entry, ratified for fix
  // 2026-08-02): filtering the frozen schedule to drifted units removes the separating units,
  // so two same-repository C1 siblings become adjacent — the exact warmth channel the
  // interleaving rule exists to close.
  const U = (unitId: string, repoKey: string): ScheduleUnit => ({ unitId, repoKey, slot: unitId.split(":")[0]! });
  const R = (pos: number, unit: string, probe = false): ScheduleRow => ({ pos, unit, driver: "T0", rep: probe ? 2 : 1, probe });
  const C1A = U("C1:prom/prom@main", "prom/prom");
  const C1B = U("C1:prom/prom@rel", "prom/prom");
  const C5 = U("C5:pwsh/pwsh@master", "pwsh/pwsh");
  const UNITS = [C1A, C1B, C5];
  test("a different-repository drifted unit is placed BETWEEN same-repository siblings", () => {
    // frozen order here is C1A(1,2), C1B(5,6), C5(7,8): the raw filter would run the two
    // prom/prom blocks back to back; the interleaved order separates them with the pwsh block
    const rows = [R(1, C1A.unitId), R(2, C1A.unitId), R(5, C1B.unitId), R(6, C1B.unitId), R(7, C5.unitId), R(8, C5.unitId)];
    expect(orderEpilogueRows(rows, UNITS).map((r) => r.pos)).toEqual([1, 2, 7, 8, 5, 6]);
  });
  test("probe rows run after ALL main-rep rows, in the same interleaved unit order", () => {
    const rows = [
      R(1, C1A.unitId), R(2, C1A.unitId), R(5, C1B.unitId), R(6, C1B.unitId), R(7, C5.unitId), R(8, C5.unitId),
      R(9, C1A.unitId, true), R(10, C1B.unitId, true), R(11, C5.unitId, true),
    ];
    expect(orderEpilogueRows(rows, UNITS).map((r) => r.pos)).toEqual([1, 2, 7, 8, 5, 6, 9, 11, 10]);
  });
  test("a single drifted unit passes through in frozen pos order", () => {
    const rows = [R(5, C1B.unitId), R(6, C1B.unitId), R(10, C1B.unitId, true)];
    expect(orderEpilogueRows(rows, UNITS).map((r) => r.pos)).toEqual([5, 6, 10]);
    expect(orderEpilogueRows([], UNITS)).toEqual([]);
  });
  test("only same-repository blocks remaining REFUSES — freeze-repair territory, never a biased order", () => {
    const rows = [R(1, C1A.unitId), R(5, C1B.unitId)];
    expect(() => orderEpilogueRows(rows, UNITS)).toThrow(/REFUSING to run the R6 epilogue: no adjacency-free order/);
    expect(() => orderEpilogueRows(rows, UNITS)).toThrow(/freeze-repair/);
  });
  test("resume continues the SAME sequence: order over the FULL drifted set, drop terminal rows after", () => {
    // the call-site discipline (cmdMatrix): the order is a fixed function of the drifted set,
    // so the resumed rows are exactly the interrupted sequence minus its completed prefix —
    // and a unit's owed replay (its lowest non-terminal pos) stays first among its rows.
    const full = [R(1, C1A.unitId), R(2, C1A.unitId), R(5, C1B.unitId), R(6, C1B.unitId), R(7, C5.unitId), R(8, C5.unitId)];
    const fixedOrder = orderEpilogueRows(full, UNITS).map((r) => r.pos); // [1,2,7,8,5,6]
    const terminal = new Set([1, 2]); // interrupted right after C1A's block completed
    const resumed = orderEpilogueRows(full, UNITS).filter((r) => !terminal.has(r.pos)).map((r) => r.pos);
    expect(resumed).toEqual([7, 8, 5, 6]); // the fixed order's suffix — C5 still separates the siblings
    expect(resumed).toEqual(fixedOrder.filter((p) => !terminal.has(p)));
    // ordering the REMAINING subset instead re-interleaves: {C1B, C5} alone puts C1B first,
    // i.e. prom/prom straight across the resume boundary (C1A, also prom, just executed) —
    // the exact adjacency the fixed sequence prevents
    const subsetOrder = orderEpilogueRows(full.filter((r) => !terminal.has(r.pos)), UNITS).map((r) => r.pos);
    expect(subsetOrder).toEqual([5, 6, 7, 8]);
    expect(subsetOrder).not.toEqual(resumed);
  });
  test("a drifted unit missing from the schedule-unit set REFUSES — its adjacency key is unknown", () => {
    expect(() => orderEpilogueRows([R(1, "C9:ghost/ghost@main")], UNITS)).toThrow(/adjacency key — is unknown|is not in the schedule-unit set/);
  });
  test("deterministic: the same drifted set always yields the same order", () => {
    const rows = [R(1, C1A.unitId), R(5, C1B.unitId), R(7, C5.unitId)];
    const a = orderEpilogueRows(rows, UNITS).map((r) => r.pos);
    expect(orderEpilogueRows(rows, UNITS).map((r) => r.pos)).toEqual(a);
  });
});

describe("readObjectWithOneRespawn — the fidelity surrogate mirrors runT2c's §3.1 allowance", () => {
  // The asymmetry (recorded confirmedButNotFixed, ratified for fix 2026-08-02): runT2c disposes
  // a first dead child and retries once; the surrogate had no equivalent, so ONE child death
  // became a permanent fidelity-driver-failure for a condition the ratified driver recovers from.
  const frame: BatchFrame = { kind: "content", oid: "a".repeat(40), size: 1, body: bytes("x") };
  const EXPECT = { oid: "a".repeat(40), size: 1 };
  const mkDisposal = (tag: string): BatchChildDisposal =>
    ({ exitCode: 1, stderrTail: bytes(`fatal: ${tag}`), stderrDroppedBytes: 0, protocolError: `child exited (1) mid-conversation` });
  class FakeReader {
    disposed = false;
    constructor(private script: Array<"ok" | "die">, private tag: string) {}
    readObject(): Promise<BatchFrame> {
      const step = this.script.shift();
      if (step === "ok") return Promise.resolve(frame);
      return Promise.reject(new BenchSpawnError("batch-fatal", `child exited (1) mid-conversation [${this.tag}]`));
    }
    dispose(): Promise<BatchChildDisposal> {
      this.disposed = true;
      return Promise.resolve(mkDisposal(this.tag));
    }
  }
  const freshState = (): FidelityRespawnState => ({ respawns: 0, firstDisposal: null });
  test("a clean first read spawns nothing and leaves the allowance intact", async () => {
    const first = new FakeReader(["ok"], "first");
    const holder = { child: first as FakeReader };
    let spawned = 0;
    const state = freshState();
    const got = await readObjectWithOneRespawn(holder, () => { spawned++; return new FakeReader(["ok"], "spare"); }, EXPECT, state);
    expect(got).toBe(frame);
    expect(spawned).toBe(0);
    expect(state).toEqual({ respawns: 0, firstDisposal: null });
    expect(holder.child).toBe(first);
  });
  test("a first death disposes the dead child, respawns once, and a successful replacement succeeds", async () => {
    const first = new FakeReader(["die"], "first");
    const replacement = new FakeReader(["ok"], "replacement");
    const holder = { child: first as FakeReader };
    const state = freshState();
    const got = await readObjectWithOneRespawn(holder, () => replacement, EXPECT, state);
    expect(got).toBe(frame);
    expect(first.disposed).toBe(true); // the diagnosis was captured before the replacement ran
    expect(state.respawns).toBe(1);
    expect(state.firstDisposal?.stderrTail).toEqual(bytes("fatal: first"));
    expect(holder.child).toBe(replacement); // the caller's finally disposes the replacement
  });
  test("a dying replacement is the died-twice UnitFailure carrying the FIRST child's diagnosis", async () => {
    const first = new FakeReader(["die"], "first");
    const replacement = new FakeReader(["die"], "replacement");
    const holder = { child: first as FakeReader };
    let thrown: unknown;
    try {
      await readObjectWithOneRespawn(holder, () => replacement, EXPECT, freshState());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnitFailure);
    expect((thrown as Error).message).toContain("batch child died twice");
    expect((thrown as Error).message).toContain("fatal: first"); // retained diagnosis, not just the second failure
    expect(holder.child).toBe(replacement); // left for the caller's finally — never orphaned
    expect(replacement.disposed).toBe(false); // disposing it is the caller's finally, not the helper
  });
  test("a spent allowance fails a later death immediately — one respawn per (fixture, driver), as runT2c per run", async () => {
    const later = new FakeReader(["die"], "later");
    const holder = { child: later as FakeReader };
    const state: FidelityRespawnState = { respawns: 1, firstDisposal: mkDisposal("first") };
    let spawned = 0;
    let thrown: unknown;
    try {
      await readObjectWithOneRespawn(holder, () => { spawned++; return new FakeReader(["ok"], "spare"); }, EXPECT, state);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnitFailure);
    expect((thrown as Error).message).toContain("batch child died twice");
    expect((thrown as Error).message).toContain("fatal: first"); // the earlier death's retained diagnosis
    expect(spawned).toBe(0);
  });
  test("the died-twice failure classifies as a durable driver failure, exactly as before the respawn existed", () => {
    expect(classifyFidelityAbort(new UnitFailure("batch child died twice: x"))).toBe("driver-failure");
  });
});

describe("reclaimBenchRoot — command teardowns must never substitute a cleanup failure", () => {
  // The masking (recorded at the santa-loop cap, ratified for fix 2026-08-02): eight
  // rmSync(benchRoot) sites ran unguarded in finally/catch blocks, so an EACCES/EBUSY there
  // REPLACED whatever error was already propagating out of a command.
  test("a throwing removal is contained and never propagates", () => {
    expect(() => reclaimBenchRoot("/tmp/pa-bench-test-root", () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    })).not.toThrow();
  });
  test("the removal receives the root with the recursive+force options", () => {
    const calls: Array<{ path: string; opts: unknown }> = [];
    reclaimBenchRoot("/tmp/pa-bench-test-root", (path, opts) => {
      calls.push({ path, opts });
    });
    expect(calls).toEqual([{ path: "/tmp/pa-bench-test-root", opts: { recursive: true, force: true } }]);
  });
  test("a pathological throw (a non-Error) is contained too", () => {
    expect(() => reclaimBenchRoot("/tmp/pa-bench-test-root", () => {
      throw null;
    })).not.toThrow();
  });
});
