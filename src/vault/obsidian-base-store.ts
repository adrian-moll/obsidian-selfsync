/**
 * BaseStore backed by Obsidian's DataAdapter, storing last-synced content under
 * the plugin's own (sync-excluded) config folder. Device-local; keyed by vault
 * path (URL-encoded to a flat filename). Works on desktop and mobile.
 */
import { type App, type DataAdapter, normalizePath } from "obsidian";
import type { BaseStore } from "../engine/base-store.js";

const BASE_DIR = ".obsidian/plugins/selfsync/base";

export class ObsidianBaseStore implements BaseStore {
  private readonly adapter: DataAdapter;
  private ensured = false;

  constructor(app: App) {
    this.adapter = app.vault.adapter;
  }

  private fileFor(path: string): string {
    return normalizePath(`${BASE_DIR}/${encodeURIComponent(path)}`);
  }

  private async ensureDir(): Promise<void> {
    if (this.ensured) return;
    if (!(await this.adapter.exists(BASE_DIR))) await this.adapter.mkdir(BASE_DIR);
    this.ensured = true;
  }

  async get(path: string): Promise<ArrayBuffer | null> {
    const file = this.fileFor(path);
    if (!(await this.adapter.exists(file))) return null;
    return this.adapter.readBinary(file);
  }

  async set(path: string, data: ArrayBuffer): Promise<void> {
    await this.ensureDir();
    await this.adapter.writeBinary(this.fileFor(path), data);
  }

  async delete(path: string): Promise<void> {
    const file = this.fileFor(path);
    if (await this.adapter.exists(file)) await this.adapter.remove(file);
  }
}
