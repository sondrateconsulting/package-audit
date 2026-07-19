// store.test.ts — §U8.10: per-variant folds; ring cap; session-counter math; PAUSED derivation
// from horizon vs injected now; sticky budget-exhausted vs retryExhaustions; seed-vs-live
// precedence; unknown tapped events ignored; version bumps. Deterministic injected clock.
import { expect, test, describe } from "bun:test";
import { createTuiStore, isPaused, PROBLEM_RING_CAP, type TuiStore } from "./store.ts";
import type { ProgressEvent } from "../progress.ts";

function makeClock(startMs = 1_000): { store: TuiStore; tick: (ms: number) => void; now: () => number } {
  let now = startMs;
  const store = createTuiStore(() => now);
  return { store, tick: (ms) => (now += ms), now: () => now };
}

const jsonl = (event: Record<string, unknown>): ProgressEvent => ({ type: "jsonl", event });

describe("progress-event folds (§U4)", () => {
  test("phase, divert, and header identity from the tapped run event — and NOTHING from counts", () => {
    const { store } = makeClock();
    store.dispatch({ type: "phase", phase: "preflight" });
    expect(store.snapshot().phase).toBe("preflight");
    store.dispatch({ type: "divert", path: "/out/logs/a.jsonl" });
    expect(store.snapshot().logPath).toBe("/out/logs/a.jsonl");
    store.dispatch(jsonl({ event: "run", runId: "abc12345-full", resumed: true, counts: { done: 999, pending: 5 } }));
    const s = store.snapshot();
    expect(s.runId).toBe("abc12345-full");
    expect(s.resumed).toBe(true);
    // db.resumeInfo counts are whole-database row totals — the snapshot must not invent queue numbers
    expect(JSON.stringify(s)).not.toContain("999");
  });

  test("spawn spans: start/end pair by id, arrival-time stamped by the INJECTED clock", () => {
    const { store, tick } = makeClock(5_000);
    store.dispatch({ type: "spawn-start", id: 1, tool: "gh", label: "gh api repos" });
    tick(250);
    store.dispatch({ type: "spawn-start", id: 2, tool: "git", label: "git clone acme/api" });
    const live = store.snapshot().spawns;
    expect(live).toEqual([
      { id: 1, tool: "gh", label: "gh api repos", sinceMs: 5_000 },
      { id: 2, tool: "git", label: "git clone acme/api", sinceMs: 5_250 },
    ]);
    store.dispatch({ type: "spawn-end", id: 1 });
    expect(store.snapshot().spawns.map((s) => s.id)).toEqual([2]);
    store.dispatch({ type: "spawn-end", id: 2 });
    expect(store.snapshot().spawns).toEqual([]);
  });

  test("fetch + introspect spans and the semaphore waiter gauge", () => {
    const { store } = makeClock();
    store.dispatch({ type: "fetch-start", id: 7, kind: "packument", label: "packument expo" });
    store.dispatch({ type: "introspect-start", id: 9, packageName: "expo", version: "52.0.0" });
    store.dispatch({ type: "spawn-queue", waiting: 3 });
    const s = store.snapshot();
    expect(s.fetches).toEqual([{ id: 7, kind: "packument", label: "packument expo", sinceMs: 1_000 }]);
    expect(s.introspections).toEqual([{ id: 9, packageName: "expo", version: "52.0.0", sinceMs: 1_000 }]);
    expect(s.spawnWaiting).toBe(3);
    store.dispatch({ type: "fetch-end", id: 7 });
    store.dispatch({ type: "introspect-end", id: 9 });
    store.dispatch({ type: "spawn-queue", waiting: 0 });
    const after = store.snapshot();
    expect(after.fetches).toEqual([]);
    expect(after.introspections).toEqual([]);
    expect(after.spawnWaiting).toBe(0);
  });

  test("owner/repo brackets and caps from the tapped concurrency event", () => {
    const { store } = makeClock();
    store.dispatch(jsonl({ event: "concurrency", organizations: 3, branches: 4, repositories: 6 }));
    store.dispatch({ type: "owner-start", owner: "acme" });
    store.dispatch({ type: "owner-start", owner: "initech" });
    store.dispatch({ type: "repo-start", owner: "acme", repo: "api" });
    const s = store.snapshot();
    expect(s.owners).toEqual(["acme", "initech"]);
    expect(s.repoCount).toBe(1);
    expect(s.ownerCap).toBe(3);
    expect(s.branchCap).toBe(4);
    expect(s.spawnCap).toBe(6);
    store.dispatch({ type: "owner-end", owner: "acme" });
    store.dispatch({ type: "repo-end", owner: "acme", repo: "api" });
    expect(store.snapshot().owners).toEqual(["initech"]);
    expect(store.snapshot().repoCount).toBe(0);
  });

  test("unit-dispatch/settle is the occupancy signal; unit-start marks a real scan; settle clears BOTH", () => {
    const { store } = makeClock();
    store.dispatch({ type: "unit-dispatch", owner: "o", repo: "r", branch: "main" });
    store.dispatch({ type: "unit-dispatch", owner: "o", repo: "r", branch: "dev" });
    store.dispatch({ type: "unit-start", owner: "o", repo: "r", branch: "main" }); // dev is a skip — no scan
    let s = store.snapshot();
    expect(s.unitWorkers.map((u) => u.key).sort()).toEqual(["o/r@dev", "o/r@main"]);
    expect(s.scanning.map((u) => u.key)).toEqual(["o/r@main"]);
    // the tapped `scanned` JSONL line does NOT clear active state — settle is the only reliable end
    store.dispatch(jsonl({ event: "unit", org: "o", repo: "r", branch: "main", action: "scanned", deps: 1, usage: 2, cli: 0 }));
    s = store.snapshot();
    expect(s.scanning.map((u) => u.key)).toEqual(["o/r@main"]);
    store.dispatch({ type: "unit-settle", owner: "o", repo: "r", branch: "main" });
    store.dispatch({ type: "unit-settle", owner: "o", repo: "r", branch: "dev" });
    s = store.snapshot();
    expect(s.unitWorkers).toEqual([]);
    expect(s.scanning).toEqual([]);
  });
});

