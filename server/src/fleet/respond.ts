// Responding to a waiting session from the dashboard. Held in memory only: the open asks with their content, a closed ask's
// outcome for a while, and the answers and messages sent from the browser until the reporter says what became of them. Nothing
// here is written to the database, and a restart loses it all; reporters re-send their open asks with every report, so they come
// back by themselves.
import { randomBytes } from 'node:crypto';
import { MAIN_LOOP, PLAN_MODES, RESPOND_LIMITS } from './protocol.js';
import type { ActivityStore } from './activity.js';
import type { Ask, AskClose, AskClosure, AskDetail, AskOutcome, AskQuestion, AskState, AskSummary, DashboardCommand, Delivery, DeliveryKind, DeliveryResult, PlanMode, QuestionAnswer, Report, RespondInfo, RespondKind } from './protocol.js';

/** A closed ask stays readable this long, or until the session's next ask opens. */
export const CLOSED_KEEP_MS = 10 * 60_000;
/** A report that no longer lists an open ask closes it only if the ask opened at least this long before the report was made. */
const UNLISTED_GRACE_MS = 5000;
/** Held answer requests kept per ask and in all; past either, the oldest is answered "none" to make room. */
const HOLDS_PER_ASK = 4;
const HOLDS_TOTAL = 200;
/** What a held request is answered with when nothing came for it. */
const NOTHING: HoldResult = { kind: 'none' };

/** Where a dashboard answer, message or command shows: its loop's live activity feed (the fleet hands over its ActivityStore). */
export type DashboardFeed = Pick<ActivityStore, 'addDashboard' | 'updateDashboard' | 'removeDashboard'>;

/** An answer, message or command the server holds until the reporter says what became of it. */
interface Held {
  delivery: Delivery;
  result: DeliveryResult | null;
  /** The reporter has been given it, so it can no longer be discarded. */
  handedOver: boolean;
}

/** How an ask closed, as the panel shows it, and `implicit`: inferred from a report that stopped listing the ask, which the reporter's own close may still replace. */
type Closure = AskClosure & { implicit: boolean };

/** A closure as the panel gets it: `implicit` is the store's own business. */
const shownClosure = ({ outcome, at, by, answer, planApproved }: Closure): AskClosure => ({ outcome, at, by, answer, planApproved });

interface TrackedAsk {
  ask: Ask;
  answer: Held | null;
  closure: Closure | null;
  /** A report made after the ask closed showed the session running: the turn it closed in is under way. */
  ranAfterClose?: boolean;
}

interface SessionState {
  /** Report.session.respond as last reported. */
  info: RespondInfo | null;
  asks: Map<string, TrackedAsk>;
  /** Messages and commands, oldest first. */
  messages: Held[];
}

