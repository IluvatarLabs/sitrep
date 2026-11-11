// Rows in, views out: the SessionView, the blowout level, the charts and the KPIs, with each provider's model family and resume
// command, and the stuck and errored states. Pure: no I/O, no clock but the `now` a caller passes.
import { isReplay, type AgentRow, type BlowoutRow, type EventRow, type MinutePoint, type SampleRow, type SecondPoint, type SessionRow, type SpendRow } from './db.js';
import { checkReporter, supportFor } from './compat.js';
import { erroredState, isStuck, type StuckThresholds } from './alerts.js';
import type { Pricing } from './pricing.js';
import {
  reporterOf,
  type ActivityView,
  type AgentView,
  type AskSummary,
  type BackgroundWait,
  type BlowoutSummary,
  type CollisionView,
  type ContextFill,
  type EventKind,
  type Failure,
  type FilesReport,
  type GitInfo,
  type Kpis,
  type LoopReport,
  type MachineInfo,
  type MachineSpend,
  type MessageView,
  type ModelFamily,
  type ModelUsage,
  type PlanView,
  type ProviderName,
  type RateLimit,
  type RespondInfo,
  type SessionStatusView,
  type SessionView,
  type TokenCounts,
  type UsageTokens,
} from './protocol.js';

/** Points in every chart: a minute of seconds, or an hour of minutes. */
export const SERIES_POINTS = 60;

/** All of a loop's tokens: input, output, cache reads and cache writes. */
export const tokenSum = (t: TokenCounts): number => t.input + t.output + t.cacheRead + t.cacheWrite;

/**
 * A session's or an agent's tokens by kind, from its usage per model, the only usage the server reads (a reporter's `tokens` are
 * not): cache writes of either length are writes. An empty list is zero; no usage at all is unknown (null), never 0.
 */
export function usageTotals(row: Pick<SessionRow, 'usage_json'>): TokenCounts | null {
  const usage = fromJson<ModelUsage[]>(row.usage_json);
  if (!usage) return null;
  const sum = (of: (t: UsageTokens) => number): number => usage.reduce((n, u) => n + of(u.tokens), 0);
  return { input: sum((t) => t.input), output: sum((t) => t.output), cacheRead: sum((t) => t.cacheRead), cacheWrite: sum((t) => t.cacheWrite + t.cacheWrite1h) };
}

/** GPT, ChatGPT and Codex ids, and the o-series. */
const OPENAI_ID = /^(gpt|chatgpt|codex)([-._:\d]|$)|^o\d/;
/** A bare Claude alias, bracketed suffix allowed (`opus[1m]`). */
const CLAUDE_ALIAS = /^(opus|sonnet|haiku|fable|opusplan)(\[[^\]]*\])?$/;

/** The Claude families a model id can name, tried in this order. */
const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/**
 * The family a model belongs to, read from its id in any case: `openai` for the GPT, ChatGPT, Codex and o-series
 * models Codex runs; a Claude family for a bare Claude Code alias or an id that names Claude; `other` for everything else, so a
 * model whose id merely contains a family's word is not taken for Claude.
 */
export const family = (model: string | null | undefined): ModelFamily => {
  const id = model?.toLowerCase() ?? '';
  if (OPENAI_ID.test(id)) return 'openai';
  const claude = id.includes('claude') || CLAUDE_ALIAS.test(id);
  return (claude && CLAUDE_FAMILIES.find((name) => id.includes(name))) || 'other';
};

/**
 * How bad a card's blowouts are: 0 with none; 2, "likely losing context", once there are 3 or more in all or one loop (the main
 * loop or an agent) has had 2 or more; otherwise 1, "context exceeded".
 */
export const blowoutLevel = (main: number, agents: readonly number[]): 0 | 1 | 2 => {
  const loops = [main, ...agents];
  const total = loops.reduce((sum, n) => sum + n, 0);
  if (total === 0) return 0;
  return total >= 3 || loops.some((n) => n >= 2) ? 2 : 1;
};

