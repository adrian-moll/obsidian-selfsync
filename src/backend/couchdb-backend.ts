/**
 * CouchDB StorageBackend — the self-hostable alternative to WebDAV (D1). Used as
 * a dumb blob store (not for native replication, see D4): each blob is one JSON
 * document `{ data: <base64> }`, and CouchDB's `_rev` is the etag for optimistic
 * concurrency (conditionalWrites = true). One database per vault.
 *
 * Runs on all platforms via the injected HttpClient (fetch in tests, requestUrl
 * in the app).
 */
import {
  ConditionalWriteError,
  type BackendCapabilities,
  type ReadResult,
  type RemoteEntry,
  type StorageBackend,
} from "./storage-backend.js";
import { arrayBufferToBase64, base64ToArrayBuffer, basicAuth, type HttpClient, utf8 } from "./http.js";

export interface CouchDbOptions {
  baseUrl: string; // e.g. https://couch.example.com:6984
  username: string;
  password: string;
  database: string;
  http: HttpClient;
}

interface CouchDoc {
  _id: string;
  _rev?: string;
  data: string; // base64 blob
}

export class CouchDbBackend implements StorageBackend {
  private readonly authHeader: string;
  private dbEnsured = false;

  constructor(private readonly opts: CouchDbOptions) {
    this.authHeader = basicAuth(opts.username, opts.password);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: this.authHeader, "Cache-Control": "no-cache", ...extra };
  }

  private dbUrl(): string {
    return this.opts.baseUrl.replace(/\/+$/, "") + "/" + encodeURIComponent(this.opts.database);
  }

  private docUrl(key: string): string {
    // encodeURIComponent encodes "/" as %2F; CouchDB 3.x treats that as part of
    // the document id, so nested (mirror-layout) keys round-trip.
    return this.dbUrl() + "/" + encodeURIComponent(key);
  }

  async testConnection(): Promise<void> {
    const res = await this.opts.http({ method: "GET", url: this.opts.baseUrl.replace(/\/+$/, "") + "/", headers: this.headers() });
    if (res.status < 200 || res.status >= 300) throw new Error(`CouchDB connection failed: HTTP ${res.status}`);
    await this.ensureDb();
  }

  async ensureDb(): Promise<void> {
    if (this.dbEnsured) return;
    const res = await this.opts.http({ method: "PUT", url: this.dbUrl(), headers: this.headers() });
    // 201 created, 202 accepted, 412 already exists — all fine.
    if (res.status !== 201 && res.status !== 202 && res.status !== 412) {
      throw new Error(`CouchDB create database failed: HTTP ${res.status}`);
    }
    this.dbEnsured = true;
  }

  /** Current _rev of a doc, or null if it doesn't exist. */
  private async currentRev(key: string): Promise<string | null> {
    const res = await this.opts.http({ method: "GET", url: this.docUrl(key), headers: this.headers() });
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw new Error(`CouchDB GET ${key} failed: HTTP ${res.status}`);
    return (JSON.parse(utf8.decode(res.body)) as CouchDoc)._rev ?? null;
  }

  async list(): Promise<RemoteEntry[]> {
    await this.ensureDb();
    const res = await this.opts.http({ method: "GET", url: this.dbUrl() + "/_all_docs", headers: this.headers() });
    if (res.status < 200 || res.status >= 300) throw new Error(`CouchDB _all_docs failed: HTTP ${res.status}`);
    const body = JSON.parse(utf8.decode(res.body)) as { rows: Array<{ id: string; value: { rev: string } }> };
    return body.rows
      .filter((r) => !r.id.startsWith("_design/"))
      .map((r) => ({ key: r.id, size: 0, etag: r.value.rev }));
  }

  async read(key: string): Promise<ArrayBuffer> {
    const res = await this.readWithMeta(key);
    if (!res) throw new Error(`CouchDB doc not found: ${key}`);
    return res.data;
  }

  async readWithMeta(key: string): Promise<ReadResult | null> {
    const res = await this.opts.http({ method: "GET", url: this.docUrl(key), headers: this.headers() });
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw new Error(`CouchDB GET ${key} failed: HTTP ${res.status}`);
    const doc = JSON.parse(utf8.decode(res.body)) as CouchDoc;
    return { data: base64ToArrayBuffer(doc.data ?? ""), etag: doc._rev };
  }

  async write(key: string, data: ArrayBuffer, prevEtag?: string): Promise<string> {
    await this.ensureDb();
    // Determine the _rev to send: the caller's (conditional) or the current one
    // (unconditional overwrite). CouchDB requires the current _rev to update.
    let rev = prevEtag;
    if (rev === undefined) rev = (await this.currentRev(key)) ?? undefined;

    const doc: CouchDoc = { _id: key, data: arrayBufferToBase64(data) };
    if (rev) doc._rev = rev;

    const res = await this.opts.http({
      method: "PUT",
      url: this.docUrl(key),
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(doc),
    });
    if (res.status === 409) throw new ConditionalWriteError(key);
    if (res.status < 200 || res.status >= 300) throw new Error(`CouchDB PUT ${key} failed: HTTP ${res.status}`);
    return (JSON.parse(utf8.decode(res.body)) as { rev: string }).rev;
  }

  async remove(key: string, prevEtag?: string): Promise<void> {
    const rev = prevEtag ?? (await this.currentRev(key));
    if (!rev) return; // already gone
    const res = await this.opts.http({
      method: "DELETE",
      url: this.docUrl(key) + "?rev=" + encodeURIComponent(rev),
      headers: this.headers(),
    });
    if (res.status === 409) throw new ConditionalWriteError(key);
    if (res.status !== 404 && (res.status < 200 || res.status >= 300)) {
      throw new Error(`CouchDB DELETE ${key} failed: HTTP ${res.status}`);
    }
  }

  async move(from: string, to: string): Promise<void> {
    const src = await this.readWithMeta(from);
    if (!src) return;
    await this.write(to, src.data);
    await this.remove(from);
  }

  capabilities(): BackendCapabilities {
    return { conditionalWrites: true };
  }
}
