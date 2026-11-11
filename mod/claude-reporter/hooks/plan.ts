// The session's plan from Claude Code's task tools. Pure: each reducer hands back a new PlanState, or the one it was given
// when the input is not one it understands, and never throws.
import type { Plan, PlanStep } from './protocol.ts';

/** The task tools' own status words, and the step state each is in a report. */
const STEP_STATE = { pending: 'pending', in_progress: 'active', completed: 'done' } as const;

/**
 * One step as the reporter holds it: the contract's step fields (`ownerAgentId` is the agent matched as its owner, kept once
 * matched), the task tools' own status word, and the owner and blockers those tools name.
 */
export type TaskState = Pick<PlanStep, 'id' | 'text' | 'activeText' | 'ownerAgentId' | 'ownerLabel'> & {
  status: keyof typeof STEP_STATE;
  /** The name a TaskUpdate gave as the step's owner. */
  owner: string | null;
  /** Ids of the steps this one waits for. */
  blockedBy: string[];
};

export interface PlanState {
  /** The title the reporter's own plan tool set; it wins over `metaTitle`. */
  toolTitle: string | null;
  /** A title from the first TaskCreate's metadata. */
  metaTitle: string | null;
  /** The tool the steps came from; null before the first one. */
  source: Plan['source'] | null;
  /** The steps, in the order the tools made them. */
  tasks: TaskState[];
}

