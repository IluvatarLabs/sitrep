// Answering from a list row: the contract every view uses, `<AnswerInline s={session} />`. It answers the ask the answer
// drawer shows (respond.ts openAsk: the newest open one, the main loop's first) through the drawer's own delivery code and
// shows the drawer's receipts (shell/answering.tsx). A permission ask offers Allow once and Deny (Deny only when the
// request is cut); a single-select single question offers its options; every ask also offers Answer (Other… for a question
// that takes typed text), which opens the drawer, where the owner can deny with a reason and read a command's description
// and each option's description. As in the drawer, nothing is answered that was not shown whole: Allow once is offered only when
// the row shows the whole input it allows, and an option only beside the whole question, so the line above the buttons carries
// what is asked, and anything larger is answered from the drawer. A session that needs you with no ask open, and takes a message,
// offers Answer for the drawer's message box; an idle one does not (its page's composer messages it). Once the ask the row showed
// closes, the row keeps it and says what became of it, as the drawer does, until the server forgets the ask or the row leaves the
// screen. Nothing shows while the session can't take an answer from here, so a view may always render it; while signed out,
// Answer opens the drawer's sign-in.
import { useState, type MouseEvent, type ReactNode } from "react";
import { providerInfo } from "../provider";
import { ASK_WORD, canAnswer, cleanLabel, respondGate } from "../respond";
import { frameOf, RECEIPT_ICON, receiptOf, useAskDetail, useSender, type Frame } from "../shell/answering";
import { openAsk, stateOf } from "../states";
import type { AskDetail, SessionView } from "../types";
import { useRespond } from "../useRespond";

/** The longest command or question a row shows whole; longer ones are answered from the drawer, where they show whole. */
const ROW_TEXT_MAX = 400;

/**
 * The input fields a row may hold beside an Allow once: the command, which it shows, and, for Claude's Bash only, its
 * `description`, a label for the person that grants nothing (Claude Code's Bash input type). Any other tool's `description`
 * may be an argument the tool acts on, which the row does not show, so it is allowed only from the drawer.
 */
const BASH_FIELDS: ReadonlySet<string> = new Set(["command", "description"]);
const COMMAND_FIELDS: ReadonlySet<string> = new Set(["command"]);

/** One quick answer: its words, the answer it sends, and a tooltip with the option's description. */
interface Quick {
  label: string;
  body: Record<string, unknown>;
  recommended?: boolean;
  title?: string;
}

/**
 * What a row offers for an open ask: the line saying what is asked (`whole` when the row shows it in full), the quick answers,
 * and the button that opens the drawer, which every ask has: the drawer alone denies with a reason and shows a command's
 * description and each option's description.
 */
function offerFor(detail: AskDetail): { line: ReactNode; whole: boolean; quick: Quick[]; drawer: "Answer" | "Other…" } {
  const ask = detail.ask;
  if (ask.kind === "permission") {
    const tool = ask.tool;
    const input = tool?.input ?? {};
    const name = tool?.name ?? "A tool";
    const command = typeof input.command === "string" && input.command !== "" ? input.command : null;
    // Shown whole: a command short enough for the row and nothing else in the input except, for Bash, its description. Any
    // other field (a working directory, a sandbox switch, a timeout, file changes, another tool's description) shows only in
    // the drawer, so it is allowed only there. A Codex turn grant carries no command, so it is never allowed from a row.
    const fields = tool?.name === "Bash" ? BASH_FIELDS : COMMAND_FIELDS;
    const whole = command !== null && command.length <= ROW_TEXT_MAX && Object.keys(input).every((key) => fields.has(key));
    const line = whole ? (
      <>
        {name} wants to run <code className="answer-inline-code">{command}</code>
      </>
    ) : (
      <>{command !== null ? `${name} wants to run a command` : `${name} wants your permission`}</>
    );
    const deny: Quick = { label: "Deny", body: { kind: "deny" } };
    if (tool?.cut === true || !whole) return { line, whole, quick: [deny], drawer: "Answer" };
    return { line, whole, quick: [{ label: "Allow once", body: { kind: "allow-once" } }, deny], drawer: "Answer" };
  }
  if (ask.kind === "question") {
    const questions = ask.questions ?? [];
    const q = questions[0];
    const more = questions.length > 1 ? ` (and ${questions.length - 1} more)` : "";
    const line = q ? `${q.question}${more}` : null;
    // One question, one answer, options to pick, no preview the row could not show, and a question short enough to show whole
    // beside its options: an option is never picked under a question cut short.
    const single = questions.length === 1 && q && !q.multiSelect && q.options.length > 0 && q.options.every((o) => !o.preview) && q.question.length <= ROW_TEXT_MAX;
    if (!single) return { line, whole: false, quick: [], drawer: "Answer" };
    const quick = q.options.map((o, i): Quick => {
      const shown = cleanLabel(o.label);
      return { label: shown.label, recommended: shown.recommended, title: o.description || undefined, body: { kind: "question", answers: [{ options: [i] }] } };
    });
    return { line, whole: true, quick, drawer: q.allowsText ? "Other…" : "Answer" };
  }
  const first = (ask.plan?.text ?? "").split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean);
  return { line: first ?? null, whole: false, quick: [], drawer: "Answer" };
}

