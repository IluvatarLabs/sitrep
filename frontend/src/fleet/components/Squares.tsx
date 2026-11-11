// A session's agents at a glance (Cards, List): one square per agent in tree order, filled by its state (Chips AgentSquare: a
// circle for a fork, dashed while queued, orange while it runs stuck, red-outlined once it failed, grey once it ended), then, on
// a card, the loops in words with the main loop counted, "3 working · 1 stuck · 78 done · 29 failed". Past the cap the rest are
// counted "+N", and the squares kept are the live ones first, then the failed. A square's tooltip says what its shape and fill
// mean: its kind, model and state. The squares and "+N" are one box (`crew-sq`), the words after it (a card's grid draws them above it, wall.css).
import { buildTree, familyName, sessionCounts } from "../logic";
import type { AgentView, SessionView } from "../types";
import { Dots, dotsText } from "../ui/Dots";
import { stationWord } from "../ui/Station";
import { kindWord } from "../views/map/words";
import { AgentSquare } from "./Chips";

/** Squares drawn at most: about three rows on a card. */
const CAP = 72;

/** Which squares the cap keeps first: running and queued, then failed, then ended. */
const KEEP: Record<AgentView["status"], number> = { running: 0, queued: 0, failed: 1, done: 2, aborted: 2 };

const nameOf = (a: AgentView) => a.description.trim() || a.name?.trim() || a.type;

/** "Sonnet 5.5 high", as the model chip names it; null when no model is reported. */
const modelOf = (a: AgentView): string | null => (a.model === null && a.modelFamily === "other" ? null : `${familyName(a.modelFamily, a.model)}${a.effort ? ` ${a.effort}` : ""}`);

/** An agent's state word: "stuck" while it runs stuck (server-derived), else its status's. */
const wordOf = (a: AgentView): string => stationWord(a.stuck ? "stuck" : a.status);

/** "survey adapters · fork · Sonnet 5.5 high · queued · launched by tests": what one square stands for. */
function squareTitle(a: AgentView, by: AgentView | undefined): string {
  const kind = kindWord(a);
  return dotsText([nameOf(a), kind === nameOf(a) ? null : kind, modelOf(a), wordOf(a), by ? `launched by ${nameOf(by)}` : null]);
}

/** The agents in tree order, as the squares drawn and those counted past the cap. */
function capped(agents: readonly AgentView[], cap: number): { drawn: AgentView[]; rest: AgentView[] } {
  const order = buildTree(agents).map((row) => row.agent);
  if (order.length <= cap) return { drawn: order, rest: [] };
  const kept = new Set(
    order
      .map((a, at) => ({ a, at }))
      .sort((x, y) => KEEP[x.a.status] - KEEP[y.a.status] || x.at - y.at)
      .slice(0, cap)
      .map(({ a }) => a.id),
  );
  return { drawn: order.filter((a) => kept.has(a.id)), rest: order.filter((a) => !kept.has(a.id)) };
}

/** "12 more: 2 working · 10 done", what "+N" stands for. */
function restTitle(rest: readonly AgentView[]): string {
  const tally = new Map<string, number>();
  for (const a of rest) tally.set(wordOf(a), (tally.get(wordOf(a)) ?? 0) + 1);
  return `${rest.length} more: ${dotsText([...tally].map(([word, n]) => `${n} ${word}`))}`;
}

export function Squares({ s, cap = CAP, words = true }: { s: SessionView; cap?: number; words?: boolean }) {
  const n = sessionCounts(s);
  const launcher = new Map(s.agents.map((a) => [a.id, a] as const));
  const { drawn, rest } = capped(s.agents, cap);
  // A stuck agent is running (the server derives it only then), so it is counted stuck and not working.
  const stuck = s.agents.filter((a) => a.stuck).length;
  const tally = [`${n.running - stuck} working`, stuck ? `${stuck} stuck` : null, `${n.done} done`, n.failed ? `${n.failed} failed` : null];
  return (
    <div className="crew">
      <span className="crew-sq">
        {drawn.map((a) => {
          const by = a.parentId !== null && a.parentId !== a.id ? launcher.get(a.parentId) : undefined;
          return <AgentSquare key={a.id} a={a} hidden title={squareTitle(a, by)} />;
        })}
        {rest.length > 0 ? (
          <span className="crew-more" title={restTitle(rest)} aria-hidden="true">
            {`+${rest.length}`}
          </span>
        ) : null}
      </span>
      {words ? (
        <span className="cnt">
          <Dots className="is-oneline" items={tally} />
        </span>
      ) : (
        <span className="ui-vh">{dotsText(tally)}</span>
      )}
    </div>
  );
}
