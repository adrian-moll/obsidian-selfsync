/** Plugin settings model + settings tab. M0 exposes a minimal skeleton. */
import { type App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
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
  /** Extra glob patterns kept out of the Git backup (managed .gitignore block). */
  excludeGlobs: string[];
}

export interface SelfSyncSettings {
  webdav: { url: string; username: string; password: string; rootDir: string };
  /** How the WebDAV password and Git token are stored at rest in data.json. */
  secretStorage: SecretStorageMode;
  encryptionEnabled: boolean;
  /**
   * E2EE passphrase (FR5). Derives the vault key; must match on every device.
   * Stored at rest like the other secrets (per `secretStorage`). Empty = not set;
   * enabling encryption without it refuses to sync rather than write garbage.
   */
  encryptionPassphrase: string;
  /** Sync the .obsidian config folder (default off — it churns across devices). */
  syncObsidianConfig: boolean;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;
  syncOnFileChange: boolean;
  excludeGlobs: string[];
  /**
   * Upper bound (MB) on a file we hold WHOLE in memory: uploads, and the fallback
   * whole-blob download used only when the server can't do ranged reads. Downloads
   * normally stream in chunks (via appendBinary) and are NOT limited by this.
   * Reading a whole large file — and, on mobile, base64-encoding it across the
   * native bridge — can OOM/crash Obsidian (notably Android), which is what this
   * caps. 0 disables it on desktop; mobile always keeps a safe internal ceiling.
   */
  maxFileMB: number;
  /** Verbose logging + a rotating log file in the plugin folder (troubleshooting). */
  debugLogging: boolean;
  /** Desktop-only Git backup (D7/FR9). */
  git: GitSettings;
  /** Stable per-device id, generated on first load. */
  deviceId: string;
  /**
   * Whether this device has already been offered the shared config stored on the
   * backend (bootstrap). Set once (imported or declined) so the offer isn't
   * repeated every launch; the manual "Import config from backend" ignores it.
   */
  bootstrapConfigChecked: boolean;
}

export const DEFAULT_SETTINGS: SelfSyncSettings = {
  webdav: { url: "", username: "", password: "", rootDir: "selfsync" },
  secretStorage: "keychain",
  encryptionEnabled: false,
  encryptionPassphrase: "",
  syncObsidianConfig: false,
  syncOnStartup: true,
  syncIntervalMinutes: 5,
  syncOnFileChange: true,
  excludeGlobs: [],
  maxFileMB: 50,
  debugLogging: false,
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
    excludeGlobs: [],
  },
  deviceId: "",
  bootstrapConfigChecked: false,
};

/**
 * Editable copy of the connection & encryption fields. These are staged here and
 * applied to the live settings only when the user clicks Save — changing the
 * backend URL, sync folder, or encryption mode mid-flight (or half-typed) could
 * point the next sync at a different remote, so they are NOT applied live like
 * the operational settings below.
 */
interface ConnDraft {
  url: string;
  username: string;
  password: string;
  rootDir: string;
  secretStorage: SecretStorageMode;
  encryptionEnabled: boolean;
  encryptionPassphrase: string;
}

