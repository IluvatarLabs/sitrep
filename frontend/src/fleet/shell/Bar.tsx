// The top bar, left to right: the way back to a folded sidebar, the filter field (its prefixes in its title; seen
// only on the pages that apply it, filter.ts FILTERED_ROUTES), the stream's state (it opens Machines), "N need you" (it opens
// the answer drawer on the longest wait), then Activity, display mode, the theme and Settings as icons, and Sign in, or Admin
// with Sign out, at the far end. Icons here are our own line glyphs.
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { hashFor, type Route } from "../../route";
import { IconChevron } from "../components/Icons";
import { SignInSection } from "../components/SignIn";
import { ADMIN_NAME } from "../respondApi";
import type { Phase } from "../store";
import { Station, type StationKind } from "../ui/Station";
import { useRespond } from "../useRespond";
import { MODES, type ModeChoice, type ThemeState } from "../useTheme";
import { FILTER_FIELDS, FILTERED_ROUTES, type FilterField } from "./filter";
import { needYouWords } from "./Nav";

// The popover attributes, which these React typings predate (React passes them through to the DOM as written).
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> {
    popover?: "" | "auto" | "manual" | undefined;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ButtonHTMLAttributes<T> {
    popovertarget?: string | undefined;
  }
}

const HINT = (Object.keys(FILTER_FIELDS) as FilterField[]).map((f) => `${f}: ${FILTER_FIELDS[f]}`).join(" · ");

/** A line glyph on the 16-unit grid, drawn by ui.css's `svg.i`. */
const glyph = (body: ReactNode) => (
  <svg className="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    {body}
  </svg>
);

const ACTIVITY = glyph(<path d="M2.5 3h11v10h-11zM9.5 3v10" />);
const DISPLAY = glyph(<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />);
const SETTINGS = glyph(
  <>
    <path d="M2 4.5h12M2 11.5h12" />
    <circle cx="10.5" cy="4.5" r="2" fill="var(--frame)" />
    <circle cx="5.5" cy="11.5" r="2" fill="var(--frame)" />
  </>,
);
/** System is half a disc; Light a sun; Dark a moon. */
const THEME_GLYPH: Record<ModeChoice, ReactNode> = {
  system: glyph(
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
    </>,
  ),
  light: glyph(
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.75M8 12.75v1.75M1.5 8h1.75M12.75 8h1.75M3.4 3.4l1.25 1.25M11.35 11.35l1.25 1.25M3.4 12.6l1.25-1.25M11.35 4.65l1.25-1.25" />
    </>,
  ),
  dark: glyph(<path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z" />),
};
const MODE_WORD: Record<ModeChoice, string> = { system: "System", light: "Light", dark: "Dark" };

/** The stream's state, and the mark it shows (a lost stream is a failure: red means only that); the wall view says it too. */
export const STREAM: Readonly<Record<Phase, { word: string; mark: StationKind }>> = {
  live: { word: "Live", mark: "working" },
  loading: { word: "Connecting…", mark: "offline" },
  disconnected: { word: "Disconnected", mark: "failed" },
};

/**
 * What a lost stream's notice says (useFleet keeps reopening it), as the desk's strip and the wall's banner say it. After a first
 * snapshot the figures shown are the last it sent: frozen until it reconnects, or since `since` where the notice gives the time.
 * Before one there are none, so it says only that the server can't be reached.
 */
export function lostWords(loaded: boolean, since?: string): { head: string; rest: string } {
  if (!loaded) return { head: "Can't reach the server.", rest: "Retrying." };
  return { head: "Connection to the server lost.", rest: `Retrying; the figures are frozen ${since ? `since ${since}` : "until it reconnects"}.` };
}

/** The stream's state, opening Machines. */
export function StreamPill({ phase }: { phase: Phase }) {
  const { word, mark } = STREAM[phase];
  return (
    <a className="shell-conn" href={hashFor("machines")} title="Machines">
      <Station kind={mark} />
      <span aria-live="polite">{word}</span>
    </a>
  );
}

/** Opening places a popover under its button, their right edges lined up. */
function usePlacedUnder(panel: RefObject<HTMLElement>, button: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = panel.current;
    if (!el) return undefined;
    const place = (e: Event) => {
      const box = button.current?.getBoundingClientRect();
      if ((e as ToggleEvent).newState !== "open" || !box) return;
      el.style.top = `${Math.round(box.bottom + 4)}px`;
      el.style.right = `${Math.max(8, Math.round(document.documentElement.clientWidth - box.right))}px`;
    };
    el.addEventListener("beforetoggle", place);
    return () => el.removeEventListener("beforetoggle", place);
  });
}

