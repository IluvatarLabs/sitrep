// Server start-up: configuration from the environment and an optional .env file at the repository
// root, the database, the fleet, the sweeper, the routes, the built UI, and a clean shutdown.
import { config as loadEnv } from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { FleetDb, openDb } from './fleet/db.js';
import { configFromEnv, Fleet } from './fleet/fleet.js';
import { createFleetRouter } from './fleet/routes.js';
import { loadPricing } from './fleet/pricing.js';
import { startSweeper } from './fleet/sweeper.js';
import { REPORTER_SUPPORT } from './fleet/compat.js';
import { createRouter } from './routes.js';
import { createLogger, parseLevel } from './logger.js';
import { inlineScriptHashes, securityHeaders } from './securityHeaders.js';
import { hostCheck, parseAllowedHosts } from './hostCheck.js';
import { createPlainHttpWatch } from './plainHttp.js';

// This file runs from server/src (tsx) or server/dist (built), both two levels below the repository root.
const REPO_ROOT = path.join(import.meta.dirname, '..', '..');
// quiet: dotenv prints an "injected env" line at startup otherwise.
loadEnv({ path: path.join(REPO_ROOT, '.env'), quiet: true });

const env = process.env;
const PORT = env.PORT ? Number(env.PORT) : 7487;
const HOST = env.HOST || '127.0.0.1';
const DB_PATH = env.SITREP_DB || path.join(REPO_ROOT, 'data', 'sitrep.sqlite');
// The owner's price overrides, laid over the shipped copy of LiteLLM's table and its refresh at start (pricing.ts).
const PRICES_PATH = env.SITREP_PRICES || path.join(REPO_ROOT, 'server', 'prices.json');
const PRICE_SNAPSHOT_PATH = path.join(REPO_ROOT, 'server', 'model_prices_and_context_window.json');
const TOKEN = env.SITREP_TOKEN || null;
const LOG_LEVEL = parseLevel(env.SITREP_LOG_LEVEL) ?? 'info';
const ALLOWED_HOSTS = parseAllowedHosts(env.SITREP_ALLOWED_HOSTS);

const logger = createLogger({ level: LOG_LEVEL, secrets: TOKEN ? [TOKEN] : [] });
// A short hand-set secret can be guessed. Never print the secret.
if (TOKEN && TOKEN.length < 24) logger.warn(`sitrep: SITREP_TOKEN is only ${String(TOKEN.length)} characters; use at least 24`);
if (!TOKEN) logger.warn('sitrep: SITREP_TOKEN is not set, so reports are taken from anyone and responding is off');

// A bad setting or prices file stops the server here, with the setting or row at fault, as does the sign-in gate set on with no
// admin secret. LiteLLM out of reach does not: the shipped copy of its table prices this start, and Settings says so.
const fleetConfig = configFromEnv(env, { home: os.homedir(), dbPath: DB_PATH });
if (fleetConfig.defaults.requireSignInToView && !TOKEN) throw new Error('SITREP_REQUIRE_SIGN_IN_TO_VIEW is on but SITREP_TOKEN is not set, so nobody could sign in; set the token or turn the setting off');
const pricing = await loadPricing({ snapshot: PRICE_SNAPSHOT_PATH, overrides: PRICES_PATH });
if (pricing.source.error) logger.warn(`sitrep: LiteLLM's prices could not be fetched (${pricing.source.error}); using the copy shipped with the server, as of ${pricing.source.asOf}`);
const fleet = new Fleet(new FleetDb(openDb(DB_PATH)), fleetConfig, pricing, Date.now, logger);
if (fleet.settings.requireSignInToView && !TOKEN) logger.warn('sitrep: requireSignInToView is on but SITREP_TOKEN is not set, so nobody can sign in to view');
const stopSweeper = startSweeper(fleet, logger);

const app = express();
app.disable('x-powered-by');
const frontendDist = path.join(REPO_ROOT, 'frontend', 'dist');
const pagePath = path.join(frontendDist, 'index.html');
const pageScripts = pageScriptHashes(pagePath);
// Signing in works whenever there is an admin secret, so the plain-HTTP warning follows the secret, not the answering switch.
const plainHttp = createPlainHttpWatch({ bind: HOST, signInOn: TOKEN !== null, logger });
// First, ahead of every route: a name that is not ours is a page on another site rebound to this address.
app.use(hostCheck({ bind: HOST, allowed: ALLOWED_HOSTS, logger }));
app.use(securityHeaders(pageScripts));
const server = { host: HOST, port: PORT, allowedHosts: ALLOWED_HOSTS, logLevel: LOG_LEVEL };
app.use('/api/fleet', createFleetRouter(fleet, { token: TOKEN, logger, onSignIn: plainHttp.onSignIn, server }));
app.use(createRouter());

app.use(express.static(frontendDist));
// A cap on page fetches from one address for the route that serves index.html; no API call counts.
const pageLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, message: 'too many requests' });
app.get('*', pageLimiter, (_req, res) => {
  res.sendFile(pagePath);
});

const listener = app.listen(PORT, HOST, () => {
  const { respond, activityFeed, requireSignInToView, lifecycle } = fleet.settings;
  const ranges = Object.entries(REPORTER_SUPPORT).map(([name, { min, max }]) => `${name} ${min}–${max}`).join(', ');
  logger.info(`SITREP server listening on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${String(PORT)} (database ${DB_PATH}, prices ${pricing.source.source} as of ${pricing.source.asOf}, overrides ${PRICES_PATH})`);
  logger.info(
    `sitrep: auth ${TOKEN ? 'on' : 'off'}, respond ${respond ? 'on' : 'off'}, activity feed ${activityFeed ? 'on' : 'off'}, sign-in to view ${requireSignInToView ? 'on' : 'off'}; ` +
      `${ranges}; ` +
      `remove after ${String(lifecycle.removeAfterMs)} ms, linger ${String(lifecycle.lingerMs)} ms`,
  );
  plainHttp.atStart();
});

/**
 * The hashes of the built page's inline scripts, the only inline scripts the content security policy lets run; none when there
 * is no built UI, or when the page cannot be read (logged).
 */
function pageScriptHashes(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  try {
    return inlineScriptHashes(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger.warn(`sitrep: no inline script allowed by the content security policy: ${(err as Error).message}`);
    return [];
  }
}

/** How long a connection still open at shutdown, such as a reporter's held answer request, may run before the process exits anyway. */
const GRACE_MS = 2000;
let stopping = false;

/** Stops once, on the first signal: clocks, then every stream, then new connections; the database closes when the last one has. */
function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  logger.info(`sitrep: ${signal} received, stopping`);
  stopSweeper();
  fleet.close();
  const exit = (): never => process.exit(0);
  listener.close(() => {
    fleet.db.close();
    exit();
  });
  setTimeout(exit, GRACE_MS).unref();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop(signal));
