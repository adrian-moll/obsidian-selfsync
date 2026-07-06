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

export const utf8 = {
  encode: (s: string): ArrayBuffer => {
    const view = new TextEncoder().encode(s);
    const buf = new ArrayBuffer(view.byteLength);
    new Uint8Array(buf).set(view);
    return buf;
  },
  decode: (b: ArrayBuffer): string => new TextDecoder().decode(b),
};
