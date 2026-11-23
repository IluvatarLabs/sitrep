// Issues, History's second view: the errors that recur, each the failed tool calls that share one error, open ones
// first and most sessions first, the closed ones when asked for. A row opens in place, its key in the address (so a failed
// call's link lands on it): what it was last closed as, the first lines of its newest kept input and output where the reader
// may read them, its newest occurrences, each a link to its session at the failing call, and Copy brief, the issue as Markdown
// for the reader's own agent; signed in, Claim (the first wins, and there is no release), Close as resolved or Incorrectly
// flagged with an optional reason, and Reopen. The list and an open issue are read once who the reader is has been checked,
// when their right to read kept text changes (useReadsKept), after each action and every 30 s while it shows; how many are open,
// the number on the view's switch, is read with it, and alone beside History's sessions. The server lists 500 at most: the
// list says so, and an issue the address opens is read by its key.
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { LIMITS } from "../../../../../server/src/fleet/protocol";
import { stepHash } from "../../../route";
import { SHORT_ID, useCopy } from "../../components/SessionId";
import { fmtCount, fmtWhen, plural } from "../../format";
import { modelIdName } from "../../logic";
import { adminApi, RespondError } from "../../respondApi";
import type { IssueDetail, IssueView } from "../../types";
import { Dots, dotsText } from "../../ui/Dots";
import { usePageVisible } from "../../usePageVisible";
import { useReadsKept, useRespond } from "../../useRespond";
import { Texts } from "../session/Turns";
import { failure, getJson, type Load } from "../settings/api";
import type { Go } from "./useHistory";

const EVERY_MS = 30_000;
const STATUS: Record<IssueView["status"], string> = { open: "Open", resolved: "Resolved", flagged: "Incorrectly flagged" };

/**
 * Whether the first check of who the reader is has settled, answered or failed (useRespond `checked`; outside the provider there
 * is none to wait for). The list and an open issue read kept text only for a reader who may, so each waits for it: else a
 * signed-in reader's first read is made signed out ("Sign in to read the error") and made again.
 */
const useReaderKnown = (): boolean => useRespond()?.checked !== false;
const isOpen = (i: IssueView): boolean => i.status === "open";
const statusText = (i: IssueView): string => dotsText([STATUS[i.status], i.recurred ? "recurred" : null]);
/**
 * An issue's error: its first line where its text was kept and the reader may read it. Kept and not given: that a sign-in reads
 * it, and to a reader who may read kept text nothing (the issue in hand was read before they could, or the server had no line
 * of it to give). Else that none was kept.
 */
const errorText = (i: IssueView, readsKept: boolean): string => i.error ?? (i.errorKept ? (readsKept ? "" : "Sign in to read the error") : "error text not kept");
/** Its last close in words: as what, by whom, when, and why when a reason was given. */
const closeText = ({ as, by, at, reason }: NonNullable<IssueView["closed"]>): string => `Closed as ${STATUS[as].toLowerCase()} by ${by}, ${fmtWhen(at)}${reason ? `: ${reason}` : ""}`;

/**
 * GET /issues?state=all: the issues seen in two or more sessions (with `&once`, those seen in one too), the open ones first;
 * how many there are in all; and how many are seen in one session.
 */
type Listed = { issues: IssueView[]; total: number; once: number };

export interface IssuesRead {
  list: Load<Listed>;
  /** How many issues seen in two or more sessions are open, of them all and not of those listed; null until the server has said. */
  open: number | null;
  /** Whether the list holds the issues seen in one session too, and the switch for it. */
  once: boolean;
  showOnce: (on: boolean) => void;
  /** Counts the reads asked for, so an open issue's detail is read again with the list. */
  round: number;
  reload: () => void;
}

/**
 * The issues, for what History shows: how many are open (`GET /issues?count`, which reads no text), and with `list` the list
 * too; `count` is that number alone, beside its sessions; null while it shows neither (a stored session's page), and then
 * nothing is read. Read whenever that changes; while the list shows, once who the reader is has been checked and when their
 * right to read kept text changes, and in a visible tab every 30 s and on `reload`.
 */
