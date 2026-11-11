// SessionState to Report. Pure. Every free-text field is redacted and held to its limit here,
// so nothing leaves the machine unredacted.
import { clip, excerpt, LIMITS } from './failures.ts';
import { lastSegment } from './git.ts';
import { windowOf } from './models.ts';
import { planOf } from './plan.ts';
import type { ActivityEntry, ActivityEvent, AgentReport, Ask, Failure, FilesReport, LoopReport, MachineInfo, Report, RespondInfo } from './protocol.ts';
import { withPlanOwners, type AgentState, type LoopStats, type SessionState } from './state.ts';

/** What one report holds at most: events, agents, full-text and feed-summary characters, command characters (the server's
 *  `activityDetailChars`), and serialized bytes, with a margin inside the server's 512 KB body limit. */
const PER_REPORT = { events: 100, agents: 200, fullText: 120_000, feeds: 60_000, commands: 200_000, bytes: 480_000 } as const;
/** The most a command may hold as the server takes it: the 20,000-character cut plus its note. */
const COMMAND_MAX = 20_100;

export interface ReportMeta {
  now: number;
  /** This machine, always sent. */
  machine: MachineInfo;
  /** The report's `reporter` block, as session.start built it. */
  reporter: Report['reporter'];
  /** The names the display name is chosen from, the first filled one winning: `/sitrep name`, Claude Code's own
   *  names for the session (its `/rename` title, then the title it generated), the `sessionName` option, then the session's
   *  first prompt (redacted as free text when taken). As /resume lists a session: its custom title, else its AI title. */
  names: (string | null)[];
  /** The fullPrompts option: each agent's whole prompt and answer, once. */
  fullText: boolean;
  /** The activityFeed option: the feed of each loop the server lists as watched. */
  activity: boolean;
  /** Whether and how far the session can be answered from the dashboard. */
  respond: RespondInfo;
  /** The asks open now, sent only while the server takes answers. */
  asks: Ask[] | null;
  /** The id a /clear replaced, when this session carries on from it; else null. */
  clearedFrom: string | null;
}

/** A trimmed text, or null for one that is empty or only whitespace. */
const filled = (v: string | null | undefined): string | null => v?.trim() || null;

/**
 * The display name: the first of `names` with something in it, else a worktree's branch (or its folder when detached), else
 * the repository folder, else a name made from the id.
 */
function displayName(s: Pick<SessionState, 'id' | 'git' | 'projectRoot'>, names: (string | null)[]): string {
  const git = s.git?.isWorktree ? s.git : null;
  const worktree = git ? (filled(git.branch && !git.detached ? lastSegment(git.branch) : null) ?? filled(git.worktreePath && lastSegment(git.worktreePath))) : null;
  const chosen = names.map(filled).find((n) => n !== null) ?? worktree ?? filled(s.projectRoot && lastSegment(s.projectRoot));
  return clip(chosen ?? `session-${s.id.slice(0, 6)}`, 80);
}

/** `owner/name` from an origin URL (`git@github.com:o/n.git`, `https://host/o/n`); null when it ends in no such pair. */
export const repoFromRemote = (remote: string | null | undefined): string | null => {
  const tail = remote ? /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim()) : null;
  return tail ? `${tail[1]}/${tail[2]}` : null;
};

/** A failure record held to the contract's limits once more, each text redacted again on the way. */
function boundedFailure(f: Failure | null): Failure | null {
  if (!f) return null;
  const line = (l: string) => clip(l, LIMITS.line);
  const tool = f.tool ? clip(f.tool, 120) : null;
  const call = f.call ? clip(f.call, LIMITS.call) : null;
  return { ...f, tool, call, outputTail: f.outputTail.slice(-LIMITS.outputLines).map(line), evidence: f.evidence.slice(0, LIMITS.evidenceLines).map(line) };
}

/** `tokens` as a percent of `window` to one decimal, at most 100; null when either is unknown or the window is 0. */
const percentOf = (tokens: number | null, window: number | null): number | null =>
  tokens !== null && window ? Math.round(Math.min(100, (tokens / window) * 100) * 10) / 10 : null;

/** The window Claude Code reports for the session's model (`$.session.usage().context.window`), and that model. */
type SessionWindow = { model: string | null; window: number | null };

