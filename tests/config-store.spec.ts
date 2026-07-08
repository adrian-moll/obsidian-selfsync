import { describe, expect, it } from "vitest";
import { applyImportedConfig, buildExportConfig, ConfigVersionError } from "../src/backend/config-store.js";
// Type-only import — erased at build, so this test never loads settings.ts (which
// imports the runtime-less `obsidian` package).
import type { SelfSyncSettings } from "../src/settings.js";

/** A fully-populated settings object (secrets + per-device fields set). */
function makeSettings(over: Partial<SelfSyncSettings> = {}): SelfSyncSettings {
  return {
    webdav: { url: "https://a.example/dav", username: "alice", password: "SECRET-PW", rootDir: "vault" },
    secretStorage: "keychain",
    encryptionEnabled: true,
    encryptionPassphrase: "SECRET-PASSPHRASE",
    autoSyncEnabled: true,
    syncObsidianConfig: false,
    syncOnStartup: true,
    syncIntervalMinutes: 12,
    syncOnFileChange: true,
    excludeGlobs: ["**/*.tmp"],
    maxFileMB: 50,
    debugLogging: false,
    git: {
      enabled: true,
      remoteUrl: "https://git.example/x.git",
      username: "",
      token: "SECRET-TOKEN",
      authorName: "Alice",
      authorEmail: "",
      commitOnSync: true,
      push: true,
      pushChunkSize: 100,
      maxPushMB: 25,
      excludeGlobs: [],
    },
    deviceId: "device-A",
    bootstrapConfigChecked: true,
    ...over,
  };
}

describe("buildExportConfig", () => {
  it("includes non-secret fields and the format version", () => {
    const c = buildExportConfig(makeSettings());
    expect(c.selfsyncConfig).toBe(1);
    expect(c.webdav.url).toBe("https://a.example/dav");
    expect(c.webdav.username).toBe("alice");
    expect(c.webdav.rootDir).toBe("vault");
    expect(c.encryptionEnabled).toBe(true);
    expect(c.excludeGlobs).toEqual(["**/*.tmp"]);
    expect(c.syncIntervalMinutes).toBe(12);
  });

  it("NEVER includes secrets, per-device fields, or the git block", () => {
    const c = buildExportConfig(makeSettings());
    const flat = JSON.stringify(c);
    expect(flat).not.toContain("SECRET-PW");
    expect(flat).not.toContain("SECRET-PASSPHRASE");
    expect(flat).not.toContain("SECRET-TOKEN");
    expect(flat).not.toContain("device-A");
    // Git backup is desktop-only + per-device: not exported at all.
    expect(flat).not.toContain("git.example");
    expect((c.webdav as unknown as Record<string, unknown>).password).toBeUndefined();
    expect((c as unknown as Record<string, unknown>).encryptionPassphrase).toBeUndefined();
    expect((c as unknown as Record<string, unknown>).git).toBeUndefined();
    expect((c as unknown as Record<string, unknown>).deviceId).toBeUndefined();
  });
});

describe("applyImportedConfig", () => {
  it("applies non-secret fields but preserves THIS device's secrets + deviceId", () => {
    const source = buildExportConfig(makeSettings({ syncIntervalMinutes: 30, excludeGlobs: ["Private/**"] }));
    const target = makeSettings({
      webdav: { url: "", username: "", password: "MY-PW", rootDir: "selfsync" },
      encryptionPassphrase: "MY-PASSPHRASE",
      git: {
        enabled: false,
        remoteUrl: "",
        username: "",
        token: "MY-TOKEN",
        authorName: "",
        authorEmail: "",
        commitOnSync: true,
        push: true,
        pushChunkSize: 100,
        maxPushMB: 25,
        excludeGlobs: [],
      },
      deviceId: "device-B",
      bootstrapConfigChecked: true,
    });

    const merged = applyImportedConfig(target, source);

    // Non-secret fields adopted from the source config.
    expect(merged.webdav.url).toBe("https://a.example/dav");
    expect(merged.webdav.username).toBe("alice");
    expect(merged.syncIntervalMinutes).toBe(30);
    expect(merged.excludeGlobs).toEqual(["Private/**"]);

    // Secrets + per-device fields kept from the TARGET device.
    expect(merged.webdav.password).toBe("MY-PW");
    expect(merged.encryptionPassphrase).toBe("MY-PASSPHRASE");
    expect(merged.deviceId).toBe("device-B");
    expect(merged.bootstrapConfigChecked).toBe(true);

    // The ENTIRE git block stays the target device's own (never from the source).
    expect(merged.git.token).toBe("MY-TOKEN");
    expect(merged.git.enabled).toBe(false); // target had it off; source's `true` is ignored
    expect(merged.git.remoteUrl).toBe(""); // target's empty remote, not the source's
  });

  it("ignores unknown keys and coerces/clamps bad values to the current ones", () => {
    const target = makeSettings({ syncIntervalMinutes: 5, maxFileMB: 50 });
    const merged = applyImportedConfig(target, {
      selfsyncConfig: 1,
      syncIntervalMinutes: -3, // invalid → keep current
      maxFileMB: "lots", // wrong type → keep current
      somethingUnknown: 42, // ignored
    });
    expect(merged.syncIntervalMinutes).toBe(5);
    expect(merged.maxFileMB).toBe(50);
    expect((merged as unknown as Record<string, unknown>).somethingUnknown).toBeUndefined();
  });

  it("rejects a payload with a wrong or missing version", () => {
    const target = makeSettings();
    expect(() => applyImportedConfig(target, { selfsyncConfig: 999 })).toThrow(ConfigVersionError);
    expect(() => applyImportedConfig(target, {})).toThrow(ConfigVersionError);
    expect(() => applyImportedConfig(target, "not an object")).toThrow(ConfigVersionError);
  });

  it("round-trips: export then import onto another device yields the source's non-secret config", () => {
    const a = makeSettings({ syncObsidianConfig: true, excludeGlobs: ["A/**"], autoSyncEnabled: false });
    const exported = JSON.parse(JSON.stringify(buildExportConfig(a)));
    const b = makeSettings({ deviceId: "device-B", syncObsidianConfig: false, excludeGlobs: [], autoSyncEnabled: true });
    const merged = applyImportedConfig(b, exported);
    expect(merged.syncObsidianConfig).toBe(true);
    expect(merged.excludeGlobs).toEqual(["A/**"]);
    expect(merged.autoSyncEnabled).toBe(false); // preference propagates
    expect(merged.deviceId).toBe("device-B");
  });
});
