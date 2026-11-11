// Answering an ask, shared by the answer panel and the quick answers in a row (ui/AnswerInline): reading the ask, sending to
// it, and what became of the answer, in the same words in both places. Whichever answers first, the terminal or the
// dashboard, wins; a receipt says what actually happened, from what the server reports about the ask. Also how fresh the
// panel's activity feed is (FeedFreshness), which only reads the feed.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ICONS, Q } from "../components/RespondForms";
import { fmtSpan } from "../format";
import { ASK_WORD, clockOf, deliverySummary } from "../respond";
import { RespondError } from "../respondApi";
import { APP_NAME, type AskDetail, type AskSummary, type SessionView } from "../types";
import { dotsText } from "../ui/Dots";
import type { FeedState } from "../useActivityFeed";
import type { RespondContext } from "../useRespond";

/** What the answer panel shows: the form, or one of the ways an answer can end up. `hidden` shows no panel. */
export type Frame = "form" | "sending" | "undelivered" | "terminal" | "other" | "closed" | "hidden";

/** Two reporter heartbeats (5 s each): a session unheard from for longer has stopped checking in. */
const SILENT_MS = 10_000;

/** When the session last checked in, as far as the page knows: the newer of the ask's own read and the session as shown. */
const lastCheckIn = (detail: AskDetail, s: Pick<SessionView, "lastSeenAt">): number => Math.max(detail.lastSeenAt, s.lastSeenAt);

/**
 * The frame for an ask, from the server's view of it. An answer the reporter has not been handed while the session has not
 * checked in for longer than two heartbeats is waiting to be delivered ("undelivered"), not on its way. `now` is the server's
 * clock (FleetState.serverTime), as `lastSeenAt` is, as Machines reads a last report.
 */
export function frameOf(detail: AskDetail, s: Pick<SessionView, "lastSeenAt">, now: number): Frame {
  const { delivery } = detail;
  const byOther = !!delivery && !delivery.mine;
  if (detail.state === "closed") {
    const outcome = detail.closed?.outcome;
    if (outcome === "terminal") return "terminal";
    if (outcome !== "dashboard") return "closed";
    // Closed by an answer from here: another browser's is worth saying; one's own needs no panel any more.
    return byOther ? "other" : "hidden";
  }
  if (byOther) return "other";
  if (detail.state === "pending") return delivery && !delivery.handedOver && now - lastCheckIn(detail, s) > SILENT_MS ? "undelivered" : "sending";
  return detail.state === "not-taken" ? "sending" : "form";
}

/** A refusal in the console's words rather than the route's error code; 409 and 410 have frames of their own. */
const REFUSED: Readonly<Record<number, string>> = {
  422: "This session doesn't take that from the dashboard now. Answer it in its terminal.",
  429: "20 messages are already waiting for this session. Send more once it has caught up.",
  403: "The server won't take this: you are signed out, or answering or the activity feed is off.",
};
const refusedLine = (err: RespondError): string => (err.status === 400 ? `That couldn't be sent: ${err.message}.` : (REFUSED[err.status] ?? "That couldn't be sent. Try again."));

/** The whole ask, for the signed-in owner, read again whenever its state changes; `reload` reads it again at once. */
export function useAskDetail(ctx: RespondContext | null, sessionId: string, ask: AskSummary | null, allowed: boolean) {
  const [read, setRead] = useState<AskDetail | null>(null);
  const askId = ask?.id ?? null;
  const askState = ask?.state ?? null;
  const readAgain = useCallback(async () => {
    if (ctx === null || askId === null || !allowed) return setRead(null);
    await ctx.api.ask(sessionId, askId).then(setRead, (err: unknown) => {
      const signedOut = err instanceof RespondError && err.status === 403;
      if (signedOut) void ctx.refresh();
    });
    // askState is listed so that a change of the ask's state reads it again.
  }, [ctx, sessionId, askId, askState, allowed]);
  useEffect(() => {
    void readAgain();
  }, [readAgain]);
  return { detail: read, reload: readAgain };
}

/**
 * Sending an answer, a message or a discard: `busy` while it goes, a refusal in plain words, and afterwards a fresh look at
 * the ask either way. `run` resolves true when the server took it.
 */
export function useSender(ctx: RespondContext | null, afterwards: () => Promise<void>) {
  const [sending, setSending] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const fail = (error: string) => setSending((was) => ({ ...was, error }));
  const run = async (send: () => Promise<unknown>): Promise<boolean> => {
    setSending({ busy: true, error: null });
    let taken = false;
    try {
      await send();
      taken = true;
    } catch (err) {
      if (!(err instanceof RespondError)) fail(`Could not reach the ${APP_NAME} server. Try again.`);
      else {
        if (err.status === 403) void ctx?.refresh();
        if (err.status !== 409 && err.status !== 410) fail(refusedLine(err));
      }
    }
    setSending((was) => ({ ...was, busy: false }));
    await afterwards();
    return taken;
  };
  return { busy: sending.busy, error: sending.error, run };
}

export const ALSO_IN_TERMINAL = "Also in the terminal";

