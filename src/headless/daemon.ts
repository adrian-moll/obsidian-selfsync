/**
 * Headless SelfSync daemon — the Node/Docker counterpart of src/main.ts.
 *
 * It composes exactly the same sync engine the plugin uses (SyncEngine +
 * WebDavBackend + optional CryptoBackend + SyncScheduler); only the edges differ:
 * a Node-fs VaultAdapter instead of Obsidian's, a JSON file instead of IndexedDB,
 * `fetchHttp` instead of `requestUrl`, and stdout instead of the status bar.
 *
 * The retry policy is deliberately identical to the plugin's (main.ts runSync):
 * a bounded fast retry when another device wins the manifest race, and a quiet
 * backoff when the network is down. Divergence there would make the two clients
 * behave differently under exactly the conditions that matter — contention.
 */
import * as nodePath from "node:path";
import { SyncEngine } from "../engine/engine.js";
import { SyncScheduler } from "../engine/scheduler.js";
import { buildExcludePatterns, makeExcluder } from "../engine/exclude.js";
import type { StateStore } from "../engine/state-db.js";
import { WebDavBackend } from "../backend/webdav-backend.js";
import { encryptedContext } from "../backend/context.js";
import { MissingPassphraseError, WrongPassphraseError } from "../backend/crypto-header.js";
import { applyImportedConfig, ConfigVersionError } from "../backend/config-store.js";
import { fetchHttp, utf8 } from "../backend/http.js";
import type { StorageBackend } from "../backend/storage-backend.js";
import { NodeVaultAdapter } from "../vault/node-vault-adapter.js";
import { NodeBaseStore } from "../vault/node-base-store.js";
import { Logger, type LogLevel } from "../util/logger.js";
import { isTransientNetworkError } from "../util/errors.js";
import { summarizeOps } from "../util/describe-ops.js";
import type { SelfSyncSettings } from "../settings.js";
import type { HeadlessConfig } from "./config.js";
import { createFileStateStore, writeFileAtomic } from "./state-file.js";
import { watchVault, type VaultWatcher } from "./watch.js";

const MB = 1024 * 1024;
/** Minimum gap between AUTOMATIC syncs (matches the plugin's desktop cooldown). */
const AUTO_SYNC_COOLDOWN_MS = 30_000;
const MAX_CONFLICT_RETRIES = 3;
const CONFLICT_RETRY_MS = 1_500;
const MAX_NET_RETRIES = 5;
const NET_RETRY_MS = 8_000;
export const HEALTH_FILE_NAME = "health.json";

export type DaemonStatus = "starting" | "syncing" | "idle" | "conflicts" | "offline" | "error";

export interface HealthSnapshot {
  status: DaemonStatus;
  deviceId: string;
  lastSyncIso: string | null;
  lastError: string | null;
  trackedFiles: number;
  conflicts: string[];
}

/** Build a stdout logger: one line per entry, `docker logs` is the interface. */
export function createStdoutLogger(level: LogLevel, write: (line: string) => void = (l) => process.stdout.write(l)): Logger {
  return new Logger({
    level,
    onEntry: (lvl, msg) => write(`${new Date().toISOString()} [${lvl.toUpperCase()}] ${msg}\n`),
  });
}

export class SyncDaemon {
  private readonly settingsRef: { current: SelfSyncSettings };
  private readonly vault: NodeVaultAdapter;
  private readonly baseStore: NodeBaseStore;
  private readonly scheduler: SyncScheduler;
  private readonly healthFile: string;
  private watcher: VaultWatcher | null = null;
  private conflictRetries = 0;
  private netRetries = 0;
  private health: HealthSnapshot;

  private constructor(
    private readonly config: HeadlessConfig,
    private readonly state: StateStore,
    readonly logger: Logger,
  ) {
    this.settingsRef = { current: config.settings };
    this.vault = new NodeVaultAdapter({ root: config.vaultDir });
    this.baseStore = new NodeBaseStore(config.stateDir);
    this.scheduler = new SyncScheduler((trigger) => this.runSync(trigger));
    this.scheduler.setCooldownMs(AUTO_SYNC_COOLDOWN_MS);
    this.healthFile = nodePath.join(config.stateDir, HEALTH_FILE_NAME);
    this.health = {
      status: "starting",
      deviceId: config.settings.deviceId,
      lastSyncIso: null,
      lastError: null,
      trackedFiles: 0,
      conflicts: [],
    };
  }

  static async create(config: HeadlessConfig, logger?: Logger): Promise<SyncDaemon> {
    const log = logger ?? createStdoutLogger(config.settings.debugLogging ? "debug" : "info");
    const state = await createFileStateStore(config.stateDir, (m) => log.warn(m));
    return new SyncDaemon(config, state, log);
  }

