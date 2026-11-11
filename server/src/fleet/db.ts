// The fleet's SQLite database, on Node's built-in node:sqlite. Every statement takes its values as parameters, so nothing a
// reporter sends is ever read as SQL.
//
// Tables: sessions, carrying their provider, machine, liveness and failure facts, and a blowout count that is null when the
// reporter cannot know it; agents and their full texts; events; blowouts; one sample per session per second; the machines that
// reported; the settings; the spend record, which nothing ever deletes; the owner's sign-ins, by a hash of their cookie; and
// Claude Code's API requests, each counted once, summed per session.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type { AgentReport, AgentStatus, ModelUsage, SpendRecordRow, UsageTokens } from './protocol.js';

// Not a static import: Vite (vitest) drops the `node:` prefix from one and then finds no module called `sqlite`.
const { DatabaseSync: Database } = process.getBuiltinModule('node:sqlite');

/** Migration 1, the first schema, one line per kind of column. Column order matters to nothing; rows are read by name. */
const SCHEMA_V1 = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL, wait_reason TEXT, wait_note TEXT, end_reason TEXT, resume_id TEXT,
  started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ended_at INTEGER, dropped_at INTEGER,
  cwd TEXT NOT NULL, project_root TEXT, repo_name TEXT, git_json TEXT,
  model TEXT, effort TEXT, context_tokens INTEGER, context_window INTEGER, context_percent REAL,
  cost_usd REAL, tok_in INTEGER NOT NULL, tok_out INTEGER NOT NULL, tok_cr INTEGER NOT NULL, tok_cw INTEGER NOT NULL,
  rate_limits_json TEXT, blowouts INTEGER, tool_failures INTEGER, hooks_active INTEGER,
  last_activity_at INTEGER, tool_open INTEGER NOT NULL DEFAULT 0, api_error_at INTEGER, api_error TEXT,
  plan_json TEXT, plan_kept_json TEXT, reporter_version TEXT NOT NULL, reporter_build TEXT, engine_version TEXT,
  loop_json TEXT, files_json TEXT, background_json TEXT, usage_json TEXT,
  attached INTEGER, detached_at INTEGER, owner TEXT, machine_id TEXT, machine_json TEXT, cleared_from TEXT
);
CREATE INDEX sessions_cleared_from ON sessions(cleared_from);
CREATE TABLE agents (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL, parent_id TEXT,
  kind TEXT NOT NULL, type TEXT NOT NULL, name TEXT, description TEXT NOT NULL,
  model TEXT, effort TEXT, effort_source TEXT,
  status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  context_tokens INTEGER, context_window INTEGER, context_percent REAL,
  tok_in INTEGER NOT NULL, tok_out INTEGER NOT NULL, tok_cr INTEGER NOT NULL, tok_cw INTEGER NOT NULL, cost_usd_est REAL, usage_json TEXT,
  skills_json TEXT, last_tool TEXT, tool_calls INTEGER NOT NULL, tool_counts_json TEXT, blowouts INTEGER, tool_failures INTEGER,
  steps_done INTEGER, steps_total INTEGER,
  prompt_excerpt TEXT, answer_excerpt TEXT, failure_json TEXT,
  last_activity_at INTEGER, tool_open INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE agent_texts (
  session_id TEXT NOT NULL, agent_id TEXT NOT NULL, prompt_text TEXT, answer_text TEXT,
  PRIMARY KEY (session_id, agent_id)
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT,
  t INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, data_json TEXT
);
CREATE INDEX events_session_t ON events (session_id, t DESC);
CREATE INDEX events_t ON events (t DESC);
CREATE TABLE blowouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent_id TEXT,
  t INTEGER NOT NULL, kind TEXT NOT NULL, tokens_before INTEGER, tokens_after INTEGER,
  UNIQUE (session_id, agent_id, t, kind)
);
CREATE TABLE samples (
  session_id TEXT NOT NULL, t INTEGER NOT NULL,
  tokens_total INTEGER NOT NULL, tokens_delta INTEGER NOT NULL,
  peak_context REAL NOT NULL, running_agents INTEGER NOT NULL,
  cost_usd REAL, usage_json TEXT,
  PRIMARY KEY (session_id, t)
);
CREATE TABLE machines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, os TEXT, last_report_at INTEGER NOT NULL,
  claude_reporter TEXT, codex_reporter TEXT, codex_daemon TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Each schema change, by version. A database records the ones it has in `schema_migrations` and runs the rest in order. */
