// The Claude reporter's hooks. It reports the session it runs in to the SITREP server (provider, machine always, liveness, API
// failures, edits); it has no recording, file diff, TLS helper or per-person identity.
//
// Hooks only watch. Each calls `next(e)` once and hands back what that resolved to, unchanged; its own work runs guarded, so
// a failure is kept for /sitrep and never reaches the session. Reports leave from a timer, so no hook on the tool
// path waits on the network, with one exception: while the mod answers, the hook of an open ask announces it and
// holds the server's answer request for as long as its dialog is up.
//
// The engine reads how this file uses `$` without running it: `$` is only handed to top-level functions, and every use is
// spelled `$.noun.method(...)`. What the reporter knows lives in module variables; a hot reload runs `register` again, which
// starts them over, and `session.start` rebuilds the session from the engine.
import type { ClassicResultOf, EngineInterface, Register, TurnStepInput, TurnStepResult } from 'claude-code';
import { finishedCall, toolEntry } from './activityDetail.ts';
import { devBuild, withBuild } from './build.ts';
import { nextCronAt } from './cron.ts';
import { clipFreeText, feedText, type CallResult } from './failures.ts';
import { changedFiles, gitInfo, type Runner } from './git.ts';
import { ID_STORE_KEY, idFilePath, idFromFile, isMachineId, linuxOs, machineInfo, macOs, newMachineId, shortHost, trimTrailingSlashes, windowsOs } from './machine.ts';
import { shortName } from './models.ts';
import { follow, quietly, repoNameOf } from './place.ts';
import { sessionKey, type Ask, type Delivery, type DeliveryResult, type MachineInfo, type Report, type RespondInfo, type RespondKind } from './protocol.ts';
import { reportOf, type ReportMeta } from './report.ts';
import { answeredLine, answersByQuestion, asDecision, LINE_MESSAGES_ON, LINE_OPEN, planApproval, planAsk, planDismissed, planFeedback, questionAsk, respondInfo, respondLevel, terminalSummary, toolAsk, toolDecision, toolDenied, type AskedQuestion } from './respond.ts';
import { addEvent, addFeedEntry, afterCompaction, afterStep, agentAsked, agentSpawned, apiFailure, backgroundLines, continuedAs, drainEvents, endSession, isWatched, markTextSent, measure, newSession, NO_FILES, notified, patchFeedEntry, promptShown, setAttached, setBackground, setFiles, setGit, setIdentity, setWatched, toolAborted, toolResult, toolStarted, turnComplete, turnStart, withListedAgents, withSkill, type ListedAgent, type MeasureInput, type SentTexts, type SessionState } from './state.ts';
import { headersFor, isDelivery, retryWaitMs, Transport, type PostOutcome } from './transport.ts';

/** The version this reporter reports; kept equal to `version` in .claude-plugin/plugin.json. */
export const VERSION = '0.3.0';
const GIT_POLL_MS = 10_000;
/** How much of a transcript's end is read for Claude's generated title: Claude Code's own head and tail read (2.1.319
 *  `LITE_READ_BUF_SIZE`, 65536), which holds the title because Claude re-appends it every half of that written. */
const TITLE_TAIL_BYTES = 65_536;
/** session.end has one short bound shared by every hook and the engine; the final report stays well inside it. */
const END_FLUSH_MS = 1000;
/** How much text of one watched step is read before the rest passes unread: far more than one 300-character entry needs. */
const STEP_TEXT_MAX = 8000;
const DEFAULT_SERVER = 'http://127.0.0.1:4317';

type Engine = EngineInterface;

// ---- options ----------------------------------------------------------------------------------------------------------

/**
 * The plugin's options (plugin.json `userConfig`) as `register` receives them, each read by its key with its default beside it:
 * a missing, empty or malformed value takes the default, except a `respond` value that is not a level, which reads as `off`.
 */
function readOptions(raw: Record<string, unknown>) {
  const stringOr = (key: string, fallback: string): string => {
    const v = raw[key];
    return typeof v === 'string' && v !== '' ? v : fallback;
  };
  /** A number of milliseconds, raised to `floor`. */
  const msOr = (key: string, floor: number, fallback: number): number => {
    const v = raw[key];
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(floor, v) : fallback;
  };
  return {
    serverUrl: stringOr('serverUrl', DEFAULT_SERVER),
    token: stringOr('token', ''),
    flushIntervalMs: msOr('flushIntervalMs', 200, 1000),
    heartbeatMs: msOr('heartbeatMs', 1000, 5000),
    sessionName: stringOr('sessionName', ''),
    // The switches: the status line and the activity feed on unless set false, full prompts off unless set true.
    showStatus: raw.showStatus !== false,
    fullPrompts: raw.fullPrompts === true,
    activityFeed: raw.activityFeed !== false,
    respond: respondLevel(raw.respond),
  };
}

type Options = ReturnType<typeof readOptions>;

// ---- what the reporter holds ------------------------------------------------------------------------------------------

/** The notices toasted once each: the key's last toasted text, so a repeat stays quiet and a changed text is news. */
type Toasted = Record<'ok' | 'fail' | 'plain' | 'refusal' | 'version', string | null>;

/** Everything the reporter holds for the session it runs in, built by `session.start`. */
interface Runtime {
  state: SessionState;
  transport: Transport;
  /** Stops the flush and git timers this session.start began; calling it again does nothing. */
  stopTimers: () => void;
  /**
   * Every report's `reporter` block, built by session.start and unchanged until the next: this plugin and its version (with a
   * dev build's commit), the Claude Code running it, and the session's surface (`background` for a `claude --bg` job,
   * `headless` with none).
   */
  reporter: Report['reporter'];
  /** False for a `claude -p` run: no person's client is on it, so it never answers. */
  interactive: boolean;
  /** This machine, sent with every report; null while its id cannot be read, so retried until it can (thisMachine). */
  machine: MachineInfo | null;
  /** The name `/sitrep name` stored for this session. */
  storedName: string | null;
  /** Claude Code's own name for the session, from a hook's `session_title`, and the session id it came for: it counts only while that id is reported. */
  claudeName: { forId: string; name: string } | null;
  /** The title Claude generated for the session, from its transcript's tail, and the session id it came for, likewise. */
  aiTitle: { forId: string; name: string } | null;
  /** The session's first prompt as a name (redacted, cut), and the session id it came for, likewise. */
  firstPrompt: { forId: string; name: string } | null;
  /** The session this one continues after a /clear; sent with every report under the new id. */
  clearedFrom: string | null;
  /** What `$.session.cwd()` last answered, to tell a move it reports from an answer that stayed put. */
  sessionCwd: string | null;
  /** Skill calls in flight: a skill.prompt meanwhile belongs to that call's loop. */
  skillCalls: number;
  flushing: boolean;
  /** The status line last shown. */
  status: string | null;
  toasted: Toasted;
}

/** Wakes one wait for a plan's approval: with the approval, or with null once the ask is done. */
type ApprovalWait = (d: Delivery | null) => void;

/** One ask open in this session, and what each of its hooks knows of it. */
interface OpenAsk {
  ask: Ask;
  sessionId: string;
  /** The race is over (answered, closed, or the call ended): every wait on it stops. */
  done: boolean;
  /**
   * Whether a wait on the server for this ask's answer is still running. Once one gives up (answering went off, the ask closed
   * there) the ask stops riding in reports, so the server never learns of it again and takes no answer nobody would collect.
   */
  listening: boolean;
  announced: boolean;
  /** The ask's announce (PUT), started when it opened: its close is queued only once this settles, so it never reaches the server first. */
  announcing: Promise<number>;
  /** For a tool: the answer the PermissionRequest hook returned. */
  answered: Delivery | null;
  /**
   * For a plan: the approval taken for the PermissionRequest hook, the waits for one, and whether it was reported not taken or
   * the hooks beneath that hook decided (then whatever the terminal does next is the terminal's).
   */
  approval: Delivery | null;
  approvalWaits: ApprovalWait[];
  notTaken: boolean;
  /** For a plan: the PermissionRequest hook handed its approval back; only then is a call resolved approved the dashboard's. */
  handedBack: boolean;
  /** The questions as Claude asked them, unredacted: answers given by position are turned back into these. */
  questions?: AskedQuestion[];
}

/** A close or a result for the server, on the route of the session `sessionId` names. The flush timer sends them, because Esc aborts a hook's own fetches. */
type OutItem = { sessionId: string; path: string; body: Record<string, unknown> };

/** A tool call as a PermissionRequest pairs with it; `ended` once the call has returned or thrown. */
type CallEntry = { tool: string; input: string; id: string; ended: boolean };

/** How long the held answer request waits on the server, in seconds. */
const HOLD_SECONDS = 20;
/** How long an approval may take to resolve the plan's call before it is reported not taken. */
const APPROVAL_CONFIRM_MS = 5000;
/** How soon after tool.check says `ask` a PermissionRequest must fire before the hooks are taken as not running here. */
const PERMISSION_CHECK_MS = 2000;
/** The deliveries acted on, kept here and in the store under this key, so one handed over twice acts once. */
const ACTED_KEY = 'respond:acted';
const ACTED_KEPT = 100;
const OUTBOX_MAX = 50;
/** The fields of a `tool.call` event that are the engine's, not the call's own arguments. */
const EVENT_FIELDS = new Set(['tool', 'tool_use_id', 'agentId']);

