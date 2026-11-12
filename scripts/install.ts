#!/usr/bin/env -S npx tsx
// SITREP install: the server as a user service, and a machine's reporters. The service is a systemd --user unit
// on Linux (with the linger hint) or a launchd agent on macOS, with a config file of KEY=VALUE lines, mode 0600, holding a
// generated admin secret. Both reporters are installed as plugins: a plugin marketplace, then install.
//
// Dry run by default: it prints every file it would write and every command it would run, and changes nothing until
// --apply. The `claude` and `codex` plugin commands make their own entries (marketplace, enable, options), and our Codex
// hooks are trusted through Codex's own app-server API as its /hooks screen does. The one provider setting it writes itself
// is Claude Code's telemetry, which a plugin cannot set: `env` and `otelHeadersHelper` in Claude Code's user settings,
// merged into what is there. No hook entry is ever touched. scripts/uninstall.ts removes what this adds.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
// The release's manifest, for the version this script gives as its own when it connects to Codex.
import release from '../package.json' with { type: 'json' };

const HELP = `install: set up the SITREP server and this machine's reporters.

Usage: npx tsx scripts/install.ts <component...> [options]

Dry run by default: prints every file it would write and every command it would run, and changes nothing.
Add --apply to make the changes. Run it again after an upgrade; it is safe to repeat.

Components (name at least one):
  --server          The dashboard server as a user service (systemd --user on Linux, launchd on macOS) and its
                    config ~/.sitrep/server.env, with a new admin secret
  --claude          The Claude Code plugin sitrep-reporter, from this repository's plugin marketplace; and
                    Claude Code's telemetry, which carries its sessions' usage, to the same server: env and
                    otelHeadersHelper in ~/.claude/settings.json, with the admin secret in
                    ~/.sitrep/claude-otel-token
  --codex           The Codex plugin sitrep-codex (its hooks), from this repository's plugin marketplace; the
                    codex-reporter user service with its config ~/.sitrep/codex-reporter.env; and trust for
                    the plugin's hooks, written as Codex's /hooks screen writes it

Options:
  --url URL         The server URL the reporters send to. Without it, on a machine with a server config (--server in
                    this run, or ~/.sitrep/server.env), both reporters are set to that server's address on
                    every run: host = --bind, else the saved HOST, else 127.0.0.1 (0.0.0.0 and :: mean 127.0.0.1; any
                    other address as given); port = --port, else the saved PORT, else 7487. On a machine without one,
                    a reporter keeps the URL it has, and a new one sends to http://127.0.0.1:7487
  --bind ADDR       Where the server listens (default 127.0.0.1; 0.0.0.0 lets other machines report). With --server only
  --port N          The server's port (default 7487). With --server only
  --token-stdin     Read the server's admin secret for the reporters from stdin. Without it the reporters use the
                    secret in this machine's ~/.sitrep/server.env when there is one
  --apply           Make the changes
  -h, --help        Show this help

To try the Claude plugin in one session without changing any Claude Code settings:
  claude --plugin-dir <repo>/mod/claude-reporter`;

// ---- Where things live --------------------------------------------------------------------------

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
/** The product's own folder on each machine: configs, the server's database, macOS service logs, the Codex hook spool. */
export const DATA_HOME = path.join(HOME, '.sitrep');
export const SERVER_ENV = path.join(DATA_HOME, 'server.env');
export const REPORTER_ENV = path.join(DATA_HOME, 'codex-reporter.env');
export const DB_DIR = path.join(DATA_HOME, 'data');
/** Claude Code's config folder, `$CLAUDE_CONFIG_DIR` or `~/.claude` (code.claude.com/docs/en/settings), as the reporters find it. */
const CLAUDE_DIR = path.resolve(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(HOME, '.claude'));
/** The machine id both reporters share; the first one to start makes it. */
export const MACHINE_ID_FILE = path.join(CLAUDE_DIR, 'sitrep-machine-id');
/** Claude Code's user settings, where its telemetry is set (a plugin cannot set it; code.claude.com/docs/en/monitoring-usage). */
export const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
/**
 * The admin secret Claude Code's telemetry sends, alone on one line, mode 0600, read by OTEL_HELPER. The plugin's own copy is
 * a `sensitive` option in Claude Code's secure store, which gives a headers helper no way to read it (code.claude.com/docs/en/
 * plugins-reference, "Fields that run through a shell"; `claude plugin configure --json` shows it empty), so install keeps
 * this one as it keeps codex-reporter's.
 */
export const OTEL_TOKEN = path.join(DATA_HOME, 'claude-otel-token');
/** Claude Code's otelHeadersHelper: prints the token and machine headers. */
export const OTEL_HELPER = path.join(REPO_ROOT, 'scripts', 'claude-otel-headers.sh');

/**
 * The settings install writes into the two config files: the server's names as server/src/index.ts reads them, and the
 * Codex reporter's. scripts/*.env.example and docs/OPERATIONS.md list every setting of both.
 */
const KEYS = {
  serverHost: 'HOST',
  serverPort: 'PORT',
  serverToken: 'SITREP_TOKEN',
  serverDb: 'SITREP_DB',
  reporterUrl: 'CODEX_REPORTER_SERVER_URL',
  reporterToken: 'CODEX_REPORTER_TOKEN',
} as const;

/** The Claude plugin's option names, `serverUrl` and `token`, as mod/claude-reporter/.claude-plugin/plugin.json declares them. */
const CLAUDE_OPTIONS = { url: 'serverUrl', token: 'token' } as const;

export interface Service {
  title: string;
  /** systemd user unit name. */
  unit: string;
  /** launchd label. */
  label: string;
  /** The built entry point, run with `node --env-file=<envFile>`. */
  entry: string;
  envFile: string;
  /** Where launchd writes the process's output (systemd keeps it in the journal). */
  log: string;
  /** The oldest Node it runs on, as its package.json's `engines` says: "24", "22.15". */
  minNode: string;
}

export const SERVER: Service = {
  title: 'SITREP server',
  unit: 'sitrep.service',
  label: 'dev.sitrep.server',
  entry: path.join(REPO_ROOT, 'server', 'dist', 'index.js'),
  envFile: SERVER_ENV,
  log: path.join(DATA_HOME, 'server.log'),
  minNode: '24',
};

