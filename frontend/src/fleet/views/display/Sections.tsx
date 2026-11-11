// The wall's Sections layout (for bigger screens), the default. At the top, Needs you: with no asks its heading line alone, from
// the first ask tiles, three to a row, two rows held while any ask remains (past six, the sixth is "+N more"), each with its wait
// clock, who asks, what and the machine; beside it the est. spend and the plan windows "used". Under them Problems, Working and
// Idle, each a section when it has rows, one line per session on one shared grid (mark, name, machine, what it is doing, context,
// est. cost), idle rows a step smaller. A foot with each machine's state on one line that ends in "…" where they do not fit, then
// the stream and the time. The sections' region keeps its height: what does not fit ends in "+N more", idle rows cut first, then
// working, then problems.
import type { ReactNode } from "react";
import { hashFor } from "../../../route";
import { fmtAge } from "../../format";
import { STATE_WORD, stateOf } from "../../states";
import type { SessionView } from "../../types";
import { Dots } from "../../ui/Dots";
import { MidCut } from "../../ui/MidCut";
import { HarnessName } from "../../components/Chips";
import { providerInfo } from "../../provider";
import { Station } from "../../ui/Station";
import { byName, STATE as MACHINE_STATE } from "../machines/MachinesView";
import { ListHead } from "../now/controls";
import { doingLine } from "../now/fleet";
import { WaitClock } from "../now/NeedsYou";
import { ProblemMark } from "../now/Problems";
import { agentNameOf, problemWords, queuedWord, type QueueItem } from "../now/queue";
import { Clock, FleetFigures, fit, GIVES_WAY, machineOf, More, moreWords, problemFact, Ruler, SessionFigures, Stream, useRooms, type Wall } from "./parts";

/** The row heights this layout fits by (display.css --wv-h-*). */
const SIZES = ["shead", "main", "minor", "more"] as const;
/** Tiles the top holds: two rows of three. */
const TILES = 6;

function Tile({ item, wall }: { item: QueueItem; wall: Wall }) {
  const { s } = item;
  const { Logo } = providerInfo(s.provider);
  return (
    <li>
      <a className="wv-item wv-tile" data-edge="needs-you" href={hashFor("session", s.id)} onClick={wall.onLeave}>
        <span className="wv-tile-1">
          <Station kind="needs-you" label />
          <span className="wv-name">
            <MidCut text={s.name} />
            <Logo />
            <HarnessName provider={s.provider} spoken />
          </span>
          <span className="wv-wait">
            <WaitClock since={item.since} now={wall.now} />
          </span>
        </span>
        {/* What is asked, then which of the session's agents asks (queue.ts agentNameOf), its words, and Queued. */}
        <Dots className="is-oneline wv-tile-2" items={[item.kind ? <b key="k">{item.kind}</b> : null, agentNameOf(s, item.ask?.agentId), item.text, queuedWord(item)]} />
        <span className="wv-tile-3">{machineOf(wall, s)}</span>
      </a>
    </li>
  );
}

/**
 * One line on the shared grid: a session, its name cut in the middle (ui/MidCut); or a problem in its loop's words, its name
 * ending in "…" as the desk's Problems row ends it ("session › agent" is prose at its end), its fact in the state's colour.
 */
function Line(props: { wall: Wall; s: SessionView; href: string; mark: ReactNode; name: ReactNode; doing: ReactNode; tone?: string | null; state?: string; minor: boolean }) {
  const { wall, s } = props;
  const { Logo } = providerInfo(s.provider);
  return (
    <li>
      <a className="wv-item wv-c-row" data-minor={props.minor || undefined} data-state={props.state} data-tone={props.tone ?? undefined} href={props.href} onClick={wall.onLeave}>
        {props.mark}
        <span className="wv-name">
          {props.name}
          <Logo />
          <HarnessName provider={s.provider} spoken />
        </span>
        <span className="wv-mach">{machineOf(wall, s)}</span>
        <span className="wv-doing">{props.doing}</span>
        <SessionFigures s={s} />
      </a>
    </li>
  );
}

/** Each machine's state, by name, on one line beside the stream and the time, ending in "…" where they do not fit (display.css). */
function Machines({ wall }: { wall: Wall }) {
  return (
    <span className="wv-machines wv-data">
      {[...wall.fleet.machines].sort(byName).map((m) => {
        const { word, mark } = MACHINE_STATE[m.state];
        return (
          <span key={m.id} className="wv-machine" data-state={m.state}>
            <Station kind={mark} />
            <b>{wall.labels.get(m.id) ?? m.name}</b>
            {m.state === "silent" ? `${word} ${fmtAge((wall.now - m.lastReportAt) / 1000)}` : word}
          </span>
        );
      })}
    </span>
  );
}

