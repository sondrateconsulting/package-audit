// policyDisposition.ts — the ONE definition of what a run_unit_head row's policy columns MEAN for the
// read surfaces (report counts, HTML scan-scope panel, compare churn). The load-bearing subtlety:
// `policy_status IS NOT NULL` does NOT mean "excluded from scanning" — a SCANNED default branch carries
// the counterfactual policy_status too (the default-branch override, PROMPT.md §3). So the two states must be
// distinguished by BOTH status and policy_status. Shared so report/HTML/compare can never drift.
//
// The guard below validates the WHOLE row, exhaustively, rather than the one rule a caller happens to
// care about. That is deliberate and was learned the hard way: three separate rounds of review each
// found another half-checked symmetry (a policy-excluded row with no verdict; a scanned policy row that
// was not the default; a policy-EXCLUDED row that WAS the default; an allow-exclusion carrying a deny
// pattern). Each was a rule the WRITE chokepoint enforces and this read guard did not. Anything the
// chokepoint asserts about a row's shape must be re-asserted here, because these surfaces also read rows
// that never passed our writer — a foreign or sibling file that survived classification, a disposition
// added later, or a hand-edited database. Validate every field or one of them will be the next hole.
import type { PolicyStatus, UnitHeadStatus } from "./db.ts"; // type-only: erased, so this module stays a runtime leaf

export interface PolicyDispositionRow {
  readonly status: string; // validated against UnitHeadStatus below — NOT trusted as one
  readonly policy_status: string | null; // validated against PolicyStatus below — NOT trusted as one
  readonly policy_matched_pattern: string | null;
  // Tri-state 1/0/NULL. Required because both policy predicates are CLAIMS about defaultness: without
  // it a read surface can only guess, and SQL cannot help — the CHECKs deliberately leave `scanned`
  // free to carry a counterfactual, so a scanned+policy row with is_default_branch=0 is schema-VALID.
  readonly is_default_branch: number | null;
}

const KNOWN_STATUSES: readonly string[] = ["scanned", "skipped-cutoff", "policy-excluded", "past-cap"];
const isKnownPolicyStatus = (v: string | null): v is PolicyStatus =>
  v === "excluded-by-deny" || v === "excluded-by-allow";

// A branch actually DROPPED by policy — its own disposition in the disjoint partition (PROMPT.md §3),
// named identically to the live JSONL stream's `action:'skip-policy'` event for the same branch.
// The status alone is authoritative for CALLERS only because assertKnownPolicyDisposition has already
// refused every row whose status, verdict, pattern or defaultness disagree. Callers MUST run that guard
// over every row they count or label — never a filtered subset (see its contract).
export const isPolicyExcluded = (r: PolicyDispositionRow): boolean => r.status === "policy-excluded";

// A branch policy WOULD have dropped but which was scanned anyway because it is the default branch
// (the default is always scanned): a scanned row carrying a counterfactual policy_status. Overlaps `branchesScanned` — it
// is a DIAGNOSTIC, never part of the disjoint disposition partition. This is the reason `policy_status`
// cannot be collapsed into `status`: the override's verdict is counterfactual, and the branch IS scanned.
export const isDefaultOverride = (r: PolicyDispositionRow): boolean =>
  r.status === "scanned" && r.policy_status !== null && r.is_default_branch === 1;

// The row's verdict, NARROWED. Use this instead of casting `policy_status` into the union: a cast
// asserts a domain nobody checked, and a bogus token then escapes into output typed as if it were valid.
// Safe to call only on a row that passed the guard; it re-checks anyway, because a guard that ran
// somewhere else is not a type.
export function policyStatusOrThrow(r: PolicyDispositionRow, where: string): PolicyStatus {
  if (isKnownPolicyStatus(r.policy_status)) return r.policy_status;
  throw new Error(
    `internal: run_unit_head ${where} has policy_status=${JSON.stringify(r.policy_status)}, outside the known domain`,
  );
}

// FAIL-CLOSED guard for any read surface that COUNTS or LABELS a run_unit_head row. Callers must run it
// over EVERY row, not a policy-bearing subset: `isPolicyExcluded` keys on status alone, so a filtered
// caller can count a row this guard never saw (exactly the drift that let a 'policy-excluded' row naming
// no rule be counted as an exclusion while the scan-scope ledger omitted it).
//
// It rejects every disagreement the write chokepoint forbids:
//   - a status outside the known four — it would land in NO disposition bucket, silently breaking the
//     partition the report's counts rest on (and a later 'error' status would arrive exactly this way);
//   - a policy_status outside the known two — a bogus token is otherwise counted AND emitted;
//   - a policy_matched_pattern on anything but a deny — the SQL CHECK only enforces deny ⇒ pattern, not
//     the converse, so an allow-exclusion carrying a deny pattern is schema-VALID and the ledger would
//     report a causing pattern that never caused anything;
//   - 'policy-excluded' with NO verdict, or on a row that is not a definite non-default: the default is
//     ALWAYS scanned (Premise 6), so it can never be a policy exclusion;
//   - a SCANNED policy-bearing row that is not the known default — the mirror image;
//   - a policy_status on a cutoff/cap row, which policy never reaches (it runs first).
// The defaultness and pattern-converse rules are deliberately NOT SQL CHECKs: a CHECK over
// is_default_branch could reject a v3 row at migration time (the rebuild copies rows verbatim, and a
// pre-v4 file's shape is history), so failing an UPGRADE to defend against a forged row would trade a
// real risk for a hypothetical one. They live here, where refusing costs one report.
// Fail, never guess: the inference this module exists to prevent is "policy-bearing and not an
// override, therefore excluded".
export function assertKnownPolicyDisposition(r: PolicyDispositionRow, where: string): void {
  if (!KNOWN_STATUSES.includes(r.status))
    throw new Error(
      `internal: run_unit_head ${where} has status=${JSON.stringify(r.status)}, outside the four known dispositions — it belongs to no report bucket`,
    );
  if (r.policy_status !== null && !isKnownPolicyStatus(r.policy_status))
    throw new Error(
      `internal: run_unit_head ${where} has policy_status=${JSON.stringify(r.policy_status)}, outside the known domain`,
    );
  if (r.policy_matched_pattern !== null && r.policy_status !== "excluded-by-deny")
    throw new Error(
      `internal: run_unit_head ${where} carries policy_matched_pattern=${JSON.stringify(r.policy_matched_pattern)} on policy_status=${JSON.stringify(r.policy_status)} — only a deny names a causing pattern`,
    );
  if (r.status === "policy-excluded") {
    if (r.policy_status === null)
      throw new Error(
        `internal: run_unit_head ${where} is status='policy-excluded' but carries no policy_status — the rule that dropped it is unknowable`,
      );
    if (r.is_default_branch !== 0)
      throw new Error(
        `internal: run_unit_head ${where} is status='policy-excluded' with is_default_branch=${r.is_default_branch ?? "null"} — the default branch is always scanned and can never be a policy exclusion`,
      );
    return;
  }
  if (r.policy_status === null) return; // the common, unlabelled case
  if (r.status === "scanned" && r.is_default_branch !== 1)
    throw new Error(
      `internal: run_unit_head ${where} is a scanned row carrying policy_status=${JSON.stringify(r.policy_status)} but is_default_branch=${r.is_default_branch ?? "null"} — only the default branch is scanned despite a policy verdict`,
    );
  if (isDefaultOverride(r)) return;
  throw new Error(
    `internal: run_unit_head ${where} carries policy_status=${JSON.stringify(r.policy_status)} on status=${JSON.stringify(r.status)} — neither a policy exclusion nor a default-branch override`,
  );
}
