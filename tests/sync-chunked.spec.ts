/**
 * Chunked manifest commit: large syncs commit in batches, and a mid-sync manifest
 * conflict is recovered by reloading + re-planning the remainder (committed
 * chunks persist in the State DB, so progress isn't lost).
 */
import { describe, expect, it } from "vitest";
import {
  ConditionalWriteError,
  MemoryBackend,
  type BackendCapabilities,
  type ReadResult,
  type RemoteEntry,
  type StorageBackend,
} from "../src/backend/storage-backend.js";
import { MemoryVaultAdapter } from "../src/vault/memory-vault-adapter.js";
import { MemoryStateStore } from "../src/engine/state-db.js";
import { MemoryBaseStore } from "../src/engine/base-store.js";
import { SyncEngine } from "../src/engine/engine.js";
import { MirrorNaming } from "../src/engine/naming.js";
import { enc } from "./support/devices.js";

function engineFor(backend: StorageBackend, vault: MemoryVaultAdapter): SyncEngine {
  return new SyncEngine({
    vault,
    backend,
    state: new MemoryStateStore(),
    deviceId: "A",
    naming: new MirrorNaming(),
    baseStore: new MemoryBaseStore(),
  });
}

/** Wraps a backend and throws a ConditionalWriteError on the first manifest write. */
class ConflictOnceBackend implements StorageBackend {
  private tripped = false;
  constructor(private readonly inner: MemoryBackend) {}
  testConnection(): Promise<void> {
    return this.inner.testConnection();
  }
  list(): Promise<RemoteEntry[]> {
    return this.inner.list();
  }
  read(key: string): Promise<ArrayBuffer> {
    return this.inner.read(key);
  }
  readWithMeta(key: string): Promise<ReadResult | null> {
    return this.inner.readWithMeta(key);
  }
  async write(key: string, data: ArrayBuffer, prevEtag?: string): Promise<string> {
    if (!this.tripped && key.includes("manifest.json")) {
      this.tripped = true;
      throw new ConditionalWriteError(key);
    }
    return this.inner.write(key, data, prevEtag);
  }
  remove(key: string, prevEtag?: string): Promise<void> {
    return this.inner.remove(key, prevEtag);
  }
  move(from: string, to: string): Promise<void> {
    return this.inner.move(from, to);
  }
  capabilities(): BackendCapabilities {
    return this.inner.capabilities();
  }
}

describe("chunked manifest commit", () => {
  it("uploads more files than the chunk size across multiple commits", async () => {
    const backend = new MemoryBackend();
    const vault = new MemoryVaultAdapter();
    for (let i = 0; i < 150; i++) await vault.writeBinary(`n/${i}.md`, enc(`file ${i}`));

    const res = await engineFor(backend, vault).sync({ timestampIso: "2026-01-01T00-00-00Z" });

    expect(res.committed).toBe(true);
    const keys = new Set((await backend.list()).map((e) => e.key));
    for (let i = 0; i < 150; i++) expect(keys.has(`n/${i}.md`)).toBe(true);
  });

  it("recovers from a mid-sync manifest conflict without losing progress", async () => {
    const inner = new MemoryBackend();
    const backend = new ConflictOnceBackend(inner);
    const vault = new MemoryVaultAdapter();
    for (let i = 0; i < 5; i++) await vault.writeBinary(`x${i}.md`, enc(`v${i}`));

    const res = await engineFor(backend, vault).sync({ timestampIso: "2026-01-01T00-00-00Z" });

    expect(res.committed).toBe(true);
    expect(res.conflict).toBe(false);
    const keys = new Set((await inner.list()).map((e) => e.key));
    for (let i = 0; i < 5; i++) expect(keys.has(`x${i}.md`)).toBe(true);
  });
});
