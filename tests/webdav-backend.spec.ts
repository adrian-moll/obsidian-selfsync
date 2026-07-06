/**
 * Live WebDAV integration test. Runs only when kDrive credentials are present in
 * the environment (.env.local, loaded by tests/setup/load-env.ts); otherwise it
 * is skipped — so CI (no creds) stays green without network.
 *
 * Requires NODE_OPTIONS=--use-system-ca when run behind a TLS-inspecting proxy.
 * Creates and deletes a temporary "selfsync-itest/" folder on the drive.
 */
import { describe } from "vitest";
import { runBackendContract } from "./support/backend-contract.js";
import { WebDavBackend } from "../src/backend/webdav-backend.js";
import { fetchHttp } from "../src/backend/http.js";

const url = process.env.SELFSYNC_WEBDAV_URL;
const user = process.env.SELFSYNC_WEBDAV_USER;
const pass = process.env.SELFSYNC_WEBDAV_PASS;
const hasKdrive = Boolean(url && user && pass);

describe.skipIf(!hasKdrive)("live kDrive WebDAV", () => {
  runBackendContract("WebDavBackend @ kDrive", async () => {
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
      cleanup: async () => {
        await backend.removeRoot().catch(() => {});
      },
    };
  });
});
