// benchFidelity.ts — the C6 battery's typed replay ledger (resolution plan §4.2/§4.5; Step-C
// residual 4). The plan permits ONE objective-external rerun per (fixture, driver) and forbids
// rerunning mismatches. Before this ledger existed, cmdFidelity had no cross-invocation memory:
// a T1 no-response was frozen as a permanent `unresolved:*` mismatch, while an exception on a
// REST/clone path aborted before any record landed and could be retried without bound. The
// ledger is reconstructed from fidelity.jsonl on every invocation, so the cap and the
// mismatch-permanence rule survive crashes and re-invocations — and the battery verdict
// (consumed by scoring's G1/G2 gates) aggregates over the WHOLE ledger, never over a single
// invocation's results.

import type { C6Fixture } from "./benchCorpus.ts";

export class BenchFidelityError extends Error {
  constructor(message: string) {
    super(`BENCH FIDELITY: ${message}`);
    this.name = "BenchFidelityError";
  }
}

// Cell outcomes, typed. `match`/`mismatch` mean the byte comparison actually happened;
// `content-failure` is a PERMANENT no-comparison defect (absent path, unverifiable frame,
// deterministic response defects, harness exceptions) — it maps to G2 completeness, never G1
// byte divergence (codex C0-R2 re f.9); `attempt-error` means a frozen objective-external
// condition prevented the comparison — only attempt-errors are ever rerunnable, once per
// (fixture, driver) group.
export type FidelityOutcome = "match" | "mismatch" | "content-failure" | "attempt-error";

export interface FidelityCellState {
  matches: number;
  mismatches: number;
  contentFailures: number;
  attemptErrors: number;
}

// one battery cell = (fixture kind, driver, entry path); the rerun cap groups by (kind, driver)
export const fidelityCellKey = (kind: string, driver: string, path: string): string => `${kind}|${driver}|${path}`;
export const fidelityGroupKey = (kind: string, driver: string): string => `${kind}|${driver}`;

// §4.2: one objective-external attempt may be REPLAYED once, so a group tolerates at most two
// recorded attempt-errors before it is terminally failed.
export const FIDELITY_MAX_ATTEMPT_ERRORS = 2;

export interface FidelityLedger {
  cells: Map<string, FidelityCellState>;
  groupAttemptErrors: Map<string, number>;
}

// Reconstruct the ledger from fidelity.jsonl lines. Only records stamped with the CURRENT
// frozen-surface digest count: evidence from a pre-amendment surface is dead (§8), and a
// re-frozen battery legitimately starts over.
export function reconstructFidelityLedger(lines: readonly string[], digest: string): FidelityLedger {
  const ledger: FidelityLedger = { cells: new Map(), groupAttemptErrors: new Map() };
  const lastNonEmpty = ((): number => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim() !== "") return i;
    return -1;
  })();
  for (const [lineIndex, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // only the final line may be torn by a crash mid-append; a malformed interior line means
      // the append-only ledger was edited or corrupted — refuse rather than silently dropping
      // recorded evidence (codex C0-R1 finding 13)
      if (lineIndex < lastNonEmpty)
        throw new BenchFidelityError(`fidelity.jsonl carries a malformed interior line (${lineIndex + 1}) — the append-only ledger must not be edited; only a torn final append is tolerated`);
      continue;
    }
    if (rec["type"] !== "fidelity") continue;
    if (rec["frozenSurfaceDigest"] !== digest) continue;
    const kind = rec["fixture"];
    const driver = rec["driver"];
    const path = rec["entry"];
    if (typeof kind !== "string" || typeof driver !== "string" || typeof path !== "string") continue;
    const outcome = rec["outcome"];
    // legacy shape tolerance: records predating the outcome field carry only pass — a
    // pass:false there was a comparison-shaped failure, so it maps to mismatch (fail-closed)
    const eff: FidelityOutcome =
      outcome === "match" || outcome === "mismatch" || outcome === "content-failure" || outcome === "attempt-error"
        ? outcome
        : rec["pass"] === true
          ? "match"
          : "mismatch";
    const key = fidelityCellKey(kind, driver, path);
    const cell = ledger.cells.get(key) ?? { matches: 0, mismatches: 0, contentFailures: 0, attemptErrors: 0 };
    if (eff === "match") cell.matches++;
    else if (eff === "mismatch") cell.mismatches++;
    else if (eff === "content-failure") cell.contentFailures++;
    else {
      cell.attemptErrors++;
      const g = fidelityGroupKey(kind, driver);
      ledger.groupAttemptErrors.set(g, (ledger.groupAttemptErrors.get(g) ?? 0) + 1);
    }
    ledger.cells.set(key, cell);
  }
  return ledger;
}

