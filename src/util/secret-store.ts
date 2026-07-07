/**
 * At-rest protection for stored secrets (the WebDAV password and the Git token),
 * which otherwise sit as cleartext in the plugin's data.json.
 *
 * Secrets are stored **self-describing** so decode dispatches on the prefix and
 * always works — regardless of the current setting, or which device/mode wrote
 * the value:
 *   - "obf:v1:<base64>"  obfuscated (reversible; NOT encryption — see below)
 *   - "kc:v1:<base64>"   OS keychain via Electron safeStorage (desktop only)
 *   - anything else      plaintext (also handles legacy cleartext data.json)
 *
 * The `SecretStorageMode` setting only decides what encode-on-save WRITES; load
 * accepts any form. This module is deliberately free of Obsidian/Electron imports
 * so it stays cross-platform and unit-testable — the desktop keychain is supplied
 * by the caller as an injected `KeychainProvider`.
 */
import { arrayBufferToBase64, base64ToArrayBuffer, utf8 } from "../backend/http.js";

export type SecretStorageMode = "plaintext" | "obfuscated" | "keychain";

const OBF_PREFIX = "obf:v1:";
const KC_PREFIX = "kc:v1:";

/**
 * Desktop-only OS-keychain provider (Electron safeStorage). Injected so the
 * cross-platform logic here can be tested without Electron. `encrypt`/`decrypt`
 * operate on base64 strings.
 */
export interface KeychainProvider {
  isAvailable(): boolean;
  encrypt(plaintext: string): string;
  decrypt(base64: string): string;
}

// Obfuscation key. This is embedded in the plugin, so obfuscation is trivially
// reversible by anyone reading the code — it only stops *casual* disclosure
// (idle folder browsing, screen shares, an accidentally committed/pasted
// data.json). It is NOT encryption; the "keychain" mode is the real protection.
const OBF_KEY = new Uint8Array(utf8.encode("selfsync/obfuscation/v1"));

function xorBytes(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ OBF_KEY[i % OBF_KEY.length];
  return out;
}

function obfuscate(plaintext: string): string {
  const bytes = new Uint8Array(utf8.encode(plaintext));
  // xorBytes returns a freshly-allocated Uint8Array, so its .buffer is a plain
  // ArrayBuffer (the cast just narrows TS's ArrayBufferLike).
  return OBF_PREFIX + arrayBufferToBase64(xorBytes(bytes).buffer as ArrayBuffer);
}

function deobfuscate(stored: string): string {
  const bytes = new Uint8Array(base64ToArrayBuffer(stored.slice(OBF_PREFIX.length)));
  return utf8.decode(xorBytes(bytes).buffer as ArrayBuffer);
}

/**
 * Encode a plaintext secret for storage under `mode`. Empty secrets are stored
 * as-is (no prefix). "keychain" falls back to "obfuscated" when no working
 * provider is supplied (mobile, or safeStorage unavailable), so a chosen mode
 * never leaves a secret unprotected-by-surprise.
 */
export function encodeSecret(mode: SecretStorageMode, plaintext: string, keychain?: KeychainProvider | null): string {
  if (!plaintext) return "";
  if (mode === "plaintext") return plaintext;
  if (mode === "keychain") {
    if (keychain && keychain.isAvailable()) {
      try {
        return KC_PREFIX + keychain.encrypt(plaintext);
      } catch {
        return obfuscate(plaintext); // provider blew up → don't lose protection
      }
    }
    return obfuscate(plaintext); // no keychain here → best available
  }
  return obfuscate(plaintext);
}

/**
 * Decode a stored secret back to plaintext, dispatching on its prefix. A
 * keychain-encrypted value that can't be decrypted here (no provider, or written
 * on a different machine/OS-user) yields "" so the caller shows "not configured"
 * and the user re-enters it — never a crash.
 */
export function decodeSecret(stored: string, keychain?: KeychainProvider | null): string {
  if (!stored) return "";
  if (stored.startsWith(KC_PREFIX)) {
    if (!keychain) return "";
    try {
      return keychain.decrypt(stored.slice(KC_PREFIX.length));
    } catch {
      return "";
    }
  }
  if (stored.startsWith(OBF_PREFIX)) {
    try {
      return deobfuscate(stored);
    } catch {
      return "";
    }
  }
  return stored; // unprefixed = plaintext (incl. legacy data.json)
}
