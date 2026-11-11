// One session's state in memory, and the pure reducers the hooks feed it. Beyond the session's basic facts it keeps
// these: when each loop last did something, whether it has a tool call open, how many of its tool calls
// failed in a row, the category of an API failure, an edit event as each file-editing call starts, and a message event as
// each SendMessage call starts. A reducer never changes the state it is given; it returns a new one. Nothing here
// calls `$` or draws.
import type { ClassicEventOf, TurnCompleteReason, TurnUsage } from 'claude-code';
import { clip, clipCall, clipFreeText, evidenceLines, excerpt, failingCall, failureClass, failureRecord, fullText, type CallResult, type FailureCandidate } from './failures.ts';
import { lastSegment, resolvePath } from './git.ts';
import { shortName, windowOf } from './models.ts';
import { emptyPlan, setTitle, taskCreate, taskUpdate, todoWrite, withOwners, type PlanState } from './plan.ts';
import { backgroundSummary, EFFORTS, LIMITS, MAIN_LOOP, type ActivityEntry, type ActivityEvent, type AgentReport, type AgentStatus, type BackgroundKind, type BackgroundTask, type BackgroundWait, type ContextFill, type Effort, type FilesReport, type GitInfo, type RateLimit } from './protocol.ts';
import { toolDenied } from './respond.ts';

