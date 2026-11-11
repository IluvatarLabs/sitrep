// Attention. The tab title and the favicon count the sessions that need you (states.ts needsYou: a question, permission or plan,
// or an open ask; never an idle turn), always, plain HTTP included. Browser notifications are opt-in (Settings) and fire once per
// transition, keyed per session and condition: needs you on a decision, stuck (a session, or an agent of one), failed, or a plan
// window at 90 % or more. Browsers allow the Notification API only in a secure context (HTTPS or localhost), so elsewhere the
// setting says why it is unavailable.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hashFor } from "../route";
import { providerInfo } from "./provider";
import { readJson, writeJson } from "./storage";
import { needsYou } from "./states";
import type { MachineView, SessionView } from "./types";
import { limitLabel, limitLevel, staleWords } from "./limits";
import { dotsText } from "./ui/Dots";
import { loopName } from "./views/now/queue";

const STORE_KEY = "notify";

/** Live sessions that need you: what the title and the favicon count. */
export function needYouCount(sessions: Record<string, SessionView>): number {
  return Object.values(sessions).filter(needsYou).length;
}

/** The page's icon (public/favicon.svg): the mark in --ink-2, --ink and --line on the light theme's --band, from ui/tokens.css. */
const ICON_MARK =
  `<rect width="32" height="32" rx="2" fill="#f0f0f0"/>` +
  `<g transform="translate(1.44 0.4) scale(1.3)"><path d="M17.2 4.8H10.4a3.6 3.6 0 0 0 0 7.2h3.2a3.6 3.6 0 0 1 0 7.2H6.8" fill="none" stroke="#383838" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<circle cx="17.6" cy="4.8" r="3" fill="#009741"/><circle cx="6.4" cy="19.2" r="3" fill="#111111"/></g>`;

/** The favicon with a count badge in the needs-you amber with its ink outline (tokens.css, light), as an SVG data URL. */
function badgeIcon(count: number): string {
  const label = count > 9 ? "9+" : String(count);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${ICON_MARK}` +
    `<circle cx="22" cy="16" r="9.25" fill="#f2a900" stroke="#111111" stroke-width="1.5"/>` +
    `<text x="22" y="20.5" text-anchor="middle" font-family="IBM Plex Sans,system-ui,-apple-system,Segoe UI,Arial,sans-serif" font-weight="700" font-size="${label.length > 1 ? 11 : 13}" fill="#111111">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Sets "(2) SITREP" and the badged favicon from the count; restores both when the count is zero or the page goes. */
export function useTitleCount(title: string, count: number): void {
  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${title}` : title;
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (!link) return;
    const original = link.getAttribute("href") ?? "/favicon.svg";
    if (count > 0) link.setAttribute("href", badgeIcon(count));
    return () => link.setAttribute("href", original);
  }, [title, count]);
}

export type NotifyAvailability = "on" | "off" | "insecure" | "unsupported" | "blocked";

/** The viewer's opt-in and whether the browser lets it work. */
export function useNotifyPref(): { availability: NotifyAvailability; toggle: () => void } {
  const [wanted, setWanted] = useState(() => readJson<unknown>(STORE_KEY, false) === true);
  const [permission, setPermission] = useState<NotificationPermission | null>(() => (typeof Notification === "undefined" ? null : Notification.permission));
  const secure = typeof window !== "undefined" && window.isSecureContext;
  let availability: NotifyAvailability;
  if (!secure) availability = "insecure";
  else if (permission === null) availability = "unsupported";
  else if (permission === "denied") availability = "blocked";
  else availability = wanted && permission === "granted" ? "on" : "off";

  const toggle = useCallback(() => {
    if (!secure || typeof Notification === "undefined") return;
    if (wanted && Notification.permission === "granted") {
      setWanted(false);
      writeJson(STORE_KEY, false);
      return;
    }
    setWanted(true);
    writeJson(STORE_KEY, true);
    if (Notification.permission === "default") void Notification.requestPermission().then(setPermission);
    else setPermission(Notification.permission);
  }, [secure, wanted]);

  return useMemo(() => ({ availability, toggle }), [availability, toggle]);
}

interface Alert {
  key: string;
  title: string;
  body: string;
  sessionId: string | null;
}

/**
 * Every condition that notifies, true or false now, keyed so one session's or window's state is followed over time. A stale
 * plan window (limits.ts staleWords, the rule that mutes it everywhere) does not count.
 */
function conditions(sessions: Record<string, SessionView>, machines: readonly MachineView[], now: number): Map<string, Alert | null> {
  const out = new Map<string, Alert | null>();
  for (const s of Object.values(sessions)) {
    if (s.status === "done") continue;
    const where = dotsText([s.project, s.machine.name]);
    const flag = (key: string, on: boolean, title: string) => {
      out.set(key, on ? { key, title, body: `${s.name}\n${where}`, sessionId: s.id } : null);
    };
    // The one rule every count of "needs you" follows (a Codex question can arrive while the turn runs); never idle.
    flag(`you:${s.id}`, needsYou(s), "Needs you");
    flag(`stuck:${s.id}`, s.stuck, "Stuck");
    flag(`err:${s.id}`, s.errored !== null, "Failed");
    // An agent stuck inside a working session.
    for (const a of s.agents) {
      const key = `stuck:${s.id}:${a.id}`;
      out.set(key, a.stuck ? { key, title: "Agent stuck", body: `${loopName(s, a.id)}\n${where}`, sessionId: s.id } : null);
    }
  }
  for (const m of machines) {
    for (const p of m.rateLimits) {
      for (const l of p.limits) {
        const key = `limit:${m.id}:${p.provider}:${l.kind}`;
        const name = providerInfo(p.provider).name;
        out.set(key, limitLevel(l.percentUsed) === "crit" && staleWords(l, now) === null ? { key, title: `${name} ${limitLabel(l.kind)} limit ${Math.round(l.percentUsed)}% used`, body: m.name, sessionId: null } : null);
      }
    }
  }
  return out;
}

/** Fires one notification per false-to-true transition while the viewer has them on. What is true on load is a baseline. */
export function useNotifications(on: boolean, ready: boolean, sessions: Record<string, SessionView>, machines: readonly MachineView[]): void {
  const prev = useRef<Map<string, boolean> | null>(null);
  useEffect(() => {
    if (!ready) return;
    const now = conditions(sessions, machines, Date.now());
    const before = prev.current;
    prev.current = new Map([...now].map(([k, v]) => [k, v !== null]));
    if (!before || !on || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const alert of now.values()) {
      if (!alert || before.get(alert.key)) continue;
      try {
        const n = new Notification(alert.title, { body: alert.body, tag: alert.key });
        const id = alert.sessionId;
        n.onclick = () => {
          window.focus();
          if (id) window.location.hash = hashFor("session", id);
          n.close();
        };
      } catch {
        // Some browsers allow notifications only from a service worker: the title count still works.
      }
    }
  }, [on, ready, sessions, machines]);
}