export class SelfSyncSettingTab extends PluginSettingTab {
  /** Staged connection/encryption edits; null until the tab is opened. */
  private draft: ConnDraft | null = null;
  private dirty = false;
  /** The Save-bar container, re-rendered in place as `dirty` changes. */
  private saveBarEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: SelfSyncPlugin,
  ) {
    super(app, plugin);
  }

  /** Leaving the settings pane discards any unsaved connection edits. */
  hide(): void {
    this.draft = null;
    this.dirty = false;
    this.saveBarEl = null;
  }

  private initDraft(): void {
    const s = this.plugin.settings;
    this.draft = {
      url: s.webdav.url,
      username: s.webdav.username,
      password: s.webdav.password,
      rootDir: s.webdav.rootDir,
      secretStorage: s.secretStorage,
      encryptionEnabled: s.encryptionEnabled,
      encryptionPassphrase: s.encryptionPassphrase,
    };
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.saveBarEl) this.renderSaveBar(this.saveBarEl);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    if (!this.draft) this.initDraft();
    const d = this.draft!;

    containerEl.createEl("h3", { text: "SelfSync" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Self-hosted, bring-your-own-backend sync and backup. Connection changes below apply only when you click Save.",
    });

    new Setting(containerEl).setName("WebDAV").setHeading();

    new Setting(containerEl)
      .setName("WebDAV URL")
      .setDesc("A WebDAV server you control — self-hosted (e.g. Apache mod_dav; see the user guide) or a hosted provider like Infomaniak kDrive.")
      .addText((t) =>
        t
          .setPlaceholder("https://…/dav/")
          .setValue(d.url)
          .onChange((v) => {
            d.url = v;
            this.markDirty();
          }),
      );
    new Setting(containerEl).setName("WebDAV username").addText((t) =>
      t.setValue(d.username).onChange((v) => {
        d.username = v;
        this.markDirty();
      }),
    );
    new Setting(containerEl)
      .setName("WebDAV password")
      .setDesc("For kDrive, use an app-specific password (not your login password). Stored per the Backend security setting below.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(d.password).onChange((v) => {
          d.password = v;
          this.markDirty();
        });
      });
    new Setting(containerEl)
      .setName("Sync folder")
      .setDesc("Folder on the WebDAV server that holds the synced data.")
      .addText((t) =>
        t.setValue(d.rootDir).onChange((v) => {
          d.rootDir = v;
          this.markDirty();
        }),
      );

    new Setting(containerEl)
      .setName("Test WebDAV connection")
      .setDesc("Check that the URL and credentials as typed above can reach the server (no need to save first).")
      .addButton((b) => {
        b.setButtonText("Test connection").onClick(async () => {
          b.setButtonText("Testing…").setDisabled(true);
          const res = await this.plugin.testWebDavConnection({
            url: d.url.trim(),
            username: d.username.trim(),
            password: d.password,
            rootDir: d.rootDir.trim() || "selfsync",
          });
          new Notice(`SelfSync: ${res.message}`);
          b.setButtonText("Test connection").setDisabled(false);
        });
      });

    const securityBase = "How the WebDAV password and Git token are stored on this device (in data.json). ";
    const securitySetting = new Setting(containerEl)
      .setName("Backend security")
      .setDesc(securityBase)
      .addDropdown((dd) =>
        dd
          .addOption("keychain", "Device keychain (recommended)")
          .addOption("obfuscated", "Obfuscated")
          .addOption("plaintext", "Plaintext")
          .setValue(d.secretStorage)
          .onChange((v) => {
            d.secretStorage = v as SecretStorageMode;
            this.markDirty();
            this.display(); // refresh the annotation for the new choice
          }),
      );
    // Probe whether real keychain encryption is available here, then annotate.
    void this.plugin.isKeychainAvailable().then((ok) => {
      securitySetting.setDesc(
        securityBase +
          (d.secretStorage === "keychain"
            ? ok
              ? "Device keychain is active — real encryption via your OS keychain."
              : "Device keychain isn't available on this device — falling back to Obfuscated."
            : d.secretStorage === "obfuscated"
              ? "Obfuscated: not stored as cleartext, but reversible — not real encryption."
              : "Plaintext: stored as-is. Anyone who can read the vault folder can read it."),
      );
    });

    new Setting(containerEl)
      .setName("End-to-end encryption")
      .setDesc(
        "Off (default): files are stored at their real paths — the server folder is browsable and mirrors your vault, " +
          "protected only by transport TLS and trust in the host. " +
          "On: file contents AND names/folders are encrypted on-device (AES-256-GCM) before upload, so the host sees " +
          "only ciphertext behind opaque keys. Set the same passphrase on every device.",
      )
      .addToggle((t) =>
        t.setValue(d.encryptionEnabled).onChange((v) => {
          d.encryptionEnabled = v;
          this.markDirty();
          this.display(); // reveal / hide the passphrase field
        }),
      );

    if (d.encryptionEnabled) {
      new Setting(containerEl)
        .setName("Encryption passphrase")
        .setDesc(
          "Derives the vault key. Must be IDENTICAL on every device. There is NO recovery — " +
            "if you lose it, the encrypted data cannot be read. Changing it on an existing " +
            "encrypted backend won't re-encrypt already-uploaded data; use a fresh sync folder.",
        )
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("a strong, memorable passphrase")
            .setValue(d.encryptionPassphrase)
            .onChange((v) => {
              d.encryptionPassphrase = v;
              this.markDirty();
            });
        });
    }

    this.saveBarEl = containerEl.createDiv();
    this.renderSaveBar(this.saveBarEl);

    new Setting(containerEl)
      .setName("Sync Obsidian config folder (.obsidian)")
      .setDesc(
        "Off (recommended): only notes and attachments sync. On: also sync appearance, " +
          "hotkeys, snippets, themes, and your installed plugins themselves (so they appear " +
          "on every device). Each plugin's own settings stay local per device, and workspace " +
          "layout and cache are never synced — so device-specific state and secrets don't " +
          "leave the device. A plugin that stores per-device state outside data.json can be " +
          "added to Extra exclude patterns below.",
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
      .setName("Max upload size (MB)")
      .setDesc(
        "Limits files uploaded from this device (they're read whole into memory, which can " +
          "crash Obsidian on mobile). Downloads stream in chunks and aren't limited by this. " +
          "0 disables it on desktop; mobile keeps a safe internal ceiling regardless.",
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxFileMB)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) {
            this.plugin.settings.maxFileMB = Math.floor(n);
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc(
        "Verbose logging written to a rotating file (selfsync.log) in this plugin's folder. " +
          "Turn on when troubleshooting, then share or inspect the log.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debugLogging).onChange(async (v) => {
          this.plugin.settings.debugLogging = v;
          await this.plugin.saveSettings();
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

  /** Render the Save/Revert bar for the connection block, reflecting `dirty`. */
  private renderSaveBar(el: HTMLElement): void {
    el.empty();
    const syncing = this.plugin.isSyncing();
    const setting = new Setting(el)
      .setName("Connection settings")
      .setDesc(
        this.dirty
          ? syncing
            ? "You have unsaved changes. Save is disabled while a sync is running — try again in a moment."
            : "You have unsaved changes. Click Save to apply them (this is what the next sync will use)."
          : "No unsaved changes.",
      );
    setting.addButton((b) => {
      b.setButtonText("Save").setCta().setDisabled(!this.dirty || syncing);
      b.onClick(() => void this.saveConnection());
    });
    if (this.dirty) {
      setting.addButton((b) => b.setButtonText("Revert").onClick(() => this.revertConnection()));
    }
  }

  /** Apply the staged connection/encryption edits to the live settings. */
  private async saveConnection(): Promise<void> {
    if (this.plugin.isSyncing()) {
      new Notice("SelfSync: a sync is in progress — try again in a moment.");
      return;
    }
    const d = this.draft!;
    const s = this.plugin.settings;
    s.webdav.url = d.url.trim();
    s.webdav.username = d.username.trim();
    s.webdav.password = d.password;
    s.webdav.rootDir = d.rootDir.trim() || "selfsync";
    s.secretStorage = d.secretStorage;
    s.encryptionEnabled = d.encryptionEnabled;
    s.encryptionPassphrase = d.encryptionPassphrase;
    await this.plugin.saveSettings();
    this.dirty = false;
    this.initDraft(); // re-sync the draft to the normalized, saved values
    new Notice("SelfSync: connection settings saved.");
    this.display();
    // Just connected/updated the backend — offer to adopt shared config if this
    // device hasn't been offered yet (one-time; no-op otherwise).
    void this.plugin.maybeOfferBackendConfig();
  }

  /** Discard the staged edits and reset the fields to the saved values. */
  private revertConnection(): void {
    this.initDraft();
    this.dirty = false;
    this.display();
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
    new Setting(containerEl)
      .setName("Test Git connection")
      .setDesc("Check the remote is reachable with these credentials (no push).")
      .addButton((b) =>
        b.setButtonText("Test connection").onClick(async () => {
          b.setButtonText("Testing…").setDisabled(true);
          const res = await this.plugin.testGitConnection();
          new Notice(`SelfSync: ${res.message}`);
          b.setButtonText("Test connection").setDisabled(false);
        }),
      );
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

    new Setting(containerEl)
      .setName("Git backup excludes")
      .setDesc(
        "One glob per line, kept out of the Git backup (written to a managed block in " +
          ".gitignore). Use this for large/churning attachments so history stays small — " +
          "every version of a binary is stored in full. e.g. **/*.mp4 or Attachments/**",
      )
      .addTextArea((t) => {
        t.setValue(g.excludeGlobs.join("\n"));
        t.inputEl.rows = 3;
        t.onChange(async (v) => {
          g.excludeGlobs = v
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Compact history to snapshot")
      .setDesc(
        "Reclaim space by discarding ALL Git history and keeping only the current state " +
          "as a single commit, then force-pushing to the remote. Destructive and permanent — " +
          "past versions can no longer be restored.",
      )
      .addButton((b) =>
        b
          .setButtonText("Compact history…")
          .setWarning()
          .onClick(() => this.plugin.confirmCompactHistory()),
      );
  }
}
