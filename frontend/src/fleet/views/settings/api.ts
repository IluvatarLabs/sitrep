// The open reads the views make under /api/fleet (History, Machines, Settings, a session's stored events). The owner's actions
// go through respondApi.ts adminApi, the answer routes' own request.
import { VIEW_GATED } from "../../../../../server/src/fleet/protocol";
import { FLEET_BASE, viewGated } from "../../useFleet";

export type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T };

/**
 * An open read under /api/fleet; a refusal throws its status ("not found" for 404). A refusal by the view gate also tells the
 * console, which then shows the sign-in screen (useFleet viewGated).
 */
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${FLEET_BASE}${path}`);
  if (res.ok) return (await res.json()) as T;
  if (await viewGated(res)) throw new Error(VIEW_GATED);
  throw new Error(res.status === 404 ? "not found" : `HTTP ${res.status}`);
}

/** What a refused action says, for "Could not …: <this>". */
export const failure = (err: unknown): string => (err instanceof Error ? err.message : String(err));
