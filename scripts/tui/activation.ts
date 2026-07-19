// activation.ts — the PURE TUI activation decision (§U1 of PROMPT-TUI.md). React-free and
// Ink-free so orchestrate.ts can import it on every run; the function IS the §U1 matrix,
// unit-tested row by row. Activation is CLI flags + runtime environment only — NO config.json
// keys (config_hash is untouchable).

// Operator-facing: `--ui` demanded in an ineligible environment. Registered in
// KNOWN_OPERATOR_ERRORS so the entrypoint renders the message without a stack.
export class TuiActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TuiActivationError";
  }
}

export interface ActivationInput {
  plan: boolean;
  uiFlag: boolean | null; // from OrchestrateArgs; null = auto
  stderrIsTTY: boolean;
  stdoutIsTTY: boolean; // decides the divert, never eligibility
  columns: number | undefined; // stderr dimensions; undefined is ineligible
  rows: number | undefined;
  term: string | undefined; // TERM
  ci: boolean; // ink's is-in-ci truthiness — compute via isInkCiEnv below, never a bare CI check
}

// Ink decides "CI" through its pinned is-in-ci dependency, and the activation gate must use
// the SAME definition or the two disagree exactly where it matters: the gate would mount a
// renderer that defers every frame to unmount (a dead dashboard over a diverted stdout), or
// refuse one that would render fine. Mirrors node_modules/is-in-ci/index.js verbatim: CI or
// CONTINUOUS_INTEGRATION present (empty string included), with literal "0"/"false" treated as
// unset. RECORDED DEVIATION (PR body): §U1's letter defines the input as "CI set and
// non-empty", but its own stated ground — "Ink itself degrades under CI" — is DEFINED by
// is-in-ci, so the predicate follows the ground, not the letter. The mount gate's IN_CI
// (mount.test.ts) imports this same helper: one definition of "CI" everywhere.
export function isInkCiEnv(env: Record<string, string | undefined>): boolean {
  const set = (key: string): boolean => key in env && env[key] !== "0" && env[key] !== "false";
  return set("CI") || set("CONTINUOUS_INTEGRATION");
}

export type ActivationDecision =
  | { mode: "off" }
  | { mode: "on"; divert: boolean }
  | { mode: "error"; message: string }; // --ui in an ineligible environment

export const MIN_COLUMNS = 40;
export const MIN_ROWS = 5;

// The environment can host a live stderr dashboard: interactive stderr TTY, a terminal that can
// render (TERM != dumb), not CI (Ink degrades there and CI consumers expect stdout JSONL — auto
// mode must never divert in CI), and at least the 40x5 floor. Undefined dimensions are
// ineligible. A terminal that SHRINKS below the floor mid-run is a render concern (§U5), never
// an activation concern.
//
// The size check is POSITIVE ("dimensions are usable integers at/above the floor"), never a
// less-than blocker test: `NaN < 40` is false, so a blocker-shaped check would wave NaN (and
// Infinity/fractions) through eligibility — mounting a dashboard that renders the EMPTY frame
// while the divert reroutes JSONL with nothing visible. Same positive-integer predicate as the
// render layer (planLayout) and the proxy's ink-facing pin.
const usableDim = (v: number | undefined, min: number): boolean => v !== undefined && Number.isInteger(v) && v >= min;

function eligibility(i: ActivationInput): { eligible: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!i.stderrIsTTY) blockers.push("stderr is not a TTY");
  if (i.term === "dumb") blockers.push("TERM is 'dumb'");
  if (i.ci) blockers.push("CI is set");
  if (!usableDim(i.columns, MIN_COLUMNS) || !usableDim(i.rows, MIN_ROWS))
    blockers.push(`terminal is ${i.columns ?? "?"}x${i.rows ?? "?"} (needs at least ${MIN_COLUMNS}x${MIN_ROWS})`);
  return { eligible: blockers.length === 0, blockers };
}

// NO_COLOR is deliberately NOT consulted: it affects styling only (Ink's chalk honors it),
// never routing.
export function decideTuiActivation(i: ActivationInput): ActivationDecision {
  // plan → off. The `--ui --plan` combination never reaches here — args.ts rejected it.
  if (i.plan) return { mode: "off" };
  if (i.uiFlag === false) return { mode: "off" };
  const { eligible, blockers } = eligibility(i);
  if (i.uiFlag === true && !eligible) {
    // An ineligible ENVIRONMENT is an operator error only when the operator explicitly demanded
    // the UI; auto mode just runs without it.
    return {
      mode: "error",
      message: `--ui requires an interactive stderr terminal: TTY, TERM not 'dumb', not CI, at least ${MIN_COLUMNS}x${MIN_ROWS} (blocked by: ${blockers.join("; ")})`,
    };
  }
  if (i.uiFlag === true || eligible) {
    // The divert exists for exactly one reason: with both streams on the same terminal, raw
    // JSONL would interleave with the dashboard frame. It fires ONLY when the TUI mounts AND
    // stdout is a TTY; every other cell leaves stdout byte-identical to today.
    return { mode: "on", divert: i.stdoutIsTTY };
  }
  return { mode: "off" };
}
