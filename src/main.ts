/**
 * SelfSync plugin entry point (M1).
 *
 * Wires the engine to a real backend: on "Sync now" it builds the configured
 * backend (WebDAV in M1), scans the vault via the Obsidian adapter, runs a full
 * sync cycle, and reflects progress in the ribbon/status bar/Notices. Sync state
 * is persisted in the plugin's data file alongside settings.
 */
import { Notice, Platform, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type SelfSyncSettings, SelfSyncSettingTab } from "./settings.js";
import { SelfSyncView, VIEW_TYPE_SELFSYNC } from "./ui/sync-view.js";
import { StatusController } from "./ui/status.js";
import { ObsidianVaultAdapter } from "./vault/obsidian-vault-adapter.js";
import { JsonStateStore } from "./engine/state-db.js";
import { SyncEngine } from "./engine/engine.js";
import { MirrorNaming, OpaqueNaming } from "./engine/naming.js";
import { WebDavBackend } from "./backend/webdav-backend.js";
import { obsidianHttp } from "./backend/obsidian-http.js";
import type { StorageBackend } from "./backend/storage-backend.js";
import type { StateEntry } from "./types.js";

interface PersistedData {
  settings: SelfSyncSettings;
  syncState: StateEntry[];
}

export default class SelfSyncPlugin extends Plugin {
  settings!: SelfSyncSettings;
  private syncState: StateEntry[] = [];
  private stateStore!: JsonStateStore;
  private status?: StatusController;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadPersisted();
    this.stateStore = new JsonStateStore(this.syncState, async (all) => {
      this.syncState = all;
      await this.savePersisted();
    });

    this.registerView(VIEW_TYPE_SELFSYNC, (leaf) => new SelfSyncView(leaf));

    const ribbonEl = this.addRibbonIcon("refresh-cw", "SelfSync", () => {
      void this.activateView();
    });
    const statusBarEl = Platform.isDesktopApp ? this.addStatusBarItem() : undefined;
    this.status = new StatusController({ ribbonEl, statusBarEl });

    this.addCommand({ id: "open-panel", name: "Open sync panel", callback: () => void this.activateView() });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });

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

  private buildBackend(): StorageBackend | null {
    const s = this.settings;
    if (s.backendType === "webdav") {
      if (!s.webdav.url) {
        new Notice("SelfSync: configure the WebDAV URL in settings first.");
        return null;
      }
      return new WebDavBackend({
        baseUrl: s.webdav.url,
        username: s.webdav.username,
        password: s.webdav.password,
        rootDir: s.webdav.rootDir || "selfsync",
        http: obsidianHttp,
      });
    }
    new Notice("SelfSync: the CouchDB backend is not implemented yet (M4).");
    return null;
  }

  async syncNow(): Promise<void> {
    if (this.syncing) return;
    const backend = this.buildBackend();
    if (!backend) return;

    this.syncing = true;
    this.status?.set("syncing", "SelfSync: syncing…");
    try {
      const naming = this.settings.encryptionEnabled ? new OpaqueNaming() : new MirrorNaming();
      const engine = new SyncEngine({
        vault: new ObsidianVaultAdapter(this.app),
        backend,
        state: this.stateStore,
        deviceId: this.settings.deviceId,
        naming,
      });
      const res = await engine.sync({ timestampIso: new Date().toISOString(), useMtimeShortcut: true });

      if (res.conflict) {
        this.status?.set("idle", "SelfSync: will retry");
        new Notice("SelfSync: another device updated the remote first — will retry on the next sync.");
      } else if (res.ops.some((o) => o.kind === "conflict")) {
        this.status?.set("conflicts", "SelfSync: conflicts");
        new Notice("SelfSync: sync complete with conflict copies — see the Sync panel.");
      } else {
        this.status?.set("idle", "SelfSync: idle");
        new Notice(res.ops.length ? `SelfSync: synced ${res.ops.length} change(s).` : "SelfSync: up to date.");
      }
    } catch (e) {
      this.status?.set("error", "SelfSync: error");
      new Notice("SelfSync error: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      this.syncing = false;
    }
  }

  private mergeSettings(raw: Partial<SelfSyncSettings> | null | undefined): SelfSyncSettings {
    const r = raw ?? {};
    return {
      ...DEFAULT_SETTINGS,
      ...r,
      webdav: { ...DEFAULT_SETTINGS.webdav, ...(r.webdav ?? {}) },
      couchdb: { ...DEFAULT_SETTINGS.couchdb, ...(r.couchdb ?? {}) },
    };
  }

  private async loadPersisted(): Promise<void> {
    const raw = (await this.loadData()) as (Partial<PersistedData> & Partial<SelfSyncSettings>) | null;
    if (raw && typeof raw === "object" && "settings" in raw) {
      this.settings = this.mergeSettings(raw.settings);
      this.syncState = Array.isArray(raw.syncState) ? raw.syncState : [];
    } else {
      // Legacy (M0) shape: data.json held settings directly.
      this.settings = this.mergeSettings(raw as Partial<SelfSyncSettings> | null);
      this.syncState = [];
    }
    if (!this.settings.deviceId) this.settings.deviceId = crypto.randomUUID();
    await this.savePersisted();
  }

  private async savePersisted(): Promise<void> {
    const data: PersistedData = { settings: this.settings, syncState: this.syncState };
    await this.saveData(data);
  }

  /** Called by the settings tab after edits. */
  async saveSettings(): Promise<void> {
    await this.savePersisted();
  }
}
