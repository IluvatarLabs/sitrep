// The console's arithmetic, pure: the Fleet's filters and sorts, plans, agent counts and the agent tree, totals and times,
// model names, and one effort order for both harnesses.
import { MAIN_LOOP } from "../../../server/src/fleet/protocol";
import { plural } from "./format";
import { isHeadless, stateOf, STATE_WORD } from "./states";
import type { AgentView, ModelFamily, Plan, PlanStep, PlanStepView, PlanView, SessionView } from "./types";

/** The main loop's row in the agent tree: the key the server gives it. */
export { MAIN_LOOP as ORCHESTRATOR_ROW };

// ---- the Fleet: sorts and filters ------------------------------------------------------------------------------------

/** The Fleet's sorts, by their labels. "Auto-compacts" is Claude Code's own word for a context blowout. */
export const SORTS = { spend: "Spend", context: "Context", blowouts: "Auto-compacts", model: "Model", newest: "Newest", name: "Name" } as const;
export type SortKey = keyof typeof SORTS;

/** The Fleet's filters, by their labels: All, then each state in the state bar's order. */
export const STATUS_FILTERS = { all: "All", ...STATE_WORD } as const;
export type StatusFilter = keyof typeof STATUS_FILTERS;

/** A figure nobody reported sorts below every reported one. */
const orLow = (n: number | null) => n ?? -1;
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

type SessionCompare = (a: SessionView, b: SessionView) => number;

/** Largest first. */
const descending = (figure: (s: SessionView) => number): SessionCompare => (a, b) => figure(b) - figure(a);

/** A session's model as its harness names it; null when nobody reported one, which sorts after every named model. */
const modelName = (s: SessionView): string | null => (s.model === null && s.modelFamily === "other" ? null : familyName(s.modelFamily, s.model));

/** Models by name, so a model's sessions sit together; an unreported model last. */
const byModel: SessionCompare = (a, b) => {
  const x = modelName(a);
  const y = modelName(b);
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
  return x.localeCompare(y);
};

/** No sort orders by state, so a session's card never moves when its state changes; every tie goes by name (sortSessions). */
const SESSION_ORDER: Record<SortKey, SessionCompare> = {
  spend: descending((s) => orLow(s.costUsd)),
  context: descending((s) => orLow(s.context.percent)),
  blowouts: descending((s) => orLow(s.blowouts?.total ?? null)),
  model: byModel,
  newest: descending((s) => s.startedAt),
  name: () => 0,
};

/** Sessions in a sort's order; ties go by name, then id, so the order never jumps. */
export function sortSessions(sessions: readonly SessionView[], by: SortKey): SessionView[] {
  return [...sessions].sort((a, b) => SESSION_ORDER[by](a, b) || a.name.localeCompare(b.name) || byId(a, b));
}

/** All, or the session's state. */
export const matchesStatus = (s: SessionView, f: StatusFilter): boolean => f === "all" || stateOf(s) === f;

/** The sessions a filter and a search let through; the search is one phrase over name, project, branch and machine. */
export function filterSessions(list: readonly SessionView[], { status, q }: { status: StatusFilter; q: string }): SessionView[] {
  const phrase = q.trim().toLowerCase();
  const text = (s: SessionView) => [s.name, s.project, s.git?.branch ?? "", s.machine.name].join("\n").toLowerCase();
  return list.filter((s) => matchesStatus(s, status) && (phrase === "" || text(s).includes(phrase)));
}

/**
 * Background sessions, set aside unless shown, still live and counted: a headless run (states.ts isHeadless), and a session nobody has been
 * attached to past its `hideAt` (detached), a background job (`claude --bg`) included, by that rule alone: one its owner
 * attaches to stays on the wall. One that never said is shown.
 */
export function splitDetached(list: readonly SessionView[], now: number, show: boolean): Record<"shown" | "hidden", SessionView[]> {
  const shown: SessionView[] = [];
  const hidden: SessionView[] = [];
  for (const s of list) {
    const setAside = s.attached === false && s.hideAt !== null && now >= s.hideAt;
    (isHeadless(s) || setAside ? hidden : shown).push(s);
  }
  return { shown: show ? [...list] : shown, hidden };
}

// ---- plans ------------------------------------------------------------------------------------------------------------

type Steps = Pick<Plan, "steps"> | null;

export type PlanProgress = { done: number; total: number; pct: number };

/** Steps done of all, and the share; null without steps. */
export function planProgress(plan: Steps): PlanProgress | null {
  const steps = plan?.steps ?? [];
  if (steps.length === 0) return null;
  const done = steps.filter((x) => x.state === "done").length;
  return { done, total: steps.length, pct: done / steps.length };
}

