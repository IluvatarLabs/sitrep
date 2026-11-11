// Needs you, one of Attention's two lists (NowView); its heading counts the sessions that need you, as every
// needs-you count does: one item per open ask, and per session that needs you with none open, in the one order the top bar's
// button and the answer drawer step in (queue.ts). Two lines each: the wait as a clock, who asks, what, the model and the
// machine; then the question or command with its answer controls (ui/AnswerInline), or, when it can't be
// answered from here, the note the answer drawer and the session page show in its place, with why on hover (components/Compose
// OffNote). A session's asks behind its current one read "Queued". An ask that settles keeps a quiet line for a moment; the page
// cannot tell who answered it. The rows scroll inside a box of fixed height, an eighth of the window, the same at every count
// (empty at 0, the heading's 0 saying so), so asks arriving, settling or leaving never move the Sessions below.
import { hashFor } from "../../../route";
import { OffNote } from "../../components/Compose";
import { fmtSpan } from "../../format";
import { providerInfo } from "../../provider";
import { canAnswer, cantReason, respondGate } from "../../respond";
import { openAsk } from "../../states";
import { AnswerInline } from "../../ui/AnswerInline";
import { Dots } from "../../ui/Dots";
import { Station } from "../../ui/Station";
import { Unknown } from "../../ui/Unknown";
import { useRespond } from "../../useRespond";
import { ListHead, Model } from "./controls";
import { queuedWord, type QueueItem } from "./queue";
import type { SettledAsk } from "./useSettled";

/** How long an ask has waited ("6m 12s"), or "—" when its start is not reported; the wall view shows it too. */
export function WaitClock({ since, now }: { since: number | null; now: number }) {
  if (since === null) return <Unknown reason="When this wait began is not reported" />;
  return (
    <>
      <span className="ui-vh">Waiting </span>
      {fmtSpan(Math.max(0, (now - since) / 1000))}
    </>
  );
}

function Row({ item, now, machine }: { item: QueueItem; now: number; machine: string }) {
  const { s } = item;
  const respond = useRespond();
  const here = respond !== null && respondGate(s, respond.me, respond.settingsOn).show;
  const queued = queuedWord(item);
  let act;
  if (queued) act = <span className="nw-note">{queued}</span>;
  else if (here) act = <AnswerInline s={s} />;
  else {
    // As the session page decides it (PageComposer): a switch off first, else what the session can't take.
    const off = respond === null || !respond.settingsOn || !respond.me?.enabled || canAnswer(s, openAsk(s)?.kind ?? null) !== "cant";
    act = <OffNote edge={off ? "off" : "cant"} reason={cantReason(s)} machine={s.machine.name} app={providerInfo(s.provider).app} provider={s.provider} />;
  }
  return (
    <li className="nw-row">
      <div className="nw-l1">
        <Station kind="needs-you" size={14} />
        <span className="nw-clock">
          <WaitClock since={item.since} now={now} />
        </span>
        <Dots
          className="is-oneline"
          items={[
            <a key="who" className="now-name" href={hashFor("session", s.id)}>
              {item.who}
            </a>,
            item.kind,
            <Model key="model" provider={s.provider} m={item.loop} />,
            machine,
          ]}
        />
      </div>
      <div className="nw-l2">
        {item.text ? <p className="nw-text">{item.text}</p> : null}
        {act}
      </div>
    </li>
  );
}

const BODY_ID = "now-needs-list";

export function NeedsYou(props: { items: QueueItem[]; settled: SettledAsk[]; now: number; labels: ReadonlyMap<string, string>; count: number }) {
  const { items, settled, now, labels, count } = props;
  return (
    <section className="nw" aria-labelledby="now-needs-h">
      <ListHead id="now-needs-h" title="Needs you" count={count} />
      <ol className="nw-list" id={BODY_ID}>
        {items.map((item) => (
          <Row key={item.key} item={item} now={now} machine={labels.get(item.s.machine.id) ?? item.s.machine.name} />
        ))}
        {settled.map((x) => (
          <li key={x.key} className="nw-row is-settled">
            <Dots
              className="is-oneline"
              items={[
                "No longer waiting",
                <a key="who" className="now-name" href={hashFor("session", x.sessionId)}>
                  {x.who}
                </a>,
                x.machine,
                now - x.at < 1000 ? "just now" : `${fmtSpan((now - x.at) / 1000)} ago`,
              ]}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
