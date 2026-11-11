// The Fleet's List layout: one row per session in two lines. Line one: its state's mark, name (with where it runs
// when that is not a terminal, Chips SurfaceChip), model, context, est. cost and time. Line two: what it is doing in one line (fleet doingLine), or, with the sidebar's Details switch on
// (useDetails), what it is doing (its state, with the names of the agents it delegates to), its plan step in every state, and
// its notes and relations (wall/Lines); then its session id to copy, and its agents' squares. The headers sort. A chevron
// opens the session's line of stations (views/map SessionBlock) beside its plan (components/PlanPanel). A row never opens by
// itself; Expand all opens every row, and the owner's chevron wins until Expand all changes. With Expand all and Group by
// Machine, a machine's opened rows are laid out as one zone (views/map layoutMap), so their stations share one column and a
// file two of them edit joins their stations across the rows. Pinned rows lead their group. Only the name is a
// link.
import { useMemo, useRef, useState } from "react";
import { hashFor } from "../../../route";
import { BlowBadge, ContextFigure, Cost, SurfaceChip } from "../../components/Chips";
import { PlanSteps } from "../../components/PlanPanel";
import { SessionIdCopy } from "../../components/SessionId";
import { Squares } from "../../components/Squares";
import { fmtPct, fmtSpan } from "../../format";
import { planProgress, sessionElapsedSec, type SortKey } from "../../logic";
import { pinnedFirst, type Pin } from "../../pins";
import { stateOf } from "../../states";
import type { SessionView } from "../../types";
import { Station } from "../../ui/Station";
import { useDetails } from "../../useDetails";
import type { FleetPrefsApi } from "../../useGroupPrefs";
import { layoutMap, layoutSession, type MapSession } from "../map/layout";
import { SessionBlock, useBlockPlaces, ZoneRings, type Hot } from "../map/SessionBlock";
import { DoingParts, FactsPart, StepPart } from "../wall/Lines";
import { Chevron, Groups, Model, PinButton } from "./controls";
import { doing, doingLine, sessionFacts, stepOf, type FleetShape } from "./fleet";

/** Squares a row draws at most before "+N": what its three figure columns hold. */
const ROW_SQUARES = 14;

/** A zone's machine goes unnamed: the group's header names it. */
const NO_LABELS: ReadonlyMap<string, string> = new Map();

