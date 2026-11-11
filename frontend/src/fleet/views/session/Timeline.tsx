// The session page's Timeline: the delegation trace. The agent tree runs down the left, in launch order or the chosen order
// among siblings; each loop is a line on one shared time axis on the right, branching off the line that launched it with a
// 45-degree knee and ending in its station. Marks sit where something happened; one toolbar row over the drawing holds the
// Timeline ⇄ Agents switch, the view's controls and the order among siblings, with the legend of every kind of mark it draws
// on its own row under it. On a live page the inspector lists the same events in words (one source, useSessionEvents; `]`
// reopens it) and each row is a button; a stored page from History has no live inspector list, so it lists them below the
// drawing. Either list is how a keyboard reaches what a mark says.
// The drawing pans and zooms in time only: drag, or scroll sideways, to pan; pinch, Ctrl or ⌘ with the wheel, or − and + to zoom;
// Fit shows the whole session and Now jumps to its live end. Until the owner moves the view it keeps fitting the session as it
// grows. d3-zoom handles the gestures; the drawing is our own SVG, and its axis labels whatever span is in view.
import { select } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { fmtClock, fmtSpan, plural } from "../../format";
import type { AgentSort } from "../../components/AgentTree";
import { defaultAgentDir, ORCHESTRATOR_ROW, type AgentSortKey } from "../../logic";
import type { ActivityView, SessionView } from "../../types";
import { Station, StationWord } from "../../ui/Station";
import { AGENT_SORT_LABELS, axisTicks, buildTrace, eventWords, rowSeconds, type Mark, type MarkKind, type Trace, type TraceRow } from "./trace";
import { dotsText } from "../../ui/Dots";
import { clock, useWidth } from "./bits";
import type { SessionEvents } from "./useSessionEvents";

/** The width of one figure of an axis label (the mono face's advance, 0.6 em, at --t-xs): a label that would run past the plot's right edge is left off. */
const TICK_CH = 7.2;
/** Row pitch; the axis band over the plot; room over the first row, so a count over a ring on the top line stays inside. */
const PITCH = 36;
const AXIS_H = 26;
const TOP = 8;
/** The knee where a branch turns into its own row. */
const KNEE = 12;
/** Events listed at first and added per "Show more". */
const EVENTS_PAGE = 12;

// ---- the time view -------------------------------------------------------------------------------------------------

/** Pixels per millisecond at zoom 1: a pixel a second. The zoom's own scale multiplies it. */
const BASE = 1 / 1000;
/**
 * How far the view zooms: out to two hours a pixel, so Fit shows a session of a month on a plot of 400 px (the axis's steps run
 * to a month, trace.ts), and in to two milliseconds a pixel.
 */
const K_MIN = 1 / 7_200_000 / BASE;
const K_MAX = 0.5 / BASE;
/** One press of − or +. */
const ZOOM_STEP = 1.6;
/** A fitted session spans at least ten seconds, so one that just began does not stretch a second across the plot; past that, Fit spans its start to now. */
const MIN_SPAN = 10_000;
/** The room a fitted session keeps at each end, so an end station is never cut; Now puts the live end at 95 % of the width. */
const PAD_L = 10;
const PAD_R = 14;
const NOW_AT = 0.95;
/** A press that moves this far is a drag, and does not also pick the row under it. */
const CLICK_PX = 4;

type X = (t: number) => number;

interface TimeView {
  x: X;
  /** The times at the plot's two edges. */
  from: number;
  to: number;
  zoomBy: (factor: number) => void;
  fit: () => void;
  goNow: () => void;
}

const clampK = (k: number) => Math.max(K_MIN, Math.min(K_MAX, k));

/**
 * The plot's view of time: d3-zoom on the x axis only (y is held at 0), anchored at the session's start. The wheel zooms only
 * with Ctrl or ⌘ (a trackpad pinch arrives that way), so a plain scroll still scrolls the page; a sideways scroll pans.
 * Every gesture, and −, + and Now, leave the view where the owner put it; Fit goes back to following the session.
 */
