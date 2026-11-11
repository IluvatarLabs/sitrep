// The answer panel: answering a session from the dashboard, in the one panel raised over the page (ui/Panel). It opens from
// a row's Answer, the needs-you count or a session page (useRespond().open), with the ask first, the message box at its foot,
// and the session's live activity under the ask, open (the owner may fold it; it stays as left while the panel is open). Up and down (outside a field or a choice) and the head's chevrons step through
// the sessions waiting on the owner, oldest first, without closing; what belongs to one session (its form, its draft
// message) starts afresh on the next. Signed out, the panel shows the session's own ask (its kind and note, who asks, how
// long, the model and machine) and one line to sign in; the whole ask stays behind the sign-in. Whichever answers first, the
// terminal or the dashboard, wins; the panel says what actually happened (shell/answering.tsx, shared with the quick
// answers in rows).
import { useEffect, useId, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { hashFor } from "../../route";
import { fmtSpan } from "../format";
import { ORCHESTRATOR_ROW } from "../logic";
import { providerInfo } from "../provider";
import { canAnswer, cantReason, clockOf, planBackOnly, shownAsk } from "../respond";
import "../shell/answer.css";
import { ALSO_IN_TERMINAL, FeedFreshness, frameOf, RECEIPT_ICON, receiptOf, useAskDetail, useSender, type Frame, type Receipt } from "../shell/answering";
import { stateLine, stateOf } from "../states";
import type { AskDetail, AskSummary, ProviderName, SessionView } from "../types";
import { Dots } from "../ui/Dots";
import { closePanelOf, Panel } from "../ui/Panel";
import { Station } from "../ui/Station";
import { askFeedsNow, readEvery, useActivityFeed } from "../useActivityFeed";
import { useRespond } from "../useRespond";
import { FeedList, FeedStatus, feedEmpty, ServerOffNote } from "./ActivityFeed";
import { ModelChip } from "./Chips";
import { commandsOf, Compose, OffNote, type ComposeProps } from "./Compose";
import { IconChevron, osLogo } from "./Icons";
import { draftToAnswer, Outcome, PermissionForm, PlanForm, QuestionForm, type Draft, type PlanChoice } from "./RespondForms";
import { SignInPanel } from "./SignIn";

/**
 * The ask's part of the panel: its head (the session's state line, which for an open ask is its kind and note, and how long
 * the ask has waited), the words beside it, then the form, a receipt or the sign-in.
 */
function AnswerPanel({ s, now, ask, also, children }: { s: SessionView; now: number; ask: AskSummary | null; also: string; children: ReactNode }) {
  const line = stateLine(s, now);
  const waiting = ask !== null && ask.state !== "closed";
  return (
    <section className="answer-panel" aria-label={line}>
      <div className="answer-lead">
        <Station kind={stateOf(s)} />
        <b>{line}</b>
        {waiting ? (
          <span className="answer-ago" title={`Asked at ${clockOf(ask.openedAt)}`}>
            {fmtSpan((now - ask.openedAt) / 1000)}
          </span>
        ) : null}
        {also ? <span className="answer-also">{also}</span> : null}
      </div>
      {children}
    </section>
  );
}

const footLine = (text: string) => (
  <div className="answer-foot">
    <span className="answer-foot-note">{text}</span>
  </div>
);

/** A receipt in full, as the panel shows it: the sentence, the detail, any Discard, and the line under it. */
function ReceiptBlock({ r, busy, onDiscard }: { r: Receipt; busy: boolean; onDiscard: (deliveryId: string) => void }) {
  const discard = r.discard;
  const acts = discard ? (
    <button className="ui-button" type="button" disabled={busy} onClick={() => onDiscard(discard)}>
      Discard answer
    </button>
  ) : undefined;
  return (
    <>
      <div className="answer-section">
        <Outcome cls={r.tone} icon={RECEIPT_ICON[r.tone]} title={r.title} acts={acts}>
          {r.detail}
          {r.note ? <span className="answer-out-note">{r.note}</span> : null}
        </Outcome>
      </div>
      {footLine(r.foot)}
    </>
  );
}

// ---- state the panel keeps ----------------------------------------------------------------------------------------------

/** What has been chosen in the form so far. It belongs to one ask: a different ask starts from nothing chosen. */
interface Choices {
  askId: string | null;
  tab: number;
  drafts: Draft[];
  plan: PlanChoice;
  feedback: string;
  allow: boolean;
  reason: string;
}

const nothingChosen = (askId: string | null): Choices => ({ askId, tab: 0, drafts: [], plan: "auto", feedback: "", allow: true, reason: "" });

/** A change to the choices: the fields that change, or a function of the latest choices that gives them. */
type ChoicesPatch = Partial<Choices> | ((latest: Choices) => Partial<Choices>);

function useChoices(askId: string | null): [Choices, (patch: ChoicesPatch) => void] {
  const [choices, setChoices] = useState<Choices>(() => nothingChosen(null));
  // Reset while rendering when the ask changes (React's pattern for state that follows a prop); no ask keeps the last.
  if (askId !== null && choices.askId !== askId) setChoices(nothingChosen(askId));
  const choose = (patch: ChoicesPatch) => setChoices((latest) => ({ ...latest, ...(typeof patch === "function" ? patch(latest) : patch) }));
  return [choices, choose];
}

/** The form for an open ask: its kind's form, wired to the choices kept for it. */
function AskForm({ detail, provider, choices, choose, backOnly, app, agent, busy, answer }: { detail: AskDetail; provider: ProviderName; choices: Choices; choose: (patch: ChoicesPatch) => void; backOnly: boolean; app: string; agent: string; busy: boolean; answer: (body: Record<string, unknown>) => void }) {
  const { tab, drafts, plan, feedback, allow, reason } = choices;
  switch (detail.ask.kind) {
    case "question": {
      const setDraft = (i: number, value: Draft) =>
        choose((latest) => {
          const next = [...latest.drafts];
          next[i] = value;
          return { drafts: next };
        });
      const submit = () => answer({ kind: "question", answers: (detail.ask.questions ?? []).map((_, i) => draftToAnswer(drafts[i] ?? null)) });
      return <QuestionForm detail={detail} app={app} agent={agent} busy={busy} tab={tab} drafts={drafts} onTab={(n) => choose({ tab: n })} onDraft={setDraft} onSubmit={submit} />;
    }
    case "plan": {
      const sendBack = backOnly || plan === "keep";
      const submit = () => answer(sendBack ? { kind: "plan-feedback", text: feedback } : { kind: "plan-approve", mode: plan });
      return <PlanForm detail={detail} app={app} agent={agent} busy={busy} backOnly={backOnly} choice={plan} feedback={feedback} onChoice={(c) => choose({ plan: c })} onFeedback={(t) => choose({ feedback: t })} onSubmit={submit} />;
    }
    default: {
      const submit = (ok: boolean) => {
        const why = detail.ask.tool?.denyReason ? reason.trim() : "";
        if (ok) answer({ kind: "allow-once" });
        else answer(why ? { kind: "deny", text: why } : { kind: "deny" });
      };
      return <PermissionForm detail={detail} provider={provider} agent={agent} busy={busy} allow={allow} reason={reason} onAllow={(a) => choose({ allow: a })} onReason={(t) => choose({ reason: t })} onSubmit={submit} />;
    }
  }
}

// ---- one session's answer, message box and activity ------------------------------------------------------------------------

/**
 * `escape` is set to what Escape does here first: it cancels an open /clear confirmation (true) before the panel closes.
 * `feedOpen`: whether the Activity section is open, the panel's to keep (it holds across the waits it steps through).
 */
function AnswerBody(props: { s: SessionView; now: number; serverFeedOn: boolean; escape: MutableRefObject<() => boolean>; feedOpen: boolean; onFeedOpen: (open: boolean) => void }) {
  const { s, now, serverFeedOn, escape, feedOpen, onFeedOpen } = props;
  const ctx = useRespond()!;
  const me = ctx.me;
  const signedIn = me?.signedIn === true;
  const ask = shownAsk(s);
  const kind = ask?.kind ?? null;
  const verdict = canAnswer(s, kind);
  const edge: "off" | "cant" | null = !ctx.settingsOn || !me?.enabled ? "off" : verdict === "ok" ? null : verdict;
  const { name: agent, app } = providerInfo(s.provider);
  const commands = commandsOf(s.provider);
  const active = s.status !== "done";

  // The feed is fetched, and its lease held, only while its section is open, at the interval Settings keeps.
  const [every] = useState(readEvery);
  const feed = useActivityFeed({ sessionId: s.id, loop: ORCHESTRATOR_ROW, enabled: s.activityFeed !== false && feedOpen, active, every, serverOn: serverFeedOn });
  const serverOff = !serverFeedOn || feed.serverOff;

  const { detail, reload } = useAskDetail(ctx, s.id, ask, signedIn && !edge);
  const [choices, choose] = useChoices(ask?.id ?? null);
  const [draft, setDraft] = useState("");
  const [clearAsked, setClearAsked] = useState(false);
  const { busy, error, run } = useSender(ctx, async () => {
    askFeedsNow(s.id);
    await reload();
  });

  const current = detail && ask && detail.ask.id === ask.id ? detail : null;
  // Whether the session still checks in reads the live fleet and the server's clock, not the copy held for the redraw interval.
  const seen = ctx.liveSession(s.id) ?? s;
  const at = ctx.serverNow();
  const frame: Frame = current ? frameOf(current, seen, at) : ask?.state === "closed" ? "hidden" : "form";
  const askOpen = !!ask && ask.state !== "closed";
  const replyable = askOpen && frame === "form" && !!detail?.ask.allowsReply;
  const answer = (body: Record<string, unknown>) => {
    if (ask) void run(() => ctx.api.answer(s.id, ask.id, body));
  };
  const send = async (text: string) => {
    const command = commands.find((c) => c.name === text);
    let taken: boolean;
    if (command) taken = await run(() => ctx.api.message(s.id, { command: command.command }));
    else if (replyable && ask) taken = await run(() => ctx.api.answer(s.id, ask.id, { kind: "reply", text }));
    else taken = await run(() => ctx.api.message(s.id, { text }));
    if (taken) setDraft("");
  };

  // ---- the answer panel ----
  let panel: ReactNode = null;
  if (!edge && !signedIn) {
    panel = (
      <AnswerPanel s={s} now={now} ask={ask} also={askOpen ? ALSO_IN_TERMINAL : ""}>
        <SignInPanel />
      </AnswerPanel>
    );
  } else if (!edge && current && frame !== "hidden") {
    let shown: { also: string; body: ReactNode } | null = null;
    if (frame === "form") {
      shown = { also: ALSO_IN_TERMINAL, body: <AskForm detail={current} provider={s.provider} choices={choices} choose={choose} backOnly={kind === "plan" && planBackOnly(s)} app={app} agent={agent} busy={busy} answer={answer} /> };
    } else {
      const r = receiptOf(frame, { detail: current, s: seen, now: at, app, agent });
      if (r) shown = { also: r.also, body: <ReceiptBlock r={r} busy={busy} onDiscard={(id) => void run(() => ctx.api.discard(id))} /> };
    }
    if (shown) {
      panel = (
        <AnswerPanel s={s} now={now} ask={ask} also={shown.also}>
          {shown.body}
        </AnswerPanel>
      );
    }
  }

  // ---- the message box ----
  let compose: ReactNode = null;
  if (edge) compose = <OffNote edge={edge} reason={cantReason(s)} machine={s.machine.name} app={app} provider={s.provider} />;
  else if (signedIn) {
    // A message replaces the open ask only while its form shows and the ask takes a reply.
    const pending = replyable ? (detail?.ask.kind ?? null) : null;
    const box: ComposeProps = { name: s.name, agent, commands, pending, busy, error, draft, onDraft: setDraft, onSend: (text) => void send(text), confirmClear: clearAsked, onConfirmClear: setClearAsked };
    compose = <Compose {...box} />;
  }

  // Escape first cancels an open /clear confirmation; only then does it close the panel.
  useEffect(() => {
    escape.current = () => {
      if (clearAsked) setClearAsked(false);
      return clearAsked;
    };
    return () => {
      escape.current = () => false;
    };
  }, [escape, clearAsked]);
  const feedPart = serverOff ? (
    <ServerOffNote />
  ) : (
    <>
      <FeedList feed={feed} startedAt={s.startedAt} empty={feedEmpty(feed)} active={active} />
      <FeedStatus feed={feed} />
    </>
  );

  return (
    <>
      <div className="answer-scroll">
        {panel}
        <details className="answer-feed" open={feedOpen} onToggle={(e) => onFeedOpen(e.currentTarget.open)}>
          <summary>
            Activity
            <FeedFreshness feed={feed} active={active} now={now} />
          </summary>
          <div className="answer-feed-body">{feedPart}</div>
        </details>
      </div>
      {compose ? <footer className="answer-compose">{compose}</footer> : null}
    </>
  );
}

// ---- the panel ---------------------------------------------------------------------------------------------------------

/**
 * Where up and down are the element's own: a field, a select, a choice list, tabs, a menu, or a region focused to scroll it
 * (the session's feed list is one).
 */
const KEEPS_ARROWS =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='radiogroup'], [role='tablist'], [role='listbox'], [role='menu'], [role='slider'], .fd-list, [tabindex='0']:not(button):not(a)";

