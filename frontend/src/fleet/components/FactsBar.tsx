// The session page's facts, two rows on fixed tracks so a cell never moves because another has nothing to say. Row one: Agents,
// Est. cost, Tokens, Time, Agent time, and Context with its auto-compacts. Row two: the last 60 seconds of output tokens per second,
// peak context and agents running as small charts in the facts' own size, the Reporter, and Limits with each window's reset. Each
// value is said in the fewest words that fit, the rest on hover; Agents and Limits wrap between their items. The auto-compact
// badge opens which loops were compacted. An explanation is the shared Tip, an unknown value the shared Unknown.
import { useState, type PointerEvent, type ReactNode } from "react";
import { reporterOf } from "../../../../server/src/fleet/protocol";
import { areaPoints, indexAt, seriesPoints, windowMean, xOf } from "../chart";
import { fmtSpan, fmtTok, plural } from "../format";
import { limitFigure, limitLevel, limitWords, resetWords, staleWords } from "../limits";
import { agentElapsedSec, AGENTS_HINT, COST_HINT_SESSION, sessionCounts, sessionElapsedSec, sessionTokens, TOKENS_HINT, tokensKnown } from "../logic";
import type { SessionView } from "../types";
import { Unknown } from "../ui/Unknown";
import { ContextMeter, contextLevel, contextWord } from "../views/session/bits";
import "../views/session/session.css";
import { BlowBadge, Cost } from "./Chips";
import { IconCompact, IconX } from "./Icons";
import { HOOKS_OFF_NOTE, hooksOffText, versionNote } from "./SessionCard";
import { Tip } from "./Tip";

/** A cell: its label over its value. A value given as words is said whole on hover, as the cell may cut it. */
function Cell({ label, children, cls, title }: { label: string; children: ReactNode; cls?: string; title?: string }) {
  return (
    <div className={cls ? `sv-fact ${cls}` : "sv-fact"} title={title}>
      <div className="sv-fk">{label}</div>
      <div className="sv-fv">{typeof children === "string" ? <span title={children}>{children}</span> : children}</div>
    </div>
  );
}

/** Loops running and done (the main loop counted, as the agent tree lists it), and a way to the first failure when there is one. */
function AgentsValue({ s, onAgent }: { s: SessionView; onAgent: (id: string) => void }) {
  const counts = sessionCounts(s);
  const firstFailed = s.agents.find((a) => a.status === "failed");
  return (
    <>
      <span>{`${counts.running} running`}</span>
      <span className="sv-fsoft">{`${counts.done} done`}</span>
      {firstFailed ? (
        <button type="button" className="sv-link bad" title="Open the first failed agent" onClick={() => onAgent(firstFailed.id)}>
          <IconX />
          {`${counts.failed} failed`}
        </button>
      ) : null}
    </>
  );
}

/** The main loop's time plus every agent's own: longer than Time while agents run at once. */
const agentTimeSec = (s: SessionView, now: number): number => s.agents.reduce((n, a) => n + agentElapsedSec(a, now), sessionElapsedSec(s, now));

interface CompactsControl {
  open: boolean;
  onToggle: () => void;
  controls: string;
}

/**
 * The main loop's context, then the session's auto-compacts: the "⟲2" badge, which opens the loops it hit; "⟲0" when there
 * were none; "⟲—" with the reason when its reporter cannot tell (Codex hooks off).
 */
function ContextValue({ s, compacts }: { s: SessionView; compacts: CompactsControl }) {
  const b = s.blowouts;
  let count: ReactNode;
  if (b === null) {
    const why = s.hooksActive === false ? `${hooksOffText(s)}. ${HOOKS_OFF_NOTE}` : "Auto-compacts not reported";
    count = (
      <span className="sv-fcompacts">
        <IconCompact />
        <Unknown reason={why} />
      </span>
    );
  } else if (b.total === 0) {
    count = (
      <span className="sv-fcompacts sv-fsoft" title="No auto-compacts">
        <IconCompact />
        <span aria-hidden="true">0</span>
        <span className="ui-vh">No auto-compacts</span>
      </span>
    );
  } else {
    count = (
      <button type="button" className="sv-fbadge" aria-expanded={compacts.open} aria-controls={compacts.open ? compacts.controls : undefined} title="Which loops were auto-compacted" onClick={compacts.onToggle}>
        <BlowBadge n={b.total} />
      </button>
    );
  }
  return (
    <>
      <ContextMeter percent={s.context.percent} />
      {count}
    </>
  );
}

