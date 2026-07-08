/**
 * VaultAdapter — the plugin's own abstraction over vault file I/O. In the app it
 * delegates to Obsidian's DataAdapter; in tests we inject a Node-fs or in-memory
 * implementation. This is the hinge that makes the engine testable without
 * Obsidian (docs/12-testing.md).
 */

export interface VaultFileStat {
  size: number;
  mtime: number; // ms since epoch
}

export interface VaultAdapter {
  /** All vault-relative file paths (recursive). */
  list(): Promise<string[]>;
  stat(path: string): Promise<VaultFileStat | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  /**
   * Append bytes to the end of a file (creating it if absent). Lets large
   * downloads be streamed to disk one chunk at a time instead of buffering (and
   * base64-encoding, on mobile) the whole file at once — the Android OOM fix.
   */
  appendBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