export const CODEX_REPORTER: Service = {
  title: 'SITREP codex-reporter',
  unit: 'sitrep-codex-reporter.service',
  label: 'dev.sitrep.codex-reporter',
  entry: path.join(REPO_ROOT, 'codex-reporter', 'dist', 'codex-reporter', 'src', 'main.js'),
  envFile: REPORTER_ENV,
  log: path.join(DATA_HOME, 'codex-reporter.log'),
  minNode: '22.15',
};

export const PLATFORM = process.platform === 'darwin' ? 'launchd' : process.platform === 'linux' ? 'systemd' : null;

export function serviceFile(svc: Service): string {
  return PLATFORM === 'launchd' ? path.join(HOME, 'Library', 'LaunchAgents', `${svc.label}.plist`) : path.join(HOME, '.config', 'systemd', 'user', svc.unit);
}

/** A plugin marketplace in this repository: its name and its one plugin's id (`plugin@marketplace`). */
function marketplace(relative: string): { file: string; name: string; plugin: string } {
  const file = path.join(REPO_ROOT, relative);
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { name: string; plugins: { name: string }[] };
  return { file, name: json.name, plugin: `${json.plugins[0].name}@${json.name}` };
}

export const claudeMarket = () => marketplace('.claude-plugin/marketplace.json');
export const codexMarket = () => marketplace('.agents/plugins/marketplace.json');

// ---- Plans --------------------------------------------------------------------------------------

export type Action =
  | { kind: 'mkdir'; path: string; mode: number }
  | { kind: 'write'; path: string; content: string; mode: number; shown: string }
  /** A file left as it is; with `mode`, that mode is applied again. */
  | { kind: 'keep'; path: string; why: string; mode?: number }
  | { kind: 'remove'; path: string }
  | { kind: 'rmdir-if-empty'; path: string }
  | { kind: 'run'; argv: string[]; input?: string; shownInput?: string; mayFail?: boolean; quiet?: boolean }
  /** launchd target `gui/<uid>/<label>`: wait until `launchctl print` no longer finds it, or fail after UNLOAD_WAIT_S. */
  | { kind: 'await-unload'; target: string }
  /** Trust `plugin`'s hooks that Codex lists as untrusted or modified, as Codex's /hooks screen does. */
  | { kind: 'trust-codex-hooks'; plugin: string }
  /**
   * Set (or, with null, remove) the telemetry keys in Claude Code's user settings, every other key kept. The file is read when
   * this runs, since the `claude plugin` commands before it write the same file; `shown` is the change as planned.
   */
  | { kind: 'claude-telemetry'; set: TelemetrySettings | null; shown: string }
  | { kind: 'note'; text: string };

/**
 * `launchctl bootout` returns while the job is still being torn down, and a `bootstrap` in that window fails ("Bootstrap
 * failed: 5: Input/output error"), leaving the service unloaded. Homebrew's `brew services` waits it out the same way:
 * once a second while launchd still has the label, up to a limit (Library/Homebrew/services/cli.rb).
 */
const UNLOAD_WAIT_S = 10;

export interface Step {
  title: string;
  /** What must be fixed before this step is applied; --apply leaves the step out while any is left. */
  blockers: string[];
  actions: Action[];
  /** The steps after it need it: when it is left out or fails, they are left out too. */
  prerequisite?: boolean;
}

export const tilde = (p: string): string => (p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);

/** Homebrew installs node under Cellar/<formula>/<version>, which `brew upgrade` deletes; opt/<formula> survives it. */
function stableNodePath(execPath: string): string {
  const stable = execPath.replace(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.*)$/, '$1/opt/$2/$3');
  try {
    return stable !== execPath && fs.realpathSync(stable) === fs.realpathSync(execPath) ? stable : execPath;
  } catch {
    return execPath;
  }
}

const NODE = stableNodePath(process.execPath);

/** Whether this Node is at least `min` ("24", "22.15"): its major, then its minor. */
export function nodeAtLeast(min: string, have: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = have.split('.').map(Number);
  const [needMajor = 0, needMinor = 0] = min.split('.').map(Number);
  return major > needMajor || (major === needMajor && minor >= needMinor);
}

