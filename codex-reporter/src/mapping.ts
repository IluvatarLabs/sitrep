// The in-memory model of every Codex thread on this machine and the mapping onto the dashboard's Report.
// Three sources feed it: our plugin's hook records, the threads' session files, and the daemon's broadcasts. Where they
// overlap: status from the daemon, then hooks, then the session file; model from hooks, then the session file, then the
// daemon; effort from the session file, then the daemon (hooks carry none). The daemon's values are snapshots it never
// refreshes for a client that is not subscribed. Facts are timestamped by the event that carried them, so a source read late
// never undoes a newer one. Unknown stays unknown.
import path from 'node:path';
import type { ThreadStatus, Thread as CodexThread } from './codex-protocol/v2.js';
import { clip, clipFreeText, LIMITS } from './report.js';
import { threadOfFile, type AsyncQuestion, type ParsedLine, type RawWindow, type RolloutRecord, type SentMessage } from './sessionFiles.js';
import { JsonlTail } from './spool.js';
import type {
  ActivityEntry,
  ActivityEvent,
  AgentStatus,
  ContextFill,
  Failure,
  FailureClass,
  FilesReport,
  GitInfo,
  ModelUsage,
  PlanStep,
  RateLimit,
  SessionReport,
  UsageTokens,
} from '../../server/src/fleet/protocol.js';

/**
 * A thread without newer evidence than this, and not loaded in the daemon, is no longer reported: the time Codex
 * keeps an idle thread loaded, `thread_unload_delay_secs`, default 1800 (`config/src/config_toml.rs:352`,
 * `core/src/config/mod.rs:4071-4072` at rust-v0.164.0), so a thread no daemon reports stays as long as Codex keeps it.
 */
export const LIVE_WINDOW_MS = 30 * 60_000;
/** A thread with no evidence for this long, not loaded, is forgotten. */
const FORGET_AFTER_MS = 60 * 60_000;
/** Activity entries a watched loop keeps. */
const ACTIVITY_KEPT = 20;
/** Events a session holds before the transport takes them. */
const EVENTS_KEPT = 500;
/** Codex's own context baseline: tokens always present (prompts, tools, room to compact), `protocol.rs:2571-2617`. */
const BASELINE_TOKENS = 12_000;
const KEYS_KEPT = 500;
/**
 * A request over this many input tokens is priced at OpenAI's long-context rate (developers.openai.com/api/docs/pricing, Context
 * length: "Long: >272K input tokens"). Cached input is counted as input (a usage record's `input_tokens` includes it), by our
 * reading.
 */
const LONG_INPUT = 272_000;
/** A usage row per model and price tier: the key joins the two with a NUL, which neither a model id nor a tier contains. */
const usageKey = (model: string, tier: ModelUsage['tier']): string => `${model}\u0000${tier}`;

/** One line of `~/.sitrep/codex-hooks.ndjson`, as `plugin/hooks/codex-hook.mjs` writes it. */
export interface HookRecord {
  /** The hook script's own timestamp, epoch ms. */
  t: number;
  ev: string;
  sid?: string;
  aid?: string;
  atype?: string;
  cwd?: string;
  tp?: string;
  m?: string;
  tool?: string;
  tuid?: string;
  /** A bounded, redacted summary of the tool call: the tool's name and its main argument. */
  sum?: string;
  /** Absolute paths an `apply_patch` call names (at most 50). */
  files?: string[];
  /** What the call's patch headers do to those paths, in order (at most 50). */
  changes?: FileChangeOp[];
  /** `files` or `changes` leaves out a path or change the call names (more than 50, or one the hook or the parse dropped). */
  filesCut?: boolean;
  /** The call's patch body, redacted and at most 20,000 characters, for its file approval only (never activity or events). */
  patch?: string;
  /** `patch` is not the body exactly as Codex passed it (redacted, shortened, or holding a character not shown as written). */
  patchCut?: boolean;
  trigger?: string;
}

/** One change an `apply_patch` header makes (codex-hook.mjs patchPaths): a move goes from `path` to `to`. */
export interface FileChangeOp {
  op: 'add' | 'delete' | 'update' | 'move';
  path: string;
  to?: string;
}

export interface Loop {
  toolCalls: number;
  /** Finished calls per tool name. A Map, so a tool named `constructor` or `__proto__` is a key like any other. */
  toolCounts: Map<string, number>;
  lastTool: string | null;
  /** Calls started and not finished, by call id. */
  open: Map<string, string>;
}

const newLoop = (): Loop => ({ toolCalls: 0, toolCounts: new Map(), lastTool: null, open: new Map() });

