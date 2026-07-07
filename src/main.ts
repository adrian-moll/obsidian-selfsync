/**
 * SelfSync plugin entry point (M2).
 *
 * Wires the sync engine to a real backend and drives it from the trigger model
 * (D5): sync on startup, on a configurable interval, debounced on file change,
 * and best-effort on app background/quit. All triggers funnel through a
 * single-flight SyncScheduler so they never overlap. Live status flows through a
 * SyncStore into the ribbon/status bar and the Sync view.
 */
import { FileSystemAdapter, Notice, Platform, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, type SelfSyncSettings, SelfSyncSettingTab } from "./settings.js";
import { SelfSyncView, VIEW_TYPE_SELFSYNC } from "./ui/sync-view.js";
import { FileHistoryView, VIEW_TYPE_FILE_HISTORY } from "./ui/file-history-view.js";
import { ConflictResolveModal } from "./ui/conflict-resolve-modal.js";
import { canonicalPathOf } from "./engine/engine.js";
import type { GitBackup } from "./git/git-backup.js";
import { StatusController } from "./ui/status.js";
import { SyncStore } from "./ui/sync-store.js";
import { ObsidianVaultAdapter } from "./vault/obsidian-vault-adapter.js";
import { ObsidianBaseStore } from "./vault/obsidian-base-store.js";
import { JsonStateStore } from "./engine/state-db.js";
import { SyncEngine } from "./engine/engine.js";
import { SyncScheduler } from "./engine/scheduler.js";
import { MirrorNaming, OpaqueNaming } from "./engine/naming.js";
import { DEFAULT_EXCLUDES, OBSIDIAN_CONFIG_GLOB, OBSIDIAN_VOLATILE, makeExcluder } from "./engine/exclude.js";
import { WebDavBackend } from "./backend/webdav-backend.js";
import { obsidianHttp } from "./backend/obsidian-http.js";
import type { StorageBackend } from "./backend/storage-backend.js";
import type { Op, StateEntry } from "./types.js";

interface PersistedData {
  settings: SelfSyncSettings;
  syncState: StateEntry[];
}

const CHANGE_DEBOUNCE_MS = 3000;

/** DNS/connectivity failures — expected right after a mobile app resume. */
function isTransientNetworkError(message: string): boolean {
  return /UnknownHostException|Unable to resolve host|No address associated|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|Failed to fetch|NetworkError|net::ERR|getaddrinfo|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|socket hang up/i.test(
    message,
  );
}

function describeOp(o: Op): string {
  switch (o.kind) {
    case "upload":
      return `↑ ${o.path}`;
    case "download":
      return `↓ ${o.path}`;
    case "deleteLocal":
      return `del-local ${o.path}`;
    case "deleteRemote":
      return `del-remote ${o.path}`;
    case "conflict":
      return `concurrent-edit ${o.path}`;
    case "move":
      return `move ${o.from} → ${o.to}`;
  }
}

function summarizeOps(ops: Op[]): string {
  const shown = ops.slice(0, 6).map(describeOp);
  const extra = ops.length > shown.length ? ` (+${ops.length - shown.length} more)` : "";
  return shown.join(", ") + extra;
}

function buildExcludePatterns(settings: SelfSyncSettings): string[] {
  const patterns = [...DEFAULT_EXCLUDES];
  if (settings.syncObsidianConfig) patterns.push(...OBSIDIAN_VOLATILE);
  else patterns.push(OBSIDIAN_CONFIG_GLOB);
  patterns.push(...settings.excludeGlobs);
  return patterns;
}

export default class SelfSyncPlugin extends Plugin {
  settings!: SelfSyncSettings;
  private syncState: StateEntry[] = [];
  private stateStore!: JsonStateStore;
  private store = new SyncStore();
  private status?: StatusController;
  private scheduler!: SyncScheduler;
  private conflictRetries = 0;
  private netRetries = 0;
  private gitBusy = false;

