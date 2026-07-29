// benchFidelity.test.ts — CI tests for the C6 battery's typed replay ledger (§4.2/§4.5,
// Step-C residual 4): mismatch permanence, the one-objective-external-rerun cap per
// (fixture, driver), digest scoping, and the whole-ledger verdict.
import { describe, expect, test } from "bun:test";
import type { C6Fixture } from "./benchCorpus.ts";
import {
  FIDELITY_MAX_ATTEMPT_ERRORS, cellFinalState, judgeFidelity, reconstructFidelityLedger,
  shouldAttemptCell,
} from "./benchFidelity.ts";

const DIGEST = "d".repeat(64);
const rec = (over: Record<string, unknown>): string =>
  JSON.stringify({
    type: "fidelity", generatedAtIso: "2026-07-29T00:00:00Z", frozenSurfaceDigest: DIGEST,
    fixture: "clone-symlink", driver: "T2c", entry: "a/link.sh", outcome: "match", pass: true,
    ...over,
  });
const FIXTURES: C6Fixture[] = [
  {
    kind: "clone-symlink", owner: "o", repo: "r", branch: "main", sha: "s".repeat(40),
    objectFormat: "sha1", appliesTo: ["T2a", "T2c"],
    entries: [{ path: "a/link.sh", mode: "120000", oid: "1".repeat(40), size: 17 }],
    verification: {},
  },
];

describe("reconstructFidelityLedger", () => {
  test("counts per cell, groups attempt-errors per (fixture, driver), scopes by digest", () => {
    const ledger = reconstructFidelityLedger([
      rec({}),
      rec({ driver: "T2a", outcome: "attempt-error", pass: false }),
      rec({ driver: "T2a", outcome: "attempt-error", pass: false }),
      rec({ outcome: "mismatch", pass: false, frozenSurfaceDigest: "x".repeat(64) }), // dead evidence
      "not json", "",
    ], DIGEST);
    expect(ledger.cells.get("clone-symlink|T2c|a/link.sh")).toEqual({ matches: 1, mismatches: 0, attemptErrors: 0 });
    expect(ledger.groupAttemptErrors.get("clone-symlink|T2a")).toBe(2);
  });
  test("legacy records without an outcome field map pass:true → match and pass:false → mismatch (fail-closed)", () => {
    const ledger = reconstructFidelityLedger([
      rec({ outcome: undefined }),
      rec({ driver: "T2a", outcome: undefined, pass: false }),
    ], DIGEST);
    expect(ledger.cells.get("clone-symlink|T2c|a/link.sh")?.matches).toBe(1);
    expect(ledger.cells.get("clone-symlink|T2a|a/link.sh")?.mismatches).toBe(1);
  });
});

describe("cellFinalState + shouldAttemptCell — the §4.2 discipline", () => {
  test("mismatch is permanent, even beside a later match (tamper evidence, not recovery)", () => {
    const ledger = reconstructFidelityLedger([rec({ outcome: "mismatch", pass: false }), rec({})], DIGEST);
    expect(cellFinalState(ledger, "clone-symlink", "T2c", "a/link.sh")).toBe("fail-mismatch");
    expect(shouldAttemptCell(ledger, "clone-symlink", "T2c", "a/link.sh")).toBe(false);
  });
  test("one attempt-error → pending-retry (attemptable); the cap exhausts at two", () => {
    const one = reconstructFidelityLedger([rec({ outcome: "attempt-error", pass: false })], DIGEST);
    expect(cellFinalState(one, "clone-symlink", "T2c", "a/link.sh")).toBe("pending-retry");
    expect(shouldAttemptCell(one, "clone-symlink", "T2c", "a/link.sh")).toBe(true);
    const two = reconstructFidelityLedger([
      rec({ outcome: "attempt-error", pass: false }),
      rec({ outcome: "attempt-error", pass: false }),
    ], DIGEST);
    expect(FIDELITY_MAX_ATTEMPT_ERRORS).toBe(2);
    expect(cellFinalState(two, "clone-symlink", "T2c", "a/link.sh")).toBe("fail-exhausted");
    expect(shouldAttemptCell(two, "clone-symlink", "T2c", "a/link.sh")).toBe(false);
  });
  test("an attempt-error then a match passes; an empty ledger is never-attempted", () => {
    const recovered = reconstructFidelityLedger([rec({ outcome: "attempt-error", pass: false }), rec({})], DIGEST);
    expect(cellFinalState(recovered, "clone-symlink", "T2c", "a/link.sh")).toBe("pass");
    expect(cellFinalState(reconstructFidelityLedger([], DIGEST), "clone-symlink", "T2c", "a/link.sh")).toBe("never-attempted");
  });
});

describe("judgeFidelity — the whole-ledger battery verdict", () => {
  test("failures make the driver G1-failed; pending/never-run make it incomplete (G2)", () => {
    const ledger = reconstructFidelityLedger([
      rec({ driver: "T2c", outcome: "mismatch", pass: false }),
      // T2a never attempted
    ], DIGEST);
    const verdict = judgeFidelity(FIXTURES, ledger);
    expect(verdict.cells.length).toBe(2);
    expect(verdict.failures.map((c) => c.driver)).toEqual(["T2c"]);
    expect(verdict.mismatchDrivers.has("T2c")).toBe(true);
    expect(verdict.neverAttempted.map((c) => c.driver)).toEqual(["T2a"]);
    expect(verdict.incompleteDrivers.has("T2a")).toBe(true);
  });
  test("an all-match ledger yields a clean verdict", () => {
    const ledger = reconstructFidelityLedger([rec({}), rec({ driver: "T2a" })], DIGEST);
    const verdict = judgeFidelity(FIXTURES, ledger);
    expect(verdict.failures).toEqual([]);
    expect(verdict.pendingRetry).toEqual([]);
    expect(verdict.neverAttempted).toEqual([]);
    expect(verdict.mismatchDrivers.size).toBe(0);
    expect(verdict.incompleteDrivers.size).toBe(0);
  });
});
