// History's state: its address (`#/history?day=&to=&page=&size=&group=&open=&step=`, with `compare=` once for each compared
// session a comparison, or `view=issues&issue=`), a page of the sessions that ended in the range (or their groups), and the
// stored session the address opens. Every day is the server's, the simplest rule: an address with no day asks the server for
// its own today, and every answer names the day it holds and the server's today. What a reload and a shared link need lives in
// the address, so they and Back all land on the same view; a change of range is a history entry of its own, so Back walks the
// days. The machines asked for come from the filter field's `m:` word, and its other words from the field (filter.ts
// historyParams), not the address.
import { useEffect, useRef, useState } from "react";
import { addDays } from "../../../../../server/src/fleet/days";
import { GROUP_KEYS, HISTORY_IDS, type GroupKey } from "../../../../../server/src/fleet/protocol";
import { historyParams } from "../../shell/filter";
import type { HistoryGroup, HistoryRow, SessionView } from "../../types";
import { getJson, type Load } from "../settings/api";

export const PAGE_SIZES: readonly number[] = [25, 50, 100];
const DEFAULT_SIZE = 50;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** How long the list waits for typing in the filter field to pause before it asks. */
const TYPING_MS = 250;

export type HistoryView = "sessions" | "issues";
/**
 * `day` null: the server's today, whichever day that is when it is asked; `to` null: that one day. `compare`: the ids of the
 * sessions whose comparison stands in the list's place, the baseline first, as they were ticked; two or more, else none. A
 * session opened out of a comparison keeps it, so its way back says where it leads.
 */
export type Address = { day: string | null; to: string | null; page: number; size: number; open: string | null; step: string | null; view: HistoryView; issue: string | null; group: GroupKey | null; compare: string[] };
/** A page of a range: `asked` is the address's day it answers (null for today), `day` the day the server says it holds; `groups` while grouped, with what by. */
export type DayPage = { asked: string | null; span: string; day: string; rows: HistoryRow[]; groups: { by: GroupKey; rows: HistoryGroup[] } | null; total: number; page: number; pageSize: number };
type HistoryReply = { day: string; to: string; today: string; sessions?: HistoryRow[]; groups?: HistoryGroup[]; total: number; page?: number; pageSize?: number };

const HOME: Address = { day: null, to: null, page: 1, size: DEFAULT_SIZE, open: null, step: null, view: "sessions", issue: null, group: null, compare: [] };

/** A `YYYY-MM-DD` that names a real calendar day: 2026-13-45 has the form and no day (the calendar would roll it over). */
const isRealDay = (day: string): boolean => ISO_DAY.test(day) && addDays(day, 0) === day;

/** The address after `#/history?`; a part missing or malformed takes its default (the day: the server's today). */
function readAddress(hash: string): Address {
  const params = new URLSearchParams(hash.split("?")[1] ?? "");
  const day = params.get("day") ?? "";
  const to = params.get("to") ?? "";
  const page = Number(params.get("page"));
  const size = Number(params.get("size"));
  const open = params.get("open") || null;
  const view: HistoryView = params.get("view") === "issues" ? "issues" : "sessions";
  const compare = [...new Set(params.getAll("compare"))].filter(Boolean);
  return {
    day: isRealDay(day) ? day : null,
    to: isRealDay(day) && isRealDay(to) && to > day ? to : null,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    size: PAGE_SIZES.find((n) => n === size) ?? DEFAULT_SIZE,
    open,
    step: open ? params.get("step") || null : null,
    view,
    issue: view === "issues" ? params.get("issue") || null : null,
    group: GROUP_KEYS.find((k) => k === params.get("group")) ?? null,
    compare: view === "sessions" && compare.length > 1 ? compare : [],
  };
}