/** A user's home folder at the start of a path, on macOS or Linux; `/Users/Shared` is not anyone's. */
const ANY_HOME = /^\/(?:Users\/(?!Shared(?:\/|$))[^/]+|home\/[^/]+)(?=\/|$)/;

/** `path` with the home folder it starts in written as `~`: the server user's own (`home`), else any macOS or Linux user's. */
export const shortenHome = (path: string, home: string): string => {
  const own = home.replace(/\/$/, '');
  const underOwn = own !== '' && (path === own || path.startsWith(`${own}/`));
  return underOwn ? `~${path.slice(own.length)}` : path.replace(ANY_HOME, '~');
};

/** A session's project folder: its project root, else its working directory, with the home folder written as `~`. */
export const projectOf = (row: Pick<SessionRow, 'project_root' | 'cwd'>, home: string): string => shortenHome(row.project_root ?? row.cwd, home);

/** Whole seconds in a span of milliseconds, never below 0. */
export const wholeSeconds = (ms: number): number => Math.max(0, Math.floor(ms / 1000));

/** A stored 0/1 column as true or false; null, unknown, stays null. */
const flag = (v: number | null): boolean | null => (v === null ? null : v === 1);

/** A word quoted for a POSIX shell, unless it holds only characters that need none. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_/.,:@%+=-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * `cd <cwd> && claude --resume <id>`, or `cd <cwd> && codex resume <id>`; null for any other provider, which has none
 * the server knows, and with no working directory to go to.
 */
export function resumeCommand(provider: ProviderName, cwd: string, resumeId: string | null, id: string): string | null {
  const resume = provider === 'claude' ? 'claude --resume' : provider === 'codex' ? 'codex resume' : null;
  return resume === null || cwd === '' ? null : `cd ${shellQuote(cwd)} && ${resume} ${shellQuote(resumeId ?? id)}`;
}

/** The resume command with `--fork-session`, or `cd <cwd> && codex fork <id>`; null whenever there is no resume command. */
export function forkCommand(provider: ProviderName, cwd: string, resumeId: string | null, id: string): string | null {
  const resume = resumeCommand(provider, cwd, resumeId, id);
  if (resume === null) return null;
  return provider === 'codex' ? `cd ${shellQuote(cwd)} && codex fork ${shellQuote(resumeId ?? id)}` : `${resume} --fork-session`;
}

/** A stored JSON column read back; null when it is empty or does not parse. */
export function fromJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The provider a row was stored under, as reported: never guessed as Claude or Codex. */
export const providerOf = (row: Pick<SessionRow, 'provider'>): ProviderName => row.provider;

/** The name a session shows: the owner's display name when one is set, else the one its reporter sent. */
export const nameOf = (row: Pick<SessionRow, 'name' | 'display_name'>): string => row.display_name ?? row.name;

/**
 * A session's or an agent's cost: its reported usage per model priced with the one table, the same for every harness;
 * an empty list costs $0. Unknown (null) with no usage at all, or when no model that used tokens has a price; `partial` when some
 * have none, whose tokens the figure leaves out.
 */
export function costParts(pricing: Pricing | undefined, row: Pick<SessionRow, 'usage_json'>): { usd: number | null; partial: boolean } {
  const usage = fromJson<ModelUsage[]>(row.usage_json);
  const usd = pricing && usage ? pricing.costOf(usage) : null;
  return { usd, partial: usd !== null && pricing!.hasUnpriced(usage!) };
}

/** The models a usage column's rows name, each with one figure for its rows, a model's tiers together. */
function figureByModel(usageJson: string | null, figure: (rows: ModelUsage[]) => number): Map<string, number> {
  const rows = new Map<string, ModelUsage[]>();
  for (const u of fromJson<ModelUsage[]>(usageJson) ?? []) rows.set(u.model, [...(rows.get(u.model) ?? []), u]);
  return new Map([...rows].map(([model, ofModel]) => [model, figure(ofModel)]));
}

