// The usage panel's Today (Usage.tsx): the est. spend since local midnight, the spend record by
// model in each family's colour (a toggle: today, the last 7 days or all time, ended sessions included), and the fleet's est. cost per minute
// (the spend booked in each minute of the last hour) and output tokens per second (the last minute) as small charts. Hand-drawn SVG. Under a machine scope (the filter's `m:` word) the spend and the models are that
// machine's, and the heading names it; the server's per-second and per-minute totals are not split by machine, so the charts
// stay the whole fleet's and say so.
import { useState, type PointerEvent, type ReactNode } from "react";
import { areaPoints, indexAt, seriesPoints, windowMean, xOf } from "../../chart";
import { fmtClock, fmtTok, fmtUsd, plural } from "../../format";
import { familyName, unpricedUse } from "../../logic";
import { providerInfo } from "../../provider";
import { readJson, writeJson } from "../../storage";
import type { Kpis, MachineView, ModelFamily, ProviderName, SessionView } from "../../types";
import { cssVar } from "../../components/Chips";
import { Dots } from "../../ui/Dots";
import { Unknown } from "../../ui/Unknown";

interface ModelSpend {
  key: string;
  provider: ProviderName;
  family: ModelFamily;
  name: string;
  usd: number;
  /** Some of the use on this model has no price. */
  unpriced: boolean;
}

/** What Est. spend by model counts: a span of the spend record, named as its rows' figures are; remembered in this browser. */
type SpendSpan = "today" | "week" | "alltime";
const SPAN_KEY = "fleet.spendSpan";
const SPANS: readonly { key: SpendSpan; word: string }[] = [
  { key: "today", word: "Today" },
  { key: "week", word: "Week" },
  { key: "alltime", word: "All time" },
];

/** A stored choice; "whole" is the old toggle's second choice. */
function storedSpan(): SpendSpan {
  const v = readJson<unknown>(SPAN_KEY, "today");
  return v === "week" ? "week" : v === "alltime" || v === "whole" ? "alltime" : "today";
}

/** What a choice counts, in its hover. */
function spanTitle(span: SpendSpan, since: string | null): string {
  const counted = "Every session, ended ones too";
  if (span === "today") return `${counted}, since midnight on the server`;
  const from = since === null ? "" : `, recorded since ${since}`;
  return span === "week" ? `${counted}, the last 7 days${from}` : `${counted}${from}`;
}

/**
 * The record's figures for a span on the machines in scope (null: every machine), merged by provider and shown name, largest
 * first. A figure of 0 is no use in the span and makes no row; a null is use on a model with no price, unknown and never $0.
 */
function recordedByModel(record: Kpis["spendRecord"], span: SpendSpan, machines: ReadonlySet<string> | null): ModelSpend[] {
  const rows = new Map<string, ModelSpend>();
  for (const r of record) {
    const usd = r[span];
    if (usd === 0 || (machines && !machines.has(r.machineId))) continue;
    const name = familyName(r.family, r.model);
    const key = `${r.provider}:${name}`;
    const row = rows.get(key) ?? { key, provider: r.provider, family: r.family, name, usd: 0, unpriced: false };
    if (usd === null) row.unpriced = true;
    else row.usd += usd;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.usd - a.usd || a.name.localeCompare(b.name));
}

