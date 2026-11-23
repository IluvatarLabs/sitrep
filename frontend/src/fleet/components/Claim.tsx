// Who is handling a session that needs someone: "Claimed by <name>", the same words on its page, its Fleet card, its List row
// and its rows of Needs you and Problems; and on its page, signed in, Claim while it needs an answer, failed or is stuck, by the rule the
// server takes a claim by (alerts.ts needsSomeone), so the button shows where a claim is taken and nowhere else. A claim is
// advisory (anyone can still answer) and the first one wins; the server drops it the moment the session no longer needs
// someone, so there is no release.
import { useEffect, useState } from "react";
import { needsSomeone } from "../../../../server/src/fleet/alerts";
import { fmtClock } from "../format";
import { adminApi, RespondError } from "../respondApi";
import { stateOf } from "../states";
import type { Claim, SessionView } from "../types";
import { useRespond } from "../useRespond";
import "../views/wall/lines.css";

/** "Claimed by <name>" once someone has, said whole with the time they did as its title; nothing before. */
export function Claimed({ claim }: { claim: Claim | null }) {
  return claim ? (
    <span className="claimed" title={`Claimed by ${claim.by} at ${fmtClock(claim.at)}`}>
      {`Claimed by ${claim.by}`}
    </span>
  ) : null;
}

/** What a refused claim says: who holds it (a 409 names them), else the server's reason. */
function refusal(err: unknown): string {
  const holder = err instanceof RespondError ? (err.body.claim as Claim | undefined) : undefined;
  if (holder?.by) return `Claimed by ${holder.by}`;
  return err instanceof RespondError ? `Not claimed: ${err.message}` : "Not claimed: the server can't be reached";
}

/**
 * On a session's page, beside its state: who claimed it, else Claim for a signed-in reader while it needs someone. A refusal
 * stays until the session's state or claim changes.
 */
export function ClaimControl({ s }: { s: SessionView }) {
  const ctx = useRespond();
  const state = stateOf(s);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // A claim taken shows once the server sends the session with it; until then, and on any change of state, the button waits.
  useEffect(() => {
    setRefused(null);
    setBusy(false);
  }, [state, s.claim?.by]);
  if (s.claim) return <Claimed claim={s.claim} />;
  if (!needsSomeone(s) || ctx?.me?.signedIn !== true) return null;
  const claim = () => {
    setBusy(true);
    adminApi.claimSession(s.id).then(
      () => undefined,
      (err: unknown) => {
        if (err instanceof RespondError && err.status === 403) void ctx.refresh();
        setBusy(false);
        setRefused(refusal(err));
      },
    );
  };
  return refused ? (
    <span className="claimed" role="alert">
      {refused}
    </span>
  ) : (
    <button type="button" className="ui-button" disabled={busy} onClick={claim}>
      Claim
    </button>
  );
}
