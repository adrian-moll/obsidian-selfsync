/**
 * The Sync view: the main status dashboard, available on desktop and mobile
 * (docs/10-ui-integration.md). M0 renders a static "not configured" placeholder;
 * live status, activity log, and the conflicts list are wired up in later
 * milestones.
 */
import { ItemView, type WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_SELFSYNC = "selfsync-view";

export class SelfSyncView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
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
    this.render();
  }

  async onClose(): Promise<void> {
    /* nothing to clean up yet */
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    c.addClass("selfsync-view");

    const header = c.createDiv({ cls: "selfsync-status-header" });
    header.createSpan({ cls: "selfsync-status-dot is-idle" });
    header.createSpan({ text: "Idle — not configured yet" });

    const activity = c.createDiv({ cls: "selfsync-section" });
    activity.createEl("h4", { text: "Activity" });
    activity.createDiv({ cls: "selfsync-empty", text: "No sync has run yet." });

    const conflicts = c.createDiv({ cls: "selfsync-section" });
    conflicts.createEl("h4", { text: "Conflicts" });
    conflicts.createDiv({ cls: "selfsync-empty", text: "No conflicts." });
  }
}
