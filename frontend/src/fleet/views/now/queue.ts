// What Now and the wall view read off the sessions in view: the needs-you queue, the problems and their words. Pure.
import { hashFor } from "../../../route";
import { needsYou, openAsk, stateLine, stateOf, type State } from "../../states";
import { byWait, isQuestionTool, toolOfNote } from "../../waiting";
import type { AgentView, AskKind, AskSummary, CollisionView, SessionView } from "../../types";
import { dotsText } from "../../ui/Dots";
import { agentWords } from "../map/words";

/** An agent's name in rows: its task, else the name its harness gave it, else its type. */
export const agentLabel = (a: Pick<AgentView, "description" | "name" | "type">): string => a.description.trim() || a.name?.trim() || a.type;

/** The name of one of a session's agents in rows (agentLabel), "agent" when the session does not list it; null for the main loop. */
export function agentNameOf(s: Pick<SessionView, "agents">, agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  const a = s.agents.find((x) => x.id === agentId);
  return a ? agentLabel(a) : "agent";
}

/** The loop that asks or acts: the session's name for its main loop, "session › agent" for one of its agents. */
export function loopName(s: Pick<SessionView, "name" | "agents">, agentId: string | null | undefined): string {
  const agent = agentNameOf(s, agentId);
  return agent === null ? s.name : `${s.name} › ${agent}`;
}

/** One thing that needs you: an open ask, or a session that needs you with none open. */
export interface QueueItem {
  key: string;
  s: SessionView;
  ask: AskSummary | null;
  /** When the wait began: the ask's opening, else the session's last event; null when unknown. */
  since: number | null;
  /** The loop that waits: the session, or "session › agent". */
  who: string;
  /** The loop that waits, for its model. */
  loop: Pick<SessionView, "modelFamily" | "model" | "effort">;
  /** "Question", "2 questions", "Plan", "Permission"; null when the wait does not say. */
  kind: string | null;
  /** The wait's own words: a permission's tool call, or a question's text; null when there are none. */
  text: string | null;
  /** The ask an answer reaches now (states.ts openAsk); a session's other asks are queued behind it. */
  current: boolean;
}

const KIND_WORD: Record<AskKind, string> = { question: "Question", plan: "Plan", permission: "Permission" };

/** "Queued" for an ask behind its session's current one (an answer cannot reach it yet); null for the current one. */
export const queuedWord = (item: Pick<QueueItem, "current">): string | null => (item.current ? null : "Queued");

/**
 * The session's wait note when it is this item's own words: the main loop's current ask or its wait with no ask, and a
 * permission's tool call, or a question's text that is not a tool call (Codex sends the question itself). A question tool's
 * or a plan's call says nothing the answer controls do not.
 */
function noteOf(s: SessionView, ask: AskSummary | null, current: boolean): string | null {
  const note = s.waitNote?.trim();
  if (!note || !current || ask?.agentId) return null;
  // The wait and the ask (when there is one) must be of one kind.
  if (s.waitReason === "permission" && (!ask || ask.kind === "permission")) return isQuestionTool(toolOfNote(note, "permission")) ? null : note;
  if (s.waitReason === "input" && (!ask || ask.kind === "question")) return toolOfNote(note, "input") === null ? note : null;
  return null;
}

/**
 * Every open ask of each session that needs you, and each such session with no ask open: sessions in the one order the
 * needs-you button and the answer drawer step in (byWait), and in each session its current ask first, then the queued ones,
 * oldest first.
 */
export function queueItems(sessions: readonly SessionView[]): QueueItem[] {
  const out: QueueItem[] = [];
  for (const s of [...sessions].filter((x) => needsYou(x)).sort(byWait)) {
    const open = s.asks.filter((ask) => ask.state !== "closed");
    if (open.length === 0) {
      const kind = s.waitReason === "input" ? KIND_WORD.question : s.waitReason === "permission" ? KIND_WORD.permission : null;
      out.push({ key: `wait:${s.id}`, s, ask: null, since: s.lastActivityAt, who: s.name, loop: s, kind, text: noteOf(s, null, true), current: true });
      continue;
    }
    const current = openAsk(s);
    const queued = open.filter((a) => a.id !== current?.id).sort((a, b) => a.openedAt - b.openedAt || (a.id < b.id ? -1 : 1));
    for (const ask of current ? [current, ...queued] : queued) {
      const agent = ask.agentId ? s.agents.find((a) => a.id === ask.agentId) : undefined;
      const isCurrent = ask.id === current?.id;
      const kind = ask.kind === "question" && ask.count > 1 ? `${ask.count} questions` : KIND_WORD[ask.kind];
      out.push({ key: `${s.id}:${ask.id}`, s, ask, since: ask.openedAt, who: loopName(s, ask.agentId), loop: agent ?? s, kind, text: noteOf(s, ask, isCurrent), current: isCurrent });
    }
  }
  return out;
}

