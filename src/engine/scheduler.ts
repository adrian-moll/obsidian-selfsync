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
 *  - **Cooldown (rate limit):** AUTOMATIC triggers (interval, change, background)
 *    run at most once per {@link setCooldownMs} window — extra ones coalesce into
 *    a single run at the end of the window. This bounds battery/network use on a
 *    phone (many app-switch/visibility events collapse to one sync). MANUAL
 *    triggers bypass the cooldown and run immediately. Safe because convergence
 *    is guaranteed by the startup + interval syncs; auto triggers are best-effort.
 *
 * Timers are injected so the logic is deterministically testable.
 */
export type RunSync = (trigger: string) => Promise<void>;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Current time in ms (Date.now in production; a controllable clock in tests). */
  now(): number;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

export class SyncScheduler {
  private running = false;
  private pending: string | null = null;
  private debounceHandle: unknown = null;
  private intervalHandle: unknown = null;
  private cooldownHandle: unknown = null;
  private lastRunEndAt = 0;
  private cooldownMs = 0; // 0 = no cooldown

  constructor(
    private readonly run: RunSync,
    private readonly timers: Timers = realTimers,
  ) {}

  /** Minimum gap between AUTOMATIC syncs. 0 disables the rate limit. */
  setCooldownMs(ms: number): void {
    this.cooldownMs = Math.max(0, ms);
  }

  /**
   * Request a MANUAL/immediate sync — bypasses the cooldown. If one is already
   * running, the request is coalesced into a single follow-up run.
   */
  async trigger(label: string): Promise<void> {
    await this.dispatch(label, true);
  }

  /** Request an AUTOMATIC sync — subject to the cooldown, coalesced with others. */
  requestAuto(label: string): void {
    void this.dispatch(label, false);
  }

  private async dispatch(label: string, bypassCooldown: boolean): Promise<void> {
    if (this.running) {
      this.pending = label;
      return;
    }
    if (!bypassCooldown && this.cooldownMs > 0) {
      const wait = this.lastRunEndAt + this.cooldownMs - this.timers.now();
      if (wait > 0) {
        this.scheduleCooldownRun(label, wait);
        return;
      }
    }
    // A run is starting now → any scheduled cooldown run is redundant.
    if (this.cooldownHandle !== null) {
      this.timers.clearTimeout(this.cooldownHandle);
      this.cooldownHandle = null;
    }
    this.running = true;
    try {
      let next: string | null = label;
      while (next !== null) {
        this.pending = null;
        await this.run(next);
        this.lastRunEndAt = this.timers.now();
        next = this.pending;
        // A trigger arrived mid-run: honor the cooldown before the trailing run
        // instead of firing it back-to-back (the trailing run itself is auto).
        if (next !== null && this.cooldownMs > 0) {
          this.scheduleCooldownRun(next, this.cooldownMs);
          next = null;
        }
      }
    } finally {
      this.running = false;
      this.pending = null;
    }
  }

  /** Schedule (once) a coalesced auto-run `wait` ms from now. */
  private scheduleCooldownRun(label: string, wait: number): void {
    if (this.cooldownHandle !== null) return; // one already queued → coalesce
    this.cooldownHandle = this.timers.setTimeout(() => {
      this.cooldownHandle = null;
      void this.dispatch(label, true); // cooldown already elapsed → run now
    }, Math.max(0, wait));
  }

  /** Schedule a coalesced run after `delayMs` of quiet (resets on each call).
   *  Routes through the cooldown unless `bypassCooldown` (used for prompt retries). */
  requestDebounced(label: string, delayMs: number, bypassCooldown = false): void {
    if (this.debounceHandle !== null) this.timers.clearTimeout(this.debounceHandle);
    this.debounceHandle = this.timers.setTimeout(() => {
      this.debounceHandle = null;
      void this.dispatch(label, bypassCooldown);
    }, delayMs);
  }

  /** Start (or restart) a periodic trigger (auto → cooldown-limited). */
  startInterval(label: string, ms: number): void {
    this.stopInterval();
    this.intervalHandle = this.timers.setInterval(() => this.requestAuto(label), ms);
  }

  stopInterval(): void {
    if (this.intervalHandle !== null) {
      this.timers.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Cancel a pending debounced/cooldown run (e.g. when auto-sync is switched off). */
  cancelDebounce(): void {
    if (this.debounceHandle !== null) {
      this.timers.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.cooldownHandle !== null) {
      this.timers.clearTimeout(this.cooldownHandle);
      this.cooldownHandle = null;
    }
  }

  /** Cancel any pending debounce, cooldown, and interval (call on plugin unload). */
  dispose(): void {
    this.cancelDebounce();
    this.stopInterval();
  }

  get isRunning(): boolean {
    return this.running;
  }
}
