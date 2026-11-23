// Getting reports to the server. Hooks only queue events and the flush timer calls `send`, so no hook ever waits on the
// network. At most 500 events are held (past that the oldest are dropped), one POST is out at a time, the server
// acknowledges events by count, and while it cannot be reached the next try waits 1 s, 2 s, 5 s, then 10 s. The record's
// rows have a queue of their own beside it, which the hooks fill directly: at most 500 held (past that the oldest go, never
// those of the POST in flight, and one gap row counts them), sent only once a reply says the server keeps a record, at most
// LIMITS.rows and LIMITS.rowTextChars of text a report, each row's text redacted once, as the report that first carries it is
// built, and acknowledged by count as events are (codex-reporter/src/transport.ts does the same). Nothing goes for a session id
// after its last report, so that report counts the rows it cannot carry on the gap row and carries it (codex-reporter instead
// sends an ended session's final report again until its rows are taken).
import type { HttpInit, HttpResponse } from 'claude-code';
import { withoutControls } from './activityDetail.ts';
import { withBuild } from './build.ts';
import { redactFreeText } from './failures.ts';
import { trimTrailingSlashes } from './machine.ts';
import { LIMITS, TOKEN_HEADER, type ActivityEvent, type Delivery, type Report, type ReportReply, type ReporterCompat, type ReporterSupport, type TraceRow } from './protocol.ts';

/** The waits before the 1st, 2nd, 3rd and every later retry while the server cannot be reached. */
const RETRY_WAITS_MS = [1000, 2000, 5000, 10_000] as const;
/** After the server refuses the token nothing changes until the settings do, so the next try waits a minute. */
const REFUSED_WAIT_MS = 60_000;
const QUEUE_MAX = 500;
const EVENTS_PER_REPORT = 100;
/** The most messages and commands taken from one reply. */
const MAX_DELIVERIES = 20;
/** A watch list longer than a report's agents plus the main loop is not taken whole. */
const MAX_WATCHED = 201;
const LOOPBACK_V4 = /^127(\.\d{1,3}){3}$/;

/** The wait before retry number `tries` (counted from 1); past the table it stays at the last step. */
export const retryWaitMs = (tries: number): number => RETRY_WAITS_MS[Math.min(Math.max(tries, 1), RETRY_WAITS_MS.length) - 1]!;

/** A delivery as the server sends it. Only its shape is checked here; what it may do is the mod's to decide. */
export const isDelivery = (v: unknown): v is Delivery => {
  const d = (typeof v === 'object' && v !== null ? v : {}) as Partial<Record<keyof Delivery, unknown>>;
  return typeof d.id === 'string' && typeof d.kind === 'string' && typeof d.by === 'string' && typeof d.at === 'number';
};

/** Whether the server URL is plain `http:` to another machine, so the token it carries is not encrypted in transit. */
function overPlainHttp(serverUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return url.protocol === 'http:' && host !== 'localhost' && host !== '::1' && !LOOPBACK_V4.test(host);
}

/** How the transport calls the server: the engine's `$.http.fetch`, of whose answer it reads the status and the text. */
type Fetch = (url: string, init: HttpInit) => Promise<Pick<HttpResponse, 'status' | 'ok' | 'text'>>;

export interface TransportConfig {
  /** This reporter's version, passed in so the transport imports nothing of the mod's. */
  version: string;
  serverUrl: string;
  /** The server's admin secret; empty when it has none. */
  token: string;
  heartbeatMs: number;
}

/** A version's major and minor as one number that sorts as they do; null when it has none. */
function minorRank(version: string): number | null {
  const found = /^(\d+)\.(\d+)(?:\.|$)/.exec(version);
  return found ? Number(found[1]) * 1e6 + Number(found[2]) : null;
}

/** How one `send` went: taken, refused for its token, rejected as a report, not delivered, or not tried while one is out. */
export type PostOutcome = 'ok' | 'refused' | 'rejected' | 'failed' | 'busy';

