// The message box at the foot of the answer panel and the session page: a new message, a reply in place of an open ask's
// answer (only where the ask allows one), or one of the commands the session's harness takes from the dashboard (respond.ts
// COMMANDS): /clear after a confirmation, and /compact. A harness with no native /clear is offered /compact only.
// Styles: shell/answer.css.
import { useState, type KeyboardEvent } from "react";
import { isKnownProvider } from "../../../../server/src/fleet/protocol";
import { ASK_WORD, COMMANDS, type CantReason, type SlashCommand } from "../respond";
import type { AskKind, ProviderName } from "../types";

/** The commands a session's harness takes from the dashboard (respond COMMANDS); none for a harness the console has no entry for. */
export const commandsOf = (p: ProviderName): readonly SlashCommand[] => (isKnownProvider(p) ? COMMANDS[p] : []);

/**
 * Where a session that can't take this from here is answered, one line, with why on hover: answering is off, or the session
 * is answered in the Codex app or its terminal (a `claude -p` run takes no answers at all). A harness the console has no entry
 * for (Hermes) is only observed: it is answered in its own app.
 */
function offWords(edge: "off" | "cant", reason: CantReason, machine: string, app: string, provider: ProviderName): { head: string; why: string } {
  if (edge === "off") return { head: "Answering is off", why: "The server's answering or activity feed setting, or this session's respond option, is off." };
  if (!isKnownProvider(provider)) return { head: `Answer in ${app}`, why: `The dashboard observes ${app} sessions; it does not answer them.` };
  switch (reason) {
    case "outdated": {
      // The Update command's installer runs `claude plugin update`, which asks for a restart ("Restart to apply changes"); a
      // resumed session loads the new plugin whichever copy its build reads.
      const restart = provider === "claude" ? `restart (resume) that ${app} session` : "restart codex-reporter";
      return { head: "Answer in its terminal", why: `Its reporter is older than the server supports: an answer from here never reaches it, and a message's result never comes back. Run the Update command Machines gives for ${machine}, then ${restart}.` };
    }
    case "desktop-app":
      return { head: "Answer in the Codex app", why: "A Codex desktop-app local project runs in the app's own app-server, so only the app can answer it." };
    case "observe-only":
      return { head: "Answer in its terminal", why: `It runs outside ${machine}'s Codex daemon (a desktop-app local project, an excluded CLI run, or codex exec).` };
    case "managed":
      return { head: "Answer in its terminal", why: `${app} doesn't run the reporter's permission hooks on this computer; questions and messages still work from here.` };
    case "print":
      return { head: "claude -p takes no answers", why: "It runs headless, with nobody to answer." };
    case "old":
      return { head: "Answer in its terminal", why: "Its reporter has not said yet whether it takes answers." };
  }
}

/** The note in place of the message box when answering is off or the session can't be answered from here. */
export function OffNote({ edge, reason, machine, app, provider }: { edge: "off" | "cant"; reason: CantReason; machine: string; app: string; provider: ProviderName }) {
  const { head, why } = offWords(edge, reason, machine, app, provider);
  return (
    <div className="compose-off" title={why}>
      <b>{head}</b>
    </div>
  );
}

/** The typed text as the command list reads it: its slash word (null for plain text), whether that names a command, and the commands it starts. */
function readSlash(text: string, commands: readonly SlashCommand[]): { word: string | null; known: boolean; matches: SlashCommand[] } {
  if (!text.startsWith("/")) return { word: null, known: false, matches: [] };
  const word = text.split(/\s/)[0] ?? "";
  const known = commands.some((c) => c.name === word);
  // The list offers completions only while the word is being typed: not once it names a command or has words after it.
  const matches = known || text.includes(" ") ? [] : commands.filter((c) => c.name.startsWith(word));
  return { word, known, matches };
}

function placeholderFor(pending: AskKind | null, name: string): string {
  if (pending === "question") return "Chat about this";
  if (pending !== null) return "Reply instead";
  return `Message ${name}, or type / for a command`;
}

