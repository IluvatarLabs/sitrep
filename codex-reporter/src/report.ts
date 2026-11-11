// Thread state -> Report, and the text rules every free-text field passes through first: redaction, excerpts and
// call summaries. Nothing leaves the machine unredacted or longer than its limit.
import path from 'node:path';
import { redact as redactNarrow, redactFreeText } from '../plugin/hooks/redact.mjs';
import type { Fleet, Loop, Session, Thread } from './mapping.js';
import {
  reporterOf,
  type ActivityEvent,
  type AgentReport,
  type Ask,
  type MachineInfo,
  type ModelUsage,
  type Report,
  type RespondInfo,
} from '../../server/src/fleet/protocol.js';

export const LIMITS = {
  call: 300,
  line: 240,
  excerpt: 400,
  text: 240,
  activity: 300,
  /** How recent a failed command must be, when its thread's turn fails, to be shown as that failure's call. */
  candidateMaxAgeMs: 60_000,
} as const;

// ---- redaction and excerpts --------------------------------------------------------------------

// ANSI escape sequences and control characters other than tab and line feed: never shown in the activity feed.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * `text` with escape sequences blanked, every secret-shaped run masked, and the value after a secret-looking key masked: the
 * narrow rules (plugin/hooks/redact.mjs `redact`), for names, ids, paths and ask input, which must stay readable as written.
 */
export const redact = (text: string): string => redactNarrow(text.replace(ANSI, ' '));

/** `text` redacted and held to `max` characters. */
export const clip = (text: string, max: number): string => redact(text).slice(0, max);

/** Characters of a text read before redaction (the mod's CLIP_RAW, the hook's oneLine), so a huge one costs bounded work. */
const CLIP_RAW = 4000;

/**
 * `text` cut to CLIP_RAW characters; a cut one loses its last, partial token (its final run of non-whitespace), so a secret
 * cut in half is never shown in part. Matched from the start, which is linear where `/\S+$/` is quadratic on a long run.
 */
function rawCut(text: string): string {
  return text.length > CLIP_RAW ? (/^[\s\S]*\s/.exec(text.slice(0, CLIP_RAW))?.[0] ?? '') : text;
}

/**
 * Display text taken from a command or a tool's free-text argument (a wait note `Shell(…)`, a shell call's summary, a
 * message to another agent), cut to CLIP_RAW, redacted with the broader rules too (plugin/hooks/redact.mjs
 * `redactFreeText`) and held to `max` characters.
 */
export function clipFreeText(text: string, max: number): string {
  return redactFreeText(rawCut(text).replace(ANSI, ' ')).slice(0, max);
}

/** Whitespace collapsed first, then cut (rawCut), so redaction sees whole what an entry can show. */
const flatten = (text: string): string => rawCut(text.replace(/\s+/g, ' ').trim());

/** The first 400 characters with whitespace collapsed, redacted; empty for no text. */
export const excerpt = (text: string | null | undefined, max: number = LIMITS.excerpt): string => (text ? clip(flatten(String(text)), max) : '');

/**
 * A session name taken from a prompt: whitespace folded and trimmed, redacted with the free-text rules (clipFreeText), held to
 * `max`, as the Claude reporter names a session after its first prompt (mod/claude-reporter/hooks/register.ts noteFirstPrompt).
 * Empty for no text.
 */
export const promptName = (text: string | null, max: number): string => (text ? clipFreeText(text.replace(/\s+/g, ' ').trim(), max).trim() : '');

/** One activity-feed entry for the text a model request wrote: whitespace collapsed, redacted, cut to 300 characters. */
export const activityText = (text: string): string => clip(flatten(text), LIMITS.activity);

/**
 * The one argument that keeps the narrow rules, by tool, as the mod's PATH_TOOLS list (failures.ts clipCall): Codex's built-in
 * tools whose shown argument is a path or a name (`view_image`, view_image_spec.rs:18; a spawned agent's type). Every other
 * argument of every other tool, whatever its name or namespace (an MCP tool among them), is free text.
 */
const NARROW_ARG: ReadonlyMap<string, string> = new Map([['view_image', 'path'], ['spawn_agent', 'agent_type']]);

/**
 * A one-line summary of a tool call, as the activity feed shows one: the tool's name, a space, and its main argument — a
 * shell call's command, a file tool's path, otherwise its first argument. Redacted, whitespace collapsed, cut to 300
 * characters.
 */