/** A reporter's held answer request, parked until something answers it. */
interface HeldRequest {
  sessionId: string;
  askId: string;
  resolve: (r: HoldResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Why the server let go of a delivery that has no result. */
export type DropWhy = 'discarded' | 'ask-closed' | 'session-ended' | 'queued-session-ended' | 'session-deleted' | 'answering-off';

/** What became of a delivery after the server took it, for the server log: never its text. */
export type DeliveryTrail = { sessionId: string; delivery: Delivery } & ({ kind: 'result'; result: DeliveryResult } | { kind: 'dropped'; why: DropWhy });

/** What a held answer request comes back with: the answer, nothing in time, an ask the server does not know, or how it closed. */
export type HoldResult = { kind: 'delivery'; delivery: Delivery } | { kind: 'none' | 'unknown' } | { kind: 'closed'; outcome: AskOutcome };

/** Hears that a session's asks changed. */
type SessionChanged = (sessionId: string) => void;

/** An answer or message from the browser: taken, as this delivery, or turned away with the reason. */
export type Taken = { ok: true; delivery: Delivery } | { ok: false; err: AnswerError };

/** What announcing an ask did: stored it, found it closed, or found as many asks open as a session may have. */
export type AnnounceOutcome = 'ok' | 'closed' | 'full';

/** What a delivery's result did: recorded a new one, matched the one recorded, or named a delivery the server does not hold. */
export type ResultOutcome = 'new' | 'repeat' | 'unknown';

/** Why an answer or message from the browser was not taken; the routes send all but `status` as the body. */
export type AnswerError =
  /** No such ask. */
  | { status: 404; error: 'unknown ask' }
  /** The ask closed before the answer came. */
  | { status: 410; error: 'this ask has closed'; outcome: AskOutcome; at: number }
  /** The ask has an answer already, from `by` at `at`. */
  | { status: 409; error: 'this ask has its answer already'; by: string; at: number }
  /** The session does not take this kind of answer now. */
  | { status: 422; error: 'the session does not take this kind now'; kind: string }
  /** The body does not fit the ask or the limits. */
  | { status: 400; error: string; path: string }
  /** As many messages as a session may have waiting already wait. */
  | { status: 429; error: string };

// ---- what the feed and the log say ----------------------------------------------------------------

/** How the feed words each plan approval mode. */
const PLAN_MODE_WORDS: Record<PlanMode, string> = { auto: 'and use auto mode', acceptEdits: 'auto-accept edits', default: 'manually approve edits' };

/** How the feed names the call a permission ask is about: a shell command (Claude Bash, Codex Shell) on one line, else the tool. */
function callName(ask: Ask): string {
  const tool = ask.tool;
  if (tool === undefined) return 'the tool';
  const command = tool.input.command;
  const isShell = tool.name === 'Bash' || tool.name === 'Shell';
  return isShell && typeof command === 'string' ? command.replace(/\s+/g, ' ').trim().slice(0, 120) : tool.name;
}

const RECOMMENDED = '(recommended)';

/**
 * A label with Claude Code's trailing "(Recommended)" taken off, in any case, along with the spaces before it. Compared by hand,
 * since a regex would take quadratic time on a long run of spaces.
 */
const stripRecommended = (label: string): string => {
  const end = label.trimEnd();
  const marked = end.length >= RECOMMENDED.length && end.slice(-RECOMMENDED.length).toLowerCase() === RECOMMENDED;
  return marked ? end.slice(0, -RECOMMENDED.length).trimEnd() : label;
};

/** How the feed and a close word a question answer: per answered question its options (", ") or typed text, joined with "; ". */
export const questionSummary = (ask: Ask, answers: readonly QuestionAnswer[]): string =>
  (ask.questions ?? [])
    .map((question, i) => {
      const answer = answers[i];
      if (!answer) return '';
      return 'text' in answer ? answer.text.trim() : answer.options.map((n) => stripRecommended(question.options[n]?.label ?? '')).join(', ');
    })
    .filter((part) => part !== '')
    .join('; ');

/** What a delivery says, trimmed; '' when it carries no text. */
const spoken = (d: Delivery): string => d.text?.trim() ?? '';

/** The feed's line for each kind of delivery ("answered: …", "approved the plan (…)", "allowed once: …"). */
const FEED_LINES: Record<DeliveryKind, (d: Delivery, ask: Ask | null) => string> = {
  question: (d, ask) => `answered: ${ask ? questionSummary(ask, d.answers ?? []) : ''}`,
  'plan-approve': (d) => `approved the plan (${PLAN_MODE_WORDS[d.mode ?? 'auto']})`,
  'plan-feedback': (d) => (spoken(d) ? `No, keep planning: ${spoken(d)}` : 'No, keep planning'),
  'allow-once': (_d, ask) => `allowed once: ${ask ? callName(ask) : ''}`,
  deny: (d, ask) => {
    const reason = spoken(d);
    return `denied: ${ask ? callName(ask) : ''}${reason ? `. ${reason}` : ''}`;
  },
  command: (d) => `/${d.command ?? ''}`,
  message: (d) => spoken(d),
  reply: (d) => spoken(d),
};

/** What the log says was done for each kind of delivery; never what was said. */
const LOG_WORDS: Record<DeliveryKind, (d: Delivery) => string> = {
  question: () => 'Answered a question',
  reply: () => 'Sent a message in place of an answer',
  'plan-approve': (d) => `Approved a plan (${d.mode ?? ''})`,
  'plan-feedback': () => 'Sent a plan back',
  'allow-once': () => 'Allowed a tool once',
  deny: () => 'Denied a tool',
  command: (d) => `Ran /${d.command ?? ''}`,
  message: () => 'Sent a message',
};

/** What the server log says a delivery did; never what it said. */
export const logWords = (d: Delivery): string => LOG_WORDS[d.kind](d);

/** The noun the feed uses for each kind of ask. */
const ASK_NOUN: Record<Ask['kind'], string> = { question: 'question', plan: 'plan', permission: 'request' };

/** The note on a delivery's feed line: an answer replaced by a message, a message or command queued, a /clear that took. */
function feedNote(d: Delivery, ask: Ask | null, result: DeliveryResult | null): string | null {
  if (d.kind === 'reply') return ask ? `(in place of an answer; the ${ASK_NOUN[ask.kind]} closes)` : null;
  const waitsForIdle = d.kind === 'message' || d.kind === 'command';
  if (waitsForIdle && result === 'queued') return '(queued until the session is idle)';
  if (d.kind === 'command' && d.command === 'clear' && result === 'took') return '(cleared: the conversation goes on under a new session id)';
  return null;
}

/** A fresh delivery id: `dlv_` and 24 random hex digits. */
const newDeliveryId = (): string => `dlv_${randomBytes(12).toString('hex')}`;

/** The id the log shows for a delivery, enough to match its lines up: `dlv_` and its first 8 hex digits. */
export const shortDeliveryId = (d: Delivery): string => d.id.slice(0, 12);

// ---- the store ----------------------------------------------------------------------------------

export class RespondStore {
  /** Told what became of each delivery, when set; the routes point it at the server log. */
  trail: ((t: DeliveryTrail) => void) | null = null;
  private readonly sessions = new Map<string, SessionState>();
  /** The reporters' held answer requests, oldest first. */
  private readonly holds = new Set<HeldRequest>();

  /**
   * `onChange` hears that a session's asks changed, so its card and the panel need a new SessionView; `feed` shows the dashboard's
   * deliveries on their loops' activity (none for a store whose feed nobody watches).
   */
  constructor(
    private readonly now: () => number,
    private readonly onChange: SessionChanged = () => {},
    private readonly feed: DashboardFeed | null = null,
  ) {}

  /** A session's state, made empty the first time it is needed. */
  private stateFor(sessionId: string): SessionState {
    const known = this.sessions.get(sessionId);
    if (known !== undefined) return known;
    const fresh: SessionState = { info: null, asks: new Map(), messages: [] };
    this.sessions.set(sessionId, fresh);
    return fresh;
  }

  private tracked(sessionId: string, askId: string): TrackedAsk | undefined {
    return this.sessions.get(sessionId)?.asks.get(askId);
  }

  /** What the session last reported it takes (Report.session.respond); null until a report since the server started has said. */
  takes(sessionId: string): RespondInfo | null {
    const state = this.sessions.get(sessionId);
    return state === undefined ? null : state.info;
  }

  /**
   * A validated report of the session `sid` (its id on the server). Keeps what the session says it takes. When the report carries
   * its asks (responding is on), any ask the server does not know (after a restart) is learnt and an open one no longer listed is
   * taken as closed. A finished session closes them all.
   */
  noteReport(sid: string, report: Report, takeAsks: boolean): void {
    const { session } = report;
    if (session.respond) this.stateFor(sid).info = session.respond;
    else {
      const known = this.sessions.get(sid);
      if (known) known.info = null;
    }
    if (session.status === 'done') {
      this.endSession(sid);
      return;
    }
    const reported = session.asks;
    if (!takeAsks || !reported) return;
    const listed = new Set(reported.map((a) => a.id));
    for (const ask of reported) this.announce(sid, ask);
    this.closeUnlisted(sid, listed, report.sentAt);
    this.forgetFinishedAsks(sid, report);
  }

  /** Takes as closed each open ask a report made at `sentAt` left out, unless it opened within UNLISTED_GRACE_MS of it. */
  private closeUnlisted(sessionId: string, listed: ReadonlySet<string>, sentAt: number): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const tracked of state.asks.values()) {
      const { ask, closure } = tracked;
      if (closure || listed.has(ask.id) || ask.openedAt > sentAt - UNLISTED_GRACE_MS) continue;
      this.setClosed(sessionId, tracked, { outcome: 'closed', at: this.now(), by: null, answer: null, planApproved: false, implicit: true });
    }
  }

