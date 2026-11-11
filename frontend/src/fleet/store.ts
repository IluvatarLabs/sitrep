// The fleet as the console holds it, and the pure reducer that folds each stream message into it: one handler per message.
import type { ActivityView, Kpis, LifecycleConfig, MachineView, RemovedReason, ServerSettings, SessionView, StateBody } from "./types";

export interface FleetState {
  /** The stream: before its first snapshot, delivering, or lost and being reopened. */
  phase: "loading" | "live" | "disconnected";
  /**
   * The server requires a sign-in to view (Settings' Require sign-in to view) and this browser has none: it refused a read with
   * `401 sign-in required`. Nothing the server sent before is kept, and nothing is read again until the next try (useFleet).
   */
  gated: boolean;
  /** Why the first load failed; cleared by the next message. */
  error: string | null;
  /** Every live session by id. */
  sessions: Record<string, SessionView>;
  /** Sessions that left, and why: their activity rows are greyed and inert. */
  gone: Record<string, RemovedReason>;
  /** Newest first, each id once, at most EVENT_CAP. */
  events: ActivityView[];
  machines: MachineView[];
  kpis: Kpis | null;
  serverTime: number;
  server: StateBody["server"] | null;
  config: LifecycleConfig;
  /** The server's answering and activity feed switches; off until the first snapshot. */
  settings: ServerSettings;
}

export type Phase = FleetState["phase"];

/** Activity events held in memory at most. */
export const EVENT_CAP = 150;

/** The server's timers until its first snapshot says otherwise. */
export const DEFAULT_LIFECYCLE: LifecycleConfig = { removeAfterMs: 75_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };

export const initialState: Readonly<FleetState> = {
  phase: "loading",
  gated: false,
  error: null,
  sessions: {},
  gone: {},
  events: [],
  machines: [],
  kpis: null,
  serverTime: 0,
  server: null,
  config: DEFAULT_LIFECYCLE,
  settings: { respond: false, activityFeed: false },
};

/** Each message the reducer takes, by its type: the server's stream events, and the page's own (a lost stream, a failed first
 * load, the view gate's refusal and a new try after it). */
interface Messages {
  snapshot: { body: StateBody };
  tick: { serverTime: number; kpis: Kpis; machines?: MachineView[] };
  session: { view: SessionView };
  removed: { sessionId: string; reason: RemovedReason };
  activity: { event: ActivityView };
  disconnected: Record<never, never>;
  error: { message: string };
  gated: { on: boolean };
}

export type FleetAction = { [K in keyof Messages]: { type: K } & Messages[K] }[keyof Messages];

/** The record without `key`; the same object when it has none, so nothing redraws for it. */
function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!Object.hasOwn(rec, key)) return rec;
  const rest = { ...rec };
  delete rest[key];
  return rest;
}

/** Events newest first, each id once, cut at EVENT_CAP. */
function newestFirst(events: readonly ActivityView[]): ActivityView[] {
  const byId = new Map<string, ActivityView>();
  for (const e of [...events].sort((a, b) => b.t - a.t)) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].slice(0, EVENT_CAP);
}

/**
 * The sessions a snapshot leaves out that the page knew of (held, gone, or named by the snapshot's events): they left while
 * the page was away. One already gone keeps its reason; the rest ended.
 */
function goneSince(was: FleetState, live: Record<string, SessionView>, events: readonly ActivityView[]): Record<string, RemovedReason> {
  const known = new Set([...Object.keys(was.sessions), ...Object.keys(was.gone), ...events.map((e) => e.sessionId)]);
  return Object.fromEntries([...known].filter((id) => !Object.hasOwn(live, id)).map((id) => [id, Object.hasOwn(was.gone, id) ? was.gone[id]! : "done"]));
}

type Handler<K extends keyof Messages> = (s: FleetState, m: Messages[K]) => FleetState;

/** Any message from the server means the stream is live again. */
const live = (s: FleetState): FleetState => (s.phase === "live" && s.error === null ? s : { ...s, phase: "live", error: null });

const HANDLERS: { [K in keyof Messages]: Handler<K> } = {
  snapshot(s, { body }) {
    const sessions = Object.fromEntries(body.sessions.map((v) => [v.id, v]));
    return {
      ...live(s),
      sessions,
      gone: goneSince(s, sessions, body.events),
      events: newestFirst(body.events),
      machines: body.machines,
      kpis: body.kpis,
      serverTime: body.serverTime,
      server: body.server,
      config: body.config,
      settings: body.settings,
    };
  },
  tick: (s, m) => ({ ...live(s), serverTime: m.serverTime, kpis: m.kpis, machines: m.machines ?? s.machines }),
  session: (s, { view }) => ({ ...live(s), sessions: { ...s.sessions, [view.id]: view }, gone: omit(s.gone, view.id) }),
  removed: (s, { sessionId, reason }) => ({ ...live(s), sessions: omit(s.sessions, sessionId), gone: { ...s.gone, [sessionId]: reason } }),
  activity: (s, { event }) => (s.events.some((e) => e.id === event.id) ? live(s) : { ...live(s), events: newestFirst([event, ...s.events]) }),
  // The page's own messages touch only the connection.
  disconnected: (s) => (s.phase === "disconnected" ? s : { ...s, phase: "disconnected" }),
  error: (s, { message }) => ({ ...s, error: message }),
  // Refused by the view gate: everything the server sent goes, so nothing of it can show or be counted behind the gate. A new
  // try starts from nothing too, loading.
  gated: (s, { on }) => (s.gated === on ? s : { ...initialState, gated: on }),
};

export function fleetReducer(s: FleetState, action: FleetAction): FleetState {
  const handle = HANDLERS[action.type] as Handler<keyof Messages>;
  return handle(s, action as never);
}
