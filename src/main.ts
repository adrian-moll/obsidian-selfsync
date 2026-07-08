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
import { AdvancedModal, type AdvancedGroup } from "./ui/advanced-modal.js";
import { Logger, createRotatingSink, type LogFileIO } from "./util/logger.js";
import { canonicalPathOf } from "./engine/engine.js";
import type { GitBackup } from "./git/git-backup.js";
import { StatusController } from "./ui/status.js";
import { SyncStore } from "./ui/sync-store.js";
import { ObsidianVaultAdapter } from "./vault/obsidian-vault-adapter.js";
import { ObsidianBaseStore } from "./vault/obsidian-base-store.js";
import type { StateStore } from "./engine/state-db.js";
import { createStateStore } from "./engine/indexeddb-state-store.js";
import { SyncEngine } from "./engine/engine.js";
import { ManifestStore } from "./engine/manifest-store.js";
import { cleanupExcluded } from "./engine/cleanup.js";
import { SyncScheduler } from "./engine/scheduler.js";
import { type BlobNaming, MirrorNaming, OpaqueNaming } from "./engine/naming.js";
import { buildExcludePatterns, makeExcluder } from "./engine/exclude.js";
import { WebDavBackend } from "./backend/webdav-backend.js";
import { CryptoBackend } from "./backend/crypto-backend.js";
import { loadCryptoHeader, MissingPassphraseError, unlock, WrongPassphraseError } from "./backend/crypto-header.js";
import { applyImportedConfig, buildExportConfig } from "./backend/config-store.js";
import { utf8 } from "./backend/http.js";
import { obsidianHttp } from "./backend/obsidian-http.js";
import type { StorageBackend } from "./backend/storage-backend.js";
import { decodeSecret, encodeSecret, type KeychainProvider } from "./util/secret-store.js";
import type { Op, StateEntry } from "./types.js";

interface PersistedData {
  settings: SelfSyncSettings;
  /** Legacy: the sync state now lives in IndexedDB. Still written on the JSON
   *  fallback, and read once at load to migrate into IndexedDB. */
  syncState?: StateEntry[];
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

export default class SelfSyncPlugin extends Plugin {
  settings!: SelfSyncSettings;
  private syncState: StateEntry[] = []; // load/migration input + JSON-fallback state
  private stateStore!: StateStore;
  private usingIndexedDb = false;
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
    await this.initStateStore();
    this.scheduler = new SyncScheduler((trigger) => this.runSync(trigger));

    this.registerView(
      VIEW_TYPE_SELFSYNC,
      (leaf) =>
        new SelfSyncView(
          leaf,
          this.store,
          () => void this.scheduler.trigger("manual"),
          (conflictPath) => void this.openResolver(conflictPath),
          () => this.openAdvanced(),
        ),
    );

    const ribbonEl = this.addRibbonIcon("refresh-cw", "SelfSync", () => void this.activateView());
    const statusBarEl = Platform.isDesktopApp ? this.addStatusBarItem() : undefined;
    this.status = new StatusController(ribbonEl, statusBarEl, this.store);
    this.store.update({
      backendLabel: this.backendLabel(),
      encrypted: this.settings.encryptionEnabled,
      trackedFiles: await this.countTrackedFiles(),
      gitPushPending: this.gitPushPending,
    });

