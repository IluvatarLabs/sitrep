// The fleet service. It owns the live set, turns reports and the timers' sweeps into SSE messages, answers the reads, and
// holds the live server settings. Storage is FleetDb; the rules are in ingest.ts, derive.ts and alerts.ts. The clock is
// injected, so lifecycle tests move time without waiting.
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { EditRow, EventFilter, EventRow, FleetDb, SessionRow } from './db.js';
import { activityView, computeKpis, costParts, costReasonOf, family, firstMinuteSecond, fromJson, isUnused, lastCompleteSecond, MESSAGE_LIMIT, MESSAGE_WINDOW_MS, messageView, nameOf, projectOf, providerOf, SERIES_POINTS, sessionView, wholeSeconds, type DeriveConfig } from './derive.js';
import { COLLISION_WINDOW_MS, collidingEdit, collisionsFor, loopName } from './alerts.js';
import { addDays, localDay } from './days.js';
import { REPORTER_SUPPORT, checkReporter, serverBuild, serverVersion, supportFor } from './compat.js';
import { ingestReport, ingestRequests, type IngestResult } from './ingest.js';
import type { ApiRequest } from './telemetry.js';
import { machineNote, machineState, machineViews } from './machines.js';
import type { Pricing } from './pricing.js';
import { ActivityStore } from './activity.js';
import { RespondStore } from './respond.js';
import { BUILT_IN, patched, settingsFromEnv, storedPatch, type SettingsChange, type SettingsPatch } from './settings.js';
import { SseHub } from './sse.js';
import { LIMITS } from './protocol.js';
import type { ActivityView, EditableSettings, HistoryRow, Kpis, MachineState, MachineView, PriceRowView, RemovedReason, Report, SessionView, StateBody } from './protocol.js';
import { silentLogger, type Logger } from '../logger.js';

export interface FleetConfig {
  /** What each editable setting is when the owner has not changed it: `server.env`, else the built-in value. */
  defaults: EditableSettings;
  /** The server user's home directory, written as `~` in paths. */
  home: string;
  /** The shortest gap between two `session` broadcasts of one session. */
  throttleMs: number;
  dbPath: string;
}

/** The built-in settings and a 500 ms broadcast throttle; tests add a home and a database. */
export const DEFAULT_CONFIG: Omit<FleetConfig, 'home' | 'dbPath'> = { defaults: BUILT_IN, throttleMs: 500 };

/**
 * The fleet's configuration at start: the built-in parts, `base`, and each setting's default from `server.env`, where a bad value
 * stops the server.
 */
export const configFromEnv = (env: NodeJS.ProcessEnv, base: Pick<FleetConfig, 'home' | 'dbPath'>): FleetConfig => ({ ...DEFAULT_CONFIG, ...base, defaults: settingsFromEnv(env) });

/** The newest events a snapshot carries: as many as the UI keeps. */
export const STATE_EVENTS = 150;
/**
 * At most this many reporters are remembered for the "connected" log line, files for the once-per-window collision note, unpriced
 * models, and models with their rates.
 */
const MAX_REPORTERS = 1000;
const MAX_COLLIDED = 2000;
const MAX_UNPRICED = 200;
const MAX_RATES = 1000;
/** The settings key that holds the owner's changes to the server settings, and the one that holds each model's rates. */
const SETTINGS_KEY = 'server_settings';
const PRICES_KEY = 'spend_prices';

/** What the fleet holds in memory for a session on the wall, or about to be. */
interface LiveSession {
  /** Its last report's clock skew (the report's sentAt less the server's time), for /health; null before one. */
  skewMs: number | null;
}

/** When a session left: dropped, else ended, else last seen. */
const leftAt = (row: SessionRow): number => row.dropped_at ?? row.ended_at ?? row.last_seen_at;

/** The text of the `end` event the server writes when a session leaves the live set. */
const END_TEXT = { done: 'session ended', dropped: 'heartbeat lost' } as const;

/** Sets `key` as the newest entry of a map kept in the order keys were last set, forgets the oldest past `cap`, and returns the value it had. */
function setNewest<V>(map: Map<string, V>, key: string, value: V, cap: number): V | undefined {
  const had = map.get(key);
  map.delete(key);
  map.set(key, value);
  if (map.size > cap) map.delete(map.keys().next().value!);
  return had;
}

