// A loop's live activity feed: what one loop did lately, tool calls and the text it wrote, oldest at the top, polled at the
// interval Settings keeps and only while it is shown: the server holds the entries under that viewer's lease and stores
// nothing. A shell call that came with its whole command opens to show it and says how the call ended. Command output is not
// in the contract, so no row has an output part. Everything drawn is reported text, put into text nodes only. The
// answer panel and the inspector's agent detail draw it from here; Expand raises it in the one modal panel.
import { useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { LIMITS } from "../../../../server/src/fleet/protocol";
import { fmtCount } from "../format";
import type { ActivityEntryView, SessionView } from "../types";
import { readEvery, useActivityFeed, type FeedState } from "../useActivityFeed";
import { useNow } from "../useNow";
import { FeedFreshness } from "../shell/answering";
import { useRespond } from "../useRespond";
import { Panel } from "../ui/Panel";
import "../views/session/session.css";
import { useCopy } from "./SessionId";

// ---- glyphs ----------------------------------------------------------------------------------------------------------

interface Stroke {
  width?: string;
  cap?: "round";
  join?: "round";
}

/** A 12-pixel line glyph on a 16-unit grid. Decorative: the words or the label beside it carry the meaning. */
function glyph(body: ReactNode, stroke: Stroke = {}): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={stroke.width ?? "1.6"} strokeLinecap={stroke.cap} strokeLinejoin={stroke.join} aria-hidden="true">
      {body}
    </svg>
  );
}

const EXPAND_GLYPH = glyph(<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />);
const TICK = glyph(<path d="m3 8.5 3.2 3.2L13 5" />, { width: "1.8", cap: "round", join: "round" });
const CROSS = glyph(<path d="m4 4 8 8M12 4l-8 8" />, { width: "1.8", cap: "round" });
/** The disclosure arrow of a call that opens; the stylesheet turns it a quarter while the call is open. */
const DISCLOSURE = (
  <svg className="fd-chev" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 1.5 6.5 5 3 8.5" />
  </svg>
);

/** Per entry kind: its accessible name, its glyph, and the row class the stylesheet colours it by. */
const KINDS: Record<ActivityEntryView["kind"], { label: string; icon: ReactElement; cls: string }> = {
  tool: { label: "Tool call", cls: "fd-tool", icon: glyph(<path d="m3 4 4 4-4 4M8.5 12.5H13" />) },
  text: { label: "Text", cls: "fd-txt", icon: glyph(<path d="M3 4.5h10M3 8h10M3 11.5h6" />) },
  reasoning: {
    label: "Reasoning",
    cls: "fd-txt",
    icon: glyph(
      <>
        <circle cx="8" cy="7" r="4.5" />
        <path d="M6 13.5h4" />
      </>,
    ),
  },
  dashboard: {
    label: "Sent from the dashboard",
    cls: "fd-you",
    icon: glyph(
      <>
        <circle cx="8" cy="5.5" r="2.6" />
        <path d="M3 13.5c.6-2.5 2.6-4 5-4s4.4 1.5 5 4" />
      </>,
      { width: "1.5", cap: "round" },
    ),
  },
};

// ---- notes in place of the feed --------------------------------------------------------------------------------------

/** What the feed shows while the server's activity feed setting is off (Settings turns it on). */
export function ServerOffNote() {
  return <p className="fd-off">Activity feed off</p>;
}

/** What the feed shows while the session's reporter has its activityFeed option off. */
function ReporterOffNote({ machine }: { machine: string }) {
  return (
    <div className="fd">
      <h4 className="fd-lab">Activity</h4>
      <p className="fd-off">{`Activity feed off in ${machine}'s reporter`}</p>
    </div>
  );
}

// ---- text helpers ----------------------------------------------------------------------------------------------------

