/**
 * VaultAdapter implementation backed by Obsidian's DataAdapter. This is the only
 * place in the sync path that touches the "obsidian" module; it is never imported
 * by unit tests. Works on desktop and mobile.
 */
import { type App, type DataAdapter, normalizePath } from "obsidian";
import type { VaultAdapter, VaultFileStat } from "./vault-adapter.js";

export class ObsidianVaultAdapter implements VaultAdapter {
  private readonly adapter: DataAdapter;

  constructor(app: App) {
    this.adapter = app.vault.adapter;
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const listing = await this.adapter.list(dir);
      for (const file of listing.files) out.push(file);
      for (const folder of listing.folders) await walk(folder);
    };
    await walk("/");
    return out;
  }

  async stat(path: string): Promise<VaultFileStat | null> {
    const st = await this.adapter.stat(normalizePath(path));
    if (!st || st.type !== "file") return null;
    return { size: st.size, mtime: st.mtime };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(normalizePath(path));
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    await this.adapter.writeBinary(normalizePath(path), data);
  }

  async remove(path: string): Promise<void> {
    await this.adapter.remove(normalizePath(path));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.adapter.rename(normalizePath(from), normalizePath(to));
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path));
  }
}
