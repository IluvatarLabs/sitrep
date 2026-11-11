// Plans (#/plans): the board (components/Board) as its own view. It gets the sessions in the Fleet's sort order with background
// sessions set aside unless the Fleet shows them, the server's whole-fleet figures, how many of the whole fleet's sessions need
// you (attention needYouCount, the one rule), and whether the top bar's filter narrows the board.
import { useMemo } from "react";
import { hashFor } from "../../../route";
import { needYouCount } from "../../attention";
import { Board } from "../../components/Board";
import { sortSessions, splitDetached } from "../../logic";
import type { FleetPrefsApi } from "../../useGroupPrefs";
import type { ViewProps } from "../types";

export function PlansView({ fleet, sessions, now, prefs }: ViewProps & { prefs: FleetPrefsApi }) {
  const { sort, background } = prefs.prefs;
  const shown = useMemo(() => splitDetached(sortSessions(sessions, sort), now, background).shown, [sessions, sort, now, background]);
  const filtered = sessions.length < Object.keys(fleet.sessions).length;
  return <Board sessions={shown} kpis={fleet.kpis} waiting={needYouCount(fleet.sessions)} filtered={filtered} onOpen={(id) => (window.location.hash = hashFor("session", id))} />;
}
