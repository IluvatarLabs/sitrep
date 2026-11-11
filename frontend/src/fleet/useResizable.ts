// The sidebar's ("rail") and the inspector's ("side") widths: dragged, stepped with the arrow keys (16 px, 48 px with Shift),
// reset with a double-click, Home or Escape, and remembered. The main column never gets narrower than MIN_MAIN.
import { useCallback, useEffect, useState } from "react";
import { readJson, writeJson } from "./storage";

export type Panel = "rail" | "side";

/** Each panel's narrowest and widest, and its width until one is chosen. */
export const LIMITS: Readonly<Record<Panel, readonly [min: number, max: number]>> = { rail: [180, 440], side: [260, 700] };
export const DEFAULT_WIDTH: Readonly<Record<Panel, number>> = { rail: 252, side: 300 };

/**
 * The main column's least width, from its widest row: the List's fixed columns (fold, mark, model, context, cost, time, pin and
 * their gaps, 496 px), its 48 px of padding, and a 176 px floor for the name. The inspector still opens to its 700 px at 1920.
 */
const MIN_MAIN = 720;
const STEP = { small: 16, large: 48 };
const RESET_KEYS: ReadonlySet<string> = new Set(["Home", "Escape"]);
const STORE_KEY = "panels";

type Widths = Partial<Record<Panel, number>>;
const otherOf = (p: Panel): Panel => (p === "rail" ? "side" : "rail");

/** A width inside its panel's limits, and inside what leaves the main column MIN_MAIN wide once the frame is measured. */
function fit(p: Panel, wanted: number, frameWidth: number, otherWidth: number): number {
  const [min, max] = LIMITS[p];
  const most = frameWidth > 0 ? Math.min(max, frameWidth - otherWidth - MIN_MAIN) : max;
  return Math.round(Math.max(min, Math.min(most, Number.isFinite(wanted) ? wanted : DEFAULT_WIDTH[p])));
}

/**
 * What a key does to a panel's width: a new width for an arrow, undefined (back to the default) for Home and Escape, null for
 * any other key. The rail's free edge is on its right and the inspector's on its left, so ArrowRight widens one and narrows the
 * other.
 */
export function keyWidth(p: Panel, key: string, shift: boolean, width: number): number | null | undefined {
  if (RESET_KEYS.has(key)) return undefined;
  const sign = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  if (sign === 0) return null;
  const step = (shift ? STEP.large : STEP.small) * sign;
  return p === "rail" ? width + step : width - step;
}

export interface Resizable {
  /** The width shown: the one chosen, else the default. */
  width: (p: Panel) => number;
  widths: Widths;
  reset: (p: Panel) => void;
  /** Shows a width, and stores it when `save` (a drag stores once, at its end). */
  set: (p: Panel, width: number, save: boolean) => void;
}

function stored(): Widths {
  const saved = readJson<Widths | null>(STORE_KEY, null) ?? {};
  const out: Widths = {};
  for (const p of ["rail", "side"] as const) {
    const w = saved[p];
    if (typeof w === "number" && Number.isFinite(w)) out[p] = Math.max(LIMITS[p][0], Math.min(LIMITS[p][1], w));
  }
  return out;
}

export function useResizable(frame: () => HTMLElement | null): Resizable {
  const [widths, setWidths] = useState(stored);
  const width = useCallback((p: Panel) => widths[p] ?? DEFAULT_WIDTH[p], [widths]);

  const set = useCallback(
    (p: Panel, wanted: number, save: boolean) =>
      setWidths((was) => {
        const next = { ...was, [p]: fit(p, wanted, frame()?.clientWidth ?? 0, was[otherOf(p)] ?? DEFAULT_WIDTH[otherOf(p)]) };
        if (save) writeJson(STORE_KEY, next);
        return next;
      }),
    [frame],
  );

  const reset = useCallback(
    (p: Panel) =>
      setWidths((was) => {
        const next = { ...was };
        delete next[p];
        writeJson(STORE_KEY, next);
        return next;
      }),
    [],
  );

  // The stored widths are brought inside the window when the page opens, and again whenever the window shrinks.
  useEffect(() => {
    const refit = () =>
      setWidths((was) => {
        const el = frame();
        if (!el) return was;
        const next = { ...was };
        for (const p of ["rail", "side"] as const) {
          const w = was[p];
          if (w !== undefined) next[p] = fit(p, w, el.clientWidth, was[otherOf(p)] ?? DEFAULT_WIDTH[otherOf(p)]);
        }
        return next;
      });
    refit();
    addEventListener("resize", refit);
    return () => removeEventListener("resize", refit);
  }, [frame]);

  return { widths, width, set, reset };
}
