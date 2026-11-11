// Signing in sends the admin secret and gets a session cookie back. Over plain HTTP to a name beyond loopback both cross the
// network unencrypted. The server says so in its log and never blocks: once at start, while there is a secret and the bind
// address reaches other machines, and at most once a minute when a sign-in arrives that way.
import type { RequestHandler } from 'express';
import { hostnameOf, isLoopback } from './hostCheck.js';
import type { Logger } from './logger.js';

/** At most one sign-in note a minute, naming at most this many characters of the host. */
const SIGN_IN_NOTE_GAP_MS = 60_000;
const HOST_CHARS_LOGGED = 100;

/** Whether a Host value or bind address names this machine only: a loopback name or address. Empty and wildcards do not. */
function loopbackOnly(value: string | undefined): boolean {
  const name = hostnameOf(value);
  return name !== null && isLoopback(name);
}

export interface PlainHttpWatch {
  /** Once, as the server starts. */
  atStart(): void;
  /** Ahead of a sign-in: notes one made over plain HTTP to a name that is not loopback, and always lets it through. */
  onSignIn: RequestHandler;
}

/** `signInOn`: whether there is an admin secret, which is what lets anyone sign in. */
export function createPlainHttpWatch({ bind, signInOn, logger, now = Date.now }: { bind: string; signInOn: boolean; logger: Logger; now?: () => number }): PlainHttpWatch {
  let notedAt = -Infinity;
  return {
    atStart: () => {
      if (!signInOn || loopbackOnly(bind)) return;
      logger.warn(
        'sitrep: an admin secret is set and the server is reachable beyond this machine; signing in sends the secret and its cookie over plain HTTP, unencrypted, unless you reach it through an SSH tunnel',
      );
    },
    onSignIn: (req, _res, next) => {
      const t = now();
      if (req.protocol !== 'https' && !loopbackOnly(req.headers.host) && t - notedAt >= SIGN_IN_NOTE_GAP_MS) {
        notedAt = t;
        const shown = (hostnameOf(req.headers.host) ?? req.headers.host ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, HOST_CHARS_LOGGED);
        logger.warn(`sitrep: a sign-in reached ${shown} over plain HTTP; the secret and cookie are not encrypted in transit`);
      }
      next();
    },
  };
}
