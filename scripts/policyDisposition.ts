// policyDisposition.ts — the ONE definition of what a run_unit_head row's policy columns MEAN for the
// read surfaces (report counts, HTML scan-scope panel, compare churn). The load-bearing subtlety:
// `policy_status IS NOT NULL` does NOT mean "excluded from scanning" — a SCANNED default branch carries
// the counterfactual policy_status too (the default-branch override, PROMPT.md §3). So the two states must be
// distinguished by BOTH status and policy_status. Shared so report/HTML/compare can never drift.
import type { PolicyStatus } from "./db.ts"; // type-only: erased, so this module stays a runtime leaf

export interface PolicyDispositionRow {
  readonly status: string; // 'scanned' | 'skipped-cutoff' | 'policy-excluded' | 'past-cap' (UnitHeadStatus)
  readonly policy_status: string | null; // 'excluded-by-deny' | 'excluded-by-allow' | null
  // Tri-state 1/0/NULL. Required here because the override predicate below is a CLAIM about
  // defaultness: without this column a read surface can only guess, and the SQL CHECKs cannot help —
  // they deliberately leave `scanned` free to carry a counterfactual, so a scanned+policy row with
  // is_default_branch=0 is schema-VALID and reaches these predicates.
  readonly is_default_branch: number | null;
}

// A branch actually DROPPED by policy — its own disposition in the disjoint partition (PROMPT.md §3),
// named identically to the live JSONL stream's `action:'skip-policy'` event for the same branch.
// The status alone is authoritative: the write chokepoint and two SQL CHECKs both refuse a
// 'policy-excluded' row that names no rule, and refuse a policy verdict on a cutoff/cap row.
export const isPolicyExcluded = (r: PolicyDispositionRow): boolean => r.status === "policy-excluded";

// A branch policy WOULD have dropped but which was scanned anyway because it is the default branch
// (the default is always scanned): a scanned row carrying a counterfactual policy_status. Overlaps `branchesScanned` — it
// is a DIAGNOSTIC, never part of the disjoint disposition partition. This is the reason `policy_status`
// cannot be collapsed into `status`: the override's verdict is counterfactual, and the branch IS scanned.
// is_default_branch must be a definite 1: the write chokepoint enforces that a scanned policy-bearing
// row IS the known default, so anything else reaching a read surface is a row that never passed our
// writer — assert it rather than label it (see assertKnownPolicyDisposition).
export const isDefaultOverride = (r: PolicyDispositionRow): boolean =>
  r.status === "scanned" && r.policy_status !== null && r.is_default_branch === 1;

// FAIL-CLOSED guard for any read surface that COUNTS or LABELS a run_unit_head row. Callers must run it
// over EVERY row, not a policy-bearing subset: `isPolicyExcluded` keys on status alone, so a filtered
// caller can count a row this guard never saw (exactly the drift that let a 'policy-excluded' row naming
// no rule be counted as an exclusion while the scan-scope ledger omitted it).
// It rejects every status↔policy_status disagreement the write path forbids:
//   - 'policy-excluded' with NO policy_status (checked FIRST — the null-policy early return below would
//     otherwise wave through the one policy-bearing status whose verdict is missing);
//   - a policy_status on a status that cannot carry one (a cutoff/cap row, or an unmigrated shape);
//   - a SCANNED policy-bearing row that is not the known default — schema-valid (the CHECKs leave
//     `scanned` free for the counterfactual) but a write-path violation, and the one shape where
//     "excluded or override?" has no honest answer.
// All are states the chokepoint and the SQL CHECKs forbid — but those run at WRITE time, not here, so a
// read surface must never INFER a label from a partial match. That inference is the second definition
// this module exists to prevent, and a disposition added later (e.g. an 'error' status) would silently
// inherit the wrong label. Fail, never guess.
// A row with NO policy_status and a non-policy status returns immediately — the common, unlabelled case.
export function assertKnownPolicyDisposition(r: PolicyDispositionRow, where: string): void {
  if (r.status === "policy-excluded" && r.policy_status === null)
    throw new Error(
      `internal: run_unit_head ${where} is status='policy-excluded' but carries no policy_status — the rule that dropped it is unknowable`,
    );
  if (r.policy_status === null) return;
  if (r.status === "scanned" && r.is_default_branch !== 1)
    throw new Error(
      `internal: run_unit_head ${where} is a scanned row carrying policy_status=${JSON.stringify(r.policy_status)} but is_default_branch=${r.is_default_branch ?? "null"} — only the default branch is scanned despite a policy verdict`,
    );
  if (isPolicyExcluded(r) || isDefaultOverride(r)) return;
  throw new Error(
    `internal: run_unit_head ${where} carries policy_status=${JSON.stringify(r.policy_status)} on status=${JSON.stringify(r.status)} — neither a policy exclusion nor a default-branch override`,
  );
}

// The closed literal set as VALUES — the runtime half of db.ts's PolicyStatus, kept honest by a
// BIDIRECTIONAL compile-time sync (the reportSchema.ts ↔ db.ts enum precedent): Equal<> fails the
// build in both drift directions, so this list can neither admit a literal the union dropped nor
// reject one it gained. That link is the point — a hand-written `=== "a" || === "b"` check would
// silently start rejecting a VALID value the day the union grows.
const POLICY_STATUSES = ["excluded-by-deny", "excluded-by-allow"] as const;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
export type PolicyStatusesSyncedWithDb = Expect<Equal<(typeof POLICY_STATUSES)[number], PolicyStatus>>;

// The row's policy_status as that closed set, CHECKED — for a read surface that STAMPS the value into
// an emitted artifact (report scanScope's policyBranches[].policyStatus, typed as exactly these two
// literals). Everything above discriminates on SHAPE — (status, policy_status IS NOT NULL) — and never
// reads the literal, so a shape-valid row carrying an out-of-band value satisfies isPolicyExcluded and
// clears assertKnownPolicyDisposition untouched; only an `as` cast stood between it and the emitted
// JSON, and a cast is a claim, not a check. Unreachable today (the v4 column CHECK constrains the
// value, and classifyRunUnitHead refuses a table whose CHECK set differs) — this is the read-side
// backstop for external damage, or for a status added to the schema but not to this surface.
export function checkedPolicyStatus(r: PolicyDispositionRow, where: string): PolicyStatus {
  const known = POLICY_STATUSES.find((s) => s === r.policy_status);
  if (known !== undefined) return known;
  throw new Error(
    `internal: run_unit_head ${where} carries an unrecognised policy_status=${JSON.stringify(r.policy_status)}`,
  );
}
