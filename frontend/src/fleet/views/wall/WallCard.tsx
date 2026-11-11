// One session as a card in the Fleet's Cards layout, its rows on the grid's row tracks (wall.css: the card is a
// subgrid), so a row lines up across the cards beside it:
//   1. its state's mark, name, pin and model;
//   2. on separate lines: the machine (when the groups do not name it), where it runs when that is not a terminal ("Desktop",
//      "headless"; Chips SurfaceChip), and its path; its git line; its session id to copy;
//   3. what it is doing in one line, with its plan's bar and done/total when it has a plan (fleet doingLine); a session that
//      needs you shows Answer here (it opens the answer drawer; the answer controls live in Attention);
//   4. its agents' counts in words and, under them, their squares, filled by state (a stuck one orange), up to two lines' worth;
//   5. context with its bar, est. cost and time.
// The sidebar's Details switch adds two rows, and only what it adds takes room: under the doing line, its plan step ("Step 3/6 ·
// text", else "Next: text" inferred and muted) and its notes and relations as muted facts ("Nobody attached · 3 messages · 77
// tool calls"), the plan's bar moving there; the doing line then says the state with the names of the agents it delegates to
// (Lines DoingParts); and under the agents, its output tokens per minute over the last 30 minutes across the card (components/Sparkline)
// with the current rate at its end (Claude reports once a response, so a minute is the step that shows a steady burn from
// bursts).
// Every row keeps its height whatever the data does, so a card never grows or shrinks while it is on screen.
// A state edge marks a card that needs you, is stuck or failed, and, in stuck's orange, one whose agent runs stuck (it is in
// Problems; auto-compacts never mark a card: they are a neutral count); nobody attached dashes it. Only the name is a link, so
// the pin, the id and Answer are buttons beside it, never inside it; a click anywhere else on the card opens the session too
// (openCard).
import type { MouseEvent } from "react";
import { hashFor } from "../../../route";
import { BlowBadge, ContextBar, ContextFigure, Cost, GitLine, PlanBar, SurfaceChip } from "../../components/Chips";
import { SessionIdCopy } from "../../components/SessionId";
import { Sparkline } from "../../components/Sparkline";
import { Squares } from "../../components/Squares";
import { fmtSpan, fmtTok } from "../../format";
import { planProgress, sessionElapsedSec, tokensKnown } from "../../logic";
import { stateOf } from "../../states";
import type { SessionView } from "../../types";
import { Dots } from "../../ui/Dots";
import { MidCut } from "../../ui/MidCut";
import { Station } from "../../ui/Station";
import { Unknown } from "../../ui/Unknown";
import { useDetails } from "../../useDetails";
import { useRespond } from "../../useRespond";
import { respondGate } from "../../respond";
import { Model, PinButton } from "../now/controls";
import { doing, doingLine, sessionFacts, stepOf } from "../now/fleet";
import { DoingParts, FactsPart, StepPart } from "./Lines";

/**
 * The whole card opens its session: a click anywhere but on a link or a button, unless it ends a text selection (the card's click
 * defers to the name's link). Every part keeps its hover title. The name stays the one link, for the keyboard and a new tab.
 */
function openCard(e: MouseEvent<HTMLElement>, href: string): void {
  if (e.defaultPrevented || (e.target as Element).closest("a, button") || document.getSelection()?.toString()) return;
  window.location.hash = href;
}

/**
 * Agent squares a card draws, the live ones first, before "+N": two lines on the narrowest card, 340 px (wallLayout): 314 px
 * inside it holds 24 squares of 10 px 3 px apart a line, and the second line keeps room for "+999" (3 + 3 px and four 7.8 px
 * mono figures) after 21. Past that the words count them all.
 */
const CARD_SQUARES = 45;

/** The states a card's edge shows. */
const EDGED = new Set(["needs-you", "stuck", "failed"]);

/** Answer, for a session that needs you and takes an answer from here: it opens the answer drawer (shell/answering). */
function CardAnswer({ s }: { s: SessionView }) {
  const ctx = useRespond();
  if (!ctx || !respondGate(s, ctx.me, ctx.settingsOn).show) return null;
  return (
    <button type="button" className="ui-button" aria-haspopup="dialog" onClick={(e) => ctx.open(s.id, e.currentTarget)}>
      Answer
    </button>
  );
}

