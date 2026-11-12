// The Graph's model and layout, both pure. The model is a connected graph: a centre, one hub per group (Machine or
// Project; with None the sessions hang on the centre), each session on its hub, its live agents on their real parent
// (`parentId`), and each parent's ended agents folded into one node. Label text is sized by generous estimates, never measured.
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { fmtAge, plural } from "../../format";
import type { GroupBy } from "../../groups";
import { familyName, parentOf } from "../../logic";
import { openAsk, STATE_WORD, stateLine, stateOf, type State } from "../../states";
import { isKnownProvider } from "../../../../../server/src/fleet/protocol";
import type { AgentView, ModelFamily, ProviderName, SessionView } from "../../types";
import { dotsText } from "../../ui/Dots";
import { stationWord } from "../../ui/Station";
import { agentName } from "../map/layout";

export type Mark = State | "queued" | "stopped";
export type Side = "r" | "l" | "t" | "b" | "ru" | "rd" | "lu" | "ld";
type Box = [number, number, number, number];

export interface GraphNode {
  id: string;
  kind: "centre" | "hub" | "session" | "agent" | "fold";
  parent: string | null;
  /** The mark's radius in px at 100 %: hub 24, session 16, agent 12, fold 10; the centre's is the pane's. */
  R: number;
  name: string;
  /** The second line; `room` is the widest it may read while the node stands (its box). */
  sub: string | null;
  room: string | null;
  provider?: ProviderName;
  mark?: Mark;
  s?: SessionView;
  a?: AgentView;
  /** A machine hub: its OS (the logo) and the machine name it scopes the view to. */
  os?: string | null;
  scope?: string;
  clash?: boolean;
  /** Hover text and accessible name. */
  title: string;
}

export interface Graph {
  nodes: GraphNode[];
  /** Messages between two loops of a session in the last 30 minutes, one per pair of drawn nodes. */
  messages: [string, string][];
}

const ROOM = dotsText([STATE_WORD["needs-you"], "59m"]);
/** A hub's count at its widest, so its label keeps its box as sessions come and go. */
const HUB_ROOM = plural(99, "session");
const word = (m: Mark) => stationWord(m).charAt(0).toUpperCase() + stationWord(m).slice(1);
const modelOf = (family: ModelFamily, id: string | null) => (id === null ? null : familyName(family, id));
const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const loop = (sessionId: string, agentId: string | null) => `${sessionId}\n${agentId ?? ""}`;
/** A loop's second line: its model, state and age; a harness without a logo of its own leads with its name (provider providerInfo). */
const lines = (provider: ProviderName, model: string | null, mark: Mark, age: string): Pick<GraphNode, "sub" | "room"> => {
  const what = isKnownProvider(provider) ? model : dotsText([provider, model]);
  return { sub: dotsText([what, word(mark), age]), room: dotsText([what, ROOM]) };
};

/** A session's clock: how long it has been in its state where the state line counts one, else how long it has run. */
function since(s: SessionView, state: State): number {
  if (state === "done") return s.lastSeenAt;
  if (state === "needs-you") return openAsk(s)?.openedAt ?? s.lastActivityAt ?? s.startedAt;
  return state === "working" ? s.startedAt : (s.lastActivityAt ?? s.startedAt);
}

