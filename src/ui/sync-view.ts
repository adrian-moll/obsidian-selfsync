/**
 * The Sync view: the main status dashboard, available on desktop and mobile
 * (docs/10-ui-integration.md). Renders live from the SyncStore — status, last
 * sync, active backend, a recent-activity log, and the conflicts list.
 */
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { SyncStore, SyncUiState } from "./sync-store.js";

export const VIEW_TYPE_SELFSYNC = "selfsync-view";

export class SelfSyncView extends ItemView {
  private unsubscribe?: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly store: SyncStore,
    private readonly onSyncNow: () => void,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_SELFSYNC;
  }

  getDisplayText(): string {
    return "SelfSync";
  }

  getIcon(): string {
    return "refresh-cw";
  }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.store.subscribe((s) => this.render(s));
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
  }

  private render(s: SyncUiState): void {
    const c = this.contentEl;
    c.empty();
    c.addClass("selfsync-view");

    const header = c.createDiv({ cls: "selfsync-status-header" });
    header.createSpan({ cls: `selfsync-status-dot is-${s.status}` });
    header.createSpan({ text: s.detail || s.status });

    const meta = c.createDiv({ cls: "selfsync-section" });
    meta.createEl("h4", { text: "Status" });
    const list = meta.createEl("ul");
    list.createEl("li", {
      text: `Last sync: ${s.lastSyncIso ? new Date(s.lastSyncIso).toLocaleString() : "never"}`,
    });
    list.createEl("li", { text: `Backend: ${s.backendLabel}` });
    list.createEl("li", { text: `Layout: ${s.encrypted ? "encrypted (opaque)" : "browsable (mirror)"}` });
    if (s.lastError) list.createEl("li", { text: `Error: ${s.lastError}`, cls: "selfsync-error" });

    const sync = c.createDiv({ cls: "selfsync-section" });
    const btn = sync.createEl("button", { text: "Sync now" });
    btn.onclick = () => this.onSyncNow();

    const conflicts = c.createDiv({ cls: "selfsync-section" });
    conflicts.createEl("h4", { text: `Conflicts (${s.conflicts.length})` });
    if (s.conflicts.length === 0) {
      conflicts.createDiv({ cls: "selfsync-empty", text: "No conflicts." });
    } else {
      const ul = conflicts.createEl("ul");
      for (const path of s.conflicts) ul.createEl("li", { text: path });
    }

    const activity = c.createDiv({ cls: "selfsync-section" });
    activity.createEl("h4", { text: "Activity" });
    if (s.activity.length === 0) {
      activity.createDiv({ cls: "selfsync-empty", text: "No sync has run yet." });
    } else {
      const log = activity.createDiv({ cls: "selfsync-activity-log" });
      for (const entry of s.activity) {
        log.createDiv({ text: `${entry.time}  ${entry.message}` });
      }
    }
  }
}
