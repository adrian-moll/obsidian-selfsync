/**
 * File-history view (D8/FR13, enhanced in M5b) — DESKTOP ONLY. Lists a note's Git
 * versions with a synthetic "Current" entry, rendered/source preview, any-two
 * side-by-side diff, and restore (confirmed). Follows the active note. GitBackup
 * is provided lazily by the plugin (type-only import → never pulls Node fs on
 * mobile).
 */
import { Component, ItemView, MarkdownRenderer, Modal, Notice, type App, type WorkspaceLeaf } from "obsidian";
import type { CommitInfo, GitBackup } from "../git/git-backup.js";
import { renderLineDiff } from "./diff-render.js";
import { relativeTime } from "../util/time.js";

export const VIEW_TYPE_FILE_HISTORY = "selfsync-file-history";

const CURRENT_ID = "current";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isMarkdown(path: string): boolean {
  const l = path.toLowerCase();
  return l.endsWith(".md") || l.endsWith(".markdown");
}

interface ViewState {
  path: string;
  backup: GitBackup | null;
  commits: CommitInfo[];
  currentText: string;
  error?: string;
}

export class FileHistoryView extends ItemView {
  private state: ViewState | null = null;
  private loadedPath: string | null = null;
  private selected: string[] = []; // entry ids selected for A↔B diff (max 2)
  private targetOverride: string | null = null; // pinned file (e.g. from right-click)

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
    return "SelfSync — File history";
  }
  getIcon(): string {
    return "history";
  }

  /** Show a specific file's history (e.g. from the file context menu). */
  showFile(path: string): void {
    this.targetOverride = path;
    void this.reload();
  }

  private currentTarget(): string | null {
    return this.targetOverride ?? this.getActivePath();
  }

  async onOpen(): Promise<void> {
    // Follow the active note; opening a file clears any pinned target.
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.targetOverride = null;
        void this.maybeReload();
      }),
    );
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.maybeReload()));
    await this.reload();
  }
  async onClose(): Promise<void> {}

  private async maybeReload(): Promise<void> {
    if (this.currentTarget() !== this.loadedPath) await this.reload();
  }

  private async reload(): Promise<void> {
    const path = this.currentTarget();
    this.loadedPath = path;
    this.selected = [];
    if (!path) {
      this.state = null;
      this.draw();
      return;
    }
    const backup = await this.getBackup();
    let commits: CommitInfo[] = [];
    let error: string | undefined;
    if (backup) {
      try {
        commits = await backup.log(path);
      } catch (e) {
        error = msg(e);
      }
    }
    const currentText = await this.app.vault.adapter.read(path).catch(() => "");
    this.state = { path, backup, commits, currentText, error };
    this.draw();
  }

  /** Content + label for an entry id ("current" or a commit oid). */
  private async contentFor(id: string): Promise<{ label: string; text: string }> {
    const s = this.state!;
    if (id === CURRENT_ID) return { label: "Current", text: s.currentText };
    const commit = s.commits.find((c) => c.oid === id)!;
    const text = await s.backup!.readFileAt(commit.oid, s.path);
    return { label: `${commit.oid.slice(0, 7)} · ${relativeTime(commit.timestamp)}`, text };
  }

  private draw(): void {
    const c = this.contentEl;
    c.empty();
    c.addClass("selfsync-view");

    const head = c.createDiv({ cls: "selfsync-section-head" });
    head.createEl("h4", { text: "SelfSync — File history" });
    head.createEl("button", { text: "Refresh" }).onclick = () => void this.reload();

    const s = this.state;
    if (!s) {
      c.createDiv({ cls: "selfsync-empty", text: "Open a note to see its Git history." });
      return;
    }
    c.createEl("p", { cls: "setting-item-description", text: s.path });

    if (!s.backup) {
      c.createDiv({ cls: "selfsync-empty", text: "Git backup is not enabled (Settings → SelfSync)." });
      return;
    }
    if (s.error) {
      c.createDiv({ cls: "selfsync-error", text: "Error reading history: " + s.error });
      return;
    }

    // Diff-selected bar.
    const bar = c.createDiv({ cls: "selfsync-section-head" });
    const diffBtn = bar.createEl("button", { text: `Diff selected (${this.selected.length}/2)` });
    diffBtn.disabled = this.selected.length !== 2;
    diffBtn.onclick = () => void this.openDiff(this.selected[0], this.selected[1]);

    const list = c.createEl("div", { cls: "selfsync-history" });
    this.drawEntry(list, CURRENT_ID, "Current", true, undefined);
    for (const commit of s.commits) {
      this.drawEntry(list, commit.oid, commit.message || "(no message)", false, commit);
    }
    if (s.commits.length === 0) {
      c.createDiv({ cls: "selfsync-empty", text: "No commits yet — this note is backed up on the next sync." });
    }
  }

  private drawEntry(
    parent: HTMLElement,
    id: string,
    label: string,
    isCurrent: boolean,
    commit: CommitInfo | undefined,
  ): void {
    const row = parent.createDiv({ cls: "selfsync-history-row" });

    const cb = row.createEl("input", { type: "checkbox" });
    cb.checked = this.selected.includes(id);
    cb.onchange = () => this.toggleSelected(id);

    const info = row.createDiv({ cls: "selfsync-history-info" });
    const title = info.createDiv();
    title.createSpan({ text: label });
    if (isCurrent) title.createSpan({ cls: "selfsync-badge", text: "current" });
    if (commit) {
      info.createDiv({
        cls: "setting-item-description",
        text: `${relativeTime(commit.timestamp)} · ${commit.oid.slice(0, 7)} · ${commit.author}`,
      });
    }

    const actions = row.createDiv({ cls: "selfsync-history-actions" });
    actions.createEl("button", { text: "View" }).onclick = () => void this.view(id, isCurrent);
    if (!isCurrent) {
      actions.createEl("button", { text: "Diff vs current" }).onclick = () => void this.openDiff(CURRENT_ID, id);
      actions.createEl("button", { text: "Restore" }).onclick = () => this.confirmRestore(commit!);
    }
  }

  private toggleSelected(id: string): void {
    const i = this.selected.indexOf(id);
    if (i >= 0) this.selected.splice(i, 1);
    else {
      this.selected.push(id);
      if (this.selected.length > 2) this.selected.shift(); // keep the last two
    }
    this.draw();
  }

  private async view(id: string, isCurrent: boolean): Promise<void> {
    try {
      const { text } = await this.contentFor(id);
      const s = this.state!;
      new VersionModal(this.app, {
        path: s.path,
        title: isCurrent ? `${s.path} — current` : `${s.path} @ ${id.slice(0, 7)}`,
        content: text,
        markdown: isMarkdown(s.path),
        onRestore: isCurrent ? undefined : () => this.confirmRestore(s.commits.find((c) => c.oid === id)!),
      }).open();
    } catch (e) {
      new Notice("SelfSync: " + msg(e));
    }
  }

  private async openDiff(idA: string, idB: string): Promise<void> {
    try {
      const a = await this.contentFor(idA);
      const b = await this.contentFor(idB);
      new DiffModal(this.app, { leftLabel: a.label, leftText: a.text, rightLabel: b.label, rightText: b.text }).open();
    } catch (e) {
      new Notice("SelfSync: " + msg(e));
    }
  }

  private confirmRestore(commit: CommitInfo): void {
    const s = this.state!;
    new ConfirmModal(
      this.app,
      `Restore "${s.path}" to version ${commit.oid.slice(0, 7)} (${relativeTime(commit.timestamp)})? This overwrites the current file; it will sync as a new change.`,
      () => {
        void (async () => {
          try {
            await s.backup!.restore(commit.oid, s.path);
            new Notice(`SelfSync: restored ${s.path} from ${commit.oid.slice(0, 7)}`);
            await this.reload();
          } catch (e) {
            new Notice("SelfSync restore failed: " + msg(e));
          }
        })();
      },
    ).open();
  }
}

