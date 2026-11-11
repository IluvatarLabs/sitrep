// The one panel: a square head (Back, title, one close) over a body. Docked, it fills its container (the inspector's
// agent detail). Modal, it is raised over the page on the browser's own <dialog> (Sheet: inert page, Tab kept inside,
// Escape and a press outside close it), flush right and full height: answering, report texts, the expanded feed.
import type { ReactNode } from "react";
import { IconX } from "../components/Icons";
import { closeSheetOf, Sheet } from "../shell/Sheet";

export interface PanelProps {
  /** The panel's name, shown in its head on the element with id `titleId`. */
  title: ReactNode;
  titleId: string;
  /** A line under the title. */
  sub?: ReactNode;
  /** The close control and, for a modal panel, Escape and a press outside. */
  onClose: () => void;
  /** A Back control before the title, for detail opened from a list. */
  back?: { label: string; onBack: () => void } | null;
  /** Raised as a modal dialog over the page; otherwise docked in its container. */
  modal?: boolean;
  /** Modal only: hears Escape first and returns true when it used the key (the panel then stays). */
  onEscape?: () => boolean;
  /** Modal only: true closes the panel, as Escape does. */
  closing?: boolean;
  className?: string;
  children: ReactNode;
}

/** Closes the modal panel a control sits in, as Escape does. */
export const closePanelOf = closeSheetOf;

export function Panel({ title, titleId, sub, onClose, back, modal = false, onEscape, closing, className, children }: PanelProps) {
  const head = (
    <header className="ui-panel-head">
      {back ? (
        <button type="button" className="ui-button ui-panel-back" onClick={back.onBack}>
          ‹ {back.label}
        </button>
      ) : null}
      {/* A modal panel takes focus on its title, so a screen reader reads it first and the close is not ringed on open. */}
      <h2 id={titleId} className="ui-panel-title" tabIndex={modal ? -1 : undefined} data-autofocus={modal ? "" : undefined}>
        {title}
      </h2>
      {/* A modal panel closes through its dialog, as Escape does, so focus goes back to what opened it. */}
      <button type="button" className="ui-panel-close" aria-label={modal ? "Close (Esc)" : "Close"} title={modal ? "Close (Esc)" : "Close"} onClick={(e) => (modal ? closeSheetOf(e.currentTarget) : onClose())}>
        <IconX />
      </button>
      {sub ? <div className="ui-panel-sub">{sub}</div> : null}
    </header>
  );
  const cls = `ui-panel${className ? ` ${className}` : ""}`;
  if (modal) {
    return (
      <Sheet labelledBy={titleId} className={`${cls} ui-panel--modal`} onClose={onClose} onEscape={onEscape} closing={closing}>
        {head}
        <div className="ui-panel-body">{children}</div>
      </Sheet>
    );
  }
  return (
    <section className={cls} aria-labelledby={titleId}>
      {head}
      <div className="ui-panel-body">{children}</div>
    </section>
  );
}
