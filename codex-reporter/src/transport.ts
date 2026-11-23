// One session's reports to the server: events queue up to 500, one POST at a time, the reply's count acks them, and a server
// that cannot be reached is tried again after 1 s, 2 s, 5 s, then every 10 s (a minute after it refuses the token). The
// record's rows have a queue of their own beside the events', acked by the reply's own count the same way. The
// reporter keeps one Transport per reported Codex session, as the Claude reporter keeps one per Claude session; hermes-reporter
// keeps one per Hermes session.
import { LIMITS, TOKEN_HEADER, type ActivityEvent, type Delivery, type Report, type TraceRow } from '../../server/src/fleet/protocol.js';
import { keptRow, type QueuedRow } from './report.js';

/** The counts: events (and rows) queued, events per report, and the watched loops and deliveries one reply may list. */
const MOST = { queued: 500, perReport: 100, watched: 201, deliveries: 20 } as const;
/** A report's serialized bytes at most, a margin inside the server's 512 KB body limit (mod/claude-reporter/hooks/report.ts PER_REPORT.bytes). */
const REPORT_BYTES = 480_000;
/** When this process started: a row older than this was read again from the harness's own store (pushRows). */
const STARTED_AT = Date.now();
const RETRY_MS = [1000, 2000, 5000, 10_000] as const;
const AFTER_REFUSAL_MS = 60_000;
const REPORT_TIMEOUT_MS = 15_000;

/** The wait before trying again after `misses` misses in a row: 1 s after the first, 10 s from the fourth on. */
export const retryDelay = (misses: number): number => RETRY_MS[Math.min(Math.max(misses, 1), RETRY_MS.length) - 1]!;

export interface HttpResult {
  status: number;
  ok: boolean;
  text: string;
}

