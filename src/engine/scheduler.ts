/**
 * SyncScheduler — coalesces the M2 sync triggers (startup, interval,
 * debounced-on-change, best-effort quit/visibility flush) into a single-flight
 * runner (docs/05-sync-engine.md "Triggers", D5).
 *
 * Guarantees:
 *  - **Single-flight:** only one sync runs at a time.
 *  - **Coalescing:** requests that arrive while a sync is running collapse into
 *    exactly one follow-up run (so a burst of edits ⇒ at most one extra sync).
 *  - **Debounce:** rapid file changes schedule one run after a quiet period.
 *
 * Timers are injected so the logic is deterministically testable.
 */
export type RunSync = (trigger: string) => Promise<void>;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class SyncScheduler {
  private running = false;
  private pending: string | null = null;
  private debounceHandle: unknown = null;
  private intervalHandle: unknown = null;

  constructor(
    private readonly run: RunSync,
    private readonly timers: Timers = realTimers,
  ) {}

  /**
   * Request a sync. If one is already running, the request is coalesced into a
   * single follow-up run once the current one finishes. Resolves when no more
   * runs are pending.
   */
  async trigger(label: string): Promise<void> {
    if (this.running) {
      this.pending = label;
      return;
    }
    this.running = true;
    try {
      let next: string | null = label;
      while (next !== null) {
        this.pending = null;
        await this.run(next);
        next = this.pending; // anything requested during the run → run once more
      }
    } finally {
      this.running = false;
      this.pending = null;
    }
  }

  /** Schedule a coalesced run after `delayMs` of quiet (resets on each call). */
  requestDebounced(label: string, delayMs: number): void {
    if (this.debounceHandle !== null) this.timers.clearTimeout(this.debounceHandle);
    this.debounceHandle = this.timers.setTimeout(() => {
      this.debounceHandle = null;
      void this.trigger(label);
    }, delayMs);
  }

  /** Start (or restart) a periodic trigger. */
  startInterval(label: string, ms: number): void {
    this.stopInterval();
    this.intervalHandle = this.timers.setInterval(() => void this.trigger(label), ms);
  }

  stopInterval(): void {
    if (this.intervalHandle !== null) {
      this.timers.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Cancel any pending debounce and interval (call on plugin unload). */
  dispose(): void {
    if (this.debounceHandle !== null) {
      this.timers.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    this.stopInterval();
  }

  get isRunning(): boolean {
    return this.running;
  }
}
