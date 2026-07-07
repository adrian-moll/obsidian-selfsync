import { describe, expect, it } from "vitest";
import { Logger, createRotatingSink, type LogFileIO } from "../src/util/logger.js";

describe("Logger", () => {
  it("routes messages at or below the threshold to the panel sink", () => {
    const seen: Array<[string, string]> = [];
    const log = new Logger({ level: "info", onEntry: (lvl, msg) => seen.push([lvl, msg]) });
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d"); // dropped at info
    expect(seen).toEqual([
      ["error", "e"],
      ["warn", "w"],
      ["info", "i"],
    ]);
  });

  it("emits debug once the threshold is raised", () => {
    const seen: string[] = [];
    const log = new Logger({ level: "info", onEntry: (_l, m) => seen.push(m) });
    log.debug("hidden");
    log.setLevel("debug");
    log.debug("shown");
    expect(seen).toEqual(["shown"]);
  });

  it("writes preformatted, timestamped lines to the file sink", () => {
    const lines: string[] = [];
    const fixed = Date.UTC(2026, 0, 2, 3, 4, 5);
    const log = new Logger({ level: "debug", now: () => fixed, fileSink: (l) => void lines.push(l) });
    log.info("hello");
    expect(lines).toEqual(["2026-01-02T03:04:05.000Z [INFO] hello"]);
  });

  it("respects the threshold for the file sink too", () => {
    const lines: string[] = [];
    const log = new Logger({ level: "info", fileSink: (l) => void lines.push(l) });
    log.debug("nope");
    expect(lines).toEqual([]);
  });

  it("setFileSink can attach and detach the file sink", () => {
    const lines: string[] = [];
    const log = new Logger({ level: "info" });
    log.info("before"); // no sink yet
    log.setFileSink((l) => void lines.push(l));
    log.info("during");
    log.setFileSink(null);
    log.info("after");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("during");
  });
});

describe("createRotatingSink", () => {
  function fakeIO() {
    const state = { current: "", backup: null as string | null, rotations: 0 };
    const io: LogFileIO = {
      size: async () => Buffer.byteLength(state.current, "utf8"),
      append: async (line) => {
        state.current += line;
      },
      rotate: async () => {
        state.backup = state.current;
        state.current = "";
        state.rotations++;
      },
    };
    return { io, state };
  }

  it("appends lines with a trailing newline", async () => {
    const { io, state } = fakeIO();
    const sink = createRotatingSink(io, 1024);
    await sink("one");
    await sink("two");
    expect(state.current).toBe("one\ntwo\n");
    expect(state.rotations).toBe(0);
  });

  it("rotates once the log passes the size cap, keeping one generation", async () => {
    const { io, state } = fakeIO();
    const sink = createRotatingSink(io, 5); // rotate when the EXISTING log exceeds 5 bytes
    await sink("aaaaaaaa"); // size 0 before append → no rotate; current becomes 9 bytes
    expect(state.rotations).toBe(0);
    await sink("bbbbbbbb"); // size 9 > 5 before append → rotate, then append
    expect(state.rotations).toBe(1);
    expect(state.backup).toBe("aaaaaaaa\n");
    expect(state.current).toBe("bbbbbbbb\n");
  });

  it("serializes concurrent writes without interleaving", async () => {
    const { io, state } = fakeIO();
    const sink = createRotatingSink(io, 1_000_000);
    await Promise.all([sink("a"), sink("b"), sink("c")]);
    expect(state.current.split("\n").filter(Boolean).sort()).toEqual(["a", "b", "c"]);
  });

  it("never throws when the underlying IO fails", async () => {
    const io: LogFileIO = {
      size: async () => {
        throw new Error("stat fail");
      },
      append: async () => {
        throw new Error("append fail");
      },
      rotate: async () => {
        throw new Error("rotate fail");
      },
    };
    const sink = createRotatingSink(io, 10);
    await expect(sink("x")).resolves.toBeUndefined();
  });
});
