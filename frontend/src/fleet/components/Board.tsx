// The board: every session's plan steps sorted into a column per state, read-only, a page of cards at a time. A card opens its
// session's page. Cards keep plan order in their column and never move by themselves; a card that changes column is announced
// once to screen readers. Over the board, the running counts (the server's whole-fleet figures and the one needs-you rule, then
// the board's plans and cards), folded and opened by the tab on their edge and remembered. Below the five-column width one column
// shows at a time, picked by tabs. Sessions without open steps are simply not on the board, and every card carries its session's
// state: ui/Station's mark beside its name, and the Fleet cards' state edge (wall.css [data-edge]) in the state's colour,
// whatever the state. With no cards the five columns still show, each with its own empty words, under one line saying why the
// board is empty.
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { hashFor } from "../../route";
import { BOARD_COLUMNS, buildBoard, CARDS_PER_PAGE, EMPTY_COLUMN, planFigures, type BoardCard, type BoardColumn, type BoardColumns, type PlanFigures } from "../board";
import { stateOf } from "../states";
import { readJson, writeJson } from "../storage";
import type { Kpis, SessionView } from "../types";
import { Station, stationColor, stationWord } from "../ui/Station";
import { Unknown } from "../ui/Unknown";
import { IconChevron } from "./Icons";
import { PageNav } from "./PageNav";
import "../views/wall/wall.css";
import "../views/plans/plans.css";

const PREFS_KEY = "board";
/** Whether the KPI rows are folded: their own key, apart from the page's other choices. */
const KPIS_KEY = "collapsed.board.kpis";

interface BoardPrefs {
  /** Cards in a lane per session instead of mixed in each column. */
  group: boolean;
}

function stepsWord(n: number): string {
  return n === 1 ? "1 step" : `${n} steps`;
}

/** A session's name with its state's mark: a card's title, or the head of a lane. */
function NameTag({ cls, s, size }: { cls: string; s: SessionView; size: number }) {
  return (
    <div className={cls}>
      <Station kind={stateOf(s)} label size={size} />
      <b>{s.name}</b>
    </div>
  );
}

/** What the card says under its step: a session card its need; a step moved to Review why it waits. */
function whyLine(card: BoardCard): string | null {
  const why = card.why;
  if (!why) return null;
  if (card.waiting) return why.detail;
  return why.detail ? `${why.lead}: ${why.detail}` : why.lead;
}

/** A plain primary click, which the page handles itself; a modified or middle one (a new tab or window) is the browser's. The
 * board's cards and the wall view's items test it. */
export const isPlainClick = (e: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "button">): boolean => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);

function Card({ card, titled, onOpen }: { card: BoardCard; titled: boolean; onOpen: (id: string) => void }) {
  const { session: s, step } = card;
  // A modified click (a new tab) is left to the browser; a plain one opens the session's page here.
  const onClick = (e: MouseEvent) => {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    onOpen(s.id);
  };
  // While a step is in progress its live wording stands in for its text.
  const live = !card.waiting && step.state === "active" ? step.activeText : null;
  const why = whyLine(card);
  const state = stateOf(s);
  return (
    <a
      className="pb-card"
      href={hashFor("session", s.id)}
      data-edge={state}
      style={{ ["--wc-edge" as string]: stationColor(state) }}
      aria-label={`${step.text}, ${card.waiting ? "waiting" : step.state}, ${s.name}, ${stationWord(state)}`}
      onClick={onClick}
    >
      {titled ? <NameTag cls="pb-title" s={s} size={14} /> : null}
      <div className="pb-text">{live || step.text}</div>
      {why ? <div className="pb-wait">{why}</div> : null}
      {step.ownerLabel ? <div className="pb-own">{step.ownerLabel}</div> : null}
    </a>
  );
}

/**
 * Sessions live, running and waiting on you, and agents live (running and queued), running and queued: the server's figures, and
 * for sessions waiting the one rule every needs-you count follows (states needsYou). Then the plan and card counts.
 */
