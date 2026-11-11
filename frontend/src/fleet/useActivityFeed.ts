// Fetching a loop's live activity feed. The server keeps a loop's entries only while a viewer holds a lease on it, and every
// fetch renews the lease, so this fetches only while the panel (or its modal) is open, the tab is visible and the session's
// feed is on, at the interval this browser keeps (Settings changes it). It shows only what arrived after its first answer:
// entries from before the viewer started watching are never backfilled. While the server's activityFeed setting is off a
// reply says `enabled: false`; the hook drops what it showed and keeps asking at the same interval, so the feed returns by
// itself.
import { useEffect, useReducer } from "react";
import { VIEW_GATED } from "../../../server/src/fleet/protocol";
import { readJson, writeJson } from "./storage";
import type { ActivityEntryView, ActivityReply } from "./types";
import { usePageVisible } from "./usePageVisible";
import { getJson } from "./views/settings/api";

/** The feed intervals Settings offers, in seconds; the first is the default. */
export const EVERY_CHOICES: readonly number[] = [5, 10, 20, 30, 60];
const STORE_KEY = "activityEvery";
/** Entries shown, as many as the server keeps. */
export const FEED_KEPT = 20;
/** The window event something just sent to a session raises, with the session's id. */
const SENT_EVENT = "sitrep:sent";

/** Something was just sent to this session from here: its feeds open anywhere (the answer panel's, the inspector's) ask again now. */
export const askFeedsNow = (sessionId: string): void => void window.dispatchEvent(new CustomEvent(SENT_EVENT, { detail: sessionId }));

export function readEvery(): number {
  const v = readJson<unknown>(STORE_KEY, EVERY_CHOICES[0]);
  return EVERY_CHOICES.find((n) => n === v) ?? EVERY_CHOICES[0];
}

export function writeEvery(seconds: number): void {
  writeJson(STORE_KEY, seconds);
}

/**
 * One read of a loop's feed; `every` tells the server how long this viewer's lease should last. The console's open read
 * (settings api getJson), so a refusal by the view gate is told to the console, which shows the sign-in screen.
 */
const fetchActivity = (sessionId: string, loop: string, every: number): Promise<ActivityReply> =>
  getJson<ActivityReply>(`/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(loop)}/activity?every=${every}`);

/** A feed panel before its first reply; its shape is FeedState's. */
const EMPTY = {
  /** The newest FEED_KEPT entries that came in after this viewer began watching, oldest first. */
  entries: [] as ActivityEntryView[],
  /** Every entry that came in after this viewer began watching, the ones no longer kept included ("Last 20 of 31"). */
  seen: 0,
  /** This browser's time at the latest reply, which "Updated 5s ago" counts from; null until a reply comes. */
  fetchedAt: null as number | null,
  /** The latest read went wrong ("Server unreachable, retrying"); the next read is still on its way. */
  failed: false,
  /** Turns false once the server says the session has left the live set, after which nothing new can arrive. */
  live: true,
  /** The latest reply found the server's activityFeed setting off, so the panel says so in place of the list. */
  serverOff: false,
};

/** What a feed panel draws. */
export type FeedState = typeof EMPTY;

export interface FeedOptions {
  sessionId: string;
  loop: string;
  /** Seconds between fetches, the viewer's choice. */
  every: number;
  /** The server's setting as the console's state says; a change asks again at once. */
  serverOn: boolean;
  /** The session can send a feed: its reporter's option is on, or not known to be off. */
  enabled: boolean;
  /** The loop still works. A finished one is fetched once more, for its last entries, then left alone. */
  active: boolean;
}

/**
 * The entries already shown, brought up to date with the server's window. Two kinds change after they arrive: an answer,
 * message or command sent from the dashboard (its note changes, or it goes when discarded or never taken) and a tool call
 * (its end lands on the seq it already has). Older than the window, an entry is kept as it was.
 */
