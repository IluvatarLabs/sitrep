// Numbers, times and counts as the console prints them. A value nobody reported is "—", never 0.

type Maybe = number | null | undefined;

const UNKNOWN = "—";
const isNumber = (value: Maybe): value is number => typeof value === "number" && Number.isFinite(value);
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "1 agent", "2 agents"; the plural is passed when it is not the word and an "s". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Token counts: 999, 1.0k, 123k, 1.50M. */
export function fmtTok(value: Maybe): string {
  if (!isNumber(value)) return UNKNOWN;
  const v = Math.max(0, value);
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(v));
}

/** Dollars: $0.53, $12.84, $140, $2,926. */
export function fmtUsd(value: Maybe): string {
  if (!isNumber(value)) return UNKNOWN;
  const v = Math.max(0, value);
  const digits = v >= 100 ? 0 : 2;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** The title of a partial cost ("$817+"): why its true figure is higher. */
export const COST_PARTIAL_WHY = "Leaves out usage on models with no price";

/**
 * A session's est. cost, the one form every place prints it in: "$817"; "$817+" when it is known but leaves out usage on models
 * with no price (`partial`: SessionView.costPartial, HistoryRow.costPartial), so the true figure is higher, with
 * COST_PARTIAL_WHY as its title; "—" when nobody could price it (its reason is the caller's, as for every unknown).
 */
export function fmtCost(value: Maybe, partial: boolean): string {
  return partial && isNumber(value) ? `${fmtUsd(value)}+` : fmtUsd(value);
}

/** A span's whole days, hours, minutes and seconds; a negative or non-finite span is none. */
function units(seconds: number) {
  const t = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return { d: Math.floor(t / 86400), h: Math.floor(t / 3600) % 24, m: Math.floor(t / 60) % 60, s: t % 60 };
}

/** A span in two units: 12s, 6m 12s, 1h 05m, 2d 03h. */
export function fmtSpan(seconds: number): string {
  const { d, h, m, s } = units(seconds);
  if (d) return `${d}d ${pad2(h)}h`;
  if (h) return `${h}h ${pad2(m)}m`;
  return m ? `${m}m ${pad2(s)}s` : `${s}s`;
}

/** A span in its largest unit, as a state line says it ("Idle 12m"): 19s, 12m, 3h, 2d. */
export function fmtAge(seconds: number): string {
  const { d, h, m, s } = units(seconds);
  return d ? `${d}d` : h ? `${h}h` : m ? `${m}m` : `${s}s`;
}

/** Local wall-clock time, HH:MM:SS: the head of the standard time string. */
export const fmtClock = (t: number): string => new Date(t).toTimeString().slice(0, 8);

/** The local date, YYYY-MM-DD. */
export function fmtDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** A count with grouped digits: 18,402. */
export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** A whole percentage from 0 to 100. */
export function fmtPct(value: Maybe): string {
  return isNumber(value) ? `${Math.round(Math.min(100, Math.max(0, value)))}%` : UNKNOWN;
}