const STEP_ORDER: readonly PlanStep["state"][] = ["active", "blocked", "pending", "done"];

/**
 * The session page's step order: in progress, blocked, pending, then done in the order they finished (steps done when first
 * seen lead). The sort is stable, so equal steps keep plan order; the plan's counts keep plan order throughout.
 */
export function orderedSteps(plan: Pick<PlanView, "steps"> | null): PlanStepView[] {
  const finished = (x: PlanStepView) => (x.state === "done" ? (x.doneSeq ?? 0) : 0);
  return [...(plan?.steps ?? [])].sort((a, b) => STEP_ORDER.indexOf(a.state) - STEP_ORDER.indexOf(b.state) || finished(a) - finished(b));
}

// ---- agents: counts and the tree ---------------------------------------------------------------------------------------

export type AgentCounts = Record<AgentView["status"] | "all", number>;

/** Agents by status, and all of them. */
export function agentCounts(agents: readonly Pick<AgentView, "status">[]): AgentCounts {
  const counts: AgentCounts = { all: agents.length, queued: 0, running: 0, done: 0, failed: 0, aborted: 0 };
  for (const a of agents) counts[a.status] += 1;
  return counts;
}

/** As agentCounts, with the main loop: running while the session runs, done once it is. */
export function sessionCounts(s: Pick<SessionView, "status" | "agents">): AgentCounts {
  const counts = agentCounts(s.agents);
  // The main loop is working only while the session runs: waiting (needs you, idle) it is neither working nor done, so a tally
  // never says "1 working" beside Idle.
  if (s.status === "done") counts.done += 1;
  else if (s.status === "running") counts.running += 1;
  counts.all += 1;
  return counts;
}

export type AgentCompare = (a: AgentView, b: AgentView) => number;

/** An agent in the tree with a guide per level: `last` an elbow, `mid` a tee or a line through, `blank` nothing. */
export type TreeRow = { agent: AgentView; guides: ("mid" | "last" | "blank")[] };
export type Guide = TreeRow["guides"][number];

/** The agent that launched this one; null when the main loop did or the launcher is not listed. */
export function parentOf(agents: readonly AgentView[], a: Pick<AgentView, "id" | "parentId">): AgentView | null {
  return a.parentId && a.parentId !== a.id ? (agents.find((x) => x.id === a.parentId) ?? null) : null;
}

/**
 * Agents under their parents at any depth, each with its guides: `last` for the final child at its level, else `mid`, and
 * above that `blank` where the ancestor was a last child, else `mid`. An agent whose parent is not listed starts at the top.
 * With `order`, each parent's children are sorted by it, so a sorted table keeps children under their parent; without it
 * they stay in launch order.
 */
export function buildTree(agents: readonly AgentView[], order?: AgentCompare): TreeRow[] {
  const listed = new Set(agents.map((a) => a.id));
  const children = new Map<string | null, AgentView[]>();
  for (const a of agents) {
    const parent = a.parentId && a.parentId !== a.id && listed.has(a.parentId) ? a.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), a]);
  }
  if (order) for (const list of children.values()) list.sort(order);

  // Depth first from a stack, siblings pushed last first so the first comes off first.
  const stack: { agent: AgentView; above: Guide[]; last: boolean }[] = [];
  const push = (parent: string | null, above: Guide[]) => {
    const list = children.get(parent) ?? [];
    for (let i = list.length - 1; i >= 0; i--) stack.push({ agent: list[i]!, above, last: i === list.length - 1 });
  };
  const rows: TreeRow[] = [];
  const placed = new Set<string>();
  push(null, []);
  for (let next = stack.pop(); next; next = stack.pop()) {
    const { agent, above, last } = next;
    if (placed.has(agent.id)) continue;
    placed.add(agent.id);
    rows.push({ agent, guides: [...above, last ? "last" : "mid"] });
    push(agent.id, [...above, last ? "blank" : "mid"]);
  }
  // Agents in a parent cycle are never reached from the top; they are listed there all the same.
  for (const a of agents) if (!placed.has(a.id)) rows.push({ agent: a, guides: ["last"] });
  return rows;
}

export const treeDepth = (rows: readonly TreeRow[]): number => rows.reduce((n, r) => Math.max(n, r.guides.length), 0);

// ---- tokens, cost and time ----------------------------------------------------------------------------------------------

/** An agent's tokens for a sum (the context it holds now, as the native client's agent line shows): 0 while not reported. */
export const agentTokens = (a: Pick<AgentView, "context">): number => a.context.tokens ?? 0;

