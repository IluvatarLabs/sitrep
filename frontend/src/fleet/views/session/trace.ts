// The delegation trace behind the session page's Timeline, worked out from one session and its events. Pure: no React.
// Rows are the main loop, then its agents in the agent tree's order (launch order, or the chosen sort among siblings). Each
// row is a line on one shared time axis from its start to its end (or now). Marks sit on the lines where something
// happened: an ask, a wait on the owner, a failure, an auto-compact, a message between loops, a file two loops edited.
// The drawing pans and zooms over one plain time scale; `axisTicks` labels whatever span is in view.
import { agentElapsedSec, agentOrder, buildTree, familyName, ORCHESTRATOR_ROW, type AgentSortKey, type TreeRow } from "../../logic";
import { readableEvent } from "../../eventText";
import { fmtClock, fmtDay, fmtTok, plural } from "../../format";
import { stateOf, waitingOnByRow } from "../../states";
import type { ActivityView, AgentView, AskKind, BlowoutLogEntry, SessionView } from "../../types";
import { stationWord, type StationKind } from "../../ui/Station";
import { parseWaitEvent } from "../../waiting";

export interface TraceRow {
  /** ORCHESTRATOR_ROW for the main loop, else the agent's id. */
  id: string;
  agent: AgentView | null;
  /** 0 for the main loop, 1 for what it launched, and so on. */
  depth: number;
  /** The row this line branched from; null for the main loop. */
  parent: number | null;
  name: string;
  /** "main loop", "fork", or the agent's type. */
  kindText: string;
  model: string;
  station: StationKind;
  word: string;
  start: number;
  end: number;
  /** Still going: its end is now. */
  open: boolean;
  /** Drawn as a finished line (grey). */
  finished: boolean;
  queued: boolean;
}

/** The orders a parent's agents can be put in, by their labels. */
export const AGENT_SORT_LABELS: Record<AgentSortKey, string> = { model: "Model", effort: "Effort", ctx: "Context", tok: "Tokens", cost: "Est. cost", time: "Time", status: "Status" };

export type MarkKind = "ask" | "wait" | "fail" | "blow" | "message" | "file";

/** One thing that happened, in words. */
interface MarkItem {
  t: number;
  text: string;
}

export interface Mark {
  key: string;
  kind: MarkKind;
  /** The row the mark sits on, and for a message or a shared file the other row it joins, when it is in this trace. */
  row: number;
  to: number | null;
  /** When it happened; for an interchange that stands for several, the latest of them. */
  t: number;
  /** One line for the hover and the row's spoken label; for several interchanges, what joins the two rows and how many. */
  text: string;
  /**
   * What the mark stands for, oldest first. One item, except an interchange: every message, or every file both edited,
   * between the same two rows is one mark, so parallel joins never stack up into a barcode.
   */
  items: MarkItem[];
  /** An open ask: drawn held. */
  open?: boolean;
}

export interface Trace {
  rows: TraceRow[];
  marks: Mark[];
  t0: number;
  t1: number;
  live: boolean;
  /** How many agents "Hide done" takes off the drawing, counted whether or not it is on. */
  done: number;
}

const ASK_NOUN: Record<AskKind, string> = { question: "Question", permission: "Permission request", plan: "Plan approval" };

/** When the session's own line ends: its last report once it is done, now while it is live (or silent). */
function sessionEnd(s: SessionView, now: number): number {
  return s.status === "done" ? s.lastSeenAt : Math.max(now, s.lastSeenAt);
}

/**
 * An agent's mark: needs you while it asks, its own status once it is not running (queued, done, failed, stopped), stuck
 * unless agents it launched are working, else working.
 */
export function agentStationKind(a: AgentView, asking: boolean, delegating: boolean): StationKind {
  if (asking && (a.status === "running" || a.status === "queued")) return "needs-you";
  if (a.status !== "running") return a.status;
  return a.stuck && !delegating ? "stuck" : "working";
}

export function agentName(a: AgentView): string {
  return a.description || a.name || a.type;
}

export function agentKindText(a: AgentView): string {
  return a.kind === "fork" ? "fork" : a.type;
}

/**
 * The agents "Hide done" takes off the Timeline, by their place in `tree`: a done agent with nothing under it still running,
 * queued, failed or stopped, so a line left on the drawing never loses the line it branched from. In buildTree's order an
 * agent's descendants follow it, each deeper than it.
 */
function doneBranches(tree: readonly TreeRow[]): boolean[] {
  const gone = new Array<boolean>(tree.length);
  for (let i = tree.length - 1; i >= 0; i--) {
    let all = tree[i]!.agent.status === "done";
    for (let j = i + 1; all && j < tree.length && tree[j]!.guides.length > tree[i]!.guides.length; j++) all = gone[j]!;
    gone[i] = all;
  }
  return gone;
}

