// History (#/history): the sessions that ended or went offline on one day, a page at a time, each with why it ended and its
// /clear lineage; signed in, a stored session can be deleted. A row opens that session's page read-only, its Timeline rebuilt
// from the agents and events the server stored. The day is the server's (useHistory), stepped as a calendar steps it (DayNav).
// The filter field's `m:` word narrows it, on the server, to the machines the word picks on the Fleet (filter.ts scopedMachines).
import { useEffect, useRef, useState } from "react";
import { addDays } from "../../../../../server/src/fleet/days";
import { isKnownProvider } from "../../../../../server/src/fleet/protocol";
import { Cost, ModelChip } from "../../components/Chips";
import { IconChevron } from "../../components/Icons";
import { PageNav } from "../../components/PageNav";
import { SessionIdCopy } from "../../components/SessionId";
import { fmtClock, fmtSpan, plural } from "../../format";
import { adminApi } from "../../respondApi";
import { scopedMachines } from "../../shell/filter";
import { useInspector } from "../../shell/inspector";
import { initialState } from "../../store";
import type { HistoryRow } from "../../types";
import { Unknown } from "../../ui/Unknown";
import { useHotkeys } from "../../useHotkeys";
import { useRespond } from "../../useRespond";
import { endReasonShort, endReasonWords } from "../session/endReason";
import { SessionPage } from "../session/SessionPage";
import { useSessionEvents } from "../session/useSessionEvents";
import { failure, type Load } from "../settings/api";
import type { ViewProps } from "../types";
import "./history.css";
import { PAGE_SIZES, pageSpan, useAddress, useDayPage, useStoredSession, type DayPage, type Go } from "./useHistory";

/** A day as the page names it, "Thu, Nov 5, 2026": the weekday is what a person remembers a day by. */
const DAY_LABEL = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
const dayLabel = (day: string): string => DAY_LABEL.format(new Date(`${day}T00:00:00Z`));

/** Opens a date field's own picker from another control (showPicker); where it cannot, the field takes the focus. */
function openPicker(field: HTMLInputElement | null): void {
  if (!field) return;
  try {
    field.showPicker();
  } catch {
    field.focus();
  }
}

/**
 * The day and the ways to move it, as calendars do: ‹ Today ›, the day as the title, and `t` for today. ‹ and › (← and →) step
 * one day, › resting on the server's today; Today (`t`) goes back to it;
 * the day opens the date field's picker. Each move is a history entry (useHistory go "push"), so Back walks the days. `day` is
 * null until the server has named today's.
 */
function DayNav({ day, today, go }: { day: string | null; today: string | null; go: Go }) {
  const picker = useRef<HTMLInputElement>(null);
  const toDay = (next: string | null) => go({ day: next, page: 1 }, "push");
  const before = day === null ? null : addDays(day, -1);
  const after = day === null || today === null || day >= today ? null : addDays(day, 1);
  const onToday = day === null || day === today;
  // Not while typing, nor while the answer panel is open (useHotkeys); only while the list shows (this is not drawn over a session).
  useHotkeys((e) => {
    if (e.key === "ArrowLeft" && before) toDay(before);
    else if (e.key === "ArrowRight" && after) toDay(after);
    else if ((e.key === "t" || e.key === "T") && !onToday) toDay(null);
    else return;
    e.preventDefault();
  });
  return (
    <nav className="hs-nav" aria-label="Day">
      <button type="button" className="ui-button ui-button--icon" aria-label="The day before" title="The day before (←)" disabled={!before} onClick={() => before && toDay(before)}>
        <IconChevron className="shell-chev-left" />
      </button>
      <button type="button" className="ui-button" title="Today (t)" disabled={onToday} onClick={() => toDay(null)}>
        Today
      </button>
      <button type="button" className="ui-button ui-button--icon" aria-label="The day after" title="The day after (→)" disabled={!after} onClick={() => after && toDay(after)}>
        <IconChevron className="shell-chev-right" />
      </button>
      {day ? (
        <span className="hs-pick">
          <button type="button" className="ui-button" aria-label={`${dayLabel(day)}, pick a day`} title="Pick a day" onClick={() => openPicker(picker.current)}>
            {dayLabel(day)}
            <IconChevron />
          </button>
          {/* The picker's own field, under the button it opens from; clearing it gives an empty value, which keeps the day. */}
          <input ref={picker} type="date" className="hs-pick-field" tabIndex={-1} aria-hidden="true" value={day} max={today ?? undefined} onChange={(e) => e.target.value && e.target.value !== day && toDay(e.target.value)} />
        </span>
      ) : null}
    </nav>
  );
}