  async onload(): Promise<void> {
    await this.loadPersisted();
    this.stateStore = new JsonStateStore(this.syncState, async (all) => {
      this.syncState = all;
      await this.savePersisted();
    });
    this.scheduler = new SyncScheduler((trigger) => this.runSync(trigger));

    this.registerView(
      VIEW_TYPE_SELFSYNC,
      (leaf) =>
        new SelfSyncView(
          leaf,
          this.store,
          () => void this.scheduler.trigger("manual"),
          (conflictPath) => void this.openResolver(conflictPath),
        ),
    );

    const ribbonEl = this.addRibbonIcon("refresh-cw", "SelfSync", () => void this.activateView());
    const statusBarEl = Platform.isDesktopApp ? this.addStatusBarItem() : undefined;
    this.status = new StatusController(ribbonEl, statusBarEl, this.store);
    this.store.update({ backendLabel: this.backendLabel(), encrypted: this.settings.encryptionEnabled });

    this.addCommand({ id: "open-panel", name: "Open sync panel", callback: () => void this.activateView() });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.scheduler.trigger("manual") });

    this.addSettingTab(new SelfSyncSettingTab(this.app, this));

    // Git backup is desktop-only (D7). Register its view + commands only there.
    if (Platform.isDesktopApp) {
      this.registerView(
        VIEW_TYPE_FILE_HISTORY,
        (leaf) =>
          new FileHistoryView(
            leaf,
            () => this.getGitBackup(),
            () => this.app.workspace.getActiveFile()?.path ?? null,
          ),
      );
      this.addCommand({ id: "git-commit-now", name: "Git backup: commit now", callback: () => void this.runGitBackup("manual") });
      this.addCommand({
        id: "show-file-history",
        name: "Show file history (Git)",
        callback: () => void this.activateFileHistory(),
      });
      // Right-click a file → SelfSync: File history.
      this.registerEvent(
        this.app.workspace.on("file-menu", (menu, file) => {
          if (!(file instanceof TFile)) return;
          menu.addItem((item) =>
            item
              .setTitle("SelfSync: File history")
              .setIcon("history")
              .onClick(() => void this.activateFileHistory(file.path)),
          );
        }),
      );
    }

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

  // --- Git backup (desktop only) ---------------------------------------------

  /** Construct a ready GitBackup, or null if unavailable (mobile/disabled/no fs). */
  private async getGitBackup(): Promise<GitBackup | null> {
    if (!Platform.isDesktopApp || !this.settings.git.enabled) return null;
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const { GitBackup } = await import("./git/git-backup.js"); // lazy: never loaded on mobile
    const g = this.settings.git;
    const backup = new GitBackup({
      dir: adapter.getBasePath(),
      remoteUrl: g.remoteUrl || undefined,
      username: g.username || undefined,
      token: g.token || undefined,
      authorName: g.authorName || undefined,
      authorEmail: g.authorEmail || undefined,
    });
    await backup.init();
    return backup;
  }

  private async runGitBackup(reason: string): Promise<void> {
    if (this.gitBusy) return;
    const backup = await this.getGitBackup();
    if (!backup) {
      if (reason === "manual") new Notice("SelfSync: enable Git backup in settings (desktop only).");
      return;
    }
    this.gitBusy = true;
    try {
      const res = await backup.commitAll(`SelfSync backup (${reason})`);
      if (res.committed) {
        this.store.log(`Git: committed ${res.oid?.slice(0, 7)}`);
        if (this.settings.git.push && this.settings.git.remoteUrl) {
          await backup.push();
          this.store.log("Git: pushed");
        }
      } else if (reason === "manual") {
        this.store.log("Git: nothing to commit");
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.store.log("Git error: " + m);
      if (reason === "manual") new Notice("SelfSync Git error: " + m);
    } finally {
      this.gitBusy = false;
    }
  }

  private async activateFileHistory(path?: string): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_FILE_HISTORY)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type: VIEW_TYPE_FILE_HISTORY, active: true });
      leaf = right;
    }
    workspace.revealLeaf(leaf);
    if (path && leaf.view instanceof FileHistoryView) leaf.view.showFile(path);
  }

  /** Open the side-by-side resolver for a conflict copy (D9/FR12). */
  private async openResolver(conflictPath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const canonicalPath = canonicalPathOf(conflictPath);
    const conflictText = await adapter.read(conflictPath).catch(() => "");
    const currentText = (await adapter.exists(canonicalPath)) ? await adapter.read(canonicalPath) : "";
    new ConflictResolveModal(
      this.app,
      { canonicalPath, currentText, conflictPath, conflictText },
      (merged) => {
        void (async () => {
          await adapter.write(canonicalPath, merged);
          await adapter.remove(conflictPath).catch(() => {});
          new Notice(`SelfSync: resolved ${canonicalPath}`);
          this.scheduler.requestDebounced("resolve", 500);
        })();
      },
    ).open();
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
      const exclude = makeExcluder(buildExcludePatterns(this.settings));
      const engine = new SyncEngine({
        vault: new ObsidianVaultAdapter(this.app),
        backend,
        state: this.stateStore,
        deviceId: this.settings.deviceId,
        naming,
        baseStore: new ObsidianBaseStore(this.app),
      });
      const res = await engine.sync({ timestampIso: new Date().toISOString(), useMtimeShortcut: true, exclude });
      const nowIso = new Date().toISOString();

      if (res.conflict) {
        // Another device committed the manifest first. Retry a bounded number of
        // times (the winner's changes are already reflected on re-read).
        this.store.update({
          status: res.existingConflicts.length ? "conflicts" : "idle",
          detail: "Remote changed — retrying",
          lastSyncIso: nowIso,
          conflicts: res.existingConflicts,
        });
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
      this.netRetries = 0;

      // The panel lists ALL conflict copies present in the vault (any device),
      // so they persist across syncs until resolved (deleted).
      const existing = res.existingConflicts;
      this.store.update({
        status: existing.length ? "conflicts" : "idle",
        detail: existing.length ? `${existing.length} conflict file(s)` : "Idle",
        lastSyncIso: nowIso,
        conflicts: existing,
      });
      this.store.log(res.ops.length ? `Synced: ${summarizeOps(res.ops)}` : "Up to date");
      if (res.merged.length) {
        this.store.log(`Auto-merged ${res.merged.length}: ${res.merged.slice(0, 4).join(", ")}`);
      }
      // Notify only when THIS sync created a new conflict copy.
      if (res.conflictCopies.length) {
        new Notice(`SelfSync: ${res.conflictCopies.length} conflict copy(ies) — overlapping edits, see the Sync panel.`);
      }

      // Desktop-only Git backup after the vault has converged (no-op on mobile).
      if (this.settings.git.commitOnSync) void this.runGitBackup("after sync");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isTransientNetworkError(msg)) {
        // Offline / DNS not ready (common right after a mobile app resume).
        // Recover quietly with a short backoff instead of alarming the user.
        this.store.update({ status: "idle", detail: "Offline — will retry" });
        if (this.netRetries === 0) this.store.log("Offline — will retry when the connection returns");
        if (this.netRetries < 5) {
          this.netRetries++;
          this.scheduler.requestDebounced("net-retry", 8000);
        }
      } else {
        this.store.update({ status: "error", detail: "Error", lastError: msg });
        this.store.log("Error: " + msg);
        if (trigger === "manual") new Notice("SelfSync error: " + msg);
      }
    }
  }

  private mergeSettings(raw: Partial<SelfSyncSettings> | null | undefined): SelfSyncSettings {
    const r = raw ?? {};
    return {
      ...DEFAULT_SETTINGS,
      ...r,
      webdav: { ...DEFAULT_SETTINGS.webdav, ...(r.webdav ?? {}) },
      couchdb: { ...DEFAULT_SETTINGS.couchdb, ...(r.couchdb ?? {}) },
      git: { ...DEFAULT_SETTINGS.git, ...(r.git ?? {}) },
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