  private get settings(): SelfSyncSettings {
    return this.settingsRef.current;
  }

  /** Raw (unencrypted) backend — the transport only. */
  private rawBackend(): StorageBackend {
    const w = this.settings.webdav;
    return new WebDavBackend({
      baseUrl: w.url,
      username: w.username,
      password: w.password,
      rootDir: w.rootDir || "selfsync",
      http: fetchHttp,
    });
  }

  /** Verify configuration and reachability without writing anything. */
  async doctor(): Promise<void> {
    const raw = this.rawBackend();
    await raw.testConnection();
    this.logger.info(`Backend reachable: ${this.settings.webdav.url} (rootDir=${this.settings.webdav.rootDir})`);
    // encryptedContext would MINT a crypto header if E2EE is on and none exists;
    // doctor must stay read-only, so only report what the config implies.
    this.logger.info(`Encryption: ${this.settings.encryptionEnabled ? "on" : "off"}`);
    this.logger.info(`Device id: ${this.settings.deviceId}`);
    this.logger.info(`Vault: ${this.config.vaultDir}  State: ${this.config.stateDir}`);
    const files = await this.vault.list();
    this.logger.info(`Vault readable: ${files.length} file(s)`);
  }

  /**
   * Adopt `syncObsidianConfig` and `excludeGlobs` from the shared config blob the
   * plugin publishes. Exclude-list parity is not cosmetic: excluded paths are
   * invisible to reconciliation while the FULL manifest is still committed, so if
   * the two clients disagree each keeps re-uploading what the other ignores.
   *
   * Only those two fields are taken. Connection and encryption settings stay from
   * the environment — adopting `encryptionEnabled` from a blob could flip this
   * client into writing plaintext into an encrypted vault (or vice versa).
   */
  async importSharedConfig(): Promise<void> {
    if (!this.config.importRemoteConfig) return;
    try {
      const { backend, naming } = await encryptedContext(this.rawBackend(), this.settings);
      const res = await backend.readWithMeta(naming.configKey);
      if (!res) {
        this.logger.info("No shared config on the backend — using the environment's exclude settings");
        return;
      }
      const merged = applyImportedConfig(this.settings, JSON.parse(utf8.decode(res.data)));
      this.settingsRef.current = {
        ...this.settings,
        syncObsidianConfig: merged.syncObsidianConfig,
        excludeGlobs: merged.excludeGlobs,
      };
      this.logger.info(
        `Adopted shared exclude config: syncObsidianConfig=${merged.syncObsidianConfig}, ` +
          `excludeGlobs=[${merged.excludeGlobs.join(", ")}]`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof ConfigVersionError) {
        this.logger.warn(`Shared config has an unsupported version (${msg}) — keeping the environment's settings`);
      } else {
        // Never fatal: the environment already has a usable exclude config.
        this.logger.warn(`Could not read the shared config (${msg}) — keeping the environment's settings`);
      }
    }
  }