    this.addCommand({ id: "open-panel", name: "Open sync panel", callback: () => void this.activateView() });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.scheduler.trigger("manual") });
    this.addCommand({ id: "open-advanced", name: "Advanced…", callback: () => this.openAdvanced() });
    this.addCommand({
      id: "reset-sync-state",
      name: "Reset local sync state (re-index on next sync)",
      callback: () => void this.resetSyncState(),
    });
    this.addCommand({
      id: "export-config",
      name: "Export config to backend",
      callback: () => void this.exportConfigToBackend(),
    });
    this.addCommand({
      id: "import-config",
      name: "Import config from backend",
      callback: () => void this.importConfigFromBackend({ auto: false }),
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
    // On a freshly-connected device, offer to adopt the shared config stored on the
    // backend BEFORE the first file sync, then start the startup reconcile (NFR1).
    // The config offer runs regardless of auto-sync; only the file sync is gated.
    void (async () => {
      await this.maybeOfferBackendConfig();
      if (this.settings.autoSyncEnabled && this.settings.syncOnStartup) void this.scheduler.trigger("startup");
    })();

    // Periodic interval (started only when auto-sync is on; toggled live via
    // onAutoSyncToggled).
    this.applyIntervalTrigger();

    // Debounced on file change.
    const onChange = () => {
      if (this.settings.autoSyncEnabled && this.settings.syncOnFileChange) {
        this.scheduler.requestDebounced("change", CHANGE_DEBOUNCE_MS);
      }
    };
    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    this.registerEvent(this.app.vault.on("rename", onChange));

    // Best-effort flush on quit / backgrounding (not guaranteed to run — the
    // startup reconcile is what guarantees convergence). Skipped when auto-sync off.
    this.registerEvent(
      this.app.workspace.on("quit", () => {
        if (this.settings.autoSyncEnabled) void this.scheduler.trigger("quit");
      }),
    );
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.hidden && this.settings.autoSyncEnabled) void this.scheduler.trigger("background");
    });
    this.registerDomEvent(window, "blur", () => {
      if (this.settings.autoSyncEnabled) void this.scheduler.trigger("background");
    });
  }

  /** Start or stop the periodic interval to match the current settings. */
  private applyIntervalTrigger(): void {
    if (this.settings.autoSyncEnabled && this.settings.syncIntervalMinutes > 0) {
      this.scheduler.startInterval("interval", this.settings.syncIntervalMinutes * 60_000);
    } else {
      this.scheduler.stopInterval();
    }
  }

  /** Called when the Automatic sync toggle changes — (re)arm or halt auto triggers. */
  onAutoSyncToggled(): void {
    this.applyIntervalTrigger();
    // Cancel any queued debounced auto-run; on-change/quit read the flag live.
    if (!this.settings.autoSyncEnabled) this.scheduler.cancelDebounce();
    this.store.update({
      detail: this.settings.autoSyncEnabled ? "Idle" : "Auto-sync off — Sync now to sync manually",
    });
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
  async testWebDavConnection(override?: SelfSyncSettings["webdav"]): Promise<{ ok: boolean; message: string }> {
    // `override` lets the settings tab test the values currently typed (draft),
    // before they've been saved into the active settings.
    const backend = this.buildBackend(override);
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

      // Commit in byte-bounded chunks so each commit is a small pack.
      const maxPushBytes = this.settings.git.maxPushMB > 0 ? this.settings.git.maxPushMB * 1024 * 1024 : undefined;
      const res = await backup.backup(`SelfSync backup (${reason})`, {
        chunkSize: this.settings.git.pushChunkSize,
        maxBytesPerCommit: maxPushBytes,
      });
      if (res.commits > 0) this.logger.info(`Git: committed ${res.commits} batch(es)`);

      if (doPush) {
        // Resumable, incremental push: unpushed commits go one small pack at a
        // time from wherever the remote is. A large/flaky backup makes progress
        // each cycle instead of re-sending the whole vault and timing out forever.
        try {
          const { pushed } = await backup.pushIncremental();
          this.gitPushPending = false;
          if (pushed > 0) this.logger.info(`Git: pushed ${pushed} commit(s)`);
          else if (res.commits === 0 && reason === "manual") this.logger.info("Git: up to date");
        } catch (e) {
          this.gitPushPending = true; // commits may remain unpushed; resume next cycle
          this.logPushError(e instanceof Error ? e.message : String(e), reason);
        }
      } else if (res.commits > 0) {
        this.gitPushPending = canPush; // committed; push throttled/off
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

  private buildBackend(override?: SelfSyncSettings["webdav"]): StorageBackend | null {
    const w = override ?? this.settings.webdav;
    if (!w.url) return null;
    return new WebDavBackend({
      baseUrl: w.url,
      username: w.username,
      password: w.password,
      rootDir: w.rootDir || "selfsync",
      http: obsidianHttp,
    });
  }

  /** Whether a sync is currently in flight (used by the settings tab). */
  isSyncing(): boolean {
    return this.store.get().status === "syncing";
  }

  /**
   * Resolve the effective backend + layout for a sync/maintenance op. With E2EE
   * off this is the raw backend + browsable mirror layout. With E2EE on, unlock
   * the vault key (minting the crypto header on first use) and wrap the backend
   * so every blob AND the manifest are encrypted, using the opaque layout.
   * Throws MissingPassphraseError / WrongPassphraseError so callers refuse to
   * sync BEFORE any writes rather than producing garbage (UC10).
   */
  private async encryptedContext(inner: StorageBackend): Promise<{ backend: StorageBackend; naming: BlobNaming }> {
    if (!this.settings.encryptionEnabled) return { backend: inner, naming: new MirrorNaming() };
    const { key, chunkSize, initialized } = await unlock(inner, this.settings.encryptionPassphrase);
    if (initialized) this.logger.info("E2EE initialized on this backend (crypto header written)");
    return { backend: new CryptoBackend(inner, key, chunkSize), naming: new OpaqueNaming() };
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
      const { backend: effBackend, naming } = await this.encryptedContext(backend);
      const exclude = makeExcluder(buildExcludePatterns(this.settings));
      const engine = new SyncEngine({
        vault: new ObsidianVaultAdapter(this.app),
        backend: effBackend,
        state: this.stateStore,
        deviceId: this.settings.deviceId,
        naming,
        baseStore: new ObsidianBaseStore(this.app),
      });
      // Throttle UI updates to ~10/s so the fine-grained per-file/per-scan-file
      // callbacks below don't thrash the store; always let the final tick through.
      let lastProgressAt = 0;
      const setDetail = (detail: string, force = false) => {
        const now = Date.now();
        if (force || now - lastProgressAt > 100) {
          lastProgressAt = now;
          this.store.update({ status: "syncing", detail });
        }
      };
      const onProgress = (done: number, total: number) =>
        setDetail(`Syncing… ${done}/${total}`, done === total);
      const onPhase = (detail: string) => setDetail(detail);
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
        onPhase,
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
        trackedFiles: await this.countTrackedFiles(),
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
      if (e instanceof WrongPassphraseError || e instanceof MissingPassphraseError) {
        // A key problem never resolves by retrying — surface it plainly on every
        // trigger (a silent background failure would look like nothing synced).
        this.store.update({ status: "error", detail: "Encryption locked", lastError: msg });
        this.logger.error("Encryption: " + msg);
        new Notice("SelfSync: " + msg + " Check the passphrase in settings.");
      } else if (isTransientNetworkError(msg)) {
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

  /** Count non-deleted tracked files (for the status panel), from the state store. */
  private async countTrackedFiles(): Promise<number> {
    return (await this.stateStore.all()).filter((e) => !e.deleted).length;
  }

  /** Clear the local sync index so the next sync re-indexes against the backend. */
  private async resetSyncState(): Promise<void> {
    await this.stateStore.clear();
    this.syncState = [];
    this.store.update({ trackedFiles: 0 });
    this.logger.info("Local sync state reset — next sync re-indexes against the backend");
    new Notice("SelfSync: local sync state reset. Run 'Sync now' to re-index.");
  }

  /** Open the Advanced maintenance window (side-panel button + command). */
  private openAdvanced(): void {
    const groups: AdvancedGroup[] = [];

    const connections = [
      { label: "Test WebDAV connection", run: () => void this.testAndNotify(() => this.testWebDavConnection()) },
    ];
    if (Platform.isDesktopApp) {
      connections.push({
        label: "Test Git connection",
        run: () => void this.testAndNotify(() => this.testGitConnection()),
      });
    }
    groups.push({ title: "Connections", items: connections });

    if (Platform.isDesktopApp && this.settings.git.enabled) {
      groups.push({
        title: "Git backup",
        items: [
          { label: "Commit now", run: () => void this.runGitBackup("manual") },
          { label: "Push now", run: () => void this.runGitBackup("manual", true) },
          { label: "Compact history…", run: () => this.confirmCompactHistory() },
          { label: "File history", run: () => void this.activateFileHistory() },
        ],
      });
    }

    groups.push({
      title: "Maintenance",
      items: [
        {
          label: "Clean up excluded files…",
          hint: "Remove leftover remote entries for files no longer synced (e.g. .git).",
          run: () => void this.cleanupExcludedFiles(),
        },
        {
          label: "Reset sync state…",
          hint: "Clear the local index; the next sync re-indexes against the backend.",
          danger: true,
          run: () =>
            new ConfirmModal(this.app, {
              title: "Reset local sync state?",
              body: "Clears this device's sync index. Nothing is deleted; the next sync re-indexes against the backend.",
              confirmText: "Reset",
              onConfirm: () => void this.resetSyncState(),
            }).open(),
        },
      ],
    });

    groups.push({
      title: "Setup (share config across devices)",
      items: [
        {
          label: "Export config to backend",
          hint: "Publish this device's non-secret settings so a new device can adopt them. Excludes passwords/passphrase/token.",
          run: () => void this.exportConfigToBackend(),
        },
        {
          label: "Import config from backend",
          hint: "Replace this device's settings with the shared config stored on the backend (keeps your own secrets).",
          run: () => void this.importConfigFromBackend({ auto: false }),
        },
      ],
    });

    new AdvancedModal(this.app, groups).open();
  }

  // --- shared config (bootstrap a new device) --------------------------------

  /** Publish this device's non-secret settings as a blob on the backend. */
  private async exportConfigToBackend(): Promise<void> {
    const raw = this.buildBackend();
    if (!raw) {
      new Notice("SelfSync: configure the WebDAV backend first.");
      return;
    }
    try {
      // Use the same effective backend + layout as a normal sync, so the config
      // blob is encrypted when E2EE is on (host sees only ciphertext).
      const { backend, naming } = await this.encryptedContext(raw);
      const json = JSON.stringify(buildExportConfig(this.settings), null, 2);
      await backend.write(naming.configKey, utf8.encode(json));
      this.logger.info("Exported config to backend");
      new Notice("SelfSync: config exported to the backend.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn("Export config failed: " + msg);
      new Notice("SelfSync: couldn't export config — " + msg);
    }
  }

  /**
   * Resolve the backend to read the shared config from, based on the BACKEND's
   * state (not this device's encryption setting) — a new device may not have E2EE
   * enabled locally yet. Returns an error string when the backend is encrypted but
   * no passphrase is set here.
   */
  private async backendForConfigRead(
    raw: StorageBackend,
  ): Promise<{ backend: StorageBackend; configKey: string } | { error: string }> {
    const header = await loadCryptoHeader(raw);
    if (header) {
      if (!this.settings.encryptionPassphrase) {
        return { error: "This backend is encrypted — set your passphrase in settings, then Import config from backend." };
      }
      const { key, chunkSize } = await unlock(raw, this.settings.encryptionPassphrase); // verifies the passphrase
      return { backend: new CryptoBackend(raw, key, chunkSize), configKey: new OpaqueNaming().configKey };
    }
    return { backend: raw, configKey: new MirrorNaming().configKey };
  }

  /**
   * Read the shared config from the backend and (after a confirm) apply it to this
   * device, preserving local secrets + deviceId. `auto` suppresses the "nothing to
   * import" notices for the silent first-connect offer. Resolves only after the
   * user has decided, so the caller can gate the first sync on it.
   */
  private async importConfigFromBackend(opts: { auto: boolean }): Promise<void> {
    const raw = this.buildBackend();
    if (!raw) {
      if (!opts.auto) new Notice("SelfSync: configure the WebDAV backend first.");
      return;
    }
    let resolved: { backend: StorageBackend; configKey: string } | { error: string };
    try {
      resolved = await this.backendForConfigRead(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn("Import config (resolve) failed: " + msg);
      if (!opts.auto) new Notice("SelfSync: " + msg);
      return;
    }
    if ("error" in resolved) {
      if (!opts.auto) new Notice("SelfSync: " + resolved.error);
      return;
    }

    const res = await resolved.backend.readWithMeta(resolved.configKey).catch(() => null);
    if (!res) {
      if (!opts.auto) new Notice("SelfSync: no saved config found on this backend.");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8.decode(res.data));
    } catch {
      if (!opts.auto) new Notice("SelfSync: the saved config on the backend is unreadable.");
      return;
    }

    await new Promise<void>((resolve) => {
      new ConfirmModal(this.app, {
        title: "Import SelfSync settings?",
        body:
          "Import saved settings from this backend? This replaces your current SelfSync settings on this " +
          "device, except your WebDAV password, encryption passphrase, and Git token.",
        confirmText: "Import",
        onConfirm: () => void this.applyImportedConfigAndSave(parsed).finally(resolve),
        onCancel: () => resolve(),
      }).open();
    });
  }

  private async applyImportedConfigAndSave(parsed: unknown): Promise<void> {
    try {
      this.settings = applyImportedConfig(this.settings, parsed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice("SelfSync: couldn't import config — " + msg);
      return;
    }
    await this.saveSettings();
    this.logger.info("Imported config from backend");
    const needPass = this.settings.encryptionEnabled ? " and encryption passphrase" : "";
    new Notice(`SelfSync: config imported. Enter your WebDAV password${needPass} to finish setup.`);
  }

  /**
   * Once per device, if connected but not yet checked, offer to import the shared
   * config from the backend before the first sync. Marks the device checked up
   * front so a dismissed offer isn't repeated every launch (the manual Import
   * action stays available).
   */
  async maybeOfferBackendConfig(): Promise<void> {
    if (this.settings.bootstrapConfigChecked || !this.settings.webdav.url) return;
    this.settings.bootstrapConfigChecked = true;
    await this.savePersisted();
    await this.importConfigFromBackend({ auto: true });
  }

  /** Run a connection test and surface the result as a Notice. */
  private async testAndNotify(test: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
    const res = await test();
    new Notice(`SelfSync: ${res.message}`);
  }

  /**
   * Purge remote manifest entries, blobs, and local-state records for paths that are
   * currently excluded from sync (e.g. a `.git/` repo synced by an older build before
   * `.git/**` was excluded). Shows a dry-run preview before committing.
   */
  private async cleanupExcludedFiles(): Promise<void> {
    if (this.store.get().status === "syncing") {
      new Notice("SelfSync: a sync is in progress — try again in a moment.");
      return;
    }
    const raw = this.buildBackend();
    if (!raw) {
      new Notice("SelfSync: configure the WebDAV backend first.");
      return;
    }
    const exclude = makeExcluder(buildExcludePatterns(this.settings));
    const log = (m: string): void => this.logger.debug(m);

    let preview;
    let backend: StorageBackend;
    let manifests: ManifestStore;
    try {
      // With E2EE on, operate through the crypto-wrapped backend so the manifest
      // decrypts and blob removal targets the right (opaque) keys.
      const ctx = await this.encryptedContext(raw);
      backend = ctx.backend;
      manifests = new ManifestStore(backend, this.settings.deviceId, ctx.naming.manifestKey);
      preview = await cleanupExcluded({ manifests, backend, exclude, state: this.stateStore, dryRun: true, log });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("Cleanup preview failed: " + msg);
      new Notice("SelfSync: cleanup failed — " + msg);
      return;
    }
    if (preview.count === 0) {
      new Notice("SelfSync: nothing to clean up — no excluded files on the remote.");
      return;
    }

    const mb = (preview.bytes / (1024 * 1024)).toFixed(1);
    const sample = preview.paths.slice(0, 8).join("\n");
    const more = preview.count > 8 ? `\n…and ${preview.count - 8} more` : "";
    new ConfirmModal(this.app, {
      title: "Clean up excluded files?",
      body:
        `Remove ${preview.count} entr${preview.count === 1 ? "y" : "ies"} (${mb} MB) from the remote index — ` +
        `files currently excluded on THIS device:\n\n${sample}${more}`,
      confirmText: "Remove",
      onConfirm: () => void this.runCleanup(manifests, backend, exclude, log),
    }).open();
  }

  private async runCleanup(
    manifests: ManifestStore,
    backend: StorageBackend,
    exclude: (path: string) => boolean,
    log: (msg: string) => void,
  ): Promise<void> {
    try {
      const res = await cleanupExcluded({ manifests, backend, exclude, state: this.stateStore, dryRun: false, log });
      this.logger.info(`Cleaned up ${res.count} excluded file(s) from the remote`);
      new Notice(`SelfSync: removed ${res.count} excluded file(s) from the remote.`);
      this.store.update({ trackedFiles: await this.countTrackedFiles() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("Cleanup failed: " + msg);
      new Notice("SelfSync: cleanup failed — " + msg);
    }
  }

  /**
   * Select and initialise the sync-state backend: IndexedDB (scales to large
   * vaults — persists only changed keys) with an automatic JSON fallback. On the
   * first IndexedDB run any legacy data.json state is migrated in, and data.json is
   * slimmed to settings-only. Losing the store is safe — the next sync re-indexes.
   */
  private async initStateStore(): Promise<void> {
    const jsonPersist = async (all: StateEntry[]): Promise<void> => {
      this.syncState = all;
      await this.savePersisted();
    };
    const vaultId = (this.app as unknown as { appId?: string }).appId || this.app.vault.getName() || "default";
    const idb = typeof indexedDB !== "undefined" ? indexedDB : undefined;
    const { store, backend, migrated } = await createStateStore({
      indexedDB: idb,
      dbName: `selfsync-state-${vaultId}`,
      legacyEntries: this.syncState,
      jsonPersist,
    });
    this.stateStore = store;
    this.usingIndexedDb = backend === "indexeddb";
    this.logger.debug(`State store: ${backend}${migrated ? " (migrated from data.json)" : ""}`);
    if (this.usingIndexedDb) {
      if (migrated) await this.savePersisted(); // drop syncState from data.json
      // Ask the OS to keep the DB across storage pressure (best-effort).
      const p = navigator.storage?.persist?.();
      if (p) void p.catch(() => {});
    }
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
    this.settings.encryptionPassphrase = decodeSecret(this.settings.encryptionPassphrase, keychain);
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
      encryptionPassphrase: encodeSecret(mode, this.settings.encryptionPassphrase, keychain),
    };
    // On IndexedDB the state lives in the DB, so data.json holds settings only.
    const data: PersistedData = this.usingIndexedDb
      ? { settings: settingsForDisk }
      : { settings: settingsForDisk, syncState: this.syncState };
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
