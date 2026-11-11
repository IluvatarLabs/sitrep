// The one mark for a value the harness does not report: a dash, with the reason on hover and in words for screen readers
// (an aria-label on a plain span is not read, so the words are visually hidden text).
export function Unknown({ reason }: { reason: string }) {
  return (
    <span className="ui-unknown" title={reason}>
      <span aria-hidden="true">—</span>
      <span className="ui-vh">{`Unknown: ${reason}`}</span>
    </span>
  );
}
