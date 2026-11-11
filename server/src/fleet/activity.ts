// The live activity feed: what a watched loop is doing, held in memory under its viewers' leases and never
// stored.
//
// A fetch of GET /sessions/:id/agents/:agentId/activity takes a lease on that loop, and the viewer's next fetch renews it. Each
// report's reply lists the loops under a live lease (`watch`), and a reporter sends a loop's entries only while it is listed.
// A lease keeps its loop's newest LIMITS.activityEntries entries and lets them go when it lapses, when the session leaves the
// live set or is deleted, and on restart. Nothing from before a lease began is taken, so a viewer who comes back starts empty.
// No call output is ever taken: the contract has no field for it.
//
// With the server's `activityFeed` setting off the feed is off: no lease is granted, `watch` stays empty, and what a reporter
// sends is dropped. The setting can change while the server runs; turning it off drops every lease.
import { LIMITS, MAIN_LOOP, type ActivityEntry, type Report } from './protocol.js';

/** The panel's refresh choices, in seconds, its default first. */
const EVERY_CHOICES: readonly number[] = [5, 10, 20, 30, 60];
/** A lease outlives its viewer's interval by this much, so one late or missed fetch, or a report cycle or two, keeps it. */
const LEASE_GRACE_MS = 15_000;

/**
 * An entry as the activity route serves it. `seq` numbers a lease's entries in the order the server took them. A `dashboard`
 * entry is an answer, message or command sent from the dashboard, added by the server with its sender and an optional note.
 */
export interface ActivityEntryView {
  kind: ActivityEntry['kind'] | 'dashboard';
  seq: number;
  text: string;
  at: number;
  /** A tool call's id and command, as the reporter sent them. */
  id?: string;
  command?: string;
  commandCut?: boolean;
  /** How a tool call ended, as far as the reporter has said. */
  done?: boolean;
  failed?: boolean;
  exitCode?: number;
  /** A dashboard entry's sender and note ("(queued until the session is idle)"). */
  by?: string;
  note?: string | null;
}

/** The activity route's body. */
export interface ActivityReply {
  /** The server's clock when it answered. */
  serverTime: number;
  /** The server's `activityFeed` setting. */
  enabled: boolean;
  /** Whether the session is in the live set. */
  live: boolean;
  /** When the viewer's lease began; null while the session is not live or the feed is off. */
  since: number | null;
  /** What the lease holds, oldest first. */
  entries: ActivityEntryView[];
}

/** An entry under a lease; a dashboard entry also keeps its delivery's id (`ref`), so a later result can find it. */
type Held = ActivityEntryView & { ref?: string };

/** One loop's lease: when it began and when it lapses, and the entries taken since, numbered as they came. */
interface Lease {
  since: number;
  until: number;
  entries: Held[];
  taken: number;
}

/** Adds an entry under the lease's next number. */
function append(lease: Lease, entry: Omit<Held, 'seq'>): void {
  lease.taken += 1;
  lease.entries.push({ seq: lease.taken, ...entry });
}

/** Lets a lease's oldest entries go until LIMITS.activityEntries are left. */
function trim(lease: Lease): void {
  lease.entries.splice(0, Math.max(0, lease.entries.length - LIMITS.activityEntries));
}

/** An entry as the route serves it, without the delivery id a dashboard entry keeps. */
function served(held: Held): ActivityEntryView {
  const { ref, ...entry } = held;
  void ref;
  return entry;
}

/** The refresh interval a request names, in seconds, when it is one of the panel's choices; otherwise the panel's default. */
export const everyOf = (v: unknown): number => {
  const asked = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Number.NaN;
  return EVERY_CHOICES.includes(asked) ? asked : EVERY_CHOICES[0]!;
};

/** A dashboard delivery's line on a loop's feed: when it was sent, what it says, who sent it, and its note. */
export type DashboardLine = { at: number; text: string; by: string; note: string | null };

