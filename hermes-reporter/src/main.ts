// hermes-reporter: reports the sessions of one Hermes Agent home to the dashboard server, observe-only. It reads Hermes's own
// session store read-only on a timer (store.ts), as codex-reporter reads Codex's session files, and posts each session's report
// with codex-reporter's transport, machine identity and redaction, imported, not copied. No hooks, no answering, no deliveries.
// Configuration is codex-reporter's own module (codex-reporter/src/config.ts: CODEX_REPORTER_SERVER_URL, CODEX_REPORTER_TOKEN,
// from the environment or a `.env` file in the working directory), so one env file serves both, plus:
//
//   HERMES_HOME  the Hermes home holding state.db, as Hermes finds its own (default /hermes, the sidecar's mount)
import path from 'node:path';
import {
  LIMITS,
  reporterOf,
  type ActivityEvent,
  type AgentReport,
  type AgentStatus,
  type ContextFill,
  type MachineInfo,
  type ModelUsage,
  type Report,
} from '../../server/src/fleet/protocol.js';
import { serverUrl, token } from '../../codex-reporter/src/config.js';
import { readMachine } from '../../codex-reporter/src/machine.js';
import { clip, excerpt, promptName } from '../../codex-reporter/src/report.js';
import { Transport } from '../../codex-reporter/src/transport.js';
import { ACTIVE_WINDOW_MS, HermesStore, hermesHome, type LastTurn, type ModelTokens, type StoredAgent, type StoredSession } from './store.js';

export const VERSION = '0.1.0';
const PROVIDER = 'hermes';
/** codex-reporter's cadence: a pass every second, a heartbeat every 5 s. */
const TICK_MS = 1000;
const HEARTBEAT_MS = 5000;
/** What one report carries at most: usage rows (codex-reporter's MOST.usageRows, the server's LIMITS.usageModels). */
const USAGE_ROWS = 40;
/**
 * Why an open session leaves the board: Hermes no longer counts it active (ACTIVE_WINDOW_MS without activity, when its web UI
 * drops the "Live" badge), while it keeps the session open (`ended_at` unset). The negation of Hermes's `is_active`.
 */
const INACTIVE = 'inactive';
/** Hermes records no context fill for a session or a subagent run: every figure of it unknown. */
const NO_CONTEXT: ContextFill = { tokens: null, window: null, percent: null };

/** Each line with its UTC time, as codex-reporter's: `docker logs` shows Docker's own only with -t. */
const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);

const store = new HermesStore(path.join(hermesHome(), 'state.db'));

// ---- the report ----------------------------------------------------------------------------------

/** Hermes's per-model totals as the report sends them: a whole life cannot be split by request size, so every row is `std`. */
const usageRows = (rows: readonly ModelTokens[]): ModelUsage[] =>
  rows.slice(0, USAGE_ROWS).map((r) => ({
    model: clip(r.model, 120),
    tier: 'std',
    tokens: { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, cacheWrite1h: 0 },
  }));

/**
 * A session's or an agent's `usageByModel`: an empty list while Hermes has recorded no tokens for it, a known zero, so
 * the server books the session's first real figure instead of only starting its count there.
 */
const usageField = (rows: readonly ModelTokens[]): { usageByModel: ModelUsage[] } => ({ usageByModel: usageRows(rows) });

/**
 * A subagent run's state by Hermes's own record: running until Hermes ends its session; then, by its last turn as Hermes
 * classifies it (`classify_session_status`, `hermes_state.py:4017-4042`), failed on an error, aborted when it stopped mid-turn
 * (`interrupted`), otherwise done.
 */
function agentStatus(a: StoredAgent): AgentStatus {
  if (a.endedAt === null) return 'running';
  return a.turn?.state === 'error' ? 'failed' : a.turn?.state === 'interrupted' ? 'aborted' : 'done';
}

/**
 * A subagent run as one of the session's agents, as codex-reporter reports a child thread (`codex-reporter/src/report.ts`
 * agentReport): its id, the run that delegated it (null for the session itself), Hermes's `source` for it as its type, its model,
 * state, times, tool calls, last activity and its own usage. Its task and answer are message text, which this reporter does not
 * read for agents, and Hermes records no name, context, effort, plan or failure detail for a run: empty or unknown.
 */
