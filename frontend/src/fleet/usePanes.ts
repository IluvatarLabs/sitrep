// Which of the sidebar (left), the inspector (right) and the top bar are folded away, remembered per browser apart from their
// widths (useResizable), so a pane that opens again comes back at its width. All three open by default. Display mode covers
// the window by itself and leaves these as they are.
//
// Where the window is too narrow for three columns of cards (wallLayout) beside both panes at their default widths, the
// inspector folds by itself, the usual responsive collapse of a side pane: a zoom step then keeps three columns rather than
// dropping to two (wallLayout). The width is the same in every layout (Cards, List,
// Graph), so switching layouts never shows or hides the pane. It is above the frame's floor (1280 CSS px, desktop
// only), so under the floor the inspector is folded too, the page is never wider than the window, and nothing at its right
// (Settings, Sign in, the Activity search) is cut off out of reach. The stored choice is left alone: while the window is narrow
// the inspector opens and folds as it is asked to (Activity, `]`, picking an agent) without storing it, folds again each time
// the window becomes narrow, and once the window is wide again the stored choice holds.
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";
import { DEFAULT_WIDTH } from "./useResizable";
import { CARD_MIN, GAP as CARD_GAP } from "./wallLayout";

/** Each pane, and whether it is folded away. */
export interface Collapsed {
  left: boolean;
  right: boolean;
  top: boolean;
}
export type Pane = keyof Collapsed;

// The three-pane frame's own key: an older layout stored the inspector folded under another, and that must not carry over.
const STORE_KEY = "panes.folded";

/** The Fleet view's padding on either side of its content (views/now/now.css .now-body, var(--s5)). */
const VIEW_PADDING = 24;
/** Room past the three cards, so a classic scrollbar (15 px, macOS "always show scrollbars") does not take a column away. */
const SPARE = 24;

/**
 * Narrower than both panes at their default widths, three cards at their least and SPARE beside them: 252 + 300 + 2 × 24 +
 * 3 × 340 + 2 × 12 + 24 = 1668 CSS px (media queries level 4 range syntax, so a fractional width at a zoom level is caught too).
 */
const NARROW = `(width < ${DEFAULT_WIDTH.rail + DEFAULT_WIDTH.side + 2 * VIEW_PADDING + 3 * CARD_MIN + 2 * CARD_GAP + SPARE}px)`;

function narrowQuery(): MediaQueryList | null {
  try {
    return window.matchMedia(NARROW);
  } catch {
    return null;
  }
}

function onWidthChange(notify: () => void): () => void {
  const query = narrowQuery();
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
}

/** A browser that cannot say is wide: the inspector never folds by itself there. */
const isNarrow = () => narrowQuery()?.matches ?? false;

/** The stored flags; a missing or unreadable one is open. */
function load(): Collapsed {
  const saved = readJson<Partial<Record<Pane, unknown>> | null>(STORE_KEY, null) ?? {};
  return { left: saved.left === true, right: saved.right === true, top: saved.top === true };
}

export interface Panes {
  /** As shown: the stored flags, the inspector's folded while the window is narrow unless it was opened since. */
  collapsed: Collapsed;
  toggle: (pane: Pane) => void;
  /** Opens a folded pane; an open one stays open. */
  reveal: (pane: Pane) => void;
}

export function usePanes(): Panes {
  const [stored, setStored] = useState(load);
  const narrow = useSyncExternalStore(onWidthChange, isNarrow);
  // The inspector while narrow, never stored: folded each time the window becomes narrow (React's state that follows a value).
  const [narrowFold, setNarrowFold] = useState(true);
  const [wasNarrow, setWasNarrow] = useState(narrow);
  if (narrow !== wasNarrow) {
    setWasNarrow(narrow);
    if (narrow) setNarrowFold(true);
  }
  // A stored change is stored at once.
  const set = useCallback(
    (pane: Pane, folded: (was: boolean) => boolean) => {
      if (pane === "right" && narrow) {
        setNarrowFold(folded);
        return;
      }
      setStored((was) => {
        const value = folded(was[pane]);
        if (value === was[pane]) return was;
        const next = { ...was, [pane]: value };
        writeJson(STORE_KEY, next);
        return next;
      });
    },
    [narrow],
  );
  const toggle = useCallback((pane: Pane) => set(pane, (was) => !was), [set]);
  const reveal = useCallback((pane: Pane) => set(pane, () => false), [set]);
  const collapsed = useMemo(() => (narrow ? { ...stored, right: narrowFold } : stored), [narrow, narrowFold, stored]);
  return { collapsed, toggle, reveal };
}
