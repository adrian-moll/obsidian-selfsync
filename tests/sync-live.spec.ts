/**
 * Live end-to-end sync (L3 against a real backend). Runs the FULL SyncEngine —
 * manifest read/commit + blob transfer over real WebDAV — for two devices
 * sharing one kDrive folder, asserting convergence for create/edit/conflict/
 * delete. Skipped without kDrive credentials (.env.local); requires
 * NODE_OPTIONS=--use-system-ca behind a TLS-inspecting proxy. Cleans up its
 * temporary "selfsync-e2e/" folder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDavBackend } from "../src/backend/webdav-backend.js";
import { fetchHttp } from "../src/backend/http.js";
import { dec, enc, makeDevice } from "./support/devices.js";

const url = process.env.SELFSYNC_WEBDAV_URL;
const user = process.env.SELFSYNC_WEBDAV_USER;
const pass = process.env.SELFSYNC_WEBDAV_PASS;
const hasKdrive = Boolean(url && user && pass);

describe.skipIf(!hasKdrive)("live kDrive end-to-end sync", () => {
  const backend = new WebDavBackend({
    baseUrl: url!,
    username: user!,
    password: pass!,
    rootDir: "selfsync-e2e",
    http: fetchHttp,
  });

  beforeAll(async () => {
    await backend.removeRoot().catch(() => {});
  });
  afterAll(async () => {
    await backend.removeRoot().catch(() => {});
  });

  it("two devices converge over real WebDAV (create/edit/conflict/delete)", async () => {
    const A = makeDevice(backend, "A");
    const B = makeDevice(backend, "B");

    // create A → B
    await A.vault.writeBinary("note.md", enc("hello"));
    await A.sync();
    await B.sync();
    expect(dec(await B.vault.readBinary("note.md"))).toBe("hello");

    // edit A → B
    await A.vault.writeBinary("note.md", enc("edited"));
    await A.sync();
    await B.sync();
    expect(dec(await B.vault.readBinary("note.md"))).toBe("edited");

    // rename A → B (validates WebDAV MOVE)
    await A.vault.rename("note.md", "renamed.md");
    const rmv = await A.sync();
    expect(rmv.ops.some((o) => o.kind === "move")).toBe(true);
    await B.sync();
    expect(await B.vault.exists("note.md")).toBe(false);
    expect(dec(await B.vault.readBinary("renamed.md"))).toBe("edited");

    // concurrent edit → keep both (on the renamed file)
    await A.vault.writeBinary("renamed.md", enc("A-version"));
    await B.vault.writeBinary("renamed.md", enc("B-version"));
    await A.sync();
    const r = await B.sync();
    expect(r.ops.some((o) => o.kind === "conflict")).toBe(true);
    expect(dec(await B.vault.readBinary("renamed.md"))).toBe("A-version");
    const copies = (await B.vault.list()).filter((p) => p.startsWith("renamed (conflict"));
    expect(copies).toHaveLength(1);
    expect(dec(await B.vault.readBinary(copies[0]))).toBe("B-version");

    // delete A → B
    await A.vault.remove("renamed.md");
    await A.sync();
    await B.sync();
    expect(await B.vault.exists("renamed.md")).toBe(false);
  }, 60_000);
});
