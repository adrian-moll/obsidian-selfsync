/**
 * A compact "Advanced" maintenance window opened from the sync panel. It's a dumb
 * action launcher: all logic lives in main.ts (which builds the groups), mirroring
 * the existing gitActions() pattern, so this modal has no plugin dependencies.
 */
import { type App, Modal } from "obsidian";

export interface AdvancedItem {
  label: string;
  hint?: string;
  run: () => void | Promise<void>;
  danger?: boolean;
}

export interface AdvancedGroup {
  title: string;
  items: AdvancedItem[];
}

export class AdvancedModal extends Modal {
  constructor(
    app: App,
    private readonly groups: AdvancedGroup[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("selfsync-advanced");
    contentEl.createEl("h3", { text: "SelfSync — Advanced" });

    for (const group of this.groups) {
      if (group.items.length === 0) continue;
      const section = contentEl.createDiv({ cls: "selfsync-section" });
      section.createEl("h4", { text: group.title });
      for (const item of group.items) {
        const row = section.createDiv({ cls: "selfsync-advanced-item" });
        const btn = row.createEl("button", {
          text: item.label,
          cls: item.danger ? "mod-warning" : undefined,
        });
        if (item.hint) row.createEl("div", { cls: "selfsync-advanced-hint", text: item.hint });
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            await item.run();
          } finally {
            btn.disabled = false;
          }
        };
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
