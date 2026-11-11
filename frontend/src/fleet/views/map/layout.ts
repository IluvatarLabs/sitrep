// The line layout: one pure function from sessions to session blocks, line paths and interchange rings, in pixels (a List row
// opened draws one block; under Expand all, grouped by Machine, a machine's opened rows are one zone). It never measures the
// page or reads the clock, so the same data always draws the same lines.
//
// Rows. Machines are zones in name order; sessions sit in their zone in launch order, each in a block of its own, its first
// row its own line (its name and state as the session station's label); a session's agents take rows under that line in
// launch order, each after the agent that launched it, so a new session or agent only ever adds a row at the end of its
// block and a station's x comes from its own depth alone. A session whose agents are all folded is that one row. Finished
// and failed agents fold into "+N done · M failed" unless the session is expanded, or they wait on their person, or an agent
// still shown hangs under them.
//
// Lanes. Delegation runs down vertical lanes, assigned the way a commit graph assigns branch lanes: in the order the lanes
// open, each takes the first lane right of its launcher's that no other lane holds over its rows. A lane runs from its
// agent's row to its last child's row and no further, and there are as many lanes as the delegation needs. A lane can change
// when a later child extends it over another lane's rows; rows never do.
//
// Interchanges. A shared file or a message joins two stations with a ring on each, linked: one connector per station pair,
// interchanges of one kind between the same stations being one mark with a count. Between an agent and the loop that
// launched it the delegation lane already joins the two, so that pair's mark is one ring on the agent's own line. Rings take
// as many columns as the zone's interchanges need, between the delegation lanes and the station column, one ring diameter of
// space between neighbours.
//
// Columns. A machine zone's station column sits only as far right as the zone needs: past its last lane, and past its ring
// columns when it has interchanges; a zone with neither keeps a short line before each station. Every station in a zone
// keeps that one column, so names line up per machine; an agent's station steps right by its depth.
import { fmtClock, plural } from "../../format";
import { stateOf } from "../../states";
import type { AgentView, SessionView } from "../../types";
import type { StationKind } from "../../ui/Station";

/** Every length on the map, in px. */
export const MAP = {
  /** One row: a session's line, or one agent's branch. */
  pitch: 28,
  /** Where a row's line runs, from the row's top. */
  lineY: 14,
  /** Space under a zone's last row, and between two sessions' blocks in a zone. */
  foot: 8,
  gap: 8,
  /** Where a session's line starts in the layout's own coordinates. Every block is drawn `SHIFT_X` to the left of them, so
   * its line starts at `bareX`. */
  lineX: 252,
  /** The main loop's delegation lane, from lineX; the step between lanes. */
  lane0: 32,
  laneW: 22,
  /** The 45° piece at every junction. */
  chamfer: 10,
  /** The shortest line before a station (a zone with no lanes and no rings), and the room kept after the last lane's turn. */
  lead: 36,
  clear: 12,
  /** An agent's station steps right by `indent` per level, up to `indentCap` levels. */
  indent: 20,
  indentCap: 6,
  /** Interchange rings: their radius; the step between ring columns (a ring's outer width plus one diameter of space); the
   * nearest column's distance from the station column. */
  ringR: 6,
  ringStep: 26,
  ringGap: 24,
  /** From a station's centre to its label. */
  labelGap: 14,
  /** Where a drawn block starts its line. */
  bareX: 12,
} as const;

/** How far left of the layout's own coordinates every block is drawn: its line starts at bareX, not lineX. */
export const SHIFT_X = MAP.lineX - MAP.bareX;

export type ChangeKind = "file" | "message";
type Tone = "live" | "done";

interface MapPath {
  key: string;
  d: string;
  cls: string;
}

/** One interchange as one of its stations sees it. */
interface RowLink {
  key: string;
  kind: ChangeKind;
  /** How many shared files or messages the mark stands for. */
  count: number;
  /** One sentence from this station's side: "Shares a.ts with Survey adapters.", "3 messages with adapter-rewrite." */
  text: string;
  /** The whole interchange: the file paths, or the messages with their excerpts. */
  title: string;
}