function addressHash({ day, to, page, size, open, step, view, issue, group, compare }: Address): string {
  const params = new URLSearchParams();
  if (view === "issues") params.set("view", view);
  if (issue) params.set("issue", issue);
  if (day) params.set("day", day);
  if (to) params.set("to", to);
  params.set("page", String(page));
  params.set("size", String(size));
  if (group) params.set("group", group);
  // One key a session, as History asks for its machines (historyQuery): an id is a line of text and may hold any separator.
  for (const id of compare) params.append("compare", id);
  if (open) params.set("open", open);
  if (step) params.set("step", step);
  return `#/history?${params.toString()}`;
}

/** History's read-only page of one stored session, its list on the server's today, optionally at one of its rows: where a
 * session's page goes once it ends. */
export const storedHash = (id: string, step: string | null = null): string => addressHash({ ...HOME, open: id, step });

/** An issue open in History's Issues: where a failed call's issue link goes. */
export const issueHash = (key: string): string => addressHash({ ...HOME, view: "issues", issue: key });

/** A hash that named a day or a range end it was refused (readAddress): its address is written back in place, no history entry. */
function correctDay(hash: string, address: Address): void {
  const given = new URLSearchParams(hash.split("?")[1] ?? "");
  if ((given.get("day") !== null && address.day === null) || (given.get("to") !== null && address.to === null)) {
    window.history.replaceState(window.history.state, "", addressHash(address));
  }
}

export type Go = (patch: Partial<Address>, how?: "push" | "replace") => void;
export type Back = (patch: Partial<Address>) => void;

/**
 * The view's address, kept in step with Back and Forward. `go` changes part of it: a new range, another view, opening a session
 * or a comparison pushes a history entry, so Back returns to the range or the list before; anything else (a page, the page
 * size, a group, an open issue, a session taken out of a comparison) replaces the current one. `back` leaves what stands in the
 * list's place (a stored session, a comparison) for what it stood over: back in the browser's history when this page pushed it,
 * so no entry is left there twice, the page showing at once where that leads; opened from a link, `patch` is written in place.
 */
export function useAddress(): [Address, Go, Back] {
  const [address, setAddress] = useState(() => readAddress(window.location.hash));
  const latest = useRef(address);
  const adopt = (next: Address) => {
    latest.current = next;
    setAddress(next);
  };
  useEffect(() => {
    correctDay(window.location.hash, latest.current);
    const follow = () => {
      // Back to another view fires these too; the list leaves the address alone while it unmounts.
      const hash = window.location.hash;
      if (!hash.startsWith("#/history")) return;
      const next = readAddress(hash);
      adopt(next);
      correctDay(hash, next);
    };
    window.addEventListener("popstate", follow);
    window.addEventListener("hashchange", follow);
    return () => {
      window.removeEventListener("popstate", follow);
      window.removeEventListener("hashchange", follow);
    };
  }, []);
  const go: Go = (patch, how = "replace") => {
    const target = { ...latest.current, ...patch };
    adopt(target);
    // The entry's state says this page pushed it (`back`): a push sets it, a replace keeps what the entry had.
    if (how === "push") window.history.pushState({ pushed: true }, "", addressHash(target));
    else window.history.replaceState(window.history.state, "", addressHash(target));
  };
  const back: Back = (patch) => {
    if (!(window.history.state as { pushed?: boolean } | null)?.pushed) return go(patch);
    adopt({ ...latest.current, ...patch });
    window.history.back();
  };
  return [address, go, back];
}

/**
 * History's query without its paging: the range, the machines (by id; null for every machine) and the filter field's other
 * words. What the list asks for and what Export downloads. Null when there is no machine to ask for.
 */
export function historyQuery({ day, to }: Pick<Address, "day" | "to">, machines: readonly string[] | null, words: string): URLSearchParams | null {
  if (machines?.length === 0) return null;
  const params = new URLSearchParams();
  if (day) params.set("day", day);
  if (to) params.set("to", to);
  for (const id of machines ?? []) params.append("machine", id);
  historyParams(words, params);
  return params;
}

