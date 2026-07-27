/**
 * CLI entry point for the headless SelfSync client (bundled to
 * dist/selfsync-cli.cjs, run by docker/Dockerfile.cli).
 *
 *   daemon     watch + interval sync until stopped (default; the container CMD)
 *   sync-once  run exactly one cycle and exit 0/1 (cron, or an agent forcing a
 *              sync before/after a work session)
 *   doctor     validate the configuration and reach the backend, writing nothing
 *
 * Nothing on this path may import "obsidian" — see the guard in tests.
 */
import process from "node:process";
import { ConfigError, loadConfig } from "./config.js";
import { createStdoutLogger, SyncDaemon } from "./daemon.js";

const USAGE = `selfsync-cli <command>

Commands:
  daemon      Sync continuously (interval + file watching). Default.
  sync-once   Run one sync cycle, then exit (0 = converged, 1 = failed).
  doctor      Check configuration and backend reachability; writes nothing.

Configuration comes from the environment; see docs/user/06-headless.md.`;

async function main(argv: string[]): Promise<number> {
  const command = argv[2] ?? "daemon";
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (!["daemon", "sync-once", "doctor"].includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`);
    return 2;
  }

  const config = loadConfig(process.env);
  const logger = createStdoutLogger(config.settings.debugLogging ? "debug" : "info");
  const daemon = await SyncDaemon.create(config, logger);

  if (command === "doctor") {
    await daemon.doctor();
    return 0;
  }
  if (command === "sync-once") {
    const ok = await daemon.syncOnce();
    return ok ? 0 : 1;
  }

  // daemon: run until a stop signal, then drain and flush.
  await daemon.start();
  await new Promise<void>((resolve) => {
    let stopping = false;
    const onSignal = (sig: string): void => {
      if (stopping) return; // a second Ctrl-C shouldn't interleave two shutdowns
      stopping = true;
      logger.info(`Received ${sig}`);
      void daemon
        .stop()
        .catch((e: unknown) => logger.error(`Shutdown error: ${e instanceof Error ? e.message : String(e)}`))
        .finally(resolve);
    };
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGINT", () => onSignal("SIGINT"));
  });
  return 0;
}

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    // ConfigError is a user-fixable mistake in the compose file — no stack trace.
    if (e instanceof ConfigError) process.stderr.write(`Configuration error: ${e.message}\n`);
    else process.stderr.write(`Fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  });
