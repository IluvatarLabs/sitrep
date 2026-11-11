// A session's auto-compacts, opened from the Context fact's badge: each loop that was auto-compacted (most first), and every
// one the server kept, newest first, with the loop it hit and the tokens before and after.
import { plural } from "../format";
import { familyName } from "../logic";
import type { AgentView, SessionView } from "../types";
import { BlowMark } from "../views/session/BlowMark";
import { Dots } from "../ui/Dots";
import { clock } from "../views/session/bits";
import "../views/session/session.css";
import { blowText } from "../views/session/trace";

/** One agent that overflowed: a link to it, its model, and how often. */
function AgentHit({ a, onAgent }: { a: AgentView; onAgent: (id: string) => void }) {
  return (
    <li>
      <Dots
        items={[
          <button key="a" type="button" className="sv-link" onClick={() => onAgent(a.id)}>
            {a.description}
          </button>,
          <span key="m" className="sv-muted">
            {familyName(a.modelFamily, a.model)}
          </span>,
          <b key="n" className="sv-num">{`${a.blowouts}×`}</b>,
        ]}
      />
    </li>
  );
}

/** Every auto-compact the server kept, newest first: when, which loop (an agent opens its detail), and what happened. */
function BlowoutLog({ s, onAgent }: { s: SessionView; onAgent: (id: string) => void }) {
  const b = s.blowouts;
  if (!b) return null;
  const kept = [...b.log].sort((x, y) => y.t - x.t);
  const loop = (id: string | null) => {
    if (id === null) return <span>Main loop</span>;
    const a = s.agents.find((x) => x.id === id);
    if (!a) return <span className="sv-muted">an agent no longer listed</span>;
    return (
      <button type="button" className="sv-link" onClick={() => onAgent(a.id)}>
        {a.description}
      </button>
    );
  };
  return (
    <>
      {kept.length ? (
        <ol className="sv-blowlog" aria-label="Each auto-compact, newest first">
          {kept.map((e, i) => (
            <li key={`${e.t}-${i}`}>
              <time className="sv-num">{clock(e.t)}</time>
              <span className="sv-blowloop">{loop(e.agentId)}</span>
              <span>{blowText(e)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {b.total > kept.length ? <p className="sv-muted">{`${b.total - kept.length} more, before the server kept details`}</p> : null}
    </>
  );
}

/** A session's auto-compacts: how many, each loop hit, and the log. `id` names it for the badge that opens it. */
export function BlowoutCallout({ id, s, onAgent }: { id: string; s: SessionView; onAgent: (agentId: string) => void }) {
  const b = s.blowouts;
  if (!b?.total) return null;
  const agentsHit = s.agents.filter((a) => (a.blowouts ?? 0) > 0).sort((x, y) => (y.blowouts ?? 0) - (x.blowouts ?? 0));
  const mainHit =
    b.orchestrator > 0 ? (
      <li>
        <Dots items={["Main loop", <b key="n" className="sv-num">{`${b.orchestrator}×`}</b>]} />
      </li>
    ) : null;
  return (
    <div className="bx" id={id} role="note">
      <p className="bx-head">
        <BlowMark />
        <b>{`Auto-compacted ${plural(b.total, "time")}`}</b>
      </p>
      <ul className="bx-hits">
        {mainHit}
        {agentsHit.map((a) => (
          <AgentHit key={a.id} a={a} onAgent={onAgent} />
        ))}
      </ul>
      <BlowoutLog s={s} onAgent={onAgent} />
    </div>
  );
}
