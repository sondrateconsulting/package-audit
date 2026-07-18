import { expect, test, describe } from "bun:test";
import { boundedPool, Aborter } from "./boundedPool.ts";

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("boundedPool", () => {
  test("never runs more than `limit` workers concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const items = [0, 1, 2, 3, 4, 5];
    const p = boundedPool(items, 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight--;
      return 0;
    });
    await tick(10); // let all six launches settle onto the two slots
    expect(peak).toBe(2); // exactly the cap: 2 run, 4 queue
    release();
    await p;
    expect(peak).toBe(2); // never exceeded across the whole run
  });

  test("results are positionally aligned with input, regardless of completion order", async () => {
    // item 0 finishes LAST (longest delay); its result must still land at index 0.
    const results = await boundedPool([0, 1, 2, 3], 4, async (item) => {
      await tick((4 - item) * 5);
      return item * 10;
    });
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : r.status))).toEqual([0, 10, 20, 30]);
  });

  test("a throwing worker is captured as `rejected` and NEVER aborts its siblings (settle-all)", async () => {
    const results = await boundedPool([0, 1, 2], 3, async (item) => {
      if (item === 1) throw new Error("boom");
      return item;
    });
    expect(results[0]).toEqual({ status: "fulfilled", value: 0 });
    expect(results[1]!.status).toBe("rejected");
    expect((results[1] as { reason: Error }).reason.message).toBe("boom");
    expect(results[2]).toEqual({ status: "fulfilled", value: 2 }); // sibling completed despite the throw
  });

  test("the returned promise NEVER rejects even when every worker throws", async () => {
    // A bare Promise.all would reject on the first throw and resolve while other fibers still run —
    // the exact fail-fast this pool must NOT do (db.close would race live writers, §7).
    const results = await boundedPool([0, 1], 2, async () => { throw new Error("x"); });
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });

  test("abort STOPS dispatch of not-yet-started items while DRAINING those already in flight", async () => {
    const aborter = new Aborter();
    const started: number[] = [];
    const results = await boundedPool([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      await Promise.resolve(); // yield so BOTH slot-0 and slot-1 items dispatch before anyone aborts
      if (item === 0) aborter.abort();
      return item;
    }, { signal: aborter });
    // items 0 and 1 were both dispatched (in flight before the abort) → they DRAIN to fulfilled
    expect(results[0]).toEqual({ status: "fulfilled", value: 0 });
    expect(results[1]).toEqual({ status: "fulfilled", value: 1 });
    // items 2,3,4 were never pulled after the abort → skipped, and their workers never ran
    expect(results[2]).toEqual({ status: "skipped" });
    expect(results[3]).toEqual({ status: "skipped" });
    expect(results[4]).toEqual({ status: "skipped" });
    expect(started).toEqual([0, 1]);
  });

  test("a pre-aborted signal skips every item (nothing dispatched)", async () => {
    const aborter = new Aborter();
    aborter.abort();
    let ran = 0;
    const results = await boundedPool([0, 1, 2], 3, async () => { ran++; return 0; }, { signal: aborter });
    expect(ran).toBe(0);
    expect(results.every((r) => r.status === "skipped")).toBe(true);
  });

  test("empty items yields an empty result and runs no worker", async () => {
    let ran = 0;
    const results = await boundedPool([], 4, async () => { ran++; return 0; });
    expect(results).toEqual([]);
    expect(ran).toBe(0);
  });

  test("limit larger than the item count just runs them all at once", async () => {
    const results = await boundedPool([1, 2, 3], 100, async (x) => x + 1);
    expect(results).toEqual([
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 3 },
      { status: "fulfilled", value: 4 },
    ]);
  });
});

describe("Aborter", () => {
  test("onAbort fires on later abort, exactly once, and immediately if already aborted", () => {
    const a = new Aborter();
    let fired = 0;
    a.onAbort(() => { fired++; });
    expect(a.aborted).toBe(false);
    a.abort();
    expect(a.aborted).toBe(true);
    expect(fired).toBe(1);
    a.abort(); // idempotent — no re-fire
    expect(fired).toBe(1);
    // a callback registered AFTER abort fires synchronously
    let late = 0;
    a.onAbort(() => { late++; });
    expect(late).toBe(1);
  });

  test("onAbort returns an unsubscribe: an unsubscribed callback does NOT fire on abort", () => {
    const a = new Aborter();
    const fired: number[] = [];
    const unsubs = [0, 1, 2, 3].map((i) => a.onAbort(() => fired.push(i)));
    unsubs[1]!(); // drop callback 1
    unsubs[3]!(); // drop callback 3
    a.abort();
    expect(fired).toEqual([0, 2]); // only the still-subscribed callbacks fired, in registration order
  });

  test("unsubscribe is idempotent — a second call (and a call after abort) is a harmless no-op", () => {
    const a = new Aborter();
    let fired = 0;
    const unsub = a.onAbort(() => { fired++; });
    unsub();
    unsub(); // second unsubscribe: no throw, no effect
    a.abort();
    expect(fired).toBe(0); // stayed unsubscribed
    // an unsubscribe called AFTER the callback already fired is also a no-op
    let fired2 = 0;
    const unsub2 = a.onAbort(() => { fired2++; }); // fires immediately (already aborted)
    expect(fired2).toBe(1);
    expect(() => unsub2()).not.toThrow();
    expect(fired2).toBe(1);
  });

  test("the callback list does not grow across many onAbort()+unsubscribe cycles (no accumulation)", () => {
    const a = new Aborter();
    const internal = a as unknown as { callbacks: unknown[] };
    for (let i = 0; i < 10_000; i++) a.onAbort(() => {})(); // register then immediately unsubscribe
    expect(internal.callbacks.length).toBe(0); // every callback was removed — nothing accumulated
    // and a still-subscribed callback registered afterward still fires
    let fired = 0;
    a.onAbort(() => { fired++; });
    a.abort();
    expect(fired).toBe(1);
  });
});
