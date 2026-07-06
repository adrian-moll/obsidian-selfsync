/**
 * Drives the two always-available status surfaces from the SyncStore: the ribbon
 * icon (desktop + mobile) and the desktop-only status bar. The Sync view is the
 * richer dashboard; this is the at-a-glance indicator (docs/10-ui-integration.md).
 */
import { setIcon } from "obsidian";
import type { SyncStatusState } from "../types.js";
import type { SyncStore, SyncUiState } from "./sync-store.js";

const ICONS: Record<SyncStatusState, string> = {
  idle: "refresh-cw",
  syncing: "refresh-ccw",
  error: "alert-triangle",
  conflicts: "git-merge",
};

function shortTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function statusText(s: SyncUiState): string {
  switch (s.status) {
    case "syncing":
      return "SelfSync: syncing…";
    case "error":
      return `SelfSync: error — ${s.lastError ?? "see panel"}`;
    case "conflicts":
      return `SelfSync: ${s.conflicts.length} conflict(s)`;
    default:
      return s.lastSyncIso ? `SelfSync: synced ${shortTime(s.lastSyncIso)}` : "SelfSync: idle";
  }
}

export class StatusController {
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ribbonEl: HTMLElement,
    private readonly statusBarEl: HTMLElement | undefined,
    store: SyncStore,
  ) {
    this.unsubscribe = store.subscribe((s) => this.render(s));
  }

  private render(s: SyncUiState): void {
    setIcon(this.ribbonEl, ICONS[s.status]);
    const text = statusText(s);
    this.ribbonEl.setAttribute("aria-label", text);
    this.ribbonEl.toggleClass("mod-error", s.status === "error");
    this.statusBarEl?.setText(text);
  }

  dispose(): void {
    this.unsubscribe();
  }
}
