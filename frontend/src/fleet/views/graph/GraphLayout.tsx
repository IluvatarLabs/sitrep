// The Fleet's Graph layout: the connected graph, drawn in SVG from model.ts. Lines are static, with no particles;
// messages are faint dotted curves bent toward the centre. Pan, zoom and Fit come from d3-zoom: a drag pans, the wheel
// scrolls, Ctrl or ⌘ with the wheel (or a pinch) zooms, and + − 0 work while the graph has focus. Up to 100 % marks scale with
// the drawing; past it they keep their size. Labels keep their own size on screen down to the scale the graph was laid out for
// (model.ts layoutGraph, where each label's room is that size) and scale with the drawing below it, where only a zoom out
// takes them (Fit never does), so no label is ever under another node or label. Zooming in draws more: each richer form of a
// label (an agent's or fold's name, a session's second line, a name uncut) from the zoom model.ts zooms found it room at.
// Until the owner moves the view it is the Graph's: the graph is laid out afresh and fitted for a new pane size or a fleet the
// layout no longer holds, refitted when the filter changes, and refitted for a session or agent coming or going only when it
// would otherwise lie outside the pane. Once the owner zooms or pans, the view is theirs: a pane change or an arrival keeps the
// layout and the view as they are (a new node placed into the layout) until they press Fit, which lays the graph out afresh
// for the pane and fleet as they are if the layout no longer holds, and fits. A new grouping, their own act, lays out afresh.
import { select } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { hashFor } from "../../../route";
import { osLogo } from "../../components/Icons";
import { machineLabels } from "../../groups";
import { providerInfo } from "../../provider";
import { respondGate } from "../../respond";
import { useInspector } from "../../shell/inspector";
import { stationColor } from "../../ui/Station";
import { useRespond } from "../../useRespond";
import type { GraphLayoutProps } from "./index";
import { buildGraph, CLASH_D, formsOf, holds, labelOf, labelSize, layoutGraph, layoutKey, LOGO, MAX_K, MIN_K, PAD, sideBox, textW, TOP, type Form, type GraphNode, type Layout, type Mark, type Side } from "./model";
import "./graph.css";

const STEP_K = 1.25;
/**
 * How long the pane must hold a new size before the graph is laid out for it. Through a drag the browser reports the size once
 * a frame (ResizeObserver: 17 ms apart at 60 Hz, 48 ms at the most when a frame ran long), so 200 ms of quiet means the drag
 * has stopped, and the layout still follows the release at once to the eye.
 */
const SETTLE_MS = 200;

/** Each state's glyph on its filled disc, on a 16 grid (radius 8): Station's shapes cut in the ground; working is the disc. */
const GLYPH: Readonly<Record<Mark, ReactNode>> = {
  working: null,
  "needs-you": <path className="is-held" d="M6 4.6v6.8M10 4.6v6.8" />,
  idle: <circle className="is-hole" cx="8" cy="8" r="3.6" />,
  stuck: <path d="M8 4.4V8l2.4 1.6" />,
  failed: <path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" />,
  done: <path d="M4.6 8.3l2.3 2.3 4.6-4.9" />,
  queued: <circle cx="8" cy="8" r="4" strokeDasharray="2.8 1.6" />,
  stopped: <path d="M5 11l6-6" />,
};

/** A node's mark: a hub's ring with its OS logo, a fold's ring with a plus, a loop's disc filled by its state with its glyph. */
function MarkOf({ n, R }: { n: GraphNode; R: number }) {
  if (n.kind === "hub")
    return (
      <>
        <circle className="gn-hub" r={R} />
        {n.os !== undefined ? (
          <svg className="gn-logo" x={-0.55 * R} y={-0.55 * R} width={1.1 * R} height={1.1 * R}>
            {osLogo(n.os)}
          </svg>
        ) : null}
      </>
    );
  if (n.kind === "fold")
    return (
      <>
        <circle className="gn-fold" r={R} />
        <path className="gn-fold-sign" d="M-3.5 0H3.5M0 -3.5V3.5" />
      </>
    );
  const m = n.mark ?? "done";
  return (
    <>
      <circle className={m === "working" ? "gn-disc station-working" : m === "needs-you" ? "gn-disc is-held" : "gn-disc"} r={R} fill={stationColor(m)} />
      <g className="gn-glyph" transform={`scale(${R / 8}) translate(-8 -8)`}>
        {GLYPH[m]}
      </g>
    </>
  );
}

/** The label on its side: the name, then `[logo] model · state · time` muted, line 1 anchored to the box's edge toward the
 * node and line 2 placed by its estimated width; drawn at `r` times its size, its box `lo` out as the layout sets it. */
