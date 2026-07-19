// panels.tsx — the dashboard's panel components (§U5 of PROMPT-TUI.md). Small pure function
// components over a TuiSnapshot + an injected now; EVERY dynamic string passes sanitizeLine
// before render, and number slots sourced from EXTERNAL data (quota seeds/snapshots, tapped
// JSONL counters) are store-validated finite numbers — the folds null anything else, since a
// masquerading runtime string would otherwise render its bytes verbatim, and
// thousands/formatReset are total besides; waiter/throttle/timing numbers come from this
// process's own typed producers. Row truncation is Ink's layout
// (<Text wrap="truncate-end"> inside a width-constrained <Box>) — never naive string slicing
// (org/repo/branch names can carry CJK/emoji whose cell width chars can't measure). Colors
// via <Text color/dimColor>; NO_COLOR is honored by Ink's chalk.
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { TuiSnapshot } from "./store.ts";
import { isPaused } from "./store.ts";
import { sanitizeLine, thousands, formatSpan, formatClock, formatCountdown, formatReset, limitTone, PROBLEM_ROWS, type Layout } from "./format.ts";

const GUTTER = 9; // label column width
// The cumulative pause-budget cap in minutes — the "/<N>m" denominator the operator reads. Mirrors
// github.ts's MAX_TOTAL_PAUSE_MS (8h = 480m). The TUI must NOT import github.ts (tui-purity), so the
// value is duplicated here; a drift-detect test (panels.test.ts, which MAY import github.ts) pins
// the two equal, so changing the source cap without updating this display trips CI.
export const PAUSE_BUDGET_CAP_MINUTES = 480;

// Exported (like LimitSegment) so the M1 wiring test can execute it and resolve the `<Text
// wrap="truncate-end">` it wraps around every row — making the test's effective-color model account
// for a tone inherited through that wrapper. Pure and hookless.
export function Row({ children }: { children: ReactNode }) {
  return (
    <Box width="100%" overflow="hidden">
      <Text wrap="truncate-end">{children}</Text>
    </Box>
  );
}

export function Header({ snap, nowMs, mountedAtMs }: { snap: TuiSnapshot; nowMs: number; mountedAtMs: number }) {
  const run = snap.runId === null ? "starting…" : `run ${sanitizeLine(snap.runId).slice(0, 8)}… ${snap.resumed === true ? "(resumed)" : "(fresh)"}`;
  const phase = snap.phase === null ? "" : ` · phase: ${sanitizeLine(snap.phase)}`;
  return (
    <Row>
      <Text bold>package-audit</Text> ▸ {run}
      {phase}
      {` · elapsed ${formatClock(nowMs - mountedAtMs)}`}
    </Row>
  );
}

// One rate-limit segment ("core 4,812/5,000 resets in 12:34"). The REMAINING count carries a graded
// headroom color (limitTone, finding M1) so a low quota stands out in the otherwise-monochrome
// healthy frame; the label and denominator stay neutral. Text content matches the prior string form
// EXCEPT the intentional M3 "resets" → "resets in" wording (the panel tests assert it verbatim);
// color is stripped before those text assertions. Exported so a unit test can walk the returned
// element tree and assert the remaining count is wrapped in a tone-colored Text — a rendered-ANSI
// assertion is not CI-stable (ink/chalk caches its color level at module load, shared across bun's
// test process).
export function LimitSegment({ snap, resource, nowMs }: { snap: TuiSnapshot; resource: "core" | "graphql"; nowMs: number }) {
  const l = snap.limits[resource];
  if (l === null) return <>{`${resource} —`}</>;
  const remaining = l.remaining === null ? "?" : thousands(l.remaining);
  const rest = `${l.limit === null ? "" : `/${thousands(l.limit)}`}${l.resetEpochSec === null ? "" : ` resets in ${formatReset(l.resetEpochSec, nowMs)}`}`;
  return (
    <>
      {`${resource} `}
      <Text color={limitTone(l.remaining, l.limit)}>{remaining}</Text>
      {rest}
    </>
  );
}

export function LimitsPanel({ snap, nowMs }: { snap: TuiSnapshot; nowMs: number }) {
  const spawnsLive = snap.spawns.length;
  const cap = snap.spawnCap === null ? "?" : String(snap.spawnCap);
  const queued = snap.spawnWaiting > 0 ? ` (+${snap.spawnWaiting} queued)` : "";
  const budgetMinutes = (ms: number): string => `${Math.round(ms / 60_000)}m`;
  const spentMs = Math.max(snap.throttle.core?.budgetSpentMs ?? 0, snap.throttle.graphql?.budgetSpentMs ?? 0);
  return (
    <Box flexDirection="column">
      <Row>
        <Text dimColor>{"limits".padEnd(GUTTER)}</Text>
        <LimitSegment snap={snap} resource="core" nowMs={nowMs} /> · <LimitSegment snap={snap} resource="graphql" nowMs={nowMs} />
      </Row>
      <Row>
        <Text dimColor>{"".padEnd(GUTTER)}</Text>
        {`subprocs ${spawnsLive}/${cap}${queued} · pause budget ${budgetMinutes(spentMs)}/${PAUSE_BUDGET_CAP_MINUTES}m`}
      </Row>
    </Box>
  );
}

