// Plan-window (rate-limit) wording and thresholds. One convention for both harnesses, said in words: the share used,
// "7d 95% used", as Claude's /usage prints it. Codex's own screens count what is left ("5% left": openai/codex@rust-v0.164.0
// tui/src/status/card.rs:505, rate_limits.rs:388), so a Codex window's title says that too. One colour scale for both: high at
// 75 % or more (orange, with weight and the word), very high at 90 % or more (red and the words). A reading older than Codex's
// own staleness threshold is stale: shown muted with when it was taken, and never the state bar's pick.
import { clockOf } from "./respond";
import { fmtDay } from "./format";
import { PROVIDER } from "./provider";
import type { ProviderName, RateLimit } from "./types";

export const LIMIT_AMBER = 75;
export const LIMIT_RED = 90;

/** A reading older than this is stale: Codex's RATE_LIMIT_STALE_THRESHOLD_MINUTES (tui/src/status/rate_limits.rs:66, 248-255). */
const STALE_MS = 15 * 60_000;

export type LimitLevel = "ok" | "hot" | "crit";

/** A window's level, from the whole percent it shows: 89.6 % reads "90%", so it is very high. */
export function limitLevel(percent: number): LimitLevel {
  const shown = Math.round(percent);
  if (shown >= LIMIT_RED) return "crit";
  if (shown >= LIMIT_AMBER) return "hot";
  return "ok";
}

/** The word a level adds after its percent: "high", "very high", or nothing. */
export function levelWord(level: LimitLevel): string {
  return level === "crit" ? "very high" : level === "hot" ? "high" : "";
}

/** A window's name: five_hour is "5-hour", seven_day "7-day", 90m "90-minute"; anything else as reported, spaced. */
export function limitLabel(kind: string): string {
  if (kind === "five_hour") return "5-hour";
  if (kind === "seven_day") return "7-day";
  const minutes = /^(\d+)m$/.exec(kind);
  if (minutes) return `${minutes[1]}-minute`;
  return kind.replace(/_/g, " ");
}

/** A window's name where a figure follows it in a tight place ("7d 81%"): five_hour "5h", seven_day "7d", 90m "90m". */
export function limitShort(kind: string): string {
  if (kind === "five_hour") return "5h";
  if (kind === "seven_day") return "7d";
  return /^\d+m$/.test(kind) ? kind : limitLabel(kind);
}

/** What a window shows: its short name and the share used, in words, "7d 95% used". */
export const limitFigure = (l: RateLimit): string => `${limitShort(l.kind)} ${Math.round(l.percentUsed)}% used`;

/** A time as the windows say one: "19:00" today, else "Nov 4 19:00" (one form everywhere). */
function whenWords(t: number, now: number): string {
  if (fmtDay(t) === fmtDay(now)) return clockOf(t);
  return `${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${clockOf(t)}`;
}

/** "resets 19:00" today, else "resets Nov 4 19:00"; null when the reset time is unknown. */
export function resetWords(l: RateLimit, now: number): string | null {
  const t = l.resetsAt ? Date.parse(l.resetsAt) : Number.NaN;
  return Number.isFinite(t) ? `resets ${whenWords(t, now)}` : null;
}

/** When the reading was taken (epoch ms); null when its reporter does not say (one older than measuredAt) or it does not parse. */
function measuredMs(l: RateLimit): number | null {
  const t = l.measuredAt ? Date.parse(l.measuredAt) : Number.NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * "as of 14:05" for a reading older than 15 minutes; null for a newer one, and for one with no time (its reporter is older
 * than measuredAt), which is neither called stale nor said to be fresh.
 */
export function staleWords(l: RateLimit, now: number): string | null {
  const at = measuredMs(l);
  return at !== null && now - at > STALE_MS ? `as of ${whenWords(at, now)}` : null;
}

/**
 * A window said whole, for a title: "7-day 95% used (5% left in Codex), very high, resets Nov 8 03:18", and ", as of Nov 3
 * 10:12" when the reading is stale. Codex's figure is its own: 100 less the share used, clamped, whole (card.rs:505).
 */
export function limitWords(l: RateLimit, provider: ProviderName, now: number): string {
  const used = Math.round(l.percentUsed);
  const left = provider === "codex" ? ` (${Math.round(Math.min(100, Math.max(0, 100 - l.percentUsed)))}% left in ${PROVIDER.codex.name})` : "";
  const word = levelWord(limitLevel(l.percentUsed));
  return [`${limitLabel(l.kind)} ${used}% used${left}`, word, resetWords(l, now) ?? "reset not reported", staleWords(l, now)].filter(Boolean).join(", ");
}
