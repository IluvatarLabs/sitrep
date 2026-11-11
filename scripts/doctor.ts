#!/usr/bin/env -S npx tsx
// SITREP doctor: read-only checks of this machine.
// Node, the clone and its build, the Claude and Codex plugins, Claude Code's telemetry, the codex-reporter service, the server
// each reporter sends to, whether it takes their admin secret and whether the versions fit, and the machine id. Each problem
// prints the command that fixes it.
//
// It changes nothing: it reads files, runs `--version` and list commands and the telemetry headers helper (its output, which
// holds the secret, is never printed), asks Codex's app-server for `hooks/list` (the daemon when one runs, else a private
// `codex app-server`), reads the server's /api/fleet/state, and asks it for an answer to no session (checkSecrets).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MACHINE_HEADER, TOKEN_HEADER, VIEW_GATED, type ReporterName, type StateBody } from '../server/src/fleet/protocol.ts';
import {
  CLAUDE_DEFAULT_URL as DEFAULT_URL,
  CLAUDE_SETTINGS,
  CODEX_REPORTER,
  MACHINE_ID_FILE,
  PLATFORM,
  REPO_ROOT,
  REPORTER_ENV,
  SERVER,
  SERVER_ENV,
  claudeMarket,
  claudePluginOptions,
  claudePluginUrl,
  codexHooksOf,
  codexMarket,
  envValue,
  localServerUrl,
  needsTrust,
  nodeAtLeast,
  openCodexAppServer,
  ownsTelemetry,
  readClaudeSettings,
  serviceFile,
  telemetrySettings,
  tilde,
  uid,
  type Service,
} from './install.ts';

const HELP = `doctor: check this machine's SITREP setup. Changes nothing.

Usage: npx tsx scripts/doctor.ts

Checks Node, the clone and its build, the Claude Code plugin and Claude Code's telemetry, the Codex plugin and its hook
trust, the codex-reporter service, the server each reporter sends to, whether it takes their admin secret and whether the
versions fit, and the machine id. Each problem prints the command that fixes it. Exits 1 when there is a problem.`;

let problems = 0;
const ok = (text: string): void => console.log(`  ✓ ${text}`);
const skip = (text: string): void => console.log(`  - ${text}`);
/** A problem: counted, and its fix printed. */
const bad = (text: string, fix: string): void => {
  problems++;
  console.log(`  ✗ ${text}\n      fix: ${fix}`);
};
/** Expected before the first session (nothing has reported yet): shown with its fix, not counted. */
const notYet = (text: string, fix: string): void => console.log(`  ! ${text}\n      fix: ${fix}`);

/** A command's stdout, or null when it could not run or failed. */
function run(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? r.stdout : null;
}

/** The version number in a `--version` line ("2.1.310 (Claude Code)", "codex-cli 0.164.0"); null when it did not run. */
const versionOf = (out: string | null): string | null => (out === null ? null : (/\d+\.\d+\.\d+\S*/.exec(out)?.[0] ?? out.trim()));

function json<T>(text: string | null): T | null {
  try {
    return text === null ? null : (JSON.parse(text) as T);
  } catch {
    return null;
  }
}

const restart = (svc: Service): string => (PLATFORM === 'launchd' ? `launchctl kickstart -k gui/${String(uid())}/${svc.label}` : `systemctl --user restart ${svc.unit}`);
const logs = (svc: Service): string => (PLATFORM === 'launchd' ? `tail -n 50 ${tilde(svc.log)}` : `journalctl --user -u ${svc.unit} -e`);

function running(svc: Service): boolean {
  if (PLATFORM === 'launchd') return /\bstate = running\b/.test(run('launchctl', ['print', `gui/${String(uid())}/${svc.label}`]) ?? '');
  return run('systemctl', ['--user', 'is-active', svc.unit])?.trim() === 'active';
}

