// The wall view: display mode's fleet for a screen across the room, a Big Picture to the console's Library. Two layouts, Sections
// (large screens, the default) and Columns (an iPad or a small screen), switched in the corner or with `l`
// (shell/useDisplayMode). Larger type, fewer things: what needs you, what is wrong, what everything is doing, with context and
// est. cost the only figures per session; no ids, paths, git, squares, effort, filters or controls. It reads the live fleet the
// console holds and never answers: an item is a link to its session's page, which leaves the wall. Arrow keys move focus between
// items by position, and back the way they came returns to the item left. While the stream is lost, a banner says so in the desk
// strip's words, and since when once it had figures.
import { useRef, type RefObject } from "react";
import { needYouCount } from "../../attention";
import { isPlainClick } from "../../components/Board";
import { fmtClock } from "../../format";
import { lostWords } from "../../shell/Bar";
import { VIEW_LABELS } from "../../shell/Nav";
import type { DisplayLayout } from "../../shell/useDisplayMode";
import { stateOf } from "../../states";
import type { FleetState } from "../../store";
import { Station } from "../../ui/Station";
import { useHotkeys } from "../../useHotkeys";
import { shapeFleet } from "../now/fleet";
import { useLiveSessions } from "../now/NowView";
import { problemItems, queueItems, worstProblem } from "../now/queue";
import { Columns } from "./Columns";
import { REST, type Wall } from "./parts";
import { Sections } from "./Sections";
// The tiles' state edge is the Fleet cards' (wall.css [data-edge]).
import "../wall/wall.css";
import "./display.css";

export interface DisplayProps {
  fleet: FleetState;
  now: number;
  layout: DisplayLayout;
  /** The Fleet's Background choice: background sessions show on the wall when they show on the Fleet. */
  background: boolean;
  /** A session's page is opening from the wall: display mode ends. */
  onLeave: () => void;
}

type Step = readonly [number, number];
const STEPS: Readonly<Record<string, Step>> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
const BACK: Readonly<Record<string, string>> = { ArrowUp: "ArrowDown", ArrowDown: "ArrowUp", ArrowLeft: "ArrowRight", ArrowRight: "ArrowLeft" };

const centre = (r: DOMRect) => [r.left + r.width / 2, r.top + r.height / 2] as const;

/**
 * The item a step away from `from` by position (XY focus), among the items wholly past `from`'s edge in the step's direction: one
 * whose box overlaps `from`'s across the step comes first (XY focus's projection), else the nearest of the rest
 * (so Left or Right from low in a column reaches a shorter one); nearest by the distance along plus twice the
 * distance across, between centres. Nothing lies beside a full-width line, so Left and Right stay there.
 */
function nearest(from: Element, [dx, dy]: Step, items: readonly HTMLElement[]): HTMLElement | null {
  const a = from.getBoundingClientRect();
  const [ax, ay] = centre(a);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  let bestOverlaps = false;
  for (const item of items) {
    if (item === from) continue;
    const b = item.getBoundingClientRect();
    // A pixel's slack, for the border two lines share.
    const past = dx > 0 ? b.left >= a.right - 1 : dx < 0 ? b.right <= a.left + 1 : dy > 0 ? b.top >= a.bottom - 1 : b.bottom <= a.top + 1;
    if (!past) continue;
    const overlaps = dx !== 0 ? b.top < a.bottom && b.bottom > a.top : b.left < a.right && b.right > a.left;
    const [bx, by] = centre(b);
    const score = dx !== 0 ? Math.abs(bx - ax) + 2 * Math.abs(by - ay) : Math.abs(by - ay) + 2 * Math.abs(bx - ax);
    if ((overlaps && !bestOverlaps) || (overlaps === bestOverlaps && score < bestScore)) {
      best = item;
      bestScore = score;
      bestOverlaps = overlaps;
    }
  }
  return best;
}

/**
 * Arrow keys move focus between the wall's items; the first press takes the first (the longest wait). A step straight back
 * returns to the item it came from, rather than to whichever is nearest. Enter is the
 * link's own. An item whose session changes state is drawn anew in another list, and focus goes with its old element: the next
 * press takes that session's new item, where focus was, rather than the first.
 */
function useArrowFocus(root: RefObject<HTMLElement>): void {
  const came = useRef<{ from: HTMLElement; to: HTMLElement; key: string } | null>(null);
  // The address of the item focus last went to.
  const held = useRef<string | null>(null);
  useHotkeys((e) => {
    const step = STEPS[e.key];
    if (!step || !root.current) return;
    e.preventDefault();
    const items = [...root.current.querySelectorAll<HTMLElement>("a.wv-item")];
    const at = items.find((item) => item === document.activeElement);
    const last = came.current;
    let to: HTMLElement | null;
    if (!at) to = items.find((item) => item.getAttribute("href") === held.current) ?? items[0] ?? null;
    else if (last && last.to === at && BACK[last.key] === e.key && last.from.isConnected) to = last.from;
    else to = nearest(at, step, items);
    if (!to) return;
    came.current = at ? { from: at, to, key: e.key } : null;
    held.current = to.getAttribute("href");
    to.focus({ preventScroll: true });
  });
}

export function DisplayView({ fleet, now, layout, background, onLeave }: DisplayProps) {
  const root = useRef<HTMLDivElement>(null);
  useArrowFocus(root);
  const { all, labels } = useLiveSessions(fleet);
  // The Fleet's own shaping (background set aside unless shown), by name within each state.
  const { shown } = shapeFleet(all, now, { sort: "name", groupBy: "none", background }, labels);
  const problems = problemItems(all);
  const wall: Wall = {
    fleet,
    now,
    labels,
    queue: queueItems(all),
    needs: needYouCount(fleet.sessions),
    problems,
    worst: worstProblem(problems),
    groups: REST.map((state) => ({ state, sessions: shown.filter((s) => stateOf(s) === state) })),
    // A plain primary click, or Enter, opens the session's page here and leaves the wall; a modified or middle click opens it
    // elsewhere as the browser does with any link, and the wall stays.
    onLeave: (e) => {
      if (isPlainClick(e)) onLeave();
    },
  };
  const lost = fleet.phase === "disconnected";
  // The desk strip's words (shell/Bar lostWords); once a first snapshot came, with when the figures froze: the server's time at
  // its last tick (every 2 s). Before one there are no figures, and no time to give.
  const loaded = fleet.server !== null;
  const words = lostWords(loaded, loaded ? fmtClock(fleet.serverTime) : undefined);
  return (
    <div ref={root} className="wv" data-theme="dark" data-lost={lost || undefined}>
      {/* The lists' headings are the desk's h3 (controls ListHead); this one, for assistive tech, heads them. */}
      <h2 className="ui-vh">{VIEW_LABELS.now}</h2>
      {layout === "columns" ? <Columns wall={wall} /> : <Sections wall={wall} />}
      <div className="wv-status" role="status">
        {lost ? (
          <div className="wv-lost">
            <Station kind="failed" />
            <p className="wv-lost-t">{words.head}</p>
            <p className="wv-lost-s">{words.rest}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