/** What answering holds between hooks; a fresh load starts it over. */
function freshAnswering() {
  return {
    asks: new Map<string, OpenAsk>(),
    acted: [] as string[],
    outbox: [] as OutItem[],
    /** Whether PermissionRequest hooks run here: null until known, false once a prompt showed without one, true once one fired. */
    permissionHooks: null as boolean | null,
    lastPermissionAt: 0,
    checks: new Map<string, { cancel: () => void }>(),
    /** Each loop's latest tool call, so a PermissionRequest (which carries no tool_use_id) can be paired with it. */
    lastCalls: new Map<string, CallEntry>(),
    messagesLineShown: false,
  };
}

// Module state, started over by `register`.
let opts: Options = readOptions({});
let rt: Runtime | null = null;
/** Counted up by each register: a wait for an answer begun under an older one stops. */
let generation = 0;
/** The reporter's last error, for /sitrep. */
let lastError: string | null = null;
/** The reporter's own time inside each hook, for /sitrep. */
let hookTimes: Record<string, { calls: number; totalMs: number; maxMs: number }> = {};
let answering = freshAnswering();

const nowMs = () => Date.now();

// ---- guards -----------------------------------------------------------------------------------------------------------

/** Keeps a reporter error for /sitrep and gives back its message. */
function keepError(where: string, err: unknown): string {
  const message = String((err as Error | undefined)?.message ?? err).slice(0, 200);
  lastError = `${where}: ${message}`;
  return message;
}

/** Calls a host surface some hosts lack (a debug log, a status line, toasts, a transcript); a throw is dropped. */
function tryHost(call: () => void): void {
  try {
    call();
  } catch {
    // this host has no such surface
  }
}

/** `keepError`, and the same line in Claude Code's debug log where the host keeps one. */
function logError($: Engine, where: string, err: unknown): void {
  const message = keepError(where, err);
  tryHost(() => $.ui.log(`sitrep-reporter: ${where}: ${message}`, { to: 'debug' }));
}

/** Runs `call`; a failure is kept under `where` rather than raised. */
async function logged($: Engine, where: string, call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (err) {
    logError($, where, err);
  }
}

/** Marks the session's state changed, so the next flush reports it. */
function touch(r: Runtime | null): void {
  if (r) r.state = { ...r.state, dirty: true };
}

/** Runs reporter logic for a hook: a throw is kept and goes no further, and the time it took is kept for /sitrep. */
function guard(where: string, fn: (r: Runtime) => void): void {
  const started = performance.now();
  const r = rt;
  try {
    if (r !== null) fn(r);
  } catch (err) {
    keepError(where, err);
  } finally {
    const ms = performance.now() - started;
    const t = hookTimes[where] ?? { calls: 0, totalMs: 0, maxMs: 0 };
    hookTimes[where] = { calls: t.calls + 1, totalMs: t.totalMs + ms, maxMs: Math.max(t.maxMs, ms) };
  }
}

/** `guard` for a reducer of the session's state. */
const update = (where: string, reduce: (s: SessionState) => SessionState): void =>
  guard(where, (r) => {
    r.state = reduce(r.state);
  });

/** A hook's fallback when its own code fails: what lies beneath it goes on as if the hook were not there. */
const passOn = <E, R>(_$: Engine, e: E, next: (e: E) => R): R => next(e);

// ---- what the session says of answering -------------------------------------------------------------------------------

/** What the session says of answering in its reports; sent at level `off` too, so the dashboard can say so. */
const respondState = (r: Runtime): RespondInfo => respondInfo(opts.respond, { activityFeed: opts.activityFeed, interactive: r.interactive, permissionHooks: answering.permissionHooks });

/** Whether the mod takes this kind of answer now: its own switches and the server's last word. */
const takes = (r: Runtime | null, kind: RespondKind): boolean => !!r && r.transport.respond && !r.state.ended && respondState(r).accepts.includes(kind);

/** Keeps the name Claude Code gives the session, under the id being reported; a hook without a title leaves the last one. */
function noteClaudeName(r: Runtime, hook: { session_title?: string }): void {
  const name = (typeof hook.session_title === 'string' ? hook.session_title : '').trim().slice(0, 80);
  if (name === '' || (r.claudeName?.forId === r.state.id && r.claudeName.name === name)) return;
  r.claudeName = { forId: r.state.id, name };
  touch(r);
}

/** Text Claude Code writes into a turn itself (a leading tag such as `<task-notification>`, an interruption notice): /resume never takes it for a first prompt (2.1.319 `iqe`). */
const NOT_TYPED = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;

/**
 * The session's first prompt, its name until Claude titles it, chosen as /resume chooses one (2.1.319 `Phe`): not text Claude
 * writes itself, nor a slash command that is built in or has no arguments (`builtInCommandNames().has(name) || !args`); any
 * other command counts, as `/name args`. Nor a turn the hook marks as not typed (a wake-up, a delivered event). Whitespace
 * folded, redacted as free text, cut to a name's 80 characters; once per session id (the hook's). Nothing waits on it.
 */
async function noteFirstPrompt($: Engine, hook: { session_id?: string; prompt?: string; source?: string }): Promise<void> {
  const r = rt;
  if (!r) return;
  const forId = hook.session_id || r.state.id;
  const text = (hook.prompt ?? '').replace(/\s+/g, ' ').trim();
  const notTyped = hook.source !== undefined && hook.source !== 'user' && hook.source !== 'sdk';
  if (r.firstPrompt?.forId === forId || notTyped || text === '' || NOT_TYPED.test(text)) return;
  // A command is what the person typed, `/name args`, when `name` is a command Claude Code lists.
  const [, name, args] = /^\/(\S+)(?: (.*))?$/.exec(text) ?? [];
  const command = name === undefined ? undefined : (await $.command.list()).find((c) => c.name === name);
  if (command && (command.source === 'builtin' || !args?.trim())) return;
  const shown = clipFreeText(text, 80).trim();
  // Another prompt may have been taken while the list was read.
  if (shown === '' || r.firstPrompt?.forId === forId) return;
  r.firstPrompt = { forId, name: shown };
  touch(r);
}

/**
 * The newest title Claude generated, in a transcript's tail: the last `ai-title` record, found as Claude Code finds it when it
 * re-appends the session's metadata (the last line holding `"type":"ai-title"`; an empty title is none). No other line is
 * parsed. Null when the tail holds none; the tail's first line, cut mid-record, does not parse and is passed over.
 */
function newestAiTitle(tail: string): string | null {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"type":"ai-title"')) continue;
    try {
      const record = JSON.parse(lines[i]!) as { type?: unknown; aiTitle?: unknown };
      if (record.type === 'ai-title') return typeof record.aiTitle === 'string' ? record.aiTitle.trim() || null : null;
    } catch {
      // not a whole record
    }
  }
  return null;
}

/**
 * Claude's generated title for the session the hook is for, from its transcript's last TITLE_TAIL_BYTES, as /resume reads it
 * (transcripts run to hundreds of MB, past `$.fs.read`'s 4 MiB). Nothing waits on it; a missing file or an unreadable tail
 * keeps the name held, and Claude never takes a title back.
 */
async function readAiTitle($: Engine, hook: { session_id?: string; transcript_path?: string }): Promise<void> {
  const r = rt;
  if (!r || !hook.transcript_path) return;
  const forId = hook.session_id || r.state.id;
  const { exitCode, stdout } = await $.process.run(['tail', '-c', String(TITLE_TAIL_BYTES), hook.transcript_path], { timeoutMs: 5000 });
  const name = exitCode === 0 ? newestAiTitle(stdout) : null;
  if (name === null || (r.aiTitle?.forId === forId && r.aiTitle.name === name)) return;
  r.aiTitle = { forId, name };
  touch(r);
}

function reportMeta(r: Runtime, now: number, machine: MachineInfo): ReportMeta {
  const open = [...answering.asks.values()].filter((a) => !a.done && a.listening && a.sessionId === r.state.id).map((a) => a.ask);
  /** A name held for a session id, while that id is the one reported. */
  const own = (held: { forId: string; name: string } | null): string | null => (held?.forId === r.state.id ? held.name : null);
  return {
    now,
    reporter: r.reporter,
    machine,
    names: [r.storedName, own(r.claudeName), own(r.aiTitle), opts.sessionName || null, own(r.firstPrompt)],
    clearedFrom: r.clearedFrom,
    fullText: opts.fullPrompts,
    activity: opts.activityFeed,
    respond: respondState(r),
    asks: r.transport.respond && opts.respond !== 'off' ? open : null,
  };
}

// ---- notices ----------------------------------------------------------------------------------------------------------

function refreshStatusLine($: Engine, r: Runtime): void {
  const line = r.transport.statusText();
  if (!opts.showStatus || line === r.status) return;
  r.status = line;
  tryHost(() => $.ui.status(line));
}

/** Toasts `text` under `key` unless it is the text last toasted there; null clears the key, so the text is news again later. */
function notify($: Engine, r: Runtime, key: keyof Toasted, text: string | null): void {
  if (text === r.toasted[key]) return;
  r.toasted[key] = text;
  if (text !== null) tryHost(() => $.ui.toast(`SITREP: ${text}`));
}

// ---- reporting --------------------------------------------------------------------------------------------------------

