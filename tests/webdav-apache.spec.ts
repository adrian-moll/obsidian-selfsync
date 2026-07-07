/**
 * Live self-hosted WebDAV contract test against Apache mod_dav — the recommended
 * bring-your-own-backend for users without a kDrive subscription. Runs only when
 * SELFSYNC_APACHEDAV_URL/USER/PASS are set; otherwise skipped (CI stays green).
 * Spin one up with `docker compose -f docker/docker-compose.yml up -d webdav`.
 *
 * Uses settleMs > 1s because mod_dav emits a *weak* ETag for one second after a
 * write, which a strong If-Match rejects (see normalizeEtag in webdav-backend.ts);
 * the delay models the natural spacing between real manifest commits.
 */
import { describe } from "vitest";
import { runBackendContract } from "./support/backend-contract.js";
import { WebDavBackend } from "../src/backend/webdav-backend.js";
import { fetchHttp } from "../src/backend/http.js";

const url = process.env.SELFSYNC_APACHEDAV_URL;
const user = process.env.SELFSYNC_APACHEDAV_USER;
const pass = process.env.SELFSYNC_APACHEDAV_PASS;
const hasApache = Boolean(url && user && pass);

describe.skipIf(!hasApache)("live Apache mod_dav WebDAV", () => {
  runBackendContract("WebDavBackend @ Apache mod_dav", async () => {
    const backend = new WebDavBackend({
      baseUrl: url!,
      username: user!,
      password: pass!,
      rootDir: "selfsync-itest",
      http: fetchHttp,
    });
    await backend.removeRoot().catch(() => {});
    await backend.ensureRoot();
    return {
      backend,
      key: (n) => n,
      settleMs: 1100,
      cleanup: async () => {
        await backend.removeRoot().catch(() => {});
      },
    };
  });
});