/** The reporter's version and a dev build's commit. Out of the server's range, what to do is the session header's notice
 * (and this cell's tooltip), not said again here. */
function ReporterValue({ s }: { s: SessionView }) {
  return (
    <>
      <span className="sv-mono">{s.reporterVersion || <Unknown reason="The reporter did not say its version" />}</span>
      {s.reporterBuild ? <span className="sv-mono sv-fsoft">{`dev ${s.reporterBuild}`}</span> : null}
    </>
  );
}

/**
 * The plan windows this session last reported: each window's short name and share used ("7d 95% used"), orange from
 * 75 % and red from 90 %, and when it resets, wrapping between windows; a stale reading muted, with when it was taken in the
 * reset's place. The full names, the level words and a Codex window's own "left" are on hover (limits.ts).
 */
function LimitsValue({ s, now }: { s: SessionView; now: number }) {
  if (s.rateLimits.length === 0) return <Unknown reason="No plan windows reported yet" />;
  return (
    <Tip text={`${s.rateLimits.map((l) => limitWords(l, s.provider, now)).join("; ")}.`} className="sv-flims">
      {s.rateLimits.map((l) => {
        const stale = staleWords(l, now);
        return (
          <span key={l.kind} className="sv-limw">
            <span className={`sv-lim ${stale ? "stale" : limitLevel(l.percentUsed)}`}>{limitFigure(l)}</span>
            <span className="sv-fsoft">{stale ?? resetWords(l, now) ?? <Unknown reason="Reset not reported" />}</span>
          </span>
        );
      })}
    </Tip>
  );
}

const TREND_W = 120;
const TREND_H = 20;

interface TrendProps {
  /** What the chart is, for its summary: "Output tokens per second". */
  name: string;
  /** One point a second, oldest first (SessionView.series). */
  values: readonly number[];
  format: (v: number) => string;
  /** The top of the scale; the largest value when left out. */
  top?: number;
  /** The reading is the mean of the newest this many points, else the newest point. */
  meanOf?: number;
  /** Points to mark with a rule, in seconds before the newest (auto-compacts). */
  marks?: readonly number[];
  /** Words the summary adds after a value (a context level's). */
  word?: (v: number) => string;
}

/**
 * One series of the last 60 seconds as a fact's value: the reading, then a shaded line in ink-2 (the sparkline's look: data,
 * not a state) with its marks as rules. Under the pointer the reading is that second's, a crosshair where it is.
 */
function Trend({ name, values, format, top, meanOf, marks = [], word }: TrendProps) {
  const [at, setAt] = useState<number | null>(null);
  const n = values.length;
  const latest = meanOf ? windowMean(values, meanOf) : (values[n - 1] ?? 0);
  const peak = Math.max(0, ...values);
  const scale = top ?? Math.max(1, peak);
  const ruled = marks.filter((age) => age >= 0 && age < n);
  const follow = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width > 0) setAt(indexAt(e.clientX, box.left, box.width, n));
  };
  const words = (v: number) => `${format(v)}${word?.(v) ? ` ${word(v)}` : ""}`;
  const summary = [`${name}, last 60 s: now ${words(latest)}`, `peak ${words(peak)}`, ruled.length ? plural(ruled.length, "auto-compact") : null].filter(Boolean).join(", ");
  const crossX = at === null ? null : xOf(at, n, TREND_W);
  return (
    <>
      <span className="sv-trend-v">
        {at === null ? format(latest) : format(values[at] ?? 0)}
        {/* The series ends at the last whole second, so its newest point is a second ago and its oldest 60 (server buildSeries). */}
        {at === null ? null : <span className="sv-fsoft">{` ${n - at}s ago`}</span>}
      </span>
      <svg className="sp sv-trend" viewBox={`0 0 ${TREND_W} ${TREND_H}`} preserveAspectRatio="none" role="img" aria-label={summary} onPointerMove={follow} onPointerLeave={() => setAt(null)}>
        <title>{summary}</title>
        <polyline className="area" points={areaPoints(values, TREND_W, TREND_H, scale)} />
        <polyline points={seriesPoints(values, TREND_W, TREND_H, scale)} />
        {ruled.map((age, i) => {
          const x = xOf(n - 1 - age, n, TREND_W);
          return <line key={`${age}:${i}`} className="sv-trend-mark" x1={x} x2={x} y1="0" y2={TREND_H} />;
        })}
        {crossX === null ? null : <line className="sv-trend-cross" x1={crossX} x2={crossX} y1="0" y2={TREND_H} />}
      </svg>
    </>
  );
}

