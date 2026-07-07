/**
 * WebDAV StorageBackend (primary target: Infomaniak kDrive).
 *
 * Blobs are stored as flat files under a configured `rootDir`; keys are file
 * names (no nested folders), so only the root collection needs creating. The
 * behaviors below were confirmed against real kDrive in spike S2
 * (docs/06-backends.md):
 *   - ETags come from PROPFIND <getetag>, XML-entity-encoded → must be decoded.
 *   - PUT does not return an ETag header → a follow-up PROPFIND fetches it.
 *   - If-Match / If-None-Match conditional writes are honored (412 on mismatch).
 */
import {
  ConditionalWriteError,
  type BackendCapabilities,
  type ReadResult,
  type RemoteEntry,
  type StorageBackend,
} from "./storage-backend.js";
import { basicAuth, type HttpClient, utf8 } from "./http.js";

export interface WebDavOptions {
  baseUrl: string;
  username: string;
  password: string;
  /** Folder under baseUrl that holds all blobs, e.g. "selfsync". */
  rootDir: string;
  http: HttpClient;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>';

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function tag(name: string): RegExp {
  // Matches <x:name ...>value</x:name> for any/no namespace prefix.
  return new RegExp(`<(?:[a-z0-9]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${name}>`, "i");
}

function parseEtag(xml: string): string | null {
  const m = xml.match(tag("getetag"));
  return m ? decodeEntities(m[1].trim()) : null;
}

interface ParsedResponse {
  href: string;
  etag: string | null;
  size: number;
  isCollection: boolean;
}

function parseMultistatus(xml: string): ParsedResponse[] {
  const blocks = xml.match(/<(?:[a-z0-9]+:)?response[\s\S]*?<\/(?:[a-z0-9]+:)?response>/gi) ?? [];
  return blocks.map((block) => {
    const hrefMatch = block.match(tag("href"));
    const sizeMatch = block.match(tag("getcontentlength"));
    return {
      href: hrefMatch ? decodeEntities(hrefMatch[1].trim()) : "",
      etag: parseEtag(block),
      size: sizeMatch ? Number(sizeMatch[1].trim()) || 0 : 0,
      isCollection: /<(?:[a-z0-9]+:)?collection\b/i.test(block),
    };
  });
}

export class WebDavBackend implements StorageBackend {
  private readonly authHeader: string;
  private rootEnsured = false;
  private readonly ensuredDirs = new Set<string>();

  constructor(private readonly opts: WebDavOptions) {
    this.authHeader = basicAuth(opts.username, opts.password);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // no-cache prevents Electron's HTTP cache from issuing conditional GETs
    // (If-None-Match/If-Modified-Since), which kDrive can answer with 412/304.
    return { Authorization: this.authHeader, "Cache-Control": "no-cache", ...extra };
  }

  /** Encode each path segment but keep "/" separators (supports nested keys). */
  private encodePath(path: string): string {
    return path
      .split("/")
      .filter((s) => s.length > 0)
      .map(encodeURIComponent)
      .join("/");
  }

  private rootUrl(): string {
    return this.opts.baseUrl.replace(/\/+$/, "") + "/" + encodeURIComponent(this.opts.rootDir) + "/";
  }

  private urlFor(key: string): string {
    return this.rootUrl() + this.encodePath(key);
  }

  async testConnection(): Promise<void> {
    const res = await this.opts.http({
      method: "PROPFIND",
      url: this.opts.baseUrl,
      headers: this.headers({ Depth: "0", "Content-Type": "application/xml" }),
      body: PROPFIND_BODY,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`WebDAV connection failed: HTTP ${res.status}`);
    }
  }

  async ensureRoot(): Promise<void> {
    if (this.rootEnsured) return;
    const res = await this.opts.http({ method: "MKCOL", url: this.rootUrl(), headers: this.headers() });
    // 201 = created, 405 = already exists. Both are fine.
    if (res.status !== 201 && res.status !== 405) {
      throw new Error(`WebDAV MKCOL ${this.opts.rootDir} failed: HTTP ${res.status}`);
    }
    this.rootEnsured = true;
  }

  /** MKCOL a single directory (relative to root), idempotently and cached. */
  private async mkcol(relDir: string): Promise<void> {
    if (this.ensuredDirs.has(relDir)) return;
    const url = this.rootUrl() + this.encodePath(relDir) + "/";
    const res = await this.opts.http({ method: "MKCOL", url, headers: this.headers() });
    if (res.status !== 201 && res.status !== 405) {
      throw new Error(`WebDAV MKCOL ${relDir} failed: HTTP ${res.status}`);
    }
    this.ensuredDirs.add(relDir);
  }

