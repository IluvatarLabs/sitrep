// One session's activity events, the one source for its Timeline marks, the inspector's list of its activity, and a stored
// page's event list: read from the server's event route (GET /api/fleet/events?sessionId=, newest first, a page at a time),
// and, for a live session, joined by every event the stream brings while it is open. The fleet keeps only its newest events
// in memory, so the stored ones are read once per session.
import { useEffect, useMemo, useState } from "react";
import type { ActivityView } from "../../types";
import { getJson } from "../settings/api";

/** Events per request (the route's most) and requests at most: the newest 1,000 events are plenty for one session's trace. */
const PAGE = 200;
const PAGES = 5;

export interface SessionEvents {
  /** Newest first, each id once. */
  events: ActivityView[];
  loading: boolean;
  /** The stored events could not be read; the live ones still show. */
  failed: boolean;
  /** More stored events exist than were read. */
  cut: boolean;
}

/** One page of the session's stored events, newest first, before `before` when given; a refusal throws (getJson). */
async function fetchPage(sessionId: string, before: number | null): Promise<ActivityView[]> {
  const params = new URLSearchParams({ sessionId, limit: String(PAGE) });
  if (before !== null) params.set("before", String(before));
  return (await getJson<{ events: ActivityView[] }>(`/events?${params.toString()}`)).events;
}

/** Each list's state belongs to the session it was read for, so a new session never shows the last one's events. */
interface Stored {
  for: string | null;
  list: ActivityView[];
  loading: boolean;
  failed: boolean;
  cut: boolean;
}
interface Seen {
  for: string | null;
  byId: Map<string, ActivityView>;
}

const NO_EVENTS: ActivityView[] = [];
const NONE_SEEN = new Map<string, ActivityView>();
const NOTHING: SessionEvents = { events: NO_EVENTS, loading: false, failed: false, cut: false };

/**
 * `sessionId`: the session to read, or null to read nothing (no session open). `live`: the fleet's in-memory events (newest
 * first), or null for a stored session that gets no more.
 */
export function useSessionEvents(sessionId: string | null, live: readonly ActivityView[] | null): SessionEvents {
  const [stored, setStored] = useState<Stored>({ for: null, list: NO_EVENTS, loading: false, failed: false, cut: false });
  // Every live event of this session seen since it was opened, kept after the fleet's own list lets it go.
  const [seen, setSeen] = useState<Seen>(() => ({ for: null, byId: NONE_SEEN }));

  useEffect(() => {
    if (sessionId === null) return undefined;
    let current = true;
    setStored({ for: sessionId, list: NO_EVENTS, loading: true, failed: false, cut: false });
    void (async () => {
      const list: ActivityView[] = [];
      try {
        let before: number | null = null;
        for (let n = 0; n < PAGES; n++) {
          const page = await fetchPage(sessionId, before);
          list.push(...page);
          if (page.length < PAGE) {
            if (current) setStored({ for: sessionId, list, loading: false, failed: false, cut: false });
            return;
          }
          before = page[page.length - 1]!.t;
        }
        if (current) setStored({ for: sessionId, list, loading: false, failed: false, cut: true });
      } catch {
        if (current) setStored({ for: sessionId, list, loading: false, failed: true, cut: false });
      }
    })();
    return () => {
      current = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (sessionId === null || !live) return;
    const mine = live.filter((e) => e.sessionId === sessionId);
    setSeen((was) => {
      const same = was.for === sessionId;
      if (same && mine.every((e) => was.byId.has(e.id))) return was;
      const next = new Map(same ? was.byId : NONE_SEEN);
      for (const e of mine) next.set(e.id, e);
      return { for: sessionId, byId: next };
    });
  }, [live, sessionId]);

  const storedList = stored.for === sessionId ? stored.list : NO_EVENTS;
  const seenById = seen.for === sessionId ? seen.byId : NONE_SEEN;
  const events = useMemo(() => {
    const byId = new Map<string, ActivityView>();
    for (const e of storedList) byId.set(e.id, e);
    for (const e of seenById.values()) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : -1));
  }, [storedList, seenById]);

  if (sessionId === null) return NOTHING;
  // Until the read for this session starts, it is loading.
  if (stored.for !== sessionId) return { events, loading: true, failed: false, cut: false };
  return { events, loading: stored.loading, failed: stored.failed, cut: stored.cut };
}
