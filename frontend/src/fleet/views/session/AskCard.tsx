// What this session's open ask needs from its owner, on its page under the head: what kind of ask and which loop asks, how
// long it has waited, and AnswerInline, which shows what is asked with the quick answers, or Answer for the answer panel (it
// gates itself). Shown only while an ask is open; the head's state line already says a wait with no ask.
import { fmtSpan, plural } from "../../format";
import { openAsk } from "../../states";
import type { AskKind, SessionView } from "../../types";
import { AnswerInline } from "../../ui/AnswerInline";
import { dotsText } from "../../ui/Dots";
import { Station } from "../../ui/Station";
import { clock } from "./bits";

const ASK_TITLE: Record<AskKind, string> = { question: "Question", permission: "Permission", plan: "Plan" };

export function AskCard({ s, now }: { s: SessionView; now: number }) {
  const ask = openAsk(s);
  if (ask === null) return null;
  const asker = ask.agentId === null ? s.name : (s.agents.find((a) => a.id === ask.agentId)?.description ?? "an agent no longer listed");
  const queued = s.asks.filter((a) => a.state !== "closed" && a.id !== ask.id).length;
  const facts = dotsText([
    ask.kind === "question" && ask.count > 1 ? plural(ask.count, "question") : null,
    queued > 0 ? `${queued} queued` : null,
    ask.state === "pending" ? "Answer sent, not confirmed yet" : ask.state === "not-taken" ? "Answer not taken: answer again, or in its terminal" : null,
  ]);
  return (
    <section className="sv-ask" aria-labelledby="sv-ask-h">
      <Station kind="needs-you" />
      <div className="sv-ask-main">
        <h2 id="sv-ask-h">{`${ASK_TITLE[ask.kind]} from ${asker}`}</h2>
        {facts ? <p className="sv-muted">{facts}</p> : null}
        <div className="sv-ask-acts">
          <AnswerInline s={s} />
        </div>
      </div>
      <span className="sv-clock" title={`Asked at ${clock(ask.openedAt)}`}>
        {fmtSpan((now - ask.openedAt) / 1000)}
      </span>
    </section>
  );
}
