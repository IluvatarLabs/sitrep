// A report becomes rows: the session, its agents and their texts, new events, blowouts, this second's sample and what it spent,
// all in one transaction. So does a batch of Claude Code's API requests, Claude's only source of usage.
import type { ActivityEvent, AgentReport, ContextFill, ModelUsage, Plan, PlanStepView, PlanView, Report, SessionReport } from './protocol.js';
import { sessionKey, type AgentRow, type EventRow, type FleetDb, type ReportedSession, type SessionRow } from './db.js';
import { costParts, fromJson, spendShares, tokenSum, unpricedRises, usageTotals } from './derive.js';
import { localDay } from './days.js';
import type { Pricing } from './pricing.js';
import type { ApiRequest } from './telemetry.js';

/** What storing a report did, for the fleet's log lines, live set and broadcasts. */
export interface IngestResult {
  /** The session's id on the server (sessionKey), not the reporter's. */
  sessionId: string;
  /** The session had no row before this report. */
  created: boolean;
  /** A session that had ended or been dropped reports as live again. */
  revived: boolean;
  /** The stored row already said done. */
  wasDone: boolean;
  /** This report says done. */
  ended: boolean;
  /** The events stored now; an id stored before is skipped. */
  newEvents: EventRow[];
  /** The report's sentAt less the server's time: for debugging, and to place activity entries against a lease. */
  clockSkewMs: number;
}

/** How far a session's first reported start may be from the moment the server first hears of it and still be believed. */
export const START_TOLERANCE_MS = 120_000;

/**
 * The provider whose usage comes from its harness's own telemetry, one record per API request (`ingestRequests`), and never from its
 * reports: Claude Code's `api_request` events count every request, its side requests too, which the plugin never saw.
 */
export const TELEMETRY_PROVIDER = 'claude';

/** A JSON column: null for null or undefined. */
const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
/** A boolean column: 1, 0, or null for unknown. */
const bit = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
/** A reported number rounded, or null when it is not a finite number. */
const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/** A loop's context fill, in the columns the session and agent tables share. */
const contextColumns = (c: ContextFill) => ({ context_tokens: c.tokens, context_window: c.window, context_percent: c.percent });

/**
 * When the session started. A Hermes session's reported start is always believed: its reporter reads it from Hermes's own store.
 * Any other is fixed once stored, and on its first report the reporter's time is believed when it is near the moment the server
 * first heard of the session; otherwise, since Codex's daemon can give every session under it one host-wide value, the session
 * started when the server first heard of it.
 */
function startedAt(r: Report, prev: SessionRow | undefined, serverTime: number): number {
  const reported = r.session.startedAt;
  if (r.provider === 'hermes') return reported;
  if (prev) return prev.started_at;
  return Math.abs(reported - serverTime) <= START_TOLERANCE_MS ? reported : serverTime;
}

/** When the session ended: the first report saying done sets it, and a repeat of that report keeps it. */
function endedAt(s: SessionReport, prev: SessionRow | undefined, serverTime: number): number | null {
  if (s.status !== 'done') return null;
  return prev?.status === 'done' && prev.ended_at !== null ? prev.ended_at : serverTime;
}

/** Since when nobody has been attached: set by the first report with nobody attached, and kept while that stays true. */
function detachedAt(s: SessionReport, prev: SessionRow | undefined, serverTime: number): number | null {
  if (s.attached !== false) return null;
  return prev?.attached === 0 && prev.detached_at !== null ? prev.detached_at : serverTime;
}

/** Whether a stored plan and a reported one are the same plan: same source and title, and shared step ids whose text agrees. */
function samePlan(stored: PlanView, reported: Plan): boolean {
  if (stored.source !== reported.source || stored.title !== reported.title) return false;
  const storedText = new Map(stored.steps.map((step) => [step.id, step.text]));
  const shared = reported.steps.filter((step) => storedText.has(step.id));
  return shared.length > 0 && shared.every((step) => storedText.get(step.id) === step.text);
}