export function WallCard({ s, now, machine, pinned, onPin }: { s: SessionView; now: number; machine: string | null; pinned: boolean; onPin: () => void }) {
  const [detailed] = useDetails();
  const state = stateOf(s);
  const edge = EDGED.has(state) ? state : s.agents.some((a) => a.stuck) ? "stuck" : undefined;
  const progress = planProgress(s.plan);
  const step = detailed ? stepOf(s) : null;
  const facts = detailed ? sessionFacts(s, now) : [];
  // Details off: the one line of what it is doing; on, its parts (null here).
  const brief = detailed ? null : doingLine(s, now);
  const nameId = `wc-${s.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const href = hashFor("session", s.id);
  const cls = ["wc", s.attached === false && "is-detached", pinned && "is-pinned"].filter(Boolean).join(" ");
  const pct = s.context.percent;
  // The series' last minute is the current rate (SessionView.series.tokensPerMin).
  const perMin = s.series.tokensPerMin;
  const plan = progress ? (
    <span className="wc-plan">
      <PlanBar pct={progress.pct} />
      <span>{`${progress.done}/${progress.total}`}</span>
    </span>
  ) : null;
  return (
    <article className={cls} data-edge={edge} data-details={detailed || undefined} aria-labelledby={nameId} onClick={(e) => openCard(e, href)}>
      <div className="wc-who">
        <Station kind={state} label />
        <h3 className="wc-name" id={nameId}>
          <a href={href}>
            <MidCut text={s.name} />
          </a>
        </h3>
        <PinButton name={s.name} on={pinned} onToggle={onPin} />
        <Model provider={s.provider} m={s} />
      </div>
      <div className="wc-where">
        <div className="wc-where-line">
          {machine ? (
            <span className="wc-machine" title={machine}>
              {machine}
            </span>
          ) : null}
          <SurfaceChip surface={s.hostSurface} />
          {/* Right to left puts the ellipsis at the front of a long path, so its last folders stay in view; bdi keeps its order. */}
          {s.project ? (
            <span className="wc-path" title={s.project}>
              <bdi>{s.project}</bdi>
            </span>
          ) : (
            <Unknown reason="Project not reported" />
          )}
        </div>
        {/* Its line is kept while git is not yet read, so the card does not grow when it arrives. */}
        {s.git ? <GitLine git={s.git} files={s.files} /> : <span aria-hidden="true" />}
        <SessionIdCopy id={s.nativeId} full />
      </div>
      <div className="wc-doing">
        {brief === null ? (
          <p className="wc-doing-text fl-line">
            <DoingParts d={doing(s, now)} />
          </p>
        ) : (
          <>
            <p className="wc-doing-text" title={brief}>
              {brief}
            </p>
            {plan}
          </>
        )}
        {state === "needs-you" ? <CardAnswer s={s} /> : null}
      </div>
      {detailed ? (
        <div className="wc-more">
          <p className="wc-more-text fl-line">
            {step ? <StepPart step={step} /> : null}
            {facts.length > 0 ? <FactsPart facts={facts} /> : null}
          </p>
          {plan}
        </div>
      ) : null}
      <div className="wc-crew">{s.agents.length > 0 ? <Squares s={s} cap={CARD_SQUARES} /> : null}</div>
      {detailed ? (
        <div className="wc-rate" title="Output tokens per minute, the last 30 minutes">
          {/* Unreported tokens would draw as a flat zero, so there is no trend then, only "—". */}
          {tokensKnown(s) && perMin.length > 0 ? (
            <>
              <Sparkline values={perMin} w={240} h={20} />
              <span className="wc-rate-now">{`${fmtTok(perMin[perMin.length - 1]!)} tok/min`}</span>
            </>
          ) : (
            <Unknown reason="Token counts not reported" />
          )}
        </div>
      ) : null}
      <div className="wc-figs">
        {pct === null ? null : <ContextBar percent={pct} />}
        <Dots
          items={[
            <span key="ctx">
              <ContextFigure percent={pct} />
              <BlowBadge n={s.blowouts?.total ?? null} />
            </span>,
            <span key="cost">
              est. <Cost s={s} />
            </span>,
            fmtSpan(sessionElapsedSec(s, now)),
          ]}
        />
      </div>
    </article>
  );
}
