/** Plugin settings model + settings tab. M0 exposes a minimal skeleton. */
import { type App, PluginSettingTab, Setting } from "obsidian";
import type SelfSyncPlugin from "./main.js";

export type BackendType = "webdav" | "couchdb";

export interface SelfSyncSettings {
  backendType: BackendType;
  webdav: { url: string; username: string; password: string; rootDir: string };
  couchdb: { url: string; username: string; password: string; database: string };
  encryptionEnabled: boolean;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;
  syncOnFileChange: boolean;
  excludeGlobs: string[];
  /** Stable per-device id, generated on first load. */
  deviceId: string;
}

export const DEFAULT_SETTINGS: SelfSyncSettings = {
  backendType: "webdav",
  webdav: { url: "", username: "", password: "", rootDir: "selfsync" },
  couchdb: { url: "", username: "", password: "", database: "obsidian" },
  encryptionEnabled: false,
  syncOnStartup: true,
  syncIntervalMinutes: 5,
  syncOnFileChange: true,
  excludeGlobs: [],
  deviceId: "",
};

export class SelfSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SelfSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "SelfSync" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Early development (M0). Configuration below is a skeleton; syncing is not functional yet.",
    });

    new Setting(containerEl)
      .setName("Backend")
      .setDesc("Where your vault is synced. WebDAV (e.g. Infomaniak kDrive) or a self-hosted CouchDB.")
      .addDropdown((d) =>
        d
          .addOption("webdav", "WebDAV")
          .addOption("couchdb", "CouchDB (self-hosted)")
          .setValue(this.plugin.settings.backendType)
          .onChange(async (value) => {
            this.plugin.settings.backendType = value as BackendType;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.backendType === "webdav") {
      new Setting(containerEl)
        .setName("WebDAV URL")
        .addText((t) =>
          t
            .setPlaceholder("https://…/dav/")
            .setValue(this.plugin.settings.webdav.url)
            .onChange(async (v) => {
              this.plugin.settings.webdav.url = v.trim();
              await this.plugin.saveSettings();
            }),
        );
      new Setting(containerEl).setName("WebDAV username").addText((t) =>
        t.setValue(this.plugin.settings.webdav.username).onChange(async (v) => {
          this.plugin.settings.webdav.username = v.trim();
          await this.plugin.saveSettings();
        }),
      );
      new Setting(containerEl)
        .setName("WebDAV password")
        .setDesc("For kDrive, use an app-specific password (not your login password).")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(this.plugin.settings.webdav.password).onChange(async (v) => {
            this.plugin.settings.webdav.password = v;
            await this.plugin.saveSettings();
          });
        });
      new Setting(containerEl)
        .setName("Sync folder")
        .setDesc("Folder on the WebDAV server that holds the synced data.")
        .addText((t) =>
          t.setValue(this.plugin.settings.webdav.rootDir).onChange(async (v) => {
            this.plugin.settings.webdav.rootDir = v.trim() || "selfsync";
            await this.plugin.saveSettings();
          }),
        );
    } else {
      new Setting(containerEl)
        .setName("CouchDB URL")
        .addText((t) =>
          t
            .setPlaceholder("https://…:6984")
            .setValue(this.plugin.settings.couchdb.url)
            .onChange(async (v) => {
              this.plugin.settings.couchdb.url = v.trim();
              await this.plugin.saveSettings();
            }),
        );
      new Setting(containerEl).setName("CouchDB database").addText((t) =>
        t.setValue(this.plugin.settings.couchdb.database).onChange(async (v) => {
          this.plugin.settings.couchdb.database = v.trim();
          await this.plugin.saveSettings();
        }),
      );
    }

    new Setting(containerEl)
      .setName("Hide file names (encrypted layout)")
      .setDesc(
        "Off (default): files are stored at their real paths — the server folder is browsable and mirrors your vault. " +
          "On: file names and folders are hidden behind opaque keys (not browsable). Full content encryption arrives in a later version.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.encryptionEnabled).onChange(async (v) => {
          this.plugin.settings.encryptionEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("How often to sync while Obsidian is open. Startup and on-change syncing are separate.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.syncIntervalMinutes = n;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
