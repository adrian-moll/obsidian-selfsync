/**
 * Environment parsing for the headless client. Every failure here is a mistake a
 * user makes in a compose file, so each must surface as a ConfigError with a
 * fixable message rather than a stack trace at 3am — and the device id must be
 * minted once and then stay put across restarts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { ConfigError, loadConfig, loadDeviceId, type Env } from "../src/headless/config.js";

let tmp: string;

/** Minimal valid environment; individual tests override what they exercise. */
function baseEnv(extra: Env = {}): Env {
  return {
    SELFSYNC_WEBDAV_URL: "https://dav.example.com",
    SELFSYNC_WEBDAV_USER: "me",
    SELFSYNC_WEBDAV_PASS: "secret",
    SELFSYNC_VAULT_DIR: nodePath.join(tmp, "vault"),
    SELFSYNC_STATE_DIR: nodePath.join(tmp, "state"),
    ...extra,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "selfsync-cfg-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.settings.webdav.rootDir).toBe("selfsync");
    expect(cfg.settings.syncIntervalMinutes).toBe(5);
    expect(cfg.settings.changeDebounceSeconds).toBe(10);
    expect(cfg.settings.maxFileMB).toBe(50);
    expect(cfg.settings.syncObsidianConfig).toBe(false);
    expect(cfg.settings.excludeGlobs).toEqual([]);
    expect(cfg.settings.debugLogging).toBe(false);
    expect(cfg.importRemoteConfig).toBe(true);
    expect(cfg.watchEnabled).toBe(true);
  });

  it("reports every missing required variable at once", () => {
    expect(() => loadConfig({ SELFSYNC_VAULT_DIR: tmp })).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("SELFSYNC_WEBDAV_URL");
      expect(msg).toContain("SELFSYNC_WEBDAV_USER");
      expect(msg).toContain("SELFSYNC_WEBDAV_PASS");
    }
  });

  it("accepts the longer USERNAME/PASSWORD spellings as aliases", () => {
    const env = baseEnv({
      SELFSYNC_WEBDAV_USER: undefined,
      SELFSYNC_WEBDAV_PASS: undefined,
      SELFSYNC_WEBDAV_USERNAME: "me",
      SELFSYNC_WEBDAV_PASSWORD: "secret",
    });
    expect(loadConfig(env).settings.webdav.username).toBe("me");
    expect(loadConfig(env).settings.webdav.password).toBe("secret");
  });

  it("reads secrets from a *_FILE path (docker secrets)", () => {
    const file = nodePath.join(tmp, "dav-password");
    fs.writeFileSync(file, "from-file\n");
    const env = baseEnv({ SELFSYNC_WEBDAV_PASS: undefined, SELFSYNC_WEBDAV_PASS_FILE: file });
    expect(loadConfig(env).settings.webdav.password).toBe("from-file");
  });

  it("fails clearly when a *_FILE secret is unreadable", () => {
    const env = baseEnv({
      SELFSYNC_WEBDAV_PASS: undefined,
      SELFSYNC_WEBDAV_PASS_FILE: nodePath.join(tmp, "does-not-exist"),
    });
    expect(() => loadConfig(env)).toThrow(/SELFSYNC_WEBDAV_PASS_FILE is set but unreadable/);
  });

  it("derives encryptionEnabled from the presence of a passphrase", () => {
    expect(loadConfig(baseEnv()).settings.encryptionEnabled).toBe(false);
    const enc = loadConfig(baseEnv({ SELFSYNC_ENCRYPTION_PASSPHRASE: "hunter2" }));
    expect(enc.settings.encryptionEnabled).toBe(true);
    expect(enc.settings.encryptionPassphrase).toBe("hunter2");
  });

  it("refuses a state directory inside the vault", () => {
    const vaultDir = nodePath.join(tmp, "vault");
    const env = baseEnv({ SELFSYNC_VAULT_DIR: vaultDir, SELFSYNC_STATE_DIR: nodePath.join(vaultDir, "state") });
    expect(() => loadConfig(env)).toThrow(/must not be inside/);
  });

  it("parses booleans, numbers and glob lists", () => {
    const cfg = loadConfig(
      baseEnv({
        SELFSYNC_SYNC_OBSIDIAN_CONFIG: "yes",
        SELFSYNC_DEBUG: "1",
        SELFSYNC_WATCH: "off",
        SELFSYNC_SYNC_INTERVAL_MINUTES: "0.5",
        SELFSYNC_MAX_FILE_MB: "0",
        SELFSYNC_EXCLUDE_GLOBS: "Attachments/**, *.tmp\nprivate/**",
      }),
    );
    expect(cfg.settings.syncObsidianConfig).toBe(true);
    expect(cfg.settings.debugLogging).toBe(true);
    expect(cfg.watchEnabled).toBe(false);
    expect(cfg.settings.syncIntervalMinutes).toBe(0.5);
    expect(cfg.settings.maxFileMB).toBe(0);
    expect(cfg.settings.excludeGlobs).toEqual(["Attachments/**", "*.tmp", "private/**"]);
  });

  it("rejects malformed booleans and numbers", () => {
    expect(() => loadConfig(baseEnv({ SELFSYNC_DEBUG: "maybe" }))).toThrow(/must be a boolean/);
    expect(() => loadConfig(baseEnv({ SELFSYNC_MAX_FILE_MB: "-1" }))).toThrow(/must be a number/);
    expect(() => loadConfig(baseEnv({ SELFSYNC_SYNC_INTERVAL_MINUTES: "abc" }))).toThrow(/must be a number/);
  });

  it("never enables the desktop-only Git backup", () => {
    expect(loadConfig(baseEnv()).settings.git.enabled).toBe(false);
    expect(loadConfig(baseEnv()).settings.git.commitOnSync).toBe(false);
  });
});

describe("loadDeviceId", () => {
  it("mints an id once and reuses it across restarts", () => {
    const stateDir = nodePath.join(tmp, "state");
    const first = loadDeviceId(stateDir);
    expect(first).toMatch(/^headless-[0-9a-f]{8}$/);
    expect(loadDeviceId(stateDir)).toBe(first);
  });

  it("gives two containers distinct ids", () => {
    const a = loadDeviceId(nodePath.join(tmp, "a"));
    const b = loadDeviceId(nodePath.join(tmp, "b"));
    expect(a).not.toBe(b);
  });

  it("honours an explicit override without persisting it", () => {
    const stateDir = nodePath.join(tmp, "state");
    expect(loadDeviceId(stateDir, "server-1")).toBe("server-1");
    expect(fs.existsSync(nodePath.join(stateDir, "device-id"))).toBe(false);
  });
});
