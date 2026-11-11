// The console's frame: the sidebar, the top bar, the main view and the inspector (the fleet's activity, or a picked
// agent's detail), flush and resizable, then the passing notice and the answer drawer. While the stream is lost, a strip at the
// top of the main view says so, with the top bar hidden too; the wall view says it itself. Display mode lays the wall view
// (views/display) alone over the window, its layout switch and Exit in the corner. The fleet comes from useFleet; the shell
// applies the filter field, whose `m:` word is the machine scope the sidebar writes, and hands each view its sessions
// (views/types.ts); the wall takes every live session, since it shows no filter. While the server requires a sign-in to view and
// this browser has none, the page is the sign-in alone (components/SignIn SignInScreen), and signing in reads the fleet again.
import "./ui/tokens.css";
import "./ui/ui.css";
import "./shell/shell.css";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { agentIn, ALL_VIEWS, hashFor, movedFrom, routeFor, sessionIn, type MovedView, type View } from "../route";
import { needYouCount, useNotifications, useNotifyPref, useTitleCount } from "./attention";
import { PAGE, rowAgent, type ActivityFilter, type ActivitySource } from "./components/ActivityList";
import { ResizeHandle } from "./components/ResizeHandle";
import { AnswerDrawer } from "./components/Respond";
import { SignInScreen } from "./components/SignIn";
import { sharedNames } from "./groups";
import { ORCHESTRATOR_ROW, sortSessions, splitDetached, type SortKey } from "./logic";
import { Bar, lostWords } from "./shell/Bar";
import { applyFilter, hasScope, scopeIn, scopeTerm, withoutScope, withScope } from "./shell/filter";
import { InspectorProvider, useInspector } from "./shell/inspector";
import { InspectorPane } from "./shell/InspectorPane";
import { Nav, VIEW_LABELS, type SidebarMachine } from "./shell/Nav";
import { DISPLAY_LAYOUTS, useDisplayMode, type DisplayLayout } from "./shell/useDisplayMode";
import { useMotion } from "./shell/useMotion";
import { needsYou } from "./states";
import { readJson, writeJson } from "./storage";
import type { FleetState } from "./store";
import { APP_NAME, type ActivityView, type MachineView, type SessionView } from "./types";
import { Station } from "./ui/Station";
import { isUrgentChange, readRedraw, writeRedraw } from "./updateInterval";
import { useFleet } from "./useFleet";
import { useFleetPrefs, type FleetPrefs, type FleetPrefsApi } from "./useGroupPrefs";
import { useHeldState } from "./useHeldState";
import { useHotkeys } from "./useHotkeys";
import { useNow } from "./useNow";
import { usePanes, type Pane, type Panes } from "./usePanes";
import { useResizable } from "./useResizable";
import { RespondProvider, useRespond } from "./useRespond";
import { useTheme } from "./useTheme";
import { byWait } from "./waiting";
import { DisplayView } from "./views/display";
import { HistoryPage, storedHash } from "./views/history";
import { MachinesView, useRefusals } from "./views/machines";
import { NowView } from "./views/now";
import { useNotice } from "./views/now/controls";
import { PlansView } from "./views/plans";
import { SessionPage, useSessionEvents } from "./views/session";
import { SettingsView } from "./views/settings";
import type { BrowserPrefs, ViewProps } from "./views/types";

/** How long a row that just arrived (an event, a session) flashes. */
const ARRIVAL_MS = 1000;
const LAST_VIEW_KEY = "lastView";
const RAIL_ID = "shell-rail";
const PANE_ID = "shell-inspector";
const TOP_ID = "shell-top";
/** The keys that fold a pane away or bring it back. */
const PANE_KEYS = new Map<string, Pane>([
  ["\\", "top"],
  ["[", "left"],
  ["]", "right"],
]);

/** The views besides the Fleet and Settings, each drawn from the shell's props and the Fleet's choices (Plans sets background
 * sessions aside as the Fleet does). */
const VIEW_OF: Record<Exclude<View, "now" | "settings">, (props: ViewProps & { prefs: FleetPrefsApi }) => ReactNode> = { history: HistoryPage, plans: PlansView, machines: MachinesView };

/** The Fleet layout an old view's address opens the Fleet in: the Wall is Cards, the Map the List opened, the Graph
 * the Graph. */
