// The product's mark: an S drawn as one line between two stations, the far one working: the name's letter in the console's
// own picture of a session. Drawn, never a letter in a square; the line and its first station in ink, the working station in
// the working colour, as a working session's mark is. Decorative: the wordmark (APP_NAME) beside it carries the name.
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg className="shell-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M17.2 4.8H10.4a3.6 3.6 0 0 0 0 7.2h3.2a3.6 3.6 0 0 1 0 7.2H6.8" fill="none" stroke="var(--ink-2)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="17.6" cy="4.8" r="3" fill="var(--line)" />
      <circle cx="6.4" cy="19.2" r="3" fill="var(--ink)" />
    </svg>
  );
}