function Label({ n, side, lo, form, r }: { n: GraphNode; side: Side; lo: number; form: Form; r: number }) {
  const { name, sub } = labelOf(n, form);
  const [w, h] = labelSize(n, form);
  const [x, y] = sideBox(side, lo, w * r, h * r);
  const anchor = side === "t" || side === "b" ? "middle" : side.startsWith("r") ? "start" : "end";
  const at = anchor === "start" ? 0 : anchor === "end" ? 1 : 0.5;
  const Logo = n.provider ? providerInfo(n.provider).Logo : null;
  const x2 = (w - (sub ? textW(sub, 13) + (Logo ? LOGO : 0) : 0)) * at;
  // The ground behind each line, its row's full height and as wide as the layout's estimate of it (textW, as labelSize sizes
  // it): the name where it is drawn, then the logo and second line from 3 px left of x2 (a logo has no halo), but never left of
  // the box's own edge; the two rows overlap by a pixel. The letters' halo (graph.css) covers what a font draws past the estimate.
  const nw = textW(name, n.kind === "fold" ? 13 : 14, n.kind !== "fold");
  const x3 = Math.max(0, x2 - 3);
  return (
    <g transform={`translate(${x} ${y})${r !== 1 ? ` scale(${r})` : ""}`}>
      <rect className="gn-knock" x={(w - nw) * at} width={nw} height={sub ? 21 : h} />
      {sub ? <rect className="gn-knock" x={x3} y={20} width={x2 - x3 + (Logo ? LOGO : 0) + textW(sub, 13)} height={h - 20} /> : null}
      <text className={n.kind === "fold" ? "gn-sub" : "gn-name"} x={w * at} y={n.kind === "fold" ? 14 : 15} textAnchor={anchor}>
        {name}
      </text>
      {sub ? (
        <>
          {Logo ? (
            <svg className="gn-logo" x={x2} y={23} width={13} height={13}>
              <Logo />
            </svg>
          ) : null}
          <text className="gn-sub" x={x2 + (Logo ? LOGO : 0)} y={34}>
            {sub}
          </text>
        </>
      ) : null}
    </g>
  );
}

/** Enter and Space act on a node drawn as a button, as on a button. */
const press = (act: () => void) => (e: KeyboardEvent) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  act();
};

