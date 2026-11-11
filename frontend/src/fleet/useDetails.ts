// The Details switch (the sidebar's footer): one choice, remembered per browser, that the sidebar's rows, the Fleet's cards
// and its List rows all read. Off (the default) shows the clean rows; on adds the detail lines. One store, so every reader
// changes together (React's useSyncExternalStore, the standard hook for shared outside state).
import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

const KEY = "sidebar.detailed";
const listeners = new Set<() => void>();
let current = readJson<unknown>(KEY, false) === true;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether Details is on, and the setter every reader shares. */
export function useDetails(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, () => current);
  const set = (next: boolean) => {
    current = next;
    writeJson(KEY, next);
    for (const l of listeners) l();
  };
  return [on, set];
}