export class Fleet {
  readonly hub = new SseHub();
  /** The live activity feed: in memory only, and only for loops someone watches. */
  readonly activity: ActivityStore;
  /** Answering: asks, answers and messages, in memory only. */
  readonly respond: RespondStore;
  /** When this process started: a machine last heard before it reads "Not since restart". */
  readonly startedAt: number;
  /** The settings in force: the defaults with the owner's stored changes over them. */
  settings: EditableSettings;
  /** The owner's changes, as stored. */
  private changes: SettingsPatch;
  /** The live set: each session on the wall, or about to be, by server id. */
  private readonly live = new Map<string, LiveSession>();
  /** The `session` broadcast each session has waiting out its throttle. */
  private readonly pending = new Map<string, NodeJS.Timeout>();
  /** When each reporter (machine and reporter name) last reported. */
  private readonly reporterHeardAt = new Map<string, number>();
  /** When each file (machine and path) last raised a collision note, so one window raises one. */
  private readonly collided = new Map<string, number>();
  /** Models seen in reports since start that no price row matches. */
  private readonly unpriced = new Set<string>();
  /** Each model's rates as this start prices it, by model, kept in settings (PRICES_KEY) for the next start to compare. */
  private readonly rates: Map<string, string>;

  constructor(
    readonly db: FleetDb,
    readonly cfg: FleetConfig,
    readonly pricing: Pricing,
    readonly now: () => number = Date.now,
    readonly logger: Logger = silentLogger,
  ) {
    this.startedAt = now();
    this.changes = this.storedChanges();
    this.settings = patched(cfg.defaults, this.changes);
    this.activity = new ActivityStore(now, this.settings.activityFeed);
    this.respond = new RespondStore(now, (sid) => this.scheduleSession(sid), this.activity);
    // At start every stored session that has not ended is live again in its last stored state, its silence counted from the start
    // (`sweepSession`); a done one still inside its linger stays until the linger is over.
    for (const row of db.openSessions(this.startedAt - this.settings.lifecycle.lingerMs)) this.live.set(row.id, { skewMs: null });
    this.rates = this.restartMovedPrices();
  }

  /** A model's rates as the price table gives them now, compared as text; `null` for a model it does not price. */
  private rateOf(model: string): string {
    const row = this.pricing.rowFor(model);
    return JSON.stringify(row ? [row.std, row.long ?? null] : null);
  }

  /**
   * A change of a model's prices moves the figure of every session on it at once, up or down, and none of that is spend: the
   * record starts each such session again from its next figure. Only sessions whose usage names a model whose rates moved
   * since the last start, or that the last start did not record, restart; labels do not count. A record kept before rates were
   * kept per model (a list of rows) restarts every session once. Returns the rates now, by model.
   */
  private restartMovedPrices(): Map<string, string> {
    const stored = fromJson<unknown>(this.db.getSetting(PRICES_KEY));
    const was = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? new Map(Object.entries(stored as Record<string, unknown>)) : null;
    const rates = new Map(this.db.modelIds().map((m) => [m, this.rateOf(m)]));
    if (was === null) {
      this.db.restartSpendCounts();
      this.logger.info('sitrep: spend marks restarted: the record held no prices by model yet');
    } else {
      const moved = [...rates].filter(([m, rate]) => was.get(m) !== rate).map(([m]) => m);
      const restarted = moved.length > 0 ? this.db.restartSpendCountsFor(moved) : 0;
      if (restarted > 0) this.logger.info(`sitrep: spend marks restarted for ${String(restarted)} sessions: prices moved for ${moved.join(', ')}`);
    }
    this.db.setSetting(PRICES_KEY, JSON.stringify(Object.fromEntries(rates)));
    return rates;
  }

  // ---- settings --------------------------------------------------------------------------

  /** The owner's stored changes; one that no longer reads as a change is left out alone, with a log line naming it. */
  private storedChanges(): SettingsPatch {
    const { patch, dropped } = storedPatch(fromJson<unknown>(this.db.getSetting(SETTINGS_KEY)) ?? {});
    for (const why of dropped) this.logger.warn(`sitrep: stored setting ignored (${why}); its default applies`);
    return patch;
  }