/** The left column: time since the loop started, as mm:ss, or h:mm:ss from the first hour on. */
function feedTime(at: number, startedAt: number): string {
  const elapsed = Math.max(0, Math.floor((at - startedAt) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutesSeconds = [Math.floor(elapsed / 60) % 60, elapsed % 60].map((n) => n.toString().padStart(2, "0")).join(":");
  return hours > 0 ? `${hours}:${minutesSeconds}` : minutesSeconds;
}

/** Reported text with every `[redacted]` a reporter put in picked out, as text nodes. */
function Redacted({ text }: { text: string }) {
  // Splitting on a captured marker keeps the markers, always at the odd positions.
  const pieces = text.split(/(\[redacted\])/);
  return (
    <>
      {pieces.map((piece, i) =>
        i % 2 === 1 ? (
          <span key={i} className="fd-red">
            {piece}
          </span>
        ) : (
          <span key={i}>{piece}</span>
        ),
      )}
    </>
  );
}

/** A tool line is the tool's name, one space, then a summary of its arguments. */
function splitCall(text: string): [string, string] {
  const gap = text.indexOf(" ");
  return gap < 0 ? [text, ""] : [text.slice(0, gap), text.slice(gap + 1)];
}

/** Who sent a dashboard entry, as the feed words it: "You" for the viewer who is signed in. */
function senderName(by: string | undefined, me: string | null): string {
  if (!by) return "Someone";
  const fold = (name: string) => name.trim().toLowerCase();
  return me && fold(by) === fold(me) ? "You" : by;
}

/**
 * A call the row can say more about: one the reporter sent the whole command for (Claude's Bash; the contract allows Codex's
 * shell too), or a Bash line without one, which still says where its summary was cut.
 */
function isShellCall(e: ActivityEntryView): boolean {
  return e.kind === "tool" && (e.command !== undefined || splitCall(e.text)[0] === "Bash");
}

// ---- rows ------------------------------------------------------------------------------------------------------------

/** The two cells every row starts with: the time (clock time as its tooltip) and the kind's glyph, named for screen readers. */
function RowLead({ at, startedAt, kind }: { at: number; startedAt: number; kind: ActivityEntryView["kind"] }) {
  const { label, icon } = KINDS[kind];
  return (
    <>
      <span className="fd-at" title={new Date(at).toLocaleTimeString()}>
        {feedTime(at, startedAt)}
      </span>
      <span className="fd-k" role="img" aria-label={label} title={label}>
        {icon}
      </span>
    </>
  );
}

/** A row that only reads: text the model wrote, a tool call other than a shell call, or something sent from the dashboard. */
function PlainRow({ e, startedAt, cls, me }: { e: ActivityEntryView; startedAt: number; cls: string; me: string | null }) {
  let body: ReactNode;
  if (e.kind === "tool") {
    const [name, arg] = splitCall(e.text);
    body = (
      <>
        <span className="fd-name">{name}</span>{" "}
        <span className="fd-arg">
          <Redacted text={arg} />
        </span>
      </>
    );
  } else if (e.kind === "dashboard") {
    body = (
      <>
        <span className="fd-who">{senderName(e.by, me)}, from the dashboard:</span> {e.text}
        {e.note ? <span className="fd-q"> {e.note}</span> : null}
      </>
    );
  } else {
    body = <Redacted text={e.text} />;
  }
  return (
    <li className={cls}>
      <RowLead at={e.at} startedAt={startedAt} kind={e.kind} />
      <span className="fd-body">{body}</span>
    </li>
  );
}

/** How a finished call ended. Success is a bare check, named for screen readers and by its tooltip; anything else is a cross and words. */
function Ended({ e }: { e: ActivityEntryView }) {
  const code = e.exitCode;
  const ok = e.failed !== true && (code === undefined || code === 0);
  const words = ok ? <span className="ui-vh">Exit 0, succeeded</span> : code === undefined ? "Failed" : `Exit ${code}, failed`;
  return (
    <span className={ok ? "fd-exit ok" : "fd-exit bad"} title={ok ? "Succeeded" : undefined}>
      {ok ? TICK : CROSS}
      {words}
    </span>
  );
}

/** Copies the command as shown (redacted). It reads Copied with a check for 1.6 s, and changes nothing when the clipboard refuses. */
function CopyCommand({ text }: { text: string }) {
  const { state, copy } = useCopy(text);
  const copied = state === "copied";
  return (
    <button type="button" className="ui-button" onClick={copy}>
      {copied ? TICK : null}
      {copied ? <span aria-live="polite">Copied</span> : "Copy command"}
    </button>
  );
}

/** The whole command as preformatted text. When the reporter cut it, its closing "[cut off at …]" line is muted. */
function CommandText({ text, cut }: { text: string; cut: boolean }) {
  const marker = cut ? text.lastIndexOf("\n[cut off") : -1;
  if (marker < 0) return <Redacted text={text} />;
  return (
    <>
      <Redacted text={text.slice(0, marker + 1)} />
      <span className="fd-mark">{text.slice(marker + 1)}</span>
    </>
  );
}

/** Where a row sat in its scrolling list just before it opened or closed, and whether the list was at its end. */
interface ReadingPlace {
  list: HTMLElement;
  offset: number;
  atEnd: boolean;
}

/** A list counts as following its newest row while it is scrolled to within a few pixels of the bottom. */
const isAtEnd = (el: HTMLElement) => el.scrollTop + el.clientHeight >= el.scrollHeight - 6;

function readPlace(row: HTMLElement | null): ReadingPlace | null {
  const list = row?.parentElement;
  if (!row || !list) return null;
  return { list, offset: row.getBoundingClientRect().top - list.getBoundingClientRect().top, atEnd: isAtEnd(list) };
}

/**
 * The feed has `overflow-anchor: none`, so the browser will not keep the reader's place when a row changes height. A list at its
 * end stays at its end; otherwise the row goes back to where it was, and a row whose top was above the list comes to the top.
 */
function restorePlace(place: ReadingPlace | null, row: HTMLElement | null): void {
  if (!place || !row) return;
  const { list } = place;
  if (place.atEnd) {
    list.scrollTop = list.scrollHeight;
    return;
  }
  const offsetNow = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
  list.scrollTop += offsetNow - Math.max(0, place.offset);
}

/**
 * A shell call. With its whole command the row is a disclosure: its line is a real button for the keyboard and screen readers,
 * and the rest of the row takes pointer clicks too, except inside the opened part and a click that only ends a text selection.
 * The line says how the call ended (or that it runs). Without a whole command the row is a plain line that says when its summary
 * was cut. `newestWhileActive` comes from the list: only the newest call of a loop that still works can be running.
 */
function ShellRow({ e, startedAt, cls, newestWhileActive }: { e: ActivityEntryView; startedAt: number; cls: string; newestWhileActive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const partId = useId();
  const rowRef = useRef<HTMLLIElement>(null);
  const partRef = useRef<HTMLDivElement>(null);
  const lineButton = useRef<HTMLButtonElement>(null);
  const place = useRef<ReadingPlace | null>(null);
  const { command } = e;
  const [name, arg] = splitCall(e.text);
  const summaryCut = e.text.length >= LIMITS.activityText;
  const running = newestWhileActive && !e.done;

  const toggle = (next: boolean) => {
    place.current = readPlace(rowRef.current);
    setExpanded(next);
  };
  // After the row's new height is laid out. On the first render there is no place to go back to.
  useLayoutEffect(() => {
    restorePlace(place.current, rowRef.current);
    place.current = null;
  }, [expanded]);

  const summary = (
    <>
      <span className="fd-name">{name}</span>{" "}
      <span className="fd-arg">
        <Redacted text={arg} />
      </span>
      {summaryCut && <span className="fd-cut">…</span>}
    </>
  );

  if (command === undefined) {
    return (
      <li className={cls}>
        <RowLead at={e.at} startedAt={startedAt} kind={e.kind} />
        <span className="fd-body">
          <span>
            {summary}
            {summaryCut && <span className="fd-nofull">cut at 300 characters</span>}
          </span>
        </span>
      </li>
    );
  }

  const onRowClick = (ev: MouseEvent<HTMLLIElement>) => {
    if (partRef.current?.contains(ev.target as Node)) return;
    // Letting go of the mouse after selecting text in this row is not a request to open it; a key press (detail 0) always is.
    const selection = window.getSelection?.();
    const endsSelection = ev.detail > 0 && !!selection && !selection.isCollapsed && !!rowRef.current?.contains(selection.anchorNode);
    if (!endsSelection) toggle(!expanded);
  };
  // Collapse sits at the end of the opened part, so a long command always has a visible way back; focus returns to the line.
  const collapse = () => {
    toggle(false);
    lineButton.current?.focus();
  };
  const lengthNote = `${fmtCount(command.length)} characters`;
  let ending: ReactNode = null;
  if (e.done) ending = <Ended e={e} />;
  else if (running) ending = "running";

  return (
    <li ref={rowRef} className={[cls, "fd-can", expanded && "open"].filter(Boolean).join(" ")} onClick={onRowClick}>
      <RowLead at={e.at} startedAt={startedAt} kind={e.kind} />
      <span className="fd-body">
        <button ref={lineButton} type="button" className="fd-tgl" aria-expanded={expanded} aria-controls={expanded ? partId : undefined}>
          {DISCLOSURE}
          {summary}
          {ending !== null && <span className="fd-state">{ending}</span>}
          <span className="ui-vh"> {summaryCut ? `Show whole command, ${lengthNote}` : "Show command"}</span>
        </button>
        {expanded && (
          <div ref={partRef} className="fd-xp" id={partId}>
            <div>
              <div className="fd-xh">
                <span>{summaryCut ? `Command, ${lengthNote}` : "Command"}</span>
                <CopyCommand text={command} />
              </div>
              <pre className="sv-code fd-cmd" aria-label="Whole command">
                <CommandText text={command} cut={e.commandCut === true} />
              </pre>
            </div>
            {running && (
              <div className="fd-off">
                <b>Running.</b>
              </div>
            )}
            <div className="fd-xf">
              <button type="button" className="ui-button" onClick={collapse}>Collapse</button>
            </div>
          </div>
        )}
      </span>
    </li>
  );
}

// ---- the list --------------------------------------------------------------------------------------------------------

/** Tool calls that only edit a file: a run of them says little one by one, so a list may fold the run into one line. */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"]);
/** The shortest run of edits that is folded. */
const EDIT_RUN = 3;

const isEdit = (e: ActivityEntryView) => e.kind === "tool" && e.command === undefined && EDIT_TOOLS.has(splitCall(e.text)[0]);

type FeedItem = { kind: "one"; e: ActivityEntryView } | { kind: "edits"; list: ActivityEntryView[] };

/** The entries as the list shows them: each on its own, or, when asked, runs of three or more file edits as one item. */
function feedItems(entries: readonly ActivityEntryView[], fold: boolean): FeedItem[] {
  const items: FeedItem[] = [];
  let run: ActivityEntryView[] = [];
  const endRun = () => {
    if (run.length >= EDIT_RUN) items.push({ kind: "edits", list: run });
    else for (const e of run) items.push({ kind: "one", e });
    run = [];
  };
  for (const e of entries) {
    if (fold && isEdit(e)) run.push(e);
    else {
      endRun();
      items.push({ kind: "one", e });
    }
  }
  endRun();
  return items;
}

/** A folded run of file edits: one line that opens to list them. */
function EditRun({ list, startedAt, open, onToggle, children }: { list: ActivityEntryView[]; startedAt: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  const files = list.length;
  return (
    <li className="fd-tool fd-run">
      <RowLead at={list[0]!.at} startedAt={startedAt} kind="tool" />
      <span className="fd-body">
        <button type="button" className="fd-tgl" aria-expanded={open} onClick={onToggle}>
          {DISCLOSURE}
          <span className="fd-name">{`${files} file edits`}</span> <span className="fd-arg">{`until ${feedTime(list[files - 1]!.at, startedAt)}`}</span>
        </button>
        {open ? <ol className="fd-runlist">{children}</ol> : null}
      </span>
    </li>
  );
}

/**
 * The entries, newest last, or what an empty feed says. The list keeps the newest in view until the viewer scrolls up, and
 * then offers a pill back to it.
 * Rows that arrived since the previous answer flash once (none on the first answer). `active`: the loop still works.
 * `foldEdits`: runs of three or more file edits read as one line that opens.
 */
export function FeedList({ feed, startedAt, empty, active, foldEdits }: { feed: FeedState; startedAt: number; empty: string; active: boolean; foldEdits?: boolean }) {
  const listRef = useRef<HTMLOListElement>(null);
  // Whether the list keeps its newest row in view: until the viewer scrolls up.
  const [atNewest, setAtNewest] = useState(true);
  // Folded runs the viewer opened, by the seq of their first edit.
  const [openRuns, setOpenRuns] = useState<ReadonlySet<number>>(() => new Set());
  const me = useRespond()?.me;
  const myName = me?.signedIn ? me.name : null;
  const { entries } = feed;
  const newest = entries.length ? entries[entries.length - 1]! : undefined;
  const newestSeq = newest?.seq ?? 0;

  // Read while rendering, so this answer's new rows can be told apart, then moved on once the frame is laid out.
  const shownUpTo = useRef(0);
  const flashAfter = shownUpTo.current;
  useLayoutEffect(() => {
    shownUpTo.current = newestSeq;
  }, [newestSeq]);
  // The newest row can also change in place (its call ended): a list that follows keeps its end in view.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && atNewest) list.scrollTop = list.scrollHeight;
  }, [newestSeq, newest?.done, atNewest]);

  // From the first hour on the times read h:mm:ss, which needs the wider time column on every row.
  const pastAnHour = entries.some((x) => x.at - startedAt >= 3_600_000);
  const row = (x: ActivityEntryView) => {
    const cls = flashAfter > 0 && x.seq > flashAfter ? `${KINDS[x.kind].cls} new` : KINDS[x.kind].cls;
    if (isShellCall(x)) return <ShellRow key={x.seq} e={x} startedAt={startedAt} cls={cls} newestWhileActive={active && x === newest} />;
    return <PlainRow key={x.seq} e={x} startedAt={startedAt} cls={cls} me={myName} />;
  };
  const rows = feedItems(entries, foldEdits === true).map((item) => {
    if (item.kind === "one") return row(item.e);
    const first = item.list[0]!.seq;
    const toggle = () =>
      setOpenRuns((was) => {
        const next = new Set(was);
        if (!next.delete(first)) next.add(first);
        return next;
      });
    return (
      <EditRun key={`run-${first}`} list={item.list} startedAt={startedAt} open={openRuns.has(first)} onToggle={toggle}>
        {item.list.map(row)}
      </EditRun>
    );
  });
  const backToLatest = () => {
    setAtNewest(true);
    listRef.current?.focus();
  };
  // No rows: the one line that says why when there is a reason, else nothing (an empty section is absent).
  if (rows.length === 0) return empty ? <p className="ui-empty">{empty}</p> : null;

  return (
    <div className="fd-wrap">
      <ol ref={listRef} className={pastAnHour ? "fd-list hours" : "fd-list"} aria-label="Activity, oldest first" tabIndex={0} onScroll={(ev) => setAtNewest(isAtEnd(ev.currentTarget))}>
        {rows}
      </ol>
      {atNewest ? null : (
        <button type="button" className="ui-button fd-jump" onClick={backToLatest}>
          Back to newest
        </button>
      )}
    </div>
  );
}

/**
 * The line under the feed, only when it has something to say: that older entries dropped out of the 20 kept, and that the
 * server can't be reached. Nothing otherwise.
 */
export function FeedStatus({ feed }: { feed: FeedState }) {
  const dropped = feed.seen > feed.entries.length ? `Last ${feed.entries.length} of ${feed.seen}` : null;
  const failed = feed.failed ? "Server unreachable, retrying" : null;
  if (!dropped && !failed) return null;
  return (
    <div className="fd-foot stat">
      <span className="fd-count">{dropped}</span>
      <span className="fd-when">{failed}</span>
    </div>
  );
}

/** What an empty feed says: only that the server can't be reached; otherwise it shows nothing. */
export const feedEmpty = (feed: FeedState): string => (feed.failed ? "Server unreachable, retrying" : "");

// ---- the section -----------------------------------------------------------------------------------------------------

/** What the feed keeps, on its heading's hover: the one fact about it that could mislead. */
const FEED_NOTE = "Only gathered when someone is viewing. Secrets are redacted on the machine.";

interface ActivityFeedProps {
  s: SessionView;
  loop: string;
  title: string;
  startedAt: number;
  active: boolean;
  isMain?: boolean;
  serverOn: boolean;
  /** Runs of three or more file edits read as one line that opens (the main loop's feed). */
  foldEdits?: boolean;
  /** A stored session (History): no feed was kept, so the section is absent. */
  stored?: boolean;
}

/** The feed's freshness (shell/answering FeedFreshness) on its own 5-second clock, so the list under it does not redraw each tick. */
function Freshness({ feed, active }: { feed: FeedState; active: boolean }) {
  return <FeedFreshness feed={feed} active={active} now={useNow(5000)} />;
}

/**
 * The Activity section for one loop: `loop` is an agent's id, or the main loop's key. `active`: the loop still works.
 * `serverOn`: the server's activityFeed setting. Expand raises the same feed full height in the modal panel; the main loop's
 * Expand opens the answer panel instead, which carries the same feed, while the session is live.
 */
export function ActivityFeed(props: ActivityFeedProps) {
  const { s, loop, active, startedAt } = props;
  const stored = props.stored === true;
  const respond = useRespond();
  const [every] = useState(readEvery);
  const [modalOpen, setModalOpen] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const feed = useActivityFeed({ sessionId: s.id, loop, enabled: !stored && s.activityFeed !== false, active, every, serverOn: props.serverOn });
  if (stored) return null;

  // The server's switch comes first: with it off nothing would show whatever the reporter's option says.
  const serverOff = !props.serverOn || feed.serverOff;
  if (!serverOff && s.activityFeed === false) return <ReporterOffNote machine={s.machine.name} />;

  const closeModal = () => {
    setModalOpen(false);
    expandButton.current?.focus();
  };
  // The answer panel holds only a session of the live fleet: for one that has ended, or that the server says is not live (a
  // stored session opened from History), it would close at once, so the main loop's feed opens in the panel as an agent's does.
  const live = feed.live && s.status !== "done";
  const expand = () => {
    if (props.isMain && live && respond) respond.open(s.id, expandButton.current);
    else setModalOpen(true);
  };
  const body = serverOff ? (
    <ServerOffNote />
  ) : (
    <>
      <FeedList feed={feed} startedAt={startedAt} empty={feedEmpty(feed)} active={active} foldEdits={props.foldEdits} />
      <FeedStatus feed={feed} />
    </>
  );

  return (
    <div className="fd">
      <div className="fd-head">
        <h4 className="fd-lab" title={FEED_NOTE}>
          Activity
        </h4>
        {serverOff ? null : <Freshness feed={feed} active={active} />}
        {serverOff ? null : (
          <button ref={expandButton} type="button" className="ui-button" aria-haspopup="dialog" onClick={expand}>
            {EXPAND_GLYPH}
            Expand
          </button>
        )}
      </div>
      {body}
      {modalOpen && (
        <Panel modal titleId={titleId} title="Activity" sub={props.title} onClose={closeModal} className="fd-panel">
          {body}
        </Panel>
      )}
    </div>
  );
}