const MIGRATIONS: readonly string[] = [
  SCHEMA_V1,
  // 2: the owner's display name for a session, which reports never touch.
  'ALTER TABLE sessions ADD COLUMN display_name TEXT;',
  // 3: the spend record, by server-local day, machine and model, and how much of each session's cost it has counted. A null
  // `usd` is tokens spent on a model with no price.
  `CREATE TABLE spend_days (day TEXT NOT NULL, machine_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, usd REAL, PRIMARY KEY (day, machine_id, provider, model)) WITHOUT ROWID;
   ALTER TABLE sessions ADD COLUMN spend_counted REAL;`,
  // 4: Codex figures now come from Codex's per-response records; each Codex session's next figure is its new baseline, so the
  // correction from the old reporter's figure is not counted as spend.
  "UPDATE sessions SET spend_counted = NULL WHERE provider = 'codex';",
  // 5: the surface the session runs in, as its reporter names it (Report.reporter.hostSurface).
  'ALTER TABLE sessions ADD COLUMN host_surface TEXT;',
  // 6: the owner's sign-ins, kept across restarts. A row holds the SHA-256 of a sign-in cookie's id, never the id.
  'CREATE TABLE sign_ins (id_hash TEXT PRIMARY KEY, last_used_at INTEGER NOT NULL) WITHOUT ROWID;',
  // 7: each sample's output tokens and their rise, which the token rates count; tokens_total and tokens_delta keep every kind, which
  // replay detection reads (isReplay). A sample from before has no output total, so the next one's output rise is 0.
  `ALTER TABLE samples ADD COLUMN output_total INTEGER;
   ALTER TABLE samples ADD COLUMN output_delta INTEGER NOT NULL DEFAULT 0;`,
  // 8: a session is its machine's own, so one conversation open on two machines is two sessions. Each id becomes sessionKey's
  // `<native id>@<machine id>` and `native_id` keeps the reporter's own id. Every row naming a session moves with it (a collision
  // note's other session too), and a /clear link names the session it continues on the same machine. Rows of no stored session
  // keep their id.
  `PRAGMA defer_foreign_keys = ON;
   ALTER TABLE sessions ADD COLUMN native_id TEXT NOT NULL DEFAULT '';
   UPDATE sessions SET native_id = id;
   UPDATE agents SET session_id = session_id || '@' || (SELECT COALESCE(machine_id, '') FROM sessions s WHERE s.id = agents.session_id) WHERE session_id IN (SELECT id FROM sessions);
   UPDATE agent_texts SET session_id = session_id || '@' || (SELECT COALESCE(machine_id, '') FROM sessions s WHERE s.id = agent_texts.session_id) WHERE session_id IN (SELECT id FROM sessions);
   UPDATE events SET session_id = session_id || '@' || (SELECT COALESCE(machine_id, '') FROM sessions s WHERE s.id = events.session_id) WHERE session_id IN (SELECT id FROM sessions);
   UPDATE blowouts SET session_id = session_id || '@' || (SELECT COALESCE(machine_id, '') FROM sessions s WHERE s.id = blowouts.session_id) WHERE session_id IN (SELECT id FROM sessions);
   UPDATE samples SET session_id = session_id || '@' || (SELECT COALESCE(machine_id, '') FROM sessions s WHERE s.id = samples.session_id) WHERE session_id IN (SELECT id FROM sessions);
   UPDATE events SET data_json = json_set(data_json, '$.sessionId', json_extract(data_json, '$.sessionId') || '@' || (SELECT COALESCE(machine_id, '') FROM sessions s WHERE s.id = json_extract(events.data_json, '$.sessionId')))
    WHERE kind = 'note' AND json_extract(data_json, '$.kind') = 'collision' AND json_extract(data_json, '$.sessionId') IN (SELECT id FROM sessions);
   UPDATE sessions SET id = id || '@' || COALESCE(machine_id, ''), cleared_from = cleared_from || '@' || COALESCE(machine_id, '');`,
  // 9: each sample keeps what its second booked to the spend record, which the cost per minute adds up, so that chart and the
  // day's spend agree; samples no longer keep the usage that chart used to price again.
  `ALTER TABLE samples ADD COLUMN spend_usd REAL NOT NULL DEFAULT 0;
   ALTER TABLE samples DROP COLUMN usage_json;`,
  // 10: usage comes only as reported per model, and every cost is that usage priced with the one table: a reporter's own
  // cost and token counts are no longer kept, nor a sample's cost. A mark now belongs to the reporter version it was counted under.
  // Marks were counted on the old figures, so each session's next figure only sets its starting point and the switch books
  // nothing. An empty usage list now means none used; one stored before meant nothing seen since a reporter started, so it
  // becomes unknown.
  `UPDATE sessions SET spend_counted = NULL;
   UPDATE sessions SET usage_json = NULL WHERE usage_json = '[]';
   UPDATE agents SET usage_json = NULL WHERE usage_json = '[]';
   ALTER TABLE sessions ADD COLUMN spend_version TEXT;
   ALTER TABLE sessions DROP COLUMN cost_usd;
   ALTER TABLE sessions DROP COLUMN tok_in;
   ALTER TABLE sessions DROP COLUMN tok_out;
   ALTER TABLE sessions DROP COLUMN tok_cr;
   ALTER TABLE sessions DROP COLUMN tok_cw;
   ALTER TABLE agents DROP COLUMN cost_usd_est;
   ALTER TABLE agents DROP COLUMN tok_in;
   ALTER TABLE agents DROP COLUMN tok_out;
   ALTER TABLE agents DROP COLUMN tok_cr;
   ALTER TABLE agents DROP COLUMN tok_cw;
   ALTER TABLE samples DROP COLUMN cost_usd;`,
  // 11: Claude usage comes from Claude Code's own telemetry, one record per API request: each request id once (`api_requests`,
  // kept as long as samples, far past any exporter's retry), and each session's tokens per agent ('' for the main loop), model and
  // tier summed from its requests (`api_usage`), kept with the session. `spend_version` goes: it restarted a mark per reporter
  // version, as one might count on another basis; Claude requests book with no mark, and Codex and Hermes send the harness's totals.
  `CREATE TABLE api_requests (request_id TEXT PRIMARY KEY, t INTEGER NOT NULL) WITHOUT ROWID;
   CREATE TABLE api_usage (
     session_id TEXT NOT NULL, agent_id TEXT NOT NULL, model TEXT NOT NULL, tier TEXT NOT NULL,
     input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
     last_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, agent_id, model, tier)
   ) WITHOUT ROWID;
   ALTER TABLE sessions DROP COLUMN spend_version;`,
  // 12: whether a session has been on the wall (Fleet.unused), so one that recorded nothing keeps its History and Activity rows
  // after it leaves and across restarts. A row from before is 0, judged as before by what it recorded.
  'ALTER TABLE sessions ADD COLUMN shown INTEGER NOT NULL DEFAULT 0;',
];

