/**
 * SelfSync plugin entry point.
 *
 * M0 scaffold: registers the Sync view, ribbon icon, desktop status bar,
 * commands, and settings tab. The sync engine itself is not wired to a real
 * backend yet (see docs/09-roadmap.md).
 */
import { Notice, Platform, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type SelfSyncSettings, SelfSyncSettingTab } from "./settings.js";
import { SelfSyncView, VIEW_TYPE_SELFSYNC } from "./ui/sync-view.js";
import { StatusController } from "./ui/status.js";

export default class SelfSyncPlugin extends Plugin {
  settings!: SelfSyncSettings;
  private status?: StatusController;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_SELFSYNC, (leaf) => new SelfSyncView(leaf));

    const ribbonEl = this.addRibbonIcon("refresh-cw", "SelfSync", () => {
      void this.activateView();
    });

    const statusBarEl = Platform.isDesktopApp ? this.addStatusBarItem() : undefined;
    this.status = new StatusController({ ribbonEl, statusBarEl });

    this.addCommand({
      id: "open-panel",
      name: "Open sync panel",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        this.syncNow();
      },
    });

    this.addSettingTab(new SelfSyncSettingTab(this.app, this));
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_SELFSYNC)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_SELFSYNC, active: true });
    workspace.revealLeaf(leaf);
  }

  syncNow(): void {
    this.status?.set("idle", "SelfSync: idle");
    new Notice("SelfSync: the sync engine is not implemented yet (M0 scaffold).");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.deviceId) {
      this.settings.deviceId = crypto.randomUUID();
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
