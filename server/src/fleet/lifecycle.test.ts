// The server owns time (a session unheard from for 75 s leaves, counted from no earlier than a restart), and a session that has
// done nothing stays off the wall, for both providers.
import { beforeEach, describe, expect, it } from 'vitest';
import { FleetDb, openDb, sessionKey } from './db.js';
import type { Fleet } from './fleet.js';
import type { Report } from './protocol.js';
import { fixture, testFleet } from './testing.js';

const T0 = 1_791_648_000_000;
let clock = T0;
beforeEach(() => {
  clock = T0;
});

/** Every SSE message the hub sends from now on, decoded; the reconnect hint is not a message. */
function collect(fleet: Fleet): { event: string; data: unknown }[] {
  const seen: { event: string; data: unknown }[] = [];
  const decode = (block: string): void => {
    const [head = '', body = ''] = block.split('\n');
    if (head.startsWith('event: ') && body.startsWith('data: ')) seen.push({ event: head.slice('event: '.length), data: JSON.parse(body.slice('data: '.length)) });
  };
  fleet.hub.add({ write: (chunk: string) => chunk.split('\n\n').forEach(decode) });
  return seen;
}

/** Advances the clock a second at a time, sweeping each second as the timer would. */
function advance(fleet: Fleet, ms: number): void {
  const end = clock + ms;
  while (clock < end) {
    clock = Math.min(end, clock + 1000);
    fleet.sweep();
  }
}

/** What a reporter sends for a session that was started and never prompted. */
function untouched(provider: 'claude' | 'codex', id: string): Report {
  const r = structuredClone(fixture(provider));
  r.session = { ...r.session, id, status: 'waiting', waitReason: 'input', costUsd: null, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, context: { tokens: null, window: null, percent: null }, blowouts: 0, plan: null, asks: [] };
  delete r.session.usageByModel;
  r.agents = [];
  r.events = [];
  return r;
}

describe('lifecycle', () => {
  it('a silent session shows what it last reported and leaves at 75 s with removed:dropped and a heartbeat-lost line', () => {
    const fleet = testFleet(() => clock);
    const msgs = collect(fleet);
    const id = fleet.ingest(fixture('codex')).sessionId;
    advance(fleet, 15_000);
    expect(fleet.view(id)?.status).toBe('waiting');
    // Swept a second at a time, it stays live until the sweep that reaches its drop time, and leaves on that one.
    while (fleet.isLive(id) && clock < T0 + 120_000) advance(fleet, 1000);
    expect(clock).toBe(T0 + 75_000);
    expect(fleet.isLive(id)).toBe(false);
    expect(msgs.filter((m) => m.event === 'removed')).toEqual([{ event: 'removed', data: { sessionId: id, reason: 'dropped' } }]);
    expect(msgs.filter((m) => m.event === 'activity').map((m) => (m.data as { text: string }).text)).toContain('heartbeat lost');
  });

  it('after a restart, a stored session is live in its last state at once, and leaves the full window after the restart unless it reports', () => {
    const db = new FleetDb(openDb(':memory:'));
    const r = fixture('claude');
    const id = sessionKey(r.session.id, r.machine.id);
    testFleet(() => clock, {}, db).ingest(r);
    clock = T0 + 3_600_000;
    const restarted = testFleet(() => clock, {}, db);
    expect(restarted.state().sessions.map((s) => [s.id, s.status])).toEqual([[id, 'running']]);
    advance(restarted, 74_000);
    expect(restarted.isLive(id)).toBe(true);
    advance(restarted, 1000);
    expect(db.getSession(id)?.dropped_at).toBe(clock);
    restarted.ingest(r);
    expect(restarted.state().sessions.map((s) => [s.id, s.status])).toEqual([[id, 'running']]);
  });

  it('keeps a session that has done nothing off the wall until it uses tokens, for either provider', () => {
    const fleet = testFleet(() => clock);
    fleet.ingest(untouched('claude', 'spare-claude'));
    fleet.ingest(untouched('codex', 'idle-codex'));
    expect(fleet.state().sessions).toEqual([]);
    expect(fleet.state().kpis.live).toBe(0);
    const used = untouched('codex', 'idle-codex');
    used.session.usageByModel = [{ model: 'gpt-6-sol', tier: 'std', tokens: { input: 12, output: 36, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } }];
    fleet.ingest(used);
    expect(fleet.state().sessions.map((s) => s.nativeId)).toEqual(['idle-codex']);
  });

  it('shows an unknown blowout count as unknown, never as 0, on the card and in History', () => {
    const fleet = testFleet(() => clock);
    const r = fixture('codex');
    r.session.blowouts = null;
    r.session.hooksActive = false;
    const id = fleet.ingest(r).sessionId;
    expect(fleet.view(id)).toMatchObject({ blowouts: null, hooksActive: false });
    fleet.ingest({ ...r, session: { ...r.session, status: 'done' } });
    const day = new Date(T0);
    day.setHours(0, 0, 0, 0);
    expect(fleet.historyPage(day.getTime(), day.getTime() + 86_400_000, 1, 50).rows[0]?.blowouts).toBeNull();
  });
});