export interface Thread {
  id: string;
  /** The root thread of its session tree (= `id` for a root). */
  sessionId: string;
  /** The thread that spawned it; null for a root, or a child whose parent is not known yet. */
  parentId: string | null;
  firstSeenAt: number;
  /** A hook event has arrived for this thread. */
  hookSeen: boolean;
  /** The thread's newest file, read through every record: a plain one tailed, a compressed one (no tail) read whole once. */
  rollout: { path: string; tail: JsonlTail | null; metaSeen: boolean } | null;
  /** Each of its files taken up, and whether it has been read to its end once (main.ts usageReady). */
  files: Map<string, boolean>;
  startedAt: number | null;
  cwd: { daemon: string | null; hook: string | null; file: string | null };
  model: { daemon: string | null; hook: string | null; file: string | null };
  effort: { daemon: string | null; file: string | null };
  name: string | null;
  nickname: string | null;
  role: string | null;
  /** The agent path a multi-agent v2 spawn gave it (session file), what a v2 message names it by; null for a root or a v1 child. */
  agentPath: string | null;
  agentType: string | null;
  cliVersion: string | null;
  /**
   * `session_meta.originator` (session file): the client that started the thread, sent as the report's `hostSurface`
   * (`Codex Desktop`, `codex-tui`, `Claude Code`, `codex_exec` …); `Codex Desktop` also marks a desktop-app thread (respond.ts).
   */
  originator: string | null;
  /**
   * The first user prompt parsed from the thread's session files, as a session name (sessionFiles promptOf: redacted as free
   * text, cut); kept once set, so a file read later never replaces it.
   */
  firstPrompt: string | null;
  historyMode: 'legacy' | 'paginated' | null;
  /** In the daemon's loaded set, as its broadcasts say. */
  loaded: boolean;
  status: ThreadStatus | null;
  ephemeral: boolean | null;
  /** The latest evidence of a turn running and of the thread being idle (epoch ms). */
  runAt: number;
  idleAt: number;
  /**
   * A PermissionRequest hook seen and not yet ended by a later tool start, the call's end or the turn's end. `tool` is the
   * waiting call's tool; `ownStartSeen` says that call's own PreToolUse has been read (see toolStartEndsWait).
   */
  permission: { note: string; at: number; tool: string; ownStartSeen: boolean } | null;
  ended: boolean;
  endedAt: number;
  /**
   * The last turn's end, when it ended with an error or was aborted. `failed`: it carried Codex's `error`; `category`: that
   * error's `codex_error_info`, null without one (then it is an agent failure but no API error category).
   */
  turnError: { category: string | null; failed: boolean; aborted: boolean; at: number } | null;
  /** The running turn's id from the session file (`task_started`), null once it ended: where an async answer is steered. */
  turnId: string | null;
  answer: string | null;
  lastEvidenceAt: number;
  lastActivityAt: number | null;
  /** Tokens per model and tier (`usageKey`), from the usage records of all of its files (addUsage). */
  usage: Map<string, ModelUsage>;
  /** The response ids of the usage records counted: each once, and their count is the thread's steps. */
  responses: Set<string>;
  contextWindow: number | null;
  context: ContextFill | null;
  rateLimits: { at: number; limits: RateLimit[] } | null;
  hookLoop: Loop;
  fileLoop: Loop;
  /** Consecutive failed shell commands, from paginated-history items only; ended by a success and by a turn's start or end. */
  commandFailures: number;
  lastFailedCommand: { at: number; summary: string; exitCode: number | null } | null;
  blowouts: number;
  compacting: boolean;
  plan: PlanStep[] | null;
  activity: ActivityEntry[];
  /** The spawning call's prompt (child), bounded and redacted. */
  prompt: string;
  /** spawn_agent calls of this thread waiting for their result: call id -> prompt excerpt. */
  spawnCalls: Map<string, string>;
  /**
   * Per apply_patch call, for its file approval: the paths and changes our PreToolUse hook recorded, `cut` when
   * either leaves any out, and the patch the ask shows with `patchCut` when it is not the whole body. In memory only.
   */
  patchPaths: Map<string, { paths: string[]; changes: FileChangeOp[]; cut: boolean; patch?: string; patchCut: boolean }>;
  editKeys: Set<string>;
  /**
   * `request_user_input_async` calls by call id: their questions, when they were asked, which of them a reply in the
   * session file has answered (by index), and whether the call is still open — or answered (every question, or the call as a
   * whole), dropped when its turn ended as Codex's TUI drops them, or refused by Codex (its output is not `{"accepted":true}`).
   */
  asyncQuestions: Map<string, { questions: AsyncQuestion[]; at: number; replied: Set<number>; state: 'open' | 'replied' | 'ended' | 'refused' }>;
  /** The session-start (root) or spawn (child) event has been considered. */
  announced: boolean;
  endEventAt: number;
}

export interface Session {
  /** The root thread id. */
  id: string;
  events: ActivityEvent[];
  dirty: boolean;
  /** The loops the last reply listed as watched (`@orchestrator` for the root). */
  watched: string[];
  git: GitInfo | null;
  files: FilesReport | null;
  gitBase: string | null;
  placeCwd: string | null;
  projectRoot: string | null;
  repoName: string | null;
  /** The `endedAt` whose final report the server has taken, or refused for good. */
  finalFor: number;
  /** Every file of the session has been read once since it was first seen (main.ts usageReady). */
  usageReady: boolean;
  /** The last report the server took carried no usage (not ready yet): the session stays reported until one with it is taken. */
  usagePending: boolean;
}

export interface SessionState {
  status: SessionReport['status'];
  waitReason: SessionReport['waitReason'];
  waitNote: string | null;
}

/** Codex's own context formula: the share of the effective window (window − baseline) in use, `protocol.rs:2605-2617`. */
export function contextPercent(tokens: number, window: number): number {
  if (window <= BASELINE_TOKENS) return 100;
  const effective = window - BASELINE_TOKENS;
  const used = Math.max(0, tokens - BASELINE_TOKENS);
  const remaining = Math.max(0, effective - used);
  return 100 - Math.round(Math.min(100, Math.max(0, (remaining / effective) * 100)));
}

/**
 * A Codex plan window as the Report's `{ kind, percentUsed, resetsAt, measuredAt }`. A window of unknown length
 * keeps Codex's slot name. `measuredAt` is the time of the `token_count` record that carried it (epoch ms `at`, the record's
 * `timestamp`, `history/src/lib.rs:369-375`): the reading's age, as Codex's own status card keeps one (`captured_at`,
 * `tui/src/status/rate_limits.rs:66, 248`).
 */
export function rateLimit(slot: 'primary' | 'secondary', w: RawWindow, at: number): RateLimit {
  const kind = w.windowMinutes === 300 ? 'five_hour' : w.windowMinutes === 10_080 ? 'seven_day' : w.windowMinutes !== null ? `${w.windowMinutes}m` : slot;
  return { kind, percentUsed: w.usedPercent, resetsAt: w.resetsAt !== null ? new Date(w.resetsAt * 1000).toISOString() : null, measuredAt: new Date(at).toISOString() };
}

/**
 * Codex's `input_tokens` with its two cached parts taken out: cache reads (`cached_input_tokens`) and cache writes
 * (`cache_write_input_tokens`) are both counted inside it (`codex-api/src/sse/responses.rs` test `parses_cache_write_token_usage`:
 * input 100 = cached 40 + cache-write 60). Never below 0.
 */
function uncachedInput(input: number, cached: number, cacheWrite: number): number {
  return Math.max(0, input - cached - cacheWrite);
}

/**
 * A `token_count` written by Codex's fill on a context-window-exceeded failure (`core/src/session/turn.rs:1824-1826` →
 * `TokenUsageInfo::fill_to_context_window`): total set to the window, every part 0, last usage the gap to the window. It is
 * not a measurement.
 */
function isWindowFill(r: Extract<RolloutRecord, { kind: 'tokens' }>): boolean {
  const u = r.total;
  return !!u && r.window !== null && u.total === r.window && u.input === 0 && u.cached === 0 && u.cacheWrite === 0 && u.output === 0 && u.reasoning === 0;
}

const PLAN_STATES: Record<string, PlanStep['state']> = { pending: 'pending', in_progress: 'active', completed: 'done' };

const waitsOnApproval = (s: ThreadStatus): boolean => s.type === 'active' && s.activeFlags.includes('waitingOnApproval');

function remember<T>(set: Set<T>, v: T): boolean {
  if (set.has(v)) return false;
  set.add(v);
  if (set.size > KEYS_KEPT) set.delete(set.values().next().value as T);
  return true;
}

export class Fleet {
  readonly threads = new Map<string, Thread>();
  readonly sessions = new Map<string, Session>();
  /** Our hooks' trust as `hooks/list` reports it while a daemon is connected; null without a daemon. */
  hooksTrusted: boolean | null = null;
  activityFeed: boolean;

  constructor(activityFeed: boolean) {
    this.activityFeed = activityFeed;
  }

  // ---- identity ---------------------------------------------------------------------------------

