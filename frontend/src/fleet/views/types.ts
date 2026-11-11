// What the shell hands every view. Views never call useFleet themselves and never apply the filter field.
import type { RefusalView } from "../../../../server/src/fleet/protocol";
import type { NotifyAvailability } from "../attention";
import type { FleetState } from "../store";
import type { SessionView } from "../types";
import type { ThemeState } from "../useTheme";

/** This browser's own choices, which the shell holds and acts on; Settings changes them here (its "This browser" section). */
export interface BrowserPrefs {
  theme: ThemeState;
  notify: { availability: NotifyAvailability; toggle: () => void };
  /** How often the console redraws, in seconds (updateInterval.ts). */
  every: number;
  onEvery: (seconds: number) => void;
}

export interface ViewProps {
  /** The whole fleet: machines, events, kpis, settings. */
  fleet: FleetState;
  /** The live sessions through the top bar's filter (its `m:` word is the machine scope); the view orders and groups them. */
  sessions: SessionView[];
  /** The machine scope in force: the filter's one `m:` word, lower-cased (shell/filter scopeIn), or null. */
  scope?: string | null;
  /** The shared clock (epoch ms), one tick for every view. */
  now: number;
  browser: BrowserPrefs;
  /** The server's refused reports, newest first, read once for the sidebar and Machines (views/machines useRefusals). */
  refusals: RefusalView[];
}
