// History (#/history): the sessions that ended or went offline on one day, or in a range of days, a page at a time, each with its
// figures, its record's counts, its feedback, why it ended and its /clear lineage; signed in, a stored session can be deleted
// and the range exported. A row opens that session's page read-only, its Timeline rebuilt from the agents and events the server
// stored. The day is the server's (useHistory), stepped as a calendar steps it (DayNav). The filter field narrows the range on
// the server: its `m:` word to the machines it picks on the Fleet (filter.ts scopedMachines), its other words by what a session
// was (historyParams), its plain words by search. Ticked sessions are compared side by side (Compare), their ids in the
// address so a comparison is a link, Group by turns the table into one row a group (Groups), and the page's switch shows the
// errors that recur in their place (Issues.tsx).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { addDays } from "../../../../../server/src/fleet/days";
import { isKnownProvider, type GroupKey } from "../../../../../server/src/fleet/protocol";
import { Cost, ModelChip } from "../../components/Chips";
import { IconChevron } from "../../components/Icons";
import { PageNav } from "../../components/PageNav";
import { SessionIdCopy, SHORT_ID } from "../../components/SessionId";
import { fmtClock, fmtPct, fmtSpan, fmtUsd, fmtWhen, plural } from "../../format";
import { familyName } from "../../logic";
import { providerInfo } from "../../provider";
import { adminApi } from "../../respondApi";
import { scopedMachines } from "../../shell/filter";
import { useInspector } from "../../shell/inspector";
import { initialState } from "../../store";
import type { HistoryGroup, HistoryRow, RecordCounts } from "../../types";
import { dotsText } from "../../ui/Dots";
import { Unknown } from "../../ui/Unknown";
import { useHotkeys } from "../../useHotkeys";
import { useReadsKept, useRespond } from "../../useRespond";
import { Select } from "../now/controls";
import { endReasonShort, endReasonWords } from "../session/endReason";
import { SessionPage } from "../session/SessionPage";
import { useSessionEvents } from "../session/useSessionEvents";
import { failure, type Load } from "../settings/api";
import type { ViewProps } from "../types";
import "./history.css";
import { Issues, useIssues } from "./Issues";
import { historyQuery, PAGE_SIZES, pageSpan, readSessions, useAddress, useDayPage, useStoredSession, type DayPage, type Go, type HistoryView } from "./useHistory";

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

/** Whole days from one day to a later one. */
const daysFrom = (day: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);

/** The range as the page names it: its day, or its first and last. */
const spanLabel = (day: string, to: string | null): string => (to ? `${dayLabel(day)} – ${dayLabel(to)}` : dayLabel(day));

