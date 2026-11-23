// Turns: a session's record, one card a turn, newest first, the newest open when the view opens (nothing opens by
// itself after that); in a card its rows oldest first, a subagent's under one folded line named as the Agents
// view names it, identical calls in a row (the same non-null callHash, with only model requests between them) as one line with
// ×N, and a gap as the rows that were not received; a long turn draws its newest 500 lines, earlier ones on asking
// (TurnCard). Counts and times come from the rows loaded, and while older rows remain on the server the cards they may belong
// to say so, with Load earlier. A row opens in place: its facts,
// its kept text where the reader may read it, its feedback; a failed call with an errorHash links to its issue. Rows are read only
// while this view shows: the newest page, then what was stored since whenever the session's record moves (RecordCounts.seq);
// a stored session's record never moves, so it is read once. Kept text is drawn as plain text, never as markup.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { findingsOf, FINDINGS_VERSION } from "../../../../../server/src/fleet/findings";
import { TEXT_PARTS, TEXT_PREVIEW } from "../../../../../server/src/fleet/protocol";
import { FeedbackBox, type SessionFeedback } from "../../components/Feedback";
import { IconChevron } from "../../components/Icons";
import { fmtClock, fmtCount, fmtSpan, fmtTok, plural } from "../../format";
import { modelIdName } from "../../logic";
import type { AgentView, KeptText, RowsReply, RowView, SessionView, TextPart, TokenCounts, TurnEnd } from "../../types";
import { Dots, dotsText } from "../../ui/Dots";
import { Unknown } from "../../ui/Unknown";
import { useReadsKept, useRespond } from "../../useRespond";
import { issueHash } from "../history/useHistory";
import { failure, getJson, needsSignIn, type Load } from "../settings/api";
import { clock, FLASH_MS } from "./bits";
import { agentKindText, agentName } from "./trace";

const enc = encodeURIComponent;

/** How a turn ended, in the page's words. */
const END_WORD: Record<TurnEnd, string> = { answer: "answered", aborted: "interrupted", refusal: "refused", error: "failed" };
const PART_LABEL: Record<TextPart, string> = { prompt: "Prompt", message: "Message", thinking: "Thinking", input: "Input", output: "Output" };
const FINDING_WORD = { correction: "Correction", frustration: "Frustration" } as const;
/** A finding is something to check, never a state, with the rules' version. */
const FINDING_TITLE = `Found by a phrase rule; check the turn before acting (rules version ${FINDINGS_VERSION})`;
const NO_END = "No end recorded";
const NO_OUTCOME = "The harness does not say how the call ended";
/** How the key of a card that began without its turn's own row starts (turnsOf). */
const EARLIER = "\u0000earlier";
/** How many of an open turn's newest lines are drawn at first, and how many earlier ones each Show earlier adds (TurnCard). */
const LINES_STEP = 500;

/** A span as the page writes one: under a minute to a tenth of a second ("0.1s", "4.2s"), longer as fmtSpan ("1m 02s"). */
const fmtMs = (ms: number): string => (ms < 60_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : fmtSpan(ms / 1000));

/** A model request's "in": everything it read, the input its provider did not cache with what was read from and written to the cache. */
const tokensIn = (t: TokenCounts): number => t.input + t.cacheRead + t.cacheWrite;

/** A row's place among the rows of one moment: a turn's row, then a model request, then the rest. */
const atOnce = (r: RowView): number => (r.kind === "turn" ? 0 : r.kind === "request" ? 1 : 2);

/**
 * Time order: when each started; at one moment by `atOnce`, then the order stored. A turn's row takes a new, highest `seq` when
 * it ends, so by `seq` alone a row that started in the turn's own millisecond would fall into the turn before; and a Codex model
 * request's row carries the time its first tool call was recorded (codex-reporter mapping.ts), so it reads before that call.
 */
const byTime = (a: RowView, b: RowView): number => a.t0 - b.t0 || atOnce(a) - atOnce(b) || a.seq - b.seq;

/** When the rows end, the latest of their ends; null when one of them has no end recorded, since it may be the last to end. */
const lastEnd = (rows: readonly RowView[]): number | null => rows.reduce<number | null>((at, r) => (at === null || r.t1 === null ? null : Math.max(at, r.t1)), -Infinity);

// ---- reading the rows ----------------------------------------------------------------------------------------------------