/** One session and its agents, in pre-order, with the messages between its drawn loops. */
function addSession(s: SessionView, parent: string, now: number, clash: Map<string, string[]>, g: Graph): void {
  const sid = `s:${s.id}`;
  const state = stateOf(s);
  const model = modelOf(s.modelFamily, s.model);
  const said = clash.get(loop(s.id, null)) ?? [];
  g.nodes.push({ id: sid, kind: "session", parent, R: 16, name: s.name, ...lines(s.provider, model, state, fmtAge((now - since(s, state)) / 1000)), provider: s.provider, mark: state, s, clash: said.length > 0, title: [s.name, stateLine(s, now), ...said].join("\n") });

  // An agent's parent is the listed agent that launched it, or the session when there is none or the chain loops.
  const up = (a: AgentView): AgentView | null => {
    const p = parentOf(s.agents, a);
    for (let q = p, n = 0; q; q = parentOf(s.agents, q)) if (++n > s.agents.length) return null;
    return p;
  };
  const under = new Map<string | null, AgentView[]>();
  for (const a of [...s.agents].sort((x, y) => x.startedAt - y.startedAt || (x.id < y.id ? -1 : 1))) {
    const p = up(a)?.id ?? null;
    under.set(p, [...(under.get(p) ?? []), a]);
  }
  const live = s.status !== "done";
  const asks = new Set(live ? s.asks.filter((k) => k.state !== "closed").map((k) => k.agentId) : []);
  const ended = (a: AgentView) => a.status === "done" || a.status === "failed" || a.status === "aborted";
  const shown = (a: AgentView): boolean => !ended(a) || asks.has(a.id) || (under.get(a.id) ?? []).some(shown);

  const nodeOf = new Map<string | null, string>([[null, sid]]);
  const walk = (from: AgentView | null, at: string) => {
    let done = 0;
    let failed = 0;
    const fold = (a: AgentView) => {
      if (a.status === "failed") failed += 1;
      else done += 1;
      nodeOf.set(a.id, `f:${at}`);
      for (const k of under.get(a.id) ?? []) fold(k);
    };
    for (const a of under.get(from?.id ?? null) ?? []) {
      if (!shown(a)) {
        fold(a);
        continue;
      }
      const id = `a:${s.id}\n${a.id}`;
      const mark: Mark = asks.has(a.id) ? "needs-you" : a.status === "running" ? (a.stuck ? "stuck" : "working") : a.status === "aborted" ? "stopped" : a.status;
      const name = agentName(a);
      const ll = lines(a.provider, modelOf(a.modelFamily, a.model), mark, fmtAge(((a.endedAt ?? now) - a.startedAt) / 1000));
      const its = clash.get(loop(s.id, a.id)) ?? [];
      nodeOf.set(a.id, id);
      g.nodes.push({ id, kind: "agent", parent: at, R: 12, name, ...ll, provider: a.provider, mark, s, a, clash: its.length > 0, title: [name, ll.sub, ...its].join("\n") });
      walk(a, id);
    }
    if (done + failed === 0) return;
    const name = `+${dotsText([done > 0 && `${done} done`, failed > 0 && `${failed} failed`])}`;
    g.nodes.push({ id: `f:${at}`, kind: "fold", parent: at, R: 10, name, sub: null, room: null, s, title: dotsText([name, s.name]) });
  };
  walk(null, sid);

  // A message joins the two loops' nodes, an agent folded away by its fold, unless they are one node or parent and child.
  const parentOfNode = new Map(g.nodes.map((n) => [n.id, n.parent] as const));
  const seen = new Set<string>();
  for (const m of s.messages) {
    const x = nodeOf.get(m.from);
    const y = m.to === undefined ? undefined : nodeOf.get(m.to);
    const pair = x && y && x !== y && parentOfNode.get(x) !== y && parentOfNode.get(y) !== x ? ([x, y].sort() as [string, string]) : null;
    if (!pair || seen.has(pair.join("\n\n"))) continue;
    seen.add(pair.join("\n\n"));
    g.messages.push(pair);
  }
}

/**
 * The graph of the sessions in view, in pre-order: the centre, then each hub followed by its sessions and their agents. No name
 * or room holds a state or a count that changes while the node set holds, so a routine update never lays the graph out again
 * (layoutKey).
 */
export function buildGraph(sessions: readonly SessionView[], group: GroupBy, labels: ReadonlyMap<string, string>, now: number): Graph {
  const g: Graph = { nodes: [], messages: [] };
  g.nodes.push({ id: "c", kind: "centre", parent: null, R: 0, name: "", sub: null, room: null, title: "" });
  // Both ends of a file collision carry the mark: this session, and the other loop (CollisionView names it).
  const clash = new Map<string, string[]>();
  const say = (key: string, text: string) => clash.set(key, [...(clash.get(key) ?? []), text]);
  for (const s of sessions)
    for (const c of s.collisions) {
      say(loop(s.id, null), `Also edited by ${c.name}: ${base(c.path)}`);
      if (c.sessionId !== s.id || c.agentId !== null) say(loop(c.sessionId, c.agentId), `Also edited by ${s.name}: ${base(c.path)}`);
    }
  const byStart = [...sessions].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  if (group === "none") {
    for (const s of byStart) addSession(s, "c", now, clash, g);
    return g;
  }
  const hubs = new Map<string, SessionView[]>();
  for (const s of byStart) {
    const key = group === "machine" ? `m:${s.machine.id}` : `p:${s.project}`;
    hubs.set(key, [...(hubs.get(key) ?? []), s]);
  }
  // A project not reported ("") is one hub, "—", the reason in its title.
  const named = [...hubs].map(([key, list]) => ({ key, list, name: group === "machine" ? (labels.get(list[0]!.machine.id) ?? list[0]!.machine.name) : list[0]!.project ? base(list[0]!.project) : "—" }));
  for (const { key, list, name } of named.sort((a, b) => a.name.localeCompare(b.name) || (a.key < b.key ? -1 : 1))) {
    const id = `h:${key}`;
    const n = list.length;
    const sub = plural(n, "session");
    const m = list[0]!.machine;
    const where = group === "machine" ? dotsText([name, m.os, sub]) : dotsText([list[0]!.project || "Project not reported", sub]);
    g.nodes.push({ id, kind: "hub", parent: "c", R: 24, name, sub, room: HUB_ROOM, ...(group === "machine" ? { os: m.os, scope: m.name } : {}), title: where });
    for (const s of list) addSession(s, id, now, clash, g);
  }
  return g;
}

// ---- layout: d3-force, run synchronously -------------------------------------------------------------------------------

/** Text widths in em, generous for IBM Plex Sans: the page never measures text. */
const EM: Readonly<Record<string, number>> = { " ": 0.3, i: 0.27, l: 0.27, j: 0.29, ".": 0.3, ",": 0.3, ":": 0.3, ";": 0.3, "|": 0.3, "!": 0.3, "'": 0.25, f: 0.38, t: 0.38, r: 0.4, "(": 0.38, ")": 0.38, "[": 0.36, "]": 0.36, I: 0.3, m: 0.88, w: 0.8, M: 0.92, W: 1, "·": 0.34, "…": 0.94, "-": 0.44, _: 0.58, "/": 0.4 };
/**
 * A character drawn a full em wide, in the system's face (Plex has none): CJK ideographs, kana, hangul and the marks written
 * with them (by script extension, so "ー" and "・" count), their punctuation and full-width forms.
 */