/** The server's pages in the one pager: the rows shown, "1 of 3" between the chevrons, and Rows per page. */
function Pager({ page, pageSize, total, onPage, onSize }: { page: number; pageSize: number; total: number; onPage: (n: number) => void; onSize: (n: number) => void }) {
  const { first, last, pages } = pageSpan(page, pageSize, total);
  return (
    <PageNav label="History pages" at={page - 1} pages={pages} from={first - 1} shown={last - first + 1} total={total} perPage={pageSize} onPage={(n) => onPage(n + 1)} compact>
      <label className="sv-field">
        <span>Rows per page</span>
        <select className="ui-select" value={pageSize} onChange={(e) => onSize(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => <option key={n}>{n}</option>)}
        </select>
      </label>
    </PageNav>
  );
}

/** A /clear splits one conversation into two sessions; each part links to the other. */
function Lineage({ r, open }: { r: HistoryRow; open: (id: string) => void }) {
  const links = [
    r.clearedInto && { id: r.clearedInto, title: "Went on after /clear in", text: `After: ${r.clearedInto.slice(0, 8)}` },
    r.clearedFrom && { id: r.clearedFrom, title: "Went on after /clear from", text: `Before: ${r.clearedFrom.slice(0, 8)}` },
  ];
  return (
    <>
      {links.map((link) =>
        link ? (
          <button key={link.id} type="button" className="sv-link hs-lin hs-cut" title={link.title} onClick={() => open(link.id)}>
            {link.text}
          </button>
        ) : null,
      )}
    </>
  );
}

/** The table's columns: Session, Model, Ended, Duration, Est. cost, Auto-compacts, Agents, End reason; then Delete, signed in. */
const COLUMNS = 8;

/**
 * A row: the session's name over its project and its id to copy (the cell that stays in place as the table scrolls), then its
 * figures. The name opens the stored page; the id is its own control beside it, never inside it.
 */