function systemdUnit(svc: Service): string {
  // systemd expands % specifiers in all three lines; ExecStart also splits on spaces and expands $VARIABLES, and an
  // Environment= assignment with spaces needs quotes (systemd.service(5), systemd.exec(5)).
  const spec = (s: string): string => s.replace(/%/g, '%%');
  const quote = (s: string): string => `"${s.replace(/(["\\])/g, '\\$1')}"`;
  const arg = (s: string): string => (/[\s"'\\$%]/.test(s) ? quote(spec(s).replace(/\$/g, '$$$$')) : s);
  const env = (s: string): string => (/[\s"'\\]/.test(s) ? quote(spec(s)) : spec(s));
  return `[Unit]
Description=${svc.title}
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${spec(REPO_ROOT)}
Environment=${env(`PATH=${process.env.PATH ?? '/usr/bin:/bin'}`)}
ExecStart=${[NODE, `--env-file=${svc.envFile}`, svc.entry].map(arg).join(' ')}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function launchdPlist(svc: Service): string {
  const x = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const args = [NODE, `--env-file=${svc.envFile}`, svc.entry];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${x(svc.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${x(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${x(REPO_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${x(process.env.PATH ?? '/usr/bin:/bin')}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${x(svc.log)}</string>
  <key>StandardErrorPath</key><string>${x(svc.log)}</string>
</dict>
</plist>
`;
}

export const uid = (): number => os.userInfo().uid;

/** Write the unit and (re)start it: a restart applies a changed unit or config. */
function enableService(svc: Service): Action[] {
  const file = serviceFile(svc);
  if (PLATFORM === 'launchd') {
    const target = `gui/${String(uid())}/${svc.label}`;
    return [
      { kind: 'write', path: file, content: launchdPlist(svc), mode: 0o644, shown: launchdPlist(svc) },
      { kind: 'run', argv: ['launchctl', 'bootout', target], mayFail: true, quiet: true },
      { kind: 'await-unload', target },
      { kind: 'run', argv: ['launchctl', 'bootstrap', `gui/${String(uid())}`, file] },
      { kind: 'note', text: `Logs: ${tilde(svc.log)}` },
    ];
  }
  return [
    { kind: 'write', path: file, content: systemdUnit(svc), mode: 0o644, shown: systemdUnit(svc) },
    { kind: 'run', argv: ['systemctl', '--user', 'daemon-reload'] },
    { kind: 'run', argv: ['systemctl', '--user', 'enable', svc.unit] },
    { kind: 'run', argv: ['systemctl', '--user', 'restart', svc.unit] },
    { kind: 'note', text: `Logs: journalctl --user -u ${svc.unit} -f` },
    { kind: 'note', text: 'The service starts when you log in. To start it at boot and keep it running after you log out, run once: loginctl enable-linger $USER' },
  ];
}

/** Stop the service and remove its unit. Nothing to do when no unit file is there. */
export function disableService(svc: Service): Action[] {
  const file = serviceFile(svc);
  if (!fs.existsSync(file)) return [{ kind: 'note', text: `No service file at ${tilde(file)}; nothing to stop.` }];
  if (PLATFORM === 'launchd') {
    const target = `gui/${String(uid())}/${svc.label}`;
    return [
      { kind: 'run', argv: ['launchctl', 'bootout', target], mayFail: true, quiet: true },
      { kind: 'await-unload', target },
      { kind: 'remove', path: file },
    ];
  }
  return [
    { kind: 'run', argv: ['systemctl', '--user', 'disable', '--now', svc.unit], mayFail: true },
    { kind: 'remove', path: file },
    { kind: 'run', argv: ['systemctl', '--user', 'daemon-reload'] },
  ];
}

/** Reads one KEY=VALUE from an env file's text; null when the key is absent. Quotes and a trailing comment are dropped. */
export function envValue(text: string, key: string): string | null {
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m || m[1] !== key) continue;
    const raw = m[2].trim();
    const quoted = /^(["'`])(.*?)\1/.exec(raw);
    return quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').trim();
  }
  return null;
}

/** Sets keys in an env file's text, each on its own line in place, appended when missing. */
function setEnv(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    const v = /[\s#"'`]/.test(value) ? `"${value}"` : value;
    const re = new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=.*$`, 'm');
    out = re.test(out) ? out.replace(re, `$1${key}=${v}`) : `${out.replace(/\n?$/, '\n')}${key}=${v}\n`;
  }
  return out;
}

/** The text with the secret's value hidden, for printing. */
function hideSecret(text: string, key: string): string {
  const value = envValue(text, key);
  return value ? setEnv(text, { [key]: '(hidden)' }) : text;
}

/** Create a config from its template, or update only the given keys in the one there; keep it when nothing changes. */
function envFile(file: string, template: string, values: Record<string, string>, secretKey: string): Action {
  const exists = fs.existsSync(file);
  const base = fs.readFileSync(exists ? file : path.join(REPO_ROOT, 'scripts', template), 'utf8');
  const content = setEnv(base, values);
  if (exists && content === base) return { kind: 'keep', path: file, why: 'unchanged' };
  return { kind: 'write', path: file, content, mode: 0o600, shown: hideSecret(content, secretKey) };
}

interface InstallOptions {
  server: boolean;
  claude: boolean;
  codex: boolean;
  url: string | null;
  bind: string | null;
  port: number | null;
  secret: string | null;
}

/** The admin secret the reporters send: from stdin, else the one in this machine's server config (made in this run, or there already). */
function reporterSecret(o: InstallOptions, newServerSecret: string | null): string | null {
  if (o.secret !== null) return o.secret;
  if (newServerSecret) return newServerSecret;
  if (!fs.existsSync(SERVER_ENV)) return null;
  return envValue(fs.readFileSync(SERVER_ENV, 'utf8'), KEYS.serverToken) || null;
}

/**
 * Where this machine's server listens after this run, as a URL its own reporters reach; null when the machine has no
 * server config. server.env decides: this run's --bind and --port over its saved HOST and PORT, else the server's own
 * defaults (server/src/index.ts). 0.0.0.0 and :: listen on every address, so 127.0.0.1 reaches them; a server bound to
 * any other address listens only there (one on ::1 refuses 127.0.0.1; Node may bind localhost to ::1), so that address
 * is used as given, an IPv6 one in brackets.
 */
export function localServerUrl(o: Pick<InstallOptions, 'server' | 'bind' | 'port'>): string | null {
  const exists = fs.existsSync(SERVER_ENV);
  if (!o.server && !exists) return null;
  const saved = exists ? fs.readFileSync(SERVER_ENV, 'utf8') : '';
  const host = (o.bind ?? envValue(saved, KEYS.serverHost)) || '127.0.0.1';
  const port = o.port !== null ? String(o.port) : envValue(saved, KEYS.serverPort) || '7487';
  const reach = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return `http://${reach}:${port}`;
}

/** Whether this machine's Claude Code has `plugin` installed, from `claude plugin list --json` (read only); null when it cannot tell. */
function claudeHasPlugin(plugin: string): boolean | null {
  const r = spawnSync('claude', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) return null;
  try {
    const list = JSON.parse(r.stdout) as unknown;
    return Array.isArray(list) ? list.some((p) => (p as { id?: unknown } | null)?.id === plugin) : null;
  } catch {
    return null;
  }
}

/** The Claude plugin's options as `claude plugin configure <plugin> --json` lists them: read only, secret values shown empty; null when it cannot tell. */
export function claudePluginOptions(plugin: string): { configured?: unknown; inputs?: { serverUrl?: unknown } } | null {
  const r = spawnSync('claude', ['plugin', 'configure', plugin, '--json'], { encoding: 'utf8', timeout: 30_000 });
  try {
    return r.status === 0 ? (JSON.parse(r.stdout) as { configured?: unknown; inputs?: { serverUrl?: unknown } }) : null;
  } catch {
    return null;
  }
}

/** The Claude plugin's default server URL, as mod/claude-reporter/.claude-plugin/plugin.json declares it. */
export const CLAUDE_DEFAULT_URL = 'http://127.0.0.1:7487';

/** The URL the Claude plugin sends to: its saved serverUrl, else its default. */
export function claudePluginUrl(options: ReturnType<typeof claudePluginOptions>): string {
  const saved = options?.inputs?.serverUrl;
  return (typeof saved === 'string' && saved ? saved : CLAUDE_DEFAULT_URL).replace(/\/+$/, '');
}

// ---- Claude Code telemetry ------------------------------------------------------------------------

export interface TelemetrySettings {
  env: Record<string, string>;
  otelHeadersHelper: string;
}

/**
 * What install sets in Claude Code's user settings so its OTLP log events (one `claude_code.api_request` per API request,
 * with that request's tokens) reach the server (code.claude.com/docs/en/monitoring-usage): logs only, their protocol and
 * endpoint in the logs-only variables so no other exporter is touched, HTTP/JSON to the server's logs route as a full URL,
 * which the exporter uses as given; exported each second, the reporters' cadence; no metrics or traces exporter.
 * `otelHeadersHelper` prints the token and machine headers, so the secret stays out of the file; run by /bin/sh, it names no
 * Node that a version manager or an upgrade can move.
 */
export function telemetrySettings(url: string): TelemetrySettings {
  return {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${url}/api/fleet/v1/logs`,
      OTEL_LOGS_EXPORT_INTERVAL: '1000',
    },
    otelHeadersHelper: ['/bin/sh', OTEL_HELPER].map(shellQuote).join(' '),
  };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Claude Code's user settings; {} when there is no file. Throws when the file cannot be read or is not settings. */
export function readClaudeSettings(): Json {
  let text: string;
  try {
    text = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const s = JSON.parse(text) as unknown;
  if (!isObject(s) || (s.env !== undefined && !isObject(s.env))) throw new Error('not a JSON object with an object `env`');
  return s;
}

/**
 * Whether these settings run our helper, from any clone of this repository (its command ends in the script's own path, quoted
 * or not; `.mjs`, run by Node, is the one installs wrote before): then their telemetry keys are the ones an install set, for
 * install, uninstall and doctor to update, remove or check.
 */
export const ownsTelemetry = (s: Json): boolean => typeof s.otelHeadersHelper === 'string' && /\/scripts\/claude-otel-headers\.(?:sh|mjs)'?$/.test(s.otelHeadersHelper.trim());

/** The Claude step's telemetry: the secret for the helper, then the settings, merged into Claude Code's user settings. */
function telemetryPlan(url: string, secret: string | null): { blockers: string[]; actions: Action[] } {
  let s: Json;
  try {
    s = readClaudeSettings();
  } catch (err) {
    return { blockers: [`${tilde(CLAUDE_SETTINGS)} cannot be read as Claude Code settings (${(err as Error).message}); fix it, then run this again`], actions: [] };
  }
  const env = (s.env ?? {}) as Json;
  // Telemetry already set up by something else: its log events have one destination, and the dashboard would take it over.
  const theirs = ownsTelemetry(s) ? [] : [
    ...Object.keys(env).filter((k) => k === 'CLAUDE_CODE_ENABLE_TELEMETRY' || k.startsWith('OTEL_')).map((k) => `env.${k}`),
    ...('otelHeadersHelper' in s ? ['otelHeadersHelper'] : []),
  ];
  const blockers = theirs.length ? [`${tilde(CLAUDE_SETTINGS)} already sets Claude Code's telemetry (${theirs.join(', ')}); the dashboard would take over where its log events go. Remove those settings to send them to the dashboard instead`] : [];
  const want = telemetrySettings(url);
  const line = (key: string, value: string, old: unknown): string => `${key} = ${JSON.stringify(value)}${old === undefined ? '' : old === value ? '   (unchanged)' : `   (was ${JSON.stringify(old)})`}`;
  const shown = [...Object.entries(want.env).map(([k, v]) => line(`env.${k}`, v, env[k])), line('otelHeadersHelper', want.otelHeadersHelper, s.otelHeadersHelper)].join('\n');
  const actions: Action[] = [];
  if (secret) {
    const content = `${secret}\n`;
    const same = fs.existsSync(OTEL_TOKEN) && fs.readFileSync(OTEL_TOKEN, 'utf8') === content;
    actions.push({ kind: 'mkdir', path: DATA_HOME, mode: 0o700 }, same ? { kind: 'keep', path: OTEL_TOKEN, why: 'unchanged', mode: 0o600 } : { kind: 'write', path: OTEL_TOKEN, content, mode: 0o600, shown: '(the admin secret, hidden)' });
  } else if (fs.existsSync(OTEL_TOKEN)) actions.push({ kind: 'keep', path: OTEL_TOKEN, why: 'no secret given; the one there stays', mode: 0o600 });
  // Settings without a secret would have every export refused (401), which the exporter never retries: the usage is lost.
  else blockers.push(`no admin secret for Claude Code's telemetry (none on stdin, in ${tilde(SERVER_ENV)} or in ${tilde(OTEL_TOKEN)}): re-run with --token-stdin`);
  actions.push({ kind: 'claude-telemetry', set: want, shown });
  if (!fs.existsSync(MACHINE_ID_FILE)) actions.push({ kind: 'note', text: `No machine id yet (${tilde(MACHINE_ID_FILE)}). Telemetry needs it; the plugin or codex-reporter makes it when it first starts, and the sessions started after that send their usage.` });
  return { blockers, actions };
}

function serviceBlockers(svc: Service, built: string): string[] {
  const out: string[] = [];
  if (!PLATFORM) out.push(`user services are set up on Linux (systemd) and macOS (launchd) only, not ${process.platform}`);
  if (!fs.existsSync(svc.entry)) out.push(`${path.relative(REPO_ROOT, svc.entry)} is missing: run \`npm ci && ${built}\` first`);
  if (!nodeAtLeast(svc.minNode)) out.push(`the ${svc.title} needs Node ${svc.minNode} or later; this is Node ${process.versions.node} (${NODE})`);
  return out;
}

function installPlan(o: InstallOptions): Step[] {
  const steps: Step[] = [];
  const port = o.port ?? 7487;
  const localServer = localServerUrl(o);
  // The URL both reporters are set to on this run, replacing a saved one: --url, else this machine's server. Null (no
  // server here) keeps a reporter's saved URL, and a new one gets the Claude plugin's default.
  const chosenUrl = o.url ?? localServer;
  const url = chosenUrl ?? 'http://127.0.0.1:7487';
  let newServerSecret: string | null = null;

  if (o.server) {
    const blockers = serviceBlockers(SERVER, 'npm run build');
    if (!fs.existsSync(path.join(REPO_ROOT, 'frontend', 'dist', 'index.html'))) blockers.push('frontend/dist/index.html is missing: run `npm ci && npm run build` first');
    const actions: Action[] = [{ kind: 'mkdir', path: DATA_HOME, mode: 0o700 }, { kind: 'mkdir', path: DB_DIR, mode: 0o700 }];
    if (fs.existsSync(SERVER_ENV)) {
      // An existing config keeps its secret and database; only --bind and --port change it, and they are saved there.
      const values: Record<string, string> = {};
      if (o.bind !== null) values[KEYS.serverHost] = o.bind;
      if (o.port !== null) values[KEYS.serverPort] = String(o.port);
      actions.push(envFile(SERVER_ENV, 'server.env.example', values, KEYS.serverToken));
    } else {
      // First install: a new admin secret.
      newServerSecret = randomBytes(24).toString('hex');
      actions.push(envFile(SERVER_ENV, 'server.env.example', {
        [KEYS.serverHost]: o.bind ?? '127.0.0.1',
        [KEYS.serverPort]: String(port),
        [KEYS.serverDb]: path.join(DB_DIR, 'sitrep.sqlite'),
        [KEYS.serverToken]: newServerSecret,
      }, KEYS.serverToken));
      actions.push({ kind: 'note', text: `The admin secret is in ${tilde(SERVER_ENV)} (${KEYS.serverToken}). You sign in with it to answer sessions, and every reporter sends it.` });
    }
    actions.push(...enableService(SERVER));
    actions.push({ kind: 'note', text: `Open the dashboard at ${localServer ?? url}/ (from other machines: this machine's LAN address, with --bind 0.0.0.0 or that address).` });
    // The server moves (a new HOST or PORT): this machine's reporters left out of this run still send to the old address.
    const before = localServerUrl({ ...o, server: false, bind: null, port: null });
    if (before !== null && before !== localServer) {
      const left = [
        ...(!o.codex && fs.existsSync(REPORTER_ENV) ? [{ who: `codex-reporter (${tilde(REPORTER_ENV)})`, flag: '--codex' }] : []),
        ...(!o.claude && claudeHasPlugin(claudeMarket().plugin) ? [{ who: 'the Claude plugin', flag: '--claude' }] : []),
      ];
      if (left.length) actions.push({ kind: 'note', text: `The server moves from ${before} to ${String(localServer)}: ${left.map((l) => l.who).join(' and ')} on this machine ${left.length > 1 ? 'keep their' : 'keeps its'} old URL. Re-run with ${left.map((l) => l.flag).join(' ')} to point them at the new address.` });
    }
    // The reporters below are given this server's address and secret, so they wait for it.
    steps.push({ title: 'Server', blockers, actions, prerequisite: true });
  }

  const secret = reporterSecret(o, newServerSecret);
  const reporterNotes: Action[] = secret ? [] : [{ kind: 'note', text: 'No admin secret given (--token-stdin) and none in this machine\'s server config: a reporter set up before keeps the secret it has, and a new one sends none, which a server with a secret refuses (HTTP 401).' }];
  if (chosenUrl === null) reporterNotes.push({ kind: 'note', text: `No --url given and no server config on this machine: a reporter set up for the first time sends to ${url} (also the Claude plugin's default), and one set up before keeps its URL. Pass --url when the server runs on another machine.` });

  if (o.codex) {
    const market = codexMarket();
    const blockers = serviceBlockers(CODEX_REPORTER, 'npm run build -w codex-reporter');
    const manifest = path.join(REPO_ROOT, 'codex-reporter', 'plugin', '.codex-plugin', 'plugin.json');
    if (!fs.existsSync(manifest)) blockers.push(`${path.relative(REPO_ROOT, manifest)} is missing: this checkout has no Codex plugin`);
    const values: Record<string, string> = {};
    if (chosenUrl !== null || !fs.existsSync(REPORTER_ENV)) values[KEYS.reporterUrl] = url;
    if (secret) values[KEYS.reporterToken] = secret;
    steps.push({
      title: 'Codex',
      blockers,
      actions: [
        // Codex reads this repository's .agents/plugins/marketplace.json and copies the plugin into its own cache.
        { kind: 'run', argv: ['codex', 'plugin', 'marketplace', 'add', REPO_ROOT] },
        { kind: 'run', argv: ['codex', 'plugin', 'add', market.plugin] },
        { kind: 'mkdir', path: DATA_HOME, mode: 0o700 },
        envFile(REPORTER_ENV, 'codex-reporter.env.example', values, KEYS.reporterToken),
        ...enableService(CODEX_REPORTER),
        ...reporterNotes,
        // Codex ties hook trust to the plugin's contents, so every `codex plugin add` above needs it again.
        { kind: 'trust-codex-hooks', plugin: market.plugin },
      ],
    });
  }

  if (o.claude) {
    const market = claudeMarket();
    const blockers: string[] = [];
    const manifest = path.join(REPO_ROOT, 'mod', 'claude-reporter', '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifest)) blockers.push(`${path.relative(REPO_ROOT, manifest)} is missing: this checkout has no Claude plugin`);
    const actions: Action[] = [
      // Claude Code reads this relative-path plugin from the checkout in place, but records its version with a copy in its cache
      // (`claude plugin list --json`: readFromFolder, version, installPath), and `install` leaves an existing record as it is.
      // `update` moves the record and the copy to this checkout's version (exit 0, "nothing to update", when they match), so the
      // plugin is this version whichever one a Claude Code build loads. Open sessions take it once restarted (resumed), as
      // `update` itself asks ("Restart to apply changes").
      { kind: 'run', argv: ['claude', 'plugin', 'marketplace', 'add', REPO_ROOT, '--scope', 'user'] },
      { kind: 'run', argv: ['claude', 'plugin', 'install', market.plugin, '--scope', 'user'] },
      { kind: 'run', argv: ['claude', 'plugin', 'update', market.plugin, '--scope', 'user'] },
    ];
    // The URL is saved only when this run chose one (--url, or this machine's server); otherwise the one set before stays.
    const values: Record<string, string> = {};
    if (chosenUrl !== null) values[CLAUDE_OPTIONS.url] = chosenUrl;
    if (secret) values[CLAUDE_OPTIONS.token] = secret;
    if (Object.keys(values).length) {
      // On stdin, so the secret never appears in a process list or shell history.
      const shown = { ...values, ...(secret ? { [CLAUDE_OPTIONS.token]: '(hidden)' } : {}) };
      actions.push({ kind: 'run', argv: ['claude', 'plugin', 'configure', market.plugin, '--values-stdin'], input: JSON.stringify(values), shownInput: JSON.stringify(shown) });
    }
    // Telemetry goes where the plugin reports: this run's URL, else the one the plugin has, its default only when Claude Code
    // says it is not installed yet. A plugin whose options cannot be read, installed or not known to be absent, may send
    // anywhere, so that is a blocker, not a guess.
    let telemetryUrl = chosenUrl;
    if (telemetryUrl === null) {
      const options = claudePluginOptions(market.plugin);
      if (options) telemetryUrl = claudePluginUrl(options);
      else if (claudeHasPlugin(market.plugin) === false) telemetryUrl = CLAUDE_DEFAULT_URL;
      else blockers.push(`the plugin's server URL cannot be read (\`claude plugin configure ${market.plugin} --json\` failed), so Claude Code's telemetry has no known destination: pass --url`);
    }
    if (telemetryUrl !== null) {
      const telemetry = telemetryPlan(telemetryUrl, secret);
      blockers.push(...telemetry.blockers);
      actions.push(...telemetry.actions);
    }
    actions.push(...reporterNotes);
    actions.push({ kind: 'note', text: 'Claude Code sessions started from now on report and send their usage. A running session does both once restarted (resumed): Claude Code reads its telemetry settings at start, and `claude plugin update` asks for a restart.' });
    steps.push({ title: 'Claude Code', blockers, actions });
  }
  return steps;
}

/** A step that could not be done, with a message that says why; runPlan prints it and stops. */
class Failed extends Error {}

// ---- Codex hook trust ----------------------------------------------------------------------------

/**
 * A JSON-RPC connection to a Codex app-server, reached the way Codex's own clients reach one: the managed daemon's socket
 * when it runs (its path from `codex app-server daemon version`, then a WebSocket over the socket, as
 * codex-reporter/src/daemon.ts connects), else a private `codex app-server` over stdio, one JSON message per line (the TUI
 * likewise runs its own server when no daemon runs: codex-rs/tui/src/app_server_connection.rs). It only sends requests: a
 * request from the server is never answered.
 */
export interface CodexAppServer {
  /** Where it was reached, for messages. */
  via: string;
  call(method: string, params: unknown): Promise<unknown>;
  close(): void;
}

const RPC_TIMEOUT_MS = 30_000;

class Rpc implements CodexAppServer {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private gone: Error | null = null;

  constructor(readonly via: string, private readonly send: (text: string) => void, readonly close: () => void) {}

  call(method: string, params: unknown): Promise<unknown> {
    if (this.gone) return Promise.reject(this.gone);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, new Error(`${method} got no answer in ${String(RPC_TIMEOUT_MS / 1000)} s`)), RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string): void {
    this.send(JSON.stringify({ method }));
  }

  /** One message from the server. Only answers to our requests count; notifications and server requests are dropped. */
  receive(text: string): void {
    let m: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: unknown } | null } | null;
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || typeof m.id !== 'number' || m.method !== undefined) return;
    this.settle(m.id, m.error ? new Error(String(m.error.message ?? 'error')) : undefined, m.result);
  }

  /** The connection ended: every open request fails, and so does every later one. */
  fail(err: Error): void {
    this.gone ??= err;
    for (const id of [...this.pending.keys()]) this.settle(id, err);
  }

  private settle(id: number, err: Error | undefined, result?: unknown): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (err) p.reject(err);
    else p.resolve(result);
  }
}

/** The managed daemon's socket, from Codex's own passive probe; null when no daemon runs. */
function daemonSocket(): string | null {
  const r = spawnSync('codex', ['app-server', 'daemon', 'version'], { encoding: 'utf8', timeout: 10_000 });
  try {
    const v = JSON.parse(r.stdout) as { status?: unknown; socketPath?: unknown };
    return v.status === 'running' && typeof v.socketPath === 'string' && v.socketPath ? v.socketPath : null;
  } catch {
    return null;
  }
}

async function overSocket(socketPath: string): Promise<Rpc> {
  // Loaded here, not at the top, so a checkout without `npm ci` can still run doctor.ts and be told so.
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false });
  const rpc = new Rpc(`the Codex daemon at ${tilde(socketPath)}`, (text) => ws.send(text), () => ws.close());
  ws.on('message', (data) => rpc.receive(String(data)));
  ws.on('close', () => rpc.fail(new Error('the Codex daemon closed the connection')));
  ws.on('error', (err) => rpc.fail(err));
  // Rejects with the socket's error if it fails before it opens.
  await once(ws, 'open');
  return rpc;
}