interface Held {
  byId: Map<string, RowView>;
  /** The newest and oldest `seq` read: where `after=` and `before=` start. */
  top: number;
  bottom: number;
  more: boolean;
}

/** A reply folded into what is held: a row sent again replaces the one held, by id. `paged`: a reply whose `more` counts. */
function fold(was: Held | null, reply: RowsReply, paged: boolean): Held {
  const byId = new Map(was?.byId);
  let top = was?.top ?? 0;
  let bottom = was?.bottom ?? Number.POSITIVE_INFINITY;
  for (const r of reply.rows) {
    byId.set(r.id, r);
    top = Math.max(top, r.seq);
    bottom = Math.min(bottom, r.seq);
  }
  return { byId, top, bottom, more: paged ? reply.more : (was?.more ?? false) };
}

interface Rows {
  list: RowView[];
  loaded: boolean;
  more: boolean;
  paging: boolean;
  failed: string | null;
  earlier: () => void;
}

/**
 * The session's rows: its newest page on mount, then, whenever `seq` (the record's newest) passes the newest held, what was
 * stored since, asked again while a full page comes back or the record moved on meanwhile; `earlier` reads the page before.
 */
function useRows(sessionId: string, seq: number): Rows {
  const [held, setHeld] = useState<Held | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const latest = useRef<Held | null>(null);
  const want = useRef(seq);
  want.current = seq;
  const syncing = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const read = useCallback((query: string) => getJson<RowsReply>(`/sessions/${enc(sessionId)}/rows${query}`), [sessionId]);
  const take = (reply: RowsReply, paged: boolean) => {
    latest.current = fold(latest.current, reply, paged);
    setHeld(latest.current);
  };
  useEffect(() => {
    if (syncing.current) return;
    syncing.current = true;
    void (async () => {
      try {
        for (;;) {
          const was = latest.current;
          if (was !== null && want.current <= was.top) break;
          const reply = await read(was === null ? "" : `?after=${was.top}`);
          if (!alive.current) return;
          take(reply, was === null);
          if (was !== null && reply.rows.length === 0) break;
        }
        setFailed(null);
      } catch (err) {
        if (alive.current) setFailed(failure(err));
      } finally {
        syncing.current = false;
      }
    })();
    // `read` and `take` are this session's; the loop reads the latest `seq` through `want`.
  }, [seq]);
  const earlier = () => {
    const was = latest.current;
    if (!was?.more || paging) return;
    setPaging(true);
    read(`?before=${was.bottom}`).then(
      (reply) => {
        if (!alive.current) return;
        take(reply, true);
        setPaging(false);
      },
      (err: unknown) => {
        if (!alive.current) return;
        setFailed(failure(err));
        setPaging(false);
      },
    );
  };
  const list = useMemo(() => (held ? [...held.byId.values()].sort(byTime) : []), [held]);
  return { list, loaded: held !== null, more: held?.more ?? false, paging, failed, earlier };
}

interface Previews {
  byRow: ReadonlyMap<string, KeptText[]>;
  failed: string | null;
  /** Reads the first lines of the kept texts of the rows given that are not read yet, as one span (`from`/`until`). */
  ask: (rows: readonly RowView[]) => void;
}

const NO_TEXTS: ReadonlyMap<string, KeptText[]> = new Map();

/** The first lines of kept texts, while the reader may read them (useReadsKept): read afresh each time that begins (`for`), and otherwise none show. */
function usePreviews(sessionId: string, readsKept: boolean): Previews {
  const refresh = useRespond()?.refresh;
  const [got, setGot] = useState<{ for: boolean; byRow: ReadonlyMap<string, KeptText[]>; failed: string | null }>({ for: readsKept, byRow: NO_TEXTS, failed: null });
  const asked = useRef<{ for: boolean; ids: Set<string> }>({ for: readsKept, ids: new Set() });
  const ask = useCallback(
    (rows: readonly RowView[]) => {
      if (!readsKept) return;
      if (asked.current.for !== readsKept) asked.current = { for: readsKept, ids: new Set() };
      // By id and seq: a row stored again (a prompt that grew, a call's output) is read again.
      const missing = rows.filter((r) => r.kept && !asked.current.ids.has(`${r.id}@${r.seq}`));
      if (missing.length === 0) return;
      for (const r of missing) asked.current.ids.add(`${r.id}@${r.seq}`);
      const from = missing.reduce((at, r) => Math.min(at, r.t0), Infinity);
      const until = missing.reduce((at, r) => Math.max(at, r.t0), -Infinity) + 1;
      getJson<{ texts: KeptText[] }>(`/sessions/${enc(sessionId)}/text?from=${from}&until=${until}`).then(
        ({ texts }) =>
          setGot((was) => {
            const byRow = new Map(was.for === readsKept ? was.byRow : NO_TEXTS);
            for (const t of texts) byRow.set(t.rowId, [...(byRow.get(t.rowId) ?? []).filter((x) => x.part !== t.part), t]);
            return { for: readsKept, byRow, failed: null };
          }),
        (err: unknown) => {
          if (needsSignIn(err)) void refresh?.();
          else setGot((was) => ({ ...was, for: readsKept, failed: failure(err) }));
        },
      );
    },
    [sessionId, readsKept, refresh],
  );
  const current = got.for === readsKept;
  return { byRow: current ? got.byRow : NO_TEXTS, failed: current ? got.failed : null, ask };
}