/** The rows: the main loop first, then the agent tree in its order, without its done branches when they are hidden. */
function traceRows(s: SessionView, now: number, sort: { key: AgentSortKey | null; dir: 1 | -1 }, hideDone: boolean): { rows: TraceRow[]; done: number } {
  const live = s.status !== "done";
  const end = sessionEnd(s, now);
  const asking = new Set(s.asks.filter((a) => a.state !== "closed" && a.agentId !== null).map((a) => a.agentId!));
  const delegating = waitingOnByRow(s);
  // The session's own state: an open ask of the main loop while its turn still runs (a Codex question) needs you too.
  const mainKind = stateOf(s);
  const rows: TraceRow[] = [
    {
      id: ORCHESTRATOR_ROW,
      agent: null,
      depth: 0,
      parent: null,
      name: s.name,
      kindText: "main loop",
      model: familyName(s.modelFamily, s.model),
      station: mainKind,
      word: stationWord(mainKind),
      start: s.startedAt,
      end,
      open: s.status !== "done",
      finished: s.status === "done",
      queued: false,
    },
  ];
  const tree = buildTree(s.agents, sort.key ? agentOrder(sort.key, sort.dir, now) : undefined);
  const gone = doneBranches(tree);
  const index = new Map<string, number>();
  for (const [i, { agent: a, guides }] of tree.entries()) {
    if (hideDone && gone[i]) continue;
    const station = agentStationKind(a, live && asking.has(a.id), delegating.has(a.id));
    const finished = a.status === "done" || a.status === "failed" || a.status === "aborted";
    const start = Math.min(a.startedAt, end);
    const parentRow = a.parentId && a.parentId !== a.id ? index.get(a.parentId) : undefined;
    index.set(a.id, rows.length);
    rows.push({
      id: a.id,
      agent: a,
      depth: guides.length,
      parent: parentRow ?? 0,
      name: agentName(a),
      kindText: agentKindText(a),
      model: familyName(a.modelFamily, a.model),
      station,
      word: stationWord(station),
      start,
      end: Math.max(start, Math.min(a.endedAt ?? end, end)),
      open: a.endedAt === null && s.status !== "done",
      finished,
      queued: a.status === "queued",
    });
  }
  return { rows, done: gone.filter(Boolean).length };
}

/** An auto-compact in words: the tokens before and after when the server saw them, and a request that overran the window. */
export function blowText(b: BlowoutLogEntry): string {
  const before = b.tokensBefore === null ? "" : ` at ${fmtTok(b.tokensBefore)} tokens`;
  const after = b.tokensAfter === null ? "" : `, to ${fmtTok(b.tokensAfter)}`;
  return `Auto-compacted${before}${after}${b.kind === "window-exceeded" ? " (the request overran the window)" : ""}`;
}

/** A collision note the server wrote: the file, and the other loop with its session. */
function collisionOf(e: ActivityView): { path: string; sessionId: string | null; agentId: string | null } | null {
  const d = e.data;
  if (e.kind !== "note" || !d || d.kind !== "collision" || typeof d.path !== "string") return null;
  return { path: d.path, sessionId: typeof d.sessionId === "string" ? d.sessionId : null, agentId: typeof d.agentId === "string" ? d.agentId : null };
}

/** A message event's recipient: its id (null for a main loop, undefined when the reporter could not tie it) and its name. */
function messageTo(e: ActivityView): { to: string | null | undefined; toName: string } {
  const d = e.data ?? {};
  const to = d.to === null ? null : typeof d.to === "string" ? d.to : undefined;
  return { to, toName: typeof d.toName === "string" && d.toName ? d.toName : "another agent" };
}

/** A message's text in words: an empty one is unknown (Codex can write a sub-agent message encrypted), never a blank quote. */
export function messageText(text: string): string {
  return text === "" ? "— (its text is not known)" : text;
}

/** Asks within this long of a wait event are the same wait, already marked from the ask. */
const SAME_WAIT_MS = 5000;

/** One message or one file both edited, before the interchanges between the same two rows are joined into one mark. */
interface Interchange {
  kind: "message" | "file";
  row: number;
  /** The other row, or null when the other end is not a loop of this session (a name no loop has, another session). */
  to: number | null;
  /** Groups the interchanges with no other row: the name a message was sent to, the session a file was shared with. */
  away: string;
  t: number;
  text: string;
  /** A shared file's path: the same file between the same two rows counts once. */
  path?: string;
}