  /**
   * Takes a checked change: stores it over the earlier ones (a null drops one) and puts the result in force at once. Turning
   * the feed or answering off drops what they hold, and every open page gets a new snapshot. Turning
   * on the sign-in to view ends every open stream instead, so each opens again through the sign-in check.
   */
  changeSettings(change: SettingsChange): EditableSettings {
    const was = this.settings;
    this.changes = patched(this.changes, change);
    this.db.setSetting(SETTINGS_KEY, JSON.stringify(this.changes));
    this.settings = patched(this.cfg.defaults, this.changes);
    const turnedOff = (s: 'respond' | 'activityFeed'): boolean => was[s] && !this.settings[s];
    this.activity.on = this.settings.activityFeed;
    if (turnedOff('activityFeed')) this.activity.clear();
    // Answering needs both switches, so either one going off drops every ask, answer, message and command held.
    if (turnedOff('respond') || turnedOff('activityFeed')) this.respond.clear();
    if (!was.requireSignInToView && this.settings.requireSignInToView) this.hub.closeAll();
    else this.hub.broadcast('snapshot', this.state());
    return this.settings;
  }

  /** Whether the server's settings let anyone answer: `respond` and `activityFeed` both on. Signing in is the routes' check. */
  respondFlagsOn(): boolean {
    return this.settings.respond && this.settings.activityFeed;
  }

  private get derive(): DeriveConfig {
    return { home: this.cfg.home, stuck: this.settings.stuckAfterMs };
  }

  /** Models seen since start that no price row matches, sorted. */
  unpricedModels(): string[] {
    return [...this.unpriced].sort();
  }

  // ---- the live set -----------------------------------------------------------------------------

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  /**
   * The live sessions on the wall, leaving out those that have done nothing and an ended one still lingering: the count the report
   * reply and /health give.
   */
  visibleCount(): number {
    return [...this.live.keys()].map((id) => this.db.getSession(id)).filter((row) => row?.status !== 'done' && !this.unused(row)).length;
  }

  /**
   * A stored session that has done nothing yet stays off the wall and out of every feed (`isUnused`); an open ask is the owner
   * being waited on, so a session with one is shown. A live session found shown once is stored as shown and stays shown:
   * its card never goes and comes back, and it keeps its History and Activity rows after it leaves and across restarts. Its agents
   * and asks are read last, only when everything else says unused.
   */
  private unused(row?: SessionRow): boolean {
    if (row === undefined || row.shown === 1) return false;
    const asksAllClosed = (id: string): boolean => this.respond.summaries(id).every((a) => a.state === 'closed');
    const unused = isUnused(row, () => this.db.countAgents(row.id)) && asksAllClosed(row.id);
    if (!unused && this.live.has(row.id)) this.db.setShown(row.id);
    return unused;
  }

  // ---- reports ----------------------------------------------------------------------------------

  /** Stores one report under the session's server id (sessionKey), notes its machine, and tells the browsers what changed. */
  ingest(report: Report, owner?: string | null): IngestResult {
    const now = this.now();
    this.db.noteMachine(machineNote(report, now));
    this.noteReporter(report, now);
    const res = ingestReport(this.db, report, now, owner ?? null, this.pricing);
    const { sessionId: sid, clockSkewMs } = res;
    this.activity.ingest(sid, report, clockSkewMs);
    this.respond.noteReport(sid, report, this.respondFlagsOn());
    const { session, agents } = report;
    this.notePrices([session.model, ...(session.usageByModel ?? []).map((u) => u.model), ...agents.flatMap((a) => [a.model, ...(a.usageByModel ?? []).map((u) => u.model)])]);
    const collisions = this.noteCollisions(report.machine.id, res.newEvents);
    const row = this.db.getSession(sid);
    const entry = this.live.get(sid);
    if (entry) entry.skewMs = clockSkewMs;
    else if (!(res.ended && res.wasDone)) {
      // New, revived, or back after leaving the live set. A repeated final report of a session that already left is stored
      // but does not bring it back.
      this.live.set(sid, { skewMs: clockSkewMs });
      this.logger.debug(`sitrep: session ${sid} ${res.created ? 'started' : 'is reporting again'}`);
    }
    if (res.ended && !res.wasDone) this.logger.debug(`sitrep: session ${sid} ended${row?.end_reason ? ` (${row.end_reason})` : ''}`);
    if (!this.unused(row)) {
      // An `edit` event is the collision signal, not an activity row; the collision note it raises is one.
      const shown = [...res.newEvents.filter((e) => e.kind !== 'edit'), ...collisions].sort((a, b) => a.t - b.t);
      for (const e of shown) this.hub.broadcast('activity', activityView(e, row));
    }
    this.scheduleSession(sid);
    return res;
  }

