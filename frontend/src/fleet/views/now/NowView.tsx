// The Fleet page, the home (the view `now` in code): what needs me, what is wrong, what is everything
// doing? The state bar (its chips write the filter field's `s:` word and count what each would show; its spend and plan windows
// open the usage panel under it), Attention (Needs you beside Problems under one header, shut until opened, its counts on the
// header), then the Sessions in their layout: Cards, List or Graph. Display mode shows the wall view instead (views/display). The
// sessions come through the filter field (whose `m:` is the machine selected); Needs you and Problems take every one of them,
// background ones included.
import { useMemo } from "react";
import { ADD_MACHINE_HASH } from "../../../route";
import { machineLabels } from "../../groups";
import { splitDetached } from "../../logic";
import { applyFilter, withoutState } from "../../shell/filter";
import type { FleetState } from "../../store";
import type { SessionView } from "../../types";
import { usePins } from "../../usePins";
import type { FleetPrefsApi } from "../../useGroupPrefs";
import { GraphLayout } from "../graph";
import type { ViewProps } from "../types";
import { Cards } from "../wall/Cards";
import { AttentionHead, FleetControls, FleetMachines, FleetSpendTotal } from "./controls";
import { shapeFleet, stateCounts } from "./fleet";
import { FleetList } from "./FleetList";
import { NeedsYou } from "./NeedsYou";
import { Problems } from "./Problems";
import { problemItems, queueItems, worstProblem } from "./queue";
import { StateBar } from "./StateBar";
import { useSettled } from "./useSettled";
import "./now.css";

export interface NowProps extends ViewProps {
  prefs: FleetPrefsApi;
  /** A Graph hub was clicked: scope the console to that machine. */
  onScope: (machineName: string) => void;
  /** The filter field, whose `s:` word the state chips write. */
  query: string;
  onQuery: (q: string) => void;
  /** The filter's machine scope (ViewProps.scope), required here: the usage panel's Today follows it. */
  scope: string | null;
}

/** Every live session, and each machine's name as rows print it (groups machineLabels); the wall view's too. */
export function useLiveSessions(fleet: FleetState): { all: SessionView[]; labels: ReadonlyMap<string, string> } {
  const all = useMemo(() => Object.values(fleet.sessions), [fleet.sessions]);
  const labels = useMemo(() => machineLabels([...fleet.machines.map((m) => ({ machine: m })), ...all]), [fleet.machines, all]);
  return { all, labels };
}

export function NowView({ fleet, sessions, now, prefs, onScope, query, onQuery, scope }: NowProps) {
  const pins = usePins(fleet.phase === "loading" ? null : fleet.sessions, fleet.gone);
  const { all, labels } = useLiveSessions(fleet);
  const inViewIds = new Set(sessions.map((s) => s.id));
  const { layout, sort, groupBy, background, attentionOpen } = prefs.prefs;
  const spend = new Map((fleet.kpis?.costTodayByMachine ?? []).map((m) => [m.machineId, m.unpriced ? null : m.costUsd]));
  const spendOf = (id: string) => (fleet.kpis ? (spend.has(id) ? (spend.get(id) ?? null) : 0) : null);
  const shape = shapeFleet(sessions, now, { sort, groupBy, background }, labels);
  // Each chip counts its state among what the rest of the field lets through, so pressing one never zeroes the others.
  const counts = stateCounts(applyFilter(all, withoutState(query)), now, background);
  const queue = queueItems(sessions);
  const settled = useSettled(all, fleet.config.lingerMs).filter((x) => inViewIds.has(x.sessionId));
  const problems = problemItems(sessions);
  const needCount = new Set(queue.map((x) => x.s.id)).size;
  // The worst of the problems, for the header's mark.
  const worst = worstProblem(problems);

  let body;
  if (fleet.phase === "loading") body = <p className="ui-empty">Connecting…</p>;
  else if (all.length === 0)
    body = (
      <div className="ui-empty">
        No live sessions{" "}
        <a className="ui-button" href={ADD_MACHINE_HASH}>
          Add a machine
        </a>
      </div>
    );
  else if (shape.shown.length === 0) {
    body = (
      <div className="ui-empty">
        No matches{" "}
        <button type="button" className="ui-button" onClick={() => onQuery("")}>
          Clear filter
        </button>
      </div>
    );
  } else if (layout === "graph") body = <GraphLayout sessions={shape.shown} fleet={fleet} now={now} group={groupBy} query={query} onScope={onScope} />;
  else if (layout === "cards") body = <Cards shape={shape} now={now} prefs={prefs} pins={pins.pins} onPin={pins.toggle} spendOf={spendOf} labels={labels} />;
  else body = <FleetList shape={shape} all={all} now={now} prefs={prefs} pins={pins.pins} onPin={pins.toggle} spendOf={spendOf} />;

  return (
    <div className="now">
      <StateBar counts={counts} query={query} onQuery={onQuery} fleet={fleet} live={all} now={now} scope={scope} />
      <div className="now-body">
        {/* Folded, the rows stay mounted, so an answer being typed is still there when the section opens again. */}
        <section className="now-attn" aria-labelledby="now-attn-h">
          <AttentionHead id="now-attn-h" needs={needCount} problems={problems.length} worst={worst} open={attentionOpen} onToggle={() => prefs.set({ attentionOpen: !attentionOpen })} bodyId="now-attn-body" />
          <div className="now-top" id="now-attn-body" hidden={!attentionOpen}>
            <NeedsYou items={queue} settled={settled} now={now} labels={labels} count={needCount} />
            <Problems items={problems} now={now} labels={labels} sessions={fleet.sessions} />
          </div>
        </section>
        <section className="now-fleet" aria-labelledby="now-fleet-h" data-layout={layout}>
          <div className="now-fleet-head">
            <h2 id="now-fleet-h" className="now-h2">
              Sessions
            </h2>
            <FleetControls fleet={prefs} background={splitDetached(sessions, now, false).hidden} />
          </div>
          <FleetSpendTotal.Provider value={fleet.kpis?.costToday ?? null}>
            <FleetMachines.Provider value={{ machines: fleet.machines, now }}>{body}</FleetMachines.Provider>
          </FleetSpendTotal.Provider>
        </section>
      </div>
    </div>
  );
}
