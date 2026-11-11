// The inspector, the right pane: the fleet's activity (on a session's page, that session's own events, the ones the page
// reads), or, once an agent is picked anywhere, that agent's detail in the one panel, docked, with Back to the activity. Its
// width never changes between the two, so the main view never reflows. A picked agent that is no longer listed says so.
// Picking never moves focus (the station, node or row picked keeps it); a status line tells assistive technology what the pane now
// shows. A session that is no longer live (a History page hands it over) is drawn as stored: its links keep it, and its feed
// is not polled.
import type { ReactNode } from "react";
import { AgentDetailBody } from "../components/AgentDetail";
import { ActivityList, type ActivitySource, type OpenSession } from "../components/ActivityList";
import { OrchestratorDetailBody } from "../components/OrchestratorDetail";
import { familyName, ORCHESTRATOR_ROW } from "../logic";
import { stateOf, waitingOnByRow } from "../states";
import type { AgentView, SessionView } from "../types";
import { Panel } from "../ui/Panel";
import { Dots, dotsText } from "../ui/Dots";
import { stationWord, StationWord } from "../ui/Station";
import { agentKindText, agentName, agentStationKind } from "../views/session/trace";
import { useInspector } from "./inspector";

const TITLE_ID = "shell-pane-agent";

/** The line under a detail's title, on one line: what does not fit ends in "…", cut inside its words, and the whole line is its title. */
function Sub({ items, text }: { items: ReactNode[]; text: string }) {
  return (
    <span className="shell-pane-sub" title={text}>
      <Dots className="is-oneline" items={items} />
    </span>
  );
}

function AgentPanel({ s, a, now, feedOn, stored }: { s: SessionView; a: AgentView; now: number; feedOn: boolean; stored: boolean }) {
  const { pick, back } = useInspector();
  const asking = s.asks.some((x) => x.state !== "closed" && x.agentId === a.id);
  const kind = agentStationKind(a, asking, waitingOnByRow(s).has(a.id));
  const rest = [agentKindText(a), familyName(a.modelFamily, a.model), `in ${s.name}`];
  const sub = <Sub items={[<StationWord kind={kind} />, ...rest]} text={dotsText([stationWord(kind), ...rest])} />;
  return (
    <Panel title={agentName(a)} titleId={TITLE_ID} sub={sub} back={{ label: "Activity", onBack: back }} onClose={back}>
      <div className="shell-pane-agent">
        <AgentDetailBody s={s} a={a} now={now} onAgent={(id) => pick(s.id, id, stored ? s : undefined)} feedOn={feedOn} stored={stored} />
      </div>
    </Panel>
  );
}

/** The main loop's detail, its session's state first. */
function MainPanel({ s, now, feedOn, stored }: { s: SessionView; now: number; feedOn: boolean; stored: boolean }) {
  const { back } = useInspector();
  const kind = stateOf(s);
  const rest = ["main loop", familyName(s.modelFamily, s.model)];
  return (
    <Panel title={s.name} titleId={TITLE_ID} sub={<Sub items={[<StationWord kind={kind} />, ...rest]} text={dotsText([stationWord(kind), ...rest])} />} back={{ label: "Activity", onBack: back }} onClose={back}>
      <div className="shell-pane-agent">
        <OrchestratorDetailBody s={s} now={now} feedOn={feedOn} stored={stored} />
      </div>
    </Panel>
  );
}

interface InspectorPaneProps {
  id: string;
  hidden: boolean;
  activity: ActivitySource;
  /** On a session's page: that session and its own events, which the activity lists instead of the fleet's. */
  open: OpenSession | null;
  now: number;
  feedOn: boolean;
}

export function InspectorPane({ id, hidden, activity, open, now, feedOn }: InspectorPaneProps) {
  const { picked, back } = useInspector();
  const { sessions, gone } = activity;
  const live = picked && !Object.hasOwn(gone, picked.sessionId) && Object.hasOwn(sessions, picked.sessionId) ? sessions[picked.sessionId] : undefined;
  const s = live ?? picked?.session;
  const main = picked?.agentId === ORCHESTRATOR_ROW;
  const a = picked && !main ? s?.agents.find((x) => x.id === picked.agentId) : undefined;
  let body;
  if (!picked) body = <ActivityList {...activity} open={open} />;
  else if (s && main) body = <MainPanel key={`${s.id}:main`} s={s} now={now} feedOn={feedOn} stored={!live} />;
  else if (s && a) body = <AgentPanel key={`${s.id}:${a.id}`} s={s} a={a} now={now} feedOn={feedOn} stored={!live} />;
  else {
    body = (
      <Panel title="Agent" titleId={TITLE_ID} back={{ label: "Activity", onBack: back }} onClose={back}>
        <p className="ui-empty">That agent is no longer listed.</p>
      </Panel>
    );
  }
  return (
    <aside className="shell-pane" id={id} hidden={hidden} aria-label="Inspector">
      {body}
      <p className="ui-vh" role="status">
        {picked ? (s && main ? `${s.name}'s main loop shown in the inspector.` : a ? `${agentName(a)} shown in the inspector.` : "That agent is no longer listed.") : ""}
      </p>
    </aside>
  );
}