/** Posts the state as it is now (a later change marks it dirty again): how the post went, and the full texts the report carried. */
async function postSnapshot(r: Runtime, now: number, machine: MachineInfo): Promise<{ outcome: PostOutcome; carried: SentTexts }> {
  const snapshot = r.state;
  r.state = { ...snapshot, dirty: false };
  let carried: SentTexts = {};
  const outcome = await r.transport.send((batch) => {
    const report = reportOf(snapshot, batch, reportMeta(r, now, machine));
    carried = Object.fromEntries(report.agents.map((a) => [a.id, { promptText: a.promptText, answerText: a.answerText }]));
    return report;
  }, now);
  return { outcome, carried };
}

/** Hands queued events to the transport and posts one report when one is due (or `force`), then says what came of it. */
async function reportNow($: Engine, r: Runtime, now: number, force: boolean): Promise<void> {
  const [rest, events] = drainEvents(r.state);
  r.state = rest;
  r.transport.queueEvents(events);
  if (!force && !r.transport.isDue(now, r.state.dirty)) return;
  // A report names its machine, whose id is never made up: until it can be read, nothing is sent and the state stays dirty.
  r.machine ??= await thisMachine($);
  if (r.machine === null) {
    notify($, r, 'fail', "not reporting · this machine's id cannot be read (/sitrep says why)");
    return;
  }
  const { outcome, carried } = await postSnapshot(r, now, r.machine);
  const server = trimTrailingSlashes(opts.serverUrl);
  if (outcome === 'ok') {
    if (opts.fullPrompts) r.state = markTextSent(r.state, carried);
    // The reply names the loops a viewer watches; with the option off, nothing is ever watched.
    const watched = opts.activityFeed ? r.transport.watch : [];
    r.state = setWatched(r.state, watched);
    // Taken again, so a later refusal is news again.
    notify($, r, 'refusal', null);
    notify($, r, 'ok', `reporting · ${server}`);
    takeDeliveries($, r);
    sayMessagesOn($, r);
  } else if (outcome !== 'rejected') {
    // A report the server will never take is gone, with nothing to tell; any other that did not land goes again.
    touch(r);
  }
  if (outcome === 'failed') notify($, r, 'fail', `offline · ${server}`);
  if (outcome === 'refused') notify($, r, 'refusal', r.transport.refusalNotice());
  notify($, r, 'version', r.transport.versionNotice());
  notify($, r, 'plain', r.transport.plainHttpNotice());
  refreshStatusLine($, r);
}

// ---- reading the engine -----------------------------------------------------------------------------------------------
// Each read runs on its own: a failure is kept under the call's name and changes nothing.

/** The status line's figures as `measure` takes them. */
const usageFigures = (u: Awaited<ReturnType<Engine['session']['usage']>>): MeasureInput => ({ context: u.context, rateLimits: u.rateLimits, startedAt: u.startedAt });

function readUsage($: Engine, r: Runtime): Promise<void> {
  return logged($, 'session.usage', async () => {
    r.state = measure(r.state, usageFigures(await $.session.usage()));
  });
}

/** The roster of attached clients: none is a background session nobody is on. */
function readSurfaces($: Engine, r: Runtime): Promise<void> {
  return logged($, 'session.surfaces', async () => {
    const attached = (await $.session.surfaces()).length > 0;
    r.state = setAttached(r.state, attached);
  });
}

function readAgents($: Engine, r: Runtime, now: number): Promise<void> {
  return logged($, 'agent.list', async () => {
    r.state = withListedAgents(r.state, (await $.agent.list()) as ListedAgent[], now);
  });
}

/** Takes the folder the session moved to (place.ts decides); whether it moved. */
async function followMove($: Engine, r: Runtime, hookCwd?: string): Promise<boolean> {
  const { sessionCwd, moved } = await follow($, { cwd: r.state.cwd, projectRoot: r.state.projectRoot, sessionCwd: r.sessionCwd }, hookCwd);
  r.sessionCwd = sessionCwd;
  if (moved !== null) r.state = setIdentity(r.state, moved);
  return moved !== null;
}

/** A hook carries Claude Code's current `cwd`: take it when the session moved there, and read git in the new folder at once. */
async function hookMovedTo($: Engine, cwd: string | undefined): Promise<void> {
  if (typeof cwd !== 'string' || !rt) return;
  if (await followMove($, rt, cwd)) void pollGit($, rt);
}

/** A runner on `$.process.run` with these options (a fresh copy per run), giving back how the command exited and what it printed. */
function runnerFor($: Engine, init: { cwd?: string; timeoutMs: number }): Runner {
  return async (argv) => {
    const { exitCode, stdout } = await $.process.run(argv, { ...init });
    return { exitCode, stdout };
  };
}

/** The commit this mod runs from when it runs from a checkout; null for a release or an installed copy. */
async function devBuildOf($: Engine): Promise<string | null> {
  const root = await quietly<string | null>(() => Promise.resolve($.plugin.root), null);
  return root ? devBuild(runnerFor($, { timeoutMs: 5000 }), root) : null;
}

/** A string the store keeps under `key`, trimmed; null for anything else, an empty one, or a failed read. */
async function stored($: Engine, key: string): Promise<string | null> {
  const v = await quietly<unknown>(() => $.store.get(key), null);
  return typeof v === 'string' ? v.trim() || null : null;
}

/** The git poll: the place, branch and status, then the files changed since the session's starting commit. */
function pollGit($: Engine, r: Runtime): Promise<void> {
  return logged($, 'git', async () => {
    await followMove($, r);
    const cwd = r.state.cwd;
    const inCwd = runnerFor($, { cwd, timeoutMs: 5000 });
    const git = await gitInfo(inCwd, cwd);
    r.state = setGit(r.state, git);
    await readFiles($, r, inCwd, cwd, git === null);
  });
}

/**
 * The files changed since the session's starting commit, for the session id in force when the read began. Asked even without
 * git info (`noGit`): a repository with no commit yet has no HEAD, yet has files to list. The starting commit is kept in the
 * store, so a hot reload (which keeps the process; a restart does not) counts from the same one.
 */
async function readFiles($: Engine, r: Runtime, run: Runner, cwd: string, noGit: boolean): Promise<void> {
  const id = r.state.id;
  const base = r.state.gitBase ?? (await stored($, `base:${id}`));
  const changes = await changedFiles(run, cwd, base);
  if (changes === null) {
    if (noGit) r.state = setFiles(r.state, NO_FILES, r.state.gitBase);
    return;
  }
  // Under another id a /clear came while git was read, and those files belong to the session that ended.
  if (r.state.id !== id) return;
  if (changes.base !== base) await quietly(() => $.store.set(`base:${id}`, changes.base), undefined);
  r.state = setFiles(r.state, changes.files, changes.base);
}

/** The event that opens a session's feed: `session.start · Opus high`. */
const startText = (model: string | null, effort: string | null): string => `session.start · ${shortName(model)}${effort ? ` ${effort}` : ''}`;

/** A /clear happened: the old id gets its final report, then reporting starts again under the new id. */
async function startOver($: Engine, r: Runtime, newId: string, now: number): Promise<void> {
  const old = r.state;
  // The new id continues the old session unless that one had already ended some other way.
  const continues = !old.ended || old.endReason === 'clear';
  for (const a of answering.asks.values()) if (a.sessionId === old.id) a.done = true;
  if (!old.ended) {
    r.state = endSession(old, 'clear', old.id, now);
    await r.transport.idle();
    await reportNow($, r, now, true);
  }
  r.transport.queue = [];
  const startedAt = (await quietly(() => $.session.usage(), null))?.startedAt;
  const { model, effort } = r.state.main;
  r.state = addEvent(continuedAs(r.state, newId, startedAt || now), 'start', null, startText(model, effort), now);
  r.storedName = await stored($, `name:${newId}`);
  r.clearedFrom = continues ? old.id : null;
  answering.messagesLineShown = false;
}

/** The flush timer: notices a new session id, sends what the hooks queued, refreshes usage and agents, posts a report when due. */
async function flush($: Engine): Promise<void> {
  const r = rt;
  if (r === null || r.flushing) return;
  r.flushing = true;
  try {
    // Whether a report or a retry is due goes by the engine's clock; the events the hooks queue carry Date.now().
    const now = await clockNow($);
    const id = await currentId($);
    if (id && id !== r.state.id) await startOver($, r, id, now);
    await drainOutbox($);
    if (!r.state.ended) {
      await readUsage($, r);
      await readSurfaces($, r);
      await readAgents($, r, now);
      await reportNow($, r, now, false);
    }
  } catch (err) {
    logError($, 'flush', err);
  } finally {
    r.flushing = false;
  }
}

/** The session's id as the engine says it now; null, with the error kept, when it cannot say. */
async function currentId($: Engine): Promise<string | null> {
  try {
    return await $.session.id();
  } catch (err) {
    logError($, 'session.id', err);
    return null;
  }
}

/** The engine's time; Date.now() on a host without a clock. */
async function clockNow($: Engine): Promise<number> {
  return (await quietly<number | null>(() => $.clock.now(), null)) ?? nowMs();
}

// ---- this machine -----------------------------------------------------------------------------------------------------

/**
 * The machine's id, the same for every reporter on the machine. The shared file decides. A file that is missing, or
 * there but holding no id, is written from the id this load's store holds (the store follows the file, so it is the id a Claude
 * process last read from it) and read back; only a missing file, with no id in the store, takes a new one. Where no file can be used, the store
 * alone keeps the id. A file that cannot be read, one holding no id while the store holds none, or a read of the environment or
 * the store that fails, throws: an id is never made up for a machine that may have one, as a session is its machine's and
 * a new id would make each live session a second card and start its spend over.
 */