export { sessionKey } from './protocol.js';

/**
 * A `sessions` row, a column to a line in SCHEMA_V1's order; a column a later migration added stands by the one it goes with
 * (`native_id` by `id`, `display_name` and `spend_counted` by `name`, `shown` by `status`, `host_surface` by `engine_version`). A
 * boolean column holds 0 or 1, or null for unknown where it may.
 */
export interface SessionRow {
  /** sessionKey: the native id at its machine. */
  id: string;
  /** The id the session's own harness gave it, as its reporter sends it. */
  native_id: string;
  provider: string;
  name: string;
  /** The owner's name for the session, set from the dashboard; null when none. Reports never write it. */
  display_name: string | null;
  /**
   * The highest cost of this session the spend record has counted; null with no baseline yet. Reports never write it. A
   * Claude session books each request instead and never uses it.
   */
  spend_counted: number | null;
  status: 'running' | 'waiting' | 'done';
  /** 1 once the session has been on the wall (Fleet.unused). Reports never write it. */
  shown: number;
  wait_reason: string | null;
  wait_note: string | null;
  end_reason: string | null;
  resume_id: string | null;
  started_at: number;
  last_seen_at: number;
  ended_at: number | null;
  dropped_at: number | null;
  cwd: string;
  project_root: string | null;
  repo_name: string | null;
  git_json: string | null;
  model: string | null;
  effort: string | null;
  context_tokens: number | null;
  context_window: number | null;
  context_percent: number | null;
  rate_limits_json: string | null;
  /** Null when the reporter cannot know (Codex hooks not active): never read as 0. */
  blowouts: number | null;
  tool_failures: number | null;
  hooks_active: number | null;
  last_activity_at: number | null;
  tool_open: number;
  /** The main loop's newest model API failure (a `fail` event with a category): when, and its category. */
  api_error_at: number | null;
  api_error: string | null;
  plan_json: string | null;
  /** The plan stored last, kept while the newest report carries none, so the order its steps finished in survives the gap. */
  plan_kept_json: string | null;
  reporter_version: string;
  reporter_build: string | null;
  engine_version: string | null;
  /** Report.reporter.hostSurface; null when the reporter did not say (older reporters). */
  host_surface: string | null;
  loop_json: string | null;
  files_json: string | null;
  background_json: string | null;
  usage_json: string | null;
  attached: number | null;
  detached_at: number | null;
  owner: string | null;
  machine_id: string | null;
  machine_json: string | null;
  cleared_from: string | null;
}

/** A session row as a report writes it: every column but the owner's display name, the spend counted and whether it was shown. */
export type ReportedSession = Omit<SessionRow, 'display_name' | 'spend_counted' | 'shown'>;

/** An `agents` row, a column to a line in the table's order. */
export interface AgentRow {
  session_id: string;
  id: string;
  parent_id: string | null;
  kind: AgentReport['kind'];
  type: string;
  name: string | null;
  description: string;
  model: string | null;
  effort: string | null;
  effort_source: AgentReport['effortSource'] | null;
  status: AgentStatus;
  started_at: number;
  ended_at: number | null;
  context_tokens: number | null;
  context_window: number | null;
  context_percent: number | null;
  usage_json: string | null;
  skills_json: string | null;
  last_tool: string | null;
  tool_calls: number;
  tool_counts_json: string | null;
  blowouts: number | null;
  tool_failures: number | null;
  steps_done: number | null;
  steps_total: number | null;
  prompt_excerpt: string | null;
  answer_excerpt: string | null;
  failure_json: string | null;
  last_activity_at: number | null;
  tool_open: number;
  /** Only from `getAgents`: the length of the full prompt and answer stored for the agent; null when there is none. */
  prompt_chars?: number | null;
  answer_chars?: number | null;
}

/** An `events` row: the event's id, session and loop, then its time, kind, text and data. */
export interface EventRow {
  id: string;
  session_id: string;
  agent_id: string | null;
  t: number;
  kind: string;
  text: string;
  data_json: string | null;
}

/** A `blowouts` row: one per session, loop, time and kind, with the context tokens before and after when the reporter knew them. */
export interface BlowoutRow {
  id: number;
  session_id: string;
  agent_id: string | null;
  t: number;
  kind: string;
  tokens_before: number | null;
  tokens_after: number | null;
}

