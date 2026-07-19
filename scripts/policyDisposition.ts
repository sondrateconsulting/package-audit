// policyDisposition.ts — the ONE read-time soundness gate for a run_unit_head row, and the ONE
// definition of what its policy columns MEAN (report counts, HTML scan-scope panel, compare churn,
// the export snapshot). The load-bearing subtlety: `policy_status IS NOT NULL` does NOT mean "excluded
// from scanning" — a SCANNED default branch carries the counterfactual policy_status too (the
// default-branch override, PROMPT.md §3). So the two states are distinguished by BOTH status and
// policy_status. Shared so every read surface applies the same gate and can never drift.
//
// The gate validates the WHOLE row, not the one rule a caller happens to care about. That is the
// lesson of this module's history: round after round of review found another half-checked symmetry
// (a policy-excluded row with no verdict; a scanned policy row that was not the default; a
// policy-EXCLUDED DEFAULT; an allow-exclusion carrying a deny pattern; a bogus policy token; an
// unknown status; a scanned row with an empty commit_sha that leaked findings). Each was a rule the
// WRITE chokepoint (assertRunUnitHeadInvariants) enforces and this read gate did not. These surfaces
// also read rows that never passed our writer — a foreign or sibling database that survived
// classification, a disposition added later, a hand-edited file — so anything the chokepoint asserts
// about a row's SHAPE is re-asserted HERE. Validate every field or one of them is the next hole.
//
// ONE deliberate exception: the chokepoint's SEMANTIC pattern↔branch verification (a stored deny
// pattern must actually match its branch, via the live glob engine) is NOT re-asserted here. This
// gate stays glob-free on purpose: Bun.Glob semantics are version-sensitive, so re-evaluating
// HISTORY under a newer engine could refuse rows that were true when written. The trust boundary is
// therefore write-time: rows written by a build carrying that verifier are match-attested; rows
// from before it (or from raw-SQL edits, which nothing attests) are legacy-unattested — readable,
// counted, and never re-matched.
import { isScanAttemptStatus, type PolicyStatus, type UnitHeadStatus } from "./db.ts";
import { isIsoInstant } from "./isoDate.ts";

export interface PolicyDispositionRow {
  // The identity trio is validated too: report/compare/export COUNT and EMIT these, and a BLOB
  // branch (schema-valid in a non-STRICT table) was counted and exported (round 6).
  readonly organization: string;
  readonly repository: string;
  readonly branch: string;
  readonly status: string; // validated against UnitHeadStatus below — NOT trusted as one
  readonly policy_status: string | null; // validated against PolicyStatus below — NOT trusted as one
  readonly policy_matched_pattern: string | null;
  // Tri-state 1/0/NULL. Load-bearing in BOTH directions (a policy-excluded row must be a definite
  // non-default; a scanned policy-bearing row must be the known default), and SQL cannot help: the
  // CHECKs leave `scanned` free to carry a counterfactual, so a scanned+policy row with
  // is_default_branch=0 is schema-VALID and reaches this gate.
  readonly is_default_branch: number | null;
  // A SCAN-ATTEMPT row (scanned/reused/deferred-*/error) pins a real observed commit; a DISCOVERY-time
  // disposition (skipped-cutoff/policy-excluded/past-cap) stores ''. The report/export findings join keys on
  // a REPORTABLE head (status IN ('scanned','reused')) matched on commit_sha, so a reportable row with
  // commit_sha='' would join findings parked at the empty SHA — a stale/poison leak. The gate is that join's only defense.
  readonly commit_sha: string;
  // NULL ONLY on a v3→v4-migrated row (the pre-upgrade provenance sentinel). Used to scope the
  // default⇒scanned rule to NATIVE rows: the migration copies v3 rows verbatim, so a CHECK — or an
  // ungated read rule — that a real pre-v4 row might violate would fail an UPGRADE to defend against a
  // forged row. A native row always carries a real date (a scan-attempt row its observed commit's date, a discovery-time row the discovered-head date).
  readonly scanned_commit_date: string | null;
}

