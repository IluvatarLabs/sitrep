// The state a session shows everywhere: one word, one mark (ui/Station) and one colour per state, and the line
// that says it with its fact. Pure.
import { MAIN_LOOP } from "../../../server/src/fleet/protocol";
import { fmtAge, plural } from "./format";
import { isHeadlessSurface } from "./provider";
import type { AgentView, AskKind, AskSummary, ErroredState, SessionView } from "./types";
import { dotsText } from "./ui/Dots";
import { backgroundFact, idleOnBackground, isQuestionTool, toolOfNote } from "./waiting";

export type State = "working" | "needs-you" | "idle" | "stuck" | "failed" | "done";

/** One word per state, in the state bar's order. */
export const STATE_WORD: Readonly<Record<State, string>> = {
  "needs-you": "Needs you",
  working: "Working",
  idle: "Idle",
  stuck: "Stuck",
  failed: "Failed",
  done: "Done",
};

type StateInput = Pick<SessionView, "status" | "waitReason" | "background" | "asks" | "errored" | "stuck" | "hostSurface" | "respond">;

/** The ask a session's line and its answer button are about: the newest open one, the main loop's before an agent's. */
export function openAsk({ asks }: Pick<SessionView, "asks">): AskSummary | null {
  let main: AskSummary | null = null;
  let any: AskSummary | null = null;
  for (const a of asks) {
    if (a.state === "closed") continue;
    if (!any || a.openedAt > any.openedAt) any = a;
    if (a.agentId === null && (!main || a.openedAt > main.openedAt)) main = a;
  }
  return main ?? any;
}

/**
 * A live (not done) session holding an ask that is not closed. It wants its owner whatever its status: a Codex async question
 * arrives while the turn keeps running (as Codex's TUI shows a question while "Working").
 */
export const liveOpenAsk = (s: Pick<SessionView, "status" | "asks">): boolean => s.status !== "done" && s.asks.some((a) => a.state !== "closed");

/**
 * A run nobody can answer or attach to: `claude -p` and the SDK, `codex exec`. Its surface says so (provider isHeadlessSurface:
 * `headless`, `codex_exec`), or its respond limits do (`not-interactive`), which is how a reporter with no surface or an older
 * one says it (codex-reporter 0.2.0 sends Codex's `source`, `exec` for `codex exec`). Only a `claude --bg` job (`background`)
 * is never headless by its limits: when nobody is attached to it, it counts as detached.
 */
export function isHeadless(s: Pick<SessionView, "hostSurface" | "respond">): boolean {
  const surface = s.hostSurface?.trim() ?? "";
  return isHeadlessSurface(surface) || (surface !== "background" && s.respond?.limits.includes("not-interactive") === true);
}

/**
 * The session wants its owner: a question, a permission or a plan, or an open ask. An idle turn does not, nor a headless
 * run (isHeadless), which nobody can answer.
 */
export function needsYou(s: Pick<SessionView, "status" | "waitReason" | "background" | "asks" | "hostSurface" | "respond">): boolean {
  if (isHeadless(s)) return false;
  return liveOpenAsk(s) || (s.status === "waiting" && s.waitReason !== "idle" && !idleOnBackground(s));
}

/** The state shown. Needing the owner comes before failing, so every count of "needs you" is one rule (needsYou). */
export function stateOf(s: StateInput): State {
  if (s.status === "done") return "done";
  if (needsYou(s)) return "needs-you";
  if (s.errored) return "failed";
  if (s.stuck) return "stuck";
  return s.status === "waiting" && s.waitReason === "idle" ? "idle" : "working";
}

/**
 * The rows that wait on agents they launched, keyed by agent id (MAIN_LOOP for the main loop): a running row with running
 * children. Display only: a foreground launch and a background one look the same, so any running child counts. A child whose
 * listed parent is not running makes no row wait; while the session itself is not running, nothing does.
 */
export function waitingOnByRow({ status, agents }: Pick<SessionView, "status" | "agents">): Map<string, AgentView[]> {
  const rows = new Map<string, AgentView[]>();
  if (status !== "running") return rows;
  const listed = new Map(agents.map((a) => [a.id, a] as const));
  for (const child of agents) {
    if (child.status !== "running") continue;
    const parent = child.parentId !== null && child.parentId !== child.id ? listed.get(child.parentId) : undefined;
    if (parent && parent.status !== "running") continue;
    const row = parent?.id ?? MAIN_LOOP;
    rows.set(row, [...(rows.get(row) ?? []), child]);
  }
  return rows;
}