  /**
   * Forgets closed asks once their turn is over: the session was seen running after they closed, and now reports itself idle
   * (`waiting`) with nothing open. An idle report without a running one in between may be the moment before the session takes
   * the answer, and a report made before the ask closed says nothing about it.
   */
  private forgetFinishedAsks(sessionId: string, report: Report): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const { status } = report.session;
    if (status === 'running') {
      for (const tracked of state.asks.values()) if (tracked.closure && tracked.closure.at < report.sentAt) tracked.ranAfterClose = true;
      return;
    }
    if (status !== 'waiting' || [...state.asks.values()].some((t) => !t.closure)) return;
    const over = [...state.asks].filter(([, t]) => t.closure && t.ranAfterClose).map(([id]) => id);
    for (const id of over) state.asks.delete(id);
    if (over.length > 0) this.onChange(sessionId);
  }

  /** The reporter announces an ask (PUT), any number of times: a new body replaces the stored one while no answer is pending. */
  announce(sessionId: string, ask: Ask): AnnounceOutcome {
    const state = this.stateFor(sessionId);
    const tracked = state.asks.get(ask.id);
    if (tracked === undefined) return this.openAsk(sessionId, state, ask);
    const closure = tracked.closure;
    if (closure && !closure.implicit) return 'closed';
    if (closure) {
      // Listed again after an implicit close, so open again; an answer that close dropped is gone, and it takes a new one.
      tracked.closure = null;
      if (tracked.answer?.result === 'closed') tracked.answer = null;
      this.onChange(sessionId);
    }
    if (!tracked.answer) tracked.ask = ask;
    return 'ok';
  }

  private openAsk(sessionId: string, state: SessionState, ask: Ask): Exclude<AnnounceOutcome, 'closed'> {
    if ([...state.asks.values()].filter((t) => !t.closure).length >= RESPOND_LIMITS.asks) return 'full';
    // Every closed ask stops being readable once a new one opens.
    for (const [id, tracked] of state.asks) if (tracked.closure) state.asks.delete(id);
    state.asks.set(ask.id, { ask, answer: null, closure: null });
    this.onChange(sessionId);
    return 'ok';
  }

  /**
   * The reporter's held request: the answer now, or as soon as one arrives, or nothing within `waitMs`. `signal` aborts when the
   * reporter's connection closes, so an answer arriving later is not marked handed over to a request nobody reads.
   */
  async hold(sessionId: string, askId: string, waitMs: number, signal?: AbortSignal): Promise<HoldResult> {
    if (signal?.aborted) return NOTHING;
    const tracked = this.tracked(sessionId, askId);
    if (!tracked) return { kind: 'unknown' };
    if (tracked.closure) return { kind: 'closed', outcome: tracked.closure.outcome };
    const ready = this.handOver(sessionId, tracked);
    return ready ? { kind: 'delivery', delivery: ready } : new Promise((resolve) => this.park(sessionId, askId, waitMs, resolve, signal));
  }

  /**
   * Parks a held request until an answer comes, its wait runs out, or its reporter goes. To make room, the oldest request parked
   * on the same ask is let go first once HOLDS_PER_ASK wait there, and then the oldest of all once HOLDS_TOTAL wait in all.
   */
  private park(sessionId: string, askId: string, waitMs: number, resolve: (r: HoldResult) => void, signal?: AbortSignal): void {
    const sameAsk = this.parkedOn(sessionId, askId);
    if (sameAsk.length >= HOLDS_PER_ASK) this.release(sameAsk[0]!, NOTHING);
    const oldest = this.holds.values().next();
    if (this.holds.size >= HOLDS_TOTAL && !oldest.done) this.release(oldest.value, NOTHING);
    const letGo = (): void => this.release(held, NOTHING);
    const held: HeldRequest = { sessionId, askId, resolve, timer: setTimeout(letGo, waitMs) };
    held.timer.unref?.();
    this.holds.add(held);
    signal?.addEventListener('abort', letGo, { once: true });
  }

  /** The requests parked on one ask, oldest first. */
  private parkedOn(sessionId: string, askId: string): HeldRequest[] {
    return Array.from(this.holds).filter((h) => h.askId === askId && h.sessionId === sessionId);
  }

  /** Answers a parked request once; a request already answered is left as it is. */
  private release(held: HeldRequest, r: HoldResult): void {
    const parked = this.holds.delete(held);
    if (parked) {
      clearTimeout(held.timer);
      held.resolve(r);
    }
  }

  /** Answers each request parked on one ask with what `outcome` returns, asked afresh for each. */
  private wake(sessionId: string, askId: string, outcome: () => HoldResult): void {
    for (const held of this.parkedOn(sessionId, askId)) this.release(held, outcome());
  }

  /** How many held requests are parked now. */
  get holding(): number {
    return this.holds.size;
  }

  /** The answer to hand the reporter for an ask: one taken and still without a result. The first hand-over is noted. */
  private handOver(sessionId: string, tracked: TrackedAsk): Delivery | null {
    const held = tracked.answer;
    if (held === null || held.result !== null) return null;
    if (!held.handedOver) {
      held.handedOver = true;
      this.onChange(sessionId);
    }
    return held.delivery;
  }

  /** The reporter says an ask closed without the dashboard's answer. An answer it was not yet handed is dropped. */
  close(sessionId: string, askId: string, { outcome, at, answer, planApproved }: AskClose): void {
    const tracked = this.tracked(sessionId, askId);
    // Only an implicit close gives way to the reporter's own.
    if (!tracked || (tracked.closure && !tracked.closure.implicit)) return;
    this.setClosed(sessionId, tracked, { outcome, at, by: null, answer: answer ?? null, planApproved: planApproved === true, implicit: false });
  }

  /** Closes an ask: an answer not yet handed over is dropped with its feed line, and the requests parked on it learn the outcome. */
  private setClosed(sessionId: string, tracked: TrackedAsk, closure: Closure): void {
    tracked.closure = closure;
    const held = tracked.answer;
    if (held !== null && held.result === null && !held.handedOver) {
      held.result = 'closed';
      this.feed?.removeDashboard(sessionId, held.delivery.id);
      this.trail?.({ kind: 'dropped', sessionId, delivery: held.delivery, why: 'ask-closed' });
    }
    this.wake(sessionId, tracked.ask.id, () => ({ kind: 'closed', outcome: closure.outcome }));
    this.onChange(sessionId);
  }

  /** The session ended or left the live set: each open ask closes as `ended`, and the messages waiting for it go. */
  endSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const tracked of state.asks.values()) {
      if (!tracked.closure) this.setClosed(sessionId, tracked, { outcome: 'ended', at: this.now(), by: null, answer: null, planApproved: false, implicit: false });
    }
    // A message with no result never reached the session. One it queued may still be read, so the log says only that the
    // session ended first; one with a final result already has its log line.
    for (const m of state.messages) {
      const why: DropWhy | null = m.result === null ? 'session-ended' : m.result === 'queued' ? 'queued-session-ended' : null;
      if (why !== null) this.trail?.({ kind: 'dropped', sessionId, delivery: m.delivery, why });
    }
    state.messages = [];
  }

  /** The session is gone, or answering was turned off: everything held for it goes, and the requests parked on its asks learn it ended. */
  dropSession(sessionId: string, why: DropWhy = 'session-deleted'): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const answers = [...state.asks.values()].flatMap((t) => (t.answer ? [t.answer] : []));
    for (const held of [...state.messages, ...answers]) {
      if (held.result === null) this.trail?.({ kind: 'dropped', sessionId, delivery: held.delivery, why });
    }
    for (const tracked of state.asks.values()) this.wake(sessionId, tracked.ask.id, () => ({ kind: 'closed', outcome: 'ended' }));
    this.sessions.delete(sessionId);
  }

  /**
   * Answering or the activity feed it needs was turned off: every session's asks, answers, messages and commands go as if the
   * session were gone, so none survives to be handed over once both are on again. A parked
   * request is only ever on an open ask the store tracks, so waking each session's asks lets go of every one.
   */
  clear(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.dropSession(sessionId, 'answering-off');
      this.onChange(sessionId);
    }
  }

  /** Every second: an ask closed longer than CLOSED_KEEP_MS ago goes. */
  expire(): void {
    const now = this.now();
    for (const [sid, state] of this.sessions) {
      const old = [...state.asks].filter(([, t]) => t.closure !== null && now - t.closure.at > CLOSED_KEEP_MS).map(([id]) => id);
      for (const id of old) state.asks.delete(id);
      if (old.length > 0) this.onChange(sid);
    }
  }

  /** A session's asks as the state and the stream carry them: no questions, plan or tool input. */
  summaries(sessionId: string): AskSummary[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    const out: AskSummary[] = [];
    for (const tracked of state.asks.values()) {
      const { id, kind, agentId, openedAt, questions } = tracked.ask;
      out.push({ id, kind, agentId, openedAt, count: kind === 'question' ? (questions?.length ?? 1) : 1, state: askState(tracked) });
    }
    return out;
  }

  /** The whole ask, for the signed-in owner. */
  detail(sessionId: string, askId: string, lastSeenAt: number): AskDetail | null {
    const tracked = this.tracked(sessionId, askId);
    if (!tracked) return null;
    const { ask, answer: held, closure } = tracked;
    return {
      ask,
      state: askState(tracked),
      // Single-owner mode: every delivery is the signed-in owner's own.
      delivery: held ? { ...held.delivery, result: held.result, mine: true, handedOver: held.handedOver } : null,
      closed: closure && shownClosure(closure),
      lastSeenAt,
    };
  }

  /** An answer from the browser, checked against the ask and what the session last said it takes. The first answer wins. */
  answer(sessionId: string, askId: string, by: string, body: unknown): Taken {
    const tracked = this.tracked(sessionId, askId);
    if (!tracked) return { ok: false, err: { status: 404, error: 'unknown ask' } };
    const { closure, answer: earlier } = tracked;
    if (closure) return { ok: false, err: { status: 410, error: 'this ask has closed', outcome: closure.outcome, at: closure.at } };
    // An answer the session refused leaves the ask open to another.
    if (earlier && earlier.result !== 'refused') return { ok: false, err: { status: 409, error: 'this ask has its answer already', by: earlier.delivery.by, at: earlier.delivery.at } };
    const checked = parseAnswer(body, tracked.ask, this.takes(sessionId)?.accepts ?? []);
    if (!checked.ok) return { ok: false, err: checked.err };
    const delivery: Delivery = { id: newDeliveryId(), askId, by, at: this.now(), ...checked.fields };
    tracked.answer = { delivery, result: null, handedOver: false };
    const line = { at: delivery.at, text: FEED_LINES[delivery.kind](delivery, tracked.ask), by, note: feedNote(delivery, tracked.ask, null) };
    this.feed?.addDashboard(sessionId, tracked.ask.agentId ?? MAIN_LOOP, delivery.id, line);
    this.wake(sessionId, askId, () => ({ kind: 'delivery', delivery: this.handOver(sessionId, tracked) ?? delivery }));
    this.onChange(sessionId);
    return { ok: true, delivery };
  }

  /** A new message or command from the browser. One sent while the session runs waits until it is idle. */
  message(sessionId: string, by: string, body: unknown): Taken {
    const checked = parseMessage(body, this.takes(sessionId)?.accepts ?? []);
    if (!checked.ok) return { ok: false, err: checked.err };
    const state = this.stateFor(sessionId);
    const waiting = state.messages.filter((m) => m.result === null).length;
    if (waiting >= RESPOND_LIMITS.deliveries) {
      return { ok: false, err: { status: 429, error: `at most ${String(RESPOND_LIMITS.deliveries)} messages can wait for one session` } };
    }
    const delivery: Delivery = { id: newDeliveryId(), askId: null, by, at: this.now(), ...checked.fields };
    state.messages.push({ delivery, result: null, handedOver: false });
    this.feed?.addDashboard(sessionId, MAIN_LOOP, delivery.id, { at: delivery.at, text: FEED_LINES[delivery.kind](delivery, null), by, note: null });
    return { ok: true, delivery };
  }

  /** The messages and commands a report's reply carries: those still without a result, oldest first, marked handed over now. */
  handOverMessages(sessionId: string): Delivery[] {
    const due = (this.sessions.get(sessionId)?.messages ?? []).filter((m) => m.result === null).slice(0, RESPOND_LIMITS.deliveries);
    for (const m of due) m.handedOver = true;
    return due.map((m) => m.delivery);
  }

  /** The reporter says what became of a delivery: 'new', 'repeat' for a result already recorded, 'unknown' when it is not held. */
  result(sessionId: string, deliveryId: string, result: DeliveryResult): ResultOutcome {
    const state = this.sessions.get(sessionId);
    if (!state) return 'unknown';
    const message = state.messages.find((m) => m.delivery.id === deliveryId);
    if (message) return this.messageResult(sessionId, state, message, result);
    const tracked = [...state.asks.values()].find((t) => t.answer?.delivery.id === deliveryId);
    if (!tracked || !tracked.answer) return 'unknown';
    return this.answerResult(sessionId, tracked, tracked.answer, result);
  }

  private messageResult(sessionId: string, state: SessionState, message: Held, result: DeliveryResult): Exclude<ResultOutcome, 'unknown'> {
    if (message.result === result) return 'repeat';
    message.result = result;
    const { delivery } = message;
    this.trail?.({ kind: 'result', sessionId, delivery, result });
    if (result === 'refused' || result === 'closed') this.feed?.removeDashboard(sessionId, delivery.id);
    else this.feed?.updateDashboard(sessionId, delivery.id, feedNote(delivery, null, result));
    // A message with its final result is done: only those still waiting for one, or queued, stay.
    state.messages = state.messages.filter((m) => m.result === null || m.result === 'queued');
    return 'new';
  }

  private answerResult(sessionId: string, tracked: TrackedAsk, held: Held, result: DeliveryResult): Exclude<ResultOutcome, 'unknown'> {
    if (held.result === result) return 'repeat';
    held.result = result;
    const { delivery } = held;
    this.trail?.({ kind: 'result', sessionId, delivery, result });
    switch (result) {
      case 'took':
        if (!tracked.closure || tracked.closure.implicit) {
          tracked.closure = { outcome: 'dashboard', at: this.now(), by: delivery.by, answer: null, planApproved: delivery.kind === 'plan-approve', implicit: false };
        }
        this.wake(sessionId, tracked.ask.id, () => ({ kind: 'closed', outcome: 'dashboard' }));
        break;
      case 'refused':
        // Refused by the session: the ask takes an answer again, from its terminal or from the dashboard.
        tracked.answer = null;
        this.feed?.removeDashboard(sessionId, delivery.id);
        break;
      case 'closed':
      case 'not-taken':
        // It never reached the session (the ask closed first, or the engine did not take an approval): the feed does not claim it.
        this.feed?.removeDashboard(sessionId, delivery.id);
        break;
      default:
        // `queued` changes nothing for an answer.
        break;
    }
    this.onChange(sessionId);
    return 'new';
  }

  /** "Discard my answer": drops an answer or message before the reporter is handed it. */
  discard(deliveryId: string): 'ok' | 'handed-over' | 'unknown' {
    for (const [sid, state] of this.sessions) {
      const index = state.messages.findIndex((m) => m.delivery.id === deliveryId);
      const tracked = index === -1 ? [...state.asks.values()].find((t) => t.answer?.delivery.id === deliveryId) : undefined;
      const held = index === -1 ? tracked?.answer : state.messages[index];
      if (!held) continue;
      if (held.handedOver || held.result !== null) return 'handed-over';
      if (index !== -1) state.messages.splice(index, 1);
      else if (tracked) tracked.answer = null;
      this.feed?.removeDashboard(sid, deliveryId);
      this.trail?.({ kind: 'dropped', sessionId: sid, delivery: held.delivery, why: 'discarded' });
      this.onChange(sid);
      return 'ok';
    }
    return 'unknown';
  }
}