  /**
   * Stores a batch of Claude Code's API requests from one machine (`ingestRequests`), notes their models, and broadcasts each
   * live session they changed.
   */
  ingestRequests(machineId: string, requests: readonly ApiRequest[]): void {
    if (requests.length === 0) return;
    for (const sid of ingestRequests(this.db, machineId, requests, this.now(), this.pricing)) this.scheduleSession(sid);
    this.notePrices(requests.map((r) => r.usage.model));
  }

  /**
   * Notes each model a report or request names: one no price row matches, and one this start has no rates recorded for, so the next
   * start can tell whether its prices moved (restartMovedPrices).
   */
  private notePrices(models: readonly (string | null)[]): void {
    let added = false;
    for (const m of models) {
      if (!m) continue;
      if (this.unpriced.size < MAX_UNPRICED && this.pricing.rowFor(m) === null) this.unpriced.add(m);
      if (!this.rates.has(m) && this.rates.size < MAX_RATES) {
        this.rates.set(m, this.rateOf(m));
        added = true;
      }
    }
    if (added) this.db.setSetting(PRICES_KEY, JSON.stringify(Object.fromEntries(this.rates)));
  }

  /** The price rows of every model the stored sessions and agents name, for Settings. */
  priceRows(): PriceRowView[] {
    return this.pricing.rowsFor(this.db.modelIds());
  }

  /**
   * File collisions: a new `edit` event on an absolute path that another loop on the same machine edited within
   * 5 minutes adds one `note` event, written by the server, to this session, at most once per file per window; both cards get
   * the chip at their next view.
   */
  private noteCollisions(machineId: string, newEvents: readonly EventRow[]): EventRow[] {
    const notes: EventRow[] = [];
    for (const e of newEvents) {
      const file = e.kind === 'edit' ? fromJson<{ path?: unknown }>(e.data_json)?.path : undefined;
      if (typeof file !== 'string') continue;
      const other = collidingEdit({ sessionId: e.session_id, agentId: e.agent_id, t: e.t, path: file, machineId }, this.db.editsSince(e.t - COLLISION_WINDOW_MS));
      if (!other) continue;
      this.scheduleSession(other.session_id);
      const key = `${machineId}\u0000${file}`;
      const last = this.collided.get(key);
      if (last !== undefined && Math.abs(e.t - last) <= COLLISION_WINDOW_MS) continue;
      setNewest(this.collided, key, e.t, MAX_COLLIDED);
      const note: EventRow = {
        id: `${e.id}:collision`,
        session_id: e.session_id,
        agent_id: e.agent_id,
        t: e.t,
        kind: 'note',
        text: `Also edited by ${loopName(other)}: ${path.posix.basename(file)}`.slice(0, LIMITS.text),
        data_json: JSON.stringify({ kind: 'collision', path: file, sessionId: other.session_id, agentId: other.agent_id }),
      };
      if (this.db.insertEvent(note)) notes.push(note);
    }
    return notes;
  }

  /** A log line the first time a reporter is heard, and again when it comes back after going quiet. */
  private noteReporter(report: Report, now: number): void {
    const { name, version } = report.reporter;
    const heardAt = setNewest(this.reporterHeardAt, `${report.machine.id}\u0000${name}`, now, MAX_REPORTERS);
    if (heardAt !== undefined && now - heardAt <= this.settings.lifecycle.removeAfterMs) return;
    const compat = checkReporter(version, supportFor(name));
    this.logger.info(`sitrep: ${name} ${version} connected from ${report.machine.name}${compat === 'ok' ? '' : ` (${compat})`}`);
  }

  /** One `session` broadcast per live session per throttle window, built when the window closes so it carries every change made in it. */
  private scheduleSession(id: string): void {
    if (!this.live.has(id) || this.pending.has(id)) return;
    const timer = setTimeout(() => this.broadcastSession(id), this.cfg.throttleMs);
    timer.unref?.();
    this.pending.set(id, timer);
  }