export interface MapRow {
  key: string;
  session: SessionView;
  /** Null on the session's own row (its main loop). */
  agent: AgentView | null;
  /** The row's top and its line's y, from the top of its session's block. */
  top: number;
  y: number;
  /** The station's centre. */
  x: number;
  station: StationKind;
  /** This loop waits on its person. */
  asks: boolean;
  /** For an agent: the name of what launched it (the session's name for its main loop). Null on a session row. */
  launchedBy: string | null;
  /** 0 for the session's own row, 1 for an agent its main loop launched, and so on. */
  depth: number;
  /** The interchanges at this station. */
  links: RowLink[];
}

export interface MapChange {
  key: string;
  kind: ChangeKind;
  x: number;
  /** The rings' centres, top to bottom, and the rows they sit on (one ring, on the agent's line, between an agent and its
   * launcher). */
  ys: number[];
  ends: string[];
  /** How many shared files or messages it stands for; shown on the mark from 2. */
  count: number;
  /** What hovering it says, and its accessible name: the files, or the messages' excerpts. */
  title: string;
}

export interface MapSession {
  session: SessionView;
  /** The session's own row first, then its agents' rows in launch order. */
  rows: MapRow[];
  /** Agents that finished (done or stopped) and agents that failed, in all; and how many of each are folded away now. */
  finished: number;
  failed: number;
  folded: number;
  foldedFailed: number;
  expanded: boolean;
  /** Agents running now. */
  working: number;
  /** The block's top in its zone, and its height. */
  top: number;
  height: number;
  /** Drawn in this order: lines, then lanes and junctions (a lane crossing a line passes over it). */
  under: MapPath[];
  over: MapPath[];
  /** The interchanges whose rings all sit in this block, in the block's coordinates. */
  changes: MapChange[];
}

export interface MapZone {
  /** The machine's id. */
  id: string;
  label: string;
  os: string | null;
  /** The drawing's height, under the zone's header. */
  height: number;
  sessions: MapSession[];
  /** The interchanges that join rows of two blocks (a file two sessions share), in the zone's coordinates. */
  changes: MapChange[];
}

export interface MapLayout {
  zones: MapZone[];
}

// ---- names --------------------------------------------------------------------------------------------------------------

/** An agent's name on the map: its task, else its name, else its type. */
export function agentName(a: AgentView): string {
  return a.description.trim() || a.name?.trim() || a.type.trim() || "agent";
}

/** The last part of a path. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// ---- one session ----------------------------------------------------------------------------------------------------------

interface Placed {
  agent: AgentView;
  index: number;
  parent: AgentView | null;
  depth: number;
}

const byLaunch = (a: AgentView, b: AgentView) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The agents in launch order, each placed after the agent that launched it (so a lane always runs down). An agent whose
 * launcher is not listed, or is itself, counts as the main loop's, as the agent tree does.
 */
function launchOrder(agents: readonly AgentView[]): Placed[] {
  const listed = new Set(agents.map(({ id }) => id));
  const launcher = (a: AgentView) => (a.parentId && a.parentId !== a.id && listed.has(a.parentId) ? a.parentId : null);
  const sorted = [...agents].sort(byLaunch);
  const out: Placed[] = [];
  const placed = new Map<string, Placed>();
  const held = new Map<string, AgentView[]>();
  const place = (a: AgentView, parent: Placed | null) => {
    if (placed.has(a.id)) return;
    const p: Placed = { agent: a, index: out.length, parent: parent?.agent ?? null, depth: parent ? parent.depth + 1 : 1 };
    out.push(p);
    placed.set(a.id, p);
    const waiting = held.get(a.id);
    held.delete(a.id);
    for (const child of waiting ?? []) place(child, p);
  };
  for (const a of sorted) {
    const from = launcher(a);
    const parent = from === null ? null : placed.get(from);
    if (from === null) place(a, null);
    else if (parent) place(a, parent);
    else held.set(from, [...(held.get(from) ?? []), a]);
  }
  // Agents whose launcher never got a place are in a parent cycle: they start at the main loop, in launch order.
  for (const a of sorted) place(a, null);
  return out;
}

/**
 * Each launching agent's lane (the main loop's is 0), over the rows drawn (`rows` in drawing order, each after its
 * launcher). In the order lanes open (an agent's first drawn child), each takes the first lane right of its launcher's that
 * no lane placed before it holds over its rows; a lane is held from its agent's row to its last drawn child's row.
 */