function useTimeView(svgRef: RefObject<SVGSVGElement>, width: number, anchor: number, trace: Trace): TimeView {
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  const behavior = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([K_MIN, K_MAX])
      .filter((e: Event) => (e.type === "wheel" ? (e as WheelEvent).ctrlKey || (e as WheelEvent).metaKey : !(e as MouseEvent).ctrlKey && !(e as MouseEvent).button))
      .constrain((t) => zoomIdentity.translate(t.x, 0).scale(t.k))
      .clickDistance(CLICK_PX)
      .on("zoom", (e: D3ZoomEvent<SVGSVGElement, unknown>) => {
        if (e.sourceEvent) following.current = false;
        setTransform(e.transform);
      });
    const sel = select(svg).call(z);
    // A sideways scroll (or Shift with the wheel) pans; an upright one is left to the page.
    sel.on(
      "wheel.pan",
      (e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) return;
        const sideways = e.shiftKey ? e.deltaY || e.deltaX : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
        if (sideways === 0) return;
        e.preventDefault();
        const px = sideways * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? svg.clientWidth : 1);
        following.current = false;
        z.translateBy(sel, -px / zoomTransform(svg).k, 0);
      },
      { passive: false },
    );
    behavior.current = z;
    return () => {
      sel.on(".zoom", null).on("wheel.pan", null);
      behavior.current = null;
    };
  }, [svgRef]);

  const apply = useCallback(
    (k: number, x: number) => {
      const svg = svgRef.current;
      if (svg && behavior.current) behavior.current.transform(select(svg), zoomIdentity.translate(x, 0).scale(k));
    },
    [svgRef],
  );
  const { t0, t1 } = trace;
  const end = trace.rows[0]?.end ?? t1;
  const fitNow = useCallback(() => {
    if (width <= PAD_L + PAD_R) return;
    const wanted = (width - PAD_L - PAD_R) / Math.max(t1 - t0, MIN_SPAN) / BASE;
    const k = clampK(wanted);
    // Longer than the farthest zoom holds, its live end shows, as Now has it, never a blank start.
    apply(k, k > wanted ? width - PAD_R - k * BASE * (t1 - anchor) : PAD_L - k * BASE * (t0 - anchor));
  }, [apply, width, t0, t1, anchor]);
  // While the owner has not moved it, the view fits the session again as it grows or the plot is resized.
  useLayoutEffect(() => {
    if (following.current) fitNow();
  }, [fitNow]);

  const k = transform.k * BASE;
  const x: X = (t) => transform.x + k * (t - anchor);
  return {
    x,
    from: anchor - transform.x / k,
    to: anchor + (width - transform.x) / k,
    zoomBy: (factor) => {
      const svg = svgRef.current;
      if (!svg || !behavior.current) return;
      following.current = false;
      behavior.current.scaleBy(select(svg), factor);
    },
    fit: () => {
      following.current = true;
      fitNow();
    },
    goNow: () => {
      following.current = false;
      apply(transform.k, NOW_AT * width - k * (end - anchor));
    },
  };
}

// ---- the drawing ---------------------------------------------------------------------------------------------------

/** A row's line: from its parent's line, down and in at 45 degrees, then along its row to its end. */
function linePath(r: TraceRow, i: number, rows: readonly TraceRow[], x: X): string {
  const y = i * PITCH + PITCH / 2;
  const xs = x(r.start);
  const xe = Math.max(xs, x(r.end));
  if (r.parent === null) return `M${xs.toFixed(1)} ${y}H${xe.toFixed(1)}`;
  const py = r.parent * PITCH + PITCH / 2;
  const k = Math.max(0, Math.min(KNEE, xs - x(rows[r.parent]!.start), (y - py) / 2));
  return `M${(xs - k).toFixed(1)} ${py}V${y - k}L${xs.toFixed(1)} ${y}H${xe.toFixed(1)}`;
}

/** An interchange ring's radius, as in a List row's block of lines (MAP.ringR); marks keep one ring diameter clear of each
 * other, edge to edge. */
const RING_R = 6;
const GAP = RING_R * 2;
/** Half the width of a mark (a ring with its stroke; the others are drawn no wider), and of a line's end station. */
const MARK_HW = RING_R + 1;
const STATION_HW = 8;
/** A ring's count: how far its baseline sits above the ring, and how wide each figure is with half its halo at each end. */
const COUNT_LIFT = RING_R + 3;
const COUNT_CH = 7;
const COUNT_HALO = 1.5;

/**
 * Half the width a mark keeps clear on its rows: its ring's, or, for a count too wide to fit over the clear space between two
 * rings, enough that two counts over neighbouring rings keep 2 px apart. Up to three figures fit at the rings' own spacing.
 */
function footprint(m: Mark): number {
  if (m.items.length < 2) return MARK_HW;
  const countHalf = (String(m.items.length).length * COUNT_CH) / 2 + COUNT_HALO;
  return Math.max(MARK_HW, countHalf - GAP / 2 + 1);
}

