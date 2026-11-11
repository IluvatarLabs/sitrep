// One session's reports to the server: events queue up to 500, one POST at a time, the reply's count acks them, and a server
// that cannot be reached is tried again after 1 s, 2 s, 5 s, then every 10 s (a minute after it refuses the token). The
// reporter keeps one Transport per reported Codex session, as the Claude reporter keeps one per Claude session.
import { TOKEN_HEADER, type ActivityEvent, type Delivery, type Report } from '../../server/src/fleet/protocol.js';

/** The counts: events queued, events per report, and the watched loops and deliveries one reply may list. */
const MOST = { queued: 500, perReport: 100, watched: 201, deliveries: 20 } as const;
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

/** What became of a report: taken, dropped for good (the server will never take it as it is), or kept for a later try. */
export type Sent = 'ok' | 'rejected' | 'later';

/** Answers that mean the report itself is unacceptable (bad shape, a conflict, too large): resending it can never succeed. */
const NEVER_TAKEN: ReadonlySet<number> = new Set([400, 409, 413]);

/** The fields of a report reply this reporter reads. */
interface Reply {
  ackedEvents?: unknown;
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

  /** Whether to post now: nothing in flight, no backoff holding, and something changed, events wait, or the heartbeat is due. */
  ready(now: number, changed: boolean): boolean {
    if (this.inFlight || this.nextAttemptAt > now) return false;
    return changed || this.queue.length > 0 || now - this.lastSentAt >= this.heartbeatMs;
  }

  /**
   * Posts one report built from the oldest queued events (at most 100). A 200 acks them; 400, 409 or 413 drops the report
   * and its events, since resending can never succeed; a 401 keeps them for a minute; anything else, or no answer at all,
   * keeps them until the backoff ends.
   */
  async send(build: (events: ActivityEvent[]) => Report, now: number): Promise<Sent> {
    if (this.inFlight) return 'later';
    const batch = this.queue.slice(0, MOST.perReport);
    let report: Report;
    try {
      report = build(batch);
    } catch (err) {
      return this.unbuilt(err, now);
    }
    this.buildError = null;
    this.inFlight = true;
    let why = '';
    try {
      const res = await serverCall(this.serverUrl, this.token, 'POST', '/api/fleet/report', report, REPORT_TIMEOUT_MS, (w) => (why = w));
      if (res?.ok) return this.taken(res.text, batch, now);
      if (res && NEVER_TAKEN.has(res.status)) return this.dropped(res, batch, now);
      if (res?.status === 401) return this.refusedToken(now);
      return this.missed(now, res ? `HTTP ${String(res.status)}` : why);
    } finally {
      this.inFlight = false;
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

  /** Taken: the reply's word is kept, the events it acks leave the queue, and every backoff ends. */
  private taken(text: string, batch: readonly ActivityEvent[], now: number): Sent {
    this.answered(now);
    let reply: Reply | null = null;
    try {
      reply = JSON.parse(text) as Reply | null;
    } catch {
      // not JSON: taken all the same, with every event in it, and the last reply's word stands
    }
    let acked = batch.length;
    if (reply !== null) {
      if (typeof reply.ackedEvents === 'number') acked = Math.min(batch.length, Math.max(0, reply.ackedEvents));
      this.watch = Array.isArray(reply.watch) ? reply.watch.filter((id): id is string => typeof id === 'string').slice(0, MOST.watched) : [];
      this.respond = reply.respond === true;
      this.deliveries = this.respond && Array.isArray(reply.deliveries) ? reply.deliveries.filter(isDelivery).slice(0, MOST.deliveries) : [];
    }
    this.forget(batch, acked);
    this.unreachedRun = this.rejectedRun = this.nextAttemptAt = 0;
    this.lastSentAt = now;
    this.refused = false;
    return 'ok';
  }

  /** Never taken as it is: the report and its events go, logged once per run, and each rejection in a run waits longer. */
  private dropped(res: HttpResult, batch: readonly ActivityEvent[], now: number): Sent {
    this.answered(now);
    this.forget(batch, batch.length);
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
}
