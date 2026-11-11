import type { ReactNode } from "react";

/** A chevron on the 16-unit grid (styles: ui/ui.css .ui-pager). */
const chevron = (d: string) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={d} />
  </svg>
);
const BACK = chevron("M10 3.5 5.5 8l4.5 4.5");
const ON = chevron("M6 3.5 10.5 8 6 12.5");

interface PageNavProps {
  /** The page buttons' name for assistive tech. */
  label: string;
  /** The page shown and how many there are, counted from 0. */
  at: number;
  pages: number;
  /** The first row shown (from 0), how many are shown, and how many there are. */
  from: number;
  shown: number;
  total: number;
  perPage: number;
  onPage: (page: number) => void;
  /** "2 of 5" between the two chevrons instead of a button per page. */
  compact?: boolean;
  /** A control of the list's own (History's rows per page), in place of the "per page" words. */
  children?: ReactNode;
}

/**
 * The one pager: the rows shown, then the pages once there is more than one. Plan and Files (session page), the Plans board
 * and History use it.
 */
export function PageNav({ label, at, pages, from, shown, total, perPage, onPage, compact = false, children }: PageNavProps) {
  const range = <span>{`Showing ${from + 1}–${from + shown} of ${total}`}</span>;
  if (pages <= 1) {
    return (
      <div className="ui-pager">
        {range}
        {children ?? <span>{`${perPage} per page`}</span>}
      </div>
    );
  }
  const go = (page: number, name: string, mark: ReactNode) => (
    <button type="button" aria-label={name} disabled={page < 0 || page >= pages} onClick={() => onPage(page)}>
      {mark}
    </button>
  );
  const numbered = Array.from({ length: pages }, (_, page) => (
    <button key={page} type="button" aria-current={page === at ? "page" : undefined} onClick={() => onPage(page)}>
      {page + 1}
    </button>
  ));
  return (
    <div className="ui-pager">
      {range}
      <nav className="ui-pager-pages" aria-label={label}>
        {go(at - 1, "Previous page", BACK)}
        {compact ? <span className="ui-pager-at">{`${at + 1} of ${pages}`}</span> : numbered}
        {go(at + 1, "Next page", ON)}
      </nav>
      {children}
    </div>
  );
}
