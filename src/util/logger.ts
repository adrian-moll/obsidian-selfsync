/**
 * Leveled logger for SelfSync. Obsidian-free and dependency-injected so it can be
 * unit-tested in Node (like secret-store.ts). It fans each accepted message out to
 * two optional sinks:
 *   - a panel sink (the in-memory SyncStore activity log), and
 *   - a file sink (a rotating on-disk log, wired to Obsidian's DataAdapter in main).
 *
 * The threshold gates BOTH sinks: at "info" (default) debug messages are dropped;
 * turning on debug logging raises the threshold to "debug" and enables the file
 * sink, so verbose diagnostics land in selfsync.log for troubleshooting (the very
 * mobile-debugging case the plugin exists for).
 */
export type LogLevel = "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LoggerOptions {
  level?: LogLevel;
  /** Panel sink — receives every message that passes the threshold. */
  onEntry?: (level: LogLevel, message: string) => void;
  /** File sink — receives a preformatted line; null disables file logging. */
  fileSink?: ((line: string) => void | Promise<void>) | null;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number;
}

export class Logger {
  private level: LogLevel;
  private onEntry?: (level: LogLevel, message: string) => void;
  private fileSink: ((line: string) => void | Promise<void>) | null;
  private readonly now: () => number;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? "info";
    this.onEntry = opts.onEntry;
    this.fileSink = opts.fileSink ?? null;
    this.now = opts.now ?? (() => Date.now());
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setFileSink(sink: ((line: string) => void | Promise<void>) | null): void {
    this.fileSink = sink;
  }

  error(message: string): void {
    this.emit("error", message);
  }
  warn(message: string): void {
    this.emit("warn", message);
  }
  info(message: string): void {
    this.emit("info", message);
  }
  debug(message: string): void {
    this.emit("debug", message);
  }

  private emit(level: LogLevel, message: string): void {
    if (ORDER[level] > ORDER[this.level]) return;
    this.onEntry?.(level, message);
    if (this.fileSink) void this.fileSink(this.formatLine(level, message));
  }

  private formatLine(level: LogLevel, message: string): string {
    const iso = new Date(this.now()).toISOString();
    return `${iso} [${level.toUpperCase()}] ${message}`;
  }
}

/** Low-level file operations a rotating sink needs; injected so it stays testable. */
export interface LogFileIO {
  /** Current log size in bytes (0 if it doesn't exist yet). */
  size(): Promise<number>;
  /** Append a line (the sink adds the trailing newline). */
  append(line: string): Promise<void>;
  /** Rotate the current log aside (e.g. selfsync.log → selfsync.log.1). */
  rotate(): Promise<void>;
}

/**
 * Build a file sink that appends lines and rotates once the log passes `maxBytes`,
 * keeping one previous generation. Writes are serialized through a promise chain so
 * concurrent log calls can't interleave or race the size check. All IO errors are
 * swallowed — logging must never break sync.
 */
export function createRotatingSink(io: LogFileIO, maxBytes: number): (line: string) => Promise<void> {
  let pending: Promise<void> = Promise.resolve();
  return (line: string): Promise<void> => {
    pending = pending.then(async () => {
      try {
        const size = await io.size().catch(() => 0);
        if (size > maxBytes) await io.rotate().catch(() => {});
        await io.append(line + "\n");
      } catch {
        /* never let logging throw */
      }
    });
    return pending;
  };
}
