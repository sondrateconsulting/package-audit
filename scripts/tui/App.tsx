// App.tsx — the dashboard frame (§U5 of PROMPT-TUI.md): reads the store snapshot, plans the
// layout against the LIVE render-stream dimensions, and renders the panels. The tick loop and
// error boundary live in mount.tsx (a React error boundary cannot catch timer callbacks); this
// component is pure display.
import { useEffect, useReducer } from "react";
import { Box, Text, useStdout, useWindowSize } from "ink";
import type { TuiStore } from "./store.ts";
import { planLayout } from "./format.ts";
import { bannerLineCount, CompactFrame, Footer, Header, LimitsPanel, NetPanel, ProblemsPanel, ThrottleBanner, WorkPanel } from "./panels.tsx";

export interface AppProps {
  store: TuiStore;
  subscribe: (fn: () => void) => () => void; // the mount-owned frame bus (tick → re-render)
  nowMs: () => number;
  mountedAtMs: number;
}

export function App({ store, subscribe, nowMs, mountedAtMs }: AppProps) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribe(() => bump()), [subscribe]);
  // Resize-driven re-render (P0-verified under Bun: the stream emits 'resize' on SIGWINCH), but
  // layout decisions read the RAW stream dimensions — useWindowSize's fallback would substitute
  // ambient terminal values exactly when the stream reports none, and undefined dimensions must
  // render the EMPTY frame (§U5).
  useWindowSize();
  const { stdout } = useStdout();

  const snap = store.snapshot();
  const now = nowMs();
  const layout = planLayout(stdout.columns, stdout.rows, {
    units: snap.unitWorkers.length,
    introspections: snap.introspections.length,
    net: snap.spawns.length + snap.fetches.length,
    problems: snap.problems.length,
    banner: bannerLineCount(snap, now),
  });

  // An unusable viewport renders NOTHING at all: a fixed line cannot be guaranteed to occupy one
  // physical row there. Never unmount on shrink — resize is transient, unmount is one-way (§U5).
  if (layout.mode === "empty") return null;
  if (layout.mode === "single-line") {
    return (
      <Box width="100%" overflow="hidden">
        <Text wrap="truncate-end">package-audit · {snap.phase ?? "scanning"} · terminal too small</Text>
      </Box>
    );
  }
  if (layout.mode === "compact") return <CompactFrame snap={snap} nowMs={now} mountedAtMs={mountedAtMs} />;

  return (
    <Box flexDirection="column">
      <Header snap={snap} nowMs={now} mountedAtMs={mountedAtMs} />
      <LimitsPanel snap={snap} nowMs={now} />
      <ThrottleBanner snap={snap} nowMs={now} />
      <WorkPanel snap={snap} nowMs={now} workRows={layout.workRows} showFindings={layout.showFindings} />
      <NetPanel snap={snap} nowMs={now} netRows={layout.netRows} />
      <ProblemsPanel snap={snap} nowMs={now} collapsed={layout.problemsCollapsed} />
      <Footer snap={snap} />
    </Box>
  );
}