/** The main loop's context plus each agent's, so a session's rows add up. */
export const sessionTokens = (s: Pick<SessionView, "context" | "agents">): number => s.agents.reduce((n, a) => n + agentTokens(a), s.context.tokens ?? 0);

/** Whether any loop of the session reported its tokens; until one has, the total is unknown, not zero. */
export const tokensKnown = (s: Pick<SessionView, "context" | "agents">): boolean => s.context.tokens !== null || s.agents.some((a) => a.context.tokens !== null);

/** Sums over an agent's branch: its own estimate plus each one's under it; an agent with no price adds nothing. */
export interface BranchTotals {
  /** Null until an agent in the branch reports its tokens. */
  tokens: number | null;
  costUsd: number;
  /** Agents in the branch with no price. */
  unpriced: number;
  /** Agents under this one at every depth, itself not counted. */
  agents: number;
}

/** An agent and every agent under it, each once, a parent cycle included. */
export function branchTotals(agents: readonly AgentView[], rootId: string): BranchTotals {
  const children = new Map<string, AgentView[]>();
  for (const a of agents) if (a.parentId && a.parentId !== a.id) children.set(a.parentId, [...(children.get(a.parentId) ?? []), a]);
  const totals: BranchTotals = { tokens: null, costUsd: 0, unpriced: 0, agents: 0 };
  const root = agents.find((a) => a.id === rootId);
  const queue = root ? [root] : [];
  const reached = new Set([rootId]);
  // Breadth first, by index; an agent reached again (a cycle) is not counted twice.
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i]!;
    if (a.id !== rootId) totals.agents += 1;
    if (a.costUsdEst === null) totals.unpriced += 1;
    else totals.costUsd += a.costUsdEst;
    if (a.context.tokens !== null) totals.tokens = (totals.tokens ?? 0) + a.context.tokens;
    for (const child of children.get(a.id) ?? []) {
      if (reached.has(child.id)) continue;
      reached.add(child.id);
      queue.push(child);
    }
  }
  return totals;
}

/** The titles of the figures that could mislead: one sentence each. */
export const COST_HINT_SESSION = "The session and every agent under it: its token usage priced with the price table.";
export const AGENTS_HINT = "Every agent once, nested ones included, and the main loop.";
export const COST_HINT_ORCHESTRATOR = "The session's cost less its agents' estimates, never below $0.";
export const COST_HINT_AGENT = "This agent alone, not the agents it launched.";
export const COST_HINT_HEADER = "Each agent's own est. cost; the main loop's row is the rest, so the rows add up.";
export const TOKENS_HINT = "Tokens in the context window now, as the session's own client counts them.";

/**
 * The title of a row whose agents work for it: "2 agents working: survey, tests". A stuck one runs but is not working, so it
 * is counted apart, as the state line says it (states.ts stateLine): "1 agent working · 1 stuck: survey, tests".
 */
export function delegateText(children: readonly Pick<AgentView, "description" | "stuck">[]): string {
  const stuck = children.filter((a) => a.stuck).length;
  const working = children.length - stuck;
  const lead = working === 0 ? `${plural(stuck, "agent")} stuck` : `${plural(working, "agent")} working${stuck > 0 ? ` · ${stuck} stuck` : ""}`;
  return `${lead}: ${children.map((a) => a.description).join(", ")}`;
}

/** Seconds an agent ran: to its end, or to now while it runs. */
export const agentElapsedSec = (a: Pick<AgentView, "startedAt" | "endedAt">, now: number): number => Math.max(0, ((a.endedAt ?? now) - a.startedAt) / 1000);

/** Seconds since the session started, stopped at its last report once it is done. */
export const sessionElapsedSec = (s: Pick<SessionView, "status" | "startedAt" | "lastSeenAt">, now: number): number =>
  Math.max(0, ((s.status === "done" ? s.lastSeenAt : now) - s.startedAt) / 1000);

/** The main loop's share of the session's cost: what its agents' estimates leave, never below 0; null with no session figure. */
export function orchestratorCostUsd(s: Pick<SessionView, "costUsd" | "agents">): number | null {
  if (s.costUsd === null) return null;
  const agents = s.agents.reduce((n, a) => n + (a.costUsdEst ?? 0), 0);
  return Math.max(0, s.costUsd - agents);
}

/** Tokens spent on a model with no price row (the server's costReason): a cost unknown, not zero. No usage yet is not this. */
export const unpricedUse = (s: Pick<SessionView, "costReason" | "tokensTotal">): boolean => s.costReason === "unpriced" && s.tokensTotal !== null && s.tokensTotal > 0;