/** Where an ask stands, as its card and the panel show it. */
function askState(tracked: TrackedAsk): AskState {
  if (tracked.closure) return 'closed';
  const result = tracked.answer?.result;
  if (result === 'not-taken') return 'not-taken';
  return tracked.answer && result !== 'refused' ? 'pending' : 'open';
}

// ---- checking what the browser sends -------------------------------------------------------

type Fields = Omit<Delivery, 'id' | 'askId' | 'by' | 'at'>;
type Checked = { ok: true; fields: Fields } | { ok: false; err: AnswerError };

const accepted = (fields: Fields): Checked => ({ ok: true, fields });
const invalid = (error: string, path: string): Checked => ({ ok: false, err: { status: 400, error, path } });
const refusedKind = (kind: string): Checked => ({ ok: false, err: { status: 422, error: 'the session does not take this kind now', kind } });

const CONTROLS_BUT_TAB_AND_LF = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Text typed in the browser, every control character but tab and line feed turned to a space; null when not a string or over `max`. */
function typedText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(CONTROLS_BUT_TAB_AND_LF, ' ');
  return cleaned.length <= max ? cleaned : null;
}

/** Optional typed text: '' when absent, null when it is not a string or is over `max`. */
const optionalText = (v: unknown, max: number): string | null => (v === undefined ? '' : typedText(v, max));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type AnswerKind = Exclude<DeliveryKind, 'reply' | 'message' | 'command'>;

