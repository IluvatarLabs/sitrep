// True once `enabled` has stayed on for `ms` with no pointer movement, touch or key: display mode hides the cursor and its exit
// then. Movement over an element marked data-display-control never starts the count, so a control under the pointer never
// hides from under it.
import { useEffect, useState } from "react";

export const IDLE_MS = 4000;

const ACTIVITY = ["pointermove", "touchstart", "keydown"] as const;

const onControl = (e: Event) => e.type === "pointermove" && e.target instanceof Element && e.target.closest("[data-display-control]") !== null;

export function useIdle(enabled: boolean, ms = IDLE_MS): boolean {
  const [resting, setResting] = useState(false);
  useEffect(() => {
    // Turned off it is never idle; turned on again it counts afresh.
    setResting(false);
    if (!enabled) return undefined;
    let timer = setTimeout(() => setResting(true), ms);
    const onActivity = (e: Event) => {
      clearTimeout(timer);
      setResting(false);
      if (!onControl(e)) timer = setTimeout(() => setResting(true), ms);
    };
    for (const type of ACTIVITY) document.addEventListener(type, onActivity);
    return () => {
      clearTimeout(timer);
      for (const type of ACTIVITY) document.removeEventListener(type, onActivity);
    };
  }, [enabled, ms]);
  return enabled && resting;
}