export type FidelityCellFinal = "pass" | "fail-mismatch" | "fail-content" | "fail-exhausted" | "pending-retry" | "never-attempted";

export interface FidelityCellVerdict {
  kind: string;
  driver: string;
  path: string;
  final: FidelityCellFinal;
}

export interface FidelityVerdict {
  cells: FidelityCellVerdict[];
  failures: FidelityCellVerdict[]; // fail-mismatch + fail-exhausted
  pendingRetry: FidelityCellVerdict[]; // one attempt-error recorded, the single rerun still open
  neverAttempted: FidelityCellVerdict[]; // a skipped applicable fixture is a G2 event (§4.2)
  // the §4.7 mapping keeps G1 for OBSERVED byte divergence and G2 for completeness (codex
  // C0-R1 finding 9): a mismatch is G1; an exhausted, pending, or never-run cell means the
  // battery's evidence is incomplete — G2 — and either way the driver is ineligible.
  mismatchDrivers: Set<string>; // ≥1 fail-mismatch — a G1 event via the battery
  incompleteDrivers: Set<string>; // exhausted/pending/never-run cells — a G2 event
}

// Judge the WHOLE battery from the ledger: every applicable (fixture × driver × entry) cell
// must reach a terminal state. A cell may be attempted this invocation exactly when
// `shouldAttempt` says so; the verdict below is what scoring reads.
export function cellFinalState(ledger: FidelityLedger, kind: string, driver: string, path: string): FidelityCellFinal {
  const cell = ledger.cells.get(fidelityCellKey(kind, driver, path));
  // a recorded mismatch or content-failure is permanent even beside a later match — re-running
  // them is forbidden (§4.2), so a match AFTER one could only come from tampering
  if (cell !== undefined && cell.mismatches > 0) return "fail-mismatch";
  if (cell !== undefined && cell.contentFailures > 0) return "fail-content";
  if (cell !== undefined && cell.matches > 0) return "pass";
  const groupErrors = ledger.groupAttemptErrors.get(fidelityGroupKey(kind, driver)) ?? 0;
  if (groupErrors >= FIDELITY_MAX_ATTEMPT_ERRORS) return "fail-exhausted";
  if ((cell?.attemptErrors ?? 0) > 0 || groupErrors > 0) return "pending-retry";
  return "never-attempted";
}

export function shouldAttemptCell(ledger: FidelityLedger, kind: string, driver: string, path: string): boolean {
  const final = cellFinalState(ledger, kind, driver, path);
  return final === "pending-retry" || final === "never-attempted";
}

export function judgeFidelity(fixtures: readonly C6Fixture[], ledger: FidelityLedger): FidelityVerdict {
  const verdict: FidelityVerdict = {
    cells: [], failures: [], pendingRetry: [], neverAttempted: [],
    mismatchDrivers: new Set(), incompleteDrivers: new Set(),
  };
  for (const fixture of fixtures) {
    for (const driver of fixture.appliesTo) {
      for (const entry of fixture.entries) {
        const final = cellFinalState(ledger, fixture.kind, driver, entry.path);
        const cell: FidelityCellVerdict = { kind: fixture.kind, driver, path: entry.path, final };
        verdict.cells.push(cell);
        if (final === "fail-mismatch") {
          verdict.failures.push(cell);
          verdict.mismatchDrivers.add(driver);
        } else if (final === "fail-content" || final === "fail-exhausted") {
          verdict.failures.push(cell);
          verdict.incompleteDrivers.add(driver);
        } else if (final === "pending-retry") {
          verdict.pendingRetry.push(cell);
          verdict.incompleteDrivers.add(driver);
        } else if (final === "never-attempted") {
          verdict.neverAttempted.push(cell);
          verdict.incompleteDrivers.add(driver);
        }
      }
    }
  }
  return verdict;
}