/** Each model's row: its name, a bar at its share of the largest in its family's colour, and its spend. */
function ByModel({ rows, span, onSpan, since }: { rows: ModelSpend[]; span: SpendSpan; onSpan: (s: SpendSpan) => void; since: string | null }) {
  const top = Math.max(0, ...rows.map((r) => r.usd));
  return (
    <div>
      <div className="mc-byhead">
        <h3 className="mc-h3">Est. spend by model</h3>
        <span className="mc-span-pick" role="group" aria-label="Count">
          {SPANS.map(({ key, word }) => (
            <button key={key} type="button" aria-pressed={span === key} title={spanTitle(key, since)} onClick={() => onSpan(key)}>
              {word}
            </button>
          ))}
        </span>
      </div>
      <ol className="mc-bars">
        {rows.map((r) => {
          const { Logo, name } = providerInfo(r.provider);
          return (
            <li key={r.key}>
              <span className="mc-bar-name">
                <Logo />
                <span className="ui-vh">{`${name} `}</span>
                {r.name}
              </span>
              <span className="mc-track" aria-hidden="true">
                <i style={{ width: `${top > 0 ? (r.usd / top) * 100 : 0}%`, ...cssVar(`var(--${r.family})`) }} />
              </span>
              <span className="mc-num">{r.usd === 0 && r.unpriced ? <Unknown reason={`No price for ${r.name}`} /> : fmtUsd(r.usd)}</span>
              {r.unpriced && r.usd > 0 ? <span className="mc-bar-note">some not priced</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const W = 240;
const H = 64;

/** The top of a scale at or above `peak`: twice a round step (1, 2 or 5 × 10ⁿ), so its middle line is round too; a count's step is 1 at least. */
function roundTop(peak: number, whole: boolean): number {
  const half = Math.max(whole ? 1 : 0, peak / 2);
  if (!(half > 0)) return 2;
  const unit = 10 ** Math.floor(Math.log10(half));
  return 2 * unit * ([1, 2, 5].find((k) => k * unit >= half - 1e-9) ?? 10);
}

/** Money on a scale: whole dollars when the step is, else the cents the step needs, the same on every label. */
function usdTick(v: number, step: number): string {
  const digits = step >= 1 ? 0 : Math.max(2, Math.ceil(-Math.log10(step) - 1e-9));
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** A rate on a scale, with no trailing zeros: "0", "500k/s", "1M/s". */
function rateTick(v: number): string {
  if (v === 0) return "0";
  const [unit, word] = v >= 1e6 ? [1e6, "M"] : v >= 1e3 ? [1e3, "k"] : [1, ""];
  return `${Number((v / unit).toPrecision(3))}${word}/s`;
}

interface RateChartProps {
  label: string;
  /** Said after the label, muted: "all machines" under a machine scope. */
  note?: string;
  values: readonly number[];
  format: (v: number) => string;
  tick: (v: number, step: number) => string;
  /** How far back the series reaches ("60m"), and the time between two points. */
  span: string;
  stepMs: number;
  /** When the newest point was taken. */
  endTime: number;
  /** The reading is the mean of the newest this many points. */
  meanOf?: number;
  whole?: boolean;
  /** The line's colour. */
  color: string;
}

/** One series: a scale with round steps, the line, and the reading, which follows the pointer with its time. */
function RateChart({ label, note, values, format, tick, span, stepMs, endTime, meanOf, whole = false, color }: RateChartProps) {
  const [at, setAt] = useState<number | null>(null);
  const n = values.length;
  const peak = Math.max(0, ...values);
  const top = roundTop(peak, whole);
  const latest = meanOf ? windowMean(values, meanOf) : (values[n - 1] ?? 0);
  const bySecond = stepMs < 60_000;
  const reading = at === null ? format(latest) : `${fmtClock(endTime - (n - 1 - at) * stepMs).slice(bySecond ? 3 : 0, bySecond ? 8 : 5)}  ${format(values[at] ?? 0)}`;
  const follow = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width > 0) setAt(indexAt(e.clientX, box.left, box.width, n));
  };
  const crossX = at === null ? null : xOf(at, n, W);
  return (
    <figure className="mc-chart" style={cssVar(color)}>
      <figcaption>
        <span>
          {label}
          {note ? <span className="mc-dim">{` · ${note}`}</span> : null}
        </span>
        <span className="mc-reading" title={at === null && meanOf ? `Mean of the last ${meanOf} points` : undefined}>
          {reading}
        </span>
      </figcaption>
      <div className="mc-plot">
        <span className="mc-scale" aria-hidden="true">
          {[top, top / 2, 0].map((v) => (
            <span key={v}>{tick(v, top / 2)}</span>
          ))}
        </span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}, the last ${span}: now ${format(latest)}, peak ${format(peak)}`} onPointerMove={follow} onPointerLeave={() => setAt(null)}>
          <line className="mc-grid" x1="0" x2={W} y1="1" y2="1" vectorEffect="non-scaling-stroke" />
          <line className="mc-grid" x1="0" x2={W} y1={H / 2} y2={H / 2} vectorEffect="non-scaling-stroke" />
          <line className="mc-base" x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} vectorEffect="non-scaling-stroke" />
          <polygon className="mc-area" points={areaPoints(values, W, H, top, 1)} />
          <polyline className="mc-line" points={seriesPoints(values, W, H, top, 1)} vectorEffect="non-scaling-stroke" />
          {crossX === null ? null : <line className="mc-cross" x1={crossX} x2={crossX} y1="0" y2={H} vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <div className="mc-span" aria-hidden="true">
        <span>{`${span} ago`}</span>
        <span>now</span>
      </div>
    </figure>
  );
}

/** A machine scope: the filter's `m:` word and the machines it picks (Usage scopedMachines). */
export interface TodayScope {
  word: string;
  machines: readonly MachineView[];
}

/**
 * The est. spend since local midnight: the fleet's, or the scope's machines' summed from the server's split by machine, where a
 * machine missing from the split spent nothing recorded today and one with unpriced use is unknown (as its Machines row says).
 */
function spendToday(kpis: Kpis, scope: TodayScope | null): number | { unknown: string } {
  if (!scope) return kpis.costToday;
  const ids = new Set(scope.machines.map((m) => m.id));
  const rows = kpis.costTodayByMachine.filter((r) => ids.has(r.machineId));
  return rows.some((r) => r.unpriced) ? { unknown: "No price for some models" } : rows.reduce((n, r) => n + r.costUsd, 0);
}

export function Today({ kpis, live, now, scope }: { kpis: Kpis | null; live: readonly SessionView[]; now: number; scope: TodayScope | null }) {
  const ids = scope ? new Set(scope.machines.map((m) => m.id)) : null;
  const sessions = ids ? live.filter((s) => ids.has(s.machine.id)) : live;
  const [span, setSpan] = useState<SpendSpan>(storedSpan);
  const pickSpan = (next: SpendSpan) => {
    writeJson(SPAN_KEY, next);
    setSpan(next);
  };
  // The token series ends at the last whole second before now.
  const lastSecond = now - (now % 1000) - 1000;
  const named = scope ? scope.machines.map((m) => m.name).join(", ") || scope.word.slice("m:".length) : null;
  const unpricedLive = scope ? sessions.filter(unpricedUse).length : (kpis?.unpricedSessions ?? 0);
  const fleetWide = scope ? "all machines" : undefined;
  let meta: ReactNode = null;
  if (kpis && scope?.machines.length === 0) meta = "No machine matches";
  else if (kpis) {
    const spend = spendToday(kpis, scope);
    meta = (
      <Dots
        items={[
          <span key="c" title="Since local midnight, ended sessions included">
            est. <b className="mc-num">{typeof spend === "number" ? fmtUsd(spend) : <Unknown reason={spend.unknown} />}</b>
          </span>,
          unpricedLive > 0 ? `${plural(unpricedLive, "live session")} not priced` : null,
        ]}
      />
    );
  }
  return (
    <section className="mc-sec" aria-labelledby="mc-today">
      <div className="mc-sec-head">
        <h2 id="mc-today">{named ? `Today on ${named}` : "Today"}</h2>
        {meta ? <span className="mc-meta">{meta}</span> : null}
      </div>
      {kpis ? (
        <div className="mc-today">
          {kpis.spendRecord.length > 0 ? <ByModel rows={recordedByModel(kpis.spendRecord, span, ids)} span={span} onSpan={pickSpan} since={kpis.spendSince} /> : null}
          <RateChart label="Est. cost per minute" note={fleetWide} values={kpis.costPerMinute} format={fmtUsd} tick={usdTick} span="60m" stepMs={60_000} endTime={now} color="var(--eff-high)" />
          <RateChart label="Output tokens per second" note={fleetWide} values={kpis.tokensPerSec} format={(v) => `${fmtTok(v)}/s`} tick={rateTick} span="60s" stepMs={1000} endTime={lastSecond} meanOf={10} whole color="var(--eff-xhigh)" />
        </div>
      ) : (
        <p className="ui-empty">Waiting for the server's first totals</p>
      )}
    </section>
  );
}
