// What the wall view's two layouts (Columns, Sections) share: the fleet as the wall reads it, a session's two figures, a
// problem's fact, the est. spend and plan windows, the stream's word and the time, "+N more", and the arithmetic that fits a
// list to its fixed region. States, orders and figures come from the console's own functions, and the words it already says
// from the pieces that say them on the desk (queue.ts problemWords and agentNameOf, NeedsYou's WaitClock, Problems' ProblemMark
// and AlsoEdited, StateBar's SpendToday, Bar's STREAM, controls' ListHead, Chips' HarnessName and ContextFigure); the layouts
// and sizes are the wall's (display.css).
import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { ContextFigure, Cost, contextLevel, HarnessName } from "../../components/Chips";
import { limitFigure, limitLevel, resetWords } from "../../limits";
import { providerInfo } from "../../provider";
import { clockOf } from "../../respond";
import { STREAM } from "../../shell/Bar";
import type { FleetState } from "../../store";
import type { SessionView } from "../../types";
import { Station } from "../../ui/Station";
import { AlsoEdited } from "../now/Problems";
import type { Problem, ProblemWords, QueueItem } from "../now/queue";
import { nearestWindows, SpendToday } from "../now/StateBar";

/** The states listed below Needs you and Problems, in their order on screen. */
export const REST = ["working", "idle"] as const;
export type RestState = (typeof REST)[number];

/**
 * The order a list's rows give way in when it does not fit, least important first: idle, then working, then problems. Needs you
 * is a region of its own.
 */
export const GIVES_WAY: Readonly<Record<RestState | "problems", number>> = { idle: 0, working: 1, problems: 2 };

/** The fleet as the wall shows it (DisplayView). */
export interface Wall {
  fleet: FleetState;
  now: number;
  /** Each machine's name as the console prints it, the start of its id where two share a name (groups machineLabels). */
  labels: ReadonlyMap<string, string>;
  /** Every open ask and every session that needs you with none, longest wait first (queue.ts queueItems). */
  queue: QueueItem[];
  /** The sessions that need you, as every needs-you count counts them (attention needYouCount). */
  needs: number;
  problems: Problem[];
  /** The worst problem's state, for the Problems heading's mark (queue.ts worstProblem, as the desk's Attention header). */
  worst: "failed" | "stuck" | null;
  /** Working and Idle, each by name; background sessions only as the Fleet shows them (fleet.ts shapeFleet). */
  groups: { state: RestState; sessions: SessionView[] }[];
  /** An item's link was clicked: a plain click opens the session's page here and leaves the wall. */
  onLeave: (e: MouseEvent) => void;
}

export const machineOf = (wall: Wall, s: SessionView): string => wall.labels.get(s.machine.id) ?? s.machine.name;

/** A session's context fill, orange from 75 % and red from 80 % (Chips ContextFigure, contextLevel), and its est. cost (Chips Cost). */
export function SessionFigures({ s }: { s: SessionView }) {
  const pct = s.context.percent;
  return (
    <>
      <span className="wv-ctx" data-level={pct === null ? undefined : (contextLevel(pct) ?? undefined)}>
        <span className="ui-vh">Context </span>
        <ContextFigure percent={pct} />
      </span>
      <span className="wv-cost">
        <span className="ui-vh">Est. cost </span>
        <Cost s={s} />
      </span>
    </>
  );
}

/** A problem's fact in Problems' words: the state line, or a shared file and who else edited it (no links on the wall). */
export const problemFact = (w: ProblemWords): ReactNode => (w.file ? <AlsoEdited file={w.file.name} by={w.file.by} /> : w.fact);

/**
 * The est. spend today and each harness's plan window nearest its limit, "7d 81% used", as the state bar says them
 * (StateBar SpendToday and nearestWindows: stale readings left out), with its reset from 75 %: the desk's tooltip says it, a wall
 * has none.
 */
