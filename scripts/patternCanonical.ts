// patternCanonical.ts — the ONE canonicalizer for string-pattern lists.
//
// A single, neutral leaf module (imports nothing from config.ts) so both config.ts (config_hash)
// and branchPolicy.ts (policy compilation) — and the unmatched-pattern warning sweep — share exactly one
// implementation. Two separately-maintained "sorted order" implementations could silently drift,
// and startRun() resumes purely by config_hash: if hashing and matching disagreed on order, a
// resumed run could enforce a different policy than the one its hash represents.
//
// Contract (intentionally minimal — matching must be predictable and the hash must be stable):
//   - EXACT-string set dedup: two entries are "the same" iff their UTF-16 code-unit sequences are
//     identical. No trimming, case-folding, locale collation, or Unicode normalization.
//   - Deterministic order: the default Array.prototype.sort (UTF-16 code-unit ascending). No
//     locale awareness.
// Consequences: reordering or duplicating entries never changes the result; any different
// code-unit sequence always does. Consumers receive already-canonical output and must NOT sort
// again.
export function sortedDedup(patterns: readonly string[]): string[] {
  return [...new Set(patterns)].sort();
}
