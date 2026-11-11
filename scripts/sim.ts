#!/usr/bin/env -S npx tsx
// SITREP simulator: posts realistic Claude Code and Codex session reports, and the Claude sessions' usage as Claude
// Code's telemetry, so the UI can be built and demoed with no sessions running: a provider on every report, sessions spread
// over several machines, Codex sessions with their own shapes, and the liveness, tool-failure, edit and rate-limit facts the
// server derives from.
//
// Every random choice comes from one seeded generator, so a seed always gives the same reports (timestamps aside). The
// Simulator class is pure apart from its injected clock; main() does the HTTP. A development aid only, never proof that the
// real reporters work.
import os from 'node:os';
import { parseArgs } from 'node:util';
import {
  MACHINE_HEADER,
  MAIN_LOOP,
  reporterOf,
  TOKEN_HEADER,
  type ActivityEntry,
  type ActivityEvent,
  type AgentReport,
  type ChangedFile,
  type ContextFill,
  type Failure,
  type FilesReport,
  type LoopReport,
  type MachineInfo,
  type ModelUsage,
  type Plan,
  type PlanStep,
  type Provider,
  type RateLimit,
  type Report,
  type TokenCounts,
} from '../server/src/fleet/protocol.ts';

const HELP = `sim: POST simulated Claude Code and Codex session reports to a SITREP server.

Usage: npx tsx scripts/sim.ts [options]

Options:
  --url URL             The dashboard server; reports and Claude telemetry go to it. Default http://127.0.0.1:4317
  --sessions N          Sessions open at a time, 1 to 50; each one that ends is replaced. Default 5
  --codex SHARE         The part of them that are Codex sessions, 0 to 1. Default 0.4
  --machines N          Machines to spread them over, 1 to 8: a Mac laptop first, then Linux servers. Default 3
  --speed X             Simulated seconds that pass in each real second. Default 1
  --seed N              Seeds every random choice: one seed always plays out the same way. Default 1
  --duration S          Real seconds to run before every session is ended and the simulator exits 0. Default: until
                        Ctrl-C
  --chaos               Add trouble: sessions that go quiet (and leave) or stall (stuck), turns that end on API errors,
                        tools failing in a row (errored), more blowouts, and plan windows filling faster
  --agents N            Ad-hoc agents every session starts with, beyond its plan, to load the UI. Default 0
  --nested              Keep one Claude session whose agents launch agents, four levels deep
  --reporter-version V  The reporter version the reports claim. Default 0.1.0-sim, outside every range the server
                        reads, so it shows no update warning
  --print               Send nothing: write each report, and each Claude telemetry export with the machine it comes
                        from, to stdout as one JSON line. Ends after --ticks
  --ticks N             With --print, the simulated seconds to run. Default 60
  -h, --help            Show this help

The server's admin secret, when it has one, is read from the SITREP_TOKEN environment variable and sent as
${TOKEN_HEADER}. It is never taken on the command line, where other users of the machine could read it.

Claude sessions carry no usage in their reports, as the Claude plugin's carry none. Each of their model
requests goes to /api/fleet/v1/logs as an api_request record, the way Claude Code's own telemetry sends it, with the
session's machine in ${MACHINE_HEADER}. Codex sessions send their usage in their reports, as codex-reporter does.

Codex sessions include some whose hooks are not active (blowouts unknown), some that are observe-only (a desktop-app
local thread, codex exec, or a machine without the Codex daemon), and most with unknown tool exit status. File edits go
out as edit events with absolute paths; each loop edits its own files, and now and then two loops working in one
checkout on one machine edit the same file. Loops message each other now and then, as Claude's SendMessage and Codex's
send_input do.

On exit (duration reached, Ctrl-C or SIGTERM) every session it started is reported once more with status "done", so
nothing is left running on the wall. Its reports say hostSurface "simulator".`;

// ---- Seeded randomness (mulberry32) -----------------------------------------------------------------

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  hex(n: number): string {
    let out = '';
    for (let i = 0; i < n; i++) out += this.int(0, 15).toString(16);
    return out;
  }
}

// ---- Models --------------------------------------------------------------------------------------------
// Tokens go out per model and never with a cost: the server prices them. Codex sends them in its reports, Claude one model
// request at a time as telemetry.

interface ModelSpec {
  id: string;
  label: string;
  window: number;
}

const MODELS = {
  opus: { id: 'claude-opus-5-5', label: 'Opus', window: 1_000_000 },
  sonnet: { id: 'claude-sonnet-5-5', label: 'Sonnet', window: 1_000_000 },
  // A 200K window, so haiku agents blow out often enough to see.
  haiku: { id: 'claude-haiku-4-5', label: 'Haiku', window: 200_000 },
  fable: { id: 'claude-fable-5-1', label: 'Fable', window: 1_000_000 },
  sol: { id: 'gpt-6-sol', label: 'gpt-6-sol', window: 272_000 },
  luna: { id: 'gpt-6-luna', label: 'gpt-6-luna', window: 272_000 },
} satisfies Record<string, ModelSpec>;

type ModelKey = keyof typeof MODELS;

const specOf = (id: string | null): ModelSpec | undefined => Object.values(MODELS).find((m) => m.id === id);
const labelOf = (id: string | null): string => specOf(id)?.label ?? id ?? 'unknown model';
const windowOf = (id: string | null): number => specOf(id)?.window ?? 1_000_000;
/** A loop's context as reported: `fill` (0 to 1) of a window of `window` tokens, the percentage to one decimal. */
const contextOf = (fill: number, window: number): ContextFill => ({ tokens: Math.round(fill * window), window, percent: Math.round(fill * 1000) / 10 });

// ---- Scenarios --------------------------------------------------------------------------------------

interface StepSpec {
  d: string;
  kind: 'subagent' | 'fork';
  /** Claude: the agent type. Codex: the child thread's agent_role. */
  type: string;
  /** Null for a fork, which inherits its launcher's model and effort. */
  model: ModelKey | null;
  effort: string | null;
  skills: string[];
  /** Index of the step whose agent launches this one. */
  under?: number;
}

const sub = (d: string, type: string, model: ModelKey, effort: string, skills: string[] = [], under?: number): StepSpec => ({ d, kind: 'subagent', type, model, effort, skills, under });
const fork = (d: string, skills: string[] = [], under?: number): StepSpec => ({ d, kind: 'fork', type: 'fork', model: null, effort: null, skills, under });

/** The checkout's git state as the session's card shows it: its branch, commits ahead of and behind upstream, changed files. */
interface GitFacts {
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
}

interface Template {
  provider: Provider;
  name: string;
  project: string;
  git: GitFacts;
  /** Works in a worktree under .claude/worktrees/, named after the branch's last segment, instead of the project root. */
  worktree: boolean;
  model: ModelKey;
  effort: string;
  // The work.
  /** Claude: the plan's title. Codex: any value means the thread keeps an update_plan plan (Codex plans have no title). */
  plan: string | null;
  steps: StepSpec[];
  /** Steps in progress at one time, 2 when unset; an agent still waiting on agents it launched keeps its slot. */
  parallel?: number;
  // Where it stands when the simulator starts.
  /** Steps already finished. */
  done?: number;
  /** How long ago the session started, in seconds. */
  ageSec?: number;
  // Where it stops.
  /** What the session waits on when it stops at a permission prompt; without it, it never does. */
  waitNote?: string;
}

/** What one loop tells another. */
const MESSAGES = [
  'Schema migration is merged; rebase before you touch the invoice tables.',
  'Can you take the flaky retry test? I am on the fixtures.',
  'Adapter is done, handing the review back to you.',
  'Blocked on the key rotation, picking up the docs meanwhile.',
  'Found the race: the cache warms after the first request.',
];

