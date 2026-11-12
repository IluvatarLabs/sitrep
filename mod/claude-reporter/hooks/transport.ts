// Getting reports to the server. Hooks only queue events and the flush timer calls `send`, so no hook ever waits on the
// network. At most 500 events are held (past that the oldest are dropped), one POST is out at a time, the server
// acknowledges events by count, and while it cannot be reached the next try waits 1 s, 2 s, 5 s, then 10 s.
import type { HttpInit, HttpResponse } from 'claude-code';
import { withBuild } from './build.ts';
import { trimTrailingSlashes } from './machine.ts';
import { TOKEN_HEADER, type ActivityEvent, type Delivery, type Report, type ReportReply, type ReporterCompat, type ReporterSupport } from './protocol.ts';

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

  /** Whether a report goes now: none in flight, no backoff holding, and something to say or the heartbeat due. */
  isDue(now: number, changed: boolean): boolean {
    const holding = this.inFlight || now < this.nextAttemptAt;
    return !holding && (changed || this.queue.length > 0 || this.lastSentAt === 0 || now - this.lastSentAt >= this.cfg.heartbeatMs);
  }

  /** Posts one report (see `post`); answers 'busy' at once while another is in flight. */
  send(makeReport: (events: ActivityEvent[]) => Report, now: number): Promise<PostOutcome> {
    if (this.inFlight) return Promise.resolve<PostOutcome>('busy');
    this.inFlight = true;
    this.posting = this.post(makeReport, now);
    return this.posting;
  }

  /** Resolves once no POST is in flight. */
  async idle(): Promise<void> {
    await this.posting?.catch(() => undefined);
  }

  /**
   * Posts one report with the oldest queued events (at most 100). A 200 acknowledges them; a 400 or 413 drops that report and
   * its events (the server would never take it) and backs off; a 401 keeps them and waits a minute; anything else, an
   * unreachable server included, keeps them and backs off.
   */
  private async post(makeReport: (events: ActivityEvent[]) => Report, now: number): Promise<PostOutcome> {
    const batch = this.queue.slice(0, EVENTS_PER_REPORT);
    try {
      const res = await this.fetch(this.url, { method: 'POST', headers: headersFor(this.cfg.token), body: JSON.stringify(makeReport(batch)) });
      if (res.ok) return this.accepted(res.text, batch, now);
      if (res.status === 400 || res.status === 413) return this.rejectedWith(res, batch, now);
      if (res.status === 401) return this.refusedAt(now);
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      return this.failedWith(err, now);
    } finally {
      this.inFlight = false;
      this.posting = null;
    }
  }

  private accepted(text: string, batch: readonly ActivityEvent[], now: number): PostOutcome {
    this.dropAcked(batch, this.takeReply(text, batch));
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
   * The server answered about the report itself, so it would never take it: the report goes with its events. That is no
   * outage, but backing off keeps a report it keeps refusing from going out on every tick while the state is dirty.
   */
  private rejectedWith(res: Pick<HttpResponse, 'status' | 'text'>, batch: readonly ActivityEvent[], now: number): PostOutcome {
    this.dropAcked(batch, batch.length);
    this.rejected++;
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

  /** Takes in what a 200 reply says, and how many of `batch` it acknowledged: all of them when it does not say. */
  private takeReply(text: string, batch: readonly ActivityEvent[]): number {
    let reply: Partial<Record<keyof ReportReply, unknown>> | null;
    try {
      reply = JSON.parse(text) as typeof reply;
    } catch {
      // A 200 without a JSON body still acknowledges everything that went.
      return batch.length;
    }
    if (reply === null) return batch.length;
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
    const acked = reply.ackedEvents;
    return typeof acked === 'number' ? Math.max(0, Math.min(batch.length, acked)) : batch.length;
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

  /**
   * The status line: `dashboard v0.1.0 ● 3 live`, or the state that keeps it from that, then a version hint. The version is
   * the dashboard's, as the dashboard shows it (the server's, from its last reply; none before the first), never this
   * plugin's, which `/sitrep` gives.
   */
  statusText(): string {
    const name = `${overPlainHttp(this.cfg.serverUrl) ? '⚠ ' : ''}dashboard${this.serverVersion ? ` v${this.serverVersion}` : ''}`;
    const notLive = this.refused ? 'token refused' : this.online === false ? 'offline' : this.online === null ? 'connecting' : null;
    if (notLive !== null) return `${name} ○ ${notLive}`;
    const hint = this.compat === 'outdated' ? 'update plugin' : this.compat === 'newer' ? 'update server' : this.behind ? 'update available' : null;
    return `${name} ● ${this.liveSessions ?? 1} live${hint ? ` · ${hint}` : ''}`;
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