const idOf = (prefix: string, key: string) => `${prefix}-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;

interface RowProps {
  s: SessionView;
  all: readonly SessionView[];
  now: number;
  open: boolean;
  onOpen: () => void;
  /** The session's ended agents are shown in its opened block. */
  showEnded: boolean;
  onShowEnded: (id: string) => void;
  pinned: boolean;
  onPin: () => void;
  /** Its block as its machine's zone laid it out (Expand all, Group by Machine); null when the row lays out its own. */
  zoned: MapSession | null;
  hot?: Hot;
}

function Row({ s, all, now, open, onOpen, showEnded, onShowEnded, pinned, onPin, zoned, hot }: RowProps) {
  const state = stateOf(s);
  const plan = planProgress(s.plan) !== null;
  const opens = s.agents.length > 0 || plan;
  const blockId = idOf("lr-open", s.id);
  const own = useMemo(() => (open && zoned === null ? layoutSession(s, all, showEnded) : null), [open, zoned, s, all, showEnded]);
  const block = open ? (zoned ?? own) : null;
  const [detailed] = useDetails();
  const step = detailed ? stepOf(s) : null;
  const facts = detailed ? sessionFacts(s, now) : [];
  // Details off: the one line of what it is doing; on, its parts (null here).
  const brief = detailed ? null : doingLine(s, now);
  const pct = s.context.percent;
  return (
    <li className="lr">
      <div className="lr-line">
        {opens ? (
          <button type="button" className="lr-fold" aria-expanded={open} aria-controls={blockId} aria-label={`${open ? "Hide" : "Show"} the agents and plan of ${s.name}`} onClick={onOpen}>
            <Chevron open={open} />
          </button>
        ) : (
          <span className="lr-fold" />
        )}
        <span className="lr-mark">
          <Station kind={state} label />
        </span>
        <span className="lr-name">
          <a className="now-name" href={hashFor("session", s.id)} title={s.name}>
            {s.name}
          </a>
          <SurfaceChip surface={s.hostSurface} />
        </span>
        <span className="lr-model">
          <Model provider={s.provider} m={s} />
        </span>
        <span className="lr-fig lr-ctx">
          <span className="ui-vh">Context </span>
          {pct !== null && Math.round(pct) >= 75 ? <b>{fmtPct(pct)}</b> : <ContextFigure percent={pct} />}
          <BlowBadge n={s.blowouts?.total ?? null} />
        </span>
        <span className="lr-fig lr-cost">
          <span className="ui-vh">Est. cost </span>
          <Cost s={s} />
        </span>
        <span className="lr-fig lr-time">
          <span className="ui-vh">Time </span>
          {fmtSpan(sessionElapsedSec(s, now))}
        </span>
        <span className="lr-pin">
          <PinButton name={s.name} on={pinned} onToggle={onPin} />
        </span>
        <span className="lr-doing fl-line">
          {brief === null ? (
            <>
              <DoingParts d={doing(s, now)} />
              {step ? <StepPart step={step} /> : null}
              {facts.length > 0 ? <FactsPart facts={facts} /> : null}
            </>
          ) : (
            <span className="fl-said" title={brief}>
              {brief}
            </span>
          )}
          <SessionIdCopy id={s.nativeId} />
        </span>
        <span className="lr-crew">{s.agents.length > 0 ? <Squares s={s} cap={ROW_SQUARES} words={false} /> : null}</span>
      </div>
      {block ? (
        <div className={plan ? "lr-open has-plan" : "lr-open"} id={blockId}>
          <SessionBlock ms={block} now={now} onToggle={onShowEnded} bare hot={hot} />
          {plan ? <PlanSteps s={s} /> : null}
        </div>
      ) : null}
    </li>
  );
}

interface BodyProps {
  list: readonly SessionView[];
  bodyId: string;
  hidden: boolean;
  /** Lay the opened rows out as one zone: Expand all, with the groups by machine. */
  together: boolean;
  all: readonly SessionView[];
  now: number;
  pins: Pin[];
  onPin: (id: string, slot: number) => void;
  isOpen: (s: SessionView) => boolean;
  onOpen: (s: SessionView) => void;
  showEnded: ReadonlySet<string>;
  onShowEnded: (id: string) => void;
}

/**
 * One group's rows. Laid out together, the opened rows' blocks come from their machine's zone, and the rings that join two of
 * them are drawn over the rows, where each block was placed (measured); a station under the pointer or holding focus lights its
 * rings.
 */
function Body({ list, bodyId, hidden, together, all, now, pins, onPin, isOpen, onOpen, showEnded, onShowEnded }: BodyProps) {
  const host = useRef<HTMLDivElement>(null);
  const [hotKey, setHotKey] = useState<string | null>(null);
  const hot: Hot = { key: hotKey, set: (key, on) => setHotKey((was) => (on ? key : was === key ? null : was)) };
  const rows = pinnedFirst(list, pins);
  const openIds = together ? JSON.stringify(rows.filter(isOpen).map((s) => s.id)) : "[]";
  const zone = useMemo(() => {
    const ids = new Set(JSON.parse(openIds) as string[]);
    return ids.size === 0 ? null : (layoutMap(all.filter((s) => ids.has(s.id)), all, showEnded, NO_LABELS).zones[0] ?? null);
  }, [openIds, all, showEnded]);
  const zoned = new Map((zone?.sessions ?? []).map((ms) => [ms.session.id, ms] as const));
  const placed = useBlockPlaces(host, zone !== null && zone.changes.length > 0);
  return (
    <div className="map-across" id={bodyId} hidden={hidden} ref={host}>
      <ul className="lr-rows">
        {rows.map((s, slot) => (
          <Row
            key={s.id}
            s={s}
            all={all}
            now={now}
            open={isOpen(s)}
            onOpen={() => onOpen(s)}
            showEnded={showEnded.has(s.id)}
            onShowEnded={onShowEnded}
            pinned={pins.some((p) => p.id === s.id)}
            onPin={() => onPin(s.id, slot)}
            zoned={zoned.get(s.id) ?? null}
            hot={together ? hot : undefined}
          />
        ))}
      </ul>
      {zone && placed ? <ZoneRings zone={zone} placed={placed} hot={hot} /> : null}
    </div>
  );
}

/** A header that sorts its column: pressed while its sort is in force. */
function SortHead({ label, by, prefs, right }: { label: string; by: SortKey; prefs: FleetPrefsApi; right?: boolean }) {
  return (
    <button type="button" className={right ? "lr-sort is-right" : "lr-sort"} aria-pressed={prefs.prefs.sort === by} onClick={() => prefs.set({ sort: by })}>
      {label}
    </button>
  );
}

interface ListProps {
  shape: FleetShape;
  /** Every live session, so a file shared with another session names its loop. */
  all: readonly SessionView[];
  now: number;
  prefs: FleetPrefsApi;
  pins: Pin[];
  onPin: (id: string, slot: number) => void;
  spendOf: (machineId: string) => number | null;
}

export function FleetList({ shape, all, now, prefs, pins, onPin, spendOf }: ListProps) {
  const expandAll = prefs.prefs.expandAll;
  const together = expandAll && prefs.prefs.groupBy === "machine";
  // Each row's chevron as the owner left it, until Expand all changes; a row no one chose for follows Expand all.
  const [folds, setFolds] = useState<{ under: boolean; open: Readonly<Record<string, boolean>> }>({ under: expandAll, open: {} });
  const chosen = folds.under === expandAll ? folds.open : {};
  const isOpen = (s: SessionView) => chosen[s.id] ?? expandAll;
  const onOpen = (s: SessionView) => setFolds({ under: expandAll, open: { ...chosen, [s.id]: !isOpen(s) } });
  const [showEnded, setShowEnded] = useState<ReadonlySet<string>>(new Set());
  const flipEnded = (id: string) =>
    setShowEnded((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="lr-list">
      <div className="lr-head">
        <span />
        <span />
        <SortHead label="Session" by="name" prefs={prefs} />
        <SortHead label="Model" by="model" prefs={prefs} />
        <SortHead label="Context" by="context" prefs={prefs} right />
        <SortHead label="Est. cost" by="spend" prefs={prefs} right />
        <SortHead label="Time" by="newest" prefs={prefs} right />
        <span />
      </div>
      <Groups shape={shape} prefs={prefs} spendOf={spendOf} idPrefix="lr">
        {(list, bodyId, hidden) => (
          <Body
            list={list}
            bodyId={bodyId}
            hidden={hidden}
            together={together}
            all={all}
            now={now}
            pins={pins}
            onPin={onPin}
            isOpen={isOpen}
            onOpen={onOpen}
            showEnded={showEnded}
            onShowEnded={flipEnded}
          />
        )}
      </Groups>
    </div>
  );
}