  thread(id: string, now = Date.now()): Thread {
    let t = this.threads.get(id);
    if (!t) {
      t = {
        id,
        sessionId: id,
        parentId: null,
        firstSeenAt: now,
        hookSeen: false,
        rollout: null,
        files: new Map(),
        startedAt: null,
        cwd: { daemon: null, hook: null, file: null },
        model: { daemon: null, hook: null, file: null },
        effort: { daemon: null, file: null },
        name: null,
        nickname: null,
        role: null,
        agentPath: null,
        agentType: null,
        cliVersion: null,
        originator: null,
        firstPrompt: null,
        historyMode: null,
        loaded: false,
        status: null,
        ephemeral: null,
        runAt: 0,
        idleAt: 0,
        permission: null,
        ended: false,
        endedAt: 0,
        turnError: null,
        turnId: null,
        answer: null,
        lastEvidenceAt: 0,
        lastActivityAt: null,
        usage: new Map(),
        responses: new Set(),
        contextWindow: null,
        context: null,
        rateLimits: null,
        hookLoop: newLoop(),
        fileLoop: newLoop(),
        commandFailures: 0,
        lastFailedCommand: null,
        blowouts: 0,
        compacting: false,
        plan: null,
        activity: [],
        prompt: '',
        spawnCalls: new Map(),
        patchPaths: new Map(),
        editKeys: new Set(),
        asyncQuestions: new Map(),
        announced: false,
        endEventAt: 0,
      };
      this.threads.set(id, t);
      this.session(id);
    }
    return t;
  }