/**
 * Numbers each done step (`doneSeq`) in the order the server saw the steps finish, so the plan can list them in that order. A
 * step keeps its number while it stays done and loses it when reopened. Steps already done in the first plan the server sees
 * get none, and a different plan from the one stored (`prevJson`) starts again.
 */
function withDoneOrder(plan: Plan | null, prevJson: string | null): PlanView | null {
  if (!plan?.steps.some((step) => step.state === 'done')) return plan;
  const stored = fromJson<PlanView>(prevJson);
  if (!stored || !samePlan(stored, plan)) return plan;
  const was = new Map(stored.steps.map((step) => [step.id, step]));
  let next = 1 + Math.max(0, ...stored.steps.map((step) => step.doneSeq ?? 0));
  const steps = plan.steps.map((step): PlanStepView => {
    if (step.state !== 'done') return step;
    const before = was.get(step.id);
    if (before?.state !== 'done') return { ...step, doneSeq: next++ };
    return before.doneSeq === undefined ? step : { ...step, doneSeq: before.doneSeq };
  });
  return { ...plan, steps };
}

/**
 * The main loop's model API failure that stands: the newest of its new `fail` events that carries a `category`,
 * until the session is seen running again with activity after it.
 */
function standingApiError(prev: SessionRow | undefined, newEvents: readonly EventRow[], s: SessionReport): { at: number | null; category: string | null } {
  let failure = { at: prev?.api_error_at ?? null, category: prev?.api_error ?? null };
  for (const e of newEvents) {
    if (e.kind !== 'fail' || e.agent_id !== null || !e.data_json) continue;
    const category = (JSON.parse(e.data_json) as { category?: unknown }).category;
    if (typeof category === 'string' && (failure.at === null || e.t >= failure.at)) failure = { at: e.t, category };
  }
  const ranSince = failure.at !== null && s.status === 'running' && s.lastActivityAt !== null && s.lastActivityAt > failure.at;
  return ranSince ? { at: null, category: null } : failure;
}

/** The session's row; `usage` is its usage as the session's source gives it, undefined when unknown, which keeps the stored usage. */
function sessionRow(r: Report, prev: SessionRow | undefined, serverTime: number, owner: string | null, newEvents: readonly EventRow[], usage: ModelUsage[] | undefined): ReportedSession {
  const s = r.session;
  const failure = standingApiError(prev, newEvents, s);
  // The plan stored last, whether the last report carried it or it was kept through a gap.
  const lastPlan = prev?.plan_json ?? prev?.plan_kept_json ?? null;
  return {
    // Whose session, and which reporter on which machine sent it.
    id: sessionKey(s.id, r.machine.id),
    native_id: s.id,
    provider: r.provider,
    owner: owner ?? prev?.owner ?? null,
    machine_id: r.machine.id,
    machine_json: JSON.stringify(r.machine),
    reporter_version: r.reporter.version,
    reporter_build: r.reporter.build ?? null,
    engine_version: r.reporter.engineVersion,
    host_surface: r.reporter.hostSurface,
    // What it is and where it runs.
    name: s.name,
    cwd: s.cwd,
    project_root: s.projectRoot,
    repo_name: s.repoName,
    git_json: json(s.git),
    // Where it stands. last_seen_at is the server's clock, never the reporter's.
    status: s.status,
    wait_reason: s.waitReason,
    wait_note: s.waitNote,
    end_reason: s.endReason,
    resume_id: s.resumeId,
    started_at: startedAt(r, prev, serverTime),
    last_seen_at: serverTime,
    ended_at: endedAt(s, prev, serverTime),
    dropped_at: null,
    attached: bit(s.attached),
    detached_at: detachedAt(s, prev, serverTime),
    // Set once; a later report without it keeps the link. A /clear continues a session on the same machine.
    cleared_from: s.clearedFrom ? sessionKey(s.clearedFrom, r.machine.id) : (prev?.cleared_from ?? null),
    // Model, usage and spend.
    model: s.model,
    // A reporter learns a loop's effort from its next model request, so one that has just started on a session already
    // running (a resume, a reloaded plugin) reports none until then: the effort stored for the same model stays.
    effort: s.effort ?? (prev && prev.model === s.model ? prev.effort : null),
    ...contextColumns(s.context),
    // Usage not known now leaves the stored usage as it is.
    usage_json: usage === undefined ? (prev?.usage_json ?? null) : json(usage),
    rate_limits_json: json(s.rateLimits),
    blowouts: s.blowouts,
    // Liveness and trouble.
    tool_failures: s.toolFailures,
    hooks_active: bit(s.hooksActive),
    last_activity_at: s.lastActivityAt,
    tool_open: s.toolOpen ? 1 : 0,
    api_error_at: failure.at,
    api_error: failure.category,
    // Its work. While a report carries no plan, the last one is kept so the finish order survives the gap.
    plan_json: json(withDoneOrder(s.plan, lastPlan)),
    plan_kept_json: s.plan ? null : lastPlan,
    loop_json: json(s.loop),
    files_json: json(s.files),
    background_json: json(s.background),
  };
}