export function FleetFigures({ fleet, now }: { fleet: FleetState; now: number }) {
  return (
    <span className="wv-figs wv-data">
      <SpendToday kpis={fleet.kpis} picked={null} />
      {nearestWindows(fleet.machines, now).map(({ provider, limit }) => {
        const level = limitLevel(limit.percentUsed);
        const { Logo } = providerInfo(provider);
        return (
          <span key={provider} className="wv-win" data-level={level}>
            <Logo />
            <HarnessName provider={provider} spoken />
            {limitFigure(limit)}
            {level === "ok" ? null : <span className="wv-reset">{resetWords(limit, now)}</span>}
          </span>
        );
      })}
    </span>
  );
}

/** The stream's word and mark as the top bar says them (Bar STREAM): Live, or Disconnected. */
export function Stream({ phase }: { phase: FleetState["phase"] }) {
  const { word, mark } = STREAM[phase];
  return (
    <span className="wv-stream" data-lost={phase === "disconnected" || undefined}>
      <Station kind={mark} />
      {word}
    </span>
  );
}

/** The time of day. */
export const Clock = ({ now }: { now: number }) => <span className="wv-clock">{clockOf(now)}</span>;

/** The line that ends a list whose last `n` rows did not fit. */
export const More = ({ n, of }: { n: number; of?: string }) => (n > 0 ? <li className="wv-more">{moreWords(n, of)}</li> : null);

/** What stands for the rows or items cut from a list: "+3 more", or "+3 more idle" where it says which group they were cut from. */
export const moreWords = (n: number, of?: string): string => `+${n} more${of ? ` ${of}` : ""}`;

// ---- fitting a list to its fixed region ------------------------------------------------------------------------------------

/** A group of rows in a list region: its head's height (px; 0 for none), each row's height, how many rows, and GIVES_WAY's rank. */
export interface Lot {
  head: number;
  row: number;
  n: number;
  rank: number;
}

/**
 * How many rows of each group fit in `room` px. Rows go from the end of the group of lowest rank first, a group emptied before
 * the next is touched; a group that lost rows ends in a "+N more" line `more` px tall; a group with no rows takes no room. Never
 * pages.
 */
export function fit(lots: readonly Lot[], room: number, more: number): number[] {
  const shown = lots.map((l) => l.n);
  const used = () => lots.reduce((h, l, i) => (l.n === 0 ? h : h + l.head + shown[i] * l.row + (shown[i] < l.n ? more : 0)), 0);
  const order = lots.map((_, i) => i).sort((a, b) => lots[a].rank - lots[b].rank);
  for (const i of order) while (shown[i] > 0 && used() > room) shown[i] -= 1;
  return shown;
}

/** The px of a layout's fixed regions (`data-room`) and of its Ruler's samples (`data-size`). */
export interface Rooms {
  room: (name: string) => number;
  size: (name: string) => number;
}

/**
 * Measures the regions and samples inside `ref`, before the first paint and again whenever it or one of its regions changes
 * size: every wall size follows the viewport, and Sections' rows region also grows and shrinks as its tiles go and come. Null
 * until measured, when a list shows every row.
 */
export function useRooms<T extends HTMLElement>(): [RefObject<T>, Rooms | null] {
  const ref = useRef<T>(null);
  const [rooms, setRooms] = useState<Rooms | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const heights = (attr: "room" | "size") => new Map([...el.querySelectorAll<HTMLElement>(`[data-${attr}]`)].map((n) => [n.dataset[attr] ?? "", n.getBoundingClientRect().height]));
    const read = () => {
      const room = heights("room");
      const size = heights("size");
      setRooms({ room: (k) => room.get(k) ?? 0, size: (k) => size.get(k) ?? 0 });
    };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    for (const region of el.querySelectorAll("[data-room]")) watch.observe(region);
    return () => watch.disconnect();
  }, []);
  return [ref, rooms];
}

/** One invisible sample of each row height a layout uses (`--wv-h-<name>`, display.css), so useRooms reads them in px. */
export function Ruler({ sizes }: { sizes: readonly string[] }) {
  return (
    <div className="wv-ruler" aria-hidden="true">
      {sizes.map((name) => (
        <i key={name} data-size={name} style={{ height: `var(--wv-h-${name})` }} />
      ))}
    </div>
  );
}
