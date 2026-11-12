# How SITREP works

## The pieces

```
 laptop        Claude Code ── plugin ───────────────┐
 workstation   Codex ──────── plugin + reporter ────┼──▶  SITREP server  ──▶  your browser
 server        Hermes ─────── read-only sidecar ────┘     (Node, SQLite)      (live)
```

| Piece | Where it runs | What it does |
|---|---|---|
| The server | One machine that stays on | One Node process with a SQLite database. Port 7487 carries everything: the reporters' API, the dashboard and its live stream |
| The Claude Code plugin, `sitrep-reporter` | Inside each Claude Code session | Reports the session's state, its asks and their answers |
| Claude Code's own telemetry | Each Claude Code session | Carries the session's usage to the server, one event per API request. The installer turns it on |
| The Codex plugin, `sitrep-codex`, and `codex-reporter` | Each machine that runs Codex | The plugin's hooks write to a local spool; the reporter service reads the spool, Codex's session files and the Codex daemon, and sends the reports |
| `hermes-reporter` | Beside Hermes, as a sidecar | Reads Hermes's own store read-only and reports its sessions. It never answers |
| The dashboard | Your browser | Served by the server and updated live |

The reporters' only network connection is outbound, to the server.

## A session

A report is the session's whole current state, never a change to it. A report that is lost costs nothing: the next one
carries everything.

A session is known by its machine and the id its harness gave it. A machine is known by a small id file the reporters
share (`~/.claude/sitrep-machine-id`), so it keeps its row across reinstalls.

Each session is in one state, shown with the same word, mark and colour everywhere:

| State | Meaning |
|---|---|
| Working | It is running |
| Needs you | It is waiting on a permission, a question or a plan |
| Idle | Its turn ended and it asked nothing |
| Stuck | It is running but has been silent longer than the threshold for its model |
| Failed | A model API error, or tool calls that keep failing (three in a row, or one followed by a minute of silence) |
| Done | It ended |

A session that stops reporting keeps what it last showed for 75 seconds, then leaves the board and is recorded in
History as "Went offline". An ended session stays 8 seconds as Done, then moves to History. Both timers, and the stuck
thresholds, are settings.

## Answering

When a session asks for a permission, an answer or a plan approval, its reporter announces the ask and waits on the
server for the answer. Signed in, you answer in the dashboard, and the reporter gives the session exactly that answer.
You can still answer in the terminal: the first answer wins, and the dashboard says what became of yours.

- **Claude Code** sessions are answered through the plugin.
- **Codex** sessions running in Codex's managed daemon on that machine are answered through it. The others (`codex exec`,
  a desktop-app local project, a machine without the daemon) are shown, not answered.
- **Hermes** sessions are shown, not answered.

Where a session can be answered you can also send it a message or `/compact`; a Claude Code session also takes `/clear`.

That is all SITREP does to a session. It never controls a terminal, and never starts, stops or restarts one.

## Usage and cost

- **Claude Code:** every API request is counted once, from Claude Code's own telemetry, so the figure covers its side
  requests too.
- **Codex:** from the usage Codex records for each response in its session files.

The server prices the tokens with LiteLLM's public price table, plus your own overrides. Every cost is an estimate and
is marked "est.". Plan windows show each provider's limits as the harness reports them.

## What is stored

Everything lives in one SQLite database on the server (`~/.sitrep/data/`): sessions, their agents, plans and events,
and usage. History is kept for as long as the retention settings say.

No transcripts are stored. The free text a report carries (a prompt's opening, a command, a failed tool's output) is
redacted on the machine it comes from and cut to a fixed length.

While the server cannot be reached, a reporter keeps each session's latest state and up to 500 events, and sends them
when it is back.

## Security

SITREP is built for one person on a trusted LAN.

- It speaks plain HTTP. By default anyone who can reach port 7487 can read every session; Settings → Require sign-in to
  view closes that.
- One admin secret does everything else: the reporters send it with their reports, and you sign in with it to answer a
  session or change a setting.
- From outside the LAN, reach it through an SSH tunnel.

[Operations: Security](OPERATIONS.md#security-one-owner-one-secret) has the detail and the ways to narrow it.

## What it reaches on the internet

The server fetches LiteLLM's public price table. The dashboard page loads its fonts from Google Fonts. Nothing about
your sessions goes anywhere but your server.