// The throttle banner: PAUSED is DERIVED (horizon vs now — §U4); the budget-exhausted notice is
// sticky, never conflated with per-call retry exhaustion (surfaced as a count).
export function ThrottleBanner({ snap, nowMs }: { snap: TuiSnapshot; nowMs: number }) {
  const lines: ReactNode[] = [];
  for (const resource of ["core", "graphql"] as const) {
    const t = snap.throttle[resource];
    if (t !== null && isPaused(t, nowMs)) {
      lines.push(
        <Row key={resource}>
          <Text color="yellow">{`⏸ ${resource} PAUSED — resumes in ${formatCountdown(t.horizonMs, nowMs)}`}</Text>
        </Row>,
      );
    }
  }
  if (snap.budgetExhausted) {
    lines.push(
      <Row key="budget">
        <Text color="red">✖ pause budget exhausted — remaining throttled work defers to the next run</Text>
      </Row>,
    );
  }
  if (lines.length === 0) return null;
  return <Box flexDirection="column">{lines}</Box>;
}

// How many banner lines the layout planner must reserve — mirrors ThrottleBanner exactly.
export function bannerLineCount(snap: TuiSnapshot, nowMs: number): number {
  let n = 0;
  if (isPaused(snap.throttle.core, nowMs)) n++;
  if (isPaused(snap.throttle.graphql, nowMs)) n++;
  if (snap.budgetExhausted) n++;
  return n;
}

export function WorkPanel({ snap, nowMs, workRows, showFindings }: { snap: TuiSnapshot; nowMs: number; workRows: number; showFindings: boolean }) {
  const ownerCap = snap.ownerCap === null ? "?" : String(snap.ownerCap);
  const branchCap = snap.branchCap === null ? "?" : String(snap.branchCap);
  const owners = snap.owners.length === 0 ? "" : `: ${snap.owners.map((o) => sanitizeLine(o)).join(", ")}`;
  const c = snap.counters;
  const skipped = c.skipCutoff + c.skipPolicy;
  // The row budget covers the "+N more" line too, and a ZERO budget renders neither rows nor
  // the more-line — the planner counted zero lines, so zero lines it is (the summary line above
  // already carries the worker count). Exceeding rows-1 would smear scrollback (§U5).
  const shownUnits = workRows >= snap.unitWorkers.length ? snap.unitWorkers : snap.unitWorkers.slice(0, Math.max(0, workRows - 1));
  const moreUnits = workRows === 0 ? 0 : snap.unitWorkers.length - shownUnits.length;
  const introspections = snap.introspections;
  return (
    <Box flexDirection="column">
      <Row>
        <Text dimColor>{"work".padEnd(GUTTER)}</Text>
        {`owners ${snap.owners.length} (≤${ownerCap} concurrent)${owners} · repos ${snap.repoCount} · unit workers ${snap.unitWorkers.length} (≤${branchCap}/repo) · scanning ${snap.scanning.length}`}
      </Row>
      {shownUnits.map((u) => (
        <Row key={u.key}>
          <Text dimColor>{"".padEnd(GUTTER + 2)}</Text>
          {sanitizeLine(u.key)}
          <Text dimColor>{`  ${formatSpan(nowMs - u.sinceMs)}`}</Text>
        </Row>
      ))}
      {moreUnits > 0 ? (
        <Row>
          <Text dimColor>{`${"".padEnd(GUTTER + 2)}… +${moreUnits} more`}</Text>
        </Row>
      ) : null}
      {introspections.length > 0 ? (
        <Row>
          <Text dimColor>{"".padEnd(GUTTER)}</Text>
          {`introspect ${sanitizeLine(`${introspections[0]!.packageName}@${introspections[0]!.version}`)} ${formatSpan(nowMs - introspections[0]!.sinceMs)}`}
          {introspections.length > 1 ? <Text dimColor>{` · +${introspections.length - 1} more`}</Text> : null}
        </Row>
      ) : null}
      <Row>
        <Text dimColor>{"".padEnd(GUTTER)}</Text>
        {`session: scanned ${thousands(c.scanned)} · errored ${thousands(c.errored)}${snap.retryExhaustions > 0 ? ` · retry-exhausted ${thousands(snap.retryExhaustions)}` : ""}${c.requeued > 0 ? ` · requeued ${thousands(c.requeued)}` : ""} · current ${thousands(c.skipCurrent)} · skipped ${thousands(skipped)} · past-cap ${thousands(c.pastCap)}`}
      </Row>
      {showFindings ? (
        <Row>
          <Text dimColor>{"".padEnd(GUTTER)}</Text>
          {`findings (session): ${thousands(snap.findings.deps)} dep · ${thousands(snap.findings.usage)} usage · ${thousands(snap.findings.cli)} cli`}
        </Row>
      ) : null}
    </Box>
  );
}