/** The confirmation /clear needs before it goes: it starts the session over. */
function ClearConfirm({ name, onCancel, onClear }: { name: string; onCancel: () => void; onClear: () => void }) {
  return (
    <div className="compose-confirm" role="alertdialog" aria-label="Run /clear?">
      <span>
        <b>Run /clear?</b> {name} starts a new session with empty context.
      </span>
      <span className="compose-acts">
        <button className="ui-button" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="ui-button ui-button--danger" type="button" autoFocus onClick={onClear}>
          Run /clear
        </button>
      </span>
    </div>
  );
}

/** The completions for a half-typed command, above the box. */
function CommandList({ matches, highlight, onChoose }: { matches: SlashCommand[]; highlight: number; onChoose: (name: string) => void }) {
  const option = (c: SlashCommand, on: boolean) => (
    <button key={c.name} type="button" role="option" aria-selected={on} className="compose-command" onClick={() => onChoose(c.name)}>
      <span className="compose-command-name">{c.name}</span>
      <span className="compose-command-desc">{c.desc}</span>
    </button>
  );
  return (
    <div className="compose-commands" role="listbox" aria-label="Commands">
      {matches.map((c, i) => option(c, i === highlight))}
      <div className="compose-commands-foot">Other commands are terminal-only.</div>
    </div>
  );
}

export interface ComposeProps {
  /** The session's name, and the loop a message goes to. */
  name: string;
  agent: string;
  /** The commands this session's provider takes from the dashboard. */
  commands: readonly SlashCommand[];
  /** The open ask a message would replace, when its form shows and the ask allows a reply; null otherwise. */
  pending: AskKind | null;
  busy: boolean;
  error: string | null;
  draft: string;
  onDraft: (t: string) => void;
  onSend: (text: string) => void;
  /** /clear waits for this confirmation. */
  confirmClear: boolean;
  onConfirmClear: (on: boolean) => void;
}

export function Compose(props: ComposeProps) {
  const { name, pending, commands, draft, busy } = props;
  const [highlight, setHighlight] = useState(0);
  const { word, known, matches } = readSlash(draft, commands);

  // One line above the box at most: the confirmation, else what is wrong with the command typed, else what a reply does.
  let note = null;
  if (props.confirmClear) {
    const clear = () => {
      props.onConfirmClear(false);
      props.onSend("/clear");
    };
    note = <ClearConfirm name={name} onCancel={() => props.onConfirmClear(false)} onClear={clear} />;
  } else if (word && !known && draft.length > 1 && matches.length === 0) {
    const sendable = commands.map((c) => c.name).join(" and ");
    note = (
      <div className="compose-error">
        {word} runs only in the terminal. From here you can send {sendable}.
      </div>
    );
  } else if (known && draft.trim() !== word) {
    note = (
      <div className="compose-error">
        {word} takes nothing after it from here. Send {word} on its own, or use the terminal.
      </div>
    );
  } else if (pending && draft.trim() && !word) {
    note = (
      <div className="compose-warn">
        Sending this closes the {ASK_WORD[pending]} without an answer and gives {props.agent} your message instead, as "Chat about this" does.
      </div>
    );
  }

  const edit = (text: string) => {
    props.onDraft(text);
    setHighlight(0);
  };
  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (text.startsWith("/")) {
      const command = commands.find((c) => c.name === text);
      // Anything else typed after a slash runs only in the terminal; the line above the box says so.
      if (!command) return;
      if (command.command === "clear") return props.onConfirmClear(true);
    }
    props.onSend(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const listShown = matches.length > 0;
    if (listShown && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((n) => (n + step + matches.length) % matches.length);
    } else if (listShown && (e.key === "Tab" || e.key === "Enter")) {
      e.preventDefault();
      edit(matches[Math.min(highlight, matches.length - 1)]!.name);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="compose">
      {matches.length > 0 && !props.confirmClear ? <CommandList matches={matches} highlight={highlight} onChoose={edit} /> : null}
      {note}
      {props.error ? (
        <div className="compose-error" role="alert">
          {props.error}
        </div>
      ) : null}
      <div className="compose-row">
        <textarea
          className="compose-box"
          aria-label={`Message to ${name}`}
          placeholder={placeholderFor(pending, name)}
          rows={1}
          value={draft}
          data-keeps-tab={matches.length > 0 ? "" : undefined}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="ui-button ui-button--primary" type="button" disabled={!draft.trim() || busy} onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}
