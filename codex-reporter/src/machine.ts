// Which machine the reports come from. The id is random and kept in one file both reporters share, `sitrep-machine-id` in
// `$CLAUDE_CONFIG_DIR` or `~/.claude`: one line of 8 to 32 lowercase hex characters (12 when made here). Whichever reporter
// starts first makes it; nothing about the hardware is read.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MachineInfo } from '../../server/src/fleet/protocol.js';

export const MACHINE_ID_FILE = 'sitrep-machine-id';

/** `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`, where the Claude reporter keeps the same file. */
export function machineIdPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  return path.join(path.resolve(dir), MACHINE_ID_FILE);
}

/**
 * The shared id. A missing file is made, create-only, with a new 12-hex id and read back. A file that cannot be read or made,
 * or that holds no id, throws with its name: an id is never made up over one that may hold this machine's, as a new id would
 * make each live session a second card and start its spend over.
 */
export function machineId(): string {
  const file = machineIdPath();
  try {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        fs.writeFileSync(file, `${randomBytes(6).toString('hex')}\n`, { flag: 'wx' });
      } catch (made) {
        if ((made as NodeJS.ErrnoException).code !== 'EEXIST') throw made;
      }
      text = fs.readFileSync(file, 'utf8');
    }
    const id = text.trim();
    if (!/^[0-9a-f]{8,32}$/.test(id)) throw new Error(`${file} holds no machine id`);
    return id;
  } catch (err) {
    // Every failure names the file once: some of Node's messages carry the path (open), some do not (EISDIR, a failed write).
    const why = (err as Error).message;
    throw new Error(why.includes(file) ? why : `${file}: ${why}`);
  }
}

/** The short host name: up to the first dot, without control characters, at most 64. */
function hostName(): string | null {
  const host = os.hostname().replace(/[\u0000-\u001f\u007f]/g, '').trim().split('.')[0]!.trim();
  return host ? host.slice(0, 64) : null;
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000, maxBuffer: 64 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

const cleanOs = (v: string): string | null => {
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80);
  return s || null;
};

/** The OS as free text: `sw_vers` on macOS, `/etc/os-release` on Linux; null when neither reads. */
async function readOs(): Promise<string | null> {
  const sw = await run('sw_vers', []);
  if (sw) {
    const field = (key: string) => new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(sw)?.[1]?.trim() ?? '';
    const name = field('ProductName');
    if (name) return cleanOs(`${name} ${field('ProductVersion')}`);
  }
  try {
    const value = /^PRETTY_NAME=(.*)$/m.exec(fs.readFileSync('/etc/os-release', 'utf8'))?.[1]?.trim() ?? '';
    // A value may be quoted, shell style (os-release(5)).
    return cleanOs(/^(["'])(.*)\1$/.exec(value)?.[2] ?? value);
  } catch {
    return null;
  }
}

/** This machine; throws while its id cannot be read (machineId). */
export async function readMachine(): Promise<MachineInfo> {
  const id = machineId();
  return { name: hostName() ?? `machine-${id.slice(0, 4)}`, id, os: await readOs() };
}