/** A row's kept texts whole, read when it opens; "sign-in" when the server refused a reader who is not signed in. */
function useWholeText(sessionId: string, row: RowView, readsKept: boolean): Load<KeptText[]> | "sign-in" | null {
  const refresh = useRespond()?.refresh;
  const [got, setGot] = useState<Load<KeptText[]> | "sign-in" | null>(null);
  useEffect(() => {
    if (!row.kept || !readsKept) return setGot(null);
    let current = true;
    setGot({ state: "loading" });
    getJson<{ texts: KeptText[] }>(`/sessions/${enc(sessionId)}/text?row=${enc(row.id)}`).then(
      (r) => current && setGot({ state: "ok", data: r.texts }),
      (err: unknown) => {
        if (!current) return;
        if (needsSignIn(err)) void refresh?.();
        setGot(needsSignIn(err) ? "sign-in" : { state: "error", message: failure(err) });
      },
    );
    return () => {
      current = false;
    };
  }, [sessionId, row.id, row.seq, row.kept, readsKept, refresh]);
  return got;
}

// ---- turns and their lines -----------------------------------------------------------------------------------------------

interface Turn {
  key: string;
  /** Its `turn` row; null for the rows before the first turn row loaded. */
  head: RowView | null;
  /** Its other rows, oldest first. */
  rows: RowView[];
}

/**
 * The rows in time order, cut into turns at each turn row; rows before the first turn row loaded make a card of their own. That
 * card is keyed by its newest row when it is first seen (`orphans` remembers which), and the turn that holds the row keeps the
 * key once Load earlier brings the turn's own row: the card stays the one it was, open if it was open.
 */
function turnsOf(rows: readonly RowView[], orphans: Set<string>): Turn[] {
  const turns: Turn[] = [];
  for (const r of rows) {
    if (r.kind === "turn") turns.push({ key: r.id, head: r, rows: [] });
    else if (turns.length > 0) turns[turns.length - 1]!.rows.push(r);
    else turns.push({ key: EARLIER, head: null, rows: [r] });
    if (orphans.has(r.id)) turns[turns.length - 1]!.key = EARLIER + r.id;
  }
  const first = turns[0];
  if (first?.key === EARLIER) {
    const { id } = first.rows[first.rows.length - 1]!;
    orphans.add(id);
    first.key = EARLIER + id;
  }
  return turns;
}

/** A turn's rows, its own first. */
const rowsOf = (t: Turn): RowView[] => (t.head ? [t.head, ...t.rows] : t.rows);

type Item = { kind: "row"; row: RowView } | { kind: "run"; key: string; rows: RowView[]; calls: RowView[] } | { kind: "agent"; key: string; agentId: string; rows: RowView[]; items: Item[] };

const firstOf = (item: Item): RowView => (item.kind === "row" ? item.row : item.rows[0]!);

/** One loop's rows as lines: a call repeated with the same non-null callHash, only model requests between, is one run. */
function loopItems(rows: readonly RowView[], prefix: string): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < rows.length; ) {
    const r = rows[i]!;
    let end = i;
    if (r.kind === "tool" && r.callHash) {
      for (let k = i + 1; k < rows.length && rows[k]!.kind !== "gap"; k++) {
        if (rows[k]!.kind !== "tool") continue;
        if (rows[k]!.callHash !== r.callHash) break;
        end = k;
      }
    }
    const span = rows.slice(i, end + 1);
    items.push(end === i ? { kind: "row", row: r } : { kind: "run", key: `${prefix}r:${r.id}`, rows: span, calls: span.filter((x) => x.kind === "tool") });
    i = end + 1;
  }
  return items;
}

