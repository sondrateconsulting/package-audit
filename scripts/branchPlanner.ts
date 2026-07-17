// branchPlanner.ts — the ONE shared branch planner (PROMPT.md §5.B). Both the real scan
// (processRepo) and --plan (runPlan) classify branches through THIS module so their dispositions and
// counts can never diverge. Policy is applied BEFORE cutoff/cap: a denied recent branch must never
// consume a cap slot that an allowed older branch could have used (§5.B). Pure — no I/O, no DB.

import type { BranchHead, BranchSnapshot } from "./github.ts";
import { classifyBranch, coverageForName, isBranchPolicyEligible, type CompiledBranchPolicy, type PolicyResult, type RepoPolicyCoverage } from "./branchPolicy.ts";
import type { PolicyStatus } from "./db.ts";

// §5.B classification, pure: heads arrive sorted committedDate DESC. The repo's DEFAULT branch
// (matched by name; resolved by §5.B discovery from the SAME snapshot as these heads — never from the
// older §5.A REST listing, see github.ts::BranchSnapshot) is ALWAYS eligible — exempt from BOTH the cutoff
// filter and the cap — so the default-branch view the report's headline metrics depend on is
// never silently absent (a dormant default behind active feature branches, or one past the
// cap, must still be scanned). Every OTHER still-live branch before cutoffDate is
// `cutoffSkipped` (regardless of the cap); the after-cutoff survivors are `eligible` up to
// maxBranchesPerRepo (the cap counts NON-default branches only, so a repo can yield cap+1
// eligible units); older survivors past the cap are `pastCap` — NOT scanned this run, but still
// SURFACED: processRepo records a `past-cap` run_unit_head row for report visibility while leaving
// the WORK QUEUE untouched, so a prior 'done' scan survives and a later cap-order shift can promote
// the branch without a re-scan. ("Retains prior state" is about the work queue, never the report.)
// Order within each group preserves the input order. A defaultBranch
// not among the live heads admits nothing — heads are never synthesized. This runs over an
// ALREADY-policy-filtered head list (see planRepoBranches), so the cap counts only ELIGIBLE branches.
export interface BranchPlan {
  readonly cutoffSkipped: readonly BranchHead[];
  readonly eligible: readonly BranchHead[];
  readonly pastCap: readonly BranchHead[];
}
export function classifyBranchPlan(
  heads: readonly BranchHead[], cutoffDate: string, maxBranchesPerRepo: number, defaultBranch: string | null,
): BranchPlan {
  const cutoffSkipped: BranchHead[] = [];
  const eligible: BranchHead[] = [];
  const pastCap: BranchHead[] = [];
  let nonDefaultEligible = 0;
  for (const h of heads) {
    if (h.name === defaultBranch) eligible.push(h);
    else if (h.committedDate.slice(0, 10) < cutoffDate) cutoffSkipped.push(h);
    else if (nonDefaultEligible < maxBranchesPerRepo) {
      eligible.push(h);
      nonDefaultEligible++;
    } else pastCap.push(h);
  }
  return { cutoffSkipped, eligible, pastCap };
}

// A branch's full disposition: the head, whether it's the repo default, and its RAW
// (counterfactual) policy decision. `rawPolicyResult` may be `excluded-by-*` even for a branch that
// is scanned (the default-branch override) — the report records it as the "would have been excluded"
// fact. Which BUCKET a decision lands in encodes the cutoff/cap reason, so no separate field is needed.
export interface BranchDecision {
  readonly head: BranchHead;
  readonly isDefaultBranch: boolean;
  readonly rawPolicyResult: PolicyResult;
}

// Every discovered head lands in EXACTLY one bucket (a disjoint partition — the disposition-count
// identity the report's scanScope counts rest on).
// toScan/cutoffSkipped/pastCap are the cutoff/cap split of the POLICY-ELIGIBLE heads; policyExcluded
// are the NON-default heads policy dropped (they never reach cutoff/cap).
export interface RepoBranchPlan {
  readonly toScan: readonly BranchDecision[];
  readonly cutoffSkipped: readonly BranchDecision[];
  readonly pastCap: readonly BranchDecision[];
  readonly policyExcluded: readonly BranchDecision[];
  // The UNION over this repo's raw heads of every configured pattern that matched ≥1 head (warning-sweep
  // coverage, per list), plus the narrower deny set that matched a ≥1 NON-DEFAULT head. Folded into the
  // run-level warning finalizer: a configured pattern absent from EVERY discovered repo's coverage matched
  // nothing ("unmatched-pattern"); a deny pattern present in the wide set but in NO repo's non-default set
  // matched only defaults and therefore excluded nothing ("default-only-deny").
  readonly coverage: RepoPolicyCoverage;
}

