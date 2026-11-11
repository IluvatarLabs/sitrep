// Activity, the inspector's own content: the fleet's events (the newest the page holds) or, on a session's page,
// that session's own events, the ones its page reads (useSessionEvents), so the two never disagree. Newest first, a page at a
// time, narrowed by kind and by a find field. One line per event: its time, a mark (the state it tells of, in that state's
// colour, else what kind of event it is), the session and what happened; the whole row is the link (an agent's event shows the agent in the inspector, any other opens the session's
// page), and a row of a session that left is greyed and inert. A row that just arrived flashes once. The list fills the pane's
// height and scrolls inside it; the count and Show more / Show fewer sit in a footer pinned to the pane's bottom. Styles:
// shell/shell.css.
import type { ReactNode } from "react";
import { readableEvent } from "../eventText";
import { fmtClock } from "../format";
import { parentOf } from "../logic";
import { needsYou } from "../states";
import { EVENT_CAP } from "../store";
import type { ActivityView, SessionView } from "../types";
import { dotsText } from "../ui/Dots";
import { Station, type StationKind } from "../ui/Station";
import { messageText } from "../views/session/trace";
import type { SessionEvents } from "../views/session/useSessionEvents";
import { idleOnBackground, parseBackgroundEvent, parseWaitEvent } from "../waiting";

/**
 * Rows shown at first, and added by "Show more". Rows are 32 px and the pane's head, filters and footer 137, so a page fills
 * the list in a window up to about 1,420 px tall (at 1,080 px, 30 do); the list scrolls inside the pane past what fits.
 */
export const PAGE = 40;

type Kind = ActivityView["kind"];

/** Each kind's name in the filter, in the filter's order. */
const KIND_LABEL: Record<Kind, string> = {
  wait: "Waits",
  fail: "Failures",
  blow: "Auto-compacts",
  compact: "Compactions",
  message: "Messages",
  spawn: "Launches",
  done: "Finished",
  plan: "Plan steps",
  edit: "Edits",
  skill: "Skills",
  note: "Notes",
  start: "Starts",
  end: "Ends",
};
const KINDS = Object.keys(KIND_LABEL) as Kind[];

/** What the list is narrowed to: one kind (null for every kind) and the words to find. */
export interface ActivityFilter {
  kind: Kind | null;
  find: string;
}

/** The agent a row leads to, shown in the inspector; null when the row opens the session's page. */
export function rowAgent(e: ActivityView, live: SessionView | undefined): string | null {
  return live && e.agentId !== null && live.agents.some((a) => a.id === e.agentId) ? e.agentId : null;
}

/** The state an event tells of. A wait keeps its needs-you mark only while it is the session's newest news and still waited on
 * (amber means only "needs you" now), and background work its working mark likewise; events that change no state have none. */
function markOf(e: ActivityView, live: SessionView | undefined, newest: boolean): StationKind | null {
  switch (e.kind) {
    case "fail":
      return "failed";
    case "done":
      return "done";
    // The server writes "heartbeat lost" for a session it dropped (fleet.ts END_TEXT): it went offline, it did not finish.
    case "end":
      return e.text === "heartbeat lost" ? "offline" : "done";
    case "start":
    case "spawn":
      return "working";
    case "wait": {
      if (!newest || !live) return null;
      if (parseWaitEvent(e.text)) return needsYou(live) ? "needs-you" : null;
      return parseBackgroundEvent(e.text) && idleOnBackground(live) ? "working" : null;
    }
    // A plan that completed is done; a plan or a step that started has its own glyph (KindGlyph).
    case "plan":
      return e.text.startsWith("plan complete") ? "done" : null;
    default:
      return null;
  }
}

/**
 * An event that tells of no state shows what kind it is, in the Timeline's shapes where it has one: a ring with a centre dot for
 * a message, a diamond for an auto-compact (hollow for a compaction asked for). A step that started is in the working colour,
 * a message and an auto-compact a tone stronger than the rest, which are muted. Decorative: the row's words say the same.
 */