/** Request headers for a reporter call: JSON, and the token when one is set. */
export const headersFor = (token: string): Record<string, string> => ({ 'Content-Type': 'application/json', ...(token ? { [TOKEN_HEADER]: token } : {}) });

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export class Transport {
  readonly cfg: TransportConfig;
  readonly url: string;
  private readonly fetch: Fetch;
  private readonly log: (line: string) => void;

  /** Events waiting to go, oldest first, and how many were dropped because it was full. */
  queue: ActivityEvent[] = [];
  dropped = 0;
  /** Whether the last attempt reached the server; null before the first. */
  online: boolean | null = null;
  /** Set when the server turns the token down (401); cleared only once it reads a report again, taken or rejected as one. */
  refused = false;
  inFlight = false;
  lastSentAt = 0;
  nextAttemptAt = 0;
  lastError: string | null = null;
  /** Attempts in a row that reached no usable answer, for the backoff. */
  failures = 0;
  sent = 0;
  failed = 0;
  rejected = 0;

  // What the last accepted reply said.
  serverVersion: string | null = null;
  serverBuild: string | null = null;
  /** Where the server places this reporter's version; null until a reply places it. */
  compat: Exclude<ReporterCompat, 'unknown'> | null = null;
  support: ReporterSupport | null = null;
  liveSessions: number | null = null;
  /** Whether the server takes answers for this session. */
  respond = false;
  /** The messages and commands it handed over. */
  deliveries: Delivery[] = [];
  /** The loops a viewer watches. */
  watch: string[] = [];
  /** Whether the server keeps a record: null until a reply says (rows are queued and none goes), then its reply's `trace` (an older server says nothing: false). */
  trace: boolean | null = null;
  /** The record's rows waiting to go, oldest first. */
  rows: TraceRow[] = [];
  /** The one gap row standing for the rows dropped since the server last took one, sent first; null when none. */
  gap: TraceRow | null = null;

  /** How many rows at the head of `rows` the POST in flight carries: they are never dropped from under it. */
  private flying = 0;
  /** Queued rows whose text is redacted already. */
  private readonly redacted = new WeakSet<TraceRow>();
  private posting: Promise<PostOutcome> | null = null;
  private rejectStreak = 0;
  private loggedReject = false;
  private loggedRefusal = false;

  constructor(fetch: Fetch, cfg: TransportConfig, log: (line: string) => void = () => {}) {
    this.fetch = fetch;
    this.cfg = cfg;
    this.log = log;
    this.url = `${trimTrailingSlashes(cfg.serverUrl)}/api/fleet/report`;
  }

  /** Adds events to the queue; once it holds more than QUEUE_MAX, the oldest go and are counted. */
  queueEvents(events: readonly ActivityEvent[]): void {
    this.queue.push(...events);
    const over = this.queue.length - QUEUE_MAX;
    if (over <= 0) return;
    this.queue.splice(0, over);
    this.dropped += over;
  }

  /** Queues a row of the record unless the server said it keeps none. Past QUEUE_MAX the oldest go (never those of the POST in flight), and the gap row counts them. */
  queueRow(row: TraceRow): void {
    if (this.trace === false) return;
    this.rows.push(row);
    if (this.rows.length > QUEUE_MAX) this.lose(this.rows.splice(this.flying, this.rows.length - QUEUE_MAX));
  }

  /**
   * Rows that will never reach the server, counted on the one gap row. It grows as a new object under its id, so one sent and
   * in flight is sent again with the larger count, which the server takes in its place; its t0 is the first dropped row's.
   */
  private lose(dropped: readonly TraceRow[]): void {
    const first = dropped[0];
    if (first === undefined) return;
    const g = this.gap;
    this.gap = { id: g?.id ?? `gap:${crypto.randomUUID()}`, kind: 'gap', agentId: null, t0: g?.t0 ?? first.t0, t1: null, count: (g?.count ?? 0) + dropped.length };
  }

  /**
   * The queued rows the next report carries, oldest first: at most `max`, with at most LIMITS.rowTextChars of text between them,
   * so a row whose text does not fit waits for the next report (the first always goes). Each row's text is redacted here, as
   * the report is built and never in a hook: the free-text rules, after control characters are taken out (as a command's are).
   * The redacted row takes the raw one's place, so a report that did not land never redacts it again.
   */
  private nextRows(max: number): TraceRow[] {
    const batch: TraceRow[] = [];
    let chars = 0;
    for (let i = 0; i < this.rows.length && batch.length < max; i++) {
      let row = this.rows[i]!;
      if (row.text && !this.redacted.has(row)) {
        row = { ...row, text: Object.fromEntries(Object.entries(row.text).map(([part, t = '']) => [part, redactFreeText(withoutControls(t))])) };
        this.redacted.add(row);
        this.rows[i] = row;
      }
      const n = Object.values(row.text ?? {}).reduce((sum, t) => sum + (t?.length ?? 0), 0);
      if (batch.length > 0 && chars + n > LIMITS.rowTextChars) break;
      chars += n;
      batch.push(row);
    }
    return batch;
  }

  /**
   * Takes rows off the queue, each by itself, not by id: a turn row queued again under its id while the first was in flight is a
   * newer row, and stays. The gap row goes when it is among them, unless it grew while in flight (a new object, to go again).
   */
  private dropRows(taken: readonly TraceRow[]): void {
    if (taken.length === 0) return;
    const gone = new Set(taken);
    if (this.gap !== null && gone.has(this.gap)) this.gap = null;
    this.rows = this.rows.filter((row) => !gone.has(row));
  }

  /** Whether a report goes now: none in flight, no backoff holding, and something to say or the heartbeat due. */
  isDue(now: number, changed: boolean): boolean {
    const holding = this.inFlight || now < this.nextAttemptAt;
    const rowsWait = this.trace === true && (this.rows.length > 0 || this.gap !== null);
    return !holding && (changed || this.queue.length > 0 || rowsWait || this.lastSentAt === 0 || now - this.lastSentAt >= this.cfg.heartbeatMs);
  }

  /** Posts one report (see `post`), `last` when it is its session id's last; answers 'busy' at once while another is in flight. */
  send(makeReport: (events: ActivityEvent[], rows: TraceRow[]) => Report, now: number, last = false): Promise<PostOutcome> {
    if (this.inFlight) return Promise.resolve<PostOutcome>('busy');
    this.inFlight = true;
    this.posting = this.post(makeReport, now, last);
    return this.posting;
  }

  /** Resolves once no POST is in flight. */
  async idle(): Promise<void> {
    await this.posting?.catch(() => undefined);
  }

  /**
   * Posts one report with the oldest queued events (at most 100) and, once a reply has said the server keeps a record, the gap
   * row and the oldest queued rows (at most LIMITS.rows in all, nextRows). The rows a session id's `last` report does not carry
   * would never be sent, so they leave the queue counted on the gap row, which that report carries first. A 200 acknowledges
   * them; a 400 or 413 drops that report, its events and its rows, the gap row counting those (the server would never take
   * it), and backs off; a 401 keeps them and waits a minute; anything else, an unreachable server included, keeps them and
   * backs off.
   */
  private async post(makeReport: (events: ActivityEvent[], rows: TraceRow[]) => Report, now: number, last: boolean): Promise<PostOutcome> {
    const batch = this.queue.slice(0, EVENTS_PER_REPORT);
    const gap = this.trace === true ? this.gap : null;
    try {
      // One place is the gap row's: the one standing, or the one a last report adds when more rows are queued than it can hold.
      const room = LIMITS.rows - (gap !== null || (last && this.rows.length > LIMITS.rows) ? 1 : 0);
      const queued = this.trace === true ? this.nextRows(room) : [];
      const report = makeReport(batch, gap ? [gap, ...queued] : queued);
      // The rows it carries in the end: its byte budget may leave the last ones out (never the first), and those wait.
      let rows = report.rows ?? [];
      this.flying = rows.length - (gap ? 1 : 0);
      if (last && this.trace === true && this.flying < this.rows.length) {
        // Taken in after the byte budget ran: a gap row holds no text (about 120 bytes), and that budget keeps 44 KB below the
        // server's 512 KB.
        this.lose(this.rows.splice(this.flying));
        rows = report.rows = [this.gap!, ...rows.slice(gap ? 1 : 0)];
      }
      const res = await this.fetch(this.url, { method: 'POST', headers: headersFor(this.cfg.token), body: JSON.stringify(report) });
      if (res.ok) return this.accepted(res.text, batch, rows, now);
      if (res.status === 400 || res.status === 413) return this.rejectedWith(res, batch, rows, now);
      if (res.status === 401) return this.refusedAt(now);
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      return this.failedWith(err, now);
    } finally {
      this.inFlight = false;
      this.posting = null;
      this.flying = 0;
    }
  }

  private accepted(text: string, batch: readonly ActivityEvent[], rows: readonly TraceRow[], now: number): PostOutcome {
    const acked = this.takeReply(text, batch.length, rows.length);
    this.dropAcked(batch, acked.events);
    this.dropRows(rows.slice(0, acked.rows));
    this.sent++;
    this.online = true;
    this.lastSentAt = now;
    this.lastError = null;
    this.failures = 0;
    this.rejectStreak = 0;
    this.nextAttemptAt = 0;
    this.refused = false;
    this.loggedRefusal = false;
    return 'ok';
  }

  /**
   * The server answered about the report itself, so it would never take it: the report goes with its events, and its rows with
   * them, counted on the gap row (which stays). That is no outage, but backing off keeps a report it keeps refusing from going
   * out on every tick while the state is dirty.
   */
  private rejectedWith(res: Pick<HttpResponse, 'status' | 'text'>, batch: readonly ActivityEvent[], rows: readonly TraceRow[], now: number): PostOutcome {
    this.dropAcked(batch, batch.length);
    const carried = rows.filter((row) => row.kind !== 'gap');
    this.dropRows(carried);
    this.lose(carried);
    this.rejected++;
    this.online = true;
    this.lastError = `report rejected (${res.status})`;
    this.lastSentAt = now;
    this.rejectStreak++;
    this.nextAttemptAt = now + retryWaitMs(this.rejectStreak);
    // It read the token before it read the report, so an earlier 401 no longer stands.
    this.refused = false;
    this.loggedRefusal = false;
    if (!this.loggedReject) {
      this.loggedReject = true;
      this.log(`sitrep-reporter: report rejected (${res.status}): ${res.text.slice(0, 200)}`);
    }
    return 'rejected';
  }

  /** A wrong or missing token: the events stay, the next try waits a minute, and it is said once. The token is never in a message. */
  private refusedAt(now: number): PostOutcome {
    this.refused = true;
    this.online = false;
    this.lastError = 'token refused (401)';
    this.lastSentAt = now;
    this.nextAttemptAt = now + REFUSED_WAIT_MS;
    if (!this.loggedRefusal) {
      this.loggedRefusal = true;
      this.log('sitrep-reporter: token refused (401)');
    }
    return 'refused';
  }

  private failedWith(err: unknown, now: number): PostOutcome {
    this.failed++;
    this.failures++;
    this.online = false;
    this.nextAttemptAt = now + retryWaitMs(this.failures);
    this.lastError = (err as Error | undefined)?.message ?? 'network error';
    return 'failed';
  }

  /** Takes in what a 200 reply says, and how many of the report's events and rows it acknowledged: all of them when it does not say. */
  private takeReply(text: string, events: number, rows: number): { events: number; rows: number } {
    let reply: Partial<Record<keyof ReportReply, unknown>> | null;
    try {
      reply = JSON.parse(text) as typeof reply;
    } catch {
      // A 200 without a JSON body still acknowledges everything that went.
      return { events, rows };
    }
    if (reply === null) return { events, rows };
    if (typeof reply.liveSessions === 'number') this.liveSessions = reply.liveSessions;
    const compat = reply.reporterCompat;
    this.compat = compat === 'ok' || compat === 'outdated' || compat === 'newer' ? compat : null;
    this.serverVersion = typeof reply.serverVersion === 'string' ? reply.serverVersion : null;
    this.serverBuild = typeof reply.serverBuild === 'string' ? reply.serverBuild : null;
    const support = reply.reporterSupport as Partial<ReporterSupport> | null | undefined;
    this.support = typeof support?.min === 'string' && typeof support.max === 'string' ? { min: support.min, max: support.max } : null;
    this.watch = strings(reply.watch).slice(0, MAX_WATCHED);
    this.respond = reply.respond === true;
    this.deliveries = this.respond && Array.isArray(reply.deliveries) ? reply.deliveries.filter(isDelivery).slice(0, MAX_DELIVERIES) : [];
    // An older server says nothing of a record: it keeps none. Rows queued for one that keeps none go, and none of them is a gap.
    this.trace = reply.trace === true;
    if (!this.trace) {
      this.rows = [];
      this.gap = null;
    }
    const taken = (acked: unknown, sent: number): number => (typeof acked === 'number' ? Math.max(0, Math.min(sent, acked)) : sent);
    return { events: taken(reply.ackedEvents, events), rows: taken(reply.ackedRows, rows) };
  }

  /** Takes the first `n` events of `batch` off the queue by id; events queued while the POST was out stay. */
  private dropAcked(batch: readonly ActivityEvent[], n: number): void {
    const gone = new Set(batch.slice(0, n).map((e) => e.id));
    this.queue = this.queue.filter((e) => !gone.has(e.id));
  }

  /** In the server's range (or not placed) but below its newest major.minor: a newer reporter exists. Patches never count. */
  get behind(): boolean {
    const mine = minorRank(this.cfg.version);
    const newest = this.support ? minorRank(this.support.max) : null;
    return (this.compat === 'ok' || this.compat === null) && mine !== null && newest !== null && mine < newest;
  }

  /** What keeps this session off the dashboard; null while the server takes its reports. */
  get notLive(): 'token refused' | 'offline' | 'connecting' | 'report rejected' | null {
    if (this.refused) return 'token refused';
    if (this.online === false) return 'offline';
    if (this.online === null) return 'connecting';
    return this.rejectStreak > 0 ? 'report rejected' : null;
  }

  /** The server's count of live sessions; "live" alone when it has not given one, never a made-up number. */
  get live(): string {
    return this.liveSessions === null ? 'live' : `${this.liveSessions} live`;
  }

  /**
   * The status line: `dashboard v0.1.0 ● 3 live`, or the state that keeps it from that, then a version hint. The version is
   * the dashboard's, as the dashboard shows it (the server's, from its last reply; none before the first), never this
   * plugin's, which `/sitrep` gives.
   */
  statusText(): string {
    const name = `${overPlainHttp(this.cfg.serverUrl) ? '⚠ ' : ''}dashboard${this.serverVersion ? ` v${this.serverVersion}` : ''}`;
    const notLive = this.notLive;
    if (notLive !== null) return `${name} ○ ${notLive}`;
    const hint = this.compat === 'outdated' ? 'update plugin' : this.compat === 'newer' ? 'update server' : this.behind ? 'update available' : null;
    return `${name} ● ${this.live}${hint ? ` · ${hint}` : ''}`;
  }

  /** Said once when the server is plain HTTP beyond this machine; names no address and no token. */
  plainHttpNotice(): string | null {
    return overPlainHttp(this.cfg.serverUrl) ? 'plain HTTP beyond this machine: the token and reports are not encrypted' : null;
  }

  refusalNotice(): string | null {
    return this.refused ? 'token refused · set it with npx tsx scripts/install.ts --claude --token-stdin --apply' : null;
  }

  private get server(): string {
    return this.serverVersion ? `server ${withBuild(this.serverVersion, this.serverBuild)}` : 'the server';
  }

  versionNotice(): string | null {
    if (this.compat === 'outdated') return `plugin ${this.cfg.version} is too old for ${this.server} · run the machine's Update command, then restart (resume) this session`;
    if (this.compat === 'newer') return `plugin ${this.cfg.version} is too new for ${this.server} · update the server`;
    return null;
  }

  /** The mild hint behind `· update available`, for `/sitrep` only, never a toast. */
  updateNotice(): string | null {
    const newest = this.behind ? this.support?.max : undefined;
    return newest === undefined ? null : `update available: ${this.server} reads plugins up to ${newest}, this is ${this.cfg.version} · run the machine's Update command, then restart (resume) this session`;
  }
}
