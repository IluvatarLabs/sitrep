// SITREP report contract.
//
// What a reporter POSTs to /api/fleet/report (a Report) and gets back (a ReportReply), the asks and answers of responding,
// the view types the UI reads, and the hand-written validator the server runs on every untrusted body. It covers both
// providers (Claude and Codex): Codex ask shapes, observe-only sessions, liveness and edit facts, machine views and agent
// messages.
//
// No imports: the Claude reporter carries a byte-identical copy at mod/claude-reporter/hooks/protocol.ts, kept equal by a
// `cmp` check. Only erasable TypeScript is used (no enums, no parameter properties), so a loader that
// strips types can run it.

// ---- Product constants ----------------------------------------------------------------------

/** The request header that carries the admin secret on every reporter call. */
export const TOKEN_HEADER = 'X-Sitrep-Token';

/**
 * The request header that names the machine (its MACHINE_ID) on Claude Code's own telemetry, OTLP/HTTP JSON logs POSTed to
 * /api/fleet/v1/logs with TOKEN_HEADER, whose records name no machine. Claude usage comes from those records, not from reports.
 */
export const MACHINE_HEADER = 'X-Sitrep-Machine';

/**
 * A session's id on the server (SessionView.id): the id its own harness gave it (Report.session.id) at the machine it runs on
 * (Report.machine.id), so the same conversation open on two machines is two sessions. Every route that names a session
 * takes it, the reporters' too: PUT /api/fleet/sessions/:id/asks/:askId, GET …/asks/:askId/answer, POST …/asks/:askId/close and
 * POST /api/fleet/sessions/:id/deliveries/:deliveryId/result.
 */
export const sessionKey = (nativeId: string, machineId: string): string => `${nativeId}@${machineId}`;

/**
 * The coding agent (harness) a session runs in, by name: any name PROVIDER_NAME matches, such as `hermes`. The two the
 * dashboard has behaviour of its own for are `Provider`; every other name takes the generic path: no resume command, and its
 * model's family by model id. Every harness's cost is its usage priced, booked the same way. The UI shows it with a generic logo
 * and its name.
 */
export type ProviderName = string;
/** Lower-case letters, digits and hyphens, a letter first, at most 32 characters. */
export const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The providers with behaviour of their own. */
export type Provider = 'claude' | 'codex';
export const PROVIDERS: readonly Provider[] = ['claude', 'codex'];
export const isKnownProvider = (p: ProviderName): p is Provider => (PROVIDERS as readonly string[]).includes(p);

/**
 * The reporter that produces a provider's reports is always named `<provider>-reporter` (`reporterOf`), and each the server knows
 * has its own supported version range (compat.ts); one it has no range for is accepted, its compatibility unknown.
 */
export type ReporterName = 'claude-reporter' | 'codex-reporter';
export const reporterOf = (provider: ProviderName): string => `${provider}-reporter`;

/** The orchestrator's own loop key in `watch` and the activity route. Agent ids never start with `@`. */
export const MAIN_LOOP = '@orchestrator';

// ---- Report building blocks -----------------------------------------------------------------

/**
 * Claude Code's five effort levels, which the effort meter draws as bars. On the wire `effort` is any string: a
 * Codex value outside these five is shown as text in the meter's place.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** Where an agent is in its life: waiting to start, at work, or finished in one of three ways. */
