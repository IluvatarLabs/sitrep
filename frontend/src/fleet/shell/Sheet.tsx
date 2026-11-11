// A modal sheet on the browser's own <dialog>, shown with showModal(): the page behind is inert, Tab stays inside, and Escape
// closes it. Focus moves to the element marked data-autofocus (else the browser's first focusable one). A press that starts
// on the dimmed area closes it too. `onEscape` hears Escape first and returns true when it used the key (a confirmation it
// closed), and then the sheet stays. Every way of closing goes through the dialog's own close(): Escape, a press outside,
// closeSheetOf for a control inside, and `closing` for the caller (the drawer's session left). The page stops being inert
// first, and then `onClose` runs on the dialog's close event, so the caller can return focus to what opened it. The dialog
// element itself never scrolls, pads or draws a border, so a press on it is a press on the dimmed area.
import { useEffect, useRef, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";

interface SheetProps {
  labelledBy: string;
  className: string;
  onClose: () => void;
  onEscape?: () => boolean;
  /** True closes the sheet, as Escape does. */
  closing?: boolean;
  children: ReactNode;
}

/** Closes the sheet a control sits in, as Escape does. */
export function closeSheetOf(el: Element): void {
  el.closest("dialog")?.close();
}

export function Sheet({ labelledBy, className, onClose, onEscape, closing = false, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // The newest handlers, for the events the dialog keeps for its whole life.
  const handlers = useRef({ onClose, onEscape });
  handlers.current = { onClose, onEscape };

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    // Unmounting removes the element, and with it the dialog from the top layer.
  }, []);

  // After the opening above, so a sheet asked to close as it mounts still closes through its own close event.
  useEffect(() => {
    if (closing) ref.current?.close();
  }, [closing]);

  const onCancel = (e: SyntheticEvent<HTMLDialogElement>) => {
    if (handlers.current.onEscape?.()) e.preventDefault();
  };
  const onPressBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  };
  return (
    <dialog ref={ref} className={className} aria-labelledby={labelledBy} onCancel={onCancel} onClose={() => handlers.current.onClose()} onMouseDown={onPressBackdrop}>
      {children}
    </dialog>
  );
}