/** The models `figure` rose on from one usage column to the next, each with its rise. */
function risesByModel(before: string | null, after: string | null, figure: (rows: ModelUsage[]) => number): [string, number][] {
  const was = figureByModel(before, figure);
  return [...figureByModel(after, figure)].flatMap(([model, now]): [string, number][] => {
    const rise = now - (was.get(model) ?? 0);
    return rise > 0 ? [[model, rise]] : [];
  });
}

const usageTokens = (rows: ModelUsage[]): number => rows.reduce((sum, u) => sum + tokenSum(u.tokens) + u.tokens.cacheWrite1h, 0);

/**
 * How a rise in a session's cost falls on its models: in proportion to what each model's priced usage rose by since
 * `before`. Should none have risen, all of it goes to the session's model, so the figures always add up to the rise. A model
 * with no price gets no share; the caller records its spend as unknown (recordSpend).
 */
export function spendShares(pricing: Pricing | undefined, before: string | null, row: Pick<SessionRow, 'usage_json' | 'model'>, rise: number): { model: string; usd: number }[] {
  const priced = risesByModel(before, row.usage_json, (rows) => pricing?.costOf(rows) ?? 0);
  const pricedRise = priced.reduce((sum, [, r]) => sum + r, 0);
  if (pricedRise > 0) return priced.map(([model, r]) => ({ model, usd: (rise * r) / pricedRise }));
  return [{ model: row.model ?? 'unknown', usd: rise }];
}

/** The models with no price row this report's usage rose on, each with its token rise; their spend is unknown, never $0 (`pricing.ts`). */
export function unpricedRises(pricing: Pricing | undefined, prev: Pick<SessionRow, 'usage_json'>, row: Pick<SessionRow, 'usage_json'>): [string, number][] {
  return risesByModel(prev.usage_json, row.usage_json, usageTokens).filter(([model]) => !!model && pricing?.rowFor(model) === null);
}

/** Why a known cost is missing: the model has no price row, or there is no usage to price yet; null when the cost is known. */
export function costReasonOf(pricing: Pricing | undefined, model: string | null, cost: number | null): SessionView['costReason'] {
  if (cost !== null) return null;
  return model && pricing?.rowFor(model) === null ? 'unpriced' : 'pending';
}

/** A loop's plan progress as stored: the steps done, out of how many when known; null when it reported none. */
const stepsOf = (r: Pick<AgentRow, 'steps_done' | 'steps_total'>): AgentView['steps'] => (r.steps_done === null ? null : { done: r.steps_done, total: r.steps_total });

/** A row's context fill, as the views carry it. */
const contextOf = (r: Pick<AgentRow, 'context_tokens' | 'context_window' | 'context_percent'>): ContextFill => ({ tokens: r.context_tokens, window: r.context_window, percent: r.context_percent });

export function agentView(a: AgentRow, provider: ProviderName, pricing: Pricing | undefined, stuck: boolean): AgentView {
  return {
    // Who it is and what launched it.
    id: a.id,
    parentId: a.parent_id,
    provider,
    name: a.name,
    type: a.type,
    kind: a.kind,
    description: a.description,
    // Its model and how hard it was asked to think.
    model: a.model,
    modelFamily: family(a.model),
    effort: a.effort,
    effortSource: a.effort_source ?? 'unknown',
    // Where it stands.
    status: a.status,
    startedAt: a.started_at,
    endedAt: a.ended_at,
    lastActivityAt: a.last_activity_at,
    toolOpen: a.tool_open === 1,
    stuck,
    failure: fromJson<Failure>(a.failure_json),
    // What it used.
    context: contextOf(a),
    tokens: usageTotals(a),
    costUsdEst: costParts(pricing, a).usd,
    blowouts: a.blowouts,
    // What it did.
    skills: fromJson<string[]>(a.skills_json) ?? [],
    lastTool: a.last_tool,
    toolCalls: a.tool_calls,
    toolCounts: fromJson<Record<string, number>>(a.tool_counts_json),
    toolFailures: a.tool_failures,
    steps: stepsOf(a),
    // Its prompt and answer: short excerpts here, and how long the full texts the server holds are.
    promptExcerpt: a.prompt_excerpt ?? '',
    answerExcerpt: a.answer_excerpt,
    promptChars: a.prompt_chars ?? null,
    answerChars: a.answer_chars ?? null,
  };
}

