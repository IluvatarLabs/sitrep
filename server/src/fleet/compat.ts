// Which reporter versions this server reads correctly: one range per reporter, moved only when the report format or a
// reporter's behaviour changes. Only major and minor are compared, so a patch release never raises a warning.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReporterCompat, ReporterSupport } from './protocol.js';

/** For each reporter the server knows, the oldest and newest version it reads correctly. A reporter not listed reads as unknown. */
export const REPORTER_SUPPORT: { readonly [reporter: string]: ReporterSupport } = {
  // From 0.2.0 plan windows carry `measuredAt` and the surface is reported, and asks, answers and results name the session
  // `<native id>@<machine id>`, which 0.1.0 does not, so it cannot be answered. 0.3.0 sends no usage: Claude usage comes
  // from Claude Code's own telemetry, and no version's usage is read.
  'claude-reporter': { min: '0.2.0', max: '0.3.0' },
  // 0.2.0 took usage from Codex's per-response records, which spend trusts; 0.3.0 adds `measuredAt` and the thread's
  // originator and names the session `<native id>@<machine id>` on the answer routes, so 0.2.0 cannot be answered.
  'codex-reporter': { min: '0.3.0', max: '0.3.0' },
  // Hermes sessions, observed only.
  'hermes-reporter': { min: '0.1.0', max: '0.1.0' },
};

/** A reporter's range; null when the server has none for it, which is accepted and reads as `unknown`. */
export const supportFor = (name: string): ReporterSupport | null => (Object.hasOwn(REPORTER_SUPPORT, name) ? REPORTER_SUPPORT[name]! : null);

/** The major and minor of a `major.minor.patch` version; null for any other text. */
function majorMinor(version: string | null | undefined): [number, number] | null {
  if (version == null || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  const [major = 0, minor = 0] = version.split('.', 2).map(Number);
  return [major, minor];
}

/** Below 0 when `a` is the older of the two, above 0 when it is the newer, 0 when major and minor agree. */
const older = (a: [number, number], b: [number, number]): number => a[0] - b[0] || a[1] - b[1];

/** Where a version stands against a reporter's range; `unknown` when there is no range, or the version or a bound does not parse. */
export function checkReporter(version: string | null | undefined, support: ReporterSupport | null): ReporterCompat {
  const [v, oldest, newest] = [version, support?.min, support?.max].map(majorMinor);
  if (!v || !oldest || !newest) return 'unknown';
  if (older(v, oldest) < 0) return 'outdated';
  return older(v, newest) > 0 ? 'newer' : 'ok';
}

let version: string | undefined;

/** The server's own version, read once from server/package.json, two folders up from this file in src/ and dist/ alike. */
export function serverVersion(): string {
  if (version === undefined) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version?: unknown };
      version = typeof manifest.version === 'string' ? manifest.version : 'unknown';
    } catch {
      version = 'unknown';
    }
  }
  return version;
}

/** What SITREP_BUILD holds on a dev build: its commit, 7 to 40 hex digits, then `-dirty` when it had changes. */
const BUILD = /^[0-9a-f]{7,40}(-dirty)?$/;

/** The commit of a dev build of the server; null for a release. */
export function serverBuild(env: NodeJS.ProcessEnv = process.env): string | null {
  const build = env.SITREP_BUILD?.trim() ?? '';
  return BUILD.test(build) ? build : null;
}