describe("limits + throttle (§U4)", () => {
  test("live rate-limit snapshots stamp arrival time; the seed folds ONLY into null slots", () => {
    const { store, tick } = makeClock(10_000);
    store.dispatch({ type: "rate-limit-seed", resource: "core", remaining: 4_800 });
    expect(store.snapshot().limits.core).toEqual({ remaining: 4_800, limit: null, resetEpochSec: null, asOfMs: 10_000 });
    tick(500);
    store.dispatch({ type: "rate-limit", resource: "core", remaining: 4_750, limit: 5_000, resetEpochSec: 999 });
    expect(store.snapshot().limits.core).toEqual({ remaining: 4_750, limit: 5_000, resetEpochSec: 999, asOfMs: 10_500 });
    // a LATER seed must NOT clobber the live snapshot with nulls
    store.dispatch({ type: "rate-limit-seed", resource: "core", remaining: 1 });
    expect(store.snapshot().limits.core!.remaining).toBe(4_750);
    // graphql slot is independent and still null
    expect(store.snapshot().limits.graphql).toBeNull();
  });

  test("quota folds VALIDATE their number slots — hostile runtime values fold to null, never into the snapshot", () => {
    // The seed's values originate in an UNVALIDATED external JSON body (preflight reads the
    // rate_limit response through a bare type assertion), so a hostile GHES/proxy payload can
    // put ANY runtime value in a number-typed field — including a control-byte string whose
    // toLocaleString would return its bytes verbatim into the render stream (§U0 pillar 9).
    // Spelled via fromCharCode so this source file itself carries no raw control bytes.
    const hostile = `${String.fromCharCode(0x9d)}0;pwn${String.fromCharCode(0x9c)}` as unknown as number;
    const { store } = makeClock(2_000);
    store.dispatch({ type: "rate-limit-seed", resource: "graphql", remaining: hostile });
    expect(store.snapshot().limits.graphql).toEqual({ remaining: null, limit: null, resetEpochSec: null, asOfMs: 2_000 });
    expect(JSON.stringify(store.snapshot())).not.toContain("pwn"); // the bytes never entered the store
    // the LIVE fold validates identically (NaN/Infinity/strings are not quota numbers)
    store.dispatch({ type: "rate-limit", resource: "core", remaining: NaN, limit: Infinity, resetEpochSec: "999" as unknown as number });
    expect(store.snapshot().limits.core).toEqual({ remaining: null, limit: null, resetEpochSec: null, asOfMs: 2_000 });
    // honest numbers still fold — the guard rejects shapes, not values
    store.dispatch({ type: "rate-limit", resource: "core", remaining: 4_000, limit: 5_000, resetEpochSec: 999 });
    expect(store.snapshot().limits.core).toEqual({ remaining: 4_000, limit: 5_000, resetEpochSec: 999, asOfMs: 2_000 });
  });

  test("PAUSED is DERIVED from horizon vs now — time, not events, clears it (no 'cleared' exists)", () => {
    const { store, now } = makeClock(1_000);
    store.dispatch({ type: "throttle", bucket: "core", state: "armed", untilMs: 5_000, budgetSpentMs: 4_000 });
    const t = store.snapshot().throttle.core;
    expect(t).toEqual({ horizonMs: 5_000, budgetSpentMs: 4_000 });
    expect(isPaused(t, now())).toBe(true); // 1_000 < 5_000
    expect(isPaused(t, 4_999)).toBe(true);
    expect(isPaused(t, 5_000)).toBe(false); // the horizon passing unpauses — no event needed
    expect(isPaused(null, 0)).toBe(false);
  });

  test("arm → waiting → re-arm extends the horizon; PAUSED holds until the LAST horizon", () => {
    const { store } = makeClock();
    store.dispatch({ type: "throttle", bucket: "graphql", state: "armed", untilMs: 3_000, budgetSpentMs: 2_000 });
    store.dispatch({ type: "throttle", bucket: "graphql", state: "waiting", untilMs: 3_000, budgetSpentMs: 2_000 });
    store.dispatch({ type: "throttle", bucket: "graphql", state: "armed", untilMs: 9_000, budgetSpentMs: 8_000 });
    const t = store.snapshot().throttle.graphql;
    expect(t).toEqual({ horizonMs: 9_000, budgetSpentMs: 8_000 });
    expect(isPaused(t, 8_999)).toBe(true);
    expect(isPaused(t, 9_001)).toBe(false);
  });

  test("exhausted reason budget sets the STICKY flag; reason retries only increments the counter — never conflated", () => {
    const { store } = makeClock();
    store.dispatch({ type: "throttle", bucket: "core", state: "exhausted", reason: "retries", untilMs: null, budgetSpentMs: 100 });
    let s = store.snapshot();
    expect(s.budgetExhausted).toBe(false);
    expect(s.retryExhaustions).toBe(1);
    store.dispatch({ type: "throttle", bucket: "core", state: "exhausted", reason: "budget", untilMs: null, budgetSpentMs: 500 });
    s = store.snapshot();
    expect(s.budgetExhausted).toBe(true);
    expect(s.retryExhaustions).toBe(1);
    // sticky: it cannot un-happen within a run
    store.dispatch({ type: "throttle", bucket: "core", state: "armed", untilMs: 9, budgetSpentMs: 500 });
    expect(store.snapshot().budgetExhausted).toBe(true);
  });
});

