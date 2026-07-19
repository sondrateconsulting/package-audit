// format.ts — pure display helpers for the TUI (§U5 of PROMPT-TUI.md): durations, countdowns,
// thousands separators, the sanitizeLine defense, and the pure frame-layout planner. No React,
// no I/O; everything here is table-tested.

// ---- sanitization (§U0) ----------------------------------------------------------------------
// EVERY dynamic string the dashboard displays — spawn labels, error messages (which can embed
// child-process stderr), branch/repo names — passes through here before Ink truncation: C0/C1
// controls and ANSI escape sequences stripped, newlines collapsed, ONE display line forced.
// Child output must never be able to inject terminal control through the dashboard.
const OSC_RE = /(?:\u001B\]|\u009D)[^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C)?/g; // OSC ... BEL/ST
const CSI_RE = /(?:\u001B\[|\u009B)[0-?]*[ -\/]*[@-~]?/g; // CSI params intermediates final
const ESC_OTHER_RE = /\u001B[@-_]?/g; // remaining two-char escapes and a stray ESC
const CONTROLS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g; // C0 (less newline/CR/tab) + DEL + C1

export function sanitizeLine(input: string): string {
  return input
    .replace(/\r\n|[\r\n\t]/g, " ") // one display line; tabs become plain spaces
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(ESC_OTHER_RE, "")
    .replace(CONTROLS_RE, "");
}

// ---- numbers & time --------------------------------------------------------------------------
// Locale-pinned so frames are byte-stable across machines.
export function thousands(n: number): string {
  return n.toLocaleString("en-US");
}

// Span elapsed for active rows: sub-10s with one decimal ("0.8s", "2.1s"), then whole seconds
// ("41s"), then minutes ("2m05s").
export function formatSpan(ms: number): string {
  const clamped = Math.max(0, ms);
  const s = clamped / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 100) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.floor(s % 60);
  return `${m}m${String(rest).padStart(2, "0")}s`;
}

// Clock-style mm:ss (or h:mm:ss past the hour) for the header elapsed and countdowns.
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Countdown to an absolute horizon; floors at 00:00 (time, not events, clears PAUSED — §U4).
export function formatCountdown(untilMs: number, nowMs: number): string {
  return formatClock(untilMs - nowMs);
}

// Countdown to a rate-limit reset epoch (seconds), or "—" when unknown.
export function formatReset(resetEpochSec: number | null, nowMs: number): string {
  if (resetEpochSec === null) return "—";
  return formatClock(resetEpochSec * 1000 - nowMs);
}

// ---- the pure frame-layout planner (§U5 terminal-size discipline) ----------------------------
// A frame taller than the viewport cannot be fully erased on redraw and smears scrollback, so
// the frame is hard-capped at rows-1 by degrading in priority order: shrink NET_ROWS → shrink
// WORK_ROWS → drop the findings line → collapse problems to a one-line count → compact mode →
// single-line frame → EMPTY frame. Never unmount on shrink (resize is transient; unmount is
// one-way).
export const WORK_ROWS_MAX = 8;
export const NET_ROWS_MAX = 8;
export const PROBLEM_ROWS = 5;

export interface LayoutDemand {
  units: number; // active unit-worker rows wanted
  introspections: number;
  net: number; // active spawn+fetch rows wanted
  problems: number;
  banner: number; // throttle banner lines (0–3: paused core, paused graphql, sticky budget)
}

export type Layout =
  | { mode: "empty" } // rows < 2, columns < 20, or dimensions undefined mid-run
  | { mode: "single-line" } // below the §U1 floor but still ≥ 2 rows and ≥ 20 columns
  | { mode: "compact" } // header + limits strip + counters + footer only
  | { mode: "full"; workRows: number; netRows: number; showFindings: boolean; problemsCollapsed: boolean };

// The §U1 activation floor (40x5) re-checked at RENDER time: a terminal that shrinks below it
// mid-run degrades the frame, never the lifecycle.
// A renderable dimension is a POSITIVE INTEGER — the same predicate the lifecycle's stderr
// proxy pins ink-facing values with (the two layers must agree, or the App could budget more
// rows than ink's own viewport). NaN passes every `<` guard below, and fractions/Infinity would
// corrupt the row budget — all of them render the EMPTY frame, exactly like undefined (§U5: a
// fixed line cannot be guaranteed one physical row in an unknowable viewport).
const usableDim = (v: number | undefined): v is number => v !== undefined && Number.isInteger(v) && v > 0;
export function planLayout(columns: number | undefined, rows: number | undefined, demand: LayoutDemand): Layout {
  if (!usableDim(columns) || !usableDim(rows) || rows < 2 || columns < 20) return { mode: "empty" };
  if (rows < 5 || columns < 40) return { mode: "single-line" };
  if (columns < 60 || rows < 12) return { mode: "compact" };

  const budget = rows - 1; // the hard cap: one row of slack keeps the redraw erasable
  let netRows = Math.min(demand.net, NET_ROWS_MAX);
  let workRows = Math.min(demand.units, WORK_ROWS_MAX);
  let showFindings = true;
  let problemsCollapsed = false;

  const total = (): number => {
    const fixed = 1 /* header */ + 2 /* limits */ + demand.banner + 1 /* work summary */ + 1 /* session */ + 1 /* footer */;
    const intro = demand.introspections > 0 ? 1 : 0;
    const findings = showFindings ? 1 : 0;
    const problems = demand.problems === 0 ? 0 : problemsCollapsed ? 1 : Math.min(demand.problems, PROBLEM_ROWS);
    return fixed + workRows + intro + findings + netRows + problems;
  };

  while (total() > budget && netRows > 0) netRows--;
  while (total() > budget && workRows > 0) workRows--;
  if (total() > budget) showFindings = false;
  if (total() > budget) problemsCollapsed = true;
  return { mode: "full", workRows, netRows, showFindings, problemsCollapsed };
}