function SessionRow({ r, open, canDelete, onDeleted }: { r: HistoryRow; open: (id: string) => void; canDelete: boolean; onDeleted: () => void }) {
  const [step, setStep] = useState<"idle" | "ask" | "busy">("idle");
  const [refused, setRefused] = useState<string | null>(null);
  const confirm = () => {
    setStep("busy");
    adminApi.deleteSession(r.id).then(onDeleted, (err: unknown) => {
      setStep("idle");
      setRefused(failure(err));
    });
  };
  const why = endReasonShort(r.endReason);
  return (
    <>
      <tr>
        <th scope="row">
          <button type="button" className="sv-link hs-name hs-cut" title={r.name} onClick={() => open(r.id)}>
            {r.name}
          </button>
          <span className="hs-sub">
            {/* Right to left puts the ellipsis at the front of a long path, so its last folders stay in view; bdi keeps its order. */}
            {r.project ? (
              <span className="sv-mono hs-proj" title={r.project}>
                <bdi>{r.project}</bdi>
              </span>
            ) : (
              <Unknown reason="Project not reported" />
            )}
            <SessionIdCopy id={r.nativeId} />
          </span>
        </th>
        {/* A harness the console has no entry for keeps its chip with no model: the chip is where its name shows (Chips ModelChip). */}
        <td>{r.model === null && r.modelFamily === "other" && isKnownProvider(r.provider) ? <Unknown reason="The model was not reported" /> : <ModelChip provider={r.provider} family={r.modelFamily} model={r.model} />}</td>
        <td className="sv-n">{fmtClock(r.endedAt).slice(0, 5)}</td>
        <td className="sv-n">{fmtSpan(r.durationSec)}</td>
        {/* As a card says it (Chips Cost): "—" with the server's reason (HistoryRow.costReason), "$817+" when it leaves out usage;
            an ended session with no usage had none reported, it is not waiting for any. */}
        <td className="sv-n">{r.costReason === "pending" ? <Unknown reason="No usage reported" /> : <Cost s={r} />}</td>
        <td className="sv-n">{r.blowouts === null ? <Unknown reason={r.provider === "codex" ? "Not known: Codex hooks were off" : "Not reported"} /> : r.blowouts}</td>
        <td className="sv-n">{r.agents}</td>
        <td>
          <span className="hs-why hs-cut" title={endReasonWords(r.endReason) ?? undefined}>
            {why ?? <Unknown reason="No end reason was reported" />}
          </span>
          <Lineage r={r} open={open} />
        </td>
        {canDelete ? (
          <td className="hs-act">
            <button
              type="button"
              className="ui-button"
              disabled={step !== "idle"}
              onClick={() => {
                setRefused(null);
                setStep("ask");
              }}
            >
              Delete
            </button>
          </td>
        ) : null}
      </tr>
      {step !== "idle" || refused ? (
        <tr className="hs-confirm">
          <td colSpan={COLUMNS + 1}>
            {refused ? (
              <span role="alert">{`Could not delete ${r.name}: ${refused}`}</span>
            ) : (
              <>
                <span>{`Delete ${r.name} from History?`}</span>
                <button type="button" className="ui-button ui-button--danger" disabled={step === "busy"} onClick={confirm}>
                  Delete
                </button>
                <button type="button" className="ui-button" disabled={step === "busy"} onClick={() => setStep("idle")}>
                  Keep
                </button>
              </>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The page of sessions, or why there is none. */
function DayList({ list, go, canDelete, reload }: { list: Load<DayPage>; go: Go; canDelete: boolean; reload: () => void }) {
  const open = (id: string) => go({ open: id }, "push");
  if (list.state === "loading") return <p className="ui-empty">Loading…</p>;
  if (list.state === "error") return <p className="ui-empty">{`Could not load: ${list.message}`}</p>;
  if (list.data.total === 0) return <p className="ui-empty">{`No sessions ended on ${dayLabel(list.data.day)}`}</p>;
  const { rows, page, pageSize, total } = list.data;
  return (
    <>
      <div className="hs-scroll">
        <table className={canDelete ? "hs-table hs-can-delete" : "hs-table"}>
          {/* Fixed widths for the figures; Session takes the rest up to 420 px, End reason past that (history.css). */}
          <colgroup>
            <col className="hs-w-session" />
            <col className="hs-w-model" />
            <col className="hs-w-ended" />
            <col className="hs-w-dur" />
            <col className="hs-w-cost" />
            <col className="hs-w-blow" />
            <col className="hs-w-agents" />
            <col className="hs-w-end" />
            {canDelete ? <col className="hs-w-act" /> : null}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col">Model</th>
              <th scope="col" className="sv-n">
                Ended
              </th>
              <th scope="col" className="sv-n">
                Duration
              </th>
              <th scope="col" className="sv-n">
                Est. cost
              </th>
              <th scope="col" className="sv-n">
                Auto-compacts
              </th>
              <th scope="col" className="sv-n">
                Agents
              </th>
              <th scope="col">End reason</th>
              {canDelete ? (
                <th scope="col">
                  <span className="ui-vh">Delete</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <SessionRow key={r.id} r={r} open={open} canDelete={canDelete} onDeleted={reload} />
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pageSize={pageSize} total={total} onPage={(n) => go({ page: n })} onSize={(n) => go({ size: n, page: 1 })} />
    </>
  );
}

/** History takes the shell's view props when it has them; a stored session's page needs only their lifecycle settings. */
export function HistoryPage(props: Partial<ViewProps>) {
  const fleet = props.fleet ?? initialState;
  const canDelete = useRespond()?.me?.signedIn === true;
  const [address, go] = useAddress();
  const [reloads, setReloads] = useState(0);
  // The machines the field's `m:` word picks, by the Fleet's rule; null for every machine.
  const scope = props.scope ?? null;
  const picked = scope === null ? null : scopedMachines(scope, fleet.machines, Object.values(fleet.sessions));
  const { list, today } = useDayPage(address, picked?.map((m) => m.id) ?? null, go, reloads);
  // The day shown: the address's, else (today's) the one the server says it holds, once it has said.
  const day = address.day ?? (list.state === "ok" && list.data.asked === null ? list.data.day : null);
  const session = useStoredSession(address.open);
  // History moves between its day and a stored session with pushState and replaceState, which the shell never hears, so a
  // pick of stored session A's agent is dropped here when B opens or the day's list returns.
  const { back: unpick } = useInspector();
  useEffect(() => unpick(), [address.open, unpick]);
  // A stored session gets no more events: only what the server kept.
  const events = useSessionEvents(address.open, null);
  // Back from a session opened here goes back in the browser's history; one opened from a link returns to its day.
  const back = () => {
    if ((window.history.state as { open?: boolean } | null)?.open) window.history.back();
    else go({ open: null });
  };
  const backLink = (
    <button type="button" className="sv-link hs-back" onClick={back}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.2 3L5.2 8l5 5" />
      </svg>
      {`Back to ${day ? dayLabel(day) : "History"}`}
    </button>
  );

  if (session?.state === "ok") return <SessionPage fleet={fleet} session={session.data} now={session.data.lastSeenAt} readOnly back={backLink} events={events} />;
  if (session) {
    return (
      <div className="hs">
        {backLink}
        <p className="ui-empty">{session.state === "loading" ? "Loading…" : `Could not load that session: ${session.message}`}</p>
      </div>
    );
  }
  return (
    <div className="hs">
      <header className="ui-view-head">
        <h1>History</h1>
        <DayNav day={day} today={today} go={go} />
        {list.state === "ok" && picked?.length !== 0 ? <p className="ui-view-meta hs-count">{plural(list.data.total, "session")}</p> : null}
      </header>
      {picked?.length === 0 ? <p className="ui-empty">{`No machine matches ${scope}`}</p> : <DayList list={list} go={go} canDelete={canDelete} reload={() => setReloads((n) => n + 1)} />}
    </div>
  );
}