/** The main loop's running children: the agents a "2 agents working" line counts. */
const delegatesOf = (s: Pick<SessionView, "status" | "agents">): AgentView[] => waitingOnByRow(s).get(MAIN_LOOP) ?? [];

const NEED_WORD: Record<AskKind, string> = { question: "Question", plan: "Plan", permission: "Permission" };

/**
 * What the session needs, in the harnesses' words: the open ask's kind, else its wait's. The wait note joins it when it is that
 * wait's own words: a permission's tool call, or a question's text that is not a tool call (Codex sends the question itself).
 */
function needParts(s: Pick<SessionView, "asks" | "waitReason" | "waitNote">): (string | null)[] {
  const note = s.waitNote?.trim() || null;
  const tool = note === null ? null : toolOfNote(note, s.waitReason);
  const waited: AskKind | null = s.waitReason === "input" || isQuestionTool(tool) ? "question" : s.waitReason === "permission" ? "permission" : null;
  const kind = openAsk(s)?.kind ?? waited;
  if (kind === null) return [STATE_WORD["needs-you"]];
  const own = kind === waited && (kind === "permission" || tool === null);
  return [NEED_WORD[kind], own ? note : null];
}

/**
 * Why a session failed: the model API's own name for the error; or the tool that failed (the server's `detail`,
 * else "tool error") and, from the second, how many calls failed in a row (`toolFailures`).
 */
function failure(e: ErroredState | null, toolFailures: number | null): (string | null)[] {
  if (!e) return [];
  if (e.cause === "api") return [e.detail?.replace(/_/g, " ") ?? "API error"];
  return [e.detail ?? "tool error", toolFailures !== null && toolFailures >= 2 ? `${toolFailures} in a row` : null];
}

/**
 * The state with its facts, as a row's second line says it: "2 agents working", "1 agent working · 1 stuck", "Working · 1
 * agent stuck", "Working · 1 background shell (nightly
 * build)", "Question · <text>", "Permission · Bash(npm test)", "Idle 12m", "Stuck 6m · tool open", "Failed · Bash · 3
 * in a row", "Done".
 */
export function stateLine(s: SessionView, now: number): string {
  const state = stateOf(s);
  const word = STATE_WORD[state];
  const since = (t: number | null) => (t === null ? word : `${word} ${fmtAge((now - t) / 1000)}`);
  switch (state) {
    case "working": {
      // A stuck agent runs (its status) but is not working: it is counted apart, as the card's counts and Problems say it.
      const delegates = delegatesOf(s);
      const stuck = delegates.filter((a) => a.stuck).length;
      const working = delegates.length - stuck;
      if (working > 0) return dotsText([`${plural(working, "agent")} working`, stuck > 0 ? `${stuck} stuck` : null]);
      if (stuck > 0) return dotsText([word, `${plural(stuck, "agent")} stuck`]);
      return dotsText([word, idleOnBackground(s) ? backgroundFact(s.background) : null]);
    }
    case "needs-you":
      return dotsText(needParts(s));
    case "idle":
      return since(s.lastActivityAt);
    case "stuck":
      return dotsText([since(s.lastActivityAt), s.toolOpen ? "tool open" : null]);
    case "failed":
      return dotsText([word, ...failure(s.errored, s.toolFailures)]);
    case "done":
      return word;
  }
}

/** How many sessions are live: every state but done (stateOf). */
export const liveCount = (sessions: readonly Pick<SessionView, "status">[]): number => sessions.filter((s) => s.status !== "done").length;

// ---- the status kind respondGate (respond.ts, an answer path) uses ----------------------------------------------------------

/** What a session is doing by its status alone; `bg` while it works on background work with its turn ended. */
export type CardKind = SessionView["status"] | "bg";

export const cardKind = (s: Pick<SessionView, "status" | "waitReason" | "background">): CardKind => (idleOnBackground(s) ? "bg" : s.status);