const CLAUDE_TEMPLATES: Template[] = [
  { provider: 'claude', name: 'invoice-v2', project: 'billing-service', git: { branch: 'refactor/invoice-v2', ahead: 7, behind: 0, dirty: 3 }, worktree: true, model: 'opus', effort: 'xhigh', plan: 'Migrate invoices to the v2 schema', done: 3, ageSec: 2600, steps: [
    sub('Map invoice call sites', 'Explore', 'haiku', 'low', ['repo-map']), fork('Draft the v2 schema'), sub('Write the migration', 'general-purpose', 'sonnet', 'high'),
    sub('Dry-run the backfill', 'general-purpose', 'sonnet', 'medium'), fork('Port the invoice endpoints', ['code-review']), sub('Render PDFs from v2 rows', 'general-purpose', 'opus', 'high', ['frontend-design']),
    sub('Add contract tests for PDF totals', 'general-purpose', 'haiku', 'low', [], 5), sub('Review the full diff', 'code-review', 'opus', 'xhigh', ['code-review']), sub('Write rollout notes', 'general-purpose', 'haiku', 'low')] },
  { provider: 'claude', name: 'flaky-e2e', project: 'web-platform', git: { branch: 'fix/flaky-e2e', ahead: 1, behind: 3, dirty: 1 }, worktree: true, model: 'fable', effort: 'max', plan: 'Stabilize the e2e suite', done: 2, ageSec: 1400, waitNote: 'Bash(npm run e2e -- --retries=0)', steps: [
    sub('Collect the last 200 CI runs', 'general-purpose', 'haiku', 'low'), fork('Cluster failures by cause'), sub('Reproduce the top three flakes', 'general-purpose', 'sonnet', 'high'),
    sub('Fix the checkout race', 'general-purpose', 'opus', 'high'), sub('Rerun the suite twenty times', 'general-purpose', 'haiku', 'low')] },
  { provider: 'claude', name: 'handbook-links', project: 'handbook', git: { branch: 'main', ahead: 0, behind: 0, dirty: 12 }, worktree: false, model: 'haiku', effort: 'low', plan: null, ageSec: 300, steps: [
    sub('Fix broken internal links', 'general-purpose', 'haiku', 'low'), sub('Normalize heading levels', 'general-purpose', 'haiku', 'low')] },
  { provider: 'claude', name: 'iam-audit', project: 'terraform-live', git: { branch: 'audit/iam', ahead: 0, behind: 1, dirty: 0 }, worktree: false, model: 'opus', effort: 'medium', plan: 'Audit IAM roles', done: 2, ageSec: 3300, steps: [
    sub('List roles per account', 'Explore', 'haiku', 'low'), sub('Flag wildcard grants', 'general-purpose', 'sonnet', 'medium'), fork('Draft the findings'),
    sub('Propose least-privilege policies', 'general-purpose', 'opus', 'high'), sub('Open change requests', 'general-purpose', 'haiku', 'low')] },
  { provider: 'claude', name: 'offline-sync', project: 'mobile-app', git: { branch: 'feat/offline-sync', ahead: 4, behind: 0, dirty: 8 }, worktree: true, model: 'opus', effort: 'high', plan: 'Offline sync for notes', done: 1, ageSec: 1800, steps: [
    sub('Audit the cache layer', 'Explore', 'haiku', 'low', ['repo-map']), fork('Design conflict resolution'), sub('Persist the outbound queue', 'general-purpose', 'sonnet', 'high'),
    sub('Add retry backoff', 'general-purpose', 'sonnet', 'medium'), sub('Write the offline UI states', 'general-purpose', 'sonnet', 'medium', ['frontend-design']), sub('Test on the device farm', 'general-purpose', 'haiku', 'low')] },
  { provider: 'claude', name: 'oidc-login', project: 'auth-gateway', git: { branch: 'feat/oidc-login', ahead: 0, behind: 0, dirty: 0 }, worktree: true, model: 'opus', effort: 'high', plan: 'Add an OIDC login flow', steps: [
    sub('Survey the session middleware', 'Explore', 'haiku', 'low', ['repo-map']), fork('Draft the token exchange'), sub('Implement the callback handler', 'general-purpose', 'sonnet', 'medium', ['security-review']),
    sub('Write integration tests', 'general-purpose', 'sonnet', 'medium'), sub('Security review pass', 'code-review', 'opus', 'high', ['security-review'])] },
  { provider: 'claude', name: 'p99-latency', project: 'search-api', git: { branch: 'perf/p99-latency', ahead: 0, behind: 0, dirty: 2 }, worktree: false, model: 'sonnet', effort: 'medium', plan: 'Cut p99 query latency', steps: [
    sub('Capture baseline flame graphs', 'general-purpose', 'sonnet', 'low'), fork('Rank the hot paths'), sub('Prototype the index fix', 'general-purpose', 'opus', 'high'),
    sub('Benchmark before and after', 'general-purpose', 'haiku', 'low', ['dataviz'])] },
];

const CODEX_TEMPLATES: Template[] = [
  { provider: 'codex', name: 'Add settlement retries', project: 'payments-api', git: { branch: 'feat/settlement-retries', ahead: 2, behind: 0, dirty: 2 }, worktree: false, model: 'sol', effort: 'high', plan: 'plan', done: 1, ageSec: 1800, waitNote: 'Shell(pnpm test --filter settlement)', steps: [
    sub('Find every caller of the settlement retry helper', 'explorer', 'luna', 'medium'), sub('Add backoff to settlement retries', 'worker', 'sol', 'high'), sub('Run the settlement test suite', 'worker', 'luna', 'low')] },
  // A thread that works alone, as most Codex sessions do: with no agents running, a stall makes the session itself stuck.
  { provider: 'codex', name: 'Pin the time zone in date tests', project: 'calendar-sync', git: { branch: 'fix/date-tests', ahead: 1, behind: 0, dirty: 2 }, worktree: false, model: 'sol', effort: 'low', plan: null, ageSec: 600, steps: [] },
  // Same project as handbook-links and not a worktree, so the two edit one checkout on one machine and can collide.
  { provider: 'codex', name: 'Fix glossary anchors', project: 'handbook', git: { branch: 'main', ahead: 0, behind: 0, dirty: 4 }, worktree: false, model: 'luna', effort: 'medium', plan: null, ageSec: 240, steps: [
    sub('Check every glossary anchor', 'explorer', 'luna', 'low')] },
  { provider: 'codex', name: 'Bound consumer backpressure', project: 'event-pipeline', git: { branch: 'fix/backpressure', ahead: 1, behind: 2, dirty: 3 }, worktree: false, model: 'sol', effort: 'xhigh', plan: 'plan', done: 1, ageSec: 2100, waitNote: 'Shell(cargo test -p consumer)', steps: [
    sub('Map the consumer groups', 'explorer', 'luna', 'low'), sub('Trace the lag spikes', 'explorer', 'sol', 'medium'), sub('Bound the in-flight batch', 'worker', 'sol', 'high'),
    sub('Load-test the consumer', 'worker', 'luna', 'medium', [], 2)] },
  // `minimal` is a Codex effort outside Claude's five levels: the meter shows it as text.
  { provider: 'codex', name: 'Lint the data contracts', project: 'data-contracts', git: { branch: 'chore/schema-lint', ahead: 0, behind: 0, dirty: 6 }, worktree: false, model: 'luna', effort: 'minimal', plan: null, ageSec: 120, steps: [
    sub('Lint every schema', 'worker', 'luna', 'minimal')] },
  { provider: 'codex', name: 'Share the flag parser', project: 'devtools-cli', git: { branch: 'feat/flag-parsing', ahead: 3, behind: 0, dirty: 5 }, worktree: false, model: 'sol', effort: 'medium', plan: 'plan', ageSec: 900, steps: [
    sub('Inventory the flag parsers', 'explorer', 'luna', 'low'), sub('Port the parsers to the shared helper', 'worker', 'sol', 'medium')] },
];

/** Agents that launch agents: subagents under subagents three and four levels deep, a fork under a subagent, a subagent under a fork. */
const NESTED: Template = { provider: 'claude', name: 'adapter-rewrite', project: 'payments', git: { branch: 'feat/adapter-rewrite', ahead: 2, behind: 0, dirty: 4 }, worktree: true, model: 'opus', effort: 'high', plan: 'Rewrite the payment adapters', ageSec: 420, parallel: 8, steps: [
  sub('Plan the adapter rewrite', 'general-purpose', 'sonnet', 'high'),
  sub('Survey the payment adapters', 'Explore', 'haiku', 'low', ['repo-map'], 0),
  fork('Sketch the adapter interface', [], 0),
  sub('Read the card adapter', 'Explore', 'haiku', 'low', [], 1),
  sub('Check the refund path', 'Explore', 'haiku', 'low', [], 3),
  fork('Weigh the retry options'),
  sub('Check refund edge cases', 'general-purpose', 'sonnet', 'medium', [], 5),
  sub('Write the adapter tests', 'general-purpose', 'sonnet', 'medium')] };

/** Every project, in a fixed order: a project's sessions always run on the same machine. */
const PROJECTS = [...new Set([...CLAUDE_TEMPLATES, ...CODEX_TEMPLATES, NESTED].map((t) => t.project))];

/**
 * How an agent can fail, in the report's own Failure fields. finish() adds when it happened and the retry, and keeps the
 * exit code only where the reporter can read one.
 */
type FailSpec = Pick<Failure, 'class' | 'tool' | 'call' | 'exitCode' | 'outputTail' | 'evidence'>;

const FAILS: Record<Provider, FailSpec[]> = {
  claude: [
    { class: 'Tool error', tool: 'Bash', call: 'npm test -- invoice.contract.test.ts', exitCode: 1,
      outputTail: ['FAIL  src/contracts/invoice.contract.test.ts', '  ● invoice v2 › serializes totals', '    expected "total_cents": 12900', '    received "total": 129.0'],
      evidence: ['same call failed 2 times'] },
    { class: 'Tool error', tool: 'Edit', call: 'Edit src/render/pdf.ts', exitCode: null,
      outputTail: ['Error: old_string is not unique in the file (3 matches).'],
      evidence: ['src/render/pdf.ts read 4 times'] },
    { class: 'Blocked by permission', tool: 'Bash', call: 'rm -rf dist && npm run build', exitCode: null,
      outputTail: ['PreToolUse hook denied this call:', '  destructive command outside an allow-listed path'],
      evidence: ['permission denied'] },
    { class: 'Model API error', tool: 'model request', call: 'POST /v1/messages', exitCode: null,
      outputTail: ['529 overloaded_error', 'retried 3 times with backoff'],
      evidence: ['turn ended with reason "error"'] },
  ],
  codex: [
    // Codex's failure comes from the persisted turn error; tool exit codes only from paginated-history command items.
    { class: 'Model API error', tool: 'model request', call: 'turn failed', exitCode: null,
      outputTail: ['turn completed with an error: server_overloaded'], evidence: ['codex_error_info: server_overloaded'] },
    { class: 'Context window exhausted', tool: 'model request', call: 'turn failed', exitCode: null,
      outputTail: ['turn completed with an error: context_window_exceeded'], evidence: ['codex_error_info: context_window_exceeded'] },
    { class: 'Tool error', tool: 'Bash', call: 'cargo test -p consumer', exitCode: 101,
      outputTail: ['test batch::bounds_in_flight ... FAILED', 'thread panicked at batch.rs:88: in-flight 513 > 512'], evidence: ['exit code 101 from a command item'] },
  ],
};