/** The newest second a chart shows: the one before the second `now` falls in, which may still be taking samples. */
export const lastCompleteSecond = (now: number): number => Math.floor(now / 1000) - 1;

/** Minutes in a session's tokens-per-minute row. */
export const MINUTE_POINTS = 30;

/** A chart of `n` points, each `[slot, value]` set where its slot falls; every other point is 0. */
function chart(points: Iterable<readonly [number, number]> = [], n = SERIES_POINTS): number[] {
  const out = new Array<number>(n).fill(0);
  for (const [slot, value] of points) if (slot >= 0 && slot < n) out[slot] = value;
  return out;
}

/** The first second of a session's tokens-per-minute row: MINUTE_POINTS minutes ending at the last complete second. */
export const firstMinuteSecond = (now: number): number => lastCompleteSecond(now) - MINUTE_POINTS * 60 + 1;

/**
 * A session's charts, a point a second for the SERIES_POINTS seconds up to the last complete one, oldest first, 0 for a second
 * with no sample; its tokens in each of the MINUTE_POINTS minutes ending there (`minutes`, from the second firstMinuteSecond
 * gives); and how many seconds ago each recent blowout was. Token figures are output tokens and leave out a `provider`'s replays
 * (`isReplay`), as the fleet's do.
 */
export function buildSeries(samples: readonly SampleRow[], minutes: readonly MinutePoint[], blowouts: readonly Pick<BlowoutRow, 't'>[], now: number, provider: ProviderName): SessionView['series'] {
  const newest = lastCompleteSecond(now);
  const slot = (s: SampleRow): number => s.t - (newest - SERIES_POINTS + 1);
  // A blowout in the second still under way is 0 seconds ago.
  const ages = blowouts.map(({ t }) => newest - Math.floor(t / 1000)).filter((age) => age >= -1 && age < SERIES_POINTS);
  return {
    tokensPerSec: chart(samples.map((s) => [slot(s), isReplay(s, provider) ? 0 : Math.max(0, s.output_delta)] as const)),
    peakContext: chart(samples.map((s) => [slot(s), Math.max(0, Math.min(1, s.peak_context))] as const)),
    running: chart(samples.map((s) => [slot(s), Math.max(0, s.running_agents)] as const)),
    blowoutSecondsAgo: ages.map((age) => Math.max(0, age)).sort((a, b) => a - b),
    tokensPerMin: chart(minutes.map(({ m, v }) => [m, Math.max(0, v)] as const), MINUTE_POINTS),
  };
}

export interface DeriveConfig {
  home: string;
  stuck: StuckThresholds;
}

/**
 * A session that has done nothing yet: not running, and no tokens, context, blowouts, agents or plan.
 * Background daemons start such sessions nobody asked for, each loading the reporter; they stay off the wall until they do
 * something. An unknown blowout count (null) is not a blowout. `agentCount` may be a function, so the count is read only for a
 * row that passes every other test. A session waiting on a permission is never unused: it was asked for something, and
 * Codex reports usage only after its first tool's output, so a fresh session's first approval has none yet. (An open ask, the
 * other wait on the owner, is checked by the fleet, which holds the asks.)
 */