/**
 * Sign in, or the signed-in name with Sign out, in a popover (components/SignIn). Nothing until the server has said who is in,
 * nor while it has no admin secret to sign in with: with its switches on, `me.enabled` is false only then (respondRoutes.ts).
 */
function SignInMenu() {
  const ctx = useRespond();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  usePlacedUnder(panel, button);
  const me = ctx?.me;
  if (!me || (!me.signedIn && ctx.settingsOn && !me.enabled)) return null;
  const label = me.signedIn ? (me.name ?? ADMIN_NAME) : "Sign in";
  return (
    <>
      <button ref={button} type="button" className="ui-button shell-signin" aria-haspopup="dialog" popovertarget={id}>
        {label}
        {me.signedIn ? <IconChevron /> : null}
      </button>
      <div ref={panel} id={id} popover="auto" className="shell-pop" role="dialog" aria-label={label}>
        <SignInSection />
      </div>
    </>
  );
}

interface BarProps {
  id: string;
  hidden: boolean;
  route: Route;
  /** The sidebar is folded away: a button brings it back. */
  sidebar: { controls: string; folded: boolean; onShow: () => void };
  query: string;
  onQuery: (q: string) => void;
  stream: Phase;
  needYou: number;
  onNeedYou: (opener: HTMLElement) => void;
  activity: { controls: string; open: boolean; onToggle: () => void };
  onDisplay: () => void;
  theme: ThemeState;
}

export function Bar({ id, hidden, route, sidebar, query, onQuery, stream, needYou, onNeedYou, activity, onDisplay, theme }: BarProps) {
  const hintId = useId();
  const next = MODE_WORD[MODES[(MODES.indexOf(theme.mode) + 1) % MODES.length]!];
  const themeLabel = `Theme: ${MODE_WORD[theme.mode]}. Switch to ${next}`;
  return (
    <header className="shell-top" id={id} hidden={hidden}>
      {sidebar.folded ? (
        <button type="button" className="ui-button ui-button--icon" aria-label="Show the sidebar" title="Show the sidebar ([)" aria-controls={sidebar.controls} aria-expanded="false" onClick={sidebar.onShow}>
          <IconChevron className="shell-chev-right" />
        </button>
      ) : null}
      {/* Only where the page applies it; elsewhere unseen in its own place, so nothing after it moves, its words kept. */}
      <div className={FILTERED_ROUTES.has(route) ? "shell-filter" : "shell-filter is-off"} role="search" title={HINT}>
        {glyph(<path d="M10.4 10.4 14 14M11.6 7A4.6 4.6 0 1 1 2.4 7a4.6 4.6 0 0 1 9.2 0z" />)}
        <input type="search" aria-label="Filter sessions" aria-describedby={hintId} placeholder="Filter" autoComplete="off" spellCheck={false} value={query} onChange={(e) => onQuery(e.target.value)} />
        <span id={hintId} className="ui-vh">
          {HINT}
        </span>
      </div>
      <StreamPill phase={stream} />
      <span className="shell-top-gap" />
      {needYou > 0 ? (
        <button type="button" className="ui-button" title="Answer the longest wait" aria-haspopup="dialog" onClick={(e) => onNeedYou(e.currentTarget)}>
          <Station kind="needs-you" />
          {needYouWords(needYou)}
        </button>
      ) : null}
      <button type="button" className="ui-button ui-button--icon shell-toggle" aria-label="Activity" title="Activity (])" aria-controls={activity.controls} aria-expanded={activity.open} onClick={activity.onToggle}>
        {ACTIVITY}
      </button>
      <button type="button" className="ui-button ui-button--icon" aria-label="Display mode" title="Display mode (w)" onClick={onDisplay}>
        {DISPLAY}
      </button>
      <button type="button" className="ui-button ui-button--icon" aria-label={themeLabel} title={themeLabel} onClick={theme.cycle}>
        {THEME_GLYPH[theme.mode]}
      </button>
      <a className="ui-button ui-button--icon" href={hashFor("settings")} aria-label="Settings" title="Settings" aria-current={route === "settings" ? "page" : undefined}>
        {SETTINGS}
      </a>
      <SignInMenu />
    </header>
  );
}
