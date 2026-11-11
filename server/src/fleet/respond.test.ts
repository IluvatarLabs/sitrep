// The race between the dashboard and the terminal, how an answer settles on the reporter's result, a Codex Deny, and
// the whole path over the routes.
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sessionKey } from './db.js';
import { RespondStore } from './respond.js';
import { createFleetRouter } from './routes.js';
import { LEVEL_KINDS, TOKEN_HEADER, type Ask } from './protocol.js';
import { fixture, testFleet } from './testing.js';

const T0 = 1_800_000_000_000;
const PAGE_SIZE: Ask['questions'] = [
  { question: 'Page size?', header: 'Page size', multiSelect: false, options: [{ label: '25/50/100', description: 'a', preview: null }, { label: 'Fixed 50', description: 'b', preview: null }], allowsText: true },
];
const QUESTION: Ask = { id: 'toolu_q', kind: 'question', agentId: null, openedAt: T0, allowsReply: true, questions: PAGE_SIZE };
const PLAN: Ask = { id: 'toolu_p', kind: 'plan', agentId: null, openedAt: T0, allowsReply: true, plan: { text: '# Plan', filePath: null } };
const CODEX_SHELL: Ask = { id: 'item_s:1', kind: 'permission', agentId: null, openedAt: T0, allowsReply: false, tool: { name: 'Shell', input: { command: 'pnpm test' }, cut: false, denyReason: false } };

/** A store holding one session, whose report says it takes every kind of answer, and a held request on it by ask id. */
function store() {
  const feed: string[] = [];
  const s = new RespondStore(() => T0, () => {}, { addDashboard: (_s, _l, ref, e) => feed.push(`add ${ref} ${e.text}`), updateDashboard: () => {}, removeDashboard: (_s, ref) => feed.push(`remove ${ref}`) });
  const r = fixture('claude');
  r.sentAt = T0;
  r.session.respond = { level: 'everything', accepts: [...LEVEL_KINDS.everything], limits: [] };
  delete r.session.asks;
  s.noteReport(r.session.id, r, true);
  const hold = (askId: string, waitMs: number) => s.hold(r.session.id, askId, waitMs);
  return { s, sid: r.session.id, feed, hold };
}

describe('RespondStore', () => {
  it('takes the first answer only, hands it to a request already waiting, and refuses a later one with who answered and when', async () => {
    const { s, sid, hold } = store();
    s.announce(sid, QUESTION);
    expect(await hold(QUESTION.id, 5)).toEqual({ kind: 'none' });
    const waiting = hold(QUESTION.id, 10_000);
    const first = s.answer(sid, 'toolu_q', 'Admin', { kind: 'question', answers: [{ options: [1] }] });
    expect(await waiting).toMatchObject({ kind: 'delivery', delivery: { kind: 'question', answers: [{ options: [1] }] } });
    expect(first.ok).toBe(true);
    expect(s.answer(sid, 'toolu_q', 'Admin', { kind: 'question', answers: [{ options: [0] }] })).toEqual({ ok: false, err: { status: 409, error: 'this ask has its answer already', by: 'Admin', at: T0 } });
    // Handed over but with no result yet: handed over again, for a reporter that lost the reply.
    expect((await hold(QUESTION.id, 5)).kind).toBe('delivery');
  });

  it('lets the terminal win: its close wakes the held request, drops an answer never handed over, and refuses later answers', async () => {
    const { s, sid, feed, hold } = store();
    s.announce(sid, PLAN);
    const out = s.answer(sid, 'toolu_p', 'Admin', { kind: 'plan-approve', mode: 'acceptEdits' });
    if (!out.ok) throw new Error('refused');
    s.close(sid, PLAN.id, { outcome: 'terminal', at: T0, planApproved: true });
    expect(feed.slice(-1)).toEqual([`remove ${out.delivery.id}`]);
    expect(s.detail(sid, PLAN.id, 0)).toMatchObject({ state: 'closed', delivery: { result: 'closed' }, closed: { outcome: 'terminal', planApproved: true } });
    expect(await hold(PLAN.id, 10_000)).toEqual({ kind: 'closed', outcome: 'terminal' });
    expect(s.answer(sid, 'toolu_p', 'Admin', { kind: 'plan-feedback' })).toMatchObject({ ok: false, err: { status: 410, outcome: 'terminal' } });
  });

  it('settles on the reporter’s result: took closes the ask, refused opens it again, not-taken holds it', () => {
    const { s, sid } = store();
    s.announce(sid, QUESTION);
    const a = s.answer(sid, 'toolu_q', 'Admin', { kind: 'reply', text: 'x' });
    if (!a.ok) throw new Error('refused');
    s.result(sid, a.delivery.id, 'refused');
    expect(s.summaries(sid).map((a) => a.state)).toEqual(['open']);
    const b = s.answer(sid, 'toolu_q', 'Admin', { kind: 'reply', text: 'y' });
    if (!b.ok) throw new Error('refused');
    expect(s.result(sid, b.delivery.id, 'took')).toBe('new');
    expect(s.result(sid, b.delivery.id, 'took')).toBe('repeat');
    expect(s.detail(sid, 'toolu_q', 0)).toMatchObject({ state: 'closed', closed: { outcome: 'dashboard', by: 'Admin' } });
    s.announce(sid, PLAN);
    const c = s.answer(sid, 'toolu_p', 'Admin', { kind: 'plan-approve', mode: 'auto' });
    if (!c.ok) throw new Error('refused');
    s.result(sid, c.delivery.id, 'not-taken');
    expect(s.summaries(sid).find((x) => x.id === 'toolu_p')?.state).toBe('not-taken');
    expect(s.answer(sid, 'toolu_p', 'Admin', { kind: 'plan-feedback' })).toMatchObject({ ok: false, err: { status: 409 } });
  });

  it('takes a Deny with no reason on a Codex approval, whose native decline carries none', () => {
    const { s, sid } = store();
    s.announce(sid, CODEX_SHELL);
    expect(s.answer(sid, 'item_s:1', 'Admin', { kind: 'deny' }).ok).toBe(true);
  });
});

