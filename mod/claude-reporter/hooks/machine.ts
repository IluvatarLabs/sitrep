// The machine a session runs on. Pure: register.ts reads the host name, the OS and the shared id file through
// `$` and hands the text here. The id is random, never read from the hardware, and lives in one file under the Claude config
// folder that the codex-reporter on the same machine reads too, so both reporters name the machine alike and two machines
// with one host name stay apart. The mod's own store keeps a copy for when the file cannot be used.
import type { MachineInfo } from './protocol.ts';

/** The `$.store` key of the store's copy of the id. */
export const ID_STORE_KEY = 'machineId';
/** The shared file, in `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
const ID_FILE = 'sitrep-machine-id';
/** An id either reporter makes: 8 to 32 lowercase hex characters. */
const ID_SHAPE = /^[0-9a-f]{8,32}$/;
/** An absolute folder on POSIX (`/…`) or Windows (`C:\…`, `C:/…`). */
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/;
const OS_MAX = 80;
const HOST_MAX = 64;

export const isMachineId = (v: unknown): v is string => typeof v === 'string' && ID_SHAPE.test(v);

/** The id the shared file holds as its one line; null for anything else. */
export function idFromFile(text: string | null | undefined): string | null {
  const id = text?.trim();
  return isMachineId(id) ? id : null;
}

/**
 * The shared file under `CLAUDE_CONFIG_DIR`, else under `~/.claude`. Null when neither is an absolute folder (a relative one
 * would land in each session's own working folder): the store alone keeps the id then.
 */
export function idFilePath(configDir: string | undefined, home: string | undefined): string | null {
  const config = trimTrailingSlashes(configDir?.trim() ?? '');
  const homeDir = trimTrailingSlashes(home?.trim() ?? '');
  const dir = config || (homeDir && `${homeDir}/.claude`);
  return ABSOLUTE.test(dir) ? `${dir}/${ID_FILE}` : null;
}

/** A fresh id: the first 12 hex digits of a random UUID, all of them random. */
export const newMachineId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 12);

/** `s` without its trailing slashes, by a scan from the end (`/\/+$/` is quadratic on a long run of them). */
export const trimTrailingSlashes = (s: string): string => {
  let end = s.length;
  while (s[end - 1] === '/') end--;
  return s.slice(0, end);
};

/** The short host name from what `hostname` printed: its first line, control characters out, up to the first dot (`Devs-MBP.local` is `Devs-MBP`). */
export function shortHost(stdout: string | null | undefined): string | null {
  const firstLine = (stdout ?? '').split(/\r?\n/, 1)[0] ?? '';
  const host = firstLine.replaceAll(/\p{Cc}/gu, '').trim().split('.')[0]!.trim();
  return host.slice(0, HOST_MAX) || null;
}

/** The machine as a report carries it; a host with no name goes by its id, an unread OS is null. */
export function machineInfo(host: string | null, id: string, os: string | null): MachineInfo {
  return { name: host ?? `machine-${id.slice(0, 4)}`, id, os };
}

// ---- the OS: the mod API has no call for it, so each platform's own answer is read ---------------------------------------

/** OS text as a report carries it: control characters and whitespace runs as one space, trimmed, at most OS_MAX; null when empty. */
function osText(v: string): string | null {
  const text = v.replaceAll(/\p{Cc}+/gu, ' ').replaceAll(/\s+/g, ' ').trim().slice(0, OS_MAX).trim();
  return text || null;
}

/** macOS `sw_vers`: `ProductName ProductVersion`, such as `macOS 27.0.1`; null without a product name. */
export function macOs(stdout: string | null | undefined): string | null {
  const field = (key: string) => new RegExp(`^${key}:(.+)$`, 'm').exec(stdout ?? '')?.[1]?.trim() ?? '';
  const name = field('ProductName');
  return name ? osText(`${name} ${field('ProductVersion')}`) : null;
}

/** Linux `/etc/os-release`: `PRETTY_NAME`, without the quotes around it when they pair. */
export function linuxOs(text: string | null | undefined): string | null {
  const value = /^PRETTY_NAME=(.*)$/m.exec(text ?? '')?.[1]?.trim() ?? '';
  const quote = value.charAt(0);
  const quoted = value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote);
  return osText(quoted ? value.slice(1, -1) : value);
}

/** Windows `cmd /c ver`: its first line with anything on it. */
export function windowsOs(stdout: string | null | undefined): string | null {
  const line = (stdout ?? '').split(/\r?\n/).find((l) => l.trim() !== '');
  return line === undefined ? null : osText(line);
}