const AGENT_STATUSES = ['queued', 'running', 'done', 'failed', 'aborted'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** What a loop's failure is put down to (Failure.class). */
export type FailureClass = 'Tool error' | 'Blocked by permission' | 'Model API error' | 'Refusal' | 'Context window exhausted' | 'Aborted' | 'Unknown';

/** `edit` is a file edit with its absolute path; `message` is one loop messaging another. */
export type EventKind = 'start' | 'end' | 'spawn' | 'skill' | 'done' | 'fail' | 'blow' | 'compact' | 'plan' | 'wait' | 'note' | 'edit' | 'message';

/** Tokens by kind. `cacheRead` and `cacheWrite` are prompt tokens read from and written to the provider's prompt cache. */
export type TokenCounts = Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number>;

/** Tokens with cache writes split by lifetime: `cacheWrite` holds the 5-minute writes, `cacheWrite1h` the 1-hour ones (0 when not split). */
export type UsageTokens = TokenCounts & { cacheWrite1h: number };

/**
 * What one model used, for the server to price against its table. `tier: 'long'` marks a long-context request: for
 * Claude, a prompt (input, cache reads and cache writes together) over 100,000 tokens; for Codex, input over 272,000 tokens,
 * where OpenAI's long-context pricing starts.
 */
const USAGE_TIERS = ['std', 'long'] as const;
export interface ModelUsage {
  model: string;
  tier: (typeof USAGE_TIERS)[number];
  tokens: UsageTokens;
}

/** A loop's progress through its steps: how many are done, and out of how many when that is known. */
export interface StepCount {
  done: number;
  total: number | null;
}

/** How much of a loop's context window is in use. A value nobody knows is null, never 0. */
export type ContextFill = Record<'tokens' | 'window' | 'percent', number | null>;

/** The repository at the session's working directory. */
export interface GitInfo {
  /** The branch checked out, or the short commit when HEAD is detached. */
  branch: string | null;
  detached: boolean;
  /** Whether the checkout is a linked worktree, and its top directory when it is. */
  isWorktree: boolean;
  worktreePath: string | null;
  /** Commits ahead of and behind the upstream, and how many paths have changes. */
  ahead: number;
  behind: number;
  dirty: number;
}

/** How a file changed. */
const FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/** One changed file. Its line counts are null when it is binary; `from` is where a renamed file used to be. */
export interface ChangedFile {
  path: string;
  status: FileStatus;
  added: number | null;
  removed: number | null;
  from: string | null;
}

/**
 * What the session has changed in its repository: up to 200 of the changed files, and line totals over all of them. `since` is
 * the base they are counted from: `start`, the commit HEAD was on when the session began; `upstream`, the merge base with the
 * upstream once that commit is gone; `worktree`, HEAD itself.
 */
export interface FilesReport {
  files: ChangedFile[];
  total: number;
  added: number;
  removed: number;
  since: (typeof FILES_SINCE)[number];
}
const FILES_SINCE = ['start', 'upstream', 'worktree'] as const;

/**
 * One window of the provider plan's usage limits. Claude's come as `session.usage().rateLimits` has them. Codex's
 * are named by length, `five_hour` for 300 minutes, `seven_day` for 10,080 and `<n>m` otherwise, with `used_percent` as
 * `percentUsed` and `resets_at` as an ISO `resetsAt`.
 */
export interface RateLimit {
  kind: string;
  percentUsed: number;
  resetsAt: string | null;
  /**
   * When the reading was taken (ISO). Claude: when the model response whose headers carried these windows came back (the
   * reporter's last `turn.step` with usage); null until one comes back after the reporter starts, reloads or the session clears.
   * Codex: the timestamp of the `token_count` record it came from. Absent from older reporters (before claude-reporter 0.2.0,
   * codex-reporter 0.3.0).
   */
  measuredAt?: string | null;
}

/** Where a plan step stands. */
const STEP_STATES = ['pending', 'active', 'done', 'blocked'] as const;

/** One step of a plan. `activeText` is its wording while under way (Claude's `activeForm`); the owner is the agent it is matched to. */
export interface PlanStep {
  id: string;
  text: string;
  activeText: string | null;
  state: (typeof STEP_STATES)[number];
  ownerAgentId: string | null;
  ownerLabel: string | null;
}

/**
 * Where a plan came from: Claude Code's task tools (`TaskCreate`, `TodoWrite`), the Claude reporter's own plan tool
 * (`reporter_plan`), or Codex's latest `update_plan` call (`codex-plan`; its snake_case statuses map `pending`→`pending`,
 * `in_progress`→`active`, `completed`→`done`).
 */
export type PlanSource = 'TaskCreate' | 'TodoWrite' | 'reporter_plan' | 'codex-plan';

/** A session's plan: its title when it has one, where it came from, and its steps in order. */
export interface Plan {
  title: string | null;
  source: PlanSource;
  steps: PlanStep[];
}

/**
 * Why a loop failed, as its reporter makes it out: the class and when; the call blamed, by tool name, a one-line form of the call
 * and its exit code; the last lines of its output; up to five facts the reporter saw, never guesses (a call failing again, a
 * file read over and over, blowouts, a denial); and `retriedAs`, which today's reporters always send as null.
 */
export interface Failure {
  class: FailureClass;
  at: number;
  tool: string | null;
  call: string | null;
  exitCode: number | null;
  outputTail: string[];
  evidence: string[];
  retriedAs: string | null;
}

/**
 * The main loop's own work, read as the AgentReport fields of the same names are; what the agents it started did is theirs, not
 * counted here. `steps.done` counts the model requests the main loop has made.
 */
export interface LoopReport {
  skills: string[];
  lastTool: string | null;
  toolCalls: number;
  toolCounts: Record<string, number>;
  steps: StepCount & { total: null };
}

/** What an activity entry shows: a tool call, the model's text, or `reasoning`, kept for its thinking, which reporters never send. */
const ACTIVITY_KINDS = ['tool', 'text', 'reasoning'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * One entry of a loop's live activity feed: a tool call (its name, a space, a short summary of its arguments) or the text the
 * model wrote in one step, redacted and cut to 300 characters on the machine. Sent only with the reporter's `activityFeed`
 * option on and only for a loop the last reply listed in `watch`; the server holds entries in memory under the viewer's lease.
 * The optional fields describe a Bash (Codex: shell) call and appear only on a `tool` entry. A call's output is never sent:
 * there are no output fields, because they would ship command output off the machine.
 */
export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  text: string;
  /** The call's id, so its result can be matched to an entry that went out while the call ran. */
  id?: string;
  /** The whole command, redacted, line breaks kept, cut to 20,000 characters behind a visible marker (`commandCut`). */
  command?: string;
  commandCut?: boolean;
  /**
   * How the call ended, once `done`: `failed` when it failed, with or without an `exitCode`, which is sent only when the reporter
   * reads it from structured data, never parsed out of output text.
   */
  done?: boolean;
  failed?: boolean;
  exitCode?: number;
}

/** How an agent came to be, and where its effort figure comes from: asked for, seen in its requests, taken from its parent, or not known. */
const AGENT_KINDS = ['subagent', 'fork', 'teammate'] as const;
const EFFORT_SOURCES = ['requested', 'observed', 'inherited', 'unknown'] as const;

/**
 * One agent working under a session's main loop: a Claude subagent, fork or teammate, or a Codex child thread, which is sent as a
 * `subagent` with the child thread's id as `id`, its `agent_role` as `type` and its `agent_nickname` as `name`.
 */
export interface AgentReport {
  /** Its id, and the agent that started it (null when the main loop did). */
  id: string;
  parentId: string | null;
  /** What sort of agent it is, its type and name as the harness gives them, and the task it was given. */
  kind: (typeof AGENT_KINDS)[number];
  type: string;
  name: string | null;
  description: string;
  /** Its model and effort, and where the effort figure comes from. */
  model: string | null;
  effort: string | null;
  effortSource: (typeof EFFORT_SOURCES)[number];
  status: AgentStatus;
  startedAt: number;
  endedAt: number | null;
  context: ContextFill;
  /**
   * Its own tokens per model and tier, which the server prices; absent while the reporter does not know them. Not read from a
   * Claude report: a Claude agent's usage comes from Claude Code's own telemetry (MACHINE_HEADER).
   */
  usageByModel?: ModelUsage[];
  /**
   * Not read, and kept only so that older reports still validate: the server prices `usageByModel`. Reporters send
   * `costUsdEst` as null and may leave `tokens` out.
   */
  costUsdEst: number | null;
  tokens?: TokenCounts;
  /** The skills it used, its latest tool, its tool calls, and its finished calls per tool name. */
  skills: string[];
  lastTool: string | null;
  toolCalls: number;
  toolCounts: Record<string, number> | null;
  steps: StepCount | null;
  /** This loop's context blowouts so far; null when the reporter cannot know (Codex hooks not active). */
  blowouts: number | null;
  /**
   * Consecutive failed tool calls in this loop, reset to 0 by a successful tool result; null when the reporter cannot observe
   * tool exit status (a Codex thread without active hooks, in legacy history mode). The server derives errored from it.
   */
  toolFailures: number | null;
  failure: Failure | null;
  /** Excerpts of its task prompt and final answer, at most LIMITS.excerpt characters each. */
  promptExcerpt: string;
  answerExcerpt: string | null;
  /** The whole task prompt and final answer, redacted, line breaks kept; only with the `fullPrompts` option, each sent once. */
  promptText?: string;
  answerText?: string;
  /** The last 20 activity entries, oldest first, while a viewer watches this agent. */
  activity?: ActivityEntry[];
  /** The last hook, turn-step, tool or item event of this loop (epoch ms), never a heartbeat; null before the first. */
  lastActivityAt: number | null;
  /** A tool call of this loop has started and not finished. */
  toolOpen: boolean;
}

/**
 * One activity event, acknowledged by count in the reply and stored once by `id` (`sessionId:agentId|main:kind:t:n`).
 *
 * `data` is free-form within 4,096 characters, except for the events whose data the server reads:
 * - an `edit` event carries `{ path }`, the absolute path of the file the loop edited (Claude Edit/Write/MultiEdit/NotebookEdit,
 *   Codex fileChange/apply_patch paths). Paths only, never contents: the validator keeps nothing else.
 * - a `message` event is one loop sending a message to another loop of the same session while both run (Claude Code's agent-team
 *   SendMessage, Codex's send_input). `agentId` is the sender (null for the main loop), `text` the redacted message cut to
 *   LIMITS.text, and `data` is `{ to, toName }`: the recipient's agent id (null for the main loop) and its name as the harness
 *   gives it. `to` is absent when the reporter cannot tie the name to a loop of this session; then no link is drawn.
 * - a `fail` event for a turn that ended on a model API failure carries `category`, the provider's own name for it (Claude
 *   `classic.StopFailure`: `rate_limit`, `overloaded`, `billing_error`, …; Codex: the failed turn's `codex_error_info`, or
 *   `system_error` for a daemon thread in that state). The main loop's (`agentId` null) drives the errored state.
 * - a `blow` event (a context blowout) carries `{ kind: string; tokensBefore: number | null; tokensAfter: number | null }`, `kind`
 *   being one of `window-exceeded`, `server-compaction` or `auto-compact`. Only a `blow` event with a non-empty string
 *   `kind` adds an entry to the session's blowout log; the counts are the loops' own `blowouts`.
 */
export interface ActivityEvent {
  id: string;
  t: number;
  kind: EventKind;
  agentId: string | null;
  text: string;
  data: Record<string, unknown> | null;
}

/** What a session idle between turns still waits on: background work in flight, or a scheduled wake-up. */
const BACKGROUND_KINDS = ['shell', 'agent', 'monitor', 'workflow', 'wakeup', 'other'] as const;
export type BackgroundKind = (typeof BACKGROUND_KINDS)[number];

/** One piece of background work: its kind, a short description (never a whole shell command), and its status. */
export interface BackgroundTask {
  type: BackgroundKind;
  description: string;
  status: string;
}

/** The background work a session waits on, and `wakeAt`, the epoch ms of its next wake-up (null when none or not known). */
export interface BackgroundWait {
  tasks: BackgroundTask[];
  wakeAt: number | null;
}

/** Where a session stands as its reporter says, and what it waits on its owner for. */
const SESSION_STATUSES = ['running', 'waiting', 'done'] as const;
const WAIT_REASONS = ['permission', 'input', 'idle'] as const;

/** One session as its reporter sees it: the main loop's state and work, and the usage of the whole session. */
export interface SessionReport {
  /** The native session id (Claude's session id, Codex's root thread id), and the display name (Codex: `Thread.name` when known). */
  id: string;
  name: string;
  status: (typeof SESSION_STATUSES)[number];
  /** What the owner is waited on for: a permission, an input (a question or a plan), or `idle` (the turn ended and nothing
   *  was asked; not counted as needing the owner). */
  waitReason: (typeof WAIT_REASONS)[number] | null;
  /** What it waits on, such as `Bash(npm test)` or `Shell(pnpm test)`; at most 160 characters. */
  waitNote: string | null;
  /** Why it ended, and the id to resume it by; null resumes by `id`. */
  endReason: string | null;
  resumeId: string | null;
  startedAt: number;
  /** Where it runs: the working directory, the project root and repository name when known, and the repository's state. */
  cwd: string;
  projectRoot: string | null;
  repoName: string | null;
  git: GitInfo | null;
  model: string | null;
  effort: string | null;
  context: ContextFill;
  /**
   * Tokens per model and tier over the session's whole life, agents included, from the harness's own record; the server prices
   * them, and each rise is spend. Absent while the reporter does not know them yet. Not read from a Claude report:
   * Claude usage comes from Claude Code's own telemetry, each request counted once (MACHINE_HEADER).
   */
  usageByModel?: ModelUsage[];
  /**
   * Not read, and kept only so that older reports still validate: the server prices `usageByModel`. Reporters send
   * `costUsd` as null and may leave `tokens` out.
   */
  costUsd: number | null;
  tokens?: TokenCounts;
  rateLimits: RateLimit[];
  /** The main loop's blowouts so far; null when the reporter cannot know (Codex hooks not active). */
  blowouts: number | null;
  /** Consecutive failed tool calls in the main loop, reset to 0 by a successful tool result; null when not observable. */
  toolFailures: number | null;
  /**
   * Codex only: whether our hooks are active for this thread — their `hooks/list` trust state where a daemon runs, else whether a
   * hook event has arrived for the thread. While false, hook-only facts are unknown.
   */
  hooksActive?: boolean;
  /** Its plan, the main loop's own work, and what it has changed in its repository. */
  plan: Plan | null;
  loop: LoopReport | null;
  files: FilesReport | null;
  /** Whether any client is attached; false for a background session left running; null when unknown (Codex never knows). */
  attached: boolean | null;
  /** Background work the session is idle on; absent when there is none. */
  background?: BackgroundWait | null;
  /** The reporter's `activityFeed` option, and the main loop's last 20 activity entries while a viewer watches the orchestrator. */
  activityFeed?: boolean;
  activity?: ActivityEntry[];
  /** Whether and how far the session can be answered from the dashboard. */
  respond?: RespondInfo;
  /** Its open asks, 8 at most, sent only while the server's last reply said `respond: true`. */
  asks?: Ask[];
  /** The session this one continues after a Claude `/clear`. */
  clearedFrom?: string | null;
  /** The last hook, turn-step, tool or item event of the main loop (epoch ms), never a heartbeat; null before the first. */
  lastActivityAt: number | null;
  /** A tool call of the main loop has started and not finished. */
  toolOpen: boolean;
}

/** A machine id: 1 to 32 letters, digits, `-` or `_`, so `sessionKey`'s `@` splits it off unambiguously. */
export const MACHINE_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** The machine a session runs on: its short host name, the random id both reporters share, and its OS as read. */
export interface MachineInfo {
  name: string;
  /** 1 to 32 letters, digits, `-` or `_`; kept in `sitrep-machine-id` in the Claude config directory. */
  id: string;
  /** Free text such as `macOS 27.0.1`, never parsed; null when it could not be read. */
  os: string | null;
}

export interface Report {
  v: 1;
  sentAt: number;
  provider: ProviderName;
  /**
   * `name` is `<provider>-reporter` (`reporterOf`). `engineVersion` is the version of the engine running the session (Claude
   * Code, the Codex that hosts the thread, or the other harness).
   * `hostSurface` is where the session runs, as SessionView.hostSurface describes it. `build` is the commit of a reporter dev
   * build, absent for a release. `daemonVersion` is the Codex managed app-server daemon's version on the machine, from the
   * codex-reporter only; absent when no daemon runs.
   */
  reporter: {
    name: string;
    version: string;
    engineVersion: string | null;
    hostSurface: string | null;
    build?: string | null;
    daemonVersion?: string | null;
  };
  session: SessionReport;
  /** Every agent seen this session, running or finished. */
  agents: AgentReport[];
  /** The events not yet acknowledged. */
  events: ActivityEvent[];
  machine: MachineInfo;
}

/** "1 shell, 1 agent": a background wait counted by kind, as the activity feed's wait row reads it. */
export function backgroundSummary(wait: BackgroundWait): string {
  const counts = new Map<string, number>();
  for (const task of wait.tasks) counts.set(task.type, (counts.get(task.type) ?? 0) + 1);
  return Array.from(counts, ([kind, n]) => `${String(n)} ${kind}`).join(', ');
}

/** A session that waits, but only on background work or a wake-up: nothing is asked of its person. */
export const idleOnBackground = <T extends Record<'status', string> & Pick<SessionReport, 'background'> & { waitReason: string | null }>(s: T): s is T & { background: BackgroundWait } =>
  s.status === 'waiting' && s.waitReason === null && s.background != null;

// ---- Responding -------------------------------------------------------------

/** The reporter's `respond` option: how far the session takes answers from the dashboard, from none to every kind. */
export const RESPOND_LEVELS = ['off', 'questions', 'questions-and-plans', 'everything'] as const;
export type RespondLevel = (typeof RESPOND_LEVELS)[number];

/** Each kind of answer a session can take. */
export const RESPOND_KINDS = ['question', 'plan-approve', 'plan-feedback', 'permission', 'message', 'command'] as const;
export type RespondKind = (typeof RESPOND_KINDS)[number];

/**
 * Why a kind the level allows is missing from `accepts`: PermissionRequest hooks do not run here (drops plan-approve and
 * permission), a `claude -p` run (drops everything), or a Codex thread the reporter cannot answer — a desktop-app local
 * thread, an excluded CLI run, `codex exec` — which the UI words as "Answer in its terminal" (drops everything).
 * `desktop-app` comes beside `observe-only` for a Codex desktop-app local thread: observe-only; it is answered in the Codex
 * app, which the UI words as "Answer in the Codex app". It never adds to `accepts`.
 */
export type RespondLimit = 'no-permission-hooks' | 'not-interactive' | 'observe-only' | 'desktop-app';
export const RESPOND_LIMIT_NAMES: readonly RespondLimit[] = ['no-permission-hooks', 'not-interactive', 'observe-only', 'desktop-app'];

/** Report.session.respond. */
export interface RespondInfo {
  level: RespondLevel;
  /** What the session takes now: the level's kinds less what `limits` removes; empty while the activityFeed option is off. */
  accepts: RespondKind[];
  limits: RespondLimit[];
}

/** What each level adds to the one below it: questions and messages, then plans, then permissions and commands. */
const ASKED: readonly RespondKind[] = ['question', 'message'];
const PLANS: readonly RespondKind[] = [...ASKED, 'plan-approve', 'plan-feedback'];

/** The kinds each level allows: all those of the level below, and its own. */
export const LEVEL_KINDS: Readonly<Record<RespondLevel, readonly RespondKind[]>> = {
  off: [],
  questions: ASKED,
  'questions-and-plans': PLANS,
  everything: [...PLANS, 'permission', 'command'],
};

/** The kinds a level allows once the limits are applied: none while the reporter's activityFeed option (`feedOn`) is off. */
export function acceptsFor(level: RespondLevel, limits: readonly RespondLimit[], feedOn: boolean): RespondKind[] {
  if (!feedOn || limits.includes('not-interactive') || limits.includes('observe-only')) return [];
  if (!limits.includes('no-permission-hooks')) return [...LEVEL_KINDS[level]];
  return LEVEL_KINDS[level].filter((kind) => kind !== 'plan-approve' && kind !== 'permission');
}

/** What an ask waits for: answers to questions, a verdict on a plan, or leave to run a tool. */
const ASK_KINDS = ['question', 'plan', 'permission'] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/** One choice a question offers: its label, what it means, and its preview when it has one. */
export interface AskOption {
  label: string;
  description: string;
  preview: string | null;
}

/** One question. Claude: 1 to 4 options. Codex: 0 to 4 (`options` null in the request gives none), `multiSelect` false; any other provider 0 to 4. */
export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect: boolean;
  /** Whether a typed answer is taken. Claude: true. Codex: true only when the native question has `isOther` or no options. */
  allowsText: boolean;
}

