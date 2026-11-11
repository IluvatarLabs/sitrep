#!/usr/bin/env -S npx tsx
// SITREP uninstall: removes what scripts/install.ts added, and nothing else. It stops each service and deletes
// its unit, and deletes data only when asked (--purge).
//
// Dry run by default; --apply carries it out. The plugins are removed with the `claude` and `codex` plugin commands, which
// delete their own marketplace, enable and option entries; Claude Code's telemetry keys that install set in its user settings
// are removed while they still run our helper; no hook entry in ~/.claude/settings.json or ~/.codex/hooks.json is touched.
// Configs, the telemetry token file, the database, logs, the codex-reporter state and the Codex hook spool are deleted only
// with --purge. The machine id is never deleted: a new id would make the server list a reinstalled machine twice.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  CLAUDE_SETTINGS,
  CODEX_REPORTER,
  DATA_HOME,
  DB_DIR,
  MACHINE_ID_FILE,
  OTEL_TOKEN,
  REPORTER_ENV,
  SERVER,
  SERVER_ENV,
  claudeMarket,
  codexMarket,
  disableService,
  ownsTelemetry,
  readClaudeSettings,
  runPlan,
  telemetrySettings,
  tilde,
  type Action,
  type Step,
} from './install.ts';

const HELP = `uninstall: remove what scripts/install.ts set up on this machine.

Usage: npx tsx scripts/uninstall.ts <component...> [--purge] [--apply]

Dry run by default: prints every file it would delete and every command it would run, and changes nothing.
Add --apply to make the changes.

Components (name at least one):
  --server    Stop the server's user service and delete its unit
  --claude    Uninstall the sitrep-reporter plugin and remove this repository's Claude plugin marketplace;
              remove the telemetry settings install added to ~/.claude/settings.json
  --codex     Uninstall the sitrep-codex plugin, remove this repository's Codex plugin marketplace, stop
              the codex-reporter user service and delete its unit

Options:
  --purge     Also delete the named components' data: the server's config and database (dashboard history), the
              codex-reporter config and saved state, the telemetry token file, the service logs and the Codex hook
              spool in ~/.sitrep
  --apply     Make the changes
  -h, --help  Show this help

The machine id file the reporters share is kept, so a reinstalled machine keeps its row in the dashboard; Remove takes
a machine off the dashboard (Machines). Provider sessions, transcripts and session files are never touched.`;

interface UninstallOptions {
  server: boolean;
  claude: boolean;
  codex: boolean;
  purge: boolean;
}

/** Deletes each path that exists; with no --purge, says what is kept, and `ifKept` when that is not nothing. */
function purgeActions(o: UninstallOptions, paths: string[], what: string, ifKept = ''): Action[] {
  const present = paths.filter((p) => fs.existsSync(p));
  if (present.length === 0) return [];
  if (!o.purge) return [{ kind: 'note', text: `Kept ${what}: ${present.map(tilde).join(', ')} (add --purge to delete).${ifKept}` }];
  return present.map((p): Action => ({ kind: 'remove', path: p }));
}

/**
 * Claude Code's telemetry as install set it: its keys in the user settings, while otelHeadersHelper still runs our helper (other
 * telemetry settings are not ours and stay).
 */
function telemetryRemoval(): { blockers: string[]; actions: Action[] } {
  let s: Record<string, unknown>;
  try {
    s = readClaudeSettings();
  } catch (err) {
    return { blockers: [`${tilde(CLAUDE_SETTINGS)} cannot be read as Claude Code settings (${(err as Error).message}); fix it, then run this again`], actions: [] };
  }
  const env = (s.env ?? {}) as Record<string, unknown>;
  const actions: Action[] = ownsTelemetry(s)
    ? [{ kind: 'claude-telemetry', set: null, shown: [...Object.keys(telemetrySettings('').env).filter((k) => k in env).map((k) => `env.${k}`), 'otelHeadersHelper'].join('\n') }]
    : [{ kind: 'note', text: `${tilde(CLAUDE_SETTINGS)} holds no telemetry settings of ours (its otelHeadersHelper runs neither scripts/claude-otel-headers.sh nor the older .mjs); nothing in it is changed.` }];
  return { blockers: [], actions };
}