function lanesOf(rows: readonly Placed[]): Map<string, number> {
  const at = new Map(rows.map((p, i) => [p.agent.id, i + 1] as const));
  const children = new Map<string, number[]>();
  for (const p of rows) if (p.parent) children.set(p.parent.id, [...(children.get(p.parent.id) ?? []), at.get(p.agent.id) ?? 0]);
  const spans = rows
    .filter((p) => children.has(p.agent.id))
    .map((p) => {
      const kids = children.get(p.agent.id) ?? [];
      const start = at.get(p.agent.id) ?? 0;
      return { p, start, end: kids[kids.length - 1] ?? start, opened: kids[0] ?? start };
    })
    .sort((a, b) => a.opened - b.opened || a.start - b.start);
  const lane = new Map<string, number>();
  const held: { lane: number; start: number; end: number }[] = [];
  for (const span of spans) {
    let l = (span.p.parent ? (lane.get(span.p.parent.id) ?? 0) : 0) + 1;
    while (held.some((h) => h.lane === l && h.start <= span.end && span.start <= h.end)) l += 1;
    lane.set(span.p.agent.id, l);
    held.push({ lane: l, start: span.start, end: span.end });
  }
  return lane;
}

const laneX = (l: number) => MAP.lineX + MAP.lane0 + MAP.laneW * l;
/** Ended without failing (done or stopped). */
const finished = (a: AgentView) => a.status === "done" || a.status === "aborted";
/** Ended in any way, failed included: the agents that fold. */
const ended = (a: AgentView) => finished(a) || a.status === "failed";
/** Stations whose line is drawn live: a loop at work, one that needs you, one stuck at work. */
const LIVE_STATIONS: ReadonlySet<StationKind> = new Set<StationKind>(["working", "running", "needs-you", "stuck"]);

/** The loops of a session that hold an open ask, by agent id; `main` when the main loop asks or the asking agent is not listed. */
function askers(s: SessionView): { main: boolean; agents: Set<string> } {
  const live = s.status !== "done";
  const ids = new Set(s.agents.map((a) => a.id));
  const out = { main: false, agents: new Set<string>() };
  if (!live) return out;
  for (const ask of s.asks) {
    if (ask.state === "closed") continue;
    if (ask.agentId !== null && ids.has(ask.agentId)) out.agents.add(ask.agentId);
    else out.main = true;
  }
  return out;
}

/** A session's station: its state (states.ts stateOf), needing you while its main loop holds an open ask. */
function sessionStation(s: SessionView, mainAsks: boolean): StationKind {
  const state = stateOf(s);
  return mainAsks && state !== "done" ? "needs-you" : state;
}

/** An agent's station: needing you while it holds an open ask, stuck while it runs stuck, else its status. */
export function agentStation(a: AgentView, asks: boolean): StationKind {
  if (asks) return "needs-you";
  if (a.status === "running" && a.stuck) return "stuck";
  return a.status;
}

interface Block {
  ms: MapSession;
  over: (MapPath & { tone: Tone })[];
  /** Each agent row's launcher row, by row key. */
  launcherOf: Map<string, string>;
  /** The rightmost lane it uses (0: only the main loop's). */
  maxLane: number;
}

