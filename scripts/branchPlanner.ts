// branchPlanner.ts — the ONE shared branch planner (branch allow/deny §1/§12). Both the real scan
// (processRepo) and --plan (runPlan) classify branches through THIS module so their dispositions and
// counts can never diverge. Policy is applied BEFORE cutoff/cap: a denied recent branch must never
// consume a cap slot that an allowed older branch could have used (§12). Pure — no I/O, no DB.

import type { BranchHead } from "./github.ts";
import { classifyBranch, coverageForName, type CompiledBranchPolicy, type PolicyResult, type PolicyCoverage } from "./branchPolicy.ts";
import type { PolicyStatus } from "./db.ts";

// §5.B classification, pure: heads arrive sorted committedDate DESC. The repo's DEFAULT branch
// (matched by name; known from §5.A discovery) is ALWAYS eligible — exempt from BOTH the cutoff
// filter and the cap — so the default-branch view the report's headline metrics depend on is
// never silently absent (CV2: a dormant default behind active feature branches, or one past the
// cap, must still be scanned). Every OTHER still-live branch before cutoffDate is
// `cutoffSkipped` (regardless of the cap); the after-cutoff survivors are `eligible` up to
// maxBranchesPerRepo (the cap counts NON-default branches only, so a repo can yield cap+1
// eligible units); older survivors past the cap are `pastCap` (they retain prior state and are
// not surfaced this run). Order within each group preserves the input order. A defaultBranch
// not among the live heads admits nothing — heads are never synthesized. This runs over an
// ALREADY-policy-filtered head list (see planRepoBranches), so the cap counts only ELIGIBLE branches.
export interface BranchPlan {
  readonly cutoffSkipped: readonly BranchHead[];
  readonly eligible: readonly BranchHead[];
  readonly pastCap: readonly BranchHead[];
}
export function classifyBranchPlan(
  heads: readonly BranchHead[], cutoffDate: string, maxBranchesPerRepo: number, defaultBranch: string,
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

// A branch's full T6 disposition: the head, whether it's the repo default, and its RAW
// (counterfactual) policy decision. `rawPolicyResult` may be `excluded-by-*` even for a branch that
// is scanned (the default-branch override) — the report records it as the "would have been excluded"
// fact. Which BUCKET a decision lands in encodes the cutoff/cap reason, so no separate field is needed.
export interface BranchDecision {
  readonly head: BranchHead;
  readonly isDefaultBranch: boolean;
  readonly rawPolicyResult: PolicyResult;
}

// Every discovered head lands in EXACTLY one bucket (a disjoint partition — the §5 count identity).
// toScan/cutoffSkipped/pastCap are the cutoff/cap split of the POLICY-ELIGIBLE heads; policyExcluded
// are the NON-default heads policy dropped (they never reach cutoff/cap).
export interface RepoBranchPlan {
  readonly toScan: readonly BranchDecision[];
  readonly cutoffSkipped: readonly BranchDecision[];
  readonly pastCap: readonly BranchDecision[];
  readonly policyExcluded: readonly BranchDecision[];
  // The UNION over this repo's raw heads of every configured pattern that matched ≥1 head (§8 coverage,
  // per list). Folded into the run-level warning finalizer: a configured pattern absent from EVERY
  // discovered repo's coverage matched nothing and warrants an "unmatched-pattern" warning.
  readonly coverage: PolicyCoverage;
}

// Classify every head — policy FIRST, then cutoff/cap over ONLY the policy-eligible set. Also sweeps
// coverage over EVERY raw head (§8/§12). classifyBranch and coverageForName may throw PolicyMatchError
// (a malformed glob, fail-closed) — and coverage invokes patterns the WINNER matcher shadows, so a
// shadowed malformed glob fails HERE. This runs the WHOLE repo up-front, before any per-branch write,
// so such a throw aborts before this repo is half-classified; callers must let it propagate FATAL
// (never a per-repo/per-unit soft error — a denied branch must never be silently scanned).
export function planRepoBranches(
  heads: readonly BranchHead[],
  policy: CompiledBranchPolicy,
  cutoffDate: string,
  maxBranchesPerRepo: number,
  defaultBranch: string,
): RepoBranchPlan {
  const decisions = new Map<BranchHead, BranchDecision>();
  const matchedInclude = new Set<string>();
  const matchedExclude = new Set<string>();
  for (const head of heads) {
    const c = classifyBranch(policy, head.name, defaultBranch);
    decisions.set(head, { head, isDefaultBranch: c.isDefaultBranch, rawPolicyResult: c.rawPolicyResult });
    // Coverage (§8): EVERY pattern that matched this head, both lists. Separate from the winner used
    // above (which short-circuits) — so a pattern shadowed for classification is still exercised here.
    const cov = coverageForName(policy, head.name);
    for (const p of cov.branches) matchedInclude.add(p);
    for (const p of cov.excludeBranches) matchedExclude.add(p);
  }
  // Stable-filter to the policy-eligible heads (order preserved), then cutoff/cap ONLY those. A
  // non-default excluded head is dropped here — before nonDefaultEligible can increment for it — so
  // it cannot strand an allowed older branch behind the cap (§12).
  const eligibleHeads: BranchHead[] = [];
  const policyExcluded: BranchDecision[] = [];
  for (const head of heads) {
    const d = decisions.get(head)!;
    if (d.isDefaultBranch || d.rawPolicyResult.kind === "no-exclusion") eligibleHeads.push(head);
    else policyExcluded.push(d);
  }
  const plan = classifyBranchPlan(eligibleHeads, cutoffDate, maxBranchesPerRepo, defaultBranch);
  const decide = (hs: readonly BranchHead[]): BranchDecision[] => hs.map((h) => decisions.get(h)!);
  return {
    toScan: decide(plan.eligible), cutoffSkipped: decide(plan.cutoffSkipped), pastCap: decide(plan.pastCap),
    policyExcluded, coverage: { branches: [...matchedInclude], excludeBranches: [...matchedExclude] },
  };
}

// Map a branch's RAW policy decision to the persisted (policy_status, policy_matched_pattern) pair
// (§3). Only `excluded-by-deny` carries a pattern; `no-exclusion` carries neither. Applied
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
