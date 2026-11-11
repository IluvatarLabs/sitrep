// The sessions this browser pinned in the Fleet.
import { useCallback, useEffect, useRef, useState } from "react";
import { dropEnded, pin, readPins, unpin, type Pin } from "./pins";
import { readJson, writeJson } from "./storage";
import type { RemovedReason, SessionView } from "./types";

const STORE_KEY = "pins";

/**
 * A pin goes only when its session ends or is deleted, not when it is dropped: a laptop's sleep drops its sessions (silent for
 * the server's removeAfterMs) and they come back when they report again, pinned where they were.
 *
 * Ended is what this page saw: the session's own view saying done (it shows done through its linger before it leaves), or a
 * removal the server named `deleted`. A removal reason the page worked out for itself is not taken: a snapshot after the page was
 * away (a sleep) calls every session it no longer holds "done" (store goneSince), dropped ones included. The pin of a session
 * seen done goes when the session leaves, so the card holds its place through its Done hold. `sessions` is null before the first
 * load.
 */
export function usePins(sessions: Readonly<Record<string, Pick<SessionView, "status">>> | null, gone: Readonly<Record<string, RemovedReason>>): { pins: Pin[]; toggle: (id: string, slot: number) => void } {
  const [pins, setPins] = useState(() => readPins(readJson<unknown>(STORE_KEY, null)));
  // The sessions last seen done, until they leave or report again.
  const seenDone = useRef(new Set<string>());
  const change = useCallback((next: (was: Pin[]) => Pin[]) => {
    setPins((was) => {
      const now = next(was);
      if (now !== was) writeJson(STORE_KEY, now);
      return now;
    });
  }, []);
  useEffect(() => {
    if (!sessions) return;
    const done = seenDone.current;
    for (const [id, s] of Object.entries(sessions)) {
      if (s.status === "done") done.add(id);
      else done.delete(id);
    }
    const left = [...done].filter((id) => !Object.hasOwn(sessions, id));
    for (const id of left) done.delete(id);
    const ended = new Set([...left, ...Object.keys(gone).filter((id) => gone[id] === "deleted")]);
    change((was) => dropEnded(was, ended));
  }, [sessions, gone, change]);
  const toggle = useCallback((id: string, slot: number) => change((was) => (was.some((p) => p.id === id) ? unpin(was, id) : pin(was, id, slot))), [change]);
  return { pins, toggle };
}
