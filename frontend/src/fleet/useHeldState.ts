import { useEffect, useRef, useState } from "react";

/**
 * `live` as it stood at the last tick of `intervalMs`, so whatever renders from it redraws once per interval. A change that
 * `isUrgent(shown, next)` calls urgent shows at once. A new interval shows the newest value straight away and restarts.
 */
export function useHeldState<T>(live: T, intervalMs: number, isUrgent: (shown: T, next: T) => boolean): T {
  const [snapshot, setSnapshot] = useState(live);
  const latest = useRef(live);
  latest.current = live;
  // An urgent change jumps the queue: it shows in this render and becomes the snapshot right after.
  const jumps = snapshot !== live && isUrgent(snapshot, live);
  useEffect(() => {
    if (jumps) setSnapshot(live);
  }, [jumps, live]);

  // The interval itself: the newest value now, then again at every tick.
  useEffect(() => {
    setSnapshot(latest.current);
    const timer = setInterval(() => setSnapshot(latest.current), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return jumps ? live : snapshot;
}
