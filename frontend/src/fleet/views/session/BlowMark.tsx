// The mark for a context blowout, the same ink diamond the Timeline draws on a line: its shape says what it is.
export function BlowMark() {
  return (
    <svg className="sv-ic" viewBox="-7 -7 14 14" width="14" height="14" aria-hidden="true">
      <path d="M0 -5.5L5.5 0L0 5.5L-5.5 0Z" fill="var(--ink)" />
    </svg>
  );
}
