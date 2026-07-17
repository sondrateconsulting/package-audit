// branchPolicy.ts — branch allow/deny policy engine.
//
// EAGER compilation of the configured pattern lists into a CompiledBranchPolicy that the
// classifier and the pattern-coverage sweep consume, plus the winner/coverage matching APIs.
//
// This module is a dependency LEAF: it imports nothing from config.ts (no Config, no ConfigError,
// no hashing), so config.ts can import IT — loadConfig() calls compileBranchPolicy() and wraps
// BranchPolicyError as ConfigError. It shares the canonicalizer with config_hash via the neutral
// patternCanonical module, so a compiled policy iterates patterns in exactly the order the hash
// was computed over.
//
// FAIL-CLOSED CONTRACT (critical — PROMPT.md §5.B: a glob that throws at match time is FATAL,
// never "no match"): Bun.Glob silently ACCEPTS
// malformed patterns. `new Bun.Glob("[")` does NOT throw — at construction OR at .match() time
// (`Bun.Glob("[").match(...)` returns false in the pinned branchPlanner test): an ACCEPTED
// malformed pattern is matched normally and may match some names or none (on Bun 1.4, `{a,[}`
// matches `a`); one that matches nothing surfaces via the advisory unmatched-pattern warning
// (when it stays uncovered and at least one repo was discovered). So eager construction here
// catches ONLY the patterns Bun throws on AT CONSTRUCTION — it is NOT a complete validator, and
// does not promise that every malformed pattern is rejected at load. The classifier MUST wrap every .match() call and turn any exception
// into a FATAL policy-evaluation error — NEVER `false`, because `false` is fail-OPEN for an
// exclude (a denied branch would be silently scanned). Empty-string and leading-"!" patterns are
// rejected earlier, at config validation (config.ts), as a deliberate policy-language restriction.

import { sortedDedup } from "./patternCanonical.ts";

// Thrown when a configured pattern cannot be compiled into a Bun.Glob. Own error type (not
// ConfigError) to keep this module a leaf; loadConfig() catches it and re-throws as ConfigError.
export class BranchPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchPolicyError";
  }
}

// One compiled pattern: its canonical source string plus the compiled Bun.Glob. Every pattern is
// compiled — there is no "pure literal" shortcut, because detecting a pure literal would duplicate
// Bun's glob grammar and drift from it. (The winner match still checks exact string equality
// FIRST; the compiled glob is what the fall-through and the coverage sweep use.)
export interface CompiledPattern {
  readonly pattern: string;
  readonly glob: Bun.Glob;
}

// The compiled policy the run uses. `include` preserves the semantic distinction between
// null (unrestricted — every branch eligible) and [] (nothing but the default branch eligible);
// `exclude` is always a list (config normalizes a null excludeBranches to []).
export interface CompiledBranchPolicy {
  readonly include: readonly CompiledPattern[] | null;
  readonly exclude: readonly CompiledPattern[];
}

function compileList(patterns: readonly string[], listName: string): readonly CompiledPattern[] {
  // Canonicalize FIRST, with the SAME canonicalizer config_hash uses, so the compiled order (which
  // determines the "first canonical-order glob" winner) matches the hash's view and never depends
  // on config-file order.
  return sortedDedup(patterns).map((pattern) => {
    let glob: Bun.Glob;
    try {
      glob = new Bun.Glob(pattern);
    } catch (e) {
      // A Bun.Glob CONSTRUCTION throw is the only malformed-pattern class catchable here (see the
      // fail-closed contract above). JSON.stringify keeps control characters out of the message.
      throw new BranchPolicyError(
        `${listName} pattern ${JSON.stringify(pattern)} is not a valid glob: ${(e as Error).message}`,
      );
    }
    return { pattern, glob };
  });
}

