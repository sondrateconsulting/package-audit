// benchContentTransport.test.ts — CI tests for the harness entrypoint's fail-closed seams:
// the §8 freeze gate's git-state evaluation, harness-commit provenance acquisition, the
// fidelity battery's live-enumeration classification, and the pinning probe's batch atomicity.
//
// Every case here targets a path where a FAILED subprocess or a partially-errored response could
// otherwise be read as a valid observation. The harness's output is the evidence a one-way
// architecture decision rests on, so each of these must fail closed rather than fabricate.
import { describe, expect, test } from "bun:test";
import {
  BenchOperationalError, assertFreezeGitState, classifyFidelityEnumeration,
  harnessCommitFromGitResult, loginFromUserPayload, parseProbeBatch,
} from "./benchContentTransport.ts";
import { UnitFailure, describeDisposal } from "./benchDrivers.ts";
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
  test("the refusal carries the exit code and bounded stderr for the operator", () => {
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

describe("UnitFailure.annotateTeardown — teardown evidence must reach the RECORD", () => {
  // The engine writes `failureCause = e.cause2`, not `e.message`. A previous fix annotated
  // `message` only, so the batch child's disposal diagnosis was preserved in an error nobody
  // read and still absent from runs.jsonl — the exact discard it was meant to fix.
  test("the annotation lands on cause2, which is what the run record reads", () => {
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
  const blob = (over: Record<string, unknown> = {}) => ({ __typename: "Blob", isBinary: false, isTruncated: false, text: "hi", ...over });

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
