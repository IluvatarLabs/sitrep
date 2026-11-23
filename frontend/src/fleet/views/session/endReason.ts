// Why a session ended, in words. Claude Code reports its SessionEnd hook's own reason (`clear`, `resume`, `logout`,
// `prompt_input_exit`, `other`); the Codex reporter reports `other`; the server writes `heartbeat lost` for one it dropped
// after it went offline.
import { END_WORDS } from "../../../../../server/src/fleet/protocol";

const END_WHOLE: Record<string, string> = {
  clear: "Cleared with /clear",
  resume: "Switched to another session",
  logout: "Logged out",
  prompt_input_exit: "You exited",
  other: "Ended",
  "heartbeat lost": "Went offline",
};

/** The words for an end reason; one not listed reads as its own words, never as a raw identifier. Null when none was reported. */
export function endReasonWords(reason: string | null): string | null {
  if (reason === null || reason.trim() === "") return null;
  const known = END_WHOLE[reason];
  if (known) return known;
  const words = reason.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The same reasons in the fewest words, for a narrow column: the protocol's table (END_WORDS), which the server matches History's
 * `end:` word against, so the column and the filter cannot disagree; endReasonWords says them whole (its title). One not listed
 * falls back to endReasonWords. Null when none was reported.
 */
export function endReasonShort(reason: string | null): string | null {
  if (reason === null || reason.trim() === "") return null;
  return END_WORDS[reason] ?? endReasonWords(reason);
}