const MOVED_LAYOUT: Partial<Record<MovedView, Partial<FleetPrefs>>> = { wall: { layout: "cards" }, map: { layout: "list", expandAll: true }, graph: { layout: "graph" } };

// ---- where the page is ---------------------------------------------------------------------------------------------------

/** The view this browser showed last; the Fleet when it showed none. */
const lastView = (): View => {
  const stored = readJson<unknown>(LAST_VIEW_KEY, "now");
  return ALL_VIEWS.find((v) => v === stored) ?? "now";
};

/**
 * The address of the view this browser showed last. One the old console remembered (`wall`, `map`, `graph`, `usage`)
 * gives its old address, which opens the place it moved to in its Fleet layout as an old link does (MOVED_LAYOUT); the view
 * then remembered is the new one, so this happens once.
 */
function lastHash(): string {
  const stored = readJson<unknown>(LAST_VIEW_KEY, "now");
  if (typeof stored === "string" && movedFrom(`#/${stored}`)) return `#/${stored}`;
  return hashFor(lastView());
}

/** The address the page opens at: as given, or for the server's plain URL the view this browser showed last (`#/` is the
 * Fleet's own address, so a link to the Fleet always opens it). */
function landingHash(): string {
  const given = location.hash;
  if (given !== "" && given !== "#") return given;
  const last = lastHash();
  if (last === hashFor("now")) return given;
  history.replaceState(history.state, "", last);
  return last;
}

/** The address, followed through links, Back and Forward; `replace` swaps it without a history entry. */
function useAddress(): [string, (hash: string) => void] {
  const [hash, setHash] = useState(landingHash);
  useEffect(() => {
    const follow = () => setHash(location.hash);
    addEventListener("hashchange", follow);
    addEventListener("popstate", follow);
    return () => {
      removeEventListener("hashchange", follow);
      removeEventListener("popstate", follow);
    };
  }, []);
  const replace = useCallback((next: string) => {
    history.replaceState(history.state, "", next);
    setHash(next);
  }, []);
  return [hash, replace];
}

/**
 * Whether an id arrived less than ARRIVAL_MS ago, so its row flashes once. The ids there when the fleet first loaded are the
 * baseline and never flash. Worked out while rendering: no state, no effect.
 */
function useArrivals(ids: readonly string[], ready: boolean): (id: string) => boolean {
  // Null until the first ready render, whose ids are the baseline.
  const firstSeen = useRef<Map<string, number> | null>(null);
  const at = Date.now();
  if (ready) {
    const baseline = firstSeen.current === null;
    const seen = (firstSeen.current ??= new Map());
    for (const id of ids) if (!seen.has(id)) seen.set(id, baseline ? 0 : at);
  }
  const seen = firstSeen.current;
  return (id) => {
    const when = seen?.get(id) ?? 0;
    return when > 0 && at - when < ARRIVAL_MS;
  };
}

// ---- what the frame shows ------------------------------------------------------------------------------------------------

/** The sessions that need you, in the one order the Fleet's queue follows (waiting.ts byWait): the needs-you button opens the first,
 * the answer drawer steps through them all. */
const waitQueue = (sessions: Record<string, SessionView>): string[] =>
  Object.values(sessions)
    .filter(needsYou)
    .sort(byWait)
    .map((s) => s.id);

/** The same array as last time while its ids and order hold, so a memoized frame does not redraw for it. */
function useSameList(list: string[]): string[] {
  const kept = useRef(list);
  if (list.length !== kept.current.length || list.some((id, i) => id !== kept.current[i])) kept.current = list;
  return kept.current;
}

/**
 * The machines with sessions the sidebar lists, by name, the name and OS from the server's row when it has one, each with those
 * sessions in the Fleet's sort: background ones set aside unless the Fleet shows them, so the sidebar counts what it lists.
 */