/** The server URL without its trailing slashes, so a path can follow it. A loop, as `/\/+$/` backtracks on a long run. */
function baseOf(url: string): string {
  let end = url.length;
  while (url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/**
 * One call to the server with the admin secret; null when it could not be made (offline, timed out), and `failed` is told why.
 * `body` goes as JSON, and a call without one (a held answer's GET) sends none: `JSON.stringify(undefined)` is undefined.
 */
export async function serverCall(serverUrl: string, token: string, method: string, pathName: string, body: unknown, timeoutMs: number, failed?: (why: string) => void): Promise<HttpResult | null> {
  try {
    const res = await fetch(baseOf(serverUrl) + pathName, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { [TOKEN_HEADER]: token } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, ok: res.ok, text: await res.text() };
  } catch (err) {
    // fetch fails with a TimeoutError when the signal ends it, else with its cause's code (ECONNREFUSED, ENOTFOUND, …).
    const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
    failed?.(e?.name === 'TimeoutError' ? `no answer within ${String(timeoutMs / 1000)} s` : `connection error (${String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? err)})`);
    return null;
  }
}

/** A delivery as the server sends it: only its shape is checked here; what it may do is the reporter's to decide. */
export const isDelivery = (v: unknown): v is Delivery => {
  if (!v || typeof v !== 'object') return false;
  const { id, kind, by, at } = v as Record<string, unknown>;
  return typeof id === 'string' && typeof kind === 'string' && typeof by === 'string' && typeof at === 'number';
};

/**
 * Keeps the serialized report under REPORT_BYTES (a character budget does not see multi-byte text): rows go from the last, and
 * wait in their queue for the next report (the first always goes), as the Claude reporter's do (its report.ts bytesWithin).
 */
function bytesWithin(r: Report): void {
  const rows = r.rows ?? [];
  if (rows.length < 2) return;
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  // A row left out takes its own bytes and the comma before it.
  for (let over = size(r) - REPORT_BYTES; over > 0 && rows.length > 1; ) over -= size(rows.pop()) + 1;
}

/** What became of a report: taken, dropped for good (the server will never take it as it is), or kept for a later try. */
export type Sent = 'ok' | 'rejected' | 'later';

/** Answers that mean the report itself is unacceptable (bad shape, a conflict, too large): resending it can never succeed. */
const NEVER_TAKEN: ReadonlySet<number> = new Set([400, 409, 413]);

/** The fields of a report reply this reporter reads. */
interface Reply {
  ackedEvents?: unknown;
  ackedRows?: unknown;
  trace?: unknown;
  watch?: unknown;
  respond?: unknown;
  deliveries?: unknown;
}

export class Transport {
  queue: ActivityEvent[] = [];
  lastSentAt = 0;
  nextAttemptAt = 0;
  /** The loops the last accepted report's reply says someone is watching. */
  watch: string[] = [];
  /** Whether the last accepted report's reply said the server takes answers for this session. */
  respond = false;
  /** Messages and commands the last reply handed over. */
  deliveries: Delivery[] = [];
  inFlight = false;
  /** The record's rows not yet acked, oldest first; each one's text stays raw until a report takes it (keptRow). */
  private rows: QueuedRow[] = [];
  /** Whether the last accepted report's reply said the server keeps a record (`trace`); an older server says nothing: false. */
  private trace = false;
  /** The one `gap` row standing for the rows dropped since the server last took one, sent first; null when none. */
  private gap: TraceRow | null = null;
  private gaps = 0;
  /** How many rows at the head of `rows` the post in flight carries: they are never dropped from under it. */
  private flying = 0;
  /** Misses in a row, each run with its own backoff: the server not reached, and reports it will never take. */
  private unreachedRun = 0;
  private rejectedRun = 0;
  /** The last answer was a 401, already logged. */
  private refused = false;
  /** The run of posts that got no answer about the report, logged at its start and end: how many, since when. */
  private failedPosts = 0;
  private failingSince = 0;
  /** The error the last build of a report threw, logged; null once one is built. */
  private buildError: string | null = null;

  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly heartbeatMs: number,
    private readonly log: (line: string) => void,
    /** The reporter's name, as its log lines start (`codex-reporter`, `hermes-reporter`). */
    private readonly name: string,
    /** The session these reports are for, as the failure lines name it. */
    private readonly session: string,
  ) {}

  /** Adds events behind those queued, keeping the newest 500. */
  push(events: readonly ActivityEvent[]): void {
    if (events.length) this.queue = this.queue.concat(events).slice(-MOST.queued);
  }

  /**
   * Adds rows behind those queued, keeping the newest 500. The oldest of the rest (never the rows of a post in flight) are dropped,
   * and ONE gap row stands in their place, its count growing with each drop, except for a row whose `t0` is before this
   * process started: both reporters read their history from the harness's own store (Codex's session files, Hermes's state.db), so
   * such a row was read again, and the server took it from the reporter that ran then. Dropping it loses nothing; it is no gap.
   */
  pushRows(rows: readonly QueuedRow[]): void {
    if (!rows.length) return;
    this.rows = this.rows.concat(rows);
    const over = this.rows.length - MOST.queued;
    if (over > 0) this.lose(this.rows.splice(this.flying, over));
  }

  /** Rows dropped: those read since this start are counted on the gap row, which grows as a new object (the sent one may be in flight). */
  private lose(dropped: readonly TraceRow[]): void {
    const lost = dropped.filter((r) => r.t0 >= STARTED_AT);
    if (!lost.length) return;
    const g = this.gap;
    const t0 = lost.reduce((at, r) => Math.min(at, r.t0), g?.t0 ?? Infinity);
    const t1 = lost.reduce((at, r) => Math.max(at, r.t1 ?? r.t0), g?.t1 ?? -Infinity);
    this.gap = { id: g?.id ?? `gap:${String(STARTED_AT)}:${String(++this.gaps)}`, kind: 'gap', agentId: null, t0, t1, count: (g?.count ?? 0) + lost.length };
  }

  /** Rows wait to be sent: the server keeps a record and rows (or a gap) are queued. While it keeps none, nothing waits. */
  rowsPending(): boolean {
    return this.trace && (this.rows.length > 0 || this.gap !== null);
  }

  /** Whether to post now: nothing in flight, no backoff holding, and something changed, events or rows wait, or the heartbeat is due. */
  ready(now: number, changed: boolean): boolean {
    if (this.inFlight || this.nextAttemptAt > now) return false;
    return changed || this.queue.length > 0 || this.rowsPending() || now - this.lastSentAt >= this.heartbeatMs;
  }

  /**
   * The queued rows the next report carries, from the head and in order: at most `max`, while their text fits LIMITS.rowTextChars
   * (the first always goes; one that does not fit waits for the next report). Each one's text is redacted and cut as a report
   * first takes it (keptRow), and the kept row replaces the raw one in the queue.
   */
  private nextRows(max: number): TraceRow[] {
    let chars = 0;
    let n = 0;
    for (; n < Math.min(max, this.rows.length); n++) {
      const row = (this.rows[n] = keptRow(this.rows[n]!));
      const size = Object.values(row.text ?? {}).reduce((sum, part) => sum + part.length, 0);
      if (n > 0 && chars + size > LIMITS.rowTextChars) break;
      chars += size;
    }
    return this.rows.slice(0, n);
  }

  /**
   * Posts one report built from the oldest queued events (at most 100) and, while the server keeps a record, the gap row and the
   * oldest queued rows (at most LIMITS.rows in all, nextRows, within the report's bytes, bytesWithin). A 200 acks them; 400, 409
   * or 413 drops the report with its events and rows, since resending can never succeed; a 401 keeps them for a minute; anything
   * else, or no answer at all, keeps them until the backoff ends.
   */
  async send(build: (events: ActivityEvent[]) => Report, now: number): Promise<Sent> {
    if (this.inFlight) return 'later';
    const batch = this.queue.slice(0, MOST.perReport);
    const gap = this.trace ? this.gap : null;
    const queued = this.trace ? this.nextRows(LIMITS.rows - (gap ? 1 : 0)) : [];
    let report: Report;
    try {
      report = build(batch);
    } catch (err) {
      return this.unbuilt(err, now);
    }
    if (gap || queued.length) report.rows = gap ? [gap, ...queued] : queued;
    bytesWithin(report);
    // The queued rows it carries in the end: those its bytes left out wait at the head of the queue for the next report.
    const rows = (report.rows ?? []).slice(gap ? 1 : 0);
    this.buildError = null;
    this.inFlight = true;
    this.flying = rows.length;
    let why = '';
    try {
      const res = await serverCall(this.serverUrl, this.token, 'POST', '/api/fleet/report', report, REPORT_TIMEOUT_MS, (w) => (why = w));
      if (res?.ok) return this.taken(res.text, batch, gap, rows, now);
      if (res && NEVER_TAKEN.has(res.status)) return this.dropped(res, batch, rows, now);
      if (res?.status === 401) return this.refusedToken(now);
      return this.missed(now, res ? `HTTP ${String(res.status)}` : why);
    } finally {
      this.inFlight = false;
      this.flying = 0;
    }
  }

  /**
   * A report that could not be built is this reporter's fault, not the network's: its error's message (never the report) is logged
   * once per run of one error, and it is tried again on the same backoff.
   */
  private unbuilt(err: unknown, now: number): Sent {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    if (message !== this.buildError) this.log(`${this.name}: could not build session ${this.session}'s report: ${message}`);
    this.buildError = message;
    this.nextAttemptAt = now + retryDelay(++this.unreachedRun);
    return 'later';
  }

  /** The server answered: a run of failed posts ends, logged with its length. */
  private answered(now: number): void {
    if (this.failedPosts) this.log(`${this.name}: the server answers session ${this.session}'s reports again, after ${String(this.failedPosts)} failed post${this.failedPosts === 1 ? '' : 's'} over ${String(Math.round((now - this.failingSince) / 1000))} s`);
    this.failedPosts = 0;
  }

  /**
   * Taken: the reply's word is kept, the events and rows it acks leave their queues, and every backoff ends. A reply that says the
   * server keeps no record empties the row queue: nothing is held for a record nobody keeps, and nothing of it is a gap.
   */
  private taken(text: string, batch: readonly ActivityEvent[], gap: TraceRow | null, rows: readonly TraceRow[], now: number): Sent {
    this.answered(now);
    let reply: Reply | null = null;
    try {
      reply = JSON.parse(text) as Reply | null;
    } catch {
      // not JSON: taken all the same, with every event in it, and the last reply's word stands
    }
    let acked = batch.length;
    let ackedRows = rows.length + (gap ? 1 : 0);
    if (reply !== null) {
      if (typeof reply.ackedEvents === 'number') acked = Math.min(batch.length, Math.max(0, reply.ackedEvents));
      if (typeof reply.ackedRows === 'number') ackedRows = Math.min(ackedRows, Math.max(0, reply.ackedRows));
      this.trace = reply.trace === true;
      this.watch = Array.isArray(reply.watch) ? reply.watch.filter((id): id is string => typeof id === 'string').slice(0, MOST.watched) : [];
      this.respond = reply.respond === true;
      this.deliveries = this.respond && Array.isArray(reply.deliveries) ? reply.deliveries.filter(isDelivery).slice(0, MOST.deliveries) : [];
    }
    this.forget(batch, acked);
    // The gap row is the first of the report's rows; one that grew while in flight is a new object, kept to be sent again.
    if (gap && ackedRows > 0 && this.gap === gap) this.gap = null;
    this.forgetRows(rows, ackedRows - (gap ? 1 : 0));
    if (!this.trace) {
      this.rows = [];
      this.gap = null;
    }
    this.unreachedRun = this.rejectedRun = this.nextAttemptAt = 0;
    this.lastSentAt = now;
    this.refused = false;
    return 'ok';
  }

  /**
   * Never taken as it is: the report, its events and its rows go (the rows counted on the gap row, which stays), logged once per
   * run, and each rejection in a run waits longer.
   */
  private dropped(res: HttpResult, batch: readonly ActivityEvent[], rows: readonly TraceRow[], now: number): Sent {
    this.answered(now);
    this.forget(batch, batch.length);
    this.forgetRows(rows, rows.length);
    this.lose(rows);
    if (++this.rejectedRun === 1) this.log(`${this.name}: server rejected a report (${res.status}): ${res.text.slice(0, 200)}`);
    this.refused = false;
    this.lastSentAt = now;
    this.nextAttemptAt = now + retryDelay(this.rejectedRun);
    return 'rejected';
  }

  /** 401: the admin secret is wrong or missing. Logged once; the next try is a minute later. */
  private refusedToken(now: number): Sent {
    this.answered(now);
    if (!this.refused) this.log(`${this.name}: the server refused this reporter (401): check CODEX_REPORTER_TOKEN`);
    this.refused = true;
    this.lastSentAt = now;
    this.nextAttemptAt = now + AFTER_REFUSAL_MS;
    return 'later';
  }

  /**
   * No answer about the report itself (offline, timed out, a 5xx): its events stay queued and the next try backs off. The run
   * is logged once as it starts, with `why`, and once as it ends (answered).
   */
  private missed(now: number, why: string): Sent {
    if (this.failedPosts++ === 0) {
      this.failingSince = now;
      this.log(`${this.name}: posting session ${this.session}'s report failed: ${why}; trying again with backoff`);
    }
    this.nextAttemptAt = now + retryDelay(++this.unreachedRun);
    return 'later';
  }

  /** Takes the first `n` events of `batch` out of the queue; events queued while the post was in flight stay. */
  private forget(batch: readonly ActivityEvent[], n: number): void {
    const gone = new Set(batch.slice(0, n).map((e) => e.id));
    this.queue = this.queue.filter((e) => !gone.has(e.id));
  }

  /**
   * Takes the first `n` rows of `sent` out of the queue, each by itself, not by id: a turn row queued again under its id while the
   * first was in flight (its end, or its prompt) is a newer row and stays to be sent.
   */
  private forgetRows(sent: readonly TraceRow[], n: number): void {
    if (n <= 0) return;
    const gone = new Set<TraceRow>(sent.slice(0, n));
    this.rows = this.rows.filter((r) => !gone.has(r));
  }
}