export const isUnused = (row: SessionRow, agentCount: number | (() => number)): boolean => {
  const busy = row.status === 'running' || (row.status === 'waiting' && row.wait_reason === 'permission');
  if (busy) return false;
  const used = usageTotals(row);
  const traces = (used !== null && tokenSum(used) > 0) || Boolean(row.context_tokens) || Boolean(row.blowouts) || row.plan_json !== null;
  if (traces) return false;
  return (typeof agentCount === 'number' ? agentCount : agentCount()) === 0;
};

/** A session's blowouts, or null when its own count is unknown. The totals add only the counts that are known. */
function blowoutSummary(row: SessionRow, agents: readonly AgentRow[], log: readonly BlowoutRow[]): BlowoutSummary | null {
  const own = row.blowouts;
  if (own === null) return null;
  const known = agents.flatMap((a) => (a.blowouts === null ? [] : [a.blowouts]));
  const ofAgents = known.reduce((sum, n) => sum + n, 0);
  return {
    orchestrator: own,
    agents: ofAgents,
    total: own + ofAgents,
    level: blowoutLevel(own, known),
    loopsHit: [own, ...known].filter((n) => n > 0).length,
    loopsTotal: agents.length + 1,
    log: log.map((b) => ({ t: b.t, agentId: b.agent_id, kind: b.kind, tokensBefore: b.tokens_before, tokensAfter: b.tokens_after })),
  };
}

/** What `sessionView` reads: the stored rows, and what only the fleet holds in memory. */
export interface SessionInput {
  /** The session's row, its recent samples and its output tokens per minute (buildSeries), its blowouts and agents. */
  row: SessionRow;
  samples: readonly SampleRow[];
  minutes: readonly MinutePoint[];
  blowouts: readonly BlowoutRow[];
  agents: readonly AgentRow[];
  /** When a session nobody is attached to is set aside (the fleet knows the delay); null while attached or not reported. */
  hideAt: number | null;
  /** The price table, to price a session or agent from its usage. */
  pricing?: Pricing;
  /** Whether the reporter has the activityFeed option on, held in memory; null when unknown. */
  activityFeed: boolean | null;
  /** Report.session.respond as last reported, held in memory; null when unknown. */
  respond: RespondInfo | null;
  /** Its asks as the respond store holds them, without what they ask. */
  asks: AskSummary[];
  /** Other loops that edited this session's files in the last 5 minutes. */
  collisions: CollisionView[];
  /** Messages between this session's loops in the last 30 minutes. */
  messages: MessageView[];
}

/** Whether any agent below `id` (its children, theirs, and so on) is running. */
function runningBelow(id: string, agents: readonly AgentRow[]): boolean {
  const reached = new Set([id]);
  for (const parent of reached) {
    for (const a of agents) {
      if (a.parent_id !== parent || reached.has(a.id)) continue;
      if (a.status === 'running') return true;
      reached.add(a.id);
    }
  }
  return false;
}

/** Each agent's view. An agent is stuck by its own family's threshold, and never while one of its asks is open. */
function agentViews(input: SessionInput, provider: ProviderName, status: SessionStatusView, now: number, stuck: StuckThresholds): AgentView[] {
  const sessionLive = status === 'running' || status === 'waiting';
  const asking = new Set(input.asks.filter((a) => a.state !== 'closed').map((a) => a.agentId));
  return input.agents.map((a) => {
    const liveness = {
      running: sessionLive && a.status === 'running',
      waiting: asking.has(a.id),
      runningUnder: runningBelow(a.id, input.agents),
      lastActivityAt: a.last_activity_at,
      toolOpen: a.tool_open === 1,
      family: family(a.model),
    };
    return agentView(a, provider, input.pricing, isStuck(liveness, now, stuck));
  });
}

/** The reported wait reasons the views carry; anything else reads as none. */
const WAIT_REASONS: readonly NonNullable<SessionView['waitReason']>[] = ['permission', 'input', 'idle'];

