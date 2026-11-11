// The report route takes both reporters' contract fixtures with the admin secret and stores nothing sent without it, and Codex
// cost is priced server-side, unknown when unpriced.
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sessionKey } from './db.js';
import { createFleetRouter } from './routes.js';
import { REPORTER_SUPPORT } from './compat.js';
import { TOKEN_HEADER } from './protocol.js';
import { fixture, testFleet } from './testing.js';

const SECRET = 'a-long-test-secret-for-the-reports-00000';

function setup() {
  const fleet = testFleet(Date.now);
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: SECRET }));
  /** POSTs a report, with `secret` as the admin secret when given. */
  const post = (body: object, secret?: string) => {
    const req = request(app).post('/api/fleet/report');
    return (secret === undefined ? req : req.set(TOKEN_HEADER, secret)).send(body);
  };
  return { fleet, app, post };
}

describe('POST /api/fleet/report', () => {
  it('stores both reporters’ reports under Admin and answers with the range of the report’s own reporter', async () => {
    const { fleet, app } = setup();
    for (const provider of ['claude', 'codex'] as const) {
      const r = fixture(provider);
      const res = await request(app).post('/api/fleet/report').set(TOKEN_HEADER, SECRET).send(r);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, sessionId: r.session.id, ackedEvents: r.events.length, reporterSupport: REPORTER_SUPPORT[r.reporter.name], reporterCompat: 'ok' });
      expect(fleet.view(sessionKey(r.session.id, r.machine.id))).toMatchObject({ provider, owner: 'Admin', machine: r.machine });
    }
    expect(fleet.machines().map((m) => m.id).sort()).toEqual([fixture('claude').machine.id, fixture('codex').machine.id].sort());
    fleet.close();
  });

  it('stores nothing from a reporter that sends no secret or the wrong one', async () => {
    const { fleet, post } = setup();
    const r = fixture('codex');
    await post(r);
    await post(r, 'wrong');
    expect(fleet.view(sessionKey(r.session.id, r.machine.id))).toBeUndefined();
    fleet.close();
  });

  it('prices a Codex session from its usage with the price table, and leaves an unpriced model’s cost unknown, not $0', async () => {
    const { fleet, app } = setup();
    const r = fixture('codex');
    await request(app).post('/api/fleet/report').set(TOKEN_HEADER, SECRET).send(r);
    // gpt-6-sol: 328k × $2 + 41k × $10 + 1,512k × $0.20; gpt-6-luna: 52k × $0.10 + 6.1k × $0.50 + 230k × $0.01 (per million).
    expect(fleet.view(sessionKey(r.session.id, r.machine.id))?.costUsd).toBeCloseTo(1.3684 + 0.01055, 6);
    expect(fleet.view(sessionKey(r.session.id, r.machine.id))?.agents[0]?.costUsdEst).toBeCloseTo(0.01055, 6);
    const unpriced = fixture('codex');
    unpriced.session.id = 'unpriced';
    unpriced.session.model = 'gpt-unknown';
    unpriced.session.usageByModel = unpriced.session.usageByModel!.map((u) => ({ ...u, model: 'gpt-unknown' }));
    unpriced.agents = [];
    await request(app).post('/api/fleet/report').set(TOKEN_HEADER, SECRET).send(unpriced);
    expect(fleet.view(sessionKey('unpriced', unpriced.machine.id))?.costUsd).toBeNull();
    expect(fleet.kpis()).toMatchObject({ unpricedSessions: 1 });
    fleet.close();
  });
});
