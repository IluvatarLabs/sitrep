// An agent's auto-compacts: how many, and each one the server saw. Neutral at any count: a long run compacts as it goes.
import { fmtClock, fmtTok, plural } from "../format";
import type { AgentView, BlowoutLogEntry } from "../types";
import { BlowMark } from "../views/session/BlowMark";
import "../views/session/session.css";

/** What one auto-compact left: a share of the window when its size is known, else tokens; the tokens before; an overrun. */
function compactText(entry: BlowoutLogEntry, window: number | null): string {
  const before = entry.tokensBefore === null ? "" : `at ${fmtTok(entry.tokensBefore)} tokens`;
  const left = entry.tokensAfter === null ? "" : window ? `to about ${Math.round((entry.tokensAfter / window) * 100)}%` : `to ${fmtTok(entry.tokensAfter)} tokens`;
  const overran = entry.kind === "window-exceeded" ? "(the request overran the window)" : "";
  return [before, left, overran].filter(Boolean).join(" ") || "Auto-compacted";
}

/** An agent's auto-compacts, each with what the server saw of it. */
export function BlowoutBox({ a, entries }: { a: AgentView; entries: readonly BlowoutLogEntry[] }) {
  const total = a.blowouts ?? 0;
  if (!total) return null;
  const kept = entries.filter((entry) => entry.agentId === a.id);
  // Auto-compacts the reporter counted before the server kept their details.
  const earlier = total - kept.length;
  return (
    <div className="bx" role="note">
      <p className="bx-head">
        <BlowMark />
        <b>{`Auto-compacted ${plural(total, "time")}`}</b>
      </p>
      <ul className="bx-log">
        {kept.map((entry, i) => (
          <li key={`${entry.t}-${i}`}>
            <time className="sv-num">{fmtClock(entry.t)}</time>
            <span>{compactText(entry, a.context.window)}</span>
          </li>
        ))}
        {earlier > 0 ? (
          <li>
            <time className="sv-num">earlier</time>
            <span>{`${earlier} more, before the server kept details`}</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
