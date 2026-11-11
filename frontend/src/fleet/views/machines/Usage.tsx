// The usage panel under the Fleet's state bar, which its est. spend and plan windows open: Today, which follows the machine
// picked in the sidebar (the filter's `m:`). Each machine's est. spend and plan windows are on its group's header
// (views/now/controls GroupHead). An `.mc` block, so Machines' own rules draw it unchanged; only its frame is the Fleet's.
import { scopedMachines } from "../../shell/filter";
import type { FleetState } from "../../store";
import type { SessionView } from "../../types";
import { Today } from "./Today";
import "./machines.css";

export function Usage({ id, fleet, live, now, scope }: { id: string; fleet: FleetState; live: readonly SessionView[]; now: number; scope: string | null }) {
  const picked = scope === null ? null : scopedMachines(scope, fleet.machines, live);
  return (
    <div id={id} className="mc mc-usage">
      <Today kpis={fleet.kpis} live={live} now={now} scope={scope === null || picked === null ? null : { word: scope, machines: picked }} />
    </div>
  );
}
