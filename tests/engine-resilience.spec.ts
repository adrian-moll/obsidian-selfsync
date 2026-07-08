/**
 * A single file's op failing (e.g. a server 500 on GET) must NOT abort the whole
 * sync: the other files converge, the bad file is reported in `failed`, and it is
 * retried (and succeeds) on the next cycle. Regression guard for the sync getting
 * wedged forever on one erroring file.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryBackend,
  type BackendCapabilities,
  type ReadResult,
  type RemoteEntry,
  type StorageBackend,
} from "../src/backend/storage-backend.js";
import { enc, makeDevice } from "./support/devices.js";

/** Delegates to a MemoryBackend but throws on read of one key (like a 500). */
class FailingBackend implements StorageBackend {
  failKey: string | null;
  constructor(
    private readonly inner: MemoryBackend,
    failKey: string,
  ) {
    this.failKey = failKey;
  }
  testConnection() {
    return this.inner.testConnection();
  }
  list(): Promise<RemoteEntry[]> {
    return this.inner.list();
  }
  read(key: string): Promise<ArrayBuffer> {
    if (key === this.failKey) throw new Error(`WebDAV GET ${key} failed: HTTP 500`);
    return this.inner.read(key);
  }
  readWithMeta(key: string): Promise<ReadResult | null> {
    return this.inner.readWithMeta(key);
  }
  head(key: string) {
    return this.inner.head(key);
  }
  readRange(key: string, start: number, end: number): Promise<ArrayBuffer> {
    if (key === this.failKey) throw new Error(`WebDAV GET ${key} failed: HTTP 500`);
    return this.inner.readRange(key, start, end);
  }
  write(key: string, data: ArrayBuffer, prevEtag?: string): Promise<string> {
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

describe("per-file error resilience", () => {
  it("skips a failing download, syncs the rest, and retries it next cycle", async () => {
    const inner = new MemoryBackend();

    // Device A uploads three files (mirror mode: blobKey === path).
    const a = makeDevice(inner, "A");
    await a.vault.writeBinary("ok1.md", enc("one"));
    await a.vault.writeBinary("bad.md", enc("boom"));
    await a.vault.writeBinary("ok2.md", enc("two"));
    expect((await a.sync()).committed).toBe(true);

    // Device B downloads, but the backend 500s on bad.md.
    const failing = new FailingBackend(inner, "bad.md");
    const b = makeDevice(failing, "B");
    const res = await b.sync();

    // The sync still succeeded overall; only the bad file was skipped.
    expect(res.committed).toBe(true);
    expect(res.conflict).toBe(false);
    expect(res.failed).toEqual(["bad.md"]);
    expect(await b.vault.exists("ok1.md")).toBe(true);
    expect(await b.vault.exists("ok2.md")).toBe(true);
    expect(await b.vault.exists("bad.md")).toBe(false);

    // Once the server recovers, the next sync retries and gets the file.
    failing.failKey = null;
    const res2 = await b.sync();
    expect(res2.failed).toEqual([]);
    expect(await b.vault.exists("bad.md")).toBe(true);
  });
});