/** A `samples` row: one session's second `t`. */
export interface SampleRow {
  session_id: string;
  t: number;
  /** Every kind of token of the session, its agents' included, from its usage, and their rise since the sample before: what isReplay reads. */
  tokens_total: number;
  tokens_delta: number;
  /** Their output tokens alone, null in a sample from before migration 7, and the rise of those: what the token rates count. */
  output_total: number | null;
  output_delta: number;
  /** The fullest context, 0 to 1, among the main loop and its running agents, and how many agents were running. */
  peak_context: number;
  running_agents: number;
  /** The USD this second booked to the spend record (recordSpend), its reports' together; 0 when it booked nothing. */
  spend_usd: number;
}

/** An agent's full prompt and answer, as kept in `agent_texts`. */
export type AgentTexts = { prompt: string | null; answer: string | null };

/** One model and tier of a session's or agent's request sums (`api_usage`), as requestUsage reads them. */
type UsageSum = Pick<ModelUsage, 'model' | 'tier'> & UsageTokens;

export interface MachineRow {
  id: string;
  name: string;
  os: string | null;
  last_report_at: number;
  claude_reporter: string | null;
  codex_reporter: string | null;
  codex_daemon: string | null;
}

/** An `edit` event inside the collision window, with the names of its loop and the machine of its session. */
export interface EditRow {
  session_id: string;
  agent_id: string | null;
  t: number;
  path: string;
  machine_id: string | null;
  session_name: string;
  agent_name: string | null;
  agent_type: string | null;
}

/** What `listEvents` narrows the newest events to: one session's, and those before a time. */
export interface EventFilter {
  sessionId?: string | null;
  before?: number | null;
}

/** A chart point the samples add up to: a second (`t`) or a minute (`m`, seconds / 60 rounded down), and its value. */
export interface SecondPoint {
  t: number;
  v: number;
}
export interface MinutePoint {
  m: number;
  v: number;
}

/** How long rows are kept: samples and events from their own time, ended sessions and silent machines from when they stopped. */
export interface RetentionPolicy {
  samplesMs: number;
  eventsMs: number;
  sessionsMs: number;
}

/** One row of the spend record: one machine's spend on one model on one server-local day (`YYYY-MM-DD`). */
export interface SpendDayRow {
  day: string;
  machine_id: string;
  provider: string;
  model: string;
  /** Null: tokens were spent on a model with no price. */
  usd: number | null;
}

/** The record's figures for one machine and model, before the KPIs add what only they know. */
export type SpendRow = Omit<SpendRecordRow, 'provider' | 'family'> & Pick<SessionRow, 'provider'>;

type Params = Record<string, SQLInputValue>;

/** `work` as one transaction: committed when it returns, rolled back when it or the commit throws, the error passed on. */
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  let committed = false;
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) db.exec('ROLLBACK');
  }
}

/** Opens a database (`:memory:` for tests; a file gets its folder and WAL journaling) and brings it up to the newest schema. */
export function openDb(file: string): DatabaseSync {
  const inMemory = file === ':memory:';
  if (!inMemory) mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (!inMemory) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  // Migration n is MIGRATIONS[n - 1]; each one not yet recorded runs, in order, in its own transaction with its record.
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => Number(r.version)));
  for (const [i, sql] of MIGRATIONS.entries()) {
    if (applied.has(i + 1)) continue;
    inTransaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, Date.now());
    });
  }
  return db;
}

/**
 * A rise in one sample this large is a reporter reading a session's history, not tokens spent, and the token charts leave it out:
 * Codex's reporter sends a session's whole figure at once after a restart, and samples stored from a codex-reporter before 0.2.0
 * hold its chunked re-reads, up to 20 million tokens a sample. A live Codex session's largest steps are under it. Spend never
 * uses it.
 */
export const REPLAY_STEP = 1_000_000;

/**
 * The harnesses whose reporters read the harness's stored record, codex-reporter its session files and hermes-reporter Hermes's
 * store, and so can send history as one rise. Claude usage arrives a request at a time from Claude Code's telemetry and never as
 * history, and one live Claude request can rise by more than REPLAY_STEP.
 */
export const READS_HISTORY: readonly string[] = ['codex', 'hermes'];

/** A sample of a session of `provider` whose rise is its reporter reading history, which every token chart leaves out; judged on every kind's rise. */
export const isReplay = (s: Pick<SampleRow, 'tokens_delta'>, provider: string): boolean => READS_HISTORY.includes(provider) && s.tokens_delta >= REPLAY_STEP;
/** isReplay's negation in SQL over `samples`, its parameters REPLAY_ARGS. */
const NOT_REPLAY = 'NOT (tokens_delta >= ? AND session_id IN (SELECT id FROM sessions WHERE provider IN (SELECT value FROM json_each(?))))';
const REPLAY_ARGS = [REPLAY_STEP, JSON.stringify(READS_HISTORY)] as const;

/** The models a JSON usage column names, as rows of `model` (SQLite's json_each over `col`). */
const usageModelsOf = (table: string, col: string): string => `SELECT DISTINCT json_extract(u.value, '$.model') AS model FROM ${table}, json_each(${table}.${col}) u`;