/** The previous and next session in the waits (oldest first), and where this one stands among them. */
function stepsOf(id: string, waits: readonly string[]): { at: number; prev: string | null; next: string | null } {
  const at = waits.indexOf(id);
  // A session that no longer waits (just answered) goes on to the oldest wait, as the needs-you count would.
  if (at < 0) return { at, prev: null, next: waits[0] ?? null };
  return { at, prev: waits[at - 1] ?? null, next: waits[at + 1] ?? null };
}

/** `[↑] 2 of 3 [↓]`: the chevrons step through the waits, as the up and down keys do. */
function Pager({ s, at, waits, prev, next, onStep }: { s: SessionView; at: number; waits: readonly string[]; prev: string | null; next: string | null; onStep: (id: string) => void }) {
  if (waits.length === 0) return null;
  const step = (to: string | null, label: string, cls: string) => (
    <button type="button" className={`ui-button ui-button--icon ${cls}`} disabled={!to} aria-label={label} title={label} onClick={() => to && onStep(to)}>
      <IconChevron />
    </button>
  );
  return (
    <span className="answer-steps" role="group" aria-label="Sessions waiting on you">
      {step(prev, "Previous (↑)", "answer-up")}
      <span className="answer-place" aria-live="polite">
        {at >= 0 ? `${at + 1} of ${waits.length}` : `${waits.length} waiting`}
        <span className="ui-vh">{`: ${s.name}`}</span>
      </span>
      {step(next, "Next (↓)", "answer-down")}
    </span>
  );
}