/** A trend's cell: the chart, or "—" with `unknown`'s reason (a stored session's last 60 seconds are long gone; the server
 * fills seconds nobody reported with 0, so a figure no loop reports yet is unknown, never a flat 0). */
function TrendCell({ label, title, unknown, ...trend }: TrendProps & { label: string; title: string; unknown: string | null }) {
  return (
    <Cell label={label} cls="sv-fnum" title={title}>
      {unknown ? <Unknown reason={unknown} /> : <Trend {...trend} />}
    </Cell>
  );
}

const ENDED = "Ended: no live figures";

interface FactsProps {
  s: SessionView;
  now: number;
  /** A stored session (History): it ran rather than runs. */
  readOnly: boolean;
  onAgent: (id: string) => void;
  compacts: CompactsControl;
}

export function FactsBar({ s, now, readOnly, onAgent, compacts }: FactsProps) {
  const { tokensPerSec, peakContext, running, blowoutSecondsAgo } = s.series;
  const reporter = versionNote(s);
  const contextKnown = s.context.percent !== null || s.agents.some((a) => a.context.percent !== null);
  const notYet = (known: boolean) => (readOnly ? ENDED : known ? null : "Not reported yet");
  return (
    <div className="sv-facts" role="group" aria-label="Facts">
      <Cell label="Agents" cls="sv-fwrap" title={AGENTS_HINT}>
        <AgentsValue s={s} onAgent={onAgent} />
      </Cell>
      <Cell label="Est. cost" cls="sv-fnum" title={COST_HINT_SESSION}>
        <Cost s={s} />
      </Cell>
      <Cell label="Tokens" cls="sv-fnum" title={TOKENS_HINT}>
        {tokensKnown(s) ? fmtTok(sessionTokens(s)) : <Unknown reason="Not reported yet" />}
      </Cell>
      <Cell label="Time" cls="sv-fnum">
        {fmtSpan(sessionElapsedSec(s, now))}
      </Cell>
      <Cell label="Agent time" cls="sv-fnum" title="The main loop's time plus every agent's own, so it passes Time while agents run at once.">
        {fmtSpan(agentTimeSec(s, now))}
      </Cell>
      <Cell label="Context">
        <ContextValue s={s} compacts={compacts} />
      </Cell>
      <TrendCell label="Output/s" title="Output tokens per second, the mean of the last 10 seconds" unknown={notYet(tokensKnown(s))} name="Output tokens per second" values={tokensPerSec} format={(v) => `${fmtTok(v)}/s`} meanOf={10} />
      <TrendCell
        label="Peak context"
        title="The fullest context of any loop, each second"
        unknown={notYet(contextKnown)}
        name="Peak context"
        values={peakContext}
        top={1}
        format={(v) => `${Math.round(v * 100)}%`}
        word={(v) => contextWord(contextLevel(v * 100))}
        marks={s.blowouts === null ? [] : blowoutSecondsAgo}
      />
      <TrendCell label="Subagents running" title="The agents it launched, not the main loop" unknown={readOnly ? ENDED : null} name="Subagents running" values={running} top={Math.max(4, Math.ceil(Math.max(0, ...running) / 2) * 2)} format={(v) => String(v)} />
      <Cell label="Reporter" title={reporter ? reporter.text : `${reporterOf(s.provider)} ${s.reporterVersion || "version not reported"}${s.reporterBuild ? `, dev build ${s.reporterBuild}` : ""}`}>
        <ReporterValue s={s} />
      </Cell>
      <Cell label="Limits" cls="sv-fwrap sv-flimits">
        <LimitsValue s={s} now={now} />
      </Cell>
    </div>
  );
}