async function sharedMachineId($: Engine): Promise<string> {
  const path = idFilePath(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'));
  const present = path !== null && (await $.fs.exists(path));
  if (present) {
    const inFile = idFromFile(await $.fs.read(path));
    if (inFile !== null) {
      // The store follows the file, so the id outlives the file being deleted.
      if ((await quietly<unknown>(() => $.store.get(ID_STORE_KEY), undefined)) !== inFile) await quietly(() => $.store.set(ID_STORE_KEY, inFile), undefined);
      return inFile;
    }
  }
  const inStore: unknown = await $.store.get(ID_STORE_KEY);
  if (present && !isMachineId(inStore)) throw new Error(`${path} holds no machine id`);
  const id = isMachineId(inStore) ? inStore : newMachineId();
  if (id !== inStore) await quietly(() => $.store.set(ID_STORE_KEY, id), undefined);
  if (path === null) return id;
  await quietly(() => $.fs.write(path, `${id}\n`), undefined);
  // Read back, so the id reported is the one the file ends up holding.
  return (await quietly(async () => idFromFile(await $.fs.read(path)), null)) ?? id;
}

/** The OS and version: the first of `sw_vers` (macOS), `/etc/os-release` (Linux) and `cmd /c ver` (Windows) that answers. */
async function osName($: Engine): Promise<string | null> {
  const printed = async (argv: string[]) => {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 2000 });
    return exitCode === 0 ? stdout : null;
  };
  const readers = [async () => macOs(await printed(['sw_vers'])), async () => linuxOs(await $.fs.read('/etc/os-release')), async () => windowsOs(await printed(['cmd', '/c', 'ver']))];
  for (const read of readers) {
    const os = await quietly(read, null);
    if (os !== null) return os;
  }
  return null;
}

/**
 * This machine, read once per load: its short host name, the shared id, and its OS. Null, with the error kept, while the id cannot
 * be read: reports and the answer routes wait for it (reportNow, callServer), since an id made up here would make each live
 * session a second card.
 */
async function thisMachine($: Engine): Promise<MachineInfo | null> {
  try {
    const id = await sharedMachineId($);
    const host = quietly(async () => {
      const { exitCode, stdout } = await $.process.run(['hostname'], { timeoutMs: 2000 });
      return exitCode === 0 ? shortHost(stdout) : null;
    }, null);
    const [name, os] = await Promise.all([host, osName($)]);
    return machineInfo(name, id, os);
  } catch (err) {
    logError($, 'machine', err);
    return null;
  }
}

// ---- answering: talking to the server ---------------------------------------------------------------------------------

/** An ask's route under its session's. */
const askPath = (a: OpenAsk): string => `/asks/${encodeURIComponent(a.ask.id)}`;

/**
 * One request to the server on `path` under the route of the session `sessionId` names, which takes its id there: that id at
 * this machine's (sessionKey). It carries the reporter's token, and a body only when one is given. Null when it could not be
 * made: offline, aborted by Esc, or this machine's id not yet read, so asks, closes and results wait as the reports do (reportNow).
 */
