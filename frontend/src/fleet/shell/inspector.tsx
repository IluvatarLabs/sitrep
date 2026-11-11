// What the inspector (the right pane) shows: the fleet's activity, or one agent's detail once an agent is picked anywhere (a
// List row's station, a Graph node, a timeline row, an activity row). Back returns to the activity; picking shows the pane if it
// was hidden (`onPick`). On its session's page the main loop is picked as ORCHESTRATOR_ROW; elsewhere what opens a main loop
// opens its session's page. A page drawing a stored session (History)
// hands it over, since the live fleet no longer holds it.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { SessionView } from "../types";

export interface Picked {
  sessionId: string;
  agentId: string;
  /** The session itself, when it is not in the live fleet (a History page). */
  session?: SessionView;
}

export interface Inspector {
  picked: Picked | null;
  pick: (sessionId: string, agentId: string, session?: SessionView) => void;
  back: () => void;
}

const NONE: Inspector = { picked: null, pick: () => undefined, back: () => undefined };
const InspectorContext = createContext<Inspector>(NONE);

export function InspectorProvider({ onPick, children }: { onPick?: () => void; children: ReactNode }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const pick = useCallback(
    (sessionId: string, agentId: string, session?: SessionView) => {
      setPicked({ sessionId, agentId, session });
      onPick?.();
    },
    [onPick],
  );
  const back = useCallback(() => setPicked(null), []);
  const value = useMemo(() => ({ picked, pick, back }), [picked, pick, back]);
  return <InspectorContext.Provider value={value}>{children}</InspectorContext.Provider>;
}

/** The inspector; outside its provider picking does nothing. */
export function useInspector(): Inspector {
  return useContext(InspectorContext);
}
