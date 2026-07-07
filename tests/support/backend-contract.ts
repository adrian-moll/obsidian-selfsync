/**
 * Shared StorageBackend conformance suite. Run against every backend (in-memory
 * always; real WebDAV — hosted kDrive or a self-hosted Apache mod_dav container —
 * when credentials/containers are available) so they all behave identically for
 * the engine above them (docs/developer/backends.md, docs/developer/testing.md).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConditionalWriteError, type StorageBackend } from "../../src/backend/storage-backend.js";
import { utf8 } from "../../src/backend/http.js";

export interface ContractHarness {
  backend: StorageBackend;
  /** Namespaces a key so runs don't collide on a shared backend. */
  key: (name: string) => string;
  cleanup: () => Promise<void>;
  /**
   * Delay (ms) to let a just-written blob "settle" before a conditional
   * overwrite. Some servers (Apache mod_dav) emit a *weak* ETag for ~1s after a
   * change, which never satisfies a strong `If-Match`; this models the natural
   * spacing between real manifest commits. Default 0 (kDrive and in-memory
   * return strong etags immediately).
   */
  settleMs?: number;
}

export function runBackendContract(name: string, setup: () => Promise<ContractHarness>): void {
  describe(`StorageBackend contract: ${name}`, () => {
    let h: ContractHarness;
    const settle = () => new Promise<void>((r) => setTimeout(r, h.settleMs ?? 0));
    beforeAll(async () => {
      h = await setup();
    });
    afterAll(async () => {
      await h?.cleanup();
    });

    it("write → read round-trips and returns an etag", async () => {
      const k = h.key("rt.txt");
      const etag = await h.backend.write(k, utf8.encode("hello"));
      expect(typeof etag).toBe("string");
      expect(utf8.decode(await h.backend.read(k))).toBe("hello");
    });

    it("list surfaces a written key", async () => {
      const k = h.key("listed.txt");
      await h.backend.write(k, utf8.encode("x"));
      const keys = (await h.backend.list()).map((e) => e.key);
      expect(keys).toContain(k);
    });

    it("conditional write: correct etag overwrites, stale etag throws", async () => {
      const k = h.key("cond.txt");
      const etag1 = await h.backend.write(k, utf8.encode("v1"));
      await settle();
      const etag2 = await h.backend.write(k, utf8.encode("v2"), etag1);
      expect(utf8.decode(await h.backend.read(k))).toBe("v2");
      expect(etag2).not.toBe(etag1);
      await expect(h.backend.write(k, utf8.encode("v3"), etag1)).rejects.toBeInstanceOf(ConditionalWriteError);
    });

    it("remove deletes the key", async () => {
      const k = h.key("del.txt");
      await h.backend.write(k, utf8.encode("bye"));
      await h.backend.remove(k);
      const keys = (await h.backend.list()).map((e) => e.key);
      expect(keys).not.toContain(k);
    });

    it("readWithMeta's etag is usable for a conditional overwrite (no 412)", async () => {
      // This is exactly the manifest commit invariant: read → get etag →
      // conditional write with that etag must succeed. Regression guard for the
      // kDrive 412 bug where read/write etags disagreed.
      const k = h.key("meta.txt");
      await h.backend.write(k, utf8.encode("v1"));
      const r = await h.backend.readWithMeta(k);
      expect(r).not.toBeNull();
      await settle();
      await h.backend.write(k, utf8.encode("v2"), r!.etag); // must NOT throw 412
      expect(utf8.decode(await h.backend.read(k))).toBe("v2");
    });

    it("move relocates a blob", async () => {
      const from = h.key("mv-from.txt");
      const to = h.key("mv-to.txt");
      await h.backend.write(from, utf8.encode("data"));
      await h.backend.move(from, to);
      expect(utf8.decode(await h.backend.read(to))).toBe("data");
      const keys = (await h.backend.list()).map((e) => e.key);
      expect(keys).toContain(to);
      expect(keys).not.toContain(from);
    });
  });
}
