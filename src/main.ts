/**
 * SelfSync plugin entry point (M2).
 *
 * Wires the sync engine to a real backend and drives it from the trigger model
 * (D5): sync on startup, on a configurable interval, debounced on file change,
 * and best-effort on app background/quit. All triggers funnel through a
 * single-flight SyncScheduler so they never overlap. Live status flows through a
 * SyncStore into the ribbon/status bar and the Sync view.
 */
import { Notice, Platform, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type SelfSyncSettings, SelfSyncSettingTab } from "./settings.js";
import { SelfSyncView, VIEW_TYPE_SELFSYNC } from "./ui/sync-view.js";
import { StatusController } from "./ui/status.js";
import { SyncStore } from "./ui/sync-store.js";
import { ObsidianVaultAdapter } from "./vault/obsidian-vault-adapter.js";
import { JsonStateStore } from "./engine/state-db.js";
import { SyncEngine } from "./engine/engine.js";
import { SyncScheduler } from "./engine/scheduler.js";
import { MirrorNaming, OpaqueNaming } from "./engine/naming.js";
import { DEFAULT_EXCLUDES, makeExcluder } from "./engine/exclude.js";
import { WebDavBackend } from "./backend/webdav-backend.js";
import { obsidianHttp } from "./backend/obsidian-http.js";
import type { StorageBackend } from "./backend/storage-backend.js";
import type { Op, StateEntry } from "./types.js";

interface PersistedData {
  settings: SelfSyncSettings;
  syncState: StateEntry[];
}

const CHANGE_DEBOUNCE_MS = 3000;