/** The fleet's queries over one database. A statement is prepared the first time it runs and kept for the next. */
export class FleetDb {
  private readonly statements = new Map<string, StatementSync>();

  constructor(readonly db: DatabaseSync) {}

  private prepared(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) this.statements.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  /** The first row `sql` returns, or undefined. */
  private one<T>(sql: string, ...params: (SQLInputValue | Params)[]): T | undefined {
    return this.prepared(sql).get(...(params as SQLInputValue[])) as unknown as T | undefined;
  }

  /** Every row `sql` returns. */
  private all<T>(sql: string, ...params: (SQLInputValue | Params)[]): T[] {
    return this.prepared(sql).all(...(params as SQLInputValue[])) as unknown as T[];
  }

  /** Runs `sql` and returns how many rows it changed. */
  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.prepared(sql).run(...params).changes);
  }

  /** Runs `fn` in one transaction, rolled back if it throws. */
  tx<T>(fn: () => T): T {
    return inTransaction(this.db, fn);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Writes a row object whose keys name the columns. With `keys`, a row already stored under them is updated: every other column
   * takes its new value, or the SQL `set` gives for it. Without, a row already stored is left as it is. Returns the rows changed.
   */
  private write(table: string, row: object, keys?: readonly string[], set: Record<string, string> = {}): number {
    const cols = Object.keys(row);
    const insert = `INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`;
    const update = cols.filter((c) => !keys?.includes(c)).map((c) => `${c} = ${set[c] ?? `excluded.${c}`}`);
    const sql = keys ? `INSERT ${insert} ON CONFLICT(${keys.join(', ')}) DO UPDATE SET ${update.join(', ')}` : `INSERT OR IGNORE ${insert}`;
    return Number(this.prepared(sql).run(row as Params).changes);
  }

  // Sessions, by server id (sessionKey).

  upsertSession(row: ReportedSession): void {
    this.write('sessions', row, ['id']);
  }

  getSession(id: string): SessionRow | undefined {
    return this.one('SELECT * FROM sessions WHERE id = ?', id);
  }

  /** The sessions that may still be on the wall, oldest first: not dropped, and not ended or ended after `endedSince`. */
  openSessions(endedSince: number): SessionRow[] {
    return this.all('SELECT * FROM sessions WHERE dropped_at IS NULL AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at', endedSince);
  }

  setDropped(id: string, at: number): void {
    this.run('UPDATE sessions SET dropped_at = ? WHERE id = ?', at, id);
  }

  setShown(id: string): void {
    this.run('UPDATE sessions SET shown = 1 WHERE id = ?', id);
  }

  /** Sets or clears (null) the owner's name for a session; false when there is no such session. */
  setDisplayName(id: string, name: string | null): boolean {
    return this.run('UPDATE sessions SET display_name = ? WHERE id = ?', name, id) > 0;
  }

  /** Deletes a session with every row of its own; whether it existed. */
  private removeSession(id: string): boolean {
    for (const table of ['events', 'blowouts', 'samples', 'agents', 'agent_texts', 'api_usage']) this.run(`DELETE FROM ${table} WHERE session_id = ?`, id);
    return this.run('DELETE FROM sessions WHERE id = ?', id) > 0;
  }

  deleteSession(id: string): boolean {
    return this.tx(() => this.removeSession(id));
  }

  /** The session that took over from `id` after a /clear (the newest, should there be several); null when none did. */
  clearedInto(id: string): string | null {
    return this.one<{ id: string }>('SELECT id FROM sessions WHERE cleared_from = ? ORDER BY started_at DESC LIMIT 1', id)?.id ?? null;
  }

  /** The sessions that left in [from, to): dropped in it, or ended in it and never dropped. */
  leftBetween(from: number, to: number): SessionRow[] {
    const droppedIn = 'dropped_at >= :from AND dropped_at < :to';
    const endedIn = 'dropped_at IS NULL AND ended_at >= :from AND ended_at < :to';
    return this.all(`SELECT * FROM sessions WHERE (${droppedIn}) OR (${endedIn}) ORDER BY started_at`, { from, to });
  }

  /** Every provider and reporter version a stored session came from, once each, as `claude 0.1.0`. */
  reporterVersions(): string[] {
    return this.all<{ v: string }>("SELECT DISTINCT provider || ' ' || reporter_version AS v FROM sessions ORDER BY v").map((r) => r.v);
  }

  // Agents, by session and agent id, and their full texts.

  /** A report that leaves out an agent's usage does not know it: the stored usage stays. */
  upsertAgent(row: AgentRow): void {
    this.write('agents', row, ['session_id', 'id'], { usage_json: 'COALESCE(excluded.usage_json, usage_json)' });
  }

  /** A session's agents in the order they started, each with the length of its stored full texts. */
  getAgents(sessionId: string): AgentRow[] {
    return this.all(
      `SELECT a.*, length(x.prompt_text) AS prompt_chars, length(x.answer_text) AS answer_chars
       FROM agents a LEFT JOIN agent_texts x ON x.session_id = a.session_id AND x.agent_id = a.id
       WHERE a.session_id = ? ORDER BY a.started_at, a.id`,
      sessionId,
    );
  }

  countAgents(sessionId: string): number {
    return this.one<{ n: number }>('SELECT COUNT(*) AS n FROM agents WHERE session_id = ?', sessionId)!.n;
  }

  /** Keeps the full texts a report carried; a text it left out is written as NULL, which keeps the one stored before. */
  upsertAgentTexts(sessionId: string, agentId: string, texts: { prompt?: string; answer?: string }): void {
    const row = { session_id: sessionId, agent_id: agentId, prompt_text: texts.prompt ?? null, answer_text: texts.answer ?? null };
    const keep = (c: string) => `COALESCE(excluded.${c}, ${c})`;
    this.write('agent_texts', row, ['session_id', 'agent_id'], { prompt_text: keep('prompt_text'), answer_text: keep('answer_text') });
  }

  /** An agent's full prompt and answer as kept; null when nothing is kept for it. */
  agentTexts(sessionId: string, agentId: string): AgentTexts | null {
    return this.one<AgentTexts>('SELECT prompt_text AS prompt, answer_text AS answer FROM agent_texts WHERE session_id = ? AND agent_id = ?', sessionId, agentId) ?? null;
  }

  /** For a session that ended: each agent still running or queued is aborted, ending at `at` unless it has an end already. */
  abortUnfinishedAgents(sessionId: string, at: number): void {
    this.run("UPDATE agents SET status = 'aborted', ended_at = COALESCE(ended_at, ?), tool_open = 0 WHERE session_id = ? AND status IN ('running', 'queued')", at, sessionId);
  }

  // Events, each stored once by its id.

  /** Stores an event unless its id is stored already; true when it was stored now. */
  insertEvent(row: EventRow): boolean {
    return this.write('events', row) > 0;
  }

  /**
   * The activity rows the browser gets: events newest first (ties newest id first), of one session or all, before `before`
   * when given. `edit` events are left out, so a page is never short: they stay stored as the collision signal (`editsSince`),
   * and only the collision note one raises is an activity row.
   */
  listEvents(limit: number, { sessionId, before }: EventFilter = {}): EventRow[] {
    const newest = "t < ? AND kind != 'edit' ORDER BY t DESC, id DESC LIMIT ?";
    const until = before ?? Number.MAX_SAFE_INTEGER;
    if (sessionId) return this.all(`SELECT * FROM events WHERE session_id = ? AND ${newest}`, sessionId, until, limit);
    return this.all(`SELECT * FROM events WHERE ${newest}`, until, limit);
  }

  countEvents(sessionId?: string): number {
    if (sessionId === undefined) return this.one<{ n: number }>('SELECT COUNT(*) AS n FROM events')!.n;
    return this.one<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE session_id = ?', sessionId)!.n;
  }

  /** The `edit` events at or after `since` (event time), with their loop's names (the owner's name for a main loop) and their session's machine. */
  editsSince(since: number): EditRow[] {
    return this.all(
      `SELECT e.session_id AS session_id, e.agent_id AS agent_id, e.t AS t, json_extract(e.data_json, '$.path') AS path,
         s.machine_id AS machine_id, COALESCE(s.display_name, s.name) AS session_name, a.name AS agent_name, a.type AS agent_type
       FROM events e JOIN sessions s ON s.id = e.session_id LEFT JOIN agents a ON a.session_id = e.session_id AND a.id = e.agent_id
       WHERE e.t >= ? AND e.kind = 'edit' ORDER BY e.t`,
      since,
    );
  }

  /** A session's `message` events at or after `since` (event time), newest first (ties newest id first), at most `limit`. */
  messagesSince(sessionId: string, since: number, limit: number): EventRow[] {
    return this.all("SELECT * FROM events WHERE session_id = ? AND kind = 'message' AND t >= ? ORDER BY t DESC, id DESC LIMIT ?", sessionId, since, limit);
  }

  // Blowouts: one per session, loop, time and kind.

  /** Keeps a blowout, once per session, loop, time and kind. */
  addBlowout(row: Omit<BlowoutRow, 'id'>): void {
    this.write('blowouts', row);
  }

  getBlowouts(sessionId: string): BlowoutRow[] {
    return this.all('SELECT * FROM blowouts WHERE session_id = ? ORDER BY t', sessionId);
  }

  // Samples: one per session per second.

  /** The session's newest sample from before second `t`. */
  previousSample(sessionId: string, t: number): SampleRow | undefined {
    return this.one('SELECT * FROM samples WHERE session_id = ? AND t < ? ORDER BY t DESC LIMIT 1', sessionId, t);
  }

  /** The session's newest sample of all. */
  newestSample(sessionId: string): SampleRow | undefined {
    return this.one('SELECT * FROM samples WHERE session_id = ? ORDER BY t DESC LIMIT 1', sessionId);
  }

  /** The sample of second `t`, one per second: a second sampled already takes the new figures and adds the new spend to its own. */
  upsertSample(row: SampleRow): void {
    this.write('samples', row, ['session_id', 't'], { spend_usd: 'samples.spend_usd + excluded.spend_usd' });
  }

  /** The sample of second `t`, only when that second has none. */
  insertSampleIfAbsent(row: SampleRow): void {
    this.write('samples', row);
  }

  /** The session's samples from second `fromT` on, oldest first. */
  samplesFrom(sessionId: string, fromT: number): SampleRow[] {
    return this.all('SELECT * FROM samples WHERE session_id = ? AND t >= ? ORDER BY t', sessionId, fromT);
  }

  /** The fleet's output tokens per second (Σ output_delta), for each second from `fromT` on, replays left out. */
  fleetTokensPerSecond(fromT: number): SecondPoint[] {
    return this.all(`SELECT t, SUM(output_delta) AS v FROM samples WHERE t >= ? AND ${NOT_REPLAY} GROUP BY t ORDER BY t`, fromT, ...REPLAY_ARGS);
  }

  /**
   * A session's output tokens in each minute (`m`, 0 for the minute from second `fromT`) from second `fromT` to `toT` inclusive,
   * replays left out. node:sqlite binds a JS number as REAL, so the bucket is cast to a whole number.
   */
  sessionTokensPerMinute(sessionId: string, fromT: number, toT: number): MinutePoint[] {
    return this.all(`SELECT CAST((t - ?) / 60 AS INTEGER) AS m, SUM(output_delta) AS v FROM samples WHERE session_id = ? AND t >= ? AND t <= ? AND ${NOT_REPLAY} GROUP BY m ORDER BY m`, fromT, sessionId, fromT, toT, ...REPLAY_ARGS);
  }

  /** The USD the spend record booked in each minute (seconds / 60, rounded down) from second `fromT` on, as the samples keep it. */
  fleetCostPerMinute(fromT: number): MinutePoint[] {
    return this.all('SELECT CAST(t / 60 AS INTEGER) AS m, SUM(spend_usd) AS v FROM samples WHERE t >= ? GROUP BY m ORDER BY m', fromT);
  }

  // Machines.

  /** A report from a machine: the columns it sets replace the stored ones, and a column it leaves undefined stays. */
  noteMachine(row: Pick<MachineRow, 'id' | 'name' | 'os' | 'last_report_at'> & Partial<MachineRow>): void {
    this.write('machines', Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)), ['id']);
  }

  listMachines(): MachineRow[] {
    return this.all('SELECT * FROM machines ORDER BY name, id');
  }

  /** Takes a machine off the list; a report from it brings it back. Whether it was there. */
  deleteMachine(id: string): boolean {
    return this.run('DELETE FROM machines WHERE id = ?', id) > 0;
  }

  // Settings and backup.

  getSetting(key: string): string | null {
    return this.one<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.write('settings', { key, value }, ['key']);
  }

  // Sign-ins, each by the SHA-256 of its cookie's id.

  /** When a sign-in was last used; null when there is no such sign-in. */
  signInUsedAt(idHash: string): number | null {
    return this.one<{ last_used_at: number }>('SELECT last_used_at FROM sign_ins WHERE id_hash = ?', idHash)?.last_used_at ?? null;
  }

  /** Starts a sign-in, or notes one used at `at`; then keeps only the `keep` most recently used. */
  useSignIn(idHash: string, at: number, keep: number): void {
    this.tx(() => {
      this.write('sign_ins', { id_hash: idHash, last_used_at: at }, ['id_hash']);
      this.run('DELETE FROM sign_ins WHERE id_hash NOT IN (SELECT id_hash FROM sign_ins ORDER BY last_used_at DESC LIMIT ?)', keep);
    });
  }

  /** Ends one sign-in (`idHash`), or every one (no argument); how many ended. */
  endSignIns(idHash?: string): number {
    return idHash === undefined ? this.run('DELETE FROM sign_ins') : this.run('DELETE FROM sign_ins WHERE id_hash = ?', idHash);
  }

  /** Writes a consistent copy of the whole database to a new file (`VACUUM INTO`); the file must not exist yet. */
  backupTo(file: string): void {
    this.db.prepare('VACUUM INTO ?').run(file);
  }

  // Claude Code's API requests: each counted once, its tokens added to its session's sums.

  /** Notes a request id at `t`; false when it was noted before, so a record sent again is not counted again. */
  addRequest(requestId: string, t: number): boolean {
    return this.write('api_requests', { request_id: requestId, t }) > 0;
  }

  /** Adds one request's tokens to its session's sum for its agent ('' for the main loop), model and tier, as of `at`. */
  addRequestUsage(sessionId: string, agentId: string, { model, tier, tokens: t }: ModelUsage, at: number): void {
    const row = { session_id: sessionId, agent_id: agentId, model, tier, input: t.input, output: t.output, cache_read: t.cacheRead, cache_write: t.cacheWrite, cache_write_1h: t.cacheWrite1h, last_at: at };
    const add = Object.fromEntries(['input', 'output', 'cache_read', 'cache_write', 'cache_write_1h'].map((c) => [c, `api_usage.${c} + excluded.${c}`]));
    this.write('api_usage', row, ['session_id', 'agent_id', 'model', 'tier'], add);
  }

  /** A session's usage per model and tier summed from its requests, its agents' included, or one agent's alone; null with none. */
  requestUsage(sessionId: string, agentId?: string): ModelUsage[] | null {
    const sums = 'SELECT model, tier, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite, SUM(cache_write_1h) AS cacheWrite1h FROM api_usage WHERE session_id = ?';
    const rows =
      agentId === undefined
        ? this.all<UsageSum>(`${sums} GROUP BY model, tier ORDER BY model, tier`, sessionId)
        : this.all<UsageSum>(`${sums} AND agent_id = ? GROUP BY model, tier ORDER BY model, tier`, sessionId, agentId);
    return rows.length === 0 ? null : rows.map(({ model, tier, ...tokens }) => ({ model, tier, tokens }));
  }

  /** Writes the usage of a stored session (`agentId` null) or of one of its stored agents; nothing when the row is not there yet. */
  setUsage(sessionId: string, agentId: string | null, usage: ModelUsage[]): void {
    const json = JSON.stringify(usage);
    if (agentId === null) this.run('UPDATE sessions SET usage_json = ? WHERE id = ?', json, sessionId);
    else this.run('UPDATE agents SET usage_json = ? WHERE session_id = ? AND id = ?', json, sessionId, agentId);
  }

  // The spend record: spend already happened, so `retain` and `removeSession` leave it alone.

  /** The highest cost of a session the record has counted; null: none yet. */
  setSpendCounted(id: string, usd: number | null): void {
    this.run('UPDATE sessions SET spend_counted = ? WHERE id = ?', usd, id);
  }

  /** Every session's next figure sets its baseline again. */
  restartSpendCounts(): void {
    this.run('UPDATE sessions SET spend_counted = NULL');
  }

  /** The next figure of each session whose usage names one of `models` sets its baseline again; how many sessions that is. */
  restartSpendCountsFor(models: readonly string[]): number {
    const named = "EXISTS (SELECT 1 FROM json_each(sessions.usage_json) u WHERE json_extract(u.value, '$.model') IN (SELECT value FROM json_each(?)))";
    return this.run(`UPDATE sessions SET spend_counted = NULL WHERE ${named}`, JSON.stringify(models));
  }

  /** Every model a stored session or agent names, as its model or in its usage, once each, sorted. */
  modelIds(): string[] {
    const named = `SELECT model FROM sessions UNION SELECT model FROM agents UNION ${usageModelsOf('sessions', 'usage_json')} UNION ${usageModelsOf('agents', 'usage_json')}`;
    return this.all<{ model: unknown }>(`SELECT model FROM (${named}) WHERE model IS NOT NULL ORDER BY model`).flatMap((r) => (typeof r.model === 'string' && r.model !== '' ? [r.model] : []));
  }

  /** Adds to a day's row. A null `usd` only makes sure the row exists: unknown never erases a figure, and a figure replaces unknown. */
  addSpend(row: SpendDayRow): void {
    if (row.usd === null) this.write('spend_days', row);
    else this.write('spend_days', row, ['day', 'machine_id', 'provider', 'model'], { usd: 'COALESCE(usd, 0) + excluded.usd' });
  }

  /**
   * The record by machine and model, and `since`, the first day it holds (null while it is empty). In each span a figure is 0 with
   * no row in it, and null when its rows there all say null.
   */
  spendRecord(today: string, weekFrom: string): { rows: SpendRow[]; since: string | null } {
    const span = (days: string) => `CASE WHEN COUNT(*) FILTER (WHERE ${days}) = 0 THEN 0 ELSE SUM(usd) FILTER (WHERE ${days}) END`;
    const rows = this.all<SpendRow>(
      `SELECT machine_id AS machineId, provider, model, ${span('day = :today')} AS today, ${span('day >= :weekFrom')} AS week, SUM(usd) AS alltime
       FROM spend_days GROUP BY machine_id, provider, model ORDER BY machine_id, provider, model`,
      { today, weekFrom },
    );
    return { rows, since: this.one<{ since: string | null }>('SELECT MIN(day) AS since FROM spend_days')!.since };
  }

  // Retention.

  /**
   * Deletes old samples and events, sessions that ended long enough ago (with their rows), and machines silent as long; request ids
   * as old as old samples, long past any resend of their record; and the request sums of a session that never reported, once
   * as quiet as an ended session that goes.
   */
  retain(now: number, p: RetentionPolicy): { samples: number; events: number; sessions: number; machines: number } {
    return this.tx(() => {
      const samples = this.run('DELETE FROM samples WHERE t < ?', Math.floor((now - p.samplesMs) / 1000));
      this.run('DELETE FROM api_requests WHERE t < ?', now - p.samplesMs);
      const events = this.run('DELETE FROM events WHERE t < ?', now - p.eventsMs);
      const cutoff = now - p.sessionsMs;
      const old = this.all<{ id: string }>('SELECT id FROM sessions WHERE (ended_at IS NOT NULL AND ended_at < ?) OR (dropped_at IS NOT NULL AND dropped_at < ?)', cutoff, cutoff);
      for (const { id } of old) this.removeSession(id);
      this.run('DELETE FROM api_usage WHERE last_at < ? AND session_id NOT IN (SELECT id FROM sessions)', cutoff);
      const machines = this.run('DELETE FROM machines WHERE last_report_at < ?', cutoff);
      return { samples, events, sessions: old.length, machines };
    });
  }
}