  /** One sync cycle. Only ever invoked through the scheduler (single-flight). */
  private async runSync(trigger: string): Promise<void> {
    this.setHealth({ status: "syncing" });
    try {
      const { backend, naming, initialized } = await encryptedContext(this.rawBackend(), this.settings);
      if (initialized) this.logger.info("E2EE initialized on this backend (crypto header written)");
      const exclude = makeExcluder(buildExcludePatterns(this.settings));
      const engine = new SyncEngine({
        vault: this.vault,
        backend,
        state: this.state,
        deviceId: this.settings.deviceId,
        naming,
        baseStore: this.baseStore,
      });
      // Cap only what we hold WHOLE in memory (uploads); downloads stream in
      // chunks regardless of size. No mobile clamp — this is a server.
      const maxFileBytes = this.settings.maxFileMB > 0 ? this.settings.maxFileMB * MB : 0;
      this.logger.debug(`Sync start (${trigger}); maxFileMB=${this.settings.maxFileMB}`);

      const res = await engine.sync({
        timestampIso: new Date().toISOString(),
        useMtimeShortcut: true,
        exclude,
        maxFileBytes,
        log: (m) => this.logger.debug(m),
      });
      const nowIso = new Date().toISOString();

      if (res.conflict) {
        // Another device committed the manifest first. Its changes are already
        // reflected on re-read, so retry promptly a bounded number of times.
        this.setHealth({
          status: res.existingConflicts.length ? "conflicts" : "idle",
          lastSyncIso: nowIso,
          conflicts: res.existingConflicts,
        });
        if (this.conflictRetries < MAX_CONFLICT_RETRIES) {
          this.conflictRetries++;
          this.logger.info(`Remote changed mid-sync — retrying (${this.conflictRetries}/${MAX_CONFLICT_RETRIES})`);
          this.scheduler.requestDebounced("retry", CONFLICT_RETRY_MS, true); // bypass cooldown
        } else {
          this.logger.warn(`Still contended after ${MAX_CONFLICT_RETRIES} retries — will sync on the next trigger`);
        }
        return;
      }
      this.conflictRetries = 0;
      this.netRetries = 0;

      this.setHealth({
        status: res.existingConflicts.length ? "conflicts" : "idle",
        lastSyncIso: nowIso,
        lastError: null,
        conflicts: res.existingConflicts,
        trackedFiles: (await this.state.all()).length,
      });
      this.logger.info(res.ops.length ? `Synced: ${summarizeOps(res.ops)}` : "Up to date");
      if (res.merged.length) {
        this.logger.info(`Auto-merged ${res.merged.length}: ${res.merged.slice(0, 4).join(", ")}`);
      }
      if (res.conflictCopies.length) {
        this.logger.warn(
          `${res.conflictCopies.length} conflict copy(ies) from overlapping edits: ` +
            res.conflictCopies.slice(0, 4).join(", "),
        );
      }
      if (res.skippedLarge.length) {
        this.logger.warn(
          `Skipped ${res.skippedLarge.length} file(s) over ${this.settings.maxFileMB} MB: ` +
            res.skippedLarge.slice(0, 4).join(", "),
        );
      }
      if (res.failed.length) {
        // Per-file errors don't fail the whole sync — the rest converged and
        // these are retried next cycle.
        this.logger.warn(
          `Failed ${res.failed.length} file(s) this sync (will retry): ` + res.failed.slice(0, 4).join(", "),
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof WrongPassphraseError || e instanceof MissingPassphraseError) {
        // A key problem never resolves by retrying — report it on every trigger.
        this.setHealth({ status: "error", lastError: msg });
        this.logger.error(`Encryption: ${msg} Check SELFSYNC_ENCRYPTION_PASSPHRASE.`);
      } else if (isTransientNetworkError(msg)) {
        this.setHealth({ status: "offline", lastError: msg });
        if (this.netRetries === 0) this.logger.info(`Offline — will retry when the connection returns (${msg})`);
        if (this.netRetries < MAX_NET_RETRIES) {
          this.netRetries++;
          this.scheduler.requestDebounced("net-retry", NET_RETRY_MS, true); // already backing off
        }
      } else {
        this.setHealth({ status: "error", lastError: msg });
        this.logger.error(`Error: ${msg}`);
      }
    }
  }

  /** Run exactly one sync cycle; resolves to false if it ended in an error state. */
  async syncOnce(): Promise<boolean> {
    await this.importSharedConfig();
    await this.scheduler.trigger("manual");
    return this.health.status !== "error" && this.health.status !== "offline";
  }

  /** Start the daemon: shared config, startup sync, interval, and the watcher. */
  async start(): Promise<void> {
    this.logger.info(
      `SelfSync headless starting — device=${this.settings.deviceId} vault=${this.config.vaultDir} ` +
        `interval=${this.settings.syncIntervalMinutes}m watch=${this.config.watchEnabled}`,
    );
    await this.importSharedConfig();

    if (this.config.watchEnabled) {
      const exclude = makeExcluder(buildExcludePatterns(this.settings));
      this.watcher = await watchVault({
        root: this.config.vaultDir,
        exclude,
        onChange: () =>
          this.scheduler.requestDebounced("change", this.settings.changeDebounceSeconds * 1000),
        log: this.logger,
      });
    }

    this.scheduler.startInterval("interval", this.settings.syncIntervalMinutes * 60_000);
    await this.scheduler.trigger("startup");
  }

  /**
   * Stop cleanly: no new triggers, drain the in-flight cycle, then one final sync
   * so edits made just before shutdown aren't stranded locally.
   */
  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    this.scheduler.dispose();
    this.logger.info("Shutting down — running a final sync");
    await this.scheduler.trigger("shutdown");
    await this.state.flush();
  }

  getHealth(): HealthSnapshot {
    return { ...this.health };
  }

  private setHealth(patch: Partial<HealthSnapshot>): void {
    this.health = { ...this.health, ...patch };
    // Best-effort: a health file we can't write must never break sync.
    void writeFileAtomic(this.healthFile, JSON.stringify(this.health, null, 2)).catch(() => {});
  }
}
