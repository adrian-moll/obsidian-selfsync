/**
 * Two-device sim for `.obsidian` config conflict handling: enabled-plugin lists
 * must union-merge (no keep-both copy) so a second device joining an already
 * set-up vault ends up with all plugins enabled, and both devices converge.
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { dec, enc, makeDevice } from "./support/devices.js";

const CP = ".obsidian/community-plugins.json";
const asSet = (buf: ArrayBuffer) => new Set(JSON.parse(dec(buf)) as string[]);

describe("config conflict auto-resolution (sim)", () => {
  it("unions community-plugins.json instead of writing a conflict copy", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A");
    const B = makeDevice(backend, "B");

    // Device A: set up with a plugin, synced.
    await A.vault.writeBinary(CP, enc(JSON.stringify(["dataview"])));
    await A.sync();

    // Device B: fresh vault already has its own list, then joins.
    await B.vault.writeBinary(CP, enc(JSON.stringify(["templater"])));
    const r = await B.sync();

    // No conflict copy anywhere.
    expect(r.conflictCopies).toHaveLength(0);
    expect((await B.vault.list()).filter((p) => /\(conflict /.test(p))).toHaveLength(0);
    // B ends up with the union, and it's reported as auto-resolved.
    expect(asSet(await B.vault.readBinary(CP))).toEqual(new Set(["dataview", "templater"]));
    expect(r.merged).toContain(CP);

    // A converges to the same union on its next sync (plain download, no conflict).
    await A.sync();
    expect(asSet(await A.vault.readBinary(CP))).toEqual(new Set(["dataview", "templater"]));
  });

  it("still keeps-both for a genuine NOTE conflict (config policy doesn't leak)", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A");
    const B = makeDevice(backend, "B");
    await A.vault.writeBinary("note.md", enc("A"));
    await A.sync();
    await B.vault.writeBinary("note.md", enc("B"));
    const r = await B.sync();
    expect(r.conflictCopies.length).toBe(1); // notes are unaffected by the config policy
  });
});
