# hermes-reporter

Puts the sessions of one Hermes Agent home on the dashboard, observe-only. Every second it reads Hermes's own session store,
`state.db`, read-only, and posts one report per active session with codex-reporter's transport, machine identity and redaction
(imported from `codex-reporter/src/`). It adds no hooks or plugin to Hermes, and the dashboard cannot answer its
sessions or send them a message or command.

## What it reports

Hermes's rules are cited in `src/store.ts` (hermes-agent 0.20.6).

| Report | From Hermes |
|---|---|
| `provider`, `reporter.name` | `hermes`, `hermes-reporter` |
| `reporter.hostSurface` | `sessions.source`, Hermes's own word for the surface (CLI, a gateway platform, cron, …) |
| which sessions | the rows `hermes sessions list` shows (no delegated-subagent runs, no `tool` sessions, nothing archived or hidden), while Hermes counts them active (not ended, last activity under 300 s old) or wrote usage for them, or for one of their subagent runs, in the last 300 s |
| `session.id`, `resumeId` | `sessions.id` |
| `session.name` | `sessions.title`; else the first user message, redacted with the free-text rules and cut by `promptName`; else `Hermes session` |
| `status` | ended (`ended_at`): `done`, `endReason` = `end_reason`. Open but no longer active in Hermes's sense (300 s without activity, when Hermes's web UI drops its "Live" badge): `done`, `endReason` = `inactive`; it reports again if it becomes active. Active: `running` while the last message leaves the turn unanswered (Hermes's `interrupted`), otherwise `waiting`/`idle` |
| `agents` | each delegated subagent run (a child session carrying Hermes's `_delegate_from` marker, and theirs): `kind` `subagent`, `type` = its `source` (`subagent`), `model`, times, `toolCalls` = `tool_call_count`, last activity, its own `usageByModel`, and `status`: `running` until Hermes ends it, then by its last message as Hermes classifies it, `failed` on an error, `aborted` mid-turn, else `done`. Its task and answer are message text and are not read: `description` and `promptExcerpt` are empty |
| `events` | a last turn Hermes classifies as an error (finish reason `error`, `agent_error` or `content_filter`): one main-loop `fail` event, `category` = that finish reason, id from the session and message ids, as codex-reporter reports a failed turn. The server holds it as the session's errored state until the session runs again |
| `toolOpen` | the last message is an assistant tool call with no result yet |
| `lastActivityAt`, `startedAt` | Hermes's last activity (newer of its activity stamp and newest message), `started_at` |
| `model` | `sessions.model` as stored |
| `usageByModel` | whole-life tokens per model: every `session_model_usage` row of the session and of its delegated subagents' runs, plus what the session counters hold beyond those rows, as Hermes Insights counts them. Tier `std` (whole-life totals cannot be split by request size). An empty list, a known zero, while Hermes has recorded none, so the session's first real figure is booked |
| `costUsd` | null: the server prices `usageByModel`, as for every harness |
| `cwd`, `projectRoot` | `sessions.cwd` (empty, unknown, when Hermes has none), `git_repo_root` |
| `respond` | `off`, limit `observe-only` |
| everything else | unknown: git, context, plan, loop, files and rate limits are null or empty |

A session reported live is read every second until a final report of it (ended, or `inactive`) is taken. A final report is sent
again whenever it changes, so usage Hermes writes after a session ends reaches the server: Hermes stamps each usage row's
`last_seen` at every write, and the session is read while that stamp is under 300 s old.

## Configuration

It uses codex-reporter's configuration, `codex-reporter/src/config.ts` (the environment, or a `.env` in the working
directory), so one env file serves both:

- `CODEX_REPORTER_SERVER_URL`: the dashboard server (default `http://127.0.0.1:7487`)
- `CODEX_REPORTER_TOKEN`: the admin secret
- `HERMES_HOME`: the Hermes home holding `state.db` (default `/hermes`, the sidecar's mount)

## The sidecar

Run on the Hermes machine from the built clone, `<clone>` (its absolute path; `npm ci && npm run build` at its root,
which builds this workspace).

Before `docker run`:

- The env file, `~/.sitrep/codex-reporter.env`, is the one `scripts/install.ts --codex` writes for codex-reporter.
  The sidecar reads only `CODEX_REPORTER_SERVER_URL` and `CODEX_REPORTER_TOKEN` from it. On a machine without
  codex-reporter nothing here writes it: give `--env-file` a file of your own with those two `KEY=VALUE` lines, values
  unquoted, mode `0600`.
- The machine-id file (`~/.claude/sitrep-machine-id`, or under `$CLAUDE_CONFIG_DIR`) is made by codex-reporter
  or the Claude Code plugin, whichever first starts on the machine. On a machine with neither, nothing in this
  repository makes it before the sidecar runs; a reporter reads a file holding one line of 8 to 32 lowercase hex
  characters (`codex-reporter/src/machine.ts`; codex-reporter makes 12 random ones). It must be readable by other users
  (`chmod 644 ~/.claude/sitrep-machine-id`). It is bound with `--mount`, which refuses to start the container while the
  file is missing, where `-v` would create a directory in its place. Its `source` below must be the file's real path,
  under `$CLAUDE_CONFIG_DIR` when that is set.
- `--user` is the owner of the Hermes store's files: 10000 in Hermes's image unless Hermes was started with
  `HERMES_UID` and `HERMES_GID` (or `PUID` and `PGID`). `docker run --rm -v <hermes-state-volume>:/hermes:ro node:24-slim stat -c '%u:%g' /hermes`
  prints it.
- The image is pinned by digest. `docker pull node:24-slim && docker image inspect --format '{{index .RepoDigests 0}}' node:24-slim`
  prints `node@sha256:` followed by the digest; use what follows `sha256:` in place of `<digest>` below.
- `<hermes-state-volume>` is the volume (or host folder) your Hermes container mounts at `/opt/data`, its home:
  `docker inspect --format '{{json .Mounts}}' <hermes-container>` lists its mounts.

```sh
docker run -d --name sitrep-hermes-reporter --restart unless-stopped \
  --network host \
  --user 10000:10000 \
  --env-file ~/.sitrep/codex-reporter.env \
  -e CLAUDE_CONFIG_DIR=/claude \
  -v <hermes-state-volume>:/hermes:ro \
  -v <clone>:/app:ro \
  --mount type=bind,source="$HOME/.claude/sitrep-machine-id",target=/claude/sitrep-machine-id,readonly \
  -v /etc/os-release:/etc/os-release:ro \
  node:24-slim@sha256:<digest> node /app/hermes-reporter/dist/hermes-reporter/src/main.js
```

- Stop: `docker stop sitrep-hermes-reporter` (`docker rm sitrep-hermes-reporter` removes it).
- Upgrade the code: update and build the clone, then `docker restart sitrep-hermes-reporter`.
- Upgrade Node: pull and print the new digest as above, `docker rm -f sitrep-hermes-reporter`, then the command
  above with that digest.
- Logs: `docker logs --tail 100 -f sitrep-hermes-reporter`; each line starts with its UTC time.

Why each part:

- **`<hermes-state-volume>:/hermes:ro`.** Hermes's home (`/opt/data`) holds `state.db` and its `-wal` and `-shm` at the
  top. SQLite reads a WAL database it cannot write while those two files exist (sqlite.org/wal.html §5, "Read-Only
  Databases"). The whole directory has to be mounted: Hermes recreates `-wal` and `-shm` when it restarts, and a mount of
  single files would keep reading the old ones. So the sidecar can read everything in that home, though it opens only
  `state.db`.
- **`--user 10000:10000`.** The owner of the store's files (Hermes's image default; see above for yours); the directory
  is `0700`, so no other user could read it except root.
- **`--network host`.** A host firewall may keep a bridge container from reaching the server. Host networking reaches the
  server the way the machine's own codex-reporter does, and gives the container the machine's host name, the machine name
  the reports carry.
- **The machine id and `/etc/os-release`, read-only.** The Hermes sessions then sit under the same machine as its Codex
  sessions (one id file per machine), and the machine's OS reads as the host's, not the image's.
- **`--env-file`.** Docker reads it as the user who runs `docker run`, so the container needs no access to it (`0600`).
  Its values are unquoted, as Docker's `--env-file` needs. The token then sits in the container's environment, where
  `docker inspect` shows it to members of the `docker` group.
- **`node:24-slim@sha256:…`.** Node 24, with `node:sqlite` built in; this workspace has no dependencies. The digest keeps
  a restart on the image you pulled, not whatever the tag points to later.
