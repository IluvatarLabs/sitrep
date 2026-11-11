// A session's reporter notes, for its page and its main loop's detail: a reporter version outside the server's range, and Codex
// hooks that are off. A state is said by states.ts stateLine.
import { reporterOf } from "../../../../server/src/fleet/protocol";
import type { SessionView } from "../types";
import { dotsText } from "../ui/Dots";

/**
 * What to tell the viewer when the server places this session's reporter outside the range it supports; null otherwise.
 * `parts` are the short label's items for a `Dots` list ("0.3.0", "update"); `label` is the same as plain text.
 */
export function versionNote(s: Pick<SessionView, "compat" | "reporterVersion" | "provider" | "machine">): { parts: string[]; label: string; text: string } | null {
  const v = s.reporterVersion || "unknown";
  if (s.compat === "outdated") {
    return {
      parts: [v, "update"],
      label: dotsText([v, "update"]),
      text: `This session's reporter (${reporterOf(s.provider)} ${v}) is older than the server supports. Run the Update command Machines gives for ${s.machine.name}${s.provider === "claude" ? ", then restart (resume) this session" : ""}. Reports are still accepted, but what is newer may not work: answers sent from here may never reach it, so answer it where it runs.`,
    };
  }
  if (s.compat === "newer") {
    return {
      parts: [v, "upgrade server"],
      label: dotsText([v, "upgrade server"]),
      text: `This session's reporter (${reporterOf(s.provider)} ${v}) is newer than the server supports. Upgrade the SITREP server. Reports are still accepted, but some fields may be ignored.`,
    };
  }
  return null;
}

/** Why hook-only facts read "—" for a Codex session. */
export function hooksOffText(s: Pick<SessionView, "machine">): string {
  return `Codex hooks not active on ${s.machine.name}`;
}

export const HOOKS_OFF_NOTE = "Without its Codex hooks, auto-compacts and approvals outside the Codex daemon go unseen; npx tsx scripts/install.ts --codex --apply on that machine trusts them.";