function traceMarks(s: SessionView, rows: readonly TraceRow[], events: readonly ActivityView[]): Mark[] {
  const rowOf = new Map(rows.map((r, i) => [r.id, i]));
  // A loop's row: the main loop for no agent id; null for an agent that is not on this trace. A mark from or to such a loop
  // is left off the drawing (it would read as the main loop's) and stays only in the Events list.
  const at = (agentId: string | null | undefined): number | null => (agentId ? (rowOf.get(agentId) ?? null) : 0);
  const name = (row: number) => rows[row]!.name;
  const marks: Mark[] = [];
  const one = (m: Omit<Mark, "items">) => marks.push({ ...m, items: [{ t: m.t, text: m.text }] });
  const interchanges: Interchange[] = [];

  for (const a of s.asks) {
    const row = at(a.agentId);
    if (row === null) continue;
    const state = a.state === "closed" ? " (closed)" : a.state === "pending" ? " (answer sent)" : a.state === "not-taken" ? " (not taken)" : "";
    one({ key: `ask:${a.id}`, kind: "ask", row, to: null, t: a.openedAt, text: `${ASK_NOUN[a.kind]} for you${state}`, open: a.state !== "closed" });
  }
  const seenMessages = new Set<string>();
  const addMessage = (from: string | null, to: string | null | undefined, toName: string, text: string, t: number) => {
    const key = `msg:${from ?? "main"}:${t}`;
    if (seenMessages.has(key)) return;
    seenMessages.add(key);
    const row = at(from);
    // `to` null is the main loop; a missing `to` could not be tied to a loop, so the mark joins nothing and names `toName` as given.
    const other = to === undefined ? null : at(to);
    // A loop not on the trace at either end, or a loop messaging itself, is not drawn.
    if (row === null || (to !== undefined && (other === null || other === row))) return;
    interchanges.push({ kind: "message", row, to: other, away: to === undefined ? toName : "", t, text: `${name(row)} to ${toName}: ${messageText(text)}` });
  };
  for (const m of s.messages ?? []) addMessage(m.from, m.to, m.toName, m.text, m.at);

  for (const e of events) {
    if (e.kind === "wait") {
      const wait = parseWaitEvent(e.text);
      const row = at(e.agentId);
      if (!wait || row === null || s.asks.some((a) => Math.abs(a.openedAt - e.t) <= SAME_WAIT_MS)) continue;
      one({ key: `wait:${e.id}`, kind: "wait", row, to: null, t: e.t, text: readableEvent(e)?.text ?? e.text });
    } else if (e.kind === "fail") {
      // An agent's failure is its line's failed end; the main loop's turn failures are marks on its line.
      if (e.agentId) continue;
      one({ key: `fail:${e.id}`, kind: "fail", row: 0, to: null, t: e.t, text: readableEvent(e)?.text ?? e.text });
    } else if (e.kind === "message") {
      const { to, toName } = messageTo(e);
      addMessage(e.agentId, to, toName, e.text, e.t);
    } else if (e.kind === "note") {
      const c = collisionOf(e);
      const row = at(e.agentId);
      if (!c || row === null) continue;
      // The other loop: a row of this trace, or, in another session, nothing on this trace to join.
      const here = c.sessionId === s.id;
      const other = here ? at(c.agentId) : null;
      if (here && (other === null || other === row)) continue;
      interchanges.push({ kind: "file", row, to: other, away: here ? "" : (c.sessionId ?? "?"), t: e.t, text: `${e.text} (${c.path})`, path: c.path });
    }
  }
  for (const [i, b] of (s.blowouts?.log ?? []).entries()) {
    const row = at(b.agentId);
    if (row === null) continue;
    one({ key: `blow:${b.t}:${i}`, kind: "blow", row, to: null, t: b.t, text: blowText(b) });
  }

  // Every interchange of one kind between the same two rows is one mark, at the latest of them, with their count.
  const groups = new Map<string, Interchange[]>();
  for (const x of interchanges) {
    const ends = x.to === null ? `${x.row}:${x.away}` : `${Math.min(x.row, x.to)}-${Math.max(x.row, x.to)}`;
    const key = `${x.kind}:${ends}`;
    const list = groups.get(key) ?? [];
    // The same file between the same two rows counts once, at its latest note.
    const same = x.path === undefined ? -1 : list.findIndex((y) => y.path === x.path);
    if (same >= 0 && list[same]!.t >= x.t) continue;
    if (same >= 0) list.splice(same, 1);
    list.push(x);
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    list.sort((a, b) => a.t - b.t);
    const last = list[list.length - 1]!;
    const n = list.length;
    const between = last.to === null ? null : `${name(Math.min(last.row, last.to))} and ${name(Math.max(last.row, last.to))}`;
    let text: string;
    if (n === 1) text = last.kind === "message" ? `Message from ${last.text}` : last.text;
    else if (last.kind === "message") text = between ? `${plural(n, "message", "messages")} between ${between}` : `${plural(n, "message", "messages")} from ${name(last.row)} to ${last.away}, not tied to a loop of this session`;
    else text = between ? `${plural(n, "file", "files")} both edited by ${between}` : `${plural(n, "file", "files")} ${name(last.row)} edited that another session also edited`;
    marks.push({ key, kind: last.kind, row: last.row, to: last.to, t: last.t, text, items: list.map((x) => ({ t: x.t, text: x.text })) });
  }
  return marks.sort((a, b) => a.t - b.t);
}

