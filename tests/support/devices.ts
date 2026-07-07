/** Shared helpers for the two-device sync simulations (in-memory and live). */
import { MemoryVaultAdapter } from "../../src/vault/memory-vault-adapter.js";
import { MemoryStateStore } from "../../src/engine/state-db.js";
import { SyncEngine } from "../../src/engine/engine.js";
import { MirrorNaming, type BlobNaming } from "../../src/engine/naming.js";
import { MemoryBaseStore } from "../../src/engine/base-store.js";
import type { StorageBackend } from "../../src/backend/storage-backend.js";

export const enc = (s: string): ArrayBuffer => {
  const v = new TextEncoder().encode(s);
  const b = new ArrayBuffer(v.byteLength);
  new Uint8Array(b).set(v);
  return b;
};

export const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);

export interface SimDevice {
  vault: MemoryVaultAdapter;
  sync: () => ReturnType<SyncEngine["sync"]>;
}

/** A simulated device: its own vault + State DB, sharing the given backend. */
export function makeDevice(
  backend: StorageBackend,
  id: string,
  naming: BlobNaming = new MirrorNaming(),
  exclude?: (path: string) => boolean,
): SimDevice {
  const vault = new MemoryVaultAdapter();
  const engine = new SyncEngine({
    vault,
    backend,
    state: new MemoryStateStore(),
    deviceId: id,
    naming,
    baseStore: new MemoryBaseStore(),
  });
  let n = 0;
  return {
    vault,
    sync: () => engine.sync({ timestampIso: `2026-01-01T00-00-${String(n++).padStart(2, "0")}Z`, exclude }),
  };
}
