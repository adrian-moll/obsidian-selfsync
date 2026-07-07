/**
 * Live kDrive test: deleting the last file in a folder prunes the now-empty
 * parent folders (browsable layout stays tidy). Gated on kDrive credentials.
 */
import { describe, expect, it } from "vitest";
import { WebDavBackend } from "../src/backend/webdav-backend.js";
import { fetchHttp, utf8 } from "../src/backend/http.js";

const url = process.env.SELFSYNC_WEBDAV_URL;
const user = process.env.SELFSYNC_WEBDAV_USER;
const pass = process.env.SELFSYNC_WEBDAV_PASS;
const hasKdrive = Boolean(url && user && pass);

describe.skipIf(!hasKdrive)("kDrive folder pruning", () => {
  it("removes empty parent folders after deleting the last file", async () => {
    const backend = new WebDavBackend({
      baseUrl: url!,
      username: user!,
      password: pass!,
      rootDir: "selfsync-itest-folders",
      http: fetchHttp,
    });
    await backend.removeRoot().catch(() => {});
    await backend.ensureRoot();
    try {
      await backend.write("a/b/c.txt", utf8.encode("hi"));
      expect((await backend.list()).map((e) => e.key)).toContain("a/b/c.txt");

      await backend.remove("a/b/c.txt");
      // File gone AND its empty parents (a/, a/b/) pruned → nothing left.
      expect(await backend.list()).toHaveLength(0);
    } finally {
      await backend.removeRoot().catch(() => {});
    }
  }, 30_000);
});