function agentReport(s: StoredSession, a: StoredAgent, usage: readonly ModelTokens[]): AgentReport {
  const status = agentStatus(a);
  return {
    id: clip(a.id, LIMITS.id),
    parentId: a.parentId === s.id ? null : clip(a.parentId, LIMITS.id),
    kind: 'subagent',
    type: clip(a.source ?? 'subagent', LIMITS.short),
    name: null,
    description: '',
    model: a.model && clip(a.model, LIMITS.short),
    effort: null,
    effortSource: 'unknown',
    status,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    context: NO_CONTEXT,
    costUsdEst: null,
    ...usageField(usage),
    skills: [],
    lastTool: null,
    toolCalls: a.toolCalls,
    toolCounts: null,
    steps: null,
    blowouts: null,
    toolFailures: null,
    failure: null,
    promptExcerpt: '',
    answerExcerpt: null,
    lastActivityAt: a.lastActive,
    toolOpen: status === 'running' && !!a.turn?.toolOpen,
  };
}

/**
 * A last turn Hermes classifies as an error, as codex-reporter reports a failed turn (`codex-reporter/src/mapping.ts:864-868`):
 * one main-loop `fail` event whose `category` is Hermes's finish reason, which the server holds as the session's
 * errored state until it runs again. Its id is the session's and the message's, so sending it again stores nothing.
 */
const failEvent = (s: StoredSession, error: NonNullable<LastTurn['error']>): ActivityEvent => ({
  id: `${s.id}:main:fail:${error.messageId}`,
  t: error.at,
  kind: 'fail',
  agentId: null,
  text: clip(`turn ended with an error (${error.reason})`, LIMITS.text),
  data: { category: clip(error.reason, 120) },
});

/**
 * One Hermes session as a report; null while it has no message, which Hermes calls `empty` and the dashboard would not show.
 * Status follows Hermes: an ended row is done with its end reason; an open one Hermes no longer counts active is done as INACTIVE,
 * as Hermes's web UI drops it from Live, and reports again if it becomes active; an active one runs while its last turn is
 * unanswered (`interrupted`), and is idle once the turn has ended; a turn that ended in error also carries its `fail` event
 * (failEvent). Its delegated subagent runs are its agents. Whatever Hermes does not record is left unknown.
 */
function buildReport(s: StoredSession, machine: MachineInfo, now: number): Report | null {
  const turn = store.lastTurn(s.id);
  if (!turn) return null;
  const ended = s.endedAt !== null;
  const done = ended || !s.active;
  const running = !done && turn.state === 'interrupted';
  const usage = store.usage(s.id);
  return {
    v: 1,
    sentAt: now,
    provider: PROVIDER,
    reporter: { name: reporterOf(PROVIDER), version: VERSION, engineVersion: null, hostSurface: s.source && clip(s.source, 120) },
    machine,
    session: {
      id: s.id,
      name: excerpt(s.title, 80) || promptName(store.firstPrompt(s.id), 80) || 'Hermes session',
      status: done ? 'done' : running ? 'running' : 'waiting',
      waitReason: done || running ? null : 'idle',
      waitNote: null,
      endReason: ended ? clip(s.endReason ?? 'other', 120) : done ? INACTIVE : null,
      resumeId: s.id,
      startedAt: s.startedAt,
      // Empty when Hermes recorded none: unknown, never a made-up folder.
      cwd: s.cwd ?? '',
      projectRoot: s.repoRoot,
      repoName: null,
      git: null,
      model: s.model && clip(s.model, 120),
      effort: null,
      context: NO_CONTEXT,
      costUsd: null,
      ...usageField(usage.total),
      rateLimits: [],
      blowouts: null,
      toolFailures: null,
      plan: null,
      loop: null,
      files: null,
      attached: null,
      activityFeed: false,
      respond: { level: 'off', accepts: [], limits: ['observe-only'] },
      lastActivityAt: s.lastActive,
      toolOpen: running && turn.toolOpen,
    },
    // The newest LIMITS.agents, as codex-reporter keeps its newest children.
    agents: store.agents(s.id).slice(-LIMITS.agents).map((a) => agentReport(s, a, usage.own.get(a.id) ?? [])),
    events: turn.error ? [failEvent(s, turn.error)] : [],
  };
}