const WIDE = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}　-〿！-｠￠-￦]/u;
export function textW(text: string, px: number, bold = false): number {
  let em = 0;
  for (const c of text) em += EM[c] ?? (c >= "A" && c <= "Z" ? 0.69 : c >= "0" && c <= "9" ? 0.6 : c >= "a" && c <= "z" ? 0.555 : WIDE.test(c) ? 1 : 0.7);
  return em * px * (bold ? 1.05 : 1.01) + 2;
}
/** The provider logo and its gap before a loop's second line, px. */
export const LOGO = 18;

/** The collision mark, an ink diamond centred on 0 0 (a file two loops edited): a node's corner, a Problems row. */
export const CLASH_D = "M0 -4.6L4.6 0L0 4.6L-4.6 0Z";

/** A name in at most `n` characters, cut in the middle so names that share a start stay apart. */
function cut(text: string, n: number): string {
  const c = [...text];
  if (c.length <= n) return text;
  const head = Math.ceil((n - 1) * 0.6);
  return `${c.slice(0, head).join("").trimEnd()}…${c.slice(c.length - (n - 1 - head)).join("").trimStart()}`;
}

/** The room Fit keeps around the graph, and above it for the zoom controls; the least and the most zoom. */
export const PAD = 24;
export const TOP = 48;
export const MIN_K = 0.2;
export const MAX_K = 8;

/**
 * The scales a layout is made for, each a fifth below the last: a fresh layout takes the largest at which its labels fit, no
 * smaller than K_FLOOR, where a session's disc is 16 px across, the size of the UI's state marks (ui/Station). Below the floor
 * only the last label level goes, down to MIN_K.
 */
const LADDER = [1, 0.8, 0.64, 0.512, 0.41, 0.328, 0.262, MIN_K];
const K_FLOOR = 0.5;
/**
 * How much more room than its marks and labels take a layout is given: d3-force does not pack tightly, and at 1.35 a 90-node
 * fleet spilled out of a 1140 x 564 pane while at 2 it fitted in every grouping tried.
 */
const SLACK = 2;

/** A label's form: its name in at most `chars` characters, cut in the middle, with its second line or not. */
export interface Form {
  chars: number;
  sub: boolean;
}

/** What a layout reserves room for, most detail first: agents' and folds' labels give way first, then the second line, then the name's length. */
const LEVELS: readonly { agents: boolean; form: Form }[] = [
  { agents: true, form: { chars: 28, sub: true } },
  { agents: false, form: { chars: 28, sub: true } },
  { agents: false, form: { chars: 28, sub: false } },
  { agents: false, form: { chars: 18, sub: false } },
  { agents: false, form: { chars: 12, sub: false } },
];
/** The lengths a name is cut to. */
const CHARS = [12, 18, 28, Infinity];

/** A node's label in a form: a hub's and a fold's always with their second line. */
export function labelOf(n: GraphNode, f: Form): { name: string; sub: string | null; room: string | null } {
  const two = n.kind === "hub" || n.kind === "fold" || f.sub;
  return { name: cut(n.name, f.chars), sub: two ? n.sub : null, room: two ? n.room : null };
}

/** A label's width and height on screen, px: names 14 px on a 20 px line, second lines 13 px (graph.css). */
export function labelSize(n: GraphNode, f: Form): [number, number] {
  const l = labelOf(n, f);
  const fold = n.kind === "fold";
  return [Math.ceil(Math.max(textW(l.name, fold ? 13 : 14, !fold), l.room ? textW(l.room, 13) + (n.provider ? LOGO : 0) : 0)), fold ? 18 : l.room ? 38 : 20];
}

/**
 * A node's label at a level: the form the layout reserves room for (an agent's or fold's at the first level only), and each
 * richer form after it, the name longer, then the second line, each drawn from the zoom where it has room (`zooms`).
 */
export function formsOf(n: GraphNode, level: number): { base: Form | null; more: Form[] } {
  const L = LEVELS[level]!;
  if (n.kind === "centre") return { base: null, more: [] };
  if (n.kind === "hub") return { base: { chars: 28, sub: true }, more: [...n.name].length > 28 ? [{ chars: Infinity, sub: true }] : [] };
  if (n.kind === "fold" && L.agents) return { base: { chars: 28, sub: true }, more: [] };
  if (n.kind === "fold") return { base: null, more: [{ chars: 28, sub: false }] };
  const base = n.kind === "session" || L.agents ? L.form : null;
  const more: Form[] = [];
  const length = [...n.name].length;
  // An agent with no room of its own starts at the second length; a name already whole gets no longer form.
  let chars = base?.chars ?? 12;
  for (const c of CHARS) if (c > chars && (length > chars || (!base && !more.length))) more.push({ chars: (chars = c), sub: base?.sub ?? false });
  if (!base?.sub) more.push({ chars: Infinity, sub: true });
  return { base, more };
}

