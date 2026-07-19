// dims.ts — the ONE shared contract for the lifecycle proxy's raw-dimension capability (§U5).
// The sealable stderr proxy (lifecycle.ts) pins ink-facing columns/rows to safe positive integers,
// but exposes the REAL stream's raw values (undefined included) through getRawDims(); App.tsx reads
// THOSE for layout so §U5's EMPTY-frame discipline sees the truth, not the pinned fallback.
//
// Producer (lifecycle.ts) and consumer (App.tsx) share this ONE type so the getRawDims contract is
// compiler-checked end to end: rename the method here and the consumer's access stops compiling
// instead of silently falling through to the pinned dimensions. The trap key and the type's method
// name are the SAME literal (GET_RAW_DIMS), so they can never drift apart.
//
// Type-only + a single string const — dependency-free. App imports the types with `import type`
// (verbatimModuleSyntax erases them), so the display layer gains NO runtime edge into lifecycle.ts;
// only lifecycle.ts imports the GET_RAW_DIMS value, and it already owns this capability.

export interface RawDims {
  readonly columns: number | undefined;
  readonly rows: number | undefined;
}

// The property name the proxy serves and the type advertises — one source of truth for both.
export const GET_RAW_DIMS = "getRawDims" as const;

// Ink's stream surface plus the raw-dimension accessor the lifecycle proxy staples on.
export type DimsAwareStream = NodeJS.WriteStream & { [GET_RAW_DIMS](): RawDims };

// The ONE "usable dimension" predicate — a positive integer. Shared so activation eligibility
// (§U1), the render planner (§U5 planLayout), and the ink-facing proxy pin can never disagree on
// what counts as renderable: NaN/Infinity/fractions/0/negatives/undefined all fail here, exactly
// once. Each old site carried a "must agree" comment; this makes them agree by construction.
// Takes `unknown` so the lifecycle pin (which reads off an untyped stream) and the number|undefined
// callers share it; narrows to `number` for the callers that need the guard.
export function isPositiveIntegerDim(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}
