// History's state: its address (`#/history?day=&page=&size=&open=`), one day's page of ended sessions, and the stored session
// the address opens. Every day is the server's, the simplest rule: an address with no day asks the server for its own
// today, and every answer names the day it holds and the server's today. The day, page, page size and open session live in the
// address, so a reload, a shared link and Back all land on the same view; a change of day is a history entry of its own, so
// Back walks the days. The machines asked for come from the filter field's `m:` word, not the address.
import { useEffect, useRef, useState } from "react";
import { addDays } from "../../../../../server/src/fleet/days";
import type { HistoryRow, SessionView } from "../../types";
import { getJson, type Load } from "../settings/api";

export const PAGE_SIZES: readonly number[] = [25, 50, 100];
const DEFAULT_SIZE = 50;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `day` null: the server's today, whichever day that is when it is asked. */
type Address = { day: string | null; page: number; size: number; open: string | null };
/** A page of a day: `asked` is the address's day it answers (null for today), `day` the day the server says it holds. */
export type DayPage = { asked: string | null; day: string; rows: HistoryRow[]; total: number; page: number; pageSize: number };
type HistoryReply = { day: string; today: string; sessions: HistoryRow[]; total: number; page: number; pageSize: number };

/** A `YYYY-MM-DD` that names a real calendar day: 2026-13-45 has the form and no day (the calendar would roll it over). */
const isRealDay = (day: string): boolean => ISO_DAY.test(day) && addDays(day, 0) === day;

/** The address after `#/history?`; a part missing or malformed takes its default (the day: the server's today). */
function readAddress(hash: string): Address {
  const params = new URLSearchParams(hash.split("?")[1] ?? "");
  const day = params.get("day") ?? "";
  const page = Number(params.get("page"));
  const size = Number(params.get("size"));
  return {
    day: isRealDay(day) ? day : null,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    size: PAGE_SIZES.find((n) => n === size) ?? DEFAULT_SIZE,
    open: params.get("open") || null,
  };
}

function addressHash({ day, page, size, open }: Address): string {
  const params = new URLSearchParams();
  if (day) params.set("day", day);
  params.set("page", String(page));
  params.set("size", String(size));
  if (open) params.set("open", open);
  return `#/history?${params.toString()}`;
}

/** History's read-only page of one stored session, its list on the server's today: where a session's page goes once it ends. */
export const storedHash = (id: string): string => addressHash({ day: null, page: 1, size: DEFAULT_SIZE, open: id });

/** A hash that named a day it was refused (readAddress): its address, the server's today, is written back in place, no history entry. */
function correctDay(hash: string, address: Address): void {
  const given = new URLSearchParams(hash.split("?")[1] ?? "").get("day");
  if (given !== null && address.day === null) window.history.replaceState(window.history.state, "", addressHash(address));
}

export type Go = (patch: Partial<Address>, how?: "push" | "replace") => void;

/**
 * The view's address, kept in step with Back and Forward. `go` changes part of it: a new day or opening a session pushes a
 * history entry, so Back returns to the day or the list before; anything else (a page, the page size) replaces the current one.
 */
export function useAddress(): [Address, Go] {
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
    const entry = { open: target.open !== null };
    if (how === "push") window.history.pushState(entry, "", addressHash(target));
    else window.history.replaceState(entry, "", addressHash(target));
  };
  return [address, go];
}

/**
 * One page of a day's ended sessions on `machines` (by id; null for every machine), read again when `reload` changes (after a
 * delete), and the server's today as its last answer gave it (null before the first). Within a day the shown page stays up while
 * the next loads; another day starts empty. A page past the end comes back as the last one, and the address follows. With no
 * machine to ask for, nothing is asked.
 */
export function useDayPage({ day, page, size }: Address, machines: readonly string[] | null, go: Go, reload: number): { list: Load<DayPage>; today: string | null } {
  const [list, setList] = useState<Load<DayPage>>({ state: "loading" });
  const [today, setToday] = useState<string | null>(null);
  // Each machine as its own `machine=`; null when there is none to ask for.
  const only = machines === null ? "" : machines.length > 0 ? machines.map((id) => `&machine=${encodeURIComponent(id)}`).join("") : null;
  useEffect(() => {
    if (only === null) return;
    let current = true;
    setList((shown) => (shown.state === "ok" && shown.data.asked === day ? shown : { state: "loading" }));
    const query = `${day ? `day=${encodeURIComponent(day)}&` : ""}page=${page}&pageSize=${size}${only}`;
    getJson<HistoryReply>(`/history?${query}`).then(
      (r) => {
        if (!current) return;
        setToday(r.today);
        setList({ state: "ok", data: { asked: day, day: r.day, rows: r.sessions, total: r.total, page: r.page, pageSize: r.pageSize } });
        if (r.page !== page) go({ page: r.page });
      },
      (err: Error) => current && setList({ state: "error", message: err.message }),
    );
    return () => {
      current = false;
    };
    // `go` reads the latest address through a ref, so the render it came from does not matter.
  }, [day, page, size, only, reload]);
  return { list, today };
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
