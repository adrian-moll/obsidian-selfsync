/**
 * Minimal HTTP client abstraction used by network backends. Two implementations
 * exist: `fetchHttp` (Node/tests, global fetch) and an Obsidian-backed one
 * (src/backend/obsidian-http.ts, uses requestUrl to avoid CORS on mobile/desktop).
 * The backend never calls fetch/requestUrl directly, so it is testable in Node.
 */

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
}

export interface HttpResponse {
  status: number;
  /** Response headers with lowercased keys. */
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

/** UTF-8-safe base64, for HTTP Basic auth in both Node and browser. */
export function toBase64(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf-8").toString("base64");
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function basicAuth(username: string, password: string): string {
  return "Basic " + toBase64(`${username}:${password}`);
}

/** fetch-based HttpClient for Node and tests. */
export const fetchHttp: HttpClient = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: "manual",
  });
  const body = await res.arrayBuffer();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: res.status, headers, body };
};

/** Fixed part of every request's time budget (connect, server think time). */
const TIMEOUT_BASE_MS = 60_000;
/** Assumed worst-case throughput (a weak mobile link) for sizing the budget. */
const TIMEOUT_MIN_BYTES_PER_SEC = 32 * 1024;
/** Budget for a GET of unknown size (the manifest, a whole small blob). */
const TIMEOUT_UNKNOWN_GET_MS = 5 * 60_000;

/** The time budget for one request: a fixed base plus time for its payload. */
export function requestTimeoutMs(req: HttpRequest): number {
  let bytes = 0;
  if (req.body !== undefined) {
    bytes = typeof req.body === "string" ? req.body.length : req.body.byteLength;
  } else if (req.method === "GET") {
    const range = /bytes=(\d+)-(\d+)/.exec(req.headers?.Range ?? "");
    if (!range) return TIMEOUT_UNKNOWN_GET_MS;
    bytes = Number(range[2]) - Number(range[1]) + 1;
  }
  return TIMEOUT_BASE_MS + Math.ceil((bytes / TIMEOUT_MIN_BYTES_PER_SEC) * 1000);
}

/**
 * Bound every request in time. Obsidian's requestUrl has no timeout, so a
 * connection that stalls (typical when a phone switches networks) would hang
 * the sync forever — and because syncs are single-flight, block every later
 * sync until Obsidian restarts. requestUrl can't be aborted; we just stop
 * waiting. The message is classified as transient (isTransientNetworkError),
 * so the plugin backs off and retries quietly. A request that completes after
 * we gave up is harmless: a blob is an orphan, a late manifest commit is
 * adopted by the next sync.
 */
export function withTimeout(
  http: HttpClient,
  budgetMs: (req: HttpRequest) => number = requestTimeoutMs,
): HttpClient {
  return (req) => {
    const ms = budgetMs(req);
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      handle = setTimeout(
        () => reject(new Error(`${req.method} request timed out after ${Math.round(ms / 1000)} s`)),
        ms,
      );
    });
    return Promise.race([http(req), timeout]).finally(() => clearTimeout(handle));
  };
}

/** Base64 (de)serialization of binary blobs — for backends that store JSON docs. */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(b64, "base64");
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export const utf8 = {
  encode: (s: string): ArrayBuffer => {
    const view = new TextEncoder().encode(s);
    const buf = new ArrayBuffer(view.byteLength);
    new Uint8Array(buf).set(view);
    return buf;
  },
  decode: (b: ArrayBuffer): string => new TextDecoder().decode(b),
};
