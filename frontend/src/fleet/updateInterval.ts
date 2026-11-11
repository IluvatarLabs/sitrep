// How often the fleet page redraws from new data and moves its clock. Server events keep arriving as they do; the page
// shows the newest state once per interval, which keeps the GPU quiet on a big wall.
import { readJson, writeJson } from "./storage";
import { liveOpenAsk, needsYou } from "./states";
import type { FleetState } from "./store";
import type { SessionView } from "./types";

/** The redraw intervals offered, in seconds; the first is the default. */
export const REDRAW_CHOICES: readonly number[] = [2, 5, 10, 20, 30, 60];
const STORE_KEY = "updateEvery";

/** This browser's redraw interval: the stored one while it is still offered, else the default. */
export function readRedraw(): number {
  const stored = readJson<unknown>(STORE_KEY, null);
  return REDRAW_CHOICES.find((n) => n === stored) ?? REDRAW_CHOICES[0]!;
}

export const writeRedraw = (seconds: number): void => writeJson(STORE_KEY, seconds);

/**
 * Whether a session's change can't wait for the interval, against `was`, the session as shown (undefined when it was not): it
 * starts waiting, or ends (so its Done view always shows through its hold, and the page and its pins see the end); gains or
 * loses an open ask, so the needs-you queue and every count follow at once, as the live top bar does; starts or stops needing its
 * person (also with no change of status: idle on background work and waiting on its person are both "waiting"); gets stuck or
 * errors; or an agent of it newly failed or got stuck.
 */
function urgentFor(s: SessionView, was: SessionView | undefined): boolean {
  if (s.status !== was?.status && (s.status === "waiting" || s.status === "done")) return true;
  if (liveOpenAsk(s) !== (was !== undefined && liveOpenAsk(was))) return true;
  if (was && needsYou(was) !== needsYou(s)) return true;
  if ((s.stuck && !was?.stuck) || (s.errored !== null && !was?.errored)) return true;
  const failedBefore = new Set(was?.agents.filter((a) => a.failure).map((a) => a.id));
  const stuckBefore = new Set(was?.agents.filter((a) => a.stuck).map((a) => a.id));
  return s.agents.some((a) => (a.failure && !failedBefore.has(a.id)) || (a.stuck && !stuckBefore.has(a.id)));
}

/**
 * Whether `next` holds something nobody should wait for, against what is `shown`: a change of connection phase or of the server
 * settings, a session that left, or a session's urgent change (urgentFor). Everything else waits for the interval.
 */
export function isUrgentChange(shown: FleetState, next: FleetState): boolean {
  if (shown === next) return false;
  if (shown.phase !== next.phase || shown.settings !== next.settings) return true;
  if (Object.keys(shown.gone).length !== Object.keys(next.gone).length) return true;
  return Object.values(next.sessions).some((s) => urgentFor(s, shown.sessions[s.id]));
}