/** A turn's lines: the main loop's, and one folded line for each agent's, where each agent's first row falls. */
function turnItems(turn: Turn): Item[] {
  const main: RowView[] = [];
  const agents = new Map<string, RowView[]>();
  for (const r of turn.rows) {
    if (r.agentId === null) main.push(r);
    else if (agents.has(r.agentId)) agents.get(r.agentId)!.push(r);
    else agents.set(r.agentId, [r]);
  }
  const items = loopItems(main, `${turn.key}:`);
  for (const [agentId, rows] of agents) items.push({ kind: "agent", key: `${turn.key}:a:${agentId}`, agentId, rows, items: loopItems(rows, `${turn.key}:${agentId}:`) });
  return items.sort((a, b) => byTime(firstOf(a), firstOf(b)));
}

/** The keys to open so a row of a turn shows: the turn's, the agent line and run it sits in, and its own. */
function pathTo(t: Turn, rowId: string): string[] {
  const keys = [`t:${t.key}`, `o:${rowId}`];
  const walk = (items: readonly Item[]) => {
    for (const it of items) {
      if (it.kind === "row" || !it.rows.some((r) => r.id === rowId)) continue;
      keys.push(it.key);
      if (it.kind === "agent") walk(it.items);
    }
  };
  walk(turnItems(t));
  return keys;
}

/**
 * "3 model requests · 5 tool calls · 1 failed", none of a kind left out. Where some of the calls did not report how they ended,
 * the failed count is a lower bound and reads as History's Failed does (HistoryPage Failed): "1+ failed", with how many reported
 * as its title and for a screen reader. With none failed it says nothing of failures.
 */
function countsLine(rows: readonly RowView[]): ReactNode {
  let requests = 0;
  let calls = 0;
  let known = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.kind === "request") requests += 1;
    else if (r.kind === "tool") {
      calls += 1;
      if (r.outcome) known += 1;
      if (r.outcome === "failed") failed += 1;
    }
  }
  const shown = dotsText([requests ? plural(requests, "model request") : null, calls ? plural(calls, "tool call") : null]);
  if (failed === 0) return shown;
  if (known === calls) return `${shown} · ${failed} failed`;
  const why = `${known} of ${calls} tool calls reported how they ended`;
  return (
    <>
      {`${shown} · `}
      <span title={why}>
        {`${failed}+ failed`}
        <span className="ui-vh">{` (${why})`}</span>
      </span>
    </>
  );
}

/** How a call ended, a failure in the failure colour; "—" where the harness does not say. */
const outcomeNode = (outcome: RowView["outcome"]): ReactNode =>
  outcome === undefined || outcome === null ? <Unknown reason={NO_OUTCOME} /> : <span className={outcome === "failed" ? "fb-bad" : undefined}>{outcome}</span>;

/** A run's outcomes: the one they share, else each with its count ("2 failed · 1 ok"). */
function runOutcomes(calls: readonly RowView[]): ReactNode {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.outcome ?? "—", (counts.get(c.outcome ?? "—") ?? 0) + 1);
  if (counts.size === 1) return outcomeNode(calls[0]!.outcome);
  return dotsText([...counts].map(([o, n]) => `${n} ${o}`));
}

// ---- drawing -------------------------------------------------------------------------------------------------------------

interface Ctx {
  s: SessionView;
  agents: ReadonlyMap<string, AgentView>;
  open: ReadonlySet<string>;
  toggle: (key: string) => void;
  previews: Previews;
  readsKept: boolean;
  feedback: SessionFeedback;
  marked: string | null;
  markRef: RefObject<HTMLButtonElement>;
  /** The row the address opens (`step=`), so its turn draws as far as its line. */
  step: string | null;
}

/**
 * Kept texts as plain text: thinking folded; in a line's first lines (`preview`, three lines each) a prompt and a message
 * unlabelled. An open issue shows the first lines of its newest kept input and output with it too (history/Issues). A preview
 * the server cut (a whole text, `chars` characters, longer than its part's TEXT_PREVIEW) ends in "…", as any cut text does; where it runs past three lines the
 * clamp's own "…" stands in its place. An issue's texts are whole and carry no `chars`.
 */
