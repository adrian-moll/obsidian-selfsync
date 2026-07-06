/** In-memory VaultAdapter for unit tests and the two-device simulation (L3). */
import type { VaultAdapter, VaultFileStat } from "./vault-adapter.js";

interface Entry {
  data: ArrayBuffer;
  mtime: number;
}

export class MemoryVaultAdapter implements VaultAdapter {
  private readonly files = new Map<string, Entry>();
  private clock = 0;

  private tick(): number {
    return ++this.clock;
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }

  async stat(path: string): Promise<VaultFileStat | null> {
    const e = this.files.get(path);
    return e ? { size: e.data.byteLength, mtime: e.mtime } : null;
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const e = this.files.get(path);
    if (!e) throw new Error(`ENOENT: ${path}`);
    return e.data.slice(0);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, { data: data.slice(0), mtime: this.tick() });
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const e = this.files.get(from);
    if (!e) throw new Error(`ENOENT: ${from}`);
    this.files.set(to, { data: e.data, mtime: this.tick() });
    this.files.delete(from);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}
