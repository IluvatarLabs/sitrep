// Hermes Agent's own session store, read-only: `$HERMES_HOME/state.db`, the SQLite database in which Hermes keeps every session
// of every surface (CLI, TUI, gateway, cron) and which `hermes sessions list` reads. Hermes owns the file. It is opened read-only
// (through a read-only mount in the sidecar), and every query is a single statement run to its end, so no read transaction stays
// open to hold back Hermes's checkpoints (sqlite.org/wal.html §2.2). A WAL database without write permission is readable while
// its -wal and -shm files exist (wal.html §5), which they do while Hermes runs.
//
// The rules below are Hermes's own, at hermes-agent 0.20.6 (the version in the Hermes image); each names where Hermes states
// it. Unknown stays unknown.
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { TokenCounts } from '../../server/src/fleet/protocol.js';

/** `$HERMES_HOME`, else the sidecar's mount `/hermes`; state.db sits at its top, as Hermes places it (`hermes_state.py:362`). */
export function hermesHome(): string {
  const env = process.env.HERMES_HOME?.trim();
  return path.resolve(env || '/hermes');
}

/**
 * Hermes's "active" window: a session is active while it has not ended and its last activity is under 300 s old
 * (`hermes_cli/web_routers/sessions.py:149-152`, `:301-304`), which Hermes's web UI shows as "Live" (`web/src/pages/SessionsPage.tsx:
 * 695-700`).
 */
export const ACTIVE_WINDOW_MS = 300_000;

/** One session row as Hermes keeps it, times in epoch ms. */
export interface StoredSession {
  /** Hermes's `is_active`: not ended, and its last activity inside ACTIVE_WINDOW_MS. */
  active: boolean;
  id: string;
  /** Hermes's own word for where the session came from (`sessions.source`: the CLI, a gateway platform, cron, …). */
  source: string | null;
  model: string | null;
  title: string | null;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  cwd: string | null;
  repoRoot: string | null;
  /** Hermes's last activity: the newer of its activity stamp and its newest message, else its start (`hermes_state_common.py:279-301`). */
  lastActive: number;
}

/**
 * The state of a session's last turn by Hermes's own classification of its last message (`classify_session_status`,
 * `hermes_state.py:4017-4042`): `complete` (a normal assistant reply), `interrupted` (the last row is the user's turn, a tool
 * result not yet answered, or an assistant tool call with no result yet), `error` (an error finish reason).
 */
export interface LastTurn {
  state: 'complete' | 'interrupted' | 'error';
  /** The last row is an assistant tool call with no result after it: a tool is running. */
  toolOpen: boolean;
  /** For `error`: the last message's id, its time (epoch ms) and its finish reason as Hermes stored it. */
  error: { messageId: number; at: number; reason: string } | null;
}

/** One model's tokens over a session's whole life. */
export interface ModelTokens extends TokenCounts {
  model: string;
}

/**
 * One delegated subagent's run under a session: a child session Hermes creates for each `delegate_task` child, its parent the
 * delegating session and its `source` its platform, `subagent` (`tools/delegate_tool.py:1965-1989`, `run_agent.py:93-103`), and ends
 * `agent_close` when the child closes (`run_agent.py:4738-4746`).
 */
export interface StoredAgent {
  id: string;
  /** The session that delegated it: the reported session, or another subagent of it. */
  parentId: string;
  source: string | null;
  model: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Hermes's own count of the tool calls its messages made (`append_message`, `hermes_state.py:10687-10698`). */
  toolCalls: number;
  lastActive: number;
  /** Its last turn, as LastTurn; null while it has no message. */
  turn: LastTurn | null;
}

/** A session's usage: the whole tree's per model (the session's own and its subagents'), and each session's own. */
export interface TreeUsage {
  total: ModelTokens[];
  own: ReadonlyMap<string, ModelTokens[]>;
}

/** Finish reasons Hermes reads as a turn that ended in error (`hermes_state.py:4014`). */
const ERROR_FINISH_REASONS: ReadonlySet<string> = new Set(['error', 'agent_error', 'content_filter']);

/** A delegated subagent's run: a child row carrying Hermes's `_delegate_from` marker (`tools/delegate_tool.py:2046-2052`). */
const DELEGATE = (alias: string) => `json_extract(COALESCE(${alias}.model_config, '{}'), '$._delegate_from')`;

/** Hermes's last activity of the row `alias`: the newer of its activity stamp and its newest message, else its start. */
const LAST_ACTIVE = (alias: string) => `COALESCE((SELECT MAX(v) FROM (SELECT ${alias}.last_activity_at AS v
                         UNION ALL SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = ${alias}.id)), ${alias}.started_at)`;

/** `?1`'s session and every subagent run under it, its subagents' included: the delegation edges Hermes marks (DELEGATE). */
const TREE = `tree(id) AS (
  SELECT ?1
  UNION
  SELECT c.id FROM sessions c JOIN tree t ON c.parent_session_id = t.id WHERE ${DELEGATE('c')} IS NOT NULL
)`;