export function Texts({ texts, preview }: { texts: readonly (Pick<KeptText, "part" | "text"> & Partial<Pick<KeptText, "chars">>)[]; preview: boolean }) {
  const ordered = TEXT_PARTS.flatMap((part) => texts.filter((t) => t.part === part));
  const pre = (t: Pick<KeptText, "part" | "text"> & Partial<Pick<KeptText, "chars">>) => (
    <pre className={preview ? "tn-text" : "sv-code"}>{preview && (t.chars ?? 0) > TEXT_PREVIEW[t.part === "prompt" ? "prompt" : "other"] ? `${t.text}…` : t.text}</pre>
  );
  return (
    <div className="tn-texts">
      {ordered.map((t) =>
        t.part === "thinking" ? (
          <details key={t.part}>
            <summary>{PART_LABEL.thinking}</summary>
            {pre(t)}
          </details>
        ) : (
          <div key={t.part}>
            {preview && (t.part === "prompt" || t.part === "message") ? null : <span className="tn-label">{PART_LABEL[t.part]}</span>}
            {pre(t)}
          </div>
        ),
      )}
    </div>
  );
}

/** A row's facts, kept text and feedback, under its line. `running`: it is the row of a turn that runs now. */
function RowDetail({ row, ctx, running }: { row: RowView; ctx: Ctx; running: boolean }) {
  const whole = useWholeText(ctx.s.id, row, ctx.readsKept);
  const agent = row.agentId === null ? undefined : ctx.agents.get(row.agentId);
  // A row with one time has no start and end to tell apart: a Codex model request has when its response completed, a Hermes row
  // its message's time. Only a turn that runs now has started and not ended yet.
  const once = row.t1 === null && !running;
  const facts: [string, ReactNode][] = [[once ? "At" : "Started", fmtClock(row.t0)]];
  if (!once) facts.push(["Ended", row.t1 === null ? <Unknown reason={NO_END} /> : fmtClock(row.t1)]);
  facts.push(["Loop", row.agentId === null ? "Main loop" : agent ? agentName(agent) : row.agentId]);
  if (row.kind === "turn") facts.push(["Outcome", row.end ? END_WORD[row.end] : <Unknown reason="How the turn ended was not reported" />]);
  if (row.kind === "request") {
    const t = row.tokens;
    facts.push(
      // As its harness names it, the id it was reported as on hover.
      ["Model", row.model === null || row.model === undefined ? <Unknown reason="Model not reported" /> : <span title={row.model}>{modelIdName(row.model)}</span>],
      ["Effort", row.effort ?? <Unknown reason="Effort not reported" />],
      // "in" as on the row's line, then in brackets what it is made of.
      ["Tokens", t ? dotsText([`${fmtTok(tokensIn(t))} in (${dotsText([`${fmtTok(t.input)} uncached`, `${fmtTok(t.cacheRead)} cache read`, `${fmtTok(t.cacheWrite)} cache write`])})`, `${fmtTok(t.output)} out`]) : <Unknown reason="Tokens not reported" />],
      ["Stop", row.stop ?? <Unknown reason="Stop reason not reported" />],
    );
  }
  if (row.kind === "tool") {
    facts.push(["Tool", row.tool ?? <Unknown reason="Tool not reported" />], ["Outcome", outcomeNode(row.outcome)], ["Exit code", row.exit ?? <Unknown reason="No exit code from the harness" />]);
  }
  let text: ReactNode = null;
  if (row.kept) {
    if (!ctx.readsKept || whole === "sign-in") text = <p className="sv-muted">Sign in to read the text</p>;
    else if (whole?.state === "ok") text = <Texts texts={whole.data} preview={false} />;
    else if (whole?.state === "error") text = <p className="sv-muted">{`Could not read the text: ${whole.message}`}</p>;
    else text = <p className="sv-muted">Loading…</p>;
  }
  return (
    <div className="tn-open">
      <dl className="ag-facts">
        {facts.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
      {text}
      <FeedbackBox fb={ctx.feedback} rowId={row.id} />
    </div>
  );
}

/** The quiet line a finding reads as on a turn's prompt, with the words that matched. */
function Findings({ prompt, firstTurn }: { prompt: string; firstTurn: boolean }) {
  return (
    <>
      {findingsOf(prompt, firstTurn).map((f) => (
        <p key={f.rule} className="tn-finding" title={FINDING_TITLE}>
          {`${FINDING_WORD[f.rule]}: ${f.words}`}
        </p>
      ))}
    </>
  );
}

/** One row's line (its time, what it was, how long, how it went), its texts' first lines, and, open, its detail. `running`: the row of a turn that runs now. */
function RowLine({ row, ctx, firstTurn, running = false }: { row: RowView; ctx: Ctx; firstTurn: boolean; running?: boolean }) {
  if (row.kind === "gap") return <li className="tn-gap">{`⋯ ${row.count === 1 ? "1 row was" : `${row.count} rows were`} not received`}</li>;
  const key = `o:${row.id}`;
  const isOpen = ctx.open.has(key);
  const texts = ctx.previews.byRow.get(row.id);
  const prompt = row.kind === "turn" ? texts?.find((t) => t.part === "prompt")?.text : undefined;
  let name: ReactNode = row.tool;
  let facts: ReactNode = null;
  if (row.kind === "turn") name = "You";
  else if (row.kind === "request") {
    name = row.model ? <span title={row.model}>{dotsText([modelIdName(row.model), row.effort])}</span> : <Unknown reason="Model not reported" />;
    facts = dotsText([row.tokens ? `${fmtTok(tokensIn(row.tokens))} in · ${fmtTok(row.tokens.output)} out` : null, row.stop]);
  } else facts = <Dots items={[outcomeNode(row.outcome), row.exit === null || row.exit === undefined ? null : `exit ${row.exit}`]} />;
  const marked = ctx.marked === row.id;
  return (
    <li>
      <div className="tn-line">
        <button ref={marked ? ctx.markRef : undefined} type="button" className={marked ? "tn-row flash" : "tn-row"} aria-expanded={isOpen} onClick={() => ctx.toggle(key)}>
          <time className="sv-mono">{fmtClock(row.t0)}</time>
          <span>{name}</span>
          <span className="tn-dur">{row.kind === "turn" ? null : row.t1 === null ? <Unknown reason={NO_END} /> : fmtMs(row.t1 - row.t0)}</span>
          <span className="tn-facts">{facts}</span>
        </button>
        {row.outcome === "failed" && row.errorHash ? (
          <a className="sv-link tn-issue" href={issueHash(row.errorHash)}>
            issue →
          </a>
        ) : null}
      </div>
      {texts && !isOpen ? <Texts texts={texts} preview /> : null}
      {prompt ? <Findings prompt={prompt} firstTurn={firstTurn} /> : null}
      {isOpen ? <RowDetail row={row} ctx={ctx} running={running} /> : null}
    </li>
  );
}

/** A folded line: an agent's rows in the turn, or a run of identical calls, and under it, open, what it holds. */
function ItemLine({ item, ctx, firstTurn }: { item: Item; ctx: Ctx; firstTurn: boolean }) {
  if (item.kind === "row") return <RowLine row={item.row} ctx={ctx} firstTurn={firstTurn} />;
  const isOpen = ctx.open.has(item.key);
  const first = item.rows[0]!;
  const end = lastEnd(item.rows);
  const agent = item.kind === "agent" ? ctx.agents.get(item.agentId) : undefined;
  let name: ReactNode;
  if (item.kind === "run") name = <b>{`${item.calls[0]!.tool ?? ""} ×${item.calls.length}`}</b>;
  else if (agent) name = <><b>{agentName(agent)}</b><em>{agentKindText(agent)}</em></>;
  else name = <b>{item.agentId}</b>;
  return (
    <li>
      <div className="tn-line">
        <button type="button" className="tn-row" aria-expanded={isOpen} onClick={() => ctx.toggle(item.key)}>
          <time className="sv-mono">{fmtClock(first.t0)}</time>
          <span className="tn-fold">
            <IconChevron />
            {name}
          </span>
          <span className="tn-dur">{end === null ? <Unknown reason={NO_END} /> : fmtMs(end - first.t0)}</span>
          <span className="tn-facts">{item.kind === "agent" ? countsLine(item.rows) : runOutcomes(item.calls)}</span>
        </button>
      </div>
      {isOpen ? (
        <ul className="tn-rows">
          {item.kind === "agent" ? item.items.map((it) => <ItemLine key={firstOf(it).id} item={it} ctx={ctx} firstTurn={firstTurn} />) : item.rows.map((r) => <RowLine key={r.id} row={r} ctx={ctx} firstTurn={firstTurn} />)}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * A turn's card: when it started, which turn, running or how long and how it ended, its counts; open, its lines. `more`: older
 * rows remain on the server and may be this turn's, so its counts are said to be the loaded rows' and its head offers them.
 * A turn can hold thousands of lines, so under its own row it draws its newest LINES_STEP, as a log shows its tail and a running
 * turn's newest lines are what is happening now, and LINES_STEP earlier ones above them at each Show earlier, the page's own
 * direction for what it has not drawn (Load earlier), as a long list is drawn without a list library (the console uses none);
 * always back as far as the linked row's line, so the page can keep that row in view.
 */
function TurnCard({ turn, number, running, more, ctx }: { turn: Turn; number: number | null; running: boolean; more: Rows | null; ctx: Ctx }) {
  const key = `t:${turn.key}`;
  const isOpen = ctx.open.has(key);
  const { head } = turn;
  const all = useMemo(() => rowsOf(turn), [turn]);
  const counts = countsLine(all);
  const items = useMemo(() => (isOpen ? turnItems(turn) : []), [isOpen, turn]);
  // The line holding a row, by its id: a line's first row can change as Load earlier joins earlier rows to it.
  const lineOf = (id: string | null): number => (id === null ? -1 : items.findIndex((it) => (it.kind === "row" ? it.row.id === id : it.rows.some((r) => r.id === id))));
  // The line Show earlier reached, by a row of it: it holds as a running turn's new lines arrive below and Load earlier's above (a
  // line that Load earlier gives an earlier first row moves with it). Until then the newest LINES_STEP are drawn, moving on with the turn.
  const [startId, setStartId] = useState<string | null>(null);
  const anchored = lineOf(startId);
  const linked = lineOf(ctx.step);
  // The first line drawn, reaching back to the linked one.
  const from = Math.max(0, Math.min(anchored >= 0 ? anchored : items.length - LINES_STEP, linked < 0 ? items.length : linked));
  const { ask } = ctx.previews;
  useEffect(() => {
    if (isOpen) ask(all);
  }, [isOpen, all, ask]);
  let state: ReactNode = null;
  if (head && running) state = "running";
  // A turn with no end recorded has no duration, whatever its rows reach: one dash for an end nobody recorded at all.
  else if (head && head.t1 === null && !head.end) state = <Unknown reason={NO_END} />;
  else if (head) state = <Dots items={[head.t1 === null ? <Unknown reason={NO_END} /> : fmtMs(head.t1 - head.t0), head.end ? END_WORD[head.end] : <Unknown reason="How the turn ended was not reported" />]} />;
  const firstTurn = number === 1;
  return (
    <li className="tn-card">
      <button type="button" className="tn-head" aria-expanded={isOpen} onClick={() => ctx.toggle(key)}>
        <IconChevron />
        <time className="sv-mono">{clock(all[0]!.t0)}</time>
        <b>{number === null ? "Earlier" : `Turn ${number}`}</b>
        <span className="tn-state">{state}</span>
        <span className="tn-counts">
          {more && counts ? "Rows loaded: " : null}
          {counts}
        </span>
      </button>
      {more ? (
        <div className="tn-gap">
          {"Earlier rows are not loaded "}
          <button type="button" className="sv-link" disabled={more.paging} onClick={more.earlier}>
            Load earlier
          </button>
        </div>
      ) : null}
      {isOpen ? (
        <ul className="tn-rows">
          {head ? <RowLine row={head} ctx={ctx} firstTurn={firstTurn} running={running} /> : null}
          {from > 0 ? (
            <li className="tn-gap">
              <button type="button" className="sv-link" onClick={() => setStartId(firstOf(items[Math.max(0, from - LINES_STEP)]!).id)}>
                {from > LINES_STEP ? `Show ${fmtCount(LINES_STEP)} earlier of ${fmtCount(from)}` : `Show ${fmtCount(from)} earlier`}
              </button>
            </li>
          ) : null}
          {items.slice(from).map((it) => (
            <ItemLine key={firstOf(it).id} item={it} ctx={ctx} firstTurn={firstTurn} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

interface TurnsProps {
  /** A session with a record (SessionView.record not null). */
  s: SessionView;
  /** Its main loop runs now, by the session's own status as its page reads it (never a stored session's). */
  runs: boolean;
  /** The row the address opens (`step=`): its turn and the lines it sits in open, it opens and is brought into view. */
  step: string | null;
  feedback: SessionFeedback;
  /** What leads the toolbar row: the page's view switch. */
  lead: ReactNode;
}

export function Turns({ s, runs, step, feedback, lead }: TurnsProps) {
  const record = s.record ?? { turns: 0, requests: 0, toolCalls: 0, failedCalls: 0, seq: 0 };
  const rows = useRows(s.id, record.seq);
  const readsKept = useReadsKept();
  const previews = usePreviews(s.id, readsKept);
  const orphans = useRef(new Set<string>()).current;
  const turns = useMemo(() => turnsOf(rows.list, orphans), [rows.list, orphans]);
  // The newest turn when the view first had one is open until the reader changes what is open.
  const first = useRef<string | null>(null);
  if (first.current === null && turns.length > 0) first.current = `t:${turns[turns.length - 1]!.key}`;
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const open = chosen ?? new Set(first.current ? [first.current] : []);
  const toggle = (key: string) =>
    setChosen((was) => {
      const next = new Set(was ?? open);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // The linked row: read earlier pages until it is loaded, then open the lines it sits in and mark it for a moment. While it
  // is marked the page keeps it in view as what loads after it moves it (SessionPage useKeepPickInView).
  const [marked, setMarked] = useState<string | null>(null);
  const markRef = useRef<HTMLButtonElement>(null);
  const placed = useRef<string | null>(null);
  const home = useMemo(() => (step === null ? undefined : turns.find((t) => t.head?.id === step || t.rows.some((r) => r.id === step))), [turns, step]);
  useEffect(() => {
    if (step === null || placed.current === step || !rows.loaded) return;
    if (!home && rows.more) return rows.paging ? undefined : rows.earlier();
    placed.current = step;
    if (!home) return;
    setChosen((was) => new Set([...(was ?? open), ...pathTo(home, step)]));
    setMarked(step);
    // `open` and `rows.earlier` are this render's; the step is placed once.
  }, [step, home, rows.loaded, rows.more, rows.paging]);
  useEffect(() => {
    if (marked === null) return undefined;
    markRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const timer = setTimeout(() => setMarked(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [marked]);

  const ctx: Ctx = { s, agents: new Map(s.agents.map((a) => [a.id, a])), open, toggle, previews, readsKept, feedback, marked, markRef, step };
  // Numbered from the newest, as the record counts turns; one the record has not counted yet still gets its number.
  const total = Math.max(record.turns, turns.filter((t) => t.head).length);
  const newest = [...turns].reverse();
  let number = total + 1;
  // While older rows remain on the server, the cards they may belong to: the one with no turn row of its own, and the oldest
  // turn's, unless it shows rows and its own row was stored before each of them (as a turn's is until it ends, and stays where
  // the harness records no end): that turn began after the oldest row loaded, so all of it is here.
  const oldest = turns.find((t) => t.head);
  const lacks = ({ head, rows: its }: Turn): boolean => rows.more && (head === null || (head === oldest?.head && !(its.length > 0 && its.every((r) => r.seq > head.seq))));
  return (
    <div className="tn">
      <div className="sv-bar">{lead}</div>
      {rows.failed ? <p className="ui-empty">{`Could not load the record: ${rows.failed}`}</p> : null}
      {previews.failed ? <p className="ui-empty">{`Could not read the kept text: ${previews.failed}`}</p> : null}
      {!rows.loaded && !rows.failed ? <p className="ui-empty">Loading…</p> : null}
      {rows.loaded && turns.length === 0 ? <p className="ui-empty">Nothing recorded</p> : null}
      {step !== null && rows.loaded && !rows.more && !home ? <p className="ui-empty">The linked row is not in this session's record</p> : null}
      {turns.length > 0 ? (
        <ol className="tn-list">
          {newest.map((t, i) => {
            if (t.head) number -= 1;
            // A turn row with no end is no proof it runs (Hermes records none): the newest runs only while the session does.
            const running = runs && i === 0 && t.head !== null && t.head.t1 === null && !t.head.end;
            return <TurnCard key={t.key} turn={t} number={t.head ? number : null} running={running} more={lacks(t) ? rows : null} ctx={ctx} />;
          })}
        </ol>
      ) : null}
      {rows.more ? (
        <button type="button" className="ui-button tn-more" disabled={rows.paging} onClick={rows.earlier}>
          Load earlier
        </button>
      ) : null}
    </div>
  );
}
