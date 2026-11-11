// How this browser arranges the Fleet, remembered: the layout (Cards, List or Graph), Group by, Sort, whether background
// sessions are shown, whether the List opens every row, whether Attention is open, and the groups folded shut.
import { useCallback, useState } from "react";
import { GROUP_BYS, type GroupBy } from "./groups";
import { SORTS, type SortKey } from "./logic";
import { readJson, writeJson } from "./storage";

export const LAYOUTS = { cards: "Cards", list: "List", graph: "Graph" } as const;
export type FleetLayout = keyof typeof LAYOUTS;

export interface FleetPrefs {
  layout: FleetLayout;
  groupBy: GroupBy;
  /** The order inside each group. */
  sort: SortKey;
  /** Background sessions (headless runs, and sessions nobody attached to past their time) are in the Fleet. */
  background: boolean;
  /** The List opens every row. */
  expandAll: boolean;
  /** The Attention section (Needs you and Problems) is open; shut until it is first opened, its counts on its header. */
  attentionOpen: boolean;
  /** Groups folded to their header, `<group by>:<group key>`. */
  folded: string[];
}

const STORE_KEY = "fleet";
/** Name is the default sort; a stored sort no longer offered (the old Attention) falls back to it. */
const DEFAULTS: FleetPrefs = { layout: "list", groupBy: "machine", sort: "name", background: false, expandAll: false, attentionOpen: false, folded: [] };

/**
 * The old Now's choices (key `groups`): its sorts by today's; its "Status" (ordered by state) has none
 * and falls back to Name. Its group order ("Order groups by") is not carried: groups are in name order. Its folded groups used
 * today's keys.
 */
const OLD_KEY = "groups";
const OLD_SORT: Readonly<Record<string, SortKey>> = { model: "model", blow: "blowouts", ctx: "context", cost: "spend", newest: "newest" };

/** A stored choice when it is one of `choices`, else the default. */
const choice = <K extends string>(v: unknown, choices: Record<K, string>, fallback: K): K => (typeof v === "string" && Object.hasOwn(choices, v) ? (v as K) : fallback);

function readPrefs(stored: unknown): FleetPrefs {
  const o = (stored !== null && typeof stored === "object" ? stored : {}) as Partial<Record<keyof FleetPrefs, unknown>>;
  return {
    layout: choice(o.layout, LAYOUTS, DEFAULTS.layout),
    groupBy: choice(o.groupBy, GROUP_BYS, DEFAULTS.groupBy),
    sort: choice(o.sort, SORTS, DEFAULTS.sort),
    background: o.background === true,
    expandAll: o.expandAll === true,
    attentionOpen: o.attentionOpen === true,
    folded: (Array.isArray(o.folded) ? o.folded : []).filter((k): k is string => typeof k === "string").slice(0, 200),
  };
}

/**
 * The choices stored under `fleet`; while there are none, the old Now's (key `groups`), read this once and stored under `fleet`
 * at once, so a browser coming back from the old UI keeps its Group by, sort and folded groups.
 */
function storedPrefs(): FleetPrefs {
  const stored = readJson<unknown>(STORE_KEY, null);
  if (stored !== null) return readPrefs(stored);
  const old = readJson<unknown>(OLD_KEY, null);
  if (old === null || typeof old !== "object") return DEFAULTS;
  const o = old as Record<string, unknown>;
  const sort = typeof o.sort === "string" && Object.hasOwn(OLD_SORT, o.sort) ? OLD_SORT[o.sort] : undefined;
  const carried = readPrefs({ groupBy: o.groupBy, sort, folded: o.collapsed });
  writeJson(STORE_KEY, carried);
  return carried;
}

export interface FleetPrefsApi {
  prefs: FleetPrefs;
  set: (change: Partial<FleetPrefs>) => void;
  /** Folds a group shut, or opens it again. */
  fold: (key: string) => void;
}

export function useFleetPrefs(): FleetPrefsApi {
  const [prefs, setPrefs] = useState(storedPrefs);
  const update = useCallback((next: (was: FleetPrefs) => FleetPrefs) => {
    setPrefs((was) => {
      const now = next(was);
      writeJson(STORE_KEY, now);
      return now;
    });
  }, []);
  const set = useCallback((change: Partial<FleetPrefs>) => update((was) => ({ ...was, ...change })), [update]);
  const fold = useCallback((key: string) => update((was) => ({ ...was, folded: was.folded.includes(key) ? was.folded.filter((k) => k !== key) : [...was.folded, key] })), [update]);
  return { prefs, set, fold };
}
