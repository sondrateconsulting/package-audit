// policyDisposition.ts — the ONE definition of what a run_unit_head row's policy columns MEAN for the
// read surfaces (report counts, HTML scan-scope panel, compare churn). The load-bearing subtlety:
// `policy_status IS NOT NULL` does NOT mean "excluded from scanning" — a SCANNED default branch carries
// the counterfactual policy_status too (the default-branch override, §3). So the two states must be
// distinguished by BOTH status and policy_status. Shared so report/HTML/compare can never drift.
export interface PolicyDispositionRow {
  readonly status: string; // 'scanned' | 'skipped-cutoff' | 'past-cap' (UnitHeadStatus)
  readonly policy_status: string | null; // 'excluded-by-deny' | 'excluded-by-allow' | null
}

// A branch actually DROPPED by policy: a skipped-cutoff row that carries a policy_status (§3 — the
// policy-excluded disposition reuses the skipped-cutoff status, disambiguated by policy_status).
export const isPolicyExcluded = (r: PolicyDispositionRow): boolean =>
  r.status === "skipped-cutoff" && r.policy_status !== null;

// A branch policy WOULD have dropped but which was scanned anyway because it is the default branch
// (Premise 6): a scanned row carrying a counterfactual policy_status. Overlaps `branchesScanned` — it
// is a DIAGNOSTIC, never part of the disjoint disposition partition.
export const isDefaultOverride = (r: PolicyDispositionRow): boolean =>
  r.status === "scanned" && r.policy_status !== null;
