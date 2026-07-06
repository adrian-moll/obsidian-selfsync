/**
 * Observable UI state for sync status. The plugin updates it around each sync
 * cycle; the ribbon/status-bar (StatusController) and the Sync view subscribe and
 * re-render. Keeps UI surfaces consistent (docs/10-ui-integration.md, FR11/FR12).
 */
import type { SyncStatusState } from "../types.js";

export interface SyncActivityEntry {
  time: string; // human-readable local time
  message: string;
}

export interface SyncUiState {
  status: SyncStatusState;
  detail: string;
  lastSyncIso: string | null;
  backendLabel: string;
  encrypted: boolean;
  lastError: string | null;
  conflicts: string[]; // conflict-copy paths from the latest sync
  activity: SyncActivityEntry[]; // most-recent first, capped
}

type Listener = (state: SyncUiState) => void;

const MAX_ACTIVITY = 50;

export class SyncStore {
  private state: SyncUiState = {
    status: "idle",
    detail: "Idle",
    lastSyncIso: null,
    backendLabel: "not configured",
    encrypted: false,
    lastError: null,
    conflicts: [],
    activity: [],
  };
  private readonly listeners = new Set<Listener>();

  get(): SyncUiState {
    return this.state;
  }

  /** Subscribe; fires immediately with current state. Returns an unsubscribe fn. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  update(patch: Partial<SyncUiState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  log(message: string): void {
    const entry: SyncActivityEntry = { time: new Date().toLocaleTimeString(), message };
    this.state = { ...this.state, activity: [entry, ...this.state.activity].slice(0, MAX_ACTIVITY) };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}