export function NetPanel({ snap, nowMs, netRows }: { snap: TuiSnapshot; nowMs: number; netRows: number }) {
  const rows: Array<{ key: string; label: string; sinceMs: number }> = [
    ...snap.spawns.map((s) => ({ key: `s${s.id}`, label: s.label, sinceMs: s.sinceMs })),
    ...snap.fetches.map((f) => ({ key: `f${f.id}`, label: f.kind === "registry-probe" ? f.label : `registry ${f.label}`, sinceMs: f.sinceMs })),
  ];
  if (rows.length === 0 || netRows === 0) return null;
  const shown = netRows >= rows.length ? rows : rows.slice(0, Math.max(0, netRows - 1));
  const more = rows.length - shown.length;
  return (
    <Box flexDirection="column">
      {shown.map((r, i) => (
        <Row key={r.key}>
          <Text dimColor>{(i === 0 ? "net" : "").padEnd(GUTTER)}</Text>
          {sanitizeLine(r.label)}
          <Text dimColor>{`  ${formatSpan(nowMs - r.sinceMs)}`}</Text>
        </Row>
      ))}
      {more > 0 ? (
        <Row>
          <Text dimColor>{`${"".padEnd(GUTTER)}… +${more} more`}</Text>
        </Row>
      ) : null}
    </Box>
  );
}

export function ProblemsPanel({ snap, nowMs, collapsed }: { snap: TuiSnapshot; nowMs: number; collapsed: boolean }) {
  const problems = snap.problems;
  if (problems.length === 0) return null;
  if (collapsed) {
    const errors = problems.filter((p) => p.kind === "error").length;
    return (
      <Row>
        <Text dimColor>{"problems".padEnd(GUTTER)}</Text>
        {`${problems.length} recent (${errors} errors)`}
      </Row>
    );
  }
  const recent = problems.slice(-PROBLEM_ROWS).reverse(); // last 5, newest first (§U5)
  return (
    <Box flexDirection="column">
      {recent.map((p, i) => {
        const age = formatClock(nowMs - p.atMs);
        const text = `${age} ${p.kind === "error" ? "✖" : "⚠"} ${sanitizeLine(p.scope)} ${sanitizeLine(p.target)}${p.message === "" ? "" : ` — ${sanitizeLine(p.message)}`}`;
        return (
          <Row key={`${p.atMs}-${i}`}>
            <Text dimColor>{(i === 0 ? "problems" : "").padEnd(GUTTER)}</Text>
            {p.kind === "warning" ? <Text dimColor>{text}</Text> : <Text color="red">{text}</Text>}
          </Row>
        );
      })}
    </Box>
  );
}

export function Footer({ snap }: { snap: TuiSnapshot }) {
  const log = snap.logPath === null ? "" : `JSONL → ${sanitizeLine(snap.logPath)} · `;
  return (
    <Row>
      <Text dimColor>{`${log}Ctrl+C aborts (resumable)`}</Text>
    </Row>
  );
}

// Compact mode (§U5): header + limits strip + counters + footer only.
export function CompactFrame({ snap, nowMs, mountedAtMs }: { snap: TuiSnapshot; nowMs: number; mountedAtMs: number }) {
  const c = snap.counters;
  return (
    <Box flexDirection="column">
      <Header snap={snap} nowMs={nowMs} mountedAtMs={mountedAtMs} />
      <Row>
        <Text dimColor>{"limits".padEnd(GUTTER)}</Text>
        <LimitSegment snap={snap} resource="core" nowMs={nowMs} /> · <LimitSegment snap={snap} resource="graphql" nowMs={nowMs} />
      </Row>
      <Row>
        <Text dimColor>{"".padEnd(GUTTER)}</Text>
        {`scanned ${thousands(c.scanned)} · errored ${thousands(c.errored)} · workers ${snap.unitWorkers.length}`}
      </Row>
      <Footer snap={snap} />
    </Box>
  );
}

export type { Layout };