function RunningCounts({ id, hidden, kpis, waiting, filtered, plans }: { id: string; hidden: boolean; kpis: Kpis | null; waiting: number; filtered: boolean; plans: PlanFigures }) {
  // [label, value, caption, whether it is a whole-fleet figure (said so when the filter narrows the board)]
  const tiles: [string, number | undefined, string, boolean][] = [
    ["Sessions live", kpis?.live, "forks excluded", true],
    ["Sessions running", kpis?.running, "", true],
    ["Sessions waiting", kpis ? waiting : undefined, "", true],
    ["Sessions with plans", plans.orchestrators, kpis && !filtered ? `of ${kpis.live} live` : "", false],
    ["Agents live", kpis ? kpis.agentsRunning + kpis.agentsWaiting : undefined, "forks included", true],
    ["Agents running", kpis?.agentsRunning, "", true],
    ["Agents queued", kpis?.agentsWaiting, "", true],
    ["Total cards", plans.steps, `${plans.done} done`, false],
  ];
  return (
    <div id={id} className="pb-kpis" role="group" aria-label="Sessions and agents, plans and cards, whole fleet" hidden={hidden}>
      {tiles.map(([label, value, caption, fleet]) => (
        <div key={label} className="pb-kpi">
          <div className="pb-kpi-k">{label}</div>
          <div className="pb-kpi-v">{value ?? <Unknown reason="The server has not sent its figures yet" />}</div>
          <div className="pb-kpi-cap">{filtered && fleet ? "whole fleet" : caption}</div>
        </div>
      ))}
    </div>
  );
}

/** Why the board has no cards; `live` is how many sessions the fleet has live, shown or not. */
function blankText(sessions: number, live: number): string {
  if (!sessions) return live > 0 ? "No sessions shown: the filter or Background hides them." : "No sessions are active.";
  return `None of the ${sessions} active sessions has open steps.`;
}

// ---- state ----------------------------------------------------------------------------------------------------------

/** The board's switch, remembered in this browser. */
function useBoardPrefs(): [BoardPrefs, (change: Partial<BoardPrefs>) => void] {
  const [prefs, setPrefs] = useState<BoardPrefs>(() => {
    const saved = readJson<Partial<BoardPrefs> | null>(PREFS_KEY, null);
    return { group: saved?.group === true };
  });
  const change = (part: Partial<BoardPrefs>) => {
    const next = { ...prefs, ...part };
    writeJson(PREFS_KEY, next);
    setPrefs(next);
  };
  return [prefs, change];
}

type Placed = { column: BoardColumn; text: string };

/**
 * Follows the board from one build to the next: the cards that moved column or arrived are told to screen readers in one
 * sentence for the whole change. The first build only records where every card is.
 */
function useBoardNote(board: BoardColumns): string {
  const placedBefore = useRef<Map<string, Placed> | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    const placed = new Map<string, Placed>();
    for (const { key } of BOARD_COLUMNS) for (const card of board[key]) placed.set(card.key, { column: key, text: card.step.text });
    const before = placedBefore.current;
    placedBefore.current = placed;
    if (before === null) return;
    const moved: [string, Placed][] = [];
    const added: [string, Placed][] = [];
    for (const entry of placed) {
      const was = before.get(entry[0]);
      if (!was) added.push(entry);
      else if (was.column !== entry[1].column) moved.push(entry);
    }
    const count = moved.length + added.length;
    if (count === 0) return;

    const columnLabel = (c: BoardColumn) => BOARD_COLUMNS.find((x) => x.key === c)!.label;
    const lead = moved.length > 0 ? `${moved[0][1].text} moved to ${columnLabel(moved[0][1].column)}` : `New step: ${added[0][1].text}`;
    setNote(count > 1 ? `${lead}, and ${count - 1} more ${count === 2 ? "change" : "changes"}` : lead);
  }, [board]);

  return note;
}

// ---- parts ----------------------------------------------------------------------------------------------------------

/** A two-way switch in the board's header: the shared segmented control's buttons. */
function Segmented({ label, options }: { label: string; options: { text: string; on: boolean; press: () => void }[] }) {
  return (
    <div className="ui-segment-options" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.text} type="button" aria-pressed={o.on} onClick={o.press}>
          {o.text}
        </button>
      ))}
    </div>
  );
}

