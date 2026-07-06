/**
 * Remote layout tests (D12): mirror mode stores files at real vault paths
 * (browsable), opaque mode hides them behind opaque keys. Both must still
 * converge across devices.
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../src/backend/storage-backend.js";
import { MirrorNaming, OpaqueNaming, type BlobNaming } from "../src/engine/naming.js";
import { makeExcluder } from "../src/engine/exclude.js";
import { dec, enc, makeDevice } from "./support/devices.js";

async function createOne(naming: BlobNaming) {
  const backend = new MemoryBackend();
  const A = makeDevice(backend, "A", naming);
  await A.vault.writeBinary("Notes/todo.md", enc("hi"));
  await A.sync();
  return { backend, keys: (await backend.list()).map((e) => e.key) };
}

describe("remote layout", () => {
  it("mirror: files at real paths (browsable), manifest under .selfsync", async () => {
    const { backend, keys } = await createOne(new MirrorNaming());
    expect(keys).toContain("Notes/todo.md");
    expect(keys.some((k) => k.startsWith("b-"))).toBe(false);
    expect(await backend.readWithMeta(".selfsync/manifest.json")).not.toBeNull();
  });

  it("opaque: files under opaque keys, manifest at root", async () => {
    const { backend, keys } = await createOne(new OpaqueNaming());
    expect(keys).not.toContain("Notes/todo.md");
    expect(keys.some((k) => k.startsWith("b-"))).toBe(true);
    expect(await backend.readWithMeta("manifest.json")).not.toBeNull();
  });

  it("mirror: rename relocates the blob (move)", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A", new MirrorNaming());
    await A.vault.writeBinary("Notes/todo.md", enc("hi"));
    await A.sync();
    await A.vault.rename("Notes/todo.md", "Notes/done.md");
    const r = await A.sync();
    expect(r.ops.some((o) => o.kind === "move")).toBe(true);
    const keys = (await backend.list()).map((e) => e.key);
    expect(keys).toContain("Notes/done.md");
    expect(keys).not.toContain("Notes/todo.md");
  });

  it("never uploads excluded paths (e.g. the plugin's own data)", async () => {
    const backend = new MemoryBackend();
    const exclude = makeExcluder([".obsidian/plugins/selfsync/**"]);
    const A = makeDevice(backend, "A", new MirrorNaming(), exclude);
    await A.vault.writeBinary("Notes/todo.md", enc("hi"));
    await A.vault.writeBinary(".obsidian/plugins/selfsync/data.json", enc("device-specific"));
    await A.sync();
    const keys = (await backend.list()).map((e) => e.key);
    expect(keys).toContain("Notes/todo.md");
    expect(keys).not.toContain(".obsidian/plugins/selfsync/data.json");
  });

  it("opaque mode still propagates across devices", async () => {
    const backend = new MemoryBackend();
    const A = makeDevice(backend, "A", new OpaqueNaming());
    const B = makeDevice(backend, "B", new OpaqueNaming());
    await A.vault.writeBinary("note.md", enc("hello"));
    await A.sync();
    await B.sync();
    expect(dec(await B.vault.readBinary("note.md"))).toBe("hello");
  });
});
