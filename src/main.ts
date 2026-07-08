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
import { ConfirmModal } from "./ui/confirm-modal.js";
import { Logger, createRotatingSink, type LogFileIO } from "./util/logger.js";
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
import { decodeSecret, encodeSecret, type KeychainProvider } from "./util/secret-store.js";
import type { Op, StateEntry } from "./types.js";

interface PersistedData {
  settings: SelfSyncSettings;
  syncState: StateEntry[];
}

const CHANGE_DEBOUNCE_MS = 3000;
const GIT_PUSH_THROTTLE_MS = 60_000;
const LOG_FILE_NAME = "selfsync.log";
const LOG_MAX_BYTES = 1024 * 1024; // rotate past ~1 MB, keep one previous generation

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
  private logger = new Logger({ onEntry: (_lvl, msg) => this.store.log(msg) });
  private status?: StatusController;
  private scheduler!: SyncScheduler;
  private conflictRetries = 0;
  private netRetries = 0;
  private gitBusy = false;
  private lastGitPushAt = 0;
  private gitPushPending = false;

  async onload(): Promise<void> {
    await this.loadPersisted();
    this.configureLogger();
    // Attempt a push on the first backup to drain any commits stranded from a
    // previous session (e.g. a push that timed out).
    this.gitPushPending = this.settings.git.enabled;
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
          () =>
            Platform.isDesktopApp && this.settings.git.enabled
              ? {
                  commitNow: () => void this.runGitBackup("manual"),
                  pushNow: () => void this.runGitBackup("manual", true),
                  fileHistory: () => void this.activateFileHistory(),
                }
              : null,
          () => this.testWebDavConnection(),
        ),
    );

    const ribbonEl = this.addRibbonIcon("refresh-cw", "SelfSync", () => void this.activateView());
    const statusBarEl = Platform.isDesktopApp ? this.addStatusBarItem() : undefined;
    this.status = new StatusController(ribbonEl, statusBarEl, this.store);
    this.store.update({
      backendLabel: this.backendLabel(),
      encrypted: this.settings.encryptionEnabled,
      trackedFiles: this.syncState.filter((e) => !e.deleted).length,
      gitPushPending: this.gitPushPending,
    });

    this.addCommand({ id: "open-panel", name: "Open sync panel", callback: () => void this.activateView() });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.scheduler.trigger("manual") });
    this.addCommand({
      id: "reset-sync-state",
      name: "Reset local sync state (re-index on next sync)",
      callback: () => void this.resetSyncState(),
    });

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
      this.addCommand({ id: "git-push-now", name: "Git backup: push now", callback: () => void this.runGitBackup("manual", true) });
      this.addCommand({
        id: "git-compact-history",
        name: "Git backup: compact history to snapshot",
        callback: () => this.confirmCompactHistory(),
      });
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

  // --- Logging ---------------------------------------------------------------

  /** Apply the debug-logging setting: raise the level and attach the file sink. */
  private configureLogger(): void {
    const debug = this.settings.debugLogging;
    this.logger.setLevel(debug ? "debug" : "info");
    this.logger.setFileSink(debug ? this.buildLogFileSink() : null);
  }

  /** A rotating file sink under the plugin folder (mobile-safe via DataAdapter). */
  private buildLogFileSink(): (line: string) => Promise<void> {
    const adapter = this.app.vault.adapter;
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const logPath = `${dir}/${LOG_FILE_NAME}`;
    const backup = `${logPath}.1`;
    const io: LogFileIO = {
      size: async () => {
        try {
          return (await adapter.stat(logPath))?.size ?? 0;
        } catch {
          return 0;
        }
      },
      append: (line) => adapter.append(logPath, line),
      rotate: async () => {
        try {
          if (await adapter.exists(backup)) await adapter.remove(backup);
          if (await adapter.exists(logPath)) await adapter.rename(logPath, backup);
        } catch {
          /* best-effort */
        }
      },
    };
    return createRotatingSink(io, LOG_MAX_BYTES);
  }

  // --- Connection tests ------------------------------------------------------

  /** Validate the WebDAV endpoint + credentials (for the settings/panel button). */
  async testWebDavConnection(): Promise<{ ok: boolean; message: string }> {
    const backend = this.buildBackend();
    if (!backend) return { ok: false, message: "WebDAV not configured — set a URL first." };
    try {
      await backend.testConnection();
      this.logger.info("WebDAV connection OK");
      return { ok: true, message: "WebDAV connection OK" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn("WebDAV connection failed: " + msg);
      return { ok: false, message: "WebDAV connection failed: " + msg };
    }
  }

  /** Validate the Git remote is reachable with the configured credentials. */
  async testGitConnection(): Promise<{ ok: boolean; message: string }> {
    if (!Platform.isDesktopApp) return { ok: false, message: "Git backup is desktop-only." };
    if (!this.settings.git.enabled) return { ok: false, message: "Enable Git backup first." };
    if (!this.settings.git.remoteUrl) return { ok: false, message: "Set a Git remote URL first." };
    try {
      const backup = await this.getGitBackup();
      if (!backup) return { ok: false, message: "Git backup unavailable on this device." };
      await backup.testRemote();
      this.logger.info("Git connection OK");
      return { ok: true, message: "Git connection OK" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn("Git connection failed: " + msg);
      return { ok: false, message: "Git connection failed: " + msg };
    }
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
      excludeGlobs: g.excludeGlobs,
    });
    await backup.init();
    return backup;
  }

  /** Confirm, then discard all Git history and keep only a current snapshot. */
  confirmCompactHistory(): void {
    if (!Platform.isDesktopApp || !this.settings.git.enabled) {
      new Notice("SelfSync: enable Git backup in settings (desktop only).");
      return;
    }
    new ConfirmModal(this.app, {
      title: "Compact Git history?",
      body:
        "This permanently discards ALL Git history and keeps only the current vault " +
        "state as a single commit, then force-pushes to the remote. Past versions can " +
        "no longer be restored. This cannot be undone.",
      confirmText: "Discard history & snapshot",
      onConfirm: () => void this.compactGitHistory(),
    }).open();
  }

  private async compactGitHistory(): Promise<void> {
    if (this.gitBusy) {
      new Notice("SelfSync: Git is busy — try again in a moment.");
      return;
    }
    this.gitBusy = true;
    try {
      const backup = await this.getGitBackup();
      if (!backup) {
        new Notice("SelfSync: Git backup unavailable on this device.");
        return;
      }
      this.logger.info("Git: compacting history to a snapshot…");
      const res = await backup.compactHistory();
      this.gitPushPending = !res.pushed && !!this.settings.git.remoteUrl;
      this.store.update({ gitPushPending: this.gitPushPending });
      if (res.pushed) {
        this.logger.info("Git: history compacted and force-pushed");
        new Notice("SelfSync: Git history compacted and pushed.");
      } else if (res.pushError) {
        this.logger.warn("Git: snapshot committed but push failed: " + res.pushError);
        new Notice("SelfSync: snapshot committed locally; push failed — retry later.");
      } else {
        this.logger.info("Git: history compacted (no remote)");
        new Notice("SelfSync: Git history compacted.");
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.logger.error("Git compaction error: " + m);
      new Notice("SelfSync Git compaction error: " + m);
    } finally {
      this.gitBusy = false;
    }
  }

  private logPushError(m: string, reason: string): void {
    if (isTransientNetworkError(m) || /timed?\s*out/i.test(m)) {
      this.logger.info("Git: push deferred — will retry (" + m + ")");
    } else {
      this.logger.warn("Git push error: " + m);
      if (reason === "manual") new Notice("SelfSync Git push error: " + m);
    }
  }

  private async runGitBackup(reason: string, forcePush = false): Promise<void> {
    if (this.gitBusy) return;
    const backup = await this.getGitBackup();
    if (!backup) {
      if (reason === "manual") new Notice("SelfSync: enable Git backup in settings (desktop only).");
      return;
    }
    this.gitBusy = true;
    try {
      const canPush = this.settings.git.push && !!this.settings.git.remoteUrl;
      const doPush = canPush && (forcePush || Date.now() - this.lastGitPushAt > GIT_PUSH_THROTTLE_MS);
      if (doPush) this.lastGitPushAt = Date.now();

      // Commit + push in chunks so each push is a small pack (survives short
      // server timeouts on large backups).
      const res = await backup.backup(`SelfSync backup (${reason})`, {
        chunkSize: this.settings.git.pushChunkSize,
        push: doPush,
      });
      if (res.commits > 0) this.logger.info(`Git: committed ${res.commits} batch(es)`);

      if (res.pushed) {
        this.gitPushPending = false;
        this.logger.info("Git: pushed");
      } else if (res.pushError) {
        this.gitPushPending = true;
        this.logPushError(res.pushError, reason);
      } else if (res.commits > 0) {
        this.gitPushPending = canPush; // committed, push throttled/off
      }

      // Drain an earlier backlog (a push that timed out on a prior cycle) — this
      // is why later syncs now retry the push instead of stranding commits.
      if (doPush && !res.pushed && !res.pushError && this.gitPushPending) {
        try {
          await backup.push();
          this.gitPushPending = false;
          this.logger.info("Git: pushed");
        } catch (e) {
          this.gitPushPending = true;
          this.logPushError(e instanceof Error ? e.message : String(e), reason);
        }
      }

      if (res.commits === 0 && !this.gitPushPending && reason === "manual") {
        this.logger.info("Git: up to date");
      }
      this.store.update({ gitPushPending: this.gitPushPending });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.logger.error("Git commit error: " + m);
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
    return this.settings.webdav.url ? "WebDAV" : "WebDAV (not configured)";
  }

  private buildBackend(): StorageBackend | null {
    const s = this.settings;
    if (!s.webdav.url) return null;
    return new WebDavBackend({
      baseUrl: s.webdav.url,
      username: s.webdav.username,
      password: s.webdav.password,
      rootDir: s.webdav.rootDir || "selfsync",
      http: obsidianHttp,
    });
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
      let lastProgressAt = 0;
      const onProgress = (done: number, total: number) => {
        const now = Date.now();
        if (done === total || now - lastProgressAt > 200) {
          lastProgressAt = now;
          this.store.update({ status: "syncing", detail: `Syncing… ${done}/${total}` });
        }
      };
      // Cap only what we hold WHOLE in memory (uploads + non-streamed reads);
      // downloads stream in chunks regardless of size. On mobile, clamp to a safe
      // ceiling — a big file edited on the phone can't be chunk-uploaded (no ranged
      // read API) and would OOM, so it's skipped with a warning instead.
      const MB = 1024 * 1024;
      const MOBILE_WHOLE_CAP = 20 * MB;
      const cap = this.settings.maxFileMB > 0 ? this.settings.maxFileMB * MB : 0;
      const maxFileBytes = Platform.isDesktopApp ? cap : cap > 0 ? Math.min(cap, MOBILE_WHOLE_CAP) : MOBILE_WHOLE_CAP;
      this.logger.debug(`Sync start (${trigger}); maxFileMB=${this.settings.maxFileMB}`);
      const res = await engine.sync({
        timestampIso: new Date().toISOString(),
        useMtimeShortcut: true,
        exclude,
        onProgress,
        maxFileBytes,
        log: (m) => this.logger.debug(m),
      });
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
          this.logger.info(`Remote changed mid-sync — retrying (${this.conflictRetries}/3)`);
          this.scheduler.requestDebounced("retry", 1500);
        } else {
          this.logger.warn("Still contended after 3 retries — will sync on next change");
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
        trackedFiles: this.syncState.filter((e) => !e.deleted).length,
        skippedLarge: res.skippedLarge.length,
        failedFiles: res.failed.length,
      });
      this.logger.info(res.ops.length ? `Synced: ${summarizeOps(res.ops)}` : "Up to date");
      if (res.merged.length) {
        this.logger.info(`Auto-merged ${res.merged.length}: ${res.merged.slice(0, 4).join(", ")}`);
      }
      if (res.skippedLarge.length) {
        this.logger.warn(
          `Skipped ${res.skippedLarge.length} file(s) over ${this.settings.maxFileMB} MB: ` +
            res.skippedLarge.slice(0, 4).join(", "),
        );
      }
      if (res.failed.length) {
        // Per-file errors (e.g. a server 500) don't fail the whole sync — the rest
        // converged and these are retried next cycle.
        this.logger.warn(
          `Failed ${res.failed.length} file(s) this sync (will retry): ` + res.failed.slice(0, 4).join(", "),
        );
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
        if (this.netRetries === 0) this.logger.info("Offline — will retry when the connection returns");
        if (this.netRetries < 5) {
          this.netRetries++;
          this.scheduler.requestDebounced("net-retry", 8000);
        }
      } else {
        this.store.update({ status: "error", detail: "Error", lastError: msg });
        this.logger.error("Error: " + msg);
        if (trigger === "manual") new Notice("SelfSync error: " + msg);
      }
    }
  }

  /** Clear the local sync index so the next sync re-indexes against the backend. */
  private async resetSyncState(): Promise<void> {
    this.syncState = [];
    this.stateStore = new JsonStateStore(this.syncState, async (all) => {
      this.syncState = all;
      await this.savePersisted();
    });
    await this.savePersisted();
    this.store.update({ trackedFiles: 0 });
    this.logger.info("Local sync state reset — next sync re-indexes against the backend");
    new Notice("SelfSync: local sync state reset. Run 'Sync now' to re-index.");
  }

  private mergeSettings(raw: Partial<SelfSyncSettings> | null | undefined): SelfSyncSettings {
    const r = raw ?? {};
    return {
      ...DEFAULT_SETTINGS,
      ...r,
      webdav: { ...DEFAULT_SETTINGS.webdav, ...(r.webdav ?? {}) },
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
    // Decode the at-rest-protected secrets so the in-memory settings hold
    // plaintext (buildBackend/getGitBackup expect that). Any form decodes; a
    // keychain value we can't read here yields "" → "not configured".
    const keychain = await this.getKeychain();
    this.settings.webdav.password = decodeSecret(this.settings.webdav.password, keychain);
    this.settings.git.token = decodeSecret(this.settings.git.token, keychain);
    if (!this.settings.deviceId) this.settings.deviceId = crypto.randomUUID();
    await this.savePersisted(); // re-writes in the current mode (auto-migrates legacy cleartext)
  }

  private async savePersisted(): Promise<void> {
    // Encode secrets on a COPY so this.settings stays plaintext in memory for auth.
    const keychain = await this.getKeychain();
    const mode = this.settings.secretStorage;
    const settingsForDisk: SelfSyncSettings = {
      ...this.settings,
      webdav: { ...this.settings.webdav, password: encodeSecret(mode, this.settings.webdav.password, keychain) },
      git: { ...this.settings.git, token: encodeSecret(mode, this.settings.git.token, keychain) },
    };
    const data: PersistedData = { settings: settingsForDisk, syncState: this.syncState };
    await this.saveData(data);
  }

  /**
   * Lazily resolve the desktop OS-keychain provider (once). Returns null on
   * mobile or if safeStorage isn't usable, so callers fall back to obfuscation.
   */
  private keychainResolved = false;
  private keychain: KeychainProvider | null = null;
  private async getKeychain(): Promise<KeychainProvider | null> {
    if (this.keychainResolved) return this.keychain;
    this.keychainResolved = true;
    if (Platform.isDesktopApp) {
      try {
        const { getKeychainProvider } = await import("./util/keychain-desktop.js");
        const provider = getKeychainProvider();
        this.keychain = provider.isAvailable() ? provider : null;
      } catch {
        this.keychain = null;
      }
    }
    return this.keychain;
  }

  /** Whether real OS-keychain encryption is available on this device (for the settings UI). */
  async isKeychainAvailable(): Promise<boolean> {
    return (await this.getKeychain()) !== null;
  }

  /** Called by the settings tab after edits. */
  async saveSettings(): Promise<void> {
    this.configureLogger();
    this.store.update({ backendLabel: this.backendLabel(), encrypted: this.settings.encryptionEnabled });
    await this.savePersisted();
  }
}