describe('responding over the routes', () => {
  const SECRET = 'a-long-test-secret-for-the-routes-000000';
  const H = { 'X-Sitrep-Respond': '1' };

  it('runs a Codex approval from the reporter’s announcement to the browser’s answer, the held request and the session taking it', async () => {
    const fleet = testFleet(Date.now);
    const app = express();
    app.use('/api/fleet', createFleetRouter(fleet, { token: SECRET }));
    const r = fixture('codex');
    const ask = r.session.asks![0]!;
    // The reporter and the browser both name the session by its id on the server (sessionKey).
    const key = encodeURIComponent(sessionKey(r.session.id, r.machine.id));
    const askUrl = `/sessions/${key}/asks/${ask.id}`;
    const rep = await request(app).post('/api/fleet/report').set(TOKEN_HEADER, SECRET).send(r);
    expect(rep.body).toMatchObject({ ok: true, respond: true, deliveries: [] });
    expect((await request(app).put(`/api/fleet/sessions/${key}/asks/${ask.id}`).set(TOKEN_HEADER, SECRET).send(ask)).status).toBe(200);
    expect(JSON.stringify(fleet.state())).not.toContain('outside the sandbox');

    const browser = request.agent(app);
    expect((await browser.post('/api/fleet/respond/sign-in').set(H).send({ name: 'Admin', token: 'wrong' })).status).toBe(401);
    expect((await browser.post('/api/fleet/respond/sign-in').set(H).send({ name: 'Admin', token: SECRET })).status).toBe(200);
    expect((await browser.get(`/api/fleet/respond/sessions/${key}/asks/${ask.id}`)).body).toMatchObject({ ask, state: 'open' });

    const held = request(app).get(`/api/fleet/sessions/${key}/asks/${ask.id}/answer?wait=5`).set(TOKEN_HEADER, SECRET).then((x) => x);
    await new Promise((done) => setTimeout(done, 50));
    const sent = await browser.post(`/api/fleet/respond${askUrl}/answer`).set(H).send({ kind: 'allow-once' });
    const got = await held;
    expect([sent.status, got.status]).toEqual([202, 200]);
    expect(got.body.delivery).toMatchObject({ id: sent.body.deliveryId, askId: ask.id, by: 'Admin', kind: 'allow-once' });

    expect((await request(app).post(`/api/fleet/sessions/${key}/deliveries/${sent.body.deliveryId}/result`).set(TOKEN_HEADER, SECRET).send({ result: 'took', at: Date.now() })).status).toBe(200);
    expect((await browser.get(`/api/fleet/respond/sessions/${key}/asks/${ask.id}`)).body).toMatchObject({ state: 'closed', closed: { outcome: 'dashboard' } });
    fleet.close();
  });
});
