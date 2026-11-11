// Animation (Settings → This browser): System follows the system's reduced-motion setting, On and Off override it. Remembered
// in this browser and set as data-motion on <html>, which ui.css reads to run or stop the pulse and the new-row flash:
// index.html sets the stored choice before the first paint, by readMotion's rule and key (keep the two the same), and
// setMotion sets a new one. Each pulse is a CSS animation of the mark's opacity; this starts every one at the document
// timeline's zero, so all beat together.
import { useEffect } from "react";
import { readJson, writeJson } from "../storage";

export type MotionChoice = "system" | "on" | "off";

/** The choices, in the order Settings lists them. */
export const MOTIONS: readonly MotionChoice[] = ["system", "on", "off"];

const STORE_KEY = "motion";

/** The stored choice; anything else is System. */
export function readMotion(): MotionChoice {
  const stored = readJson<unknown>(STORE_KEY, null);
  return MOTIONS.find((m) => m === stored) ?? "system";
}

/** Remembers the choice and applies it to the page at once. */
export function setMotion(choice: MotionChoice): void {
  writeJson(STORE_KEY, choice);
  document.documentElement.setAttribute("data-motion", choice);
}

/** Starts the pulses among `list` at the document timeline's zero: with one duration, they are then in phase. */
function align(list: Animation[]): void {
  for (const a of list) if (a instanceof CSSAnimation && a.animationName === "ui-pulse") a.startTime = 0;
}

/** Puts each pulse in phase with the rest as it starts (Web Animations' shared timeline). */
export function useMotion(): void {
  useEffect(() => {
    align(document.getAnimations());
    const onStart = (e: AnimationEvent) => {
      if (e.animationName === "ui-pulse" && e.target instanceof Element) align(e.target.getAnimations());
    };
    document.addEventListener("animationstart", onStart);
    return () => document.removeEventListener("animationstart", onStart);
  }, []);
}