describe("session counters + findings (tapped unit events, §U4)", () => {
  test("per-action counter math, findings summed from scanned events' fields", () => {
    const { store } = makeClock();
    const unit = (action: string, extra: Record<string, unknown> = {}) =>
      store.dispatch(jsonl({ event: "unit", org: "o", repo: "r", branch: "b", action, ...extra }));
    unit("scanned", { deps: 3, usage: 10, cli: 1 });
    unit("scanned", { deps: 2, usage: 5, cli: 0 });
    unit("skip-current");
    unit("skip-cutoff");
    unit("skip-cutoff");
    unit("skip-policy");
    unit("past-cap");
    unit("error", { message: "git clone failed" });
    unit("requeue-throttle");
    const s = store.snapshot();
    expect(s.counters).toEqual({ scanned: 2, skipCurrent: 1, skipCutoff: 2, skipPolicy: 1, pastCap: 1, errored: 1, requeued: 1 });
    expect(s.findings).toEqual({ deps: 5, usage: 15, cli: 1 });
  });
});

describe("problems ring (§U4)", () => {
  test("folds errors and warnings with scope/target/message and arrival time", () => {
    const { store, tick } = makeClock(100);
    store.dispatch(jsonl({ event: "unit", org: "acme", repo: "api", branch: "dev", action: "error", message: "git clone failed: boom" }));
    tick(50);
    store.dispatch(jsonl({ event: "discovery", org: "acme", error: "repo discovery failed: 500" }));
    store.dispatch(jsonl({ event: "discovery", org: "acme", repo: "web", error: "branch discovery failed" }));
    store.dispatch(jsonl({ event: "introspection", packageName: "expo", version: "52.0.0", error: "tarball 500" }));
    store.dispatch(jsonl({ event: "introspection", packageName: "expo", error: "packument fetch failed" }));
    store.dispatch(jsonl({ event: "warning", reason: "clone-cleanup-failed", target: "/tmp/pkg-audit-x", message: "EBUSY" }));
    store.dispatch(jsonl({ event: "policy-warning", kind: "empty-allowlist" }));
    const p = store.snapshot().problems;
    expect(p).toEqual([
      { atMs: 100, kind: "error", scope: "scan", target: "acme/api@dev", message: "git clone failed: boom" },
      { atMs: 150, kind: "error", scope: "discovery", target: "acme", message: "repo discovery failed: 500" },
      { atMs: 150, kind: "error", scope: "discovery", target: "acme/web", message: "branch discovery failed" },
      { atMs: 150, kind: "error", scope: "introspection", target: "expo@52.0.0", message: "tarball 500" },
      { atMs: 150, kind: "error", scope: "introspection", target: "expo", message: "packument fetch failed" },
      { atMs: 150, kind: "warning", scope: "clone-cleanup-failed", target: "/tmp/pkg-audit-x", message: "EBUSY" },
      { atMs: 150, kind: "warning", scope: "policy", target: "empty-allowlist", message: "" },
    ]);
  });

  test("non-failure unit/discovery/introspection events fold NO problem", () => {
    const { store } = makeClock();
    store.dispatch(jsonl({ event: "unit", org: "o", repo: "r", branch: "b", action: "scanned", deps: 0, usage: 0, cli: 0 }));
    store.dispatch(jsonl({ event: "discovery", org: "o", action: "requeue-throttle", message: "throttled" }));
    store.dispatch(jsonl({ event: "introspection", packageName: "p", version: "1.0.0" }));
    expect(store.snapshot().problems).toEqual([]);
  });

  test(`the ring is capped at ${PROBLEM_RING_CAP} — oldest entries fall off`, () => {
    const { store } = makeClock();
    for (let i = 0; i < PROBLEM_RING_CAP + 10; i++)
      store.dispatch(jsonl({ event: "unit", org: "o", repo: "r", branch: `b${i}`, action: "error", message: `m${i}` }));
    const p = store.snapshot().problems;
    expect(p.length).toBe(PROBLEM_RING_CAP);
    expect(p[0]!.target).toBe("o/r@b10"); // the 10 oldest fell off
    expect(p[p.length - 1]!.target).toBe(`o/r@b${PROBLEM_RING_CAP + 9}`);
  });
});