/** One session's block in its own coordinates (top 0, its own row first), with its session station at `stationX`. */
function sessionBlock(s: SessionView, expanded: boolean, stationX: number): Block {
  const asking = askers(s);
  const order = launchOrder(s.agents);

  // Shown: everything when expanded; else every agent that has not ended, asks, or has a shown agent under it. Children
  // come after their launcher, so walking back sees every child before its launcher.
  const shown = new Set<string>();
  const launchesShown = new Set<string>();
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const { agent, parent } = order[i]!;
    if (expanded || !ended(agent) || asking.agents.has(agent.id) || launchesShown.has(agent.id)) {
      shown.add(agent.id);
      if (parent) launchesShown.add(parent.id);
    }
  }
  const drawn = order.filter((p) => shown.has(p.agent.id));
  const lanes = lanesOf(drawn);

  const station = sessionStation(s, asking.main);
  const trunk: MapRow = {
    key: s.id,
    session: s,
    agent: null,
    top: 0,
    y: MAP.lineY,
    x: stationX,
    station,
    asks: station === "needs-you",
    launchedBy: null,
    depth: 0,
    links: [],
  };
  const trunkTone: Tone = LIVE_STATIONS.has(station) ? "live" : "done";
  const under: MapPath[] = [
    { key: `${s.id}:line`, d: `M${MAP.lineX} ${trunk.y}H${trunk.x - 7}`, cls: `ml ml-trunk ml-${trunkTone}` },
  ];
  const over: Block["over"] = [];
  const rows: MapRow[] = [trunk];
  const rowOf = new Map<string, MapRow>();
  const parentOf = new Map<string, string>();
  const C = MAP.chamfer;

  for (const p of drawn) {
    const a = p.agent;
    const rowTop = rows.length * MAP.pitch;
    const st = agentStation(a, asking.agents.has(a.id));
    const row: MapRow = {
      key: `${s.id}/${a.id}`,
      session: s,
      agent: a,
      top: rowTop,
      y: rowTop + MAP.lineY,
      x: stationX + MAP.indent * Math.min(p.depth, MAP.indentCap),
      station: st,
      asks: st === "needs-you",
      launchedBy: p.parent ? agentName(p.parent) : s.name,
      depth: p.depth,
      links: [],
    };
    rows.push(row);
    rowOf.set(a.id, row);

    // From the launcher's line: a 45° fork into its lane, down the lane, a 45° turn out, then this agent's own line.
    const from = (p.parent ? rowOf.get(p.parent.id) : trunk) ?? trunk;
    parentOf.set(row.key, from.key);
    const lane = p.parent ? (lanes.get(p.parent.id) ?? 1) : 0;
    const lx = laneX(lane);
    const tone: Tone = LIVE_STATIONS.has(st) ? "live" : "done";
    over.push({ key: `${row.key}:lane`, d: `M${lx - C} ${from.y}L${lx} ${from.y + C}V${row.y - C}L${lx + C} ${row.y}`, cls: `ml ml-lane ml-${tone}`, tone });
    const own = `M${lx + C} ${row.y}H${row.x - 7}`;
    under.push({ key: `${row.key}:line`, d: own, cls: `ml ml-${a.kind} ml-${tone}` });
    if (a.kind === "fork") under.push({ key: `${row.key}:hollow`, d: own, cls: "ml-hollow" });
  }

  const hidden = s.agents.filter((a) => !shown.has(a.id));
  const ms: MapSession = {
    session: s,
    rows,
    finished: s.agents.filter(finished).length,
    failed: s.agents.filter((a) => a.status === "failed").length,
    folded: hidden.filter(finished).length,
    foldedFailed: hidden.filter((a) => a.status === "failed").length,
    expanded,
    // A stuck agent runs but is not working (the row's state words count it apart, states.ts stateLine).
    working: s.agents.filter((a) => a.status === "running" && !a.stuck).length,
    top: 0,
    height: rows.length * MAP.pitch,
    under,
    over: [],
    changes: [],
  };
  return { ms, over, launcherOf: parentOf, maxLane: Math.max(0, ...lanes.values()) };
}

// ---- interchanges ---------------------------------------------------------------------------------------------------------

/** A loop: a session's main loop (`agentId` null), one of its agents, or `undefined` for "one of its loops, not said which". */
interface Loop {
  sessionId: string;
  agentId: string | null | undefined;
  /** The name the server gave it, for an agent the session no longer lists. */
  name: string;
}

interface FileGroup {
  path: string;
  machineId: string;
  loops: Map<string, Loop>;
}

/**
 * Shared files, by machine and path, across every session the page holds (so a loop is named even when its session is
 * filtered out). Each session's collisions name the other loops; a session's own loop is named by the other session's list.
 * When no list names it (that session is gone), the session itself stands for the loop.
 */
function fileGroups(all: readonly SessionView[]): Map<string, FileGroup> {
  const groups = new Map<string, FileGroup>();
  const holders = new Map<string, Set<string>>();
  for (const s of all) {
    for (const c of s.collisions) {
      const key = `${s.machine.id}\u0000${c.path}`;
      const g = groups.get(key) ?? { path: c.path, machineId: s.machine.id, loops: new Map<string, Loop>() };
      g.loops.set(`${c.sessionId}\u0000${c.agentId ?? ""}`, { sessionId: c.sessionId, agentId: c.agentId, name: c.name });
      groups.set(key, g);
      holders.set(key, (holders.get(key) ?? new Set<string>()).add(s.id));
    }
  }
  for (const [key, g] of groups) {
    for (const h of holders.get(key) ?? []) {
      if (![...g.loops.values()].some((l) => l.sessionId === h)) g.loops.set(`${h}\u0000?`, { sessionId: h, agentId: undefined, name: "" });
    }
  }
  return groups;
}