function overStdio(): Rpc {
  const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const rpc = new Rpc('`codex app-server` over stdio', (text) => child.stdin.write(`${text}\n`), () => child.kill());
  createInterface({ input: child.stdout }).on('line', (line) => rpc.receive(line));
  child.stdin.on('error', (err) => rpc.fail(err));
  child.on('error', (err) => rpc.fail(err));
  child.on('exit', () => rpc.fail(new Error('codex app-server exited')));
  return rpc;
}

/** An initialized connection, named as Codex's own passive daemon probe is, which leaves the daemon's identity alone. */
export async function openCodexAppServer(): Promise<CodexAppServer> {
  const socket = daemonSocket();
  const rpc = socket ? await overSocket(socket) : overStdio();
  try {
    await rpc.call('initialize', { clientInfo: { name: 'codex_app_server_daemon', title: 'SITREP install', version: release.version }, capabilities: null });
    rpc.notify('initialized');
    return rpc;
  } catch (err) {
    rpc.close();
    throw err;
  }
}

/** A hook as `hooks/list` lists it (codex-rs/app-server-protocol/src/protocol/v2/plugin.rs HookMetadata), the fields used here. */
export interface CodexHook {
  key: string;
  currentHash: string;
  trustStatus: string;
}

/** `plugin`'s hooks as Codex lists them: the keys that start with `<plugin>:`. */
export async function codexHooksOf(server: CodexAppServer, plugin: string): Promise<CodexHook[]> {
  const res = (await server.call('hooks/list', {})) as { data?: { hooks?: CodexHook[] }[] } | null;
  const ours = new Map<string, CodexHook>();
  for (const entry of res?.data ?? []) for (const h of entry.hooks ?? []) if (typeof h.key === 'string' && h.key.startsWith(`${plugin}:`)) ours.set(h.key, h);
  return [...ours.values()];
}

