// repositoryPolicy.ts — repository denylist engine (the repo-grain analog of branchPolicy.ts).
//
// EAGER compilation of the configured `excludeRepositories` patterns into a CompiledRepositoryPolicy
// the classifier consumes, plus the fail-closed boolean predicate `classifyRepository`.
//
// This module is a dependency LEAF: it imports nothing from config.ts (no Config, no ConfigError, no
// hashing), so config.ts can import IT — loadConfig() calls compileRepositoryPolicy() and wraps
// RepositoryPolicyError as ConfigError. It shares the ASCII fold + sort/dedup with config_hash via the
// neutral patternCanonical module, so a compiled policy iterates patterns in exactly the order (and the
// case-folded form) the hash was computed over.
//
// INDEPENDENT of branchPolicy.ts by DESIGN (a locked decision): the two policies diverge in case
// sensitivity (repos fold ASCII-lowercase; branches are case-sensitive), list kinds (deny-only here; an
// include/exclude pair there), attribution (none here — a plain boolean; a winner there), and warning
// coverage (none here). A shared glob primitive would need options for all of that to save ~5 lines
// while destabilizing shipped branch code, so the ~5-line fail-closed wrapper (safeMatch) is duplicated
// deliberately, NOT extracted.
//
// FAIL-CLOSED CONTRACT (critical — a glob that throws at match time is FATAL, never "no match"):
// Bun.Glob silently ACCEPTS malformed patterns (`new Bun.Glob("[")` does not throw, at construction OR
// at .match()), so eager construction here catches ONLY the patterns Bun throws on AT CONSTRUCTION — it
// is NOT a complete validator. The classifier MUST wrap every .match() call and turn any exception into
// a FATAL error — NEVER `false`, because `false` is fail-OPEN for a denylist (a denied repo would be
// silently scanned). Empty-string and leading-"!" patterns are rejected earlier, at config validation
// (config.ts, validateRepoPattern).

import { sortedDedup, toAsciiLower } from "./patternCanonical.ts";

// Thrown when a configured pattern cannot be compiled into a Bun.Glob. Own error type (not ConfigError)
// to keep this module a leaf; loadConfig() catches it and re-throws as ConfigError. No accepted pattern
// is known to throw at construction on the exercised Bun versions, so this is a defensive/forward-compat
// guard (mirroring BranchPolicyError) — the real protection is the classifier's match-time handling.
export class RepositoryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryPolicyError";
  }
}