/**
 * One page of the range's ended sessions, or with a group its groups (no paging), read again when `reload` changes (after a
 * delete) and, while plain words search, when the reader's right to read kept text changes; and the server's today as its last
 * answer gave it (null before the first). Within a range and grouping the shown list stays up while the next loads; another
 * range starts empty. A change of the filter's words waits until typing pauses. A page past the end comes back as the last one,
 * and the address follows. With no machine to ask for, nothing is asked.
 */
export function useDayPage(address: Address, machines: readonly string[] | null, words: string, go: Go, reload: number, readsKept: boolean): { list: Load<DayPage>; today: string | null } {
  const { day, to, page, size, group } = address;
  const [list, setList] = useState<Load<DayPage>>({ state: "loading" });
  const [today, setToday] = useState<string | null>(null);
  const asked = historyQuery(address, machines, words);
  const query = asked?.toString() ?? null;
  // The server searches kept text only for a reader who may read it, so only a search's answer follows that.
  const reader = readsKept && asked?.has("q") === true;
  const lastWords = useRef(words);
  useEffect(() => {
    if (query === null) return;
    let current = true;
    const span = `${day}|${to}|${group}`;
    setList((shown) => (shown.state === "ok" && shown.data.span === span ? shown : { state: "loading" }));
    const typing = words !== lastWords.current;
    lastWords.current = words;
    const params = new URLSearchParams(query);
    if (group) params.set("group", group);
    else {
      params.set("page", String(page));
      params.set("pageSize", String(size));
    }
    const timer = setTimeout(() => {
      getJson<HistoryReply>(`/history?${params.toString()}`).then(
        (r) => {
          if (!current) return;
          setToday(r.today);
          setList({ state: "ok", data: { asked: day, span, day: r.day, rows: r.sessions ?? [], groups: group ? { by: group, rows: r.groups ?? [] } : null, total: r.total, page: r.page ?? 1, pageSize: r.pageSize ?? size } });
          if (!group && r.page !== undefined && r.page !== page) go({ page: r.page });
        },
        (err: Error) => current && setList({ state: "error", message: err.message }),
      );
    }, typing ? TYPING_MS : 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `go` reads the latest address through a ref, so the render it came from does not matter; `query` holds the range and words.
  }, [query, page, size, group, reload, reader]);
  return { list, today };
}

/**
 * The ended stored sessions with these ids (GET /history?ids=), in their order, HISTORY_IDS asked at a time; one the server does
 * not return (unknown, not ended, deleted, hidden from History's list) is left out.
 */
export async function readSessions(ids: readonly string[]): Promise<HistoryRow[]> {
  const asks: Promise<{ sessions: HistoryRow[] }>[] = [];
  for (let i = 0; i < ids.length; i += HISTORY_IDS) asks.push(getJson(`/history?${ids.slice(i, i + HISTORY_IDS).map((id) => `ids=${encodeURIComponent(id)}`).join("&")}`));
  return (await Promise.all(asks)).flatMap((r) => r.sessions);
}

/** The stored session the address opens; null while none is. */
export function useStoredSession(id: string | null): Load<SessionView> | null {
  const [stored, setStored] = useState<Load<SessionView> | null>(null);
  useEffect(() => {
    if (id === null) return setStored(null);
    let current = true;
    setStored({ state: "loading" });
    getJson<SessionView>(`/sessions/${encodeURIComponent(id)}`).then(
      (s) => current && setStored({ state: "ok", data: s }),
      (err: Error) => current && setStored({ state: "error", message: err.message }),
    );
    return () => {
      current = false;
    };
  }, [id]);
  return stored;
}

/** The rows a page holds, counted from 1 ("26 to 50 of 120"), and how many pages there are; 0 to 0 on one page when empty. */
export function pageSpan(page: number, size: number, total: number): { first: number; last: number; pages: number } {
  if (total === 0) return { first: 0, last: 0, pages: 1 };
  const before = (page - 1) * size;
  return { first: before + 1, last: Math.min(total, before + size), pages: Math.ceil(total / size) };
}
