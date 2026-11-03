import { afterEach, describe, expect, it, vi } from "vitest";
import { requestTimeoutMs, withTimeout, type HttpClient, type HttpResponse } from "../src/backend/http.js";
import { isTransientNetworkError } from "../src/util/errors.js";

const ok: HttpResponse = { status: 200, headers: {}, body: new ArrayBuffer(0) };

describe("requestTimeoutMs", () => {
  it("gives small requests the base budget and scales with the payload", () => {
    const base = requestTimeoutMs({ method: "PROPFIND", url: "u", body: "<xml/>" });
    expect(base).toBeGreaterThanOrEqual(60_000);
    expect(base).toBeLessThan(61_000);

    const upload8 = requestTimeoutMs({ method: "PUT", url: "u", body: new ArrayBuffer(8 * 1024 * 1024) });
    const range8 = requestTimeoutMs({
      method: "GET",
      url: "u",
      headers: { Range: `bytes=0-${8 * 1024 * 1024 - 1}` },
    });
    expect(upload8).toBe(range8); // same bytes → same budget either direction
    expect(upload8).toBe(60_000 + 256_000); // 8 MiB at 32 KiB/s
  });

  it("allows a GET of unknown size a generous fixed budget", () => {
    expect(requestTimeoutMs({ method: "GET", url: "u" })).toBe(5 * 60_000);
  });
});

describe("withTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("passes a response through", async () => {
    const http = withTimeout(async () => ok);
    await expect(http({ method: "GET", url: "u" })).resolves.toBe(ok);
  });

  it("rejects a stalled request with an error classified as transient", async () => {
    vi.useFakeTimers();
    const hang: HttpClient = () => new Promise(() => {});
    const p = withTimeout(hang, () => 1000)({ method: "PUT", url: "u" });
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    const err = await p.catch((e: Error) => e);
    expect(isTransientNetworkError((err as Error).message)).toBe(true);
  });
});
