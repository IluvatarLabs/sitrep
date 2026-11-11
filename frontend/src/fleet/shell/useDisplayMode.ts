// Display mode: the wall view (views/display) over the window, for a screen left on the fleet. The top bar's button also asks the
// browser for fullscreen, and a refusal changes nothing else; `w` turns it on or off without fullscreen, and Escape leaves.
// However it ends, a fullscreen it asked for is released, and the browser's own way out of fullscreen ends it. After a few idle
// seconds the cursor, the layout switch and Exit hide. The wall's layout is remembered per browser (a TV keeps Sections, an iPad
// Columns); `l` switches it, a key no other shortcut takes (useHotkeys callers).
import { useCallback, useEffect, useRef, useState } from "react";
import { readJson, writeJson } from "../storage";
import { useHotkeys } from "../useHotkeys";
import { useIdle } from "../useIdle";

/** The wall's two layouts: Columns for an iPad or a small screen, Sections for a large one. */
export const DISPLAY_LAYOUTS = { columns: "Columns", sections: "Sections" } as const;
export type DisplayLayout = keyof typeof DISPLAY_LAYOUTS;

const LAYOUT_KEY = "display.layout";

/** This browser's layout; Sections until it chose Columns. */
const storedLayout = (): DisplayLayout => (readJson<unknown>(LAYOUT_KEY, null) === "columns" ? "columns" : "sections");

export interface DisplayMode {
  on: boolean;
  /** No pointer, touch or key for a while: the cursor and the controls hide. */
  idle: boolean;
  enter: (fullscreen: boolean) => void;
  exit: () => void;
  layout: DisplayLayout;
  setLayout: (layout: DisplayLayout) => void;
}

export function useDisplayMode(): DisplayMode {
  const [on, setOn] = useState(false);
  const [layout, setShown] = useState(storedLayout);
  // The fullscreen showing is one this mode asked for.
  const ours = useRef(false);

  const enter = useCallback((fullscreen: boolean) => {
    setOn(true);
    const root = document.documentElement;
    if (!fullscreen || typeof root.requestFullscreen !== "function") return;
    ours.current = true;
    root.requestFullscreen().catch(() => {
      ours.current = false;
    });
  }, []);
  const exit = useCallback(() => setOn(false), []);
  const setLayout = useCallback((next: DisplayLayout) => {
    setShown(next);
    writeJson(LAYOUT_KEY, next);
  }, []);

  // Turned off, or the shell gone: a fullscreen this mode asked for is released.
  useEffect(() => {
    if (!on) return undefined;
    return () => {
      if (ours.current && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      ours.current = false;
    };
  }, [on]);

  // Leaving the browser's fullscreen (its own Escape) leaves the mode.
  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement || !ours.current) return;
      ours.current = false;
      setOn(false);
    };
    const listening = new AbortController();
    document.addEventListener("fullscreenchange", onChange, { signal: listening.signal });
    return () => listening.abort();
  }, []);

  useHotkeys((e) => {
    if (e.key === "Escape" && on) exit();
    else if (e.key === "w" || e.key === "W") {
      if (on) exit();
      else enter(false);
    } else if ((e.key === "l" || e.key === "L") && on) setLayout(layout === "columns" ? "sections" : "columns");
  });

  return { on, idle: useIdle(on), enter, exit, layout, setLayout };
}
