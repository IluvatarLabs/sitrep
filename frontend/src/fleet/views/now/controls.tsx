// The Fleet's controls and small shared parts: the layout switch, Group, Sort, the Background chip and Expand all;
// the Attention header and its two lists' headings; a group's header; a pin; the disclosure chevron; the shell's passing notice.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { isKnownProvider } from "../../../../../server/src/fleet/protocol";
import { ModelChip } from "../../components/Chips";
import { osLogo } from "../../components/Icons";
import { PlanWindows } from "../../components/PlanWindows";
import { fmtUsd, plural } from "../../format";
import { countIn, GROUP_BYS, type Group, type GroupBy } from "../../groups";
import { SORTS, type SortKey } from "../../logic";
import { isHeadless, liveCount } from "../../states";
import type { MachineView, ProviderName, SessionView } from "../../types";
import { Dots, dotsText } from "../../ui/Dots";
import { Station } from "../../ui/Station";
import { Unknown } from "../../ui/Unknown";
import { LAYOUTS, type FleetLayout, type FleetPrefsApi } from "../../useGroupPrefs";
import type { FleetShape } from "./fleet";
import "./controls.css";
import { needYouWords } from "../../shell/Nav";

/** The fleet's est. spend today (Kpis.costToday), for a machine group's share of it; null until the server sends it. */
export const FleetSpendTotal = createContext<number | null>(null);

/** The machines and the clock a machine group's header reads its plan windows from. */
export const FleetMachines = createContext<{ machines: readonly MachineView[]; now: number }>({ machines: [], now: 0 });

/** What background sessions have cost: "est. $4.10 so far", the sessions with no cost named; never $0.00 for none known. */
function spentSoFar(list: readonly SessionView[]): string {
  const known = list.flatMap((s) => (s.costUsd === null ? [] : [s.costUsd]));
  if (known.length === 0) return "est. cost not reported";
  const usd = `est. ${fmtUsd(known.reduce((sum, n) => sum + n, 0))} so far`;
  const missing = list.length - known.length;
  return missing > 0 ? `${usd}, not counting ${plural(missing, "session")} with no cost` : usd;
}

