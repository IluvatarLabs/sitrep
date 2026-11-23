// Feedback: a tag with a score or a value, and a comment, left on a session or on one of its rows, with who and when. One
// list and one form, under a session's facts (its own feedback) and inside an open row of its Turns (that row's). The page
// reads the session's feedback once and both places share it; an add or a remove updates it from the server's reply. Signed
// out, the list alone, and nothing where there is none.
import { useEffect, useId, useState, type FormEvent } from "react";
import { LIMITS, type Feedback } from "../../../../server/src/fleet/protocol";
import { fmtWhen } from "../format";
import { adminApi, RespondError } from "../respondApi";
import { useRespond } from "../useRespond";
import { dotsText } from "../ui/Dots";
import { failure, getJson } from "../views/settings/api";
import "../views/session/session.css";

/** A session's feedback as its page holds it. */
export interface SessionFeedback {
  sessionId: string;
  items: Feedback[];
  /** Every tag in use anywhere, offered by the form. */
  keys: string[];
  /** Why the list could not be read; null once it was. */
  failed: string | null;
  added: (f: Feedback) => void;
  removed: (id: number) => void;
}

/** The session's feedback, read once for its page. */
export function useFeedback(sessionId: string): SessionFeedback {
  const [got, setGot] = useState<{ items: Feedback[]; keys: string[]; failed: string | null }>({ items: [], keys: [], failed: null });
  useEffect(() => {
    let current = true;
    getJson<{ feedback: Feedback[]; keys: string[] }>(`/sessions/${encodeURIComponent(sessionId)}/feedback`).then(
      (r) => current && setGot({ items: r.feedback, keys: r.keys, failed: null }),
      (err: unknown) => current && setGot((was) => ({ ...was, failed: failure(err) })),
    );
    return () => {
      current = false;
    };
  }, [sessionId]);
  return {
    sessionId,
    ...got,
    added: (f) => setGot((was) => ({ ...was, items: [...was.items, f], keys: was.keys.includes(f.key) ? was.keys : [...was.keys, f.key].sort() })),
    removed: (id) => setGot((was) => ({ ...was, items: was.items.filter((f) => f.id !== id) })),
  };
}

/** What one field holds: a number is a score, anything else a value, nothing neither. */
function scoreOrValue(raw: string): { score?: number; value?: string } {
  const v = raw.trim();
  if (v === "") return {};
  const n = Number(v);
  return Number.isFinite(n) ? { score: n } : { value: v };
}

/** The form: a tag (one in use, or a new one), a score or a value, a comment. */
function FeedbackForm({ fb, rowId, onDone }: { fb: SessionFeedback; rowId: string | null; onDone: () => void }) {
  const ctx = useRespond();
  const tags = useId();
  const [key, setKey] = useState("");
  const [measure, setMeasure] = useState("");
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const send = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (sending || !key.trim()) return;
    setSending(true);
    setRefused(null);
    const body = { ...(rowId === null ? {} : { rowId }), key: key.trim(), ...scoreOrValue(measure), ...(comment.trim() ? { comment: comment.trim() } : {}) };
    adminApi.addFeedback(fb.sessionId, body).then(
      (r) => {
        fb.added(r.feedback);
        onDone();
      },
      (err: unknown) => {
        if (err instanceof RespondError && err.status === 403) void ctx?.refresh();
        setSending(false);
        setRefused(failure(err));
      },
    );
  };
  return (
    <form className="signin" onSubmit={send}>
      <div className="signin-line">
        <input aria-label="Tag" list={tags} maxLength={LIMITS.name} placeholder="Tag" value={key} autoFocus onChange={(e) => setKey(e.target.value)} />
        <datalist id={tags}>
          {fb.keys.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
        <input aria-label="Score or value" maxLength={LIMITS.short} placeholder="Score or value" value={measure} onChange={(e) => setMeasure(e.target.value)} />
        <input aria-label="Comment" maxLength={LIMITS.feedbackComment} placeholder="Comment" value={comment} onChange={(e) => setComment(e.target.value)} />
        <button type="submit" className="ui-button ui-button--primary" disabled={sending || !key.trim()}>
          Add
        </button>
        <button type="button" className="ui-button" onClick={onDone}>
          Cancel
        </button>
      </div>
      {refused ? (
        <p className="signin-error" role="alert">
          {`Could not add feedback: ${refused}`}
        </p>
      ) : null}
    </form>
  );
}

/** One item: when, with its day (fmtWhen); who; then its tag, score or value and comment, and Remove for a signed-in reader. */
function Item({ f, fb, canRemove }: { f: Feedback; fb: SessionFeedback; canRemove: boolean }) {
  const [refused, setRefused] = useState<string | null>(null);
  const remove = () =>
    adminApi.removeFeedback(f.id).then(
      () => fb.removed(f.id),
      (err: unknown) => setRefused(failure(err)),
    );
  return (
    <li className="sv-ev is-dated">
      <time className="sv-num" dateTime={new Date(f.at).toISOString()} title={new Date(f.at).toLocaleString()}>
        {fmtWhen(f.at)}
      </time>
      <span className="sv-evloop" title={f.by}>
        {f.by}
      </span>
      <span className="sv-evtext">
        <b>{f.key}</b>
        {` ${dotsText([f.score === null ? f.value : String(f.score), f.comment])}`}
        {canRemove ? (
          <>
            {" "}
            <button type="button" className="sv-link" onClick={() => void remove()}>
              Remove
            </button>
          </>
        ) : null}
        {refused ? <span role="alert" className="fb-bad">{` Could not remove: ${refused}`}</span> : null}
      </span>
    </li>
  );
}

/** The feedback on a session (`rowId` null) or on one of its rows, and Add feedback for a signed-in reader; absent when neither shows. */
export function FeedbackBox({ fb, rowId }: { fb: SessionFeedback; rowId: string | null }) {
  const signedIn = useRespond()?.me?.signedIn === true;
  const [adding, setAdding] = useState(false);
  const items = fb.items.filter((f) => f.rowId === rowId);
  // The page's own box says the list could not be read; a row's says nothing more.
  const failed = rowId === null ? fb.failed : null;
  if (items.length === 0 && !signedIn && !failed) return null;
  return (
    <section aria-label="Feedback">
      {items.length > 0 || (signedIn && !adding) ? (
        <div className="sv-sh">
          {items.length > 0 ? <h2>Feedback</h2> : null}
          {signedIn && !adding ? (
            <button type="button" className="ui-button" onClick={() => setAdding(true)}>
              Add feedback
            </button>
          ) : null}
        </div>
      ) : null}
      {failed ? <p className="ui-empty">{`Could not load feedback: ${failed}`}</p> : null}
      {adding ? <FeedbackForm fb={fb} rowId={rowId} onDone={() => setAdding(false)} /> : null}
      {items.length > 0 ? (
        <ul className="sv-evlist">
          {items.map((f) => (
            <Item key={f.id} f={f} fb={fb} canRemove={signedIn} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
