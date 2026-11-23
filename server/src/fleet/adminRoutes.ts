// A signed-in person's actions, at ADMIN_BASE: change the server settings, remove machines, delete a stored session,
// rename one, download a backup or an export, leave feedback, claim a session, and claim, close or reopen an issue. They sit behind the answer routes' own guard and sign-in check (respondRoutes.ts), so a
// change needs the owner's sign-in, RESPOND_HEADER and this server's origin. Every refusal is `{ ok: false, error, path }`.
import { rmSync } from 'node:fs';
import { pipeline, Readable } from 'node:stream';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Fleet } from './fleet.js';
import type { BrowserAccess } from './respondRoutes.js';
import { sourceAddress } from './auth.js';
import { parsePatch } from './settings.js';
import { LIMITS, type Feedback, type SettingsBody } from './protocol.js';
import type { Logger } from '../logger.js';

export interface AdminDeps {
  fleet: Fleet;
  access: BrowserAccess;
  /** GET /settings's body, which the reply to a change repeats. */
  settingsBody(): SettingsBody;
  /** History's selection for a query, as JSONL lines; or why the query was refused. */
  exportOf(query: Request['query']): AsyncGenerator<string> | { error: string; path: string };
  logger: Logger;
}

const refuse = (res: Response, status: number, error: string, path = '$'): void => void res.status(status).json({ ok: false, error, path });

/** A display name from the browser: null clears it; otherwise 1 to LIMITS.name characters on one line, else undefined. */
function displayName(body: unknown): string | null | undefined {
  const name = (body as { name?: unknown } | null)?.name;
  if (name === null) return null;
  if (typeof name !== 'string') return undefined;
  const line = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return line.length >= 1 && line.length <= LIMITS.name ? line : undefined;
}

/** A value on one line from the browser, within `max`: null when absent or empty, undefined when it is not text. */
function oneLine(v: unknown, max: number): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null : undefined;
}

/** A longer text from the browser, its line breaks kept: null when absent or empty, undefined when it is not text. */
function someText(v: unknown, max: number): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v.trim().slice(0, max) || null : undefined;
}

/** Feedback from the browser, checked: a tag; a score, a value and a comment, each optional; the row it is on, if any. Undefined when it is not that. */
function feedbackIn(body: unknown): Pick<Feedback, 'rowId' | 'key' | 'score' | 'value' | 'comment'> | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const [key, value, rowId, comment] = [oneLine(b.key, LIMITS.name), oneLine(b.value, LIMITS.short), oneLine(b.rowId, LIMITS.id), someText(b.comment, LIMITS.feedbackComment)];
  const score = b.score === null || b.score === undefined ? null : typeof b.score === 'number' && Number.isFinite(b.score) ? b.score : undefined;
  if (!key || value === undefined || rowId === undefined || comment === undefined || score === undefined) return undefined;
  return { rowId, key, score, value, comment };
}

type IssueAct = Parameters<Fleet['actOnIssue']>[2];

