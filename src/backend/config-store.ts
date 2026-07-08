/**
 * The shared, NON-SECRET SelfSync config carried on the backend to bootstrap a new
 * device (Part B of the config-portability work). `buildExportConfig` strips
 * secrets and per-device fields; `applyImportedConfig` merges a parsed payload back
 * over a device's settings while PRESERVING that device's own secrets + deviceId.
 *
 * Pure — no Obsidian/Electron imports (the `SelfSyncSettings` import is type-only,
 * erased at compile) — so both directions are unit-tested in Node.
 *
 * Secrets / per-device fields are NEVER exported and ALWAYS preserved on import:
 *   webdav.password, encryptionPassphrase, git.token, deviceId, bootstrapConfigChecked.
 * Keeping the strip and the preserve in this one module stops the two lists drifting.
 */
import type { SelfSyncSettings } from "../settings.js";

/** Bumped if the exported shape changes incompatibly; import rejects other values. */
export const CONFIG_FORMAT_VERSION = 1;

export interface ExportedConfig {
  selfsyncConfig: number;
  webdav: { url: string; username: string; rootDir: string };
  secretStorage: SelfSyncSettings["secretStorage"];
  encryptionEnabled: boolean;
  autoSyncEnabled: boolean;
  syncObsidianConfig: boolean;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;
  syncOnFileChange: boolean;
  excludeGlobs: string[];
  maxFileMB: number;
  debugLogging: boolean;
  git: {
    enabled: boolean;
    remoteUrl: string;
    username: string;
    authorName: string;
    authorEmail: string;
    commitOnSync: boolean;
    push: boolean;
    pushChunkSize: number;
    excludeGlobs: string[];
  };
}

/** Build the non-secret config payload to publish to the backend. */
export function buildExportConfig(s: SelfSyncSettings): ExportedConfig {
  return {
    selfsyncConfig: CONFIG_FORMAT_VERSION,
    webdav: { url: s.webdav.url, username: s.webdav.username, rootDir: s.webdav.rootDir },
    secretStorage: s.secretStorage,
    encryptionEnabled: s.encryptionEnabled,
    autoSyncEnabled: s.autoSyncEnabled,
    syncObsidianConfig: s.syncObsidianConfig,
    syncOnStartup: s.syncOnStartup,
    syncIntervalMinutes: s.syncIntervalMinutes,
    syncOnFileChange: s.syncOnFileChange,
    excludeGlobs: [...s.excludeGlobs],
    maxFileMB: s.maxFileMB,
    debugLogging: s.debugLogging,
    git: {
      enabled: s.git.enabled,
      remoteUrl: s.git.remoteUrl,
      username: s.git.username,
      authorName: s.git.authorName,
      authorEmail: s.git.authorEmail,
      commitOnSync: s.git.commitOnSync,
      push: s.git.push,
      pushChunkSize: s.git.pushChunkSize,
      excludeGlobs: [...s.git.excludeGlobs],
    },
  };
}

export class ConfigVersionError extends Error {
  constructor(got: unknown) {
    super(`Unsupported SelfSync config version: ${String(got)}`);
    this.name = "ConfigVersionError";
  }
}

/**
 * Merge a parsed config payload over `current`, returning fresh settings. Unknown
 * keys are ignored and each field is coerced/clamped like the settings-tab setters,
 * so a malformed value falls back to the current one instead of corrupting settings.
 * Throws {@link ConfigVersionError} if the payload isn't a recognized version.
 */
export function applyImportedConfig(current: SelfSyncSettings, parsed: unknown): SelfSyncSettings {
  if (!isRecord(parsed) || parsed.selfsyncConfig !== CONFIG_FORMAT_VERSION) {
    throw new ConfigVersionError(isRecord(parsed) ? parsed.selfsyncConfig : parsed);
  }
  const p = parsed;
  const w = isRecord(p.webdav) ? p.webdav : {};
  const g = isRecord(p.git) ? p.git : {};

  return {
    ...current,
    webdav: {
      ...current.webdav,
      url: str(w.url, current.webdav.url),
      username: str(w.username, current.webdav.username),
      rootDir: str(w.rootDir, current.webdav.rootDir) || "selfsync",
      // secret — preserved from this device
      password: current.webdav.password,
    },
    secretStorage: oneOf(p.secretStorage, ["keychain", "obfuscated", "plaintext"], current.secretStorage),
    encryptionEnabled: bool(p.encryptionEnabled, current.encryptionEnabled),
    // secret — preserved from this device
    encryptionPassphrase: current.encryptionPassphrase,
    autoSyncEnabled: bool(p.autoSyncEnabled, current.autoSyncEnabled),
    syncObsidianConfig: bool(p.syncObsidianConfig, current.syncObsidianConfig),
    syncOnStartup: bool(p.syncOnStartup, current.syncOnStartup),
    syncIntervalMinutes: posNum(p.syncIntervalMinutes, current.syncIntervalMinutes),
    syncOnFileChange: bool(p.syncOnFileChange, current.syncOnFileChange),
    excludeGlobs: strArr(p.excludeGlobs, current.excludeGlobs),
    maxFileMB: nonNegInt(p.maxFileMB, current.maxFileMB),
    debugLogging: bool(p.debugLogging, current.debugLogging),
    git: {
      ...current.git,
      enabled: bool(g.enabled, current.git.enabled),
      remoteUrl: str(g.remoteUrl, current.git.remoteUrl),
      username: str(g.username, current.git.username),
      authorName: str(g.authorName, current.git.authorName),
      authorEmail: str(g.authorEmail, current.git.authorEmail),
      commitOnSync: bool(g.commitOnSync, current.git.commitOnSync),
      push: bool(g.push, current.git.push),
      pushChunkSize: posInt(g.pushChunkSize, current.git.pushChunkSize),
      excludeGlobs: strArr(g.excludeGlobs, current.git.excludeGlobs),
      // secret — preserved from this device
      token: current.git.token,
    },
    // per-device — preserved from this device
    deviceId: current.deviceId,
    bootstrapConfigChecked: current.bootstrapConfigChecked,
  };
}

// --- coercion helpers (mirror the settings-tab validators) ---------------------
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function posNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}
function posInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}
function nonNegInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}
function strArr(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? [...(v as string[])] : fallback;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
