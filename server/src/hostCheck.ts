// Refuses a request whose Host header is not one the server expects, against DNS rebinding. A page
// on another site can point its own name at this server's address after it loaded, and the browser then treats the dashboard as
// that page's origin, so it could read the open routes. The name it used is in Host, so a name that is not ours gives it away. An
// IP address cannot be rebound, so an address typed in the bar is safe where a name is not.
import { isIP } from 'node:net';
import type { RequestHandler } from 'express';
import type { Logger } from './logger.js';

export interface HostCheckOptions {
  /** `HOST`, where the server listens: itself a Host it answers to, and when it is a wildcard (0.0.0.0, :: or empty), every IP. */
  bind?: string;
  /** Names or addresses the owner allows (`SITREP_ALLOWED_HOSTS`), with or without a port. The port is never compared. */
  allowed?: string[];
  logger?: Logger;
}

/** `:` and up to five digits: the port part of a Host value, which is dropped and never compared. */
const PORT_PART = /^:\d{0,5}$/;
/** What a host name may be made of once lower-cased. */
const NAME_PART = /^[a-z0-9._-]+$/;
/** Bind addresses that listen on every interface. */
const WILDCARD_BINDS: ReadonlySet<string> = new Set(['', '0.0.0.0', '::']);

/** The address inside `[…]` or `[…]:port`, when it is an IPv6 address; null for anything else. */
function bracketedIpv6(value: string): string | null {
  const close = value.indexOf(']');
  if (close === -1) return null;
  const after = value.slice(close + 1);
  if (after !== '' && !PORT_PART.test(after)) return null;
  const inner = value.slice(1, close);
  return isIP(inner) === 6 ? inner : null;
}

/** The hostname in a Host header or setting, lower-cased, without port, brackets or a trailing dot; null when malformed. */
export function hostnameOf(value = ''): string | null {
  const raw = value.trim().toLowerCase();
  if (raw === '') return null;
  // A setting may name a bare IPv6 address; a Host header always puts one in brackets.
  if (isIP(raw) === 6) return raw;
  if (raw.startsWith('[')) return bracketedIpv6(raw);
  let name = raw;
  const firstColon = raw.indexOf(':');
  if (firstColon !== -1) {
    // A name takes one colon at most, and only in front of a port.
    if (firstColon !== raw.lastIndexOf(':') || !PORT_PART.test(raw.slice(firstColon))) return null;
    name = raw.slice(0, firstColon);
  }
  if (name.endsWith('.')) name = name.slice(0, -1);
  return NAME_PART.test(name) ? name : null;
}

/** `localhost`, `::1`, or any address in 127.0.0.0/8. */
export function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.startsWith('127.');
}

/** `SITREP_ALLOWED_HOSTS`: names or addresses separated by commas. */
export function parseAllowedHosts(setting = ''): string[] {
  return setting.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/** A refused Host value is logged at most once a minute, and at most this many distinct values are remembered for that. */
const REFUSAL_LOG_GAP_MS = 60_000;
const REFUSAL_LOG_VALUES = 100;

export function hostCheck({ bind = '', allowed = [], logger }: HostCheckOptions = {}): RequestHandler {
  const anyAddress = WILDCARD_BINDS.has(bind.trim());
  const names = new Set(allowed.map((entry) => hostnameOf(entry)).filter((name): name is string => name !== null));
  // The bind address is a name the server answers to, unless it is a wildcard.
  const bindName = hostnameOf(bind);
  if (bindName !== null && !WILDCARD_BINDS.has(bindName)) names.add(bindName);
  const lastWarned = new Map<string, number>();

  const accepted = (host: string | null): boolean =>
    host !== null && (isLoopback(host) || names.has(host) || (anyAddress && isIP(host) !== 0));

  /** Logs the refused value, made printable and cut to 100 characters, and nothing else about the request. */
  const warnRefused = (rawHost: string | undefined): void => {
    if (!logger) return;
    const printable = (rawHost ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 100);
    const t = Date.now();
    const previous = lastWarned.get(printable);
    if (previous !== undefined && t - previous < REFUSAL_LOG_GAP_MS) return;
    if (lastWarned.size >= REFUSAL_LOG_VALUES) lastWarned.clear();
    lastWarned.set(printable, t);
    logger.warn(`sitrep: refused a request whose Host is "${printable}"; allow it with SITREP_ALLOWED_HOSTS if it is yours`);
  };

  return (req, res, next) => {
    if (accepted(hostnameOf(req.headers.host))) return next();
    warnRefused(req.headers.host);
    // The reason is fixed: the name sent is logged, never echoed back.
    res.status(403).json({ error: 'not a host name this server answers to' });
  };
}