export function createAdminRouter({ fleet, access, settingsBody, exportOf, logger }: AdminDeps): Router {
  const admin = Router();
  const from = (req: Request): string => sourceAddress(req.ip);

  admin.use(access.guard, express.json({ limit: '64kb' }), (req, res, next) => {
    if (access.signedIn(req, res)) return next();
    logger.warn(`sitrep: refused ${req.method} ${req.baseUrl}${req.path} from ${from(req)}: not signed in`);
    refuse(res, 403, 'not signed in');
  });

  admin.put('/settings', (req, res) => {
    const read = parsePatch(req.body);
    if ('error' in read) return refuse(res, 400, read.error, read.path);
    fleet.changeSettings(read.patch);
    logger.info(`sitrep: settings changed from ${from(req)}: ${Object.keys(read.patch).join(', ') || 'nothing'}`);
    res.json(settingsBody());
  });

  admin.delete('/machines/:id', (req, res) => {
    const id = req.params.id;
    const state = fleet.machineStateOf(id);
    if (state === undefined) return refuse(res, 404, 'unknown machine', '$.id');
    if (state === 'reporting') return refuse(res, 409, 'machine is reporting', '$.id');
    res.json({ removed: fleet.removeMachines((m) => m.id === id) });
  });

  admin.post('/machines/remove-silent', (_req, res) => {
    res.json({ removed: fleet.removeMachines((m) => m.state === 'silent' || m.state === 'restart') });
  });

  admin.delete('/sessions/:id', (req, res) => {
    const id = req.params.id;
    if (fleet.isLive(id)) return refuse(res, 409, 'session is live', '$.id');
    if (!fleet.deleteSession(id)) return refuse(res, 404, 'unknown session', '$.id');
    logger.info(`sitrep: session ${id} deleted from ${from(req)}`);
    res.json({ ok: true });
  });

  admin.put('/sessions/:id/name', (req, res) => {
    const name = displayName(req.body);
    if (name === undefined) return refuse(res, 400, `name must be 1 to ${String(LIMITS.name)} characters, or null`, '$.name');
    if (!fleet.rename(req.params.id, name)) return refuse(res, 404, 'unknown session', '$.id');
    res.json({ ok: true });
  });

  // The copy is written off the event loop; Express 4 answers a rejected promise only when it is passed on (`next`).
  admin.get('/backup', (req, res, next) => {
    fleet.backup().then((file) => {
      const day = new Date(fleet.now()).toISOString().slice(0, 10);
      logger.info(`sitrep: backup downloaded from ${from(req)}`);
      res.download(file, `sitrep-${day}.sqlite`, () => rmSync(file, { force: true }));
    }, next);
  });

  // History's current range and filter as JSONL, streamed a page of lines at a time so a large export is never held whole. `pipeline`
  // ends the lines when the download stops part way, and takes an error in producing them instead of letting it end the process.
  admin.get('/export', (req, res) => {
    const lines = exportOf(req.query);
    if ('error' in lines) return refuse(res, 400, lines.error, lines.path);
    logger.info(`sitrep: export downloaded by ${access.name(req)} from ${from(req)}`);
    res.attachment(`sitrep-${new Date(fleet.now()).toISOString().slice(0, 10)}.jsonl`).type('application/x-ndjson');
    pipeline(Readable.from(lines), res, () => undefined);
  });

  admin.post('/sessions/:id/feedback', (req, res) => {
    const feedback = feedbackIn(req.body);
    if (!feedback) return refuse(res, 400, `feedback needs a tag of 1 to ${String(LIMITS.name)} characters; a score is a number, a value and a comment are text`);
    if (!fleet.db.getSession(req.params.id)) return refuse(res, 404, 'unknown session', '$.id');
    res.json({ ok: true, feedback: fleet.db.addFeedback(req.params.id, { ...feedback, by: access.name(req), at: fleet.now() }) });
  });

  admin.delete('/feedback/:id', (req, res) => {
    if (!fleet.db.deleteFeedback(Number(req.params.id))) return refuse(res, 404, 'unknown feedback', '$.id');
    res.json({ ok: true });
  });

  // Claiming restricts nothing: it only says who is on it. The first claim wins, and 409 names the holder.
  admin.post('/sessions/:id/claim', (req, res) => {
    const out = fleet.claim(req.params.id, access.name(req));
    if (out.ok) return void res.json(out);
    res.status(409).json({ ok: false, error: out.why === 'held' ? `claimed by ${out.claim.by}` : 'nothing to claim', ...(out.why === 'held' ? { claim: out.claim } : {}) });
  });

  /** A route that does one thing to an issue as the signed-in person; `act` reads what from the body, null when the body does not say. */
  const onIssue =
    (act: (body: unknown) => IssueAct | null): RequestHandler =>
    (req, res) => {
      const what = act(req.body);
      if (!what) return refuse(res, 400, 'expected as: resolved or flagged', '$.as');
      const out = fleet.actOnIssue(req.params.key!, access.name(req), what);
      if (out.ok) return void res.json(out);
      if (out.why === 'unknown') return refuse(res, 404, 'unknown issue', '$.key');
      res.status(409).json({ ok: false, error: out.why === 'held' ? `claimed by ${out.issue?.claim?.by ?? 'someone'}` : 'the issue is closed', issue: out.issue });
    };
  admin.post('/issues/:key/claim', onIssue(() => ({ do: 'claim' })));
  admin.post('/issues/:key/close', onIssue((body) => {
    const { as, reason } = (body ?? {}) as { as?: unknown; reason?: unknown };
    return as === 'resolved' || as === 'flagged' ? { do: 'close', as, reason: someText(reason, LIMITS.feedbackComment) ?? null } : null;
  }));
  admin.post('/issues/:key/reopen', onIssue(() => ({ do: 'reopen' })));

  return admin;
}
