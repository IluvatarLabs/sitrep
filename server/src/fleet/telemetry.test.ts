// Claude usage from Claude Code's own telemetry: each API request books its price once however often its export is resent,
// and a session's usage, its agent's and its samples are its requests' sums, whether they arrived before its first report or after;
// a report's own usage books nothing.
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { FleetDb, openDb, sessionKey } from './db.js';
import { localDay } from './days.js';
import { Fleet } from './fleet.js';
import { Pricing } from './pricing.js';
import { createFleetRouter } from './routes.js';
import { MACHINE_HEADER, TOKEN_HEADER } from './protocol.js';
import { fixture, TEST_CONFIG } from './testing.js';

const SECRET = 'a-long-test-secret-for-the-telemetry-000';
const T0 = 1_791_648_000_000;
const SESSION = fixture('claude').session.id;
const MACHINE = fixture('claude').machine.id;

/** One `api_request` record as Claude Code 2.1.319 exports it (OTLP JSON, ints as decimal strings), with attributes the server drops. */
function apiRequest(id: string, agent: string | null, [input, output, cacheRead, write5m, write1h]: number[]) {
  const values: Record<string, unknown> = {
    'event.name': 'api_request', 'session.id': SESSION, 'user.email': 'dev@example.com', model: 'claude-test-5', request_id: id,
    input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_creation_tokens: write5m + write1h,
    cache_creation_5m_tokens: write5m, cache_creation_1h_tokens: write1h, ...(agent ? { agent_id: agent } : {}),
  };
  const attributes = Object.entries(values).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } }));
  return { timeUnixNano: (BigInt(T0) * 1_000_000n).toString(), body: { stringValue: 'claude_code.api_request' }, attributes: [...attributes, { key: 'cost_usd', value: { doubleValue: 9.99 } }] };
}
const exportOf = (...logRecords: unknown[]) => ({ resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] }, scopeLogs: [{ logRecords }] }] });

describe('Claude Code telemetry', () => {
  it('books each request once, at its own tier, and makes the session’s, its agent’s and its samples’ usage from the requests', async () => {
    let now = T0;
    const prices = (k: number) => ({ input: k, output: 2 * k, cacheRead: 0.1 * k, cacheWrite: 1.25 * k, cacheWrite1h: 2 * k });
    const fleet = new Fleet(new FleetDb(openDb(':memory:')), TEST_CONFIG, new Pricing({ 'claude-test-5': { label: 'Test', std: prices(1), long: prices(2) } }), () => now);
    const app = express().use('/api/fleet', createFleetRouter(fleet, { token: SECRET }));
    const post = (body: object) => request(app).post('/api/fleet/v1/logs').set(TOKEN_HEADER, SECRET).set(MACHINE_HEADER, MACHINE).send(body);
    const spent = () => fleet.kpis().costToday;
    // Main loop, std: 1,000 × $1 + 2,000 × $2 + 10,000 × $0.10 + 4,000 1-hour writes × $2 = $0.014. The agent's prompt is 112,000
    // tokens, so long: 50,000 × $2 + 1,000 × $4 + 60,000 × $0.20 + 2,000 5-minute writes × $2.50 = $0.121.
    const batch = exportOf(apiRequest('req_1', null, [1000, 2000, 10_000, 0, 4000]), apiRequest('req_2', 'a1', [50_000, 1000, 60_000, 2000, 0]));
    expect((await post(batch)).body).toEqual({});
    expect(spent()).toBeCloseTo(0.135, 9);
    await post(batch); // The exporter resends it.
    expect(spent()).toBeCloseTo(0.135, 9);
    // The session's first report, from a plugin that still sends its own usage: the requests that came first are its usage.
    const r = fixture('claude');
    r.reporter.version = '0.2.1';
    r.session.usageByModel = [{ model: 'claude-test-5', tier: 'std', tokens: { input: 9e6, output: 9e6, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } }];
    await request(app).post('/api/fleet/report').set(TOKEN_HEADER, SECRET).send(r);
    const id = sessionKey(SESSION, MACHINE);
    expect(fleet.view(id)).toMatchObject({ tokensTotal: 17_000 + 113_000, costUsd: expect.closeTo(0.135, 9) });
    expect(fleet.view(id)?.agents.find((a) => a.id === 'a1')).toMatchObject({ tokens: { input: 50_000, output: 1000, cacheRead: 60_000, cacheWrite: 2000 }, costUsdEst: expect.closeTo(0.121, 9) });
    expect(spent()).toBeCloseTo(0.135, 9);
    // A later request raises the session and its sample in the second it arrives: 500 output tokens, $0.001.
    now = T0 + 2000;
    await post(exportOf(apiRequest('req_3', null, [0, 500, 0, 0, 0])));
    now = T0 + 3000;
    expect(fleet.view(id)?.series.tokensPerSec.at(-1)).toBe(500);
    expect(spent()).toBeCloseTo(0.136, 9);
    expect(fleet.db.spendRecord(localDay(T0), localDay(T0)).rows).toEqual([expect.objectContaining({ machineId: MACHINE, provider: 'claude', model: 'claude-test-5' })]);
    fleet.close();
  });
});