/** One column: its heading, a page of its cards (in lanes when grouped), and its pager when it has more than one page. */
function Column(props: { spec: (typeof BOARD_COLUMNS)[number]; cards: BoardCard[]; page: number; onPage: (n: number) => void; selected: boolean; grouped: boolean; onOpen: (id: string) => void }) {
  const { spec, cards, grouped } = props;
  const pageCount = Math.max(1, Math.ceil(cards.length / CARDS_PER_PAGE));
  const at = Math.min(props.page, pageCount - 1);
  const from = at * CARDS_PER_PAGE;
  const onPage = cards.slice(from, from + CARDS_PER_PAGE);
  const heading = (
    <div className="pb-col-h">
      <h3>{spec.label}</h3>
      <span className="pb-n">{cards.length}</span>
    </div>
  );
  return (
    <section className={`pb-col pb-${spec.key}${props.selected ? " on" : ""}`} aria-label={`${spec.label}, ${stepsWord(cards.length)}`}>
      {heading}
      <div className="pb-col-b">
        {onPage.length ? null : <div className="pb-empty">{EMPTY_COLUMN[spec.key]}</div>}
        {onPage.map((card, i) => {
          // Grouped, a lane heading starts wherever the session changes.
          const newLane = grouped && (i === 0 || onPage[i - 1].session.id !== card.session.id);
          return (
            <div key={card.key} className="pb-slot">
              {newLane ? <NameTag cls="pb-lane" s={card.session} size={16} /> : null}
              <Card card={card} titled={!grouped} onOpen={props.onOpen} />
            </div>
          );
        })}
      </div>
      {/* The compact form ("1 of 2" between the chevrons), as every pager uses: a column is as narrow as 140 px. */}
      {pageCount > 1 && <PageNav label={`${spec.label} pages`} at={at} pages={pageCount} from={from} shown={onPage.length} total={cards.length} perPage={CARDS_PER_PAGE} onPage={props.onPage} compact />}
    </section>
  );
}

// ---- the page -------------------------------------------------------------------------------------------------------

/**
 * `sessions`: those the board shows; `waiting`: how many of the whole fleet's need you; `filtered`: the filter field narrows the
 * board, so the whole-fleet tiles say so.
 */
export function Board(props: { sessions: SessionView[]; kpis: Kpis | null; waiting: number; filtered: boolean; onOpen: (sessionId: string) => void }) {
  const [prefs, setPref] = useBoardPrefs();
  const [kpisShut, setKpisShut] = useState(() => readJson<unknown>(KPIS_KEY, false) === true);
  const kpisId = useId();
  const headId = useId();
  const [pageOf, setPageOf] = useState<Partial<Record<BoardColumn, number>>>({});
  // Below the five-column width one column shows at a time, picked by these tabs.
  const [tab, setTab] = useState<BoardColumn>("active");
  const board = useMemo(() => buildBoard(props.sessions), [props.sessions]);
  const plans = useMemo(() => planFigures(board), [board]);
  const note = useBoardNote(board);

  const cardCount = BOARD_COLUMNS.reduce((sum, c) => sum + board[c.key].length, 0);
  const toggleKpis = () => {
    writeJson(KPIS_KEY, !kpisShut);
    setKpisShut(!kpisShut);
  };
  const kpisTab = kpisShut ? "Show KPI rows" : "Hide KPI rows";
  const columns = BOARD_COLUMNS.map((spec) => ({ spec, cards: board[spec.key] }));

  return (
    <section className="pb-page" aria-labelledby={headId}>
      <div className="pb-head">
        <header className="ui-view-head">
          <h1 id={headId}>Plans</h1>
        </header>
        <Segmented
          label="Layout"
          options={[
            { text: "Mixed", on: !prefs.group, press: () => setPref({ group: false }) },
            { text: "By session", on: prefs.group, press: () => setPref({ group: true }) },
          ]}
        />
      </div>
      <div className={kpisShut ? "pb-kpi-block shut" : "pb-kpi-block"}>
        <RunningCounts id={kpisId} hidden={kpisShut} kpis={props.kpis} waiting={props.waiting} filtered={props.filtered} plans={plans} />
        <button type="button" className="pb-kpi-tab" aria-expanded={!kpisShut} aria-controls={kpisId} aria-label={kpisTab} title={kpisTab} onClick={toggleKpis}>
          <IconChevron />
        </button>
      </div>
      <div className="ui-vh" role="status" aria-label="Board updates">
        {note}
      </div>
      {cardCount === 0 ? <p className="pb-blank">{blankText(props.sessions.length, props.kpis?.live ?? 0)}</p> : null}
      <div className="ui-tabs pb-tabs" role="tablist" aria-label="Board columns">
        {columns.map(({ spec, cards }) => (
          <button key={spec.key} type="button" role="tab" aria-selected={tab === spec.key} onClick={() => setTab(spec.key)}>
            {spec.label}
            <span className="pb-tab-n">{cards.length}</span>
          </button>
        ))}
      </div>
      <div className="pb-board">
        {columns.map(({ spec, cards }) => (
          <Column
            key={spec.key}
            spec={spec}
            cards={cards}
            page={pageOf[spec.key] ?? 0}
            onPage={(n) => setPageOf((pages) => ({ ...pages, [spec.key]: n }))}
            selected={tab === spec.key}
            grouped={prefs.group}
            onOpen={props.onOpen}
          />
        ))}
      </div>
    </section>
  );
}