/** A day as a button that opens a date field's own picker; the field itself lies unseen under it. With no day it reads `empty`. */
function DayPick({ value, empty = "", title, min, max, disabled = false, onPick }: { value: string | null; empty?: string; title: string; min?: string; max?: string; disabled?: boolean; onPick: (day: string) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const shown = value ? dayLabel(value) : empty;
  return (
    <span className="hs-pick">
      <button type="button" className="ui-button" aria-label={`${shown}, ${title}`} title={title} disabled={disabled} onClick={() => openPicker(picker.current)}>
        {shown}
        <IconChevron />
      </button>
      <input ref={picker} type="date" className="hs-pick-field" tabIndex={-1} aria-hidden="true" value={value ?? ""} min={min} max={max} onChange={(e) => onPick(e.target.value)} />
    </span>
  );
}

/**
 * The day, or the range from it to a last day, and the ways to move it, as calendars do: ‹ Today ›, the day as the title, and `t`
 * for today. ‹ and › (← and →) step by the range's length, one day without a range, › no further once the range reaches the
 * server's today; Today (`t`) goes back to it and to one day. The day opens its date field's picker; the second date sets the
 * range's last day, and cleared, or set to the day itself, leaves one day. Each move is a history entry (useHistory go "push"),
 * so Back walks them. `day` is null until the server has named today's.
 */
function DayNav({ day, to, today, go }: { day: string | null; to: string | null; today: string | null; go: Go }) {
  const move = (next: string | null, last: string | null = null) => go({ day: next, to: last, page: 1 }, "push");
  const length = day !== null && to !== null ? daysFrom(day, to) + 1 : 1;
  const shift = (n: number) => day !== null && move(addDays(day, n), to === null ? null : addDays(to, n));
  const after = day !== null && today !== null && (to ?? day) < today;
  const onToday = to === null && (day === null || day === today);
  const days = length === 1 ? "day" : `${length} days`;
  // Not while typing, nor while the answer panel is open (useHotkeys); only while the list shows (this is not drawn over a session).
  useHotkeys((e) => {
    if (e.key === "ArrowLeft" && day !== null) shift(-length);
    else if (e.key === "ArrowRight" && after) shift(length);
    else if ((e.key === "t" || e.key === "T") && !onToday) move(null);
    else return;
    e.preventDefault();
  });
  return (
    <nav className="hs-nav" aria-label="Day">
      <button type="button" className="ui-button ui-button--icon" aria-label={`The ${days} before`} title={`The ${days} before (←)`} disabled={day === null} onClick={() => shift(-length)}>
        <IconChevron className="shell-chev-left" />
      </button>
      <button type="button" className="ui-button" title="Today (t)" disabled={onToday} onClick={() => move(null)}>
        Today
      </button>
      <button type="button" className="ui-button ui-button--icon" aria-label={`The ${days} after`} title={`The ${days} after (→)`} disabled={!after} onClick={() => shift(length)}>
        <IconChevron className="shell-chev-right" />
      </button>
      {day ? (
        <>
          {/* Clearing the first field gives an empty value, which keeps the day; a day past the range's last ends the range. */}
          <DayPick value={day} title="Pick a day" max={today ?? undefined} onPick={(v) => v && v !== day && move(v, to !== null && to > v ? to : null)} />
          <span className="hs-pick" aria-hidden="true">
            –
          </span>
          <DayPick value={to} empty="to" title="Pick the range's last day" min={day} max={today ?? undefined} disabled={today === null || day >= today} onPick={(v) => v !== (to ?? "") && move(day, v > day ? v : null)} />
        </>
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

/** The table's columns: the tick, Session, Model, Ended, Duration, Est. cost, Auto-compacts, Agents, Turns, Tool calls, Failed, End reason, Feedback; then Delete, signed in. */
const COLUMNS = 13;
const NO_RECORD = "No record kept";
const NO_OUTCOME = "No tool call's outcome was reported";
/** The one line under a comparison and under groups. */
const NOT_PROOF = "Differences between sessions that did different work are not proof of an improvement.";

/** One piece of feedback in words: its tag with its value or score, as a History group names it (server history.ts keysOf). */
const feedbackWords = (f: HistoryRow["feedback"][number]): string => (f.value !== null ? `${f.key}: ${f.value}` : f.score !== null ? `${f.key}: ${f.score}` : f.key);
const noCompacts = (r: HistoryRow): string => (r.provider === "codex" ? "Not known: Codex hooks were off" : "Not reported");
/**
 * A session's failed tool calls where the count is exact; null where it is not: with no record, and where a reporter did not give
 * the outcome of every tool call (RecordCounts.knownCalls: Hermes gives none, Codex only a command's), so more may have failed.
 */
const failedOf = (r: HistoryRow): number | null => (r.record === null || r.record.knownCalls < r.record.toolCalls ? null : r.record.failedCalls);

/**
 * A session's failed tool calls as the list and a comparison print them: the count; "—" with its reason with no record, or with no
 * tool call's outcome known, which is not 0 failed; and with some known and some not, the count as a cost that leaves out usage is
 * written (Chips Cost), "3+", with how many outcomes are known as its title and for a screen reader.
 */
function Failed({ r }: { r: HistoryRow }) {
  const exact = failedOf(r);
  if (exact !== null) return <>{exact}</>;
  if (!r.record?.knownCalls) return <Unknown reason={r.record ? NO_OUTCOME : NO_RECORD} />;
  const why = `${r.record.knownCalls} of ${r.record.toolCalls} tool calls reported how they ended`;
  return (
    <span title={why}>
      {`${r.record.failedCalls}+`}
      <span className="ui-vh">{` (${why})`}</span>
    </span>
  );
}

/**
 * A session's est. cost as a card says it (Chips Cost): "—" with the server's reason (HistoryRow.costReason), "$817+" when it
 * leaves out usage; an ended session with no usage had none reported, it is not waiting for any.
 */
function CostCell({ r }: { r: HistoryRow }) {
  return r.costReason === "pending" ? <Unknown reason="No usage reported" /> : <Cost s={r} />;
}

type Open = (id: string, step?: string | null) => void;
type Ticks = { rows: readonly HistoryRow[]; toggle: (r: HistoryRow) => void };

/** A session's tick for Compare: in its row, and over its column of the comparison. */
function Tick({ r, ticks }: { r: HistoryRow; ticks: Ticks }) {
  return <input type="checkbox" aria-label={`Compare ${r.name}`} checked={ticks.rows.some((t) => t.id === r.id)} onChange={() => ticks.toggle(r)} />;
}

/**
 * A row: its tick, the session's name over its project and its id to copy (the cells that stay in place as the table scrolls),
 * then its figures. The name opens the stored page, at the row a search found its phrase in when it names one; the id is its
 * own control beside it, never inside it. In a range of days (`ranged`) Ended says its day too, as Issues says a moment.
 */
function SessionRow({ r, open, ticks, ranged, canDelete, onDeleted }: { r: HistoryRow; open: Open; ticks: Ticks; ranged: boolean; canDelete: boolean; onDeleted: (id: string) => void }) {
  const [step, setStep] = useState<"idle" | "ask" | "busy">("idle");
  const [refused, setRefused] = useState<string | null>(null);
  const confirm = () => {
    setStep("busy");
    adminApi.deleteSession(r.id).then(
      () => onDeleted(r.id),
      (err: unknown) => {
        setStep("idle");
        setRefused(failure(err));
      },
    );
  };
  const why = endReasonShort(r.endReason);
  return (
    <>
      <tr>
        <td className="hs-tick">
          <Tick r={r} ticks={ticks} />
        </td>
        <th scope="row">
          <button type="button" className="sv-link hs-name hs-cut" title={r.name} onClick={() => open(r.id, r.match?.rowId)}>
            {r.name}
          </button>
          {r.match?.snippet ? (
            <div className="hs-cut sv-muted" title={r.match.snippet}>
              {r.match.snippet}
            </div>
          ) : null}
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
        <td className="sv-n hs-when">{ranged ? fmtWhen(r.endedAt) : fmtClock(r.endedAt).slice(0, 5)}</td>
        <td className="sv-n">{fmtSpan(r.durationSec)}</td>
        <td className="sv-n">
          <CostCell r={r} />
        </td>
        <td className="sv-n">{r.blowouts ?? <Unknown reason={noCompacts(r)} />}</td>
        <td className="sv-n">{r.agents}</td>
        {(["turns", "toolCalls"] as const).map((k) => (
          <td key={k} className="sv-n">
            {r.record ? r.record[k] : <Unknown reason={NO_RECORD} />}
          </td>
        ))}
        <td className="sv-n">
          <Failed r={r} />
        </td>
        <td>
          <span className="hs-why hs-cut" title={endReasonWords(r.endReason) ?? undefined}>
            {why ?? <Unknown reason="No end reason was reported" />}
          </span>
          <Lineage r={r} open={open} />
        </td>
        {/* Its tags, each once; with their scores and values on hover. */}
        <td>
          <div className="hs-cut" title={dotsText(r.feedback.map(feedbackWords))}>
            {dotsText([...new Set(r.feedback.map((f) => f.key))])}
          </div>
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

const GROUPS: Record<GroupKey | "none", string> = { none: "None", day: "Day", week: "Week", model: "Model", engine: "Harness version", project: "Project", machine: "Machine", feedback: "Feedback" };
const TYPICAL = "The median of the group's sessions that have the figure";

/**
 * A group as its row names it, from the server's key for it (history.ts keysOf), which is the row's title: a day and a week (its
 * Monday) as days read; a model by its name, which is its key; and a harness with its version as Compare names one (its key: the
 * harness's name, a space, the version or "—"; a harness's name has no space).
 */
function groupName(by: GroupKey, key: string): string {
  if (by === "day" || by === "week") return dayLabel(key);
  const cut = key.indexOf(" ");
  return by === "engine" && cut > 0 ? `${providerInfo(key.slice(0, cut)).app}${key.slice(cut)}` : key;
}

/** The range's sessions as groups (HistoryGroup), one row each: how many, and what one typically took. */
function Groups({ by, rows }: { by: GroupKey; rows: HistoryGroup[] }) {
  return (
    <>
      <div className="hs-scroll">
        <table className="hs-table">
          <colgroup>
            <col />
            <col className="hs-w-dur" />
            <col className="hs-w-model" />
            <col className="hs-w-model" />
            <col className="hs-w-end" />
            <col className="hs-w-model" />
            <col className="hs-w-blow" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">{GROUPS[by]}</th>
              <th scope="col" className="sv-n">
                Sessions
              </th>
              {["Typical duration", "Typical est. cost", "Typical turns", "Typical tool calls"].map((name) => (
                <th key={name} scope="col" className="sv-n" title={TYPICAL}>
                  {name}
                </th>
              ))}
              <th scope="col" className="sv-n" title="Its failed tool calls over its tool calls whose outcome is known">
                Failed share
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.key}>
                <th scope="row">
                  <div className="hs-cut" title={g.key}>
                    {groupName(by, g.key)}
                  </div>
                </th>
                <td className="sv-n">{g.sessions}</td>
                <td className="sv-n">{fmtSpan(g.durationSec)}</td>
                {/* As a session's cost reads (Chips Cost): "$817+" where a cost it was taken from leaves out unpriced usage. */}
                <td className="sv-n">{g.costUsd === null ? <Unknown reason="No session in the group has a cost" /> : <Cost s={{ costUsd: g.costUsd, costPartial: g.costPartial, costReason: null, model: null }} />}</td>
                <td className="sv-n">{g.turns ?? <Unknown reason={NO_RECORD} />}</td>
                <td className="sv-n">{g.toolCalls ?? <Unknown reason={NO_RECORD} />}</td>
                <td className="sv-n">{g.failedShare === null ? <Unknown reason={g.toolCalls === null ? NO_RECORD : NO_OUTCOME} /> : fmtPct(g.failedShare * 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ui-empty">{NOT_PROOF}</p>
    </>
  );
}

/** A figure Compare sets side by side: a session's value (null: unknown, for `why`; none where there is no `why`), how a number is written, and its cell where that is not the value alone. */
interface Figure {
  name: string;
  of: (r: HistoryRow) => number | string | null;
  fmt?: (n: number) => string;
  why?: (r: HistoryRow) => string;
  cell?: (r: HistoryRow) => ReactNode;
}
const counted = (name: string, key: keyof RecordCounts): Figure => ({ name, of: (r) => r.record?.[key] ?? null, why: () => NO_RECORD });
const FIGURES: readonly Figure[] = [
  // As its harness names it, as its chip in the list is: two ids of one model (a dated one, one with a context suffix) are one model.
  { name: "Model", of: (r) => (r.model === null ? null : familyName(r.modelFamily, r.model)), why: () => "The model was not reported" },
  { name: "Harness version", of: (r) => (r.engineVersion === null ? null : `${providerInfo(r.provider).app} ${r.engineVersion}`), why: () => "Not reported" },
  { name: "Commit", of: (r) => r.commit?.slice(0, SHORT_ID) ?? null, why: () => "Not reported" },
  { name: "Duration", of: (r) => r.durationSec, fmt: fmtSpan },
  // As a failed count below: a cost that leaves out usage ("$817+") is shown and not compared.
  { name: "Est. cost", of: (r) => (r.costPartial ? null : r.costUsd), fmt: fmtUsd, cell: (r) => <CostCell r={r} /> },
  { name: "Auto-compacts", of: (r) => r.blowouts, why: noCompacts },
  { name: "Agents", of: (r) => r.agents },
  counted("Turns", "turns"),
  counted("Model requests", "requests"),
  counted("Tool calls", "toolCalls"),
  // Only an exact count is compared: beside a "+" the amount of a difference is not known.
  { name: "Failed calls", of: failedOf, cell: (r) => <Failed r={r} /> },
  { name: "End reason", of: (r) => endReasonShort(r.endReason), why: () => "No end reason was reported" },
  { name: "Feedback", of: (r) => dotsText(r.feedback.map(feedbackWords)) || null },
];

/**
 * A value's difference from the baseline's: a number as a signed amount, a category as "from → to", and nothing where the two
 * are equal (or apart by less than the figure is written to) or either is unknown.
 */
function difference(from: number | string | null, to: number | string | null, fmt: (n: number) => string): string | null {
  if (from === null || to === null || from === to) return null;
  if (typeof from !== "number" || typeof to !== "number") return `${from} → ${to}`;
  const amount = fmt(Math.abs(to - from));
  return amount === fmt(0) ? null : `${to > from ? "+" : "−"}${amount}`;
}

/**
 * Compare: one column a ticked session, the first ticked the baseline, one row a figure. Each other cell shows its difference
 * from the baseline: a number as its value, then the signed amount, muted; a category as "from → to", the baseline's value and
 * the arrow muted and its own in ink, each said once, the pair the cell's title too; and its value alone where the two are
 * equal or either is unknown. A column's tick takes its session out of the comparison.
 */
function Compare({ ticks, open }: { ticks: Ticks; open: Open }) {
  const base = ticks.rows[0]!;
  return (
    <>
      <div className="hs-scroll">
        {/* The figures' names, then a column a session, each at least 200 px. */}
        <table className="hs-table" style={{ minWidth: 136 + ticks.rows.length * 200 }}>
          <colgroup>
            <col className="hs-w-model" />
            {ticks.rows.map((r) => (
              <col key={r.id} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">
                <span className="ui-vh">Figure</span>
              </th>
              {ticks.rows.map((r) => (
                <th key={r.id} scope="col">
                  <button type="button" className="sv-link hs-name hs-cut" title={r.name} onClick={() => open(r.id)}>
                    {r.name}
                  </button>
                  <span className="hs-sub">
                    <Tick r={r} ticks={ticks} />
                    {r === base ? "Baseline" : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FIGURES.map(({ name, of, fmt = String, why, cell }) => (
              <tr key={name}>
                <th scope="row" className="sv-muted">
                  {name}
                </th>
                {ticks.rows.map((r) => {
                  const from = of(base);
                  const value = of(r);
                  const differs = r === base ? null : difference(from, value, fmt);
                  const pair = differs !== null && typeof value === "string";
                  const shown = cell ? cell(r) : typeof value === "number" ? fmt(value) : (value ?? (why ? <Unknown reason={why(r)} /> : null));
                  return (
                    <td key={r.id}>
                      {/* A pair too long for its column is cut from its front, as a project's path is (hs-proj): the baseline's
                          value, whole in its own column, gives way, and this session's stays. */}
                      <div className={pair ? "hs-cut hs-front" : "hs-cut"} title={differs ?? (typeof value === "string" ? value : undefined)}>
                        <bdi>
                          {pair ? <span className="sv-muted">{`${String(from)} → `}</span> : null}
                          {shown}
                          {differs && !pair ? <span className="sv-muted">{` ${differs}`}</span> : null}
                        </bdi>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ui-empty">{NOT_PROOF}</p>
    </>
  );
}

/** The page of sessions, their groups while the list is grouped, or why there is none. */
function DayList({ list, to, narrowed, go, open, ticks, canDelete, onDeleted }: { list: Load<DayPage>; to: string | null; narrowed: boolean; go: Go; open: Open; ticks: Ticks; canDelete: boolean; onDeleted: (id: string) => void }) {
  if (list.state === "loading") return <p className="ui-empty">Loading…</p>;
  if (list.state === "error") return <p className="ui-empty">{`Could not load: ${list.message}`}</p>;
  // With the filter's words in force, the Fleet's own words for it.
  if (list.data.total === 0) return <p className="ui-empty">{narrowed ? "No matches" : `No sessions ended ${to ? `from ${dayLabel(list.data.day)} to ${dayLabel(to)}` : `on ${dayLabel(list.data.day)}`}`}</p>;
  if (list.data.groups) return <Groups {...list.data.groups} />;
  const { rows, page, pageSize, total } = list.data;
  return (
    <>
      <div className="hs-scroll">
        <table className={`hs-table hs-list${canDelete ? " hs-can-delete" : ""}${to ? " hs-range" : ""}`}>
          {/* Fixed widths for the tick and the figures, Ended wider in a range, for its day; Session takes the rest up to 420 px, End reason past that (history.css). */}
          <colgroup>
            <col className="hs-w-tick" />
            <col className="hs-w-session" />
            <col className="hs-w-model" />
            <col className={to ? "hs-w-day" : "hs-w-ended"} />
            <col className="hs-w-dur" />
            <col className="hs-w-cost" />
            <col className="hs-w-blow" />
            <col className="hs-w-agents" />
            <col className="hs-w-ended" />
            <col className="hs-w-calls" />
            <col className="hs-w-ended" />
            <col className="hs-w-end" />
            <col className="hs-w-fb" />
            {canDelete ? <col className="hs-w-act" /> : null}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="hs-tick">
                <span className="ui-vh">Compare</span>
              </th>
              <th scope="col">Session</th>
              <th scope="col">Model</th>
              {["Ended", "Duration", "Est. cost", "Auto-compacts", "Agents", "Turns", "Tool calls", "Failed"].map((name) => (
                <th key={name} scope="col" className="sv-n">
                  {name}
                </th>
              ))}
              <th scope="col">End reason</th>
              <th scope="col">Feedback</th>
              {canDelete ? (
                <th scope="col">
                  <span className="ui-vh">Delete</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <SessionRow key={r.id} r={r} open={open} ticks={ticks} ranged={to !== null} canDelete={canDelete} onDeleted={onDeleted} />
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
  const signedIn = useRespond()?.me?.signedIn === true;
  const readsKept = useReadsKept();
  const [address, go, back] = useAddress();
  const [reloads, setReloads] = useState(0);
  // The sessions ticked for Compare, in the order ticked (the first is the baseline): the rows themselves, so a tick outlives its
  // page and the filter. Compare puts their ids in the address, a step in the browser's history as an opened session is, so a
  // reload, a link, Back and Forward all show that comparison: the rows the page holds stand as they are and the rest are read by
  // id (readSessions), and the ticks become its sessions, so the list shows them ticked when the reader goes back to it. An id
  // the server does not return is left out, of the comparison and of its address, in place, as a refused day is (useHistory
  // correctDay); with fewer than two left the address is the list's.
  const [ticked, setTicked] = useState<HistoryRow[]>([]);
  const ticks: Ticks = { rows: ticked, toggle: (r) => setTicked((was) => (was.some((t) => t.id === r.id) ? was.filter((t) => t.id !== r.id) : [...was, r])) };
  const compared = address.compare;
  const key = compared.join("\u0000");
  const held = new Map(ticked.map((t) => [t.id, t]));
  // The comparison's columns, once the page holds every one.
  const columns = compared.every((id) => held.has(id)) ? compared.map((id) => held.get(id)!) : null;
  const [unread, setUnread] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    if (compared.length === 0 || ticked.map((t) => t.id).join("\u0000") === key) return undefined;
    if (columns) return setTicked(columns);
    let current = true;
    setUnread(null);
    readSessions(compared.filter((id) => !held.has(id))).then(
      (got) => {
        if (!current) return;
        const byId = new Map([...held, ...got.map((r) => [r.id, r] as const)]);
        const found = compared.flatMap((id) => byId.get(id) ?? []);
        setTicked(found);
        if (found.length < compared.length) go({ compare: found.length > 1 ? found.map((t) => t.id) : [] });
      },
      (err: unknown) => current && setUnread({ key, message: failure(err) }),
    );
    return () => {
      current = false;
    };
    // The ticks are this render's, whose address named these sessions; `go` reads the latest address through a ref.
  }, [key]);
  // The machines the field's `m:` word picks, by the Fleet's rule; null for every machine.
  const scope = props.scope ?? null;
  const picked = scope === null ? null : scopedMachines(scope, fleet.machines, Object.values(fleet.sessions));
  const machines = picked?.map((m) => m.id) ?? null;
  const words = props.query ?? "";
  const { list, today } = useDayPage(address, machines, words, go, reloads, readsKept);
  // What the list asks for, less its paging: what Export downloads, and whether the field's words narrow the range.
  const query = historyQuery(address, machines, words);
  const narrowed = query !== null && [...query.keys()].some((k) => k !== "day" && k !== "to" && k !== "machine");
  // The day shown: the address's, else (today's) the one the server says it holds, once it has said.
  const day = address.day ?? (list.state === "ok" && list.data.asked === null ? list.data.day : null);
  const session = useStoredSession(address.open);
  // History moves between its day and a stored session with pushState and replaceState, which the shell never hears, so a
  // pick of stored session A's agent is dropped here when B opens or the day's list returns.
  const { back: unpick } = useInspector();
  useEffect(() => unpick(), [address.open, unpick]);
  // A stored session gets no more events: only what the server kept.
  const events = useSessionEvents(address.open, null);
  const onIssues = address.view === "issues";
  const issues = useIssues(address.open !== null ? null : onIssues ? "list" : "count", readsKept);
  // A session opened out of a comparison is the step after it: Back returns to the comparison, and its link says so.
  const open: Open = (id, step = null) => go({ open: id, step }, "push");
  // The way back to the list, over what stands in its place: a stored session's page or a comparison. The top bar hides its filter
  // field while this link shows (shell.css .hs-back): no word of it narrows either.
  const backLink = (onBack: () => void, to = day ? spanLabel(day, address.to) : "History") => (
    <button type="button" className="sv-link hs-back" onClick={onBack}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.2 3L5.2 8l5 5" />
      </svg>
      {`Back to ${to}`}
    </button>
  );
  const onDeleted = (id: string) => {
    setTicked((was) => was.filter((t) => t.id !== id));
    setReloads((n) => n + 1);
  };

  // Back from a session opened here goes back in the browser's history; one opened from a link returns to its day, or to the
  // comparison it was opened out of (useHistory back).
  const toSession = backLink(() => back({ open: null, step: null }), compared.length > 0 ? "the comparison" : undefined);
  if (session?.state === "ok") return <SessionPage fleet={fleet} session={session.data} now={session.data.lastSeenAt} readOnly back={toSession} events={events} step={address.step} />;
  if (session) {
    return (
      <div className="hs">
        {toSession}
        <p className="ui-empty">{session.state === "loading" ? "Loading…" : `Could not load that session: ${session.message}`}</p>
      </div>
    );
  }
  if (compared.length > 0) {
    // Its way back to the list, and a column's tick taken out, which takes that session out of the address in place; down to
    // one the comparison ends, by the same rule as its link (useHistory back).
    const untick = (r: HistoryRow) => {
      const left = columns!.filter((t) => t.id !== r.id);
      setTicked(left);
      if (left.length > 1) go({ compare: left.map((t) => t.id) });
      else back({ compare: [] });
    };
    return (
      <div className="hs">
        {backLink(() => back({ compare: [] }))}
        {columns ? <Compare ticks={{ rows: columns, toggle: untick }} open={open} /> : <p className="ui-empty">{unread?.key === key ? `Could not load: ${unread.message}` : "Loading…"}</p>}
      </div>
    );
  }
  // Sessions or Issues, the page's one switch, Issues with how many are open (of them all, not of those listed) once that is known.
  const views: Record<HistoryView, string> = { sessions: "Sessions", issues: issues.open === null ? "Issues" : `Issues ${issues.open}` };
  const switcher = (
    <div className="ui-segment-options" role="group" aria-label="Show">
      {(Object.keys(views) as HistoryView[]).map((view) => (
        <button key={view} type="button" aria-pressed={address.view === view} onClick={() => address.view !== view && go({ view, issue: null }, "push")}>
          {views[view]}
        </button>
      ))}
    </div>
  );
  if (onIssues) {
    // The top bar hides its filter field while this shows (shell.css): no word of it narrows the issues.
    return (
      <div className="hs hs-issues">
        <header className="ui-view-head">
          <h1>History</h1>
        </header>
        <Issues {...issues} opened={address.issue} go={go} lead={switcher} />
      </div>
    );
  }
  return (
    <div className="hs">
      <header className="ui-view-head">
        <h1>History</h1>
        <DayNav day={day} to={address.to} today={today} go={go} />
        {list.state === "ok" && picked?.length !== 0 ? <p className="ui-view-meta hs-count">{plural(list.data.total, "session")}</p> : null}
      </header>
      <div className="sv-bar">
        {switcher}
        <Select<GroupKey | "none"> label="Group by" options={GROUPS} value={address.group ?? "none"} onChange={(by) => go({ group: by === "none" ? null : by, page: 1 })} />
        <button type="button" className="ui-button" disabled={ticked.length < 2} title={ticked.length < 2 ? "Tick two or more sessions" : undefined} onClick={() => go({ compare: ticked.map((t) => t.id) }, "push")}>
          {ticked.length > 0 ? `Compare ${ticked.length}` : "Compare"}
        </button>
        {signedIn && query ? (
          <a className="ui-button" href={adminApi.exportUrl(query.toString())} download>
            Export
          </a>
        ) : null}
      </div>
      {picked?.length === 0 ? (
        <p className="ui-empty">{`No machine matches ${scope}`}</p>
      ) : (
        <DayList list={list} to={address.to} narrowed={narrowed} go={go} open={open} ticks={ticks} canDelete={signedIn} onDeleted={onDeleted} />
      )}
    </div>
  );
}