/** The validator takes at most 200 agents per report; stay under it. */
const MAX_AGENTS = 195;
/** Events a reporter holds until the server acks them; past this the oldest go. */
const EVENT_QUEUE = 500;

const TOOLS: Record<Provider, string[]> = {
  claude: ['Read', 'Grep', 'Edit', 'Bash', 'Glob', 'Read', 'Write'],
  codex: ['Bash', 'Bash', 'apply_patch', 'Bash', 'update_plan', 'apply_patch'],
};
/** The tools a main loop picks from: mostly launching agents and keeping its plan, with fewer edits than its agents make. */
const LOOP_TOOLS: Record<Provider, string[]> = {
  claude: ['Agent', 'Read', 'TaskUpdate', 'Bash', 'Edit', 'Read', 'Agent'],
  codex: ['Bash', 'spawn_agent', 'update_plan', 'apply_patch', 'Bash', 'wait'],
};
/** Tools whose calls edit a file and so go out as `edit` events. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'apply_patch']);
/**
 * The chance each tick that one shared edit falls due: the next edit that can goes to a file another loop in its
 * checkout edited lately, raising a collision. Per tick, not per edit, so a busy fleet collides no more
 * often than a quiet one: about one shared edit every five minutes.
 */
const SHARED_EDIT_PER_TICK = 1 / 300;
/** How far back "lately" reaches, in ticks (simulated seconds), so a seed's choices never depend on the wall clock; at the
 * default speed that is three minutes, inside the server's five-minute collision window. */
const RECENT_EDIT_TICKS = 180;
/** The i-th file of a project's checkout, relative to its root: the changed-files list and the loops' own files share it. */
const projectFile = (project: string, i: number, stem = 'file'): string => `src/${project}/area${String(i % 4)}/${stem}${String(i).padStart(2, '0')}.ts`;
/** Skills a main loop may have loaded: the ones the templates' agents use. */
const LOOP_SKILLS = ['repo-map', 'code-review', 'security-review', 'dataviz'];
const NICKNAMES = ['Hopper', 'Lovelace', 'Turing', 'Noether', 'Ramanujan', 'Curie', 'Knuth', 'Liskov'];
/** Provider names for a turn that ended on a model API failure (Claude classic.StopFailure; Codex codex_error_info). */
const API_FAILURES: Record<Provider, string[]> = {
  claude: ['rate_limit', 'overloaded'],
  codex: ['usage_limit_exceeded', 'server_overloaded', 'internal_server_error'],
};

/** What a watched loop does, one entry a second, in turn. One line shows the redaction the reporters do. */
const FEED_SCRIPT: Record<Provider, [ActivityEntry['kind'], string][]> = {
  claude: [
    ['tool', 'Read docs/HOW-IT-WORKS.md'],
    ['text', 'Activity entries are cut to 300 characters on the machine. Following the same rule here.'],
    ['tool', 'Grep "lastActivityAt" in server/src/fleet'],
    ['tool', 'Edit server/src/fleet/derive.ts'],
    ['tool', 'Bash npm test -- derive'],
    ['tool', 'Bash curl -H "Authorization: [redacted]" http://127.0.0.1:4317/api/fleet/state'],
    ['text', 'Tests pass; the panel is next.'],
  ],
  codex: [
    ['tool', 'Bash rg -n "retry" src/settlement'],
    ['text', 'The retry helper is called from three modules. Adding the backoff in one place.'],
    ['tool', 'apply_patch src/settlement/retry.ts'],
    ['tool', 'Bash pnpm test --filter settlement'],
    ['tool', 'update_plan 2 of 3 steps done'],
    ['text', 'Tests pass. Updating the plan.'],
  ],
};

// ---- Simulation -------------------------------------------------------------------------------------

interface SimMachine {
  info: MachineInfo;
  index: number;
  /** Whether the Codex managed daemon runs here; without it every Codex session here is observe-only. */
  daemon: boolean;
}

interface SimAgent {
  report: AgentReport;
  /** The plan step it works on (an index into the session's steps), or null for an agent outside the plan. */
  planIndex: number | null;
  /** Steps of work it does before it may finish. */
  workSteps: number;
  /** How full its context window is, from 0 to 1; syncFill() copies it into report.context. */
  fill: number;
  /** The two files this loop works on, given to no other loop in its checkout; an edit goes to one of them or, now and
   * then, to a file another loop in the same checkout edited lately. */
  files: string[];
  /** Codex: this agent's own tokens per model, for its reports. A Claude agent's go out as telemetry instead. */
  usage: Map<string, TokenCounts>;
}

/** A plan step. It is never `blocked` here: planOf() shows that for a Claude step whose launching step (`under`) is still pending. */
interface SimStep {
  id: string;
  spec: StepSpec;
  state: 'pending' | 'active' | 'done';
  /** The agent working on it, or that finished it; null while it waits for one. */
  owner: string | null;
}

interface SimSession {
  // Who and where.
  id: string;
  provider: Provider;
  tpl: Template;
  machine: SimMachine;
  name: string;
  projectRoot: string;
  /** The project root, or the worktree under it the session works in. */
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  // What it is doing.
  status: 'running' | 'waiting' | 'done';
  waitReason: Report['session']['waitReason'];
  waitNote: string | null;
  /** Ticks until the person answers, or sends the next prompt. */
  waitLeft: number;
  /** Ticks left in a stall: the session still reports, but nothing happens (the server's stuck rule). */
  quietLeft: number;
  /** Gone quiet for good (--chaos): it never reports again, so the server removes it after its silence timer. */
  silent: boolean;
  lastActivityAt: number | null;
  toolOpen: boolean;
  // The main loop's own model, usage and work.
  model: string;
  /** How full the main loop's context window is, from 0 to 1. */
  fill: number;
  /** Codex: the main loop's tokens per model, for its reports. A Claude main loop's go out as telemetry instead. */
  usage: Map<string, TokenCounts>;
  blowouts: number;
  toolFailures: number;
  loop: LoopReport;
  files: string[];
  steps: SimStep[] | null;
  agents: SimAgent[];
  // What the reporter would know.
  /** Codex: whether our hooks are active for this thread; while false, blowouts are unknown. */
  hooksActive: boolean;
  /** Codex: answerable only in its own terminal or app. */
  observeOnly: boolean;
  /** Codex: one of the observe-only threads that is a desktop-app local thread, answered in the Codex app. Laptop only:
   * on a server the desktop app's threads are remote projects in the daemon, and answerable. */
  desktopApp: boolean;
  /** Whether tool exit status can be read: Claude always; Codex only in paginated history mode. */
  exitKnown: boolean;
  // The outbound side.
  /** Events the server has not acked yet, oldest first; eventSeq keeps their ids unique. */
  events: ActivityEvent[];
  eventSeq: number;
  /** Once done: how many times its final report went out. Three, or an ack, and it leaves the simulation. */
  finalSends: number;
  /** Loop ids (MAIN_LOOP or an agent id) that the last reply asked to watch, and each one's feed, newest 20 entries. */
  watch: string[];
  feed: Record<string, ActivityEntry[]>;
}

interface SimOptions {
  sessions: number;
  /** Share of sessions that are Codex, 0..1. */
  codex: number;
  machines: number;
  seed: number;
  chaos: boolean;
  /** Agents outside the plan that every session starts with (--agents), to put load on the UI. */
  extraAgents: number;
  nested: boolean;
  reporterVersion: string;
  now: () => number;
  home: string;
}