// Record<UnitHeadStatus, true> is the EXHAUSTIVE compile-time link: a token added to db.ts's union
// makes this object MISSING a required key (error), and a token removed makes one EXCESS (error).
// (`satisfies readonly UnitHeadStatus[]` only checked membership, not coverage — an extended union
// compiled clean, which review proved by execution.)
const KNOWN_STATUS_MAP = {
  "scanned": true, "reused": true, "skipped-cutoff": true, "policy-excluded": true, "past-cap": true,
  "deferred-throttle": true, "deferred-network": true, "deferred-service": true, "error": true,
} as const satisfies Record<UnitHeadStatus, true>;
const KNOWN_STATUSES = Object.keys(KNOWN_STATUS_MAP);
const isKnownStatus = (v: string): v is UnitHeadStatus => KNOWN_STATUSES.includes(v);
// Same exhaustive link for the policy domain: a hand-written `=== "a" || === "b"` guard would
// silently start REJECTING a valid verdict the day the union grows (the type predicate does not
// police coverage) — the map makes that day a build error instead.
const KNOWN_POLICY_STATUS_MAP = {
  "excluded-by-deny": true, "excluded-by-allow": true,
} as const satisfies Record<PolicyStatus, true>;
const KNOWN_POLICY_STATUSES = Object.keys(KNOWN_POLICY_STATUS_MAP);
const isKnownPolicyStatus = (v: string | null): v is PolicyStatus => v !== null && KNOWN_POLICY_STATUSES.includes(v);

// A branch actually DROPPED by policy — its own disposition in the disjoint partition (PROMPT.md §3),
// corresponding to the live JSONL stream's `action:'skip-policy'` event. The status alone is
// authoritative for CALLERS only because assertRunUnitHeadSound has already refused every row whose
// status, verdict, pattern, defaultness or commit disagree. Run that gate over EVERY row first.
export const isPolicyExcluded = (r: PolicyDispositionRow): boolean => r.status === "policy-excluded";

// A branch policy WOULD have dropped but which was scan-attempted anyway because it is the default (the
// default is always scan-attempted): a scan-attempt row (scanned/reused, or a deferred-*/error attempt)
// carrying a counterfactual policy_status on the known default. Overlaps `branchesScanned` — a
// DIAGNOSTIC, never part of the disjoint partition. This is the reason policy_status cannot collapse
// into status: the override's verdict is counterfactual, the branch IS scan-attempted. Callers run
// assertRunUnitHeadSound first, so r.status is a validated UnitHeadStatus by the time this is read.
export const isDefaultOverride = (r: PolicyDispositionRow): boolean =>
  isScanAttemptStatus(r.status as UnitHeadStatus) && r.policy_status !== null && r.is_default_branch === 1;

// The row's verdict, NARROWED — use instead of casting `policy_status` into the union. A cast asserts a
// domain nobody checked, and a bogus token then escapes into output typed as if it were valid. Safe to
// call only after the gate; it re-checks anyway, because a gate that ran elsewhere is not a type.
export function policyStatusOrThrow(r: PolicyDispositionRow, where: string): PolicyStatus {
  if (isKnownPolicyStatus(r.policy_status)) return r.policy_status;
  throw new Error(`internal: run_unit_head ${where} has policy_status=${JSON.stringify(r.policy_status)}, outside the known domain`);
}

