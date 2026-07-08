/**
 * The Sync view: the main status dashboard, available on desktop and mobile
 * (docs/10-ui-integration.md). Renders live from the SyncStore — status, last
 * sync, active backend, a recent-activity log, and the conflicts list.
 */
import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { SyncActivityEntry, SyncStore, SyncUiState } from "./sync-store.js";
import { relativeTime } from "../util/time.js";

export const VIEW_TYPE_SELFSYNC = "selfsync-view";

/** Git actions to surface as buttons when Git backup is enabled (desktop). */
export interface GitPanelActions {
  commitNow: () => void;
  pushNow: () => void;
  fileHistory: () => void;
}

export class SelfSyncView extends ItemView {
  private unsubscribe?: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly store: SyncStore,
    private readonly onSyncNow: () => void,
    private readonly onResolveConflict: (conflictPath: string) => void,
    private readonly gitActions: () => GitPanelActions | null,
    private readonly onTestConnection: () => Promise<{ ok: boolean; message: string }>,
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

    c.createEl("h4", { text: "SelfSync" });

    const header = c.createDiv({ cls: "selfsync-status-header" });
    header.createSpan({ cls: `selfsync-status-dot is-${s.status}` });
    header.createSpan({ text: s.detail || s.status });

    const meta = c.createDiv({ cls: "selfsync-section" });
    meta.createEl("h4", { text: "Status" });
    const list = meta.createEl("ul");
    list.createEl("li", { text: `Last sync: ${this.formatLastSync(s.lastSyncIso)}` });
    list.createEl("li", { text: `Backend: ${s.backendLabel}` });
    list.createEl("li", { text: `Layout: ${s.encrypted ? "encrypted (opaque)" : "browsable (mirror)"}` });
    list.createEl("li", { text: `Files synced: ${s.trackedFiles}` });
    if (s.skippedLarge > 0) {
      list.createEl("li", {
        text: `Skipped (too large): ${s.skippedLarge}`,
        cls: "selfsync-error",
      });
    }
    if (s.failedFiles > 0) {
      list.createEl("li", {
        text: `Failed (will retry): ${s.failedFiles}`,
        cls: "selfsync-error",
      });
    }
    if (s.gitPushPending) list.createEl("li", { text: "Git: changes pending push" });
    if (s.lastError) list.createEl("li", { text: `Error: ${s.lastError}`, cls: "selfsync-error" });

    const sync = c.createDiv({ cls: "selfsync-section" });
    const syncBar = sync.createDiv({ cls: "selfsync-section-head" });
    syncBar.createEl("button", { text: "Sync now" }).onclick = () => this.onSyncNow();
    const testBtn = syncBar.createEl("button", { text: "Test connection" });
    testBtn.onclick = () => void this.runTest(testBtn);

    const git = this.gitActions();
    if (git) {
      const gitSection = c.createDiv({ cls: "selfsync-section" });
      gitSection.createEl("h4", { text: "Git backup" });
      const bar = gitSection.createDiv({ cls: "selfsync-section-head" });
      bar.createEl("button", { text: "Commit now" }).onclick = () => git.commitNow();
      bar.createEl("button", { text: "Push now" }).onclick = () => git.pushNow();
      bar.createEl("button", { text: "File history" }).onclick = () => git.fileHistory();
    }

    const conflicts = c.createDiv({ cls: "selfsync-section" });
    conflicts.createEl("h4", { text: `Conflicts (${s.conflicts.length})` });
    if (s.conflicts.length === 0) {
      conflicts.createDiv({ cls: "selfsync-empty", text: "No conflicts." });
    } else {
      const ul = conflicts.createEl("ul");
      for (const path of s.conflicts) {
        const li = ul.createEl("li");
        const row = li.createDiv({ cls: "selfsync-section-head" });
        row.createSpan({ text: path });
        row.createEl("button", { text: "Resolve" }).onclick = () => this.onResolveConflict(path);
      }
    }

    const activity = c.createDiv({ cls: "selfsync-section" });
    const actHead = activity.createDiv({ cls: "selfsync-section-head" });
    actHead.createEl("h4", { text: "Activity" });
    if (s.activity.length > 0) {
      const copyBtn = actHead.createEl("button", { text: "Copy" });
      copyBtn.onclick = () => void this.copyLog(s.activity);
    }
    if (s.activity.length === 0) {
      activity.createDiv({ cls: "selfsync-empty", text: "No sync has run yet." });
    } else {
      const log = activity.createEl("textarea", { cls: "selfsync-activity-log" });
      log.readOnly = true;
      log.value = this.formatLog(s.activity);
    }
  }

  private formatLastSync(iso: string | null): string {
    if (!iso) return "never";
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return "never";
    return `${relativeTime(Math.floor(ms / 1000))} (${new Date(ms).toLocaleString()})`;
  }

  private async runTest(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = "Testing…";
    try {
      const res = await this.onTestConnection();
      new Notice(`SelfSync: ${res.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Test connection";
    }
  }

  private formatLog(activity: SyncActivityEntry[]): string {
    return activity.map((e) => `${e.time}  ${e.message}`).join("\n");
  }

  private async copyLog(activity: SyncActivityEntry[]): Promise<void> {
    const text = this.formatLog(activity);
    try {
      await navigator.clipboard.writeText(text);
      new Notice("SelfSync: activity log copied");
    } catch {
      new Notice("SelfSync: couldn't copy — select the text in the Activity box instead");
    }
  }
}
