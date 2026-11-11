// One session's page (#/s/<id>): its two-line head, what it asks of the owner, its facts, its plan as a checklist, then the
// Timeline or the agent tree under one toolbar row, with the changed files in a column beside them that folds away ("—" while
// they are not reported), and the message box at the foot. Picking a row anywhere on the page shows its detail in the
// inspector: an agent's, or the main loop's from its own row. A stored
// session from History opens the same page read-only: no asks, no Rename, no message box.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AgentTree, type AgentSort } from "../../components/AgentTree";
import { BlowoutCallout } from "../../components/BlowoutCallout";
import { FactsBar } from "../../components/FactsBar";
import { FilesList } from "../../components/FilesList";
import { IconChevron } from "../../components/Icons";
import { PlanSteps } from "../../components/PlanPanel";
import { defaultAgentDir, ORCHESTRATOR_ROW, planProgress, type AgentSortKey } from "../../logic";
import { useInspector } from "../../shell/inspector";
import { needsYou, waitingOnByRow } from "../../states";
import { readJson, writeJson } from "../../storage";
import type { FleetState } from "../../store";
import type { SessionView } from "../../types";
import { dotsText } from "../../ui/Dots";
import { Unknown } from "../../ui/Unknown";
import { watchSize } from "../../useWallColumns";
import { AskCard } from "./AskCard";
import { useWidth } from "./bits";
import { PageComposer } from "./PageComposer";
import { SessionHead, SessionNotices } from "./SessionHeader";
import { Timeline } from "./Timeline";
import type { SessionEvents } from "./useSessionEvents";
import "./session.css";

type Mode = "timeline" | "agents";

/** Launch order: no column sorts the agents. */
const LAUNCH_ORDER: AgentSort = { key: null, dir: 1 };
/** How long a row picked from outside the page stays marked. */
const FLASH_MS = 2000;
/** The owner's choice to fold or open the Files column, one for every session; absent until they make one. */
const FOLD_KEY = "session.filesFolded";
/** Below this page width the column starts folded, so the Timeline gets the room; an explicit choice wins either way. */
const FOLD_BELOW = 1000;

/** Whether the Files column is folded: the owner's remembered choice, else folded on a page narrower than FOLD_BELOW. */
function useFilesFold(width: number): [boolean, () => void] {
  const [chosen, setChosen] = useState<boolean | null>(() => {
    const saved = readJson<unknown>(FOLD_KEY, null);
    return typeof saved === "boolean" ? saved : null;
  });
  const folded = chosen ?? (width > 0 && width < FOLD_BELOW);
  const toggle = () => {
    writeJson(FOLD_KEY, !folded);
    setChosen(!folded);
  };
  return [folded, toggle];
}

/**
 * The agent the inspector shows when it is one of this session's, and picking one. An agent picked from outside the page (its
 * address, an activity row, a link in the inspector) is marked for a moment and brought into view; one picked here is not.
 */