/** One session's leases, by loop: an agent id, or MAIN_LOOP for the orchestrator. */
type Loops = Map<string, Lease>;

export class ActivityStore {
  /** The leases held, by session; a session with none left has no entry. */
  private readonly leases = new Map<string, Loops>();
  /** The activityFeed option each session's reporter last reported. */
  private readonly reporterOption = new Map<string, boolean>();

  /** `on` is the server's `activityFeed` setting; the fleet sets it again when the setting changes. */
  constructor(
    private readonly now: () => number,
    public on = true,
  ) {}

  /** Takes or renews a viewer's lease on one loop, and returns what it holds. */
  watch(sessionId: string, loop: string, everySeconds: number): Pick<ActivityReply, 'entries' | 'since'> {
    const now = this.now();
    const loops: Loops = this.liveLeases(sessionId, now) ?? new Map();
    this.leases.set(sessionId, loops);
    let lease = loops.get(loop);
    if (!lease) loops.set(loop, (lease = { since: now, until: now, entries: [], taken: 0 }));
    // Renewing only ever extends: a slower viewer of the same loop keeps the time it was given.
    const until = now + everySeconds * 1000 + LEASE_GRACE_MS;
    if (until > lease.until) lease.until = until;
    return { entries: lease.entries.map(served), since: lease.since };
  }

  /** The loops of a session under a live lease: the report reply's `watch`. */
  watched(sessionId: string): string[] {
    return this.on ? [...(this.liveLeases(sessionId, this.now())?.keys() ?? [])] : [];
  }

  /** The reporter's activityFeed option for a session; null until a report since the server started has said. */
  feedOn(sessionId: string): boolean | null {
    return this.reporterOption.get(sessionId) ?? null;
  }

  /**
   * A validated report's entries for the session `sessionId` (its id on the server), taken for the loops under a live lease.
   * `skewMs` (the report's `sentAt` less the server's clock) puts an entry's time on the server's clock, to compare with when the
   * lease began.
   */
  ingest(sessionId: string, report: Report, skewMs: number): void {
    const { session } = report;
    if (typeof session.activityFeed === 'boolean') this.reporterOption.set(sessionId, session.activityFeed);
    if (!this.on || !this.leases.has(sessionId)) return;
    const loops = this.liveLeases(sessionId, this.now());
    // The orchestrator's entries first, then each agent's, in the report's order.
    const snapshots: [string, ActivityEntry[] | undefined][] = [[MAIN_LOOP, session.activity], ...report.agents.map((a): [string, ActivityEntry[] | undefined] => [a.id, a.activity])];
    for (const [loop, snapshot] of snapshots) {
      const lease = loops?.get(loop);
      if (lease && snapshot?.length) takeSnapshot(lease, snapshot, skewMs);
    }
  }

  /** A dashboard answer, message or command, as an entry of the loop it is about; kept only while someone watches that loop. */
  addDashboard(sessionId: string, loop: string, ref: string, e: DashboardLine): void {
    const lease = this.on ? this.leases.get(sessionId)?.get(loop) : undefined;
    if (!lease) return;
    append(lease, { at: e.at, kind: 'dashboard', text: e.text.slice(0, LIMITS.activityText), by: e.by, note: e.note, ref });
    trim(lease);
  }

  /** Every lease a session holds now; none when it holds none. */
  private leasesOf(sessionId: string): Lease[] {
    return Array.from(this.leases.get(sessionId)?.values() ?? []);
  }

  /** The entries standing for one dashboard delivery (`ref`), in every lease of the session. */
  private dashboardEntries(sessionId: string, ref: string): Held[] {
    return this.leasesOf(sessionId).flatMap((lease) => lease.entries.filter((entry) => entry.ref === ref));
  }

  /** A dashboard entry's note changed (queued, then taken). */
  updateDashboard(sessionId: string, ref: string, note: string | null): void {
    for (const entry of this.dashboardEntries(sessionId, ref)) entry.note = note;
  }