function followServer(shown: readonly ActivityEntryView[], held: readonly ActivityEntryView[]): ActivityEntryView[] {
  const current = new Map(held.map((e) => [e.seq, e]));
  const windowStart = held[0]?.seq ?? Infinity;
  const out: ActivityEntryView[] = [];
  for (const e of shown) {
    const latest = current.get(e.seq);
    if (e.kind === "tool") out.push(latest ?? e);
    else if (e.kind !== "dashboard") out.push(e);
    else if (latest) out.push(latest);
    else if (e.seq < windowStart) out.push(e);
  }
  return out;
}

/** Where the viewer has got to in the server's lease on the loop: which lease it reads under, and the highest seq it has taken. */
type Place = { lease: number | null; top: number };

/** A feed with its viewer's place, which is null until the first reply for the loop open now. */
interface Watched {
  feed: FeedState;
  place: Place | null;
}

const UNWATCHED: Watched = { feed: EMPTY, place: null };

/** What can happen to a feed: another loop opens in its panel, a read is answered (`at`: this browser's time), or a read fails. */
type FeedEvent = { kind: "reopen" } | { kind: "reply"; reply: ActivityReply; at: number } | { kind: "failed" };

/**
 * The feed after one event (the useReducer reducer). A reply under the lease the viewer already reads adds what came past its
 * place. A reply under any other lease, the first one or one the server began again, only sets the place: what that lease holds
 * came in before the viewer watched, and is never backfilled.
 */
function nextFeed(was: Watched, event: FeedEvent): Watched {
  if (event.kind === "reopen") return UNWATCHED;
  if (event.kind === "failed") return { ...was, feed: { ...was.feed, failed: true } };
  const { reply, at } = event;
  if (!reply.enabled) return { feed: { ...EMPTY, fetchedAt: at, live: reply.live, serverOff: true }, place: null };
  const answered = { fetchedAt: at, failed: false, live: reply.live, serverOff: false };
  const top = Math.max(0, ...reply.entries.map((e) => e.seq));
  const place = was.place;
  if (place === null || place.lease !== reply.since) return { feed: { ...was.feed, ...answered }, place: { lease: reply.since, top } };
  const fresh = reply.entries.filter((e) => e.seq > place.top);
  const entries = [...followServer(was.feed.entries, reply.entries), ...fresh].slice(-FEED_KEPT);
  return { feed: { ...answered, entries, seen: was.feed.seen + fresh.length }, place: { lease: reply.since, top: Math.max(place.top, top) } };
}

export function useActivityFeed({ sessionId, loop, every, serverOn, enabled, active }: FeedOptions): FeedState {
  const visible = usePageVisible();
  const [{ feed }, dispatch] = useReducer(nextFeed, UNWATCHED);

  // Another loop in the panel starts from nothing, as if the viewer had only now begun watching.
  useEffect(() => dispatch({ kind: "reopen" }), [sessionId, loop]);

  useEffect(() => {
    if (!enabled || !visible) return;
    let stopped = false;
    const ask = () =>
      fetchActivity(sessionId, loop, every)
        .then((reply) => {
          if (!stopped) dispatch({ kind: "reply", reply, at: Date.now() });
        })
        .catch((err: unknown) => {
          // A refusal by the view gate is not a failed read: the console shows the sign-in screen in place of the feed.
          if (!stopped && !(err instanceof Error && err.message === VIEW_GATED)) dispatch({ kind: "failed" });
        });

    void ask();
    // Something just sent to this session shows without waiting for the next read.
    const onSent = (e: Event) => {
      if ((e as CustomEvent<string>).detail === sessionId) void ask();
    };
    window.addEventListener(SENT_EVENT, onSent);
    const timer = active ? setInterval(() => void ask(), every * 1000) : undefined;
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener(SENT_EVENT, onSent);
    };
  }, [sessionId, loop, enabled, visible, active, every, serverOn]);

  return feed;
}