/** The block an agent entry and the main loop share: skills, last tool, call counts and model requests. */
function loopBlock(l: LoopStats): LoopReport {
  const toolCounts = Object.fromEntries(Object.entries(l.toolCounts).map(([name, n]) => [clip(name, 120), n]));
  return { skills: l.skills.slice(0, 50).map((name) => clip(name, 120)), lastTool: l.lastTool, toolCalls: l.toolCalls, toolCounts, steps: { done: l.steps, total: null } };
}

/** The liveness facts each loop carries. */
const liveness = (l: LoopStats) => ({ lastActivityAt: l.lastActivityAt, toolOpen: l.openTools > 0, toolFailures: l.toolFailures });

/** One feed entry as sent. Its summary is redacted and cut again here; a command was redacted when captured and is only held to the limit. */
function sentEntry(e: ActivityEntry): ActivityEntry {
  const sent: ActivityEntry = { at: e.at, kind: e.kind, text: clip(e.text, LIMITS.activity) };
  if (e.kind !== 'tool') return sent;
  if (e.id !== undefined) sent.id = clip(e.id, 200);
  if (e.command !== undefined) sent.command = e.command.slice(0, COMMAND_MAX);
  if (e.command !== undefined && e.commandCut) sent.commandCut = true;
  if (e.done) sent.done = true;
  if (e.exitCode !== undefined) sent.exitCode = e.exitCode;
  if (e.failed) sent.failed = true;
  return sent;
}

/** An agent's report. */
function agentBlock(a: AgentState, fullText: boolean, activity: boolean, session: SessionWindow): AgentReport {
  // The model's window (models.ts); for a model it does not know, the only window Claude Code reports, the session model's,
  // when the agent runs that model; otherwise unknown.
  const window = a.window ?? windowOf(a.model) ?? (a.model !== null && a.model === session.model ? session.window : null);
  const { parentId, kind, model, effort, effortSource, status, startedAt, endedAt, blowouts } = a;
  const block: AgentReport = {
    id: clip(a.id, 200),
    parentId,
    kind,
    type: clip(a.type, 120),
    name: a.name ? clip(a.name, 80) : null,
    description: clip(a.description, 240),
    model,
    effort,
    effortSource,
    status,
    startedAt,
    endedAt,
    context: { tokens: a.ctxTokens, window, percent: percentOf(a.ctxTokens, window) },
    // Required by the report format and not read: Claude usage reaches the server from Claude Code's own telemetry.
    costUsdEst: null,
    ...loopBlock(a),
    blowouts,
    // Both were excerpted when taken; held to the limit once more.
    promptExcerpt: excerpt(a.promptExcerpt, LIMITS.excerpt),
    answerExcerpt: excerpt(a.answerExcerpt, LIMITS.excerpt) || null,
    failure: boundedFailure(a.failure),
    ...liveness(a),
  };
  // A full text goes once: an accepted report marks it sent.
  if (fullText && a.promptText && !a.promptSent) block.promptText = a.promptText;
  if (fullText && a.answerText && !a.answerSent) block.answerText = a.answerText;
  if (activity && a.activity.length > 0) block.activity = a.activity.map(sentEntry);
  return block;
}

/** Full texts past the per-report budget wait for a later report (they stay unsent); the first one always goes, however long. */
function fullTextsWithin(blocks: AgentReport[]): AgentReport[] {
  let spent = 0;
  const fits = (text: string | undefined): text is string => {
    if (text === undefined || (spent > 0 && spent + text.length > PER_REPORT.fullText)) return false;
    spent += text.length;
    return true;
  };
  return blocks.map(({ promptText, answerText, ...rest }) => {
    const kept: AgentReport = rest;
    if (fits(promptText)) kept.promptText = promptText;
    if (fits(answerText)) kept.answerText = answerText;
    return kept;
  });
}

/** Every feed in a report, in the order the server reads them: the orchestrator's, then each agent's. */
const feedsOf = (r: Report): ActivityEntry[][] => [r.session, ...r.agents].flatMap((owner) => (owner.activity ? [owner.activity] : []));

/** Leaves out whole feeds past the summary budget, in the server's order; a feed that does not fit costs nothing. */
function feedsWithin(r: Report): void {
  let room = PER_REPORT.feeds;
  for (const owner of [r.session, ...r.agents]) {
    if (!owner.activity) continue;
    const size = owner.activity.reduce((n, e) => n + e.text.length, 0);
    if (size > room) delete owner.activity;
    else room -= size;
  }
}