/** The answer to one question, matched by position: the indexes of the options chosen, typed text, or null when skipped. */
export type QuestionAnswer = { options: number[] } | { text: string } | null;

/**
 * Something a session waits on its person for that the dashboard can answer, redacted and cut to RESPOND_LIMITS with a visible
 * marker on the machine. Its id is the Claude tool call's `tool_use_id`, or the Codex request's `itemId` with `:<approvalId>`
 * after it when the request has one. Codex command, file-change and permissions approvals are `permission` asks and
 * `requestUserInput` is a `question` ask. A Codex request holding an `isSecret` question is never announced as an
 * ask: the reporter reports the session as `waitReason: 'input'` with a `waitNote` saying to answer in its terminal.
 * The UI reads `allowsReply`, `allowsText` and `tool.denyReason`; it never infers them from the provider.
 */
export interface Ask {
  id: string;
  kind: AskKind;
  /** The loop that asked (a subagent or Codex child thread id; null for the main loop), and when. */
  agentId: string | null;
  openedAt: number;
  /** Whether a message can be sent in place of an answer. Claude: true. Codex: false. */
  allowsReply: boolean;
  /** What is asked, by kind: the questions, the plan and its file, or the tool below. */
  questions?: AskQuestion[];
  plan?: { text: string; filePath: string | null };
  /**
   * The tool and its arguments (Codex: `Shell` with command, cwd and reason; `Edit` with `changes`, each path with its operation,
   * and the redacted `patch`). `cut` when anything was cut off, redacted or is missing, and then only Deny is offered. `denyReason` says whether a Deny can carry a reason: Claude Code, yes;
   * Codex `decline`, no, so the reason box is hidden.
   */
  tool?: { name: string; input: Record<string, unknown>; cut: boolean; denyReason: boolean };
}

/** How much responding carries: list lengths, characters per text, and how long an answer request is held. */
export const RESPOND_LIMITS = {
  /** Asks open at once per session, questions per ask, options per question, and messages and commands waiting per session. */
  asks: 8,
  questions: 4,
  options: 4,
  deliveries: 20,
  /** Characters of an ask's content. */
  question: 1000,
  header: 40,
  label: 200,
  description: 1000,
  preview: 4000,
  plan: 40_000,
  toolInput: 20_000,
  /** Typed answers, deny reasons, and the answer summary a close carries. */
  answer: 2000,
  /** Messages, replies sent instead of an answer, and plan feedback. */
  message: 20_000,
  /** The longest a held answer request waits, in seconds (the Claude mod's `$.http.fetch` gives up at 30). */
  holdSeconds: 20,
} as const;

/** Each kind of delivery; a `reply` is a message the owner sends in place of an answer to the ask. */
export const DELIVERY_KINDS = ['question', 'reply', 'plan-approve', 'plan-feedback', 'allow-once', 'deny', 'message', 'command'] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

