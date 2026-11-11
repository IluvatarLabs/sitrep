// The state mark: one shape and one colour per state, always beside its word, never colour alone; offline shares
// stuck's orange, the warning colour (both want a look), its dotted ring telling them apart. The failed mark's
// cross is cut in --station-fill (the surface under it; --sheet unless a pane sets it). The needs-you mark's outline and bars
// are --on-held (ink on light, where amber alone is under 3:1). Working marks pulse in phase (ui.css --pulse, shell/useMotion).
import { STATE_WORD, type State } from "../states";
import type { AgentStatus } from "../types";

/** The marks: a session's six states, offline (a silent machine, a lost stream, a session that went offline in Activity), and an
 * agent's queued and stopped. */
type Mark = State | "offline" | "queued" | "stopped";

/** What a mark is asked for by: a state, or an agent's status. */
export type StationKind = Mark | AgentStatus;

const MARK: Record<StationKind, Mark> = {
  working: "working",
  running: "working",
  "needs-you": "needs-you",
  idle: "idle",
  stuck: "stuck",
  failed: "failed",
  offline: "offline",
  done: "done",
  queued: "queued",
  stopped: "stopped",
  aborted: "stopped",
};

const WORD: Record<Mark, string> = { ...STATE_WORD, offline: "Offline", queued: "Queued", stopped: "Stopped" };

const COLOR: Record<Mark, string> = {
  working: "var(--line)",
  "needs-you": "var(--held)",
  idle: "var(--idle)",
  stuck: "var(--stuck)",
  failed: "var(--fail)",
  offline: "var(--stuck)",
  done: "var(--done)",
  queued: "var(--done)",
  stopped: "var(--done)",
};

/** A state's word in running text ("2 working", "needs you"); a label capitalises it (states.ts STATE_WORD). */
export const stationWord = (kind: StationKind): string => WORD[MARK[kind]].toLowerCase();

/** A state's colour, for what it fills beyond the mark: agent squares, nodes, edges. */
export const stationColor = (kind: StationKind): string => COLOR[MARK[kind]];

const GROUND = "var(--station-fill, var(--sheet))";

function shape(mark: Mark) {
  const c = COLOR[mark];
  switch (mark) {
    case "working":
      return <circle cx="8" cy="8" r="4.5" fill={c} />;
    case "needs-you":
      return (
        <>
          <circle cx="8" cy="8" r="6" fill={c} stroke="var(--on-held)" strokeWidth="1" />
          <path d="M6.4 5.6v4.8M9.6 5.6v4.8" stroke="var(--on-held)" strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
    case "idle":
      return <circle cx="8" cy="8" r="4.8" fill="none" stroke={c} strokeWidth="1.8" />;
    case "stuck":
      return (
        <>
          <circle cx="8" cy="8" r="5.6" fill="none" stroke={c} strokeWidth="1.8" />
          <path d="M8 5.2V8l1.8 1.2" fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" />
        </>
      );
    case "failed":
      return (
        <>
          <circle cx="8" cy="8" r="6" fill={c} />
          <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" stroke={GROUND} strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
    case "offline":
      return <circle cx="8" cy="8" r="4.8" fill="none" stroke={c} strokeWidth="1.6" strokeDasharray="1.6 2.2" />;
    case "done":
      return <path d="M4.6 8.3l2.3 2.3 4.6-4.9" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />;
    case "queued":
      return <circle cx="8" cy="8" r="4.8" fill="none" stroke={c} strokeWidth="1.6" strokeDasharray="2.8 1.6" />;
    case "stopped":
      return (
        <>
          <circle cx="8" cy="8" r="4.8" fill="none" stroke={c} strokeWidth="1.6" />
          <path d="M5 11l6-6" stroke={c} strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
  }
}

/**
 * The mark alone (16 px unless sized), decorative: put its word beside it, or pass `label` to name it for assistive tech, true
 * for its state's word or the words that say it there ("Went offline").
 */
export function Station({ kind, label, size = 16 }: { kind: StationKind; label?: boolean | string; size?: number }) {
  const mark = MARK[kind];
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={`station station-${mark}`}
      role={label ? "img" : undefined}
      aria-label={label ? (label === true ? WORD[mark] : label) : undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {shape(mark)}
    </svg>
  );
}

/** The mark with its word, as rows and headers show a state. */
export function StationWord({ kind, word }: { kind: StationKind; word?: string }) {
  return (
    <span className="station-word">
      <Station kind={kind} />
      <span>{word ?? stationWord(kind)}</span>
    </span>
  );
}