/**
 * One problem: a session failed or stuck, an agent stuck (the server derives it for a session or an agent, and both alert), or a
 * file two loops edited. Auto-compacts are never one: a long session compacts as it runs. A failed agent is not one: it has
 * ended, and its square and its own detail say it.
 */
export type Problem =
  | { key: string; type: "session"; s: SessionView }
  | { key: string; type: "agent"; s: SessionView; a: AgentView }
  | { key: string; type: "collision"; s: SessionView; c: CollisionView };

/** A session's problem rank: failed, then stuck; null for none. */
function rank(s: SessionView): number | null {
  const state = stateOf(s);
  if (state === "failed") return 0;
  return state === "stuck" ? 1 : null;
}

/**
 * Failed sessions, then stuck sessions and stuck agents ("session › agent"), each by name; then shared files, one per file
 * and pair.
 */
export function problemItems(sessions: readonly SessionView[]): Problem[] {
  const troubled: { p: Problem; r: number; name: string }[] = [];
  for (const s of sessions) {
    const r = rank(s);
    if (r !== null) troubled.push({ p: { key: `s:${s.id}`, type: "session", s }, r, name: s.name });
    for (const a of s.agents) if (a.stuck) troubled.push({ p: { key: `a:${s.id}:${a.id}`, type: "agent", s, a }, r: 1, name: loopName(s, a.id) });
  }
  troubled.sort((x, y) => x.r - y.r || x.name.localeCompare(y.name));
  const files = new Map<string, Problem>();
  for (const s of sessions) {
    for (const c of s.collisions) {
      const key = `c:${c.path}\u0000${[s.id, c.sessionId].sort().join("\u0000")}`;
      if (!files.has(key)) files.set(key, { key, type: "collision", s, c });
    }
  }
  return [...troubled.map((t) => t.p), ...files.values()];
}

/** The worst of the problems, for a heading's mark: a failed session, else anything stuck; a shared file alone has no state. */
export function worstProblem(problems: readonly Problem[]): "failed" | "stuck" | null {
  if (problems.some((p) => p.type === "session" && stateOf(p.s) === "failed")) return "failed";
  return problems.some((p) => p.type !== "collision") ? "stuck" : null;
}

const fileName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** A problem in the words Problems and the wall view say it in. */
export interface ProblemWords {
  /** The loop it is about: the session, or "session › agent" for a stuck agent. */
  name: string;
  /** Its page: the session's, opened on the agent for a stuck agent. */
  href: string;
  /** The state its mark shows and its fact is coloured by; null for a shared file, marked by the collision diamond. */
  state: State | null;
  /** The state with its fact ("Failed · Bash · 3 in a row", "Stuck 6m · tool open"); null for a shared file. */
  fact: string | null;
  /** A shared file: its name and path, and the other loop that edited it, with that loop's page while its session is live. */
  file: { name: string; path: string; by: string; byHref: string | null } | null;
}

export function problemWords(p: Problem, now: number, sessions: Readonly<Record<string, SessionView>>): ProblemWords {
  const { s } = p;
  if (p.type === "collision") {
    const { c } = p;
    const other = c.sessionId === s.id ? null : sessions[c.sessionId];
    const by = other && c.agentId !== null ? `${other.name} › ${c.name}` : (other?.name ?? c.name);
    return { name: s.name, href: hashFor("session", s.id), state: null, fact: null, file: { name: fileName(c.path), path: c.path, by, byHref: other ? hashFor("session", other.id) : null } };
  }
  if (p.type === "agent") {
    const { a } = p;
    return { name: loopName(s, a.id), href: hashFor("session", s.id, a.id), state: "stuck", fact: dotsText([agentWords(a, "stuck", now).word, a.toolOpen ? "tool open" : null]), file: null };
  }
  return { name: s.name, href: hashFor("session", s.id), state: stateOf(s), fact: stateLine(s, now), file: null };
}
