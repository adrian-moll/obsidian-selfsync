/**
 * Live LARGE-FILE end-to-end sync against real kDrive (browsable single object).
 * A file over the 8 MiB download-stream chunk is uploaded WHOLE to its real vault
 * path (browsable in the kDrive web UI, not split into parts), re-scans without
 * re-uploading, and downloads byte-for-byte on a second device via streaming.
 * Skipped without kDrive credentials (.env.local); requires
 * NODE_OPTIONS=--use-system-ca behind a TLS proxy. Cleans up "selfsync-large/".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDavBackend } from "../src/backend/webdav-backend.js";
import { fetchHttp } from "../src/backend/http.js";
import { makeDevice } from "./support/devices.js";

const url = process.env.SELFSYNC_WEBDAV_URL;
const user = process.env.SELFSYNC_WEBDAV_USER;
const pass = process.env.SELFSYNC_WEBDAV_PASS;
const hasKdrive = Boolean(url && user && pass);

const BIG_BYTES = 12 * 1024 * 1024;
function bigBuffer(): ArrayBuffer {
  const u = new Uint8Array(BIG_BYTES);
  for (let i = 0; i < BIG_BYTES; i++) u[i] = (i * 17 + (i >> 8)) & 0xff;
  return u.buffer;
}
function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

describe.skipIf(!hasKdrive)("live kDrive large-file sync (browsable single object)", () => {
  const backend = new WebDavBackend({
    baseUrl: url!,
    username: user!,
    password: pass!,
    rootDir: "selfsync-large",
    http: fetchHttp,
  });

  beforeAll(async () => {
    await backend.removeRoot().catch(() => {});
  });
  afterAll(async () => {
    await backend.removeRoot().catch(() => {});
  });

  it("uploads whole to the vault path, doesn't re-upload, and downloads byte-perfect", async () => {
    const A = makeDevice(backend, "A");
    const B = makeDevice(backend, "B");
    const content = bigBuffer();

    await A.vault.writeBinary("Media/clip.bin", content);
    const ra = await A.sync({ useMtimeShortcut: true });
    expect(ra.failed).toEqual([]);

    // One browsable object at the real path — not split into parts.
    const keys = (await backend.list()).map((e) => e.key);
    expect(keys).toContain("Media/clip.bin");
    expect(keys.some((k) => k.includes("/parts/"))).toBe(false);

    // Re-scan: no re-upload (unchanged; mtime shortcut).
    const ra2 = await A.sync({ useMtimeShortcut: true });
    expect(ra2.ops).toHaveLength(0);

    // Second device streams it down byte-for-byte.
    const rb = await B.sync();
    expect(rb.failed).toEqual([]);
    expect(sameBytes(await B.vault.readBinary("Media/clip.bin"), content)).toBe(true);
  }, 120_000);
});