  /** Ensure the root and every ancestor directory of `key` exists. */
  private async ensureParents(key: string): Promise<void> {
    await this.ensureRoot();
    const parts = key.split("/").filter((s) => s.length > 0);
    parts.pop(); // drop the file name
    let dir = "";
    for (const part of parts) {
      dir = dir ? `${dir}/${part}` : part;
      await this.mkcol(dir);
    }
  }

  async list(): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = [];
    const walk = async (relDir: string): Promise<void> => {
      const url = this.rootUrl() + (relDir ? this.encodePath(relDir) + "/" : "");
      const res = await this.opts.http({
        method: "PROPFIND",
        url,
        headers: this.headers({ Depth: "1", "Content-Type": "application/xml" }),
        body: PROPFIND_BODY,
      });
      if (res.status === 404) return;
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`WebDAV PROPFIND list failed: HTTP ${res.status}`);
      }
      const reqPath = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, "");
      for (const r of parseMultistatus(utf8.decode(res.body))) {
        if (!r.href) continue;
        const hrefPath = decodeURIComponent(new URL(r.href, this.opts.baseUrl).pathname).replace(/\/+$/, "");
        if (hrefPath === reqPath) continue; // the directory being listed
        const name = hrefPath.slice(hrefPath.lastIndexOf("/") + 1);
        const rel = relDir ? `${relDir}/${name}` : name;
        if (r.isCollection) {
          await walk(rel);
        } else {
          out.push({ key: rel, size: r.size, etag: r.etag ?? undefined });
        }
      }
    };
    await walk("");
    return out;
  }

  async read(key: string): Promise<ArrayBuffer> {
    const res = await this.opts.http({ method: "GET", url: this.urlFor(key), headers: this.headers() });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`WebDAV GET ${key} failed: HTTP ${res.status}`);
    }
    return res.body;
  }

  async readWithMeta(key: string): Promise<ReadResult | null> {
    const res = await this.opts.http({ method: "GET", url: this.urlFor(key), headers: this.headers() });
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`WebDAV GET ${key} failed: HTTP ${res.status}`);
    }
    // Always source the etag from PROPFIND <getetag> — the strong value that
    // If-Match compares against (validated in spike S2). A GET response's ETag
    // header is unreliable across servers/clients (e.g. kDrive via Obsidian's
    // requestUrl returns a different value), which caused 412s on manifest commit.
    const etag = (await this.fetchEtag(key)) ?? undefined;
    return { data: res.body, etag };
  }

  async write(key: string, data: ArrayBuffer, prevEtag?: string): Promise<string> {
    await this.ensureParents(key);
    const extra: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (prevEtag !== undefined) extra["If-Match"] = prevEtag;
    const res = await this.opts.http({ method: "PUT", url: this.urlFor(key), headers: this.headers(extra), body: data });
    if (res.status === 412) throw new ConditionalWriteError(key);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`WebDAV PUT ${key} failed: HTTP ${res.status}`);
    }
    // kDrive does not return an ETag on PUT — fetch it explicitly.
    return (await this.fetchEtag(key)) ?? res.headers["etag"] ?? "";
  }

  async remove(key: string, prevEtag?: string): Promise<void> {
    const extra: Record<string, string> = {};
    if (prevEtag !== undefined) extra["If-Match"] = prevEtag;
    const res = await this.opts.http({ method: "DELETE", url: this.urlFor(key), headers: this.headers(extra) });
    if (res.status === 412) throw new ConditionalWriteError(key);
    // 404 = already gone → idempotent success.
    if (res.status !== 404 && (res.status < 200 || res.status >= 300)) {
      throw new Error(`WebDAV DELETE ${key} failed: HTTP ${res.status}`);
    }
  }

  async move(from: string, to: string): Promise<void> {
    await this.ensureParents(to);
    const res = await this.opts.http({
      method: "MOVE",
      url: this.urlFor(from),
      headers: this.headers({ Destination: this.urlFor(to), Overwrite: "T" }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`WebDAV MOVE ${from} -> ${to} failed: HTTP ${res.status}`);
    }
  }

  capabilities(): BackendCapabilities {
    return { conditionalWrites: true };
  }

  /** PROPFIND a single key to read its current (decoded) ETag. */
  async fetchEtag(key: string): Promise<string | null> {
    const res = await this.opts.http({
      method: "PROPFIND",
      url: this.urlFor(key),
      headers: this.headers({ Depth: "0", "Content-Type": "application/xml" }),
      body: PROPFIND_BODY,
    });
    if (res.status < 200 || res.status >= 300) return null;
    return parseEtag(utf8.decode(res.body));
  }

  /** Delete the entire root collection. Intended for tests / reset. */
  async removeRoot(): Promise<void> {
    const res = await this.opts.http({ method: "DELETE", url: this.rootUrl(), headers: this.headers() });
    this.rootEnsured = false;
    if (res.status !== 404 && (res.status < 200 || res.status >= 300)) {
      throw new Error(`WebDAV DELETE root failed: HTTP ${res.status}`);
    }
  }
}
