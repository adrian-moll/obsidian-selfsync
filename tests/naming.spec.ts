import { describe, expect, it } from "vitest";
import { MirrorNaming, OpaqueNaming } from "../src/engine/naming.js";

describe("BlobNaming", () => {
  it("mirror: blobKey is the identity path; manifest under .selfsync", async () => {
    const n = new MirrorNaming();
    expect(await n.blobKey("Notes/todo.md")).toBe("Notes/todo.md");
    expect(n.manifestKey).toBe(".selfsync/manifest.json");
  });

  it("opaque: blobKey is a stable opaque hash; manifest at root", async () => {
    const n = new OpaqueNaming();
    const k1 = await n.blobKey("Notes/todo.md");
    const k2 = await n.blobKey("Notes/todo.md");
    expect(k1).toMatch(/^b-[0-9a-f]{64}$/);
    expect(k1).toBe(k2); // deterministic
    expect(await n.blobKey("Other.md")).not.toBe(k1);
    expect(n.manifestKey).toBe("manifest.json");
  });
});
