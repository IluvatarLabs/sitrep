// The fleet API at /api/fleet, in single-owner mode. Reporters prove themselves with the admin secret in
// TOKEN_HEADER; reads are open on the LAN, or, while `requireSignInToView` is on, need the owner's sign-in or the admin secret in
// TOKEN_HEADER (`viewGate`); answering a session and the owner's admin actions need the owner's sign-in (respondRoutes.ts,
// adminRoutes.ts). Every refusal is JSON of one shape, `{ ok: false, error, path }`.
import express, { Router, type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Fleet } from './fleet.js';
import { checkReporter, serverBuild, serverVersion, supportFor } from './compat.js';
import { LIMITS, MACHINE_HEADER, MACHINE_ID, MAIN_LOOP, TOKEN_HEADER, validateReport, VIEW_GATED, type RefusalView, type Report, type ReportReply, type SettingsBody } from './protocol.js';
import { apiRequestsOf } from './telemetry.js';
import { everyOf, type ActivityReply } from './activity.js';
import { identify, Lockout, ownerOf, sourceAddress, type Identity } from './auth.js';
import { mountRespondRoutes, replyFor, signIns } from './respondRoutes.js';
import { localDay } from './days.js';
import { createAdminRouter } from './adminRoutes.js';
import { formatSse } from './sse.js';
import { silentLogger, type Logger } from '../logger.js';

/** The server's own facts that Settings shows read-only; the start-up code fills them in. */
export type ServerFacts = Pick<SettingsBody['about'], 'host' | 'port' | 'allowedHosts' | 'logLevel'>;

export interface FleetRouterOptions {
  /** The admin secret. While it is set, POST /report, POST /v1/logs, DELETE /sessions/:id and the reporters' answer routes need it. */
  token?: string | null;
  /** Where the router logs. It is never given a report body, the secret, or anything the owner typed. */
  logger?: Logger;
  /** The wrong-sign-in counter; the router makes its own when none is given. */
  lockout?: Lockout;
  /** Runs before the sign-in, to note a plain-HTTP connection; it always lets the request through. */
  onSignIn?: express.RequestHandler;
  /** The bind address, port, allowed hosts and log level, for Settings. */
  server?: ServerFacts;
}

export const BODY_LIMIT = '512kb';
/**
 * The body limit for Claude Code's telemetry: the OpenTelemetry Collector's default for an OTLP/HTTP receiver (confighttp
 * `max_request_body_size`, 20 MiB). One export carries up to hundreds of records of every event Claude Code emits.
 */
export const TELEMETRY_BODY_LIMIT = '20mb';

/** History's page: the sizes a request may ask for, and the size of one that asks for none. */
const HISTORY_PAGE = { sizes: [25, 50, 100], fallback: 50 };
/** The refusals kept in memory for Machines, newest first, and the characters kept of each reason. */
const MAX_REFUSALS = 200;
const REASON_CHARS = 200;
/** Request bodies a reporter sends: JSON, under its own media type or any `+json` one. */
const JSON_TYPES = ['application/json', 'application/*+json'];

/** What `GET /stream` answers with before its first message. */
const STREAM_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};
/** The whole reply to a stream request past the hub's limit of clients. */
const STREAM_FULL = 'event: error\ndata: {"error":"too many clients"}\n\n';

/** A whole number from the query string; null when the value is absent or empty, 'bad' when it is anything but decimal digits. */
function count(v: unknown): number | null | 'bad' {
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return v === undefined || v === '' ? null : 'bad';
}

/** Who tokenCheck found a request to be; read only on routes behind it. */
function identityOf(res: Response): Identity {
  return res.locals.identity as Identity;
}

/** For log lines: the route a request matched, with its mount point (`/api/fleet/report`). */
const routeName = (req: Request): string => req.baseUrl + ((req.route as { path?: string } | undefined)?.path ?? req.path);

function refuse(res: Response, status: number, error: string, path: string): void {
  res.status(status).json({ ok: false, error, path });
}

/**
 * How a failed request is answered. What a body parser rejects (malformed JSON, a body over its limit, a bad charset) is the
 * client's 4xx, naming the limit the browser's routes (64kb) or the reporters' (BODY_LIMIT) set; anything else is a 500.
 */
