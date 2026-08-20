import type { Logger, LogLevel } from "../core/ports.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface JsonLoggerOptions {
  level?: LogLevel;
  /** Defaults to stderr so stdout stays clean for CLI JSON output. */
  write?: (line: string) => void;
}

/** Line-delimited JSON logger. Fields carry ids, never secrets (spec §48). */
export class JsonLogger implements Logger {
  private readonly threshold: number;
  private readonly write: (line: string) => void;

  constructor(
    private readonly base: Record<string, unknown> = {},
    private readonly opts: JsonLoggerOptions = {},
  ) {
    this.threshold = LEVELS[opts.level ?? (process.env["HERDR_A2A_LOG_LEVEL"] as LogLevel) ?? "info"] ?? LEVELS.info;
    this.write = opts.write ?? ((line) => process.stderr.write(`${line}\n`));
  }

  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < this.threshold) return;
    this.write(
      JSON.stringify({ ts: new Date().toISOString(), level, message, ...this.base, ...fields }),
    );
  }

  child(fields: Record<string, unknown>): Logger {
    return new JsonLogger({ ...this.base, ...fields }, this.opts);
  }
}

export const silentLogger: Logger = {
  log: () => {},
  child: () => silentLogger,
};