async function main(): Promise<number> {
  try {
    if (parseArgs({ args: process.argv.slice(2), options: { help: { type: 'boolean', short: 'h' } } }).values.help) {
      console.log(HELP);
      return 0;
    }
  } catch (err) {
    console.error(`doctor: ${(err as Error).message} (see --help)`);
    return 2;
  }

  const serverHere = fs.existsSync(SERVER_ENV);
  const claudeVersion = versionOf(run('claude', ['--version']));
  const codexVersion = versionOf(run('codex', ['--version']));
  const codexHere = codexVersion !== null || fs.existsSync(REPORTER_ENV);
  // How a reporter here is (re)installed: on the server machine it finds the server and its secret itself.
  const install = (flag: string): string => (serverHere ? `npx tsx scripts/install.ts ${flag} --apply` : `npx tsx scripts/install.ts ${flag} --url <server URL> --token-stdin --apply (README: Add a machine)`);
  /**
   * Each server URL a reporter here sends to, with who sends there and the admin secret its config here gives, which checkServer
   * sends so it passes "Require sign-in to view" and checks. Only the config that names the URL gives its secret, so
   * no server is sent another's. Never printed.
   */
  const servers = new Map<string, Sender[]>();
  const sendsTo = (url: string, who: string, secret: string | null, none = ''): void => void servers.set(url, [...(servers.get(url) ?? []), { who, secret, none }]);

  console.log(`doctor: ${os.hostname()}, clone ${tilde(REPO_ROOT)}\n`);

  // Node, the clone and the build.
  const need = serverHere ? SERVER.minNode : CODEX_REPORTER.minNode;
  if (nodeAtLeast(need)) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node}; ${serverHere ? 'the server' : 'codex-reporter'} needs ${need} or later`, `nvm install ${need.split('.')[0] ?? need}`);
  if (fs.existsSync(path.join(REPO_ROOT, 'node_modules'))) ok('Dependencies installed');
  else bad('Dependencies not installed', 'npm ci');
  const builds = [
    ...(serverHere ? [{ what: 'server', file: SERVER.entry, cmd: 'npm run build' }, { what: 'dashboard', file: path.join(REPO_ROOT, 'frontend', 'dist', 'index.html'), cmd: 'npm run build' }] : []),
    ...(codexHere ? [{ what: 'codex-reporter', file: CODEX_REPORTER.entry, cmd: 'npm run build -w codex-reporter' }] : []),
  ];
  const unbuilt = builds.filter((b) => !fs.existsSync(b.file));
  if (unbuilt.length) bad(`Not built: ${unbuilt.map((b) => b.what).join(', ')}`, [...new Set(unbuilt.map((b) => b.cmd))].join(' && '));
  else if (builds.length) ok(`Built: ${builds.map((b) => b.what).join(', ')}`);

  // Claude Code.
  if (claudeVersion === null) skip('Claude Code not found');
  else {
    const id = claudeMarket().plugin;
    const list = json<unknown>(run('claude', ['plugin', 'list', '--json']));
    const entry = (Array.isArray(list) ? (list as { id?: unknown; enabled?: unknown; errors?: unknown }[]) : []).find((p) => p.id === id);
    if (!entry) bad(`Claude plugin ${id} not installed`, install('--claude'));
    else if (entry.enabled !== true) bad(`Claude plugin ${id} disabled`, `claude plugin enable ${id}`);
    else if (Array.isArray(entry.errors) && entry.errors.length) bad(`Claude plugin ${id} failed to load: ${String(entry.errors[0])}`, install('--claude'));
    else {
      const options = claudePluginOptions(id);
      const holds = Array.isArray(options?.configured) && options.configured.includes('token');
      if (!options) bad(`Claude plugin ${id}: could not read its options (Claude Code ${claudeVersion})`, 'claude update');
      else if (!holds) bad(`Claude plugin ${id} has no admin secret`, install('--claude'));
      else ok(`Claude plugin ${id} (Claude Code ${claudeVersion})`);
      const url = claudePluginUrl(options);
      sendsTo(url, 'Claude plugin', null, !options ? 'its options could not be read' : holds ? 'Claude Code keeps it in its secure store, which doctor cannot read' : 'it holds none');
      // The telemetry's copy, from its helper, can be checked.
      const telemetrySecret = checkTelemetry(url, install('--claude'));
      if (telemetrySecret) sendsTo(url, 'Claude Code telemetry', telemetrySecret);
    }
  }

  // Codex.
  if (!codexHere) skip('Codex not found');
  else if (codexVersion === null) bad('codex not found on this PATH, but codex-reporter is set up', 'put codex on the PATH, then npx tsx scripts/install.ts --codex --apply');
  else {
    const id = codexMarket().plugin;
    try {
      const server = await openCodexAppServer();
      try {
        const hooks = await codexHooksOf(server, id);
        const review = hooks.filter(needsTrust);
        if (!hooks.length) bad(`Codex plugin ${id} not installed (Codex lists none of its hooks)`, install('--codex'));
        else if (review.length) bad(`Codex hooks not trusted: ${String(review.length)} of ${String(hooks.length)}`, install('--codex'));
        else ok(`Codex plugin ${id}, ${String(hooks.length)} hooks trusted (Codex ${codexVersion})`);
      } finally {
        server.close();
      }
    } catch (err) {
      bad(`Could not read Codex's hooks: ${(err as Error).message}`, "open Codex and check /hooks");
    }
    const env = fs.existsSync(REPORTER_ENV) ? fs.readFileSync(REPORTER_ENV, 'utf8') : null;
    if (env === null) bad(`No codex-reporter config (${tilde(REPORTER_ENV)})`, install('--codex'));
    else {
      if (!envValue(env, 'CODEX_REPORTER_TOKEN')) bad('codex-reporter has no admin secret', install('--codex'));
      sendsTo((envValue(env, 'CODEX_REPORTER_SERVER_URL') || DEFAULT_URL).replace(/\/+$/, ''), 'codex-reporter', envValue(env, 'CODEX_REPORTER_TOKEN'), 'its config holds none');
    }
    if (!PLATFORM || !fs.existsSync(serviceFile(CODEX_REPORTER))) bad('codex-reporter service not installed', install('--codex'));
    else if (running(CODEX_REPORTER)) ok('codex-reporter running');
    else bad('codex-reporter not running', `${restart(CODEX_REPORTER)}; logs: ${logs(CODEX_REPORTER)}`);
  }

  // The machine id, and the servers the reporters send to. A missing file is made by the next reporter to start; no
  // reporter makes a new id over one that is there but cannot be read or holds no id.
  let idText: string | null = null;
  let idUnread: string | null = null;
  try {
    idText = fs.readFileSync(MACHINE_ID_FILE, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') idUnread = code ?? (err as Error).message;
  }
  const machineId = idText?.trim().match(/^[0-9a-f]{8,32}$/)?.[0] ?? null;
  if (serverHere) {
    const url = localServerUrl({ server: false, bind: null, port: null });
    if (url) sendsTo(url, 'this machine\'s server', envValue(fs.readFileSync(SERVER_ENV, 'utf8'), 'SITREP_TOKEN'), 'its server.env sets none');
  }
  for (const [url, senders] of servers) await checkServer(url, senders, machineId, serverHere);

  const idRow = 'docs/OPERATIONS.md#troubleshooting ("Nothing reports from a machine")';
  if (machineId) ok(`Machine id ${machineId} (${tilde(MACHINE_ID_FILE)})`);
  else if (idUnread !== null || idText !== null) bad(`${tilde(MACHINE_ID_FILE)} ${idUnread === null ? 'holds no machine id' : `cannot be read (${idUnread})`}`, `fix its permission or delete it; a new id makes a new machine row (${idRow})`);
  else if (claudeVersion !== null || codexHere) notYet(`No machine id yet (${tilde(MACHINE_ID_FILE)})`, `start codex-reporter or a Claude Code session; either creates it (${idRow})`);

  console.log(problems ? `\n${String(problems)} problem${problems === 1 ? '' : 's'}.` : '\nNo problems.');
  return problems ? 1 : 0;
}