export function buildTrace(s: SessionView, now: number, sort: { key: AgentSortKey | null; dir: 1 | -1 }, events: readonly ActivityView[], hideDone = false): Trace {
  const { rows, done } = traceRows(s, now, sort, hideDone);
  // A mark from or to a hidden agent is left off with its row, as for any loop not on the trace (traceMarks).
  const marks = traceMarks(s, rows, events);
  const t0 = Math.min(s.startedAt, ...rows.map((r) => r.start));
  // How short a span the view fits is the Timeline's own floor (MIN_SPAN), not the trace's.
  const t1 = Math.max(rows[0]!.end, ...rows.map((r) => r.end));
  return { rows, marks, t0, t1, live: s.status !== "done", done };
}

// ---- the axis ------------------------------------------------------------------------------------------------------

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
/**
 * The round steps an axis tick can take, finest first: from a second to a day, then past it for a session of weeks.
 */
const STEPS = [1000, 2000, 5000, 10_000, 15_000, 30_000, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, 60 * MINUTE, 120 * MINUTE, 360 * MINUTE, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY];
/** Ticks keep at least this far apart on screen. */
const TICK_MIN_PX = 80;

/** The finest round step whose ticks keep TICK_MIN_PX apart at `msPerPx`. */
function tickStep(msPerPx: number): number {
  const want = msPerPx * TICK_MIN_PX;
  return STEPS.find((st) => st >= want) ?? 28 * DAY;
}

/** A tick's label at its step: the date for whole days, HH:MM from a minute up, and the seconds too when zoomed in further. */
function tickLabel(t: number, step: number): string {
  if (step >= DAY) return fmtDay(t).slice(5);
  return step >= MINUTE ? fmtClock(t).slice(0, 5) : fmtClock(t);
}

/** The round clock times at `step` within [ta, tb], counted from local midnight so an hour tick reads :00 in every time zone. */
function roundTimes(ta: number, tb: number, step: number): number[] {
  // Steps past a day count from one fixed midnight, so their ticks stay put as the view pans across a day.
  const midnight = new Date(step > DAY ? 0 : ta);
  midnight.setHours(0, 0, 0, 0);
  const base = midnight.getTime();
  const times: number[] = [];
  if (step < DAY) {
    for (let t = base + Math.ceil((ta - base) / step) * step; t <= tb; t += step) times.push(t);
    return times;
  }
  // Whole days step by the calendar, so a tick stays on midnight across a clock change (a day of 23 or 25 hours). The first
  // jump comes within a step of `ta` by the clock; the calendar takes it from there.
  const days = step / DAY;
  midnight.setDate(midnight.getDate() + days * Math.max(0, Math.floor((ta - base) / step) - 1));
  for (; midnight.getTime() <= tb; midnight.setDate(midnight.getDate() + days)) if (midnight.getTime() >= ta) times.push(midnight.getTime());
  return times;
}

/** A tick on the axis: its time and its label. */
interface AxisTick {
  t: number;
  label: string;
}

/** The ticks for the time shown between `from` and `to` on an axis `width` pixels wide: they follow the zoom. */
export function axisTicks(from: number, to: number, width: number): AxisTick[] {
  if (!(width > 0) || !(to > from)) return [];
  const step = tickStep((to - from) / width);
  return roundTimes(from, to, step).map((t) => ({ t, label: tickLabel(t, step) }));
}

// ---- words for the event list ---------------------------------------------------------------------------------------

/** One stored event in plain words: a message, else the activity's own reading (eventText.ts), else its text as stored. */
export function eventWords(e: ActivityView): string {
  if (e.kind === "message") {
    const { toName } = messageTo(e);
    return `Message to ${toName}: ${messageText(e.text)}`;
  }
  return readableEvent(e)?.text ?? e.text;
}

/** How long a row's line runs, for its label. */
export function rowSeconds(r: TraceRow, now: number): number {
  if (r.agent) return agentElapsedSec(r.agent, now);
  return Math.max(0, (r.end - r.start) / 1000);
}
