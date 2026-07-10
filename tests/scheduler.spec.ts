import { describe, expect, it } from "vitest";
import { SyncScheduler, type Timers } from "../src/engine/scheduler.js";

/** Deterministic fake timers: capture callbacks and fire them on demand, with a
 *  controllable clock for cooldown tests (delays are recorded per timeout). */
class FakeTimers implements Timers {
  private id = 0;
  clock = 0;
  timeouts = new Map<number, { fn: () => void; at: number }>();
  intervals = new Map<number, () => void>();

  now(): number {
    return this.clock;
  }
  /** Advance the clock and fire any timeouts whose deadline has passed. */
  advance(ms: number): void {
    this.clock += ms;
    for (const [id, t] of [...this.timeouts]) {
      if (t.at <= this.clock) {
        this.timeouts.delete(id);
        t.fn();
      }
    }
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.id;
    this.timeouts.set(id, { fn, at: this.clock + ms });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timeouts.delete(h as number);
  }
  setInterval(fn: () => void): unknown {
    const id = ++this.id;
    this.intervals.set(id, fn);
    return id;
  }
  clearInterval(h: unknown): void {
    this.intervals.delete(h as number);
  }

  fireTimeouts(): void {
    const entries = [...this.timeouts.values()];
    this.timeouts.clear();
    entries.forEach((t) => t.fn());
  }
  fireIntervalOnce(): void {
    [...this.intervals.values()].forEach((f) => f());
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A run() whose completion the test controls. */
function deferredRun() {
  const resolvers: Array<() => void> = [];
  let calls = 0;
  const labels: string[] = [];
  const run = (label: string): Promise<void> => {
    calls++;
    labels.push(label);
    return new Promise<void>((resolve) => resolvers.push(resolve));
  };
  return {
    run,
    get calls() {
      return calls;
    },
    labels,
    finishNext() {
      const r = resolvers.shift();
      if (r) r();
    },
  };
}

describe("SyncScheduler", () => {
  it("is single-flight and coalesces overlapping requests into one follow-up", async () => {
    const d = deferredRun();
    const s = new SyncScheduler(d.run, new FakeTimers());

    void s.trigger("startup"); // run #1 starts
    void s.trigger("edit"); // running → queued
    void s.trigger("edit2"); // running → collapses with the queued one
    await flush();
    expect(d.calls).toBe(1);

    d.finishNext(); // finish run #1 → exactly one follow-up run starts
    await flush();
    expect(d.calls).toBe(2);
    expect(d.labels[1]).toBe("edit2"); // last request wins

    d.finishNext(); // finish follow-up → nothing pending → stop
    await flush();
    expect(d.calls).toBe(2);
  });

  it("runs immediately when idle", async () => {
    const d = deferredRun();
    const s = new SyncScheduler(d.run, new FakeTimers());
    void s.trigger("manual");
    await flush();
    expect(d.calls).toBe(1);
    d.finishNext();
  });

  it("debounces rapid requests into a single run", async () => {
    const d = deferredRun();
    const timers = new FakeTimers();
    const s = new SyncScheduler(d.run, timers);

    s.requestDebounced("change", 500);
    s.requestDebounced("change", 500);
    s.requestDebounced("change", 500);
    expect(timers.timeouts.size).toBe(1); // only the latest survives
    expect(d.calls).toBe(0);

    timers.fireTimeouts();
    await flush();
    expect(d.calls).toBe(1);
    d.finishNext();
  });

  it("triggers on each interval tick and stops cleanly", async () => {
    const d = deferredRun();
    const timers = new FakeTimers();
    const s = new SyncScheduler(d.run, timers);

    s.startInterval("interval", 1000);
    expect(timers.intervals.size).toBe(1);

    timers.fireIntervalOnce();
    await flush();
    expect(d.calls).toBe(1);
    d.finishNext();
    await flush();

    s.stopInterval();
    expect(timers.intervals.size).toBe(0);
  });

  it("rate-limits automatic triggers to one per cooldown window", async () => {
    const d = deferredRun();
    const timers = new FakeTimers();
    timers.clock = 1_000_000; // like production: real clock ≫ 0, so the first run isn't deferred
    const s = new SyncScheduler(d.run, timers);
    s.setCooldownMs(1000);

    // First auto trigger runs immediately (last run was "never").
    s.requestAuto("interval");
    await flush();
    expect(d.calls).toBe(1);
    d.finishNext();
    await flush();

    // More auto triggers within the cooldown window do NOT run yet…
    s.requestAuto("background");
    s.requestAuto("background");
    await flush();
    expect(d.calls).toBe(1);

    // …they coalesce into a single run once the cooldown elapses.
    timers.advance(1000);
    await flush();
    expect(d.calls).toBe(2);
    d.finishNext();
    await flush();
    expect(d.calls).toBe(2);
  });

  it("manual triggers bypass the cooldown", async () => {
    const d = deferredRun();
    const timers = new FakeTimers();
    timers.clock = 1_000_000;
    const s = new SyncScheduler(d.run, timers);
    s.setCooldownMs(10_000);

    s.requestAuto("interval"); // runs now
    await flush();
    d.finishNext();
    await flush();
    expect(d.calls).toBe(1);

    void s.trigger("manual"); // within cooldown, but manual → runs immediately
    await flush();
    expect(d.calls).toBe(2);
    d.finishNext();
  });
});