/** A label box's top left on a side of its node, `lo` out from the centre (16 off the line in for a two-letter side). */
export function sideBox(side: Side, lo: number, w: number, h: number): [number, number] {
  const x = side === "t" || side === "b" ? -w / 2 : side[0] === "r" ? lo : -lo - w;
  const y = side.length === 2 ? (side[1] === "u" ? -16 - h : 16) : side === "r" || side === "l" ? -h / 2 : side === "b" ? lo : -lo - h;
  return [x, y];
}

export interface Placed {
  x: number;
  y: number;
  side: Side;
  /** The reserved label's box from the node: left, top, width, height. */
  box: Box;
  /** Each richer form of its label with the zoom it is drawn from, in order (`zooms`). */
  more: { z: number; form: Form }[];
}
export interface Layout {
  level: number;
  /** The scale it is laid out for: each label takes its room on screen there, and the whole graph fits the pane. */
  k: number;
  /** The centre's radius: 40-56 px by the pane. */
  Rc: number;
  pane: { w: number; h: number };
  at: Map<string, Placed>;
  /**
   * Everything drawn up to 100 %, marks and labels, a richer form at its own zoom: x1, y1, x2, y2; and the box the layout keeps
   * to, the pane at `k` (more for a fleet too big for it).
   */
  extent: Box;
  bound: Box;
  /** Laid out afresh, not on the layout before it. */
  fresh: boolean;
}

interface Sim extends SimulationNodeDatum {
  n: GraphNode;
  x: number;
  y: number;
  up: Sim | null;
  hub: Sim | null;
  kids: Sim[];
  R: number;
  /** The mark's clearance, the label's offset from the centre, its size and padding; the weight a push moves it by (0 holds it). */
  cr: number;
  lo: number;
  w: number;
  h: number;
  pad: number;
  wt: number;
  /** The room its children take, its link's length, a hub's sector angle. */
  rho: number;
  rest: number;
  sa: number;
  side: Side;
  box: Box;
  /** From the node, x1, y1, x2, y2: the box the label sweeps over every zoom, and mark and label together; the layout's scale. */
  sweep: Box;
  all: Box;
  k: number;
}

function setSide(m: Sim, side: Side): void {
  const { lo, w, h, cr, pad, k } = m;
  const [x, y] = sideBox(side, lo, w, h);
  m.side = side;
  m.box = [x, y, w, h];
  // Past 100 % a label keeps its size and offset on screen while the drawing grows (GraphLayout), so in the layout's units it
  // closes in on its node, to an eighth at MAX_K: the box it sweeps on the way is what is kept clear, so no zoom puts it on
  // another node.
  const [x8, y8] = sideBox(side, lo, w * k, h * k).map((v) => v / MAX_K) as [number, number];
  m.sweep = [Math.min(x, x8), Math.min(y, y8), Math.max(x + w, x8 + (w * k) / MAX_K), Math.max(y + h, y8 + (h * k) / MAX_K)];
  const [x1, y1, x2, y2] = m.sweep;
  m.all = w ? [Math.min(-cr, x1 - pad), Math.min(-cr, y1 - pad), Math.max(cr, x2 + pad), Math.max(cr, y2 + pad)] : [-cr, -cr, cr, cr];
}

/**
 * The label's side, snapped by angle with hysteresis: a leaf's outward from its parent; a node with children (hubs, sessions
 * and launching agents) faces its parent, above or below the
 * line in, so the label never sits in the cone its children fan out into. A node held in place (`fx`) keeps its side.
 */
function pickSide(m: Sim): Side {
  const p = m.up;
  if (!p) return "b";
  if (m.fx != null) return m.side;
  const cur = m.side;
  const d = Math.hypot(m.x - p.x, m.y - p.y);
  if (d < 1) return cur;
  const cos = (m.x - p.x) / d;
  const sin = (m.y - p.y) / d;
  if (m.kids.length) return `${cur.length === 2 && Math.abs(cos) < 0.25 ? cur[0] : cos <= 0 ? "r" : "l"}${cur.length === 2 && Math.abs(sin) < 0.08 ? cur[1] : sin <= 0 ? "u" : "d"}` as Side;
  if ((cur === "r" || cur === "l") && Math.abs(cos) >= 0.34 && cos > 0 === (cur === "r")) return cur;
  if ((cur === "t" || cur === "b") && Math.abs(cos) < 0.46 && sin < 0 === (cur === "t")) return cur;
  return Math.abs(cos) >= 0.4 ? (cos > 0 ? "r" : "l") : sin < 0 ? "t" : "b";
}

