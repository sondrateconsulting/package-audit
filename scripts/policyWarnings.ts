// policyWarnings.ts — the advisory branch-policy warning contract. PURE: it never invokes a
// glob (the matchers ran EAGERLY during discovery, inside planRepoBranches, so a glob that throws at
// .match() time already failed closed there) — this is only set difference + rendering. A malformed
// pattern Bun.Glob ACCEPTS without throwing (e.g. "[") is NOT an error anywhere: whatever it matches
// applies normally, and a configured pattern that matched NOTHING ("[" in the pinned test) is
// exactly what THIS advisory surface — the unmatched-pattern warning — reports as dead
// (branchPolicy.ts's fail-closed contract states the throw scope). Warnings are ADVISORY: they
// never fail a run, and are NOT recorded in the DB / errors / report.
//
// The surface answers ONE question: did your policy do something OTHER than what you'd assume? Two of
// the three kinds report a DEAD rule — it matched no branch at all, or (deny only) its only matches
// were DEFAULT branches, which are always scanned, so it excluded nothing. The second is the more
// surprising: the rule matched and was overridden anyway. It is not redundant with the "N
// default-branch policy override(s)" count, which is branch-level, folds deny and allow together,
// cannot show that a SPECIFIC pattern was globally dead, and is printed only by `--plan`
// (runSummaryText omits it, so a real run would otherwise report nothing at all).
// `empty-allowlist` is the INVERSE and must not be described as a dead rule: `branches: []` is doing a
// great deal — dropping every non-default branch — and warns because that is easy to write by accident,
// not because it is inert.
import type { CompiledBranchPolicy, RepoPolicyCoverage } from "./branchPolicy.ts";

export type PolicyWarning =
  | { readonly kind: "empty-allowlist" }
  | { readonly kind: "unmatched-pattern"; readonly direction: "deny" | "allow"; readonly pattern: string }
  | { readonly kind: "default-only-deny"; readonly pattern: string };

// `branches: []` — an EMPTY allowlist (distinct from `null` = unrestricted): only default branches are
// policy-eligible. Emitted ONCE, UNCONDITIONALLY, at mode entry (so it fires even when discovery then
// fails). `include === null` is unrestricted and warns nothing.
export const isEmptyAllowlist = (policy: CompiledBranchPolicy): boolean =>
  policy.include !== null && policy.include.length === 0;

// Configured patterns that are DEAD — one warning each. PURE set algebra over the per-repo coverage
// collected during discovery. SUPPRESSED entirely when ZERO repos were discovered successfully (can't
// call a pattern unused if we never saw a branch).
//
// The two deny predicates are mutually exclusive, evaluated in ONE pass over the canonical deny list,
// so a pattern yields at most one warning:
//   matched nothing anywhere                  -> unmatched-pattern (deny)
//   matched, but never a NON-default branch   -> default-only-deny
//   matched some non-default branch somewhere -> silent (it did real work)
// Both predicates are GLOBAL, never per-repo: ONE non-default match in ANY discovered repo makes the
// pattern live, and warning about the repos where it happened to hit only a default would be noise
// for the ordinary portable config (`excludeBranches: ["legacy/*"]` across an estate where only some
// repos have such a branch). Deterministic order: the compiled canonical lists (deny then allow),
// NEVER Set insertion order.
export function computePolicyWarnings(
  policy: CompiledBranchPolicy,
  coverages: readonly RepoPolicyCoverage[],
): PolicyWarning[] {
  if (coverages.length === 0) return []; // no successfully-discovered repo → suppress
  const matchedInclude = new Set<string>();
  const matchedExclude = new Set<string>();
  const matchedExcludeNonDefault = new Set<string>();
  for (const c of coverages) {
    for (const p of c.branches) matchedInclude.add(p);
    for (const p of c.excludeBranches) matchedExclude.add(p);
    for (const p of c.excludeBranchesMatchedByNonDefault) matchedExcludeNonDefault.add(p);
  }
  const out: PolicyWarning[] = [];
  for (const p of policy.exclude) {
    if (!matchedExclude.has(p.pattern)) out.push({ kind: "unmatched-pattern", direction: "deny", pattern: p.pattern });
    else if (!matchedExcludeNonDefault.has(p.pattern)) out.push({ kind: "default-only-deny", pattern: p.pattern });
  }
  if (policy.include !== null)
    for (const p of policy.include) if (!matchedInclude.has(p.pattern)) out.push({ kind: "unmatched-pattern", direction: "allow", pattern: p.pattern });
  return out;
}

// The advisory summary section (stderr): a compact header + one line per warning. Patterns render via
// JSON.stringify so quotes/newlines/control chars can't corrupt the layout. Empty when no warnings.
// The default-only-deny wording deliberately does NOT say the pattern "caused" an override: coverage
// counts every pattern that MATCHED a head, including ones shadowed by an earlier deny, so the honest
// claim is about what the pattern matched — not about which rule won.
export function policyWarningLines(warnings: readonly PolicyWarning[]): string[] {
  if (warnings.length === 0) return [];
  const lines = [`  Branch-policy warnings: ${warnings.length} (advisory)`];
  for (const w of warnings) {
    if (w.kind === "empty-allowlist") lines.push(`    empty allowlist: only repository default branches are policy-eligible`);
    else if (w.kind === "default-only-deny")
      lines.push(`    deny pattern ${JSON.stringify(w.pattern)} matched only discovered default branches — the default branch is always scanned, so it excluded nothing`);
    else lines.push(`    ${w.direction} pattern ${JSON.stringify(w.pattern)} matched no discovered branch`);
  }
  return lines;
}
