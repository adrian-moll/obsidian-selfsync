/** A minimal yes/no confirmation modal (Obsidian has no built-in confirm). */
import { App, Modal, Setting } from "obsidian";

export class ConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private readonly opts: {
      title: string;
      body: string;
      confirmText: string;
      onConfirm: () => void;
      /** Called if the modal is dismissed without confirming (Cancel or close). */
      onCancel?: () => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.opts.title });
    contentEl.createEl("p", { text: this.opts.body });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.opts.confirmText)
          .setWarning()
          .onClick(() => {
            // Mark BEFORE close() so onClose() doesn't fire onCancel for a confirm.
            this.confirmed = true;
            this.close();
            this.opts.onConfirm();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.confirmed) this.opts.onCancel?.();
  }
}