/** The ask each kind of answer fits, and the `accepts` entry the session must list for it. */
const ANSWER_FITS: Record<AnswerKind, { ask: Ask['kind']; needs: RespondKind }> = {
  question: { ask: 'question', needs: 'question' },
  'plan-approve': { ask: 'plan', needs: 'plan-approve' },
  'plan-feedback': { ask: 'plan', needs: 'plan-feedback' },
  'allow-once': { ask: 'permission', needs: 'permission' },
  deny: { ask: 'permission', needs: 'permission' },
};

/** The `accepts` entry a message sent in place of an answer needs: feedback for a plan; for a question or a permission, its own kind. */
const replyNeeds = (kind: Ask['kind']): RespondKind => (kind === 'plan' ? 'plan-feedback' : kind);

/**
 * Checks an answer from the browser against its ask and what the session takes. Nothing over a limit is cut: it is refused. The
 * ask's own flags say what its provider can take: a reply instead of an answer only with `allowsReply`, a typed answer
 * only with `allowsText`, a reason with a deny only with `tool.denyReason`.
 */
export function parseAnswer(body: unknown, ask: Ask, accepts: readonly RespondKind[]): Checked {
  if (!isRecord(body)) return invalid('expected an object', '$');
  const kind = body.kind;
  if (kind === 'reply') return checkReply(body.text, ask, accepts);
  if (typeof kind !== 'string' || !(kind in ANSWER_FITS)) return invalid('expected kind question, reply, plan-approve, plan-feedback, allow-once or deny', '$.kind');
  const fit = ANSWER_FITS[kind as AnswerKind];
  if (fit.ask !== ask.kind || !accepts.includes(fit.needs)) return refusedKind(kind);
  if (kind === 'question') return checkQuestionAnswers(body.answers, ask);
  if (kind === 'plan-approve') {
    const mode = PLAN_MODES.find((m) => m === body.mode);
    return mode === undefined ? invalid('expected mode auto, acceptEdits or default', '$.mode') : accepted({ kind, mode });
  }
  if (kind === 'plan-feedback') {
    const text = optionalText(body.text, RESPOND_LIMITS.message);
    return text === null ? invalid(`expected feedback of at most ${String(RESPOND_LIMITS.message)} characters`, '$.text') : accepted({ kind, text });
  }
  // Allow once on a request the owner could not see whole is refused; Deny still works.
  if (kind === 'allow-once') return ask.tool?.cut ? refusedKind('allow-once') : accepted({ kind });
  return checkDeny(body.text, ask);
}