/** A small mark drawn the same way on the line and in the legend. */
function MarkShape({ kind, open }: { kind: MarkKind; open?: boolean }) {
  switch (kind) {
    case "ask":
    case "wait":
      return open ? (
        <>
          <circle r="5.5" fill="var(--held)" stroke="var(--on-held)" strokeWidth="1" />
          <path d="M-1.6 -2.4v4.8M1.6 -2.4v4.8" stroke="var(--on-held)" strokeWidth="1.2" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle r="5" fill="var(--sheet)" stroke="var(--muted)" strokeWidth="1.5" />
          <path d="M-1.5 -2v4M1.5 -2v4" stroke="var(--muted)" strokeWidth="1.2" strokeLinecap="round" />
        </>
      );
    case "fail":
      return (
        <>
          <circle r="5.5" fill="var(--fail)" />
          <path d="M-2.2 -2.2l4.4 4.4M2.2 -2.2l-4.4 4.4" stroke="var(--sheet)" strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
    // Ink: the diamond's shape says what it is; orange is kept for the stuck state alone.
    case "blow":
      return <path d="M0 -5.5L5.5 0L0 5.5L-5.5 0Z" fill="var(--ink)" stroke="var(--sheet)" strokeWidth="1" />;
    // A block of lines' two interchange marks (map SessionBlock): a ring for a file both edited, a ring with a centre dot
    // for a message.
    case "message":
      return (
        <>
          <circle r={RING_R} fill="var(--sheet)" stroke="var(--ink)" strokeWidth="2" />
          <circle r="2" fill="var(--ink)" />
        </>
      );
    case "file":
      return <circle r={RING_R} fill="var(--sheet)" stroke="var(--ink)" strokeWidth="2" />;
  }
}

/** What a mark says on hover: its moment, or for several interchanges their span and the latest three. */
function markTitle(m: Mark): string {
  if (m.items.length === 1) return `${clock(m.t)} ${m.text}`;
  const first = m.items[0]!;
  const latest = m.items.slice(-3).map((it) => `${clock(it.t)} ${it.text}`);
  const earlier = m.items.length - latest.length;
  return [`${m.text}, ${clock(first.t)} to ${clock(m.t)}`, ...latest, ...(earlier ? [`and ${earlier} earlier, in the session's events`] : [])].join("\n");
}

/** A place taken on the plot: its x, the rows it spans, its half width, and the clear space it keeps. */
interface Slot {
  x: number;
  lo: number;
  hi: number;
  hw: number;
  gap: number;
}

/** Where a mark may sit: on its own line, and for an interchange on the stretch both its lines share. */
function stretchOf(m: Mark, rows: readonly TraceRow[], x: X, ends: readonly number[]): [number, number] {
  let min = x(rows[m.row]!.start);
  let max = ends[m.row]!;
  if (m.to !== null) {
    const a = Math.max(min, x(rows[m.to]!.start));
    const b = Math.min(max, ends[m.to]!);
    if (a <= b) [min, max] = [a, b];
  }
  return [min, max];
}

/**
 * Where each mark is drawn: at its time, or the nearest place either side that keeps it one ring diameter clear of every mark
 * already placed on the rows it spans (an interchange spans every row between its two ends) and off the stations at the
 * lines' ends, so no two marks overprint. It stays on its own line, and an interchange on the stretch both its lines share.
 * Open asks are placed first, then the rest in time order. Only when a line is too short to hold its marks apart do they meet.
 */
function placeMarks(marks: readonly Mark[], rows: readonly TraceRow[], x: X, ends: readonly number[]): number[] {
  const taken: Slot[] = ends.map((e, i) => ({ x: e, lo: i, hi: i, hw: STATION_HW, gap: 2 }));
  const placed = new Array<number>(marks.length);
  const order = marks.map((_, i) => i).sort((a, b) => Number(!!marks[b]!.open) - Number(!!marks[a]!.open) || marks[a]!.t - marks[b]!.t);
  for (const i of order) {
    const m = marks[i]!;
    const lo = Math.min(m.row, m.to ?? m.row);
    const hi = Math.max(m.row, m.to ?? m.row);
    const [min, max] = stretchOf(m, rows, x, ends);
    const hw = footprint(m);
    const near = taken.filter((s) => s.lo <= hi && lo <= s.hi);
    const clear = (at: number) => near.every((s) => Math.abs(at - s.x) >= s.hw + hw + s.gap - 0.01);
    const want = Math.min(max, Math.max(min, x(m.t)));
    let best = want;
    if (!clear(want)) {
      const free = near.flatMap((s) => [s.x - s.hw - hw - s.gap, s.x + s.hw + hw + s.gap]).filter((c) => c >= min && c <= max && clear(c));
      if (free.length) best = free.reduce((p, c) => (Math.abs(c - want) < Math.abs(p - want) ? c : p));
    }
    taken.push({ x: best, lo, hi, hw, gap: GAP });
    placed[i] = best;
  }
  return placed;
}

/** The row a mark opens: its own when that is an agent's, else the agent at its other end; the main loop's opens nothing. */
function markRow(m: Mark, rows: readonly TraceRow[]): number | null {
  if (rows[m.row]!.agent) return m.row;
  return m.to !== null && rows[m.to]!.agent ? m.to : null;
}

/**
 * A mark as drawn: one shape on its own row (`m.row`: an interchange's sender, or the loop that reported a shared file), where
 * it sits, the other rows its link reaches, and what it stands for.
 */
interface Drawn {
  /** The mark, or for several merged, one standing for them all: the last one's place and row, every item. */
  m: Mark;
  /** The marks it stands for: itself, or every one merged into it. */
  parts: readonly Mark[];
  x: number;
  /** The far-end rows of its messages and shared files; the link ends on each one's line, with no ring there. */
  links: number[];
}

/** The two kinds that call for attention: never merged into another mark, and painted over the rest, failures topmost. */
const ALONE: ReadonlySet<MarkKind> = new Set<MarkKind>(["ask", "fail"]);

/** A mark's look: an ask or wait held open or not, else its kind's own; "mixed" for several kinds at once. */
type Look = Exclude<LegendKey, "count" | "now">;

function lookOf(m: Mark): Look {
  if (m.kind === "ask" || m.kind === "wait") return m.open ? "held" : "waited";
  return m.kind;
}

/** A drawn mark's look: the one look its marks share, or "mixed" when they differ. */
function lookAt(d: Drawn): Look {
  const looks = new Set(d.parts.map(lookOf));
  return looks.size === 1 ? [...looks][0]! : "mixed";
}

/** A look drawn as on the line; several kinds merged are one ink disc, which no single kind draws. */
function LookShape({ look }: { look: Look }) {
  if (look === "held") return <MarkShape kind="ask" open />;
  if (look === "waited") return <MarkShape kind="wait" />;
  if (look === "mixed") return <circle r="5.5" fill="var(--ink)" stroke="var(--sheet)" strokeWidth="1" />;
  return <MarkShape kind={look} />;
}

/** The kinds a merged mark lists on hover, in this order, each with its words for one and several. */
const KIND_WORDS: readonly [MarkKind, string, string][] = [
  ["wait", "Wait on you", "Waits on you"],
  ["blow", "Auto-compact", "Auto-compacts"],
  ["message", "Message", "Messages"],
  ["file", "File both edited", "Files both edited"],
];

/** What a drawn mark says on hover: one mark's own words; for several merged, their span and, kind by kind, the latest three. */
function drawnTitle(d: Drawn): string {
  if (d.parts.length === 1) return markTitle(d.m);
  const { items } = d.m;
  const lines = [`${plural(items.length, "mark", "marks")} too close to draw apart, ${clock(items[0]!.t)} to ${clock(items[items.length - 1]!.t)}`];
  for (const [kind, one, many] of KIND_WORDS) {
    const its = d.parts.filter((p) => p.kind === kind).flatMap((p) => p.items).sort((a, b) => a.t - b.t);
    if (its.length === 0) continue;
    const latest = its.slice(-3);
    lines.push(`${its.length === 1 ? one : many} (${its.length}):`, ...latest.map((it) => `${clock(it.t)} ${it.text}`));
    if (its.length > latest.length) lines.push(`and ${its.length - latest.length} earlier, in the session's events`);
  }
  return lines.join("\n");
}

/**
 * One row's group of marks as one: drawn at its last mark, standing for every item, and linked only to the other rows its
 * messages and shared files reach (an auto-compact or a wait in it adds no link).
 */
function merged(group: readonly Drawn[]): Drawn {
  const last = group[group.length - 1]!;
  if (group.length === 1) return last;
  const items = group.flatMap((d) => d.m.items).sort((a, b) => a.t - b.t);
  const links = [...new Set(group.flatMap((d) => d.links))];
  return { m: { ...last.m, key: group.map((d) => d.m.key).join("+"), items }, parts: group.flatMap((d) => d.parts), x: last.x, links };
}

/**
 * Every mark where `placeMarks` put it, with the marks it could not hold apart (a line too short for them) merged, except asks
 * and failures, which stand alone and paint over the rest. Every mark draws one shape, on its own row. A row's asks, failures
 * and end station keep their places, and any other mark within one mark's width of one is first moved just clear before it.
 * The row's other marks are then taken in one sweep along the row (time order, as placed): a mark joins the group before it
 * when it is closer than one mark's width to that group's last mark, else it starts a new group, and each group is drawn at
 * its last mark, so no two marks drawn on a row are closer than a mark's width and none sits under an ask, a failure or the
 * station. A group of several shows their count (the legend's "merged").
 */
function drawnMarks(marks: readonly Mark[], rows: readonly TraceRow[], x: X, ends: readonly number[]): Drawn[] {
  const xs = placeMarks(marks, rows, x, ends);
  const out: Drawn[] = [];
  const byRow = new Map<number, Drawn[]>();
  // What keeps its place on each row: its end station, and its asks and failures (never merged, painted on top).
  const fixed = new Map<number, { x: number; hw: number }[]>(ends.map((e, r) => [r, [{ x: e, hw: STATION_HW }]]));
  marks.forEach((m, i) => {
    const d: Drawn = { m, parts: [m], x: xs[i]!, links: m.to === null ? [] : [m.to] };
    if (ALONE.has(m.kind)) {
      out.push(d);
      fixed.get(m.row)?.push({ x: d.x, hw: MARK_HW });
    } else byRow.set(m.row, [...(byRow.get(m.row) ?? []), d]);
  });
  for (const [row, list] of byRow) {
    // A mark within reach of one is drawn just clear before it (right to left, so it also clears the next), never before its
    // own stretch; its hover keeps its true time. Only a line too short for both leaves them touching (zoom in to separate).
    const occupants = (fixed.get(row) ?? []).sort((a, b) => b.x - a.x);
    for (const d of list) {
      const [min] = stretchOf(d.m, rows, x, ends);
      for (const o of occupants) if (Math.abs(d.x - o.x) < o.hw + MARK_HW) d.x = Math.max(min, o.x - o.hw - MARK_HW);
    }
    let group: Drawn[] = [];
    for (const d of list.sort((a, b) => a.x - b.x || a.m.t - b.m.t)) {
      if (group.length > 0 && d.x - group[group.length - 1]!.x >= MARK_HW * 2) {
        out.push(merged(group));
        group = [];
      }
      group.push(d);
    }
    if (group.length > 0) out.push(merged(group));
  }
  return out;
}

/**
 * Marks on the lines, one shape each on its own row: an interchange's ring is its sender's (or the loop that reported the
 * shared file), and its thin link runs to the other loop's line and ends there, faint until a row at either end is hovered,
 * focused or picked. One that stands for several carries their count over itself. Each mark names itself,
 * both ends included, on hover.
 */
function Marks({ drawn, rows, lit, onRow }: { drawn: readonly Drawn[]; rows: readonly TraceRow[]; lit: (row: number) => boolean; onRow: (row: number) => void }) {
  const y = (row: number) => row * PITCH + PITCH / 2;
  return (
    <>
      {drawn.map((d) => {
        const { m } = d;
        const cx = d.x.toFixed(1);
        const reach = [m.row, ...d.links];
        const top = Math.min(...reach);
        const bottom = Math.max(...reach);
        const opens = markRow(m, rows);
        return (
          <g key={m.key} className={opens === null ? "sv-mk" : "sv-mk opens"} onClick={opens === null ? undefined : () => onRow(opens)}>
            <title>{drawnTitle(d)}</title>
            {top !== bottom ? <path className={reach.some(lit) ? "sv-join is-hot" : "sv-join"} d={`M${cx} ${y(top)}V${y(bottom)}`} /> : null}
            <g transform={`translate(${cx} ${y(m.row)})`}>
              <LookShape look={lookAt(d)} />
            </g>
            {m.items.length > 1 ? (
              <text className="sv-mk-n" x={cx} y={y(m.row) - COUNT_LIFT} textAnchor="middle">
                {m.items.length}
              </text>
            ) : null}
          </g>
        );
      })}
    </>
  );
}

/** A live line's body takes its row's state colour (stuck, needs you, idle, failed), else the working hue; an ended line is grey. */
const LINE_TONE: Partial<Record<TraceRow["station"], string>> = { stuck: "stuck", "needs-you": "held", idle: "idle", failed: "fail" };

const lineTone = (r: TraceRow): string | null => (r.finished || r.queued ? "fin" : (LINE_TONE[r.station] ?? null));

/** Every line in tree order, so a branch is drawn over the line it leaves. */
function Lines({ rows, x }: { rows: readonly TraceRow[]; x: X }) {
  return (
    <>
      {rows.map((r, i) => {
        // An ended line (done, failed or stopped) at half a live one's weight, so many finished lanes never bury the live ones.
        const width = (r.parent === null ? 6 : 4) / (r.finished ? 2 : 1);
        const cls = ["sv-line", lineTone(r), r.parent === null ? "main" : null, r.queued ? "queued" : null].filter(Boolean).join(" ");
        return <path key={r.id} className={cls} strokeWidth={width} d={linePath(r, i, rows, x)} />;
      })}
    </>
  );
}

/** Each line's end station, over the lines and the interchanges' links, so neither crosses one. */
function Stations({ rows, ends }: { rows: readonly TraceRow[]; ends: readonly number[] }) {
  return (
    <>
      {rows.map((r, i) => (
        <g key={`end-${r.id}`} className="sv-end" transform={`translate(${ends[i]!.toFixed(1)} ${i * PITCH + PITCH / 2})`}>
          <circle r="7.5" fill="var(--sheet)" />
          <g transform="translate(-8 -8)">
            <Station kind={r.station} />
          </g>
        </g>
      ))}
    </>
  );
}

interface PlotProps {
  trace: Trace;
  /** The marks as drawn, and each line's end, at the view's scale (the legend reads the same marks). */
  drawn: readonly Drawn[];
  ends: readonly number[];
  view: TimeView;
  width: number;
  now: number;
  selected: string | null;
  flash: string | null;
  /** The row under the pointer or the keyboard, which raises the links at it. */
  hot: string | null;
  onHot: (id: string, on: boolean) => void;
  onRow: (row: number) => void;
}

/** Paint order: every mark that may merge under the stations (so no link crosses one), then asks, then failures topmost. */
const layerOf = (d: Drawn) => (d.m.kind === "fail" ? 2 : d.m.kind === "ask" ? 1 : 0);

/**
 * The plot: the axis band with the clock times in view (they follow the zoom) and their grid lines, a band per row that opens
 * its agent, the lines, the marks that may merge, the stations, the asks and the failures, and, while the session is live, a
 * rule at now.
 */
function Plot({ trace, drawn, ends, view, width, now, selected, flash, hot, onHot, onRow }: PlotProps) {
  const { rows } = trace;
  const { x } = view;
  const height = AXIS_H + TOP + rows.length * PITCH;
  const lit = (row: number) => rows[row]!.id === hot || rows[row]!.id === selected;
  const layer = (n: number) => <Marks drawn={drawn.filter((d) => layerOf(d) === n)} rows={rows} lit={lit} onRow={onRow} />;
  const ticks = axisTicks(view.from, view.to, width);
  const nowX = trace.live ? x(now) : null;
  return (
    <>
      {ticks.map((tk) => {
        const tx = x(tk.t);
        const fits = tx + 4 + tk.label.length * TICK_CH <= width;
        return (
          <g key={tk.t}>
            <line className="sv-grid" x1={tx} x2={tx} y1={AXIS_H - 4} y2={height} />
            {fits ? (
              <text className="sv-tick" x={tx + 4} y={AXIS_H / 2}>
                {tk.label}
              </text>
            ) : null}
          </g>
        );
      })}
      <line className="sv-axis-rule" x1="0" x2={width} y1={AXIS_H - 0.5} y2={AXIS_H - 0.5} />
      <g transform={`translate(0 ${AXIS_H + TOP})`}>
        {rows.map((r, i) => {
          const cls = ["sv-band", r.agent ? "opens" : null, selected === r.id ? "on" : null, flash === r.id ? "flash" : null].filter(Boolean).join(" ");
          return (
            <rect
              key={r.id}
              className={cls}
              x="0"
              y={i * PITCH}
              width={width}
              height={PITCH}
              onClick={r.agent ? () => onRow(i) : undefined}
              onPointerEnter={() => onHot(r.id, true)}
              onPointerLeave={() => onHot(r.id, false)}
            />
          );
        })}
        <Lines rows={rows} x={x} />
        {layer(0)}
        <Stations rows={rows} ends={ends} />
        {layer(1)}
        {layer(2)}
      </g>
      {nowX !== null && nowX >= 0 && nowX <= width ? <line className="sv-now" x1={nowX} x2={nowX} y1={AXIS_H - 4} y2={height} /> : null}
    </>
  );
}

/** What a row says to a screen reader: who, its state, when it ran, and what happened on its line. */
function rowLabel(r: TraceRow, marks: readonly Mark[], i: number, now: number): string {
  const on = marks
    .filter((m) => m.row === i || m.to === i)
    .map((m) => (m.items.length === 1 ? `${clock(m.t)} ${m.text}` : `${m.text}, the latest at ${clock(m.t)}: ${m.items[m.items.length - 1]!.text}`));
  const ran = `started ${clock(r.start)}, ${fmtSpan(rowSeconds(r, now))}`;
  return [`${r.name}, ${r.kindText}, ${r.model}, ${r.word}`, ran, ...on].join(". ");
}

/** Every look a mark can have on the drawing: an open ask (held), a past ask or wait, the rest by kind, a count, and now. */
type LegendKey = "held" | "waited" | Exclude<MarkKind, "ask" | "wait"> | "mixed" | "count" | "now";

/** The legend's entries in a fixed order, so an entry never moves when another appears: a short word, and what it means on hover. */
const LEGEND: readonly { key: LegendKey; words: string; title: string }[] = [
  { key: "held", words: "waits on you", title: "An ask or wait still open" },
  { key: "waited", words: "waited on you", title: "An ask or wait since answered or ended" },
  { key: "fail", words: "failed", title: "Where the loop failed" },
  { key: "blow", words: "auto-compact", title: "Where the context window was auto-compacted" },
  { key: "message", words: "message", title: "A message between the two loops it links" },
  { key: "file", words: "file both edited", title: "A file edited by both loops it links" },
  { key: "mixed", words: "mixed", title: "Several kinds of mark too close to draw apart; hover it to list them" },
  { key: "count", words: "merged", title: "The number of marks merged into one" },
  { key: "now", words: "now", title: "The current time" },
];

/** The looks the drawing uses, read from the marks as drawn: each one's look, the count when one stands for several, and now while it is live. */
function legendKeys(drawn: readonly Drawn[], live: boolean): Set<LegendKey> {
  const keys = new Set<LegendKey>();
  for (const d of drawn) {
    keys.add(lookAt(d));
    if (d.m.items.length > 1) keys.add("count");
  }
  if (live) keys.add("now");
  return keys;
}

/** A legend entry's mark, drawn as on the line; the count as it sits over its ring; now as its rule. */
function LegendMark({ k }: { k: LegendKey }) {
  if (k === "now") {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <line className="sv-now" x1="8" x2="8" y1="1" y2="15" />
      </svg>
    );
  }
  if (k === "count") {
    return (
      <b className="sv-legend-n" aria-hidden="true">
        2
      </b>
    );
  }
  return (
    <svg viewBox="-8 -8 16 16" width="16" height="16" aria-hidden="true">
      <LookShape look={k} />
    </svg>
  );
}

