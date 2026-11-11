// The answer panel's forms: a question as tabs like the native client's own, a plan with three ways to approve it or a way
// to send it back, and a tool's Allow once or Deny. What a form offers and says comes from the ask's own flags (`allowsText`,
// `tool.cut`, `tool.denyReason`) and the session's `respond.accepts`; the provider only tells a Codex turn grant from a tool
// that happens to share its name (respond.ts grantsForTurn). Every text from a session is drawn as text nodes; the plan's
// markdown goes through the shared renderer. Styles: shell/answer.css.
import { useId, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { isKnownProvider, PLAN_MODES } from "../../../../server/src/fleet/protocol";
import { cleanLabel, countWord, grantsForTurn, pickedLabels, PLAN_LABELS, TURN_GRANT } from "../respond";
import type { AskDetail, AskQuestion, PlanMode, ProviderName, QuestionAnswer } from "../types";
import { Markdown } from "./Markdown";

/** A ring with a mark inside, drawn as the console's line icons are (ui.css svg.i). */
const ringed = (mark: string): ReactElement => (
  <svg className="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="6.2" />
    <path d={mark} />
  </svg>
);

/** The receipts' marks: waiting, information and failure. */
export const ICONS = {
  wait: ringed("M8 4.8v3.6M8 10.6v.6"),
  info: ringed("M8 7.2v4M8 4.8v.6"),
  x: ringed("m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4"),
};

/** What became of an answer, in place of the form: an icon, one sentence, the detail, and any action. */
export function Outcome({ cls, icon, title, children, acts }: { cls: "info" | "bad" | "wait"; icon: ReactNode; title: ReactNode; children: ReactNode; acts?: ReactNode }) {
  return (
    <div className="answer-out" data-tone={cls}>
      <span className="answer-out-icon">{icon}</span>
      <b>{title}</b>
      <span className="answer-out-detail">{children}</span>
      {acts ? <span className="answer-out-acts">{acts}</span> : null}
    </div>
  );
}

/** A form's last row: a note on the left, then its buttons. */
function FormFoot({ note, children }: { note: string; children: ReactNode }) {
  return (
    <div className="answer-foot">
      <span className="answer-foot-note">{note}</span>
      {children}
    </div>
  );
}

/** A quoted answer: bold, with no quote marks drawn. */
export function Q({ children }: { children: ReactNode }) {
  return <q>{children}</q>;
}

// ---- a question -----------------------------------------------------------------------------------------------------

/** One question's answer while it is chosen: nothing yet, the options picked, or a typed answer. */
export type Draft = null | { options: number[] } | { other: string };

/** The answer a draft makes, or null while it makes none (nothing picked, or only spaces typed). */
export const draftToAnswer = (draft: Draft): QuestionAnswer => {
  if (draft === null) return null;
  if ("options" in draft) return draft.options.length > 0 ? { options: draft.options } : null;
  const typed = draft.other.trim();
  return typed ? { text: typed } : null;
};

/** A draft as the tabs and the review quote it; empty while it makes no answer. */
function draftText(question: AskQuestion, d: Draft): string {
  const answer = draftToAnswer(d);
  if (answer === null) return "";
  return "text" in answer ? answer.text : pickedLabels(question.options, answer.options);
}

function reviewNote(count: number, app: string): string {
  if (count === 1) return `Submitting sends it, as ${app} does.`;
  if (count === 2) return `Submitting sends both at once, as ${app} does.`;
  return `Submitting sends all ${countWord(count)} at once, as ${app} does.`;
}

/** The last tab: every question with its answer, or a note that it goes as skipped. */
function ReviewStep({ questions, drafts, agent }: { questions: AskQuestion[]; drafts: Draft[]; agent: string }) {
  const rows = questions.map((q, i) => ({ q, said: draftText(q, drafts[i] ?? null) }));
  return (
    <>
      <p className="answer-q">Review your answers</p>
      <dl className="answer-review">
        {rows.map(({ q, said }, i) => (
          <div key={i}>
            <dt>{q.question}</dt>
            <dd data-blank={said ? undefined : ""}>{said || `Not answered. ${agent} sees it as skipped.`}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** One question's tab: its options (radios, or checkboxes for several answers), a typed answer where taken, and a preview. */
function QuestionStep({ q, tab, draft, groupId, onDraft }: { q: AskQuestion; tab: number; draft: Draft; groupId: string; onDraft: (d: Draft) => void }) {
  const picked = draft !== null && "options" in draft ? draft.options : [];
  const typing = draft !== null && "other" in draft;
  const typed = draft !== null && "other" in draft ? draft.other : "";
  const headingId = `${groupId}-qh`;
  const radioName = `${groupId}-q${tab}`;
  // The preview shown is the picked option's; until one with a preview is picked, the first option's.
  const anyPreview = q.options.some((o) => o.preview);
  const preview = q.options.find((o, i) => o.preview && picked.includes(i)) ?? (anyPreview ? q.options[0] : undefined);
  // A typed answer is offered only where the ask takes one; a question with no options and no typed answer can't be answered here.
  const offerTyped = q.allowsText && !q.multiSelect;

  const choose = (i: number) => {
    if (!q.multiSelect) onDraft({ options: [i] });
    else if (picked.includes(i)) onDraft({ options: picked.filter((x) => x !== i) });
    else onDraft({ options: [...picked, i].sort((a, b) => a - b) });
  };
  const options = q.options.map((o, i) => {
    const shown = cleanLabel(o.label);
    return (
      <label key={i} className="answer-opt">
        <input type={q.multiSelect ? "checkbox" : "radio"} name={radioName} checked={picked.includes(i)} onChange={() => choose(i)} />
        <span className="answer-opt-label">
          {shown.label}
          {shown.recommended ? <span className="answer-rec">Recommended</span> : null}
        </span>
        {o.description && <span className="answer-opt-desc">{o.description}</span>}
      </label>
    );
  });

  return (
    <>
      <p id={headingId} className="answer-q">
        {q.question}
      </p>
      {q.multiSelect ? <p className="answer-hint">(Select all that apply)</p> : null}
      <div className="answer-qgrid" data-preview={preview ? "" : undefined}>
        <fieldset className="answer-opts" aria-labelledby={headingId}>
          {options}
          {offerTyped && (
            <label className="answer-opt">
              <input type="radio" name={radioName} checked={typing} onChange={() => onDraft({ other: typed })} />
              <span className="answer-opt-label">{q.options.length ? "Type something" : "Your answer"}</span>
              <input
                className="answer-text"
                type="text"
                placeholder="Write your answer"
                aria-label="Write your answer"
                value={typed}
                onFocus={() => {
                  if (!typing) onDraft({ other: typed });
                }}
                onChange={(e) => onDraft({ other: e.target.value })}
              />
            </label>
          )}
          {!offerTyped && q.options.length === 0 && <p className="answer-note">This question takes no answer from here. Answer it in its terminal.</p>}
        </fieldset>
        {preview && (
          <div className="answer-preview">
            <div className="answer-preview-label">Preview: {cleanLabel(preview.label).label}</div>
            <pre>{preview.preview}</pre>
          </div>
        )}
      </div>
    </>
  );
}

export function QuestionForm(props: { detail: AskDetail; app: string; agent: string; tab: number; drafts: Draft[]; onTab: (n: number) => void; onDraft: (i: number, d: Draft) => void; onSubmit: () => void; busy: boolean }) {
  const { tab, drafts, onTab } = props;
  const groupId = useId();
  const questions = props.detail.ask.questions ?? [];
  const count = questions.length;
  // One tab per question, then Review.
  const reviewing = tab === count;
  const primary = reviewing ? { label: "Submit answers", disabled: props.busy, press: props.onSubmit } : { label: "Next", disabled: false, press: () => onTab(Math.min(tab + 1, count)) };

  // The tabs pattern (WAI-ARIA): only the selected tab is in the tab order; the arrow keys, Home and End move and select.
  const tabId = (i: number) => `${groupId}-tab${i}`;
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const last = count;
    const to = e.key === "ArrowRight" ? (tab + 1) % (last + 1) : e.key === "ArrowLeft" ? (tab + last) % (last + 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (to === null) return;
    e.preventDefault();
    onTab(to);
    document.getElementById(tabId(to))?.focus();
  };
  const tabButton = (i: number, label: ReactNode, done?: boolean) => (
    <button key={i} id={tabId(i)} type="button" role="tab" data-done={done ? "" : undefined} aria-selected={tab === i} aria-controls={`${groupId}-panel`} tabIndex={tab === i ? 0 : -1} onClick={() => onTab(i)} onKeyDown={onTabKey}>
      {label}
    </button>
  );

  return (
    <>
      <div className="answer-section">
        <div className="ui-tabs" role="tablist" aria-label="Questions">
          {questions.map((q, i) =>
            tabButton(
              i,
              <>
                <span className="answer-tab-box" aria-hidden="true" />
                {q.header}
              </>,
              !!draftText(q, drafts[i] ?? null),
            ),
          )}
          {tabButton(count, "Review")}
        </div>
        <div id={`${groupId}-panel`} role="tabpanel" aria-labelledby={tabId(tab)} className="answer-tabpanel">
          {reviewing ? (
            <ReviewStep questions={questions} drafts={drafts} agent={props.agent} />
          ) : (
            <QuestionStep q={questions[tab]!} tab={tab} draft={drafts[tab] ?? null} groupId={groupId} onDraft={(d) => props.onDraft(tab, d)} />
          )}
        </div>
      </div>
      <FormFoot note={reviewing ? reviewNote(count, props.app) : `Question ${tab + 1} of ${count}`}>
        {tab > 0 && (
          <button className="ui-button" type="button" onClick={() => onTab(tab - 1)}>
            Back
          </button>
        )}
        <button className="ui-button ui-button--primary" type="button" disabled={primary.disabled} onClick={primary.press}>
          {primary.label}
        </button>
      </FormFoot>
    </>
  );
}

// ---- a plan ---------------------------------------------------------------------------------------------------------

/** A plan approved in one of Claude Code's modes, or sent back. */
export type PlanChoice = "keep" | PlanMode;

const PLAN_NOTES: Record<PlanMode, string> = {
  auto: "The agent decides which tools need asking.",
  acceptEdits: "Edits go ahead without asking; commands still ask.",
  default: "Edits need your approval.",
};

export function PlanForm(props: { detail: AskDetail; app: string; agent: string; backOnly: boolean; choice: PlanChoice; feedback: string; onChoice: (c: PlanChoice) => void; onFeedback: (t: string) => void; onSubmit: () => void; busy: boolean }) {
  const { app, agent, backOnly, onChoice } = props;
  const radioName = `${useId()}-plan`;
  const plan = props.detail.ask.plan;
  // A session that can only send a plan back has "keep planning" as its one choice.
  const choice: PlanChoice = backOnly ? "keep" : props.choice;
  const keeping = choice === "keep";
  const fileLine = plan?.filePath ? <p className="answer-planfile">{plan.filePath}</p> : null;

  const keepOption = (
    <label className="answer-opt">
      <input type="radio" name={radioName} checked={keeping} onChange={() => onChoice("keep")} />
      <span className="answer-opt-label">No, keep planning</span>
      {keeping && <textarea className="answer-text" rows={2} placeholder={`Tell ${agent} what to change`} aria-label={`Tell ${agent} what to change`} value={props.feedback} onChange={(e) => props.onFeedback(e.target.value)} />}
    </label>
  );
  const approveOptions = PLAN_MODES.map((mode) => (
    <label key={mode} className="answer-opt">
      <input type="radio" name={radioName} checked={choice === mode} onChange={() => onChoice(mode)} />
      <span className="answer-opt-label">{PLAN_LABELS[mode]}</span>
      <span className="answer-opt-desc">{PLAN_NOTES[mode]}</span>
    </label>
  ));
  // Shown when the session takes plan feedback but not plan approval (`respond.accepts`): its permission hooks do not run.
  const ways = backOnly ? (
    <>
      <p className="answer-note">
        This session can't take an approval from the dashboard, because {app} doesn't run the reporter's permission hooks on this computer, as where an organization manages {app}. Approve the plan in the terminal, or send it back from here.
      </p>
      <fieldset className="answer-opts" aria-label="Plan feedback">
        {keepOption}
      </fieldset>
    </>
  ) : (
    <fieldset className="answer-opts" aria-label="Approve the plan">
      {approveOptions}
      {keepOption}
    </fieldset>
  );

  return (
    <>
      <div className="answer-section">
        <p className="answer-q">Ready to code?</p>
        {fileLine}
        <div className="answer-plan">
          <Markdown source={plan?.text ?? ""} />
        </div>
        {ways}
      </div>
      <FormFoot note="Editing the plan text is only in the terminal.">
        <button className="ui-button ui-button--primary" type="button" disabled={props.busy} onClick={props.onSubmit}>
          {keeping ? "Send feedback" : "Approve plan"}
        </button>
      </FormFoot>
    </>
  );
}

// ---- a tool permission ----------------------------------------------------------------------------------------------

/** A non-empty string field of the tool's input, else null. */
function inputText(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** A Codex file approval's operations in words, as apply_patch's headers name them (Add, Delete, Update File; Move to). */
const OP_WORDS = new Map([
  ["add", "Add"],
  ["delete", "Delete"],
  ["update", "Update"],
  ["move", "Move"],
]);

/**
 * A path that reads on one line exactly as written: no line break or other control character (the Codex reporter leaves such
 * a path out and marks the list cut).
 */
const onePath = (v: unknown): v is string => typeof v === "string" && !/[\u0000-\u001f\u007f]/.test(v);

/**
 * A Codex file approval's `changes`, one line per change: its operation, its path, and where a move goes. Null unless
 * every change is well formed, and then the input is shown as it came (as JSON, escaped), so no change is ever left out of what the
 * owner sees or drawn as more than one line.
 */
function changeLines(input: Record<string, unknown>): string[] | null {
  const list: unknown = input.changes;
  if (!Array.isArray(list) || list.length === 0) return null;
  const lines: string[] = [];
  for (const change of list as unknown[]) {
    if (typeof change !== "object" || change === null) return null;
    const { op, path, to } = change as Record<string, unknown>;
    const word = typeof op === "string" ? OP_WORDS.get(op) : undefined;
    if (word === undefined || !onePath(path) || (to != null && !onePath(to))) return null;
    lines.push(typeof to === "string" ? `${word} ${path} to ${to}` : `${word} ${path}`);
  }
  return lines;
}

/**
 * Every input field the form does not already show, as its key and its value: a string as it is, anything else as indented
 * JSON. An Allow once grants the whole input (and may grant only what was shown whole), so a field shown nowhere else is
 * listed here.
 */
function otherFields(input: Record<string, unknown>, shown: ReadonlySet<string>): [string, string][] {
  return Object.entries(input)
    .filter(([key]) => !shown.has(key))
    .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value, null, 2)]);
}

/**
 * Why only Deny is offered, for every ask whose `tool.cut` is set. A reporter sets it for a request cut short, redacted or
 * incomplete, and also for one shown in full that only the terminal may allow, so the sentence claims only what both
 * share.
 */
const DENY_ONLY = "This request can only be allowed in the terminal. You can still deny it from here.";

export function PermissionForm(props: { detail: AskDetail; provider: ProviderName; agent: string; allow: boolean; reason: string; onAllow: (allow: boolean) => void; onReason: (t: string) => void; onSubmit: (allow: boolean) => void; busy: boolean }) {
  const { agent, onAllow } = props;
  const radioName = `${useId()}-perm`;
  const tool = props.detail.ask.tool;
  const input = tool?.input ?? {};
  const command = inputText(input, "command");
  const description = inputText(input, "description");
  const why = description ?? inputText(input, "reason");
  const cwd = inputText(input, "cwd");
  const name = tool?.name ?? "A tool";
  // A Codex file approval lists its changes and its patch; any other input is shown as it came.
  const changes = name === "Edit" ? changeLines(input) : null;
  const patch = changes ? inputText(input, "patch") : null;
  const grantRoot = changes ? inputText(input, "grantRoot") : null;
  // The fields the lines below show. With neither file changes nor a command the whole input shows as JSON, leaving none out;
  // otherwise every field they do not show is listed under the command.
  const shownKeys = [changes ? "changes" : command !== null ? "command" : null, patch !== null ? "patch" : null, grantRoot !== null ? "grantRoot" : null, cwd !== null ? "cwd" : null, description !== null ? "description" : why !== null ? "reason" : null];
  const others = changes || command !== null ? otherFields(input, new Set(shownKeys.filter((k): k is string => k !== null))) : [];
  // A cut or incomplete request can't be allowed from here (the server refuses it), so only Deny is offered.
  const cut = tool?.cut === true;
  const allowing = props.allow && !cut;
  // Only a Codex `Permissions` request grants for its turn; a harness without behaviour of its own never does.
  const forTurn = isKnownProvider(props.provider) && grantsForTurn(props.detail.ask, props.provider);
  const allowLabel = forTurn ? TURN_GRANT : "Allow once";
  const allowNote = forTurn ? "Grants these permissions for the rest of this turn." : command !== null ? "This command only; later ones still ask." : "This request only; later ones still ask.";

  return (
    <>
      <div className="answer-section">
        <p className="answer-q">{command !== null ? `${name} wants to run a command` : `${name} wants your permission`}</p>
        {changes ? (
          <>
            <div className="answer-cmd">{changes.join("\n")}</div>
            {patch && <div className="answer-cmd">{patch}</div>}
          </>
        ) : (
          <div className="answer-cmd">{command ?? JSON.stringify(input, null, 2)}</div>
        )}
        {cwd && <p className="answer-cmd-detail answer-mono">in {cwd}</p>}
        {others.length > 0 ? (
          <dl className="answer-fields">
            {others.map(([key, value]) => (
              <div key={key}>
                <dt className="answer-mono">{key}</dt>
                <dd className="answer-cmd">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {why && <p className="answer-cmd-detail">{why}</p>}
        {grantRoot && <p className="answer-cmd-detail answer-mono">Also asks to allow writes under {grantRoot} for the rest of the session.</p>}
        {cut && <p className="answer-note">{DENY_ONLY}</p>}
        <fieldset className="answer-opts" aria-label="Decision">
          {cut ? null : (
            <label className="answer-opt">
              <input type="radio" name={radioName} checked={allowing} onChange={() => onAllow(true)} />
              <span className="answer-opt-label">{allowLabel}</span>
              <span className="answer-opt-desc">{allowNote}</span>
            </label>
          )}
          <label className="answer-opt">
            <input type="radio" name={radioName} checked={!allowing} onChange={() => onAllow(false)} />
            <span className="answer-opt-label">Deny</span>
            <span className="answer-opt-desc">{agent} is told no and keeps going.</span>
            {!allowing && tool?.denyReason && (
              <textarea className="answer-text" rows={2} placeholder={`Tell ${agent} why, or what to do instead (optional)`} aria-label={`Tell ${agent} why`} value={props.reason} onChange={(e) => props.onReason(e.target.value)} />
            )}
          </label>
        </fieldset>
      </div>
      <FormFoot note={`"Always allow" changes the session's rules, so it is only in the terminal.`}>
        <button className={allowing ? "ui-button ui-button--primary" : "ui-button"} type="button" disabled={props.busy} onClick={() => props.onSubmit(allowing)}>
          {allowing ? allowLabel : "Deny"}
        </button>
      </FormFoot>
    </>
  );
}
