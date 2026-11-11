// The answer routes, the reporters' and the browser's, mounted on the fleet router in single-owner mode.
//
// The reporters' routes (announce an ask, hold for its answer, say an ask closed, say what became of a delivery) take the admin
// secret in TOKEN_HEADER, checked as for a report, and only for a session that belongs to Admin. The browser's routes sit under
// /respond and need a sign-in as Admin with that secret: a random id in an HttpOnly, SameSite=Strict cookie scoped to /api, kept
// in SQLite only as the SHA-256 of the secret and the id together, so a sign-in outlives a restart but not a new secret. It lasts
// 400 days unused and each use renews it. A browser change must carry `X-Sitrep-Respond: 1` and, if it names an Origin, come
// from this server's own host; there is no CORS. The admin routes reuse the same guard and sign-in (adminRoutes.ts). The text of
// an answer, a question or a plan is never logged or stored here.
import { randomBytes } from 'node:crypto';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Fleet } from './fleet.js';
import { ADMIN_OWNER, digest, matchesSecret, nameKey, sourceAddress, type Identity, type Lockout } from './auth.js';
import { logWords, shortDeliveryId, type AnswerError, type DeliveryTrail, type DropWhy } from './respond.js';
import { ASK_CLOSE_OUTCOMES, DELIVERY_RESULTS, RESPOND_LIMITS, validateAsk, type Delivery, type DeliveryResult, type ReportReply, type RespondMe } from './protocol.js';
import type { SessionRow } from './db.js';
import { providerOf } from './derive.js';
import type { Logger } from '../logger.js';

export interface RespondDeps {
  fleet: Fleet;
  /** The admin secret; null turns authentication off, and responding with it. */
  token: string | null;
  /** The report route's check of TOKEN_HEADER, which the reporters' routes reuse. */
  requireToken: RequestHandler;
  /** Who `requireToken` found the request to be. */
  identityOf(res: Response): Identity;
  /** Runs ahead of the sign-in to note a plain-HTTP connection; it never blocks. */
  onSignIn?: RequestHandler;
  /** Counts wrong sign-ins by address, and locks an address out for a while. */
  lockout: Lockout;
  /** The owner's sign-ins. */
  signIns: SignIns;
  /** The server log, which is never handed an answer's text or a secret. */
  logger: Logger;
}

export const RESPOND_COOKIE = 'sitrep_respond';
/** The header every browser change must carry. */
export const RESPOND_HEADER = 'X-Sitrep-Respond';
const COOKIE_PATH = '/api';
/** How long a sign-in lasts unused: the browsers' cap on a cookie's life (RFC 6265bis, 400 days). */
const SIGN_IN_MAX_AGE_MS = 400 * 86_400_000;
const MAX_SIGN_INS = 200;
/** The ask a reporter announces, holds for, and closes; the browser reads and answers it at the same path below /respond. */
const ASK_PATH = '/sessions/:id/asks/:askId';

/** A cookie's value from the request's Cookie header; null when it is not there. */
function cookieValue(req: Request, name: string): string | null {
  const header = req.get('cookie') ?? '';
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

/** The address a request came from, as the log shows it. */
const fromAddress = (req: Request): string => sourceAddress(req.ip);

/** A refusal: `{ ok: false, error, ...extra }` with its status. */
function fail(res: Response, status: number, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ ok: false, error, ...extra });
}

/** An answer or message the store turned away, sent as its status with the rest as the body. */
function answerError(res: Response, { status, error, ...extra }: AnswerError): void {
  fail(res, status, error, extra);
}

/** An answer or message taken: 202, with its delivery's id and anything `extra` adds. */
function accepted(res: Response, delivery: Delivery, extra: Record<string, unknown> = {}): void {
  res.status(202).json({ ok: true, deliveryId: delivery.id, ...extra });
}

/** Whether the server answers sessions at all now: it has an admin secret, and both of its settings for it are on. */
const answeringAllowed = (fleet: Fleet, token: string | null): boolean => token !== null && fleet.respondFlagsOn();

/** How long a reporter asked to be held (`wait`, in seconds): 1 to RESPOND_LIMITS.holdSeconds, the most when it asked nothing readable. */
function holdSeconds(raw: unknown): number {
  const asked = typeof raw === 'string' && /^\d{1,3}$/.test(raw) ? Number(raw) : RESPOND_LIMITS.holdSeconds;
  return Math.max(1, Math.min(RESPOND_LIMITS.holdSeconds, asked));
}

