// branchPolicy.ts — branch allow/deny policy engine.
//
// T2 scope: EAGER compilation of the configured pattern lists into a CompiledBranchPolicy that the
// classifier (T3) and pattern sweep (T7) consume. The winner/coverage MATCHING APIs are added in
// T3; this file starts as the compilation half only.
//
// This module is a dependency LEAF: it imports nothing from config.ts (no Config, no ConfigError,
// no hashing), so config.ts can import IT — loadConfig() calls compileBranchPolicy() and wraps
// BranchPolicyError as ConfigError. It shares the canonicalizer with config_hash via the neutral
// patternCanonical module, so a compiled policy iterates patterns in exactly the order the hash
// was computed over.
//
// FAIL-CLOSED CONTRACT (critical — see the v4 mapping spec §9): Bun.Glob silently ACCEPTS
// malformed patterns. `new Bun.Glob("[")` does NOT throw; it fails only at .match() time, and only
// for some inputs. So eager construction here catches ONLY the patterns Bun throws on AT
// CONSTRUCTION — it is NOT a complete validator, and does not promise that every malformed pattern
// is rejected at load. The classifier (T3) MUST wrap every .match() call and turn any exception
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
// Bun's glob grammar and drift from it. (T3's winner match still checks exact string equality
// FIRST; the compiled glob is what the fall-through and the T7 coverage sweep use.)
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
  // determines T3's "first canonical-order glob" winner) matches the hash's view and never depends
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
