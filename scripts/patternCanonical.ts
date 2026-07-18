// patternCanonical.ts — the neutral home for shared string-pattern canonicalizers.
//
// A single, neutral leaf module (imports nothing from config.ts) so config.ts (config_hash),
// branchPolicy.ts (policy compilation), repositoryPolicy.ts (repo denylist compilation + matching),
// and the unmatched-pattern warning sweep share exactly one implementation of each primitive. Two
// separately-maintained copies could silently drift, and startRun() resumes purely by config_hash:
// if hashing and matching disagreed on order (or on the case fold), a resumed run could enforce a
// different policy than the one its hash represents.

// sortedDedup — the ONE order/dedup canonicalizer for pattern lists.
//
// Contract (intentionally minimal — matching must be predictable and the hash must be stable):
//   - EXACT-string set dedup: two entries are "the same" iff their UTF-16 code-unit sequences are
//     identical. sortedDedup itself does NO trimming, case-folding, locale collation, or Unicode
//     normalization (a case-INSENSITIVE consumer folds with toAsciiLower FIRST, then calls this).
//   - Deterministic order: the default Array.prototype.sort (UTF-16 code-unit ascending). No
//     locale awareness.
// Consequences: reordering or duplicating entries never changes the result; any different
// code-unit sequence always does. Consumers receive already-canonical output and must NOT sort
// again.
export function sortedDedup(patterns: readonly string[]): string[] {
  return [...new Set(patterns)].sort();
}

// toAsciiLower — an EXPLICIT ASCII-only lowercase fold: A-Z (0x41-0x5A) → a-z, every other code unit
// untouched. Deliberately NOT String.prototype.toLowerCase, which does Unicode/locale case conversion.
//
// GitHub owner/repo identity case-insensitivity is ASCII-based, and a RepoInfo identity CAN carry
// non-ASCII (isCanonicalIdentity, github.ts, does not enforce the full name grammar, and githubHost is
// configurable — GHES/legacy hosts differ). A Unicode fold could collapse two distinct GHES identities
// that the host treats as different (e.g. a dotted-I locale), silently over-excluding. The regex class
// [A-Z] matches ONLY the ASCII range, so this fold can never touch a non-ASCII byte.
//
// This is the SINGLE canonicalizer used for BOTH repository-denylist matching AND the config_hash
// projection of excludeRepositories, so the two can never disagree on which repos a pattern covers.
export function toAsciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}