/**
 * An agent's row, in the groups agentView reads it back in; its full prompt and answer go to agent_texts (storeAgents). `usage` is
 * as for sessionRow: undefined keeps the stored usage (upsertAgent).
 */
function agentRow(sessionId: string, a: AgentReport, usage: ModelUsage[] | undefined): AgentRow {
  return {
    // Who it is and what started it.
    session_id: sessionId,
    id: a.id,
    parent_id: a.parentId,
    kind: a.kind,
    type: a.type,
    name: a.name,
    description: a.description,
    // Where it stands.
    status: a.status,
    started_at: a.startedAt,
    ended_at: a.endedAt,
    last_activity_at: a.lastActivityAt,
    tool_open: a.toolOpen ? 1 : 0,
    failure_json: json(a.failure),
    // Its model, and what it used.
    model: a.model,
    effort: a.effort,
    effort_source: a.effortSource,
    ...contextColumns(a.context),
    usage_json: json(usage),
    blowouts: a.blowouts,
    // What it did.
    skills_json: JSON.stringify(a.skills),
    last_tool: a.lastTool,
    tool_calls: a.toolCalls,
    tool_counts_json: json(a.toolCounts),
    tool_failures: a.toolFailures,
    steps_done: a.steps?.done ?? null,
    steps_total: a.steps?.total ?? null,
    // Excerpts of its prompt and answer.
    prompt_excerpt: a.promptExcerpt,
    answer_excerpt: a.answerExcerpt,
  };
}

/** Stores the report's events, skipping ids stored before, and returns the ones stored now. */
function storeEvents(f: FleetDb, sessionId: string, events: readonly ActivityEvent[]): EventRow[] {
  const rows = events.map((e): EventRow => ({ id: e.id, session_id: sessionId, agent_id: e.agentId, t: e.t, kind: e.kind, text: e.text, data_json: json(e.data) }));
  return rows.filter((row) => f.insertEvent(row));
}

/**
 * Upserts each agent the report lists, with its usage as `usageOf` gives it and any full text it sent; one it leaves out stays, as a
 * reload can lose an agent. A report that ends the session (`endedNow`, the server's time then) aborts every agent still running
 * or queued.
 */
function storeAgents(f: FleetDb, sessionId: string, agents: readonly AgentReport[], usageOf: (a: AgentReport) => ModelUsage[] | undefined, endedNow: number | null): void {
  for (const a of agents) {
    f.upsertAgent(agentRow(sessionId, a, usageOf(a)));
    if (a.promptText || a.answerText) f.upsertAgentTexts(sessionId, a.id, { prompt: a.promptText || undefined, answer: a.answerText || undefined });
  }
  if (endedNow !== null) f.abortUnfinishedAgents(sessionId, endedNow);
}