function Select<T extends string>({ label, options, value, onChange }: { label: string; options: Record<T, string>; value: T; onChange: (v: T) => void }) {
  return (
    <label className="ctl-field">
      <span>{label}</span>
      <select className="ui-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {(Object.keys(options) as T[]).map((k) => (
          <option key={k} value={k}>
            {options[k]}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The Background chip: shows or sets aside the background sessions. Its name says its kinds with their counts, "Headless 1 ·
 * Detached 2" (a headless run, states isHeadless, counted once even when nobody is attached to it either); its title says what
 * they have cost.
 */
export function BackgroundChip({ fleet, background }: { fleet: FleetPrefsApi; background: readonly SessionView[] }) {
  const { prefs, set } = fleet;
  const spent = spentSoFar(background);
  const known = background.flatMap((s) => (s.costUsd === null ? [] : [s.costUsd]));
  const headless = background.filter(isHeadless).length;
  const kinds = [
    { word: "Headless", n: headless, title: plural(headless, "headless run") },
    { word: "Detached", n: background.length - headless, title: `${plural(background.length - headless, "session")} nobody is attached to` },
  ].filter((k) => k.n > 0);
  return (
    <button
      type="button"
      className="ui-button ctl-chip"
      aria-pressed={prefs.background}
      title={dotsText([`${plural(background.length, "background session")}: ${kinds.map((k) => k.title).join(", ")}`, spent])}
      onClick={() => set({ background: !prefs.background })}
    >
      <span className="ui-vh">Background sessions: </span>
      <Dots
        items={kinds.map((k) => (
          <span key={k.word}>
            {k.word} <b>{k.n}</b>
          </span>
        ))}
      />
      {known.length > 0 ? <span className="ctl-chip-sub">{`est. ${fmtUsd(known.reduce((sum, n) => sum + n, 0))}`}</span> : null}
      <span className="ui-vh">{`, ${spent}`}</span>
    </button>
  );
}

/** `[Cards | List | Graph]`, Group, Sort (not on the Graph), the Background chip when there are any, Expand all on the List. */
export function FleetControls({ fleet, background }: { fleet: FleetPrefsApi; background: readonly SessionView[] }) {
  const { prefs, set } = fleet;
  return (
    <div className="ctl-row">
      <div className="ui-segment-options" role="group" aria-label="Layout">
        {(Object.keys(LAYOUTS) as FleetLayout[]).map((k) => (
          <button key={k} type="button" aria-pressed={prefs.layout === k} onClick={() => set({ layout: k })}>
            {LAYOUTS[k]}
          </button>
        ))}
      </div>
      <Select<GroupBy> label="Group" options={GROUP_BYS} value={prefs.groupBy} onChange={(groupBy) => set({ groupBy })} />
      {prefs.layout === "graph" ? null : <Select<SortKey> label="Sort" options={SORTS} value={prefs.sort} onChange={(sort) => set({ sort })} />}
      {background.length > 0 ? <BackgroundChip fleet={fleet} background={background} /> : null}
      {prefs.layout === "list" ? (
        <button type="button" className="ui-button ctl-chip" aria-pressed={prefs.expandAll} onClick={() => set({ expandAll: !prefs.expandAll })}>
          Expand all
        </button>
      ) : null}
    </div>
  );
}

/** "[logo] Opus 5.5 ▮▮▮▯▯" for a loop, or "—" when its model is not reported; a harness without its own logo keeps its named chip. */
export function Model({ provider, m }: { provider: ProviderName; m: Pick<SessionView, "modelFamily" | "model" | "effort"> }) {
  if (m.model === null && m.modelFamily === "other" && isKnownProvider(provider)) return <Unknown reason="Model not reported" />;
  return <ModelChip provider={provider} family={m.modelFamily} model={m.model} effort={m.effort} />;
}

/** The disclosure chevron: right while shut, down while open. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={open ? "ctl-chev is-open" : "ctl-chev"} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The Attention section's header (Needs you and Problems), drawn as a machine group's header is, with the two counts where a
 * machine has its info: the band is the button that folds the section, shut until first opened, so nothing here takes the
 * Sessions' room unless it is asked to; the counts stay in view and take colour when they are not 0.
 */
export function AttentionHead({ id, needs, problems, worst, open, onToggle, bodyId }: { id: string; needs: number; problems: number; worst: "failed" | "stuck" | null; open: boolean; onToggle: () => void; bodyId: string }) {
  return (
    <h2 id={id} className="ui-group-head ctl-group-h">
      <button type="button" className="ctl-group" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <Chevron open={open} />
        <span className="ctl-group-name">Attention</span>
        <span className="ctl-group-meta">
          <Dots
            items={[
              <span key="needs" className="ctl-attn" data-on={needs > 0 || undefined}>
                {needs > 0 ? <Station kind="needs-you" size={14} /> : null}
                {needYouWords(needs)}
              </span>,
              <span key="problems" className="ctl-attn" data-on={problems > 0 || undefined} data-tone={worst ?? undefined}>
                {worst ? <Station kind={worst} size={14} /> : null}
                {plural(problems, "problem")}
              </span>,
            ]}
          />
        </span>
      </button>
    </h2>
  );
}

/** One of Attention's two lists' headings: its name and count at the section heading's size, the count muted at 0. */
export function ListHead({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <h3 id={id} className="now-h2 ctl-list-h">
      <span>{title}</span>
      <b data-zero={count === 0 || undefined}>{count}</b>
    </h3>
  );
}

/**
 * A group's header, its whole width the button that folds it: a machine's OS, its name, its live sessions (an ended one, shown
 * until it leaves, not counted), how many need you (the held mark, as the sidebar counts them), its est. spend today and its
 * share of the fleet's ("45% of today's spend", the figures in the title), and its plan windows with their resets.
 * One line, ending in "…" where it does not fit; the plan windows, last, give way first.
 */
export function GroupHead({ group, open, onToggle, bodyId, spend }: { group: Group; open: boolean; onToggle: () => void; bodyId: string; spend: number | null }) {
  const total = useContext(FleetSpendTotal);
  const { machines, now } = useContext(FleetMachines);
  const machine = group.kind === "machine" ? machines.find((m) => m.id === group.sessions[0]?.machine.id) : undefined;
  const waits = countIn(group, "needs-you");
  const pct = spend !== null && total !== null && total > 0 ? Math.round((spend / total) * 100) : null;
  const share = pct === null || spend === null || total === null ? undefined : `${pct}% of the fleet's est. spend today (${fmtUsd(spend)} of ${fmtUsd(total)})`;
  return (
    <h3 className="ui-group-head ctl-group-h">
      <button type="button" className="ctl-group" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <Chevron open={open} />
        {group.kind === "machine" ? <span className="ctl-group-os">{osLogo(group.os)}</span> : null}
        <span className={group.kind === "project" ? "ctl-group-name is-path" : "ctl-group-name"}>{group.name || <Unknown reason="Project not reported" />}</span>
        <span className="ctl-group-meta">
          <Dots
            className="is-oneline"
            items={[
              plural(liveCount(group.sessions), "session"),
              waits > 0 ? (
                <span className="ui-needs" title={needYouWords(waits)}>
                  <Station kind="needs-you" />
                  <span aria-hidden="true">{waits}</span>
                  <span className="ui-vh">{needYouWords(waits)}</span>
                </span>
              ) : null,
              // Null once the totals are in: a model here has no price, so the machine says it does not know, never less.
              spend !== null ? <span title={share}>{`est. ${fmtUsd(spend)} today${pct === null ? "" : ` · ${pct}% of today's spend`}`}</span> : group.kind === "machine" && total !== null ? (
                <span>
                  est. <Unknown reason="No price for some models" /> today
                </span>
              ) : null,
              machine && machine.rateLimits.some((p) => p.limits.length > 0) ? <PlanWindows m={machine} now={now} /> : null,
            ]}
          />
        </span>
      </button>
    </h3>
  );
}

/**
 * The shown sessions by group, each under its header that folds it (remembered with the Fleet's choices), or all in one body
 * when nothing groups them. `children` draws one group's body.
 */
export function Groups(props: {
  shape: FleetShape;
  prefs: FleetPrefsApi;
  spendOf: (machineId: string) => number | null;
  idPrefix: string;
  children: (sessions: SessionView[], bodyId: string, hidden: boolean) => ReactNode;
}) {
  const { shape, prefs, idPrefix, children } = props;
  if (shape.groups.length === 0) return <>{children(shape.shown, `${idPrefix}-all`, false)}</>;
  return (
    <div className="ctl-groups">
      {shape.groups.map((g) => {
        const key = `${prefs.prefs.groupBy}:${g.key}`;
        const open = !prefs.prefs.folded.includes(key);
        const bodyId = `${idPrefix}-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        const spend = g.kind === "machine" ? props.spendOf(g.sessions[0]!.machine.id) : null;
        return (
          <section key={g.key} className="ctl-groupbox" aria-label={g.name || "Project not reported"}>
            <GroupHead group={g} open={open} onToggle={() => prefs.fold(key)} bodyId={bodyId} spend={spend} />
            {children(g.sessions, bodyId, !open)}
          </section>
        );
      })}
    </div>
  );
}

/**
 * A pin: holds a session's place while the sort moves the others (pins.ts), kept in this browser; shown on its row's or card's
 * hover or focus, and while pinned. Its title says what pressing it does.
 */
export function PinButton({ name, on, onToggle }: { name: string; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="ctl-pin" aria-pressed={on} aria-label={on ? `Unpin ${name}` : `Pin ${name}`} title={on ? "Unpin: back to sort order" : "Keep in place"} onClick={onToggle}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        <path d="M5.6 2.5h4.8l-.7 4.1 2.3 2.4H4l2.3-2.4z" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M8 9v4.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  );
}

const NOTICE_MS = 6000;

/** A one-line notice that clears itself after six seconds. */
export function useNotice(): [string | null, (text: string | null) => void] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (text === null) return undefined;
    const timer = setTimeout(() => setText(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return [text, setText];
}