/** Two boxes apart along the shorter overlap, each node moved by its weight. */
function push(a: Sim, A: Box, b: Sim, B: Box): number {
  const ox = Math.min(A[2], B[2]) - Math.max(A[0], B[0]);
  const oy = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
  const ws = a.wt + b.wt;
  if (ox <= 0 || oy <= 0 || !ws) return 0;
  if (ox < oy) {
    const s = A[0] + A[2] < B[0] + B[2] ? -1 : 1;
    a.x += (s * ox * a.wt) / ws;
    b.x -= (s * ox * b.wt) / ws;
  } else {
    const s = A[1] + A[3] < B[1] + B[3] ? -1 : 1;
    a.y += (s * oy * a.wt) / ws;
    b.y -= (s * oy * b.wt) / ws;
  }
  return 1;
}
const mark = (m: Sim): Box => [m.x - m.cr, m.y - m.cr, m.x + m.cr, m.y + m.cr];
const label = (m: Sim): Box => [m.x + m.sweep[0] - m.pad, m.y + m.sweep[1] - m.pad, m.x + m.sweep[2] + m.pad, m.y + m.sweep[3] + m.pad];
const hit = (A: Box, B: Box): boolean => Math.min(A[2], B[2]) > Math.max(A[0], B[0]) && Math.min(A[3], B[3]) > Math.max(A[1], B[1]);
const disc = (m: Sim): Box => [m.x - m.R, m.y - m.R, m.x + m.R, m.y + m.R];
const text = (m: Sim): Box => [m.x + m.sweep[0], m.y + m.sweep[1], m.x + m.sweep[2], m.y + m.sweep[3]];
/** Whether m's disc and label as drawn at any zoom, without clearance or padding, overlap no other node's. */
const clear = (m: Sim, list: readonly Sim[]): boolean => list.every((o) => o === m || !(hit(disc(m), disc(o)) || (m.w > 0 && hit(text(m), disc(o))) || (o.w > 0 && (hit(disc(m), text(o)) || (m.w > 0 && hit(text(m), text(o)))))));
const within = (m: Sim, b: Box): boolean => m.x + m.all[0] >= b[0] && m.y + m.all[1] >= b[1] && m.x + m.all[2] <= b[2] && m.y + m.all[3] <= b[3];

/**
 * Overlap relaxation as one d3 custom force (d3-force: a force may resolve a geometric constraint by moving positions): one
 * Gauss-Seidel sweep keeping every mark and label off every other, then every node that moves held inside the bound, as d3's
 * bounded force layout clamps its nodes. forceCollide's circles cannot hold a label box set off to one side without reserving a
 * circle as wide as the label, so this replaces it. Returns the pushes.
 */
function apart(list: readonly Sim[], turn: boolean, bound: Box): number {
  let moved = 0;
  if (turn) for (const m of list) if (pickSide(m) !== m.side) setSide(m, pickSide(m));
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]!;
      if ((!a.wt && !b.wt) || a.x + a.all[2] < b.x + b.all[0] || b.x + b.all[2] < a.x + a.all[0] || a.y + a.all[3] < b.y + b.all[1] || b.y + b.all[3] < a.y + a.all[1]) continue;
      moved += push(a, mark(a), b, mark(b));
      if (a.w) moved += push(a, label(a), b, mark(b));
      if (b.w) moved += push(a, mark(a), b, label(b));
      if (a.w && b.w) moved += push(a, label(a), b, label(b));
    }
  }
  for (const m of list) {
    if (!m.wt) continue;
    m.x = Math.max(bound[0] - m.all[0], Math.min(bound[2] - m.all[2], m.x));
    m.y = Math.max(bound[1] - m.all[1], Math.min(bound[3] - m.all[3], m.y));
  }
  return moved;
}

/**
 * A node the relaxation leaves overlapping another as drawn (boxed in by held nodes or the bound) moves to the nearest place
 * inside the bound where it overlaps nothing, searched along an Archimedean spiral out from where it stands, as d3-cloud
 * places a word; with no such place, to the nearest clear place outside it, and the layout spills. The spiral's turns are
 * 10 px apart on screen at the layout's scale, so its cost does not grow as the scale falls. Children go first, so a parent
 * keeps its place where moving them clears it.
 */
function settle(list: readonly Sim[], bound: Box, k: number): void {
  const far = Math.max(bound[2] - bound[0], bound[3] - bound[1]);
  const u = 10 / k;
  for (const m of [...list].reverse()) {
    if (!m.wt || clear(m, list)) continue;
    const [x, y] = [m.x, m.y];
    let to: [number, number] = [x, y];
    for (let a = 0, r = 0, outside = false; r < far; ) {
      a += 2 / Math.max(2, r / u);
      r = (u * a) / (2 * Math.PI);
      [m.x, m.y] = [x + r * Math.cos(a), y + r * Math.sin(a)];
      const inside = within(m, bound);
      // Once a clear place outside is found, only a place inside is worth testing.
      if ((outside && !inside) || !clear(m, list)) continue;
      to = [m.x, m.y];
      if (inside) break;
      outside = true;
    }
    [m.x, m.y] = to;
  }
}

/**
 * The zoom from which each richer form of a label is drawn: the least from which up it covers no disc, no reserved label and
 * no richer form drawn before it, and stays inside what Fit frames, forms taken in turn, every node's first before any node's
 * second, sessions before agents and folds. These are the active ranges of consistent dynamic map labelling (Been, Daiches
 * and Yap, 2006): a form once drawn stays drawn as the view zooms in, and goes only below its zoom. From the layout's scale up
 * a label keeps its size on screen and marks scale with the drawing to 100 % (GraphLayout), so on each side of 100 % every box
 * edge moves linearly with the zoom, and two boxes overlap on one interval of it.
 */
