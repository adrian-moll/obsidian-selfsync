import { describe, expect, it } from "vitest";
import { decodeSecret, encodeSecret, type KeychainProvider } from "../src/util/secret-store.js";

// A fake keychain: base64 round-trip, always available.
const kc: KeychainProvider = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s, "utf8").toString("base64"),
  decrypt: (b) => Buffer.from(b, "base64").toString("utf8"),
};
// Unavailable keychain (mobile / safeStorage off).
const kcOff: KeychainProvider = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error("unavailable");
  },
  decrypt: () => {
    throw new Error("unavailable");
  },
};
// Available but throws (safeStorage present yet failing).
const kcBad: KeychainProvider = {
  isAvailable: () => true,
  encrypt: () => {
    throw new Error("boom");
  },
  decrypt: () => {
    throw new Error("boom");
  },
};

const SAMPLES = ["hunter2", "pä$$wörd 🔐 with spaces", "a".repeat(500)];

describe("secret-store", () => {
  it("plaintext mode stores raw and round-trips", () => {
    const enc = encodeSecret("plaintext", "hunter2");
    expect(enc).toBe("hunter2");
    expect(decodeSecret(enc)).toBe("hunter2");
  });

  it("empty secret encodes to empty (no prefix) in every mode", () => {
    for (const mode of ["plaintext", "obfuscated", "keychain"] as const) {
      expect(encodeSecret(mode, "", kc)).toBe("");
    }
    expect(decodeSecret("")).toBe("");
  });

  it("obfuscation is prefixed, not cleartext, and round-trips (incl. unicode)", () => {
    for (const s of SAMPLES) {
      const enc = encodeSecret("obfuscated", s);
      expect(enc.startsWith("obf:v1:")).toBe(true);
      expect(enc).not.toContain(s);
      expect(decodeSecret(enc)).toBe(s);
    }
  });

  it("legacy unprefixed cleartext decodes to itself", () => {
    expect(decodeSecret("legacy-cleartext-password")).toBe("legacy-cleartext-password");
  });

  it("keychain mode round-trips through the provider", () => {
    for (const s of SAMPLES) {
      const enc = encodeSecret("keychain", s, kc);
      expect(enc.startsWith("kc:v1:")).toBe(true);
      expect(decodeSecret(enc, kc)).toBe(s);
    }
  });

  it("keychain falls back to obfuscation when unavailable", () => {
    const enc = encodeSecret("keychain", "hunter2", kcOff);
    expect(enc.startsWith("obf:v1:")).toBe(true);
    expect(decodeSecret(enc)).toBe("hunter2");
  });

  it("keychain falls back to obfuscation when the provider throws on encrypt", () => {
    const enc = encodeSecret("keychain", "hunter2", kcBad);
    expect(enc.startsWith("obf:v1:")).toBe(true);
  });

  it("keychain value can't be decoded without a provider → empty (re-enter creds)", () => {
    const enc = encodeSecret("keychain", "hunter2", kc);
    expect(decodeSecret(enc, null)).toBe("");
    expect(decodeSecret(enc, kcBad)).toBe(""); // provider present but decrypt throws
  });

  it("decode dispatches on prefix regardless of provider (obf decodes with a keychain present)", () => {
    const enc = encodeSecret("obfuscated", "hunter2");
    expect(decodeSecret(enc, kc)).toBe("hunter2");
  });
});