/** Two blowout signals on one loop this close together (a window-exceeded stop and the compaction it sets off) count once. */
const BLOWOUT_DEDUP_MS = 2000;
const EVENTS_KEPT = 500;
/** Nothing changed yet; also what a session outside a repository reports. */
export const NO_FILES: FilesReport = { since: 'start', files: [], total: 0, added: 0, removed: 0 };
/** The reporter's own plan tool as Claude Code names a plugin's tool: `mcp__<plugin>__<name>`. */
const PLAN_TOOL = 'mcp__sitrep-reporter__plan';
/** Entries a watched loop keeps. */
const ACTIVITY_KEPT = 20;
/** The most distinct tool names a loop counts by name; calls of later new names count in toolCalls only. */
const TOOL_NAMES_KEPT = 100;
/** The tools whose call edits one file, and the input key that names it. */
const EDIT_TOOLS: ReadonlyMap<string, string> = new Map([
  ['Edit', 'file_path'],
  ['Write', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
]);
/** The tool by which a loop messages another agent or session. */
const MESSAGE_TOOL = 'SendMessage';
/** What SendMessage calls the main loop: `main`, and in an agent team the lead's name, `team-lead`. */
const MAIN_LOOP_NAMES: ReadonlySet<string> = new Set(['main', 'team-lead']);
/** How far apart a StopFailure and the turn end it explains may be and still be taken as one failure. */
const API_FAILURE_PAIR_MS = 5000;
/** A failing call this old when its loop ends is not taken as the cause. */
const CANDIDATE_FRESH_MS = 60_000;
const BLOW_TIMES_KEPT = 20;
const SKILLS_KEPT = 50;
/** Characters of a wait note. */
const NOTE_MAX = 160;

const UNKNOWN_CONTEXT: ContextFill = { tokens: null, window: null, percent: null };

/** A request's prompt (input + cache reads + cache writes), a missing count as 0: the context it ran in. */
const promptOf = (u: TurnUsage): number => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

/** What the reporter keeps of one loop: the orchestrator's (the main loop) or an agent's. */
export interface LoopStats {
  model: string | null;
  effort: Effort | null;
  window: number | null;
  /** The prompt of the loop's last request, which is the context it runs in. */
  ctxTokens: number | null;
  /** Model requests seen. */
  steps: number;
  lastStopReason: string | null;
  lastTool: string | null;
  toolCalls: number;
  /** Finished calls per tool name, at most TOOL_NAMES_KEPT names. */
  toolCounts: Record<string, number>;
  skills: string[];
  blowouts: number;
  /** When the last 20 blowouts happened. */
  blowTimes: number[];
  /** The loop's last failing call, what a failure would be blamed on. */
  candidate: FailureCandidate | null;
  /** How often each failing call, in one line, failed. */
  failedCalls: Record<string, number>;
  /** How often each file was read. */
  reads: Record<string, number>;
  /** Tool calls of the loop started and not yet finished. */
  openTools: number;
  /** Failed tool calls in a row, back to 0 at a successful result and at a turn's start or end. */
  toolFailures: number;
  /** The loop's last turn start, model request, tool call or result, compaction or turn end (epoch ms); never a heartbeat. */
  lastActivityAt: number | null;
  /** The last 20 feed entries, oldest first; empty unless the loop is watched. */
  activity: ActivityEntry[];
}

/** One agent: a loop of its own plus the contract's facts about it, and the full texts the fullPrompts option sends. */
export interface AgentState
  extends LoopStats,
    Pick<AgentReport, 'id' | 'parentId' | 'kind' | 'type' | 'name' | 'description' | 'effortSource' | 'status' | 'startedAt' | 'endedAt' | 'promptExcerpt' | 'answerExcerpt' | 'failure'> {
  /** The Agent tool call that launched it. */
  toolUseId: string | null;
  /** The whole redacted texts; null until known. */
  promptText: string | null;
  answerText: string | null;
  /** The current text went out in an accepted report and is not sent again. */
  promptSent: boolean;
  answerSent: boolean;
}

/** What the model asked for in an Agent tool call, kept until the agent it launches is seen (either may come first). */
export interface PendingSpawn {
  at: number;
  model: string | null;
  effort: Effort | null;
  subagentType: string | null;
  name: string | null;
  description: string | null;
}

/** One loop's permission prompt: the note it is shown by, and when it showed (epoch ms). */
export interface PermissionWait {
  note: string | null;
  at: number;
}

/** Everything the reporter knows of one session. */
export interface SessionState {
  id: string;
  /** When the session began (epoch ms). */
  startedAt: number;
  ended: boolean;
  endReason: string | null;
  resumeId: string | null;
  // Where it runs.
  cwd: string;
  projectRoot: string | null;
  repoName: string | null;
  /** Whether a client is attached; null until the roster is read. */
  attached: boolean | null;
  git: GitInfo | null;
  /** The commit HEAD was at when the session began; the files list diffs against it. */
  gitBase: string | null;
  files: FilesReport;
  // What it is doing.
  status: 'running' | 'waiting' | 'done';
  /**
   * A permission prompt of any loop (`permissionWaits`), or `idle`: the main loop's turn ended and nothing is asked.
   * Claude Code raises a question and a plan as permission prompts too, so this mod never sends `input`; idle on background
   * work is null. Worked out by `settled`, as is the note: the newest prompt's.
   */
  waitReason: 'permission' | 'idle' | null;
  waitNote: string | null;
  /**
   * The permission prompts up now, by the loop that asked (an agent's id, MAIN_LOOP for the main loop), each with its note and
   * when it showed. Each lasts until that loop moves on: a call of it starts, returns or is aborted, or its turn ends.
   */
  permissionWaits: Record<string, PermissionWait>;
  /** The main loop is between turns. */
  mainIdle: boolean;
  /** Background work or a wake-up the idle main loop waits on; null when none. */
  background: BackgroundWait | null;
  /** The main loop's turn ended on an API failure Claude Code named (`classic.StopFailure`); cleared when a turn starts. */
  apiFailure: { category: string; at: number } | null;
  main: LoopStats;
  agents: Record<string, AgentState>;
  /** Agent ids in the order first seen. */
  order: string[];
  /** What each Agent call asked for, by tool_use_id, held until the agent it launches is seen (agentSpawned takes it). */
  pending: Record<string, PendingSpawn>;
  plan: PlanState;
  /** The loops the server last listed as watched (agent ids, MAIN_LOOP for the main loop); empty with the activityFeed option off. */
  watched: string[];
  /** The main loop's context as the status line reads it, preferred over step usage. */
  context: ContextFill;
  rateLimits: RateLimit[];
  /**
   * When a model response of any loop last came back (epoch ms); null until one does under this load. `session.usage()` gives
   * the plan windows the last API response carried, so this is when its windows were measured, however often they are read.
   */
  respondedAt: number | null;
  events: ActivityEvent[];
  evSeq: number;
  dirty: boolean;
}

/** A loop before its first model request or tool call, grouped by what each counter is about. */
function emptyLoop(model: string | null = null): LoopStats {
  const requests = { model, effort: null, window: null, ctxTokens: null, steps: 0, lastStopReason: null };
  const tools = { lastTool: null, toolCalls: 0, toolCounts: {}, skills: [], openTools: 0, toolFailures: 0 };
  const trouble = { blowouts: 0, blowTimes: [], candidate: null, failedCalls: {}, reads: {} };
  return { ...requests, ...tools, ...trouble, lastActivityAt: null, activity: [] };
}

/** A session that has done nothing yet: idle before its first prompt, in a folder not looked at yet. Fields in SessionState's order. */
export function newSession(id: string, cwd: string, startedAt: number, model: string | null = null): SessionState {
  return {
    id,
    startedAt,
    ended: false,
    endReason: null,
    resumeId: null,
    cwd,
    projectRoot: null,
    repoName: null,
    attached: null,
    git: null,
    gitBase: null,
    files: NO_FILES,
    status: 'waiting',
    waitReason: 'idle',
    waitNote: null,
    permissionWaits: {},
    mainIdle: true,
    background: null,
    apiFailure: null,
    main: emptyLoop(model),
    agents: {},
    order: [],
    pending: {},
    plan: emptyPlan,
    watched: [],
    context: UNKNOWN_CONTEXT,
    rateLimits: [],
    respondedAt: null,
    events: [],
    evSeq: 0,
    dirty: true,
  };
}

/** The session a /clear starts under a new id: where it runs, and the main loop's model and effort, carry over. */
export function continuedAs(s: SessionState, id: string, startedAt: number): SessionState {
  const fresh = newSession(id, s.cwd, startedAt, s.main.model);
  return { ...fresh, main: { ...fresh.main, effort: s.main.effort }, projectRoot: s.projectRoot, repoName: s.repoName, git: s.git };
}

// ---- helpers ------------------------------------------------------------------------------------------------------------

/** One of Claude Code's effort levels; null for anything else. */
const effortOf = (v: unknown): Effort | null => EFFORTS.find((e) => e === v) ?? null;

/** A string with something in it; null for anything else. */
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const isFinal = (status: AgentStatus) => status === 'done' || status === 'failed' || status === 'aborted';
const isOpen = (status: AgentStatus) => status === 'running' || status === 'queued';

/** Plain data compared by its JSON. */
const sameData = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The key a loop's permission prompt is held under: the agent's id, or MAIN_LOOP. */
const loopKey = (agentId: string | null | undefined): string => agentId || MAIN_LOOP;

/** The prompt that showed last; undefined when none is up. */
const newestWait = (waits: Record<string, PermissionWait>): PermissionWait | undefined =>
  Object.values(waits).reduce<PermissionWait | undefined>((newest, w) => (newest === undefined || w.at >= newest.at ? w : newest), undefined);

/** The prompts up, less the one of this loop. */
const withoutWait = (waits: Record<string, PermissionWait>, agentId: string | null | undefined): Record<string, PermissionWait> =>
  Object.fromEntries(Object.entries(waits).filter(([key]) => key !== loopKey(agentId)));

/**
 * `s` with its status worked out again from its parts: over; held on a permission prompt while any loop's is up, shown by the
 * newest one's note; idle, or idle on background work or a wake-up, which is no wait on the person; or running. An agent that
 * is done, failed or aborted holds no prompt, however it ended (its turn's end, the engine's list, the session's end).
 */
function settled(state: SessionState): SessionState {
  const finished = (key: string) => {
    const agent = state.agents[key];
    return agent !== undefined && isFinal(agent.status);
  };
  const permissionWaits = Object.fromEntries(Object.entries(state.permissionWaits).filter(([key]) => !finished(key)));
  const s: SessionState = { ...state, permissionWaits };
  let status: SessionState['status'] = 'running';
  let waitReason: SessionState['waitReason'] = null;
  const prompt = s.ended ? undefined : newestWait(s.permissionWaits);
  if (s.ended) status = 'done';
  else if (prompt) [status, waitReason] = ['waiting', 'permission'];
  else if (s.mainIdle && !Object.values(s.agents).some((a) => isOpen(a.status))) [status, waitReason] = ['waiting', s.background ? null : 'idle'];
  return { ...s, status, waitReason, waitNote: prompt?.note ?? null, dirty: true };
}

/**
 * A loop moved past its permission prompt (a call of it started, returned or was aborted, or its turn ended): that prompt is no
 * longer waited on. Another loop's stays: only the loop that asked can move past it.
 */
function pastPermission(s: SessionState, agentId: string | null | undefined): SessionState {
  return Object.hasOwn(s.permissionWaits, loopKey(agentId)) ? settled({ ...s, permissionWaits: withoutWait(s.permissionWaits, agentId) }) : s;
}

/** `s` with one more event queued for the server. */
export function addEvent(s: SessionState, kind: ActivityEvent['kind'], agentId: string | null, text: string, at: number, data: Record<string, unknown> | null = null): SessionState {
  const seq = s.evSeq + 1;
  // The id stays the same however often the event is sent: session, loop, kind, time, and the session's own count.
  const event: ActivityEvent = { id: [s.id, agentId ?? 'main', kind, at, seq].join(':'), t: at, kind, agentId, text: clip(text.replace(/\s+/g, ' ').trim(), 240), data };
  return { ...s, evSeq: seq, events: [...s.events, event].slice(-EVENTS_KEPT), dirty: true };
}

/** The events queued since the last call, and the state without them. */
export const drainEvents = (s: SessionState): [SessionState, ActivityEvent[]] => [{ ...s, events: [] }, s.events];

/** How the feed names a loop: the orchestrator, an agent by its description, or an agent this state does not hold. */
const whereLabel = (s: SessionState, agentId: string | null | undefined): string =>
  !agentId ? 'on the orchestrator' : s.agents[agentId] ? `in “${s.agents[agentId]!.description}”` : 'in an agent';

/** The loop an event is about: an agent's when it names one, else the orchestrator's. */
const loopFor = (s: SessionState, agentId: string | null | undefined): LoopStats | undefined => (agentId ? s.agents[agentId] : s.main);

/** `s` with one loop replaced; an agent the state does not hold leaves it as it is. */
function withLoop(s: SessionState, agentId: string | null | undefined, loop: LoopStats): SessionState {
  const agent = agentId ? s.agents[agentId] : undefined;
  if (agentId && agent) return { ...s, agents: { ...s.agents, [agentId]: { ...agent, ...loop } }, dirty: true };
  return agentId ? s : { ...s, main: loop, dirty: true };
}

/** `Opus high`: the model's short name, and the effort after it when known. */
const modelAndEffort = (model: string | null, effort: Effort | null): string => (effort ? `${shortName(model)} ${effort}` : shortName(model));

/** What a plan step owned by the agent shows: `general-purpose · Opus high`, or `fork · …`. */
const agentLabel = (a: Pick<AgentState, 'kind' | 'type' | 'model' | 'effort'>): string => `${a.kind === 'fork' ? 'fork' : a.type} · ${modelAndEffort(a.model, a.effort)}`;

/** An agent the engine lists, or a step names, that this state never saw spawn (a reload, a missed event); `known` fills what is known. */
function unseenAgent(id: string, now: number, known: Partial<AgentState> = {}): AgentState {
  return {
    ...emptyLoop(),
    id,
    kind: 'subagent',
    type: 'general-purpose',
    description: 'agent',
    name: null,
    parentId: null,
    status: 'running',
    startedAt: now,
    endedAt: null,
    effortSource: 'unknown',
    failure: null,
    toolUseId: null,
    promptExcerpt: '',
    promptText: null,
    promptSent: false,
    answerExcerpt: null,
    answerText: null,
    answerSent: false,
    ...known,
  };
}

// ---- where the session runs ---------------------------------------------------------------------------------------------

/** Where the session runs, and its main model. An absent field keeps its value; a null project root or repository name is taken. */
export function setIdentity(s: SessionState, place: { cwd?: string; projectRoot?: string | null; repoName?: string | null; model?: string | null }): SessionState {
  const next: SessionState = { ...s, dirty: true };
  if (place.cwd !== undefined) next.cwd = place.cwd;
  if (place.projectRoot !== undefined) next.projectRoot = place.projectRoot;
  if (place.repoName !== undefined) next.repoName = place.repoName;
  if (place.model) next.main = { ...s.main, model: place.model };
  return next;
}

export const setGit = (s: SessionState, git: GitInfo | null): SessionState => (sameData(git, s.git) ? s : { ...s, git, dirty: true });

/** The changed files and the commit they count from; a report is due only when the list differs. */
export function setFiles(s: SessionState, files: FilesReport, gitBase: string | null): SessionState {
  const changed = !sameData(files, s.files);
  return changed || gitBase !== s.gitBase ? { ...s, files, gitBase, dirty: s.dirty || changed } : s;
}

export const setAttached = (s: SessionState, attached: boolean): SessionState => (attached === s.attached ? s : { ...s, attached, dirty: true });

// ---- turns --------------------------------------------------------------------------------------------------------------

/** The main loop starts a turn: what woke it is no longer waited on, and no call of the last turn is still open. */
export function turnStart(s: SessionState, now: number): SessionState {
  const main: LoopStats = { ...s.main, lastActivityAt: now, openTools: 0, toolFailures: 0 };
  return settled({ ...s, main, mainIdle: false, background: null, apiFailure: null });
}

type StopInput = ClassicEventOf['classic.Stop'];

/** What the Stop hook lists: its background tasks, and its scheduled wake-ups with `nextAt` worked out by the caller. */
export interface BackgroundInput {
  tasks: NonNullable<StopInput['background_tasks']>;
  crons: (NonNullable<StopInput['session_crons']>[number] & { nextAt: number | null })[];
}

/** A task status that means it is over. */
const FINISHED = new Set(['completed', 'complete', 'done', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error']);
const TASK_KINDS: ReadonlyMap<string, BackgroundKind> = new Map([
  ['shell', 'shell'],
  ['bash', 'shell'],
  ['subagent', 'agent'],
  ['agent', 'agent'],
  ['monitor', 'monitor'],
  ['workflow', 'workflow'],
]);
/** Claude Code's artifact live-update watchers live as long as the session, so they are not work it waits on. */
const ARTIFACT_WATCHER = 'live updates for artifact ';
const BACKGROUND_KEPT = 20;
const BACKGROUND_DESC = 120;

/** A task the Stop hook lists, as a report carries it; null for one that is finished or that the session never waits on. */
function backgroundTask(t: BackgroundInput['tasks'][number]): BackgroundTask | null {
  const status = t.status || 'running';
  if (FINISHED.has(status.toLowerCase())) return null;
  const type = TASK_KINDS.get((t.type ?? '').toLowerCase()) ?? 'other';
  const description = (t.description ?? '').replace(/\s+/g, ' ').trim();
  if (type === 'monitor' && description.toLowerCase().startsWith(ARTIFACT_WATCHER)) return null;
  // A command never leaves the machine: only its first word that is not a NAME=value assignment, cut to its last path
  // segment, may name a task that has no description.
  const firstWord = (t.command ?? '').trim().split(/\s+/).find((w) => w !== '' && !w.includes('='));
  const program = firstWord?.split('/').pop() ?? '';
  return { type, description: clip(description || program || type, BACKGROUND_DESC), status: clip(status, 40) };
}

/** The work the Stop hook lists as still in flight, and the scheduled wake-ups, as what the idle session waits on. */
export function setBackground(s: SessionState, listed: BackgroundInput, now: number): SessionState {
  const tasks = listed.tasks.map(backgroundTask).filter((t) => t !== null).slice(0, BACKGROUND_KEPT);
  const wakeups = listed.crons.slice(0, BACKGROUND_KEPT - tasks.length);
  for (const c of wakeups) tasks.push({ type: 'wakeup', description: clip((c.prompt ?? '').replace(/\s+/g, ' ').trim() || 'scheduled wake-up', BACKGROUND_DESC), status: 'scheduled' });
  // A wake-up whose time cannot be read may be the first to fire, so then no time is given rather than a wrong one.
  const fireTimes = wakeups.map((c) => c.nextAt);
  const wakeAt = fireTimes.length > 0 && fireTimes.every((t): t is number => typeof t === 'number') ? Math.min(...fireTimes) : null;
  const background: BackgroundWait | null = tasks.length > 0 ? { tasks, wakeAt } : null;
  if (sameData(background, s.background)) return s;
  const summary = background ? backgroundSummary(background) : null;
  // One feed row each time what it waits on changes, not one per Stop.
  const news = summary !== null && (!s.background || summary !== backgroundSummary(s.background));
  return settled(news ? addEvent({ ...s, background }, 'wait', null, `waiting on background: ${summary}`, now) : { ...s, background });
}

/** What `/sitrep` prints of the background work held, a line per task; empty when there is none. */
export const backgroundLines = (s: SessionState): string[] => (s.background?.tasks ?? []).map(({ type, status, description }) => `  ${type} ${status} · ${description}`);

/** One model request of a loop, as `turn.step` gives it. */
export interface StepInput {
  agentId?: string;
  stopReason: string | null;
  usage: TurnUsage | null;
  model?: string | null;
  /** The effort the request ran at, when the engine says. */
  effort?: unknown;
}

/** The stop reasons that show a blowout, and the kind each is logged as. */
const BLOW_STOPS: ReadonlyMap<string, string> = new Map([
  ['model_context_window_exceeded', 'window-exceeded'],
  ['compaction', 'server-compaction'],
]);

/** One model request finished: model, observed effort, context, and a blowout its stop reason shows. */
export function afterStep(state: SessionState, i: StepInput, now: number): SessionState {
  const id = i.agentId;
  // A step of an agent this state never saw spawn brings the agent in.
  const s: SessionState = id && !state.agents[id] ? { ...state, agents: { ...state.agents, [id]: unseenAgent(id, now, { model: i.model ?? null }) }, order: [...state.order, id] } : state;
  const loop = loopFor(s, id);
  if (!loop) return s;
  const model = (i.usage?.model || i.model || loop.model) ?? null;
  const effort = effortOf(i.effort);
  const next: LoopStats = {
    ...loop,
    model,
    steps: loop.steps + 1,
    lastStopReason: i.stopReason,
    lastActivityAt: now,
    ...(effort ? { effort } : {}),
    ...(i.usage ? { ctxTokens: promptOf(i.usage), window: windowOf(model) } : {}),
  };
  let out = withLoop(s, id, next);
  // A response came back: the plan windows the engine holds are now the ones it carried.
  if (i.usage) out = { ...out, respondedAt: now };
  // An effort a request reports is observed, except a fork's, which stays marked inherited.
  const agent = id && effort ? out.agents[id] : undefined;
  if (agent && agent.kind !== 'fork') out = { ...out, agents: { ...out.agents, [agent.id]: { ...agent, effortSource: 'observed' } } };
  const kind = BLOW_STOPS.get(i.stopReason ?? '');
  return kind === undefined ? out : blowout(out, id ?? null, now, { kind, tokensBefore: next.ctxTokens, tokensAfter: null });
}

/** Counts a blowout on a loop, once per BLOWOUT_DEDUP_MS: a second signal that soon after is the same blowout. */
function blowout(s: SessionState, agentId: string | null, now: number, data: { kind: string; tokensBefore: number | null; tokensAfter: number | null }): SessionState {
  const loop = loopFor(s, agentId);
  const last = loop?.blowTimes.at(-1);
  if (!loop || (last !== undefined && now - last < BLOWOUT_DEDUP_MS)) return s;
  const count = loop.blowouts + 1;
  // Where the compaction says what is left and the window is known, the context is what is left.
  const leftShare = data.tokensAfter !== null && loop.window ? Math.round((data.tokensAfter / loop.window) * 100) : null;
  const ctxTokens = leftShare === null ? loop.ctxTokens : data.tokensAfter;
  const counted = withLoop(s, agentId, { ...loop, blowouts: count, blowTimes: [...loop.blowTimes, now].slice(-BLOW_TIMES_KEPT), ctxTokens, lastActivityAt: now });
  const after = leftShare === null ? '' : `, compacted to ${leftShare}%`;
  return addEvent(counted, 'blow', agentId, `context window exceeded (blowout #${count}) ${whereLabel(s, agentId)}${after}`, now, data);
}

/** A compaction `session.compact` reports. */
export interface CompactInput {
  trigger: string;
  agentId?: string;
  tokensAfter?: number;
  tokensBefore?: number;
}

/** A compaction ran: an automatic one is a blowout, a manual or a plugin's one only an event. */
export function afterCompaction(s: SessionState, c: CompactInput, now: number): SessionState {
  const tokensBefore = c.tokensBefore ?? null;
  const tokensAfter = c.tokensAfter ?? null;
  if (c.trigger === 'auto') return blowout(s, c.agentId ?? null, now, { kind: 'auto-compact', tokensBefore, tokensAfter });
  if (c.trigger !== 'manual' && c.trigger !== 'plugin') return s;
  const loop = loopFor(s, c.agentId);
  const next = loop ? withLoop(s, c.agentId, { ...loop, lastActivityAt: now, ...(c.tokensAfter !== undefined ? { ctxTokens: c.tokensAfter } : {}) }) : s;
  return addEvent(next, 'compact', c.agentId ?? null, `${c.trigger} compaction ${whereLabel(s, c.agentId)}`, now, { tokensBefore, tokensAfter });
}

/** Per agent id, the whole prompt and answer a report sent, to mark them delivered once the server takes that report. */
export type SentTexts = Record<string, Pick<AgentReport, 'promptText' | 'answerText'>>;

/** The texts an accepted report carried have gone out, so later reports leave them out. */
export function markTextSent(s: SessionState, sent: SentTexts): SessionState {
  let changed = false;
  const agents = Object.fromEntries(
    Object.entries(s.agents).map(([id, a]) => {
      // A text replaced after the report was built was not the one delivered, so it stays unsent.
      const carried = sent[id];
      const promptSent = a.promptSent || (!!carried?.promptText && carried.promptText === a.promptText);
      const answerSent = a.answerSent || (!!carried?.answerText && carried.answerText === a.answerText);
      if (promptSent !== a.promptSent || answerSent !== a.answerSent) changed = true;
      return [id, { ...a, promptSent, answerSent }];
    }),
  );
  return changed ? { ...s, agents } : s;
}

/** The orchestrator's turn ended on an API error: a `fail` event, unless Claude Code already named the failure (`apiFailure`). */
function mainErrorEvent(s: SessionState, cand: FailureCandidate | null, now: number): SessionState {
  if (s.apiFailure !== null) return s;
  if (cand) {
    return addEvent(s, 'fail', null, `orchestrator turn ended with an error after a failing call: ${cand.call}`, now, { reason: 'error', tool: cand.tool, call: cand.call, exitCode: cand.exitCode });
  }
  return addEvent(s, 'fail', null, 'orchestrator turn ended with an API error', now, { reason: 'error' });
}

/** The feed row for an agent's turn having ended; none for a teammate that answered and runs on. */
function agentEndEvent(s: SessionState, a: AgentState, now: number): SessionState {
  switch (a.status) {
    case 'done':
      return addEvent(s, 'done', a.id, `finished: ${a.description}`, now);
    case 'failed': {
      const cls = a.failure?.class ?? 'Unknown';
      return addEvent(s, 'fail', a.id, `failed: ${a.description} (${cls})`, now, { class: cls });
    }
    case 'aborted':
      return addEvent(s, 'note', a.id, `aborted: ${a.description}`, now);
    default:
      return s;
  }
}

/** How a loop's turn ended, as `turn.complete` says it. */
export interface CompleteInput {
  reason: TurnCompleteReason;
  agentId?: string;
  answer?: string;
}

/** A new answer text, to go out again even if an earlier one went. */
const answerText = (answer: string): { answerText: string | null; answerSent: boolean } => ({ answerText: fullText(answer) || null, answerSent: false });

/** A recent failing call, to blame a failure on. */
const freshCandidate = (loop: LoopStats, now: number): FailureCandidate | null => (loop.candidate && now - loop.candidate.at <= CANDIDATE_FRESH_MS ? loop.candidate : null);

/** The main loop's turn ended: it goes idle, past its own prompt (an agent's stays), with a `fail` event for an error or a refusal. */
function mainTurnEnded(s: SessionState, reason: TurnCompleteReason, now: number): SessionState {
  const main: LoopStats = { ...s.main, candidate: reason === 'answer' ? null : s.main.candidate, lastActivityAt: now, openTools: 0, toolFailures: 0 };
  const idle: SessionState = { ...s, main, mainIdle: true, permissionWaits: withoutWait(s.permissionWaits, null) };
  if (reason === 'error') return settled(mainErrorEvent(idle, freshCandidate(s.main, now), now));
  if (reason === 'refusal') return settled(addEvent(idle, 'fail', null, 'orchestrator turn ended with a refusal', now, { reason }));
  return settled(idle);
}

/** A loop's turn ended, and with it any prompt it raised. The main loop goes idle; an agent is done, aborted, or failed with a failure record. */
export function turnComplete(state: SessionState, end: CompleteInput, now: number): SessionState {
  if (!end.agentId) return mainTurnEnded(state, end.reason, now);
  const s = pastPermission(state, end.agentId);
  const a = s.agents[end.agentId];
  if (!a || isFinal(a.status)) {
    // A teammate's later turn, or a repeat: keep the answer only.
    if (a && end.answer) return { ...s, agents: { ...s.agents, [a.id]: { ...a, answerExcerpt: excerpt(end.answer), ...answerText(end.answer), lastActivityAt: now } }, dirty: true };
    return s;
  }
  const ended = { ...a, lastActivityAt: now, openTools: 0, toolFailures: 0, ...(end.answer ? { answerExcerpt: excerpt(end.answer), ...answerText(end.answer) } : {}) };
  let next: AgentState;
  if (end.reason === 'answer') {
    const teammate = a.kind === 'teammate';
    next = { ...ended, status: teammate ? 'running' : 'done', endedAt: teammate ? null : now, candidate: null, failure: null };
  } else {
    const cls = failureClass({ reason: end.reason, candidate: a.candidate, stopReason: a.lastStopReason, blowouts: a.blowouts, now }) ?? 'Unknown';
    const facts = evidenceLines({ blowoutTimes: a.blowTimes, failedCalls: a.failedCalls, reads: a.reads, denyText: a.candidate?.denied ? a.candidate.denyText : null });
    const modelCall = a.model ? `model request (${a.model}${a.effort ? `, effort ${a.effort}` : ''})` : 'model request';
    const blamed = cls === 'Model API error' || cls === 'Context window exhausted' ? { tool: 'model request', call: modelCall } : {};
    next = { ...ended, status: end.reason === 'aborted' ? 'aborted' : 'failed', endedAt: now, failure: failureRecord(cls, freshCandidate(a, now), facts, now, blamed) };
  }
  return settled(agentEndEvent({ ...s, agents: { ...s.agents, [a.id]: next } }, next, now));
}

/**
 * Claude Code says the orchestrator's turn ended on an API failure (`classic.StopFailure`) and names its kind: a
 * `fail` event carrying `category`, which the server reads for the errored state. When the turn's own end came first and its
 * event has not left yet, that event takes the category instead of a second row; when the turn ends after, it adds none.
 */
export function apiFailure(s: SessionState, category: string, now: number): SessionState {
  const cat = clip(category, 120);
  const base: SessionState = { ...s, main: { ...s.main, lastActivityAt: now }, apiFailure: { category: cat, at: now }, dirty: true };
  const pairs = (e: ActivityEvent) => e.kind === 'fail' && e.agentId === null && e.data?.reason === 'error' && e.data.category === undefined && now - e.t <= API_FAILURE_PAIR_MS;
  const at = s.events.findLastIndex(pairs);
  if (at < 0) return addEvent(base, 'fail', null, `orchestrator turn ended with an API error (${cat})`, now, { reason: 'error', category: cat });
  const events = base.events.map((e, i) => (i === at ? { ...e, text: clip(`${e.text} (${cat})`, 240), data: { ...e.data, category: cat } } : e));
  return { ...base, events };
}

// ---- agents -------------------------------------------------------------------------------------------------------------

/** The model's Agent tool call, before the agent starts: the requested effort and model, by tool_use_id. */
export function agentAsked(s: SessionState, toolUseId: string, input: Record<string, unknown>, now: number): SessionState {
  const asked: PendingSpawn = { at: now, model: nonEmpty(input.model), effort: effortOf(input.effort), subagentType: nonEmpty(input.subagent_type), name: nonEmpty(input.name), description: nonEmpty(input.description) };
  // The spawn may have come first (either order is taken): then the request can only add a requested effort to that agent.
  const spawned = Object.values(s.agents).find((a) => a.toolUseId === toolUseId);
  if (!spawned) return { ...s, pending: { ...s.pending, [toolUseId]: asked } };
  if (spawned.kind === 'fork' || !asked.effort || spawned.effortSource === 'observed') return s;
  return { ...s, agents: { ...s.agents, [spawned.id]: { ...spawned, effort: asked.effort, effortSource: 'requested' } }, dirty: true };
}

/** What `agent.spawn` says of a new agent. */
export interface SpawnInput {
  agentId: string;
  /** The Agent tool call that launched it. */
  toolUseId: string;
  parentAgentId?: string;
  fork: boolean;
  isTeammate?: boolean;
  subagentType: string;
  name?: string;
  description: string;
  prompt: string;
  model: string | null;
}

/** The effort an agent starts with and where it came from: a fork inherits its parent's, any other takes the one requested. */
function startingEffort(spawn: SpawnInput, parent: LoopStats, asked: PendingSpawn | undefined): Pick<AgentState, 'effort' | 'effortSource'> {
  if (spawn.fork) return { effort: parent.effort, effortSource: 'inherited' };
  if (asked?.effort) return { effort: asked.effort, effortSource: 'requested' };
  return { effort: null, effortSource: 'unknown' };
}

/** An agent started. Its effort is the one requested at the Agent call; a fork inherits its parent's. */
export function agentSpawned(s: SessionState, spawn: SpawnInput, now: number): SessionState {
  const asked = s.pending[spawn.toolUseId];
  const parentAgent = spawn.parentAgentId ? s.agents[spawn.parentAgentId] : undefined;
  const parent: LoopStats = parentAgent ?? s.main;
  const known = s.agents[spawn.agentId];
  const model = spawn.fork ? (parent.model ?? spawn.model) : (spawn.model ?? asked?.model ?? null);
  // An effort a step already observed outlasts the request, except on a fork.
  const effort = known?.effortSource === 'observed' && !spawn.fork ? { effort: known.effort, effortSource: 'observed' as const } : startingEffort(spawn, parent, asked);
  const agent: AgentState = {
    ...(known ?? unseenAgent(spawn.agentId, now)),
    ...effort,
    kind: spawn.fork ? 'fork' : spawn.isTeammate ? 'teammate' : 'subagent',
    parentId: spawn.parentAgentId ?? null,
    type: spawn.fork ? 'fork' : spawn.subagentType || asked?.subagentType || 'general-purpose',
    name: spawn.name ?? asked?.name ?? null,
    description: clip(spawn.description || asked?.description || 'agent', 240),
    model,
    window: windowOf(model),
    status: 'running',
    startedAt: known?.startedAt ?? now,
    lastActivityAt: now,
    toolUseId: spawn.toolUseId,
    promptExcerpt: excerpt(spawn.prompt),
    promptText: fullText(spawn.prompt) || null,
    promptSent: false,
  };
  const pending = { ...s.pending };
  delete pending[spawn.toolUseId];
  const added: SessionState = { ...s, agents: { ...s.agents, [agent.id]: agent }, order: known ? s.order : [...s.order, agent.id], pending };
  const what = modelAndEffort(agent.model, agent.effort);
  const forkOf = !spawn.parentAgentId ? 'the session' : parentAgent ? `“${parentAgent.description}”` : 'an agent';
  const text = spawn.fork ? `fork of ${forkOf} (${what}): ${agent.description}` : `spawned ${agent.type} (${what}): ${agent.description}`;
  // Plan steps are matched while the agent runs, so a step keeps its owner after the agent finishes.
  return settled(withPlanOwners(addEvent(added, 'spawn', agent.id, text, now, { kind: agent.kind })));
}

/** One agent as `$.agent.list()` gives it; the engine is the authority on which agents exist and how each stands. */
export interface ListedAgent {
  id: string;
  status: string;
  type: string;
  description: string;
  name?: string;
  parentId?: string;
}

/** The engine's agent status words, in the contract's words; any other is running. */
const LISTED_STATUS: ReadonlyMap<string, AgentStatus> = new Map([
  ['completed', 'done'],
  ['failed', 'failed'],
  ['killed', 'aborted'],
  ['pending', 'queued'],
]);

/** An agent after the engine's entry for it; null when the entry changes nothing. The list only ever moves an agent forward. */
function reconciledAgent(held: AgentState | undefined, listed: ListedAgent, now: number): AgentState | null {
  const status = LISTED_STATUS.get(listed.status) ?? 'running';
  if (held === undefined) {
    const fork = listed.type === 'fork';
    return unseenAgent(listed.id, now, {
      description: clip(listed.description || 'agent', 240),
      type: fork ? 'fork' : listed.type || 'general-purpose',
      kind: fork ? 'fork' : listed.type === 'teammate' ? 'teammate' : 'subagent',
      parentId: listed.parentId ?? null,
      name: listed.name ?? null,
      status,
      endedAt: isFinal(status) ? now : null,
    });
  }
  // A finished agent never runs again because the list says so.
  if (isFinal(held.status) || status === held.status) return null;
  if (status === 'running') return held.status === 'queued' ? { ...held, status: 'running' } : null;
  const failure = status === 'failed' && !held.failure ? failureRecord('Unknown', held.candidate, evidenceLines({ blowoutTimes: held.blowTimes, failedCalls: held.failedCalls, reads: held.reads, denyText: null }), now) : held.failure;
  return { ...held, status, endedAt: status === 'queued' ? null : (held.endedAt ?? now), failure };
}

/** Takes the engine's list of agents: new ones join in list order, and known ones move forward to the status it gives. */
export function withListedAgents(s: SessionState, listed: readonly ListedAgent[], now: number): SessionState {
  let agents = s.agents;
  const joined: string[] = [];
  for (const entry of listed) {
    const updated = reconciledAgent(agents[entry.id], entry, now);
    if (updated === null) continue;
    if (agents[entry.id] === undefined) joined.push(entry.id);
    agents = { ...agents, [entry.id]: updated };
  }
  return agents === s.agents ? s : settled({ ...s, agents, order: joined.length > 0 ? [...s.order, ...joined] : s.order });
}

// ---- tools --------------------------------------------------------------------------------------------------------------

/**
 * A tool call is about to run in a loop: its last tool, one more open call, and the end of a permission wait there. A
 * file-editing call is an `edit` event now, when the edit is attempted, whatever the call's outcome, so both reporters agree.
 * A SendMessage call with a message is a `message` event the same way. `tool.call` fires once per
 * call, each editing tool names one file and each SendMessage one recipient, so that is one event per call.
 */
export function toolStarted(s: SessionState, agentId: string | undefined, tool: string, input: Record<string, unknown>, now: number): SessionState {
  const loop = loopFor(s, agentId);
  const next = pastPermission(loop ? withLoop(s, agentId, { ...loop, lastTool: clip(tool, 120), openTools: loop.openTools + 1, lastActivityAt: now }) : s, agentId);
  const edited = editedPath(s, tool, input);
  if (edited) return addEvent(next, 'edit', agentId ?? null, `editing ${lastSegment(edited)}`, now, { path: edited });
  const sent = tool === MESSAGE_TOOL ? messageSent(s, agentId ?? null, input) : null;
  // messageSent redacts the message with the free-text rules and cuts it to LIMITS.text.
  return sent ? addEvent(next, 'message', agentId ?? null, sent.text, now, sent.data) : next;
}

/** A tool call ended without a result (its `next(e)` threw): it is no longer open, its loop is past any prompt, and nothing else is known of it. */
export function toolAborted(s: SessionState, agentId: string | undefined, now: number): SessionState {
  const loop = loopFor(s, agentId);
  return pastPermission(loop ? withLoop(s, agentId, { ...loop, openTools: Math.max(0, loop.openTools - 1), lastActivityAt: now }) : s, agentId);
}

/** A finished tool call as `tool.call` saw it: its arguments, and what its `next(e)` resolved to. */
export interface ToolResultInput {
  tool: string;
  agentId?: string;
  input: Record<string, unknown>;
  result: CallResult;
}

/** The absolute path a file-editing call names, resolved against the session's folder; null for any other call. */
function editedPath(s: SessionState, tool: string, input: Record<string, unknown>): string | null {
  const key = EDIT_TOOLS.get(tool);
  const raw = key === undefined ? undefined : input[key];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const path = raw.startsWith('/') ? raw : resolvePath(s.cwd, raw);
  return path.startsWith('/') ? path : null;
}

/**
 * The loop of this session a SendMessage recipient names: null for the main loop, an agent's id (given as such, or the agent
 * holding that name, the latest when several took it, as the engine routes a name), or undefined when none can be tied to it
 * (another session, a `name [ref]` spelling, a name no agent here holds). A loop does not message itself, so a recipient that
 * comes out as the sender is left untied: `team-lead` sent by a teammate that runs as a session of its own names a loop
 * elsewhere.
 */
function recipientLoop(s: SessionState, from: string | null, to: string): string | null | undefined {
  let loop: string | null | undefined;
  if (MAIN_LOOP_NAMES.has(to)) loop = null;
  else if (Object.hasOwn(s.agents, to)) loop = to;
  else loop = s.order.findLast((id) => s.agents[id]?.name === to);
  return loop === from ? undefined : loop;
}

/**
 * What a SendMessage call sends as a `message` event: the message and `{ to, toName }`, `toName` the recipient as the call
 * spells it and `to` its loop, left out when no loop can be tied to it. Null for a call with no plain-text message (a pure
 * idle subscription, a structured protocol reply), which the engine does not send as a message either.
 */
function messageSent(s: SessionState, from: string | null, input: Record<string, unknown>): { text: string; data: Record<string, unknown> } | null {
  const { to, message } = input;
  if (typeof to !== 'string' || to.trim() === '' || typeof message !== 'string' || message.trim() === '') return null;
  const loop = recipientLoop(s, from, to.trim());
  const toName = excerpt(to, LIMITS.short);
  // The message is a tool's free-text argument: the broader rules, then the narrow ones.
  return { text: clipFreeText(message.replace(/\s+/g, ' ').trim(), LIMITS.text), data: loop === undefined ? { toName } : { to: loop, toName } };
}

/** A loop's numbers once one of its tool calls finished. */
function countedCall(loop: LoopStats, call: ToolResultInput, ok: boolean, failed: boolean, now: number): LoopStats {
  const tool = clip(call.tool, 120);
  const next: LoopStats = { ...loop, lastTool: tool, lastActivityAt: now, toolCalls: loop.toolCalls + 1, openTools: Math.max(0, loop.openTools - 1) };
  // A success ends a run of failures; a denied call neither adds to one nor ends it.
  next.toolFailures = ok ? 0 : failed ? loop.toolFailures + 1 : loop.toolFailures;
  const seen = Object.hasOwn(loop.toolCounts, tool);
  if (seen || Object.keys(loop.toolCounts).length < TOOL_NAMES_KEPT) next.toolCounts = { ...loop.toolCounts, [tool]: (seen ? loop.toolCounts[tool]! : 0) + 1 };
  const readPath = call.tool === 'Read' ? call.input.file_path : undefined;
  if (typeof readPath === 'string') {
    const file = clip(readPath, 200);
    next.reads = { ...loop.reads, [file]: (loop.reads[file] ?? 0) + 1 };
  }
  const candidate = failingCall(call.tool, call.input, call.result, now);
  if (candidate) {
    next.candidate = candidate;
    next.failedCalls = { ...loop.failedCalls, [candidate.call]: (loop.failedCalls[candidate.call] ?? 0) + 1 };
  }
  return next;
}

/** What a successful call changes beyond its loop's numbers: a Skill call's skill, or the plan for the task tools, TodoWrite and the plan tool. */
function afterSuccess(s: SessionState, call: ToolResultInput, now: number): SessionState {
  switch (call.tool) {
    case 'Skill':
      return typeof call.input.skill === 'string' ? withSkill(s, call.agentId, call.input.skill, now) : s;
    case 'TaskCreate':
      return planChanged(s, taskCreate(s.plan, call.input, call.result), now);
    case 'TaskUpdate':
      return planChanged(s, taskUpdate(s.plan, call.input, call.result), now);
    case 'TodoWrite':
      // Only the orchestrator's list is the session's plan.
      return call.agentId ? s : planChanged(s, todoWrite(s.plan, call.input), now);
    case PLAN_TOOL:
      return planChanged(s, setTitle(s.plan, call.input), now);
    default:
      return s;
  }
}

/** A tool call finished: counts, the failure candidate and run of failures, skills and the plan. */
export function toolResult(state: SessionState, call: ToolResultInput, now: number): SessionState {
  const ok = typeof call.result.deny !== 'string' && call.result.isError !== true;
  // A failure is an errored result that no permission decision caused; a denied call neither fails nor succeeds.
  const failed = !ok && !toolDenied(call.result);
  const loop = loopFor(state, call.agentId);
  const s = pastPermission(loop ? withLoop(state, call.agentId, countedCall(loop, call, ok, failed, now)) : state, call.agentId);
  return ok ? afterSuccess(s, call, now) : s;
}

/** A new plan with its owners matched, and a feed row for each step that started, for the plan completing, and for it starting. */
function planChanged(s: SessionState, plan: PlanState, now: number): SessionState {
  if (plan === s.plan) return s;
  const wasActive = new Set(s.plan.tasks.filter((t) => t.status === 'in_progress').map((t) => t.id));
  let out = withPlanOwners({ ...s, plan, dirty: true });
  for (const t of plan.tasks) if (t.status === 'in_progress' && !wasActive.has(t.id)) out = addEvent(out, 'plan', null, `step started: ${t.text}`, now);
  const complete = (p: PlanState) => p.tasks.length > 0 && p.tasks.every((t) => t.status === 'completed');
  if (complete(plan) && s.plan.tasks.some((t) => t.status !== 'completed')) out = addEvent(out, 'plan', null, `plan complete: ${plan.toolTitle ?? plan.metaTitle ?? `${plan.tasks.length} steps`}`, now);
  if (s.plan.tasks.length === 0 && plan.tasks.length > 0) out = addEvent(out, 'plan', null, `plan started (${plan.source ?? 'tasks'})`, now);
  return out;
}

/** A skill was loaded into a loop: the Skill tool, or `skill.prompt` for the main loop. */
export function withSkill(s: SessionState, agentId: string | undefined, skill: string, now: number): SessionState {
  const loop = loopFor(s, agentId);
  if (loop === undefined || loop.skills.includes(skill)) return s;
  const agent = agentId ? s.agents[agentId] : undefined;
  const where = !agentId ? 'orchestrator' : agent?.kind === 'fork' ? 'fork' : (agent?.type ?? 'agent');
  const skills = [...loop.skills, clip(skill, 120)].slice(-SKILLS_KEPT);
  return addEvent(withLoop(s, agentId, { ...loop, skills }), 'skill', agentId ?? null, `${skill} loaded into ${where}`, now, { skill });
}

/** Claude Code raised a permission dialog for a loop's call (no agent id: the main loop's): the session waits on it, with the call as its note. */
export function promptShown(s: SessionState, agentId: string | undefined, toolName: string, toolInput: unknown, now: number): SessionState {
  const args = toolInput !== null && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
  const shown = args.command ?? args.file_path ?? Object.values(args)[0];
  const arg = typeof shown === 'string' ? shown : shown === undefined ? '' : JSON.stringify(shown);
  // The name and what it was asked to do are redacted apart, then wrapped, so no rule takes the closing bracket for part of a
  // value: a command (or other free text) by the broader rules, a path as `clip` leaves it. The whole stays within NOTE_MAX.
  const name = clip(toolName, NOTE_MAX - 2);
  const note = `${name}(${clipCall(toolName, arg.replace(/\s+/g, ' ').trim(), NOTE_MAX - name.length - 2)})`;
  const permissionWaits = { ...s.permissionWaits, [loopKey(agentId)]: { note, at: now } };
  return addEvent(settled({ ...s, permissionWaits }), 'wait', agentId ?? null, `waiting on you: ${note}`, now);
}

/**
 * A notification: a permission prompt, or idling for input, is a fallback signal of a wait. A permission notification counts
 * only while no prompt is held: Claude Code 2.1.319 raises it 6 s into any unanswered dialog with no agent id (`Sp(e,uy())`,
 * no call context), so for an agent's prompt it would file under the main loop and outlast the agent's answer. Filed under
 * the hook's `agent_id` when one comes, else the main loop.
 */
export function notified(s: SessionState, agentId: string | undefined, type: string, message: string, now: number): SessionState {
  const permission = /permission/i.test(type);
  if (permission && newestWait(s.permissionWaits) === undefined) {
    const note = clip(message.replace(/\s+/g, ' ').trim(), NOTE_MAX) || null;
    const waiting = settled({ ...s, permissionWaits: { [loopKey(agentId)]: { note, at: now } } });
    return addEvent(waiting, 'wait', agentId ?? null, `waiting on you: ${note ?? 'permission'}`, now);
  }
  return /idle/i.test(type) ? settled({ ...s, mainIdle: true }) : s;
}

// ---- activity feed ------------------------------------------------------------------------------------------------------

/** Whether the server last listed this loop as watched (no agent id: the main loop). */
export const isWatched = (s: SessionState, agentId: string | null | undefined): boolean => s.watched.includes(agentId || MAIN_LOOP);

/** The loops the reply lists as watched. A loop that drops off forgets its entries, so a later watch starts empty. */
export function setWatched(s: SessionState, listed: readonly string[]): SessionState {
  const watched = [...new Set(listed)].sort((a, b) => a.localeCompare(b));
  if (sameData(watched, s.watched)) return s;
  const kept = new Set(watched);
  /** The loop without its entries; the same loop when it has none. */
  const forget = <L extends LoopStats>(loop: L): L => (loop.activity.length === 0 ? loop : { ...loop, activity: [] });
  const agents = Object.fromEntries(Object.entries(s.agents).map(([id, a]) => [id, kept.has(id) ? a : forget(a)]));
  return { ...s, watched, main: kept.has(MAIN_LOOP) ? s.main : forget(s.main), agents };
}

/** Adds what a finished call says to its entry in the loop's feed (the one with that id); without such an entry nothing changes. */
export function patchFeedEntry(s: SessionState, agentId: string | null | undefined, id: string, patch: Partial<ActivityEntry>): SessionState {
  const loop = loopFor(s, agentId);
  const at = loop?.activity.findIndex((e) => e.id === id) ?? -1;
  if (!loop || at < 0) return s;
  return withLoop(s, agentId, { ...loop, activity: loop.activity.with(at, { ...loop.activity[at]!, ...patch }) });
}

/** Adds an entry to a watched loop's feed, keeping the last 20; a loop nobody watches keeps nothing. */
export function addFeedEntry(s: SessionState, agentId: string | null | undefined, entry: ActivityEntry): SessionState {
  const loop = isWatched(s, agentId) ? loopFor(s, agentId) : undefined;
  return loop ? withLoop(s, agentId, { ...loop, activity: [...loop.activity, entry].slice(-ACTIVITY_KEPT) }) : s;
}

// ---- usage, end ---------------------------------------------------------------------------------------------------------

/** The status line's figures as `session.measure` or `$.session.usage()` give them. */
export interface MeasureInput {
  context?: Partial<Record<keyof ContextFill, number>> | null;
  rateLimits?: readonly { kind: string; percentUsed: number; resetsAt?: string }[] | null;
  startedAt?: number;
}

/** `v` when it is a number, else `fallback`. */
const numberOr = (v: unknown, fallback: number | null): number | null => (typeof v === 'number' ? v : fallback);

/** A plan window as the status line gives it, held to the contract's shape, with when it was measured (ISO; null unknown). */
const planWindow = (r: NonNullable<MeasureInput['rateLimits']>[number], measuredAt: string | null): RateLimit => ({ kind: clip(String(r.kind), 120), percentUsed: Number(r.percentUsed) || 0, resetsAt: r.resetsAt ?? null, measuredAt });

/**
 * The status line's figures: the main loop's context, the plan windows, when the session began. Not activity. The windows are
 * dated by the last response seen (`respondedAt`), not by this read: an idle session reads the same old windows each time.
 */
export function measure(s: SessionState, m: MeasureInput): SessionState {
  const given = m.context;
  // A figure the status line leaves out keeps its last value.
  const context: ContextFill = given ? { tokens: numberOr(given.tokens, s.context.tokens), window: numberOr(given.window, s.context.window), percent: numberOr(given.percent, s.context.percent) } : s.context;
  const measuredAt = s.respondedAt === null ? null : new Date(s.respondedAt).toISOString();
  const rateLimits = Array.isArray(m.rateLimits) ? m.rateLimits.slice(0, 10).map((r) => planWindow(r, measuredAt)) : s.rateLimits;
  const startedAt = typeof m.startedAt === 'number' && m.startedAt > 0 ? m.startedAt : s.startedAt;
  if (sameData([context, rateLimits, startedAt], [s.context, s.rateLimits, s.startedAt])) return s;
  return { ...s, context, rateLimits, startedAt, dirty: true };
}

/** The session ended: its final status, and every agent still open aborted. */
export function endSession(s: SessionState, reason: string, resumeId: string | null, now: number): SessionState {
  if (s.ended) return s;
  const agents = Object.fromEntries(Object.entries(s.agents).map(([id, a]) => [id, isOpen(a.status) ? { ...a, status: 'aborted' as const, endedAt: now, openTools: 0 } : a]));
  const ended = settled({ ...s, agents, main: { ...s.main, openTools: 0 }, ended: true, endReason: clip(reason, 120), resumeId });
  return addEvent(ended, 'end', null, `session.end · ${reason}`, now, { reason });
}

/** Plan owners matched against the current agents (kept once matched). */
export function withPlanOwners(s: SessionState): SessionState {
  const candidates = s.order.flatMap((id) => s.agents[id] ?? []).map((a) => ({ id: a.id, name: a.name, description: a.description, running: a.status === 'running', label: agentLabel(a) }));
  const owned = withOwners(s.plan, candidates);
  return owned === s.plan ? s : { ...s, plan: owned };
}
