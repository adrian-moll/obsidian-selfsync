/**
 * Conflict resolver (D9/FR12): a side-by-side diff of the current file vs a
 * conflict copy, with an editable merged result. On save, the caller writes the
 * merged text to the canonical file and deletes the copy.
 */
import { type App, Modal } from "obsidian";
import { lineDiff } from "../util/line-diff.js";

export interface ConflictResolveOpts {
  canonicalPath: string;
  currentText: string;
  conflictPath: string;
  conflictText: string;
}

export class ConflictResolveModal extends Modal {
  private result: HTMLTextAreaElement | null = null;

  constructor(
    app: App,
    private readonly opts: ConflictResolveOpts,
    private readonly onResolve: (mergedText: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("selfsync-resolve");
    contentEl.createEl("h3", { text: `Resolve conflict: ${this.opts.canonicalPath}` });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `Left = current file. Right = conflict copy (${this.opts.conflictPath}). Changed lines are highlighted.`,
    });

    const diff = contentEl.createDiv({ cls: "selfsync-diff" });
    for (const row of lineDiff(this.opts.currentText, this.opts.conflictText)) {
      const r = diff.createDiv({ cls: "selfsync-diff-row" + (row.changed ? " changed" : "") });
      r.createDiv({ cls: "selfsync-diff-cell", text: row.left ?? "" });
      r.createDiv({ cls: "selfsync-diff-cell", text: row.right ?? "" });
    }

    contentEl.createEl("h4", { text: "Merged result (edit as needed)" });
    const ta = contentEl.createEl("textarea", { cls: "selfsync-activity-log" });
    ta.value = this.opts.currentText;
    ta.rows = 12;
    this.result = ta;

    const quick = contentEl.createDiv({ cls: "selfsync-section-head" });
    quick.createEl("button", { text: "Use current" }).onclick = () => {
      ta.value = this.opts.currentText;
    };
    quick.createEl("button", { text: "Use conflict copy" }).onclick = () => {
      ta.value = this.opts.conflictText;
    };

    const actions = contentEl.createDiv({ cls: "selfsync-section-head" });
    const save = actions.createEl("button", { text: "Save & remove copy", cls: "mod-cta" });
    save.onclick = () => {
      this.onResolve(this.result?.value ?? this.opts.currentText);
      this.close();
    };
    actions.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