function zooms(nodes: readonly GraphNode[], L: Layout): void {
  type Shape = { id: string; x: number; y: number; ax: number; ay: number; cx: number; cy: number; w: number; h: number; R: number; far: number; from: number };
  const disc = (n: GraphNode, p: Placed): Shape => {
    const R = n.kind === "centre" ? L.Rc : n.R;
    return { id: n.id, x: p.x, y: p.y, ax: 0, ay: 0, cx: 0, cy: 0, w: 0, h: 0, R, far: R * 1.5, from: 0 };
  };
  const label = (n: GraphNode, p: Placed, f: Form, from: number): Shape => {
    const [w, h] = labelSize(n, f);
    const [ax, ay] = sideBox(p.side, n.R + 6, 0, 0);
    const [bx, by] = sideBox(p.side, n.R + 6, w, h);
    return { id: n.id, x: p.x, y: p.y, ax, ay, cx: bx - ax, cy: by - ay, w, h, R: 0, far: Math.abs(bx) + Math.abs(by) + w + h, from };
  };
  // A box's left edge and width at zoom z on one side of 100 %: z·x + s·(ax − R) + cx and 2·s·R + w, with s = z below it, 1 above.
  const lin = (b: Shape, above: boolean, vertical: boolean): [number, number, number, number] => {
    const [c, a, o, size] = vertical ? [b.y, b.ay, b.cy, b.h] : [b.x, b.ax, b.cx, b.w];
    return above ? [c, a - b.R + o, 0, 2 * b.R + size] : [c + a - b.R, o, 2 * b.R, size];
  };
  // The least zoom up to 100 % (Fit never goes past it) from which a form lies inside the bound, which does not change while
  // the layout is held; a form outside it at 100 % waits for a zoom past it.
  const framed = (b: Shape): number => {
    let lo = L.k;
    for (const vertical of [false, true]) {
      const [u, v, , q] = lin(b, false, vertical);
      const [e1, e2] = vertical ? [L.bound[1], L.bound[3]] : [L.bound[0], L.bound[2]];
      // Its near edge past the bound's and its far edge short of the other's: α·z + β ≥ 0.
      for (const [al, be] of [[u - e1, v], [e2 - u, -v - q]] as const) {
        if (al > 0) lo = Math.max(lo, -be / al);
        else if (al + be < 0) lo = Infinity;
      }
    }
    return lo <= 1 ? lo : 1 + 1e-6;
  };
  // The greatest zoom at which a overlaps b while b is drawn, 2 px apart; -Infinity if none.
  const until = (a: Shape, b: Shape): number => {
    if (Math.max(L.k, b.from) * Math.hypot(a.x - b.x, a.y - b.y) > a.far + b.far + 2) return -Infinity;
    let last = -Infinity;
    for (const above of [false, true]) {
      let [lo, hi] = above ? [Math.max(1, b.from), MAX_K] : [Math.max(L.k, b.from), 1];
      for (const vertical of [false, true]) {
        const [ua, va, pa, qa] = lin(a, above, vertical);
        const [ub, vb, pb, qb] = lin(b, above, vertical);
        // Each starts before the other ends: α·z + β > 0.
        for (const [al, be] of [[ub + pb - ua, vb + qb + 2 - va], [ua + pa - ub, va + qa + 2 - vb]] as const) {
          if (al > 0) lo = Math.max(lo, -be / al);
          else if (al < 0) hi = Math.min(hi, -be / al);
          else if (be <= 0) hi = lo;
        }
      }
      if (lo < hi) last = Math.max(last, hi);
    }
    return last;
  };
  const RANK: Readonly<Record<GraphNode["kind"], number>> = { centre: 0, hub: 0, session: 0, agent: 1, fold: 2 };
  const drawn: Shape[] = [];
  const asked: { n: GraphNode; p: Placed; f: Form; i: number }[] = [];
  for (const n of nodes) {
    const p = L.at.get(n.id)!;
    const { base, more } = formsOf(n, L.level);
    drawn.push(disc(n, p));
    if (base) drawn.push(label(n, p, base, 0));
    more.forEach((f, i) => asked.push({ n, p, f, i }));
    p.more = [];
  }
  asked.sort((a, b) => a.i - b.i || RANK[a.n.kind] - RANK[b.n.kind]);
  for (const { n, p, f, i } of asked) {
    if (p.more.length < i) continue;
    const b = label(n, p, f, 0);
    let z = Math.max(framed(b), p.more[p.more.length - 1]?.z ?? 0);
    for (const o of drawn) if (o.id !== n.id) z = Math.max(z, until(b, o));
    if (z >= MAX_K) continue;
    b.from = z;
    drawn.push(b);
    p.more.push({ z, form: f });
    // The extent takes in a form drawn below 100 % where it reaches furthest, at its own zoom, so Fit frames every label.
    if (z <= 1)
      for (const i of [0, 1]) {
        const [u, v, , q] = lin(b, false, i === 1);
        [L.extent[i], L.extent[i + 2]] = [Math.min(L.extent[i]!, u + v / z), Math.max(L.extent[i + 2]!, u + (v + q) / z)];
      }
  }
}