/** The permission mode a session continues in once the dashboard approves its plan. */
export const PLAN_MODES = ['auto', 'acceptEdits', 'default'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

/** The two commands the dashboard can send. Codex takes `compact`; it refuses `clear`, which has no native equivalent. */
export type DashboardCommand = 'clear' | 'compact';
export const DASHBOARD_COMMANDS: readonly DashboardCommand[] = ['clear', 'compact'];

/** One answer, message or command from the dashboard, as the server hands it to the reporter. */
export interface Delivery {
  id: string;
  kind: DeliveryKind;
  /** The ask it answers (null for a message or a command), who sent it (always `Admin` in single-owner mode), and when. */
  askId: string | null;
  by: string;
  at: number;
  /** What it carries, by kind: the question answers, the mode an approved plan goes on in, the text, or the command. */
  answers?: QuestionAnswer[];
  mode?: PlanMode;
  text?: string;
  command?: DashboardCommand;
}

/** What became of a delivery, by its reporter's word. */
export const DELIVERY_RESULTS = ['took', 'queued', 'not-taken', 'refused', 'closed'] as const;
export type DeliveryResult = (typeof DELIVERY_RESULTS)[number];

/** How an ask closed without the dashboard's answer: answered in its terminal, closed by itself, or its session ended. */
export const ASK_CLOSE_OUTCOMES = ['terminal', 'closed', 'ended'] as const;
export type AskCloseOutcome = (typeof ASK_CLOSE_OUTCOMES)[number];

/** A reporter's word that an ask closed (POST …/asks/:askId/close): how, and when. */
export interface AskClose {
  outcome: AskCloseOutcome;
  at: number;
  /** What the terminal answered, in short: question answers joined by "; ", `No, keep planning`, `allowed` or `denied`. */
  answer?: string | null;
  /** A plan approved in the terminal (which mode is not known). */
  planApproved?: boolean;
}

/** The reply to an accepted report. */
export interface ReportReply {
  /** The server's clock, and how many of the report's events, from the first, it has taken; the reporter drops those from its queue. */
  ok: true;
  serverTime: number;
  ackedEvents: number;
  /** The report's own `session.id`, and how many live sessions are on the wall. */
  sessionId: string;
  liveSessions: number;
  /** The server's version, and its dev build's commit (null for a release). */
  serverVersion: string;
  serverBuild?: string | null;
  /** The range this server supports for the report's own reporter (null when it has none for it), and where the reporter stands. */
  reporterSupport: ReporterSupport | null;
  reporterCompat: ReporterCompat;
  /** The loops a viewer is watching now (`@orchestrator` for the main loop); empty while the server's activityFeed setting is off. */
  watch: string[];
  /** Whether the server takes answers for this session now; reporters announce asks only while it is true. */
  respond: boolean;
  /** Messages and commands waiting for this session, oldest first; empty while `respond` is false. Answers never come here. */
  deliveries: Delivery[];
}

// ---- Prices -----------------------------------------------------------------------------------

/** USD per million tokens for one model: one row of prices.json. `cacheWrite` is the 5-minute rate. */
export interface ModelPriceSet {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

// ---- View types (server to UI; the UI imports them with `import type`) ---------------------------

/** The model's family, from a lowercase match on its id: Claude's four, `openai` for Codex models, else `other`. */
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'openai' | 'other';

/** A session's status on its card: what its reporter last said. */
export type SessionStatusView = SessionReport['status'];

/** `outdated`: below the reporter's supported range; `newer`: above it; `unknown`: an unreadable version, never warned about. */
export type ReporterCompat = 'ok' | 'outdated' | 'newer' | 'unknown';

/** The versions of one reporter the server reads correctly (major.minor compared, patch ignored). */
export interface ReporterSupport {
  min: string;
  max: string;
}

/** A plan step as the server serves it; `doneSeq` (1, 2, …) is the order the server saw steps finish, absent when not done. */
export type PlanStepView = PlanStep & { doneSeq?: number };

/** A plan as the server serves it, its steps numbered in the order they finished. */
export type PlanView = Omit<Plan, 'steps'> & { steps: PlanStepView[] };

export interface AgentView extends Omit<AgentReport, 'promptText' | 'answerText' | 'activity' | 'tokens'> {
  provider: ProviderName;
  /** Its tokens by kind from its usage (cache writes of either length together); null while unknown, never 0. */
  tokens: TokenCounts | null;
  modelFamily: ModelFamily;
  /** The length of the whole prompt and answer the server holds; null when it holds none. */
  promptChars: number | null;
  answerChars: number | null;
  /** Running, not waiting, no running agents under it, and no activity for longer than its family's threshold. */
  stuck: boolean;
}

/** One blowout, from its `blow` event: when, in which loop (null for the main loop), its kind, and the context tokens around it. */
export interface BlowoutLogEntry {
  t: number;
  agentId: string | null;
  kind: string;
  tokensBefore: number | null;
  tokensAfter: number | null;
}

/**
 * A session's blowouts: the main loop's, its agents', and both together; the card's level (blowoutLevel: 0 none, 1 "context
 * exceeded", 2 "likely losing context"); how many of its loops have had one, out of how many; and the log.
 */
export interface BlowoutSummary {
  orchestrator: number;
  agents: number;
  total: number;
  level: 0 | 1 | 2;
  loopsHit: number;
  loopsTotal: number;
  log: BlowoutLogEntry[];
}

/**
 * Why a session is errored, derived by the server: `api` when the main loop's turn ended on a model API failure
 * (`detail` its category, such as `rate_limit`), `tools` when `toolFailures` is 3 or more, or above 0 while the session runs with
 * no tool call open (`toolOpen` false) and 60 s have passed since `lastActivityAt` (`detail` the tool when known).
 */
export interface ErroredState {
  cause: 'api' | 'tools';
  detail: string | null;
}

/** Another loop that edited the same file within 5 minutes: "Also edited by <name>: <file>". */
export interface CollisionView {
  /** The absolute path both edited. */
  path: string;
  /** The other loop: its session (this one when two of its own agents collide), its agent (null for a main loop), and its name. */
  sessionId: string;
  agentId: string | null;
  name: string;
  /** When the later of the two edits happened. */
  at: number;
}

/** One loop of this session messaging another within the last 30 minutes, from a `message` event. */
export interface MessageView {
  /** The sender's agent id; null for the main loop. */
  from: string | null;
  /** The recipient's agent id (null for the main loop); absent when the reporter could not tie `toName` to a loop. */
  to?: string | null;
  toName: string;
  /** The redacted message, cut as the event's text is. */
  text: string;
  at: number;
}

export interface SessionView {
  /**
   * The session on the server, `<nativeId>@<machine id>` (sessionKey), so the same conversation open on two machines is two
   * sessions. Every route that names a session and every link take it; nothing shows it.
   */
  id: string;
  /** The id the session's own harness gave it (Report.session.id): the one shown, copied and resumed. */
  nativeId: string;
  name: string;
  provider: ProviderName;
  /** The reporter's version as it reported it, and the commit of a dev build (null for a release). */
  reporterVersion: string;
  reporterBuild: string | null;
  /** Where that version sits against the range this server supports for that reporter. */
  compat: ReporterCompat;
  /**
   * Report.reporter.hostSurface as last reported. Claude: `terminal`, `desktop`, `vscode` or `mobile` (Claude Code's surface),
   * `headless` with no surface (`claude -p`, the SDK), `background` for a `claude --bg` or agent-view job. Codex: the thread's
   * `session_meta.originator` exactly as Codex writes it (`Codex Desktop`, `codex-tui`, `Claude Code`, `codex_exec`, …).
   * Null when not known (older reporters).
   */
  hostSurface: string | null;
  /** `projectRoot ?? cwd`, any machine's home (`/Users/<name>`, `/home/<name>`) shortened to `~`. */
  project: string;
  /** The working directory, any machine's home shortened to `~`. */
  cwd: string;
  repoName: string | null;
  /** `cd <cwd> && claude --resume <id>`, or `cd <cwd> && codex resume <id>`, quoted where needed; null for any other provider. */
  resumeCommand: string | null;
  /** The same with `--fork-session`, or `codex fork <id>`; null for any other provider. */
  forkCommand: string | null;
  git: GitInfo | null;
  model: string | null;
  modelFamily: ModelFamily;
  effort: string | null;
  status: SessionStatusView;
  waitReason: 'permission' | 'input' | 'idle' | null;
  waitNote: string | null;
  endReason: string | null;
  /** When it started, when the server last heard from it, and how many seconds ago that was. */
  startedAt: number;
  lastSeenAt: number;
  secondsSinceSeen: number;
  /** Report.session.lastActivityAt: the status band's "No activity for 6m 12s." counts from it. */
  lastActivityAt: number | null;
  toolOpen: boolean;
  /** Report.session.toolFailures: the main loop's consecutive failed tool calls; null when not observable. */
  toolFailures: number | null;
  /** Running, not waiting, no running agents, and no activity for longer than its family's threshold. */
  stuck: boolean;
  /** Why the session is errored; null when it is not. */
  errored: ErroredState | null;
  context: ContextFill;
  costUsd: number | null;
  /** Why `costUsd` is null: the model has no row in the price table, or no usage is reported yet; null when it is known. */
  costReason: 'unpriced' | 'pending' | null;
  /** `costUsd` is known but leaves out usage on models with no price ("+ unpriced"). */
  costPartial: boolean;
  /** True when `name` is the owner's display name from the dashboard (PUT /api/fleet/admin/sessions/:id/name). */
  renamed: boolean;
  /** Every token of the session, its agents' included, from its usage; null while unknown, never 0. */
  tokensTotal: number | null;
  /** The plan windows the session last reported, for the orchestrator's Limits cell. */
  rateLimits: RateLimit[];
  /** Null when the reporter cannot know (Codex hooks not active): shown as "—", never 0. */
  blowouts: BlowoutSummary | null;
  /** Codex only: whether this thread's hooks are active; null for Claude. */
  hooksActive: boolean | null;
  plan: PlanView | null;
  loop: LoopReport | null;
  files: FilesReport | null;
  /** What the session is idle on; null when it waits on nothing. Not a wait on the person. */
  background: BackgroundWait | null;
  /**
   * Whether a client is attached (null when unknown), and when a session nobody is attached to is set aside from the wall (null
   * while attached or unknown).
   */
  attached: boolean | null;
  hideAt: number | null;
  /** Who the session belongs to from the credential: `Admin` for the admin secret, null when the server has none. */
  owner: string | null;
  machine: MachineInfo;
  /** The reporter's activityFeed option as last reported; null before the first report since start. */
  activityFeed: boolean | null;
  /** Report.session.respond as last reported; null before the first report since start. */
  respond: RespondInfo | null;
  /** The session's asks, open or recently closed, without their content. */
  asks: AskSummary[];
  /** The `id` of the session this one continues after a /clear, on the same machine; null when none. */
  clearedFrom: string | null;
  /** Other loops that edited a file this session edited within the last 5 minutes. */
  collisions: CollisionView[];
  /** Messages between this session's loops in the last 30 minutes, oldest first, at most 20. */
  messages: MessageView[];
  agents: AgentView[];
  /**
   * `tokensPerSec`, `peakContext`, `running`, `blowoutSecondsAgo`: 60 points each, one a second, oldest first; `peakContext`
   * in 0..1; missing seconds are zero-filled. `tokensPerMin`: 30 points, oldest first; point i holds the output tokens reported
   * in the 60 s ending (29 − i) minutes before now, so the last point is the current rate; 0 where nothing was reported. Token
   * figures are output tokens, the session's and its agents', and leave out a reporter's replay of usage it had already reported
   * (as the fleet series do).
   */
  series: { tokensPerSec: number[]; peakContext: number[]; running: number[]; blowoutSecondsAgo: number[]; tokensPerMin: number[] };
}

/** Where an ask stands: open, an answer taken but not confirmed, an approval the session did not take, or closed. */
export type AskState = 'open' | 'pending' | 'not-taken' | 'closed';

/**
 * An ask as the state and the stream carry it: the Ask without its questions, plan or tool input, with `count`, the questions of
 * a question ask (the Respond button's number; 1 for any other ask), and where it stands.
 */
export interface AskSummary extends Pick<Ask, 'id' | 'kind' | 'agentId' | 'openedAt'> {
  count: number;
  state: AskState;
}

/** How an ask closed, as the panel shows it. `dashboard` is an answer from the dashboard that the session took. */
export type AskOutcome = 'dashboard' | 'terminal' | 'closed' | 'ended';

/**
 * A delivery as the panel reads it back: what became of it (null until the reporter says), whether this signed-in browser sent
 * it, and whether the reporter has been handed it, after which it can no longer be discarded.
 */
export interface DeliveryView extends Delivery {
  result: DeliveryResult | null;
  mine: boolean;
  handedOver: boolean;
}

/** GET /api/fleet/respond/sessions/:id/asks/:askId: the whole ask, for a signed-in Admin. */
export interface AskDetail {
  /** The ask, where it stands, and when the server last heard from its session. */
  ask: Ask;
  state: AskState;
  lastSeenAt: number;
  /** The answer sent from the dashboard, while the server holds it. */
  delivery: DeliveryView | null;
  /** How the ask closed, once it has. */
  closed: AskClosure | null;
}

/** How an ask closed: the outcome, when, who answered from the dashboard (null otherwise), the terminal's answer, a plan approved. */
export interface AskClosure {
  outcome: AskOutcome;
  at: number;
  by: string | null;
  answer: string | null;
  planApproved: boolean;
}

/**
 * The body of GET /api/fleet/respond/me. Signing in (POST /respond/sign-in) keeps a sign-in for 400 days unused, each use renewing
 * it; POST /respond/sign-out ends the browser's own, and POST /respond/sign-out-everywhere (signed in) ends every one.
 */
export interface RespondMe {
  /** The admin secret is set and the server's `respond` setting is on. */
  enabled: boolean;
  /** Whether this browser is signed in, under what name (`Admin`; null until signed in), and whether as the admin. */
  signedIn: boolean;
  name: string | null;
  admin: boolean;
}

/** A stored activity event as the UI shows it: the event, with its session's id, name and model family. */
export interface ActivityView extends ActivityEvent {
  sessionId: string;
  sessionName: string;
  modelFamily: ModelFamily;
}

/** One machine's share of today's estimated spend, for its band header. */
export interface MachineSpend {
  machineId: string;
  costUsd: number;
  /** Tokens were spent today on a model with no price row: show "—", not a total. */
  unpriced: boolean;
}

/** One machine's spend on one model. Each figure is 0 with no use in its span, and null for use on a model with no price (unknown, never $0). */
export interface SpendRecordRow {
  machineId: string;
  provider: ProviderName;
  model: string;
  family: ModelFamily;
  /** Since local midnight on the server. */
  today: number | null;
  /** The last 7 local days, today included. */
  week: number | null;
  /** Every day recorded. */
  alltime: number | null;
}

/** The fleet's headline figures. The session and agent figures leave out an ended session still lingering on the wall. */
export interface Kpis {
  /** Live sessions, how many run, and how many the server derives as stuck. */
  live: number;
  running: number;
  stuck: number;
  /** Their agents: running, and queued. */
  agentsRunning: number;
  agentsWaiting: number;
  costToday: number;
  /** Live sessions with usage on a model with no price, wholly or in part; that usage is left out of `costToday`. */
  unpricedSessions: number;
  /** USD the spend record booked per minute across the fleet over the last hour, oldest minute first (what `costToday` adds up). */
  costPerMinute: number[];
  /** Output tokens per second across the fleet over the last minute, oldest second first. */
  tokensPerSec: number[];
  /** `costToday` split by machine, largest first. */
  costTodayByMachine: MachineSpend[];
  /** The spend record by machine and model. */
  spendRecord: SpendRecordRow[];
  /** The first local day the record holds (`YYYY-MM-DD`); null while it is empty. */
  spendSince: string | null;
}

/**
 * The server's lifecycle timers: a live session unheard from for `removeAfterMs` leaves every view; an ended one stays on the wall
 * for `lingerMs`, counted in no figure; one nobody is attached to is set aside after `detachedHideAfterMs`.
 */
export interface LifecycleConfig {
  removeAfterMs: number;
  lingerMs: number;
  detachedHideAfterMs: number;
}

/** The two server settings. */
export interface ServerSettings {
  respond: boolean;
  activityFeed: boolean;
}

/** What Settings edits: the three switches, the stuck thresholds per family, the lifecycle timers and retention. The
 *  server keeps the owner's changes in its `settings` table over `server.env` as the defaults, and applies them without a
 *  restart. A change that sets a setting to null drops the owner's change to it, so `server.env`'s value applies again.
 *  `requireSignInToView` (default false): every browser read needs a sign-in, or the admin secret in TOKEN_HEADER; without either
 *  the server answers `401 {"error":"sign-in required"}` (VIEW_GATED). Signing in and out, GET /respond/me, the UI's files,
 *  /health and the reporters' routes stay open. */
export interface EditableSettings {
  respond: boolean;
  activityFeed: boolean;
  requireSignInToView: boolean;
  stuckAfterMs: Record<ModelFamily, number>;
  lifecycle: LifecycleConfig;
  retention: { samplesMs: number; eventsMs: number; sessionsMs: number };
}

/** The least each group of EditableSettings' timers takes, in ms: stuck after 10 s, lifecycle timers 1 s, retention 1 hour. */
export const SETTINGS_MIN_MS = { stuckAfterMs: 10_000, lifecycle: 1_000, retention: 3_600_000 } as const;

/** The `error` of the 401 every browser read gets while `requireSignInToView` is on and the request has no sign-in. */
export const VIEW_GATED = 'sign-in required';

/** One price row in use, read-only in Settings. */
export interface PriceRowView {
  /** The model id it prices. */
  model: string;
  label: string;
  std: ModelPriceSet;
  /** The row's prices for a long request, when it has them, and when they apply ("over 272K input tokens"). */
  long?: { when: string; prices: ModelPriceSet };
}

/** GET /api/fleet/settings (a browser read), and the reply to PUT /api/fleet/admin/settings. */
export interface SettingsBody {
  settings: EditableSettings;
  /** What each setting falls back to: `server.env`, else the built-in default. */
  defaults: EditableSettings;
  /** Read-only facts; changing them means editing `server.env` and restarting. */
  about: { version: string; build: string | null; host: string; port: number; allowedHosts: string[]; timeZone: string; logLevel: string; startedAt: number };
  /**
   * Where this start's price table came from: `live`, LiteLLM's published price file fetched at start; `snapshot`, the copy
   * shipped with the server, when the fetch failed (`error` says why). `asOf` is the ISO time the table was fetched. `rows`
   * are the rows that price the models in the record, with `prices.json`'s overrides laid on top.
   */
  prices: { source: 'live' | 'snapshot'; asOf: string; error: string | null; rows: PriceRowView[] };
  /** Models seen in reports since start that match no price row. */
  unpricedModels: string[];
}

/** A report the server refused, kept in memory only (the last 200, newest first). GET /api/fleet/refusals. */
export interface RefusalView {
  at: number;
  /** The sender's address. */
  address: string;
  /** From the report when it carried one, or from MACHINE_HEADER on telemetry, else null. */
  machineId: string | null;
  machineName: string | null;
  /** HTTP status and the fixed reason, such as `401 bad token` or `400 $.session.status`. */
  status: number;
  reason: string;
}

/**
 * The signed-in owner's actions, under /api/fleet/admin with the same sign-in check as the answer routes:
 * - PUT    /settings                      Partial<EditableSettings> (nested objects partial too) → SettingsBody. A setting sent
 *                                         as null resets it to `server.env`'s value; a timer below SETTINGS_MIN_MS is a 400
 * - DELETE /machines/:id                  → { removed: string[] }; 409 while the machine is reporting
 * - POST   /machines/remove-silent        → { removed: string[] } (every silent and not-since-restart machine)
 * - DELETE /sessions/:id                  a stored session → { ok: true }; 409 while it is live
 * - PUT    /sessions/:id/name             { name: string | null } (at most 80 characters; null clears) → { ok: true }
 * - GET    /backup                        a consistent copy of the database (`VACUUM INTO`), as a download
 */
export const ADMIN_BASE = '/api/fleet/admin';

/**
 * One provider's plan windows on a machine: the newest reading among its live sessions of that provider, by
 * `measuredAt` (by the session's last activity for a reporter that sends none), less windows past their reset.
 */
export interface ProviderRateLimits {
  provider: ProviderName;
  limits: RateLimit[];
}

/** A machine's reporting state from its last report: under 2 minutes, under an hour, longer, or before this server started. */
export type MachineState = 'reporting' | 'quiet' | 'silent' | 'restart';
export const MACHINE_REPORTING_MS = 120_000;
export const MACHINE_QUIET_MS = 3_600_000;

/**
 * One reporter on a machine. `live`: as its live sessions there report, the worst compat among them with that session's version.
 * Otherwise the version the machine last reported, judged against the range.
 */
export interface ReporterVersion {
  version: string;
  compat: ReporterCompat;
  live: boolean;
}

/** One row of the Machines page. */
export interface MachineView {
  id: string;
  name: string;
  os: string | null;
  /** When the server last took a report from this machine (server time). */
  lastReportAt: number;
  state: MachineState;
  /** The Claude plugin's and the Codex reporter's versions on this machine; null for one never heard from it. */
  reporters: { claude: ReporterVersion | null; codex: ReporterVersion | null };
  /** The Codex daemon's version last reported from this machine; null when none. */
  codexDaemon: string | null;
  liveSessions: number;
  rateLimits: ProviderRateLimits[];
}

/** GET /api/fleet/state, and the stream's `snapshot`. */
export interface StateBody {
  /** The wall: its sessions, the latest activity, the machines, and the headline figures. */
  sessions: SessionView[];
  events: ActivityView[];
  machines: MachineView[];
  kpis: Kpis;
  /** The server's clock, timers and switches. */
  serverTime: number;
  config: LifecycleConfig;
  settings: ServerSettings;
  /** The server's version, its dev build's commit (null for a release), and the range it supports for each reporter. */
  server: { version: string; build: string | null; reporterSupport: Record<string, ReporterSupport> };
}

export type RemovedReason = 'done' | 'dropped' | 'deleted';

/** A row of GET /api/fleet/history: one session that ended or was dropped. */
export interface HistoryRow {
  /** SessionView.id. */
  id: string;
  /** SessionView.nativeId. */
  nativeId: string;
  name: string;
  provider: ProviderName;
  project: string;
  model: string | null;
  modelFamily: ModelFamily;
  /** When it started and ended, and how long it ran. */
  startedAt: number;
  endedAt: number;
  durationSec: number;
  /** Its cost, and `costPartial` when that cost leaves out usage on models with no price. */
  costUsd: number | null;
  costPartial: boolean;
  /** Why `costUsd` is null, as on cards (SessionView.costReason); null when the cost is known. */
  costReason: SessionView['costReason'];
  /** Null when the reporter could not know. */
  blowouts: number | null;
  /** How many agents it ran, and why it ended. */
  agents: number;
  endReason: string | null;
  /** The `id` of the session this one continued after a /clear, and of the one that continued it, on the same machine; null when none. */
  clearedFrom: string | null;
  clearedInto: string | null;
}

// ---- Validation: strings are clamped, lists over their limit rejected --------

/** The sizes the validator holds a report to; the reporters read them too. */
export const LIMITS = {
  /** Characters of a one-line string, by what it holds. */
  id: 200,
  short: 120,
  name: 80,
  machineName: 64,
  os: 80,
  text: 240,
  line: 240,
  waitNote: 160,
  call: 300,
  excerpt: 400,
  path: 1024,
  filePath: 300,
  backgroundDescription: 120,
  /** promptText / answerText: 20,000 characters plus room for the reporter's cut-off marker. */
  fullText: 20_100,
  /** Items in a list. */
  agents: 200,
  events: 100,
  planSteps: 100,
  skills: 50,
  toolNames: 100,
  usageModels: 40,
  backgroundTasks: 20,
  rateLimits: 10,
  blowoutLog: 50,
  files: 200,
  /** Lines a failure keeps: the end of its output, and the start of its evidence. */
  outputLines: 12,
  evidenceLines: 5,
  /** One loop's activity feed: entries kept, characters per entry, and characters of summaries over the whole report. */
  activityEntries: 20,
  activityText: 300,
  activityChars: 60_000,
  /** A Bash entry's command: 20,000 characters plus room for the cut-off marker. */
  activityDetail: 20_100,
  /** Characters of commands over the whole report, apart from `activityChars`. */
  activityDetailChars: 200_000,
} as const;

/** The characters a respond limit leaves over for the reporter's own "[cut off at N characters]" marker. */
const CUT_MARKER_ROOM = 60;
/** The most JSON one event's `data` may take. */
const EVENT_DATA_CHARS = 4096;
/** The most lines a failure's output or evidence list may hold before it is cut to its keep. */
const FAILURE_LINES_MAX = 1000;
/** The most files a report may list before the first LIMITS.files are kept. */
const FILES_LISTED_MAX = 1000;

/** A body turned away: what is wrong with it, and the path of the first field at fault. */
export type Rejected = { ok: false; error: string; path: string };
export type ValidateResult = { ok: true; report: Report } | Rejected;
export type ValidateAskResult = { ok: true; ask: Ask } | Rejected;

class Invalid extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

// A one-line string loses every control character but tab; a text keeps its line feeds too.
const ONE_LINE_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/g;
const TEXT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

const EVENT_KINDS: readonly EventKind[] = ['start', 'end', 'spawn', 'skill', 'done', 'fail', 'blow', 'compact', 'plan', 'wait', 'note', 'edit', 'message'];
const FAILURE_CLASSES: readonly FailureClass[] = ['Tool error', 'Blocked by permission', 'Model API error', 'Refusal', 'Context window exhausted', 'Aborted', 'Unknown'];
const PLAN_SOURCES: readonly PlanSource[] = ['TaskCreate', 'TodoWrite', 'reporter_plan', 'codex-plan'];

const absent = (v: unknown): v is null | undefined => v === null || v === undefined;
const clip = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);

function record(v: unknown, at: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Invalid(at, 'expected an object');
  return v as Record<string, unknown>;
}

/** A one-line string, control characters replaced by spaces, cut to `max`. */
function line(v: unknown, at: string, max: number): string {
  if (typeof v !== 'string') throw new Invalid(at, 'expected a string');
  return clip(v.replace(ONE_LINE_CONTROL, ' '), max);
}

function lineOrNull(v: unknown, at: string, max: number): string | null {
  return absent(v) ? null : line(v, at, max);
}

/** A text that keeps its line breaks, other control characters replaced by spaces, cut to `max`. */
function text(v: unknown, at: string, max: number): string {
  if (typeof v !== 'string') throw new Invalid(at, 'expected a string');
  return clip(v.replace(TEXT_CONTROL, ' '), max);
}

function finite(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Invalid(at, 'expected a finite number');
  return v;
}

function finiteOrNull(v: unknown, at: string): number | null {
  return absent(v) ? null : finite(v, at);
}

/** A non-negative number, rounded to a whole one. */
function count(v: unknown, at: string): number {
  const n = finite(v, at);
  if (n < 0) throw new Invalid(at, 'expected a non-negative number');
  return Math.round(n);
}

function countOrNull(v: unknown, at: string): number | null {
  return absent(v) ? null : count(v, at);
}

/** A cost: never below 0, null when absent. */
function costOrNull(v: unknown, at: string): number | null {
  const n = finiteOrNull(v, at);
  return n === null ? null : Math.max(0, n);
}

function flag(v: unknown, at: string): boolean {
  if (typeof v !== 'boolean') throw new Invalid(at, 'expected a boolean');
  return v;
}

function pick<T extends string>(v: unknown, at: string, allowed: readonly T[]): T {
  const found = allowed.find((a) => a === v);
  if (found === undefined) throw new Invalid(at, `expected one of ${allowed.join(', ')}`);
  return found;
}

function pickOrNull<T extends string>(v: unknown, at: string, allowed: readonly T[]): T | null {
  return absent(v) ? null : pick(v, at, allowed);
}

function list(v: unknown, at: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw new Invalid(at, 'expected an array');
  if (v.length > max) throw new Invalid(at, `at most ${String(max)} items allowed`);
  return v as unknown[];
}

/** A field of one checked object: `field(key, check, ...args)` runs `check` on it, naming its path, `<object>.key`, in an error. */
type Field = <A extends unknown[], T>(key: string, check: (v: unknown, at: string, ...args: A) => T, ...args: A) => T;

/** An object, checked, with the reader of its fields. */
function fieldsOf(v: unknown, at: string): [Record<string, unknown>, Field] {
  const o = record(v, at);
  return [o, (key, check, ...args) => check(o[key], `${at}.${key}`, ...args)];
}

function names(v: unknown, at: string): string[] {
  return list(v, at, LIMITS.skills).map((s, i) => line(s, `${at}[${String(i)}]`, LIMITS.short));
}

/** Calls per tool name: names clipped and merged, counts whole and non-negative, the `max` most used kept (ties by name). */
function toolCounts(v: unknown, at: string, max: number): Record<string, number> | null {
  if (absent(v)) return null;
  const merged = new Map<string, number>();
  for (const [tool, n] of Object.entries(record(v, at))) {
    const key = clip(tool.replace(ONE_LINE_CONTROL, ' '), LIMITS.short);
    merged.set(key, (merged.get(key) ?? 0) + count(n, `${at}.${tool}`));
  }
  const ranked = Array.from(merged).sort(([an, a], [bn, b]) => b - a || (an < bn ? -1 : 1));
  return Object.fromEntries(ranked.slice(0, max));
}

function tokenCounts(v: unknown, at: string): TokenCounts {
  const [, f] = fieldsOf(v, at);
  return { input: f('input', count), output: f('output', count), cacheRead: f('cacheRead', count), cacheWrite: f('cacheWrite', count) };
}

/** A loop's own `tokens`, still checked when sent; absent stays absent. */
const tokensIfSent = (v: unknown, at: string): { tokens?: TokenCounts } => (absent(v) ? {} : { tokens: tokenCounts(v, at) });

/** Absent stays absent; a missing `cacheWrite1h` is 0 (no split known). */
function usageByModel(v: unknown, at: string): { usageByModel?: ModelUsage[] } {
  if (absent(v)) return {};
  const rows = list(v, at, LIMITS.usageModels).map((row, i): ModelUsage => {
    const [, f] = fieldsOf(row, `${at}[${String(i)}]`);
    const [tokens, t] = f('tokens', fieldsOf);
    return {
      model: f('model', line, LIMITS.short),
      tier: f('tier', pick, USAGE_TIERS),
      tokens: { ...f('tokens', tokenCounts), cacheWrite1h: absent(tokens.cacheWrite1h) ? 0 : t('cacheWrite1h', count) },
    };
  });
  return { usageByModel: rows };
}

/** The percentage held to 0..100. */
function contextFill(v: unknown, at: string): ContextFill {
  const [, f] = fieldsOf(v, at);
  const percent = f('percent', finiteOrNull);
  return { tokens: f('tokens', finiteOrNull), window: f('window', finiteOrNull), percent: percent === null ? null : Math.min(100, Math.max(0, percent)) };
}

function gitInfo(v: unknown, at: string): GitInfo | null {
  if (absent(v)) return null;
  const [, f] = fieldsOf(v, at);
  return {
    branch: f('branch', lineOrNull, LIMITS.short),
    detached: f('detached', flag),
    isWorktree: f('isWorktree', flag),
    worktreePath: f('worktreePath', lineOrNull, LIMITS.path),
    ahead: f('ahead', count),
    behind: f('behind', count),
    dirty: f('dirty', count),
  };
}

function planOf(v: unknown, at: string): Plan | null {
  if (absent(v)) return null;
  const [, f] = fieldsOf(v, at);
  const steps = f('steps', list, LIMITS.planSteps).map((step, i): PlanStep => {
    const [, s] = fieldsOf(step, `${at}.steps[${String(i)}]`);
    return {
      id: s('id', line, LIMITS.id),
      text: s('text', line, LIMITS.text),
      state: s('state', pick, STEP_STATES),
      activeText: s('activeText', lineOrNull, LIMITS.text),
      ownerAgentId: s('ownerAgentId', lineOrNull, LIMITS.id),
      ownerLabel: s('ownerLabel', lineOrNull, LIMITS.short),
    };
  });
  return { title: f('title', lineOrNull, LIMITS.text), source: f('source', pick, PLAN_SOURCES), steps };
}

/** Output lines: each clipped, the last (or first) `keep` kept. */
function outputLines(v: unknown, at: string, keep: number, fromEnd: boolean): string[] {
  const all = list(v, at, FAILURE_LINES_MAX).map((l, i) => line(l, `${at}[${String(i)}]`, LIMITS.line));
  const first = fromEnd ? Math.max(0, all.length - keep) : 0;
  return all.slice(first, first + keep);
}

function failureOf(v: unknown, at: string): Failure | null {
  if (absent(v)) return null;
  const [, f] = fieldsOf(v, at);
  const exitCode = f('exitCode', finiteOrNull);
  return {
    class: f('class', pick, FAILURE_CLASSES),
    at: f('at', finite),
    tool: f('tool', lineOrNull, LIMITS.short),
    call: f('call', lineOrNull, LIMITS.call),
    exitCode: exitCode === null ? null : Math.round(exitCode),
    outputTail: f('outputTail', outputLines, LIMITS.outputLines, true),
    evidence: f('evidence', outputLines, LIMITS.evidenceLines, false),
    retriedAs: f('retriedAs', lineOrNull, LIMITS.id),
  };
}

/** A loop's activity feed. Absent stays absent; Bash detail is kept on `tool` entries only, and false flags are dropped. */
function activityOf(v: unknown, at: string): { activity?: ActivityEntry[] } {
  if (absent(v)) return {};
  const entries = list(v, at, LIMITS.activityEntries).map((raw, i): ActivityEntry => {
    const [o, f] = fieldsOf(raw, `${at}[${String(i)}]`);
    const kind = f('kind', pick, ACTIVITY_KINDS);
    const entry: ActivityEntry = { at: f('at', finite), kind, text: f('text', line, LIMITS.activityText) };
    if (!absent(o.id)) entry.id = f('id', line, LIMITS.id);
    const isTool = kind === 'tool';
    // Each optional field is still type-checked on a non-tool entry, then dropped there rather than rejected. Command output
    // is not part of the contract: an `output` field is ignored like any unknown field.
    const command = absent(o.command) ? null : f('command', text, LIMITS.activityDetail);
    const commandCut = !absent(o.commandCut) && f('commandCut', flag);
    const done = !absent(o.done) && f('done', flag);
    const failed = !absent(o.failed) && f('failed', flag);
    const exitCode = f('exitCode', countOrNull);
    if (!isTool) return entry;
    if (command !== null) entry.command = command;
    if (commandCut) entry.commandCut = true;
    if (done) entry.done = true;
    if (failed) entry.failed = true;
    if (exitCode !== null) entry.exitCode = exitCode;
    return entry;
  });
  return { activity: entries };
}

function agentOf(v: unknown, at: string): AgentReport {
  const [o, f] = fieldsOf(v, at);
  let steps: AgentReport['steps'] = null;
  if (!absent(o.steps)) {
    const [, s] = f('steps', fieldsOf);
    const total = s('total', finiteOrNull);
    steps = { done: s('done', count), total: total === null ? null : Math.max(0, Math.round(total)) };
  }
  const agent: AgentReport = {
    id: f('id', line, LIMITS.id),
    parentId: f('parentId', lineOrNull, LIMITS.id),
    kind: f('kind', pick, AGENT_KINDS),
    type: f('type', line, LIMITS.short),
    name: f('name', lineOrNull, LIMITS.name),
    description: f('description', line, LIMITS.text),
    model: f('model', lineOrNull, LIMITS.short),
    effort: f('effort', lineOrNull, LIMITS.short),
    effortSource: f('effortSource', pick, EFFORT_SOURCES),
    status: f('status', pick, AGENT_STATUSES),
    startedAt: f('startedAt', finite),
    endedAt: f('endedAt', finiteOrNull),
    context: f('context', contextFill),
    ...f('tokens', tokensIfSent),
    costUsdEst: f('costUsdEst', costOrNull),
    ...f('usageByModel', usageByModel),
    skills: f('skills', names),
    lastTool: f('lastTool', lineOrNull, LIMITS.short),
    toolCalls: f('toolCalls', count),
    toolCounts: f('toolCounts', toolCounts, LIMITS.toolNames),
    blowouts: f('blowouts', countOrNull),
    toolFailures: f('toolFailures', countOrNull),
    steps,
    promptExcerpt: f('promptExcerpt', line, LIMITS.excerpt),
    answerExcerpt: f('answerExcerpt', lineOrNull, LIMITS.excerpt),
    ...f('activity', activityOf),
    failure: f('failure', failureOf),
    lastActivityAt: f('lastActivityAt', finiteOrNull),
    toolOpen: f('toolOpen', flag),
  };
  if (!absent(o.promptText)) agent.promptText = f('promptText', text, LIMITS.fullText);
  if (!absent(o.answerText)) agent.answerText = f('answerText', text, LIMITS.fullText);
  return agent;
}

/**
 * One event. `edit` must carry an absolute `data.path` and keeps nothing else; `message` keeps only `data.toName` and, when present,
 * `data.to`; a `fail` event's `data.category` must be a string.
 */
function eventOf(v: unknown, at: string): ActivityEvent {
  const [o, f] = fieldsOf(v, at);
  const kind = f('kind', pick, EVENT_KINDS);
  let data = absent(o.data) ? null : f('data', record);
  if (data !== null && JSON.stringify(data).length > EVENT_DATA_CHARS) throw new Invalid(`${at}.data`, `at most ${String(EVENT_DATA_CHARS)} characters of data allowed`);
  if (kind === 'edit') {
    const path = line(data?.path, `${at}.data.path`, LIMITS.path);
    if (!path.startsWith('/')) throw new Invalid(`${at}.data.path`, 'expected an absolute path');
    data = { path };
  } else if (kind === 'message') {
    const toName = line(data?.toName, `${at}.data.toName`, LIMITS.short);
    // `to: null` is a message to the main loop; only a missing `to` means the reporter could not tie the name to a loop.
    data = data?.to === undefined ? { toName } : { to: lineOrNull(data.to, `${at}.data.to`, LIMITS.id), toName };
  } else if (kind === 'fail' && data !== null && !absent(data.category)) {
    data = { ...data, category: line(data.category, `${at}.data.category`, LIMITS.short) };
  }
  return { id: f('id', line, LIMITS.id), t: f('t', finite), kind, agentId: f('agentId', lineOrNull, LIMITS.id), text: f('text', line, LIMITS.text), data };
}

function loopOf(v: unknown, at: string): LoopReport | null {
  if (absent(v)) return null;
  const [, f] = fieldsOf(v, at);
  const [, steps] = f('steps', fieldsOf);
  return {
    skills: f('skills', names),
    lastTool: f('lastTool', lineOrNull, LIMITS.short),
    toolCalls: f('toolCalls', count),
    toolCounts: f('toolCounts', toolCounts, LIMITS.toolNames) ?? {},
    steps: { done: steps('done', count), total: null },
  };
}

/** The first LIMITS.files files are kept rather than a longer list rejected; `total` never falls below what is listed. */
function filesOf(v: unknown, at: string): FilesReport | null {
  if (absent(v)) return null;
  const [, f] = fieldsOf(v, at);
  const files = f('files', list, FILES_LISTED_MAX)
    .slice(0, LIMITS.files)
    .map((file, i): ChangedFile => {
      const [, g] = fieldsOf(file, `${at}.files[${String(i)}]`);
      return { path: g('path', line, LIMITS.filePath), status: g('status', pick, FILE_STATUSES), added: g('added', countOrNull), removed: g('removed', countOrNull), from: g('from', lineOrNull, LIMITS.filePath) };
    });
  return { files, total: Math.max(f('total', count), files.length), added: f('added', count), removed: f('removed', count), since: f('since', pick, FILES_SINCE) };
}

/** An empty task list is no background work at all. */
function backgroundOf(v: unknown, at: string): BackgroundWait | null {
  if (absent(v)) return null;
  const [, f] = fieldsOf(v, at);
  const tasks = f('tasks', list, LIMITS.backgroundTasks).map((task, i): BackgroundTask => {
    const [, g] = fieldsOf(task, `${at}.tasks[${String(i)}]`);
    return { type: g('type', pick, BACKGROUND_KINDS), description: g('description', line, LIMITS.backgroundDescription), status: g('status', line, 40) };
  });
  const wakeAt = f('wakeAt', finiteOrNull);
  return tasks.length > 0 ? { tasks, wakeAt } : null;
}

/** `accepts` keeps only what the level allows, so a reporter cannot claim more than its level. Duplicates are folded. */
function respondOf(v: unknown, at: string): { respond?: RespondInfo } {
  if (absent(v)) return {};
  const [, f] = fieldsOf(v, at);
  const level = f('level', pick, RESPOND_LEVELS);
  const accepts = f('accepts', list, RESPOND_KINDS.length).map((k, i) => pick(k, `${at}.accepts[${String(i)}]`, RESPOND_KINDS));
  const limits = f('limits', list, RESPOND_LIMIT_NAMES.length).map((k, i) => pick(k, `${at}.limits[${String(i)}]`, RESPOND_LIMIT_NAMES));
  const allowed = LEVEL_KINDS[level];
  return { respond: { level, accepts: Array.from(new Set(accepts)).filter((k) => allowed.includes(k)), limits: Array.from(new Set(limits)) } };
}

/** One ask: strings clamped with room for the cut-off marker, lists over their limit rejected. */
function askOf(v: unknown, at: string, provider: ProviderName): Ask {
  const [, f] = fieldsOf(v, at);
  const id = f('id', line, LIMITS.id);
  if (id === '') throw new Invalid(`${at}.id`, 'must not be empty');
  const kind = f('kind', pick, ASK_KINDS);
  const ask: Ask = { id, kind, agentId: f('agentId', lineOrNull, LIMITS.id), openedAt: f('openedAt', finite), allowsReply: f('allowsReply', flag) };
  const withMarker = (n: number) => n + CUT_MARKER_ROOM;
  if (kind === 'question') {
    const questions = f('questions', list, RESPOND_LIMITS.questions);
    if (questions.length === 0) throw new Invalid(`${at}.questions`, 'expected at least one question');
    // A Claude question has at least one option; any other provider's may come with none (answered by typing, as Codex's).
    const fewestOptions = provider === 'claude' ? 1 : 0;
    ask.questions = questions.map((q, i): AskQuestion => {
      const p = `${at}.questions[${String(i)}]`;
      const [, g] = fieldsOf(q, p);
      const options = g('options', list, RESPOND_LIMITS.options);
      if (options.length < fewestOptions) throw new Invalid(`${p}.options`, 'expected at least one option');
      return {
        question: g('question', text, withMarker(RESPOND_LIMITS.question)),
        header: g('header', line, RESPOND_LIMITS.header),
        multiSelect: g('multiSelect', flag),
        options: options.map((opt, j): AskOption => {
          const [oo, h] = fieldsOf(opt, `${p}.options[${String(j)}]`);
          return {
            label: h('label', line, withMarker(RESPOND_LIMITS.label)),
            description: h('description', text, withMarker(RESPOND_LIMITS.description)),
            preview: absent(oo.preview) ? null : h('preview', text, withMarker(RESPOND_LIMITS.preview)),
          };
        }),
        allowsText: g('allowsText', flag),
      };
    });
  } else if (kind === 'plan') {
    const [, g] = f('plan', fieldsOf);
    ask.plan = { text: g('text', text, withMarker(RESPOND_LIMITS.plan)), filePath: g('filePath', lineOrNull, LIMITS.path) };
  } else {
    const [, g] = f('tool', fieldsOf);
    const input = g('input', record);
    if (JSON.stringify(input).length > withMarker(RESPOND_LIMITS.toolInput)) {
      throw new Invalid(`${at}.tool.input`, `at most ${String(RESPOND_LIMITS.toolInput)} characters of input allowed`);
    }
    ask.tool = { name: g('name', line, LIMITS.short), input, cut: g('cut', flag), denyReason: g('denyReason', flag) };
  }
  return ask;
}

function sessionOf(v: unknown, at: string, provider: ProviderName): SessionReport {
  const [o, f] = fieldsOf(v, at);
  const id = f('id', line, LIMITS.id);
  if (id === '') throw new Invalid(`${at}.id`, 'must not be empty');
  const background = f('background', backgroundOf);
  const session: SessionReport = {
    id,
    name: f('name', line, LIMITS.name),
    status: f('status', pick, SESSION_STATUSES),
    waitReason: f('waitReason', pickOrNull, WAIT_REASONS),
    waitNote: f('waitNote', lineOrNull, LIMITS.waitNote),
    endReason: f('endReason', lineOrNull, LIMITS.short),
    resumeId: f('resumeId', lineOrNull, LIMITS.id),
    startedAt: f('startedAt', finite),
    cwd: f('cwd', line, LIMITS.path),
    projectRoot: f('projectRoot', lineOrNull, LIMITS.path),
    repoName: f('repoName', lineOrNull, LIMITS.short),
    git: f('git', gitInfo),
    model: f('model', lineOrNull, LIMITS.short),
    effort: f('effort', lineOrNull, LIMITS.short),
    context: f('context', contextFill),
    costUsd: f('costUsd', costOrNull),
    ...f('tokens', tokensIfSent),
    ...f('usageByModel', usageByModel),
    rateLimits: f('rateLimits', list, LIMITS.rateLimits).map((r, i): RateLimit => {
      const [ro, g] = fieldsOf(r, `${at}.rateLimits[${String(i)}]`);
      const limit: RateLimit = { kind: g('kind', line, LIMITS.short), percentUsed: g('percentUsed', finite), resetsAt: g('resetsAt', lineOrNull, LIMITS.short) };
      if (!absent(ro.measuredAt)) limit.measuredAt = g('measuredAt', line, LIMITS.short);
      return limit;
    }),
    blowouts: f('blowouts', countOrNull),
    toolFailures: f('toolFailures', countOrNull),
    plan: f('plan', planOf),
    loop: f('loop', loopOf),
    files: f('files', filesOf),
    attached: absent(o.attached) ? null : f('attached', flag),
    ...f('activity', activityOf),
    ...f('respond', respondOf),
    lastActivityAt: f('lastActivityAt', finiteOrNull),
    toolOpen: f('toolOpen', flag),
  };
  if (background !== null) session.background = background;
  if (!absent(o.hooksActive)) session.hooksActive = f('hooksActive', flag);
  if (!absent(o.activityFeed)) session.activityFeed = f('activityFeed', flag);
  if (!absent(o.asks)) session.asks = f('asks', list, RESPOND_LIMITS.asks).map((a, i) => askOf(a, `${at}.asks[${String(i)}]`, provider));
  if (o.clearedFrom !== undefined) session.clearedFrom = f('clearedFrom', lineOrNull, LIMITS.id);
  return session;
}

/** A host name (clamped, trimmed, not empty), the shared random id, and the OS as free text (null when unread). */
function machineOf(v: unknown, at: string): MachineInfo {
  const [, f] = fieldsOf(v, at);
  const name = f('name', line, LIMITS.machineName).trim();
  if (name === '') throw new Invalid(`${at}.name`, 'expected a host name');
  const id = f('id', line, 64);
  if (!MACHINE_ID.test(id)) throw new Invalid(`${at}.id`, 'expected 1 to 32 letters, digits, - or _');
  const os = f('os', lineOrNull, LIMITS.os)?.trim() ?? '';
  return { name, id, os: os === '' ? null : os };
}

/** A dev build's commit (7 to 40 hex digits, `-dirty` after it for a tree with edits); null for a release or anything else. */
function buildOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return /^[0-9a-f]{7,40}(?:-dirty)?$/.test(trimmed) ? trimmed : null;
}