export function AnswerInline({ s }: { s: SessionView }) {
  const ctx = useRespond();
  const open = openAsk(s);
  // The ask this row showed last, kept once it closes so the row can say what became of it, as the drawer keeps shownAsk.
  // Reset while rendering when a new ask opens (React's pattern for state that follows a prop).
  const [keptId, setKeptId] = useState<string | null>(null);
  if (open && open.id !== keptId) setKeptId(open.id);
  const ask = open ?? s.asks.find((a) => a.id === keptId) ?? null;
  const signedIn = ctx?.me?.signedIn === true;
  const takes = !!ctx && ctx.settingsOn && ctx.me?.enabled === true && !!ask && canAnswer(s, ask.kind) === "ok";
  const { detail, reload } = useAskDetail(ctx, s.id, ask, signedIn && takes);
  const { busy, error, run } = useSender(ctx, reload);
  if (!ctx) return null;

  const gate = respondGate(s, ctx.me, ctx.settingsOn);
  const openDrawer = (e: MouseEvent<HTMLButtonElement>) => {
    // A row may open its session on a press: this press opens the drawer only.
    e.stopPropagation();
    ctx.open(s.id, e.currentTarget);
  };
  const drawerButton = (label: string) => (
    <button type="button" className="ui-button" aria-haspopup="dialog" onClick={openDrawer}>
      {label}
    </button>
  );
  const errorLine = error ? (
    <p className="answer-inline-error" role="alert">
      {error}
    </p>
  ) : null;
  // No ask open while the session needs you and takes a message (a question or permission wait outside its respond level):
  // Answer opens the drawer, whose message box answers it. An idle session passes respondGate too, but asks nothing.
  const message = !open && gate.show && stateOf(s) === "needs-you" ? <div className="answer-inline-actions">{drawerButton("Answer")}</div> : null;

  if (!takes || !ask) return message || errorLine ? <div className="answer-inline">{message}{errorLine}</div> : null;

  const current = detail && detail.ask.id === ask.id ? detail : null;
  // Whether the session still checks in reads the live fleet and the server's clock, not the copy held for the redraw interval.
  const seen = ctx.liveSession(s.id) ?? s;
  const at = ctx.serverNow();
  const read: Frame = current ? frameOf(current, seen, at) : ask.state === "closed" ? "hidden" : "form";
  // A closed ask has no form: until its detail is read again it shows nothing.
  const frame: Frame = !open && read === "form" ? "hidden" : read;

  // What became of the ask the row showed: the drawer's receipt, as one line.
  if (frame !== "form") {
    const { app, name: agent } = providerInfo(s.provider);
    const r = frame === "hidden" || !current ? null : receiptOf(frame, { detail: current, s: seen, now: at, app, agent });
    // A row's closed ask was not answered from here, so its line drops the drawer's "before you answered".
    const title = r && current && frame === "closed" ? `This ${ASK_WORD[current.ask.kind]} was closed in the session.` : r?.title;
    if (!r && !message) return errorLine;
    const discard = r?.discard ?? null;
    return (
      <div className="answer-inline">
        {r ? (
          <p className="answer-inline-receipt" data-tone={r.tone} role="status">
            <span className="answer-inline-icon">{RECEIPT_ICON[r.tone]}</span>
            <span>
              <b>{title}</b>
              {r.note ? ` ${r.note}` : ""}
              {r.also && !r.note ? <span className="answer-inline-where"> {r.also}.</span> : null}
            </span>
            {discard ? (
              <button
                type="button"
                className="ui-button"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void run(() => ctx.api.discard(discard));
                }}
              >
                Discard answer
              </button>
            ) : null}
          </p>
        ) : null}
        {message}
        {errorLine}
      </div>
    );
  }

  if (!gate.show) return null;
  // Signed out, or the ask not read yet: the drawer answers (and signs in).
  if (!current) {
    return (
      <div className="answer-inline">
        <div className="answer-inline-actions">{drawerButton("Answer")}</div>
      </div>
    );
  }

  const { line, whole, quick, drawer } = offerFor(current);
  const send = (body: Record<string, unknown>) => (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    void run(() => ctx.api.answer(s.id, ask.id, body));
  };
  return (
    <div className="answer-inline">
      {/* What an answer here grants is never cut short; a question with no options here, or a plan's first line, is, after three lines. */}
      {line ? (
        <p className="answer-inline-line" data-clamp={whole ? undefined : ""}>
          {line}
        </p>
      ) : null}
      <div className="answer-inline-actions">
        {quick.map((q, i) => (
          <button key={i} type="button" className="ui-button" title={q.title} disabled={busy} onClick={send(q.body)}>
            <span className="answer-inline-label">{q.label}</span>
            {q.recommended ? <span className="answer-inline-rec">Recommended</span> : null}
          </button>
        ))}
        {drawerButton(drawer)}
      </div>
      {errorLine}
    </div>
  );
}