/** A stable 12-hex machine id from a label (FNV-1a), so a simulated machine keeps its id across runs. */
function machineId(label: string): string {
  let h = 0x811c9dc5;
  for (const ch of label) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  const lo = Math.imul(h ^ 0x5bd1e995, 0x01000193) >>> 0;
  return (h.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0')).slice(0, 12);
}

/** A laptop, then Linux servers. The last of three or more has no Codex daemon, and one server's OS could not be read. */
function simMachines(n: number): SimMachine[] {
  const serverOs = ['Ubuntu 24.04.3 LTS', 'Debian GNU/Linux 13 (trixie)', null];
  return Array.from({ length: n }, (_, i) => {
    const name = i === 0 ? 'sim-laptop' : `sim-server-${String(i)}`;
    const osName = i === 0 ? 'macOS 27.0.1' : serverOs[(i - 1) % serverOs.length];
    return { index: i, daemon: !(n >= 3 && i === n - 1), info: { name, id: machineId(name), os: osName } };
  });
}

/** An agent's whole task prompt, which the Claude reporter sends with its fullPrompts option. */
const fullPrompt = (task: string): string => `# ${task}

Start from the checkout you were launched in, and read \`CONTRIBUTING.md\` before you edit.

## Steps

1. Locate every place the task touches.
2. Keep the change to what the task asks for.
3. Run the test suite and say how it went.

> Never push, open a pull request or merge.`;

/** An agent's whole final answer, sent with the same option. */
const fullAnswer = (task: string): string => `## ${task}: done

The checks pass and nothing was pushed.

- 3 files changed
- \`npm test\` exits 0`;

/** A finished agent's answer: the excerpt every reporter sends, and from Claude the whole text. */
function answerFor(r: AgentReport, provider: Provider): void {
  r.answerExcerpt = `${r.description}: done, nothing blocking.`;
  if (provider === 'claude') r.answerText = fullAnswer(r.description);
}

const noTokens = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Adds one to each key's count in `counts`, and returns `counts`. */
function tally(counts: Record<string, number>, ...keys: string[]): Record<string, number> {
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}

/** `n` tokens split into a turn's parts; cache reads take what is left. */
function splitTokens(rng: Rng, n: number, provider: Provider): TokenCounts {
  const share = (lo: number, hi: number): number => Math.round(n * rng.range(lo, hi));
  const output = share(0.08, 0.18);
  const input = share(0.03, 0.07);
  // OpenAI reports no separate cache-write count; the Codex reporter sends 0.
  const cacheWrite = provider === 'codex' ? 0 : share(0.03, 0.08);
  return { input, output, cacheWrite, cacheRead: Math.max(0, n - input - output - cacheWrite) };
}

function addTokens(into: TokenCounts, t: TokenCounts): void {
  into.input += t.input;
  into.output += t.output;
  into.cacheRead += t.cacheRead;
  into.cacheWrite += t.cacheWrite;
}

function addUsage(into: Map<string, TokenCounts>, model: string, t: TokenCounts): void {
  const row = into.get(model) ?? noTokens();
  addTokens(row, t);
  into.set(model, row);
}

function usageRows(maps: Map<string, TokenCounts>[]): ModelUsage[] {
  const total = new Map<string, TokenCounts>();
  for (const m of maps) for (const [model, t] of m) addUsage(total, model, t);
  return [...total].sort(([a], [b]) => (a < b ? -1 : 1)).map(([model, t]): ModelUsage => ({ model, tier: 'std', tokens: { ...t, cacheWrite1h: 0 } }));
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
/** Still reporting: not ended, and not gone silent. */
const isLive = (s: SimSession): boolean => s.status !== 'done' && !s.silent;
const running = (a: SimAgent | undefined): boolean => a?.report.status === 'running';
const agentById = (s: SimSession, id: string | null): SimAgent | undefined => (id === null ? undefined : s.agents.find((a) => a.report.id === id));

/** The plan as the reporter sends it. Codex plans carry no title and only pending, in-progress and completed steps. */
function planOf(s: SimSession): Plan | null {
  const steps = s.steps;
  if (!steps) return null;
  const codex = s.provider === 'codex';
  return {
    title: codex ? null : s.tpl.plan,
    source: codex ? 'codex-plan' : 'TaskCreate',
    steps: steps.map((st): PlanStep => {
      const agent = codex ? undefined : agentById(s, st.owner);
      const blocked = !codex && st.state === 'pending' && st.spec.under !== undefined && steps[st.spec.under]?.state === 'pending';
      return {
        id: st.id,
        text: st.spec.d,
        state: blocked ? 'blocked' : st.state,
        activeText: !codex && st.state === 'active' ? `${st.spec.d}…` : null,
        ownerAgentId: agent ? agent.report.id : null,
        ownerLabel: agent ? `${agent.report.kind === 'fork' ? 'fork' : agent.report.type} · ${labelOf(agent.report.model)} ${agent.report.effort ?? ''}`.trim() : null,
      };
    }),
  };
}

/** The order changed files take their status in. */
const CHANGE_CYCLE: readonly ChangedFile['status'][] = ['modified', 'modified', 'added', 'modified', 'deleted', 'renamed'];

/**
 * The session's changed files, made up from its template's git counts: two per dirty file and three per commit ahead. Every
 * eleventh is binary, so git counts no lines for it; a new file removes no lines and a deleted one adds none.
 */
function filesOf(s: SimSession): FilesReport {
  const { project, git } = s.tpl;
  const out: FilesReport = { files: [], total: git.dirty * 2 + git.ahead * 3, added: 0, removed: 0, since: 'start' };
  for (let i = 0; i < out.total; i++) {
    const status = CHANGE_CYCLE[i % CHANGE_CYCLE.length];
    const counted = i % 11 !== 10;
    const added = counted ? (status === 'deleted' ? 0 : 3 + ((i * 7) % 40)) : null;
    const removed = counted ? (status === 'added' ? 0 : 1 + ((i * 5) % 25)) : null;
    out.files.push({ path: projectFile(project, i), status, added, removed, from: status === 'renamed' ? projectFile(project, i, 'old') : null });
    out.added += added ?? 0;
    out.removed += removed ?? 0;
  }
  return out;
}

class Simulator {
  private readonly rng: Rng;
  private readonly machines: SimMachine[];
  /** Every session still reporting, and each ended one until its final report is taken. */
  private fleet: SimSession[] = [];
  private readonly t0: number;
  private tickN = 0;
  private started = 0;
  private codexStarted = 0;
  private claudeIdx = 0;
  private codexIdx = 0;
  private agentSeq = 1;
  private readonly nameUse: Record<string, number> = {};
  /** Per checkout (machine and working directory): how many of its files have been given to loops. */
  private readonly filesGiven = new Map<string, number>();
  /** Edits of the last RECENT_EDIT_TICKS: which checkout, which loop, which file, in which tick. */
  private recentEdits: { checkout: string; loop: string; path: string; tick: number }[] = [];
  /** A shared edit fell due and no edit has taken it yet. */
  private sharedEditDue = false;
  /** Claude Code telemetry not yet taken: each machine's `api_request` records (OTLP LogRecords), by machine id. */
  private readonly telemetry = new Map<string, object[]>();
  private requestSeq = 0;

  constructor(private readonly config: SimOptions) {
    this.rng = new Rng(config.seed);
    this.machines = simMachines(config.machines);
    this.t0 = config.now();
    while (this.fleet.length < config.sessions) this.startSession(true);
  }

  private now(): number {
    return this.config.now();
  }

  /**
   * A loop used tokens. Codex: they add to the usage its reports carry. Claude: they go out as Claude Code's telemetry sends
   * them, one `api_request` record per model request. Work from before the simulator started arrives as several
   * requests, none with a prompt over the 100K tokens the server prices at the long tier.
   */
  private use(s: SimSession, a: SimAgent | null, model: string, t: TokenCounts): void {
    if (s.provider === 'codex') return addUsage(a ? a.usage : s.usage, model, t);
    const parts = Math.ceil((t.input + t.cacheRead + t.cacheWrite) / 90_000) || 1;
    for (let j = 0; j < parts; j++) {
      const share = (n: number): number => Math.floor((n * (j + 1)) / parts) - Math.floor((n * j) / parts);
      this.request(s, a, model, { input: share(t.input), output: share(t.output), cacheRead: share(t.cacheRead), cacheWrite: share(t.cacheWrite) });
    }
  }

  /**
   * One model request's `api_request` record, with the attributes Claude Code 2.1.319's records carry that usage reads: the
   * session, the agent on an agent's request, the model and its token counts, cache writes split by lifetime. Values are
   * strings, as Claude Code 2.1.319 sends numbers such as `prompt_length`; the server reads either. As on a subscription,
   * the main loop writes the 1-hour cache and agents the 5-minute one. The request id is unique to this run, so a second run
   * with the same seed is counted again.
   */
  private request(s: SimSession, a: SimAgent | null, model: string, t: TokenCounts): void {
    const now = this.now();
    const attr = (key: string, value: string | number) => ({ key, value: { stringValue: String(value) } });
    const records = this.telemetry.get(s.machine.info.id) ?? [];
    records.push({
      timeUnixNano: `${String(now)}000000`,
      body: { stringValue: 'claude_code.api_request' },
      attributes: [
        attr('event.name', 'api_request'),
        attr('event.timestamp', new Date(now).toISOString()),
        attr('session.id', s.id),
        ...(a ? [attr('agent_id', a.report.id)] : []),
        attr('query_source', a ? `agent:builtin:${a.report.type}` : 'repl_main_thread'),
        attr('request_id', `req_sim${this.t0.toString(36)}_${String(++this.requestSeq)}`),
        attr('model', model),
        attr('input_tokens', t.input),
        attr('output_tokens', t.output),
        attr('cache_read_tokens', t.cacheRead),
        attr('cache_creation_tokens', t.cacheWrite),
        attr('cache_creation_5m_tokens', a ? t.cacheWrite : 0),
        attr('cache_creation_1h_tokens', a ? 0 : t.cacheWrite),
      ],
    });
    this.telemetry.set(s.machine.info.id, records);
  }

  /** The telemetry since the last take: one OTLP/HTTP JSON logs export per machine, as Claude Code's exporter sends them. */
  takeTelemetry(): { machineId: string; body: object }[] {
    const exports = [...this.telemetry].map(([machineId, logRecords]) => ({
      machineId,
      body: { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] }, scopeLogs: [{ logRecords }] }] },
    }));
    this.telemetry.clear();
    return exports;
  }

  private ev(s: SimSession, kind: ActivityEvent['kind'], agentId: string | null, text: string, data: Record<string, unknown> | null = null): void {
    const t = this.now();
    s.events.push({ id: `${s.id}:${agentId ?? 'main'}:${kind}:${String(t)}:${String(++s.eventSeq)}`, t, kind, agentId, text: text.slice(0, 240), data });
    if (s.events.length > EVENT_QUEUE) s.events.shift();
  }

  /** The next template: Codex in the share asked for, spread evenly; the nested scenario first while it is asked for and not running. */
  private nextTemplate(): Template {
    const nestedLive = this.fleet.some((x) => x.tpl === NESTED && isLive(x));
    if (this.config.nested && !nestedLive) return NESTED;
    const codex = Math.round((this.started + 1) * this.config.codex) > this.codexStarted;
    if (codex) return CODEX_TEMPLATES[this.codexIdx++ % CODEX_TEMPLATES.length];
    return CLAUDE_TEMPLATES[this.claudeIdx++ % CLAUDE_TEMPLATES.length];
  }

  private startSession(initial: boolean): void {
    const tpl = this.nextTemplate();
    const rng = this.rng;
    const codexSeq = tpl.provider === 'codex' ? this.codexStarted++ : 0;
    this.started++;
    const uses = tally(this.nameUse, tpl.name)[tpl.name];
    // Claude session ids are v4 UUIDs; Codex thread ids are v7.
    const id = tpl.provider === 'codex'
      ? `019a${rng.hex(4)}-${rng.hex(4)}-7${rng.hex(3)}-${rng.pick(['8', '9', 'a', 'b'])}${rng.hex(3)}-${rng.hex(12)}`
      : `${rng.hex(8)}-${rng.hex(4)}-4${rng.hex(3)}-a${rng.hex(3)}-${rng.hex(12)}`;
    const machine = this.machines[PROJECTS.indexOf(tpl.project) % this.machines.length];
    const home = machine.index === 0 ? this.config.home : '/home/dev';
    const projectRoot = `${home}/dev/${tpl.project}`;
    const leaf = tpl.git.branch.split('/').pop() ?? tpl.git.branch;
    const cwd = tpl.worktree ? `${projectRoot}/.claude/worktrees/${leaf}` : projectRoot;
    const ageSec = initial ? (tpl.ageSec ?? rng.int(5, 120)) : rng.int(1, 5);
    const now = this.now();
    // The properties are evaluated in order, so the random draws (fill, then the loop's history) keep a seed's sequence.
    const s: SimSession = {
      id,
      provider: tpl.provider,
      tpl,
      machine,
      name: (tpl.worktree ? leaf : tpl.name) + (uses > 1 ? `-${String(uses)}` : ''),
      projectRoot,
      cwd,
      startedAt: now - ageSec * 1000,
      endedAt: null,
      status: 'running',
      waitReason: null,
      waitNote: null,
      waitLeft: 0,
      quietLeft: 0,
      silent: false,
      lastActivityAt: now,
      toolOpen: false,
      model: MODELS[tpl.model].id,
      fill: rng.range(0.08, 0.3),
      usage: new Map(),
      blowouts: 0,
      toolFailures: 0,
      loop: this.seedLoop(tpl.provider, initial ? ageSec : 0),
      files: [],
      steps: tpl.plan ? tpl.steps.map((spec, i) => ({ id: tpl.provider === 'codex' ? `plan-${String(i + 1)}` : String(i + 1), spec, state: 'pending', owner: null })) : null,
      agents: [],
      hooksActive: tpl.provider === 'claude' || codexSeq % 5 !== 1,
      observeOnly: tpl.provider === 'codex' && (!machine.daemon || codexSeq % 4 === 1),
      desktopApp: tpl.provider === 'codex' && machine.index === 0 && codexSeq % 8 === 1,
      exitKnown: tpl.provider === 'claude' || codexSeq % 3 === 2,
      events: [],
      eventSeq: 0,
      finalSends: 0,
      watch: [],
      feed: {},
    };
    s.files = this.workFiles(s);
    this.use(s, null, s.model, splitTokens(rng, rng.int(60_000, 220_000), s.provider));
    this.ev(s, 'start', null, `session.start · ${labelOf(s.model)} ${tpl.effort}`);
    if (!s.steps) {
      for (const step of tpl.steps) this.spawn(s, null, 'running', step);
    } else {
      // A session that was already under way when the simulator started shows the steps it had finished, with past times.
      const finished = initial ? Math.min(tpl.done ?? 0, s.steps.length) : 0;
      for (let i = 0; i < finished; i++) {
        const past = this.spawn(s, i, 'done').report;
        past.startedAt = now - rng.int(120, 900) * 1000;
        past.endedAt = past.startedAt + rng.int(40, 300) * 1000;
      }
      this.spawnNext(s);
    }
    for (let n = 1; n <= this.config.extraAgents; n++) {
      const model = s.provider === 'codex' ? rng.pick<ModelKey>(['sol', 'luna']) : rng.pick<ModelKey>(['haiku', 'sonnet', 'opus']);
      this.spawn(s, null, 'running', sub(`Load agent ${String(n)}`, s.provider === 'codex' ? 'worker' : 'general-purpose', model, 'low'));
    }
    this.fleet.push(s);
  }

  /** A checkout on a machine: loops there share its files, and only they can collide on one. */
  private checkoutOf(s: SimSession): string {
    return `${String(s.machine.index)}\u0000${s.cwd}`;
  }

  /** The next two files of the session's checkout for one loop, the changed files first, so no two loops share one. */
  private workFiles(s: SimSession): string[] {
    const checkout = this.checkoutOf(s);
    const next = this.filesGiven.get(checkout) ?? 0;
    this.filesGiven.set(checkout, next + 2);
    return [next, next + 1].map((i) => `${s.cwd}/${projectFile(s.tpl.project, i)}`);
  }

  private spawn(s: SimSession, planIndex: number | null, status: AgentReport['status'], adhoc?: StepSpec): SimAgent {
    const rng = this.rng;
    const spec = planIndex !== null && s.steps ? s.steps[planIndex].spec : adhoc;
    if (!spec) throw new Error('spawn needs a step or an ad-hoc spec');
    const isFork = spec.kind === 'fork';
    const parentId = spec.under !== undefined && s.steps ? (s.steps[spec.under]?.owner ?? null) : null;
    // A fork runs on the model and effort of whoever launched it: its parent agent, or the main loop when it has none.
    const parent = agentById(s, parentId);
    const model = spec.model ? MODELS[spec.model].id : (parent?.report.model ?? s.model);
    const effort = spec.effort ?? parent?.report.effort ?? s.tpl.effort;
    const codex = s.provider === 'codex';
    // Codex child agents are threads with v7 ids; Claude agent ids are opaque.
    const id = codex
      ? `019a${rng.hex(4)}-${rng.hex(4)}-7${rng.hex(3)}-8${rng.hex(3)}-${rng.hex(12)}`
      : `a${(this.agentSeq++).toString(16).padStart(6, '0')}${rng.hex(10)}`;
    const workSteps = rng.int(4, 9);
    const window = windowOf(model);
    const fill = isFork ? rng.range(0.12, 0.3) : rng.range(0.01, 0.06);
    const now = this.now();
    const report: AgentReport = {
      id,
      parentId,
      kind: isFork ? 'fork' : 'subagent',
      type: spec.type,
      name: codex ? rng.pick(NICKNAMES) : null,
      description: spec.d,
      model,
      effort,
      effortSource: codex ? 'observed' : isFork ? 'inherited' : rng.chance(0.3) ? 'observed' : 'requested',
      status,
      startedAt: now,
      endedAt: null,
      context: contextOf(fill, window),
      costUsdEst: null,
      skills: [...spec.skills],
      lastTool: rng.pick(TOOLS[s.provider]),
      toolCalls: 0,
      toolCounts: {},
      blowouts: s.hooksActive ? 0 : null,
      toolFailures: s.exitKnown ? 0 : null,
      steps: { done: 0, total: null },
      promptExcerpt: `${spec.d}. Answer in a short list, and keep every edit on the working branch.`,
      answerExcerpt: null,
      failure: null,
      lastActivityAt: now,
      toolOpen: false,
    };
    // The Claude reporter sends the whole prompt and answer with its fullPrompts option, which the simulator shows.
    if (!codex) report.promptText = fullPrompt(spec.d);
    const a: SimAgent = { report, planIndex, workSteps, fill, files: this.workFiles(s), usage: new Map() };
    if (status === 'done') {
      this.use(s, a, model, splitTokens(rng, rng.int(30_000, 260_000), s.provider));
      report.steps = { done: workSteps, total: null };
      report.toolCalls = workSteps * 3;
      report.toolCounts = tally({}, ...Array.from({ length: report.toolCalls }, () => rng.pick(TOOLS[s.provider])));
      answerFor(report, s.provider);
      a.fill = rng.range(0.2, 0.7);
      this.syncFill(a);
    }
    s.agents.push(a);
    if (planIndex !== null && s.steps) this.assign(s.steps[planIndex], a, s.agents);
    if (status !== 'done') {
      const who = isFork ? `fork (inherits ${labelOf(model)} ${effort})` : codex ? `${spec.type} ${report.name ?? ''} (${labelOf(model)} ${effort})` : `${spec.type} (${labelOf(model)} ${effort})`;
      this.ev(s, 'spawn', id, `${isFork ? 'forked' : 'spawned'} ${who}: ${spec.d}`);
      const into = isFork ? 'fork' : spec.type;
      if (spec.skills.length) this.ev(s, 'skill', id, `${spec.skills.join(', ')} loaded into ${into}`, { skills: spec.skills });
    }
    return a;
  }

  /** Hands a plan step to an agent. If an earlier agent failed this step, its failure now names this one as the retry. */
  private assign(step: SimStep, a: SimAgent, agents: readonly SimAgent[]): void {
    for (const other of agents) {
      const failure = other.report.failure;
      if (other !== a && other.planIndex === a.planIndex && failure && failure.retriedAs === null) failure.retriedAs = a.report.id;
    }
    step.owner = a.report.id;
    step.state = a.report.status === 'done' ? 'done' : 'active';
  }

  /** Copies an agent's fill, capped at a full window, into its report. */
  private syncFill(a: SimAgent): void {
    a.report.context = contextOf(Math.min(1, a.fill), a.report.context.window ?? windowOf(a.report.model));
  }

  private spawnNext(s: SimSession): void {
    if (!s.steps) return;
    if (s.agents.length >= MAX_AGENTS) {
      this.end(s, 'agent limit reached');
      return;
    }
    const steps = s.steps;
    if (steps.filter((x) => x.state === 'active').length >= (s.tpl.parallel ?? 2)) return;
    const i = steps.findIndex((x) => x.state === 'pending' && (x.spec.under === undefined || steps[x.spec.under]?.owner !== null));
    if (i < 0) return;
    this.spawn(s, i, 'running');
    if (s.tpl.plan) this.ev(s, 'plan', null, `step ${String(i + 1)} started`);
  }

  /** The context window filled and was compacted. Only our hooks see that a compaction was automatic. */
  private blowout(s: SimSession, a: SimAgent | null): void {
    const window = a ? (a.report.context.window ?? windowOf(a.report.model)) : windowOf(s.model);
    if (a) {
      a.fill = 0.3;
      this.syncFill(a);
    } else s.fill = 0.3;
    if (!s.hooksActive) return;
    const n = a ? (a.report.blowouts ?? 0) + 1 : ++s.blowouts;
    if (a) a.report.blowouts = n;
    this.ev(s, 'blow', a ? a.report.id : null, `context window exceeded (blowout #${String(n)})${a ? ` in “${a.report.description}”` : ' on the orchestrator'}, compacted to 30%`, {
      kind: 'auto-compact',
      tokensBefore: Math.round(window * this.rng.range(0.99, 1.01)),
      tokensAfter: Math.round(window * 0.3),
    });
    if (a && n >= 3 && a.report.status === 'running') {
      this.finish(s, a, false, {
        class: 'Context window exhausted', tool: 'model request', call: `model request (context ${(window / 1e6).toFixed(2)}M tokens)`, exitCode: null,
        outputTail: [`Context window exceeded ${String(n)} times in this run.`], evidence: [`exceeded the window ${String(n)} times`],
      });
    }
  }

  /**
   * An agent's run ends: done with its answer, or failed with the failure its reporter would send (`fail`, else one of the
   * provider's), its exit code kept only where the reporter can read one (Codex: paginated history only). The activity text
   * is the reporters' own. A failed plan step goes back to waiting: spawnNext gives it to a new agent, which assign() names
   * as this one's retry.
   */
  private finish(s: SimSession, a: SimAgent, ok: boolean, fail?: FailSpec): void {
    const r = a.report;
    r.endedAt = this.now();
    r.toolOpen = false;
    r.status = ok ? 'done' : 'failed';
    let f: FailSpec | null = null;
    if (ok) answerFor(r, s.provider);
    else {
      f = fail ?? this.rng.pick(FAILS[s.provider]);
      r.failure = { ...f, at: this.now(), exitCode: s.exitKnown ? f.exitCode : null, outputTail: f.outputTail.slice(-12), evidence: f.evidence.slice(0, 5), retriedAs: null };
    }
    this.ev(s, f ? 'fail' : 'done', r.id, f ? `failed: ${r.description} (${f.class})` : `finished: ${r.description}`, f && { class: f.class });
    const step = a.planIndex !== null && s.steps ? s.steps[a.planIndex] : null;
    if (step) {
      step.state = ok ? 'done' : 'pending';
      if (!ok) step.owner = null;
    }
  }

  /** A loop that has already worked `ageSec` seconds: a few calls per tool, some steps, up to two skills (Claude). */
  private seedLoop(provider: Provider, ageSec: number): LoopReport {
    const rng = this.rng;
    const calls = Math.round(ageSec / 20);
    const toolCounts = tally({}, ...Array.from({ length: calls }, () => rng.pick(LOOP_TOOLS[provider])));
    const skills = provider === 'claude' ? LOOP_SKILLS.filter(() => rng.chance(0.35)).slice(0, 2) : [];
    return { skills, lastTool: calls ? rng.pick(LOOP_TOOLS[provider]) : null, toolCalls: calls, toolCounts, steps: { done: calls + rng.int(1, 4), total: null } };
  }

  /** One tool call by a loop: counts it, may fail it (where exit status is known), and reports an edit with its path. */
  private toolCall(s: SimSession, a: SimAgent | null, tool: string): void {
    const now = this.now();
    const failP = this.config.chaos ? 0.15 : 0.03;
    const failed = this.rng.chance(failP);
    if (a) {
      a.report.toolCalls += 1;
      tally((a.report.toolCounts ??= {}), tool);
      a.report.lastTool = tool;
      a.report.lastActivityAt = now;
      a.report.toolOpen = this.rng.chance(0.3);
      if (a.report.toolFailures !== null) a.report.toolFailures = failed ? a.report.toolFailures + 1 : 0;
    } else {
      s.loop.toolCalls += 1;
      tally(s.loop.toolCounts, tool);
      s.loop.lastTool = tool;
      s.lastActivityAt = now;
      s.toolOpen = this.rng.chance(0.3);
      if (s.exitKnown) s.toolFailures = failed ? s.toolFailures + 1 : 0;
    }
    this.maybeMessage(s, a);
    if (!EDIT_TOOLS.has(tool) || failed) return;
    // This loop's own files; now and then a file another loop in the same checkout edited lately, so the two collide.
    const checkout = this.checkoutOf(s);
    const loop = `${s.id}\u0000${a ? a.report.id : ''}`;
    this.recentEdits = this.recentEdits.filter((e) => this.tickN - e.tick <= RECENT_EDIT_TICKS);
    const others = this.recentEdits.filter((e) => e.checkout === checkout && e.loop !== loop);
    const shared = this.sharedEditDue && others.length > 0;
    if (shared) this.sharedEditDue = false;
    const path = shared ? this.rng.pick(others).path : this.rng.pick(a ? a.files : s.files);
    this.recentEdits.push({ checkout, loop, path, tick: this.tickN });
    this.ev(s, 'edit', a ? a.report.id : null, `editing ${basename(path)}`, { path });
  }

  /**
   * Now and then a loop messages another loop of its session: Claude's SendMessage, Codex's send_input. `to` is the
   * recipient's id, null for the main loop; now and then a name no loop has (no `to`), and a Codex message whose text is not
   * known (empty).
   */
  private maybeMessage(s: SimSession, a: SimAgent | null): void {
    const others = s.agents.filter((x) => running(x) && x !== a);
    if (!this.rng.chance(0.06) || (a === null && others.length === 0)) return;
    const target = a !== null && (others.length === 0 || this.rng.chance(0.4)) ? null : this.rng.pick(others);
    const text = s.provider === 'codex' && this.rng.chance(0.15) ? '' : this.rng.pick(MESSAGES);
    const data = this.rng.chance(0.1)
      ? { toName: 'reviewer' }
      : { to: target === null ? null : target.report.id, toName: target === null ? (s.provider === 'claude' ? 'team-lead' : 'main') : (target.report.name ?? target.report.type) };
    this.ev(s, 'message', a ? a.report.id : null, text, data);
  }

  private tickSession(s: SimSession): void {
    const rng = this.rng;
    const chaos = this.config.chaos;
    if (s.status === 'waiting') {
      if (--s.waitLeft <= 0) {
        this.ev(s, 'note', null, s.waitReason === 'permission' ? 'permission granted, resuming' : 'new prompt, resuming');
        s.status = 'running';
        s.waitReason = null;
        s.waitNote = null;
        s.lastActivityAt = this.now();
      }
      return;
    }
    if (s.quietLeft > 0) {
      s.quietLeft--;
      return;
    }
    const codex = s.provider === 'codex';
    for (const a of s.agents.filter(running)) {
      const model = a.report.model ?? '';
      const n = Math.round(rng.int(900, 5200) * (model.includes('haiku') || model.includes('luna') ? 1.6 : model.includes('opus') ? 0.7 : 1) * 8);
      this.use(s, a, model, splitTokens(rng, n, s.provider));
      if (rng.chance(0.6)) this.toolCall(s, a, rng.pick(TOOLS[s.provider]));
      a.fill += (n / (a.report.context.window ?? 1e6)) * (chaos ? 0.12 : 0.06);
      this.syncFill(a);
      if (a.fill >= 0.97) this.blowout(s, a);
      if (running(a) && rng.chance(0.15) && a.report.steps) {
        a.report.steps.done++;
        a.report.lastActivityAt = this.now();
      }
    }
    if (rng.chance(0.4)) this.toolCall(s, null, rng.pick(LOOP_TOOLS[s.provider]));
    if (rng.chance(0.3)) {
      s.loop.steps = { done: s.loop.steps.done + 1, total: null };
      s.lastActivityAt = this.now();
    }
    const own = splitTokens(rng, rng.int(200, 900) * 6, s.provider);
    this.use(s, null, s.model, own);
    // Paced as if every main loop had a 1M window, so smaller windows do not blow out every minute.
    s.fill += ((own.input + own.cacheRead + own.cacheWrite) / 1e6) * (chaos ? 3 : 1.2);
    if (s.fill >= 0.97) this.blowout(s, null);

    // An agent is ready once its own work is done and nothing it launched still runs. A ready agent may finish this tick;
    // one still working may fail instead. Either way one draw per running agent.
    for (const a of s.agents.filter(running)) {
      const childRunning = s.agents.some((child) => child.report.parentId === a.report.id && running(child));
      const ready = !childRunning && (a.report.steps?.done ?? 0) >= a.workSteps;
      if (rng.chance(ready ? 0.35 : chaos ? 0.012 : 0.004)) this.finish(s, a, ready);
    }
    if (s.steps) {
      if (rng.chance(0.3)) this.spawnNext(s);
      const title = s.provider === 'claude' ? s.tpl.plan : null;
      if (s.steps.every((x) => x.state === 'done')) this.end(s, `plan complete: ${title ?? 'all steps'}`);
    } else if (s.tpl.steps.length === 0) {
      if (rng.chance(0.002)) this.end(s, 'task done');
    } else if (!s.agents.some(running)) {
      if (rng.chance(0.5) || s.agents.length >= MAX_AGENTS) this.end(s, 'every agent finished');
      else this.spawn(s, null, 'running', codex ? sub('Spot-check the changed files', 'explorer', 'luna', 'low') : sub('Spot-check the changed pages', 'general-purpose', 'haiku', 'low'));
    }
    if (s.status !== 'running') return;
    // A Codex thread outside the daemon shows a permission wait only through our hooks.
    const seesPermission = !codex || s.hooksActive || !s.observeOnly;
    if (s.tpl.waitNote && seesPermission && rng.chance(0.01)) this.wait(s, 'permission', s.tpl.waitNote, rng.int(8, 25));
    else if (rng.chance(0.006)) this.wait(s, 'idle', null, rng.int(5, 20));
    else if (chaos && rng.chance(0.002)) {
      // The turn ended on a model API failure: the server derives the errored state from this event.
      const category = rng.pick(API_FAILURES[s.provider]);
      this.ev(s, 'fail', null, `turn ended on a model API error: ${category}`, { category });
      this.wait(s, 'idle', null, rng.int(15, 40));
    } else if (chaos && rng.chance(0.002)) {
      // A stall: running, nothing happening, sometimes inside a long tool call (which doubles the stuck threshold).
      s.quietLeft = rng.int(240, 600);
      s.toolOpen = rng.chance(0.5);
    } else if (chaos && rng.chance(0.003)) s.silent = true;
  }

  /** The turn stops at a permission prompt, which needs the person, or ends with nothing asked: idle, which does not. */
  private wait(s: SimSession, reason: 'permission' | 'idle', note: string | null, ticks: number): void {
    s.status = 'waiting';
    s.waitReason = reason;
    s.waitNote = note;
    s.waitLeft = ticks;
    s.toolOpen = false;
    s.lastActivityAt = this.now();
    if (reason === 'permission') this.ev(s, 'wait', null, `waiting on you: ${note ?? 'permission'}`);
  }

  private end(s: SimSession, why: string): void {
    if (s.status === 'done') return;
    for (const a of s.agents) {
      if (a.report.status === 'running' || a.report.status === 'queued') {
        a.report.status = 'aborted';
        a.report.endedAt = this.now();
        a.report.toolOpen = false;
      }
    }
    s.status = 'done';
    s.waitReason = null;
    s.waitNote = null;
    s.toolOpen = false;
    s.endedAt = this.now();
    this.ev(s, 'plan', null, why);
    this.ev(s, 'end', null, `session.end · ${this.endReason(s, why)}`);
  }

  /** Codex's SessionEnd reason is always `other`. */
  private endReason(s: SimSession, why: string): string {
    return s.provider === 'codex' || why === 'exit' ? 'other' : 'prompt_input_exit';
  }

  /** Claude: every fourth session loses its window from tick 30 to 119, so dimmed and hidden cards show. Codex never knows. */
  private attached(s: SimSession): boolean | null {
    if (s.provider === 'codex') return null;
    const away = this.tickN >= 30 && this.tickN < 120;
    return !away || [...s.id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 4 !== 0;
  }

  /** One provider account's plan windows on one machine: the same for every session there, climbing with time. */
  private rateLimitsOf(s: SimSession): RateLimit[] {
    const base = (s.machine.index * 23 + (s.provider === 'codex' ? 11 : 0)) % 60;
    const climb = this.tickN / (this.config.chaos ? 6 : 40);
    const pct = (v: number) => Math.min(100, Math.round(v * 10) / 10);
    return [
      { kind: 'five_hour', percentUsed: pct(base + climb), resetsAt: new Date(this.t0 + 5 * 3600_000).toISOString() },
      { kind: 'seven_day', percentUsed: pct(base / 3 + climb / 8), resetsAt: new Date(this.t0 + 7 * 86400_000).toISOString() },
    ];
  }

  /** The session's report, deep-copied so it never changes once returned. */
  reportOf(s: SimSession): Report {
    const codex = s.provider === 'codex';
    const feed = s.feed[MAIN_LOOP];
    const git = s.tpl.git;
    return structuredClone<Report>({
      v: 1,
      sentAt: this.now(),
      provider: s.provider,
      reporter: {
        name: reporterOf(s.provider),
        version: this.config.reporterVersion,
        engineVersion: null,
        hostSurface: 'simulator',
        ...(codex && s.machine.daemon ? { daemonVersion: '0.164.0' } : {}),
      },
      session: {
        id: s.id,
        name: s.name,
        status: s.status,
        // Both are set only while waiting: wait() sets them, and resuming and end() clear them.
        waitReason: s.waitReason,
        waitNote: s.waitNote,
        endReason: s.status === 'done' ? this.endReason(s, '') : null,
        // A Codex thread resumes by its own id; Claude's id is sent once the session ended.
        resumeId: codex || s.status === 'done' ? s.id : null,
        startedAt: s.startedAt,
        cwd: s.cwd,
        projectRoot: s.projectRoot,
        repoName: `acme/${s.tpl.project}`,
        git: { branch: git.branch, detached: false, isWorktree: s.tpl.worktree, worktreePath: s.tpl.worktree ? s.cwd : null, ahead: git.ahead, behind: git.behind, dirty: git.dirty },
        model: s.model,
        effort: s.tpl.effort,
        context: contextOf(Math.min(1, s.fill), windowOf(s.model)),
        costUsd: null,
        ...(codex ? { usageByModel: usageRows([s.usage, ...s.agents.map((a) => a.usage)]) } : {}),
        rateLimits: this.rateLimitsOf(s),
        blowouts: s.hooksActive ? s.blowouts : null,
        toolFailures: s.exitKnown ? s.toolFailures : null,
        ...(codex ? { hooksActive: s.hooksActive } : {}),
        plan: planOf(s),
        loop: s.loop,
        files: filesOf(s),
        attached: this.attached(s),
        activityFeed: true,
        ...(feed?.length ? { activity: feed } : {}),
        // What an observe-only Codex thread reports: nothing it can take from the dashboard, and for a desktop-app local
        // thread that it is answered in the Codex app.
        ...(s.observeOnly ? { respond: { level: 'everything' as const, accepts: [], limits: s.desktopApp ? ['observe-only' as const, 'desktop-app' as const] : ['observe-only' as const] } } : {}),
        lastActivityAt: s.lastActivityAt,
        toolOpen: s.toolOpen,
      },
      agents: s.agents.map((a) => ({
        ...a.report,
        ...(codex ? { usageByModel: usageRows([a.usage]) } : {}),
        ...(s.feed[a.report.id]?.length ? { activity: s.feed[a.report.id] } : {}),
      })),
      events: s.events.slice(0, 100),
      machine: s.machine.info,
    });
  }

  /**
   * One simulated second: every live session works, watched loops add to their feeds, an empty slot may refill, and the
   * reports due now come back. An ended session's final report goes out until acked, three times at most, and then the
   * session leaves; a silent one never reports again. Either way its slot refills a few ticks later.
   */
  step(): Report[] {
    this.tickN++;
    if (this.rng.chance(SHARED_EDIT_PER_TICK)) this.sharedEditDue = true;
    for (const s of this.fleet.filter(isLive)) this.tickSession(s);
    for (const s of this.fleet.filter(isLive)) this.tickFeed(s);
    if (this.tickN % 4 === 0 && this.fleet.filter(isLive).length < this.config.sessions) this.startSession(false);
    const due = this.fleet.filter((s) => !s.silent && (s.status !== 'done' || s.finalSends < 3));
    const reports = due.map((s) => {
      if (s.status === 'done') s.finalSends++;
      return this.reportOf(s);
    });
    this.fleet = this.fleet.filter((s) => s.status !== 'done' || s.finalSends < 3 || due.includes(s));
    return reports;
  }

  private byId(sessionId: string): SimSession | undefined {
    return this.fleet.find((x) => x.id === sessionId);
  }

  /** A reply named the loops someone is watching: feed those, and forget the feed of any loop it no longer names. */
  watch(sessionId: string, ids: readonly string[]): void {
    const s = this.byId(sessionId);
    if (!s) return;
    s.watch = [...ids];
    s.feed = Object.fromEntries(Object.entries(s.feed).filter(([loop]) => ids.includes(loop)));
  }

  /** One entry a second for each watched loop that is still working. No randomness, so a seed's run is unchanged. */
  private tickFeed(s: SimSession): void {
    const script = FEED_SCRIPT[s.provider];
    for (const loop of s.watch) {
      const working = loop === MAIN_LOOP ? s.status === 'running' : running(agentById(s, loop));
      if (!working) continue;
      const entries = (s.feed[loop] ??= []);
      const [kind, text] = script[(this.tickN + entries.length) % script.length];
      entries.push({ at: this.now(), kind, text });
      if (entries.length > 20) entries.shift();
    }
  }

  /** The server acknowledged the first `n` events of a session's report, and with them an ended session's final report. */
  ack(sessionId: string, n: number): void {
    const s = this.byId(sessionId);
    if (!s) return;
    s.events.splice(0, n);
    if (s.status === 'done') s.finalSends = 3;
  }

  /** Ends every session still open (on exit) and returns the final report of each. */
  endAll(): Report[] {
    const open = this.fleet.filter((s) => s.status !== 'done' || s.finalSends < 3);
    for (const s of open) this.end(s, 'exit');
    return open.map((s) => this.reportOf(s));
  }
}

