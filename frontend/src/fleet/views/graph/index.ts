import type { FleetState } from "../../store";
import type { SessionView } from "../../types";
import type { GroupBy } from "../../groups";

export { GraphLayout } from "./GraphLayout";

/** What the Fleet's Graph layout gets from Now: the sessions in view, the fleet, the clock, the grouping. */
export interface GraphLayoutProps {
  sessions: readonly SessionView[];
  fleet: FleetState;
  now: number;
  group: GroupBy;
  /** The filter; a new one refits the graph. */
  query: string;
  /** A hub was clicked: scope the view to that machine (Now writes `m:<name>` into the filter). */
  onScope: (machineName: string) => void;
}
