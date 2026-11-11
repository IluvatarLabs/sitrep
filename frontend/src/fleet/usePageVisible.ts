import { useSyncExternalStore } from "react";

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

function onVisibilityChange(notify: () => void): () => void {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
}

/** False while the tab is hidden, so animation and polling can rest until it is shown again. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(onVisibilityChange, isVisible);
}