  /** The throttled broadcast, for a session still live and on the wall. */
  private broadcastSession(id: string): void {
    this.pending.delete(id);
    const view = this.view(id);
    if (!this.live.has(id) || !view || this.unused(this.db.getSession(id))) return;
    this.hub.broadcast('session', view);
  }

  // ---- reads ------------------------------------------------------------------------------------

  /** The collision window's `edit` events, read once for a batch of views. */
  private recentEdits(): EditRow[] {
    return this.db.editsSince(this.now() - COLLISION_WINDOW_MS);
  }

  /** One session's view, live or from History. */
  view(id: string): SessionView | undefined {
    const row = this.db.getSession(id);
    return row && this.viewOf(row, this.recentEdits());
  }

  private viewOf(row: SessionRow, edits: readonly EditRow[]): SessionView {
    const now = this.now();
    const { id } = row;
    const hideAt = row.attached === 0 && row.detached_at !== null ? row.detached_at + this.settings.lifecycle.detachedHideAfterMs : null;
    const input = {
      row,
      hideAt,
      pricing: this.pricing,
      agents: this.db.getAgents(id),
      blowouts: this.db.getBlowouts(id),
      // The charts' points, and the second before them; the output tokens of each minute of the last half hour.
      samples: this.db.samplesFrom(id, lastCompleteSecond(now) - SERIES_POINTS),
      minutes: this.db.sessionTokensPerMinute(id, firstMinuteSecond(now), lastCompleteSecond(now)),
      collisions: collisionsFor(id, row.machine_id, edits),
      // The window's newest messages, oldest first.
      messages: this.db.messagesSince(id, now - MESSAGE_WINDOW_MS, MESSAGE_LIMIT).reverse().map(messageView),
      activityFeed: this.activity.feedOn(id),
      respond: this.respond.takes(id),
      asks: this.respond.summaries(id),
    };
    return sessionView(input, now, this.derive);
  }

  liveViews(): SessionView[] {
    const edits = this.recentEdits();
    const views: SessionView[] = [];
    for (const id of this.live.keys()) {
      const row = this.db.getSession(id);
      if (row && !this.unused(row)) views.push(this.viewOf(row, edits));
    }
    return views;
  }

  /**
   * The KPIs over `views`, the live ones unless given. The spend record and the last hour of samples are read afresh each time, so
   * every report shows: a year of machines by models by days reads in about 13 ms, an hour of a busy day's samples in about 25 ms.
   */
  kpis(views?: readonly SessionView[]): Kpis {
    const now = this.now();
    const today = localDay(now);
    const hourStart = (Math.floor(now / 60_000) - SERIES_POINTS + 1) * 60;
    return computeKpis(
      {
        views: views ?? this.liveViews(),
        spend: this.db.spendRecord(today, addDays(today, -6)),
        tokensPerSecond: this.db.fleetTokensPerSecond(lastCompleteSecond(now) - SERIES_POINTS),
        costPerMinute: this.db.fleetCostPerMinute(hourStart),
      },
      now,
    );
  }

  machines(views: readonly SessionView[] = this.liveViews()): MachineView[] {
    return machineViews(this.db.listMachines(), views, this.now(), this.startedAt);
  }

  /** At most `limit` stored events, newest first, leaving out those of sessions that have done nothing. */
  events(limit: number, filter: EventFilter = {}): ActivityView[] {
    // Each session's row is read once, however many of its events are listed.
    const rows = new Map<string, SessionRow | undefined>();
    const sessionOf = (id: string): SessionRow | undefined => {
      if (!rows.has(id)) rows.set(id, this.db.getSession(id));
      return rows.get(id);
    };
    return this.db.listEvents(limit, filter).flatMap((e) => {
      const session = sessionOf(e.session_id);
      return this.unused(session) ? [] : [activityView(e, session)];
    });
  }