/**
 * `leaving`: the session left the fleet, and `s` is how it was last seen; the panel closes through its dialog. `waits`: the
 * sessions waiting on the owner, oldest first, in the needs-you count's order.
 */
export function AnswerDrawer({ s, now, serverFeedOn, leaving = false, waits }: { s: SessionView; now: number; serverFeedOn: boolean; leaving?: boolean; waits: readonly string[] }) {
  const ctx = useRespond()!;
  const titleId = useId();
  const escape = useRef<() => boolean>(() => false);
  // The Activity section starts open; a fold holds while the panel is open.
  const [feedOpen, setFeedOpen] = useState(true);
  const { at, prev, next } = stepsOf(s.id, waits);

  // Up and down step through the waits, wherever focus is in the panel, except where the keys are the element's own.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const to = e.key === "ArrowUp" ? prev : e.key === "ArrowDown" ? next : null;
      if (!to || (e.target instanceof Element && e.target.closest(KEEPS_ARROWS))) return;
      e.preventDefault();
      ctx.open(to);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [ctx, prev, next]);

  // Who asks: the session, then the agent when one of its agents asked rather than its main loop.
  const ask = shownAsk(s);
  const asking = ask?.agentId ? s.agents.find((a) => a.id === ask.agentId) : undefined;
  const title = (
    <>
      {s.name}
      {asking ? (
        <>
          <span className="answer-crumb" aria-hidden="true">
            ›
          </span>
          <span className="ui-vh">, asked by </span>
          {asking.name ?? asking.description}
        </>
      ) : null}
    </>
  );
  // Where it runs and on what: the machine with its OS, and the model with its effort.
  const where = [
    <span key="machine" className="answer-machine">
      {osLogo(s.machine.os)}
      {s.machine.name}
    </span>,
    <ModelChip key="model" provider={s.provider} family={s.modelFamily} model={s.model} effort={s.effort} />,
  ];
  const sub = (
    <div className="answer-sub">
      <Dots items={where} />
      <div className="answer-nav">
        <Pager s={s} at={at} waits={waits} prev={prev} next={next} onStep={(id) => ctx.open(id)} />
        {/* Closes through the dialog, as Escape does, so focus goes back to what opened the panel. */}
        <a className="answer-page" href={hashFor("session", s.id)} onClick={(e) => closePanelOf(e.currentTarget)}>
          Session page
        </a>
      </div>
    </div>
  );
  return (
    <Panel modal title={title} titleId={titleId} sub={sub} onClose={ctx.close} onEscape={() => escape.current()} closing={leaving} className="answer">
      <AnswerBody key={s.id} s={s} now={now} serverFeedOn={serverFeedOn} escape={escape} feedOpen={feedOpen} onFeedOpen={setFeedOpen} />
    </Panel>
  );
}