function checkReply(raw: unknown, ask: Ask, accepts: readonly RespondKind[]): Checked {
  if (!ask.allowsReply || !accepts.includes(replyNeeds(ask.kind))) return refusedKind('reply');
  const text = typedText(raw, RESPOND_LIMITS.message);
  if (text === null || !text.trim()) return invalid(`expected a message of 1 to ${String(RESPOND_LIMITS.message)} characters`, '$.text');
  return accepted({ kind: 'reply', text });
}

function checkQuestionAnswers(raw: unknown, ask: Ask): Checked {
  const questions = ask.questions ?? [];
  if (!Array.isArray(raw) || raw.length !== questions.length) return invalid(`expected ${String(questions.length)} answers, one per question`, '$.answers');
  const answers: QuestionAnswer[] = [];
  for (let i = 0; i < raw.length; i++) {
    const one = checkOneAnswer(raw[i] as unknown, questions[i]!, `$.answers[${String(i)}]`);
    if ('error' in one) return invalid(one.error, one.path);
    answers.push(one.answer);
  }
  if (answers.every((a) => a === null)) return invalid('answer at least one question', '$.answers');
  return accepted({ kind: 'question', answers });
}

/** One question's answer: null for skipped, typed text where the question takes it, or option indexes (stored in order). */
function checkOneAnswer(raw: unknown, question: AskQuestion, at: string): { answer: QuestionAnswer } | { error: string; path: string } {
  if (raw === null) return { answer: null };
  if (isRecord(raw) && 'text' in raw) {
    if (!question.allowsText) return { error: 'this question takes one of its options, not a typed answer', path: `${at}.text` };
    const text = typedText(raw.text, RESPOND_LIMITS.answer);
    if (text === null || !text.trim()) return { error: `expected an answer of 1 to ${String(RESPOND_LIMITS.answer)} characters`, path: `${at}.text` };
    return { answer: { text } };
  }
  if (isRecord(raw) && Array.isArray(raw.options)) {
    const picked = raw.options as unknown[];
    const inRange = picked.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < question.options.length);
    if (!inRange) return { error: 'an option index is out of range', path: `${at}.options` };
    if (new Set(picked).size !== picked.length) return { error: 'an option is chosen twice', path: `${at}.options` };
    const rightCount = question.multiSelect ? picked.length > 0 : picked.length === 1;
    if (!rightCount) return { error: question.multiSelect ? 'choose at least one option' : 'choose exactly one option', path: `${at}.options` };
    return { answer: { options: [...(picked as number[])].sort((x, y) => x - y) } };
  }
  return { error: 'expected options, text or null', path: at };
}

