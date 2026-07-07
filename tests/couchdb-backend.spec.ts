/**
 * Live CouchDB contract test. Runs only when CouchDB credentials are in the
 * environment (SELFSYNC_COUCHDB_URL/USER/PASS); otherwise skipped (CI stays
 * green). Spin up a throwaway CouchDB (see docker/docker-compose.yml) and set the
 * env vars to run it. Uses a unique per-run database, deleted on cleanup.
 */
import { describe } from "vitest";
import { runBackendContract } from "./support/backend-contract.js";
import { CouchDbBackend } from "../src/backend/couchdb-backend.js";
import { basicAuth, fetchHttp } from "../src/backend/http.js";

const url = process.env.SELFSYNC_COUCHDB_URL;
const user = process.env.SELFSYNC_COUCHDB_USER;
const pass = process.env.SELFSYNC_COUCHDB_PASS;
const hasCouch = Boolean(url && user && pass);

describe.skipIf(!hasCouch)("live CouchDB", () => {
  const database = "selfsync-itest-" + Date.now();

  runBackendContract("CouchDbBackend", async () => {
    const backend = new CouchDbBackend({
      baseUrl: url!,
      username: user!,
      password: pass!,
      database,
      http: fetchHttp,
    });
    await backend.ensureDb();
    return {
      backend,
      key: (n) => n,
      cleanup: async () => {
        await fetchHttp({
          method: "DELETE",
          url: `${url!.replace(/\/+$/, "")}/${database}`,
          headers: { Authorization: basicAuth(user!, pass!) },
        }).catch(() => {});
      },
    };
  });
});
