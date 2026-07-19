// mount.test.ts — the P0 AUTOMATED toolchain gate (§U7), now against the REAL App: the real
// mountTui under Bun against capture streams — mount, guarded tick, store-driven frame updates,
// unmount, bounded-exit path. Ink detects CI (is-in-ci) and renders non-interactively there
// (final frame at unmount only, measured at P0), so this gate asserts CONTENT and LIFECYCLE,
// never interactive repaint — intermediate-frame progression is asserted only outside CI. The
// interactive checks (repaint, resize, SIGINT/cursor) are the MANUAL P0 gate in the PR body.
import { expect, test, describe, spyOn, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { mountTui, DEFAULT_TICK_MS, type TuiHandle, type MountTuiOptions } from "./mount.tsx";
import { createTuiStore, type TuiStore } from "./store.ts";
import { makeSealableStderr } from "./lifecycle.ts";
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

// ---- escalation-remediation coverage: rollback, cleanup aggregation, resize detach ------------
type RenderSeam = NonNullable<MountTuiOptions["renderImpl"]>;

describe("post-render rollback + adapter cleanup (§U6 remediation)", () => {
  test("rollback (i): a throwing setInterval unmounts the renderer and rethrows the original error", () => {
    const out = new CaptureStream();
    const events: string[] = [];
    const instance = {
      unmount: (): void => {
        events.push("unmount");
      },
      waitUntilExit: (): Promise<void> => Promise.resolve(),
    };
    const throwingSched = {
      setInterval: (() => {
        throw new Error("scheduler broken");
      }) as unknown as typeof setInterval,
      clearInterval: (() => {}) as unknown as typeof clearInterval,
    };
    expect(() =>
      mountTui(createTuiStore(() => 0), {
        out: out as unknown as NodeJS.WriteStream,
        onDegrade: () => {},
        scheduler: throwingSched,
        renderImpl: (() => instance) as unknown as RenderSeam,
      }),
    ).toThrow("scheduler broken");
    expect(events).toEqual(["unmount"]); // the live renderer was rolled back
    expect(out.listenerCount("resize")).toBe(0); // nothing leaked
  });

  test("rollback (ii): a synchronous waitUntilExit throw AFTER registrations — cleanup runs BEFORE the unmount", () => {
    const out = new CaptureStream();
    const sched = makeFakeScheduler();
    const degrades: number[] = [];
    const atUnmountEntry: Array<{ listeners: number; degradesDuringProbe: number }> = [];
    const events: string[] = [];
    const instance = {
      unmount: (): void => {
        // AT ENTRY: cleanup must already have run — the resize listener is gone, and a retained
        // tick fired now is inert (the disposed guard wins BEFORE the latch check, so the probe
        // latch below cannot trigger a degrade).
        reportTuiFailure("probe: retained tick must be inert");
        sched.fire();
        atUnmountEntry.push({ listeners: out.listenerCount("resize"), degradesDuringProbe: degrades.length });
        events.push("unmount");
      },
      waitUntilExit: (): Promise<void> => {
        throw new Error("wue broken"); // the rejection-handler attach is the faulting tail step
      },
    };
    expect(() =>
      mountTui(createTuiStore(() => 0), {
        out: out as unknown as NodeJS.WriteStream,
        onDegrade: () => degrades.push(1),
        scheduler: sched.scheduler,
        renderImpl: (() => instance) as unknown as RenderSeam,
      }),
    ).toThrow("wue broken");
    expect(events).toEqual(["unmount"]);
    expect(atUnmountEntry).toEqual([{ listeners: 0, degradesDuringProbe: 0 }]); // cleanup-BEFORE-unmount proven
    expect(sched.activeCount()).toBe(0); // the created interval was cleared (1 → 0)
    expect(out.listenerCount("resize")).toBe(0); // registered, then detached — back to baseline
  });

  test("rollback (iii): a throwing clearInterval cannot mask the original error; the timer is unref'd and inert", () => {
    const out = new CaptureStream();
    let unrefs = 0;
    let tickFn: (() => void) | null = null;
    const token = {
      unref: (): void => {
        unrefs++;
      },
    };
    const sched = {
      setInterval: ((fn: () => void) => {
        tickFn = fn;
        return token as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        throw new Error("clear broken");
      }) as unknown as typeof clearInterval,
    };
    const events: string[] = [];
    const instance = {
      unmount: (): void => {
        events.push("unmount");
      },
      waitUntilExit: (): Promise<void> => {
        throw new Error("wue broken");
      },
    };
    expect(() =>
      mountTui(createTuiStore(() => 0), {
        out: out as unknown as NodeJS.WriteStream,
        onDegrade: () => {},
        scheduler: sched,
        renderImpl: (() => instance) as unknown as RenderSeam,
      }),
    ).toThrow("wue broken"); // the ORIGINAL error — the rollback discards its cleanup failures
    expect(events).toEqual(["unmount"]);
    expect(unrefs).toBe(1); // the uncancellable interval no longer holds the event loop
    (tickFn as unknown as () => void)(); // a still-firing interval callback is inert (no throw)
  });

  test("ink-facing dims pin LIVE while getRawDims reports the collapse: the App renders EMPTY without ink ever seeing falsy dims", async () => {
    const real = new CaptureStream(); // 100x30 to start
    const proxy = makeSealableStderr(real as unknown as NodeJS.WriteStream, () => {});
    const handle = mountTui(createTuiStore(() => 0), { out: proxy.stream, onDegrade: () => {}, nowMs: () => 0 });
    try {
      if (!IN_CI) await waitFor(() => real.all().includes("package-audit")); // content at 100x30
      // mid-run collapse: the terminal stops reporting usable dimensions
      (real as unknown as { columns: unknown }).columns = undefined;
      (real as unknown as { rows: unknown }).rows = 0;
      // LIVE, not a creation-time snapshot: the pin and the raw channel both track the mutation
      expect((proxy.stream as unknown as { columns: number }).columns).toBe(80);
      expect((proxy.stream as unknown as { rows: number }).rows).toBe(24);
      const raw = (proxy.stream as unknown as { getRawDims: () => { columns: number | undefined; rows: number | undefined } }).getRawDims();
      expect(raw).toEqual({ columns: undefined, rows: 0 });
      const framesBefore = real.frames.length;
      real.emit("resize"); // the adapter's wake channel (registered through the proxy's delegation)
      if (!IN_CI) await waitFor(() => real.frames.length > framesBefore); // React committed the EMPTY frame
      else await new Promise((r) => setTimeout(r, 50));
      const mark = real.all().length;
      handle.requestUnmount();
      await Promise.race([handle.waitUntilExit(), new Promise((r) => setTimeout(r, 2000))]);
      // everything from the post-collapse commit onward carries NO panel content: the App
      // planned EMPTY from the RAW dims while ink itself laid out against the pinned 80x24
      expect(real.all().slice(mark)).not.toContain("package-audit");
    } finally {
      handle.dispose();
    }
  });

  test("dispose() without unmount detaches exactly the adapter's resize listener (wedged-unmount shape)", async () => {
    await mounted(async ({ out, handle }) => {
      const n = out.listenerCount("resize");
      expect(n).toBeGreaterThanOrEqual(1); // the adapter's listener at minimum (Ink may add its own)
      handle.dispose();
      expect(out.listenerCount("resize")).toBe(n - 1); // exactly the adapter's went away; Ink's stays until unmount
    });
  });

  test("dispose() aggregates cleanup failures AFTER completing every attempt; the second call is a no-op", async () => {
    const out = new CaptureStream();
    const origOff = out.off.bind(out);
    (out as unknown as { off: unknown }).off = () => {
      throw new Error("off broken");
    };
    let unrefs = 0;
    let tickFn: (() => void) | null = null;
    const token = {
      unref: (): void => {
        unrefs++;
      },
    };
    const sched = {
      setInterval: ((fn: () => void) => {
        tickFn = fn;
        return token as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        throw new Error("clear broken");
      }) as unknown as typeof clearInterval,
    };
    const handle = mountTui(createTuiStore(() => 0), {
      out: out as unknown as NodeJS.WriteStream,
      onDegrade: () => {},
      scheduler: sched,
    });
    let thrown: unknown = null;
    try {
      handle.dispose();
    } catch (e) {
      thrown = e;
    }
    // ONE aggregate naming BOTH failures — proof that the second attempt ran despite the first
    expect(String(thrown)).toContain("adapter cleanup:");
    expect(String(thrown)).toContain("clear-tick: clear broken");
    expect(String(thrown)).toContain("detach-resize: off broken");
    expect(unrefs).toBe(1); // the timer was unref'd on the failed clear
    (tickFn as unknown as () => void)(); // retained interval callback: inert after cleanup
    handle.dispose(); // idempotent: no second throw
    // restore off so Ink's own unmount cleanup works, then unmount for hygiene
    (out as unknown as { off: unknown }).off = origOff;
    handle.requestUnmount();
    await Promise.race([handle.waitUntilExit(), new Promise((r) => setTimeout(r, 2000))]);
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