function KindGlyph({ kind }: { kind: Kind }) {
  const draw = (): ReactNode => {
    switch (kind) {
      case "message":
        return (
          <>
            <circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="8" cy="8" r="1.6" fill="currentColor" />
          </>
        );
      case "plan":
        return <path d="M5.6 4.2l6 3.8-6 3.8z" fill="currentColor" />;
      case "blow":
        return <path d="M8 2.8L13.2 8 8 13.2 2.8 8z" fill="currentColor" />;
      case "compact":
        return <path d="M8 3.6L12.4 8 8 12.4 3.6 8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />;
      case "edit":
        return <path d="M3.6 12.4l.5-2.6 6.3-6.3 2.1 2.1-6.3 6.3zM9.4 4.5l2.1 2.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />;
      case "skill":
        return <path d="M8 2.6l1.5 3.9 3.9 1.5-3.9 1.5L8 13.4l-1.5-3.9L2.6 8l3.9-1.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />;
      // A wait that is answered, or no longer the session's news: the needs-you mark's bars, without its amber.
      case "wait":
        return <path d="M6.2 4.8v6.4M9.8 4.8v6.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />;
      default:
        return <path d="M4 5.4h8M4 8h8M4 10.6h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />;
    }
  };
  return (
    <svg className={`shell-act-kind is-${kind}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {draw()}
    </svg>
  );
}

/** A row's words and the tool it names: a message, or the event in our words (eventText.ts), with who launched an agent. */
function wordsOf(e: ActivityView, live: SessionView | undefined): { text: string; tool: string | null } {
  if (e.kind === "message") {
    const to = typeof e.data?.toName === "string" && e.data.toName ? e.data.toName : "another agent";
    return { text: `Message to ${to}: ${messageText(e.text)}`, tool: null };
  }
  // The server's own end words (fleet.ts END_TEXT), in History's words.
  if (e.kind === "end" && e.text === "heartbeat lost") return { text: "Went offline", tool: null };
  if (e.kind === "end" && e.text === "session ended") return { text: "Ended", tool: null };
  const launched = e.kind === "spawn" && live && e.agentId ? live.agents.find((a) => a.id === e.agentId) : undefined;
  const parent = launched && live ? parentOf(live.agents, launched) : null;
  const plain = readableEvent(e) ?? { text: e.text, tool: null };
  return parent ? { text: dotsText([plain.text, `launched by ${parent.description}`]), tool: plain.tool } : plain;
}

/**
 * One row per ending: the reporter's "session.end · why" arrives first, then the server's own "session ended" as the session
 * leaves (fleet.ts END_TEXT), seconds apart and saying less. The server's row stays only for a session whose reporter sent none.
 */
function withOneEnd(events: readonly ActivityView[]): ActivityView[] {
  const told = new Set(events.filter((e) => e.kind === "end" && e.text.startsWith("session.end")).map((e) => e.sessionId));
  return events.filter((e) => !(e.kind === "end" && e.text === "session ended" && told.has(e.sessionId)));
}

function EventRow({ e, live, newest, fresh, named, onOpen }: { e: ActivityView; live: SessionView | undefined; newest: boolean; fresh: boolean; named: boolean; onOpen: (e: ActivityView) => void }) {
  const mark = markOf(e, live, newest);
  const { text, tool } = wordsOf(e, live);
  const said = dotsText([named ? e.sessionName : null, text, tool]);
  const cls = ["shell-act-row", fresh && "ui-flash", e.kind === "fail" && "is-bad", mark === "needs-you" && "is-asking", !live && "is-gone"].filter(Boolean).join(" ");
  const content = (
    <>
      <time dateTime={new Date(e.t).toISOString()}>{fmtClock(e.t)}</time>
      {mark ? <Station kind={mark} label={mark === "offline" ? "Went offline" : true} /> : <KindGlyph kind={e.kind} />}
      <span className="shell-act-text">
        {named ? <b>{e.sessionName}</b> : null}
        <span>{text}</span>
        {tool ? <code className="shell-act-tool">{tool}</code> : null}
      </span>
    </>
  );
  return (
    <li>
      {live ? (
        <button type="button" className={cls} title={said} onClick={() => onOpen(e)}>
          {content}
        </button>
      ) : (
        <div className={cls} title={`${said} (ended)`}>
          {content}
        </div>
      )}
    </li>
  );
}

/** The fleet's events and how the list pages, narrows and opens them: what the inspector hands down. */
export interface ActivitySource {
  events: ActivityView[];
  isNew: (id: string) => boolean;
  /** How many rows show; "Show more" and "Show fewer" change it by a page. */
  shown: number;
  onShown: (n: number) => void;
  filter: ActivityFilter;
  onFilter: (f: ActivityFilter) => void;
  onOpen: (e: ActivityView) => void;
  /** Live sessions, and those that left (their rows are greyed and inert). */
  sessions: Record<string, SessionView>;
  gone: Record<string, unknown>;
}

/** A session's page: the session and its own events, read once by the shell for the page and this list alike. */
export interface OpenSession {
  session: SessionView;
  events: SessionEvents;
}

export function ActivityList(props: ActivitySource & { open: OpenSession | null }) {
  const { open, shown, filter, onFilter } = props;
  const all = withOneEnd(open ? open.events.events : props.events);
  const counts = new Map<Kind, number>();
  for (const e of all) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const find = filter.find.trim().toLowerCase();
  const list = all.filter((e) => (filter.kind === null || e.kind === filter.kind) && (!find || `${e.sessionName}\n${e.text}`.toLowerCase().includes(find)));
  // Each session's newest event, so a wait row knows whether it is still that session's latest news.
  const newestAt = new Map<string, number>();
  for (const e of all) newestAt.set(e.sessionId, Math.max(e.t, newestAt.get(e.sessionId) ?? -Infinity));
  const rows = list.slice(0, shown);
  const more = list.length - shown;

  let note: string | null = null;
  if (open?.events.loading && all.length === 0) note = "Loading…";
  else if (open?.events.failed) note = "Stored events unreadable; new ones still show.";
  return (
    <section className="shell-act" aria-labelledby="shell-act-title">
      <header className="ui-panel-head">
        <h2 id="shell-act-title" className="ui-panel-title">
          {open ? dotsText(["Activity", open.session.name]) : "Activity"}
        </h2>
      </header>
      <div className="shell-act-filters">
        <select className="ui-select" aria-label="Kind of event" value={filter.kind ?? ""} onChange={(e) => onFilter({ ...filter, kind: (e.target.value || null) as Kind | null })}>
          <option value="">{`All kinds (${all.length})`}</option>
          {/* The kinds these events carry; a kind chosen earlier stays, at 0, so the choice in force is always the one shown. */}
          {KINDS.filter((k) => counts.has(k) || k === filter.kind).map((k) => (
            <option key={k} value={k}>{`${KIND_LABEL[k]} (${counts.get(k) ?? 0})`}</option>
          ))}
        </select>
        <input className="shell-find" type="search" aria-label="Find in activity" placeholder="Find" autoComplete="off" spellCheck={false} value={filter.find} onChange={(e) => onFilter({ ...filter, find: e.target.value })} />
      </div>
      <div className="shell-act-scroll">
        {note ? <p className="ui-empty">{note}</p> : null}
        {rows.length > 0 ? (
          <ul className="shell-act-list">
            {rows.map((e) => (
              <EventRow
                key={e.id}
                e={e}
                live={props.gone[e.sessionId] ? undefined : props.sessions[e.sessionId]}
                newest={e.t >= (newestAt.get(e.sessionId) ?? -Infinity)}
                fresh={props.isNew(e.id)}
                named={!open}
                onOpen={props.onOpen}
              />
            ))}
          </ul>
        ) : null}
        {rows.length === 0 && all.length > 0 ? (
          <div className="ui-empty">
            No matches{" "}
            <button type="button" className="ui-button" onClick={() => onFilter({ kind: null, find: "" })}>
              Clear filter
            </button>
          </div>
        ) : null}
      </div>
      {list.length > PAGE || more > 0 || open?.events.cut ? (
        <div className="shell-act-more">
          {/* A session's list is its newest stored events when it has more than were read (useSessionEvents `cut`). */}
          <span title={open ? undefined : `The page holds the newest ${EVENT_CAP}.`}>{`${rows.length} of ${list.length}${open?.events.cut ? ", the newest stored events" : ""}`}</span>
          {shown > PAGE ? (
            <button type="button" className="ui-button" onClick={() => props.onShown(PAGE)}>
              Show fewer
            </button>
          ) : null}
          {more > 0 ? (
            <button type="button" className="ui-button" onClick={() => props.onShown(shown + PAGE)}>
              {`Show ${Math.min(PAGE, more)} more`}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