/**
 * The sessions to report: the rows `hermes sessions list` shows, less its compression projection (`hermes_cli/sessions_cmd.py:
 * 325-334`, `list_sessions_rich` `hermes_state.py:9973-10015`): not a delegated subagent's run, not a third-party `tool`
 * session, not archived or hidden. Of those, each one whose last activity is inside Hermes's window (`?1`, ACTIVE_WINDOW_MS
 * ago), each whose usage (its own or a subagent's) Hermes wrote inside it (`spent`), and each in `?2` (a JSON array of ids still
 * followed). Hermes stamps a usage row's `last_seen` at every write and touches no activity with it (`_record_model_usage`,
 * `hermes_state.py:8756-8797`), so `spent` is what shows usage written after a session's last activity, such as compression usage
 * written after a gateway chat ended. A compression continuation is reported as its own session: Hermes lists the continuation's
 * id for the conversation (`hermes_state.py:10215-10262`), and the segment it continues has ended.
 */
const SESSIONS = `
WITH RECURSIVE spent(id) AS (
  SELECT session_id FROM session_model_usage WHERE last_seen > ?1
  UNION
  SELECT s.parent_session_id FROM spent JOIN sessions s ON s.id = spent.id WHERE ${DELEGATE('s')} IS NOT NULL
),
kept(id) AS (SELECT id FROM spent UNION SELECT value FROM json_each(?2))
SELECT id, source, model, title, started_at, ended_at, end_reason, cwd, git_repo_root, last_active,
       ended_at IS NULL AND last_active > ?1 AS active
  FROM (SELECT s.id, s.source, s.model, s.title, s.started_at, s.ended_at, s.end_reason, s.cwd, s.git_repo_root,
               ${LAST_ACTIVE('s')} AS last_active
          FROM sessions s
         WHERE ${DELEGATE('s')} IS NULL AND COALESCE(s.source, '') <> 'tool' AND s.archived = 0 AND s.hidden = 0
           AND (s.ended_at IS NULL OR s.ended_at > ?1 OR s.id IN kept))
 WHERE last_active > ?1 OR id IN kept`;

/** The session's last message, as `session_lifecycle_statuses` takes it: the row with the highest id (`hermes_state.py:10298-10309`). */
const LAST_MESSAGE = `SELECT id, timestamp, role, tool_calls IS NOT NULL AS calls, finish_reason FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1`;

/** The session's first user message, in the order Hermes's list preview takes it (`hermes_state.py:10124-10128`). */
const FIRST_PROMPT = `SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND content IS NOT NULL ORDER BY timestamp, id LIMIT 1`;

/** The session's subagent runs (TREE less the session itself), oldest first, each with its last message as LAST_MESSAGE takes it. */
const AGENTS = `
WITH RECURSIVE ${TREE}
SELECT s.id, s.parent_session_id, s.source, s.model, s.started_at, s.ended_at, s.tool_call_count, ${LAST_ACTIVE('s')} AS last_active,
       m.id AS message_id, m.timestamp, m.role, m.tool_calls IS NOT NULL AS calls, m.finish_reason
  FROM sessions s LEFT JOIN messages m ON m.id = (SELECT MAX(id) FROM messages WHERE session_id = s.id)
 WHERE s.id IN tree AND s.id <> ?1
 ORDER BY s.started_at, s.id`;

/**
 * Tokens per model over the whole life of each session of TREE, as Hermes's own Insights counts a row (`agent/insights.py:
 * 672-741`): every `session_model_usage` row (main loop and auxiliary tasks, each model that served it), plus what the row's own
 * counters hold beyond those rows, on the row's model ("unknown" when it has none), as Hermes reconciles counters written as
 * absolute totals (`hermes_state.py:8639-8641`).
 */
const USAGE = `
WITH RECURSIVE ${TREE},
rows AS (
  SELECT session_id, model, input_tokens AS i, output_tokens AS o, cache_read_tokens AS cr, cache_write_tokens AS cw
    FROM session_model_usage WHERE session_id IN tree
),
counted AS (SELECT session_id, SUM(i) AS i, SUM(o) AS o, SUM(cr) AS cr, SUM(cw) AS cw FROM rows GROUP BY session_id),
residual AS (
  SELECT s.id AS session_id, COALESCE(NULLIF(s.model, ''), 'unknown') AS model,
         MAX(0, COALESCE(s.input_tokens, 0) - COALESCE(c.i, 0)) AS i,
         MAX(0, COALESCE(s.output_tokens, 0) - COALESCE(c.o, 0)) AS o,
         MAX(0, COALESCE(s.cache_read_tokens, 0) - COALESCE(c.cr, 0)) AS cr,
         MAX(0, COALESCE(s.cache_write_tokens, 0) - COALESCE(c.cw, 0)) AS cw
    FROM sessions s LEFT JOIN counted c ON c.session_id = s.id WHERE s.id IN tree
)
SELECT session_id, model, SUM(i) AS input, SUM(o) AS output, SUM(cr) AS cacheRead, SUM(cw) AS cacheWrite
  FROM (SELECT session_id, model, i, o, cr, cw FROM rows UNION ALL SELECT session_id, model, i, o, cr, cw FROM residual)
 GROUP BY session_id, model
HAVING SUM(i) + SUM(o) + SUM(cr) + SUM(cw) > 0
 ORDER BY model`;

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
// `Number.isFinite` is false for anything but a finite number, a numeric string included, so it is the whole test.
const num = (v: unknown): number => (Number.isFinite(v) ? (v as number) : 0);
/** Hermes's REAL epoch seconds as epoch ms. */
const ms = (v: unknown): number | null => (Number.isFinite(v) ? Math.round((v as number) * 1000) : null);

