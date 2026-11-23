// Signing in, with a name and the admin secret, the one the reporters use: whoever signs in may then answer sessions, leave
// feedback, claim, and change what Settings, Machines and History offer. The name is whatever is typed (Admin when none is),
// remembered in this browser, and carried by everything done under the sign-in. Signing in needs only the secret, never
// answering on. The same field sits in the answer panel, in the top bar's Sign in, and alone on the page while the server
// requires a sign-in to view (SignInScreen); the secret is cleared after every try and never kept by the page. A sign-in lasts
// until it is signed out (here, or everywhere at once), as the server keeps it. A server with no admin secret has no sign-in:
// the top bar says so where Sign in would sit (NoSecretNote).
import { useId, useRef, useState, type FormEvent } from "react";
import { LIMITS } from "../../../../server/src/fleet/protocol";
import { ADMIN_NAME } from "../respondApi";
import { Mark } from "../shell/Mark";
import { readJson, writeJson } from "../storage";
import { APP_NAME } from "../types";
import { useRespond, type SignInResult } from "../useRespond";
import { failure } from "../views/settings/api";

const NO_SECRET = "No admin secret is set on the server.";
/** What that means for whoever reads the dashboard: the top bar's note says it on hover, and so does "Answering is off" there (Compose OffNote). */
const NO_SECRET_MEANS = "Anyone who can reach it reads everything, and nothing can be exported, changed or answered from the dashboard until the server is given one.";
export const NO_SECRET_WHY = `${NO_SECRET} ${NO_SECRET_MEANS}`;
const PROBLEM: Record<Exclude<SignInResult, "ok">, string> = {
  wrong: "Wrong secret.",
  empty: "Enter the admin secret.",
  "no-secret": NO_SECRET,
};

const ENDED = "Your sign-in ended.";
/** The name this browser last signed in with. */
const NAME_KEY = "signInName";

/**
 * The name and secret fields and Sign in, on one line, what a name is under them, and an error under that. An empty secret is
 * refused here; a wrong one clears the field. The name a sign-in took is remembered. `onSignedIn` follows a sign-in the server
 * took.
 */
function SecretForm({ lead, autoFocus = false, onSignedIn }: { lead?: string; autoFocus?: boolean; onSignedIn?: () => void }) {
  const ctx = useRespond();
  const fieldId = `${useId()}-secret`;
  const [name, setName] = useState(() => readJson<unknown>(NAME_KEY, ""));
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
    const typed = typeof name === "string" ? name.trim() : "";
    const result = await ctx.signIn(typed, secret);
    setSending(false);
    setSecret("");
    if (result !== "ok") return refuse(result);
    writeJson(NAME_KEY, typed);
    setProblem(null);
    onSignedIn?.();
  };

  return (
    <form className="signin" onSubmit={(e) => void onSubmit(e)}>
      {ctx?.expired ? <p className="signin-note">{ENDED}</p> : null}
      <div className="signin-line">
        {lead ? <b>{lead}</b> : null}
        <input aria-label="Name" type="text" autoComplete="username" maxLength={LIMITS.name} placeholder="Name" value={typeof name === "string" ? name : ""} onChange={(e) => setName(e.target.value)} />
        <label className="ui-vh" htmlFor={fieldId}>
          Admin secret
        </label>
        <input id={fieldId} ref={field} type="password" autoComplete="off" autoFocus={autoFocus} placeholder="Admin secret" value={secret} onChange={(e) => setSecret(e.target.value)} />
        <button className="ui-button ui-button--primary" type="submit" disabled={sending}>
          Sign in
        </button>
      </div>
      <p className="signin-note">A name is whatever you type; everyone here shares one secret.</p>
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
 * In Sign in's place in the top bar on a server with no admin secret (RespondMe.open): that it has none, and on hover and for a
 * screen reader what that means, as a note in a control's place says why (Compose OffNote). A note only: nothing in the
 * dashboard gives a server its secret.
 */
export function NoSecretNote() {
  return (
    <span className="shell-open" title={NO_SECRET_WHY}>
      {NO_SECRET}
      <span className="ui-vh">{` ${NO_SECRET_MEANS}`}</span>
    </span>
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
