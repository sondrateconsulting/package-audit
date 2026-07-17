// policyDisposition.ts — the ONE definition of what a run_unit_head row's policy columns MEAN for the
// read surfaces (report counts, HTML scan-scope panel, compare churn). The load-bearing subtlety:
// `policy_status IS NOT NULL` does NOT mean "excluded from scanning" — a SCANNED default branch carries
// the counterfactual policy_status too (the default-branch override, PROMPT.md §3). So the two states must be
// distinguished by BOTH status and policy_status. Shared so report/HTML/compare can never drift.
import type { PolicyStatus } from "./db.ts"; // type-only: erased, so this module stays a runtime leaf

export interface PolicyDispositionRow {
  readonly status: string; // 'scanned' | 'skipped-cutoff' | 'past-cap' (UnitHeadStatus)
  readonly policy_status: string | null; // 'excluded-by-deny' | 'excluded-by-allow' | null
}

// A branch actually DROPPED by policy: a skipped-cutoff row that carries a policy_status (PROMPT.md §3 —
// the policy-excluded disposition reuses the skipped-cutoff status, disambiguated by policy_status).
export const isPolicyExcluded = (r: PolicyDispositionRow): boolean =>
  r.status === "skipped-cutoff" && r.policy_status !== null;

// A branch policy WOULD have dropped but which was scanned anyway because it is the default branch
// (the default is always scanned): a scanned row carrying a counterfactual policy_status. Overlaps `branchesScanned` — it
// is a DIAGNOSTIC, never part of the disjoint disposition partition.
export const isDefaultOverride = (r: PolicyDispositionRow): boolean =>
  r.status === "scanned" && r.policy_status !== null;

// FAIL-CLOSED guard for any read surface that LABELS a policy-bearing row (report's scan-scope ledger,
// compare's policy churn). Over rows carrying a policy_status the two predicates above are exhaustive
// for every shape the write path permits: assertRunUnitHeadInvariants forbids a past-cap row from
// carrying a policy_status, and forces a scanned policy-bearing row to be the default. But those run at
// the WRITE chokepoint, not here — so a read surface must never INFER "excluded" from "policy-bearing
// and not an override". That inference is the second definition this module exists to prevent, and a
// disposition added later (e.g. an 'error' status) would silently inherit the wrong label. A
// policy-bearing row satisfying neither predicate is a write-path violation or an unmigrated read
// surface: fail, never guess.
// A row with NO policy_status returns immediately — that is the common, unlabelled case.
export function assertKnownPolicyDisposition(r: PolicyDispositionRow, where: string): void {
  if (r.policy_status === null) return;
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