/**
 * Claude Code's telemetry, which carries this machine's Claude usage to the dashboard: the settings install sets (the helper a
 * re-run of install writes included), sending to where the plugin reports, and its headers helper run as Claude Code runs it.
 * Returns the admin secret the helper sends, never printed; null when it sends none or did not run.
 */
function checkTelemetry(url: string, fix: string): string | null {
  let s: Record<string, unknown>;
  try {
    s = readClaudeSettings();
  } catch (err) {
    bad(`${tilde(CLAUDE_SETTINGS)} cannot be read as Claude Code settings: ${(err as Error).message}`, `fix the file, then ${fix}`);
    return null;
  }
  if (!ownsTelemetry(s)) {
    bad('Claude Code telemetry not set up: the usage and spend of this machine\'s Claude sessions do not reach the dashboard', fix);
    return null;
  }
  const want = telemetrySettings(url);
  const env = (s.env ?? {}) as Record<string, unknown>;
  const off = [...Object.keys(want.env).filter((k) => env[k] !== want.env[k]), ...(s.otelHeadersHelper === want.otelHeadersHelper ? [] : ['otelHeadersHelper'])];
  if (off.length) {
    bad(`Claude Code telemetry settings are not what install sets for ${url}: ${off.join(', ')}`, fix);
    return null;
  }
  if (!fs.existsSync(MACHINE_ID_FILE)) {
    notYet('Claude Code telemetry set up; it sends once the machine id exists (below)', 'start a Claude Code session');
    return null;
  }
  const r = spawnSync(String(s.otelHeadersHelper), { shell: true, encoding: 'utf8', timeout: 10_000 });
  const headers = r.status === 0 ? json<Record<string, unknown>>(r.stdout) : null;
  const secret = headers?.[TOKEN_HEADER];
  if (typeof headers?.[MACHINE_HEADER] !== 'string') bad(`Claude Code telemetry headers helper failed: ${r.stderr?.trim() || `exit ${String(r.status ?? r.signal)}`}`, `fix what it names; the helper runs as ${String(s.otelHeadersHelper)}`);
  else if (typeof secret !== 'string') bad('Claude Code telemetry sends no admin secret', fix);
  else {
    ok(`Claude Code telemetry to ${want.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT}`);
    return secret;
  }
  return null;
}

