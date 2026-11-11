// Problems, one of Attention's two lists, beside Needs you (NowView); its heading counts its lines: failed and stuck sessions
// with their fact and their auto-compacts' neutral "⟲N" when they have any, stuck agents as "session › agent" with how long they
// have been quiet (the link opens the session on that agent), and files two loops edited within 5 minutes, marked by the Graph's
// collision diamond, not a state's mark. Auto-compacts alone never make a problem (queue.ts). One line each, the machine last.
// The lines scroll inside a box as tall as Needs you's, an eighth of the window, at every count (empty at 0, the heading's 0
// saying so), so they never move the Sessions below. The words are queue.ts problemWords, which the wall view says too.
import type { ReactNode } from "react";
import { BlowBadge } from "../../components/Chips";
import type { State } from "../../states";
import type { SessionView } from "../../types";
import { Dots } from "../../ui/Dots";
import { Station } from "../../ui/Station";
import { CLASH_D } from "../graph/model";
import { ListHead } from "./controls";
import { problemWords, type Problem } from "./queue";

/** A problem's mark: its state's, or for a shared file (no state) the Graph's collision diamond. */
export function ProblemMark({ state }: { state: State | null }) {
  if (state !== null) return <Station kind={state} label />;
  return (
    <svg className="pb-clash" viewBox="-8 -8 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={CLASH_D} />
    </svg>
  );
}

/** A shared file's fact: "<file> also edited by <who>", the other loop a link where it is live. */
export function AlsoEdited({ file, by }: { file: string; by: ReactNode }) {
  return (
    <>
      <code className="pb-file">{file}</code> also edited by {by}
    </>
  );
}

function Row({ p, now, machine, sessions }: { p: Problem; now: number; machine: string; sessions: Readonly<Record<string, SessionView>> }) {
  const w = problemWords(p, now, sessions);
  const name = (
    <a key="s" className="now-name" href={w.href}>
      {w.name}
    </a>
  );
  let fact: ReactNode = w.fact;
  if (w.file) {
    const { file } = w;
    const by = file.byHref ? (
      <a className="now-name" href={file.byHref}>
        {file.by}
      </a>
    ) : (
      file.by
    );
    fact = (
      <span key="f">
        <AlsoEdited file={file.name} by={by} />
      </span>
    );
  }
  return (
    <li className="pb-row" data-state={w.state ?? undefined} title={w.file?.path}>
      <span className="pb-mark">
        <ProblemMark state={w.state} />
      </span>
      <Dots className="is-oneline" items={[name, fact, p.type === "session" && p.s.blowouts?.total ? <BlowBadge key="b" n={p.s.blowouts.total} /> : null, machine]} />
    </li>
  );
}

const BODY_ID = "now-problems-list";

export function Problems(props: { items: Problem[]; now: number; labels: ReadonlyMap<string, string>; sessions: Readonly<Record<string, SessionView>> }) {
  const { items, now, labels, sessions } = props;
  return (
    <section className="pb" aria-labelledby="now-problems-h">
      <ListHead id="now-problems-h" title="Problems" count={items.length} />
      <ul className="pb-list" id={BODY_ID}>
        {items.map((p) => (
          <Row key={p.key} p={p} now={now} machine={labels.get(p.s.machine.id) ?? p.s.machine.name} sessions={sessions} />
        ))}
      </ul>
    </section>
  );
}