  session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, events: [], dirty: true, watched: [], git: null, files: null, gitBase: null, placeCwd: null, projectRoot: null, repoName: null, finalFor: 0, usageReady: false, usagePending: false };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** A thread whose files' first line names session `sessionId` (main.ts scan), placed in that session. */
  indexedThread(id: string, sessionId: string): Thread {
    const t = this.thread(id);
    this.link(t, sessionId, null);
    return t;
  }

  /**
   * Places a thread in its session tree. A child's own session entry (made before its root was known) is merged into the
   * session it joins: the entry goes, and the events queued under it move there (adopt).
   */
  private link(t: Thread, sessionId: string | null, parentId: string | null): void {
    if (sessionId && sessionId !== t.sessionId) {
      t.sessionId = sessionId;
      if (sessionId !== t.id) {
        const own = this.sessions.get(t.id);
        if (own && !this.threadsOf(t.id).some((x) => x.id !== t.id)) {
          this.sessions.delete(t.id);
          this.adopt(t, own.events);
        }
      }
      this.thread(sessionId);
      this.mark(t);
    }
    if (parentId && parentId !== t.id && parentId !== t.parentId) {
      t.parentId = parentId;
      this.mark(t);
    }
  }

  /**
   * The events a thread queued while it stood as its own root, appended in their order to the session it joined. Each becomes
   * the agent's own (`agentId` the thread, the id under the new session), the id an event of that agent has when its root is
   * known from the start.
   */
  private adopt(t: Thread, events: readonly ActivityEvent[]): void {
    if (!events.length) return;
    const s = this.sessionOf(t);
    for (const e of events) {
      const agentId = e.agentId ?? t.id;
      // `<session>:<agent|main>:<kind>:<t>:<key>`: only the first two parts change.
      const rest = e.id.split(':').slice(2).join(':');
      s.events.push({ ...e, agentId, id: `${s.id}:${agentId}:${rest}` });
    }
    if (s.events.length > EVENTS_KEPT) s.events.splice(0, s.events.length - EVENTS_KEPT);
    s.dirty = true;
  }

  threadsOf(sessionId: string): Thread[] {
    return [...this.threads.values()].filter((t) => t.sessionId === sessionId);
  }

  isChild(t: Thread): boolean {
    return t.sessionId !== t.id;
  }

  private sessionOf(t: Thread): Session {
    return this.session(t.sessionId);
  }

  private mark(t: Thread): void {
    this.sessionOf(t).dirty = true;
  }

  private evidence(t: Thread, at: number, activity: boolean): void {
    if (at > t.lastEvidenceAt) t.lastEvidenceAt = at;
    if (activity && (t.lastActivityAt === null || at > t.lastActivityAt)) t.lastActivityAt = at;
    if (t.ended && at > t.endedAt) t.ended = false; // resumed after it ended
    this.mark(t);
  }

  // ---- events -----------------------------------------------------------------------------------

  /**
   * Queues one event with a durable id (the protocol's `sessionId:agentId|main:kind:t:n`), `n` taken from the source
   * record so a re-read after a restart produces the same id. Events older than the live window are history and not sent.
   */
  private event(t: Thread, kind: ActivityEvent['kind'], text: string, at: number, key: string, data: Record<string, unknown> | null = null, now = Date.now()): void {
    if (now - at > LIVE_WINDOW_MS) return;
    const s = this.sessionOf(t);
    const agentId = this.isChild(t) ? t.id : null;
    s.events.push({ id: `${s.id}:${agentId ?? 'main'}:${kind}:${at}:${key}`, t: at, kind, agentId, text: clip(text.replace(/\s+/g, ' ').trim(), LIMITS.text), data });
    if (s.events.length > EVENTS_KEPT) s.events.splice(0, s.events.length - EVENTS_KEPT);
    s.dirty = true;
  }

  private loopLabel(t: Thread): string {
    return this.isChild(t) ? `in “${t.prompt || t.nickname || 'an agent'}”` : 'on the orchestrator';
  }

  private spawnText(t: Thread): string {
    const who = [t.role ?? t.agentType ?? 'agent', t.nickname].filter(Boolean).join(' ');
    return `spawned ${who}${t.prompt ? `: ${t.prompt}` : ''}`;
  }

  /** The session-start and spawn events, once each, when a thread is first seen with live evidence. */
  private announce(t: Thread, at: number, key: string): void {
    if (t.announced) return;
    t.announced = true;
    if (!this.isChild(t)) {
      const model = this.modelOf(t);
      this.event(t, 'start', `session.start${model ? ` · ${model}` : ''}`, at, key);
    } else this.event(t, 'spawn', this.spawnText(t), at, key, { kind: 'subagent' });
  }

  // ---- hooks ------------------------------------------------------------------------------------

  /** One hook record. A record with `aid` belongs to the child thread `aid` of session `sid`; otherwise to the root `sid`. */
  applyHook(h: HookRecord, key: string): void {
    if (!h.sid || !Number.isFinite(h.t)) return;
    const t = this.thread(h.aid ?? h.sid, h.t);
    this.link(t, h.sid, null);
    t.hookSeen = true;
    if (h.cwd) t.cwd.hook = h.cwd;
    if (h.m) t.model.hook = h.m;
    if (h.atype) t.agentType = h.atype;
    // Only a first file: which file a thread moves to later is the session index's to say (main.ts follow), so two sources never
    // trade the file back and forth, each change reading it again from its start.
    if (h.tp && !h.aid && !t.rollout) this.setRollout(t, h.tp);
    if (t.startedAt === null && (h.ev === 'SessionStart' || h.ev === 'SubagentStart')) t.startedAt = h.t;
    const activity = h.ev !== 'SessionStart' && h.ev !== 'SessionEnd';
    this.evidence(t, h.t, activity);
    if (h.ev !== 'SessionEnd') this.announce(t, h.t, key);
    const loop = t.hookLoop;
    switch (h.ev) {
      case 'UserPromptSubmit':
      case 'SubagentStart':
        this.running(t, h.t);
        this.turnBoundary(t, h.t);
        break;
      case 'PreToolUse': {
        this.running(t, h.t);
        const tool = h.tool ?? 'tool';
        this.toolStartEndsWait(t, tool, h.t);
        loop.toolCalls++;
        loop.lastTool = tool;
        if (h.tuid) loop.open.set(h.tuid, tool);
        if (h.sum) this.activityEntry(t, { at: h.t, kind: 'tool', text: h.sum, ...(h.tuid ? { id: h.tuid } : {}) });
        if (h.files?.length) {
          if (h.tuid) {
            t.patchPaths.set(h.tuid, { paths: h.files, changes: h.changes ?? [], cut: h.filesCut === true, patch: h.patch, patchCut: h.patchCut === true });
            if (t.patchPaths.size > 50) t.patchPaths.delete(t.patchPaths.keys().next().value as string);
          }
          h.files.forEach((p, i) => this.edit(t, p, h.t, `${key}.${i}`, h.tuid ?? key));
        }
        break;
      }
      case 'PermissionRequest': {
        this.running(t, h.t);
        const tool = h.tool ?? 'tool';
        // Codex's hooks name every shell-like tool `Bash`; the label says `Shell`, as the daemon's command asks do (respond.ts).
        const label = tool === 'Bash' ? 'Shell' : (h.tool ?? 'Tool');
        // A shell command's note is display text taken from the command: the broader rules too; any other keeps its tool name.
        // The rules run on the argument alone, so none can take the closing bracket.
        const note = `${label}(${(tool === 'Bash' ? clipFreeText : clip)((h.sum ?? '').slice((h.tool ?? '').length).trim(), 158 - label.length)})`;
        t.permission = { note, at: h.t, tool, ownStartSeen: [...loop.open.values()].includes(tool) };
        if (!this.isDaemonHosted(t)) this.event(t, 'wait', `waiting on you: ${note}`, h.t, key);
        break;
      }
      case 'PostToolUse': {
        const tool = (h.tuid && loop.open.get(h.tuid)) || h.tool || 'tool';
        if (h.tuid) loop.open.delete(h.tuid);
        loop.toolCounts.set(tool, (loop.toolCounts.get(tool) ?? 0) + 1);
        if (t.permission && t.permission.at <= h.t) t.permission = null;
        this.finishEntry(t, h.tuid, {});
        break;
      }
      case 'PreCompact':
      case 'PostCompact':
        if (h.trigger === 'auto') {
          // One compaction fires both hooks: count it at PreCompact, or at PostCompact when its PreCompact was missed.
          if (h.ev === 'PreCompact' || !t.compacting) this.blowout(t, h.t, key, 'auto-compact');
          t.compacting = h.ev === 'PreCompact';
        } else if (h.ev === 'PreCompact' && h.trigger === 'manual') {
          this.event(t, 'compact', `manual compaction ${this.loopLabel(t)}`, h.t, key, { trigger: 'manual' });
        }
        break;
      case 'SubagentStop':
      case 'Stop':
      case 'Interrupt':
        this.idle(t, h.t);
        this.turnBoundary(t, h.t);
        if (h.ev === 'SubagentStop' && !t.rollout && h.t > t.endEventAt) {
          t.endEventAt = h.t;
          this.event(t, 'done', `finished: ${t.prompt || t.nickname || 'agent'}`, h.t, key);
        }
        break;
      case 'SessionEnd':
        if (!this.isChild(t)) {
          t.ended = true;
          t.endedAt = h.t;
          this.idle(t, h.t);
          this.event(t, 'end', 'session.end · other', h.t, key, { reason: 'other' });
        }
        break;
    }
  }

  private running(t: Thread, at: number): void {
    if (at > t.runAt) t.runAt = at;
  }

  /**
   * A turn started or ended at `at`: the run of failed commands is over, as a prompt submitted or a turn stopped ends it in the
   * Claude reporter (its turnStart and turnComplete). A failure timed after `at`, read first from the session file, is newer
   * than this boundary and keeps the count.
   */
  private turnBoundary(t: Thread, at: number): void {
    if (!t.lastFailedCommand || t.lastFailedCommand.at <= at) t.commandFailures = 0;
  }

  /**
   * The rule for a hook-recorded permission wait (the Claude reporter's toolStarted): the next tool start ends it, as the call's end and
   * the turn's end do. Codex runs PreToolUse for the waiting call before its PermissionRequest, but both hooks run async, so that
   * call's own start can reach the spool on either side of the wait. So the first start of the waiting tool not read before the
   * wait is taken as the call's own and leaves the wait in place; any other start timed after the wait ends it.
   */
  private toolStartEndsWait(t: Thread, tool: string, at: number): void {
    const wait = t.permission;
    if (!wait) return;
    if (!wait.ownStartSeen && tool === wait.tool) wait.ownStartSeen = true;
    else if (at > wait.at) t.permission = null;
  }

  private idle(t: Thread, at: number): void {
    if (at > t.idleAt) t.idleAt = at;
    if (t.permission && t.permission.at <= at) t.permission = null;
    t.hookLoop.open.clear();
    t.fileLoop.open.clear();
  }

  /**
   * One blowout, with the data the server needs to log it (`{ kind, tokensBefore, tokensAfter }`, as the Claude reporter's
   * blowout sends it). No Codex record gives the token counts: the compaction hooks carry none (Codex hook schemas), and a turn
   * that failed on the window carries none either — Codex then fills its token count to the window
   * (`core/src/session/turn.rs:1824-1826`), which is not a measurement — so both stay null.
   */
  private blowout(t: Thread, at: number, key: string, kind: 'auto-compact' | 'window-exceeded'): void {
    t.blowouts++;
    this.event(t, 'blow', `context window exceeded (blowout #${t.blowouts}) ${this.loopLabel(t)}`, at, key, { kind, tokensBefore: null, tokensAfter: null });
  }

  /** An `edit` event for one file: absolute path only, once per call and path. */
  private edit(t: Thread, file: string, at: number, key: string, callId: string): void {
    const base = this.cwdOfThread(t);
    const abs = path.isAbsolute(file) ? path.normalize(file) : base ? path.resolve(base, file) : null;
    if (!abs || abs.length > 1024 || !remember(t.editKeys, `${callId}\u0000${abs}`)) return;
    this.event(t, 'edit', `editing ${path.basename(abs)}`, at, key, { path: abs });
  }

  /**
   * A `message` event for one call of `t` sending another agent a message: `t` the sender, the text the message, `toName`
   * the target as the call names it, and `to` the recipient's agent id (null for the root) when the target is a thread of this
   * session, else left out (then no link is drawn).
   */
  private message(t: Thread, m: SentMessage, at: number, key: string): void {
    const to = this.recipientOf(t, m.target);
    this.event(t, 'message', m.text, at, key, to === undefined ? { toName: m.target } : { to, toName: m.target });
  }

  /**
   * The thread of the sender's session a message target names, as Codex resolves one (`core/src/agent/control/api.rs:40-56`,
   * `control/target.rs:33-43`, `protocol/src/agent_path.rs:59-72`): a thread id, else an agent path — an absolute one as it is,
   * a relative one under the sender's own path (`/root` when it has none). The root's path is `/root`. Its agent id (null for
   * the root), or undefined when no thread the reporter knows in this session matches.
   */
  private recipientOf(sender: Thread, target: string): string | null | undefined {
    const wanted = target.startsWith('/') ? target : `${sender.agentPath ?? '/root'}/${target}`;
    const hit = this.threadsOf(sender.sessionId).find((t) => t.id === target || (this.isChild(t) ? t.agentPath : '/root') === wanted);
    return hit ? (this.isChild(hit) ? hit.id : null) : undefined;
  }

  // ---- activity feed (kept only for watched loops) ------------------------------------------------

  private watching(t: Thread): boolean {
    return this.activityFeed && this.sessionOf(t).watched.includes(this.isChild(t) ? t.id : '@orchestrator');
  }

  /** Whether entries for this thread come from hooks (when it has them) or the session file: one source, never both. */
  private entriesFrom(t: Thread, source: 'hook' | 'file'): boolean {
    return (source === 'hook') === t.hookSeen;
  }

  /**
   * Keeps an entry for a watched loop exactly as a report will send it: redacted and held to the feed's limit whichever source
   * wrote its text (a hook's summary is read back from the spool file, written by whichever hook version ran).
   */
  private activityEntry(t: Thread, e: ActivityEntry): void {
    if (!this.watching(t)) return;
    t.activity.push({ ...e, text: clip(e.text, LIMITS.activity) });
    if (t.activity.length > ACTIVITY_KEPT) t.activity.splice(0, t.activity.length - ACTIVITY_KEPT);
    this.mark(t);
  }

  private finishEntry(t: Thread, id: string | undefined, how: { exitCode?: number; failed?: boolean }): void {
    if (!id) return;
    const e = t.activity.find((x) => x.id === id);
    if (!e) return;
    e.done = true;
    if (how.exitCode !== undefined) e.exitCode = how.exitCode;
    if (how.failed) e.failed = true;
    this.mark(t);
  }

  /** The reply's watch list: entries of a loop no longer watched are forgotten. */
  setWatched(s: Session, watched: string[]): void {
    s.watched = this.activityFeed ? watched : [];
    for (const t of this.threadsOf(s.id)) if (!this.watching(t)) t.activity = [];
  }

  // ---- session files -----------------------------------------------------------------------------

  /** The thread's newest session file. Only a file whose name carries the thread's own id is taken (`rollout-<ts>-<id>….jsonl`). */
  setRollout(t: Thread, file: string): void {
    if (t.rollout?.path === file || !path.isAbsolute(file) || threadOfFile(path.basename(file)) !== t.id) return;
    // A different file for the thread (a revert writes a new one) is read from its start. Usage spans files: the file left is
    // read whole again for records written after its last read, and each response counts once (addUsage).
    if (t.rollout) t.files.delete(t.rollout.path);
    t.rollout = { path: file, tail: file.endsWith('.zst') ? null : new JsonlTail(file), metaSeen: false };
    t.fileLoop = newLoop();
  }

  applyRollout(t: Thread, line: ParsedLine): void {
    const r = line.record;
    const at = line.ts;
    const key = line.key;
    if (r.kind === 'meta') {
      if (!t.rollout || t.rollout.metaSeen || r.id !== t.id) return;
      t.rollout.metaSeen = true;
      this.link(t, r.sessionId ?? r.id, r.parentId);
      if (r.startedAt !== null) t.startedAt = r.startedAt;
      if (r.cwd) t.cwd.file = r.cwd;
      t.nickname ??= r.nickname;
      t.role ??= r.role;
      t.agentPath ??= r.agentPath;
      t.cliVersion = r.cliVersion ?? t.cliVersion;
      t.originator ??= r.originator;
      t.historyMode = r.historyMode ?? t.historyMode;
      this.evidence(t, at, false);
      this.announce(t, at, key);
      return;
    }
    const activity = r.kind !== 'turnContext';
    this.evidence(t, at, activity);
    this.announce(t, at, key);
    switch (r.kind) {
      case 'turnContext':
        if (r.model) t.model.file = r.model;
        if (r.effort) t.effort.file = r.effort;
        if (r.cwd) t.cwd.file = r.cwd;
        break;
      case 'turnStarted':
        this.running(t, at);
        this.turnBoundary(t, at);
        t.turnId = r.turnId;
        if (r.contextWindow !== null) t.contextWindow = r.contextWindow;
        if (t.turnError && t.turnError.at <= at) t.turnError = null;
        break;
      case 'turnEnded':
        this.turnEnded(t, r, at, key);
        break;
      case 'tokens':
        this.tokens(t, r, at);
        break;
      case 'usage':
        this.addUsage(t, r, null);
        break;
      case 'call':
        this.call(t, r, at, key);
        break;
      case 'callOutput': {
        const loop = t.fileLoop;
        const tool = loop.open.get(r.callId);
        if (tool !== undefined) {
          loop.open.delete(r.callId);
          loop.toolCounts.set(tool, (loop.toolCounts.get(tool) ?? 0) + 1);
        }
        if (this.entriesFrom(t, 'file')) this.finishEntry(t, r.callId, {});
        const prompt = t.spawnCalls.get(r.callId);
        if (prompt !== undefined) {
          t.spawnCalls.delete(r.callId);
          if (r.spawnedId) this.spawnedChild(t, r.spawnedId, prompt);
        }
        // Codex returns {"accepted":true} once it shows the questions (request_user_input_async.rs:144-147); anything else is a refusal.
        const asked = t.asyncQuestions.get(r.callId);
        if (asked?.state === 'open' && !r.accepted) asked.state = 'refused';
        break;
      }
      case 'command': {
        // Exit status is known only from these paginated-history items, never from output text.
        const failed = r.status === 'failed' || (r.exitCode !== null && r.exitCode !== 0);
        if (failed) {
          t.commandFailures++;
          t.lastFailedCommand = { at, summary: r.summary, exitCode: r.exitCode };
        } else if (r.status === 'completed') t.commandFailures = 0;
        if (this.entriesFrom(t, 'file') && r.status !== 'declined') {
          const how = { ...(r.exitCode !== null ? { exitCode: r.exitCode } : {}), ...(failed ? { failed: true } : {}) };
          if (!t.activity.some((e) => e.id === r.id)) this.activityEntry(t, { at, kind: 'tool', text: r.summary, id: r.id });
          this.finishEntry(t, r.id, how);
        }
        break;
      }
      case 'fileChange':
        r.paths.forEach((p, i) => this.edit(t, p, at, `${key}.${i}`, r.id || key));
        break;
      case 'spawned':
        for (const child of r.receivers) this.spawnedChild(t, child, r.prompt);
        break;
      case 'message':
        if (r.text) this.activityEntry(t, { at, kind: 'text', text: r.text });
        break;
      case 'questionReply':
        this.questionsReplied(t, r.ids);
        break;
      case 'prompt':
        t.firstPrompt ??= r.text;
        break;
    }
  }

  /**
   * A reply naming async questions, as Codex's TUI resolves them (`tui/src/bottom_pane/async_questions/state.rs:155-191`): an
   * id `JSON.stringify(["request_user_input_async", <call id>, <index>])` answers that one question, and the call is answered
   * once all its questions are; the bare call id (older desktop replies) answers the whole call.
   */
  private questionsReplied(t: Thread, ids: readonly string[]): void {
    for (const id of ids) {
      let callId = id;
      let index: number | null = null;
      try {
        const v: unknown = JSON.parse(id);
        if (Array.isArray(v) && v[0] === 'request_user_input_async' && typeof v[1] === 'string' && Number.isInteger(v[2])) {
          callId = v[1];
          index = v[2] as number;
        }
      } catch {
        // a plain call id
      }
      const q = t.asyncQuestions.get(callId);
      if (q?.state !== 'open') continue;
      if (index !== null) q.replied.add(index);
      if (index === null || q.questions.every((_, i) => q.replied.has(i))) q.state = 'replied';
      this.mark(t);
    }
  }

  private spawnedChild(parent: Thread, childId: string, prompt: string): void {
    const c = this.thread(childId);
    this.link(c, parent.sessionId, parent.id);
    if (prompt && !c.prompt) {
      c.prompt = prompt;
      this.mark(c);
    }
  }

  private call(t: Thread, r: Extract<RolloutRecord, { kind: 'call' }>, at: number, key: string): void {
    const loop = t.fileLoop;
    loop.toolCalls++;
    loop.lastTool = r.name;
    loop.open.set(r.callId, r.name);
    if (this.entriesFrom(t, 'file')) this.activityEntry(t, { at, kind: 'tool', text: r.summary, id: r.callId });
    if (r.spawnPrompt !== null) {
      t.spawnCalls.set(r.callId, r.spawnPrompt);
      if (t.spawnCalls.size > 50) t.spawnCalls.delete(t.spawnCalls.keys().next().value as string);
    }
    r.paths.forEach((p, i) => this.edit(t, p, at, `${key}.${i}`, r.callId));
    if (r.message) this.message(t, r.message, at, key);
    if (r.plan) this.plan(t, r.plan, at, key);
    if (r.questions && !t.asyncQuestions.has(r.callId)) {
      t.asyncQuestions.set(r.callId, { questions: r.questions, at, replied: new Set(), state: 'open' });
      if (t.asyncQuestions.size > 20) t.asyncQuestions.delete(t.asyncQuestions.keys().next().value as string);
      this.mark(t);
    }
  }

  /** The latest `update_plan` call is the plan: snake_case statuses mapped to the Report's step states. */
  private plan(t: Thread, steps: { step: string; status: string }[], at: number, key: string): void {
    const next: PlanStep[] = steps.slice(0, 100).map((s, i) => ({
      id: `plan-${i + 1}`,
      text: clip(s.step.replace(/\s+/g, ' ').trim(), LIMITS.text),
      state: PLAN_STATES[s.status] ?? 'pending',
      activeText: null,
      ownerAgentId: null,
      ownerLabel: null,
    }));
    const was = t.plan ?? [];
    t.plan = next;
    this.mark(t);
    if (this.isChild(t)) return;
    if (!was.length && next.length) this.event(t, 'plan', 'plan started (codex-plan)', at, `${key}.s`);
    next.forEach((s, i) => {
      if (s.state === 'active' && was[i]?.state !== 'active') this.event(t, 'plan', `step started: ${s.text}`, at, `${key}.${i}`);
    });
    if (next.length && next.every((s) => s.state === 'done') && !was.every((s) => s.state === 'done')) {
      this.event(t, 'plan', `plan complete: ${next.length} steps`, at, `${key}.c`);
    }
  }

  private turnEnded(t: Thread, r: Extract<RolloutRecord, { kind: 'turnEnded' }>, at: number, key: string): void {
    this.idle(t, at);
    this.turnBoundary(t, at);
    t.turnId = null;
    // Codex's TUI drops async questions still pending when the live turn ends (tui/src/chatwidget/protocol.rs:478-507).
    for (const q of t.asyncQuestions.values()) if (q.state === 'open') q.state = 'ended';
    if (r.answer) t.answer = r.answer;
    t.turnError = r.failed || r.aborted ? { category: r.errorCategory, failed: r.failed, aborted: r.aborted, at } : null;
    if (r.errorCategory === 'context_window_exceeded') this.blowout(t, at, `${key}.b`, 'window-exceeded');
    if (!this.isChild(t)) {
      // Only a failure with Codex's own `codex_error_info` is an API failure category, which drives the errored state; one
      // without it is still logged as a failure, with no category.
      if (r.errorCategory !== null) this.event(t, 'fail', `orchestrator turn ended with an error (${r.errorCategory})`, at, key, { category: r.errorCategory });
      else if (r.failed) this.event(t, 'fail', 'orchestrator turn ended with an error', at, key);
      return;
    }
    if (at <= t.endEventAt) return;
    t.endEventAt = at;
    const desc = t.prompt || t.nickname || 'agent';
    const status = this.agentStatus(t);
    if (status === 'failed') this.event(t, 'fail', `failed: ${desc} (${this.failureOf(t)?.class ?? 'Unknown'})`, at, key, { class: this.failureOf(t)?.class ?? 'Unknown' });
    else if (status === 'aborted') this.event(t, 'note', `aborted: ${desc}`, at, key);
    else this.event(t, 'done', `finished: ${desc}`, at, key);
  }

  /**
   * One `token_usage_record`: the tokens of one billed model response, completed or not, compactions included (Codex writes one
   * per response, `core/src/session/mod.rs:5066-5150`, `core/src/compact.rs:888`). Each response counts once however often a file
   * holding it is read, and only the thread's own (`thread_id`). Input without cache reads or cache writes (both are parts of
   * Codex's `input_tokens`), cache reads, output, cache writes; tier `long` when the response's input was over LONG_INPUT,
   * else `std`; under `fileModel`, the `turn_context` model in effect in the record's own file, else the thread's. With no model
   * at all the record counts only as a step (`responses`).
   */
  addUsage(t: Thread, r: Extract<RolloutRecord, { kind: 'usage' }>, fileModel: string | null): void {
    if (r.threadId !== t.id || t.responses.has(r.responseId)) return;
    t.responses.add(r.responseId);
    const { input, cached, cacheWrite, output } = r.usage;
    const u: UsageTokens = { input: uncachedInput(input, cached, cacheWrite), cacheRead: cached, output, cacheWrite, cacheWrite1h: 0 };
    const model = fileModel ?? t.model.file ?? t.model.hook ?? t.model.daemon;
    if (model) {
      const tier: ModelUsage['tier'] = input > LONG_INPUT ? 'long' : 'std';
      const key = usageKey(model, tier);
      const was = t.usage.get(key)?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
      t.usage.set(key, { model, tier, tokens: { input: was.input + u.input, output: was.output + u.output, cacheRead: was.cacheRead + u.cacheRead, cacheWrite: was.cacheWrite + u.cacheWrite, cacheWrite1h: 0 } });
    }
    this.mark(t);
  }

  /**
   * Context and plan windows from `token_count`; its usage totals are not read, usage being the records' (addUsage).
   * Context is `last_token_usage.total_tokens` against the model's window. A fill record gives nothing: the last measured context
   * stays, the fill not being a measurement.
   */
  private tokens(t: Thread, r: Extract<RolloutRecord, { kind: 'tokens' }>, at: number): void {
    if (r.window !== null) t.contextWindow = r.window;
    if (r.last && !isWindowFill(r)) {
      const window = t.contextWindow;
      t.context = { tokens: r.last.total, window, percent: window !== null ? contextPercent(r.last.total, window) : null };
    }
    if (r.hasLimits) {
      const limits: RateLimit[] = [];
      if (r.primary) limits.push(rateLimit('primary', r.primary, at));
      if (r.secondary) limits.push(rateLimit('secondary', r.secondary, at));
      if (!t.rateLimits || at >= t.rateLimits.at) t.rateLimits = { at, limits };
    }
    this.mark(t);
  }

  // ---- the daemon --------------------------------------------------------------------------------

  /** A thread as the daemon describes it (`thread/started`, `thread/read`, `thread/resume`). */
  applyDaemonThread(ct: CodexThread, now = Date.now()): Thread {
    const t = this.thread(ct.id, now);
    this.link(t, typeof ct.sessionId === 'string' && ct.sessionId ? ct.sessionId : ct.id, typeof ct.parentThreadId === 'string' ? ct.parentThreadId : null);
    if (typeof ct.ephemeral === 'boolean') t.ephemeral = ct.ephemeral;
    if (typeof ct.cwd === 'string' && ct.cwd) t.cwd.daemon = ct.cwd;
    if (typeof ct.model === 'string' && ct.model) t.model.daemon = ct.model;
    if (typeof ct.reasoningEffort === 'string' && ct.reasoningEffort) t.effort.daemon = ct.reasoningEffort;
    if (typeof ct.name === 'string' && ct.name.trim()) t.name = ct.name.trim();
    if (typeof ct.agentNickname === 'string') t.nickname ??= ct.agentNickname;
    if (typeof ct.agentRole === 'string') t.role ??= ct.agentRole;
    if (typeof ct.cliVersion === 'string') t.cliVersion ??= ct.cliVersion;
    if (ct.historyMode === 'legacy' || ct.historyMode === 'paginated') t.historyMode ??= ct.historyMode;
    if (typeof ct.createdAt === 'number' && t.startedAt === null) t.startedAt = ct.createdAt * 1000;
    if (typeof ct.path === 'string' && ct.path && !t.rollout) this.setRollout(t, ct.path);
    if (ct.status && typeof ct.status === 'object') this.applyDaemonStatus(ct.id, ct.status, now);
    this.mark(t);
    return t;
  }

  /**
   * A status broadcast for a known thread (an unknown one is read first, so a child is never taken for a root). Transitions
   * are also recorded as run/idle evidence, so a thread that unloads keeps a true last state.
   */
  applyDaemonStatus(id: string, status: ThreadStatus, now = Date.now()): void {
    const t = this.threads.get(id);
    if (!t) return;
    const was = t.status;
    t.status = status;
    t.loaded = status.type !== 'notLoaded';
    if (status.type === 'active') this.running(t, now);
    else if (status.type === 'idle' || status.type === 'systemError') {
      if (was?.type === 'active' || t.runAt > t.idleAt) this.idle(t, now);
    }
    // An event records a change seen on the live connection. A status the thread already has when it is first read (at
    // start-up, or after a reconnect, when `was` is null or notLoaded) was logged by the reporter that saw it begin, so reading
    // it again adds no second row (event ids are durable). The key names the fact: the thread and the status it entered.
    if (was && was.type !== 'notLoaded') {
      if (waitsOnApproval(status) && !waitsOnApproval(was)) {
        this.event(t, 'wait', `waiting on you: ${t.permission?.note ?? 'an approval'}`, now, `${t.id}.waitingOnApproval`);
      }
      if (status.type === 'systemError' && was.type !== 'systemError' && !this.isChild(t)) {
        this.event(t, 'fail', 'orchestrator thread hit a system error', now, `${t.id}.systemError`, { category: 'system_error' });
      }
    }
    this.mark(t);
  }

  threadName(id: string, name: string | undefined): void {
    const t = this.threads.get(id);
    if (t && typeof name === 'string' && name.trim()) {
      t.name = name.trim();
      this.mark(t);
    }
  }

  unloaded(id: string): void {
    const t = this.threads.get(id);
    if (!t || !t.loaded) return;
    t.loaded = false;
    t.status = { type: 'notLoaded' };
    this.mark(t);
  }

  /** The daemon connection ended: nothing is known to be loaded any more. */
  daemonGone(): void {
    for (const t of this.threads.values()) if (t.loaded) this.unloaded(t.id);
    this.hooksTrusted = null;
  }

  // ---- derived facts ---------------------------------------------------------------------------------

  /** Answerable through the daemon: loaded there and known not to be ephemeral (an unknown `ephemeral` is not). */
  isDaemonHosted(t: Thread): boolean {
    return t.loaded && t.ephemeral === false;
  }

  /**
   * Hooks, then the session file, then the daemon, loaded or not: the daemon's model is the one it
   * gave at `thread/started`, a read or a rejoin, and `thread/settings/updated` (after `/model`) reaches subscribed clients only.
   */
  modelOf(t: Thread): string | null {
    const m = t.model.hook ?? t.model.file ?? t.model.daemon;
    return m ? clip(m, 120) : null;
  }

  /** The session file's `turn_context`, then the daemon's snapshot (hooks carry no effort). */
  effortOf(t: Thread): string | null {
    const e = t.effort.file ?? t.effort.daemon;
    return e ? clip(e, 120) : null;
  }

  cwdOfThread(t: Thread): string | null {
    return (t.loaded ? t.cwd.daemon : null) ?? t.cwd.hook ?? t.cwd.file ?? t.cwd.daemon;
  }

  cwdOf(s: Session): string | null {
    const root = this.thread(s.id);
    return this.cwdOfThread(root) ?? this.threadsOf(s.id).map((t) => this.cwdOfThread(t)).find((c) => c) ?? null;
  }

  startedAtOf(s: Session): number | null {
    const root = this.thread(s.id);
    return root.startedAt ?? Math.min(...this.threadsOf(s.id).map((t) => t.startedAt ?? t.firstSeenAt));
  }

  /** Hooks over the session file for the loop counters: one source per thread, never a sum. */
  loopOf(t: Thread): Loop {
    return t.hookSeen ? t.hookLoop : t.fileLoop;
  }

  lastActivityOf(t: Thread): number | null {
    return t.lastActivityAt;
  }

  /** Consecutive tool failures where exit status is known (paginated history), else null. */
  toolFailuresOf(t: Thread): number | null {
    return t.historyMode === 'paginated' ? t.commandFailures : null;
  }

  usageOf(threads: readonly Thread[]): ModelUsage[] {
    const out = new Map<string, ModelUsage>();
    for (const t of threads) {
      for (const [key, { model, tier, tokens: u }] of t.usage) {
        const was = out.get(key)?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
        out.set(key, { model, tier, tokens: { input: was.input + u.input, output: was.output + u.output, cacheRead: was.cacheRead + u.cacheRead, cacheWrite: was.cacheWrite + u.cacheWrite, cacheWrite1h: 0 } });
      }
    }
    // Ordered by key: by model, then tier.
    return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
  }

  /** The newest plan windows any thread of the session reported: they are the account's, not the thread's. */
  rateLimitsOf(s: Session): RateLimit[] {
    let best: Thread['rateLimits'] = null;
    for (const t of this.threadsOf(s.id)) if (t.rateLimits && (!best || t.rateLimits.at > best.at)) best = t.rateLimits;
    return best ? best.limits.slice(0, 10) : [];
  }

  /**
   * Where a daemon runs, `hooks/list` says whether our hooks are trusted; without one, whether a hook event has arrived for
   * the thread.
   */
  hooksActive(s: Session): boolean {
    return this.hooksTrusted ?? this.thread(s.id).hookSeen;
  }

  private turnRunning(t: Thread): boolean {
    if (t.loaded && t.status && t.status.type !== 'notLoaded') return t.status.type === 'active';
    return t.runAt > t.idleAt;
  }

  waitingOn(t: Thread): 'approval' | 'input' | null {
    if (t.loaded && t.status && t.status.type !== 'notLoaded') {
      if (t.status.type !== 'active') return null;
      if (t.status.activeFlags.includes('waitingOnApproval')) return 'approval';
      if (t.status.activeFlags.includes('waitingOnUserInput')) return 'input';
      return null;
    }
    return t.permission ? 'approval' : null;
  }

  agentStatus(t: Thread): AgentStatus {
    if (this.turnRunning(t) || (!t.idleAt && !t.turnError)) return 'running';
    if (t.turnError?.failed) return 'failed';
    if (t.turnError?.aborted) return 'aborted';
    return 'done';
  }

  /** A child's failure from its persisted turn end, classed with the protocol's failure classes. */
  failureOf(t: Thread): Failure | null {
    const e = t.turnError;
    if (!e || this.turnRunning(t)) return null;
    const cand = t.lastFailedCommand && e.at - t.lastFailedCommand.at <= LIMITS.candidateMaxAgeMs ? t.lastFailedCommand : null;
    let cls: FailureClass;
    if (e.category === 'context_window_exceeded' || t.blowouts >= 3) cls = 'Context window exhausted';
    else if (e.aborted && !e.failed) cls = 'Aborted';
    else if (e.category !== null && e.category !== 'other') cls = 'Model API error';
    else cls = cand ? 'Tool error' : e.category !== null ? 'Model API error' : 'Unknown';
    const evidence = t.blowouts > 0 ? [`exceeded the context window ${t.blowouts} time${t.blowouts > 1 ? 's' : ''}`] : [];
    if (e.category) evidence.push(`codex error: ${e.category}`);
    const useCand = cls === 'Tool error' && cand;
    return {
      class: cls,
      at: e.at,
      tool: useCand ? 'Shell' : null,
      call: useCand ? clip(cand.summary, LIMITS.call) : null,
      exitCode: useCand ? cand.exitCode : null,
      outputTail: [],
      evidence: evidence.slice(0, 5),
      retriedAs: null,
    };
  }

  /**
   * The status rules (the Claude reporter's withStatus) on Codex facts: done after SessionEnd; waiting on permission
   * while any thread of the session waits on an approval; waiting on input while one waits on a question (the daemon's
   * `waitingOnUserInput`); idle while the root's turn has ended — Stop, Interrupt, `task_complete`, `turn_aborted` or the
   * daemon's idle status — and no child runs, which asks nothing of the owner; otherwise running.
   */
  statusOf(s: Session, notes: ReadonlyMap<string, string> = new Map(), now = Date.now()): SessionState {
    const root = this.thread(s.id);
    if (root.ended) return { status: 'done', waitReason: null, waitNote: null };
    const threads = this.threadsOf(s.id);
    const approval = threads.find((t) => this.waitingOn(t) === 'approval');
    if (approval) return { status: 'waiting', waitReason: 'permission', waitNote: notes.get(approval.id) ?? approval.permission?.note ?? null };
    const input = threads.find((t) => this.waitingOn(t) === 'input');
    if (input) return { status: 'waiting', waitReason: 'input', waitNote: notes.get(input.id) ?? null };
    const childRunning = threads.some((t) => t.id !== s.id && this.agentStatus(t) === 'running' && (t.loaded || now - t.lastEvidenceAt <= LIVE_WINDOW_MS));
    if (!this.turnRunning(root) && !childRunning) return { status: 'waiting', waitReason: 'idle', waitNote: null };
    return { status: 'running', waitReason: null, waitNote: null };
  }

  /**
   * Whether the session is reported: a thread of it is loaded in the daemon, or a hook or session-file event
   * arrived within LIVE_WINDOW_MS (30 minutes), and the root has not ended.
   */
  isLive(s: Session, now = Date.now()): boolean {
    const threads = this.threadsOf(s.id);
    if (this.thread(s.id).ended) return false;
    return threads.some((t) => t.loaded || now - t.lastEvidenceAt <= LIVE_WINDOW_MS);
  }

  /** Forgets threads and sessions with nothing recent and nothing loaded; returns the session ids dropped. */
  forget(now = Date.now()): string[] {
    const dropped: string[] = [];
    for (const s of [...this.sessions.values()]) {
      const threads = this.threadsOf(s.id);
      if (threads.some((t) => t.loaded || now - Math.max(t.lastEvidenceAt, t.firstSeenAt) <= FORGET_AFTER_MS)) continue;
      for (const t of threads) this.threads.delete(t.id);
      this.sessions.delete(s.id);
      dropped.push(s.id);
    }
    return dropped;
  }

  /** The events queued since the last call. */
  drainEvents(s: Session): ActivityEvent[] {
    const out = s.events;
    s.events = [];
    return out;
  }
}
