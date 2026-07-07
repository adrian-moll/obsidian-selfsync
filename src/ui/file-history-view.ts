/**
 * File-history view (D8/FR13) — DESKTOP ONLY. Lists Git commits for the active
 * note; lets you view or restore a past version. GitBackup is provided lazily by
 * the plugin (type-only import here, so this file never pulls Node fs on mobile).
 */
import { ItemView, Modal, Notice, type App, type WorkspaceLeaf } from "obsidian";
import type { CommitInfo, GitBackup } from "../git/git-backup.js";

export const VIEW_TYPE_FILE_HISTORY = "selfsync-file-history";

export class FileHistoryView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly getBackup: () => Promise<GitBackup | null>,
    private readonly getActivePath: () => string | null,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_FILE_HISTORY;
  }
  getDisplayText(): string {
    return "File history";
  }
  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }
  async onClose(): Promise<void> {}

  async render(): Promise<void> {
    const c = this.contentEl;
    c.empty();
    c.addClass("selfsync-view");

    const head = c.createDiv({ cls: "selfsync-section-head" });
    head.createEl("h4", { text: "File history" });
    head.createEl("button", { text: "Refresh" }).onclick = () => void this.render();

    const filePath = this.getActivePath();
    if (!filePath) {
      c.createDiv({ cls: "selfsync-empty", text: "Open a note to see its Git history." });
      return;
    }
    c.createEl("p", { cls: "setting-item-description", text: filePath });

    const backup = await this.getBackup();
    if (!backup) {
      c.createDiv({ cls: "selfsync-empty", text: "Git backup is not enabled (Settings → SelfSync)." });
      return;
    }

    let commits: CommitInfo[];
    try {
      commits = await backup.log(filePath);
    } catch (e) {
      c.createDiv({ cls: "selfsync-error", text: "Error reading history: " + msg(e) });
      return;
    }
    if (commits.length === 0) {
      c.createDiv({ cls: "selfsync-empty", text: "No commits for this file yet." });
      return;
    }

    const list = c.createEl("ul");
    for (const commit of commits) {
      const li = list.createEl("li");
      const when = new Date(commit.timestamp * 1000).toLocaleString();
      li.createDiv({ text: `${when} — ${commit.message}` });
      const actions = li.createDiv({ cls: "selfsync-section-head" });
      actions.createEl("button", { text: "View" }).onclick = () => void this.viewVersion(backup, commit, filePath);
      actions.createEl("button", { text: "Restore" }).onclick = () => void this.restore(backup, commit, filePath);
    }
  }

  private async viewVersion(backup: GitBackup, commit: CommitInfo, filePath: string): Promise<void> {
    try {
      const content = await backup.readFileAt(commit.oid, filePath);
      new VersionModal(this.app, filePath, commit, content, () => void this.restore(backup, commit, filePath)).open();
    } catch (e) {
      new Notice("SelfSync: " + msg(e));
    }
  }

  private async restore(backup: GitBackup, commit: CommitInfo, filePath: string): Promise<void> {
    try {
      await backup.restore(commit.oid, filePath);
      new Notice(`SelfSync: restored ${filePath} from ${commit.oid.slice(0, 7)} — it will sync as a new change.`);
    } catch (e) {
      new Notice("SelfSync restore failed: " + msg(e));
    }
  }
}

class VersionModal extends Modal {
  constructor(
    app: App,
    private readonly filePath: string,
    private readonly commit: CommitInfo,
    private readonly content: string,
    private readonly onRestore: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: `${this.filePath} @ ${this.commit.oid.slice(0, 7)}` });
    const ta = contentEl.createEl("textarea", { cls: "selfsync-activity-log" });
    ta.value = this.content;
    ta.readOnly = true;
    ta.rows = 20;
    contentEl.createEl("button", { text: "Restore this version" }).onclick = () => {
      this.onRestore();
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