export function Sections({ wall }: { wall: Wall }) {
  const { fleet, now, queue, problems, groups } = wall;
  const [ref, rooms] = useRooms<HTMLDivElement>();
  const room = (k: string) => rooms?.room(k) ?? Infinity;
  const size = (k: string) => rooms?.size(k) ?? 0;
  const lists = [
    { n: problems.length, minor: false, rank: GIVES_WAY.problems },
    ...groups.map((g) => ({ n: g.sessions.length, minor: g.state !== "working", rank: GIVES_WAY[g.state] })),
  ];
  const shown = fit(
    lists.map((l) => ({ head: size("shead"), row: size(l.minor ? "minor" : "main"), n: l.n, rank: l.rank })),
    room("sections"),
    size("more"),
  );
  // The figures' labels head the first section.
  const first = lists.findIndex((l) => l.n > 0);
  const head = (i: number, id: string, mark: ReactNode, word: string, n: number) => (
    <div className="wv-shead">
      <div className="wv-head">
        {mark}
        <ListHead id={id} title={word} count={n} />
      </div>
      {i === first ? (
        <>
          <span className="wv-lbl">Context</span>
          <span className="wv-lbl">Est. cost</span>
        </>
      ) : null}
    </div>
  );
  const tiles = queue.length > TILES ? queue.slice(0, TILES - 1) : queue;
  return (
    <div ref={ref} className="wv-c">
      <Ruler sizes={SIZES} />
      <div className="wv-c-top">
        <div className="wv-head wv-data">
          <Station kind="needs-you" />
          <ListHead id="wv-needs-h" title="Needs you" count={wall.needs} />
        </div>
        <FleetFigures fleet={fleet} now={now} />
      </div>
      {/* With no asks, Needs you is its heading line and the sections take the room; from the first ask the two tile rows are
          held while any remains: the one shift is the moment something needs you. */}
      {queue.length > 0 ? (
        <ol className="wv-tiles wv-data" aria-labelledby="wv-needs-h">
          {tiles.map((item) => (
            <Tile key={item.key} item={item} wall={wall} />
          ))}
          {queue.length > tiles.length ? <li className="wv-tile-more">{moreWords(queue.length - tiles.length)}</li> : null}
        </ol>
      ) : null}
      <div className="wv-c-sections wv-data" data-room="sections">
        {problems.length > 0 ? (
          <section aria-labelledby="wv-problems-h">
            {head(0, "wv-problems-h", wall.worst === null ? null : <Station kind={wall.worst} />, "Problems", problems.length)}
            <ol className="wv-list">
              {problems.slice(0, shown[0]).map((p) => {
                const w = problemWords(p, now, fleet.sessions);
                return <Line key={p.key} wall={wall} s={p.s} href={w.href} mark={<ProblemMark state={w.state} />} name={<Dots className="is-oneline" items={[w.name]} />} doing={problemFact(w)} tone={w.state} minor={false} />;
              })}
              <More n={problems.length - shown[0]} />
            </ol>
          </section>
        ) : null}
        {groups.map((g, i) =>
          g.sessions.length === 0 ? null : (
            <section key={g.state} aria-labelledby={`wv-${g.state}-h`}>
              {head(i + 1, `wv-${g.state}-h`, <Station kind={g.state} />, STATE_WORD[g.state], g.sessions.length)}
              <ol className="wv-list">
                {g.sessions.slice(0, shown[i + 1]).map((s) => (
                  <Line key={s.id} wall={wall} s={s} href={hashFor("session", s.id)} mark={<Station kind={stateOf(s)} label />} name={<MidCut text={s.name} />} doing={doingLine(s, now)} state={stateOf(s)} minor={lists[i + 1].minor} />
                ))}
                <More n={g.sessions.length - shown[i + 1]} />
              </ol>
            </section>
          ),
        )}
      </div>
      <footer className="wv-c-foot">
        <Machines wall={wall} />
        <span className="wv-end">
          <Stream phase={fleet.phase} />
          <Clock now={now} />
        </span>
      </footer>
    </div>
  );
}
