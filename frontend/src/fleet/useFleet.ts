// The live fleet: GET /api/fleet/state once, then the SSE stream, each message folded in by the pure reducer (store.ts). Six
// seconds with no message (ticks come every 2 s) counts as a lost stream: it is closed and reopened, and the snapshot the
// server sends on connect brings everything back in step. A stream the server refuses outright (EventSource gives up on any
// answer but 200) is not reopened blind: the state is read first, so a refusal by the view gate is seen for what it is.
//
// The view gate (Settings' Require sign-in to view): while it is on, every browser read without a sign-in gets
// `401 {"error":"sign-in required"}`. The state, the stream and every other read (views/settings/api.ts getJson) report such a
// refusal here (viewGated); the fleet is then dropped and the console shows the sign-in screen. Behind it only the state is
// asked for, at the stream's reconnect pace, so a gate turned off from another browser lets this one in; a read that gets
// through, or a new `attempt` (after signing in), starts over.
import { useEffect, useReducer, useState } from "react";
import { VIEW_GATED } from "../../../server/src/fleet/protocol";
import { fleetReducer, initialState, type FleetAction, type FleetState } from "./store";
import type { ActivityView, Kpis, MachineView, RemovedReason, SessionView, StateBody } from "./types";

export const FLEET_BASE = "/api/fleet";
const SILENCE_MS = 6000;
const RECONNECT_MS = 2000;
/** The window event a read refused by the view gate raises, wherever it was made. */
const GATED_EVENT = "sitrep:view-gated";

/** The stream's events, each with the action its data makes. */
const STREAM: { [event: string]: (data: never) => FleetAction } = {
  snapshot: (body: StateBody) => ({ type: "snapshot", body }),
  tick: (d: { serverTime: number; kpis: Kpis; machines?: MachineView[] }) => ({ type: "tick", ...d }),
  session: (view: SessionView) => ({ type: "session", view }),
  removed: (d: { sessionId: string; reason: RemovedReason }) => ({ type: "removed", sessionId: d.sessionId, reason: d.reason }),
  activity: (event: ActivityView) => ({ type: "activity", event }),
};

/** A stream event's JSON, or undefined when it does not parse. */
function dataOf(ev: MessageEvent): unknown {
  try {
    return JSON.parse(String(ev.data)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Whether a refused read is the view gate's (`401 {"error":"sign-in required"}`); when it is, the console is told, wherever the
 * read was made. Reads the body, so call it only on a response that is not ok.
 */
export async function viewGated(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (body?.error !== VIEW_GATED) return false;
  window.dispatchEvent(new Event(GATED_EVENT));
  return true;
}

/** The fleet, read again from nothing whenever `attempt` changes (a sign-in at the view gate) or the gate lets it in. */
export function useFleet(attempt: number): FleetState {
  const [fleet, send] = useReducer(fleetReducer, initialState);
  const [letIn, setLetIn] = useState(0);

  useEffect(() => {
    let stream: EventSource | null = null;
    let closed = false;
    let heardAt = Date.now();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let recheck: ReturnType<typeof setInterval> | undefined;
    // A new try after the view gate starts from nothing.
    send({ type: "gated", on: false });

    const reopenLater = () => {
      if (closed || retry !== undefined) return;
      retry = setTimeout(() => {
        retry = undefined;
        open();
      }, RECONNECT_MS);
    };

    /** The state, as the first load and after a refused stream; null when the view gate refused it (viewGated has said so). */
    const readState = (): Promise<StateBody | null> =>
      fetch(`${FLEET_BASE}/state`).then(async (res) => {
        if (res.ok) return (await res.json()) as StateBody;
        if (await viewGated(res)) return null;
        throw new Error(`HTTP ${res.status}`);
      });

    function open() {
      if (closed) return;
      stream?.close();
      heardAt = Date.now();
      const es = new EventSource(`${FLEET_BASE}/stream`);
      stream = es;
      // Any event is a sign of life; one whose data parses becomes an action.
      for (const [event, toAction] of Object.entries(STREAM)) {
        es.addEventListener(event, (ev) => {
          heardAt = Date.now();
          const data = dataOf(ev);
          if (data !== undefined && data !== null) send(toAction(data as never));
        });
      }
      es.onerror = () => {
        if (closed || stream !== es) return;
        send({ type: "disconnected" });
        // A network error is retried by the browser itself. A refusal closes the stream for good: the state says why (the view
        // gate, or the server is back and the stream opens again), and only then is the stream reopened, no sooner than before.
        if (es.readyState !== EventSource.CLOSED) return;
        readState().then(
          (body) => {
            if (closed || body === null) return;
            send({ type: "snapshot", body });
            reopenLater();
          },
          () => reopenLater(),
        );
      };
    }

    // The first load runs beside the stream, which sends its own snapshot once connected.
    readState().then(
      (body) => {
        if (!closed && body !== null) send({ type: "snapshot", body });
      },
      (err: Error) => {
        if (!closed) send({ type: "error", message: err.message });
      },
    );
    open();

    // A stream gone quiet is dropped and opened again.
    const watchdog = setInterval(() => {
      if (Date.now() - heardAt <= SILENCE_MS) return;
      send({ type: "disconnected" });
      stream?.close();
      stream = null;
      heardAt = Date.now();
      reopenLater();
    }, 1000);

    // A browser opens at most six connections to one server, and a page kept in the back/forward cache would hold its stream
    // open, so a later load would wait for ever: the stream closes when the page is left and opens again (its snapshot
    // resyncs) when a cached page comes back.
    const onHide = () => {
      stream?.close();
      stream = null;
      clearTimeout(retry);
      retry = undefined;
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) open();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);

    const stop = () => {
      closed = true;
      stream?.close();
      clearTimeout(retry);
      clearInterval(watchdog);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener(GATED_EVENT, onGated);
    };
    // Refused by the view gate, here or by any other read: only the state is asked for until a read gets through.
    function onGated() {
      stop();
      send({ type: "gated", on: true });
      const timer = setInterval(() => {
        fetch(`${FLEET_BASE}/state`).then(
          (res) => {
            if (res.ok && recheck === timer) setLetIn((n) => n + 1);
          },
          () => undefined,
        );
      }, RECONNECT_MS);
      recheck = timer;
    }
    window.addEventListener(GATED_EVENT, onGated);
    return () => {
      stop();
      clearInterval(recheck);
      recheck = undefined;
    };
  }, [attempt, letIn]);

  return fleet;
}
