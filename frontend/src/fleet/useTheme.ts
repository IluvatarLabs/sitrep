// Light, dark or System (the operating system's), remembered in this browser and applied as data-theme on <html> (the mode the
// choice comes to), which ui/tokens.css reads. index.html applies the stored choice before the first paint. The top bar steps
// through the choices: System, Light, Dark.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

export type ModeChoice = "system" | "light" | "dark";

/** The choices, in the order the top bar's button steps through them. */
export const MODES: readonly ModeChoice[] = ["system", "light", "dark"];

const STORE_KEY = "theme";

/** The stored `{ mode }` (palette choices were kept in the same object); anything else is System. */
function readMode(stored: unknown): ModeChoice {
  const mode = stored !== null && typeof stored === "object" ? (stored as { mode?: unknown }).mode : undefined;
  return MODES.find((m) => m === mode) ?? "system";
}

function darkQuery(): MediaQueryList | null {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return null;
  }
}

function onSchemeChange(notify: () => void): () => void {
  const query = darkQuery();
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
}

/** The operating system's preference; light when the browser cannot say, as index.html decides. */
const systemDark = () => darkQuery()?.matches ?? false;

export interface ThemeState {
  /** The choice, and the light or dark it comes to now. */
  mode: ModeChoice;
  resolved: "light" | "dark";
  setMode: (mode: ModeChoice) => void;
  /** The next choice: System, Light, Dark, then System again. */
  cycle: () => void;
}

export function useTheme(): ThemeState {
  const [mode, setState] = useState<ModeChoice>(() => readMode(readJson<unknown>(STORE_KEY, null)));
  const dark = useSyncExternalStore(onSchemeChange, systemDark);
  const resolved = mode === "system" ? (dark ? "dark" : "light") : mode;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
  }, [resolved]);

  const setMode = useCallback((next: ModeChoice) => {
    setState(next);
    writeJson(STORE_KEY, { mode: next });
  }, []);
  const cycle = useCallback(() => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]!), [mode, setMode]);
  return { mode, resolved, setMode, cycle };
}
