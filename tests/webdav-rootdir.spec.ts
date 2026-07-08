/**
 * WebDavBackend with a NESTED rootDir (e.g. "Obsidian/ThisIsMyWay"). Regression
 * for the kDrive "MKCOL … failed: HTTP 404" bug: the root's ancestors must each be
 * created (MKCOL can't make a collection whose parent is missing), and rootDir must
 * be encoded per-segment so "/" stays a path separator (not %2F).
 */
import { describe, expect, it } from "vitest";
import { WebDavBackend } from "../src/backend/webdav-backend.js";
import type { HttpClient, HttpResponse } from "../src/backend/http.js";

function recordingHttp() {
  const calls: { method: string; url: string }[] = [];
  const http: HttpClient = async (req) => {
    calls.push({ method: req.method, url: req.url });
    const ok = (status: number): HttpResponse => ({ status, headers: {}, body: new ArrayBuffer(0) });
    if (req.method === "MKCOL") return ok(201);
    if (req.method === "PUT") return ok(201);
    if (req.method === "PROPFIND") return { status: 207, headers: {}, body: new TextEncoder().encode("<multistatus/>").buffer as ArrayBuffer };
    return ok(200);
  };
  return { calls, http };
}

describe("WebDavBackend nested rootDir", () => {
  it("creates each ancestor of a nested rootDir and never emits %2F", async () => {
    const { calls, http } = recordingHttp();
    const backend = new WebDavBackend({
      baseUrl: "https://host.example/dav/",
      username: "u",
      password: "p",
      rootDir: "Obsidian/ThisIsMyWay",
      http,
    });

    await backend.write("manifest.json", new ArrayBuffer(0));

    const mkcols = calls.filter((c) => c.method === "MKCOL").map((c) => c.url);
    expect(mkcols).toEqual([
      "https://host.example/dav/Obsidian/", // parent first
      "https://host.example/dav/Obsidian/ThisIsMyWay/", // then the nested root
    ]);

    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("https://host.example/dav/Obsidian/ThisIsMyWay/manifest.json");

    // No request URL should contain an encoded slash (%2F) from mangling rootDir.
    expect(calls.every((c) => !c.url.includes("%2F"))).toBe(true);
  });

  it("still works for a simple single-segment rootDir", async () => {
    const { calls, http } = recordingHttp();
    const backend = new WebDavBackend({
      baseUrl: "https://host.example/dav/",
      username: "u",
      password: "p",
      rootDir: "selfsync",
      http,
    });

    await backend.write("a/b.md", new ArrayBuffer(0));

    const mkcols = calls.filter((c) => c.method === "MKCOL").map((c) => c.url);
    expect(mkcols).toEqual([
      "https://host.example/dav/selfsync/", // root
      "https://host.example/dav/selfsync/a/", // parent of the key
    ]);
  });
});
