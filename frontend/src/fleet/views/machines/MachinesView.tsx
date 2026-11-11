// Machines (#/machines), sized for a few machines. One row per machine: its state from its last report, name, live
// sessions, reporter versions as the server judges them against its range (a version no live session reports is labelled "last
// reported"), Codex hooks, last report, and Remove; a row opens its refused reports and the commands that fix it on that machine.
// Then the refusals no machine row owns. The filter field's `m:` word narrows the rows to the machines it picks on the Fleet.
// Est. spend today and plan windows are on the machine's group header on the Fleet, Today in its usage panel. Add a machine opens
// here and from the sidebar's "+" (#/machines?add).
import { useEffect, useState } from "react";
import { MACHINE_QUIET_MS, type MachineState, type RefusalView } from "../../../../../server/src/fleet/protocol";
import { ADD_MACHINE_HASH, hashFor, wantsAddMachine } from "../../../route";
import { IconChevron, osLogo } from "../../components/Icons";
import { fmtAge, fmtClock, fmtDay, plural } from "../../format";
import { sharedNames, shortId } from "../../groups";
import { PROVIDER } from "../../provider";
import { adminApi } from "../../respondApi";
import { scopedMachines } from "../../shell/filter";
import type { MachineView, Provider, SessionView } from "../../types";
import { Dots } from "../../ui/Dots";
import { StationWord, type StationKind } from "../../ui/Station";
import { Unknown } from "../../ui/Unknown";
import { usePageVisible } from "../../usePageVisible";
import { useRespond } from "../../useRespond";
import { failure, getJson } from "../settings/api";
import type { ViewProps } from "../types";
import { AddMachine } from "./AddMachine";
import { Command, installCommand, machineCommands, OS_NAME, osOf } from "./commands";
import "./machines.css";

/** A machine's reporting states (idle is called Quiet, so idle is only a session's state), each with the one line its hover says. */
export const STATE: Record<MachineState, { word: string; mark: StationKind; title: string }> = {
  reporting: { word: "Reporting", mark: "working", title: "Reported in the last 2 minutes" },
  quiet: { word: "Quiet", mark: "idle", title: "Last report under an hour ago" },
  silent: { word: "Silent", mark: "offline", title: "No report for over an hour: asleep, off the LAN or uninstalled" },
  restart: { word: "Not since restart", mark: "offline", title: "No report since the server started" },
};
const STATE_ORDER: readonly MachineState[] = ["reporting", "quiet", "silent", "restart"];
const COLUMNS = 7;
/** Refused reports listed under a row before the rest are counted. */
const REFUSED_SHOWN = 10;
/** Asked again every 10 seconds while this page is open; elsewhere the sidebar's badge needs a minute's. */
const REFUSALS_EVERY_MS = { open: 10_000, badge: 60_000 } as const;

/**
 * The server's refused reports (an in-memory ring of 200, newest first), read again while the tab is visible. The shell runs
 * it once and hands the list to the sidebar's Machines badge and to this page; `open` while this page shows.
 */