/** The legend, on its own row under the toolbar: every look a mark has on the drawing, each drawn as on the line, and nothing it does not draw. */
function Legend({ drawn, live }: { drawn: readonly Drawn[]; live: boolean }) {
  const keys = legendKeys(drawn, live);
  if (keys.size === 0) return null;
  return (
    <ul className="sv-legend" aria-label="Marks on the lines">
      {LEGEND.filter((e) => keys.has(e.key)).map((e) => (
        <li key={e.key} title={e.title}>
          <LegendMark k={e.key} />
          {e.words}
        </li>
      ))}
    </ul>
  );
}

/** How the drawing moves, said on every view control. */
const MOVE_HINT = "Drag or scroll sideways to move in time; pinch, or scroll with Ctrl or ⌘, to zoom.";

interface DrawingProps {
  trace: Trace;
  anchor: number;
  now: number;
  selected: string | null;
  flash: string | null;
  onAgent: (id: string) => void;
  /** The toolbar row's first and last controls: the Timeline ⇄ Agents switch, and the order among siblings. */
  lead?: ReactNode;
  order: ReactNode;
}

/** The time-axis drawing: one toolbar row (the switch, the view's controls, the order), the legend under it, then the loops down the left and their lines on the shared axis. */
function TraceDrawing({ trace, anchor, now, selected, flash, onAgent, lead, order }: DrawingProps) {
  const [plotRef, width] = useWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const view = useTimeView(svgRef, width, anchor, trace);
  const flashRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (flash) flashRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [flash]);
  const [hot, setHot] = useState<string | null>(null);
  const onHot = useCallback((id: string, on: boolean) => setHot((was) => (on ? id : was === id ? null : was)), []);
  const { rows, marks } = trace;
  const height = AXIS_H + TOP + rows.length * PITCH;
  // Where the marks fall at this scale, merged where they would overprint; the plot draws them and the legend names them.
  const ends = rows.map((r) => Math.max(view.x(r.start), view.x(r.end)));
  const drawn = width > 0 ? drawnMarks(marks, rows, view.x, ends) : [];
  const onRow = (i: number) => {
    const r = rows[i];
    if (r?.agent) onAgent(r.id);
  };
  return (
    <>
      <div className="sv-bar">
        {lead}
        <div className="sv-tl-view" role="group" aria-label="Time shown">
          <button type="button" className="ui-button" aria-label="Zoom out" title={`Zoom out. ${MOVE_HINT}`} onClick={() => view.zoomBy(1 / ZOOM_STEP)}>
            −
          </button>
          <button type="button" className="ui-button" aria-label="Zoom in" title={`Zoom in. ${MOVE_HINT}`} onClick={() => view.zoomBy(ZOOM_STEP)}>
            +
          </button>
          <button type="button" className="ui-button" title={`Show the whole session. ${MOVE_HINT}`} onClick={view.fit}>
            Fit
          </button>
          {trace.live ? (
            <button type="button" className="ui-button" title={`Jump to now. ${MOVE_HINT}`} onClick={view.goNow}>
              Now
            </button>
          ) : null}
        </div>
        {order}
      </div>
      <Legend drawn={drawn} live={trace.live} />
      <div className="sv-tl">
        <div className="sv-tl-labels">
          <div className="sv-tl-lhead" style={{ height: AXIS_H }}>
            <span>Loop</span>
            <span>State and time</span>
          </div>
          <ol className="sv-tl-rows" aria-label="Loops of this session, in tree order" style={{ paddingTop: TOP }}>
            {rows.map((r, i) => {
              const body = (
                <>
                  <span className="sv-tl-name" title={dotsText([r.name, r.kindText, r.model])}>
                    <b>{r.name}</b>
                    <em>{r.kindText}</em>
                  </span>
                  <span className="sv-tl-meta">
                    <StationWord kind={r.station} word={r.word} />
                    <span className="sv-num">{fmtSpan(rowSeconds(r, now))}</span>
                  </span>
                </>
              );
              const indent = { paddingLeft: `${8 + Math.min(r.depth, 6) * 12}px` };
              return (
                <li key={r.id}>
                  <button
                    ref={flash === r.id ? flashRef : undefined}
                    type="button"
                    className={`sv-tl-row${r.agent ? "" : " main"}${flash === r.id ? " flash" : ""}`}
                    style={indent}
                    aria-current={selected === r.id ? "true" : undefined}
                    aria-label={rowLabel(r, marks, i, now)}
                    onClick={() => onAgent(r.id)}
                    onPointerEnter={() => onHot(r.id, true)}
                    onPointerLeave={() => onHot(r.id, false)}
                    onFocus={() => onHot(r.id, true)}
                    onBlur={() => onHot(r.id, false)}
                  >
                    {body}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="sv-tl-plot" ref={plotRef} aria-hidden="true">
          <svg ref={svgRef} className="sv-plot" width={width} height={height} viewBox={width > 0 ? `0 0 ${width} ${height}` : undefined} focusable="false">
            {width > 0 ? <Plot trace={trace} drawn={drawn} ends={ends} view={view} width={width} now={now} selected={selected} flash={flash} hot={hot} onHot={onHot} onRow={onRow} /> : null}
          </svg>
        </div>
      </div>
    </>
  );
}

/** This session's events in words, newest first, a page at a time; a row about an agent on the trace opens that agent. */
function EventList({ events, state, rowNames, onAgent }: { events: readonly ActivityView[]; state: Omit<SessionEvents, "events">; rowNames: ReadonlyMap<string, string>; onAgent: (id: string) => void }) {
  const [shown, setShown] = useState(EVENTS_PAGE);
  const page = events.slice(0, shown);
  let note: string | null = null;
  if (state.loading && events.length === 0) note = "Loading…";
  else if (state.failed) note = "Stored events could not be read.";
  if (!note && events.length === 0) return null;
  return (
    <section className="sv-events" aria-labelledby="sv-events-h">
      <div className="sv-sh">
        <h3 id="sv-events-h">Events</h3>
        <span className="sv-muted">newest first</span>
      </div>
      {note ? <p className="ui-empty">{note}</p> : null}
      {page.length ? (
        <ol className="sv-evlist">
          {page.map((e) => {
            // The main loop's events carry no agent id and open nothing here; its row on the trace shows its detail.
            const key = e.agentId ?? ORCHESTRATOR_ROW;
            const loop = rowNames.get(key);
            const body = (
              <>
                <time className="sv-num">{fmtClock(e.t)}</time>
                <span className="sv-evloop">{loop ?? "an agent no longer listed"}</span>
                <span className="sv-evtext">{eventWords(e)}</span>
              </>
            );
            return (
              <li key={e.id} className={e.kind === "fail" ? "bad" : undefined}>
                {loop === undefined || e.agentId === null ? (
                  <div className="sv-ev">{body}</div>
                ) : (
                  <button type="button" className="sv-ev" onClick={() => onAgent(key)}>
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
      <div className="sv-more">
        <span className="sv-muted">{`Showing ${page.length} of ${events.length}${state.cut ? ", the newest stored events" : ""}`}</span>
        {shown > EVENTS_PAGE ? (
          <button type="button" className="ui-button" onClick={() => setShown(EVENTS_PAGE)}>
            Show fewer
          </button>
        ) : null}
        {events.length > shown ? (
          <button type="button" className="ui-button" onClick={() => setShown(shown + EVENTS_PAGE)}>
            {`Show ${Math.min(EVENTS_PAGE, events.length - shown)} more`}
          </button>
        ) : null}
      </div>
    </section>
  );
}

interface TimelineProps {
  s: SessionView;
  now: number;
  events: SessionEvents;
  /** List the events in words below the drawing: on a stored page only, as the inspector lists a live session's. */
  eventList: boolean;
  sort: AgentSort;
  onSort: (sort: AgentSort) => void;
  /** The row whose detail the inspector shows (an agent, or the main loop as ORCHESTRATOR_ROW), and showing one. */
  selected: string | null;
  /** An agent to mark for a moment and bring into view, scrolling only as far as needed (one picked from outside the page). */
  flash?: string | null;
  onAgent: (id: string) => void;
  /** What leads the toolbar row: the page's Timeline ⇄ Agents switch. */
  lead?: ReactNode;
}

export function Timeline({ s, now, events, eventList, sort, onSort, selected, flash = null, onAgent, lead }: TimelineProps) {
  const trace = useMemo(() => buildTrace(s, now, sort, events.events), [s, now, sort, events.events]);
  const { rows } = trace;
  const rowNames = useMemo(() => new Map(rows.map((r) => [r.id, r.parent === null ? `${r.name} (main loop)` : r.name])), [rows]);
  const pickSort = (value: string) => {
    if (value === "launch") onSort({ key: null, dir: 1 });
    else onSort({ key: value as AgentSortKey, dir: defaultAgentDir(value as AgentSortKey) });
  };
  const order = (
    <label className="sv-field sv-order">
      <span>Order siblings by</span>
      <select className="ui-select" value={sort.key ?? "launch"} onChange={(e) => pickSort(e.target.value)}>
        <option value="launch">Launch time</option>
        {(Object.keys(AGENT_SORT_LABELS) as AgentSortKey[]).map((k) => (
          <option key={k} value={k}>
            {AGENT_SORT_LABELS[k]}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="sv-trace">
      <TraceDrawing trace={trace} anchor={s.startedAt} now={now} selected={selected} flash={flash} onAgent={onAgent} lead={lead} order={order} />
      {eventList ? <EventList events={events.events} state={events} rowNames={rowNames} onAgent={onAgent} /> : null}
    </div>
  );
}
