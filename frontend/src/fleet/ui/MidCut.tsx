// A name cut in the middle when it does not fit, so names that differ only at their end ("…tests-159", "…tests-160") stay
// apart: the standard CSS middle truncation, a head that ends in "…" and a tail of the last characters that never shrinks.
// Whole when it fits; the full text is always the title, and what assistive tech reads (the two parts are hidden from it, so
// no break is read at the cut). Styles: ui.css (.ui-midcut).

/** Characters the tail keeps. */
const TAIL = 8;

export function MidCut({ text }: { text: string }) {
  // By code point, so a character is never split.
  const chars = Array.from(text);
  const cut = chars.length - TAIL;
  return (
    <span className="ui-midcut" title={text}>
      <span className="ui-vh">{text}</span>
      {cut > 0 ? (
        <>
          <span className="ui-midcut-head" aria-hidden="true">
            {chars.slice(0, cut).join("")}
          </span>
          <span className="ui-midcut-tail" aria-hidden="true">
            {chars.slice(cut).join("")}
          </span>
        </>
      ) : (
        <span className="ui-midcut-head" aria-hidden="true">
          {text}
        </span>
      )}
    </span>
  );
}
