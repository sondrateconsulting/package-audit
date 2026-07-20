// panels.test.ts — §U8.11: panel frames over canned store states, mounted via the REAL adapter
// against capture streams (the P0-cleared harness; ink-testing-library's fake stdout carries no
// rows, and the layout planner treats undefined dimensions as the EMPTY frame — so the real
// adapter with sized streams is the honest harness here). ANSI is stripped before asserting;
// assertions run on the FULL captured byte stream after unmount, which is valid in interactive
// AND CI rendering modes (P0 measurement).
import { expect, test, describe, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { createElement, isValidElement } from "react";
import { Text } from "ink";
import { mountTui } from "./mount.tsx";
import { CompactFrame, LimitSegment, LimitsPanel, LimitsRow, Row, bannerLineCount, ThrottleBanner, activeBannerReasons } from "./panels.tsx";
import { createTuiStore, type TuiStore, type TuiSnapshot } from "./store.ts";
import { sanitizeLine } from "./format.ts";
import { PAUSE_BUDGET_CAP_MINUTES } from "./panels.tsx";
import { MAX_TOTAL_PAUSE_MS } from "../github.ts";
import { resetTuiFailure, type ProgressEvent } from "../progress.ts";

type LimitSegmentProps = Parameters<typeof LimitSegment>[0];
type LimitsRowProps = Parameters<typeof LimitsRow>[0];
type RowProps = Parameters<typeof Row>[0];

// Flatten an element subtree to plain text. LimitSegment and Row are pure, hookless render helpers,
// so they are executed to reach the Text they return; Ink host elements are read via props.children.
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    if (node.type === LimitSegment) return textOf(LimitSegment(node.props as LimitSegmentProps));
    if (node.type === LimitsRow) return textOf(LimitsRow(node.props as LimitsRowProps));
    if (node.type === Row) return textOf(Row(node.props as RowProps));
    return textOf((node.props as { children?: unknown }).children);
  }
  return "";
}

// Locate the count — the Ink Text whose flattened content is EXACTLY `needle`, reached THROUGH a
// LimitSegment execution — and report BOTH its OWN `color` and whether ANY ancestor Text on its path
// is colored. The design intent is count-ONLY toning: the count Text itself carries the tone and
// NOTHING above it does. So M1 is proven by requiring { own: <tone>, ancestorColored: false }, which
// fails on every realistic break:
//   • color dropped        → own undefined (≠ the tone)
//   • LimitSegment un-wired → count not reached via a segment → no match → undefined
//   • wrong own tone        → own ≠ the tone
//   • whole-segment / ancestor recolor that would tint the count via Ink inheritance → ancestorColored true
// The wrappers that hide a Text behind a component boundary (LimitSegment, Row's <Text wrap>) are
// executed so the full Text ancestry is resolved; Ink Box/Text are read via props. `viaSegment` gates
// the match to a count reached via LimitSegment. Guards with isValidElement / Array.isArray before any
// property access. (A rendered-ANSI assertion is not CI-stable here: ink/chalk caches its color level
// at module load, shared across bun's single test process.)
function countColor(node: unknown, needle: string, viaSegment = false, ancestorColored = false): { own: unknown; ancestorColored: boolean } | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = countColor(child, needle, viaSegment, ancestorColored);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  if (node.type === LimitSegment) return countColor(LimitSegment(node.props as LimitSegmentProps), needle, true, ancestorColored);
  if (node.type === LimitsRow) return countColor(LimitsRow(node.props as LimitsRowProps), needle, viaSegment, ancestorColored);
  if (node.type === Row) return countColor(Row(node.props as RowProps), needle, viaSegment, ancestorColored);
  const props = node.props as { color?: unknown; children?: unknown };
  if (viaSegment && node.type === Text && textOf(props.children) === needle) return { own: props.color, ancestorColored };
  // a Text with its own color becomes a colored ancestor for its subtree (checked AFTER the count test,
  // so the count's own color is never mistaken for an ancestor's)
  const nextAncestorColored = node.type === Text && props.color !== undefined ? true : ancestorColored;
  return countColor(props.children, needle, viaSegment, nextAncestorColored);
}

afterEach(() => {
  resetTuiFailure();
});

