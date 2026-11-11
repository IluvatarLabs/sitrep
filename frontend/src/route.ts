// The hash routes, one per view: `#/` the Fleet (route `now`), `#/s/<id>` a session's page (`?agent=<agentId>` opens
// one of its agents), `#/history`, `#/plans`, `#/machines` (`?add` opens Add a machine) and `#/settings`. Older addresses keep
// working: `#/wall`, `#/map` and `#/graph` open the Fleet in that layout, `#/board` Plans, `#/usage` the Fleet (where the state bar opens usage), and
// `#/?open=<id>` a session's page.
export type Route = "now" | "session" | "history" | "plans" | "machines" | "settings";

/** A route that is a view of its own, not one session's page. */
export type View = Exclude<Route, "session">;

/** The views the sidebar lists, in its order; Settings is the top bar's. */
export const VIEWS: readonly View[] = ["now", "history", "plans", "machines"];

/** Every view, for a remembered one read back. */
export const ALL_VIEWS: readonly View[] = [...VIEWS, "settings"];

/** The old addresses and the view each now opens. */
const MOVED = { wall: "now", map: "now", graph: "now", board: "plans", usage: "now" } as const satisfies Record<string, View>;
export type MovedView = keyof typeof MOVED;

/** An address cut at its query: the path, and the query's parameters. */
function parts(hash: string): [string, URLSearchParams] {
  const at = hash.indexOf("?");
  return at < 0 ? [hash, new URLSearchParams()] : [hash.slice(0, at), new URLSearchParams(hash.slice(at + 1))];
}

/** The id in a `#/s/<id>` path; null for any other path or an id that does not decode. */
function pagedSession(path: string): string | null {
  if (!path.startsWith("#/s/") || path.length === 4) return null;
  try {
    return decodeURIComponent(path.slice(4));
  } catch {
    return null;
  }
}

/** The old view an address names, and where it goes now; null for any other address. */
export function movedFrom(hash: string): { from: MovedView; to: View } | null {
  const name = parts(hash)[0].slice(2);
  return Object.hasOwn(MOVED, name) ? { from: name as MovedView, to: MOVED[name as MovedView] } : null;
}

/** The route an address opens. */
export const routeFor = (hash: string): Route => {
  const [path, query] = parts(hash);
  if (path.startsWith("#/s/") && path.length > 4) return "session";
  const view = ALL_VIEWS.find((v) => v !== "now" && path === `#/${v}`) ?? movedFrom(hash)?.to;
  return view ?? (query.get("open") ? "session" : "now");
};

/** The session a `#/s/<id>` (or old `#/?open=<id>`) address opens; null on any other route or for an id that does not decode. */
export function sessionIn(hash: string): string | null {
  const [path, query] = parts(hash);
  if (routeFor(hash) !== "session") return null;
  return path.startsWith("#/s/") ? pagedSession(path) : query.get("open");
}

/** The agent a session's address opens on its page (`#/s/<id>?agent=<agentId>`); null when it names none. */
export function agentIn(hash: string): string | null {
  return routeFor(hash) === "session" ? parts(hash)[1].get("agent") : null;
}

/** Machines with Add a machine open: the sidebar's "+". */
export const ADD_MACHINE_HASH = "#/machines?add";

/** Whether the address asks Machines to open Add a machine. */
export const wantsAddMachine = (hash: string): boolean => routeFor(hash) === "machines" && parts(hash)[1].has("add");

/** A view's address, or one session's page, optionally opened on one of its agents. */
export function hashFor(route: View): string;
export function hashFor(route: "session", sessionId: string, agentId?: string | null): string;
export function hashFor(route: Route, sessionId?: string, agentId?: string | null): string {
  if (route !== "session") return route === "now" ? "#/" : `#/${route}`;
  const agent = agentId ? `?agent=${encodeURIComponent(agentId)}` : "";
  return `#/s/${encodeURIComponent(sessionId ?? "")}${agent}`;
}