export const emptyPlan: PlanState = { toolTitle: null, metaTitle: null, source: null, tasks: [] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A string with something in it; null otherwise. */
const filled = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const short = (s: string, n = 240): string => (s.length > n ? s.slice(0, n) : s);
/** `v` held to `n` characters when it is a string with something in it, else `keep`. */
function cutOr<K extends string | null>(v: unknown, keep: K, n = 240): string | K {
  const text = filled(v);
  return text === null ? keep : short(text, n);
}
/** A tool result's payload, whether or not it comes wrapped in `{ result }`. */
const payload = (result: unknown): unknown => (isObj(result) && isObj(result.result) ? result.result : result);
/** The strings of a list of ids; nothing for anything else. */
const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const isStepStatus = (v: unknown): v is TaskState['status'] => typeof v === 'string' && Object.hasOwn(STEP_STATE, v);

/** A plan reducer that hands back the plan it was given, unchanged, when its input makes it throw. */
function guarded<A extends unknown[]>(reduce: (p: PlanState, ...args: A) => PlanState): (p: PlanState, ...args: A) => PlanState {
  return (p, ...args) => {
    try {
      return reduce(p, ...args);
    } catch {
      return p;
    }
  };
}

/** A step nobody owns or blocks yet. */
function newStep(id: string, text: string, activeText: string | null, status: TaskState['status'] = 'pending'): TaskState {
  return { id, text, activeText, status, owner: null, blockedBy: [], ownerAgentId: null, ownerLabel: null };
}

/** The plan title the first TaskCreate's metadata gives: `planTitle`, else `title`. */
function metadataTitle(metadata: Obj): string | null {
  return filled(metadata.planTitle) ?? filled(metadata.title);
}

/**
 * TaskCreate: the step's id is in the result (`{ task: { id } }`), its text is the input's `subject` (else the result's).
 * Steps a TodoWrite made give way to it; a step made again under a known id moves to the end.
 */
export const taskCreate = guarded((p: PlanState, input: unknown, result: unknown): PlanState => {
  if (!isObj(input)) return p;
  const made = payload(result);
  const task = isObj(made) && isObj(made.task) ? made.task : null;
  const id = task === null ? null : filled(task.id);
  const subject = filled(input.subject) ?? (task === null ? null : filled(task.subject));
  if (id === null || subject === null) return p;
  const step = newStep(id, short(subject), cutOr(input.activeForm, null));
  if (p.source === 'TodoWrite') return { ...p, tasks: [step], source: 'TaskCreate', metaTitle: null };
  const firstStep = p.tasks.length === 0 && !p.metaTitle && isObj(input.metadata);
  const metaTitle = firstStep ? metadataTitle(input.metadata as Obj) : p.metaTitle;
  return { ...p, tasks: [...p.tasks.filter((t) => t.id !== id), step], source: 'TaskCreate', metaTitle };
});

/** Every step but `id`, none of them still waiting on it. */
function withoutStep(tasks: readonly TaskState[], id: string): TaskState[] {
  const rest: TaskState[] = [];
  for (const t of tasks) if (t.id !== id) rest.push({ ...t, blockedBy: t.blockedBy.filter((b) => b !== id) });
  return rest;
}

/** TaskUpdate: status (and `deleted`), subject, activeForm, owner, addBlockedBy and addBlocks. A failed update changes nothing. */
export const taskUpdate = guarded((p: PlanState, input: unknown, result?: unknown): PlanState => {
  if (!isObj(input)) return p;
  const outcome = payload(result);
  if (isObj(outcome) && outcome.success === false) return p;
  const id = filled(input.taskId);
  if (id === null || !p.tasks.some((t) => t.id === id)) return p;
  if (input.status === 'deleted') return { ...p, tasks: withoutStep(p.tasks, id) };
  const holdsUp = new Set(idList(input.addBlocks));
  const waitsOn = idList(input.addBlockedBy).filter((b) => b !== id);
  const status = isStepStatus(input.status) ? input.status : null;
  const changed = (t: TaskState): TaskState => ({
    ...t,
    status: status ?? t.status,
    text: cutOr(input.subject, t.text),
    activeText: cutOr(input.activeForm, t.activeText),
    owner: cutOr(input.owner, t.owner, 80),
    blockedBy: [...new Set([...t.blockedBy, ...waitsOn])],
  });
  const tasks = p.tasks.map((t) => {
    if (t.id === id) return changed(t);
    // A step this one now blocks waits on it, once.
    return holdsUp.has(t.id) && !t.blockedBy.includes(id) ? { ...t, blockedBy: [...t.blockedBy, id] } : t;
  });
  // A known step means a source is already set.
  return { ...p, tasks };
});

/** TodoWrite: the whole list at once, ids `todo-<index>`. A step whose text stayed keeps the owner it had. */
export const todoWrite = guarded((p: PlanState, input: unknown): PlanState => {
  const todos: unknown = isObj(input) ? input.todos : null;
  if (!Array.isArray(todos)) return p;
  const before = new Map((p.source === 'TodoWrite' ? p.tasks : []).map((t) => [t.id, t]));
  const tasks = todos.flatMap((todo: unknown, i): TaskState[] => {
    const content = isObj(todo) ? filled(todo.content) : null;
    if (!isObj(todo) || content === null) return [];
    const status = isStepStatus(todo.status) ? todo.status : 'pending';
    const step = newStep(`todo-${i}`, short(content), cutOr(todo.activeForm, null), status);
    const was = before.get(step.id);
    return [was?.text === step.text ? { ...step, ownerAgentId: was.ownerAgentId, ownerLabel: was.ownerLabel } : step];
  });
  return { ...p, source: 'TodoWrite', metaTitle: null, tasks };
});

/** The reporter's plan tool names the plan (`title`, and an optional `phase`); it never changes where the steps came from. */
export const setTitle = guarded((p: PlanState, input: unknown): PlanState => {
  const title = isObj(input) ? filled(input.title) : null;
  if (!isObj(input) || title === null) return p;
  const phase = filled(input.phase);
  return { ...p, toolTitle: short(phase === null ? title : `${title} · ${phase}`) };
});

/** Lowercase letters and digits only, for matching a step's text with an agent's description. */
const squashed = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** What owner matching knows of one agent. */
export interface OwnerCandidate {
  id: string;
  /** What a step it owns shows as its owner. */
  label: string;
  /** A teammate's name, matched against a TaskUpdate `owner`. */
  name: string | null;
  running: boolean;
  /** Matched against a step's text while the agent runs. */
  description: string;
}

/**
 * The agent a step is matched to now: the one its TaskUpdate `owner` names, else, for a step that has none yet, a running
 * agent whose normalized description holds, or is held by, the step's normalized text.
 */
function matchOwner(t: TaskState, agents: readonly OwnerCandidate[]): OwnerCandidate | undefined {
  const named = t.owner ? agents.find((a) => a.name !== null && a.name === t.owner) : undefined;
  if (named !== undefined || t.ownerAgentId) return named;
  const text = squashed(t.text);
  if (text === '') return undefined;
  return agents.find((a) => {
    const desc = a.running ? squashed(a.description) : '';
    return desc !== '' && (desc.includes(text) || text.includes(desc));
  });
}

/**
 * Finds each step's owner (matchOwner). Once matched a step keeps its owner after the agent finishes; only the label
 * follows the agent.
 */
export function withOwners(p: PlanState, candidates: readonly OwnerCandidate[]): PlanState {
  const tasks = p.tasks.map((t): TaskState => {
    const owner = matchOwner(t, candidates) ?? (t.ownerAgentId ? candidates.find((a) => a.id === t.ownerAgentId) : undefined);
    if (owner === undefined || (owner.id === t.ownerAgentId && owner.label === t.ownerLabel)) return t;
    return { ...t, ownerAgentId: owner.id, ownerLabel: owner.label };
  });
  return tasks.some((t, i) => t !== p.tasks[i]) ? { ...p, tasks } : p;
}

/** The plan as a report carries it; null with no steps. A pending step that waits on an unfinished step is `blocked`. */
export function planOf(p: PlanState): Plan | null {
  if (p.tasks.length === 0) return null;
  const unfinished = new Set(p.tasks.filter((t) => t.status !== 'completed').map((t) => t.id));
  const steps = p.tasks.slice(0, 100).map(({ id, text, status, blockedBy, activeText, ownerAgentId, ownerLabel }): PlanStep => {
    const blocked = status === 'pending' && blockedBy.some((b) => unfinished.has(b));
    return { id, text, state: blocked ? 'blocked' : STEP_STATE[status], activeText, ownerAgentId, ownerLabel };
  });
  return { title: p.toolTitle ?? p.metaTitle, source: p.source ?? 'TaskCreate', steps };
}