function failureOf(err: { type?: string; status?: number; message?: string; limit?: unknown }): { status: number; error: string } {
  if (err.type === 'entity.too.large') return { status: 413, error: `body over ${typeof err.limit === 'number' && err.limit > 0 ? `${String(Math.round(err.limit / 1024))}kb` : BODY_LIMIT}` };
  if (err.type === 'entity.parse.failed') return { status: 400, error: 'malformed JSON' };
  const status = typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
  return { status, error: status === 500 ? 'internal error' : (err.type ?? 'bad request') };
}

/**
 * The machine a refused request names: its report's, when the body was read and has one, else MACHINE_HEADER's when that is a
 * machine id; a header that is not one is never recorded.
 */
function machineIn(body: unknown, header: string | undefined): Pick<RefusalView, 'machineId' | 'machineName'> {
  const m = (body as { machine?: { id?: unknown; name?: unknown } } | null | undefined)?.machine;
  const text = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, LIMITS.name) : null);
  return { machineId: text(m?.id) ?? (header !== undefined && MACHINE_ID.test(header) ? header : null), machineName: text(m?.name) };
}

/** Stores an accepted report and builds its reply: the reporter's standing, the loops being watched, and what waits for it. */
function acceptReport(fleet: Fleet, token: string | null, r: Report, owner: string | null): ReportReply {
  // The session's id on the server; the reply names it by the reporter's own.
  const key = fleet.ingest(r, owner).sessionId;
  const support = supportFor(r.reporter.name);
  return {
    ok: true,
    serverTime: fleet.now(),
    ackedEvents: r.events.length,
    sessionId: r.session.id,
    liveSessions: fleet.visibleCount(),
    serverVersion: serverVersion(),
    serverBuild: serverBuild(),
    reporterSupport: support,
    reporterCompat: checkReporter(r.reporter.version, support),
    watch: fleet.activity.watched(key),
    ...replyFor(fleet, token, key),
  };
}

/** The activity route's body: the viewer's lease taken or renewed with what it holds, or nothing while the feed is off or the session gone. */
function activityBody(fleet: Fleet, sessionId: string, loop: string, every: unknown): ActivityReply {
  const serverTime = fleet.now();
  if (!fleet.activity.on) return { entries: [], since: null, live: fleet.isLive(sessionId), enabled: false, serverTime };
  if (!fleet.isLive(sessionId)) return { entries: [], since: null, live: false, enabled: true, serverTime };
  return { ...fleet.activity.watch(sessionId, loop, everyOf(every)), live: true, enabled: true, serverTime };
}

/** A query value as machine ids, once or repeated: none when absent or empty, 'bad' unless each is a machine id. */
function machineIds(v: unknown): string[] | 'bad' {
  if (v === undefined || v === '') return [];
  const ids: unknown[] = Array.isArray(v) ? v : [v];
  return ids.every((id) => typeof id === 'string' && MACHINE_ID.test(id)) ? (ids as string[]) : 'bad';
}

/**
 * `GET /history`'s query, checked: the day (the server's `today` when none is named) with its bounds (the server's local
 * midnights), the page wanted, and the machines it is narrowed to (none: every machine).
 */
function historyQuery(q: Request['query'], today: string): { day: string; from: number; to: number; page: number; pageSize: number; machines: string[] } | { error: string; path: string } {
  const day = q.day === undefined || q.day === '' ? today : typeof q.day === 'string' ? q.day : '';
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!ymd) return { error: 'day must be YYYY-MM-DD', path: '$.query.day' };
  const [year, month, date] = ymd.slice(1).map(Number) as [number, number, number];
  const midnight = new Date(year, month - 1, date);
  // Date quietly turns 2026-02-31 into March 3rd, so a day that does not exist shows when its parts are read back.
  if (midnight.getFullYear() !== year || midnight.getMonth() !== month - 1 || midnight.getDate() !== date) return { error: 'day is not a real date', path: '$.query.day' };
  const page = count(q.page);
  const size = count(q.pageSize);
  if (page === 0 || page === 'bad' || size === 'bad' || (size !== null && !HISTORY_PAGE.sizes.includes(size))) {
    return { error: `page must be 1 or more and pageSize one of ${HISTORY_PAGE.sizes.join(', ')}`, path: '$.query' };
  }
  const machines = machineIds(q.machine);
  if (machines === 'bad') return { error: 'machine must be a machine id', path: '$.query.machine' };
  return { day, from: midnight.getTime(), to: new Date(year, month - 1, date + 1).getTime(), page: page ?? 1, pageSize: size ?? HISTORY_PAGE.fallback, machines };
}