function checkDeny(raw: unknown, ask: Ask): Checked {
  const text = optionalText(raw, RESPOND_LIMITS.answer);
  if (text === null) return invalid(`expected a reason of at most ${String(RESPOND_LIMITS.answer)} characters`, '$.text');
  if (text.trim() !== '' && ask.tool?.denyReason === false) return invalid('this request takes no reason with a deny', '$.text');
  return accepted({ kind: 'deny', text });
}

/**
 * Reads typed text as a command: the command it names, why it is refused, or null when it does not start with
 * `/`. Only `/clear` and `/compact` are sent from here, each on its own.
 */
export function commandOf(text: string): { command: DashboardCommand } | { refused: string } | null {
  const typed = text.trim();
  if (!typed.startsWith('/')) return null;
  const name = typed.slice(1).split(/\s/)[0] ?? '';
  if (name !== 'clear' && name !== 'compact') return { refused: `/${name} runs only in the terminal. From here you can send /clear and /compact.` };
  return typed === `/${name}` ? { command: name } : { refused: `/${name} takes nothing after it from here. Send /${name} on its own, or use the terminal.` };
}

/** A command, when the session takes commands now. */
function asCommand(command: DashboardCommand, accepts: readonly RespondKind[]): Checked {
  return accepts.includes('command') ? accepted({ kind: 'command', command }) : refusedKind('command');
}

/** Checks a new message or command from the browser: a `command` field, or text that may itself be a command. */
export function parseMessage(body: unknown, accepts: readonly RespondKind[]): Checked {
  if (!isRecord(body)) return invalid('expected an object', '$');
  const command = body.command;
  if (command !== undefined) {
    if (command !== 'clear' && command !== 'compact') return invalid('/clear and /compact are the only commands', '$.command');
    return asCommand(command, accepts);
  }
  const text = typedText(body.text, RESPOND_LIMITS.message);
  if (text === null || !text.trim()) return invalid(`expected a message of 1 to ${String(RESPOND_LIMITS.message)} characters`, '$.text');
  const named = commandOf(text);
  if (named === null) return accepts.includes('message') ? accepted({ kind: 'message', text }) : refusedKind('message');
  return 'refused' in named ? invalid(named.refused, '$.text') : asCommand(named.command, accepts);
}