export function useRefusals(open: boolean): RefusalView[] {
  const visible = usePageVisible();
  const [rows, setRows] = useState<RefusalView[]>([]);
  const every = REFUSALS_EVERY_MS[open ? "open" : "badge"];
  useEffect(() => {
    if (!visible) return undefined;
    let current = true;
    const read = () =>
      getJson<{ refusals: RefusalView[] }>("/refusals").then(
        (r) => current && setRows(r.refusals),
        () => undefined, // Unreachable for now: the last list stands.
      );
    void read();
    const timer = setInterval(() => void read(), every);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [visible, every]);
  return rows;
}

/** The refused reports that count as a problem: the last hour's (MACHINE_QUIET_MS, the server's line from quiet to silent). */
const lastHour = (refusals: readonly RefusalView[], serverTime: number): RefusalView[] => refusals.filter((r) => r.at >= serverTime - MACHINE_QUIET_MS);

/** Refused reports no machine row owns: with no machine id, or one the server lists no machine for. */
function noMachine(refusals: readonly RefusalView[], machines: readonly MachineView[]): RefusalView[] {
  const known = new Set(machines.map((m) => m.id));
  return refusals.filter((r) => r.machineId === null || !known.has(r.machineId));
}

/** Whether `#/machines?add` is open, so the sidebar's "+" can be a plain link to it; closing keeps the view's own address. */
function useAddDialog(): [boolean, (open: boolean) => void] {
  const read = () => wantsAddMachine(window.location.hash);
  const [open, setOpen] = useState(read);
  useEffect(() => {
    const follow = () => setOpen(read());
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const set = (next: boolean) => {
    window.history.replaceState(window.history.state, "", next ? ADD_MACHINE_HASH : hashFor("machines"));
    setOpen(next);
  };
  return [open, set];
}

const PROVIDERS: readonly Provider[] = ["claude", "codex"];

/**
 * A reporter its live sessions show outside the server's range (MachineView.reporters): "outdated" or "newer"; else null. A
 * version no live session reports is stale, so it never warns.
 */
const offRange = (m: MachineView, p: Provider): "outdated" | "newer" | null => {
  const r = m.reporters[p];
  return r?.live && (r.compat === "outdated" || r.compat === "newer") ? r.compat : null;
};

/** What needs a look on a machine besides its reporters' range: Codex hooks off, refused reports. Silent is a state. */
interface MachineHealth {
  /** Live Codex sessions whose hooks are off, and whether any says either way. */
  hooks: { known: boolean; off: number };
  refused: RefusalView[];
}

function healthOf(m: MachineView, live: readonly SessionView[], refusals: readonly RefusalView[]): MachineHealth {
  const hooks = live.filter((s) => s.machine.id === m.id && s.provider === "codex" && s.hooksActive !== null);
  return { hooks: { known: hooks.length > 0, off: hooks.filter((s) => s.hooksActive === false).length }, refused: refusals.filter((r) => r.machineId === m.id) };
}

/**
 * How many problems this page lists, as the sidebar's Machines badge counts them: on each machine, each reporter outside the
 * server's range, Codex hooks off, and reports refused in the last hour; then refused reports in that hour that no machine row
 * owns, as one. A silent machine is not one: Silent is a state.
 */
export function problemCount(machines: readonly MachineView[], live: readonly SessionView[], refusals: readonly RefusalView[], serverTime: number): number {
  const recent = lastHour(refusals, serverTime);
  const onMachines = machines.reduce((n, m) => {
    const h = healthOf(m, live, recent);
    return n + PROVIDERS.filter((p) => offRange(m, p)).length + (h.hooks.off > 0 ? 1 : 0) + (h.refused.length > 0 ? 1 : 0);
  }, 0);
  return onMachines + (noMachine(recent, machines).length > 0 ? 1 : 0);
}

/** A refusal's time: the clock today, with the day before that. */
const refusedAt = (t: number, now: number) => (fmtDay(t) === fmtDay(now) ? fmtClock(t) : `${fmtDay(t)} ${fmtClock(t)}`);

function Refused({ title, rows, now, hour = 0 }: { title: string; rows: readonly RefusalView[]; now: number; hour?: number }) {
  return (
    <section>
      {/* Every refusal the server keeps, the count first, so it never reads as part of a name ("no machine 2"); a count, not
          "reports": refused telemetry exports are listed too. A row's badge counts the last hour's, said here when it differs. */}
      <h3 className="mc-h3">{`${rows.length} ${title}${hour && hour !== rows.length ? `, ${hour} in the last hour` : ""}`}</h3>
      <ul className="mc-refusals">
        {rows.slice(0, REFUSED_SHOWN).map((r, i) => (
          <li key={`${r.at}:${i}`}>
            <span className="mc-num">{refusedAt(r.at, now)}</span>
            <span>{`${r.status} ${r.reason}`}</span>
            <span className="mc-dim">{r.address}</span>
          </li>
        ))}
      </ul>
      {rows.length > REFUSED_SHOWN ? <p className="mc-dim">{`+${rows.length - REFUSED_SHOWN} more`}</p> : null}
    </section>
  );
}

/** A machine's OS as its logo, named for hover and assistive tech by the whole string its reporter sent. */
function OsMark({ os }: { os: string | null }) {
  const said = os ?? "OS not reported";
  return (
    <span className="mc-os" role="img" aria-label={said} title={said}>
      {osLogo(os)}
    </span>
  );
}

/** A machine's OS logo and name, the start of its id beside it when another machine has the same name. */
export function MachineName({ m, shared }: { m: MachineView; shared: boolean }) {
  return (
    <span className="mc-name">
      <OsMark os={m.os} />
      <b>{m.name}</b>
      {shared ? <span className="mc-dim mc-num">{shortId(m.id)}</span> : null}
    </span>
  );
}

const REPORTER: Record<Provider, string> = { claude: "Claude plugin", codex: "Codex reporter" };

/** A version as the table shows it, its release number ("0.1.0" of "0.1.0-sim"); the whole one is in its title. */
const release = (v: string): string => /^\d+\.\d+\.\d+/.exec(v)?.[0] ?? v;

/**
 * The reporters' versions with their logos, each a live session shows outside the server's range marked, and one no live
 * session reports muted as "last reported"; under them, the Codex daemon's.
 */
function Versions({ m }: { m: MachineView }) {
  const version = (p: Provider) => {
    const r = m.reporters[p];
    if (!r) return null;
    const { Logo } = PROVIDER[p];
    const off = offRange(m, p);
    const why = off === "outdated" ? ": older than this server supports" : off === "newer" ? ": newer than this server supports; update the server" : "";
    return (
      <span key={p} className={off ? "mc-ver mc-warn" : r.live ? "mc-ver" : "mc-ver mc-dim"} title={`${REPORTER[p]} ${r.version}${r.live ? "" : ", last reported"}${why}`}>
        <Logo />
        <span className="ui-vh">{`${REPORTER[p]} `}</span>
        {r.live ? null : "last reported "}
        {off ? `${release(r.version)} ${off}` : release(r.version)}
      </span>
    );
  };
  const reporters = PROVIDERS.map(version);
  if (!reporters.some(Boolean) && !m.codexDaemon) return <Unknown reason="No Claude or Codex reporter version reported" />;
  return (
    <>
      {reporters.some(Boolean) ? <Dots items={reporters} /> : null}
      {m.codexDaemon ? (
        <span className="mc-daemon" title={`Codex daemon ${m.codexDaemon}`}>
          {`daemon ${release(m.codexDaemon)}`}
        </span>
      ) : null}
    </>
  );
}

/** Codex hooks as the machine's live Codex sessions say; nothing on a machine without Codex. */
function Hooks({ m, hooks }: { m: MachineView; hooks: MachineHealth["hooks"] }) {
  if (!hooks.known) return m.reporters.codex ? <Unknown reason="No live Codex session to tell" /> : null;
  return hooks.off > 0 ? <span className="mc-warn">{`Off in ${plural(hooks.off, "session")}`}</span> : <>On</>;
}

/** The commands for a machine, its problems named on the ones that fix them. */
function Detail({ m, health, now, hour }: { m: MachineView; health: MachineHealth; now: number; hour: number }) {
  const os = osOf(m.os);
  // A machine whose versions are unknown gets both harnesses' commands.
  const claude = m.reporters.claude !== null || m.reporters.codex === null;
  const codex = m.reporters.codex !== null || m.reporters.claude === null;
  const outdated = PROVIDERS.filter((p) => offRange(m, p) === "outdated").map((p) => REPORTER[p]);
  const notes: Record<string, string | null> = {
    check: m.state === "silent" || m.state === "restart" ? STATE[m.state].word : null,
    update: outdated.length ? `${outdated.join(", ")} outdated` : null,
    trust: health.hooks.off > 0 ? "hooks off" : null,
  };
  return (
    <div className="mc-detail-body">
      {health.refused.length ? <Refused title="refused" rows={health.refused} now={now} hour={hour} /> : null}
      <section>
        <h3 className="mc-h3">
          {`Run on ${m.name}, in its clone`} <span className="mc-meta">{OS_NAME[os]}</span>
        </h3>
        {machineCommands(os, claude, codex).map((c) => (
          // The machine's own state ("Claude plugin outdated"), then what to know before running it.
          <Command key={c.key} label={c.label} note={[notes[c.key], c.note].filter(Boolean).join("; ")} text={c.text} />
        ))}
      </section>
    </div>
  );
}

interface RowProps {
  m: MachineView;
  health: MachineHealth;
  /** Another machine has the same name, so the start of its id goes beside it. */
  shared: boolean;
  signedIn: boolean;
  serverTime: number;
  now: number;
}

function MachineRow({ m, health, shared, signedIn, serverTime, now }: RowProps) {
  const [detail, setDetail] = useState(false);
  const [remove, setRemove] = useState<"idle" | "ask" | "busy" | "done">("idle");
  const [refused, setRefused] = useState<string | null>(null);
  const state = STATE[m.state];
  const detailId = `mc-detail-${m.id}`;
  const confirm = () => {
    setRemove("busy");
    adminApi.removeMachine(m.id).then(
      () => setRemove("done"),
      (err: unknown) => {
        setRemove("idle");
        setRefused(failure(err));
      },
    );
  };
  const ask = () => {
    setRefused(null);
    setRemove("ask");
  };
  // The row counts the last hour's, as the sidebar's badge does; its detail lists every one the server keeps.
  const turnedAway = lastHour(health.refused, serverTime).length;
  return (
    <>
      <tr>
        <td>
          <span title={state.title}>
            <StationWord kind={state.mark} word={state.word} />
          </span>
        </td>
        <th scope="row">
          <MachineName m={m} shared={shared} />
        </th>
        <td className="mc-n">{m.liveSessions}</td>
        <td>
          <Versions m={m} />
        </td>
        <td className="mc-wrap">
          <Hooks m={m} hooks={health.hooks} />
        </td>
        <td className="mc-n" title={new Date(m.lastReportAt).toLocaleString()}>{`${fmtAge(Math.max(0, serverTime - m.lastReportAt) / 1000)} ago`}</td>
        <td className="mc-act">
          {signedIn ? (
            <button type="button" className="ui-button" disabled={m.state === "reporting" || remove !== "idle"} title={m.state === "reporting" ? "Reporting now" : undefined} onClick={ask}>
              {remove === "done" ? "Removed" : "Remove"}
            </button>
          ) : null}
          <button type="button" className="ui-button mc-more" aria-expanded={detail} aria-controls={detailId} aria-label={turnedAway ? `Details for ${m.name}, ${turnedAway} refused` : `Details for ${m.name}`} onClick={() => setDetail(!detail)}>
            {turnedAway ? <span className="mc-warn" aria-hidden="true">{`${turnedAway} refused`}</span> : null}
            <IconChevron />
          </button>
        </td>
      </tr>
      {remove === "ask" || remove === "busy" || refused ? (
        <tr className="mc-confirm">
          <td colSpan={COLUMNS}>
            {refused ? (
              <span role="alert">{`Could not remove ${m.name}: ${refused}`}</span>
            ) : (
              <>
                <span>{`Remove ${m.name} (${shortId(m.id)})? It returns if it reports again.`}</span>
                <button type="button" className="ui-button ui-button--danger" disabled={remove === "busy"} onClick={confirm}>
                  Remove
                </button>
                <button type="button" className="ui-button" disabled={remove === "busy"} onClick={() => setRemove("idle")}>
                  Keep
                </button>
              </>
            )}
          </td>
        </tr>
      ) : null}
      {detail ? (
        <tr id={detailId} className="mc-detail">
          <td colSpan={COLUMNS}>
            <Detail m={m} health={health} now={now} hour={turnedAway} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Remove silent (N): every silent and not-since-restart machine, after an inline confirmation. */
function RemoveSilent({ count }: { count: number }) {
  const [step, setStep] = useState<"idle" | "ask" | "busy">("idle");
  const [said, setSaid] = useState<string | null>(null);
  const confirm = () => {
    setStep("busy");
    adminApi.removeSilent().then(
      (r) => {
        setStep("idle");
        setSaid(`Removed ${plural(r.removed.length, "machine")}`);
      },
      (err: unknown) => {
        setStep("idle");
        setSaid(`Could not remove: ${failure(err)}`);
      },
    );
  };
  if (step === "idle") {
    return (
      <>
        {said ? <span className="mc-dim" role="status">{said}</span> : null}
        {count > 0 ? (
          <button
            type="button"
            className="ui-button"
            onClick={() => {
              setSaid(null);
              setStep("ask");
            }}
          >
            {`Remove silent (${count})`}
          </button>
        ) : null}
      </>
    );
  }
  return (
    <span className="mc-ask">
      <span>{`Remove ${plural(count, "silent machine")}? They return if they report again.`}</span>
      <button type="button" className="ui-button ui-button--danger" disabled={step === "busy"} onClick={confirm}>
        {`Remove ${count}`}
      </button>
      <button type="button" className="ui-button" disabled={step === "busy"} onClick={() => setStep("idle")}>
        Keep
      </button>
    </span>
  );
}

export const byName = (a: MachineView, b: MachineView) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);

export function MachinesView({ fleet, now, refusals, scope = null }: ViewProps) {
  const signedIn = useRespond()?.me?.signedIn === true;
  const [addOpen, setAddOpen] = useAddDialog();
  const live = Object.values(fleet.sessions);
  const all = [...fleet.machines].sort(byName);
  // The rows of the machines the field's `m:` word picks; every machine without one.
  const machines = scope === null ? all : scopedMachines(scope, all, live);
  // Names compared as the sidebar compares them (FleetApp sidebarMachines).
  const shared = sharedNames([...all.map((m) => ({ machine: m })), ...live]);
  const counts = STATE_ORDER.map((st) => {
    const n = machines.filter((m) => m.state === st).length;
    return n ? `${n} ${STATE[st].word.toLowerCase()}` : null;
  });
  // Remove silent removes every silent machine, listed or not.
  const silent = all.filter((m) => m.state === "silent" || m.state === "restart").length;
  const unattributed = noMachine(refusals, all);
  return (
    <div className="mc">
      <header className="mc-head">
        <div className="ui-view-head">
          <h1>Machines</h1>
          {machines.length ? (
            <p className="ui-view-meta">
              <Dots items={counts} />
            </p>
          ) : null}
        </div>
        <div className="mc-tools">
          {signedIn ? <RemoveSilent count={silent} /> : null}
          <button type="button" className="ui-button ui-button--primary" onClick={() => setAddOpen(true)}>
            Add a machine
          </button>
        </div>
      </header>

      {machines.length ? (
        <div className="mc-scroll">
          <table className="mc-table">
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col">Machine</th>
                <th scope="col" className="mc-n">Sessions</th>
                <th scope="col">Versions</th>
                <th scope="col">Codex hooks</th>
                <th scope="col" className="mc-n">Last report</th>
                <th scope="col"><span className="ui-vh">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => (
                <MachineRow
                  key={m.id}
                  m={m}
                  health={healthOf(m, live, refusals)}
                  shared={shared.has(m.id)}
                  signedIn={signedIn}
                  serverTime={fleet.serverTime}
                  now={now}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ui-empty">{all.length ? `No machine matches ${scope}` : "No machine has reported yet"}</p>
      )}

      {unattributed.length ? (
        <section className="mc-sec">
          <Refused title="refused, no machine" rows={unattributed} now={now} />
          {unattributed.some((r) => r.status === 401) ? (
            <Command label="Install again with the admin secret" text={installCommand(true, true, window.location.origin)} />
          ) : null}
        </section>
      ) : null}

      {addOpen ? <AddMachine machines={fleet.machines} onClose={() => setAddOpen(false)} /> : null}
    </div>
  );
}
