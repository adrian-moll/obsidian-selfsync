/**
 * Configuration for the headless client, assembled from environment variables.
 *
 * The plugin keeps settings in data.json (Obsidian's loadData/saveData); a
 * container has no such thing, so everything comes from the environment — except
 * two pieces of state that must survive a restart and live in the state
 * directory: the device id and (elsewhere) the State DB.
 *
 * The result carries a full `SelfSyncSettings` so the shared, Obsidian-free
 * helpers apply unchanged: buildExcludePatterns() for exclusions and
 * applyImportedConfig() for the shared config blob. `SelfSyncSettings` is
 * imported as a TYPE ONLY — settings.ts imports "obsidian", and this module must
 * never pull that into the Node bundle.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { SelfSyncSettings } from "../settings.js";

export interface HeadlessConfig {
  /** Settings in the plugin's own shape, so shared helpers apply unchanged. */
  settings: SelfSyncSettings;
  /** Absolute path of the vault on the container filesystem. */
  vaultDir: string;
  /** Absolute path of the device-local state directory (NEVER inside the vault). */
  stateDir: string;
  /** Pull syncObsidianConfig/excludeGlobs from the shared config blob on startup. */
  importRemoteConfig: boolean;
  /** Watch the vault for changes in addition to the interval. */
  watchEnabled: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Env = Record<string, string | undefined>;

/**
 * Read a secret from the first of `names` that is set, falling back to the
 * contents of the file named by `<NAME>_FILE`. The file form is how Docker and
 * Compose deliver secrets, and it keeps passphrases out of `docker inspect` and
 * the process environment.
 */
function readSecret(env: Env, names: string[]): string {
  for (const name of names) {
    const direct = env[name];
    if (direct !== undefined && direct !== "") return direct;
  }
  for (const name of names) {
    const file = env[`${name}_FILE`];
    if (!file) continue;
    try {
      return fs.readFileSync(file, "utf-8").trim();
    } catch (e) {
      throw new ConfigError(`${name}_FILE is set but unreadable (${file}): ${(e as Error).message}`);
    }
  }
  return "";
}

/** First set value among `names`, or `fallback`. */
function pick(env: Env, names: string[], fallback: string): string {
  for (const name of names) {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
  }
  return fallback;
}

function str(env: Env, name: string, fallback: string): string {
  return pick(env, [name], fallback);
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false), got: ${v}`);
}

function num(env: Env, name: string, fallback: number, min: number): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new ConfigError(`${name} must be a number >= ${min}, got: ${v}`);
  return n;
}

/** Comma- or newline-separated glob list. */
function globs(env: Env, name: string): string[] {
  return str(env, name, "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Stable per-device id, persisted in the state directory. It must differ from
 * every other device's: it sets `manifest.updatedBy` and names conflict copies,
 * so two clients sharing an id produce indistinguishable (and colliding) copies.
 * Never copy the plugin's data.json into the container.
 */
export function loadDeviceId(stateDir: string, override?: string): string {
  if (override) return override;
  const file = nodePath.join(stateDir, "device-id");
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing) return existing;
  } catch {
    // not created yet — fall through and mint one
  }
  const id = `headless-${randomUUID().slice(0, 8)}`;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, id + "\n", "utf-8");
  return id;
}

/**
 * Build the config from an environment. Throws ConfigError (never a bare Error)
 * for anything a user can fix by editing their compose file.
 */
export function loadConfig(env: Env = process.env): HeadlessConfig {
  // USER/PASS are the repo's existing names (.env.local.example, the live tests),
  // so the same values work for a dev machine and a container. The longer
  // USERNAME/PASSWORD forms are accepted because they're the obvious guess.
  const url = str(env, "SELFSYNC_WEBDAV_URL", "");
  const username = pick(env, ["SELFSYNC_WEBDAV_USER", "SELFSYNC_WEBDAV_USERNAME"], "");
  const password = readSecret(env, ["SELFSYNC_WEBDAV_PASS", "SELFSYNC_WEBDAV_PASSWORD"]);
  const missing = [
    !url && "SELFSYNC_WEBDAV_URL",
    !username && "SELFSYNC_WEBDAV_USER",
    !password && "SELFSYNC_WEBDAV_PASS (or SELFSYNC_WEBDAV_PASS_FILE)",
  ].filter((x): x is string => Boolean(x));
  if (missing.length) throw new ConfigError(`Missing required configuration: ${missing.join(", ")}`);

  const vaultDir = nodePath.resolve(str(env, "SELFSYNC_VAULT_DIR", "/vault"));
  const stateDir = nodePath.resolve(str(env, "SELFSYNC_STATE_DIR", "/state"));
  if (stateDir === vaultDir || stateDir.startsWith(vaultDir + nodePath.sep)) {
    // The state dir holds the State DB and merge bases. Inside the vault they'd
    // be synced to every other device (or churn the fs watcher) — refuse early.
    throw new ConfigError(`SELFSYNC_STATE_DIR (${stateDir}) must not be inside SELFSYNC_VAULT_DIR (${vaultDir})`);
  }

  const passphrase = readSecret(env, ["SELFSYNC_ENCRYPTION_PASSPHRASE"]);

  const settings: SelfSyncSettings = {
    webdav: { url, username, password, rootDir: str(env, "SELFSYNC_WEBDAV_ROOT_DIR", "selfsync") },
    // Irrelevant headless: secrets come from the environment on every start and
    // are never written to disk, so there is nothing to protect at rest.
    secretStorage: "plaintext",
    encryptionEnabled: passphrase.length > 0,
    encryptionPassphrase: passphrase,
    autoSyncEnabled: true,
    syncObsidianConfig: bool(env, "SELFSYNC_SYNC_OBSIDIAN_CONFIG", false),
    syncOnStartup: true,
    syncIntervalMinutes: num(env, "SELFSYNC_SYNC_INTERVAL_MINUTES", 5, 0.1),
    syncOnFileChange: bool(env, "SELFSYNC_WATCH", true),
    changeDebounceSeconds: num(env, "SELFSYNC_CHANGE_DEBOUNCE_SECONDS", 10, 1),
    excludeGlobs: globs(env, "SELFSYNC_EXCLUDE_GLOBS"),
    maxFileMB: num(env, "SELFSYNC_MAX_FILE_MB", 50, 0),
    debugLogging: bool(env, "SELFSYNC_DEBUG", false),
    // Git backup is desktop/plugin-only (commit+push, no pull) — the container
    // never touches .git, which is excluded from sync anyway.
    git: {
      enabled: false,
      remoteUrl: "",
      username: "",
      token: "",
      authorName: "",
      authorEmail: "",
      commitOnSync: false,
      push: false,
      pushChunkSize: 100,
      maxPushMB: 25,
      excludeGlobs: [],
    },
    deviceId: loadDeviceId(stateDir, str(env, "SELFSYNC_DEVICE_ID", "")),
    bootstrapConfigChecked: true,
  };

  return {
    settings,
    vaultDir,
    stateDir,
    importRemoteConfig: bool(env, "SELFSYNC_IMPORT_REMOTE_CONFIG", true),
    watchEnabled: settings.syncOnFileChange,
  };
}