export function useIssues(showing: "list" | "count" | null, readsKept: boolean): IssuesRead {
  const visible = usePageVisible();
  const [list, setList] = useState<Load<Listed>>({ state: "loading" });
  const [open, setOpen] = useState<number | null>(null);
  const [round, setRound] = useState(0);
  const [once, showOnce] = useState(false);
  // The list gives an error's text only to a reader who may read kept text, so it waits until who the reader is has been checked
  // (useReaderKnown) and is read again when that right changes; the count is the same for everyone.
  const known = useReaderKnown();
  const reader = showing === "list" && readsKept;
  const waiting = showing === "list" && !known;
  useEffect(() => {
    if (showing === null || waiting) return undefined;
    let current = true;
    // A read that fails leaves the last number, and the last list, standing.
    getJson<{ open: number }>("/issues?count").then(
      (r) => current && setOpen(r.open),
      () => undefined,
    );
    if (showing === "list") {
      getJson<Listed>(`/issues?state=all${once ? "&once" : ""}`).then(
        (r) => current && setList({ state: "ok", data: r }),
        (err: unknown) => current && setList((was) => (was.state === "ok" ? was : { state: "error", message: failure(err) })),
      );
    }
    return () => {
      current = false;
    };
  }, [showing, round, reader, once, waiting]);
  useEffect(() => {
    if (showing !== "list" || !visible) return undefined;
    const timer = setInterval(() => setRound((n) => n + 1), EVERY_MS);
    return () => clearInterval(timer);
  }, [showing, visible]);
  return { list, open, once, showOnce, round, reload: () => setRound((n) => n + 1) };
}

/**
 * The issue the address opens, read by its key, so one the list does not hold opens as a listed one does; read once who the
 * reader is has been checked (useReaderKnown), again with each round and when the reader's right to read kept text changes, a
 * read that fails leaving its last detail standing. Null while none is open.
 */
function useOpened(key: string | null, round: number, readsKept: boolean): Load<IssueDetail> | null {
  const [got, setGot] = useState<{ key: string; load: Load<IssueDetail> } | null>(null);
  const known = useReaderKnown();
  useEffect(() => {
    if (key === null || !known) return undefined;
    let current = true;
    getJson<IssueDetail>(`/issues/${encodeURIComponent(key)}`).then(
      (d) => current && setGot({ key, load: { state: "ok", data: d } }),
      (err: unknown) => current && setGot((was) => (was?.key === key && was.load.state === "ok" ? was : { key, load: { state: "error", message: failure(err) } })),
    );
    return () => {
      current = false;
    };
  }, [key, round, readsKept, known]);
  if (key === null) return null;
  return got?.key === key ? got.load : { state: "loading" };
}

/** That an issue's occurrences are its newest and not all of its failed calls: the server gives 50 at most (fleet.ts issue). Null when they are all. */
const newestOnly = ({ issue, occurrences }: IssueDetail): string | null => (occurrences.length < issue.calls ? `The newest ${occurrences.length} of ${fmtCount(issue.calls)} failed calls` : null);