function summarizeOps(ops: Op[]): string {
  const counts: Record<string, number> = {};
  for (const o of ops) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
  return Object.entries(counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

export default class SelfSyncPlugin extends Plugin {
  settings!: SelfSyncSettings;
  private syncState: StateEntry[] = [];
  private stateStore!: JsonStateStore;
  private store = new SyncStore();
  private status?: StatusController;
  private scheduler!: SyncScheduler;
  private conflictRetries = 0;

  async onload(): Promise<void> {
    await this.loadPersisted();
    this.stateStore = new JsonStateStore(this.syncState, async (all) => {
      this.syncState = all;
      await this.savePersisted();
    });
    this.scheduler = new SyncScheduler((trigger) => this.runSync(trigger));

    this.registerView(
      VIEW_TYPE_SELFSYNC,
      (leaf) => new SelfSyncView(leaf, this.store, () => void this.scheduler.trigger("manual")),
    );

    const ribbonEl = this.addRibbonIcon("refresh-cw", "SelfSync", () => void this.activateView());
    const statusBarEl = Platform.isDesktopApp ? this.addStatusBarItem() : undefined;
    this.status = new StatusController(ribbonEl, statusBarEl, this.store);
    this.store.update({ backendLabel: this.backendLabel(), encrypted: this.settings.encryptionEnabled });

    this.addCommand({ id: "open-panel", name: "Open sync panel", callback: () => void this.activateView() });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.scheduler.trigger("manual") });

    this.addSettingTab(new SelfSyncSettingTab(this.app, this));

    // Set up triggers once the workspace is ready (avoids the initial file-load
    // event burst and premature syncing).
    this.app.workspace.onLayoutReady(() => this.setupTriggers());
  }

  onunload(): void {
    this.scheduler?.dispose();
    this.status?.dispose();
  }

  private setupTriggers(): void {
    // Startup reconcile — the backbone (NFR1).
    if (this.settings.syncOnStartup) void this.scheduler.trigger("startup");

    // Periodic interval.
    if (this.settings.syncIntervalMinutes > 0) {
      this.scheduler.startInterval("interval", this.settings.syncIntervalMinutes * 60_000);
    }

    // Debounced on file change.
    const onChange = () => {
      if (this.settings.syncOnFileChange) this.scheduler.requestDebounced("change", CHANGE_DEBOUNCE_MS);
    };
    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    this.registerEvent(this.app.vault.on("rename", onChange));

    // Best-effort flush on quit / backgrounding (not guaranteed to run — the
    // startup reconcile is what guarantees convergence).
    this.registerEvent(this.app.workspace.on("quit", () => void this.scheduler.trigger("quit")));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.hidden) void this.scheduler.trigger("background");
    });
    this.registerDomEvent(window, "blur", () => void this.scheduler.trigger("background"));
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

  private backendLabel(): string {
    const s = this.settings;
    if (s.backendType === "webdav") return s.webdav.url ? "WebDAV" : "WebDAV (not configured)";
    return "CouchDB";
  }

  private buildBackend(): StorageBackend | null {
    const s = this.settings;
    if (s.backendType === "webdav") {
      if (!s.webdav.url) return null;
      return new WebDavBackend({
        baseUrl: s.webdav.url,
        username: s.webdav.username,
        password: s.webdav.password,
        rootDir: s.webdav.rootDir || "selfsync",
        http: obsidianHttp,
      });
    }
    return null; // CouchDB backend is M4
  }

  /** One sync cycle, invoked only via the scheduler (single-flight). */
  private async runSync(trigger: string): Promise<void> {
    const encrypted = this.settings.encryptionEnabled;
    const backend = this.buildBackend();
    if (!backend) {
      this.store.update({ status: "idle", detail: "Not configured", backendLabel: this.backendLabel() });
      if (trigger === "manual") new Notice("SelfSync: configure the backend in settings first.");
      return;
    }

    this.store.update({
      status: "syncing",
      detail: `Syncing… (${trigger})`,
      backendLabel: this.backendLabel(),
      encrypted,
      lastError: null,
    });

    try {
      const naming = encrypted ? new OpaqueNaming() : new MirrorNaming();
      const exclude = makeExcluder([...DEFAULT_EXCLUDES, ...this.settings.excludeGlobs]);
      const engine = new SyncEngine({
        vault: new ObsidianVaultAdapter(this.app),
        backend,
        state: this.stateStore,
        deviceId: this.settings.deviceId,
        naming,
      });
      const res = await engine.sync({ timestampIso: new Date().toISOString(), useMtimeShortcut: true, exclude });
      const nowIso = new Date().toISOString();

      if (res.conflict) {
        // Another device committed the manifest first. Retry a bounded number of
        // times (the winner's changes are already reflected on re-read).
        this.store.update({ status: "idle", detail: "Remote changed — retrying", lastSyncIso: nowIso });
        if (this.conflictRetries < 3) {
          this.conflictRetries++;
          this.store.log(`Remote changed mid-sync — retrying (${this.conflictRetries}/3)`);
          this.scheduler.requestDebounced("retry", 1500);
        } else {
          this.store.log("Still contended after 3 retries — will sync on next change");
        }
        return;
      }
      this.conflictRetries = 0;

      const conflictPaths = res.ops
        .filter((o): o is Extract<Op, { kind: "conflict" }> => o.kind === "conflict")
        .map((o) => o.conflictCopyPath);

      this.store.update({
        status: conflictPaths.length ? "conflicts" : "idle",
        detail: conflictPaths.length ? `${conflictPaths.length} conflict(s)` : "Idle",
        lastSyncIso: nowIso,
        conflicts: conflictPaths,
      });
      this.store.log(res.ops.length ? `Synced: ${summarizeOps(res.ops)}` : "Up to date");
      if (conflictPaths.length) {
        new Notice(`SelfSync: ${conflictPaths.length} conflict copy(ies) created — see the Sync panel.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.store.update({ status: "error", detail: "Error", lastError: msg });
      this.store.log("Error: " + msg);
      if (trigger === "manual") new Notice("SelfSync error: " + msg);
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
    this.store.update({ backendLabel: this.backendLabel(), encrypted: this.settings.encryptionEnabled });
    await this.savePersisted();
  }
}
