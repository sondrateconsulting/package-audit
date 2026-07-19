// panels.test.ts — §U8.11: panel frames over canned store states, mounted via the REAL adapter
// against capture streams (the P0-cleared harness; ink-testing-library's fake stdout carries no
// rows, and the layout planner treats undefined dimensions as the EMPTY frame — so the real
// adapter with sized streams is the honest harness here). ANSI is stripped before asserting;
// assertions run on the FULL captured byte stream after unmount, which is valid in interactive
// AND CI rendering modes (P0 measurement).
import { expect, test, describe, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { mountTui } from "./mount.tsx";
import { createTuiStore, type TuiStore } from "./store.ts";
import { sanitizeLine } from "./format.ts";
import { PAUSE_BUDGET_CAP_MINUTES } from "./panels.tsx";
import { MAX_TOTAL_PAUSE_MS } from "../github.ts";
import { resetTuiFailure, type ProgressEvent } from "../progress.ts";

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
    expect(text).toContain("core 4,812/5,000 resets 12:34");
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
    expect(text).toContain("JSONL → /out/logs/audit-log-20260718T211530Z-p4242.jsonl");
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
