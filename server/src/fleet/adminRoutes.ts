// The signed-in owner's actions, at ADMIN_BASE: change the server settings, remove machines, delete a stored session,
// rename one, and download a backup. They sit behind the answer routes' own guard and sign-in check (respondRoutes.ts), so a
// change needs the owner's sign-in, RESPOND_HEADER and this server's origin. Every refusal is `{ ok: false, error, path }`.
import { rmSync } from 'node:fs';
import express, { Router, type Request, type Response } from 'express';
import type { Fleet } from './fleet.js';
import type { BrowserAccess } from './respondRoutes.js';
import { sourceAddress } from './auth.js';
import { parsePatch } from './settings.js';
import { LIMITS, type SettingsBody } from './protocol.js';
import type { Logger } from '../logger.js';

export interface AdminDeps {
  fleet: Fleet;
  access: BrowserAccess;
  /** GET /settings's body, which the reply to a change repeats. */
  settingsBody(): SettingsBody;
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

export function createAdminRouter({ fleet, access, settingsBody, logger }: AdminDeps): Router {
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

  admin.get('/backup', (req, res) => {
    const file = fleet.backup();
    const day = new Date(fleet.now()).toISOString().slice(0, 10);
    logger.info(`sitrep: backup downloaded from ${from(req)}`);
    res.download(file, `sitrep-${day}.sqlite`, () => rmSync(file, { force: true }));
  });

  return admin;
}