/** Settings' server facts when the start-up code gives none (tests). */
const NO_SERVER_FACTS: ServerFacts = { host: '', port: 0, allowedHosts: [], logLevel: '' };

export function createFleetRouter(fleet: Fleet, { token = null, logger = silentLogger, lockout, onSignIn, server = NO_SERVER_FACTS }: FleetRouterOptions = {}): Router {
  const router = Router();
  const reportJson = express.json({ limit: BODY_LIMIT, type: JSON_TYPES });

  /** The refused reports, newest first, at most MAX_REFUSALS; Machines lists them with the refused exports (GET /refusals). */
  const refusals: RefusalView[] = [];
  const noteRefusal = (req: Request, status: number, reason: string, body?: unknown): void => {
    refusals.unshift({ at: fleet.now(), address: sourceAddress(req.ip), ...machineIn(body, req.get(MACHINE_HEADER)), status, reason: reason.slice(0, REASON_CHARS) });
    refusals.splice(MAX_REFUSALS);
  };
  /** The log line for a request turned away for its secret. */
  const logTokenRefusal = (req: Request, reason: string): void =>
    logger.warn(`sitrep: refused ${req.method} ${routeName(req)} from ${sourceAddress(req.ip)}: ${reason}`);

  /**
   * Claude Code exports every few seconds, so one fault recurs on every export: a refused export is kept as one entry per machine,
   * status and reason, whose time each repeat refreshes (so it stays in Machines' last hour while it lasts), apart from the /report
   * refusals so a repeat never replaces one of those, and logged (`log`, else the warning) only when its entry is new.
   */
  const telemetryRefusals = new Map<string, RefusalView>();
  const telemetryRefusal = (req: Request, status: number, reason: string, log?: () => void): void => {
    const machineId = machineIn(undefined, req.get(MACHINE_HEADER)).machineId;
    const text = reason.slice(0, REASON_CHARS);
    const key = `${machineId ?? ''}\u0000${String(status)}\u0000${text}`;
    const seen = telemetryRefusals.delete(key);
    telemetryRefusals.set(key, { at: fleet.now(), address: sourceAddress(req.ip), machineId, machineName: null, status, reason: text });
    if (telemetryRefusals.size > MAX_REFUSALS) telemetryRefusals.delete(telemetryRefusals.keys().next().value!);
    if (seen) return;
    if (log) log();
    else logger.warn(`sitrep: refused Claude Code telemetry from ${machineId ?? sourceAddress(req.ip)} (HTTP ${String(status)}): ${reason}`);
  };

  /**
   * Passes a request that carries the admin secret (every request while the server has none) and records who it is for the
   * handler. Any other is answered 401, and the refusal goes to `onRefused`, which logs it unless told otherwise.
   */
  const tokenCheck =
    (onRefused: (req: Request, reason: string) => void = logTokenRefusal): RequestHandler =>
    (req: Request, res: Response, next: NextFunction): void => {
      const who = identify(token, req.get(TOKEN_HEADER));
      if ('kind' in who) {
        res.locals.identity = who;
        return next();
      }
      onRefused(req, who.refused);
      refuse(res, 401, `missing or wrong ${TOKEN_HEADER}`, '$');
    };
  const requireToken = tokenCheck();

  const signIn = signIns(fleet, token);
  /**
   * The sign-in to view: while `requireSignInToView` is on, a browser read without a live sign-in is refused before anything is
   * read or a stream opens. A request carrying the admin secret in TOKEN_HEADER passes too, as the reporters' routes take it (the
   * doctor script reads /state so): whoever holds it can sign in anyway. Signing in and out, `/respond/me` (whether the caller is
   * signed in), /health, the UI's files and the reporters' routes stay open, and the answer and admin routes keep their own check.
   */
  const viewGate: RequestHandler = (req, res, next) => {
    const who = identify(token, req.get(TOKEN_HEADER));
    const holdsSecret = 'kind' in who && who.kind === 'admin';
    if (!fleet.settings.requireSignInToView || holdsSecret || signIn.live(req, res)) return next();
    refuse(res, 401, VIEW_GATED, '$');
  };

  /** A body its parser turned away (too large, not JSON) is noted by `note`; the handler at the end of the router answers it. */
  const parserRefusal =
    (note: (req: Request, status: number, reason: string) => void): ErrorRequestHandler =>
    (err: Parameters<typeof failureOf>[0], req, _res, next) => {
      const { status, error } = failureOf(err);
      if (status < 500) note(req, status, error);
      next(err);
    };

  const reportTokenRefusal = (req: Request, reason: string): void => {
    logTokenRefusal(req, reason);
    noteRefusal(req, 401, reason);
  };
  router.post('/report', tokenCheck(reportTokenRefusal), reportJson, (req: Request, res: Response) => {
    const checked = validateReport(req.body);
    if (!checked.ok) {
      logger.warn(`sitrep: rejected report at ${checked.path}: ${checked.error}`);
      noteRefusal(req, 400, `${checked.path}: ${checked.error}`, req.body);
      return refuse(res, 400, checked.error, checked.path);
    }
    try {
      res.json(acceptReport(fleet, token, checked.report, ownerOf(identityOf(res))));
    } catch (err) {
      logger.error(`sitrep: ingest failed for session ${checked.report.session.id}: ${(err as Error).message}`);
      refuse(res, 500, 'ingest failed', '$');
    }
  }, parserRefusal(noteRefusal));

  // Claude Code's own telemetry, OTLP/HTTP JSON logs, whose `api_request` events are Claude's only source of usage; the
  // records name no machine, so MACHINE_HEADER does. Answered as OTLP has it (opentelemetry.io/docs/specs/otlp): 200 with `{}`, or
  // a partial success counting the `api_request` records rejected; neither is retried, nor a 4xx. A failed ingest is a 503, which
  // the exporter retries, safely: a request counted before is skipped by its id.
  const telemetryJson = express.json({ limit: TELEMETRY_BODY_LIMIT });
  router.post('/v1/logs', tokenCheck((req, reason) => telemetryRefusal(req, 401, reason)), telemetryJson, (req: Request, res: Response) => {
    const turnAway = (status: number, reason: string): void => {
      telemetryRefusal(req, status, reason);
      refuse(res, status, reason, '$');
    };
    if (!req.is('application/json')) return turnAway(415, 'expected OTLP/HTTP JSON (protocol http/json)');
    const machineId = req.get(MACHINE_HEADER) ?? '';
    if (!MACHINE_ID.test(machineId)) return turnAway(400, `missing or bad ${MACHINE_HEADER}`);
    const { requests, rejected } = apiRequestsOf(req.body, fleet.now());
    try {
      fleet.ingestRequests(machineId, requests);
    } catch (err) {
      const message = (err as Error).message;
      // Keyed by its message too, so a different failure on the same machine is shown and logged.
      telemetryRefusal(req, 503, `ingest failed: ${message}`, () => logger.error(`sitrep: telemetry ingest failed for machine ${machineId}: ${message}`));
      return refuse(res, 503, 'ingest failed', '$');
    }
    if (rejected === 0) return void res.json({});
    const missing = 'no request id, session id, model or token counts';
    // The rest were taken, but these records were refused and their usage is lost: Machines shows them like any refusal.
    telemetryRefusal(req, 200, `some api_request records (the rest were taken): ${missing}`);
    res.json({ partialSuccess: { rejectedLogRecords: String(rejected), errorMessage: `${String(rejected)} api_request records left out: ${missing}` } });
  }, parserRefusal(telemetryRefusal));

  router.get('/state', viewGate, (_req, res) => void res.json(fleet.state()));

  router.get('/stream', viewGate, (req, res) => {
    res.status(200);
    for (const [name, value] of Object.entries(STREAM_HEADERS)) res.setHeader(name, value);
    if (fleet.hub.isFull) return void res.end(STREAM_FULL);
    res.flushHeaders();
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    const sink = {
      write: (chunk: string): void => {
        // Throwing tells the hub this client has gone, and it is dropped: the response has ended, or is destroyed, which is also how
        // Node marks it when the client disconnects. (`res.writable` stays true after all three, so it cannot tell.)
        if (res.writableEnded || res.destroyed) throw new Error('stream closed');
        res.write(chunk);
      },
      end: (): void => void res.end(),
    };
    const id = fleet.hub.add(sink, formatSse('snapshot', fleet.state()));
    // No id: the client left while it was being added, so there is nothing to clean up.
    if (id === null) return;
    const leave = (): void => fleet.hub.remove(id);
    req.on('close', leave);
    res.on('error', leave);
  });

  router.get('/sessions/:id', viewGate, (req, res) => {
    const view = fleet.view(req.params.id);
    if (view) res.json(view);
    else refuse(res, 404, 'unknown session', '$.id');
  });

  // An agent's whole prompt and answer, fetched only when the UI opens them: at tens of kilobytes they stay out of the state and
  // the stream.
  router.get('/sessions/:id/agents/:agentId/text', viewGate, (req, res) => {
    const texts = fleet.db.agentTexts(req.params.id, req.params.agentId);
    if (texts) res.json(texts);
    else refuse(res, 404, 'no full text for this agent', '$.agentId');
  });

  // A loop's live activity (`@orchestrator` is the main loop). Each fetch takes or renews the viewer's lease for `every` seconds
  // and a margin, and the next report's reply asks the reporter for that loop's entries. Memory only; no secret.
  router.get('/sessions/:id/agents/:agentId/activity', viewGate, (req, res) => {
    const { id, agentId } = req.params;
    const known = fleet.db.getSession(id) !== undefined && (agentId === MAIN_LOOP || fleet.db.getAgents(id).some((a) => a.id === agentId));
    if (!known) return refuse(res, 404, 'unknown session or agent', '$.agentId');
    res.set('Cache-Control', 'no-store').json(activityBody(fleet, id, agentId, req.query.every));
  });

  // Deleting a session and every row under it takes the admin secret.
  router.delete('/sessions/:id', requireToken, ({ params }, res) => {
    if (!fleet.deleteSession(params.id)) return refuse(res, 404, 'unknown session', '$.id');
    res.json({ ok: true });
  });

  router.get('/events', viewGate, (req, res) => {
    const { sessionId } = req.query;
    const before = count(req.query.before);
    const limit = count(req.query.limit);
    if (before === 'bad' || limit === 'bad' || (sessionId !== undefined && typeof sessionId !== 'string')) return refuse(res, 400, 'bad query', '$.query');
    res.json({ events: fleet.events(Math.min(200, Math.max(1, limit ?? 50)), { sessionId: sessionId || null, before }) });
  });

  // Every day here is the server's local day, as Today and Week are; `today` is the server's today.
  router.get('/history', viewGate, (req, res) => {
    const today = localDay(fleet.now());
    const q = historyQuery(req.query, today);
    if ('error' in q) return refuse(res, 400, q.error, q.path);
    // A page past the end comes back as the last page.
    const { rows, total, page } = fleet.historyPage(q.from, q.to, q.page, q.pageSize, q.machines);
    res.json({ day: q.day, today, sessions: rows, total, page, pageSize: q.pageSize });
  });

  router.get('/health', (_req, res) => void res.json(fleet.health()));

  /** The server settings with their defaults, the server's facts, where the prices came from and the rows in use, and the models it could not price. */
  const settingsBody = (): SettingsBody => ({
    settings: fleet.settings,
    defaults: fleet.cfg.defaults,
    about: { version: serverVersion(), build: serverBuild(), ...server, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, startedAt: fleet.startedAt },
    prices: { ...fleet.pricing.source, rows: fleet.priceRows() },
    unpricedModels: fleet.unpricedModels(),
  });
  router.get('/settings', viewGate, (_req, res) => void res.json(settingsBody()));
  router.get('/refusals', viewGate, (_req, res) => void res.json({ refusals: [...refusals, ...telemetryRefusals.values()].sort((a, b) => b.at - a.at).slice(0, MAX_REFUSALS) }));

  const access = mountRespondRoutes(router, { fleet, token, logger, lockout: lockout ?? new Lockout(fleet.now), onSignIn, requireToken, identityOf, signIns: signIn });
  // ADMIN_BASE, below the /api/fleet mount.
  router.use('/admin', createAdminRouter({ fleet, access, settingsBody, logger }));

  router.use((_req, res) => refuse(res, 404, 'not found', '$'));

  const lastResort: ErrorRequestHandler = (err: Parameters<typeof failureOf>[0], req, res, _next) => {
    void _next;
    const { status, error } = failureOf(err);
    // A body too large or not JSON is the client's plain mistake; anything else is worth a line.
    if (err.type !== 'entity.too.large' && err.type !== 'entity.parse.failed') {
      logger.error(`sitrep: request failed (${String(status)}): ${err.type ?? err.message ?? 'error'} on ${req.method} ${routeName(req)}`);
    }
    refuse(res, status, error, '$');
  };
  router.use(lastResort);

  return router;
}