// ---- models and effort ------------------------------------------------------------------------------------------------

/**
 * One effort order for both harnesses: Codex's ReasoningEffort (codex-rs/protocol/src/openai_models.rs), which holds Claude
 * Code's five levels too, then a model's own value; an effort nobody reported sorts below all.
 */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"];

export function effortRank(effort: string | null): number {
  if (effort === null) return -1;
  const at = EFFORT_ORDER.indexOf(effort.toLowerCase());
  return at < 0 ? EFFORT_ORDER.length : at;
}

const CLAUDE: ReadonlySet<ModelFamily> = new Set(["opus", "sonnet", "haiku", "fable"]);

/**
 * The version in a Claude model id: 5.5 for claude-sonnet-5-5, 4 for claude-opus-4-20250514, 3.5 for claude-3-5-sonnet-20241022;
 * null for an alias or another maker's id. A version part is one or two digits, so a date is never one.
 */
const VERSION_AFTER = /(?:opus|sonnet|haiku|fable)-(\d{1,2}(?:-\d{1,2})?)(?!\d)/;
const VERSION_BEFORE = /claude-(\d{1,2}(?:-\d{1,2})?)-(?:opus|sonnet|haiku|fable)/;

export function modelVersion(id: string | null): string | null {
  const lower = id?.toLowerCase() ?? "";
  if (!lower.includes("claude")) return null;
  return (VERSION_AFTER.exec(lower) ?? VERSION_BEFORE.exec(lower))?.[1]?.replace("-", ".") ?? null;
}

/**
 * Codex's own name for a model id (codex-rs/tui/src/status/thread_usage.rs:265-297 and model_catalog's one alias):
 * "gpt-6-astra" is "GPT-6 Astra", "gpt-5-mini" "GPT-5 Mini", "gpt-5.4" "GPT-5.4"; an id that is not GPT stays as it is.
 */
function codexName(id: string): string {
  if (id.toLowerCase() === "gpt-reserve") return "Luna Reserve";
  const cut = id.indexOf("-");
  if (cut < 0 || cut === id.length - 1 || id.slice(0, cut).toLowerCase() !== "gpt") return id;
  const [first = "", ...rest] = id.slice(cut + 1).split("-");
  const join = /^\d/.test(first) ? " " : "-";
  const word = (w: string) => (w.toLowerCase() === "oai" ? "OAI" : w.charAt(0).toUpperCase() + w.slice(1));
  return `GPT-${first}${rest.map((w) => join + word(w)).join("")}`;
}

/** A model as its harness names it: a Claude family and its version ("Sonnet 5.5"), any other id by Codex's rule. */
export function familyName(family: ModelFamily, id: string | null): string {
  if (!CLAUDE.has(family)) return id === null ? (family === "openai" ? "OpenAI" : "unknown") : codexName(id);
  const version = modelVersion(id);
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return version ? `${name} ${version}` : name;
}

// ---- the agent table's sorts ----------------------------------------------------------------------------------------------

const AGENT_STATUS_ORDER: readonly AgentView["status"][] = ["running", "failed", "queued", "aborted", "done"];

/** Each column of the agent table as a value to sort by: names as text, figures as numbers (unknown lowest). */
const AGENT_COLUMN = {
  model: (a: AgentView) => familyName(a.modelFamily, a.model),
  effort: (a: AgentView) => effortRank(a.effort),
  ctx: (a: AgentView) => orLow(a.context.percent),
  tok: (a: AgentView) => agentTokens(a),
  cost: (a: AgentView) => orLow(a.costUsdEst),
  time: (a: AgentView, now: number) => agentElapsedSec(a, now),
  status: (a: AgentView) => AGENT_STATUS_ORDER.indexOf(a.status),
};
export type AgentSortKey = keyof typeof AGENT_COLUMN;

const ASCENDING: ReadonlySet<AgentSortKey> = new Set<AgentSortKey>(["model", "effort", "status"]);

/** A column's first direction: names and states ascend, figures descend. */
export const defaultAgentDir = (key: AgentSortKey): 1 | -1 => (ASCENDING.has(key) ? 1 : -1);

/** Compares two agents by a column in a direction; ties go by id. */
export function agentOrder(key: AgentSortKey, dir: 1 | -1, now: number): AgentCompare {
  const value: (a: AgentView, now: number) => string | number = AGENT_COLUMN[key];
  const compare = (x: string | number, y: string | number) => (typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y));
  return (a, b) => compare(value(a, now), value(b, now)) * dir || byId(a, b);
}