/** A last message row (LAST_MESSAGE's columns, its id as `id` or `message_id`) classified as `classify_session_status` does. */
function classify(r: Row, id: unknown): LastTurn {
  const reason = (str(r.finish_reason) ?? '').trim();
  if (ERROR_FINISH_REASONS.has(reason.toLowerCase())) {
    return { state: 'error', toolOpen: false, error: { messageId: num(id), at: ms(r.timestamp) ?? 0, reason } };
  }
  const role = (str(r.role) ?? '').trim().toLowerCase();
  if (role === 'assistant') return { state: r.calls ? 'interrupted' : 'complete', toolOpen: !!r.calls, error: null };
  // Anything Hermes does not recognise reads as complete, its "benign default".
  return { state: role === 'user' || role === 'tool' ? 'interrupted' : 'complete', toolOpen: false, error: null };
}

/** The store, opened on first use and again after any error; a query that fails throws, and the next call reopens. */
export class HermesStore {
  private db: DatabaseSync | null = null;
  private statements = new Map<string, StatementSync>();

  constructor(readonly file: string) {}

  private run(sql: string): StatementSync {
    if (!this.db) this.db = new DatabaseSync(this.file, { readOnly: true });
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  /** Closes the connection, so the next query opens the file afresh (after an error, or a file Hermes replaced). */
  reset(): void {
    this.statements.clear();
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = null;
  }

  /** The sessions to report now (SESSIONS): active or with usage written since `since` (epoch ms), and those in `followed`. */
  sessions(since: number, followed: readonly string[]): StoredSession[] {
    const rows = this.run(SESSIONS).all(since / 1000, JSON.stringify(followed)) as Row[];
    return rows.flatMap((r): StoredSession[] => {
      const id = str(r.id);
      const startedAt = ms(r.started_at);
      if (id === null || startedAt === null) return [];
      return [
        {
          active: !!r.active,
          id,
          source: str(r.source),
          model: str(r.model),
          title: str(r.title),
          startedAt,
          endedAt: ms(r.ended_at),
          endReason: str(r.end_reason),
          cwd: str(r.cwd),
          repoRoot: str(r.git_repo_root),
          lastActive: ms(r.last_active) ?? startedAt,
        },
      ];
    });
  }

  /** The last turn's state (LastTurn); null for a session with no messages yet (Hermes's `empty`). */
  lastTurn(id: string): LastTurn | null {
    const r = this.run(LAST_MESSAGE).get(id) as Row | undefined;
    return r ? classify(r, r.id) : null;
  }

  /** The session's first user message, raw; null when it has none. */
  firstPrompt(id: string): string | null {
    const r = this.run(FIRST_PROMPT).get(id) as Row | undefined;
    return str(r?.content);
  }

  /** The session's subagent runs (AGENTS), oldest first. */
  agents(id: string): StoredAgent[] {
    const rows = this.run(AGENTS).all(id) as Row[];
    return rows.flatMap((r): StoredAgent[] => {
      const agentId = str(r.id);
      const parentId = str(r.parent_session_id);
      const startedAt = ms(r.started_at);
      if (agentId === null || parentId === null || startedAt === null) return [];
      return [
        {
          id: agentId,
          parentId,
          source: str(r.source),
          model: str(r.model),
          startedAt,
          endedAt: ms(r.ended_at),
          toolCalls: num(r.tool_call_count),
          lastActive: ms(r.last_active) ?? startedAt,
          turn: r.message_id === null ? null : classify(r, r.message_id),
        },
      ];
    });
  }

  /** Whole-life tokens per model (USAGE) of the session's tree and of each of its sessions; empty where Hermes has recorded none. */
  usage(id: string): TreeUsage {
    const total = new Map<string, ModelTokens>();
    const own = new Map<string, ModelTokens[]>();
    for (const r of this.run(USAGE).all(id) as Row[]) {
      const t: ModelTokens = { model: str(r.model) ?? 'unknown', input: num(r.input), output: num(r.output), cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite) };
      const session = str(r.session_id) ?? id;
      own.set(session, [...(own.get(session) ?? []), t]);
      const sum = total.get(t.model) ?? { model: t.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      total.set(t.model, { model: t.model, input: sum.input + t.input, output: sum.output + t.output, cacheRead: sum.cacheRead + t.cacheRead, cacheWrite: sum.cacheWrite + t.cacheWrite });
    }
    return { total: [...total.values()], own };
  }
}