// Classify every head — policy FIRST, then cutoff/cap over ONLY the policy-eligible set. Also sweeps
// unmatched-pattern coverage over EVERY raw head. classifyBranch and coverageForName may throw PolicyMatchError
// (a glob that THROWS at .match() time, fail-closed) — and coverage invokes patterns the WINNER
// matcher shadows, so a shadowed throwing glob fails HERE. This runs the WHOLE repo up-front, before
// any per-branch write, so such a throw aborts before this repo is half-classified; callers must let
// it propagate FATAL (never a per-repo/per-unit soft error — a denied branch must never be silently
// scanned). The fail-closed promise is scoped to the THROW class only: a malformed pattern Bun.Glob
// ACCEPTS without throwing (e.g. "[") is not an error anywhere — whatever it matches is applied
// normally ("[" matches nothing in the pinned test), and a pattern that matched NOTHING surfaces
// as an advisory unmatched-pattern warning (branchPolicy.ts's fail-closed contract states this scope; the
// "[" pin test in branchPlanner.test.ts executes it).
export function planRepoBranches(
  snapshot: BranchSnapshot,
  policy: CompiledBranchPolicy,
  cutoffDate: string,
  maxBranchesPerRepo: number,
): RepoBranchPlan {
  const { heads, defaultBranch } = snapshot;
  // FAIL-CLOSED snapshot invariant. listBranchHeads already rejects this pairing, so reaching it
  // means the snapshot did not come from a validated discovery — a hand-built test double, or a future
  // caller that reassembled `heads` and `defaultBranch` from different sources (exactly the stale-epoch
  // mistake BranchSnapshot exists to make unrepresentable). Planning it would be actively dangerous:
  // with no default, NO head can win the always-eligible exemption, so a restrictive policy would
  // exclude every branch and the repo would silently yield zero scanned units. Throw instead — the
  // whole-repo classification runs before any per-branch write, and processRepo lets this propagate
  // FATAL rather than degrade into a silent under-report.
  // `== null` (LOOSE) is deliberate and load-bearing: it catches `undefined` as well as `null`. The
  // shape this guard exists to catch is a hand-built double, and the commonest such shape is an
  // OMITTED key — which yields `undefined`, and `undefined === null` is false. A strict check would
  // therefore miss the exact case it was written for and let the snapshot through to be planned with
  // nothing default. This is the ONLY thing standing between that mistake and a silent zero-unit repo:
  // `name === defaultBranch` yields false for null AND undefined alike, so the classifier cannot
  // distinguish "no default" from "not the default" — it does not, and cannot, fail closed on its own.
  if (defaultBranch == null && heads.length > 0)
    throw new Error(
      `internal: branch snapshot has ${heads.length} head(s) but no default branch — refusing to plan (an unvalidated snapshot; policy would exclude every head)`,
    );
  const decisions = new Map<BranchHead, BranchDecision>();
  const matchedInclude = new Set<string>();
  const matchedExclude = new Set<string>();
  const matchedExcludeNonDefault = new Set<string>();
  for (const head of heads) {
    const c = classifyBranch(policy, head.name, defaultBranch);
    decisions.set(head, { head, isDefaultBranch: c.isDefaultBranch, rawPolicyResult: c.rawPolicyResult });
    // Coverage (for the unmatched-pattern warning): EVERY pattern that matched this head, both lists. Separate from the winner used
    // above (which short-circuits) — so a pattern shadowed for classification is still exercised here.
    const cov = coverageForName(policy, head.name);
    for (const p of cov.branches) matchedInclude.add(p);
    for (const p of cov.excludeBranches) matchedExclude.add(p);
    // ...and the narrower deny set that matched a NON-DEFAULT head — the only heads a deny can ever
    // drop. This loop is the one place a head's name and its default-ness are both in hand, so the
    // fact is captured here or nowhere. Shadowed patterns count here for the same reason as above:
    // the question is "could this pattern have excluded anything", not "did it win the race".
    if (!c.isDefaultBranch) for (const p of cov.excludeBranches) matchedExcludeNonDefault.add(p);
  }
  // Stable-filter to the policy-eligible heads (order preserved), then cutoff/cap ONLY those. A
  // non-default excluded head is dropped here — before nonDefaultEligible can increment for it — so
  // it cannot strand an allowed older branch behind the cap (policy-before-cutoff/cap, PROMPT.md §5.B).
  const eligibleHeads: BranchHead[] = [];
  const policyExcluded: BranchDecision[] = [];
  for (const head of heads) {
    const d = decisions.get(head)!;
    if (isBranchPolicyEligible(d)) eligibleHeads.push(head);
    else policyExcluded.push(d);
  }
  const plan = classifyBranchPlan(eligibleHeads, cutoffDate, maxBranchesPerRepo, defaultBranch);
  const decide = (hs: readonly BranchHead[]): BranchDecision[] => hs.map((h) => decisions.get(h)!);
  return {
    toScan: decide(plan.eligible), cutoffSkipped: decide(plan.cutoffSkipped), pastCap: decide(plan.pastCap),
    policyExcluded,
    coverage: {
      branches: [...matchedInclude],
      excludeBranches: [...matchedExclude],
      excludeBranchesMatchedByNonDefault: [...matchedExcludeNonDefault],
    },
  };
}