/** The hooks Codex's /hooks screen asks to review (codex-rs/tui/src/hooks_rpc.rs `hook_needs_review`). */
export const needsTrust = (h: CodexHook): boolean => h.trustStatus === 'untrusted' || h.trustStatus === 'modified';

/** What the /hooks screen sends to trust hooks, each at its current hash (codex-rs/tui/src/hooks_rpc.rs `write_hook_trusts`). */
const trustWrite = (hashes: Record<string, string>) => ({
  edits: [{ keyPath: 'hooks.state', value: Object.fromEntries(Object.entries(hashes).map(([key, hash]) => [key, { trusted_hash: hash }])), mergeStrategy: 'upsert' }],
  reloadUserConfig: true,
});

async function trustCodexHooks(plugin: string): Promise<void> {
  let server: CodexAppServer | null = null;
  try {
    server = await openCodexAppServer();
    const hooks = await codexHooksOf(server, plugin);
    if (!hooks.length) throw new Failed(`Codex lists no ${plugin} hooks (through ${server.via}); look for them in Codex's /hooks`);
    const review = hooks.filter(needsTrust);
    if (!review.length) {
      console.log(`    all ${String(hooks.length)} already trusted (${server.via})`);
      return;
    }
    const res = (await server.call('config/batchWrite', trustWrite(Object.fromEntries(review.map((h) => [h.key, h.currentHash]))))) as { filePath?: unknown } | null;
    const file = typeof res?.filePath === 'string' ? tilde(res.filePath) : "Codex's config.toml";
    console.log(`    trusted ${String(review.length)} of ${String(hooks.length)} in ${file} (${server.via})`);
  } catch (err) {
    if (err instanceof Failed) throw err;
    throw new Failed(`could not trust the ${plugin} hooks${server ? ` through ${server.via}` : ''}: ${(err as Error).message}. Trust them in Codex's /hooks instead`);
  } finally {
    server?.close();
  }
}

