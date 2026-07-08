/**
 * Progress/phase reporting: the engine must emit feedback during the phases that
 * otherwise show a long silent "Syncing…" — remote-index load, vault scan (with a
 * running file count), reconcile — and then a per-file count through the op loop.
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { MemoryStateStore } from "../src/engine/state-db.js";
import { MemoryVaultAdapter } from "../src/vault/memory-vault-adapter.js";
import { MirrorNaming } from "../src/engine/naming.js";
import { scanVault, SyncEngine } from "../src/engine/engine.js";
import { enc } from "./support/devices.js";

describe("scanVault progress", () => {
  it("reports onProgress monotonically up to the total path count", async () => {
    const vault = new MemoryVaultAdapter();
    for (let i = 0; i < 5; i++) await vault.writeBinary(`n${i}.md`, enc(`file ${i}`));
    const seen: Array<[number, number]> = [];
    await scanVault(vault, undefined, () => false, 0, undefined, (d, t) => seen.push([d, t]));

    expect(seen.length).toBe(5);
    expect(seen.every(([, t]) => t === 5)).toBe(true);
    expect(seen.map(([d]) => d)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("engine phase reporting", () => {
  it("emits load / scan / reconcile phases before the op loop, then per-file progress", async () => {
    const vault = new MemoryVaultAdapter();
    for (let i = 0; i < 3; i++) await vault.writeBinary(`n${i}.md`, enc(`x${i}`));
    const engine = new SyncEngine({
      vault,
      backend: new MemoryBackend(),
      state: new MemoryStateStore(),
      deviceId: "A",
      naming: new MirrorNaming(),
    });

    const phases: string[] = [];
    const progress: Array<[number, number]> = [];
    await engine.sync({
      timestampIso: "2026-01-01T00-00-00Z",
      onPhase: (d) => phases.push(d),
      onProgress: (d, t) => progress.push([d, t]),
    });

    expect(phases.some((p) => p.startsWith("Loading remote index"))).toBe(true);
    expect(phases.some((p) => p.startsWith("Scanning"))).toBe(true);
    expect(phases.some((p) => /^Scanning \d+\/\d+…$/.test(p))).toBe(true);
    expect(phases.some((p) => p.startsWith("Reconciling"))).toBe(true);
    // Three uploads → per-file progress ticks 1,2,3 (not a single 3/3 jump).
    expect(progress.map(([d]) => d)).toEqual([1, 2, 3]);
  });
});