  /**
   * One page of the sessions that ended or were dropped in [from, to), newest first, and how many there are in all; only those of
   * `machines` when it names any.
   */
  historyPage(from: number, to: number, page: number, pageSize: number, machines: readonly string[] = []): { rows: HistoryRow[]; total: number; page: number } {
    const onMachine = (row: SessionRow): boolean => machines.length === 0 || machines.includes(row.machine_id ?? '');
    const left = this.db.leftBetween(from, to).filter((row) => onMachine(row) && !this.unused(row));
    left.sort((a, b) => leftAt(b) - leftAt(a) || (a.id < b.id ? -1 : 1));
    const lastPage = Math.max(1, Math.ceil(left.length / pageSize));
    const shown = Math.min(page, lastPage);
    return { rows: left.slice((shown - 1) * pageSize, shown * pageSize).map((row) => this.historyOf(row)), total: left.length, page: shown };
  }

  /** A session that has left, as History lists it. */
  private historyOf(row: SessionRow): HistoryRow {
    const agents = this.db.getAgents(row.id);
    const endedAt = leftAt(row);
    const agentBlowouts = agents.reduce((n, a) => n + (a.blowouts ?? 0), 0);
    const cost = costParts(this.pricing, row);
    return {
      id: row.id,
      nativeId: row.native_id,
      name: nameOf(row),
      provider: providerOf(row),
      model: row.model,
      modelFamily: family(row.model),
      project: projectOf(row, this.cfg.home),
      startedAt: row.started_at,
      endedAt,
      durationSec: Math.max(0, Math.round((endedAt - row.started_at) / 1000)),
      endReason: row.dropped_at === null ? row.end_reason : END_TEXT.dropped,
      costUsd: cost.usd,
      costPartial: cost.partial,
      costReason: costReasonOf(this.pricing, row.model, cost.usd),
      agents: agents.length,
      // Unknown when the session's own count is; otherwise the counts that are known.
      blowouts: row.blowouts === null ? null : row.blowouts + agentBlowouts,
      clearedFrom: row.cleared_from,
      clearedInto: this.db.clearedInto(row.id),
    };
  }

  state(): StateBody {
    const sessions = this.liveViews();
    const { respond, activityFeed, lifecycle } = this.settings;
    return {
      serverTime: this.now(),
      server: { version: serverVersion(), build: serverBuild(), reporterSupport: { ...REPORTER_SUPPORT } },
      config: { ...lifecycle },
      settings: { respond, activityFeed },
      sessions,
      kpis: this.kpis(sessions),
      machines: this.machines(sessions),
      events: this.events(STATE_EVENTS),
    };
  }

  health() {
    const skews = [...this.live.values()].map((entry) => Math.abs(entry.skewMs ?? 0));
    return {
      ok: true as const,
      serverVersion: serverVersion(),
      serverBuild: serverBuild(),
      reporterSupport: REPORTER_SUPPORT,
      reporterVersionsSeen: this.db.reporterVersions(),
      dbPath: this.cfg.dbPath,
      uptimeSec: wholeSeconds(this.now() - this.startedAt),
      liveSessions: this.visibleCount(),
      sseClients: this.hub.size,
      maxClockSkewMs: Math.max(0, ...skews),
    };
  }

  // ---- the owner's changes ----------------------------------------------------------------------

  /** Deletes a session and its rows; a live one leaves every open browser. Whether it existed. */
  deleteSession(id: string): boolean {
    const wasLive = this.live.delete(id);
    this.forget(id);
    const deleted = this.db.deleteSession(id);
    if (wasLive) this.removed(id, 'deleted');
    if (deleted) this.logger.debug(`sitrep: session ${id} deleted`);
    return deleted;
  }

  /** Tells every open browser a session left the live set, and why. */
  private removed(sessionId: string, reason: RemovedReason): void {
    this.hub.broadcast('removed', { sessionId, reason });
  }

  /** Sets or clears (null) a session's display name; a live one is broadcast again. False when there is no such session. */
  rename(id: string, name: string | null): boolean {
    if (!this.db.setDisplayName(id, name)) return false;
    this.scheduleSession(id);
    return true;
  }

  /** Each stored machine with its state now. */
  private machineStates(): { id: string; state: MachineState }[] {
    const now = this.now();
    return this.db.listMachines().map((m) => ({ id: m.id, state: machineState(m.last_report_at, now, this.startedAt) }));
  }

  /** A stored machine's state now; undefined when no machine is stored under `id`. */
  machineStateOf(id: string): MachineState | undefined {
    return this.machineStates().find((m) => m.id === id)?.state;
  }