describe("totality + version (§U4)", () => {
  test("unknown tapped events fold to nothing — the vocabulary can grow without touching the TUI", () => {
    const { store } = makeClock();
    const before = JSON.stringify(store.snapshot());
    store.dispatch(jsonl({ event: "some-future-event", weird: { nested: true } }));
    store.dispatch(jsonl({ event: "plan", org: "o", branchesEligible: 4 })); // plan events NOT projected
    store.dispatch(jsonl({ event: "plan-summary", owners: ["o"] }));
    store.dispatch(jsonl({})); // no event key at all
    store.dispatch(jsonl({ event: 42 } as unknown as Record<string, unknown>)); // non-string event
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });

  test("hostile field shapes never throw — the projection is total", () => {
    const { store } = makeClock();
    expect(() => {
      store.dispatch(jsonl({ event: "unit", action: "scanned", deps: "many", usage: null, cli: Infinity }));
      store.dispatch(jsonl({ event: "run", runId: 7, resumed: "yes" }));
      store.dispatch(jsonl({ event: "concurrency", organizations: "3" }));
      store.dispatch(jsonl({ event: "warning" }));
      store.dispatch(jsonl({ event: "discovery", error: 500 }));
    }).not.toThrow();
    const s = store.snapshot();
    expect(s.counters.scanned).toBe(1); // counted; the malformed finding fields fold as 0
    expect(s.findings).toEqual({ deps: 0, usage: 0, cli: 0 });
    expect(s.runId).toBeNull(); // a non-string runId is not adopted
  });

  test("version bumps PER MUTATION — no-op dispatches never wake the renderer (§U4)", () => {
    const { store } = makeClock();
    const v0 = store.version;
    store.dispatch({ type: "phase", phase: "scan" });
    expect(store.version).toBe(v0 + 1); // a fold that wrote state
    store.dispatch(jsonl({ event: "unknown" })); // unknown tapped events fold to nothing…
    store.dispatch(jsonl({ event: "config", packages: ["expo"] })); // …including un-projected config
    store.dispatch(jsonl({ event: "discovery", org: "acme" })); // …and a no-error discovery line
    store.dispatch({ type: "spawn-end", id: 999 }); // unknown span id — nothing to delete
    store.dispatch({ type: "spawn-queue", waiting: 0 }); // the gauge already reads 0
    expect(store.version).toBe(v0 + 1); // none of those mutated anything
    store.dispatch({ type: "rate-limit-seed", resource: "core", remaining: 100 });
    expect(store.version).toBe(v0 + 2); // an empty slot accepted the seed
    store.dispatch({ type: "rate-limit-seed", resource: "core", remaining: 50 }); // occupied — fold-if-absent no-op
    expect(store.version).toBe(v0 + 2);
    store.dispatch({ type: "owner-end", owner: "never-started" }); // unknown member — no write
    expect(store.version).toBe(v0 + 2);
  });

  test("the snapshot is a copy — mutating it cannot corrupt the store", () => {
    const { store } = makeClock();
    store.dispatch({ type: "spawn-start", id: 1, tool: "gh", label: "x" });
    const snap = store.snapshot();
    (snap.spawns as Array<unknown>).length = 0;
    (snap.counters as { scanned: number }).scanned = 99;
    expect(store.snapshot().spawns.length).toBe(1);
    expect(store.snapshot().counters.scanned).toBe(0);
  });
});