// A fatal, operator-facing policy-evaluation failure: a compiled glob threw at .match() time. If one
// ever does, we FAIL CLOSED — the throw becomes this error, NEVER a `false` result (false for a
// denylist would be fail-OPEN: a denied repo silently scanned). Unlike RepositoryPolicyError (always
// converted to ConfigError at load), this surfaces DIRECTLY: the run driver (orchestrate.ts) calls
// db.failRun() and rethrows it unchanged, so it is registered in KNOWN_OPERATOR_ERRORS (cliErrors.ts)
// and rendered message-only. `ownerRepoLower` is the ASCII-folded `owner/repo` the classifier was matching.
export class RepoPolicyMatchError extends Error {
  readonly pattern: string;
  readonly ownerRepoLower: string;
  constructor(pattern: string, ownerRepoLower: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `excludeRepositories pattern ${JSON.stringify(pattern)} failed to match repository ${JSON.stringify(ownerRepoLower)}: ${detail}`,
    );
    this.name = "RepoPolicyMatchError";
    this.pattern = pattern;
    this.ownerRepoLower = ownerRepoLower;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

// One compiled pattern: its canonical (ASCII-folded) source string plus the compiled Bun.Glob. The
// source is stored EXPLICITLY — Bun.Glob exposes no reliable source accessor, and neither comparing
// glob objects nor calling .match() can establish the textual equality classifyRepository needs for its
// exact-first pass (and for a diagnostic that names the offending pattern).
export interface CompiledRepositoryPattern {
  readonly pattern: string;
  readonly glob: Bun.Glob;
}

// The compiled denylist. Deny-only, so a bare list (no include/exclude split, unlike CompiledBranchPolicy).
export type CompiledRepositoryPolicy = readonly CompiledRepositoryPattern[];

// Compile the raw config patterns (already string-validated by config.ts for empty / leading-"!") into
// the run's denylist. Patterns are ASCII-folded then sortedDedup — the SAME projection config_hash uses
// (patternCanonical) — so the compiled order and case-folded form match the hash's view exactly, and
// case-only duplicates collapse to one compiled glob. A construction throw becomes RepositoryPolicyError.
export function compileRepositoryPolicy(patterns: readonly string[]): CompiledRepositoryPolicy {
  return sortedDedup(patterns.map(toAsciiLower)).map((pattern) => {
    let glob: Bun.Glob;
    try {
      glob = new Bun.Glob(pattern);
    } catch (e) {
      // A Bun.Glob CONSTRUCTION throw is the only malformed-pattern class catchable here (see the
      // fail-closed contract above). JSON.stringify keeps control characters out of the message.
      throw new RepositoryPolicyError(
        `excludeRepositories pattern ${JSON.stringify(pattern)} is not a valid glob: ${(e as Error).message}`,
      );
    }
    return { pattern, glob };
  });
}

// The ONLY place .glob.match() is invoked. Wrapped so a match-time throw becomes a fatal
// RepoPolicyMatchError — never `false`. The catch is scoped to the single .match() call so unrelated
// programming errors keep their stacks. Duplicated (not shared with branchPolicy's safeMatch) by design.
function safeMatch(p: CompiledRepositoryPattern, ownerRepoLower: string): boolean {
  try {
    return p.glob.match(ownerRepoLower);
  } catch (cause) {
    throw new RepoPolicyMatchError(p.pattern, ownerRepoLower, cause);
  }
}

// Is this repository denylisted? `ownerRepo` is the `owner/repo` full name in ORIGINAL case; this
// function folds it INTERNALLY (ASCII, via toAsciiLower) to the compiled patterns' folded form, so a
// caller can never fail OPEN by forgetting to pre-fold. The fold is idempotent (an already-folded
// argument is unchanged), so the single production caller passes the raw name straight through.
//
// SINGLE pass in canonical order: for each pattern, check EXACT equality FIRST, then its glob. Returns
// true on the first pattern that matches either way; false if none match. Two properties matter:
//   - Exact-equality-FIRST is a fail-closed requirement, not an optimization: isCanonicalIdentity
//     (github.ts) does not enforce the full GitHub name grammar and githubHost is configurable, so a
//     repo name CAN contain glob metacharacters (`*?{}[]`). A pattern literally naming such a repo
//     compiles as a glob that may NOT match the literal (e.g. `acme/repo[x]` as a glob matches
//     `acme/repox`, not the literal `acme/repo[x]`); the exact pass catches the literal before its glob
//     runs, so such a repo is never let through.
//   - It is exact-first PER PATTERN, in canonical order — NOT a whole-list exact pass first (that is
//     branchPolicy's two-pass winner search, which this module deliberately does not need: there is no
//     winner attribution). Consequence: a throwing glob that sorts BEFORE an exact-name entry makes the
//     whole classification FATAL (safeMatch rethrows) rather than reaching that later exact match. That
//     is an availability difference from branchPolicy, and it is the correct fail-closed behavior — the
//     repo is never silently scanned.
export function classifyRepository(policy: CompiledRepositoryPolicy, ownerRepo: string): boolean {
  const ownerRepoLower = toAsciiLower(ownerRepo); // fold HERE (idempotent) — the fail-closed guarantee a caller can't drop
  for (const p of policy) {
    if (p.pattern === ownerRepoLower) return true; // exact-equality first (fail-closed for metachar names)
    if (safeMatch(p, ownerRepoLower)) return true; // then the fail-closed glob
  }
  return false;
}
