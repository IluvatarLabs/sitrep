// One document-level listener for the shell's single-key shortcuts. It leaves alone keys typed into fields and editable text,
// keys with Ctrl, Meta or Alt held, keys on a resize separator (which takes the arrows, Home and Escape itself), and every key
// while a modal dialog (the answer drawer) is open, so the page behind it rests.
import { useEffect, useRef } from "react";

const TYPING = "input, textarea, select, [role='separator'], [contenteditable]:not([contenteditable='false'])";

/** A key someone else takes: already handled, a browser shortcut, typing, or any key while a dialog is open. */
const othersKey = (e: KeyboardEvent): boolean =>
  e.defaultPrevented ||
  e.ctrlKey ||
  e.metaKey ||
  e.altKey ||
  document.querySelector("dialog[open], [aria-modal='true']") !== null ||
  (e.target instanceof Element && e.target.closest(TYPING) !== null);

export function useHotkeys(handle: (e: KeyboardEvent) => void): void {
  // The newest handler, so the listener is added once and still sees the current state.
  const latest = useRef(handle);
  useEffect(() => {
    latest.current = handle;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!othersKey(e)) latest.current(e);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
