// The observability rules: stuck, errored and file collisions. Pure functions over what the reporters already send; no I/O here.
import type { CollisionView, ErroredState, ModelFamily, SessionStatusView, SessionView } from './protocol.js';
import type { EditRow } from './db.js';

// ---- stuck ----------------------------------------------------------------------------

/** How long a running loop may be silent before it is stuck, by model family (ms); the Settings page edits them. */
export type StuckThresholds = Record<ModelFamily, number>;

export interface LoopLiveness {
  /** The loop is running now (a live session's own status, or an agent's). */
  running: boolean;
  /** The loop waits on its person. */
  waiting: boolean;
  /** A loop it launched is running: a session waiting on its subagents is not stuck. */
  runningUnder: boolean;
  lastActivityAt: number | null;
  toolOpen: boolean;
  family: ModelFamily;
}

/** Running, not waiting, nothing running under it, and silent longer than its family's threshold, doubled while a tool is open. */
export function isStuck(l: LoopLiveness, now: number, t: StuckThresholds): boolean {
  if (!l.running || l.waiting || l.runningUnder || l.lastActivityAt === null) return false;
  return now - l.lastActivityAt > t[l.family] * (l.toolOpen ? 2 : 1);
}

// ---- errored --------------------------------------------------------------------------

/** Three failed tool calls in a row, or one followed by 60 s of silence. */
export const ERROR_RUN = 3;
export const ERROR_IDLE_MS = 60_000;

export interface ErroredInput {
  status: SessionStatusView;
  waitReason: SessionView['waitReason'];
  /** The newest model API failure still standing (ingest clears it once a later turn runs) and its category. */
  apiErrorAt: number | null;
  apiError: string | null;
  toolFailures: number | null;
  lastActivityAt: number | null;
  /** A tool call of the loop is open now: a later call has started, so the last failure is no longer its last event. */
  toolOpen: boolean;
  lastTool: string | null;
}

/**
 * Why a live (running or waiting) session is errored, or null. An API failure stands until a later turn runs. The tool rules
 * need a known count above zero (never when `toolFailures` is null) and, since a turn's end clears them, a session that is not
 * idle between turns (waiting on anything but a permission prompt). Three or more failures in a row are errored. Fewer are
 * errored only while the session runs with no tool call open and has been silent for ERROR_IDLE_MS since its last activity:
 * that rule fires only while the failure is the loop's last event.
 */
export function erroredState(s: ErroredInput, now: number): ErroredState | null {
  if (s.status !== 'running' && s.status !== 'waiting') return null;
  if (s.apiErrorAt !== null) return { cause: 'api', detail: s.apiError };
  if (s.toolFailures === null || s.toolFailures <= 0) return null;
  // Waiting on anything but a permission prompt is the idle moment between turns (an `idle` turn end among them).
  if (s.status === 'waiting' && s.waitReason !== 'permission') return null;
  if (s.toolFailures >= ERROR_RUN) return { cause: 'tools', detail: s.lastTool };
  const silentAfterFailure = s.status === 'running' && !s.toolOpen && s.lastActivityAt !== null && now - s.lastActivityAt >= ERROR_IDLE_MS;
  if (silentAfterFailure) return { cause: 'tools', detail: s.lastTool };
  return null;
}

// ---- file collisions ------------------------------------------------------------------

/** Two loops editing one file within this window collide. */
export const COLLISION_WINDOW_MS = 5 * 60_000;

const loopKey = (sessionId: string, agentId: string | null): string => `${sessionId}\u0000${agentId ?? ''}`;

/** How a loop is named on a chip: its session's name for a main loop, else the agent's name or type. */
export function loopName(e: Pick<EditRow, 'agent_id' | 'session_name' | 'agent_name' | 'agent_type'>): string {
  return e.agent_id === null ? e.session_name : (e.agent_name ?? e.agent_type ?? 'agent');
}

/** The other loops on the same machine that edited a file this session edited, among `edits` (the last 5 minutes), newest first. */
export function collisionsFor(sessionId: string, machineId: string | null, edits: readonly EditRow[]): CollisionView[] {
  if (machineId === null) return [];
  const same = edits.filter((e) => e.machine_id === machineId && typeof e.path === 'string');
  const out = new Map<string, CollisionView>();
  for (const m of same) {
    if (m.session_id !== sessionId) continue;
    for (const o of same) {
      if (o.path !== m.path || loopKey(o.session_id, o.agent_id) === loopKey(m.session_id, m.agent_id) || Math.abs(o.t - m.t) > COLLISION_WINDOW_MS) continue;
      const key = `${o.path}\u0000${loopKey(o.session_id, o.agent_id)}`;
      const at = Math.max(o.t, m.t);
      const prev = out.get(key);
      if (!prev || prev.at < at) out.set(key, { path: o.path, sessionId: o.session_id, agentId: o.agent_id, name: loopName(o), at });
    }
  }
  return [...out.values()].sort((a, b) => b.at - a.at);
}

/** The newest edit by another loop on the same machine and path within the window of `edit`, or null. */
export function collidingEdit(edit: { sessionId: string; agentId: string | null; t: number; path: string; machineId: string }, edits: readonly EditRow[]): EditRow | null {
  let found: EditRow | null = null;
  for (const o of edits) {
    if (o.machine_id !== edit.machineId || o.path !== edit.path || Math.abs(o.t - edit.t) > COLLISION_WINDOW_MS) continue;
    if (loopKey(o.session_id, o.agent_id) === loopKey(edit.sessionId, edit.agentId)) continue;
    if (!found || o.t > found.t) found = o;
  }
  return found;
}