function callServer($: Engine, method: string, sessionId: string, path: string, body?: unknown): Promise<{ status: number; text: string } | null> {
  const machine = rt?.machine;
  if (!machine) return Promise.resolve(null);
  const url = `${trimTrailingSlashes(opts.serverUrl)}/api/fleet/sessions/${encodeURIComponent(sessionKey(sessionId, machine.id))}${path}`;
  return quietly(async () => {
    const init = { method, headers: headersFor(opts.token), ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const { status, text } = await $.http.fetch(url, init);
    return { status, text };
  }, null);
}

/** A line in the transcript; the engine draws it under the plugin's name. */
function sayInTranscript($: Engine, text: string): void {
  tryHost(() => $.ui.log(text));
}

/** Queues an item for the flush timer; past OUTBOX_MAX the oldest go. */
function toOutbox(item: OutItem): void {
  const { outbox } = answering;
  outbox.push(item);
  outbox.splice(0, Math.max(0, outbox.length - OUTBOX_MAX));
}

/** Queues what became of a delivery, for the flush timer to send. */
function queueDeliveryResult(sessionId: string, deliveryId: string, result: DeliveryResult): void {
  toOutbox({ sessionId, path: `/deliveries/${encodeURIComponent(deliveryId)}/result`, body: { result, at: nowMs() } });
}

/** Queues an ask's close once its announce has settled, so the server never has the close before the ask; nothing waits on it. */
function queueAskClose(a: OpenAsk, outcome: 'terminal' | 'closed' | 'ended', extra: { answer?: string | null; planApproved?: boolean } = {}): void {
  const item: OutItem = { sessionId: a.sessionId, path: `${askPath(a)}/close`, body: { outcome, at: nowMs(), ...extra } };
  void a.announcing.then(() => toOutbox(item));
}

/** A delivery the dashboard's answer took: its result goes to the server, and the transcript says what it did. */
function credit($: Engine, sessionId: string, d: Delivery): void {
  queueDeliveryResult(sessionId, d.id, 'took');
  sayInTranscript($, answeredLine(d, nowMs()));
}

/** The flush timer sends what the hooks queued, oldest first: any answer from the server takes an item off; a failure keeps the rest for the next tick. */
async function drainOutbox($: Engine): Promise<void> {
  const { outbox } = answering;
  while (outbox.length > 0) {
    const head = outbox[0]!;
    if ((await callServer($, 'POST', head.sessionId, head.path, head.body)) === null) return;
    outbox.shift();
  }
}

/** Notes a delivery as acted on, here and in the store, so one handed over twice (a lost reply, a reload) acts once: false when it was already. */
function actOnce($: Engine, deliveryId: string): boolean {
  const { acted } = answering;
  if (acted.includes(deliveryId)) return false;
  acted.push(deliveryId);
  acted.splice(0, Math.max(0, acted.length - ACTED_KEPT));
  void quietly(() => $.store.set(ACTED_KEY, acted), undefined);
  return true;
}

/** Announces an ask (PUT) and gives back the status. The first time it lands, the terminal says it is also open in the dashboard. */
async function announceAsk($: Engine, a: OpenAsk): Promise<number> {
  const status = (await callServer($, 'PUT', a.sessionId, askPath(a), a.ask))?.status ?? 0;
  // (An ask the terminal answered while the announce was on its way is not said to be open.)
  if (status === 200 && !a.announced && !a.done) {
    a.announced = true;
    sayInTranscript($, LINE_OPEN);
  }
  return status;
}

/** An ask opened under the session's id and announced; the next report carries it. Nothing waits on the announce here. */
function openAsk($: Engine, r: Runtime, ask: Ask, questions?: OpenAsk['questions']): OpenAsk {
  const a: OpenAsk = { ask, sessionId: r.state.id, done: false, listening: true, announced: false, announcing: Promise.resolve(0), answered: null, approval: null, approvalWaits: [], notTaken: false, handedBack: false, questions };
  answering.asks.set(ask.id, a);
  touch(r);
  a.announcing = announceAsk($, a);
  return a;
}

/** Wakes every wait for a plan's approval with `d` (null once the ask is done). */
function wakeApprovalWaits(a: OpenAsk, d: Delivery | null): void {
  for (const wake of a.approvalWaits.splice(0)) wake(d);
}

/** Ends an ask's race: every wait on it stops, and the next report no longer carries it. */
function endRace(a: OpenAsk): void {
  a.done = true;
  wakeApprovalWaits(a, null);
  answering.asks.delete(a.ask.id);
  touch(rt);
}

/**
 * Which answers a wait on an ask is for. `takes` names the ones it takes; one it does not take is refused or, when `other` is
 * given (a plan's approval), handed to that; one `leaves` names is left for another wait on the same ask.
 */
type AnswerFilter = { takes: (d: Delivery) => boolean; other?: (d: Delivery) => void; leaves?: (d: Delivery) => boolean };

/** Waits on the server for the next answer to an ask that the filter takes, until one comes, the ask is done, or the server stops taking answers. */
async function waitForAnswer($: Engine, a: OpenAsk, filter: AnswerFilter): Promise<Delivery | null> {
  const d = await holdForAnswer($, a, filter);
  if (d === null && !a.done) {
    // Given up while the ask is still open: it stops riding in reports.
    a.listening = false;
    touch(rt);
  }
  return d;
}

/** Sleeps `ms` on the engine's clock; false when the sleep fails, since its dispatch is gone and a loop must not go round again. */
function sleepFor($: Engine, ms: number): Promise<boolean> {
  return quietly(async () => {
    await $.clock.sleep(ms);
    return true;
  }, false);
}

/** The delivery a 200 answer to the held request carries; null for any other answer or a body that holds none. */
function deliveryIn(res: { status: number; text: string } | null): Delivery | null {
  if (res?.status !== 200) return null;
  try {
    const { delivery } = JSON.parse(res.text) as { delivery?: unknown };
    return isDelivery(delivery) ? delivery : null;
  } catch {
    return null;
  }
}

/**
 * What one answer to the held request means for the wait: the delivery it takes, the milliseconds to wait before asking
 * again, or null to stop. A request that could not be made (callServer) waits out the backoff; a 204 asks again at once; a 404
 * (a restarted server, or an announce that could not be made) announces again; anything but a delivery ends the wait. A
 * delivery already acted on waits for its result to land.
 */
async function nextAfter($: Engine, a: OpenAsk, res: { status: number; text: string } | null, filter: AnswerFilter): Promise<Delivery | number | null> {
  if (res === null) return retryWaitMs(1);
  if (res.status === 204) return 0;
  if (res.status === 404) {
    // A close queued from now on waits for this announce too.
    a.announcing = announceAsk($, a);
    return (await a.announcing) === 200 ? 0 : retryWaitMs(2);
  }
  const d = deliveryIn(res);
  if (d === null) return null;
  const forThisAsk = d.askId === a.ask.id;
  // Another wait on this ask acts on what `leaves` names (a plan's feedback is the tool.call hook's): ask again once it has.
  if (forThisAsk && filter.leaves?.(d)) return 500;
  if (!actOnce($, d.id)) return 1000;
  if (forThisAsk && filter.takes(d)) return d;
  if (forThisAsk && filter.other) filter.other(d);
  else queueDeliveryResult(a.sessionId, d.id, 'refused');
  return 0;
}

/** The held answer request, asked again and again until `nextAfter` takes a delivery or stops, or the wait is over. */
async function holdForAnswer($: Engine, a: OpenAsk, filter: AnswerFilter): Promise<Delivery | null> {
  // `rt` is module state: a wait begun under an older register must not read a newer session's switches.
  const gen = generation;
  const stillWaiting = () => !a.done && gen === generation && rt?.transport.respond === true;
  while (stillWaiting()) {
    const res = await callServer($, 'GET', a.sessionId, `${askPath(a)}/answer?wait=${HOLD_SECONDS}`);
    if (a.done) {
      // The race ended while the request was held: an answer that came anyway is closed, once.
      const late = deliveryIn(res);
      if (late && actOnce($, late.id)) queueDeliveryResult(a.sessionId, late.id, 'closed');
      return null;
    }
    const next = await nextAfter($, a, res, filter);
    if (typeof next !== 'number') return next;
    if (next > 0 && !(await sleepFor($, next))) return null;
  }
  return null;
}

// ---- answering: the hooks' races --------------------------------------------------------------------------------------

/** How a race ended: the terminal's result, or the dashboard's answer. */
type RaceEnd = { res: CallResult; d: null } | { res: null; d: Delivery };

/** Whichever answers first, the terminal or the dashboard. A dashboard wait that ends empty leaves the ask to the terminal. */
function firstAnswer(terminal: Promise<CallResult>, dashboard: Promise<Delivery | null>): Promise<RaceEnd> {
  const byTerminal = terminal.then((res): RaceEnd => ({ res, d: null }));
  const byDashboard = dashboard.then((d): RaceEnd | Promise<RaceEnd> => (d === null ? byTerminal : { res: null, d }));
  return Promise.race([byTerminal, byDashboard]);
}

/** A tool call that may race: its ask's id and loop, and its arguments. */
type RacingCall = { id: string; agentId: string | null; input: Record<string, unknown> };

/**
 * AskUserQuestion: the terminal's dialog (`next(e)`) against an answer from the dashboard; whichever comes first wins. The
 * terminal can win from the start: the dashboard's wait begins once the announce has gone, which never holds it up.
 */
async function questionRace($: Engine, r: Runtime, call: RacingCall, terminal: Promise<CallResult>): Promise<CallResult> {
  const ask = questionAsk({ id: call.id, agentId: call.agentId, openedAt: nowMs() }, call.input);
  if (ask === null) return terminal;
  const a = openAsk($, r, ask, (Array.isArray(call.input.questions) ? call.input.questions : []) as OpenAsk['questions']);
  const answers = (d: Delivery) => (d.kind === 'question' || d.kind === 'reply') && takes(rt, 'question');
  const first = await firstAnswer(terminal, a.announcing.then(() => waitForAnswer($, a, { takes: answers })));
  endRace(a);
  if (first.d === null) {
    const res = first.res;
    // Esc, an aborted turn and the dialog's "Chat about this" each end the call with no answers: the ask closes unanswered.
    if (res.isError || res.deny !== undefined) queueAskClose(a, 'closed');
    else queueAskClose(a, 'terminal', { answer: terminalSummary(res) });
    return res;
  }
  const d = first.d;
  credit($, a.sessionId, d);
  const reply = d.kind === 'reply';
  return { result: { questions: call.input.questions, answers: reply ? {} : answersByQuestion(a.questions ?? [], d.answers ?? []), ...(reply ? { response: d.text ?? '' } : {}) } };
}

/**
 * ExitPlanMode: one ask, two hooks. Feedback ("No, keep planning", or a message in its place) is answered here as `{ deny }`;
 * an approval goes to the waiting PermissionRequest hook, and counts only once that hook has handed it back and the call
 * resolves approved, within APPROVAL_CONFIRM_MS. As for a question, the terminal can win before the announce has gone.
 */
async function planRace($: Engine, r: Runtime, call: RacingCall, terminal: Promise<CallResult>): Promise<CallResult> {
  const a = openAsk($, r, planAsk({ id: call.id, agentId: call.agentId, openedAt: nowMs() }, call.input));
  const sendsBack = (d: Delivery) => (d.kind === 'plan-feedback' || d.kind === 'reply') && takes(rt, 'plan-feedback');
  const first = await firstAnswer(terminal, a.announcing.then(() => waitForAnswer($, a, { takes: sendsBack, other: (d) => holdApproval(a, d) })));
  if (first.d !== null) {
    endRace(a);
    credit($, a.sessionId, first.d);
    return planFeedback(first.d);
  }
  const res = first.res;
  const approvedThere = !res.isError && res.deny === undefined;
  const held = a.notTaken ? null : a.approval;
  endRace(a);
  if (held !== null && approvedThere && a.handedBack) {
    // Said only now that Claude Code took it: the terminal never reads "Approved from the dashboard" for one that did not.
    credit($, a.sessionId, held);
    return res;
  }
  // An approval never handed back (the hooks beneath still running, none here, or the hook failed) did not decide the call.
  if (held !== null) queueDeliveryResult(a.sessionId, held.id, 'closed');
  // Closed on what the terminal did: approved there, sent back with "Tell Claude what to change", or dismissed.
  if (approvedThere) queueAskClose(a, 'terminal', { planApproved: true });
  else if (planDismissed(res.text)) queueAskClose(a, 'closed');
  else queueAskClose(a, 'terminal', { answer: 'No, keep planning' });
  return res;
}

/**
 * A plan's approval, from either wait on its ask: held for the PermissionRequest hook, which checks that it took once it hands
 * it back (`confirmTook`).
 */
function holdApproval(a: OpenAsk, d: Delivery): void {
  if (d.kind !== 'plan-approve' || !takes(rt, 'plan-approve') || a.approval !== null) {
    queueDeliveryResult(a.sessionId, d.id, 'refused');
    return;
  }
  a.approval = d;
  wakeApprovalWaits(a, d);
  // The hooks beneath the PermissionRequest hook already decided the plan.
  if (a.notTaken) queueDeliveryResult(a.sessionId, d.id, 'not-taken');
}

/**
 * The PermissionRequest hook's wait for a plan's approval. It holds requests of its own, so one is in flight the whole time:
 * that stops the hook's 10-second budget, where waiting on a promise alone would not (such a hook was seen to let go live
 * on Claude Code 2.1.301). Feedback and replies are left to the tool.call hook's wait; an approval that wait got first
 * arrives through `approvalFor`.
 */
async function approvalFromDashboard($: Engine, a: OpenAsk): Promise<Delivery | null> {
  const filter: AnswerFilter = { takes: (d) => d.kind === 'plan-approve', leaves: (d) => d.kind === 'plan-feedback' || d.kind === 'reply' };
  const fromServer = waitForAnswer($, a, filter).then((d) => {
    if (d !== null) holdApproval(a, d);
    return a.approval;
  });
  return Promise.race([approvalFor(a), fromServer]);
}

/** An approval the PermissionRequest hook handed back whose plan call has not resolved approved within the confirm window did not take. */
async function confirmTook($: Engine, a: OpenAsk, d: Delivery): Promise<void> {
  await quietly(() => $.clock.sleep(APPROVAL_CONFIRM_MS), undefined);
  // A call that resolved in time has ended the race, and planRace settled the approval.
  if (a.done) return;
  a.notTaken = true;
  queueDeliveryResult(a.sessionId, d.id, 'not-taken');
}

/** A loop's newest open plan ask, for its PermissionRequest hook. */
const openPlanAsk = (agentId: string | undefined): OpenAsk | undefined =>
  [...answering.asks.values()].filter((a) => !a.done && a.ask.kind === 'plan' && a.ask.agentId === (agentId ?? null)).at(-1);

/** A plan ask's approval once there is one; null once the ask is done. */
function approvalFor(a: OpenAsk): Promise<Delivery | null> {
  if (a.approval !== null || a.done) return Promise.resolve(a.approval);
  return new Promise((wake) => a.approvalWaits.push(wake));
}

/** The key a loop's latest tool call is kept under. */
const loopOf = (agentId: string | null | undefined): string => agentId ?? '@main';

/** A tool input as text, to compare a PermissionRequest's input with its call's; empty when it cannot be written out. */
function argsKey(input: unknown): string {
  try {
    return JSON.stringify(input ?? null);
  } catch {
    // a cycle or a BigInt
    return '';
  }
}

/** A PermissionRequest fired: the hooks do run here. */
function permissionHookRan(r: Runtime, callId: string | null): void {
  answering.lastPermissionAt = nowMs();
  if (callId !== null) {
    answering.checks.get(callId)?.cancel();
    answering.checks.delete(callId);
  }
  if (answering.permissionHooks === true) return;
  answering.permissionHooks = true;
  touch(r);
}

/**
 * tool.check said a prompt is about to show. If no PermissionRequest follows within PERMISSION_CHECK_MS, PermissionRequest hooks
 * do not run here (a managed setup), and plan approval and permissions drop out of `accepts` until one does fire.
 */
function expectPermissionHook($: Engine, callId: string): void {
  const askedAt = nowMs();
  answering.checks.get(callId)?.cancel();
  const noneCame = () => {
    answering.checks.delete(callId);
    if (answering.lastPermissionAt >= askedAt || !rt) return;
    answering.permissionHooks = false;
    touch(rt);
  };
  try {
    answering.checks.set(callId, $.clock.after(PERMISSION_CHECK_MS, noneCame));
  } catch {
    // no clock on this host: it stays unknown
  }
}

/** What a PermissionRequest hook returns and its `next(e)` resolves to. */
type PermissionResult = ClassicResultOf['classic.PermissionRequest'];

/** Whether the hooks beneath settled a prompt: a decision, or `continue: false`, which takes precedence over any decision. */
const decidedBelow = (res: PermissionResult | undefined): boolean => res?.decision !== undefined || res?.preventContinuation === true;

/**
 * A tool's permission prompt. The hooks beneath (`below`, already running) run first and to the end, as they do without this
 * mod, and their decision stands. Only when they decide nothing, and the call is still waiting, is the prompt announced
 * under the call it pairs with; an answer from the dashboard while it is up is then the decision, joined to what they returned
 * as Claude Code joins its hooks' results. The engine does not end this hook when the terminal answers first; the call's own
 * end does (`toolAskEnded`).
 */
async function permissionAsk($: Engine, r: Runtime, e: { tool_name: string; tool_input: unknown; agent_id?: string }, below: Promise<PermissionResult>): Promise<PermissionResult> {
  const call = answering.lastCalls.get(loopOf(e.agent_id));
  if (call === undefined || call.tool !== e.tool_name || call.input !== argsKey(e.tool_input)) return below;
  const res = await below;
  // Answered in the terminal while they ran, or already open from another request.
  if (decidedBelow(res) || call.ended || answering.asks.has(call.id)) return res;
  const a = openAsk($, r, toolAsk({ id: call.id, agentId: e.agent_id ?? null, openedAt: nowMs() }, e.tool_name, e.tool_input));
  // Allow once only for a request shown whole; a cut one is Deny-only, since the owner did not see it as made.
  const answers = (d: Delivery) => (d.kind === 'allow-once' ? !a.ask.tool?.cut : d.kind === 'deny' || d.kind === 'reply') && takes(rt, 'permission');
  const d = await a.announcing.then(() => waitForAnswer($, a, { takes: answers }));
  if (d === null) return res;
  if (a.done) {
    // The call ended before this answer could be used.
    queueDeliveryResult(a.sessionId, d.id, 'closed');
    return res;
  }
  a.answered = d;
  sayInTranscript($, answeredLine(d, nowMs()));
  return { ...res, ...toolDecision(asDecision(d)) };
}

/**
 * The call of a permission ask ended. What happened is read from how it ended, since nothing else says: an answer from the
 * dashboard that matches it took; otherwise the terminal answered first.
 */
function toolAskEnded(id: string, res: CallResult | undefined): void {
  const a = answering.asks.get(id);
  if (a?.ask.kind !== 'permission') return;
  const d = a.answered;
  // The dashboard's own Deny is known by the message it sent.
  const sentDeny = d !== null && d.kind !== 'allow-once' ? toolDecision(asDecision(d)).decision : null;
  const denied = toolDenied(res, sentDeny !== null && 'message' in sentDeny ? sentDeny.message : undefined);
  const terminalSaid = { answer: denied ? 'denied' : 'allowed' };
  endRace(a);
  if (d === null) {
    queueAskClose(a, 'terminal', terminalSaid);
    return;
  }
  const dashboardWon = (d.kind === 'allow-once') !== denied;
  queueDeliveryResult(a.sessionId, d.id, dashboardWon ? 'took' : 'closed');
  if (!dashboardWon) queueAskClose(a, 'terminal', terminalSaid);
}

// ---- answering: messages and commands ---------------------------------------------------------------------------------

/** Messages and commands from a report's reply, each acted on once, within the session's own level. */
function takeDeliveries($: Engine, r: Runtime): void {
  const handed = r.transport.deliveries;
  r.transport.deliveries = [];
  for (const d of handed) {
    if (!actOnce($, d.id)) continue;
    const sid = r.state.id;
    const isMessage = d.kind === 'message' && typeof d.text === 'string' && d.text.trim() !== '' && takes(r, 'message');
    const command = d.kind === 'command' && (d.command === 'clear' || d.command === 'compact') && takes(r, 'command') ? d.command : null;
    if (!isMessage && command === null) {
      queueDeliveryResult(sid, d.id, 'refused');
      continue;
    }
    // Claude Code holds it until the session is idle; a busy session says so at once.
    if (r.state.status === 'running') queueDeliveryResult(sid, d.id, 'queued');
    void deliver($, sid, d, isMessage ? null : command);
  }
}

/**
 * A message (`command` null), or /clear or /compact as if the person typed it, acted on once the session is idle: a message
 * starts a turn of its own under the plugin's name, never as the person. Never any other command.
 */
async function deliver($: Engine, sid: string, d: Delivery, command: 'clear' | 'compact' | null): Promise<void> {
  try {
    if (command === null) await $.prompt.submit({ text: d.text ?? '' });
    else await $.command.run({ command });
    credit($, sid, d);
  } catch (err) {
    logError($, command === null ? 'prompt.submit' : 'command.run', err);
    queueDeliveryResult(sid, d.id, 'refused');
  }
}

/** "messages from the dashboard are on." the first time the session is idle with messages taken; again after that stopped, or a /clear. */
function sayMessagesOn($: Engine, r: Runtime): void {
  if (!takes(r, 'message')) {
    answering.messagesLineShown = false;
    return;
  }
  if (answering.messagesLineShown || !r.state.mainIdle) return;
  answering.messagesLineShown = true;
  sayInTranscript($, LINE_MESSAGES_ON);
}

// ---- session start and end, and /sitrep ----------------------------------------------------------------------

/** session.start, also after a hot reload: builds the state, registers /sitrep and the plan tool, starts the timers. */
async function sessionStarted($: Engine, e: { cwd: string; surface: string | null }): Promise<void> {
  rt?.stopTimers();
  const now = nowMs();
  // What the session says of itself, each read with its own fallback.
  const [id, model, root, repo, engine, usage, sessionKind] = await Promise.all([
    quietly(() => $.session.id(), `unknown-${now}`),
    quietly<string | null>(() => $.session.model(), null),
    quietly<string | null>(() => $.session.root(), e.cwd),
    quietly(() => $.session.repo(), null),
    quietly(() => $.session.version(), null),
    quietly(() => $.session.usage(), null),
    // Set by Claude Code for a `claude --bg` job (`bg`) and its daemon's own sessions; Claude reads any value as background.
    quietly(() => $.env.get('CLAUDE_CODE_SESSION_KIND'), undefined),
  ]);
  const prev = rt;
  // A reload under the same id keeps what it knew of the session; a new id starts over.
  const same = prev !== null && prev.state.id === id;
  const top = repo?.root ?? root ?? e.cwd;
  let state = same ? prev.state : newSession(id, e.cwd, usage?.startedAt || now, model);
  state = setIdentity(state, { cwd: e.cwd, projectRoot: top, repoName: repoNameOf(top, repo), model });
  if (usage) state = measure(state, usageFigures(usage));
  if (!same) state = addEvent(state, 'start', null, startText(model, null), now, { surface: e.surface });
  // The plugin's folder is fixed while this code is loaded, so its commit is read at the load's first session.start only.
  const build = prev ? (prev.reporter.build ?? null) : await devBuildOf($);
  const transport =
    prev?.transport ??
    new Transport((url, init) => $.http.fetch(url, init), { serverUrl: opts.serverUrl, token: opts.token, heartbeatMs: opts.heartbeatMs, version: VERSION }, (line) => void keepError('transport', line));
  const machine = prev?.machine ?? (await thisMachine($));
  const storedName = await stored($, `name:${id}`);
  const sessionCwd = await quietly<string | null>(() => $.session.cwd(), null);
  rt = {
    state,
    transport,
    stopTimers: () => {},
    reporter: {
      name: 'claude-reporter',
      version: VERSION,
      engineVersion: engine?.version ?? null,
      hostSurface: sessionKind !== undefined ? 'background' : (e.surface ?? 'headless'),
      ...(build ? { build } : {}),
    },
    interactive: e.surface !== null,
    machine,
    storedName,
    claudeName: same ? prev.claudeName : null,
    aiTitle: same ? prev.aiTitle : null,
    firstPrompt: same ? prev.firstPrompt : null,
    clearedFrom: same ? prev.clearedFrom : null,
    sessionCwd,
    skillCalls: 0,
    flushing: false,
    status: null,
    toasted: prev?.toasted ?? { ok: null, fail: null, plain: null, refusal: null, version: null },
  };
  const actedBefore = await quietly<unknown>(() => $.store.get(ACTED_KEY), undefined);
  answering.acted = Array.isArray(actedBefore) ? actedBefore.filter((x): x is string => typeof x === 'string').slice(-ACTED_KEPT) : [];
  // Whatever the module holds now, as a reload during the reads above would have replaced it.
  const r = rt;
  await readAgents($, r, now);
  await logged($, 'command.register', () => $.command.register({ name: 'sitrep', description: 'SITREP link and status; name this session', argumentHint: '[name <text>]' }));
  await logged($, 'tool.register', () =>
    $.tool.register({
      name: 'plan',
      description: 'Names the plan this session is working through, for SITREP. Call once with a short title when you start a multi-step plan.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', description: 'Short plan title' }, phase: { type: 'string', description: 'Optional phase name' } },
        required: ['title'],
      },
    }),
  );
  // Reports leave from the flush timer; git is read now and every GIT_POLL_MS.
  const running = [$.clock.every(opts.flushIntervalMs, () => void flush($)), $.clock.every(GIT_POLL_MS, () => void pollGit($, r))];
  r.stopTimers = () => {
    for (const timer of running.splice(0)) timer.cancel();
  };
  void pollGit($, r);
  refreshStatusLine($, r);
}

