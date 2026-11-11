// A report is stored once however often it is sent, and a session's end and revival follow the order reports arrive in.
import { beforeEach, describe, expect, it } from 'vitest';
import { FleetDb, openDb, sessionKey } from './db.js';
import { localDay } from './days.js';
import { Fleet } from './fleet.js';
import { ingestReport } from './ingest.js';
import { Pricing } from './pricing.js';
import type { Report } from './protocol.js';
import { fixture, TEST_CONFIG } from './testing.js';

const T0 = 1_791_648_000_000;
/** A report's session as the server stores it. */
const keyOf = (r: Report): string => sessionKey(r.session.id, r.machine.id);
let f: FleetDb;
beforeEach(() => {
  f = new FleetDb(openDb(':memory:'));
});

describe('ingestReport', () => {
  it('is idempotent for both reporters: a repeat adds no event or blowout and changes only last_seen_at', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const r = fixture(provider);
      expect(ingestReport(f, r, T0).newEvents).toHaveLength(r.events.length);
      const before = { ...f.getSession(keyOf(r))! };
      const agents = f.getAgents(keyOf(r));
      expect(ingestReport(f, r, T0 + 3000).newEvents).toEqual([]);
      expect({ ...f.getSession(keyOf(r))!, last_seen_at: before.last_seen_at }).toEqual(before);
      expect(f.getAgents(keyOf(r))).toEqual(agents);
      expect(f.countEvents(keyOf(r))).toBe(r.events.length);
    }
    expect(f.getBlowouts(keyOf(fixture('claude')))).toHaveLength(1);
  });

  it('keeps an agent a later report omits, and aborts the running ones when the session ends', () => {
    const first = fixture('claude');
    const stored = () => new Map(f.getAgents(keyOf(first)).map((agent) => [agent.id, agent]));
    ingestReport(f, first, T0);
    const withoutA2: Report = { ...first, events: [], agents: first.agents.filter(({ id }) => id !== 'a2') };
    ingestReport(f, withoutA2, T0 + 1000);
    expect(stored().get('a2')?.status).toBe('running');
    ingestReport(f, { ...withoutA2, session: { ...withoutA2.session, status: 'done', endReason: 'other' } }, T0 + 2000);
    const after = stored();
    expect(after.get('a2')).toMatchObject({ status: 'aborted', ended_at: T0 + 2000, tool_open: 0 });
    expect([after.get('a1')?.status, after.get('a3')?.status]).toEqual(['done', 'failed']);
  });

  it('keeps the first end time on a repeated final report, and revives the session when it reports running again', () => {
    const live = fixture('codex');
    const final = { ...live, session: { ...live.session, status: 'done' as const } };
    expect(ingestReport(f, final, T0).ended).toBe(true);
    ingestReport(f, final, T0 + 5000);
    expect(f.getSession(keyOf(live))?.ended_at).toBe(T0);
    expect(ingestReport(f, live, T0 + 9000).revived).toBe(true);
    expect(f.getSession(keyOf(live))).toMatchObject({ ended_at: null, status: 'waiting' });
  });

  it('records what a session spends, once, whatever its reporter does', () => {
    const price = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
    const pricing = new Pricing({ 'gpt-6-sol': { label: 'Sol', std: price(1) }, 'gpt-6-astra': { label: 'Astra', std: price(2) } });
    const recorded = () => f.spendRecord(localDay(T0), localDay(T0)).rows.reduce((sum, r) => sum + (r.today ?? 0), 0);
    let at = T0;
    const send = (r: Report, session: Partial<Report['session']>, input: number, gapMs: number) => {
      at += gapMs;
      ingestReport(f, { ...r, agents: [], events: [], session: { ...r.session, ...session, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 } } }, at, null, pricing);
      return recorded();
    };
    const codex = fixture('codex');
    const row = (model: string, millions: number) => ({ model, tier: 'std' as const, tokens: { input: millions * 1e6, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } });
    const usage = (sol: number, astra = 0, gapMs = 2000) => send(codex, { usageByModel: [row('gpt-6-sol', sol), ...(astra ? [row('gpt-6-astra', astra)] : [])] }, (sol + astra) * 1e6, gapMs);
    expect(usage(1)).toBe(0); // A session's first figure only sets its starting point.
    expect(usage(3, 0, 600_000)).toBe(2); // After a reporter was down, all that was spent meanwhile, at once.
    expect(usage(3.5)).toBeCloseTo(2.5);
    // A restarted reporter sends no usage until it has read every file of the session, then its whole figure.
    expect(send(codex, { usageByModel: undefined }, 0, 2000)).toBeCloseTo(2.5);
    expect(usage(4)).toBeCloseTo(3);
    expect(usage(3)).toBeCloseTo(3); // A session file gone: the figure falls and the mark holds.
    expect(usage(4)).toBeCloseTo(3); // Back again, it is not booked twice.
    expect(usage(4, 0.5)).toBeCloseTo(4); // A second model.
  });

  it('restarts at start the spend marks of only the sessions on a model whose prices moved, so the move is not booked', () => {
    const price = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
    const start = (solInput: number) => new Fleet(f, TEST_CONFIG, new Pricing({ 'gpt-6-sol': { label: 'Sol', std: price(solInput) }, 'gpt-6-luna': { label: 'Luna', std: price(1) } }), () => T0);
    const fleet = start(1);
    const models = ['gpt-6-sol', 'gpt-6-luna'];
    for (const model of models) {
      const r = fixture('codex');
      r.session = { ...r.session, id: model, model, usageByModel: [{ model, tier: 'std', tokens: { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } }] };
      fleet.ingest({ ...r, agents: [], events: [] });
    }
    const marks = () => models.map((id) => f.getSession(sessionKey(id, fixture('codex').machine.id))?.spend_counted ?? null);
    expect(marks()).toEqual([1, 1]);
    start(1);
    expect(marks()).toEqual([1, 1]);
    start(2);
    expect(marks()).toEqual([null, 1]);
  });
});
