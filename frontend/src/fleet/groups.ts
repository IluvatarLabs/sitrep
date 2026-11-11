// The Fleet's groups (Group by): sessions by the machine they run on or by their project, in name order; and the one way a
// machine is named where two share a name. Pure.
import { stateOf, type State } from "./states";
import type { SessionView } from "./types";

export type GroupBy = "machine" | "project" | "none";
export const GROUP_BYS: Record<GroupBy, string> = { machine: "Machine", project: "Project", none: "None" };

/** The start of a machine's id that tells two machines of one name apart, as the `m:` filter matches it. */
export const shortId = (id: string): string => id.slice(0, 6);

type Named = { machine: { id: string; name: string } };

/** The ids of machines whose name another machine also has. */
export function sharedNames(items: readonly Named[]): Set<string> {
  const idsOf = new Map<string, Set<string>>();
  for (const { machine: m } of items) idsOf.set(m.name, (idsOf.get(m.name) ?? new Set<string>()).add(m.id));
  return new Set([...idsOf.values()].filter((ids) => ids.size > 1).flatMap((ids) => [...ids]));
}

/** Each machine's name, keyed by its id, with the start of its id where another machine has the same name: "server (49ced1)". */
export function machineLabels(items: readonly Named[]): Map<string, string> {
  const shared = sharedNames(items);
  return new Map(items.map(({ machine: m }) => [m.id, shared.has(m.id) ? `${m.name} (${shortId(m.id)})` : m.name]));
}

export interface Group {
  /** Stable across renders: `m:<machine id>` or `p:<project>`. */
  key: string;
  kind: "machine" | "project";
  /** The machine's label or the project's path; "" for a project not reported (no working directory), shown as unknown. */
  name: string;
  /** A machine's OS as it reported it; null for a project. */
  os: string | null;
  sessions: SessionView[];
}

const keyOf = (s: SessionView, by: GroupBy) => (by === "project" ? `p:${s.project}` : `m:${s.machine.id}`);

/** The groups for a Group by, in name order, each holding its sessions in the order given; None is no groups. */
export function groupSessions(list: readonly SessionView[], by: GroupBy, labels: ReadonlyMap<string, string>): Group[] {
  if (by === "none") return [];
  const groups = new Map<string, Group>();
  for (const s of list) {
    const key = keyOf(s, by);
    const group = groups.get(key);
    if (group) group.sessions.push(s);
    else if (by === "project") groups.set(key, { key, kind: "project", name: s.project, os: null, sessions: [s] });
    else groups.set(key, { key, kind: "machine", name: labels.get(s.machine.id) ?? s.machine.name, os: s.machine.os, sessions: [s] });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.key < b.key ? -1 : 1));
}

/** How many of a group's sessions are in one of `states`. */
export const countIn = (g: Pick<Group, "sessions">, ...states: State[]): number => g.sessions.filter((s) => states.includes(stateOf(s))).length;
