import { describe, expect, it } from "vitest";
import { relativeTime } from "../src/util/time.js";

describe("relativeTime", () => {
  const now = 1_000_000_000_000; // fixed "now" in ms
  const nowSec = Math.floor(now / 1000);
  const ago = (sec: number) => relativeTime(nowSec - sec, now);

  it("shows 'just now' under a minute", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(59)).toBe("just now");
  });

  it("shows minutes, hours, days", () => {
    expect(ago(60)).toBe("1m ago");
    expect(ago(90 * 60)).toBe("1h ago");
    expect(ago(3 * 86400)).toBe("3d ago");
  });

  it("shows weeks, months, years", () => {
    expect(ago(10 * 86400)).toBe("1w ago");
    expect(ago(60 * 86400)).toBe("2mo ago");
    expect(ago(400 * 86400)).toBe("1y ago");
  });

  it("never shows negative (future timestamps clamp to 'just now')", () => {
    expect(relativeTime(nowSec + 500, now)).toBe("just now");
  });
});
