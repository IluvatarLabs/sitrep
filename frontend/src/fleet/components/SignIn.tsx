// Signing in. Single owner: the owner signs in as Admin with the admin secret, the one the reporters use, and
// may then answer sessions and change what Settings, Machines and History offer. Signing in needs only that secret, never
// answering on. The same field sits in the answer panel, in the top bar's Sign in, and alone on the page while the server
// requires a sign-in to view (SignInScreen); the secret is cleared after every try and never kept by the page. A sign-in lasts
// until it is signed out (here, or everywhere at once), as the server keeps it.
import { useId, useRef, useState, type FormEvent } from "react";
import { ADMIN_NAME } from "../respondApi";
import { Mark } from "../shell/Mark";
import { APP_NAME } from "../types";
import { useRespond, type SignInResult } from "../useRespond";
import { failure } from "../views/settings/api";

const PROBLEM: Record<Exclude<SignInResult, "ok">, string> = {
  wrong: "Wrong secret.",
  empty: "Enter the admin secret.",
  "no-secret": "No admin secret is set on the server.",
};

const ENDED = "Your sign-in ended.";

/**
 * The secret field and Sign in, on one line, with an error under it. An empty secret is refused here; a wrong one clears the
 * field. `onSignedIn` follows a sign-in the server took.
 */
function SecretForm({ lead, autoFocus = false, onSignedIn }: { lead?: string; autoFocus?: boolean; onSignedIn?: () => void }) {
  const ctx = useRespond();
  const fieldId = `${useId()}-secret`;
  const [secret, setSecret] = useState("");
  const [problem, setProblem] = useState<Exclude<SignInResult, "ok"> | null>(null);
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const refuse = (why: Exclude<SignInResult, "ok">) => {
    setProblem(why);
    field.current?.focus();
  };
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ctx || sending) return;
    if (!secret) return refuse("empty");
    setSending(true);
    const result = await ctx.signIn(secret);
    setSending(false);
    setSecret("");
    if (result !== "ok") return refuse(result);
    setProblem(null);
    onSignedIn?.();
  };

  return (
    <form className="signin" onSubmit={(e) => void onSubmit(e)}>
      {ctx?.expired ? <p className="signin-note">{ENDED}</p> : null}
      <div className="signin-line">
        {lead ? <b>{lead}</b> : null}
        <label className="ui-vh" htmlFor={fieldId}>
          Admin secret
        </label>
        <input id={fieldId} ref={field} type="password" autoComplete="off" autoFocus={autoFocus} placeholder="Admin secret" value={secret} onChange={(e) => setSecret(e.target.value)} />
        <button className="ui-button ui-button--primary" type="submit" disabled={sending}>
          Sign in
        </button>
      </div>
      {problem ? (
        <p className="signin-error" role="alert">
          {PROBLEM[problem]}
        </p>
      ) : null}
    </form>
  );
}

/** A panel's body while signed out: one line saying what signing in is for ("Sign in to answer"), with the field. */
export function SignInPanel({ lead = "Sign in to answer" }: { lead?: string }) {
  return (
    <div className="answer-section">
      <SecretForm lead={lead} />
    </div>
  );
}

/**
 * The page while the server requires a sign-in to view and this browser has none: the product's name and the field, nothing of
 * the fleet. `onSignedIn` hands back to the console, which reads the fleet again (useFleet's attempt).
 */
export function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  // The shell's ground, type and box model (shell/shell.css .shell), with nothing of its frame.
  return (
    <div className="shell">
      <main className="signin-screen">
        <h1 className="signin-screen-name">
          <Mark />
          {APP_NAME}
        </h1>
        <SecretForm lead="Sign in to view" autoFocus onSignedIn={onSignedIn} />
      </main>
    </div>
  );
}

/**
 * The top bar's Sign in: the field, or once signed in who is signed in, Sign out, and Sign out everywhere (every browser's
 * sign-in ends at the server, this one's included; then this browser is signed out as Sign out does it, so the end is not
 * taken for one that ran out). Nothing until the server has answered.
 */
export function SignInSection() {
  const ctx = useRespond();
  const [refused, setRefused] = useState<string | null>(null);
  if (!ctx?.me) return null;
  if (!ctx.me.signedIn) return <SecretForm />;
  const everywhere = async () => {
    setRefused(null);
    try {
      await ctx.api.signOutEverywhere();
    } catch (err) {
      setRefused(failure(err));
      return;
    }
    await ctx.signOut().catch(() => undefined);
  };
  return (
    <div className="signin">
      <div className="signin-who">
        <span>
          Signed in as <b>{ctx.me.name ?? ADMIN_NAME}</b>
        </span>
        <span className="signin-acts">
          <button type="button" className="ui-button" onClick={() => void ctx.signOut()}>
            Sign out
          </button>
          <button type="button" className="ui-button" onClick={() => void everywhere()}>
            Sign out everywhere
          </button>
        </span>
      </div>
      {refused ? (
        <p className="signin-error" role="alert">
          {`Could not sign out everywhere: ${refused}`}
        </p>
      ) : null}
    </div>
  );
}
