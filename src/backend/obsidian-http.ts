/**
 * HttpClient backed by Obsidian's requestUrl, which bypasses CORS and works on
 * both desktop and mobile. Used to wire network backends inside the plugin
 * (never imported by unit tests).
 */
import { requestUrl } from "obsidian";
import type { HttpClient } from "./http.js";

export const obsidianHttp: HttpClient = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  const headers: Record<string, string> = {};
  const raw = res.headers ?? {};
  for (const key of Object.keys(raw)) headers[key.toLowerCase()] = raw[key];
  return { status: res.status, headers, body: res.arrayBuffer };
};
