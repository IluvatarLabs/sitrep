// The one separator: items with a dot between them, "a · b · c", wrapping between items. It is the standard
// wrapped-inline-list technique: every item after the first draws its dot just before itself, in the gap the item before it
// leaves, and the list clips at its start edge, so the dot of an item that starts a line falls outside and is never seen.
// No line ever starts or ends with a dot. The dot is drawn, not text; between items assistive technology reads a comma.
// className "is-oneline" holds the list to one line that ends in "…", cut inside an item's words (items and dots run as
// inline text there, so the ellipsis can hide a dot). Styles: ui.css (.ui-dots).
import type { ReactNode } from "react";

/** Whether an item is drawn: null, undefined, booleans and "" are skipped; 0 is a value and stays. */
function drawn(item: ReactNode): boolean {
  return item !== null && item !== undefined && typeof item !== "boolean" && item !== "";
}

/** The items with a dot between them. `className` styles the list itself: "is-oneline" for one line ending in "…", or its type. */
export function Dots({ items, className }: { items: ReactNode[]; className?: string }) {
  const shown = items.filter(drawn);
  return (
    <span className={className ? `ui-dots ${className}` : "ui-dots"}>
      {shown.map((item, i) => (
        <span key={i}>
          {i > 0 ? <span className="ui-vh">, </span> : null}
          {item}
        </span>
      ))}
    </span>
  );
}

/** The same list as plain text, for a title, an aria-label or copied text: the items joined by " · ", empty ones skipped. */
export function dotsText(items: (string | null | undefined | false)[]): string {
  return items.filter((item): item is string => typeof item === "string" && item !== "").join(" · ");
}