/** session.end: sends the session's last report and waits for it, for at most END_FLUSH_MS by the engine's clock. */
async function sessionEnded($: Engine, e: { reason: string; sessionId: string; resume?: { id: string } }, signal?: AbortSignal): Promise<void> {
  const r = rt;
  if (!r) return;
  const endingId = e.sessionId || r.state.id;
  // The server closes a finished session's asks itself; the races here only stop.
  for (const a of [...answering.asks.values()]) if (a.sessionId === endingId) endRace(a);
  const now = await clockNow($);
  if (!e.sessionId || e.sessionId === r.state.id) {
    const resumeId = e.resume?.id ?? e.sessionId ?? r.state.id;
    r.state = endSession(r.state, e.reason, resumeId, now);
    // The hooks sandbox has no setTimeout, so the deadline is a sleep on the engine's clock. A sleep the dispatch abandons
    // rejects; either way the race is over.
    const deadline = $.clock.sleep(END_FLUSH_MS, signal && { signal }).catch(() => undefined);
    const final = r.transport.idle().then(() => reportNow($, r, now, true));
    await Promise.race([final, deadline]);
  }
  // After /clear the process goes on under a new id, which the flush timer picks up; any other end is the end.
  if (e.reason === 'clear') return;
  r.stopTimers();
}

