// The Fleet as Now arranges it: the sessions in view, background ones set aside unless the chip shows them, sorted
// and grouped, and counted by state for the state bar; and what a card and a List row say about a session besides its figures:
// what it is doing in one line (Details off), or with Details on, what it is doing, its plan step, and its notes and relations.
// Pure.
import { MAIN_LOOP } from "../../../../../server/src/fleet/protocol";
import { HOOKS_OFF_NOTE, versionNote } from "../../components/SessionCard";
import { fmtAge, plural } from "../../format";
import { groupSessions, type Group, type GroupBy } from "../../groups";
import { sortSessions, splitDetached, STATUS_FILTERS, type SortKey, type StatusFilter } from "../../logic";
import { liveCount, stateLine, stateOf, STATE_WORD, waitingOnByRow } from "../../states";
import type { SessionView } from "../../types";
import { dotsText } from "../../ui/Dots";
import { agentName } from "../map/layout";
import { planStep } from "../map/words";

export interface FleetShape {
  /** The sessions in view, background ones set aside unless shown, sorted. */
  shown: SessionView[];
  /** The shown sessions by Group by; empty for None. */
  groups: Group[];
}

export interface ShapeChoices {
  sort: SortKey;
  groupBy: GroupBy;
  /** Background sessions are shown. */
  background: boolean;
}

export function shapeFleet(inView: readonly SessionView[], now: number, choice: ShapeChoices, labels: ReadonlyMap<string, string>): FleetShape {
  const shown = sortSessions(splitDetached(inView, now, choice.background).shown, choice.sort);
  return { shown, groups: groupSessions(shown, choice.groupBy, labels) };
}

/**
 * The state bar's counts: the sessions by state and the live ones in all (an ended one, shown until it leaves, is not), background
 * ones set aside unless shown, as the Fleet would show them.
 */
export function stateCounts(list: readonly SessionView[], now: number, background: boolean): Record<StatusFilter, number> {
  const pool = splitDetached(list, now, background).shown;
  const counts = Object.fromEntries(Object.keys(STATUS_FILTERS).map((k) => [k, 0])) as Record<StatusFilter, number>;
  for (const s of pool) counts[stateOf(s)] += 1;
  counts.all = liveCount(pool);
  return counts;
}

/** A tool's name as words: the harness's identifier with its `_` and `.` as spaces ("view_image" reads "view image"). */
const toolWords = (tool: string | null | undefined): string | null => (tool ? tool.replace(/[_.]+/g, " ").trim() : null);

/**
 * What a session is doing in one line, as a card's third row and a List row's second line say it with Details off (the clean
 * rows): the state and its fact (states.ts stateLine) unless it is working, when its plan step ("Step 3/6 · text"), else what it
 * works on ("2 agents working"), else its last tool.
 */
export function doingLine(s: SessionView, now: number): string {
  const line = stateLine(s, now);
  if (stateOf(s) !== "working") return line;
  if (line !== STATE_WORD.working) return planStep(s) ?? line;
  return planStep(s) ?? dotsText([line, toolWords(s.loop?.lastTool)]);
}

/** What a session is doing, as a card's third row and a List row's second line say it with Details on. */
export interface Doing {
  /** Its state and fact (states.ts stateLine), with its last tool while it simply works: "2 agents working", "Working · Bash". */
  line: string;
  /** The agents it delegates to, by name, while it does ("survey adapters, write tests"): shown apart, so they give way first. */
  names: string | null;
  /** The whole of it, for the hover text: "2 agents working: survey adapters, write tests". */
  title: string;
}

export function doing(s: SessionView, now: number): Doing {
  const said = stateLine(s, now);
  const working = stateOf(s) === "working";
  const line = working && said === STATE_WORD.working ? dotsText([said, toolWords(s.loop?.lastTool)]) : said;
  // The agents a "2 agents working" line counts: the main loop's running children.
  const delegates = working ? (waitingOnByRow(s).get(MAIN_LOOP) ?? []) : [];
  const names = delegates.length > 0 ? delegates.map(agentName).join(", ") : null;
  return { line, names, title: names === null ? line : `${line}: ${names}` };
}

/** A plan step as a card and a List row show it, in every state. */
export interface Step {
  text: string;
  /** No step is in progress, so this is the first pending one, inferred: shown muted. */
  inferred: boolean;
  title: string;
}

/** "Step 3/6 · text" while a step is in progress; else the first pending step as "Next: text", inferred; null with neither. */
export function stepOf(s: Pick<SessionView, "plan">): Step | null {
  const active = planStep(s);
  if (active !== null) return { text: active, inferred: false, title: active };
  const next = s.plan?.steps.find((x) => x.state === "pending");
  return next ? { text: `Next: ${next.text}`, inferred: true, title: `Next: ${next.text} (inferred: the first pending step)` } : null;
}

/** One short fact a card and a List row carry besides the state. */
export interface Fact {
  key: string;
  text: string;
  title?: string;
}

/**
 * What a session carries besides its state, as short facts: nobody attached and when it is set aside, Codex hooks not active,
 * a reporter outside the server's range (SessionCard versionNote, the session page's words), then its messages, shared files
 * and the main loop's tool calls when there are any. Unknowns (attached or hooks not reported) say nothing.
 */
export function sessionFacts(s: SessionView, now: number): Fact[] {
  const facts: Fact[] = [];
  if (s.attached === false) {
    facts.push({ key: "detached", text: "Nobody attached" });
    if (s.hideAt !== null && s.hideAt > now) facts.push({ key: "hide", text: `set aside in ${fmtAge((s.hideAt - now) / 1000)}`, title: "Then it shows only with Background" });
  }
  if (s.hooksActive === false) facts.push({ key: "hooks", text: "Hooks not active", title: HOOKS_OFF_NOTE });
  const reporter = versionNote(s);
  if (reporter) facts.push({ key: "reporter", text: `Reporter ${reporter.label}`, title: reporter.text });
  const messages = s.messages.length;
  if (messages > 0) facts.push({ key: "messages", text: plural(messages, "message"), title: "Between its loops in the last 30 minutes" });
  const files = new Set(s.collisions.map((c) => c.path)).size;
  if (files > 0) facts.push({ key: "files", text: plural(files, "shared file"), title: "Also edited by another loop within 5 minutes" });
  const calls = s.loop?.toolCalls ?? 0;
  if (calls > 0) facts.push({ key: "tools", text: plural(calls, "tool call"), title: s.loop?.lastTool ? `The main loop's; last ${toolWords(s.loop.lastTool)}` : "The main loop's" });
  return facts;
}