/** Whether a layout still holds for a pane: made for it, with everything drawn inside its bound. */
export const holds = ({ pane: p, extent: e, bound: b }: Layout, pane: { w: number; h: number }): boolean =>
  p.w === pane.w && p.h === pane.h && e[0] >= b[0] - 0.5 && e[1] >= b[1] - 0.5 && e[2] <= b[2] + 0.5 && e[3] <= b[3] + 0.5;

const CHARGE: Readonly<Record<GraphNode["kind"], number>> = { centre: 400, hub: 300, session: 150, agent: 80, fold: 60 };

/**
 * Positions for the graph, centred on the centre node, made for the scale it opens at: each reserved label's room is its size
 * on screen at that scale, and the whole graph is held inside the pane there. A later layout (`last`, for the same pane) keeps
 * its level, scale and bound, and every node placed before whose parent was too stays where it was (fixed as d3-force fixes a
 * node, `fx`, `fy`); a node whose label changed size is held the same way and moves only if its new label needs room; only a
 * node new to the graph is placed, starting beside its parent. When that no longer fits inside the bound, or the pane is
 * another size, the graph is laid out afresh: the most detailed label level whose area test passes at a scale on LADDER no
 * smaller than K_FLOOR, checked by laying it out (a layout that spills tries the next level). The last level goes on down
 * LADDER while it spills; at MIN_K its bound grows to the area the fleet needs, and what still spills is kept in the bound, so
 * a fleet too big for the pane is panned, and the next update holds it rather than laying it out again. With `keep` (the
 * owner has moved the view) the last layout is held whatever the pane and however far new nodes spill.
 */
export function layoutGraph(nodes: readonly GraphNode[], pane: { w: number; h: number }, last: Layout | null, keep = false): Layout {
  let out = last && (keep || holds(last, pane)) ? place(nodes, last.pane, last.Rc, last.level, last.k, last.bound, last.at) : null;
  if (!out || (!keep && !holds(out, pane))) {
    const Rc = Math.max(40, Math.min(56, Math.round(Math.min(pane.w, pane.h) * 0.09)));
    const room = (pane.w - 2 * PAD) * (pane.h - TOP - PAD);
    levels: for (let level = 0; level < LEVELS.length; level++) {
      const sizes = nodes.map((n) => {
        const f = formsOf(n, level).base;
        return [(n.kind === "centre" ? Rc : n.R) + 6, f && labelSize(n, f)] as const;
      });
      // The room marks and labels take on screen at scale k, the marks scaled with it and each label at its own size.
      const need = (k: number) => sizes.reduce((sum, [cr, s]) => sum + (2 * cr * k + (s ? s[0] : 0) + 14 * k) * (Math.max(2 * cr * k, s ? s[1] : 0) + 14 * k), 0) * SLACK;
      const end = level === LEVELS.length - 1;
      const ks = end ? LADDER.filter((s) => need(s) <= room || s === MIN_K) : LADDER.filter((s) => s >= K_FLOOR && need(s) <= room).slice(0, 1);
      for (const k of ks) {
        const g = k === MIN_K ? Math.max(1, Math.sqrt(need(k) / room)) : 1;
        const [w, h] = [((pane.w - 2 * PAD) / 2 / k) * g, ((pane.h - TOP - PAD) / 2 / k) * g];
        out = { ...place(nodes, pane, Rc, level, k, [-w, -h, w, h], new Map()), fresh: true };
        if (holds(out, pane)) break levels;
      }
    }
    const [e, b] = [out!.extent, out!.bound];
    out!.bound = [Math.min(e[0], b[0]), Math.min(e[1], b[1]), Math.max(e[2], b[2]), Math.max(e[3], b[3])];
  }
  zooms(nodes, out!);
  return out!;
}

