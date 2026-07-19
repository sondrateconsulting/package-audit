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
  ci: boolean; // CI set and non-empty
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
function eligibility(i: ActivationInput): { eligible: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!i.stderrIsTTY) blockers.push("stderr is not a TTY");
  if (i.term === "dumb") blockers.push("TERM is 'dumb'");
  if (i.ci) blockers.push("CI is set");
  if ((i.columns ?? 0) < MIN_COLUMNS || (i.rows ?? 0) < MIN_ROWS)
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
