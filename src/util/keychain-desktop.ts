/**
 * Desktop-only OS-keychain provider backed by Electron `safeStorage`
 * (Windows DPAPI / macOS Keychain / Linux libsecret).
 *
 * MUST only ever be reached via a lazy `await import()` behind a
 * `Platform.isDesktopApp` guard (see `getKeychain()` in main.ts) — it uses
 * Electron/Node and must never load on mobile. `electron` is an esbuild external,
 * so `require("electron")` resolves against Electron's runtime.
 *
 * `safeStorage`'s exact location differs across Electron/Obsidian versions, so we
 * probe a couple of access paths and report `isAvailable() === false` if none
 * work — the caller then falls back to obfuscation, so this never breaks sync.
 */
import type { KeychainProvider } from "./secret-store.js";

interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

function resolveSafeStorage(): SafeStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as { safeStorage?: SafeStorage; remote?: { safeStorage?: SafeStorage } };
    return electron?.safeStorage ?? electron?.remote?.safeStorage ?? null;
  } catch {
    return null;
  }
}

export function getKeychainProvider(): KeychainProvider {
  const safeStorage = resolveSafeStorage();
  return {
    isAvailable(): boolean {
      try {
        return !!safeStorage && safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt(plaintext: string): string {
      if (!safeStorage) throw new Error("safeStorage unavailable");
      return safeStorage.encryptString(plaintext).toString("base64");
    },
    decrypt(base64: string): string {
      if (!safeStorage) throw new Error("safeStorage unavailable");
      return safeStorage.decryptString(Buffer.from(base64, "base64"));
    },
  };
}