// FAIL-CLOSED whole-row gate for any read surface that COUNTS, LABELS, or EMITS a run_unit_head row —
// report, compare, AND the export snapshot. Callers run it over EVERY row, never a filtered subset:
// `isPolicyExcluded` keys on status alone, so a filtered caller can count a row this gate never saw
// (the drift that let a 'policy-excluded' row naming no rule be counted while the ledger omitted it).
//
// It rejects every disagreement the write chokepoint forbids that a read surface could be fooled by:
//   - a status outside the known NINE — it belongs to NO disposition family, silently breaking the
//     partition the counts rest on;
//   - a policy_status outside the known two — a bogus token is otherwise counted AND emitted;
//   - an is_default_branch outside 1/0/NULL (the column has no SQL CHECK, so 2 is schema-valid and
//     the read surfaces' `=== 1` coercion would silently relabel it "not the default");
//   - a NON-NULL scanned_commit_date that is not an ISO instant (garbage there is otherwise trusted
//     as NATIVE provenance and reported as 'complete');
//   - a policy_matched_pattern that is not a real deny pattern — the SQL deny CHECK enforces only
//     IS NOT NULL (so '' passes) and has NO converse (so an allow-exclusion may carry a deny pattern);
//     the ledger would otherwise report a causing pattern that caused nothing, or an empty one;
//   - a SCAN-ATTEMPT row (scanned/reused/deferred-*/error) with commit_sha='' or a DISCOVERY-time row
//     (skipped-cutoff/policy-excluded/past-cap) with a commit_sha — the findings join depends on this
//     partition, and a reportable empty-commit row leaks findings parked at '';
//   - a NATIVE default branch that is not scan-attempted — the default is always scan-attempted (Premise 6:
//     scanned/reused, or a deferred-*/error attempt). Gated on scanned_commit_date (native rows only), so a
//     migrated pre-v4 row can never fail an upgrade here;
//   - a past-cap row that is not a definite non-default (past-cap is v4-native-only, so unconditional);
//   - 'policy-excluded' with no verdict, or on anything but a definite non-default (the default can
//     never be an exclusion);
//   - a scanned policy-bearing row that is not the known default;
//   - a policy_status on a cutoff/cap row, which policy never reaches (it runs first).
// All are states the chokepoint forbids — but it runs at WRITE time, not here. Fail, never guess: the
// inference this module exists to prevent is "policy-bearing and not an override, therefore excluded".
export function assertRunUnitHeadSound(r: PolicyDispositionRow, where: string): void {
  // RUNTIME types first: the table is not STRICT, so SQLite happily stores a BLOB in any of these
  // columns and bun:sqlite hands it over as a Uint8Array the TypeScript row type never admits
  // (round-5: a one-byte BLOB deny pattern exported as {"0":120}). A declared type is not a check.
  if (typeof r.organization !== "string" || typeof r.repository !== "string" || typeof r.branch !== "string")
    throw new Error(`internal: run_unit_head ${where} has a non-string identity column — non-STRICT storage smuggled a foreign runtime type`);
  if (typeof r.status !== "string" || typeof r.commit_sha !== "string")
    throw new Error(`internal: run_unit_head ${where} has a non-string status/commit_sha — non-STRICT storage smuggled a foreign runtime type`);
  if ((r.policy_status !== null && typeof r.policy_status !== "string") ||
      (r.policy_matched_pattern !== null && typeof r.policy_matched_pattern !== "string") ||
      (r.scanned_commit_date !== null && typeof r.scanned_commit_date !== "string"))
    throw new Error(`internal: run_unit_head ${where} has a non-string policy/date column — non-STRICT storage smuggled a foreign runtime type`);
  if (r.is_default_branch !== null && !Number.isInteger(r.is_default_branch))
    throw new Error(`internal: run_unit_head ${where} has a non-integer is_default_branch — non-STRICT storage smuggled a foreign runtime type`);
  if (!isKnownStatus(r.status))
    throw new Error(`internal: run_unit_head ${where} has status=${JSON.stringify(r.status)}, outside the known dispositions — it belongs to no report bucket`);
  if (r.policy_status !== null && !isKnownPolicyStatus(r.policy_status))
    throw new Error(`internal: run_unit_head ${where} has policy_status=${JSON.stringify(r.policy_status)}, outside the known domain`);
  // Column DOMAINS before any relational rule — the two review round 4 proved were missing. The
  // is_default_branch column has NO SQL CHECK, so 2 (or -1) is schema-valid; the read surfaces coerce
  // `=== 1` to false, silently relabelling an unknown flag as "not the default". And a NON-NULL
  // scanned_commit_date is trusted as native provenance, so garbage there reported scanScope
  // provenance 'complete' — the same laundering the write chokepoint blocks with the SAME validator.
  if (r.is_default_branch !== null && r.is_default_branch !== 0 && r.is_default_branch !== 1)
    throw new Error(`internal: run_unit_head ${where} has is_default_branch=${JSON.stringify(r.is_default_branch)} — the tri-state is 1/0/NULL, nothing else`);
  if (r.scanned_commit_date !== null && !isIsoInstant(r.scanned_commit_date))
    throw new Error(`internal: run_unit_head ${where} has scanned_commit_date=${JSON.stringify(r.scanned_commit_date.slice(0, 40))} — not an ISO instant (NULL is the one legal non-date, the migrated-row sentinel)`);
  // The NULL sentinel means "migrated from a pre-v4 row" — and pre-v4 (v3) had ONLY scanned/
  // skipped-cutoff, without policy columns. So the NULL date is legal for EXACTLY those two v3-native
  // dispositions carrying no policy verdict; every v4+-native disposition (policy-excluded, past-cap,
  // and the v5 reused / deferred-* / error) and every policy-BEARING row of any status claiming migrated
  // provenance is impossible. Treating one as exempt from the native rules (as the default⇒scan-attempt
  // scoping below does) would launder exactly the rows that most need gating (round-4/5 findings:
  // NULL-date policy-excluded/past-cap, and a NULL-date scanned default override, all slipped through).
  const v3NativeDisposition = r.status === "scanned" || r.status === "skipped-cutoff";
  if ((!v3NativeDisposition || r.policy_status !== null) && r.scanned_commit_date === null)
    throw new Error(`internal: run_unit_head ${where} is ${r.status}${r.policy_status !== null ? ` carrying policy_status=${JSON.stringify(r.policy_status)}` : ""} with a NULL scanned_commit_date — only a pre-v4 scanned/skipped-cutoff row (no policy verdict) may be a migrated row`);
  // policy_matched_pattern ↔ deny, both directions (the SQL CHECK covers neither the empty case nor
  // the converse). The write chokepoint (db.ts::assertRunUnitHeadInvariants) enforces the SAME
  // null/empty/'!' predicate AND the same runtime-type checks as this gate — keep the two in
  // lockstep, or a writable build could durably store a row this gate then refuses forever.
  if (r.policy_status === "excluded-by-deny") {
    if (r.policy_matched_pattern === null || r.policy_matched_pattern.length === 0 || r.policy_matched_pattern.startsWith("!"))
      throw new Error(`internal: run_unit_head ${where} is excluded-by-deny but names no causing pattern (policy_matched_pattern=${JSON.stringify(r.policy_matched_pattern)})`);
  } else if (r.policy_matched_pattern !== null) {
    throw new Error(`internal: run_unit_head ${where} carries policy_matched_pattern=${JSON.stringify(r.policy_matched_pattern)} on policy_status=${JSON.stringify(r.policy_status)} — only a deny names a causing pattern`);
  }
  // commit_sha ↔ disposition family (§3.1a: the findings-join partition). A SCAN-ATTEMPT row pins the
  // OBSERVED head commit (scanned/reused name the head they reported — current when recorded, possibly
  // preserved-stale after a moved-head transient; deferred-*/error name the head the failed attempt saw);
  // every DISCOVERY-time disposition stores ''. Only scanned/reused JOIN findings,
  // but the whole scan-attempt family carries a real commit (the commit-aware upsert precedence relies
  // on it). r.status is a validated UnitHeadStatus here (isKnownStatus ran above).
  if (isScanAttemptStatus(r.status as UnitHeadStatus)) {
    if (r.commit_sha === "")
      throw new Error(`internal: run_unit_head ${where} is ${r.status} but has commit_sha='' — a scan-attempt row must pin its observed head`);
  } else if (r.commit_sha !== "") {
    throw new Error(`internal: run_unit_head ${where} is ${r.status} but has commit_sha=${JSON.stringify(r.commit_sha)} — only a scan-attempt row pins a commit`);
  }
  // Default is always scan-attempted (Premise 6) — NATIVE rows only (a migrated row carries a NULL date,
  // and pre-v4 semantics are history this gate must not re-litigate). The default's attempt is
  // scanned/reused, or deferred-*/error when the attempt itself failed transiently — never a
  // discovery-time skip/exclude/cap.
  if (r.is_default_branch === 1 && !isScanAttemptStatus(r.status as UnitHeadStatus) && r.scanned_commit_date !== null)
    throw new Error(`internal: run_unit_head ${where} is is_default_branch=1 but status=${JSON.stringify(r.status)} — the default branch is always scan-attempted`);
  // past-cap first exists in v4, so its non-default certainty is safe to assert unconditionally.
  if (r.status === "past-cap" && r.is_default_branch !== 0)
    throw new Error(`internal: run_unit_head ${where} is past-cap with is_default_branch=${r.is_default_branch ?? "null"} — past-cap rows are always a definite non-default`);
  // ---- policy disposition classification -------------------------------------------------------
  if (r.status === "policy-excluded") {
    if (r.policy_status === null)
      throw new Error(`internal: run_unit_head ${where} is status='policy-excluded' but carries no policy_status — the rule that dropped it is unknowable`);
    if (r.is_default_branch !== 0)
      throw new Error(`internal: run_unit_head ${where} is status='policy-excluded' with is_default_branch=${r.is_default_branch ?? "null"} — the default branch is always scanned and can never be a policy exclusion`);
    return;
  }
  if (r.policy_status === null) return; // the common, unlabelled case
  if (isScanAttemptStatus(r.status as UnitHeadStatus) && r.is_default_branch !== 1)
    throw new Error(`internal: run_unit_head ${where} is a ${r.status} row carrying policy_status=${JSON.stringify(r.policy_status)} but is_default_branch=${r.is_default_branch ?? "null"} — only the default branch is scan-attempted despite a policy verdict`);
  if (isDefaultOverride(r)) return;
  throw new Error(`internal: run_unit_head ${where} carries policy_status=${JSON.stringify(r.policy_status)} on status=${JSON.stringify(r.status)} — neither a policy exclusion nor a default-branch override`);
}
