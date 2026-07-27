/**
 * BaseStore backed by the Node filesystem, for the headless client. Same shape as
 * ObsidianBaseStore (flat directory, vault path URL-encoded to a filename) with
 * one deliberate difference: it lives in the container's STATE directory, outside
 * the vault, rather than under `.obsidian/plugins/selfsync/base`.
 *
 * That keeps last-synced content off the synced tree entirely — nothing to
 * exclude, and no fs-watch events firing every time the engine remembers a base.
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { BaseStore } from "../engine/base-store.js";

export class NodeBaseStore implements BaseStore {
  private readonly dir: string;
  private ensured = false;

  /** @param stateDir the container's state directory; bases go in `<stateDir>/base`. */
  constructor(stateDir: string) {
    this.dir = nodePath.join(nodePath.resolve(stateDir), "base");
  }

  private fileFor(path: string): string {
    return nodePath.join(this.dir, encodeURIComponent(path));
  }

  private async ensureDir(): Promise<void> {
    if (this.ensured) return;
    await fs.mkdir(this.dir, { recursive: true });
    this.ensured = true;
  }

  async get(path: string): Promise<ArrayBuffer | null> {
    try {
      const buf = await fs.readFile(this.fileFor(path));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } catch {
      return null; // absent (or unreadable) → no ancestor, so no 3-way merge
    }
  }

  async set(path: string, data: ArrayBuffer): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(this.fileFor(path), new Uint8Array(data));
  }

  async delete(path: string): Promise<void> {
    await fs.rm(this.fileFor(path), { force: true });
  }
}