// ---- Command line ------------------------------------------------------------------------------------

/** What the command line sets: the simulation's own options, and how main() drives it and where it sends the reports. */
interface Args extends Omit<SimOptions, 'now' | 'home'> {
  url: string;
  speed: number;
  duration: number;
  print: boolean;
  ticks: number;
}

/** A number option's value, or `fallback` when it was not given; a value outside min..max is an error. */
function numberArg(name: string, raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number from ${String(min)} to ${String(max)}`);
  return n;
}

/**
 * The run's options, or null when the run ends here: --help printed, or the command line refused (said why, exit code
 * 2). Node's own parser reads the options; it refuses an unknown option, a missing value and a stray argument.
 */
function readArgs(argv: string[]): Args | null {
  try {
    const { values: v } = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        url: { type: 'string' },
        sessions: { type: 'string' },
        codex: { type: 'string' },
        machines: { type: 'string' },
        speed: { type: 'string' },
        seed: { type: 'string' },
        duration: { type: 'string' },
        chaos: { type: 'boolean' },
        agents: { type: 'string' },
        nested: { type: 'boolean' },
        'reporter-version': { type: 'string' },
        print: { type: 'boolean' },
        ticks: { type: 'string' },
      },
    });
    if (v.help) {
      console.log(HELP);
      return null;
    }
    return {
      url: (v.url ?? 'http://127.0.0.1:4317').replace(/\/+$/, ''),
      sessions: Math.round(numberArg('sessions', v.sessions, 1, 50, 5)),
      codex: numberArg('codex', v.codex, 0, 1, 0.4),
      machines: Math.round(numberArg('machines', v.machines, 1, 8, 3)),
      speed: numberArg('speed', v.speed, 0.1, 50, 1),
      seed: Math.round(numberArg('seed', v.seed, 0, 2 ** 32, 1)),
      duration: numberArg('duration', v.duration, 0, 7 * 24 * 3600, 0),
      chaos: v.chaos ?? false,
      extraAgents: Math.round(numberArg('agents', v.agents, 0, 190, 0)),
      nested: v.nested ?? false,
      reporterVersion: v['reporter-version'] ?? '0.1.0-sim',
      print: v.print ?? false,
      ticks: Math.round(numberArg('ticks', v.ticks, 1, 1e7, 60)),
    };
  } catch (err) {
    console.error(`sim: ${(err as Error).message} (see --help)`);
    process.exitCode = 2;
    return null;
  }
}

/** Server text made safe to print: C0 and C1 controls and the Unicode line separators become spaces, so it cannot forge a log line. */
const logSafe = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');

/** Refusal statuses already explained, so a wrong secret or host name is reported once and not every second. */
const explained = new Set<number>();

/** Posts one report. Returns what the reply acknowledged and asks to watch, or null when the report should go again. */
async function post(url: string, token: string | null, report: Report): Promise<{ acked: number; watch: string[] } | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(token ? { [TOKEN_HEADER]: token } : {}) };
  try {
    const res = await fetch(`${url}/api/fleet/report`, { method: 'POST', headers, body: JSON.stringify(report), signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const reply = (await res.json()) as { ackedEvents?: number; watch?: unknown };
      const watch = Array.isArray(reply.watch) ? reply.watch.filter((x): x is string => typeof x === 'string') : [];
      return { acked: reply.ackedEvents ?? 0, watch };
    }
    if (res.status === 400) {
      // The server called the report invalid: say why, and count it as delivered so it is never sent again.
      console.error(`sim: report rejected: ${logSafe((await res.text()).slice(0, 200))}`);
      return { acked: report.events.length, watch: [] };
    }
    // 401: the secret is missing or wrong. 403: the server does not expect the host name in --url.
    if ((res.status === 401 || res.status === 403) && !explained.has(res.status)) {
      explained.add(res.status);
      const hint = res.status === 401 ? ' (is SITREP_TOKEN the server\'s admin secret?)' : '';
      console.error(`sim: report refused (${String(res.status)})${hint}: ${logSafe((await res.text()).slice(0, 200))}`);
    }
    return null;
  } catch {
    return null;
  }
}

/** Posts one machine's telemetry export as Claude Code's OTLP exporter does, with the secret and the machine id in headers. */
async function postLogs(url: string, token: string | null, t: { machineId: string; body: object }): Promise<void> {
  const headers = { 'Content-Type': 'application/json', [MACHINE_HEADER]: t.machineId, ...(token ? { [TOKEN_HEADER]: token } : {}) };
  try {
    const res = await fetch(`${url}/api/fleet/v1/logs`, { method: 'POST', headers, body: JSON.stringify(t.body), signal: AbortSignal.timeout(3000) });
    if (!res.ok && !explained.has(res.status)) {
      explained.add(res.status);
      console.error(`sim: telemetry refused (${String(res.status)}): ${logSafe((await res.text()).slice(0, 200))}`);
    }
  } catch {
    // Unreachable: the reports' own failure line says so.
  }
}

async function main(): Promise<void> {
  const a = readArgs(process.argv.slice(2));
  if (a === null) return;
  // The admin secret comes from the environment only: never argv, a URL or a log line.
  const token = process.env.SITREP_TOKEN || null;
  const simOptions = (now: () => number, home: string): SimOptions => ({ ...a, now, home });

  if (a.print) {
    // No server: a fixed clock from a set start, one JSON line per report, and every report counts as acked.
    let clock = 1_800_000_000_000;
    const sim = new Simulator(simOptions(() => clock, '/Users/sim'));
    const emit = (r: Report): void => console.log(JSON.stringify(r));
    const emitTelemetry = (): void => sim.takeTelemetry().forEach((t) => console.log(JSON.stringify({ machine: t.machineId, logs: t.body })));
    for (let tick = 0; tick < a.ticks; tick++) {
      clock += 1000;
      for (const r of sim.step()) {
        emit(r);
        sim.ack(r.session.id, r.events.length);
      }
      emitTelemetry();
    }
    sim.endAll().forEach(emit);
    emitTelemetry();
    return;
  }

  const sim = new Simulator(simOptions(Date.now, os.homedir()));
  console.log(`sim: ${String(a.sessions)} sessions (Codex share ${String(a.codex)}) on ${String(a.machines)} machines, seed ${String(a.seed)}, speed ${String(a.speed)}${a.chaos ? ', chaos' : ''}${a.nested ? ', nested' : ''} -> ${a.url}`);
  let stopping = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopping) return;
    const reports = sim.step();
    const replies = await Promise.all(reports.map((r) => post(a.url, token, r)));
    reports.forEach((r, i) => {
      const reply = replies[i];
      if (!reply) return;
      sim.ack(r.session.id, reply.acked);
      sim.watch(r.session.id, reply.watch);
    });
    await Promise.all(sim.takeTelemetry().map((t) => postLogs(a.url, token, t)));
    const failed = replies.filter((x) => x === null).length;
    if (failed && failures++ % 10 === 0) console.error(`sim: ${String(failed)} of ${String(reports.length)} reports failed (is the server at ${a.url}?)`);
    if (!stopping) timer = setTimeout(() => void tick(), 1000 / a.speed);
  };

  const stop = async (why: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    const finals = sim.endAll();
    await Promise.all([...finals.map((r) => post(a.url, token, r)), ...sim.takeTelemetry().map((t) => postLogs(a.url, token, t))]);
    console.log(`sim: ${why}; ended ${String(finals.length)} sessions`);
    process.exit(0);
  };
  // Once each: a second Ctrl-C quits at once, without waiting for the final reports.
  process.once('SIGINT', () => void stop('interrupted'));
  process.once('SIGTERM', () => void stop('terminated'));
  if (a.duration > 0) setTimeout(() => void stop(`duration ${String(a.duration)}s reached`), a.duration * 1000);
  void tick();
}

void main();