/** `/sitrep`, and `/sitrep name <text>` (the name trimmed, at most 80 characters). */
async function dashboardCommand($: Engine, args: string): Promise<string> {
  const r = rt;
  const [, name] = /^name\s+(\S[\s\S]*)$/i.exec(args.trim()) ?? [];
  if (name !== undefined && r) {
    const trimmed = name.trim().slice(0, 80);
    await logged($, 'store.set', () => $.store.set(`name:${r.state.id}`, trimmed));
    r.storedName = trimmed;
    touch(r);
    return `SITREP: session named "${trimmed}"`;
  }
  if (!r) return 'SITREP: session not started yet';
  const t = r.transport;
  const connection = t.refused ? 'token refused' : t.online === null ? 'connecting' : t.online ? `connected · ${t.liveSessions ?? 1} live` : 'offline';
  const reports = [`${t.sent} sent`, `${t.failed} failed`, `${t.rejected} rejected`, `${t.queue.length} events queued`, ...(t.dropped ? [`${t.dropped} dropped`] : [])];
  const times = Object.entries(hookTimes)
    .filter(([, h]) => h.calls > 0)
    .slice(0, 8)
    .map(([hook, h]) => `${hook} ${(h.totalMs / h.calls).toFixed(2)} ms avg, ${h.maxMs.toFixed(2)} max`);
  const failure = t.lastError ?? lastError;
  const background = backgroundLines(r.state);
  const lines = [
    `SITREP: ${trimTrailingSlashes(opts.serverUrl)}/#/`,
    `Connection: ${connection}`,
    `Versions: plugin ${withBuild(VERSION, r.reporter.build)}${t.serverVersion ? ` · server ${withBuild(t.serverVersion, t.serverBuild)}` : ''}`,
    t.versionNotice() ?? t.updateNotice(),
    `Reports: ${reports.join(' · ')}`,
    failure ? `Last error: ${failure}` : null,
    r.machine ? `Machine: ${r.machine.name} (${r.machine.id})` : "Machine: its id cannot be read, so nothing is reported (see Last error)",
    `Session: ${r.state.id}${r.storedName ? ` · named "${r.storedName}"` : ''}`,
    background.length > 0 ? `Background (${background.length}):\n${background.join('\n')}` : null,
    times.length > 0 ? `Hook time: ${times.join('; ')}` : null,
    'Rename: /sitrep name <text>',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

/** Which race a tool call runs while the mod answers: a question or a plan against the terminal's dialog; null for neither. */
function raceOf(r: Runtime, tool: string): 'question' | 'plan' | null {
  if (tool === 'AskUserQuestion' && takes(r, 'question')) return 'question';
  if (tool === 'ExitPlanMode' && (takes(r, 'plan-feedback') || takes(r, 'plan-approve'))) return 'plan';
  return null;
}

/**
 * A finished model request into the state (model, effort, context, a blowout its stop reason shows) and, for a watched loop,
 * the text it wrote as one feed entry. Hands the result back unchanged.
 */
function afterModelStep(e: TurnStepInput, res: TurnStepResult, said: string): TurnStepResult {
  guard('turn.step', (r) => {
    const now = nowMs();
    r.state = afterStep(r.state, { agentId: e.agentId, model: e.model, effort: e.effort, usage: res?.usage ?? null, stopReason: res?.stopReason ?? null }, now);
    const entry = said ? feedText(said) : '';
    if (entry) r.state = addFeedEntry(r.state, e.agentId, { at: now, kind: 'text', text: entry });
  });
  return res;
}

/** A client joined or left: read the roster now rather than at the next flush. */
async function rosterChanged($: Engine): Promise<void> {
  if (rt) await readSurfaces($, rt);
}

// ---- registration -----------------------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  // A fresh load starts every module variable over.
  opts = readOptions(options as Record<string, unknown>);
  generation++;
  rt = null;
  lastError = null;
  hookTimes = {};
  for (const pending of answering.checks.values()) pending.cancel();
  answering = freshAnswering();

  on('session.start', async ($, e, next) => {
    const res = await next(e);
    await sessionStarted($, e).catch((err: unknown) => logError($, 'session.start', err));
    return res;
  }).catch(passOn);

  on('session.end', async ($, e, next) => {
    const res = await next(e);
    await sessionEnded($, e, next.signal).catch((err: unknown) => logError($, 'session.end', err));
    return res;
  }).catch(passOn);

  // On current Claude Code a subagent's run raises turn.start too; only the main loop's starts a turn of the session.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) update('turn.start', (s) => turnStart(s, nowMs()));
    return next(e);
  }).catch(passOn);

  on('turn.step', async function* ($, e, next) {
    // A loop a viewer watches, with the activityFeed option on: its text chunks are read as they pass and kept as one entry.
    // Every chunk is passed on as it came, the same object and in order. `for await` drops a stream's return value, so the
    // result is read from `stream.result`. Any other step goes the plain way.
    let watched = false;
    guard('turn.step.watch', (r) => {
      watched = opts.activityFeed && isWatched(r.state, e.agentId);
    });
    if (!watched) {
      const res = yield* next(e);
      return afterModelStep(e, res, '');
    }
    const stream = next(e);
    let said = '';
    for await (const chunk of stream) {
      if (said.length < STEP_TEXT_MAX) {
        guard('turn.step.chunk', () => {
          if (chunk.kind === 'text' && typeof chunk.text === 'string') said += chunk.text;
        });
      }
      yield chunk;
    }
    const res = await stream.result;
    return afterModelStep(e, res, said);
  }).catch(async function* ($, e, next) {
    return yield* next(e);
  });

  // A loop's turn ended: the main loop goes idle, an agent finishes, fails or stops.
  on('turn.complete', async ($, e, next) => {
    const res = await next(e);
    update('turn.complete', (s) => turnComplete(s, { agentId: e.agentId, reason: e.reason, answer: e.answer }, nowMs()));
    return res;
  }).catch(passOn);

  on('session.compact', async ($, e, next) => {
    const res = await next(e);
    update('session.compact', (s) => {
      // Only a compaction that ran: not the precompute pass, nor one a hook skipped or that produced nothing.
      const ran = e.trigger !== 'precompute' && !!res && res.skip === undefined && !!res.messages;
      return ran ? afterCompaction(s, { agentId: e.agentId, trigger: e.trigger, tokensBefore: res.tokensBefore, tokensAfter: res.tokensAfter }, nowMs()) : s;
    });
    return res;
  }).catch(passOn);

  on('session.attach', async ($, e, next) => {
    const res = await next(e);
    await rosterChanged($);
    return res;
  }).catch(passOn);

  on('session.detach', async ($, e, next) => {
    const res = await next(e);
    await rosterChanged($);
    return res;
  }).catch(passOn);

  on('session.measure', async ($, e, next) => {
    update('session.measure', (s) => measure(s, { context: e.context, rateLimits: e.rateLimits }));
    return next(e);
  }).catch(passOn);

  on('agent.spawn', async ($, e, next) => {
    const res = await next(e);
    update('agent.spawn', (s) => {
      // Only an agent that actually started.
      if (res?.deny !== undefined || !res?.agentId) return s;
      // The name SendMessage addresses it by: a teammate's is its name in the team, `teammateId` (`<name>@<team>`) up to the
      // `@`, with the suffix the team gives a taken name (`scout-2`); any other agent's is the call's.
      const name = res.teammateId?.split('@')[0] || e.name;
      const model = res.model ?? e.model ?? null;
      const spawn = { agentId: res.agentId, toolUseId: e.tool_use_id, parentAgentId: e.parentAgentId, fork: e.fork, isTeammate: e.isTeammate === true, subagentType: e.subagentType, name, description: e.description, prompt: e.prompt, model };
      return agentSpawned(s, spawn, nowMs());
    });
    return res;
  }).catch(passOn);

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool);
    const callInput = e as unknown as Record<string, unknown>;
    let call: CallEntry | undefined;
    guard('tool.call', (r) => {
      const now = nowMs();
      r.state = toolStarted(r.state, e.agentId, tool, callInput, now);
      if (opts.activityFeed && isWatched(r.state, e.agentId)) r.state = addFeedEntry(r.state, e.agentId, toolEntry(now, tool, callInput, e.tool_use_id));
      if (tool === 'Agent' && e.tool_use_id) r.state = agentAsked(r.state, e.tool_use_id, callInput, now);
      if (tool === 'Skill') r.skillCalls++;
      if (!e.tool_use_id || opts.respond === 'off') return;
      // A PermissionRequest that follows carries only the tool's own arguments, so the call is kept by those to match it.
      const args = Object.fromEntries(Object.entries(callInput).filter(([key]) => !EVENT_FIELDS.has(key)));
      call = { tool, input: argsKey(args), id: e.tool_use_id, ended: false };
      answering.lastCalls.set(loopOf(e.agentId), call);
    });
    // While the mod answers, a question or a plan races the terminal's dialog against an answer from the dashboard.
    const r = rt;
    const racer: RacingCall | null = e.tool_use_id ? { id: e.tool_use_id, agentId: e.agentId ?? null, input: callInput } : null;
    const racing = r && racer ? raceOf(r, tool) : null;
    let res: CallResult | undefined;
    try {
      if (r && racer && racing === 'question') res = await questionRace($, r, racer, next(e) as Promise<CallResult>);
      else if (r && racer && racing === 'plan') res = await planRace($, r, racer, next(e) as Promise<CallResult>);
      else res = (await next(e)) as CallResult | undefined;
    } catch (err) {
      // A call that throws returns no result: it is no longer open, and not marked done.
      update('tool.call.aborted', (s) => toolAborted(s, e.agentId, nowMs()));
      throw err;
    } finally {
      // A PermissionRequest whose hooks beneath were still running then opens no ask for it (permissionAsk).
      if (call) call.ended = true;
      guard('tool.call.done', (rr) => {
        if (tool === 'Skill') rr.skillCalls = Math.max(0, rr.skillCalls - 1);
      });
    }
    guard('tool.call.result', (rr) => {
      const result = res ?? {};
      rr.state = toolResult(rr.state, { agentId: e.agentId, tool, input: callInput, result }, nowMs());
      if (!e.tool_use_id) return;
      toolAskEnded(e.tool_use_id, res);
      // How a finished Bash call ended rides the feed; its output never does.
      if (tool === 'Bash' && opts.activityFeed) rr.state = patchFeedEntry(rr.state, e.agentId, e.tool_use_id, finishedCall(result));
    });
    return res as Awaited<ReturnType<typeof next>>;
  }).catch(passOn);

  // Where a prompt is about to show, a PermissionRequest should follow; if none does, those hooks do not run here.
  on('tool.check', async ($, e, next) => {
    const res = await next(e);
    guard('tool.check', () => {
      if (res?.decision === 'ask' && opts.respond !== 'off' && e.tool_use_id) expectPermissionHook($, e.tool_use_id);
    });
    return res;
  }).catch(passOn);

  // The reporter's own plan tool, answered here and recorded by the tool.call hook above. The matcher is the tool's full name,
  // `mcp__<plugin>__<name>`, written out so the engine sees which tool this hook answers; the result is text, since Claude Code
  // takes any other shape as an error.
  const planRecorded = { result: 'Plan title recorded for SITREP.' };
  on('tool.call', { tool: 'mcp__sitrep-reporter__plan' }, () => planRecorded).catch(() => planRecorded);

  on('skill.prompt', async ($, e, next) => {
    // A Skill call records its own loop, and an agent may be preloading the skill: skipped when it is not clear whose it is.
    guard('skill.prompt', (r) => {
      const unclear = r.skillCalls > 0 || Object.values(r.state.agents).some((a) => a.status === 'running');
      if (!unclear) r.state = withSkill(r.state, undefined, e.skill, nowMs());
    });
    return next(e);
  }).catch(passOn);

  on('classic.PermissionRequest', async ($, e, next) => {
    // The hooks beneath, the owner's settings hooks among them, run first and now, while the prompt is up, as they do without
    // this mod. `next` is called once, here; the dashboard answers only where they decide nothing.
    const below = next(e);
    const agentId = e.agent_id;
    guard('classic.PermissionRequest', (r) => {
      r.state = promptShown(r.state, agentId, e.tool_name, e.tool_input, nowMs());
      const latest = answering.lastCalls.get(loopOf(agentId));
      permissionHookRan(r, latest?.tool === e.tool_name ? latest.id : null);
    });
    const r = rt;
    // Nothing answers without a runtime, and a question is answered through its tool.call race.
    if (!r || e.tool_name === 'AskUserQuestion') return below;
    if (e.tool_name !== 'ExitPlanMode') return takes(r, 'permission') ? permissionAsk($, r, { tool_name: e.tool_name, tool_input: e.tool_input, agent_id: agentId }, below) : below;
    // A plan's approval from the dashboard: `updatedInput` is the event's own tool_input, unchanged. The transcript line waits
    // for the call to resolve approved (planRace), so it never claims an approval that did not take.
    const ask = takes(r, 'plan-approve') ? openPlanAsk(agentId) : undefined;
    if (!ask) return below;
    // The hooks beneath first, as for a tool (permissionAsk). The plan's ask is already open (planRace), so an approval may
    // have come while they ran; it waits on the ask.
    const res = await below;
    if (ask.done) return res;
    if (decidedBelow(res)) {
      // Their decision stands: an approval from the dashboard, taken or still to come, does not take (holdApproval).
      ask.notTaken = true;
      if (ask.approval !== null) queueDeliveryResult(ask.sessionId, ask.approval.id, 'not-taken');
      return res;
    }
    const approval = await approvalFromDashboard($, ask);
    if (!approval?.mode) return res;
    // The confirm window starts now, as the approval is handed back.
    void confirmTook($, ask, approval);
    ask.handedBack = true;
    return { ...res, ...planApproval(e.tool_input as Record<string, unknown>, approval.mode) };
  }).catch(passOn);

  on('classic.Notification', async ($, e, next) => {
    update('classic.Notification', (s) => notified(s, e.agent_id, e.notification_type, e.message, nowMs()));
    return next(e);
  }).catch(passOn);

  // Claude Code's own name for the session rides on these two hooks, so a rename shows from the next prompt; its generated
  // title is read from the transcript here and at each turn end, so the name moves to it once Claude writes one. A move and
  // the title are followed on their own: neither the hooks beneath nor the prompt waits on git or the transcript.
  on('classic.SessionStart', async ($, e, next) => {
    guard('classic.SessionStart', (r) => noteClaudeName(r, e));
    void logged($, 'classic.SessionStart', () => hookMovedTo($, e.cwd));
    void logged($, 'transcript.title', () => readAiTitle($, e));
    return next(e);
  }).catch(passOn);

  on('classic.UserPromptSubmit', async ($, e, next) => {
    guard('classic.UserPromptSubmit', (r) => noteClaudeName(r, e));
    void logged($, 'classic.UserPromptSubmit', () => hookMovedTo($, e.cwd));
    void logged($, 'first.prompt', () => noteFirstPrompt($, e));
    void logged($, 'transcript.title', () => readAiTitle($, e));
    return next(e);
  }).catch(passOn);

  // The Stop hook lists the background work and wake-ups still pending: a session idle on them is not waiting on the person.
  on('classic.Stop', async ($, e, next) => {
    update('classic.Stop', (s) => {
      const now = nowMs();
      const wakeups = (e.session_crons ?? []).map((cron) => ({ ...cron, nextAt: nextCronAt(cron.schedule, now) }));
      return setBackground(s, { tasks: e.background_tasks ?? [], crons: wakeups }, now);
    });
    void logged($, 'transcript.title', () => readAiTitle($, e));
    return next(e);
  }).catch(passOn);

  // The orchestrator's turn ended on an API failure Claude Code names. A subagent's is already its agent's
  // `Model API error` failure, so only the main loop's is taken.
  on('classic.StopFailure', async ($, e, next) => {
    if (e.agent_id === undefined) update('classic.StopFailure', (s) => apiFailure(s, e.error, nowMs()));
    return next(e);
  }).catch(passOn);

  on('command.run', { command: 'sitrep' }, async ($, e) => ({ text: await dashboardCommand($, e.args ?? '') }));
};