// Compile the include/exclude pattern lists into the run's policy. Inputs are the raw config
// strings (already string-validated by config.ts for empty / leading-"!"); this canonicalizes and
// compiles them. `include === null` means unrestricted and is preserved as null (distinct from []).
export function compileBranchPolicy(
  include: readonly string[] | null,
  exclude: readonly string[],
): CompiledBranchPolicy {
  return {
    include: include === null ? null : compileList(include, "branches"),
    exclude: compileList(exclude, "excludeBranches"),
  };
}

// ---- matching --------------------------------------------------------------------------------
// The winner/coverage APIs the classifier and the pattern sweep consume. They take a NAME
// (not a BranchHead) so this module stays a leaf; the run driver (orchestrate.ts) attaches the head.

// Which configured list a pattern came from — threaded through matching so a fatal match-time
// error names the operator-relevant list.
type PolicyListKind = "branches" | "excludeBranches";

// A fatal, operator-facing policy-evaluation failure: a compiled glob threw at .match() time.
// Bun.Glob accepts malformed patterns at construction, and no ACCEPTED pattern is known to throw
// at .match() on the Bun versions this project exercises ("[" returns false in the pinned case —
// the tests forge a throwing matcher to exercise this path). If one ever does, we FAIL CLOSED — a
// throw becomes this error, NEVER a `false` result
// (false for an exclude would be fail-OPEN: a denied branch silently scanned). Unlike
// BranchPolicyError (always converted to ConfigError at load), this surfaces DIRECTLY: the run
// driver (orchestrate.ts) calls db.failRun() and rethrows it unchanged, so it is registered in
// KNOWN_OPERATOR_ERRORS and rendered message-only.
export class PolicyMatchError extends Error {
  readonly listKind: PolicyListKind;
  readonly pattern: string;
  readonly branchName: string;
  constructor(listKind: PolicyListKind, pattern: string, branchName: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `branch policy pattern ${JSON.stringify(pattern)} (in ${listKind}) failed to match branch ${JSON.stringify(branchName)}: ${detail}`,
    );
    this.name = "PolicyMatchError";
    this.listKind = listKind;
    this.pattern = pattern;
    this.branchName = branchName;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

// The COUNTERFACTUAL policy decision for a branch (three outcomes that must never collapse):
export type PolicyResult =
  | { readonly kind: "excluded-by-deny"; readonly matchedPattern: string }
  | { readonly kind: "excluded-by-allow" } // include non-null and matched NOTHING
  | { readonly kind: "no-exclusion" }; //     unrestricted, or matched the allowlist

// The ONLY place .glob.match() is invoked. Wrapped so a match-time throw becomes a fatal
// PolicyMatchError — never `false`. The catch is scoped to the single .match() call so unrelated
// programming errors keep their stacks.
function safeMatch(p: CompiledPattern, listKind: PolicyListKind, name: string): boolean {
  try {
    return p.glob.match(name);
  } catch (cause) {
    throw new PolicyMatchError(listKind, p.pattern, name, cause);
  }
}

// Highest-precedence match in a canonical list: exact string equality across the WHOLE list first
// (no glob invoked — so an exact literal beats a glob that sorts earlier, e.g. "main" beats "*"),
// then the FIRST canonical-order glob that matches. null if none.
function matchWinner(
  list: readonly CompiledPattern[],
  listKind: PolicyListKind,
  name: string,
): CompiledPattern | null {
  for (const p of list) if (p.pattern === name) return p; // pass 1: exact, no glob call
  for (const p of list) if (safeMatch(p, listKind, name)) return p; // pass 2: first glob match
  return null;
}

// The counterfactual policy decision for a branch NAME, deny-before-allow. Computed for EVERY
// branch, INCLUDING the default (whose eligibility is overridden in classifyBranch) — so the
// "would have been denied by X" fact is preserved. May throw PolicyMatchError (fail-closed).
export function evaluateBranchPolicy(policy: CompiledBranchPolicy, name: string): PolicyResult {
  const deny = matchWinner(policy.exclude, "excludeBranches", name);
  if (deny !== null) return { kind: "excluded-by-deny", matchedPattern: deny.pattern };
  if (policy.include === null) return { kind: "no-exclusion" }; // unrestricted
  return matchWinner(policy.include, "branches", name) !== null
    ? { kind: "no-exclusion" }
    : { kind: "excluded-by-allow" };
}

// A branch's full classification. `eligible` is the AUTHORITATIVE scan-eligibility: the default
// branch is ALWAYS eligible; a non-default branch is eligible iff policy did not exclude it.
// `rawPolicyResult` is the RAW/counterfactual policy decision — for the default branch it may be
// `excluded-by-*` while `eligible` stays true. Anything deciding whether to SCAN must read
// `eligible`, never `rawPolicyResult` alone.
export interface BranchClassification {
  readonly isDefaultBranch: boolean;
  readonly eligible: boolean;
  readonly rawPolicyResult: PolicyResult;
}

// Classify a branch by name. `defaultBranch` is the repo's default branch NAME (not a boolean) so
// the classifier — not the caller — decides default-ness. It comes from the SAME GraphQL snapshot as
// the head being classified (github.ts::BranchSnapshot), never from the older REST listing. `null`
// means the repo has no default branch, which a validated snapshot only permits when it has no heads
// at all — so in practice this function is never called with null.
//
// The comparison is the bare `name === defaultBranch` simply because a `defaultBranch !== null &&`
// guard would be REDUNDANT: no head can be named null (listBranchHeads also rejects an empty name), so
// the equality is already false for a null default. The two forms are exactly equivalent — `null` and
// `undefined` both yield false either way — so the guard would add a condition that never changes an
// outcome.
//
// Note what that equivalence means, because it is easy to misread as a safety property: it is NOT one.
// With no default, `isDefaultBranch` is false for EVERY head, which violates the rule that the
// default branch is always scanned (nothing wins the always-eligible exemption, so a restrictive
// policy excludes the whole repo). This function CANNOT fail closed on that — from here "no default" and "not the default" are
// indistinguishable. Two callers upstream are what actually prevent it: listBranchHeads rejects an
// incoherent snapshot on the wire, and planRepoBranches refuses (`defaultBranch == null`, loose, so
// `undefined` is caught too) to plan heads with no default. Do not weaken either on the assumption
// that this comparison is defensive.
// May throw PolicyMatchError (fail-closed).
export function classifyBranch(
  policy: CompiledBranchPolicy,
  name: string,
  defaultBranch: string | null,
): BranchClassification {
  const isDefaultBranch = name === defaultBranch;
  const rawPolicyResult = evaluateBranchPolicy(policy, name);
  return {
    isDefaultBranch,
    eligible: isDefaultBranch || rawPolicyResult.kind === "no-exclusion",
    rawPolicyResult,
  };
}

// Every pattern in `list` that matches `name` (exact OR glob), in canonical order. May throw
// PolicyMatchError (fail-closed). NOTE: an exact match short-circuits WITHOUT invoking that
// pattern's glob, so this is NOT comprehensive glob validation (a malformed pattern exactly equal
// to a discovered name never throws here).
function coverageList(
  list: readonly CompiledPattern[],
  listKind: PolicyListKind,
  name: string,
): string[] {
  const out: string[] = [];
  for (const p of list) if (p.pattern === name || safeMatch(p, listKind, name)) out.push(p.pattern);
  return out;
}

// Coverage for BOTH lists, kept SEPARATE (the same string may legally appear in both). The
// unmatched-pattern warning sweep unions each list's matches across all discovered names to find
// configured patterns that matched nothing. An unrestricted (`include === null`) or empty include has no patterns to cover.
export interface PolicyCoverage {
  readonly branches: readonly string[];
  readonly excludeBranches: readonly string[];
}
export function coverageForName(policy: CompiledBranchPolicy, name: string): PolicyCoverage {
  return {
    branches: policy.include === null ? [] : coverageList(policy.include, "branches", name),
    excludeBranches: coverageList(policy.exclude, "excludeBranches", name),
  };
}