function place(nodes: readonly GraphNode[], pane: { w: number; h: number }, Rc: number, level: number, k: number, bound: Box, before: ReadonlyMap<string, Placed>): Layout {
  const ex = Math.min(1.7, Math.max(1, Math.sqrt(pane.w / pane.h)));
  const byId = new Map<string, Sim>();
  const list = nodes.map((n): Sim => {
    const R = n.kind === "centre" ? Rc : n.R;
    const f = formsOf(n, level).base;
    const s = f && labelSize(n, f);
    const m: Sim = { n, x: 0, y: 0, up: null, hub: null, kids: [], R, cr: R + 6, lo: R + 6, w: s ? s[0] / k : 0, h: s ? s[1] / k : 0, pad: 4 / k, wt: n.kind === "centre" ? 0 : n.kind === "hub" ? 0.3 : 1, rho: 0, rest: 0, sa: 0, side: "r", box: [0, 0, 0, 0], sweep: [0, 0, 0, 0], all: [0, 0, 0, 0], k };
    byId.set(n.id, m);
    return m;
  });
  const centre = list[0]!;
  for (const m of list) {
    m.up = m.n.parent === null ? null : (byId.get(m.n.parent) ?? null);
    m.up?.kids.push(m);
    m.hub = m.n.kind === "hub" ? m : (m.up?.hub ?? null);
  }

  // Children before parents: the tree is deeper than two, so a child's own subtree counts in its footprint.
  for (const m of [...list].reverse()) {
    let area = 0;
    for (const c of m.kids) area += (c.w + c.lo + c.cr + 14) * (Math.max(c.h, 2 * c.cr) + 14) * 0.5 + c.w * (c.h + c.lo + c.cr + 14) * 0.5 + (c.kids.length ? Math.PI * (c.rho - c.R) ** 2 : 0);
    m.rho = m.kids.length ? m.R + 16 + Math.sqrt((area * 1.15) / Math.PI) : m.cr;
  }
  const hubs = centre.kids.filter((c) => c.n.kind === "hub");
  const weight = hubs.map((h) => Math.sqrt(h.kids.length) + 0.8);
  const total = weight.reduce((a, b) => a + b, 0);
  let acc = 0;
  hubs.forEach((h, i) => {
    const w = weight[i]!;
    h.sa = Math.PI + (2 * Math.PI * (acc + w / 2 - weight[0]! / 2)) / total;
    acc += w;
    h.rest = Math.max(Rc + 40 + 0.92 * h.rho, hubs.length > 1 ? (1.1 * h.rho) / Math.sin(Math.min((Math.PI * w) / total, 1.3)) : 0);
  });
  for (const m of list) if (m.up && m.n.kind !== "hub") m.rest = m.up === centre ? Rc + 60 + 0.62 * centre.rho : m.up.R + 18 + 0.45 * (m.up.rho - m.up.R);

  // Seeds: where each node was, if its parent was there too; else on a slot around its parent, spread outward, away from the
  // grandparent, hubs on their sectors, the centre's children on an ellipse along the pane's long axis.
  let kept = 0;
  const seat = (p: Sim) => {
    const n = p.kids.length;
    const out = p.up ? Math.atan2(p.y - p.up.y, p.x - p.up.x) : 0;
    const span = p.up ? Math.min(2 * Math.PI - 2.4, 0.9 * n) : 2 * Math.PI;
    p.kids.forEach((c, i) => {
      const old = before.get(c.n.id);
      if (old && (p === centre || before.has(p.n.id))) {
        [c.x, c.y, c.side] = [old.x, old.y, old.side];
        [c.fx, c.fy, c.wt] = [old.x, old.y, old.box[2] === c.w && old.box[3] === c.h ? 0 : c.wt];
        kept += 1;
      } else {
        const t = c.n.kind === "hub" ? c.sa : out - span / 2 + (span * (i + 0.5)) / n;
        const r = c.rest * (n > 7 ? (i % 2 ? 1.22 : 0.84) : 1);
        const e = p === centre ? ex : 1;
        c.x = p.x + r * e * Math.cos(t);
        c.y = p.y + (r / e) * Math.sin(t);
      }
      seat(c);
    });
  };
  seat(centre);
  for (const m of list) setSide(m, pickSide(m));

  // Each hub's cluster is held in its sector, the hub on its trunk's end and its sessions and agents beyond it.
  const toward = (m: Sim, cos: (a: number) => number, e: number) => (m.hub ? (m === m.hub ? m.hub.rest : m.hub.rest + 0.5 * m.hub.rho) * e * cos(m.hub.sa) : 0);
  const pull = (m: Sim) => (!m.hub ? 0 : m === m.hub ? 0.2 : 0.03);
  centre.fx = 0;
  centre.fy = 0;
  forceSimulation(list)
    .force("link", forceLink<Sim, SimulationLinkDatum<Sim>>(list.filter((m) => m.up).map((m) => ({ source: m.up!, target: m }))).distance((l) => (l.target as Sim).rest))
    .force("charge", forceManyBody<Sim>().strength((m) => -CHARGE[m.n.kind]).distanceMax(600))
    .force("x", forceX<Sim>((m) => toward(m, Math.cos, ex)).strength(pull))
    .force("y", forceY<Sim>((m) => toward(m, Math.sin, 1 / ex)).strength(pull))
    .force("apart", () => void apart(list, true, bound))
    .stop()
    .alpha(kept > list.length / 2 ? 0.3 : 1)
    .tick(300);
  // The sides stay as the run left them, so the last pushes settle; whatever they cannot clear is placed by the spiral.
  for (let i = 0; i < 300 && apart(list, false, bound) > 0; i++);
  settle(list, bound, k);

  const at = new Map<string, Placed>();
  const extent: Box = [0, 0, 0, 0];
  for (const m of list) {
    at.set(m.n.id, { x: m.x, y: m.y, side: m.side, box: m.box, more: [] });
    extent[0] = Math.min(extent[0], m.x + m.all[0]);
    extent[1] = Math.min(extent[1], m.y + m.all[1]);
    extent[2] = Math.max(extent[2], m.x + m.all[2]);
    extent[3] = Math.max(extent[3], m.y + m.all[3]);
  }
  return { level, k, Rc, pane, at, extent, bound, fresh: false };
}

/** What the layout depends on: the node set, each node's parent and the room its label takes. State and time never move it. */
export const layoutKey = (g: Graph): string => JSON.stringify(g.nodes.map((n) => [n.id, n.parent, n.R, n.name, n.room]));
