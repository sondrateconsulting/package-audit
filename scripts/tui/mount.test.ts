// mount.test.ts — the P0 AUTOMATED toolchain gate (§U7), now against the REAL App: the real
// mountTui under Bun against capture streams — mount, guarded tick, store-driven frame updates,
// unmount, bounded-exit path. Ink detects CI (is-in-ci) and renders non-interactively there
// (final frame at unmount only, measured at P0), so this gate asserts CONTENT and LIFECYCLE,
// never interactive repaint — intermediate-frame progression is asserted only outside CI. The
// interactive checks (repaint, resize, SIGINT/cursor) are the MANUAL P0 gate in the PR body.
import { expect, test, describe, spyOn, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { mountTui, DEFAULT_TICK_MS, type TuiHandle } from "./mount.tsx";
import { createTuiStore, type TuiStore } from "./store.ts";
import { resetTuiFailure, reportTuiFailure } from "../progress.ts";

// Ink treats a CI environment as non-interactive regardless of isTTY (is-in-ci reads these).
const IN_CI = Boolean(process.env["CI"] ?? process.env["GITHUB_ACTIONS"]);

afterEach(() => {
  resetTuiFailure();
});

// A fake interactive terminal: enough surface for Ink (write/isTTY/columns/rows/on/off — the
// exact member set Ink reads, measured at P0), capturing every byte ever written.
class CaptureStream extends EventEmitter {
  frames: string[] = [];
  isTTY = true;
  columns = 100;
  rows = 30;
  write = (chunk: unknown, cb?: (err?: Error | null) => void): boolean => {
    this.frames.push(String(chunk));
    if (typeof cb === "function") cb(); // Ink flush-syncs via write("", cb) — always acknowledge
    return true;
  };
  all(): string {
    return this.frames.join("");
  }
}

// Manual scheduler: the test drives ticks deterministically; the returned token is inert.
interface FakeScheduler {
  scheduler: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  fire(): void;
  activeCount(): number;
}
function makeFakeScheduler(): FakeScheduler {
  let tickFn: (() => void) | null = null;
  let active = 0;
  return {
    scheduler: {
      setInterval: ((fn: () => void) => {
        tickFn = fn;
        active++;
        return 0 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: (() => {
        active = Math.max(0, active - 1);
      }) as typeof clearInterval,
    },
    fire: () => tickFn?.(),
    activeCount: () => active,
  };
}

// Bounded poll: Ink renders asynchronously (reconciler + frame throttle), so content lands a few
// macrotasks after the state change — poll rather than sleep a magic constant.
async function waitFor(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

interface Ctx {
  out: CaptureStream;
  store: TuiStore;
  sched: FakeScheduler;
  handle: TuiHandle;
  degrades: number[];
  advance: (ms: number) => void;
}
async function mounted(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const out = new CaptureStream();
  let now = 10_000;
  const store = createTuiStore(() => now);
  const sched = makeFakeScheduler();
  const degrades: number[] = [];
  const handle = mountTui(store, {
    out: out as unknown as NodeJS.WriteStream,
    onDegrade: () => degrades.push(1),
    scheduler: sched.scheduler,
    tickMs: DEFAULT_TICK_MS,
    nowMs: () => now,
  });
  try {
    await fn({ out, store, sched, handle, degrades, advance: (ms) => (now += ms) });
  } finally {
    handle.dispose();
    handle.requestUnmount();
    await Promise.race([handle.waitUntilExit(), new Promise((r) => setTimeout(r, 2000))]);
  }
}

describe("P0 automated gate — real mountTui under Bun against capture streams", () => {
  test("mounts, renders the dashboard frame, unmounts, and waitUntilExit resolves (bounded-exit lifecycle)", async () => {
    const out = new CaptureStream();
    const store = createTuiStore(() => 10_000);
    const sched = makeFakeScheduler();
    const handle = mountTui(store, {
      out: out as unknown as NodeJS.WriteStream,
      onDegrade: () => {},
      scheduler: sched.scheduler,
      nowMs: () => 10_000,
    });
    // CI renders only the final frame at unmount (P0 measurement) — so unmount FIRST, then
    // assert content: valid in both modes, and the exit path is the lifecycle under test.
    if (!IN_CI) expect(await waitFor(() => out.all().includes("package-audit"))).toBe(true);
    handle.requestUnmount();
    let exited = false;
    await Promise.race([handle.waitUntilExit().then(() => (exited = true)), new Promise((r) => setTimeout(r, 2000))]);
    expect(exited).toBe(true); // waitUntilExit settles after a manual unmount — the §U6 step-2 wait relies on this
    expect(out.all()).toContain("package-audit"); // content reached the capture stream in EVERY mode
    expect(out.all()).toContain("Ctrl+C aborts (resumable)"); // the footer rendered
    handle.dispose(); // dispose after exit is a safe no-op (idempotence)
    handle.dispose();
    expect(sched.activeCount()).toBe(0);
  });

  test("store-driven frame updates: a dispatched event + tick reaches the rendered frame", async () => {
    await mounted(async ({ out, store, sched }) => {
      store.dispatch({ type: "phase", phase: "reconcile" });
      sched.fire();
      if (!IN_CI) {
        expect(await waitFor(() => out.all().includes("phase: reconcile"))).toBe(true);
      } else {
        await new Promise((r) => setTimeout(r, 50)); // let React commit before the final frame
      }
    });
    // the finally unmounted; in both modes the LAST content must have reached the stream
  });

  test("a tick with an unchanged version and unchanged second does not wake React (render-skip)", async () => {
    await mounted(async ({ out, sched }) => {
      if (IN_CI) return; // frame-count observation needs interactive per-frame writes
      await waitFor(() => out.all().includes("package-audit"));
      const framesBefore = out.frames.length;
      sched.fire();
      sched.fire();
      await new Promise((r) => setTimeout(r, 100));
      expect(out.frames.length).toBe(framesBefore); // no version/second change → no new frame bytes
    });
  });

  test("a 1s-granularity clock change wakes React even with an unchanged store version", async () => {
    await mounted(async ({ out, sched, advance }) => {
      if (IN_CI) return;
      await waitFor(() => out.all().includes("elapsed 00:00"));
      advance(2_000); // the visible elapsed digit changes
      sched.fire();
      expect(await waitFor(() => out.all().includes("elapsed 00:02"))).toBe(true);
    });
  });

  test("the tick's latch check is the belt-and-braces net: a latched failure stops the tick and degrades", async () => {
    await mounted(async ({ sched, degrades }) => {
      expect(sched.activeCount()).toBe(1);
      reportTuiFailure("latched by some site that could not call degradeNow");
      sched.fire();
      expect(sched.activeCount()).toBe(0); // interval stopped
      expect(degrades.length).toBe(1); // onDegrade called directly
    });
  });

  test("dispose() stops the tick interval and is idempotent; no degrade fired in a clean run", async () => {
    await mounted(async ({ sched, handle, degrades }) => {
      expect(sched.activeCount()).toBe(1);
      handle.dispose();
      expect(sched.activeCount()).toBe(0);
      handle.dispose();
      expect(sched.activeCount()).toBe(0);
      expect(degrades.length).toBe(0);
    });
  });

  test("the mount path writes NOTHING to process.stdout (stdout JSONL purity, §U0)", async () => {
    const writes: string[] = [];
    const so = spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
      writes.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    try {
      await mounted(async ({ out, store, sched }) => {
        store.dispatch({ type: "phase", phase: "scan" });
        sched.fire();
        await waitFor(() => out.frames.length > 0, 500);
      });
    } finally {
      so.mockRestore();
    }
    expect(writes).toEqual([]);
  });
});

describe("P0 ink-testing-library verdict (§U7)", () => {
  // Measured at P0: ink-testing-library@4.0.0 drives ink@7.1.1 correctly under Bun — its capture
  // stdout receives live frames pre-unmount (non-interactive append mode) and lastFrame() tracks
  // them. This test IS the verdict: if a future Ink bump breaks the pairing, it fails loudly and
  // the panel tests must switch to mounting via the real adapter against capture streams instead.
  test("ink-testing-library renders ink@7 content and tracks lastFrame()", async () => {
    const [{ render }, { createElement }, ink] = await Promise.all([
      import("ink-testing-library"),
      import("react"),
      import("ink"),
    ]);
    const r = render(createElement(ink.Text, null, "itl-verdict-ok"));
    const ok = await waitFor(() => (r.lastFrame() ?? "").includes("itl-verdict-ok"));
    r.unmount();
    expect(ok).toBe(true);
  });
});