class VersionModal extends Modal {
  private readonly component = new Component();
  private mode: "rendered" | "source" = "rendered";

  constructor(
    app: App,
    private readonly opts: { path: string; title: string; content: string; markdown: boolean; onRestore?: () => void },
  ) {
    super(app);
  }

  onOpen(): void {
    this.component.load();
    this.modalEl.addClass("selfsync-modal");
    const { contentEl } = this;
    contentEl.addClass("selfsync-resolve");
    contentEl.createEl("h3", { text: `SelfSync — ${this.opts.title}` });

    const body = contentEl.createDiv();
    const renderBody = () => {
      body.empty();
      if (this.opts.markdown && this.mode === "rendered") {
        const md = body.createDiv({ cls: "selfsync-rendered markdown-rendered" });
        void MarkdownRenderer.render(this.app, this.opts.content, md, this.opts.path, this.component);
      } else {
        const ta = body.createEl("textarea", { cls: "selfsync-activity-log" });
        ta.value = this.opts.content;
        ta.readOnly = true;
        ta.rows = 20;
      }
    };

    if (this.opts.markdown) {
      const toggle = contentEl.createDiv({ cls: "selfsync-section-head" });
      toggle.createEl("button", { text: "Rendered" }).onclick = () => {
        this.mode = "rendered";
        renderBody();
      };
      toggle.createEl("button", { text: "Source" }).onclick = () => {
        this.mode = "source";
        renderBody();
      };
    }
    renderBody();

    if (this.opts.onRestore) {
      const a = contentEl.createDiv({ cls: "selfsync-section-head" });
      a.createEl("button", { text: "Restore this version", cls: "mod-cta" }).onclick = () => {
        this.opts.onRestore?.();
        this.close();
      };
    }
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }
}

class DiffModal extends Modal {
  constructor(
    app: App,
    private readonly opts: { leftLabel: string; leftText: string; rightLabel: string; rightText: string },
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("selfsync-modal");
    const { contentEl } = this;
    contentEl.addClass("selfsync-resolve");
    contentEl.createEl("h3", { text: "SelfSync — Compare versions" });
    const labels = contentEl.createDiv({ cls: "selfsync-diff-labels" });
    labels.createDiv({ cls: "selfsync-diff-cell", text: `◀ ${this.opts.leftLabel}` });
    labels.createDiv({ cls: "selfsync-diff-cell", text: `${this.opts.rightLabel} ▶` });
    renderLineDiff(contentEl.createDiv(), this.opts.leftText, this.opts.rightText);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly message: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message });
    const bar = contentEl.createDiv({ cls: "selfsync-section-head" });
    bar.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    bar.createEl("button", { text: "Restore", cls: "mod-warning" }).onclick = () => {
      this.onConfirm();
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