export function sessionView(input: SessionInput, now: number, { home, stuck: thresholds }: DeriveConfig): SessionView {
  const { row, agents, samples, blowouts } = input;
  const provider = providerOf(row);
  const status = row.status;
  const loop = fromJson<LoopReport>(row.loop_json);
  const waitReason = WAIT_REASONS.find((w) => w === row.wait_reason) ?? null;
  const toolOpen = row.tool_open === 1;
  const lastActivityAt = row.last_activity_at;
  const own = { running: status === 'running', waiting: false, runningUnder: agents.some((a) => a.status === 'running'), lastActivityAt, toolOpen, family: family(row.model) };
  const failure = { status, waitReason, apiErrorAt: row.api_error_at, apiError: row.api_error, toolFailures: row.tool_failures, lastActivityAt, toolOpen, lastTool: loop?.lastTool ?? null };
  const { usd: costUsd, partial: costPartial } = costParts(input.pricing, row);
  const used = usageTotals(row);
  return {
    // Which session, whose, and where it runs.
    id: row.id,
    nativeId: row.native_id,
    name: nameOf(row),
    renamed: row.display_name !== null,
    provider,
    owner: row.owner,
    machine: fromJson<MachineInfo>(row.machine_json) ?? { name: row.machine_id ?? 'unknown', id: row.machine_id ?? '', os: null },
    hostSurface: row.host_surface,
    project: projectOf(row, home),
    cwd: shortenHome(row.cwd, home),
    repoName: row.repo_name,
    git: fromJson<GitInfo>(row.git_json),
    resumeCommand: resumeCommand(provider, row.cwd, row.resume_id, row.native_id),
    forkCommand: forkCommand(provider, row.cwd, row.resume_id, row.native_id),
    clearedFrom: row.cleared_from,
    // The reporter, against the range this server supports for it.
    reporterVersion: row.reporter_version,
    reporterBuild: row.reporter_build,
    compat: checkReporter(row.reporter_version, supportFor(reporterOf(provider))),
    // Where it stands, and the server's clocks on it.
    status,
    waitReason,
    waitNote: row.wait_note,
    endReason: row.end_reason,
    background: fromJson<BackgroundWait>(row.background_json),
    attached: flag(row.attached),
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    secondsSinceSeen: wholeSeconds(now - row.last_seen_at),
    hideAt: input.hideAt,
    // Liveness and trouble.
    lastActivityAt,
    toolOpen,
    toolFailures: row.tool_failures,
    stuck: isStuck(own, now, thresholds),
    errored: erroredState(failure, now),
    hooksActive: provider === 'codex' ? flag(row.hooks_active) : null,
    // Model, usage and spend.
    model: row.model,
    modelFamily: family(row.model),
    effort: row.effort,
    context: contextOf(row),
    costUsd,
    costReason: costReasonOf(input.pricing, row.model, costUsd),
    costPartial,
    tokensTotal: used && tokenSum(used),
    rateLimits: fromJson<RateLimit[]>(row.rate_limits_json) ?? [],
    blowouts: blowoutSummary(row, agents, blowouts),
    // Its work, its agents, and what other loops did to the same files.
    plan: fromJson<PlanView>(row.plan_json),
    loop,
    files: fromJson<FilesReport>(row.files_json),
    agents: agentViews(input, provider, status, now, thresholds),
    collisions: input.collisions,
    messages: input.messages,
    // The feed and answering, as the reporter last said and the respond store holds them.
    activityFeed: input.activityFeed,
    respond: input.respond,
    asks: input.asks,
    series: buildSeries(samples, input.minutes, blowouts, now, provider),
  };
}

/** How far back a session's messages between its loops reach, and how many of the newest it shows. */
export const MESSAGE_WINDOW_MS = 30 * 60_000;
export const MESSAGE_LIMIT = 20;

