/**
 * Drives the two always-available status surfaces: the ribbon icon (desktop +
 * mobile) and the desktop-only status bar. The Sync view (docs/10-ui-integration)
 * is the richer dashboard; this is the at-a-glance indicator.
 */
import { setIcon } from "obsidian";
import type { SyncStatusState } from "../types.js";

export interface StatusTargets {
  ribbonEl: HTMLElement;
  /** Desktop only — undefined on mobile (status bar is unavailable there). */
  statusBarEl?: HTMLElement;
}

const ICONS: Record<SyncStatusState, string> = {
  idle: "refresh-cw",
  syncing: "refresh-cw",
  error: "alert-triangle",
  conflicts: "git-merge",
};

export class StatusController {
  private state: SyncStatusState = "idle";

  constructor(private readonly targets: StatusTargets) {
    this.set("idle", "SelfSync: idle");
  }

  set(state: SyncStatusState, text: string): void {
    this.state = state;
    setIcon(this.targets.ribbonEl, ICONS[state]);
    this.targets.ribbonEl.setAttribute("aria-label", text);
    this.targets.ribbonEl.toggleClass("mod-error", state === "error");
    if (this.targets.statusBarEl) this.targets.statusBarEl.setText(text);
  }

  getState(): SyncStatusState {
    return this.state;
  }
}