export function GraphLayout({ sessions, fleet, now, group, query, onScope }: GraphLayoutProps) {
  const respond = useRespond();
  const { picked, pick } = useInspector();
  const labels = useMemo(() => machineLabels(Object.values(fleet.sessions)), [fleet.sessions]);
  const graph = useMemo(() => buildGraph(sessions, group, labels, now), [sessions, group, labels, now]);
  const drawn = sessions.length > 0;

  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const following = useRef(true);
  const last = useRef<{ group: GraphLayoutProps["group"]; layout: Layout } | null>(null);
  const fresh = useRef(false);
  const [view, setView] = useState<ZoomTransform>(zoomIdentity);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Bumped when Fit finds the layout no longer holds, to lay it out afresh.
  const [fits, setFits] = useState(0);
  const ready = size.w > 0 && size.h > 0;
  const key = layoutKey(graph);
  // Laid out again only when the node set or a label's room changes (layoutKey), the pane changes size or Fit asks; afresh for
  // a new grouping, and while the view is the Graph's whenever layoutGraph finds the last layout no longer holds.
  const layout = useMemo<Layout | null>(() => {
    if (!ready) return null;
    const out = layoutGraph(graph.nodes, size, last.current?.group === group ? last.current.layout : null, !following.current);
    fresh.current = out.fresh;
    last.current = { group, layout: out };
    return out;
  }, [key, ready, size.w, size.h, fits]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([MIN_K, MAX_K])
      .extent(() => [[0, 0], [el.clientWidth, el.clientHeight]])
      .clickDistance(4)
      // d3-zoom's own filter, but the wheel zooms only with Ctrl or ⌘ (a pinch arrives so), and a node keeps its double click.
      .filter((e: Event) => {
        if (e instanceof WheelEvent) return e.ctrlKey || e.metaKey;
        const m = e as MouseEvent;
        return !m.ctrlKey && !m.button && !(e.type === "dblclick" && e.target instanceof Element && e.target.closest(".gn"));
      })
      .on("zoom", (e: D3ZoomEvent<SVGSVGElement, unknown>) => {
        if (e.sourceEvent) following.current = false;
        setView(e.transform);
      });
    const sel = select(el).call(behavior);
    zoomRef.current = behavior;
    // A plain wheel scrolls the graph, sideways with Shift or a sideways swipe; the page never scrolls under it.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const unit = (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1) / zoomTransform(el).k;
      const [dx, dy] = e.shiftKey && e.deltaX === 0 ? [e.deltaY, 0] : [e.deltaX, e.deltaY];
      following.current = false;
      behavior.translateBy(sel, -dx * unit, -dy * unit);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    // The pane's first size is taken at once; a later one only when the pane has held it for SETTLE_MS, so dragging a window
    // edge lays the graph out once, when the drag stops, not on every frame the browser reports a size.
    let timer: number | undefined;
    let sized = false;
    const watch = new ResizeObserver(() => {
      const take = () => setSize({ w: el.clientWidth, h: el.clientHeight });
      window.clearTimeout(timer);
      if (sized) timer = window.setTimeout(take, SETTLE_MS);
      else {
        take();
        sized = el.clientWidth > 0 && el.clientHeight > 0;
      }
    });
    watch.observe(el);
    following.current = true;
    setView(zoomIdentity);
    return () => {
      el.removeEventListener("wheel", onWheel);
      sel.on(".zoom", null);
      watch.disconnect();
      window.clearTimeout(timer);
      zoomRef.current = null;
    };
  }, [drawn]);

  const fit = () => {
    const el = svgRef.current;
    if (!el || !zoomRef.current || !layout) return;
    const [x1, y1, x2, y2] = layout.extent;
    // Never below the layout's scale, where its labels have their room.
    const k = Math.max(layout.k, Math.min(1, (size.w - 2 * PAD) / (x2 - x1), (size.h - TOP - PAD) / (y2 - y1)));
    zoomRef.current.transform(select(el), zoomIdentity.translate((size.w - k * (x1 + x2)) / 2, (size.h + TOP - PAD - k * (y1 + y2)) / 2).scale(k));
  };
  // A fresh layout is fitted, its nodes being in new places (while the owner holds the view only a new grouping makes one); in
  // the Graph's view a new filter refits, and a session or agent coming or going refits only when it would otherwise lie
  // outside the pane.
  const seen = useRef(query);
  useEffect(() => {
    const el = svgRef.current;
    const [asked, anew] = [seen.current !== query, fresh.current];
    [seen.current, fresh.current] = [query, false];
    if (!el || !layout) return;
    if (anew) following.current = true;
    if (!following.current) return;
    const t = zoomTransform(el);
    const [[x1, y1], [x2, y2]] = [t.apply([layout.extent[0], layout.extent[1]]), t.apply([layout.extent[2], layout.extent[3]])];
    const inside = x1 >= PAD - 1 && y1 >= TOP - 1 && x2 <= size.w - PAD + 1 && y2 <= size.h - PAD + 1;
    if (anew || asked || !inside) fit();
    // On the layout and the filter only, not on every update.
  }, [layout, query]);
  const zoomBy = (f: number) => {
    if (!svgRef.current || !zoomRef.current) return;
    following.current = false;
    zoomRef.current.scaleBy(select(svgRef.current), f);
  };
  // Fit gives the view back to the Graph: a layout made for another pane, or one the fleet has outgrown, is laid out afresh first.
  const refit = () => {
    following.current = true;
    if (layout && !holds(layout, size)) setFits((n) => n + 1);
    else fit();
  };
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomBy(STEP_K);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / STEP_K);
    else if (e.key === "0") refit();
    else return;
    e.preventDefault();
  };
  // A node reached by Tab outside the view is moved in by the shortest pan, as a page scrolls a focused element into view.
  const onFocus = (e: FocusEvent<SVGSVGElement>) => {
    const id = e.target instanceof Element ? e.target.closest("[data-node]")?.getAttribute("data-node") : null;
    const p = id ? layout?.at.get(id) : undefined;
    if (!p || !svgRef.current || !zoomRef.current) return;
    const [x, y] = view.apply([p.x, p.y]);
    const into = (at: number, room: number) => (at < PAD ? PAD - at : at > room - PAD ? room - PAD - at : 0);
    const [dx, dy] = [into(x, size.w), into(y, size.h)];
    if (!dx && !dy) return;
    following.current = false;
    zoomRef.current.translateBy(select(svgRef.current), dx / view.k, dy / view.k);
  };

  // An amber node opens the answer panel, as a row's Answer does (useRespond().open); it focuses back on close, an SVG element
  // focusing as an HTML one does.
  const answer = (n: GraphNode, el: Element): boolean => {
    if (n.mark !== "needs-you" || !n.s || !respond || !respondGate(n.s, respond.me, respond.settingsOn).show) return false;
    respond.open(n.s.id, el as HTMLElement);
    return true;
  };
  const node = (n: GraphNode): ReactNode => {
    const p = layout?.at.get(n.id);
    if (!layout || !p) return null;
    const R = n.kind === "centre" ? layout.Rc : n.R;
    // The reserved form, or the richest whose zoom the view has reached (model.ts zooms).
    const form = p.more.reduce<Form | null>((f, m) => (m.z <= view.k + 1e-9 ? m.form : f), formsOf(n, layout.level).base);
    const scale = Math.min(1, 1 / view.k);
    const common = { "data-node": n.id, "data-kind": n.kind, transform: `translate(${p.x} ${p.y})${scale !== 1 ? ` scale(${scale})` : ""}` };
    if (n.kind === "centre")
      return (
        <g key={n.id} {...common} className="gn gn-centre" aria-hidden="true">
          <circle r={R} />
        </g>
      );
    const body = (
      <>
        <title>{n.title}</title>
        <MarkOf n={n} R={R} />
        <circle className="gn-ring" r={R + 4} />
        {n.clash ? <path className="gn-clash" transform={`translate(${-0.72 * (R + 5)} ${-0.72 * (R + 5)})`} d={CLASH_D} /> : null}
        {/* Its own size on screen down to the layout's scale, the drawing's below it. */}
        {form ? <Label n={n} side={p.side} lo={R + 6} form={form} r={1 / Math.min(1, Math.max(view.k, layout.k))} /> : null}
      </>
    );
    const { s, a, scope } = n;
    if (n.kind === "hub")
      return scope === undefined ? (
        <g key={n.id} {...common} className="gn gn-quiet">
          {body}
        </g>
      ) : (
        <g key={n.id} {...common} className="gn" role="button" tabIndex={0} aria-label={n.title} onClick={() => onScope(scope)} onKeyDown={press(() => onScope(scope))}>
          {body}
        </g>
      );
    if (!s) return null;
    if (n.kind === "agent" && a) {
      const act = (el: Element) => {
        if (!answer(n, el)) pick(s.id, a.id);
      };
      const on = picked?.sessionId === s.id && picked.agentId === a.id;
      return (
        <g key={n.id} {...common} className={on ? "gn is-picked" : "gn"} role="button" tabIndex={0} aria-label={n.title} aria-current={on || undefined} onClick={(e) => act(e.currentTarget)} onKeyDown={(e) => press(() => act(e.currentTarget))(e)}>
          {body}
        </g>
      );
    }
    // A session opens its page, an amber one the answer panel; a fold opens its session's page, where every agent is listed.
    return (
      <a key={n.id} {...common} className="gn" href={hashFor("session", s.id)} aria-label={n.title} onClick={(e) => answer(n, e.currentTarget) && e.preventDefault()}>
        {body}
      </a>
    );
  };

  if (!drawn) return null;
  const at = (id: string | null) => (id === null ? undefined : layout?.at.get(id));
  return (
    <div className="graph">
      <svg ref={svgRef} className="graph-svg" role="group" aria-label="Graph" tabIndex={0} onKeyDown={onKeyDown} onFocus={onFocus}>
        <g transform={view.toString()}>
          <g aria-hidden="true">
            {graph.messages.map(([x, y]) => {
              const [a, b] = [at(x), at(y)];
              return a && b ? <path key={`${x}\n\n${y}`} className="gm" d={`M${a.x} ${a.y}Q${0.325 * (a.x + b.x)} ${0.325 * (a.y + b.y)} ${b.x} ${b.y}`} /> : null;
            })}
            {graph.nodes.map((n) => {
              const [a, b] = [at(n.parent), at(n.id)];
              return a && b ? <line key={n.id} className={n.mark === "working" ? "ge is-on" : "ge"} x1={a.x} y1={a.y} x2={b.x} y2={b.y} /> : null;
            })}
          </g>
          {graph.nodes.map(node)}
        </g>
      </svg>
      <div className="graph-zoom" role="group" aria-label="Zoom">
        <button type="button" className="ui-button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(1 / STEP_K)} disabled={view.k <= MIN_K + 1e-6}>
          −
        </button>
        <span className="graph-pct" aria-hidden="true">
          {Math.round(view.k * 100)}%
        </span>
        <button type="button" className="ui-button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(STEP_K)} disabled={view.k >= MAX_K - 1e-6}>
          +
        </button>
        <button type="button" className="ui-button" title="Fit (0)" onClick={refit}>
          Fit
        </button>
      </div>
    </div>
  );
}
