// Copying: the hook every copy control uses, and how many characters of a session id a short label shows.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { IconCheck, IconCopy } from "./Icons";
import "./chips.css";

/** How long "Copied" (or "Copy failed") stays. */
const SHOWN_MS = 1600;
/** The characters of a session id shown; a press copies all of it. */
export const SHORT_ID = 8;

type CopyState = "idle" | "copied" | "failed";

/**
 * The standard fallback where the page is not a secure context, as on plain HTTP across the LAN, and navigator.clipboard is
 * absent: the text selected in a hidden textarea and copied with execCommand. The textarea goes inside the control's dialog
 * when it is in one, since a modal dialog leaves the rest of the page inert; focus then goes back where it was.
 */
function copyBySelection(text: string, control: Element | undefined): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.cssText = "position: fixed; top: 0; left: 0; opacity: 0";
  const focused = document.activeElement;
  (control?.closest("dialog") ?? document.body).append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    // Refused: not copied.
  }
  area.remove();
  if (focused instanceof HTMLElement) focused.focus();
  return copied;
}

/**
 * Copies `text` on a press; pass the press's event (`onClick={copy}`) so the fallback finds the control's dialog. `state` says
 * copied or failed for 1.6 s after each try, then idle again.
 */
export function useCopy(text: string): { state: CopyState; copy: (press?: { currentTarget: Element }) => void } {
  const [state, setState] = useState<CopyState>("idle");
  const reset = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(reset.current), []);
  const show = (outcome: Exclude<CopyState, "idle">) => {
    clearTimeout(reset.current);
    setState(outcome);
    reset.current = setTimeout(() => setState("idle"), SHOWN_MS);
  };
  const copy = (press?: { currentTarget: Element }) => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return show(copyBySelection(text, press?.currentTarget) ? "copied" : "failed");
    void clipboard.writeText(text).then(
      () => show("copied"),
      () => show("failed"),
    );
  };
  return { state, copy };
}

/**
 * A session's id to copy where sessions are listed (cards, List rows, History): its first SHORT_ID characters (all of it on a
 * card, `full`, so it reads as the session id and not a commit), and a press copies all of it. The press never reaches the row or card it sits in. Place it outside the row's link, not inside it.
 */
export function SessionIdCopy({ id, full = false }: { id: string; full?: boolean }) {
  const { state, copy } = useCopy(id);
  const Mark = state === "copied" ? IconCheck : IconCopy;
  const press = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    copy(e);
  };
  return (
    <button type="button" className="id-copy" title={`Copy session id: ${id}`} aria-label={`Copy session id ${id.slice(0, SHORT_ID)}`} onClick={press}>
      <Mark />
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : full ? id : id.slice(0, SHORT_ID)}</span>
    </button>
  );
}