/** A loop as an interchange names it, with its row in the zone when it is drawn. */
interface Endpoint {
  row: { key: string; y: number } | null;
  name: string;
}

/** A message's text on one line, cut to 160 characters; an empty text is one the harness did not let the reporter read. */
const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "— (the text is not reported)";
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
};

const listed = (names: readonly string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** One shared file, or the messages between one pair of loops, before interchanges between the same stations merge. */
interface Draft {
  key: string;
  kind: ChangeKind;
  ends: Endpoint[];
  count: number;
  /** For a file, its path; for messages, their title. */
  path: string | null;
  title: string;
}

interface Merged {
  key: string;
  kind: ChangeKind;
  ends: Endpoint[];
  count: number;
  title: string;
  /** The drawn rows, top to bottom, by key and zone y: each says the interchange in its station's words. */
  rows: { key: string; y: number }[];
  /** The rows that carry a ring: the drawn rows, or the agent's own row alone when the pair is an agent and its launcher. */
  rings: { key: string; y: number }[];
  /** One file's name when the mark stands for one file. */
  file: string | null;
}

/**
 * Interchanges of one kind whose drawn rings sit on the same rows become one, with a count; those with no ring drawn go. A
 * mark joining exactly an agent and the loop that launched it (`launcherOf`, by row key) keeps one ring, on the agent's row.
 */
function merge(drafts: readonly Draft[], launcherOf: ReadonlyMap<string, string>): Merged[] {
  const groups = new Map<string, Draft[]>();
  for (const d of drafts) {
    const keys = [...new Set(d.ends.flatMap((e) => (e.row ? [e.row.key] : [])))].sort();
    if (keys.length === 0) continue;
    const k = `${d.kind}\u0000${keys.join("\u0000")}`;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  return [...groups.values()].map((ds): Merged => {
    const first = ds[0]!;
    const ends = new Map<string, Endpoint>();
    for (const d of ds) for (const e of d.ends) ends.set(e.row ? `r:${e.row.key}` : `n:${e.name}`, e);
    const rows = [...new Map(ds.flatMap((d) => d.ends.flatMap((e) => (e.row ? [[e.row.key, e.row] as const] : [])))).values()].sort((a, b) => a.y - b.y);
    const [upper, lower] = rows;
    const rings = rows.length === 2 && upper && lower && launcherOf.get(lower.key) === upper.key ? [lower] : rows;
    const count = ds.reduce((n, d) => n + d.count, 0);
    let title: string;
    if (ds.length === 1) title = first.title;
    else if (first.kind === "file") title = [`${count} shared files, each edited by two loops within 5 minutes:`, ...ds.map((d) => `${d.path ?? ""} (${listed(d.ends.map((e) => e.name))})`)].join("\n");
    else title = ds.map((d) => d.title).join("\n\n");
    return { key: ds.map((d) => d.key).join("\u0001"), kind: first.kind, ends: [...ends.values()], count, title, rows, rings, file: ds.length === 1 && first.path ? baseName(first.path) : null };
  });
}

/** Column `k` of the ring columns: 0 nearest the zone's station column `base`, then leftwards. */
const ringX = (k: number, base: number) => base - MAP.ringGap - k * MAP.ringStep;

/** In order of their top ring, each interchange takes the first ring column, from the station leftwards, free over its span. */
function placeColumns(items: readonly Merged[]): (Merged & { k: number; top: number; bottom: number })[] {
  const sorted = items
    .map((m) => ({ ...m, top: m.rings[0]!.y, bottom: m.rings[m.rings.length - 1]!.y }))
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom || (a.key < b.key ? -1 : 1));
  const used: { k: number; top: number; bottom: number }[] = [];
  const reach = MAP.pitch / 2;
  return sorted.map((m) => {
    let k = 0;
    while (used.some((u) => u.k === k && u.top - reach < m.bottom && m.top < u.bottom + reach)) k += 1;
    used.push({ k, top: m.top, bottom: m.bottom });
    return { ...m, k };
  });
}

/** The sentence a station carries for an interchange, given the names of its other ends. */
function linkText(m: Merged, others: readonly string[]): string {
  const who = others.length ? listed(others) : "another loop";
  if (m.kind === "file") return m.count === 1 && m.file ? `Shares ${m.file} with ${who}.` : `Shares ${plural(m.count, "file", "files")} with ${who}.`;
  return `${plural(m.count, "message", "messages")} with ${who}.`;
}

// ---- the whole map --------------------------------------------------------------------------------------------------------

/**
 * Lays out `sessions` (the sessions in view), using `all` (every session the page holds) only to name the loops a shared file
 * joins. `expanded` lists the sessions whose finished agents are shown; `labels` names each machine id. The List lays out a
 * machine's opened rows with it under Expand all, so their stations share one column and a file two of them edit joins them.
 */
export function layoutMap(sessions: readonly SessionView[], all: readonly SessionView[], expanded: ReadonlySet<string>, labels: ReadonlyMap<string, string>): MapLayout {
  const byMachine = new Map<string, SessionView[]>();
  for (const s of sessions) byMachine.set(s.machine.id, [...(byMachine.get(s.machine.id) ?? []), s]);
  const label = (id: string) => labels.get(id) ?? byMachine.get(id)?.[0]?.machine.name ?? id;
  const machineIds = [...byMachine.keys()].sort((a, b) => label(a).localeCompare(label(b)) || (a < b ? -1 : a > b ? 1 : 0));
  const files = fileGroups(all);
  const allById = new Map(all.map((s) => [s.id, s]));

  const zones = machineIds.map((machineId): MapZone => {
    const list = [...(byMachine.get(machineId) ?? [])].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const tops: number[] = [];
    let height = 0;
    // Rows, lanes and heights first; a row's x waits for the zone's station column, below.
    const base = list.map((s, i) => {
      const b = sessionBlock(s, expanded.has(s.id), 0);
      if (i > 0) height += MAP.gap;
      tops.push(height);
      height += b.ms.height;
      return b;
    });
    const launcherOf = new Map(base.flatMap((b) => [...b.launcherOf]));
    // Every drawn loop's row, by `session \0 agent`, with its key and y in the zone.
    const rowAt = new Map<string, { key: string; y: number }>();
    base.forEach((b, i) => {
      for (const r of b.ms.rows) rowAt.set(`${r.session.id}\u0000${r.agent?.id ?? ""}`, { key: r.key, y: tops[i]! + r.y });
    });
    const inZone = new Set(list.map((s) => s.id));

    // A loop's row when it is drawn, and its name either way.
    const endpoint = (loop: Loop): Endpoint => {
      const s = allById.get(loop.sessionId);
      const sessionName = s?.name ?? "a session that has ended";
      if (loop.agentId === undefined) return { row: rowAt.get(`${loop.sessionId}\u0000`) ?? null, name: `${sessionName} (which of its loops is not reported)` };
      if (loop.agentId === null) return { row: rowAt.get(`${loop.sessionId}\u0000`) ?? null, name: sessionName };
      const agent = s?.agents.find((a) => a.id === loop.agentId);
      const name = `${agent ? agentName(agent) : loop.name} in ${sessionName}`;
      return { row: rowAt.get(`${loop.sessionId}\u0000${loop.agentId}`) ?? null, name };
    };

    const drafts: Draft[] = [];
    for (const [key, g] of files) {
      if (g.machineId !== machineId) continue;
      const loops = [...g.loops.values()];
      if (!loops.some((l) => inZone.has(l.sessionId))) continue;
      const ends = loops.map(endpoint);
      drafts.push({
        key: `file:${key}`,
        kind: "file",
        ends,
        count: 1,
        path: g.path,
        title: `Shared file ${baseName(g.path)}\n${g.path}\nEdited within 5 minutes by ${listed(ends.map((e) => e.name))}.`,
      });
    }

    // Messages stay inside one session: `to` null is its main loop; no `to` means the reporter could not tie the
    // recipient's name to a loop, so only the sender's ring is drawn and the name is shown as given.
    for (const s of list) {
      const loopName = (id: string | null) => {
        if (id === null) return s.name;
        const agent = s.agents.find((a) => a.id === id);
        return agent ? agentName(agent) : "an agent not listed";
      };
      const loopEnd = (id: string | null): Endpoint => ({ row: rowAt.get(`${s.id}\u0000${id ?? ""}`) ?? null, name: loopName(id) });
      const pairs = new Map<string, typeof s.messages>();
      for (const m of s.messages) {
        const from = m.from ?? "";
        if (m.to !== undefined && (m.to ?? "") === from) continue;
        const key = m.to === undefined ? `${from}\u0000?${m.toName}` : [from, m.to ?? ""].sort().join("\u0000");
        pairs.set(key, [...(pairs.get(key) ?? []), m]);
      }
      for (const [key, msgs] of pairs) {
        const first = msgs[0]!;
        const tied = first.to !== undefined;
        const ends = [loopEnd(first.from), tied ? loopEnd(first.to ?? null) : { row: null, name: first.toName }];
        const lines = msgs.slice(-3).map((m) => `${fmtClock(m.at)} ${loopName(m.from)} to ${m.to === undefined ? m.toName : loopName(m.to ?? null)}: ${excerpt(m.text)}`);
        const count = `${plural(msgs.length, "message", "messages")} in the last 30 minutes`;
        const head = tied ? `Messages between ${ends[0]!.name} and ${ends[1]!.name} (${count})` : `Sent to ${first.toName}, which is not tied to an agent of this session (${count})`;
        drafts.push({ key: `msg:${s.id}\u0000${key}`, kind: "message", ends, count: msgs.length, path: null, title: [head, ...lines].join("\n") });
      }
    }

    const placed = placeColumns(merge(drafts, launcherOf));

    // The zone's station column: past the turn out of its last lane, and past its ring columns, and no further.
    const laneEnd = base.some((b) => b.ms.rows.length > 1) ? laneX(Math.max(...base.map((b) => b.maxLane))) + MAP.chamfer : MAP.lineX;
    const columns = placed.length > 0 ? Math.max(...placed.map((c) => c.k)) + 1 : 0;
    const stationBase = Math.max(
      MAP.lineX + MAP.lead,
      laneEnd + MAP.clear,
      columns > 0 ? laneEnd + MAP.clear + MAP.ringR + (columns - 1) * MAP.ringStep + MAP.ringGap : 0,
    );
    const blocks = list.map((s) => sessionBlock(s, expanded.has(s.id), stationBase));

    // Each station's interchanges, and each interchange in its block, or in the zone when it joins two blocks.
    const rowByKey = new Map(blocks.flatMap((b) => b.ms.rows.map((r) => [r.key, r] as const)));
    const blockOf = new Map(blocks.flatMap((b, i) => b.ms.rows.map((r) => [r.key, i] as const)));
    const zoneChanges: MapChange[] = [];
    for (const c of placed) {
      for (const end of c.rows) {
        const others = [...new Set(c.ends.filter((e) => e.row?.key !== end.key).map((e) => e.name))];
        rowByKey.get(end.key)?.links.push({ key: c.key, kind: c.kind, count: c.count, text: linkText(c, others), title: c.title });
      }
      const homes = new Set(c.rings.map((r) => blockOf.get(r.key)));
      const change: MapChange = { key: c.key, kind: c.kind, x: ringX(c.k, stationBase), ys: c.rings.map((r) => r.y), ends: c.rings.map((r) => r.key), count: c.count, title: c.title };
      const home = homes.size === 1 ? [...homes][0] : undefined;
      if (home === undefined) zoneChanges.push(change);
      else blocks[home]!.ms.changes.push({ ...change, ys: change.ys.map((y) => y - tops[home]!) });
    }

    const sessionsOut = blocks.map((b, i): MapSession => {
      // Finished lanes first, so a lane shared with a live agent reads live down to it.
      const over = [...b.over].sort((x, y) => (x.tone === y.tone ? 0 : x.tone === "done" ? -1 : 1)).map(({ key, d, cls }) => ({ key, d, cls }));
      return { ...b.ms, top: tops[i]!, over };
    });
    const first = list[0];
    return { id: machineId, label: label(machineId), os: first?.machine.os ?? null, height: height + MAP.foot, sessions: sessionsOut, changes: zoneChanges };
  });

  return { zones };
}

/**
 * One session laid out alone, as its own block (a List row opened): its interchanges with other sessions keep one ring.
 */
export function layoutSession(s: SessionView, all: readonly SessionView[], expanded: boolean): MapSession {
  const zone = layoutMap([s], all, expanded ? new Set([s.id]) : new Set(), new Map()).zones[0];
  return zone!.sessions[0]!;
}
