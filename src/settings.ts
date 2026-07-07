/** Plugin settings model + settings tab. M0 exposes a minimal skeleton. */
import { type App, Platform, PluginSettingTab, Setting } from "obsidian";
import type SelfSyncPlugin from "./main.js";
import { type SecretStorageMode } from "./util/secret-store.js";

export interface GitSettings {
  enabled: boolean;
  remoteUrl: string;
  username: string;
  token: string;
  authorName: string;
  authorEmail: string;
  commitOnSync: boolean;
  push: boolean;
  /** Files per commit/push when backing up (smaller = more, smaller pushes). */
  pushChunkSize: number;
}

export interface SelfSyncSettings {
  webdav: { url: string; username: string; password: string; rootDir: string };
  /** How the WebDAV password and Git token are stored at rest in data.json. */
  secretStorage: SecretStorageMode;
  encryptionEnabled: boolean;
  /** Sync the .obsidian config folder (default off — it churns across devices). */
  syncObsidianConfig: boolean;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;
  syncOnFileChange: boolean;
  excludeGlobs: string[];
  /** Desktop-only Git backup (D7/FR9). */
  git: GitSettings;
  /** Stable per-device id, generated on first load. */
  deviceId: string;
}

export const DEFAULT_SETTINGS: SelfSyncSettings = {
  webdav: { url: "", username: "", password: "", rootDir: "selfsync" },
  secretStorage: "keychain",
  encryptionEnabled: false,
  syncObsidianConfig: false,
  syncOnStartup: true,
  syncIntervalMinutes: 5,
  syncOnFileChange: true,
  excludeGlobs: [],
  git: {
    enabled: false,
    remoteUrl: "",
    username: "",
    token: "",
    authorName: "",
    authorEmail: "",
    commitOnSync: true,
    push: true,
    pushChunkSize: 100,
  },
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

    new Setting(containerEl).setName("WebDAV").setHeading();

    new Setting(containerEl)
      .setName("WebDAV URL")
      .setDesc("A WebDAV server you control — self-hosted (e.g. Apache mod_dav; see the user guide) or a hosted provider like Infomaniak kDrive.")
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
      .setDesc("For kDrive, use an app-specific password (not your login password). Stored per the Backend security setting below.")
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

    const securityBase = "How the WebDAV password and Git token are stored on this device (in data.json). ";
    const securitySetting = new Setting(containerEl)
      .setName("Backend security")
      .setDesc(securityBase)
      .addDropdown((d) =>
        d
          .addOption("keychain", "Device keychain (recommended)")
          .addOption("obfuscated", "Obfuscated")
          .addOption("plaintext", "Plaintext")
          .setValue(this.plugin.settings.secretStorage)
          .onChange(async (v) => {
            this.plugin.settings.secretStorage = v as SecretStorageMode;
            await this.plugin.saveSettings(); // re-writes the secrets in the new mode
            this.display();
          }),
      );
    // Probe whether real keychain encryption is available here, then annotate.
    void this.plugin.isKeychainAvailable().then((ok) => {
      securitySetting.setDesc(
        securityBase +
          (this.plugin.settings.secretStorage === "keychain"
            ? ok
              ? "Device keychain is active — real encryption via your OS keychain."
              : "Device keychain isn't available on this device — falling back to Obfuscated."
            : this.plugin.settings.secretStorage === "obfuscated"
              ? "Obfuscated: not stored as cleartext, but reversible — not real encryption."
              : "Plaintext: stored as-is. Anyone who can read the vault folder can read it."),
      );
    });

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
      .setName("Sync Obsidian config folder (.obsidian)")
      .setDesc(
        "Off (recommended): only notes and attachments sync. On: also sync .obsidian " +
          "(themes, plugin settings) — but Obsidian rewrites some config files per device, " +
          "which can cause repeated syncs and conflict copies.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncObsidianConfig).onChange(async (v) => {
          this.plugin.settings.syncObsidianConfig = v;
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

    new Setting(containerEl)
      .setName("Extra exclude patterns")
      .setDesc(
        "One glob per line, excluded from sync IN ADDITION to built-in defaults " +
          "(SelfSync's own plugin folder, Obsidian workspace files, .trash). " +
          "Use * within a folder and ** across folders, e.g. **/*.tmp",
      )
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.excludeGlobs.join("\n"));
        t.inputEl.rows = 4;
        t.onChange(async (v) => {
          this.plugin.settings.excludeGlobs = v
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          await this.plugin.saveSettings();
        });
      });

    if (Platform.isDesktopApp) this.renderGitSettings(containerEl);
  }

  private renderGitSettings(containerEl: HTMLElement): void {
    const g = this.plugin.settings.git;
    containerEl.createEl("h3", { text: "Git backup (desktop only)" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Auto-commit your vault to a Git remote for versioning. Independent of sync; never runs on mobile.",
    });

    new Setting(containerEl).setName("Enable Git backup").addToggle((t) =>
      t.setValue(g.enabled).onChange(async (v) => {
        g.enabled = v;
        await this.plugin.saveSettings();
        this.display();
      }),
    );
    if (!g.enabled) return;

    new Setting(containerEl)
      .setName("Remote URL")
      .setDesc("HTTPS Git remote, e.g. a self-hosted Gitea/GitLab repo.")
      .addText((t) =>
        t.setPlaceholder("https://git.example.com/you/vault.git").setValue(g.remoteUrl).onChange(async (v) => {
          g.remoteUrl = v.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl).setName("Username").addText((t) =>
      t.setValue(g.username).onChange(async (v) => {
        g.username = v.trim();
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl)
      .setName("Token / password")
      .setDesc("A personal access token is recommended.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(g.token).onChange(async (v) => {
          g.token = v;
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl).setName("Commit author name").addText((t) =>
      t.setValue(g.authorName).onChange(async (v) => {
        g.authorName = v;
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("Commit author email").addText((t) =>
      t.setValue(g.authorEmail).onChange(async (v) => {
        g.authorEmail = v.trim();
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl)
      .setName("Commit after each sync")
      .addToggle((t) =>
        t.setValue(g.commitOnSync).onChange(async (v) => {
          g.commitOnSync = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Push after commit")
      .addToggle((t) =>
        t.setValue(g.push).onChange(async (v) => {
          g.push = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Push batch size")
      .setDesc("Files per commit/push when backing up. Lower this if large pushes time out.")
      .addText((t) =>
        t.setValue(String(g.pushChunkSize)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1) {
            g.pushChunkSize = Math.floor(n);
            await this.plugin.saveSettings();
          }
        }),
      );
  }
}