// Map a branch's RAW policy decision to the persisted (policy_status, policy_matched_pattern) pair
// (PROMPT.md §3). Only `excluded-by-deny` carries a pattern; `no-exclusion` carries neither. Applied
// unconditionally to scanned decisions — it yields (null, null) for the common eligible case.
export function policyAttribution(r: PolicyResult): {
  policyStatus: PolicyStatus | null;
  policyMatchedPattern: string | null;
} {
  switch (r.kind) {
    case "excluded-by-deny":
      return { policyStatus: "excluded-by-deny", policyMatchedPattern: r.matchedPattern };
    case "excluded-by-allow":
      return { policyStatus: "excluded-by-allow", policyMatchedPattern: null };
    case "no-exclusion":
      return { policyStatus: null, policyMatchedPattern: null };
  }
}

// Branch-policy diagnostics for the --plan surface — the plan-mode analog of the report's
// scanScope sub-counts (report.ts buildScanScope). `excludedByDeny`/`excludedByAllow` split the
// disjoint `policyExcluded` bucket; `defaultBranchPolicyOverrides` counts default branches a policy
// WOULD have excluded but that stay eligible (the override — an OVERLAPPING diagnostic within
// branchesEligible, never its own partition bucket). FAIL-CLOSED: a no-exclusion/default row inside
// `policyExcluded`, or a non-default excluded row inside `toScan`, is an impossible planner state
// (a bucket-wiring bug, not operator error) and throws — mirroring the run path's guard at
// orchestrate.ts's to-scan loop.
export interface PlanPolicyDiagnostics {
  readonly excludedByDeny: number;
  readonly excludedByAllow: number;
  readonly defaultBranchPolicyOverrides: number;
}
export function planPolicyDiagnostics(plan: RepoBranchPlan): PlanPolicyDiagnostics {
  let excludedByDeny = 0;
  let excludedByAllow = 0;
  for (const d of plan.policyExcluded) {
    if (isBranchPolicyEligible(d))
      throw new Error(`internal: policyExcluded carries a default/no-exclusion branch ${d.head.name} (planner bucket-wiring bug)`);
    if (d.rawPolicyResult.kind === "excluded-by-deny") excludedByDeny++;
    else excludedByAllow++;
  }
  // redundant given the loop's fail-closed guard, but pins the deny+allow = excluded invariant
  // against a future refactor of the counting logic.
  if (excludedByDeny + excludedByAllow !== plan.policyExcluded.length)
    throw new Error(`internal: policy sub-counts (${excludedByDeny}+${excludedByAllow}) != policyExcluded (${plan.policyExcluded.length})`);
  let defaultBranchPolicyOverrides = 0;
  for (const d of plan.toScan) {
    if (d.rawPolicyResult.kind === "no-exclusion") continue; // the common eligible case
    if (!d.isDefaultBranch)
      throw new Error(`internal: non-default toScan branch ${d.head.name} carries policy ${d.rawPolicyResult.kind} (planner bucket-wiring bug)`);
    defaultBranchPolicyOverrides++;
  }
  return { excludedByDeny, excludedByAllow, defaultBranchPolicyOverrides };
}
