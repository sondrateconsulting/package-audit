// policyWarnings.ts — the advisory branch-policy warning contract (§8). PURE: it never invokes a
// glob (the matchers ran EAGERLY during discovery, inside planRepoBranches, so a glob that throws at
// .match() time already failed closed there) — this is only set difference + rendering. A malformed
// pattern Bun.Glob ACCEPTS without ever throwing (e.g. "[") is NOT an error anywhere: it matches
// nothing, and THIS advisory surface — the unmatched-pattern warning — is exactly how the operator
// learns such a configured pattern is dead (branchPolicy.ts's fail-closed contract states the throw
// scope). Warnings are ADVISORY: they never fail a run, and are NOT recorded in the DB / errors /
// report.
import type { CompiledBranchPolicy, PolicyCoverage } from "./branchPolicy.ts";

export type PolicyWarning =
  | { readonly kind: "empty-allowlist" }
  | { readonly kind: "unmatched-pattern"; readonly direction: "deny" | "allow"; readonly pattern: string };

// `branches: []` — an EMPTY allowlist (distinct from `null` = unrestricted): only default branches are
// policy-eligible. Emitted ONCE, UNCONDITIONALLY, at mode entry (so it fires even when discovery then
// fails). `include === null` is unrestricted and warns nothing.
export const isEmptyAllowlist = (policy: CompiledBranchPolicy): boolean =>
  policy.include !== null && policy.include.length === 0;

// Configured patterns that matched NO discovered branch anywhere — one "unmatched-pattern" warning
// each. PURE set difference over the per-repo coverage collected during discovery. SUPPRESSED entirely
// when ZERO repos were discovered successfully (can't call a pattern unused if we never saw a branch).
// Deterministic order: the compiled canonical lists (deny then allow), NEVER Set insertion order.
export function computeUnmatchedWarnings(
  policy: CompiledBranchPolicy,
  coverages: readonly PolicyCoverage[],
): PolicyWarning[] {
  if (coverages.length === 0) return []; // no successfully-discovered repo → suppress
  const matchedInclude = new Set<string>();
  const matchedExclude = new Set<string>();
  for (const c of coverages) {
    for (const p of c.branches) matchedInclude.add(p);
    for (const p of c.excludeBranches) matchedExclude.add(p);
  }
  const out: PolicyWarning[] = [];
  for (const p of policy.exclude) if (!matchedExclude.has(p.pattern)) out.push({ kind: "unmatched-pattern", direction: "deny", pattern: p.pattern });
  if (policy.include !== null)
    for (const p of policy.include) if (!matchedInclude.has(p.pattern)) out.push({ kind: "unmatched-pattern", direction: "allow", pattern: p.pattern });
  return out;
}

// The advisory summary section (stderr): a compact header + one line per warning. Patterns render via
// JSON.stringify so quotes/newlines/control chars can't corrupt the layout. Empty when no warnings.
export function policyWarningLines(warnings: readonly PolicyWarning[]): string[] {
  if (warnings.length === 0) return [];
  const lines = [`  Branch-policy warnings: ${warnings.length} (advisory)`];
  for (const w of warnings) {
    lines.push(
      w.kind === "empty-allowlist"
        ? `    empty allowlist: only repository default branches are policy-eligible`
        : `    ${w.direction} pattern ${JSON.stringify(w.pattern)} matched no discovered branch`,
    );
  }
  return lines;
}