/**
 * Keeps the report's activity inside its two budgets. Summaries share LIMITS.activityChars: the orchestrator's feed first,
 * then each agent's in order, and a feed that does not fit is dropped from this report. Commands share
 * LIMITS.activityDetailChars in the same loop order, newest entry first: an entry whose command does not fit loses it and
 * keeps its summary and how the call ended.
 */
function fitActivity(report: Report): void {
  let summaryRoom: number = LIMITS.activityChars;
  const fits = (entries: ActivityEntry[]): boolean => {
    const size = entries.reduce((n, e) => n + e.text.length, 0);
    if (size > summaryRoom) return false;
    summaryRoom -= size;
    return true;
  };
  if (report.session.activity && !fits(report.session.activity)) delete report.session.activity;
  for (const agent of report.agents) if (agent.activity && !fits(agent.activity)) delete agent.activity;

  let detailRoom: number = LIMITS.activityDetailChars;
  const trim = (entries: ActivityEntry[]): void => {
    for (const e of [...entries].reverse()) {
      const size = e.command?.length ?? 0;
      if (size > detailRoom) {
        delete e.command;
        delete e.commandCut;
      } else detailRoom -= size;
    }
  };
  if (report.session.activity) trim(report.session.activity);
  for (const agent of report.agents) if (agent.activity) trim(agent.activity);
}