/** A text in a code fence longer than any run of backticks in it. */
function fenced(text: string): string {
  const fence = "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * The issue as Markdown: its tool, error, counts, status and reason; each occurrence's time, session, project, model,
 * harness version, commit and resume command, what was not reported left out, under the page's own line where they are not all
 * of its failed calls; and the newest kept input and output.
 */
function briefOf(detail: IssueDetail, readsKept: boolean): string {
  const { issue: i, occurrences, input, output } = detail;
  const cut = newestOnly(detail);
  const lines = [
    `# Issue: ${i.tool}`,
    "",
    `- Tool: ${i.tool}`,
    `- Error: ${errorText(i, readsKept)}`,
    `- Seen: ${plural(i.calls, "failed call")} in ${plural(i.sessions, "session")}, first ${fmtWhen(i.firstAt)}, last ${fmtWhen(i.lastAt)}`,
    `- Status: ${statusText(i)}`,
    ...(i.closed ? [`- ${closeText(i.closed)}`] : []),
    "",
    "## Occurrences",
    "",
    ...(cut ? [cut, ""] : []),
    ...occurrences.map((o) => `- ${dotsText([fmtWhen(o.at), o.sessionName, o.project, o.model, o.engineVersion && `harness version ${o.engineVersion}`, o.commit && `commit ${o.commit}`, o.resumeCommand && `\`${o.resumeCommand}\``])}`),
    ...(input === null || !readsKept ? [] : ["", "## Input", "", fenced(input)]),
    ...(output === null || !readsKept ? [] : ["", "## Output", "", fenced(output)]),
  ];
  return `${lines.join("\n")}\n`;
}

function CopyBrief({ detail }: { detail: IssueDetail }) {
  const { state, copy } = useCopy(briefOf(detail, useReadsKept()));
  return (
    <button type="button" className="ui-button" onClick={copy}>
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy brief"}</span>
    </button>
  );
}

/** An open issue, under its row, with what was read by its key (useOpened). Each action reads the issues again, a refused one too: a claim someone else holds then shows. */
function Detail({ i, detail, signedIn, reload }: { i: IssueView; detail: Load<IssueDetail>; signedIn: boolean; reload: () => void }) {
  const ctx = useRespond();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const act = (verb: string, send: () => Promise<unknown>) => {
    setBusy(true);
    setRefused(null);
    send()
      .catch((err: unknown) => {
        if (err instanceof RespondError && err.status === 403) void ctx?.refresh();
        setRefused(`Could not ${verb}: ${failure(err)}`);
      })
      .finally(() => {
        setBusy(false);
        reload();
      });
  };
  // A close takes its reason with it.
  const close = (as: "resolved" | "flagged") => act("close", () => adminApi.closeIssue(i.key, as, reason.trim()).then(() => setReason("")));
  // Its newest kept input and its newest kept output (IssueDetail: each the newest of its part, null where none was kept or the
  // reader may not read it), where the list's row has one cut line of the error: their first lines, as a turn draws a row's
  // (Texts `preview`, three lines each), since the whole of each is in Copy brief and at the failing call each occurrence links
  // to. Not drawn once the reader may no longer read kept text, as Turns' are not, whatever the last read held.
  const readsKept = useReadsKept();
  const data = detail.state === "ok" ? detail.data : null;
  const texts = (["input", "output"] as const).flatMap((part) => {
    const text = data?.[part] ?? null;
    return text === null || !readsKept ? [] : [{ part, text }];
  });
  const cut = data && newestOnly(data);
  return (
    <div className="hs-issue">
      {i.closed ? <p>{closeText(i.closed)}</p> : null}
      <div className="signin-line">
        {signedIn && isOpen(i) ? (
          <>
            {i.claim ? null : (
              <button type="button" className="ui-button" disabled={busy} onClick={() => act("claim", () => adminApi.claimIssue(i.key))}>
                Claim
              </button>
            )}
            <input aria-label="Reason" placeholder="Reason (optional)" maxLength={LIMITS.feedbackComment} value={reason} onChange={(e) => setReason(e.target.value)} />
            <button type="button" className="ui-button" disabled={busy} onClick={() => close("resolved")}>
              Close as resolved
            </button>
            <button type="button" className="ui-button" disabled={busy} onClick={() => close("flagged")}>
              Incorrectly flagged
            </button>
          </>
        ) : null}
        {signedIn && !isOpen(i) ? (
          <button type="button" className="ui-button" disabled={busy} onClick={() => act("reopen", () => adminApi.reopenIssue(i.key))}>
            Reopen
          </button>
        ) : null}
        {detail.state === "ok" ? <CopyBrief detail={detail.data} /> : null}
      </div>
      {refused ? (
        <p className="signin-error" role="alert">
          {refused}
        </p>
      ) : null}
      {detail.state === "loading" ? <p className="sv-muted">Loading…</p> : null}
      {detail.state === "error" ? <p className="sv-muted">{`Could not load its occurrences: ${detail.message}`}</p> : null}
      {texts.length > 0 ? <Texts texts={texts} preview /> : null}
      {data ? (
        <ul className="sv-evlist">
          {data.occurrences.map((o) => (
            <li key={`${o.sessionId}\u0000${o.rowId}`}>
              <Dots
                items={[
                  <a key="at" className="sv-link" href={stepHash(o.sessionId, o.rowId)}>
                    {dotsText([fmtWhen(o.at), o.sessionName])}
                  </a>,
                  o.project,
                  o.model === null ? null : (
                    <span key="model" title={o.model}>
                      {modelIdName(o.model)}
                    </span>
                  ),
                  o.engineVersion,
                  o.commit?.slice(0, SHORT_ID),
                ]}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {cut ? <p className="sv-muted">{cut}</p> : null}
    </div>
  );
}

const COLUMNS: readonly [name: string, width: string | undefined, figure: boolean][] = [
  ["Tool", "hs-w-model", false],
  ["Error", undefined, false],
  ["Sessions", "hs-w-dur", true],
  ["Calls", "hs-w-agents", true],
  ["First seen", "hs-w-model", true],
  ["Last seen", "hs-w-model", true],
  ["Status", "hs-w-model", false],
  ["Claimed by", "hs-w-end", false],
];

interface IssuesProps extends IssuesRead {
  /** The issue the address opens; `go` opens another, or none. */
  opened: string | null;
  go: Go;
  /** What leads the toolbar row: the page's view switch. */
  lead: ReactNode;
}

export function Issues({ list, once, showOnce, round, reload, opened, go, lead }: IssuesProps) {
  const signedIn = useRespond()?.me?.signedIn === true;
  const readsKept = useReadsKept();
  const [showClosed, setShowClosed] = useState(false);
  const all = list.state === "ok" ? list.data.issues : [];
  const detail = useOpened(opened, round, readsKept);
  // The issue the address opens when the list does not hold it: once read it leads the list, and one the server does not know says so.
  const unlisted = list.state === "ok" && opened !== null && !all.some((i) => i.key === opened) ? detail : null;
  const closed = all.filter((i) => !isOpen(i));
  // Open first, each in the server's order (most sessions first); a closed one the address opens shows whatever the control says.
  const shown = [...(unlisted?.state === "ok" ? [unlisted.data.issue] : []), ...all.filter(isOpen), ...closed.filter((i) => showClosed || i.key === opened)];
  // The issue the address opens (a failed call's link lands here) is brought into view once the list shows it.
  const openedRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    openedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [opened, list.state, detail?.state]);
  let note: string | null = null;
  if (list.state === "loading") note = "Loading…";
  else if (list.state === "error") note = `Could not load: ${list.message}`;
  else if (shown.length === 0) note = list.data.once > 0 && !once ? "No open issue seen in more than one session" : "No open issues";
  // The server lists 500 at most, the open ones first, each kind most sessions first (fleet.ts issues); `total` is how many there are.
  const cut = list.state === "ok" && list.data.total > all.length ? `The first ${all.length} of ${fmtCount(list.data.total)} issues: open first, most sessions first` : null;
  return (
    <>
      <div className="sv-bar">
        {lead}
        {closed.length > 0 ? (
          <button type="button" className="ui-button sv-hide" aria-pressed={showClosed} onClick={() => setShowClosed(!showClosed)}>
            Show closed <b>{closed.length}</b>
          </button>
        ) : null}
        {list.state === "ok" && list.data.once > 0 ? (
          <button type="button" className="ui-button sv-hide" aria-pressed={once} onClick={() => showOnce(!once)}>
            Show seen in one session <b>{fmtCount(list.data.once)}</b>
          </button>
        ) : null}
      </div>
      {unlisted?.state === "error" ? <p className="ui-empty">{`Could not load that issue: ${unlisted.message}`}</p> : null}
      {note ? (
        <p className="ui-empty">{note}</p>
      ) : (
        <div className="hs-scroll">
          {/* Error takes what the other columns leave, 208 px at the least. */}
          <table className="hs-table" style={{ minWidth: 1000 }}>
            <colgroup>
              {COLUMNS.map(([name, width]) => (
                <col key={name} className={width} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {COLUMNS.map(([name, , figure]) => (
                  <th key={name} scope="col" className={figure ? "sv-n" : undefined}>
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <Fragment key={i.key}>
                  <tr>
                    <th scope="row">
                      <button ref={i.key === opened ? openedRow : undefined} type="button" className="sv-link hs-name hs-cut" title={i.tool} aria-expanded={i.key === opened} onClick={() => go({ issue: i.key === opened ? null : i.key })}>
                        {i.tool}
                      </button>
                    </th>
                    <td>
                      <div className={i.error === null ? "hs-cut sv-muted" : "hs-cut"} title={i.error ?? undefined}>
                        {errorText(i, readsKept)}
                      </div>
                    </td>
                    <td className="sv-n">{i.sessions}</td>
                    <td className="sv-n">{i.calls}</td>
                    <td className="sv-n">{fmtWhen(i.firstAt)}</td>
                    <td className="sv-n">{fmtWhen(i.lastAt)}</td>
                    <td>{statusText(i)}</td>
                    <td>
                      <div className="hs-cut" title={i.claim?.by}>
                        {i.claim?.by}
                      </div>
                    </td>
                  </tr>
                  {i.key === opened && detail ? (
                    <tr className="hs-confirm">
                      <td colSpan={COLUMNS.length}>
                        <Detail i={i} detail={detail} signedIn={signedIn} reload={reload} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cut && !note ? <p className="ui-empty">{cut}</p> : null}
    </>
  );
}