class CaptureStream extends EventEmitter {
  frames: string[] = [];
  isTTY = true;
  columns: number | undefined = 120;
  rows: number | undefined = 40;
  constructor(columns?: number | undefined, rows?: number | undefined) {
    super();
    if (arguments.length >= 1) this.columns = columns;
    if (arguments.length >= 2) this.rows = rows;
  }
  write = (chunk: unknown, cb?: (err?: Error | null) => void): boolean => {
    this.frames.push(String(chunk));
    if (typeof cb === "function") cb();
    return true;
  };
  text(): string {
    return sanitizeLine(this.frames.join("")); // strip ANSI before asserting (§U8.11)
  }
  raw(): string {
    return this.frames.join(""); // the UNstripped bytes, for hostile-injection assertions
  }
}

const NOW = 1_000_000;

// Mount the real adapter over a canned store, let a frame land, unmount, return the whole
// captured text. Content assertions on the full stream are CI-safe (final frame at unmount).
async function frameCapture(events: ProgressEvent[], opts: { columns?: number | undefined; rows?: number | undefined; nowMs?: number } = {}): Promise<CaptureStream> {
  const out = new CaptureStream(
    "columns" in opts ? opts.columns : 120,
    "rows" in opts ? opts.rows : 40,
  );
  const store: TuiStore = createTuiStore(() => opts.nowMs ?? NOW);
  for (const e of events) store.dispatch(e);
  const handle = mountTui(store, {
    out: out as unknown as NodeJS.WriteStream,
    onDegrade: () => {},
    scheduler: { setInterval: (() => 0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval, clearInterval: (() => {}) as typeof clearInterval },
    nowMs: () => opts.nowMs ?? NOW,
  });
  await new Promise((r) => setTimeout(r, 60)); // let React commit
  handle.dispose();
  handle.requestUnmount();
  await Promise.race([handle.waitUntilExit(), new Promise((r) => setTimeout(r, 2000))]);
  return out;
}
async function frame(events: ProgressEvent[], opts: { columns?: number | undefined; rows?: number | undefined; nowMs?: number } = {}): Promise<string> {
  return (await frameCapture(events, opts)).text();
}

const jsonl = (event: Record<string, unknown>): ProgressEvent => ({ type: "jsonl", event });

describe("panel frames over canned store states (§U8.11)", () => {
  test("empty state: header placeholder, dash limits, zeroed counters, footer without a log path", async () => {
    const text = await frame([]);
    expect(text).toContain("package-audit");
    expect(text).toContain("starting…");
    expect(text).toContain("core —");
    expect(text).toContain("graphql —");
    expect(text).toContain("session: scanned 0");
    expect(text).toContain("Ctrl+C aborts (resumable)");
    expect(text).not.toContain("JSONL →"); // no divert path known
    expect(text).not.toContain("PAUSED");
  });

  test("a hostile rate-limit seed cannot smuggle bytes into the render stream — validated at the fold, total at the formatter", async () => {
    // C1/OSC control bytes masquerading as a number in the seed's number-typed field — the
    // shape an unvalidated rate_limit JSON body can hand the display (§U0 pillar 9). Spelled
    // via fromCharCode so this source file itself carries no raw control bytes.
    const hostile = `${String.fromCharCode(0x9d)}0;pwn${String.fromCharCode(0x9c)}` as unknown as number;
    const out = await frameCapture([{ type: "rate-limit-seed", resource: "graphql", remaining: hostile }]);
    expect(out.raw()).not.toContain("pwn"); // the bytes never reached Ink's stream at all
    expect(out.raw()).not.toContain(String.fromCharCode(0x9d)); // no raw C1 OSC introducer either
    expect(out.text()).toContain("graphql ?"); // the honest placeholder renders instead
  });

  test("populated state: run identity, phase, limits, work rows, net rows, findings, footer path", async () => {
    const text = await frame([
      jsonl({ event: "run", runId: "2f9c1a77-aaaa-bbbb", resumed: true }),
      jsonl({ event: "concurrency", organizations: 3, branches: 4, repositories: 6 }),
      { type: "phase", phase: "scan" },
      { type: "rate-limit", resource: "core", remaining: 4812, limit: 5000, resetEpochSec: (NOW + 754_000) / 1000 },
      { type: "rate-limit-seed", resource: "graphql", remaining: 1998 },
      { type: "owner-start", owner: "acme" },
      { type: "owner-start", owner: "initech" },
      { type: "repo-start", owner: "acme", repo: "api" },
      { type: "unit-dispatch", owner: "acme", repo: "api", branch: "main" },
      { type: "unit-start", owner: "acme", repo: "api", branch: "main" },
      { type: "spawn-start", id: 1, tool: "gh", label: "gh api repos/acme/api/git/trees/abc" },
      { type: "fetch-start", id: 2, kind: "packument", label: "packument expo" },
      { type: "introspect-start", id: 3, packageName: "expo", version: "52.0.0" },
      { type: "spawn-queue", waiting: 2 },
      jsonl({ event: "unit", org: "acme", repo: "api", branch: "old", action: "scanned", deps: 512, usage: 1204, cli: 77 }),
      { type: "divert", path: "/out/logs/audit-log-20260718T211530Z-p4242.jsonl" },
    ]);
    expect(text).toContain("run 2f9c1a77…"); // 8-char id
    expect(text).toContain("(resumed)");
    expect(text).toContain("phase: scan");
    expect(text).toContain("(resumed) · phase: scan · elapsed"); // header fields joined by · , not runs of spaces (P1)
    expect(text).not.toContain("(resumed)   phase"); // no triple-space separator
    expect(text).toContain("core 4,812/5,000 resets in 12:34"); // countdown, phrased like the banner's "resumes in" (M3)
    expect(text).toContain("graphql 1,998"); // the seed shows remaining without a limit
    expect(text).toContain("(+2 queued)");
    expect(text).toContain("owners 2 (≤3 concurrent): acme, initech"); // occupancy, not a progress fraction (H1)
    expect(text).toContain("unit workers 1 (≤4/repo)");
    expect(text).toContain("scanning 1");
    expect(text).toContain("acme/api@main");
    expect(text).toContain("gh api repos/acme/api/git/trees/abc");
    expect(text).toContain("registry packument expo");
    expect(text).toContain("introspect expo@52.0.0");
    expect(text).toContain("findings (session): 512 dep · 1,204 usage · 77 cli");
    expect(text).toContain("session: scanned 1 · errored 0 · current 0 · skipped 0 · past-cap 0"); // M2 order, zero-conditional case
    expect(text).not.toContain("requeued"); // zero-valued conditional fields are omitted, not shown as "0"
    expect(text).not.toContain("retry-exhausted");
    expect(text).toContain("JSONL → /out/logs/audit-log-20260718T211530Z-p4242.jsonl");
  });

  test("M1 wiring: each panel routes the count through LimitSegment into an Ink Text that carries the tone ITSELF with no colored ancestor (count-only toning); healthy uncolored; core & graphql independent", () => {
    const snapWith = (coreRemaining: number, graphqlRemaining?: number): ReturnType<TuiStore["snapshot"]> => {
      const store: TuiStore = createTuiStore(() => NOW);
      store.dispatch({ type: "rate-limit", resource: "core", remaining: coreRemaining, limit: 5000, resetEpochSec: null });
      if (graphqlRemaining !== undefined) store.dispatch({ type: "rate-limit", resource: "graphql", remaining: graphqlRemaining, limit: 5000, resetEpochSec: null });
      return store.snapshot();
    };
    const red = snapWith(100); // core 2% → red
    const yellow = snapWith(1000); // core 20% → yellow
    const ok = snapWith(4800); // core 96% → uncolored
    const mixed = snapWith(100, 1000); // core red + graphql yellow in the same frame
    // Assert against BOTH modes. The count Text carries the tone ITSELF (own) with NO colored ancestor
    // (count-only toning). Fails on: un-wired LimitSegment (no match → undefined), dropped color (own
    // undefined ≠ tone), wrong own tone, or a whole-segment/ancestor recolor (ancestorColored true).
    const panels: Array<(s: ReturnType<TuiStore["snapshot"]>) => unknown> = [
      (s) => LimitsPanel({ snap: s, nowMs: NOW }),
      (s) => CompactFrame({ snap: s, nowMs: NOW, mountedAtMs: NOW }),
    ];
    for (const panel of panels) {
      expect(countColor(panel(red), "100")).toEqual({ own: "red", ancestorColored: false });
      expect(countColor(panel(yellow), "1,000")).toEqual({ own: "yellow", ancestorColored: false });
      expect(countColor(panel(ok), "4,800")).toEqual({ own: undefined, ancestorColored: false });
      expect(countColor(panel(mixed), "100")).toEqual({ own: "red", ancestorColored: false });
      expect(countColor(panel(mixed), "1,000")).toEqual({ own: "yellow", ancestorColored: false });
    }
  });

  test("M1 wiring: count-only toning is enforced — a whole-segment/ancestor recolor is REJECTED (ancestorColored true), never accepted as the count's own tone", () => {
    const store: TuiStore = createTuiStore(() => NOW);
    store.dispatch({ type: "rate-limit", resource: "core", remaining: 4800, limit: 5000, resetEpochSec: null }); // healthy → the count's OWN color is undefined
    const snap = store.snapshot();
    // A whole-segment recolor: wrap the segment in a colored ancestor Text, leaving the inner count
    // uncolored. Ink would tint the count via inheritance — but that is NOT count-only toning, so
    // countColor surfaces the colored ancestor (ancestorColored: true), which makes the real
    // assertions (ancestorColored: false) fail. This also covers the earlier concern that an ancestor
    // tone could visibly color an otherwise-uncolored count: it is detected, not silently accepted.
    const wholeSegmentTinted = createElement(Text, { color: "magenta" }, createElement(LimitSegment, { snap, resource: "core" as const, nowMs: NOW }));
    expect(countColor(wholeSegmentTinted, "4,800")).toEqual({ own: undefined, ancestorColored: true });
    // control: the real segment carries the tone on the count ITSELF with nothing colored above it
    expect(countColor(createElement(LimitSegment, { snap, resource: "core" as const, nowMs: NOW }), "4,800")).toEqual({ own: undefined, ancestorColored: false });
  });

  test("session counters front-load the danger fields so end-truncation drops the least important first (M2)", async () => {
    const text = await frame([
      jsonl({ event: "unit", org: "o", repo: "r", branch: "a", action: "scanned", deps: 0, usage: 0, cli: 0 }),
      jsonl({ event: "unit", org: "o", repo: "r", branch: "b", action: "skip-current" }),
      jsonl({ event: "unit", org: "o", repo: "r", branch: "c", action: "skip-cutoff" }),
      jsonl({ event: "unit", org: "o", repo: "r", branch: "d", action: "past-cap" }),
      jsonl({ event: "unit", org: "o", repo: "r", branch: "e", action: "error", message: "boom" }),
      jsonl({ event: "unit", org: "o", repo: "r", branch: "f", action: "requeue-throttle" }),
      { type: "throttle", bucket: "core", state: "exhausted", reason: "retries", untilMs: null, budgetSpentMs: 0 },
    ]);
    const session = text.slice(text.indexOf("session:"));
    expect(session).toContain("errored 1");
    expect(session).toContain("retry-exhausted 1");
    expect(session).toContain("requeued 1");
    // errored / retry-exhausted / requeued precede current / skipped / past-cap: a truncate-end row
    // sheds the rightmost fields first, and the danger fields must not be the ones lost under pressure.
    expect(session.indexOf("errored")).toBeLessThan(session.indexOf("current"));
    expect(session.indexOf("retry-exhausted")).toBeLessThan(session.indexOf("skipped"));
    expect(session.indexOf("requeued")).toBeLessThan(session.indexOf("past-cap"));
    // the full sequence, exactly — danger fields first, low-priority fields last
    expect(session).toContain("scanned 1 · errored 1 · retry-exhausted 1 · requeued 1 · current 1 · skipped 1 · past-cap 1");
  });

  test("overflow: more active rows than the budget renders '… +N more'", async () => {
    const events: ProgressEvent[] = [];
    for (let i = 0; i < 12; i++) events.push({ type: "unit-dispatch", owner: "o", repo: "r", branch: `b${i}` });
    for (let i = 0; i < 12; i++) events.push({ type: "spawn-start", id: 100 + i, tool: "gh", label: `gh api thing-${i}` });
    const text = await frame(events, { rows: 60 });
    expect(text).toContain("unit workers 12");
    expect(text).toContain("… +5 more"); // 12 units, 8-row budget: 7 shown + the more-line
    expect(text).toContain("gh api thing-0");
  });

  test("throttle banner: PAUSED with countdown derived from the horizon; sticky budget notice never conflated with retry counts", async () => {
    const paused = await frame([
      { type: "throttle", bucket: "core", state: "armed", untilMs: NOW + 297_000, budgetSpentMs: 60_000 },
    ]);
    expect(paused).toContain("⏸ core PAUSED — resumes in 04:57");
    expect(paused).not.toContain("budget exhausted");

    const exhausted = await frame([
      { type: "throttle", bucket: "core", state: "exhausted", reason: "budget", untilMs: null, budgetSpentMs: 480 * 60_000 },
      { type: "throttle", bucket: "graphql", state: "exhausted", reason: "retries", untilMs: null, budgetSpentMs: 0 },
    ]);
    expect(exhausted).toContain("pause budget exhausted"); // the sticky notice
    expect(exhausted).toContain("retry-exhausted 1"); // the transient count, separate
    expect(exhausted).toContain("pause budget 480m/480m");
  });

  test("an expired horizon renders NO banner — time cleared it, no event needed", async () => {
    const text = await frame([{ type: "throttle", bucket: "core", state: "armed", untilMs: NOW - 1, budgetSpentMs: 1000 }]);
    expect(text).not.toContain("PAUSED");
  });

  test("problems panel: last 5, newest first, errors and warnings visually distinct markers", async () => {
    const events: ProgressEvent[] = [];
    for (let i = 0; i < 7; i++) events.push(jsonl({ event: "unit", org: "acme", repo: "api", branch: `b${i}`, action: "error", message: `boom-${i}` }));
    events.push(jsonl({ event: "warning", reason: "clone-cleanup-failed", target: "/tmp/pkg-audit-x", message: "EBUSY" }));
    const text = await frame(events);
    expect(text).toContain("⚠ clone-cleanup-failed /tmp/pkg-audit-x — EBUSY"); // newest first
    expect(text).toContain("✖ scan acme/api@b6 — boom-6");
    expect(text).toContain("✖ scan acme/api@b3 — boom-3"); // 5th newest still shown
    expect(text).not.toContain("boom-2"); // older ones dropped from the panel
  });

  test("hostile bytes in displayed strings render inert (§U0 sanitization at render)", async () => {
    const capture = await frameCapture([
      jsonl({ event: "unit", org: "acme", repo: "api", branch: "dev", action: "error", message: "clone failed: \u001B]0;pwn\u0007\u001B[2J\u001B[9999;9999H stderr\nline2" }),
      { type: "spawn-start", id: 1, tool: "gh", label: "gh api \u001B[31mevil" },
    ]);
    const text = capture.text();
    expect(text).toContain("clone failed:  stderr line2"); // escapes stripped, newline collapsed
    expect(text).toContain("gh api evil");
    // the RAW byte stream contains only Ink's own frame-control ANSI — the hostile sequences
    // (title-set OSC, full-screen erase, absolute cursor jump) never reach the terminal
    const raw = capture.raw();
    expect(raw).not.toContain("]0;pwn");
    expect(raw).not.toContain("[2J");
    expect(raw).not.toContain("9999;9999");
  });

  test("hostile bytes are inert through EVERY sanitized panel field (runId, owner/repo/branch, introspection, logPath)", async () => {
    // Not just the error-message + spawn-label paths above: drive the same payload through the
    // header runId, the owners list, the unit-worker key, the introspection package@version, and
    // the footer divert path — the fields whose sanitize call sites had no hostile-byte assertion.
    const H = "\u001B]0;PWN\u0007\u001B[2J\u001B[8888;8888H\u202Ex"; // OSC title + erase + cursor-jump + RLO
    const capture = await frameCapture([
      jsonl({ event: "run", runId: `${H}runid`, resumed: false }),
      { type: "owner-start", owner: `acme${H}` },
      { type: "unit-dispatch", owner: `acme${H}`, repo: `api${H}`, branch: `dev${H}` },
      { type: "introspect-start", id: 1, packageName: `pkg${H}`, version: `1.0${H}` },
      { type: "divert", path: `/tmp/out${H}/log.jsonl` },
    ]);
    const raw = capture.raw();
    expect(raw).not.toContain("]0;PWN"); // OSC title-set from any field
    expect(raw).not.toContain("[2J"); // full-screen erase
    expect(raw).not.toContain("8888;8888"); // absolute cursor jump
    expect(raw).not.toContain("\u202E"); // RIGHT-TO-LEFT OVERRIDE (bidi display spoofing)
    // and the cleaned field text still rendered (proving the fields were displayed, not just absent)
    const text = capture.text();
    expect(text).toContain("acmex"); // owner survived, escapes+bidi gone
    expect(text).toContain("pkgx"); // introspection package survived
  });

  test("the rendered pause-budget cap denominator stays pinned to the source cap (drift guard)", async () => {
    // panels.tsx hardcodes the "/<N>m" denominator and CANNOT import github.ts (tui-purity), so pin
    // PAUSE_BUDGET_CAP_MINUTES to MAX_TOTAL_PAUSE_MS here (tests MAY import github.ts): changing the
    // source cap without updating the display trips this instead of silently showing a stale figure.
    expect(PAUSE_BUDGET_CAP_MINUTES).toBe(MAX_TOTAL_PAUSE_MS / 60_000);
    expect(await frame([])).toContain(`/${PAUSE_BUDGET_CAP_MINUTES}m`); // the denominator the operator sees
  });

  test("a ZERO work-row budget renders neither unit rows nor the '+N more' line (rows-1 cap conformance)", async () => {
    const events: ProgressEvent[] = [];
    for (let i = 0; i < 12; i++) events.push({ type: "unit-dispatch", owner: "o", repo: "r", branch: `branch-${i}` });
    events.push({ type: "introspect-start", id: 1, packageName: "expo", version: "1.0.0" });
    for (let i = 0; i < 6; i++) events.push(jsonl({ event: "unit", org: "o", repo: "r", branch: `e${i}`, action: "error", message: `m${i}` }));
    // rows=12 is full mode's floor; under this demand the ladder ends at workRows 0, findings
    // dropped, problems collapsed — and the panel must render EXACTLY that, not one line more
    const text = await frame(events, { columns: 120, rows: 12 });
    expect(text).toContain("unit workers 12"); // the summary still carries the truth
    expect(text).not.toContain("… +"); // no overflow line for a zero budget
    expect(text).not.toContain("o/r@branch-"); // and no unit rows
    expect(text).not.toContain("findings (session)"); // dropped by the ladder
    expect(text).toContain("recent (6 errors)"); // problems collapsed to the one-line count
  });

  test("compact mode (<60 columns): header + limits strip + counters + footer only", async () => {
    const text = await frame(
      [
        jsonl({ event: "run", runId: "abcd1234", resumed: false }),
        { type: "rate-limit", resource: "core", remaining: 100, limit: 5000, resetEpochSec: null },
        { type: "unit-dispatch", owner: "o", repo: "r", branch: "main" },
        jsonl({ event: "unit", org: "o", repo: "r", branch: "x", action: "scanned", deps: 1, usage: 2, cli: 3 }),
      ],
      { columns: 55, rows: 30 },
    );
    expect(text).toContain("package-audit");
    expect(text).toContain("(fresh)");
    expect(text).toContain("core 100/5,000");
    expect(text).toContain("scanned 1");
    expect(text).toContain("workers 1");
    expect(text).toContain("Ctrl+C aborts");
    expect(text).not.toContain("findings (session)"); // full-mode panels absent
    expect(text).not.toContain("o/r@main");
  });

  test("single-line mode (below the 40x5 floor, still >= 20x2) — Ink truncates to the cell width", async () => {
    const narrow = await frame([{ type: "phase", phase: "scan" }], { columns: 30, rows: 10 });
    expect(narrow).toContain("package-audit · scan · termin…"); // truncate-end at 30 columns, never wrapped
    expect(narrow).not.toContain("limits");
    const wide = await frame([{ type: "phase", phase: "scan" }], { columns: 39, rows: 10 });
    expect(wide).toContain("package-audit · scan · terminal too s"); // 39 columns shows more
  });

  test("a 'resize' event on the render stream re-renders at the NEW dimensions (direct subscription, no terminal-size fallback)", async () => {
    const out = new CaptureStream(120, 40);
    const store: TuiStore = createTuiStore(() => NOW);
    store.dispatch({ type: "phase", phase: "scan" });
    const handle = mountTui(store, {
      out: out as unknown as NodeJS.WriteStream,
      onDegrade: () => {},
      scheduler: { setInterval: (() => 0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval, clearInterval: (() => {}) as typeof clearInterval },
      nowMs: () => NOW,
    });
    await new Promise((r) => setTimeout(r, 60));
    // shrink below the 40x5 floor mid-run and fire the stream's own resize event
    out.columns = 30;
    out.rows = 10;
    out.emit("resize");
    await new Promise((r) => setTimeout(r, 60));
    handle.dispose();
    handle.requestUnmount();
    await Promise.race([handle.waitUntilExit(), new Promise((r) => setTimeout(r, 2000))]);
    // the single-line frame took over, itself truncated to the NEW 30-column width by Ink
    expect(out.text()).toContain("package-audit · scan · termin…");
  });

  test("EMPTY frame below the render floor and for undefined dimensions — render nothing at all", async () => {
    for (const [columns, rows] of [
      [15, 30],
      [100, 1],
      [undefined, 30],
      [100, undefined],
    ] as Array<[number | undefined, number | undefined]>) {
      const text = await frame([{ type: "phase", phase: "scan" }], { columns, rows });
      expect(text).not.toContain("package-audit");
      expect(text).not.toContain("terminal too small");
    }
  });
});

// §U5 row budget: bannerLineCount feeds a FIXED, non-shrinkable contributor to planLayout. If it
// ever disagrees with what ThrottleBanner renders, an undercount smears scrollback (the exact bug
// the degradation ladder exists to prevent). The count and the render must derive from ONE source.
describe("throttle banner: count and render stay in lockstep (§U5)", () => {
  const NOW = 10_000;
  const LIVE = 15_000; // horizon > now → paused
  const EXPIRED = 5_000; // horizon < now → not paused
  const EXACT = NOW; // horizon === now → not paused (isPaused is strictly >)

  // Build a real snapshot via the store fold: arm a bucket to a horizon, and/or latch the sticky
  // budget flag. untilMs=null on the exhausted emit leaves any existing horizon untouched, so
  // "budget only" produces no phantom pause.
  function snapWith(opts: { coreUntil?: number | null; gqlUntil?: number | null; budget?: boolean }): TuiSnapshot {
    const store = createTuiStore(() => 1_000);
    if (opts.coreUntil != null) store.dispatch({ type: "throttle", bucket: "core", state: "armed", untilMs: opts.coreUntil, budgetSpentMs: 0 });
    if (opts.gqlUntil != null) store.dispatch({ type: "throttle", bucket: "graphql", state: "armed", untilMs: opts.gqlUntil, budgetSpentMs: 0 });
    if (opts.budget) store.dispatch({ type: "throttle", bucket: "core", state: "exhausted", reason: "budget", untilMs: null, budgetSpentMs: 1 });
    return store.snapshot();
  }

  // The number of <Row> elements ThrottleBanner actually renders (null frame → 0). Counts REAL Row
  // elements by walking the tree — a null slot, a non-Row child, or a multi-Row Fragment cannot let
  // the parity check pass on the wrong count (it counts elements, not raw child-array slots).
  function countRows(node: unknown): number {
    if (Array.isArray(node)) return node.reduce((n: number, c) => n + countRows(c), 0);
    if (!isValidElement(node)) return 0;
    if (node.type === Row) return 1; // banner rows are leaves — do not descend into a Row
    return countRows((node.props as { children?: unknown }).children);
  }
  function renderedRows(snap: TuiSnapshot, nowMs: number): number {
    return countRows(ThrottleBanner({ snap, nowMs }));
  }

  test("count, reasons list, and rendered rows agree across all 8 banner states", () => {
    for (const core of [null, LIVE] as const)
      for (const gql of [null, LIVE] as const)
        for (const budget of [false, true] as const) {
          const snap = snapWith({ coreUntil: core, gqlUntil: gql, budget });
          const expected = (core ? 1 : 0) + (gql ? 1 : 0) + (budget ? 1 : 0);
          const label = `core=${core != null} gql=${gql != null} budget=${budget}`;
          expect(activeBannerReasons(snap, NOW).length, label).toBe(expected);
          expect(bannerLineCount(snap, NOW), label).toBe(expected);
          expect(renderedRows(snap, NOW), label).toBe(expected);
        }
  });

  test("expired and exact-boundary horizons are not paused (0 banner rows)", () => {
    for (const until of [EXPIRED, EXACT] as const) {
      const snap = snapWith({ coreUntil: until, gqlUntil: until });
      expect(activeBannerReasons(snap, NOW).length).toBe(0);
      expect(bannerLineCount(snap, NOW)).toBe(0);
      expect(renderedRows(snap, NOW)).toBe(0);
    }
  });

  test("reason order is stable: core, then graphql, then budget-exhausted", () => {
    const snap = snapWith({ coreUntil: LIVE, gqlUntil: LIVE, budget: true });
    expect(activeBannerReasons(snap, NOW).map((r) => (r.kind === "paused" ? r.resource : r.kind))).toEqual([
      "core",
      "graphql",
      "budget-exhausted",
    ]);
  });
});
