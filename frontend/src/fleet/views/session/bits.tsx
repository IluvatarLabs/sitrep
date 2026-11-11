// Small pieces the session and agent views share: an agent's estimated money, a line's parts, the context meter, a clock time,
// and a measured width. Separators are the console's one list (ui/Dots). Colors and sizes come from the console's tokens
// only; an unknown value is the shared <Unknown>.
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { BlowBadge } from "../../components/Chips";
import { fmtClock, fmtPct, fmtUsd } from "../../format";
import type { ModelFamily } from "../../types";
import { Unknown } from "../../ui/Unknown";
import "./session.css";

/** A clock time as the console writes one: HH:MM, local. */
export const clock = (t: number): string => fmtClock(t).slice(0, 5);

/** Why an estimate is missing for a model the server's price table does not hold. */
export const NO_PRICE = "No price for this model";

/**
 * An estimated amount in dollars, or "—" with its reason: `why` when given, the price table for a model the caller says has
 * no Claude price (`family`), else no estimate. A loop carries no reason of its own (a session's is SessionView.costReason,
 * shown by Chips' Cost).
 */
export function Usd({ usd, family, why }: { usd: number | null; family?: ModelFamily; why?: string }) {
  if (usd !== null && Number.isFinite(usd)) return <>{fmtUsd(usd)}</>;
  return <Unknown reason={why ?? (family === "openai" || family === "other" ? NO_PRICE : "No estimate")} />;
}

/** One part of a line built once: the words it says (a title or a screen reader reads them) and, when it is drawn differently, how. */
export interface Part {
  key: string;
  text: string;
  node?: ReactNode;
}

/** How full a context window is, as a level: high from 75 %, nearly full from 80 %, on the shown percent. */
export function contextLevel(percent: number | null): "ok" | "hot" | "crit" {
  if (percent === null) return "ok";
  const p = Math.round(percent);
  if (p >= 80) return "crit";
  if (p >= 75) return "hot";
  return "ok";
}

/** The words a context level adds after its percent, set in ink (a full context is compacted, it does not fail): "high", "nearly full", or nothing. */
export function contextWord(level: "ok" | "hot" | "crit"): string {
  return level === "crit" ? "nearly full" : level === "hot" ? "high" : "";
}

/**
 * A context window's fill: a thin track at the true ratio, the percent beside it, its level's words ("high", "nearly full")
 * as visible text, and its auto-compacts as the "⟲2" badge. The track is green, orange from 75 % and red from 80 %; the
 * percent and its words stay in ink and take weight from 75 %. In a narrow cell the words wrap under the percent rather than
 * hide. The track is decoration; the percent carries the number.
 */
export function ContextMeter({ percent, blowouts, wide }: { percent: number | null; blowouts?: number | null; wide?: boolean }) {
  if (percent === null) return <Unknown reason="The context window is not reported" />;
  const p = Math.max(0, Math.min(100, percent));
  const level = contextLevel(p);
  const word = contextWord(level);
  return (
    <span className={`sv-ctx ${level}${wide ? " wide" : ""}`}>
      <span className="sv-track" aria-hidden="true">
        <i style={{ width: `${p}%` }} />
      </span>
      <span className="sv-ctx-v sv-num">{fmtPct(p)}</span>
      {word ? <span className="sv-ctx-v">{word}</span> : null}
      <BlowBadge n={blowouts ?? null} />
    </span>
  );
}

/**
 * The width of an element (its client width: padding in, border and scrollbar out), kept up to date as it resizes and measured
 * before paint; 0 until it has been measured.
 */
export function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setWidth(el.clientWidth);
    read();
    if (typeof ResizeObserver !== "function") return undefined;
    const watcher = new ResizeObserver(read);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, []);
  return [ref, width];
}
