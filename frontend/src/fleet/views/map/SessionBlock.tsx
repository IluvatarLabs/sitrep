// One session's block of lines: its line, its agents as stations on branches of it, and the interchanges inside it. A List row
// opens into one (`bare`: the row above already names the session). Three layers share one coordinate space: the lines (SVG,
// under), one row per station (HTML, so labels truncate, focus shows and every station is a real link or button), and the
// interchange rings (SVG, over, for their hover text). A station's label is its name and its state (ui/Dots between them);
// the rest (kind, model, time, who launched it, its interchanges) is its hover text, and keyboard focus shows the same text in
// a panel under the label. Under Expand all, grouped by Machine, a machine's rows lay their blocks out as one zone, and the
// rings joining two of its blocks are drawn over the rows, where the List placed each block (ZoneRings).
import { useCallback, useId, useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { hashFor } from "../../../route";
import { fmtSpan } from "../../format";
import { agentElapsedSec } from "../../logic";
import { providerInfo } from "../../provider";
import { respondGate } from "../../respond";
import { useInspector } from "../../shell/inspector";
import { Dots, dotsText } from "../../ui/Dots";
import { Station } from "../../ui/Station";
import { useRespond } from "../../useRespond";
import { watchSize } from "../../useWallColumns";
import { agentName, MAP, SHIFT_X, type MapChange, type MapRow, type MapSession, type MapZone } from "./layout";
import { agentWords, foldWords, kindWord, modelName, planStep, sessionWords, type StateWords } from "./words";
import "./map.css";

/** Stations set quiet: an agent that ended or waits to start. */
const QUIET: ReadonlySet<string> = new Set(["done", "aborted", "queued"]);

/** What a station shows (its name, unless a bare block's session row, and its state) and what it keeps for hover and focus. */
interface Said {
  name: string | null;
  state: StateWords;
  /** The state is set strong unless the station is quiet (done, stopped, queued). */
  strong: boolean;
  /** Its hover text and its focus panel: the facts the label leaves out, then who launched it and its interchanges. */
  facts: string[];
  more: string[];
}

function saidOf(r: MapRow, ms: MapSession, now: number, named: boolean): Said {
  const s = r.session;
  const a = r.agent;
  const links = r.links.map((l) => l.text);
  if (a === null) {
    const step = planStep(s);
    const facts = [providerInfo(s.provider).name, modelName(s.modelFamily, s.model), ms.working > 0 ? `${ms.working} ${ms.working === 1 ? "agent" : "agents"} working` : null, step].filter((f): f is string => !!f);
    return { name: named ? s.name : null, state: sessionWords(s, now), strong: true, facts, more: links };
  }
  const name = agentName(a);
  const model = modelName(a.modelFamily, a.model);
  const handle = a.name?.trim() && a.name.trim() !== name ? `${kindWord(a)} ${a.name.trim()}` : kindWord(a);
  const facts = [handle, model, fmtSpan(agentElapsedSec(a, now))].filter((f): f is string => !!f);
  return {
    name,
    state: agentWords(a, r.station, now),
    strong: !QUIET.has(r.station),
    facts,
    more: [`Agent of ${s.name}, launched by ${r.launchedBy}.`, ...links],
  };
}

/**
 * A station's control. While its loop asks and the answer can be given here (`answer`), it opens the answer; otherwise an
 * agent's station shows the agent in the inspector and the session's own station opens its page.
 */
function StationControl({ r, answer, title, label, describedBy, style, children }: { r: MapRow; answer: ((opener: HTMLElement) => void) | null; title: string; label: string; describedBy: string; style: CSSProperties; children: ReactNode }) {
  const { picked, pick } = useInspector();
  const s = r.session;
  const agent = r.agent;
  const common = { className: "map-ctl", title, "aria-label": label, "aria-describedby": describedBy, style };
  if (answer) {
    return (
      <button type="button" {...common} onClick={(e) => answer(e.currentTarget)}>
        {children}
      </button>
    );
  }
  if (agent) {
    const current = picked?.sessionId === s.id && picked.agentId === agent.id;
    return (
      <button type="button" {...common} aria-current={current ? "true" : undefined} onClick={() => pick(s.id, agent.id)}>
        {children}
      </button>
    );
  }
  return (
    <a {...common} href={hashFor("session", s.id)}>
      {children}
    </a>
  );
}

/** "+3 done · 2 failed" folds the session's ended agents away; "Hide 3 done · 2 failed" shows them folded again. Its words
 * give way to an ellipsis where the row runs out of room, the whole of them in its title. */
function FoldToggle({ ms, onToggle }: { ms: MapSession; onToggle: (id: string) => void }) {
  const s = ms.session;
  const words = ms.expanded ? `Hide ${foldWords(ms.finished, ms.failed)}` : `+${foldWords(ms.folded, ms.foldedFailed)}`;
  return (
    <button type="button" className="ui-button map-fold" aria-expanded={ms.expanded} title={words} onClick={() => onToggle(s.id)}>
      <span className="map-fold-words">{words}</span>
      <span className="ui-vh"> agents of {s.name}</span>
    </button>
  );
}

/** The station under the pointer or holding focus, by row key: its interchange connectors stand out. Views that do not track
 * it leave it out. */
export interface Hot {
  key: string | null;
  set: (key: string, on: boolean) => void;
}

/**
 * One station's row, one flex line that never wraps: the station's control (the lead-in and its mark; its overlay takes
 * clicks anywhere on the row, the standard stretched-link pattern), then the label's parts as items of that one line (the
 * name, the state word, the state's cause) and on the session's row the fold toggle, which sits above the overlay as a
 * control of its own. Every part that gives way is an item of the line itself, so the order holds: the cause first, then the
 * fold toggle's words, then the name, down to 8 characters; the state word never. The whole label is the control's
 * accessible name and hover text, and its focus panel.
 */
function StationRow({ r, ms, now, named, fold, onToggle, hot }: { r: MapRow; ms: MapSession; now: number; named: boolean; fold: boolean; onToggle: (id: string) => void; hot?: Hot }) {
  const descId = useId();
  const respond = useRespond();
  const s = r.session;
  const answer = r.asks && respond !== null && respondGate(s, respond.me, respond.settingsOn).show ? (opener: HTMLElement) => respond.open(s.id, opener) : null;
  const said = saidOf(r, ms, now, named);
  const more = answer ? [...said.more, "Opens the answer."] : said.more;
  const labelX = r.x - SHIFT_X + MAP.labelGap;
  const state = dotsText([said.state.word, said.state.cause]);
  const title = [dotsText([said.name, state]), dotsText(said.facts), ...more].filter(Boolean).join("\n");
  const tone = said.strong ? "map-strong" : undefined;
  const { picked } = useInspector();
  const quiet = r.agent ? QUIET.has(r.station) : r.station === "done";
  const current = r.agent !== null && picked?.sessionId === s.id && picked.agentId === r.agent.id;
  return (
    <div
      className={["map-row", quiet ? "map-quiet" : "", current ? "is-current" : ""].filter(Boolean).join(" ")}
      style={{ top: r.top, height: MAP.pitch, "--map-label-x": `${labelX}px` } as CSSProperties}
      onPointerEnter={() => hot?.set(r.key, true)}
      onPointerLeave={() => hot?.set(r.key, false)}
      onFocus={() => hot?.set(r.key, true)}
      onBlur={() => hot?.set(r.key, false)}
    >
      <StationControl r={r} answer={answer} title={title} label={[said.name, state].filter(Boolean).join(", ")} describedBy={descId} style={{ paddingLeft: labelX }}>
        <span className="map-mark" style={{ left: r.x - SHIFT_X - 8, top: MAP.lineY - 8 }}>
          <Station kind={r.station} />
        </span>
      </StationControl>
      {said.name ? (
        <span className="map-label-name map-strong" aria-hidden="true">
          {said.name}
        </span>
      ) : null}
      <span className="map-label-state" aria-hidden="true">
        {said.name ? <span className="map-sep">·</span> : null}
        <span className={tone}>{said.state.word}</span>
      </span>
      {said.state.cause ? (
        <span className={tone ? `map-label-cause ${tone}` : "map-label-cause"} aria-hidden="true">
          <span className="map-sep">·</span>
          {said.state.cause}
        </span>
      ) : null}
      <span id={descId} className="ui-vh map-desc">
        <Dots items={said.facts} /> {more.join(" ")}
      </span>
      {fold ? <FoldToggle ms={ms} onToggle={onToggle} /> : null}
    </div>
  );
}

/**
 * Interchange rings, joined by a faint line that stands out while the mark is hovered or one of its stations is hovered,
 * focused (`hot`) or open in the inspector; a mark standing for several carries their count. Each is named for assistive tech.
 */
export function Rings({ changes, height, dx = 0, hot = null }: { changes: readonly MapChange[]; height: number; dx?: number; hot?: string | null }) {
  const { picked } = useInspector();
  if (changes.length === 0) return null;
  const pickedKey = picked ? `${picked.sessionId}/${picked.agentId}` : null;
  return (
    <svg className="map-rings" width="100%" height={height} focusable="false" role="group" aria-label="Interchanges">
      <g transform={dx ? `translate(${-dx} 0)` : undefined}>
        {changes.map((c) => {
          const top = c.ys[0] ?? 0;
          const bottom = c.ys[c.ys.length - 1] ?? top;
          return (
            <g key={c.key} className={c.ends.some((e) => e === hot || e === pickedKey) ? `mr mr-${c.kind} is-hot` : `mr mr-${c.kind}`} role="img" aria-label={c.title}>
              <title>{c.title}</title>
              {bottom > top ? <path className="mr-link" d={`M${c.x} ${top}V${bottom}`} /> : null}
              {c.ys.map((y) => (
                <circle key={y} className="mr-ring" cx={c.x} cy={y} r={MAP.ringR} />
              ))}
              {c.kind === "message" ? c.ys.map((y) => <circle key={`d${y}`} className="mr-dot" cx={c.x} cy={y} r={2} />) : null}
              {c.count > 1 ? (
                <text className="mr-count" x={c.x + MAP.ringR - 1} y={top - MAP.ringR - 2}>
                  {c.count}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/**
 * One session's block, its line starting at `MAP.bareX`. Its own row names the session and holds the fold toggle; `bare` leaves
 * the name out, for a block opened under a row that already names the session.
 */
export function SessionBlock({ ms, now, onToggle, bare = false, hot }: { ms: MapSession; now: number; onToggle: (id: string) => void; bare?: boolean; hot?: Hot }) {
  const fold = ms.finished + ms.failed > 0 && (ms.expanded || ms.folded + ms.foldedFailed > 0);
  const [own, ...agents] = ms.rows;
  return (
    <div className="map-block" data-session={ms.session.id} style={{ height: ms.height }}>
      <svg className="map-lines" width="100%" height={ms.height} aria-hidden="true" focusable="false">
        <g transform={`translate(${-SHIFT_X} 0)`}>
          {ms.under.map((p) => (
            <path key={p.key} className={p.cls} d={p.d} />
          ))}
          {ms.over.map((p) => (
            <path key={p.key} className={p.cls} d={p.d} />
          ))}
        </g>
      </svg>
      {own ? <StationRow r={own} ms={ms} now={now} named={!bare} fold={fold} onToggle={onToggle} hot={hot} /> : null}
      {agents.map((r) => (
        <StationRow key={r.key} r={r} ms={ms} now={now} named fold={false} onToggle={onToggle} hot={hot} />
      ))}
      <Rings changes={ms.changes} height={ms.height} dx={SHIFT_X} hot={hot?.key ?? null} />
    </div>
  );
}

/** Where a group's opened blocks sit in the box holding its rows: each block's top by session id, their left, the box's height. */
export interface BlockPlaces {
  left: number;
  height: number;
  tops: ReadonlyMap<string, number>;
}

const samePlaces = (a: BlockPlaces | null, b: BlockPlaces): boolean =>
  a !== null && a.left === b.left && a.height === b.height && a.tops.size === b.tops.size && [...b.tops].every(([id, y]) => a.tops.get(id) === y);

/**
 * The places of the blocks (`.map-block[data-session]`) inside `host`, a positioned box, measured after each render and as the
 * box changes size, while `on`. Call it in the component that holds `host`'s ref: a child's layout effect runs before its
 * parent's refs are set.
 */
export function useBlockPlaces(host: RefObject<HTMLElement>, on: boolean): BlockPlaces | null {
  const [placed, setPlaced] = useState<BlockPlaces | null>(null);
  const measure = useCallback(() => {
    const el = host.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const tops = new Map<string, number>();
    let left = 0;
    for (const block of el.querySelectorAll<HTMLElement>(".map-block[data-session]")) {
      const r = block.getBoundingClientRect();
      tops.set(block.dataset.session ?? "", r.top - box.top);
      left = r.left - box.left;
    }
    const next: BlockPlaces = { left, height: el.clientHeight, tops };
    setPlaced((was) => (samePlaces(was, next) ? was : next));
  }, [host]);
  useLayoutEffect(() => {
    if (on) measure();
  });
  useLayoutEffect(() => (on ? watchSize(host.current, measure) : undefined), [on, host, measure]);
  return on ? placed : null;
}

/**
 * A machine's interchanges that join two of its blocks (MapZone.changes), drawn over the rows holding the blocks: each ring on
 * its station wherever its block was placed (`placed`), the rings joined top to bottom.
 */
export function ZoneRings({ zone, placed, hot }: { zone: MapZone; placed: BlockPlaces; hot?: Hot }) {
  const blockOf = new Map(zone.sessions.flatMap((ms) => ms.rows.map((r) => [r.key, ms] as const)));
  const changes = zone.changes.flatMap((c): MapChange[] => {
    const rings: { key: string; y: number }[] = [];
    c.ends.forEach((key, i) => {
      const ms = blockOf.get(key);
      const top = ms ? placed.tops.get(ms.session.id) : undefined;
      if (ms && top !== undefined) rings.push({ key, y: top + (c.ys[i] ?? 0) - ms.top });
    });
    if (rings.length < c.ends.length) return [];
    rings.sort((a, b) => a.y - b.y);
    return [{ ...c, ys: rings.map((r) => r.y), ends: rings.map((r) => r.key) }];
  });
  return <Rings changes={changes} height={placed.height} dx={SHIFT_X - placed.left} hot={hot?.key ?? null} />;
}