/** A stored `message` event as the session shows it. `to` is left out when the reporter could not tie `toName` to a loop. */
export function messageView(e: EventRow): MessageView {
  const { to, toName } = fromJson<{ to?: string | null; toName?: string }>(e.data_json) ?? {};
  return { from: e.agent_id, ...(to === undefined ? {} : { to }), toName: toName ?? '', text: e.text, at: e.t };
}

/** A stored event as an activity row, named after its session (its display name when it has one). */
export function activityView(e: EventRow, session: Pick<SessionRow, 'name' | 'display_name' | 'model'> | undefined): ActivityView {
  return {
    id: e.id,
    sessionId: e.session_id,
    agentId: e.agent_id,
    sessionName: session ? nameOf(session) : 'session',
    modelFamily: family(session?.model),
    t: e.t,
    kind: e.kind as EventKind,
    text: e.text,
    data: fromJson<Record<string, unknown>>(e.data_json),
  };
}

/** What the KPIs are made from besides the live views. */
export interface KpiInput {
  views: readonly SessionView[];
  /** The spend record by machine and model, and the first day it holds. */
  spend: { rows: readonly SpendRow[]; since: string | null };
  /** The whole fleet's output tokens per second (the samples' output rises added up). */
  tokensPerSecond: readonly SecondPoint[];
  /** USD the spend record booked per minute, the whole fleet's. */
  costPerMinute: readonly MinutePoint[];
}

/** Today's spend by machine, largest first. The record never holds a row of $0, so a figure of 0 is a machine with no row today. */
function spendByMachine(rows: readonly SpendRow[]): MachineSpend[] {
  const perMachine = new Map<string, MachineSpend>();
  for (const r of rows) {
    if (r.today === 0) continue;
    const m = perMachine.get(r.machineId) ?? { machineId: r.machineId, costUsd: 0, unpriced: false };
    m.costUsd += r.today ?? 0;
    m.unpriced ||= r.today === null;
    perMachine.set(r.machineId, m);
  }
  return [...perMachine.values()].sort((a, b) => b.costUsd - a.costUsd || (a.machineId < b.machineId ? -1 : 1));
}

/**
 * The fleet's figures for the state bar and Machines: counts over the live views, an ended session still lingering on the wall left
 * out; spend from the record, rates from the samples.
 */
export function computeKpis({ views: wall, spend, tokensPerSecond, costPerMinute }: KpiInput, now: number): Kpis {
  const views = wall.filter((v) => v.status !== 'done');
  const counted = (test: (v: SessionView) => boolean): number => views.filter(test).length;
  const agents = views.flatMap((v) => v.agents);
  // Tokens on a model the price table has no row for, all of a session's or a share of them, are left out of its cost.
  const unpriced = (v: SessionView): boolean => v.costPartial || (!!v.model && v.costUsd === null && (v.tokensTotal ?? 0) > 0);
  const firstSecond = lastCompleteSecond(now) - SERIES_POINTS + 1;
  const firstMinute = Math.floor(now / 60_000) - SERIES_POINTS + 1;
  return {
    live: views.length,
    running: counted((v) => v.status === 'running'),
    stuck: counted((v) => v.stuck),
    agentsRunning: agents.filter((a) => a.status === 'running').length,
    agentsWaiting: agents.filter((a) => a.status === 'queued').length,
    unpricedSessions: counted(unpriced),
    costToday: spend.rows.reduce((sum, r) => sum + (r.today ?? 0), 0),
    costTodayByMachine: spendByMachine(spend.rows),
    spendRecord: spend.rows.map((r) => ({ ...r, provider: providerOf(r), family: family(r.model) })),
    spendSince: spend.since,
    costPerMinute: chart(costPerMinute.map(({ m, v }) => [m - firstMinute, v] as const)),
    tokensPerSec: chart(tokensPerSecond.map(({ t, v }) => [t - firstSecond, v] as const)),
  };
}