/** Whether a request's Origin, when it sends one, is this server's own host; an Origin that does not parse is not. */
function fromThisOrigin(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

/** How the log says what became of a delivery: the result it came back with, or why the server let it go without one. */
const FATES: Readonly<Record<DeliveryResult | DropWhy, string>> = {
  took: 'the session took it',
  queued: 'the session queued it',
  'not-taken': 'the session did not take it',
  refused: 'the session refused it',
  closed: 'it arrived after its ask had closed',
  discarded: 'its sender took it back before the session got it',
  'ask-closed': 'its ask closed before the session got it',
  'session-ended': 'the session ended before saying what became of it',
  'queued-session-ended': 'the session ended while it was queued, so whether it was read is unknown',
  'session-deleted': 'the session was deleted before saying what became of it',
  'answering-off': 'answering or the activity feed went off before the session said what became of it',
};

/** The log line for what became of a delivery: what was done to which session, never what was said. */
function trailLine(t: DeliveryTrail): string {
  const what = `${logWords(t.delivery).toLowerCase()} in session ${t.sessionId} [${shortDeliveryId(t.delivery)}]`;
  const fate = t.kind === 'result' ? `came back ${t.result}: ${FATES[t.result]}` : `was dropped: ${FATES[t.why]}`;
  return `sitrep: ${what} ${fate}`;
}

/**
 * The owner's sign-ins: a random id in the browser's cookie, and in the database only the SHA-256 of the admin secret and the id
 * together, so a new secret (server.env and a restart) ends every sign-in made under the old one.
 */
export interface SignIns {
  /** Whether the request carries a live sign-in. Given the response, using it renews it, and its cookie with it. */
  live(req: Request, res?: Response): boolean;
  /** A new sign-in, its cookie set on the response; past MAX_SIGN_INS the least recently used one ends. */
  start(req: Request, res: Response): void;
  /** Ends the request's sign-in and clears its cookie; whether a sign-in ended. */
  end(req: Request, res: Response): boolean;
  /** Ends every sign-in and clears the request's cookie; how many ended. */
  endAll(res: Response): number;
}

export function signIns(fleet: Fleet, token: string | null): SignIns {
  const setCookie = (req: Request, res: Response, id: string): void =>
    void res.cookie(RESPOND_COOKIE, id, { httpOnly: true, sameSite: 'strict', path: COOKIE_PATH, secure: req.secure, maxAge: SIGN_IN_MAX_AGE_MS });
  const clearCookie = (res: Response): void => void res.clearCookie(RESPOND_COOKIE, { path: COOKIE_PATH });
  /** A sign-in's key in the database: bound to the secret it was made under. */
  const keyOf = (id: string): string => digest(`${token ?? ''}\u0000${id}`);
  return {
    live(req, res) {
      const id = cookieValue(req, RESPOND_COOKIE);
      if (token === null || !id) return false;
      const key = keyOf(id);
      const usedAt = fleet.db.signInUsedAt(key);
      if (usedAt === null) return false;
      const now = fleet.now();
      if (now - usedAt > SIGN_IN_MAX_AGE_MS) {
        fleet.db.endSignIns(key);
        return false;
      }
      // Renewed once per response, however many checks it passes.
      if (res && res.locals.signInRenewed !== true) {
        fleet.db.useSignIn(key, now, MAX_SIGN_INS);
        setCookie(req, res, id);
        res.locals.signInRenewed = true;
      }
      return true;
    },
    start(req, res) {
      const id = randomBytes(32).toString('hex');
      fleet.db.useSignIn(keyOf(id), fleet.now(), MAX_SIGN_INS);
      setCookie(req, res, id);
    },
    end(req, res) {
      const id = cookieValue(req, RESPOND_COOKIE);
      clearCookie(res);
      return id !== null && id !== '' && fleet.db.endSignIns(keyOf(id)) > 0;
    },
    endAll(res) {
      const ended = fleet.db.endSignIns();
      clearCookie(res);
      return ended;
    },
  };
}

/** What the admin routes reuse of the browser's routes: their guard against other sites, and the sign-in check. */
export interface BrowserAccess {
  /** No caching; a change must carry RESPOND_HEADER and come from this server's own origin when it names one. */
  guard: RequestHandler;
  /** Whether the request carries a live sign-in; using one renews it. */
  signedIn(req: Request, res: Response): boolean;
}

export function mountRespondRoutes(router: Router, d: RespondDeps): BrowserAccess {
  const { fleet, logger, lockout } = d;
  const now = fleet.now;
  // Answers, messages, results and sign-ins are small bodies; an announced ask, with its questions or plan, may be larger.
  const json = express.json({ limit: '64kb' });
  const askJson = express.json({ limit: '512kb' });

  /** Responding is allowed by the server; whether a session takes it is its reporter's to say. */
  const enabled = (): boolean => answeringAllowed(fleet, d.token);

  /** Refuses with a log line naming the route, the address and the reason, and nothing from the body. */
  const refuse = (req: Request, res: Response, status: number, reason: string): void => {
    logger.warn(`sitrep: refused ${req.method} ${req.baseUrl}${req.path} from ${fromAddress(req)}: ${reason}`);
    fail(res, status, reason);
  };

  /** A stored session that is in the live set; null otherwise. */
  const liveSession = (id: string): SessionRow | null => {
    const row = fleet.db.getSession(id);
    return row && fleet.isLive(row.id) ? row : null;
  };

  /** Logs what became of a delivery; a failed write must not leave the delivery half updated. */
  const logTrail = (t: DeliveryTrail): void => {
    try {
      logger.info(trailLine(t));
    } catch {
      // Dropped: the delivery's own update matters more than its log line.
    }
  };
  fleet.respond.trail = logTrail;

  // ---- reporters ----------------------------------------------------------------------------------

  /**
   * The live Admin session a reporter route is about, while responding is on; otherwise the refusal is sent and null returned. The
   * reporter names it by its id on the server, its own native id at its own machine (sessionKey).
   */
  const reporterSession = (req: Request, res: Response): SessionRow | null => {
    if (!enabled()) {
      refuse(req, res, 403, 'responding is off');
      return null;
    }
    const row = liveSession(req.params.id!);
    if (!row) {
      fail(res, 404, 'unknown session', { path: '$.id' });
      return null;
    }
    if (d.identityOf(res).kind !== 'admin' || row.owner !== ADMIN_OWNER) {
      refuse(req, res, 403, 'not your session');
      return null;
    }
    return row;
  };

  /** A reporter route's handler, run with its session once reporterSession has found it (it answers the request otherwise). */
  const withSession =
    (handle: (row: SessionRow, req: Request, res: Response) => unknown): RequestHandler =>
    (req, res) => {
      const row = reporterSession(req, res);
      if (row) return handle(row, req, res);
    };

  router.put(ASK_PATH, d.requireToken, askJson, withSession((row, req, res) => {
    const checked = validateAsk(req.body, providerOf(row));
    if (!checked.ok) {
      fail(res, 400, checked.error, { path: checked.path });
    } else if (checked.ask.id !== req.params.askId) {
      fail(res, 400, 'the ask id must match the path', { path: '$.id' });
    } else {
      const outcome = fleet.respond.announce(row.id, checked.ask);
      if (outcome === 'ok') res.json({ ok: true });
      else if (outcome === 'closed') fail(res, 409, 'closed');
      else fail(res, 429, `at most ${String(RESPOND_LIMITS.asks)} open asks per session`);
    }
  }));

  router.get(`${ASK_PATH}/answer`, d.requireToken, withSession(async (row, req, res) => {
    const seconds = holdSeconds(req.query.wait);
    res.set('Cache-Control', 'no-store');
    // A reporter that has given up is never handed an answer it will not read.
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    const out = await fleet.respond.hold(row.id, req.params.askId!, seconds * 1000, gone.signal);
    // Its reporter disconnected during the hold (Node then marks the response destroyed), or the response has ended: nobody would
    // read the answer. (`res.writable` stays true in both cases, so it cannot tell.)
    if (res.writableEnded || res.destroyed) return;
    switch (out.kind) {
      case 'delivery':
        res.json({ delivery: out.delivery });
        break;
      case 'none':
        res.status(204).end();
        break;
      case 'unknown':
        fail(res, 404, 'unknown ask');
        break;
      default:
        fail(res, 410, 'closed', { outcome: out.outcome });
    }
  }));

  router.post(`${ASK_PATH}/close`, d.requireToken, json, withSession((row, req, res) => {
    const { outcome: said, answer, at, planApproved } = (req.body ?? {}) as Record<string, unknown>;
    const outcome = ASK_CLOSE_OUTCOMES.find((o) => o === said);
    if (outcome === undefined) return fail(res, 400, 'expected outcome terminal, closed or ended', { path: '$.outcome' });
    // What the terminal answered, in short: one line, within the limit.
    const summary = typeof answer === 'string' ? answer.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, RESPOND_LIMITS.answer) : null;
    const closedAt = typeof at === 'number' && Number.isFinite(at) ? at : now();
    fleet.respond.close(row.id, req.params.askId!, { outcome, at: closedAt, answer: summary, planApproved: planApproved === true });
    logger.debug(`sitrep: an ask in session ${row.id} closed (${outcome})`);
    res.json({ ok: true });
  }));

  router.post('/sessions/:id/deliveries/:deliveryId/result', d.requireToken, json, withSession((row, req, res) => {
    const result = DELIVERY_RESULTS.find((r) => r === (req.body as { result?: unknown } | undefined)?.result);
    if (result === undefined) return fail(res, 400, `expected result ${DELIVERY_RESULTS.join(', ')}`, { path: '$.result' });
    const known = fleet.respond.result(row.id, req.params.deliveryId!, result) !== 'unknown';
    if (known) res.json({ ok: true });
    else fail(res, 404, 'unknown delivery');
  }));

  // ---- the owner's browser ------------------------------------------------------------------------

  /** Whether the request carries a live sign-in; using one renews it. */
  const signedIn = (req: Request, res: Response): boolean => d.signIns.live(req, res);

  /** With the sign-in to view on, an ended sign-in must not keep a stream open: every stream opens again through the check. */
  const reopenStreams = (): void => {
    if (fleet.settings.requireSignInToView) fleet.hub.closeAll();
  };

  /** Whether a browser may respond now: responding on and a live sign-in. Otherwise the refusal is sent and false returned. */
  const mayRespond = (req: Request, res: Response): boolean => {
    if (!enabled()) {
      refuse(req, res, 403, 'responding is off');
      return false;
    }
    if (!signedIn(req, res)) {
      refuse(req, res, 403, 'sign in to respond');
      return false;
    }
    return true;
  };

  /** The live session a signed-in browser responds to; otherwise the refusal is sent and null returned. */
  const browserSession = (req: Request, res: Response): SessionRow | null => {
    if (!mayRespond(req, res)) return null;
    const row = liveSession(req.params.id!);
    if (!row) fail(res, 404, 'unknown session', { path: '$.id' });
    return row;
  };

  /** A log line for each answer, message and command taken: what was done, never its text. */
  const audit = (req: Request, row: SessionRow, delivery: Delivery): void => {
    logger.info(`sitrep: ${logWords(delivery).toLowerCase()} in session ${row.id} [${shortDeliveryId(delivery)}] from ${fromAddress(req)}`);
  };

  const browser = Router();

  // Nothing here is cached. A change must also carry RESPOND_HEADER, which a page on another site cannot add without a preflight,
  // and come from this server's own origin when it names one; the cookie is SameSite=Strict besides.
  const guard: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (read || (fromThisOrigin(req) && req.get(RESPOND_HEADER) === '1')) return next();
    refuse(req, res, 403, 'refused: not sent by this dashboard');
  };

  browser.use(guard);
  browser.use(json);

  // Signing in works whenever there is an admin secret, answering on or off: Settings and the other admin actions need it too, and
  // the answer routes check `enabled()` themselves. Open under the sign-in to view: it says only whether the caller is signed in,
  // which the sign-in screen needs.
  browser.get('/me', (req, res) => {
    const on = enabled();
    const inNow = d.token !== null && signedIn(req, res);
    const me: RespondMe = { enabled: on, signedIn: inNow, name: inNow ? ADMIN_OWNER : null, admin: inNow };
    res.json(me);
  });

  const beforeSignIn: RequestHandler[] = d.onSignIn ? [d.onSignIn] : [];
  browser.post('/sign-in', ...beforeSignIn, (req, res) => {
    if (d.token === null) {
      refuse(req, res, 403, 'no admin secret');
      return;
    }
    const source = fromAddress(req);
    const lockedForMs = lockout.lockedFor(source);
    if (lockedForMs > 0) {
      fail(res, 429, 'too many wrong tries', { retryAfterSec: Math.ceil(lockedForMs / 1000) });
      return;
    }
    const body = (req.body ?? {}) as { name?: unknown; token?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!name || !token) {
      fail(res, 400, 'enter your name and your token');
      return;
    }
    // Only the admin secret, and only under the name Admin.
    if (nameKey(name) !== nameKey(ADMIN_OWNER) || !matchesSecret(d.token, token)) {
      const { n, locked } = lockout.fail(source);
      const lockNote = locked ? `; locked for ${String(Math.round(lockout.lockMs / 60_000))} minutes` : '';
      logger.warn(`sitrep: a sign-in to respond from ${source} was refused (${String(n)} wrong${lockNote})`);
      fail(res, 401, 'wrong name or token');
      return;
    }
    lockout.succeed(source);
    d.signIns.start(req, res);
    logger.info(`sitrep: Admin signed in to respond from ${source}`);
    res.json({ ok: true, name: ADMIN_OWNER, admin: true });
  });

  // Streams close only when a sign-in ended, so a sign-out with none, which anyone can send, closes nothing.
  browser.post('/sign-out', (req, res) => {
    if (d.signIns.end(req, res)) reopenStreams();
    res.json({ ok: true });
  });

  // Ends every sign-in on every device, this one's included.
  browser.post('/sign-out-everywhere', (req, res) => {
    if (!d.signIns.live(req)) return refuse(req, res, 403, 'not signed in');
    const ended = d.signIns.endAll(res);
    reopenStreams();
    logger.info(`sitrep: Admin signed out everywhere from ${fromAddress(req)} (${String(ended)} sign-ins ended)`);
    res.json({ ok: true });
  });

  /** A browser route's handler, run with the session once browserSession has found it (it answers the request otherwise). */
  const onSession =
    (handle: (row: SessionRow, req: Request, res: Response) => void): RequestHandler =>
    (req, res) => {
      const row = browserSession(req, res);
      if (row) handle(row, req, res);
    };

  browser.get(ASK_PATH, onSession((row, req, res) => {
    const detail = fleet.respond.detail(row.id, req.params.askId!, row.last_seen_at);
    if (detail) res.json(detail);
    else fail(res, 404, 'unknown ask');
  }));

  browser.post(`${ASK_PATH}/answer`, onSession((row, req, res) => {
    const out = fleet.respond.answer(row.id, req.params.askId!, ADMIN_OWNER, req.body);
    if (out.ok) {
      audit(req, row, out.delivery);
      return accepted(res, out.delivery);
    }
    // A malformed body is the browser's own mistake; any other refusal is worth a log line.
    if (out.err.status !== 400) logger.info(`sitrep: an answer to session ${row.id} was refused: ${out.err.error}`);
    answerError(res, out.err);
  }));

  browser.post('/sessions/:id/messages', onSession((row, req, res) => {
    const out = fleet.respond.message(row.id, ADMIN_OWNER, req.body);
    if (!out.ok) return answerError(res, out.err);
    audit(req, row, out.delivery);
    accepted(res, out.delivery, { queued: row.status === 'running' });
  }));

  /** Lets a request on only while the browser may respond (mayRespond answers it otherwise). */
  const respondGate: RequestHandler = (req, res, next) => {
    if (mayRespond(req, res)) next();
  };

  browser.delete('/deliveries/:deliveryId', respondGate, (req, res) => {
    const outcome = fleet.respond.discard(req.params.deliveryId!);
    if (outcome === 'ok') return void res.json({ ok: true });
    if (outcome === 'handed-over') fail(res, 409, 'handed over');
    else fail(res, 404, 'unknown delivery');
  });

  router.use('/respond', browser);
  return { guard, signedIn };
}

/** For the report route: whether the session takes answers now, and the messages and commands waiting for it. */
export function replyFor(fleet: Fleet, token: string | null, sessionId: string): Pick<ReportReply, 'respond' | 'deliveries'> {
  // A session that reported with the secret has an owner; one that did not cannot be answered.
  const respond = answeringAllowed(fleet, token) && (fleet.db.getSession(sessionId)?.owner ?? null) !== null;
  return { respond, deliveries: respond ? fleet.respond.handOverMessages(sessionId) : [] };
}