/** A reporter here, and the admin secret its config here gives for the server it sends to, or why doctor has none. */
interface Sender {
  who: string;
  secret: string | null;
  none: string;
}

/** The server answers /api/fleet/state, takes the reporters' admin secret, and this machine's reporter versions, as the server
 * judges them for Machines (MachineView.reporters), fit its supported ranges. */
async function checkServer(url: string, senders: Sender[], machineId: string | null, serverHere: boolean): Promise<void> {
  const label = `Server ${url} (${senders.map((s) => s.who).join(', ')})`;
  // The last one given: on the server's machine, its own.
  const secret = senders.findLast((s) => s.secret)?.secret ?? null;
  let state: StateBody;
  try {
    // The whole state, over whatever link this machine has: on a phone hotspot it can take over 5 seconds.
    const res = await fetch(`${url}/api/fleet/state`, { headers: secret ? { [TOKEN_HEADER]: secret } : {}, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 && ((await res.clone().json().catch(() => null)) as { error?: unknown } | null)?.error === VIEW_GATED) {
      if (secret) bad(`${label}: "Require sign-in to view" is on and the server refused this machine's admin secret`, 'put the server\'s current secret on this machine (README: Add a machine)');
      else {
        ok(`${label}: reachable; "Require sign-in to view" is on and doctor has no admin secret to send, so reporter versions were not checked`);
        await checkSecrets(url, senders);
      }
      return;
    }
    if (!res.ok) {
      const fix = res.status === 403 ? 'add the host name to SITREP_ALLOWED_HOSTS in the server\'s server.env, or use its IP address' : 'run npx tsx scripts/doctor.ts on the server';
      bad(`${label}: HTTP ${String(res.status)}`, fix);
      return;
    }
    state = (await res.json()) as StateBody;
  } catch (err) {
    bad(`${label}: no answer (${(err as Error).message})`, serverHere ? `${restart(SERVER)}; logs: ${logs(SERVER)}` : 'check the network or the tunnel, then run npx tsx scripts/doctor.ts on the server');
    return;
  }
  ok(`${label}, version ${state.server.version}`);
  await checkSecrets(url, senders);
  if (!machineId) return;
  const row = state.machines.find((m) => m.id === machineId);
  if (!row) {
    notYet(`No report from this machine at ${url} yet`, 'start a session; if it still does not appear, see docs/OPERATIONS.md#troubleshooting');
    return;
  }
  // Claude: the machine's Update command, whose installer runs `claude plugin update` (install.ts), then a restart, which that
  // command itself asks for ("Restart to apply changes"); as Machines gives it.
  const update = { claude: 'git pull && npm ci && npx tsx scripts/install.ts --claude --apply, then restart (resume) open Claude Code sessions', codex: `git pull && npm ci && npm run build -w codex-reporter && ${restart(CODEX_REPORTER)}` };
  for (const provider of ['claude', 'codex'] as const) {
    const r = row.reporters[provider];
    if (r === null) continue;
    const name: ReporterName = `${provider}-reporter`;
    const range = state.server.reporterSupport[name];
    const seen = `${name} ${r.version}`;
    // As Machines shows it: a version no live session reports is muted, never a problem.
    if (!r.live) skip(`${seen}, last reported`);
    else if (r.compat === 'outdated') bad(`${seen} is older than the server reads (${range.min} to ${range.max})`, update[provider]);
    else if (r.compat === 'newer') bad(`${seen} is newer than the server reads (${range.min} to ${range.max})`, 'upgrade the server first: docs/OPERATIONS.md#upgrade');
    else if (r.compat === 'ok') ok(`${seen} fits the server`);
    else skip(`${seen}: the server cannot place it in ${range.min} to ${range.max}`);
  }
}

/**
 * Whether the server takes each admin secret the reporters here send it, by the check a report passes (routes.ts tokenCheck),
 * asked on the one read behind it: a reporter's wait for an answer (respondRoutes.ts), for a session id no session has (each
 * server id holds `@`, protocol.ts sessionKey). So it is answered at once and adds no session, machine or counted refusal, but
 * the server logs a line for a wrong secret, and on every run while answering is off (respondRoutes.ts reporterSession). 401 is
 * that check's refusal; 404 (no such session), or 403 while answering is off, is past it.
 */
async function checkSecrets(url: string, senders: Sender[]): Promise<void> {
  const bySecret = new Map<string, string[]>();
  for (const s of senders) {
    if (s.secret) bySecret.set(s.secret, [...(bySecret.get(s.secret) ?? []), s.who]);
    else skip(`${url}: the admin secret of ${s.who} not checked: ${s.none}`);
  }
  for (const [secret, who] of bySecret) {
    const whose = `the admin secret of ${who.join(', ')}`;
    try {
      const { status } = await fetch(`${url}/api/fleet/sessions/doctor/asks/doctor/answer`, { headers: { [TOKEN_HEADER]: secret }, signal: AbortSignal.timeout(15_000) });
      if (status === 401) bad(`${url} refuses ${whose}`, 'put the server\'s current secret on this machine (README: Add a machine)');
      else if (status === 404 || status === 403) ok(`${url} takes ${whose}`);
      else bad(`${url}: ${whose} could not be checked (HTTP ${String(status)})`, 'run npx tsx scripts/doctor.ts on the server');
    } catch (err) {
      bad(`${url}: ${whose} could not be checked: no answer (${(err as Error).message})`, 'check the network or the tunnel, then run npx tsx scripts/doctor.ts again');
    }
  }
}

process.exitCode = await main();
