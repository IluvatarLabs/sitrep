// Asks that stopped waiting on you a moment ago, so Needs you keeps a quiet line for them instead of letting
// them vanish. The view sees an ask's state, not who answered it or how it closed, so the stamp says only that it no longer
// waits.
import { useRef } from "react";
import type { SessionView } from "../../types";
import { loopName } from "./queue";

export interface SettledAsk {
  key: string;
  sessionId: string;
  who: string;
  machine: string;
  /** When the page saw it settle (epoch ms, this browser's clock). */
  at: number;
}

type Open = { who: string; machine: string; sessionId: string };

/** Every ask open now across the fleet, by `session:ask`. */
function openAsks(all: readonly SessionView[]): Map<string, Open> {
  const out = new Map<string, Open>();
  for (const s of all) {
    for (const a of s.asks) {
      if (a.state !== "closed") out.set(`${s.id}:${a.id}`, { who: loopName(s, a.agentId), machine: s.machine.name, sessionId: s.id });
    }
  }
  return out;
}

/**
 * Asks seen open earlier and closed or gone now, while their session is still live, for `lingerMs` after the page saw them
 * settle. Worked out during render from the last render's open asks; the first render is the baseline.
 */
export function useSettled(all: readonly SessionView[], lingerMs: number): SettledAsk[] {
  const before = useRef<Map<string, Open> | null>(null);
  const settled = useRef<SettledAsk[]>([]);
  const open = openAsks(all);
  const at = Date.now();
  if (before.current) {
    const live = new Set(all.filter((s) => s.status !== "done").map((s) => s.id));
    for (const [key, was] of before.current) {
      if (open.has(key) || !live.has(was.sessionId) || settled.current.some((x) => x.key === key)) continue;
      settled.current = [...settled.current, { key, sessionId: was.sessionId, who: was.who, machine: was.machine, at }];
    }
  }
  before.current = open;
  // An ask that opens again (listed again after an implicit close) is waiting once more, so its stamp goes.
  settled.current = settled.current.filter((x) => at - x.at < lingerMs && !open.has(x.key));
  return settled.current;
}