  /** Takes off the Machines page each stored machine `which` picks; one that reports again comes back. The ids removed. */
  removeMachines(which: (m: { id: string; state: MachineState }) => boolean): string[] {
    return this.machineStates().flatMap((m) => (which(m) && this.db.deleteMachine(m.id) ? [m.id] : []));
  }

  /** Writes a consistent copy of the database into a new file beside it and returns its path; the caller deletes it. */
  backup(): string {
    const dir = this.cfg.dbPath === ':memory:' ? '.' : path.dirname(this.cfg.dbPath);
    const file = path.join(dir, `backup-${String(this.now())}-${randomBytes(4).toString('hex')}.sqlite`);
    try {
      this.db.backupTo(file);
    } catch (err) {
      rmSync(file, { force: true });
      throw err;
    }
    return file;
  }

  /** What the server holds in memory for a session leaving the live set. */
  private forget(id: string): void {
    this.activity.dropSession(id);
    this.respond.dropSession(id);
    clearTimeout(this.pending.get(id));
    this.pending.delete(id);
  }

  private leave(row: SessionRow, reason: 'done' | 'dropped'): void {
    const now = this.now();
    if (reason === 'dropped') {
      this.logger.info(`sitrep: session ${row.id} ended: heartbeat lost (silent ${Math.round((now - row.last_seen_at) / 1000)} s)`);
      this.db.setDropped(row.id, now);
    }
    // Asked while it is still live, so a session once shown keeps its line.
    const shown = !this.unused(row);
    this.live.delete(row.id);
    this.respond.endSession(row.id);
    this.forget(row.id);
    // Timed as History times the end: an ended session when it ended, not when its linger let it go; a dropped one now.
    const marker = reason === 'done' ? (row.ended_at ?? now) : row.last_seen_at;
    const end: EventRow = { id: `${row.id}:server:end:${reason}:${String(marker)}`, session_id: row.id, agent_id: null, t: reason === 'done' ? marker : now, kind: 'end', text: END_TEXT[reason], data_json: JSON.stringify({ reason }) };
    // A session that never reached the wall gets no activity line as it goes. 'removed' is always sent: a card shown while the
    // session ran must still go when it ends with no usage.
    if (this.db.insertEvent(end) && shown) this.hub.broadcast('activity', activityView(end, row));
    this.removed(row.id, reason);
  }

  // ---- timers (sweeper.ts runs them) ------------------------------------------------------------

  /**
   * Every second: lapsed leases and old closed asks go; an ended session leaves once its linger is over; one unheard from for
   * `removeAfterMs` leaves (heartbeat lost); every other live session gets its carried sample.
   */
  sweep(): void {
    this.activity.expire();
    this.respond.expire();
    const now = this.now();
    for (const id of [...this.live.keys()]) this.sweepSession(id, now);
  }

  private sweepSession(id: string, now: number): void {
    const row = this.db.getSession(id);
    if (!row) return void this.live.delete(id);
    const { removeAfterMs, lingerMs } = this.settings.lifecycle;
    if (row.status === 'done') {
      if (now - (row.ended_at ?? now) >= lingerMs) this.leave(row, 'done');
      return;
    }
    // Silent too long, counted from no earlier than this start: it leaves. Still live: its chart gets this second's point.
    if (now - Math.max(row.last_seen_at, this.startedAt) >= removeAfterMs) return this.leave(row, 'dropped');
    this.carrySample(row, Math.floor(now / 1000));
  }

  /**
   * A live session that reports less than once a second still gets a sample every second, so its charts do not drop to zero
   * between reports: its last sample again with no new tokens and no spend.
   */
  private carrySample(row: SessionRow, nowSec: number): void {
    const last = this.db.newestSample(row.id);
    if (!last || last.t >= nowSec) return;
    this.db.insertSampleIfAbsent({ ...last, t: nowSec, tokens_delta: 0, output_delta: 0, spend_usd: 0 });
  }

  /** Every 2 s: the KPIs and the machines to every client; it doubles as the keepalive. */
  tick(): void {
    const views = this.liveViews();
    this.hub.broadcast('tick', { serverTime: this.now(), kpis: this.kpis(views), machines: this.machines(views) });
  }

  /** Hourly: retention, with the retention settings in force. */
  retain(): { samples: number; events: number; sessions: number; machines: number } {
    return this.db.retain(this.now(), this.settings.retention);
  }

  close(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.hub.closeAll();
  }
}