export function summarizeCall(tool: string, args: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : (JSON.stringify(v) ?? ''));
  const own = NARROW_ARG.get(tool);
  const key = own !== undefined && args[own] != null ? own : ['command', 'cmd', 'file_path', 'path'].find((k) => args[k] != null);
  const first = key === undefined ? Object.values(args)[0] : args[key];
  // The tool's name and the argument NARROW_ARG names keep the narrow rules; any other argument is free text and gets the
  // broader rules too. Redacted apart, so no rule spans the two.
  const narrow = own !== undefined && key === own;
  const name = clip(tool, LIMITS.call - 1);
  const arg = flatten(s(first));
  return arg ? `${name} ${(narrow ? clip : clipFreeText)(arg, LIMITS.call - name.length - 1)}` : name;
}

// ---- display name ---------------------------------------------------------------------------------

/** A path's last part (`feature/x` → `x`, `/a/b/` → `b`); the path itself when it has none (`/`). */
export const lastSegment = (p: string): string => path.posix.basename(p) || p;

/**
 * The display-name chain with Codex's own name first: `threadName` (Codex's name for the thread: the daemon's
 * `Thread.name`, else the newest in its session index, else its first prompt — buildReport), a worktree's branch or folder,
 * the project folder, then `session-<first 6 of id>`. Codex's own thread list shows the name, else the thread's preview,
 * "usually the first user message" (`tui/src/resume_picker.rs:1016-1017`, `app-server-protocol/src/protocol/v2/thread_data.rs:222-223`).
 * Codex has no per-session name option.
 */
export function displayName(id: string, threadName: string | null, s: Pick<Session, 'git' | 'projectRoot'>): string {
  const named = (v: string | null | undefined) => v?.trim() || null;
  const tail = (p: string | null | undefined) => named(p && lastSegment(p));
  const git = s.git;
  const worktree = git?.isWorktree ? (tail(git.detached ? null : git.branch) ?? tail(git.worktreePath)) : null;
  return clip(named(threadName) ?? worktree ?? tail(s.projectRoot) ?? `session-${id.slice(0, 6)}`, 80);
}

// ---- the report ----------------------------------------------------------------------------------

/**
 * What one report carries at most: agents (the newest), activity-feed characters (the orchestrator's first, then the agents'),
 * usage rows, asks and events.
 */
const MOST = { agents: 200, activityChars: 60_000, usageRows: 40, asks: 8, events: 100 } as const;

export interface ReportMeta {
  version: string;
  daemonVersion: string | null;
  machine: MachineInfo;
  activityFeed: boolean;
  respond: RespondInfo;
  /** The asks open now; sent only while the last reply said `respond: true`. */
  asks: Ask[] | null;
  /** What each waiting thread waits on, from the request the reporter holds (`Shell(…)`, a secret question's SECRET_NOTE). */
  notes: ReadonlyMap<string, string>;
  /** Codex's own thread names by thread id, from its session index (sessionFiles threadNames). */
  names: ReadonlyMap<string, string>;
  /**
   * Every file of the session has been read once (main.ts usageReady). Until then usage is left out, unknown, since the server
   * books each rise of a session's priced usage as spend.
   */
  usageReady: boolean;
  now: number;
}

/** Usage per model for `threads`, as the report sends it: the first rows, model ids cut to 120. */
const usage = (fleet: Fleet, threads: readonly Thread[]): ModelUsage[] =>
  fleet.usageOf(threads).slice(0, MOST.usageRows).map((r) => ({ ...r, model: clip(r.model, 120) }));

/** Calls per tool as the report's plain object: built with fromEntries, so every name is an own key, `__proto__` included. */
const toolCounts = (loop: Loop): Record<string, number> => Object.fromEntries([...loop.toolCounts].map(([tool, n]) => [clip(tool, 120), n]));

function agentReport(fleet: Fleet, session: Session, t: Thread, hooksActive: boolean, usageReady: boolean): AgentReport {
  const loop = fleet.loopOf(t);
  const status = fleet.agentStatus(t);
  const watched = fleet.activityFeed && session.watched.includes(t.id);
  return {
    id: clip(t.id, 200),
    parentId: t.parentId && t.parentId !== session.id ? t.parentId : null,
    kind: 'subagent',
    type: clip(t.role ?? t.agentType ?? 'agent', 120),
    name: t.nickname ? clip(t.nickname, 80) : null,
    description: clip(t.prompt, LIMITS.text),
    model: fleet.modelOf(t),
    effort: fleet.effortOf(t),
    effortSource: fleet.effortOf(t) ? 'observed' : 'unknown',
    status,
    startedAt: t.startedAt ?? t.firstSeenAt,
    endedAt: status === 'running' || status === 'queued' ? null : t.idleAt || null,
    context: t.context ?? { tokens: null, window: null, percent: null },
    costUsdEst: null,
    // Left out, unknown, until the session's files have been read and while the thread has no file.
    ...(usageReady && t.rollout ? { usageByModel: usage(fleet, [t]) } : {}),
    skills: [],
    lastTool: loop.lastTool ? clip(loop.lastTool, 120) : null,
    toolCalls: loop.toolCalls,
    toolCounts: toolCounts(loop),
    blowouts: hooksActive ? t.blowouts : null,
    toolFailures: fleet.toolFailuresOf(t),
    steps: { done: t.responses.size, total: null },
    promptExcerpt: t.prompt,
    answerExcerpt: t.answer,
    ...(watched && t.activity.length ? { activity: t.activity } : {}),
    failure: fleet.failureOf(t),
    lastActivityAt: t.lastActivityAt,
    toolOpen: loop.open.size > 0,
  };
}

