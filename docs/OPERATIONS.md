# Operations

How to run SITREP: the server on an always-on machine, the reporters on each machine. The README has the short version.

Contents:

- [What runs where](#what-runs-where)
- [Deploy the server](#deploy-the-server)
- [Add a machine](#add-a-machine)
- [Hermes](#hermes)
- [In a Claude Code session](#in-a-claude-code-session)
- [Ports](#ports)
- [Settings](#settings)
- [Files and services](#files-and-services)
- [Security: one owner, one secret](#security-one-owner-one-secret)
- [Back up and restore](#back-up-and-restore)
- [Upgrade](#upgrade)
- [Codex hook trust](#codex-hook-trust)
- [Off the LAN](#off-the-lan)
- [Check a machine](#check-a-machine)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

## What runs where

| Where | What | Started by |
|---|---|---|
| The server machine (always on) | The server: one Node 24 process, SQLite, the dashboard on port 4317 | A user service: systemd `--user` with linger |
| Every machine with Claude Code | The plugin `sitrep-reporter`, inside each Claude Code session (state, asks, answers); and Claude Code's own telemetry, which carries the sessions' usage | Claude Code, from this repository's plugin marketplace; the telemetry, from the settings the install writes |
| Every machine with Codex | The Codex plugin `sitrep-codex` (hooks that write a local spool) and the `codex-reporter` process (reads the spool, the session files and the Codex daemon; sends the reports) | Codex, from this repository's plugin marketplace; a user service |

Reporters push to one URL, so the server lives on the machine that is always on. While the
server cannot be reached, a reporter keeps each session's latest state and up to 500 events (the oldest are dropped)
and sends them when it is back; sessions that start and end during the gap, chart samples and live visibility are lost.
Claude Code's telemetry keeps no batch it failed to send, so a Claude session's usage during the gap is lost too.
Moving the server is a change of URL in each reporter.

## Deploy the server

1. **Node 24.** The server needs Node 24 (it uses the built-in `node:sqlite`). If the machine has an older Node,
   install Node 24 for your user, for example with nvm (`nvm install 24`).
2. **A built clone.**

   ```sh
   git clone https://github.com/IluvatarLabs/sitrep ~/sitrep && cd ~/sitrep
   npm ci
   npm run build
   ```

3. **Install the service.** Look at the dry run, then apply it:

   ```sh
   npx tsx scripts/install.ts --server --bind 0.0.0.0
   npx tsx scripts/install.ts --server --bind 0.0.0.0 --apply
   ```

   It writes `~/.sitrep/server.env` (mode 0600) from `scripts/server.env.example` with a new admin secret
   and the database path, writes `~/.config/systemd/user/sitrep.service`, and enables and starts it. The unit
   runs `node --env-file=~/.sitrep/server.env server/dist/index.js` with the Node that ran the install.
4. **Linger.** Without it the user service stops when you log out and starts only when you log in:

   ```sh
   loginctl enable-linger $USER
   ```

5. **Firewall.** Allow TCP 4317 from the LAN only, for example `sudo ufw allow from 192.0.2.0/24 to any port 4317 proto tcp`.
6. **Host names.** The server refuses a request whose `Host` it does not expect (a guard against DNS rebinding). With
   `--bind 0.0.0.0`, any IP address works, so `http://192.0.2.10:4317` works as is. To use a name such as
   `http://server:4317`, add it to `SITREP_ALLOWED_HOSTS` in `server.env` and restart.
7. **Check it.**

   ```sh
   systemctl --user status sitrep
   curl -s -o /dev/null -w '%{http_code}\n' http://192.0.2.10:4317/api/fleet/state    # 200
   ```

   Then open `http://192.0.2.10:4317` from the laptop.

On macOS, the same install writes `~/Library/LaunchAgents/dev.sitrep.server.plist` instead and loads it with
`launchctl`; it starts at login and its output goes to `~/.sitrep/server.log`.

## Add a machine

In the dashboard, Machines → Add a machine (or "+" beside Machines in the sidebar) gives these steps for the OS (macOS,
Linux) and harnesses (Claude Code, Codex) you pick, each with Copy: the clone; the install with `--url` set to the
address you opened the dashboard at, `--token-stdin` and `--apply` (paste the admin secret, then Ctrl-D); the Codex
hooks, which the install trusts; on Linux with Codex, linger; and, for Claude Code sessions already open, quit each and
resume it (`claude --resume`) so it sends its usage. "Waiting for the first report…" turns into "✓ <name> reported"
when the new machine reports.

Every machine that runs sessions needs a clone of this repository with `npm ci` run in it. The Claude Code plugin runs
from the clone; for Codex, also build the reporter (`npm run build -w codex-reporter`; it needs Node 22.15 or later).
Then:

```sh
ssh server "sed -n 's/^SITREP_TOKEN=//p' ~/.sitrep/server.env" \
  | npx tsx scripts/install.ts --claude --codex --url http://192.0.2.10:4317 --token-stdin
```

Check the dry run, then run it again with `--apply`. Leave out `--claude` or `--codex` for a machine without that tool.
On the server machine itself, leave out `--url` and `--token-stdin`: the reporters then send to the local server, by
the rule below, with the secret from the local `server.env`.

**Which URL the local reporters get.** With `--url`, both reporters use it. Without it, on a machine with a server
config (`--server` in this run, or `~/.sitrep/server.env` already there), every run that configures the reporters sets
them to that server's address, replacing a saved URL: the host is this run's `--bind`, else the saved `HOST`, else
`127.0.0.1`, and the port is this run's `--port`, else the saved `PORT`, else `4317`. `--bind` and `--port` set where
the server listens, so the install takes them only with `--server` and refuses them otherwise; to point the reporters
at a server, use `--url`. A server bound to `0.0.0.0` or `::` is reached at `127.0.0.1`; one bound to a specific address
(`localhost`, `::1`, any `127.x`, or a LAN address such as `192.0.2.10`) is reached at that address (an IPv6 address in
brackets). On a machine without a server config, a reporter set up for the first time sends to `http://127.0.0.1:4317`
and one set up before keeps its URL: pass `--url` there. When the reporters send to a LAN address over plain HTTP,
Claude Code on that machine shows its plain-HTTP warning (`⚠` in the status line and a toast); `--bind 0.0.0.0`, as in
[Deploy](#deploy-the-server), keeps them on `127.0.0.1` without it.

What the install does, and nothing more:

- **Claude Code:** `claude plugin marketplace add <clone> --scope user`, `claude plugin install sitrep-reporter@sitrep --scope user`,
  then `claude plugin update` on it, which brings a plugin installed earlier up to the clone's version, and
  `claude plugin configure sitrep-reporter@sitrep --values-stdin` with the URL and secret on stdin. Claude Code records
  the marketplace and `enabledPlugins` in `~/.claude/settings.json`, saves the URL under `pluginConfigs` there, and keeps
  the secret in the system's secure credential store. Sessions report from their next start or after `/reload-plugins`.
  To try the plugin in one session without any of this: `claude --plugin-dir <clone>/mod/claude-reporter`.
- **Claude Code's telemetry**, which carries every Claude session's usage: the install merges into
  `~/.claude/settings.json` the `env` keys `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`,
  `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=<the plugin's URL>/api/fleet/v1/logs`
  and `OTEL_LOGS_EXPORT_INTERVAL=1000`, and `otelHeadersHelper`, which runs the clone's `scripts/claude-otel-headers.sh`
  with `/bin/sh`; every other setting and hook entry stays. The helper prints the two headers the server needs:
  `X-Sitrep-Machine` (the machine id) and `X-Sitrep-Token` (the admin secret, read from `~/.sitrep/claude-otel-token`).
  The install writes that file (mode 0600) with the secret the reporters get, from `--token-stdin` or else this
  machine's `server.env`. A run with no secret keeps a token file that is there; with no secret and no token file, the
  install leaves Claude Code out, its plugin too, and says to re-run with `--token-stdin`. The secret is never in
  `settings.json`, on a command line or in a URL.
  The endpoint follows the URL this run sets with `--url`, else the one the plugin has. If `settings.json` already sets
  Claude Code's telemetry for something else (`CLAUDE_CODE_ENABLE_TELEMETRY`, an `OTEL_` key or `otelHeadersHelper`),
  the install leaves Claude Code out and says so. Claude Code reads these settings at start, so a session sends its
  usage from its next start; `/reload-plugins` does not re-read them.
- **Codex:** `codex plugin marketplace add <clone>` and `codex plugin add sitrep-codex@sitrep`. The
  first adds `[marketplaces.sitrep]` to `~/.codex/config.toml` (Codex reads the clone's
  `.agents/plugins/marketplace.json` in place); the second copies the plugin into Codex's plugin cache and enables it with
  `[plugins."sitrep-codex@sitrep"]`. Then it writes
  `~/.sitrep/codex-reporter.env` (mode 0600) and the `sitrep-codex-reporter` user service, and starts
  it. Last, it trusts the plugin's hooks: see [Codex hook trust](#codex-hook-trust).

Each component you name is applied on its own, in the order server, Codex, Claude Code. One that is blocked is left
out with the reason; one whose command fails stops there; the others are still applied, except the reporters when this
run's server was left out or failed. The install then exits non-zero.

Running the install again is safe: it keeps a config that exists and changes only what you pass (`--url`, `--bind`,
`--port`, the secret; the reporters' URL follows the rule above), rewrites the service unit, restarts the service and
trusts the Codex hooks again.

## Hermes

Hermes's sessions reach the dashboard through `hermes-reporter`, a sidecar container that mounts Hermes's state volume
read-only and reports like codex-reporter. It needs nothing installed in Hermes and never writes to it.
Build the clone (`npm run build`), then start, stop, upgrade and read its logs with the commands in
`hermes-reporter/README.md`; it reads the server address and secret from `~/.sitrep/codex-reporter.env`.
Never mount the volume writable.

## In a Claude Code session

The plugin adds one command:

- `/sitrep` prints the dashboard link (the plugin's `serverUrl`), the connection state (not tried yet, online,
  or offline and retrying, with the server's count of live sessions), the reporter's and the server's versions with
  any owner, version or update notice, the reports sent, failed and rejected and the events queued and dropped, the
  last error, this machine's name and id, the session id and any name given below, the session's background work, and
  the reporter's time per hook. Before the session has started it says only that the reporter is loaded.
- `/sitrep name <text>` gives the session a display name of up to 80 characters, kept in the plugin's store
  for that session id (a `/clear` starts a new id without it). The name the dashboard shows is the first of: this
  name, the title Claude Code gave the session, the `sessionName` option, a worktree's branch or folder, the
  repository folder, and `session-` with the first six characters of the id.

## Ports

| Port | What |
|---|---|
| 4317/tcp on the server | Everything: the reporters' API, the dashboard, and its live stream (Server-Sent Events). `PORT` changes it |
| 5173 on a development machine | The Vite dev server, only under `npm run dev` |

Reporters only make outbound connections. `codex-reporter` talks to the local Codex daemon over its Unix socket, not a
port.

## Settings

**In the dashboard.** Settings → Server changes answering, the activity feed, the stuck thresholds per model family,
the lifecycle timers and retention (signed in; signed out it shows them read-only). The server keeps them in its
database and applies them at once; the `server.env` values below are their defaults. A row's Reset removes the change
made in Settings, so the `server.env` value applies again, including one edited there later (after a restart). Settings
takes retention of 1 hour or more, timers of 1 second or more and stuck thresholds of 10 seconds or more. The reporters
learn the answering and feed settings from their next report reply. Settings also lists the price table and, under
About, the address, port, allowed hosts, time zone and log level, which only `server.env` and a restart change.

**In the env files.** The server and `codex-reporter` read their settings from env files (`KEY=VALUE` lines) through
`node --env-file`. Change one, then restart the service (`systemctl --user restart sitrep`, or re-run the
install). The tables list every setting each program reads, with the default it uses when the setting is unset or
empty; `scripts/server.env.example` and `scripts/codex-reporter.env.example` carry the same list.

### Server: `~/.sitrep/server.env`

The server also reads a `.env` file at the repository root when there is one (handy under `npm run dev`); a setting
already in the environment, such as one from the service's `server.env`, wins over it.

| Setting | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Where it listens. `0.0.0.0`, or the LAN address, for other machines |
| `PORT` | `4317` | Its port |
| `SITREP_TOKEN` | none (the install makes one) | The admin secret: reporters send it in `X-Sitrep-Token`, and you sign in with it to answer sessions. Empty turns auth off: reports are taken from anyone and nothing can be answered. The server warns at start about one shorter than 24 characters |
| `SITREP_DB` | `<repository>/data/sitrep.sqlite` (the install sets `~/.sitrep/data/sitrep.sqlite`) | The SQLite database (WAL mode: `-wal` and `-shm` files sit beside it) |
| `SITREP_ALLOWED_HOSTS` | empty | Host names other machines type, comma-separated. `localhost`, `::1`, `127.x.x.x` and the `HOST` address always work; with `HOST=0.0.0.0` any IP address does |
| `SITREP_RESPOND` | `on` | Whether sessions can be answered from the dashboard. `on` or `off` (also `true`/`false`, `1`/`0`); any other value stops the server at start. Answering also needs the activity feed on |
| `SITREP_ACTIVITY_FEED` | `on` | Whether the live activity feed is asked for. Same values as above |
| `SITREP_PRICES` | `<repository>/server/prices.json` | Price overrides, laid over LiteLLM's table. A bad file stops the server at start |
| `SITREP_REQUIRE_SIGN_IN_TO_VIEW` | `off` | Whether the dashboard shows anything before signing in. Same values as `SITREP_RESPOND`; the default for the switch in Settings |
| `SITREP_LOG_LEVEL` | `info` | How much it logs: `debug`, `info`, `warn` or `error`; any other value reads as `info` |
| `SITREP_BUILD` | unset | The commit of a development build (7 to 40 hex digits, optionally followed by `-dirty`), sent with the server's version; any other value is ignored |
| `REMOVE_AFTER_MS` | `75000` | A live session not heard from this long leaves the dashboard; History records it as "Went offline", and it comes back when it reports again |
| `LINGER_MS` | `8000` | How long a finished session remains visible before it moves to History |
| `DETACHED_HIDE_AFTER_MS` | `60000` | A session nobody is attached to shows dimmed this long, then moves behind the Fleet's chip that counts them (Headless, Detached), with the headless runs |
| `RETAIN_SAMPLES_MS` | `86400000` (24 hours) | Chart samples kept |
| `RETAIN_EVENTS_MS` | `2592000000` (30 days) | Activity events kept |
| `RETAIN_SESSIONS_MS` | `2592000000` (30 days) | Ended sessions kept (History) |
| `STUCK_AFTER_MS_OPUS` | `600000` (10 minutes) | How long a running Opus loop may show no activity before it is stuck; doubled while a tool call is open |
| `STUCK_AFTER_MS_SONNET` | `240000` (4 minutes) | The same for Sonnet |
| `STUCK_AFTER_MS_HAIKU` | `180000` (3 minutes) | The same for Haiku |
| `STUCK_AFTER_MS_FABLE` | `180000` (3 minutes) | The same for Fable |
| `STUCK_AFTER_MS_OPENAI` | `180000` (3 minutes) | The same for OpenAI models (Codex) |
| `STUCK_AFTER_MS_OTHER` | `180000` (3 minutes) | The same for any other model |
| `TZ` | the machine's | Node's own time zone setting: "today" in the cost figures starts at local midnight in this zone |

A timer, retention or stuck setting that is not a number of 0 or more reads as its default.

### Codex reporter: `~/.sitrep/codex-reporter.env`

| Setting | Default | Meaning |
|---|---|---|
| `CODEX_REPORTER_SERVER_URL` | `http://127.0.0.1:4317` | Where reports go |
| `CODEX_REPORTER_TOKEN` | none | The server's admin secret |
| `CODEX_REPORTER_RESPOND` | `everything` | How far Codex sessions here take answers: `off`, `questions`, `questions-and-plans` or `everything` |
| `CODEX_REPORTER_ACTIVITY_FEED` | on | Send the activity feed of a loop someone is watching; on unless `off`, `false` or `0`. Answering needs it on |
| `CODEX_REPORTER_CODEX_BIN` | `codex` | The `codex` executable it runs to find the Codex daemon, looked up on the service's `PATH` |

Like Codex and Claude Code themselves, it also follows `CODEX_HOME` (default `~/.codex`) to find Codex's session files
and `CLAUDE_CONFIG_DIR` (default `~/.claude`) for the machine id it shares with the Claude plugin.

### Claude plugin options

Set with `claude plugin configure sitrep-reporter@sitrep` (or **Configure** in `/plugin`). These are
every option `mod/claude-reporter/.claude-plugin/plugin.json` declares; a missing or malformed value takes
its default.

| Option | Default | Meaning |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:4317` | Where reports go. Empty reads as the default |
| `token` | empty | The server's admin secret, sent with every report and request; leave it empty when the server has none (a sensitive option: Claude Code keeps it in its secure storage) |
| `respond` | `everything` | What the session takes from the dashboard: `off` (nothing), `questions` (answers to questions, and new messages while idle), `questions-and-plans` (also approving or sending back a plan) or `everything` (also allowing once or denying a tool, and `/clear`, `/compact`). Any other value reads as `off`. Needs `activityFeed` on and the server's `SITREP_RESPOND` |
| `activityFeed` | on | While the dashboard has a loop's panel open, send that loop's last 20 tool calls and the text between them (each cut to 300 characters, secrets redacted), and for a Bash call its whole command (up to 20,000 characters, secrets redacted) and how it ended; command output is never sent. The server keeps it in memory only. Answering needs it on |
| `flushIntervalMs` | `1000` | The least time between reports while something changes, in milliseconds; less than 200 reads as 200 |
| `heartbeatMs` | `5000` | Report at least this often even when nothing changed, in milliseconds; less than 1000 reads as 1000 |
| `sessionName` | empty | A display name for this machine's sessions, used after the `/sitrep name` name and Claude Code's own title ([In a Claude Code session](#in-a-claude-code-session)). Usually left empty |
| `showStatus` | on | Show the reporter's state in the status line under the prompt: `dashboard v<version> ● N live`, or `○ offline`, `○ connecting` or `○ token refused` after the version, with `· update plugin`, `· update server` or `· update available` when the versions do not fit, and `⚠` first when the server is plain HTTP beyond this machine |
| `fullPrompts` | off | Send each agent's whole task prompt and final answer (up to 20,000 characters each, secrets redacted) so the dashboard can show them in full. Off, only the first 400 characters are sent |

## Files and services

| Machine | Path | What |
|---|---|---|
| Server | `~/.sitrep/server.env` | Server settings with the admin secret (0600) |
| Server | `~/.sitrep/data/` | The database |
| Server | `~/.config/systemd/user/sitrep.service`, or `~/Library/LaunchAgents/dev.sitrep.server.plist` | The service. Its log: `journalctl --user -u sitrep`, or `~/.sitrep/server.log` on macOS |
| Codex machine | `~/.sitrep/codex-reporter.env` | Reporter settings with the admin secret (0600) |
| Codex machine | `~/.config/systemd/user/sitrep-codex-reporter.service`, or `~/Library/LaunchAgents/dev.sitrep.codex-reporter.plist` | The service. Its log: `journalctl --user -u sitrep-codex-reporter`, or `~/.sitrep/codex-reporter.log`; each line starts with its UTC time |
| Codex machine | `~/.sitrep/codex-hooks.ndjson` (and `.1`) | The spool the plugin's hooks append to; owner-only, rotated at 5 MB |
| Codex machine | `~/.sitrep/codex-reporter-state.json` | What codex-reporter keeps across restarts: the dashboard deliveries it acted on and each session's git base (0600) |
| Codex machine | `~/.codex/config.toml`, Codex's plugin cache, `~/.codex/.hook-trust/` | The marketplace and plugin entries `codex plugin` wrote, and the trust the install wrote for our hooks |
| Claude machine | `~/.claude/settings.json` | The marketplace, `enabledPlugins` and `pluginConfigs` entries `claude plugin` wrote (the secret is in the system's secure credential store), and the telemetry `env` keys and `otelHeadersHelper` the install wrote |
| Claude machine | `~/.sitrep/claude-otel-token` | The admin secret the telemetry headers helper sends (0600) |
| Each reporter machine | `~/.claude/sitrep-machine-id` (under `$CLAUDE_CONFIG_DIR` when set) | The machine id both reporters share. Uninstall keeps it, even with `--purge` |

The services record the `PATH` of the shell that ran the install, so `codex-reporter` can find `codex` and `git`.
Re-run the install after moving Node or Codex.

## Security: one owner, one secret

One owner holds one admin secret, and the server speaks plain HTTP on a home LAN treated as trusted. Reads are open on
the LAN, and a machine off the LAN reaches the server through an SSH tunnel ([Off the LAN](#off-the-lan)). Know what
that means:

- **One secret everywhere.** Every reporter machine holds the same admin secret, and it travels in clear on every
  report over plain HTTP. Anyone who can watch the LAN can copy it.
- **The secret can answer.** With it, anyone can answer prompts and send messages to any Claude Code session, and any
  daemon-hosted Codex session, on any machine. Your sign-in in the browser also crosses the LAN in clear.
- **Reading is open.** Anyone who can reach port 4317 sees every session without signing in: names, machines, paths,
  branches, plan steps, and bounded, redacted excerpts of prompts, answers, commands, failed-tool output and messages
  agents send each other.
- **What leaves each machine.** The reports carry all of that in clear over the LAN; their free text is redacted on the
  machine and cut to fixed lengths. While a session waits on you, its report also carries the open ask as the native
  prompt shows it, redacted: the questions, the plan, or the tool call and its input, including the redacted Codex patch
  while a file approval is open. The server holds an open ask in memory only and shows it only after sign-in.
- **What Claude Code's telemetry sends.** Its log export carries every event Claude Code emits, and with each the
  account's email, user and organization ids (prompt and response text arrive as `<REDACTED>`); it crosses the LAN in
  clear like the reports. The server reads only the `api_request` events' usage fields (request, session and agent ids,
  model, token counts) and drops everything else unstored and unlogged.

Ways to narrow it, from least to most work:

- Listen on the LAN address and allow port 4317 only from the LAN (see [Deploy](#deploy-the-server)).
- Close reading: Settings → Server → Require sign-in to view, or `SITREP_REQUIRE_SIGN_IN_TO_VIEW=on` as the default.
  The dashboard then shows nothing before the sign-in.
- Turn answering off: Settings → Server → Answering, or `SITREP_RESPOND=off` as the default. The secret then
  only lets a machine report.
- Use an SSH tunnel from the laptop ([Off the LAN](#off-the-lan)): it encrypts the secret and your sign-in, and the
  dashboard at `localhost` is a secure context, so browser notifications work.
- Put a TLS-terminating reverse proxy in front of the server and list its host name in
  `SITREP_ALLOWED_HOSTS`. HTTPS is needed only if the server is reached other than over the LAN, a tunnel or a
  VPN; the server has no built-in HTTPS.

**Rotating the secret.** Put a new value in `server.env` and restart the server:

```sh
sed -i '/^SITREP_TOKEN=/d' ~/.sitrep/server.env && printf 'SITREP_TOKEN=%s\n' "$(openssl rand -hex 24)" >> ~/.sitrep/server.env
systemctl --user restart sitrep
```

On macOS, `sed -i` is `sed -i ''` and the restart is `launchctl kickstart -k gui/$(id -u)/dev.sitrep.server`.
`printf` is the shell's own, so the new secret is never on a command line. Then, on each machine, re-run the reporter
install with the new secret on `--token-stdin` and `--apply`. That updates the Claude plugin's option and
`codex-reporter.env` and restarts codex-reporter. Settings → About gives these commands, and the one that reads the
secret, for the server's OS. The new secret also ends every browser sign-in: sign in again with it. Otherwise a sign-in
lasts 400 days unused in that browser, and each use renews it.

## Back up and restore

Everything the dashboard keeps is the SQLite database on the server: sessions, agents, events, chart samples and
History, for as long as the retention settings say. It holds no transcripts and does not back up any provider session:
Claude Code and Codex keep those on each machine (`~/.claude`, `~/.codex`), and restoring the dashboard cannot bring a
session back.

**From the dashboard:** Settings → About → Download backup (signed in) gives a consistent copy of the database
(`VACUUM INTO`) without stopping the server. Keep `server.env` too: it holds the admin secret.

**From the shell** (copy the `-wal` and `-shm` files too when they are there):

```sh
systemctl --user stop sitrep
cp -p ~/.sitrep/data/sitrep.sqlite* <backup folder>/
cp -p ~/.sitrep/server.env <backup folder>/     # holds the admin secret: keep it private
systemctl --user start sitrep
```

With the `sqlite3` tool installed, `sqlite3 ~/.sitrep/data/sitrep.sqlite ".backup '<backup folder>/sitrep.sqlite'"`
takes a consistent copy without stopping the server.

Restore: stop the service, delete the database and its `-wal` and `-shm` files, copy the backup in, start the service.
Every unfinished session in the backup shows its stored state; those still running carry on when their reporters send
again, a few seconds later, and the rest leave after `REMOVE_AFTER_MS`.

## Upgrade

Upgrade the server first, then the other machines: a server older than its reporters answers 400 to a report that
carries a value it does not know, such as a new kind of event, and the reporter drops that report. Back up the database
first ([Back up and restore](#back-up-and-restore)): the server applies a new version's database migrations by itself
when it starts, and going back to an older version can mean restoring that backup.

On each machine:

```sh
git pull
npm ci
npm run build                 # a machine without the server: npm run build -w codex-reporter, or nothing for Claude only
```

- **Server:** `systemctl --user restart sitrep` (macOS: `launchctl kickstart -k gui/$(id -u)/dev.sitrep.server`),
  or re-run `npx tsx scripts/install.ts --server --apply`; the new version's migrations run as it starts. Running
  sessions stay on the dashboard in their last state and carry on when their reporters next send.
- **Codex:** re-run `npx tsx scripts/install.ts --codex --apply`. It copies the new plugin into Codex's cache, trusts
  its hooks again and restarts codex-reporter; the configs are kept.
- **Claude Code:** re-run `npx tsx scripts/install.ts --claude --apply` (the machine's Update command in Machines does
  `git pull`, `npm ci` and this); it runs `claude plugin update`, so Claude Code takes the clone's new version. Then
  restart each open Claude Code session: quit it, then `claude --resume`, which keeps the conversation; new sessions
  take the new plugin at once. The same restart loads telemetry settings the install first wrote or changed. The
  install keeps the telemetry settings unless the server address or the helper changed, and the admin secret already
  on the machine (`~/.sitrep/claude-otel-token`); with no secret at all it leaves Claude Code out and says to re-run
  with `--token-stdin`.
- **Hermes:** on the Hermes machine, once its clone is built, `docker restart sitrep-hermes-reporter`
  (`hermes-reporter/README.md`).

When a reporter and the server are on versions that do not fit, Machines and `scripts/doctor.ts` say which side to
update, and the machine's row in Machines gives its Update command.

**After every deploy, run `npx tsx scripts/doctor.ts` on each machine and check Machines:** every reporter's version
fits the server (doctor says "fits the server") and none reads "outdated". An outdated Claude
reporter is a session running an older plugin: its machine's clone was not updated, or the session loaded the plugin
before it was. Run that machine's Update command, then restart (resume) the session.

**Prices.** At each start the server fetches LiteLLM's `model_prices_and_context_window.json` (5 s limit) and lays it
over the copy shipped in `server/model_prices_and_context_window.json`; Settings shows which one is in use and why a
fetch failed. To refresh the shipped copy, download the file from LiteLLM's repository into that path and update
`SNAPSHOT_AS_OF` in `server/src/fleet/pricing.ts`. Overrides go in `prices.json`.

## Codex hook trust

Codex runs a plugin's hooks only once they are trusted, and it ties that trust to a hash of the plugin's contents
(`codex-rs/hooks/src/engine/plugin_trust.rs`), so every plugin update needs it again. `install.ts --codex` writes it
the way Codex's own `/hooks` screen does (`codex-rs/tui/src/hooks_rpc.rs`):

1. `hooks/list`, for the hooks Codex finds;
2. for our plugin's hooks that it lists as untrusted or modified, and no other, one `config/batchWrite`: key path
   `hooks.state`, merge `upsert`, `{ "<key>": { "trusted_hash": "<current hash>" } }` per hook, and
   `reloadUserConfig: true`.

It reaches Codex's app-server the way Codex's own clients do: through the managed daemon's socket when the daemon
runs, else a private `codex app-server` over stdio. The dry run prints both requests. Our keys look like
`sitrep-codex@sitrep:hooks/hooks.json:<event>:<group>:<handler>` (for example
`sitrep-codex@sitrep:hooks/hooks.json:pre_tool_use:0:0`; `codex-rs/hooks/src/lib.rs` `hook_key`,
`declarations.rs`). Codex keeps them in `~/.codex/config.toml` under `[hooks.state]`, with a content baseline in
`~/.codex/.hook-trust/`. If the install cannot reach Codex, it says so: trust the `sitrep-codex` hooks in
Codex's `/hooks` instead.

While the hooks are not trusted, the machine's row in Machines shows the Codex hooks off, auto-compacts read "—" and a
thread outside the daemon cannot show that it waits on a permission. Usage, context, plans and agents still come from
the session files. Uninstalling leaves the trust entries; they do nothing once the plugin is gone.

## Off the LAN

Sessions on the laptop keep running when it leaves the LAN; its reporters queue and drop as described in
[What runs where](#what-runs-where). To keep reporting and see the dashboard, tunnel to the server machine however you
reach it over SSH from outside:

```sh
ssh -N -L 4317:127.0.0.1:4317 server
```

The dashboard is then at `http://localhost:4317`, a secure context, so browser notifications work there. (If the
server listens only on its LAN address, use `-L 4317:192.0.2.10:4317`. If something on the laptop already uses 4317,
pick another local port and use it below.) Settings → About gives this command for the server's address and port, and
Settings → This browser shows it while notifications are unavailable.

Point the laptop's reporters at the tunnel:

```sh
ssh server "sed -n 's/^SITREP_TOKEN=//p' ~/.sitrep/server.env" \
  | npx tsx scripts/install.ts --claude --codex --url http://127.0.0.1:4317 --token-stdin --apply
```

With that, the laptop reports only while the tunnel runs, on the LAN or off it; keep the tunnel up whenever you work,
or switch back with `--url http://192.0.2.10:4317` when you are home. `--url` moves Claude Code's telemetry endpoint
with the plugin's URL; Claude Code reads it at start, so a session started before the switch sends its usage to the old
address until restarted.

## Check a machine

```sh
npx tsx scripts/doctor.ts
```

It changes nothing. It checks Node, the clone and its build, the Claude plugin and its saved secret, Claude Code's
telemetry (the settings the install writes, that they send to where the plugin reports, and the headers helper, run as
Claude Code runs it; its output is never printed), the Codex plugin and its hook trust, the codex-reporter service, the
server each reporter sends to (`/api/fleet/state`), whether that server takes each admin secret a config here holds for
it (codex-reporter's, the telemetry token file's and, on the server machine, `server.env`'s), whether this machine's
reporter versions fit, as the server judges them for Machines (a version no live session reports is "last reported"),
and the machine id. A sender whose secret it cannot check gets a line saying why (the plugin's own copy is in Claude
Code's secure storage, which doctor cannot read). Each problem prints the command that fixes it, or the section here
that does, and doctor exits 1 when there is one. A machine's row in Machines and Settings → About give this command.

## Troubleshooting

**Fix commands.** A machine's row in Machines gives the machine's commands for its OS, its problems named beside the
ones that fix them; Settings → About gives the server's. Run them on that machine, in its clone.

| To | Linux (systemd) | macOS (launchd) |
|---|---|---|
| Check the machine | `npx tsx scripts/doctor.ts` | the same |
| Update it | `git pull && npm ci && npm run build -w codex-reporter && npx tsx scripts/install.ts --claude --codex --apply` (leave out the Codex build and `--codex`, or `--claude`, for a machine without that tool; the installer runs `claude plugin update`, so Claude Code's recorded plugin version matches the clone), then restart each open Claude Code session: quit it, then `claude --resume`. With no admin secret on the machine the installer leaves Claude Code out, applies Codex, and says to re-run with `--token-stdin` | the same |
| Trust the Codex hooks | `npx tsx scripts/install.ts --codex --apply` (or Codex's `/hooks`) | the same |
| Restart codex-reporter | `systemctl --user restart sitrep-codex-reporter` | `launchctl kickstart -k gui/$(id -u)/dev.sitrep.codex-reporter` |
| Read codex-reporter's log | `journalctl --user -u sitrep-codex-reporter -e` | `tail -n 50 ~/.sitrep/codex-reporter.log` |
| Restart the server | `systemctl --user restart sitrep` | `launchctl kickstart -k gui/$(id -u)/dev.sitrep.server` |
| Read the server's log | `journalctl --user -u sitrep -e` | `tail -n 50 ~/.sitrep/server.log` |
| Uninstall | `npx tsx scripts/uninstall.ts --claude --codex --apply` | the same |

| Symptom | Check |
|---|---|
| A session never appears | A session is kept off the dashboard until it has done something, such as its first prompt. Then run `scripts/doctor.ts` on its machine: it checks that the reporters reach the server |
| Reports refused with 401 | The reporter's secret is missing or wrong. A refused 401 carries no machine id, so Machines lists it under "N refused, no machine", by address, with the install command that fixes it: re-run the reporter install with `--token-stdin` |
| Requests refused with 403 | The server does not expect that host name. Add it to `SITREP_ALLOWED_HOSTS`, or use the IP address |
| No Codex sessions from a machine | Is codex-reporter running? `scripts/doctor.ts`, then its log, which names a session whose report it could not build, with the error. It needs Node 22.15 or later, and `codex` and `git` on the `PATH` the install recorded |
| A machine's Codex hooks are off | Re-run `npx tsx scripts/install.ts --codex --apply`, which trusts them ([Codex hook trust](#codex-hook-trust)) |
| A Codex session says "Answer in its terminal" or "Answer in the Codex app" | Only threads in the machine's Codex daemon can be answered: CLI sessions and desktop-app remote projects. Desktop-app local projects (they read "Answer in the Codex app"), `codex exec`, CLI sessions started with `--no-daemon`, `--profile` or most `-c` overrides, and machines without the daemon are watch-only |
| Claude sessions show the old plugin after an upgrade (Machines: "outdated") | Run the machine's Update command (Machines), whose installer runs `claude plugin update`, then restart (resume) the session, or start a new one |
| A Claude session's usage and cost stay "—" or stop rising | Its usage comes from Claude Code's telemetry. Run `scripts/doctor.ts` on its machine: if the telemetry is not set up, run `npx tsx scripts/install.ts --claude --token-stdin --apply` as in [Add a machine](#add-a-machine), then restart (resume) the session, since Claude Code reads the settings only at start. Refused telemetry exports are listed under that machine's "N refused" (401: no or a wrong secret in `~/.sitrep/claude-otel-token`). Until the machine id exists the headers helper fails and Claude Code sends nothing; doctor says so |
| After an upgrade, a session's reporter reads "update" (Machines: "outdated"), and its asks and message box read "Answer in its terminal" | Its reporter is older than the server supports (claude-reporter 0.2.0, codex-reporter 0.3.0), so the dashboard cannot answer it ([Upgrade](#upgrade)): the machine's Update command, then restart (resume) each open Claude Code session; or update and restart codex-reporter |
| Nothing reports from a machine, and it has no id file (`~/.claude/sitrep-machine-id`, or under `$CLAUDE_CONFIG_DIR`) | Start codex-reporter or a Claude Code session; either creates it |
| Nothing reports from a machine, and a reporter says this machine's id cannot be read | The reporter names the file: it cannot be read, or holds no id, and no reporter makes a new id over it. Fix its permission (`chmod 644`: the Hermes sidecar reads it as another user) or delete it; a new id makes a new machine row, and the old row stays in Machines until you Remove it |
| The server does not start | Its log (`journalctl --user -u sitrep -e`, or `~/.sitrep/server.log`). It needs Node 24 |
| The server stops when you log out of the server machine | `loginctl enable-linger $USER` |
| A machine reads Silent | Its reporters cannot reach the server (it slept, left the LAN, or the server restarted). They send again when they can; a machine you no longer use goes with Remove. The logs of codex-reporter and the Hermes sidecar say, per session, when posting its reports began to fail and why (a connection error, no answer within 15 s, or an HTTP status), and when the server answered again |
| A machine is listed twice | Its id file was deleted, so it reports under a new id. Remove the old row in Machines (Remove silent) |
| Notifications read "Needs HTTPS or localhost" | Browsers allow notifications only on a secure context: open the dashboard at `localhost` through the tunnel, whose command Settings → This browser shows beside it |

## Uninstall

```sh
npx tsx scripts/uninstall.ts --claude --codex --server            # dry run
npx tsx scripts/uninstall.ts --claude --codex --server --apply
```

Name the components the machine has. It stops and deletes the services, and removes both plugins and this
repository's marketplaces with the providers' own commands: `claude plugin uninstall sitrep-reporter@sitrep --scope user`
(which also deletes the plugin's saved options and secret), `claude plugin marketplace remove sitrep --scope user`,
`codex plugin remove sitrep-codex@sitrep` (which also deletes Codex's cached copy) and
`codex plugin marketplace remove sitrep`. With `--claude` it also removes the telemetry keys the install added
to `~/.claude/settings.json` (only while `otelHeadersHelper` still runs our helper; telemetry settings of anything else
stay). It prints where the Codex hook trust stays
([Codex hook trust](#codex-hook-trust)). With `--purge` it also deletes the named components' data: the configs, the
telemetry token file (`~/.sitrep/claude-otel-token`), the server's database, the logs, codex-reporter's saved
state and the Codex hook spool. Back up the database first if you want History.

It keeps the machine id (`~/.claude/sitrep-machine-id`), even with `--purge`, so a reinstall does not show the
machine twice. To take a machine off the dashboard, uninstall it, then Remove it in Machines.

Without `--purge`, `--server` keeps `~/.sitrep/server.env`, and install then still treats the machine as a
server host ([Which URL the local reporters get](#add-a-machine)): a later `install --claude` or `--codex` without
`--url` points those reporters at this machine's old server address; `--purge`, or `--url` on that install, avoids it.
Nothing in `~/.claude/settings.json` or `~/.codex/hooks.json` that you wrote is touched, and no provider session is
deleted.