function sidebarMachines(live: readonly SessionView[], rows: readonly MachineView[], now: number, background: boolean, sort: SortKey): SidebarMachine[] {
  const row = new Map(rows.map((m) => [m.id, m]));
  const shared = sharedNames([...rows.map((m) => ({ machine: m })), ...live]);
  const byId = new Map<string, SidebarMachine>();
  for (const s of sortSessions(splitDetached(live, now, background).shown, sort)) {
    const known = byId.get(s.machine.id);
    if (known) {
      known.sessions.push(s);
      continue;
    }
    const m = row.get(s.machine.id) ?? s.machine;
    const machine = { id: s.machine.id, name: m.name };
    byId.set(machine.id, { ...machine, os: m.os, shared: shared.has(machine.id), term: scopeTerm(machine, shared.has(machine.id)), sessions: [s] });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

/**
 * The answer drawer, for whichever live session it was opened on. When that session leaves, the drawer keeps it as last seen
 * and closes through its dialog, so focus goes back to what opened it as on every other close.
 */
function AnswerHost({ sessions, now, feedOn, waits }: { sessions: Record<string, SessionView>; now: number; feedOn: boolean; waits: readonly string[] }) {
  const ctx = useRespond();
  const openFor = ctx?.openFor ?? null;
  const live = openFor !== null && Object.hasOwn(sessions, openFor) ? sessions[openFor] : undefined;
  // The session as the drawer last drew it, kept while rendering (React's pattern for state that follows a prop).
  const [last, setLast] = useState<SessionView | null>(null);
  if (live && live !== last) setLast(live);
  const s = live ?? (last?.id === openFor ? last : undefined);
  // Opened on a session this page never held: no drawer was drawn, so no dialog closes it.
  useEffect(() => {
    if (openFor !== null && !s) ctx?.close();
  }, [ctx, openFor, s]);
  return s ? <AnswerDrawer s={s} now={now} serverFeedOn={feedOn} leaving={!live} waits={waits} /> : null;
}

/** The strip while the stream is lost, in the notice's words (shell/Bar lostWords): `loaded` once a first snapshot came. */
function LostStrip({ loaded }: { loaded: boolean }) {
  const { head, rest } = lostWords(loaded);
  return (
    <div className="shell-strip">
      <Station kind="failed" />
      <span className="shell-strip-text">
        <b>{head}</b> {rest}
      </span>
    </div>
  );
}

// ---- the frame -------------------------------------------------------------------------------------------------------------

export function FleetApp() {
  // A sign-in at the view gate starts the fleet over (useFleet).
  const [attempt, setAttempt] = useState(0);
  const live = useFleet(attempt);
  const [redraw, setRedraw] = useState(readRedraw);
  // The views redraw once per chosen interval; something that needs you, or a failure, shows at once.
  const fleet = useHeldState(live, redraw * 1000, isUrgentChange);
  const onEvery = useCallback((seconds: number) => {
    setRedraw(seconds);
    writeRedraw(seconds);
  }, []);
  // Attention follows the live fleet, not the held one, so the tab title, notifications and the needs-you count never wait.
  const notify = useNotifyPref();
  const needYou = needYouCount(live.sessions);
  const waits = useSameList(useMemo(() => waitQueue(live.sessions), [live.sessions]));
  useTitleCount(APP_NAME, needYou);
  useNotifications(notify.availability === "on", live.phase !== "loading", live.sessions, live.machines);
  // A session as the live fleet has it, and the server's clock, read through a ref so the memoized frame does not redraw for
  // every message: a link to a session that arrived since the views last redrew opens it (Frame), and an answer's receipt
  // reads its last check-in against the server's time.
  const liveRef = useRef(live);
  liveRef.current = live;
  const liveSession = useCallback((id: string) => (Object.hasOwn(liveRef.current.sessions, id) ? liveRef.current.sessions[id]! : null), []);
  const serverNow = useCallback(() => liveRef.current.serverTime, []);
  // Behind the view gate the page is the sign-in alone: the fleet was dropped (store.ts), and nothing of the console is drawn.
  return (
    <RespondProvider settingsOn={fleet.settings.respond && fleet.settings.activityFeed} liveSession={liveSession} serverNow={serverNow}>
      {live.gated ? <SignInScreen onSignedIn={() => setAttempt((n) => n + 1)} /> : <Console fleet={fleet} liveSession={liveSession} needYou={needYou} waits={waits} every={redraw} onEvery={onEvery} notify={notify} />}
    </RespondProvider>
  );
}

interface ConsoleProps {
  fleet: FleetState;
  /** A session as the live fleet has it, which the held `fleet` may not yet; null when it is not live. */
  liveSession: (id: string) => SessionView | null;
  needYou: number;
  /** The sessions that need you, longest wait first (waitQueue). */
  waits: string[];
  every: number;
  onEvery: (seconds: number) => void;
  notify: BrowserPrefs["notify"];
}

// Memoized: the held fleet keeps its identity between ticks, so a message that changes nothing urgent does not redraw the page.
const Console = memo(function Console(props: ConsoleProps) {
  const panes = usePanes();
  const { reveal } = panes;
  // Picking an agent anywhere shows the inspector if it was folded away.
  const showInspector = useCallback(() => reveal("right"), [reveal]);
  return (
    <InspectorProvider onPick={showInspector}>
      <Frame {...props} panes={panes} />
    </InspectorProvider>
  );
});

function Frame({ fleet, liveSession, needYou, waits, every, onEvery, notify, panes }: ConsoleProps & { panes: Panes }) {
  const now = useNow(every * 1000);
  const theme = useTheme();
  const respond = useRespond();
  const prefs = useFleetPrefs();
  const display = useDisplayMode();
  const { picked, pick, back } = useInspector();
  const [hash, replaceHash] = useAddress();
  const route = routeFor(hash);
  const [notice, setNotice] = useNotice();
  const [query, setQuery] = useState("");
  const { collapsed, toggle } = panes;
  const [evShown, setEvShown] = useState(PAGE);
  const [evFilter, setEvFilter] = useState<ActivityFilter>({ kind: null, find: "" });
  const ready = fleet.phase !== "loading";

  // The frame's element, for the panes' drag limits.
  const frameRef = useRef<HTMLDivElement>(null);
  const container = useCallback(() => frameRef.current, []);
  const resize = useResizable(container);
  // Settings' Animation, and every pulse in phase.
  useMotion();

  // The view is remembered per browser: the one the owner opens, never History's stored page that a session's page turns into
  // by itself when its session ends (`switched`, set just before that switch).
  const switched = useRef(false);
  useEffect(() => {
    if (route !== "session" && !switched.current) writeJson(LAST_VIEW_KEY, route);
    switched.current = false;
  }, [route]);

  // An old view's address opens the place it moved to, the Fleet in the layout it was, in place (no history entry).
  const { set: setPrefs } = prefs;
  useEffect(() => {
    const moved = movedFrom(hash);
    if (!moved) return;
    const layout = MOVED_LAYOUT[moved.from];
    if (layout) setPrefs(layout);
    replaceHash(hashFor(moved.to));
  }, [hash, setPrefs, replaceHash]);

  const selId = route === "session" ? sessionIn(hash) : null;
  // A new view or another session's page opens at its top, before it paints.
  const sheet = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (sheet.current) sheet.current.scrollTop = 0;
  }, [route, selId]);
  // The session as the views hold it, or as the live fleet has it when it arrived since they last redrew.
  const selSession = selId === null ? null : Object.hasOwn(fleet.sessions, selId) ? fleet.sessions[selId]! : liveSession(selId);
  // The open session's events, read once for its page and the inspector alike, so the two never disagree.
  const sessionEvents = useSessionEvents(selSession?.id ?? null, fleet.events);
  // The open session as the page last showed it, so an end the page saw is told from one a snapshot inferred.
  const lastShown = useRef<SessionView | null>(null);
  if (selSession) lastShown.current = selSession;
  // A session's page whose session left on an end the page saw (its own Done view, or the server's `removed` for one that went
  // silent; never a reason store goneSince inferred, as usePins) stays open as History's stored, read-only page for it. One
  // deleted, not live, or an address naming none it can read: say so and go back.
  useEffect(() => {
    if (route !== "session" || !ready || selSession) return;
    const gone = selId !== null && Object.hasOwn(fleet.gone, selId) ? fleet.gone[selId] : undefined;
    const sawDone = lastShown.current?.id === selId && lastShown.current.status === "done";
    if (selId !== null && (sawDone || gone === "dropped")) {
      switched.current = true;
      replaceHash(storedHash(selId));
      return;
    }
    setNotice(gone === "deleted" ? "The session was deleted" : "Not live; ended sessions are in History");
    replaceHash(hashFor(lastView()));
  }, [route, selId, selSession, ready]);

  // Another session's page, or none, opens with the inspector on the activity; an address naming an agent then picks it, below.
  useEffect(() => back(), [selId, back]);
  // A stored session's pick (History hands the session over) lives only on History. Before the address's pick below, so a link
  // out of History to an agent still picks it.
  useEffect(() => {
    if (route !== "history" && picked?.session) back();
  }, [route, picked, back]);

  // On a session's page the address and the pick stay in step (#/s/<id>?agent=<agentId>): an address naming one of its loops
  // picks it (again when the address, the session or its list changes); an id it does not list is ignored. Picking writes the
  // agent into the address and Back takes it out, in place, so the same link opens the agent again later.
  const linkedAgent = route === "session" ? agentIn(hash) : null;
  const linkKnown = linkedAgent !== null && selSession !== null && (linkedAgent === ORCHESTRATOR_ROW || selSession.agents.some((a) => a.id === linkedAgent));
  useEffect(() => {
    if (selId !== null && linkedAgent !== null && linkKnown) pick(selId, linkedAgent);
  }, [selId, linkedAgent, linkKnown, pick]);
  const lastPicked = useRef(picked);
  useEffect(() => {
    if (picked === lastPicked.current) return;
    lastPicked.current = picked;
    if (route !== "session" || selId === null) return;
    const next = hashFor("session", selId, picked !== null && picked.sessionId === selId ? picked.agentId : null);
    if (next !== location.hash) replaceHash(next);
    // Only a new pick writes the address; the route and session it is written for are this render's.
  }, [picked]);

  // The refused reports, read once for the sidebar's Machines badge and the Machines page, more often while that page shows.
  const refusals = useRefusals(route === "machines" && !display.on);

  // Every view gets the live sessions through the filter field; the sidebar lists the machines with sessions it lists.
  const present = useMemo(() => Object.values(fleet.sessions), [fleet.sessions]);
  const filtered = useMemo(() => applyFilter(present, query), [present, query]);
  const machines = sidebarMachines(present, fleet.machines, now, prefs.prefs.background, prefs.prefs.sort);
  const scope = scopeIn(query);
  // The Graph's machine hubs toggle their machine on the page they filter.
  const scopeTo = (term: string) => setQuery((q) => withScope(q, term));
  const scopeToName = (name: string) => scopeTo(machines.find((m) => m.name === name)?.term ?? scopeTerm({ id: name, name }, false));
  // A sidebar machine toggles its word too, and the page stays, narrowed; Settings and a session's page, which the word does not
  // narrow, open the Fleet with it instead.
  const pickMachine = (term: string) => {
    const stays = route !== "settings" && route !== "session";
    if (stays || scope !== term) scopeTo(term);
    if (!stays) location.hash = hashFor("now");
  };
  const sessionIsNew = useArrivals(
    present.map((s) => s.id),
    ready,
  );
  const eventIsNew = useArrivals(
    fleet.events.map((e) => e.id),
    ready,
  );

  useHotkeys((e) => {
    const pane = PANE_KEYS.get(e.key);
    if (pane && !display.on) toggle(pane);
  });

  // A row about one of a session's listed agents shows it in the inspector; any other row opens the session's page.
  const openEvent = (event: ActivityView) => {
    if (Object.hasOwn(fleet.gone, event.sessionId) || !Object.hasOwn(fleet.sessions, event.sessionId)) return;
    const s = fleet.sessions[event.sessionId]!;
    const agent = rowAgent(event, s);
    if (agent !== null) pick(s.id, agent);
    else location.hash = hashFor("session", s.id);
  };
  const activity: ActivitySource = { events: fleet.events, isNew: eventIsNew, shown: evShown, onShown: setEvShown, filter: evFilter, onFilter: setEvFilter, onOpen: openEvent, sessions: fleet.sessions, gone: fleet.gone };
  const stream = fleet.phase === "loading" && fleet.error !== null ? "disconnected" : fleet.phase;
  const browser: BrowserPrefs = { theme, notify, every, onEvery };

  let view: ReactNode;
  if (!ready) view = <p className="shell-connecting">Connecting…</p>;
  else if (display.on) view = <DisplayView fleet={fleet} now={now} layout={display.layout} background={prefs.prefs.background} onLeave={display.exit} />;
  else if (route === "now") {
    view = <NowView fleet={fleet} sessions={filtered} now={now} browser={browser} refusals={refusals} prefs={prefs} scope={scope} onScope={scopeToName} query={query} onQuery={setQuery} />;
  } else if (route === "session") view = selSession ? <SessionPage fleet={fleet} session={selSession} now={now} events={sessionEvents} /> : null;
  else if (route === "settings") {
    view = <SettingsView fleet={fleet} sessions={filtered} now={now} browser={browser} refusals={refusals} topBar={{ hidden: collapsed.top, controls: TOP_ID, onToggle: () => toggle("top") }} />;
  } else {
    const Page = VIEW_OF[route];
    view = <Page fleet={fleet} sessions={filtered} now={now} browser={browser} refusals={refusals} scope={scope} prefs={prefs} />;
  }

  // Each pane's width: 0 while folded or in display mode, else the one dragged to (or its default).
  const shut = (folded: boolean) => folded || display.on;
  const frameStyle = {
    "--rail-w": shut(collapsed.left) ? "0px" : `${resize.width("rail")}px`,
    "--pane-w": shut(collapsed.right) ? "0px" : `${resize.width("side")}px`,
    "--top-h": shut(collapsed.top) ? "0px" : "var(--top-h-base)",
  } as CSSProperties;
  // The stream is lost (or the first load failed): the strip shows, and what sits at the main view's top steps below it. The
  // wall view, once drawn, says it in its own banner, which moves nothing.
  const lost = stream === "disconnected" && !(display.on && ready);
  const shellClass = ["shell", display.on && "is-display", display.on && display.idle && "is-idle", lost && "is-lost"].filter(Boolean).join(" ");
  return (
    <div className={shellClass} data-route={route}>
      <div ref={frameRef} className="shell-frame" style={frameStyle}>
        <Nav
          id={RAIL_ID}
          hidden={shut(collapsed.left)}
          route={route}
          openSession={selSession?.id ?? null}
          fleet={fleet}
          now={now}
          live={present}
          refusals={refusals}
          machines={machines}
          scope={scope}
          scoped={hasScope(query)}
          onShowAll={() => setQuery(withoutScope)}
          onMachine={pickMachine}
          onHide={() => toggle("left")}
          isNew={sessionIsNew}
        />
        <Bar
          id={TOP_ID}
          hidden={shut(collapsed.top)}
          route={route}
          sidebar={{ controls: RAIL_ID, folded: collapsed.left, onShow: () => toggle("left") }}
          query={query}
          onQuery={setQuery}
          stream={stream}
          needYou={needYou}
          onNeedYou={(opener) => {
            if (waits[0]) respond?.open(waits[0], opener);
          }}
          activity={{ controls: PANE_ID, open: !collapsed.right, onToggle: () => toggle("right") }}
          onDisplay={() => display.enter(true)}
          theme={theme}
        />
        <div className="shell-strip-slot" role="status">
          {lost ? <LostStrip loaded={fleet.server !== null} /> : null}
        </div>
        {collapsed.top && !display.on ? (
          <button type="button" className="ui-button shell-show-top" aria-controls={TOP_ID} aria-expanded="false" title="Show the top bar (\)" onClick={() => toggle("top")}>
            Show the top bar
          </button>
        ) : null}
        <main ref={sheet} className="shell-sheet" aria-label={display.on ? VIEW_LABELS.now : route === "session" ? "Session" : VIEW_LABELS[route]}>
          {view}
        </main>
        <InspectorPane id={PANE_ID} hidden={shut(collapsed.right)} activity={activity} open={selSession ? { session: selSession, events: sessionEvents } : null} now={now} feedOn={fleet.settings.activityFeed} />
        {shut(collapsed.left) ? null : <ResizeHandle panel="rail" r={resize} container={container} label="Resize the sidebar" />}
        {shut(collapsed.right) ? null : <ResizeHandle panel="side" r={resize} container={container} label="Resize the inspector" />}
      </div>
      {display.on ? (
        <div className="shell-display-bar" data-display-control data-theme="dark">
          <div className="ui-segment-options" role="group" aria-label="Layout" title="Layout (l)">
            {(Object.keys(DISPLAY_LAYOUTS) as DisplayLayout[]).map((k) => (
              <button key={k} type="button" aria-pressed={display.layout === k} onClick={() => display.setLayout(k)}>
                {DISPLAY_LAYOUTS[k]}
              </button>
            ))}
          </div>
          <button type="button" className="ui-button" title="Leave display mode (Esc)" onClick={display.exit}>
            Exit
          </button>
        </div>
      ) : null}
      <div className="shell-notice" role="status" hidden={!notice}>
        {notice}
      </div>
      <AnswerHost sessions={fleet.sessions} now={now} feedOn={fleet.settings.activityFeed} waits={waits} />
    </div>
  );
}
