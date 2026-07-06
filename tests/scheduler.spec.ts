import { describe, expect, it } from "vitest";
import { SyncScheduler, type Timers } from "../src/engine/scheduler.js";

/** Deterministic fake timers: capture callbacks and fire them on demand. */
class FakeTimers implements Timers {
  private id = 0;
  timeouts = new Map<number, () => void>();
  intervals = new Map<number, () => void>();

  setTimeout(fn: () => void): unknown {
    const id = ++this.id;
    this.timeouts.set(id, fn);
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
    const fns = [...this.timeouts.values()];
    this.timeouts.clear();
    fns.forEach((f) => f());
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
});