function uninstallPlan(o: UninstallOptions): Step[] {
  const steps: Step[] = [];
  if (o.server) {
    steps.push({
      title: 'Server',
      blockers: [],
      actions: [
        ...disableService(SERVER),
        // install reads a kept server.env as a server on this machine and points local reporters at it.
        ...purgeActions(o, [SERVER_ENV, DB_DIR, SERVER.log], 'the server config, database and log', fs.existsSync(SERVER_ENV)
          ? ` While ${tilde(SERVER_ENV)} stays, install still treats this machine as a server host: a later install --claude or --codex without --url points those reporters at this machine's old server address. --purge, or --url on that install, avoids it.`
          : ''),
      ],
    });
  }
  if (o.codex) {
    const market = codexMarket();
    steps.push({
      title: 'Codex',
      blockers: [],
      actions: [
        ...disableService(CODEX_REPORTER),
        // A failure here is usually "not installed"; the next command still runs.
        { kind: 'run', argv: ['codex', 'plugin', 'remove', market.plugin], mayFail: true },
        { kind: 'run', argv: ['codex', 'plugin', 'marketplace', 'remove', market.name], mayFail: true },
        // Codex keys each hook's trust as <plugin>@<marketplace>:<hooks file>:<event>:<group>:<handler> (codex-rs/hooks
        // declarations.rs, lib.rs hook_key) and pins a content baseline per plugin in .hook-trust (plugin_trust.rs).
        { kind: 'note', text: `The hooks' trust stays in Codex's own files: in ~/.codex/config.toml under [hooks.state], in the keys that start with "${market.plugin}:", and in a baseline file in ~/.codex/.hook-trust/. Neither does anything once the plugin is gone; delete the [hooks.state] entries by hand if you want them gone too.` },
        ...purgeActions(
          o,
          [REPORTER_ENV, path.join(DATA_HOME, 'codex-reporter-state.json'), CODEX_REPORTER.log, path.join(DATA_HOME, 'codex-hooks.ndjson'), path.join(DATA_HOME, 'codex-hooks.ndjson.1')],
          'the codex-reporter config, saved state, log and hook spool',
        ),
      ],
    });
  }
  if (o.claude) {
    const market = claudeMarket();
    const telemetry = telemetryRemoval();
    steps.push({
      title: 'Claude Code',
      blockers: telemetry.blockers,
      actions: [
        ...telemetry.actions,
        // Uninstalling also deletes the plugin's saved options, the server URL and the secret.
        { kind: 'run', argv: ['claude', 'plugin', 'uninstall', market.plugin, '--scope', 'user'], mayFail: true },
        { kind: 'run', argv: ['claude', 'plugin', 'marketplace', 'remove', market.name, '--scope', 'user'], mayFail: true },
        { kind: 'note', text: 'Running sessions drop the plugin at their next start or /reload-plugins, and their telemetry once restarted (resumed): Claude Code reads its telemetry settings at start.' },
        ...purgeActions(o, [OTEL_TOKEN], 'the telemetry token file'),
      ],
    });
  }
  // Both reporters keep one machine id in the Claude config folder. It stays: with a new one, a reinstall would report as a
  // second machine.
  const shared: Action[] = [];
  if ((o.claude || o.codex) && fs.existsSync(MACHINE_ID_FILE)) shared.push({ kind: 'note', text: `Kept the machine id ${tilde(MACHINE_ID_FILE)}.` });
  if (o.purge) shared.push({ kind: 'rmdir-if-empty', path: DATA_HOME });
  if (shared.length) steps.push({ title: 'Shared', blockers: [], actions: shared });
  return steps;
}

/** The command line, read by Node's own parser, which refuses an unknown option and a stray argument. */
function readArgs(argv: string[]): (UninstallOptions & { apply: boolean }) | 'help' {
  const flag = { type: 'boolean' } as const;
  const { values: v } = parseArgs({ args: argv, options: { help: { ...flag, short: 'h' }, server: flag, claude: flag, codex: flag, purge: flag, apply: flag } });
  if (v.help) return 'help';
  const [server, claude, codex, purge, apply] = [v.server, v.claude, v.codex, v.purge, v.apply].map(Boolean);
  if (!server && !claude && !codex) throw new Error('name what to remove: --server, --claude and/or --codex');
  return { server, claude, codex, purge, apply };
}

async function main(): Promise<number> {
  let o: ReturnType<typeof readArgs>;
  try {
    o = readArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`uninstall: ${(err as Error).message} (see --help)`);
    return 2;
  }
  if (o === 'help') {
    console.log(HELP);
    return 0;
  }
  return runPlan(uninstallPlan(o), o.apply, 'uninstall');
}

process.exitCode = await main();