// ---- the process --------------------------------------------------------------------------------------

interface Reported {
  transport: Transport;
  /** The last report the server answered, without its `sentAt` and events: an unchanged live one waits for the heartbeat. */
  sent: string | null;
  /** The last event handed to the transport, which queues it until the server acks it. */
  queued: string | null;
}

let machine: MachineInfo;
const reported = new Map<string, Reported>();
/**
 * Sessions read every pass whether or not Hermes still counts them active: each one reported live, so the pass that finds it out
 * of Hermes's active set reports that, and each final report the server has not taken (codex-reporter follows a session until its
 * final report is taken, `finalFor`).
 */
const followed = new Set<string>();
let failing: string | null = null;

/**
 * Posts a report when one is due. A live one: when it changed, or for the heartbeat. A final one (done: ended, or INACTIVE):
 * whenever it differs from the last one the server took, so usage Hermes writes after the end is sent too, never as a heartbeat.
 */
async function send(s: StoredSession, report: Report, now: number): Promise<void> {
  let r = reported.get(s.id);
  if (!r) {
    r = { transport: new Transport(serverUrl, token, HEARTBEAT_MS, log, 'hermes-reporter', s.id), sent: null, queued: null };
    reported.set(s.id, r);
  }
  const fresh = report.events.filter((e) => e.id !== r.queued);
  if (fresh.length) {
    r.transport.push(fresh);
    r.queued = fresh[fresh.length - 1]!.id;
  }
  const body = JSON.stringify({ ...report, sentAt: 0, events: [] });
  const final = report.session.status === 'done';
  const changed = body !== r.sent;
  if (!final || changed) followed.add(s.id);
  if (final && !changed && !r.transport.queue.length) return;
  if (!r.transport.ready(now, changed)) return;
  const outcome = await r.transport.send((events) => ({ ...report, events }), now);
  if (outcome === 'later') return;
  r.sent = body;
  if (final) followed.delete(s.id);
}

/**
 * One pass: every session Hermes has active or whose usage it wrote within its active window, and every followed one, each sent
 * when due. Reading never waits on a post.
 */
function tick(): void {
  const now = Date.now();
  const seen = new Set<string>();
  try {
    for (const s of store.sessions(now - ACTIVE_WINDOW_MS, [...followed])) {
      seen.add(s.id);
      const report = buildReport(s, machine, now);
      if (report) void send(s, report, now).catch((err: Error) => log(`hermes-reporter: report: ${err.message}`));
    }
    if (failing !== null) log('hermes-reporter: reading the Hermes store again');
    failing = null;
  } catch (err) {
    // Logged once per distinct failure; the store is reopened on the next pass. Nothing is reported meanwhile, so the cards go
    // stale and drop on the server's timers instead of showing a reading that stopped.
    const message = (err as Error).message;
    if (message !== failing) log(`hermes-reporter: reading ${store.file}: ${message}`);
    failing = message;
    store.reset();
    return;
  }
  // Out of the read set: its final report taken and its window passed, or gone from Hermes's list (archived, hidden, deleted).
  for (const id of reported.keys()) if (!seen.has(id)) reported.delete(id);
  for (const id of followed) if (!seen.has(id)) followed.delete(id);
}

async function main(): Promise<void> {
  try {
    machine = await readMachine();
  } catch (err) {
    // machine.ts makes an id only for a missing file; any other failure stops this reporter, loudly, until it is fixed.
    log(`hermes-reporter: stopping: this machine's id cannot be read: ${(err as Error).message}`);
    process.exit(1);
  }
  log(`hermes-reporter ${VERSION}: reporting ${store.file} to ${serverUrl} as ${machine.name}, observe-only`);
  if (!token) log('hermes-reporter: CODEX_REPORTER_TOKEN is not set; the server will refuse reports if it has an admin secret');
  setInterval(tick, TICK_MS);
  const stop = () => {
    store.reset();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
