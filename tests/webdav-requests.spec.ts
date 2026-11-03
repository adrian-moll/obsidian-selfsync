/** Request-level behaviour of WebDavBackend, against a scripted fake server. */
import { describe, expect, it } from "vitest";
import { WebDavBackend } from "../src/backend/webdav-backend.js";
import type { HttpRequest, HttpResponse } from "../src/backend/http.js";

const res = (status: number, body = ""): HttpResponse => ({
  status,
  headers: {},
  body: new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const etagXml = (e: string) => `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href><d:propstat><d:prop><d:getetag>${e}</d:getetag></d:prop></d:propstat></d:response></d:multistatus>`;

function backendWith(handler: (req: HttpRequest) => HttpResponse) {
  const log: string[] = [];
  const backend = new WebDavBackend({
    baseUrl: "https://dav.example/remote",
    username: "u",
    password: "p",
    rootDir: "selfsync",
    http: async (req) => {
      log.push(`${req.method} ${req.url.replace("https://dav.example/remote/selfsync/", "")}`);
      return handler(req);
    },
  });
  return { backend, log };
}

describe("WebDavBackend requests", () => {
  it("reads the etag BEFORE the data", async () => {
    const { backend, log } = backendWith((r) => (r.method === "PROPFIND" ? res(207, etagXml('"e1"')) : res(200, "{}")));
    const out = await backend.readWithMeta("manifest.json");
    expect(log).toEqual(["PROPFIND manifest.json", "GET manifest.json"]);
    expect(out?.etag).toBe('"e1"');
  });

  it("skips the etag round-trip for content blobs, and caches folders across writes", async () => {
    const { backend, log } = backendWith((r) => (r.method === "MKCOL" ? res(201) : r.method === "PUT" ? res(201) : res(207, etagXml('"e"'))));
    await backend.write("dir/a.md", new ArrayBuffer(1), undefined, { returnEtag: false });
    await backend.write("dir/b.md", new ArrayBuffer(1), undefined, { returnEtag: false });
    expect(log.filter((l) => l.startsWith("PROPFIND"))).toEqual([]);
    expect(log.filter((l) => l.startsWith("MKCOL")).length).toBe(2); // root + dir, once
    expect(log.filter((l) => l.startsWith("PUT")).length).toBe(2);
  });

  it("re-creates a folder another device removed (409 → MKCOL again → retry)", async () => {
    let failOnce = true;
    const { backend, log } = backendWith((r) => {
      if (r.method === "PUT" && r.url.endsWith("b.md") && failOnce) {
        failOnce = false;
        return res(409);
      }
      return r.method === "PROPFIND" ? res(207, etagXml('"e"')) : res(201);
    });
    await backend.write("dir/a.md", new ArrayBuffer(1), undefined, { returnEtag: false });
    await backend.write("dir/b.md", new ArrayBuffer(1), undefined, { returnEtag: false });
    expect(log.slice(-4)).toEqual(["PUT dir/b.md", "MKCOL ", "MKCOL dir/", "PUT dir/b.md"]);
    expect(log.filter((l) => l === "PUT dir/b.md").length).toBe(2);
    expect(log.filter((l) => l.startsWith("MKCOL")).length).toBe(4); // root+dir twice
  });
});