  /** The session never took what a dashboard entry stands for (discarded, refused, or its ask closed first): the entry goes. */
  removeDashboard(sessionId: string, ref: string): void {
    for (const lease of this.leasesOf(sessionId)) {
      const gone = lease.entries.find((entry) => entry.ref === ref);
      if (gone) lease.entries.splice(lease.entries.indexOf(gone), 1);
    }
  }

  /** The sweeper's call, every second: every lapsed lease goes. */
  expire(): void {
    const now = this.now();
    [...this.leases.keys()].forEach((sessionId) => this.liveLeases(sessionId, now));
  }

  /** Turning the feed off: every lease goes, with all it holds. */
  clear(): void {
    this.leases.clear();
  }

  /** A session that left the live set or was deleted: its leases go, and what its reporter said of the feed. */
  dropSession(sessionId: string): void {
    for (const held of [this.leases, this.reporterOption]) held.delete(sessionId);
  }

  /** A session's leases once the lapsed ones are gone; the session's entry goes with its last lease. */
  private liveLeases(sessionId: string, now: number): Loops | undefined {
    const loops = this.leases.get(sessionId);
    if (!loops) return undefined;
    for (const [loop, lease] of [...loops]) if (lease.until < now) loops.delete(loop);
    if (loops.size > 0) return loops;
    this.leases.delete(sessionId);
    return undefined;
  }
}

/** Takes what is new in a reporter's snapshot of a loop (its newest entries, oldest first), then keeps the newest. */
function takeSnapshot(lease: Lease, snapshot: readonly ActivityEntry[], skewMs: number): void {
  for (const e of snapshot) {
    const held = e.id === undefined ? undefined : lease.entries.find((x) => x.id === e.id && x.kind === e.kind);
    if (held) {
      // The same call again: it takes what the reporter has learnt since (its status, and its command when the first sending
      // had none), and keeps its place and number.
      if (held.command === undefined) Object.assign(held, commandOf(e));
      Object.assign(held, statusOf(e));
    } else if (belongs(lease, e, skewMs)) {
      append(lease, { at: e.at, kind: e.kind, text: e.text, ...(e.id === undefined ? {} : { id: e.id }), ...commandOf(e), ...statusOf(e) });
    }
  }
  trim(lease);
}

/**
 * Whether an entry the lease does not hold belongs in it: not from before the lease began (on the server's clock), not older
 * than the newest reporter entry held, and not a repeat of one held at that same moment. Dashboard entries carry the server's
 * time, not the reporter's, so only the reporter's own entries are compared.
 */
function belongs(lease: Lease, e: ActivityEntry, skewMs: number): boolean {
  if (e.at - skewMs < lease.since) return false;
  const own = lease.entries.filter((x) => x.kind !== 'dashboard');
  const newest = own.length === 0 ? undefined : own[own.length - 1]!; // not Array#at: the frontend checks this file against ES2021
  if (newest === undefined || e.at > newest.at) return true;
  return e.at === newest.at && !own.some((x) => x.at === e.at && x.kind === e.kind && x.text === e.text);
}

/** A tool entry's command, cut to the contract's limit and marked when its reporter cut it; nothing for any other entry. */
function commandOf({ kind, command, commandCut }: ActivityEntry): Pick<ActivityEntryView, 'command' | 'commandCut'> {
  if (kind !== 'tool' || typeof command !== 'string') return {};
  const kept = command.slice(0, LIMITS.activityDetail);
  return commandCut === true ? { command: kept, commandCut: true } : { command: kept };
}

/** How a tool call ended, as far as the reporter has said; nothing for another kind of entry. */
function statusOf(e: ActivityEntry): Pick<ActivityEntryView, 'done' | 'exitCode' | 'failed'> {
  if (e.kind !== 'tool') return {};
  return { ...(e.done === true ? { done: true } : {}), ...(typeof e.exitCode === 'number' ? { exitCode: e.exitCode } : {}), ...(e.failed === true ? { failed: true } : {}) };
}