/** What became of an answer: its tone, one sentence, the detail, the line under it, and a delivery that can still be discarded. */
export interface Receipt {
  tone: "info" | "bad" | "wait";
  title: string;
  detail: ReactNode;
  /** A line set apart inside the detail: an approval the session did not take. */
  note: string | null;
  /** The panel's last line. */
  foot: string;
  /** The words beside the panel's heading. */
  also: string;
  /** The delivery the owner may still discard; null when there is none. */
  discard: string | null;
}

/** The mark beside a receipt's sentence, by its tone. */
export const RECEIPT_ICON: Record<Receipt["tone"], ReactNode> = { wait: ICONS.wait, bad: ICONS.x, info: ICONS.info };

/** The receipt for every frame but the form. Null when the frame lacks what it needs. */
export function receiptOf(frame: Exclude<Frame, "form" | "hidden">, x: { detail: AskDetail; s: SessionView; now: number; app: string; agent: string }): Receipt | null {
  const { detail, s, now } = x;
  const { delivery, closed } = detail;
  const quoted = delivery ? deliverySummary(detail, delivery, s.provider) : "";
  const what = ASK_WORD[detail.ask.kind];
  const plain = { note: null, also: "", discard: null };

  switch (frame) {
    case "sending": {
      const declined = detail.state === "not-taken";
      return {
        tone: "wait",
        title: `Sending to ${s.name}…`,
        detail: (
          <>
            <Q>{quoted}</Q> leaves with the reporter's next check-in and counts as answered once the session confirms it, usually within 2 seconds.
          </>
        ),
        note: declined ? `${x.app} didn't take this approval. Approve it in the terminal.` : null,
        foot: "If the terminal answers first, this one is dropped.",
        also: declined ? ALSO_IN_TERMINAL : "",
        discard: null,
      };
    }
    case "undelivered": {
      if (!delivery) return null;
      const silentFor = now - lastCheckIn(detail, s);
      return {
        tone: "bad",
        title: "Waiting to deliver",
        detail: (
          <>
            {s.name} has not checked in for {Math.max(0, Math.round(silentFor / 1000))} seconds, so your answer, <Q>{quoted}</Q>, is waiting here. It is sent when the session reports again, unless the terminal answered by then.
          </>
        ),
        note: null,
        foot: "Busy, asleep or closed? Its terminal can still answer.",
        also: `Last check-in ${fmtSpan(silentFor / 1000)} ago`,
        discard: delivery.id,
      };
    }
    case "terminal": {
      if (!closed) return null;
      let there: ReactNode;
      if (detail.ask.kind === "plan" && closed.planApproved) there = "Plan approved.";
      else {
        const words = detail.ask.kind === "plan" ? "No, keep planning" : detail.ask.kind !== "permission" ? (closed.answer ?? "") : closed.answer === "denied" ? "Denied" : "Allowed";
        there = (
          <>
            Answer: <Q>{words}</Q>.
          </>
        );
      }
      return { ...plain, tone: "info", title: `Answered in the terminal at ${clockOf(closed.at)}.`, detail: <>{there} Nothing from here was sent, and your draft was dropped.</>, foot: "The session continued." };
    }
    case "other": {
      if (!delivery) return null;
      return {
        ...plain,
        tone: "info",
        title: `Answered from another browser at ${clockOf(delivery.at)}.`,
        detail: (
          <>
            That answer was taken first: <Q>{quoted}</Q>. Yours was not sent.
          </>
        ),
        foot: `Only the first answer to a ${what} is accepted.`,
      };
    }
    case "closed":
      if (!closed) return null;
      return {
        ...plain,
        tone: "bad",
        title: `This ${what} was closed in the session before you answered.`,
        detail: `It was closed without an answer at ${clockOf(closed.at)}, so ${x.agent} stopped waiting. Nothing was sent. Send a message below to pick it up again.`,
        foot: "The session now waits for a new message.",
      };
  }
}

// ---- the feed's freshness ----------------------------------------------------------------------------------------------

/**
 * How fresh the panel's activity feed is: "Nothing yet" while nothing has arrived since this viewer started watching, and when
 * the server last answered ("Updated 4s ago"); "No more updates" once the session is not live. Empty before the first answer,
 * and while the server's feed is off (the panel says so itself). `active`: the session still runs.
 */
export function feedFreshness(feed: FeedState, active: boolean, now: number): string {
  if (!feed.live || !active) return "No more updates";
  if (feed.fetchedAt === null || feed.serverOff) return "";
  return dotsText([feed.seen === 0 ? "Nothing yet" : null, `Updated ${fmtSpan(Math.max(0, now - feed.fetchedAt) / 1000)} ago`]);
}

/** The feed's freshness (feedFreshness), muted, at the end of the line that heads the feed; nothing when there is none. */
export function FeedFreshness({ feed, active, now }: { feed: FeedState; active: boolean; now: number }) {
  const text = feedFreshness(feed, active, now);
  return text ? <span className="answer-feed-when">{text}</span> : null;
}