/** A blowouts row for each new `blow` event whose data names its kind. */
function storeBlowouts(f: FleetDb, sessionId: string, newEvents: readonly EventRow[]): void {
  for (const e of newEvents) {
    const data = e.kind === 'blow' && e.data_json ? (JSON.parse(e.data_json) as Record<string, unknown>) : null;
    if (typeof data?.kind !== 'string' || data.kind === '') continue;
    f.addBlowout({ session_id: sessionId, agent_id: e.agent_id, t: e.t, kind: data.kind.slice(0, 40), tokens_before: whole(data.tokensBefore), tokens_after: whole(data.tokensAfter) });
  }
}

/**
 * This second's sample, from a report that carries usage: every token of the session, its agents' included, and the rise since the
 * sample before; the same two for its output tokens alone (what the token rates count); the fullest context among the main loop and
 * its running agents; how many agents run (none once the session has ended); and `spent`, what this report booked to the spend
 * record.
 */
function storeSample(f: FleetDb, row: ReportedSession, serverTime: number, ended: boolean, spent: number): void {
  const t = Math.floor(serverTime / 1000);
  const running = f.getAgents(row.id).filter((a) => a.status === 'running');
  const used = usageTotals(row)!;
  const before = f.previousSample(row.id, t);
  const peakPercent = Math.max(row.context_percent ?? 0, ...running.map((a) => a.context_percent ?? 0));
  const tokensRise = before ? tokenSum(used) - before.tokens_total : 0;
  const outputRise = before && before.output_total !== null ? used.output - before.output_total : 0;
  f.upsertSample({
    session_id: row.id,
    t,
    tokens_total: tokenSum(used),
    tokens_delta: Math.max(0, tokensRise),
    output_total: used.output,
    output_delta: Math.max(0, outputRise),
    peak_context: Math.max(0, Math.min(1, peakPercent / 100)),
    running_agents: ended ? 0 : running.length,
    spend_usd: spent,
  });
}

/**
 * Books what this report spent: the session's cost, as its card shows it, less the highest figure already counted, on the
 * server's day, in the transaction that stores the session, so a restart or a kill can neither lose it nor count it twice. A
 * session's first figure only sets that mark: a resumed session's first figure is its whole life, not today's spend. A
 * figure at or below the mark books nothing. Only a report that carries usage, from a provider other than TELEMETRY_PROVIDER,
 * comes here. Returns the USD booked.
 */
function recordSpend(f: FleetDb, pricing: Pricing | undefined, row: ReportedSession, prev: SessionRow | undefined, machineId: string, serverTime: number): number {
  const { usd: cost, partial } = costParts(pricing, row);
  if (!prev) {
    f.setSpendCounted(row.id, cost);
    return 0;
  }
  const where = { day: localDay(serverTime), machine_id: machineId, provider: row.provider };
  // Unknown stays unknown, never $0, whatever the cost does below: a session can mix priced and unpriced models.
  if (cost === null || partial) for (const [model] of unpricedRises(pricing, prev, row)) f.addSpend({ ...where, model, usd: null });
  const counted = prev.spend_counted;
  if (cost === null || (counted !== null && cost <= counted)) return 0;
  f.setSpendCounted(row.id, cost);
  if (counted === null) return 0;
  for (const { model, usd } of spendShares(pricing, prev.usage_json, row, cost - counted)) f.addSpend({ ...where, model, usd });
  return cost - counted;
}

/**
 * Stores one validated report under its session's id on the server (sessionKey). `serverTime`, never the reporter's clock, sets
 * last_seen_at. `owner` is `Admin` when the report carried the admin secret; null (no secret configured) leaves a stored owner as
 * it was. `pricing` prices the spend it records.
 */