/** Commands share their own budget, in feed order and newest entry first; one that does not fit loses its command and keeps its summary. */
function commandsWithin(r: Report): void {
  let room = PER_REPORT.commands;
  for (const e of feedsOf(r).flatMap((feed) => feed.toReversed())) {
    const n = e.command?.length ?? 0;
    if (n <= room) {
      room -= n;
      continue;
    }
    delete e.command;
    delete e.commandCut;
  }
}

/** Keeps the serialized report under its byte budget (a character budget does not see multi-byte text): commands go first, from the last loop's oldest entry back. */
function bytesWithin(r: Report): void {
  const encoder = new TextEncoder();
  const fits = () => encoder.encode(JSON.stringify(r)).length <= PER_REPORT.bytes;
  const feeds = feedsOf(r);
  if (feeds.length === 0 || fits()) return;
  for (const e of feeds.toReversed().flat()) {
    if (e.command === undefined) continue;
    delete e.command;
    delete e.commandCut;
    if (fits()) return;
  }
}

/** The changed files as sent: every path, a rename's old one too, redacted and held to 300 characters; the counts as they are. */
function sentFiles(changed: FilesReport): FilesReport {
  const toPath = (p: string): string => clip(p, 300);
  return { ...changed, files: changed.files.map((file) => ({ ...file, path: toPath(file.path), from: file.from && toPath(file.from) })) };
}

/** The main loop's context: the status line's figures where it gave them, else what the loop's own steps say. */
function sessionContext(s: SessionState): Report['session']['context'] {
  const window = s.context.window ?? s.main.window ?? windowOf(s.main.model);
  const tokens = s.context.tokens ?? s.main.ctxTokens;
  const percent = s.context.percent ?? percentOf(tokens, window);
  return { tokens, window, percent: percent === null ? null : Math.max(0, Math.min(100, percent)) };
}

/** The session block of a report. */
function sessionBlock(s: SessionState, meta: ReportMeta): Report['session'] {
  const waiting = s.status === 'waiting';
  const { id, status, resumeId, startedAt, cwd, projectRoot, repoName, git, attached } = s;
  const block: Report['session'] = {
    id,
    name: displayName(s, meta.names),
    status,
    waitReason: waiting ? s.waitReason : null,
    waitNote: waiting && s.waitNote ? clip(s.waitNote, 160) : null,
    endReason: status === 'done' ? s.endReason : null,
    resumeId,
    startedAt,
    cwd,
    projectRoot,
    repoName,
    git,
    model: s.main.model,
    effort: s.main.effort,
    context: sessionContext(s),
    // Required by the report format and not read: Claude usage reaches the server from Claude Code's own telemetry.
    costUsd: null,
    rateLimits: s.rateLimits.slice(0, 10),
    blowouts: s.main.blowouts,
    plan: planOf(s.plan),
    loop: loopBlock(s.main),
    attached,
    files: sentFiles(s.files),
    activityFeed: meta.activity,
    respond: meta.respond,
    ...liveness(s.main),
  };
  if (waiting && s.background) block.background = s.background;
  if (meta.activity && s.main.activity.length > 0) block.activity = s.main.activity.map(sentEntry);
  if (meta.asks) block.asks = meta.asks.slice(0, 8);
  if (meta.clearedFrom) block.clearedFrom = meta.clearedFrom;
  return block;
}

/** What one post sends: the whole session as it stands now, with the first PER_REPORT.events of the events handed in. */
export function reportOf(state: SessionState, events: readonly ActivityEvent[], meta: ReportMeta): Report {
  const s = withPlanOwners(state);
  // Should a session ever have more agents than the server takes, the newest are the ones sent.
  const agents = s.order.flatMap((agentId) => s.agents[agentId] ?? []).slice(-PER_REPORT.agents);
  const session: SessionWindow = { model: s.main.model, window: s.context.window };
  const report: Report = {
    v: 1,
    sentAt: meta.now,
    provider: 'claude',
    reporter: { ...meta.reporter },
    session: sessionBlock(s, meta),
    agents: fullTextsWithin(agents.map((a) => agentBlock(a, meta.fullText, meta.activity, session))),
    events: events.slice(0, PER_REPORT.events).map((e) => ({ ...e, text: clip(e.text, LIMITS.text) })),
    machine: { ...meta.machine },
  };
  feedsWithin(report);
  commandsWithin(report);
  bytesWithin(report);
  return report;
}