/**
 * Validates an untrusted body as a Report. Never throws. Strings are clamped to their limits and stripped of control
 * characters; lists over their limit, wrong types and unknown enum values are rejected with the path of the first offending
 * field; unknown fields are dropped. The provider is any PROVIDER_NAME, and the reporter's name must be `<provider>-reporter`.
 */
export const validateReport = (body: unknown): ValidateResult =>
  guarded('report', () => {
    const [o, f] = fieldsOf(body, '$');
    if (o.v === undefined) throw new Invalid('$.v', 'the protocol version is missing');
    if (o.v !== 1) throw new Invalid('$.v', 'this server reads protocol version 1 only');
    const provider = f('provider', line, LIMITS.short);
    if (!PROVIDER_NAME.test(provider)) throw new Invalid('$.provider', 'expected lower-case letters, digits and hyphens, a letter first, at most 32 characters');
    const [r, g] = f('reporter', fieldsOf);
    const name = g('name', line, LIMITS.short);
    if (name !== reporterOf(provider)) throw new Invalid('$.reporter.name', `expected ${reporterOf(provider)} for provider ${provider}`);
    const report: Report = {
      v: 1,
      sentAt: f('sentAt', finite),
      provider,
      reporter: { name, version: g('version', line, LIMITS.short), engineVersion: g('engineVersion', lineOrNull, LIMITS.short), hostSurface: g('hostSurface', lineOrNull, LIMITS.short) },
      session: f('session', sessionOf, provider),
      agents: f('agents', list, LIMITS.agents).map((a, i) => agentOf(a, `$.agents[${String(i)}]`)),
      events: f('events', list, LIMITS.events).map((e, i) => eventOf(e, `$.events[${String(i)}]`)),
      machine: f('machine', machineOf),
    };
    // A dev build's commit and the Codex daemon's version, each only when sent and readable.
    const build = buildOf(r.build);
    const daemonVersion = g('daemonVersion', lineOrNull, LIMITS.short);
    report.reporter = { ...report.reporter, ...(build === null ? {} : { build }), ...(daemonVersion === null ? {} : { daemonVersion }) };
    fitActivity(report);
    return { ok: true, report };
  });

/** Validates one ask as a reporter announces it (PUT …/asks/:askId), for a session of `provider`. Never throws. */
export const validateAsk = (body: unknown, provider: ProviderName): ValidateAskResult => guarded('ask', () => ({ ok: true, ask: askOf(body, '$', provider) }));

/** Runs one validator over an untrusted body: its result, or the first fault with its path (`invalid <what>` for anything else). */
function guarded<T extends { ok: true }>(what: string, check: () => T): T | Rejected {
  try {
    return check();
  } catch (err) {
    return err instanceof Invalid ? { ok: false, error: err.message, path: err.path } : { ok: false, error: `invalid ${what}`, path: '$' };
  }
}