function usePicked(s: SessionView, stored: boolean): { selected: string | null; flash: string | null; pickHere: (id: string) => void } {
  const { picked, pick } = useInspector();
  const listed = (id: string) => id === ORCHESTRATOR_ROW || s.agents.some((a) => a.id === id);
  const selected = picked !== null && picked.sessionId === s.id && listed(picked.agentId) ? picked.agentId : null;
  const pickedHere = useRef<string | null>(null);
  const [marked, setMarked] = useState<string | null>(null);
  useEffect(() => {
    if (selected !== null && selected !== pickedHere.current) setMarked(selected);
    pickedHere.current = null;
  }, [selected]);
  useEffect(() => {
    if (marked === null) return undefined;
    const timer = setTimeout(() => setMarked(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [marked]);
  const pickHere = (id: string) => {
    pickedHere.current = id;
    pick(s.id, id, stored ? s : undefined);
  };
  return { selected, flash: marked, pickHere };
}

/** What the Agents option counts (the main loop and every agent launched, as its list shows them), for its title. */
function launchedText(s: SessionView): string {
  if (s.agents.length === 0) return "The main loop; no agents launched yet";
  const byAgents = s.agents.filter((a) => a.parentId && a.parentId !== a.id && s.agents.some((p) => p.id === a.parentId)).length;
  return dotsText([`The main loop and ${s.agents.length} launched`, byAgents ? `${byAgents} by other agents` : null]);
}

/**
 * The sticky message box's height, published on the page as --sv-foot-h: the rows a pick brings into view keep that much
 * room below them (scroll-margin-block-end), so they are never left under the box. A callback ref, so it follows the box as it comes and goes. Whenever the page changes size while a row picked from
 * outside is still marked, that row is brought into view again: on a cold load what loads after the pick has scrolled (the
 * box becoming the composer once the sign-in check answers, the ask's detail, the Timeline's legend) moves the row down.
 */
function useFootHeight(): (foot: HTMLElement | null) => void {
  const stop = useRef<(() => void) | null>(null);
  return useCallback((foot: HTMLElement | null) => {
    stop.current?.();
    stop.current = null;
    const page = foot?.closest<HTMLElement>(".sv-page");
    if (!foot || !page) return;
    let published = -1;
    const unwatch = watchSize(page, () => {
      if (foot.offsetHeight !== published) {
        published = foot.offsetHeight;
        page.style.setProperty("--sv-foot-h", `${published}px`);
      }
      page.querySelector<HTMLElement>(".sv-tl-row.flash, .ag-row.flash")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
    stop.current = () => {
      unwatch();
      page.style.removeProperty("--sv-foot-h");
    };
  }, []);
}

/** Timeline or Agents: one radio group drawn as the shared segmented control, the first thing on the toolbar row. */
function ModeSwitch({ mode, s, onMode }: { mode: Mode; s: SessionView; onMode: (m: Mode) => void }) {
  const name = useId();
  // Plain words: the segment draws every span inside an option as the option itself.
  const options: { id: Mode; label: string; title?: string }[] = [
    { id: "timeline", label: "Timeline" },
    // The list it opens holds the main loop's row too, so its count does, as the facts' Agents cell counts it.
    { id: "agents", label: `Agents ${s.agents.length + 1}`, title: launchedText(s) },
  ];
  return (
    <fieldset className="ui-segment">
      <legend className="ui-vh">Show the session as</legend>
      <div className="ui-segment-options">
        {options.map((o) => (
          <label key={o.id} title={o.title}>
            <input type="radio" name={name} value={o.id} checked={mode === o.id} onChange={() => onMode(o.id)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Why a session's changed files are unknown (FilesReport null): no git checkout seen, or none reported yet. */
const filesUnknown = (s: SessionView): string => (s.git === null ? "Not a git checkout, or not reported" : "Not reported yet");

/** The changed files, or "—" with the reason while they are not reported; folded, a narrow rail that opens them again. */
function FilesColumn({ s, folded, onFold }: { s: SessionView; folded: boolean; onFold: () => void }) {
  if (folded) {
    return (
      <aside className="sv-side" aria-label="Files">
        <button type="button" className="sv-side-rail" aria-expanded="false" title="Show the files" onClick={onFold}>
          <IconChevron />
          <span>Files</span>
        </button>
      </aside>
    );
  }
  return (
    <aside className="sv-side" aria-label="Files">
      <div className="sv-sh">
        <h2>Files</h2>
        <button type="button" className="ui-button ui-button--icon sv-fold" aria-expanded="true" aria-label="Hide the files" title="Hide the files" onClick={onFold}>
          <IconChevron />
        </button>
      </div>
      {s.files === null ? <Unknown reason={filesUnknown(s)} /> : <FilesList report={s.files} />}
    </aside>
  );
}

interface SessionPageProps {
  fleet: FleetState;
  session: SessionView;
  now: number;
  /** A stored session opened from History: shown as it was, with nothing to answer or send. */
  readOnly?: boolean;
  /** A way back, above the head (History's "Back to" its day). */
  back?: ReactNode;
  /** This session's events (useSessionEvents), read once by whoever shows the page: the Timeline's marks, and its list on a stored page. */
  events: SessionEvents;
}

export function SessionPage(props: SessionPageProps) {
  // Another session starts with its own view, sort and notices.
  return <Page key={props.session.id} {...props} />;
}

function Page({ session: s, now, readOnly = false, back, events }: SessionPageProps) {
  const [mode, setMode] = useState<Mode>("timeline");
  const [order, setOrder] = useState<AgentSort>(LAUNCH_ORDER);
  const [compactsOpen, setCompactsOpen] = useState(false);
  const [pageRef, pageWidth] = useWidth<HTMLDivElement>();
  const [folded, toggleFold] = useFilesFold(pageWidth);
  const { selected, flash, pickHere } = usePicked(s, readOnly);
  const footRef = useFootHeight();
  const compactsId = useId();

  const waitingOn = waitingOnByRow(s);
  const compactsShown = compactsOpen && !!s.blowouts?.total;
  // The Files place: the list when a file changed, "—" while files are not reported; no changed files, no column.
  const files: "list" | "unknown" | null = s.files === null ? "unknown" : s.files.files.length > 0 ? "list" : null;
  const bodyClass = files === null ? "sv-body alone" : folded ? "sv-body folded" : files === "unknown" ? "sv-body unknown" : "sv-body";

  // A header sorts its column; pressing it again turns the order round; null goes back to launch order.
  const onTableSort = (key: AgentSortKey | null) =>
    setOrder((cur) => {
      if (key === null) return LAUNCH_ORDER;
      if (cur.key === key) return { key, dir: cur.dir === 1 ? -1 : 1 };
      return { key, dir: defaultAgentDir(key) };
    });
  const switcher = <ModeSwitch mode={mode} s={s} onMode={setMode} />;

  return (
    <div className="sv-page" ref={pageRef}>
      {back}
      <SessionHead s={s} now={now} readOnly={readOnly} />
      <SessionNotices s={s} readOnly={readOnly} />
      {!readOnly && needsYou(s) ? <AskCard s={s} now={now} /> : null}
      <FactsBar s={s} now={now} readOnly={readOnly} onAgent={pickHere} compacts={{ open: compactsShown, onToggle: () => setCompactsOpen(!compactsOpen), controls: compactsId }} />
      {compactsShown ? <BlowoutCallout s={s} onAgent={pickHere} id={compactsId} /> : null}
      {planProgress(s.plan) ? (
        <section className="sv-planbox" aria-label="Plan">
          <PlanSteps s={s} now={now} />
        </section>
      ) : null}
      <div className={bodyClass}>
        <section className="sv-main" aria-label={mode === "timeline" ? "Timeline" : "Agents"}>
          {mode === "timeline" ? (
            <Timeline s={s} now={now} events={events} eventList={readOnly} sort={order} onSort={setOrder} selected={selected} flash={flash} onAgent={pickHere} lead={switcher} />
          ) : (
            <AgentTree s={s} waiting={waitingOn} now={now} sort={order} onSort={onTableSort} selectedAgent={selected} flashAgent={flash} onSelect={pickHere} lead={switcher} />
          )}
        </section>
        {files === null ? null : <FilesColumn s={s} folded={folded} onFold={toggleFold} />}
      </div>
      {readOnly ? null : <PageComposer s={s} footRef={footRef} />}
    </div>
  );
}