export function ingestReport(f: FleetDb, report: Report, serverTime: number, owner: string | null = null, pricing?: Pricing): IngestResult {
  return f.tx(() => {
    const sid = sessionKey(report.session.id, report.machine.id);
    const prev = f.getSession(sid);
    // Events first, so the failure the row carries reads only the events this report added.
    const newEvents = storeEvents(f, sid, report.events);
    // A Claude session's usage, and each of its agents', is its requests' sums (ingestRequests), never its report's. Until it has
    // requests, what is stored stays: unknown, or its figure from before Claude usage came from telemetry.
    const fromTelemetry = report.provider === TELEMETRY_PROVIDER;
    const sums = (agentId?: string): ModelUsage[] | undefined => f.requestUsage(sid, agentId) ?? undefined;
    const row = sessionRow(report, prev, serverTime, owner, newEvents, fromTelemetry ? sums() : report.session.usageByModel);
    const ended = row.status === 'done';
    f.upsertSession(row);
    storeAgents(f, sid, report.agents, (a) => (fromTelemetry ? sums(a.id) : a.usageByModel), ended ? serverTime : null);
    storeBlowouts(f, sid, newEvents);
    // This second's sample, while the session's usage is known. A Claude report books nothing, its requests book their own spend;
    // any other report that carries usage books its rise. A report without usage leaves the figure unknown in it: it books nothing,
    // moves no mark and takes no sample; the sweep carries the last sample on (Fleet.carrySample).
    if (fromTelemetry) {
      if (row.usage_json !== null) storeSample(f, row, serverTime, ended, 0);
    } else if (report.session.usageByModel !== undefined) storeSample(f, row, serverTime, ended, recordSpend(f, pricing, row, prev, report.machine.id, serverTime));
    return {
      sessionId: sid,
      created: prev === undefined,
      revived: prev !== undefined && !ended && (prev.ended_at !== null || prev.dropped_at !== null),
      wasDone: prev?.status === 'done',
      ended,
      newEvents,
      clockSkewMs: report.sentAt - serverTime,
    };
  });
}

/**
 * Stores a batch of Claude Code's API requests from one machine, in one transaction. A request already counted (its id
 * noted) is skipped, so an exporter's resend counts nothing. Each new one adds its tokens to its session's sums, and books its price,
 * at the fast tier when it was made in fast mode, else at the long tier when its own prompt is long, to the spend record on its own day: every request is spend as it happens, with no
 * mark and no first figure. A session not reported yet keeps its sums until its first report reads them. Each stored session the
 * batch touched then takes its usage, and its agents theirs, from the sums, and this second's sample with what the batch booked for
 * it; a report in the same second writes the same sample again with the same figures (storeSample), so nothing counts twice.
 * Returns the sessions touched.
 */
export function ingestRequests(f: FleetDb, machineId: string, requests: readonly ApiRequest[], serverTime: number, pricing?: Pricing): string[] {
  return f.tx(() => {
    const touched = new Map<string, { spent: number; agents: Set<string> }>();
    for (const r of requests) {
      if (!f.addRequest(r.requestId, serverTime)) continue;
      const sid = sessionKey(r.sessionId, machineId);
      f.addRequestUsage(sid, r.agentId ?? '', r.usage, serverTime);
      // An unpriced model's spend is unknown, never $0 (addSpend); a request that cost nothing adds no row.
      const usd = pricing ? pricing.costOf([r.usage]) : null;
      if (usd !== 0) f.addSpend({ day: localDay(r.t), machine_id: machineId, provider: TELEMETRY_PROVIDER, model: r.usage.model, usd });
      const session = touched.get(sid) ?? { spent: 0, agents: new Set<string>() };
      session.spent += usd ?? 0;
      if (r.agentId !== null) session.agents.add(r.agentId);
      touched.set(sid, session);
    }
    for (const [sid, { spent, agents }] of touched) {
      for (const agentId of agents) f.setUsage(sid, agentId, f.requestUsage(sid, agentId)!);
      f.setUsage(sid, null, f.requestUsage(sid)!);
      const row = f.getSession(sid);
      if (row) storeSample(f, row, serverTime, row.status === 'done', spent);
    }
    return [...touched.keys()];
  });
}