// ---- Running a plan -----------------------------------------------------------------------------

const shellQuote = (a: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const indent = (text: string): string => text.replace(/\n$/, '').split('\n').map((l) => `      ${l}`).join('\n');

function describe(a: Action): string {
  switch (a.kind) {
    case 'mkdir': return `directory ${tilde(a.path)} (mode ${a.mode.toString(8)})`;
    case 'write': return `write ${tilde(a.path)} (mode ${a.mode.toString(8)})${fs.existsSync(a.path) ? ', replacing the file there' : ''}:\n${indent(a.shown)}`;
    case 'keep': return `keep ${tilde(a.path)} (${a.why})${a.mode === undefined ? '' : `, mode ${a.mode.toString(8)}`}`;
    case 'remove': return `remove ${tilde(a.path)}`;
    case 'rmdir-if-empty': return `remove ${tilde(a.path)} if it is empty`;
    case 'run': return `run: ${a.argv.map(shellQuote).join(' ')}${a.shownInput ? `   (stdin: ${a.shownInput})` : ''}`;
    case 'await-unload': return `wait until launchd has unloaded ${a.target} (launchctl print, once a second, up to ${String(UNLOAD_WAIT_S)} s)`;
    case 'trust-codex-hooks': return `trust the ${a.plugin} hooks Codex lists as untrusted or modified, as its /hooks screen does, through the Codex daemon when one runs, else \`codex app-server\` over stdio:\n${indent(`hooks/list {}\nconfig/batchWrite ${JSON.stringify(trustWrite({ [`${a.plugin}:<hook>`]: '<current hash>' }))}`)}`;
    case 'claude-telemetry': return `${a.set ? 'set' : 'remove'} Claude Code's telemetry settings in ${tilde(CLAUDE_SETTINGS)}, every other setting and hook entry kept:\n${indent(a.shown)}`;
    case 'note': return `note: ${a.text}`;
  }
}

async function perform(a: Action): Promise<void> {
  switch (a.kind) {
    case 'mkdir':
      fs.mkdirSync(a.path, { recursive: true, mode: a.mode });
      fs.chmodSync(a.path, a.mode);
      return;
    case 'write':
      fs.mkdirSync(path.dirname(a.path), { recursive: true });
      fs.writeFileSync(a.path, a.content, { mode: a.mode });
      fs.chmodSync(a.path, a.mode);
      return;
    case 'remove':
      fs.rmSync(a.path, { recursive: true, force: true });
      return;
    case 'rmdir-if-empty':
      try {
        fs.rmdirSync(a.path);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY' || code === 'EEXIST') console.log(`    kept ${tilde(a.path)}: other files are still in it`);
        else if (code !== 'ENOENT') throw err;
      }
      return;
    case 'run': {
      const r = spawnSync(a.argv[0], a.argv.slice(1), {
        input: a.input,
        stdio: [a.input === undefined ? 'inherit' : 'pipe', a.quiet ? 'ignore' : 'inherit', a.quiet ? 'ignore' : 'inherit'],
      });
      if (r.error) {
        if (a.mayFail) return;
        throw new Failed(`could not run ${a.argv[0]}: ${r.error.message}`);
      }
      if (r.status !== 0 && !a.mayFail) throw new Failed(`\`${a.argv.map(shellQuote).join(' ')}\` exited with ${String(r.status ?? r.signal)}`);
      return;
    }
    case 'await-unload':
      for (let waited = 0; ; waited++) {
        const r = spawnSync('launchctl', ['print', a.target], { stdio: 'ignore' });
        if (r.error) throw new Failed(`could not run launchctl: ${r.error.message}`);
        if (r.status !== 0) return;
        if (waited >= UNLOAD_WAIT_S) throw new Failed(`launchd still has ${a.target} loaded after ${String(UNLOAD_WAIT_S)} s; run \`launchctl bootout ${a.target}\`, wait until \`launchctl print ${a.target}\` finds nothing, then run this again`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
    case 'trust-codex-hooks':
      return trustCodexHooks(a.plugin);
    case 'claude-telemetry': {
      let s: Json;
      try {
        s = readClaudeSettings();
      } catch (err) {
        throw new Failed(`${tilde(CLAUDE_SETTINGS)} cannot be read as Claude Code settings (${(err as Error).message})`);
      }
      const before = JSON.stringify(s);
      const env = { ...(s.env as Json | undefined) };
      if (a.set) {
        s.env = Object.assign(env, a.set.env);
        s.otelHeadersHelper = a.set.otelHeadersHelper;
      } else {
        if (!ownsTelemetry(s)) return;
        for (const key of Object.keys(telemetrySettings('').env)) delete env[key];
        delete s.otelHeadersHelper;
        if (Object.keys(env).length) s.env = env;
        else delete s.env;
      }
      // Settings already as wanted: the file is left as it is.
      if (JSON.stringify(s) === before) return;
      // A file this run emptied held only what install added.
      if (!a.set && Object.keys(s).length === 0) fs.rmSync(CLAUDE_SETTINGS, { force: true });
      else {
        fs.mkdirSync(CLAUDE_DIR, { recursive: true });
        // As Claude Code writes it: two-space JSON and a final newline. Written to a temporary file renamed over the old one, so
        // Claude Code never reads half a file, as an atomic write is usually done: a symlink's target is written, and the
        // temporary file is created with an existing file's mode (never wider, since the umask only narrows it), then given
        // that mode exactly.
        const old = fs.statSync(CLAUDE_SETTINGS, { throwIfNoEntry: false });
        const file = old ? fs.realpathSync(CLAUDE_SETTINGS) : CLAUDE_SETTINGS;
        const tmp = `${file}.${String(process.pid)}.tmp`;
        const mode = old ? old.mode & 0o7777 : undefined;
        try {
          fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, mode === undefined ? undefined : { mode });
          if (mode !== undefined) fs.chmodSync(tmp, mode);
          fs.renameSync(tmp, file);
        } catch (err) {
          fs.rmSync(tmp, { force: true });
          throw err;
        }
      }
      return;
    }
    case 'keep':
      if (a.mode !== undefined) fs.chmodSync(a.path, a.mode);
      return;
    case 'note':
      return;
  }
}

/**
 * Prints the plan; with `apply`, carries out each step by itself, in order: a step with a blocker is left out, and one whose
 * action fails stops there, while the steps after it still run, unless it is their `prerequisite`. Returns the exit code, 1
 * when any step was left out or failed.
 */
export async function runPlan(steps: Step[], apply: boolean, name: string): Promise<number> {
  console.log(apply ? `${name}: applying.` : `${name}: dry run, nothing is changed. Re-run with --apply to make these changes.`);
  const undone: string[] = [];
  let needed: string | null = null;
  for (const step of steps) {
    console.log(`\n== ${step.title}`);
    const blockers = needed === null ? step.blockers : [...step.blockers, `needs ${needed} first`];
    for (const b of blockers) console.log(`  blocked: ${b}`);
    undone.push(...blockers.map((b) => `${step.title}: ${b}`));
    let done = blockers.length === 0;
    // Applying, a step left out lists no actions, as none is taken; the dry run lists them.
    for (const a of apply && !done ? [] : step.actions) {
      console.log(`  ${describe(a)}`);
      if (!apply) continue;
      try {
        await perform(a);
      } catch (err) {
        const why = err instanceof Failed ? err.message : String(err);
        console.error(`  failed: ${why}`);
        undone.push(`${step.title}: failed, after the actions above it were done: ${why}`);
        done = false;
        break;
      }
    }
    if (!done && step.prerequisite) needed = step.title;
  }
  if (undone.length) {
    console.error(`\n${name}: ${apply ? 'not done; fix these, then run it again' : 'blocked, so --apply leaves these out'}:\n${undone.map((u) => `  - ${u}`).join('\n')}`);
    return 1;
  }
  console.log(apply ? `\n${name}: done.` : `\n${name}: dry run only; add --apply to make these changes.`);
  return 0;
}

// ---- CLI ------------------------------------------------------------------------------------------

/** The command line, read by Node's own parser, which refuses an unknown option, a missing value and a stray argument. */
function readArgs(argv: string[]): (InstallOptions & { apply: boolean; tokenStdin: boolean }) | 'help' {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      server: { type: 'boolean' },
      claude: { type: 'boolean' },
      codex: { type: 'boolean' },
      url: { type: 'string' },
      bind: { type: 'string' },
      port: { type: 'string' },
      'token-stdin': { type: 'boolean' },
      apply: { type: 'boolean' },
    },
  });
  if (v.help) return 'help';
  const url = v.url === undefined ? null : v.url.replace(/\/+$/, '');
  if (url !== null && !/^https?:\/\/[^\s/]+$/.test(url)) throw new Error(`--url must be http:// or https:// and a host, such as http://192.0.2.10:7487, not "${url}"`);
  const port = v.port === undefined ? null : Number(v.port);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('--port must be a whole number from 1 to 65535');
  const [server, claude, codex] = [v.server, v.claude, v.codex].map(Boolean);
  if (!server && !claude && !codex) throw new Error('name what to install: --server, --claude and/or --codex');
  if (!server && (v.bind !== undefined || port !== null)) throw new Error('--bind and --port set where the server listens and need --server; to point the reporters at a server, use --url');
  return { server, claude, codex, url, bind: v.bind ?? null, port, secret: null, apply: Boolean(v.apply), tokenStdin: Boolean(v['token-stdin']) };
}

async function main(): Promise<number> {
  let o: ReturnType<typeof readArgs>;
  try {
    o = readArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`install: ${(err as Error).message} (see --help)`);
    return 2;
  }
  if (o === 'help') {
    console.log(HELP.replace('<repo>', REPO_ROOT));
    return 0;
  }
  if (o.tokenStdin) {
    const secret = fs.readFileSync(0, 'utf8').trim();
    if (!secret || /\s/.test(secret)) {
      console.error('install: --token-stdin read no secret (or one with spaces in it) from stdin');
      return 2;
    }
    o.secret = secret;
  }
  return runPlan(installPlan(o), o.apply, 'install');
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = await main();
