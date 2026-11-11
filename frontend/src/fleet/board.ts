// The kanban board: the plan steps of every session dealt into five columns by state, plus a Review card for a session that
// asks its person something. No React here: the page renders what these functions return. A session without open steps is
// not on the board.
import { isQuestionTool, toolOfNote } from "./waiting";
import { needsYou } from "./states";
import type { PlanStep, SessionView } from "./types";

/** The columns in board order: each one's heading and what it says while empty. */
export const BOARD_COLUMNS: readonly { key: BoardColumn; label: string; empty: string }[] = [
  { key: "pending", label: "Pending", empty: "Nothing waiting. Every step has started or finished." },
  { key: "active", label: "In progress", empty: "Nothing in progress. Sessions are idle or between steps." },
  { key: "review", label: "Review", empty: "Nothing waiting on a person right now." },
  { key: "blocked", label: "Blocked", empty: "No blocked steps. A step is marked blocked when the session cannot proceed." },
  { key: "done", label: "Done", empty: "Nothing done yet." },
];

export const EMPTY_COLUMN = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, c.empty])) as Record<BoardColumn, string>;

/** A column is a step state, except Review, which is a step in progress whose session waits on its person. */
export type BoardColumn = PlanStep["state"] | "review";

/** The headline of a Review card and, when the wait names one, the question or the tool behind it. */
interface WaitWhy {
  lead: string;
  detail: string | null;
}

export interface BoardCard {
  session: SessionView;
  step: PlanStep;
  column: BoardColumn;
  /** `<session id>:<step id>`, unchanged as the step moves, so the page can tell a card moved columns. */
  key: string;
  /** Set on Review cards. */
  why?: WaitWhy;
  /** The session's own Review card, made because it asks something while none of its steps is in progress. */
  waiting?: boolean;
}

/** One column page holds this many cards. */
export const CARDS_PER_PAGE = 25;

/**
 * The column a step belongs in. Only an in-progress step can move to Review, when its session needs its person by the one rule
 * the sidebar and the Fleet count by (states.ts needsYou), so an idle turn is no wait.
 */
function columnOf(s: SessionView, step: PlanStep): BoardColumn {
  if (step.state !== "active") return step.state;
  return needsYou(s) ? "review" : "active";
}

/** Notes are capped at this length on the wire; a note that reaches it may have been cut. */
const NOTE_CAP = 160;

/** The `"question": "…"` a question tool's note carries, unescaped; null without one or when the cut fell inside an escape. */
function questionIn(note: string): string | null {
  const field = /"question"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(note);
  if (!field) return null;
  try {
    return JSON.parse(`"${field[1]}"`) as string;
  } catch {
    return null;
  }
}

/** A wait's headline, as a Review card shows it: what the session waits on its person for. */
function waitLead(reason: SessionView["waitReason"], tool: string | null): string {
  const input = reason === "input" || isQuestionTool(tool);
  if (!input && reason !== "permission") return "Waiting on you";
  return `Waiting for your ${input ? "input" : "approval"}`;
}

/** The card's words for a wait: the headline, then the question asked, else the tool wanted, else the note when it came whole. */
function waitWhy(s: Pick<SessionView, "waitReason" | "waitNote">): WaitWhy {
  const raw = s.waitNote ?? "";
  const note = raw.trim();
  const tool = toolOfNote(note, s.waitReason);
  // A note cut at the cap would pass for the whole of it, so only a shorter one is quoted.
  const quoted = note !== "" && raw.length < NOTE_CAP ? note : null;
  return { lead: waitLead(s.waitReason, tool), detail: questionIn(note) ?? (tool ? `Tool: ${tool}` : quoted) };
}

/** A plan whose steps are all done, on a session that ended: its Done cards come off. */
function sessionFinished(s: SessionView): boolean {
  if (s.status !== "done") return false;
  const steps = s.plan?.steps ?? [];
  return steps.length > 0 && steps.every((x) => x.state === "done");
}

/** The board itself: each column's cards. */
export type BoardColumns = Record<BoardColumn, BoardCard[]>;

/**
 * Only sessions with open steps are on the board: one with no plan, an empty one or a finished one gets no card. Each column
 * holds the sessions' cards in the order the sessions come, each plan's in plan order, so a session's cards sit together.
 */
export function buildBoard(sessions: readonly SessionView[]): BoardColumns {
  const columns: BoardColumns = { pending: [], active: [], review: [], blocked: [], done: [] };
  for (const s of sessions) {
    const steps = s.plan && s.plan.steps.length > 0 && !sessionFinished(s) ? s.plan.steps : [];
    const why = needsYou(s) ? waitWhy(s) : undefined;
    const cards = steps.map((step): BoardCard => {
      const column = columnOf(s, step);
      return { key: `${s.id}:${step.id}`, session: s, step, column, ...(column === "review" ? { why } : {}) };
    });
    for (const card of cards) columns[card.column].push(card);
    // A waiting session with a plan none of whose steps went to Review gets a Review card of its own.
    const ownCard = why !== undefined && !cards.some((c) => c.column === "review") && steps.length > 0;
    if (ownCard) {
      const step: PlanStep = { id: "waiting", text: why.lead, state: "active", activeText: null, ownerAgentId: null, ownerLabel: null };
      columns.review.push({ key: `${s.id}:waiting`, session: s, step, column: "review", waiting: true, why });
    }
  }
  return columns;
}

/** What the plan tiles state: sessions with a plan on the board, their steps, and how many are done. */
export type PlanFigures = { orchestrators: number; steps: number; done: number };

/** The figures over the board's step cards; a session's own Review card is no step of its plan. */
export function planFigures(columns: BoardColumns): PlanFigures {
  const steps = Object.values(columns)
    .flat()
    .filter((card) => !card.waiting);
  return {
    orchestrators: new Set(steps.map((card) => card.session.id)).size,
    steps: steps.length,
    done: steps.filter((card) => card.column === "done").length,
  };
}
