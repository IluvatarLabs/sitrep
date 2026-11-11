// The server's log: plain lines on the console, debug and info on stdout, warn and error on stderr, shipped nowhere. The admin
// secret is cut out of every line before it is written, and callers never pass report bodies, anything the owner typed, or tokens.

/** How serious each level is: a line is written when its level ranks at or above the logger's. */
const RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const;
export type Level = keyof typeof RANK;

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** The level `SITREP_LOG_LEVEL` names, in any case; null when it names none, and the server then logs at `info`. */
export function parseLevel(v: string | undefined): Level | null {
  const name = v?.trim().toLowerCase() ?? '';
  return Object.hasOwn(RANK, name) ? (name as Level) : null;
}

/** Where lines go unless told otherwise: warnings and errors to stderr, the rest to stdout. */
function toConsole(line: string, level: Level): void {
  (RANK[level] >= RANK.warn ? process.stderr : process.stdout).write(`${line}\n`);
}

/**
 * A logger writing lines of `level` (`info` unless given) and above to `sink` (the console unless given), each of `secrets`
 * replaced by `[redacted]`. A sink that throws loses that one line, never the request or timer that logged it.
 */
export function createLogger({ level = 'info', secrets = [], sink = toConsole }: { level?: Level; secrets?: readonly string[]; sink?: (line: string, level: Level) => void } = {}): Logger {
  const hidden = secrets.filter((secret) => secret !== '');
  const scrub = (message: string): string => hidden.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), message);
  const lineAt = (at: Level) => (message: string): void => {
    if (RANK[at] < RANK[level]) return;
    try {
      sink(scrub(message), at);
    } catch {
      // Dropped: logging must not fail its caller.
    }
  };
  return { debug: lineAt('debug'), info: lineAt('info'), warn: lineAt('warn'), error: lineAt('error') };
}

/** A logger that writes nothing: the fleet's default, which keeps tests quiet. */
export const silentLogger: Logger = createLogger({ sink: () => {} });
