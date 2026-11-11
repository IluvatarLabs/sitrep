// One owner, one secret: every reporter sends the admin secret, and the owner signs in with it as
// Admin. Browsers read without signing in on the LAN unless the owner turns on `requireSignInToView`.
import { createHash, timingSafeEqual } from 'node:crypto';

/** The name the owner signs in under, and the owner of every session a report with the admin secret stores. */
export const ADMIN_OWNER = 'Admin';

/** What a request's secret makes it: the owner's (`admin`), or anyone's while the server has no secret (`open`, no owner). */
export type Identity = { kind: 'admin' } | { kind: 'open' };

/** The hex SHA-256 of a text. A sign-in's random id is stored this way, so the database never holds an id that works. */
export const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Whether `given` is the admin secret, compared in constant time whatever the two lengths: both are hashed first, so the compare
 * always runs over 32 bytes.
 */
export function matchesSecret(secret: string, given: string): boolean {
  const hashed = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
  return timingSafeEqual(hashed(secret), hashed(given));
}

/** Who sent a request, by the secret it carries; or why it was refused, for the log only (never the client, never the secret). */
export function identify(secret: string | null, given: unknown): Identity | { refused: string } {
  if (secret === null) return { kind: 'open' };
  if (typeof given !== 'string' || given === '') return { refused: 'missing token' };
  return matchesSecret(secret, given) ? { kind: 'admin' } : { refused: 'wrong token' };
}

export const ownerOf = (id: Identity): string | null => (id.kind === 'admin' ? ADMIN_OWNER : null);

/** A name made comparable: trimmed, lower-cased, each run of spaces as one. */
export const nameKey = (name: string): string => name.trim().toLowerCase().replace(/ +/g, ' ');

/** A request's source address, an IPv4 one without its `::ffff:` mapping prefix. */
export const sourceAddress = (ip: string | undefined): string => ip?.replace(/^::ffff:/, '') ?? 'unknown';

/** How many source addresses are tracked at most; past it, the one tracked longest is dropped to make room. */
const TRACKED_SOURCES = 1000;

/** What a wrong sign-in did: how many wrong tries in a row this source has now, and whether that locked it out. */
export interface Strike {
  n: number;
  locked: boolean;
}

/** Wrong sign-ins in a row that lock a source address out, and for how long. */
const LOCK_AFTER = 5;
const LOCK_FOR_MS = 15 * 60_000;

/** Wrong sign-ins per source address, in memory only, so a restart forgets them; each lock starts the count over. */
export class Lockout {
  readonly lockMs = LOCK_FOR_MS;
  /** Per address: wrong tries since its last lock, and when its current lock ends (0: not locked). */
  private readonly sources = new Map<string, { tries: number; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The ms left before `source` may try again; 0 when it may now. */
  lockedFor(source: string): number {
    return Math.max(0, (this.sources.get(source)?.until ?? 0) - this.now());
  }

  /** Counts a wrong try from `source`. */
  fail(source: string): Strike {
    const known = this.sources.get(source);
    if (!known && this.sources.size >= TRACKED_SOURCES) this.sources.delete(this.sources.keys().next().value!);
    const n = (known?.tries ?? 0) + 1;
    const locked = n >= LOCK_AFTER;
    this.sources.set(source, locked ? { tries: 0, until: this.now() + this.lockMs } : { tries: n, until: 0 });
    return { n, locked };
  }

  /** A right sign-in wipes the source's record. */
  succeed(source: string): void {
    this.sources.delete(source);
  }
}
