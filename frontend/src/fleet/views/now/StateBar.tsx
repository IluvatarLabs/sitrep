// The Fleet's state bar, one row: a chip per state with its count, which writes its state's `s:` word into the filter
// field and is pressed while the field picks that state (shell/filter withState, stateIn; pressed again, All); a count is of the
// sessions the rest of the field lets through, and a count of 0 is muted and keeps its place. Then, pushed right, the est. spend
// today and each provider's plan window nearest its limit ("7d 81% used", limits.ts): orange from 75 %, red from 90 %; a stale
// reading is never the one shown (it is on its
// machine's group header, muted, with its time). They are one button that opens the usage panel under the
// bar and closes it again (Today; each machine's spend and plan windows are on its group's header), open or closed as this browser last
// left it. Where the row is too narrow, the figures go under the chips as one line; the chips never break.
import { useState } from "react";
import { fmtUsd, plural } from "../../format";
import { limitFigure, limitLevel, limitWords, staleWords } from "../../limits";
import type { StatusFilter } from "../../logic";
import { providerInfo } from "../../provider";
import { scopedMachines, stateIn, withState } from "../../shell/filter";
import { STATE_WORD, type State } from "../../states";
import { readJson, writeJson } from "../../storage";
import type { FleetState } from "../../store";
import type { Kpis, MachineView, ProviderName, RateLimit, SessionView } from "../../types";
import { dotsText } from "../../ui/Dots";
import { Station } from "../../ui/Station";
import { Unknown } from "../../ui/Unknown";
import { Usage } from "../machines/Usage";
import { Chevron } from "./controls";

/** The chips, in the bar's order: All, then each live state (a session that ended leaves within seconds). */
const CHIPS: readonly State[] = ["needs-you", "working", "idle", "stuck", "failed"];

/** Whether the usage panel is open, remembered per browser; closed until it is first opened. */
const USAGE_KEY = "fleet.usageOpen";
const USAGE_ID = "sb-usage";

/** Whether a plan window still holds: its reset is later, or not known. */
function holds(l: RateLimit, now: number): boolean {
  const at = l.resetsAt === null ? Number.NaN : Date.parse(l.resetsAt);
  return Number.isNaN(at) || at > now;
}

/** Each provider's plan window nearest its limit, across the machines, with the machine that reported it; stale readings left out. */
export function nearestWindows(machines: readonly MachineView[], now: number): { provider: ProviderName; limit: RateLimit; machine: string }[] {
  const best = new Map<ProviderName, { provider: ProviderName; limit: RateLimit; machine: string }>();
  for (const m of machines) {
    for (const { provider, limits } of m.rateLimits) {
      for (const limit of limits) {
        const was = best.get(provider);
        if (holds(limit, now) && staleWords(limit, now) === null && (!was || limit.percentUsed > was.limit.percentUsed)) best.set(provider, { provider, limit, machine: m.name });
      }
    }
  }
  return [...best.values()].sort((a, b) => (a.provider < b.provider ? -1 : 1));
}

interface StateBarProps {
  counts: Record<StatusFilter, number>;
  /** The filter field, whose `s:` word the chips write and read. */
  query: string;
  onQuery: (q: string) => void;
  fleet: FleetState;
  /** Every live session, for the usage panel's Today. */
  live: readonly SessionView[];
  now: number;
  /** The filter's machine scope (ViewProps.scope), which the usage panel's Today follows. */
  scope: string | null;
}

/**
 * The est. spend today, "$655 est. today": every machine's, or the picked machines' (`picked`; null for every machine), "—" with
 * why when it is unknown; then "N not priced" when every machine's leaves out sessions with no price. The wall view says it too.
 */
export function SpendToday({ kpis, picked }: { kpis: Kpis | null; picked: readonly MachineView[] | null }) {
  const unpriced = picked ? 0 : (kpis?.unpricedSessions ?? 0);
  const rows = picked && kpis ? kpis.costTodayByMachine.filter((r) => picked.some((m) => m.id === r.machineId)) : null;
  // A picked word that names no machine has no spend to show: unknown, not $0.00.
  const spend = !kpis || picked?.length === 0 ? null : rows ? (rows.some((r) => r.unpriced) ? null : rows.reduce((sum, r) => sum + r.costUsd, 0)) : kpis.costToday;
  return (
    <>
      <span title={unpriced > 0 ? `Leaves out ${plural(unpriced, "session")} with no price` : picked ? "The picked machine, since midnight on the server" : "Every machine, since midnight on the server"}>
        {/* The figure in its own box, unstyled here: the wall view sets it in ink at 600 (display.css .sb-spend). */}
        <span className="sb-spend">{spend !== null ? fmtUsd(spend) : <Unknown reason={!kpis ? "Not reported yet" : picked?.length === 0 ? "No machine matches" : "No price for some models on this machine"} />}</span> est. today
      </span>
      {unpriced > 0 ? <span className="sb-unpriced">{`${unpriced} not priced`}</span> : null}
    </>
  );
}

export function StateBar({ counts, query, onQuery, fleet, live, now, scope }: StateBarProps) {
  const [usage, setUsage] = useState(() => readJson<unknown>(USAGE_KEY, false) === true);
  const pressed = stateIn(query);
  // With a machine picked in the sidebar (the filter's `m:`), its spend and its plan windows, as the chips count its sessions.
  const picked = scope === null ? null : scopedMachines(scope, fleet.machines, live);
  const windows = nearestWindows(picked ?? fleet.machines, now);
  const toggle = () => {
    writeJson(USAGE_KEY, !usage);
    setUsage(!usage);
  };
  const chip = (key: StatusFilter, label: string, n: number) => (
    <button key={key} type="button" className="sb-chip" aria-pressed={pressed === key} data-zero={n === 0 || undefined} onClick={() => onQuery(withState(query, key))}>
      {key === "all" ? null : <Station kind={key} size={12} />}
      <span>{label}</span>
      <b>{n}</b>
    </button>
  );
  return (
    <>
      <div className="sb">
        <div className="sb-chips" role="group" aria-label="Show sessions">
          {chip("all", "All", counts.all)}
          {CHIPS.map((k) => chip(k, STATE_WORD[k], counts[k]))}
        </div>
        <button type="button" className="sb-end" aria-expanded={usage} aria-controls={usage ? USAGE_ID : undefined} title={usage ? "Hide usage" : "Show usage"} onClick={toggle}>
          <Chevron open={usage} />
          <SpendToday kpis={fleet.kpis} picked={picked} />
          {windows.map(({ provider, limit, machine }) => {
            const { name, Logo } = providerInfo(provider);
            return (
              <span key={provider} className="sb-win" data-level={limitLevel(limit.percentUsed)} title={dotsText([`${name} ${limitWords(limit, provider, now)}`, machine])}>
                <Logo />
                <span className="ui-vh">{`${name} `}</span>
                {limitFigure(limit)}
              </span>
            );
          })}
        </button>
      </div>
      {usage ? <Usage id={USAGE_ID} fleet={fleet} live={live} now={now} scope={scope} /> : null}
    </>
  );
}
