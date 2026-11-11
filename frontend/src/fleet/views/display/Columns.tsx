// The wall's Columns layout (for a tablet or another small screen). Down the left, Needs you, two lines per ask with its wait
// clock at the right, then Problems in a box three lines high; down the right, the other sessions, two lines each, working, then
// idle, each by name, with context and est. cost; a strip at the foot with the est. spend, the plan windows "used", the time and
// the stream. Every region keeps its height whatever the data does: a list that does not fit ends in "+N more", idle rows cut
// first, then working.
import { hashFor } from "../../../route";
import { STATE_WORD, stateOf } from "../../states";
import type { SessionView } from "../../types";
import { Dots } from "../../ui/Dots";
import { MidCut } from "../../ui/MidCut";
import { HarnessName } from "../../components/Chips";
import { providerInfo } from "../../provider";
import { Station, stationWord } from "../../ui/Station";
import { ListHead } from "../now/controls";
import { doingLine } from "../now/fleet";
import { WaitClock } from "../now/NeedsYou";
import { ProblemMark } from "../now/Problems";
import { problemWords, queuedWord, type Problem, type QueueItem } from "../now/queue";
import { Clock, FleetFigures, fit, GIVES_WAY, machineOf, More, problemFact, Ruler, SessionFigures, Stream, useRooms, type Wall } from "./parts";

/** The row heights this layout fits by (display.css --wv-h-*). */
const SIZES = ["ask", "prob", "row", "more", "gap"] as const;

function Ask({ item, wall }: { item: QueueItem; wall: Wall }) {
  const { s } = item;
  const { Logo } = providerInfo(s.provider);
  return (
    <li>
      <a className="wv-item wv-b-ask" href={hashFor("session", s.id)} onClick={wall.onLeave}>
        <Station kind="needs-you" label />
        <span className="wv-who">
          {/* The loop that waits, "session › agent" (queue.ts loopName), on one line ending in "…", as Needs you prints it. */}
          <Dots className="is-oneline" items={[item.who]} />
          <Logo />
          <HarnessName provider={s.provider} spoken />
        </span>
        <span className="wv-wait">
          <WaitClock since={item.since} now={wall.now} />
        </span>
        <Dots
          className="is-oneline wv-l2"
          items={[item.kind ? <b key="k">{item.kind}</b> : null, item.text, queuedWord(item), <span key="m" className="wv-m">{machineOf(wall, s)}</span>]}
        />
      </a>
    </li>
  );
}

function ProblemLine({ p, wall }: { p: Problem; wall: Wall }) {
  const w = problemWords(p, wall.now, wall.fleet.sessions);
  return (
    <li>
      <a className="wv-item wv-b-prob" href={w.href} onClick={wall.onLeave}>
        <ProblemMark state={w.state} />
        <Dots
          className="is-oneline"
          items={[
            <b key="n">{w.name}</b>,
            <em key="f" data-tone={w.state ?? undefined}>
              {problemFact(w)}
            </em>,
            <span key="m" className="wv-m">
              {machineOf(wall, p.s)}
            </span>,
          ]}
        />
      </a>
    </li>
  );
}

function Session({ s, wall }: { s: SessionView; wall: Wall }) {
  const { Logo } = providerInfo(s.provider);
  const state = stateOf(s);
  return (
    <li>
      <a className="wv-item wv-b-row" data-state={state} href={hashFor("session", s.id)} onClick={wall.onLeave}>
        <Station kind={state} label />
        <span className="wv-name">
          <MidCut text={s.name} />
          <Logo />
          <HarnessName provider={s.provider} spoken />
        </span>
        <SessionFigures s={s} />
        <Dots className="is-oneline wv-l2" items={[doingLine(s, wall.now), <span key="m" className="wv-m">{machineOf(wall, s)}</span>]} />
      </a>
    </li>
  );
}

export function Columns({ wall }: { wall: Wall }) {
  const { fleet, now, queue, problems, groups } = wall;
  const [ref, rooms] = useRooms<HTMLDivElement>();
  const room = (k: string) => rooms?.room(k) ?? Infinity;
  const size = (k: string) => rooms?.size(k) ?? 0;
  const [asks] = fit([{ head: 0, row: size("ask"), n: queue.length, rank: 0 }], room("needs"), size("more"));
  const [lines] = fit([{ head: 0, row: size("prob"), n: problems.length, rank: 0 }], room("problems"), size("more"));
  // A gap parts each group from the one above it.
  const first = groups.findIndex((g) => g.sessions.length > 0);
  const rows = fit(
    groups.map((g, i) => ({ head: i > first ? size("gap") : 0, row: size("row"), n: g.sessions.length, rank: GIVES_WAY[g.state] })),
    room("rest"),
    size("more"),
  );
  return (
    <div ref={ref} className="wv-b">
      <Ruler sizes={SIZES} />
      <div className="wv-b-left wv-data">
        <section className="wv-b-needs" aria-labelledby="wv-needs-h">
          <div className="wv-head">
            <ListHead id="wv-needs-h" title="Needs you" count={wall.needs} />
          </div>
          <div className="wv-room" data-room="needs">
            <ol className="wv-list">
              {queue.slice(0, asks).map((item) => (
                <Ask key={item.key} item={item} wall={wall} />
              ))}
              <More n={queue.length - asks} />
            </ol>
          </div>
        </section>
        <section className="wv-b-problems" aria-labelledby="wv-problems-h">
          <div className="wv-head">
            <ListHead id="wv-problems-h" title="Problems" count={problems.length} />
          </div>
          <div className="wv-room" data-room="problems">
            <ul className="wv-list">
              {problems.slice(0, lines).map((p) => (
                <ProblemLine key={p.key} p={p} wall={wall} />
              ))}
              <More n={problems.length - lines} />
            </ul>
          </div>
        </section>
      </div>
      <section className="wv-b-right wv-data" aria-label="Sessions">
        <div className="wv-head">
          <div className="wv-counts">
            {groups.map((g) => (
              <ListHead key={g.state} id={`wv-${g.state}-h`} title={STATE_WORD[g.state]} count={g.sessions.length} />
            ))}
          </div>
          <span className="wv-lbl">Context</span>
          <span className="wv-lbl">Est. cost</span>
        </div>
        <div className="wv-room" data-room="rest">
          {groups.map((g, i) =>
            g.sessions.length === 0 ? null : (
              <ol key={g.state} className="wv-list wv-group" aria-labelledby={`wv-${g.state}-h`}>
                {g.sessions.slice(0, rows[i]).map((s) => (
                  <Session key={s.id} s={s} wall={wall} />
                ))}
                <More n={g.sessions.length - rows[i]} of={stationWord(g.state)} />
              </ol>
            ),
          )}
        </div>
      </section>
      <footer className="wv-b-strip">
        <FleetFigures fleet={fleet} now={now} />
        <span className="wv-end">
          <span className="wv-hint">Esc or w exits</span>
          <Clock now={now} />
          <Stream phase={fleet.phase} />
        </span>
      </footer>
    </div>
  );
}