/**
 * Keeps each whole feed that still fits the report's activity budget and leaves out each one that does not, in the order the
 * server reads them: the orchestrator's first, then every agent's.
 */
function capActivity(r: Report): void {
  let spent = 0;
  for (const holder of [r.session, ...r.agents]) {
    const size = holder.activity?.reduce((chars, e) => chars + e.text.length, 0) ?? 0;
    if (spent + size > MOST.activityChars) delete holder.activity;
    else spent += size;
  }
}

/** A full snapshot of one Codex session (its root thread and every child thread) plus the events given (at most 100). */
export function buildReport(fleet: Fleet, session: Session, events: readonly ActivityEvent[], meta: ReportMeta): Report {
  const root = fleet.thread(session.id);
  const threads = fleet.threadsOf(session.id);
  const children = threads.filter((t) => t.id !== session.id).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).slice(-MOST.agents);
  const hooksActive = fleet.hooksActive(session);
  const state = fleet.statusOf(session, meta.notes, meta.now);
  const loop = fleet.loopOf(root);
  const watched = meta.activityFeed && session.watched.includes('@orchestrator');
  const report: Report = {
    v: 1,
    sentAt: meta.now,
    provider: 'codex',
    reporter: {
      name: reporterOf('codex'),
      version: meta.version,
      engineVersion: fleet.isDaemonHosted(root) ? meta.daemonVersion : root.cliVersion,
      hostSurface: root.originator,
      ...(meta.daemonVersion ? { daemonVersion: meta.daemonVersion } : {}),
    },
    machine: meta.machine,
    session: {
      id: session.id,
      name: displayName(session.id, root.name ?? meta.names.get(session.id) ?? root.firstPrompt, session),
      status: state.status,
      waitReason: state.status === 'waiting' ? state.waitReason : null,
      waitNote: state.status === 'waiting' && state.waitNote ? clip(state.waitNote, 160) : null,
      endReason: state.status === 'done' ? 'other' : null,
      resumeId: session.id,
      startedAt: fleet.startedAtOf(session) ?? meta.now,
      // Empty while no source has given one: unknown, never a made-up folder.
      cwd: fleet.cwdOf(session) ?? '',
      projectRoot: session.projectRoot,
      repoName: session.repoName,
      git: session.git,
      model: fleet.modelOf(root),
      effort: fleet.effortOf(root),
      context: root.context ?? { tokens: null, window: null, percent: null },
      costUsd: null,
      // Left out, unknown, until every file of the session has been read and while it has none.
      ...(meta.usageReady && threads.some((t) => t.rollout) ? { usageByModel: usage(fleet, threads) } : {}),
      rateLimits: fleet.rateLimitsOf(session),
      blowouts: hooksActive ? root.blowouts : null,
      toolFailures: fleet.toolFailuresOf(root),
      hooksActive,
      plan: root.plan ? { title: null, source: 'codex-plan', steps: root.plan } : null,
      loop: {
        skills: [],
        lastTool: loop.lastTool ? clip(loop.lastTool, 120) : null,
        toolCalls: loop.toolCalls,
        toolCounts: toolCounts(loop),
        steps: { done: root.responses.size, total: null },
      },
      files: session.files,
      attached: null,
      activityFeed: meta.activityFeed,
      ...(watched && root.activity.length ? { activity: root.activity } : {}),
      respond: meta.respond,
      ...(meta.asks && { asks: meta.asks.slice(0, MOST.asks) }),
      lastActivityAt: fleet.lastActivityOf(root),
      toolOpen: loop.open.size > 0,
    },
    agents: children.map((t) => agentReport(fleet, session, t, hooksActive, meta.usageReady)),
    events: events.slice(0, MOST.events).map((e) => ({ ...e, text: clip(e.text, LIMITS.text) })),
  };
  capActivity(report);
  return report;
}
