// An agent's task prompt and final answer: two buttons that raise the text in the one modal panel, as markdown. The whole text
// is read from the server when the panel opens; the streamed state carries only its first 400 characters.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { VIEW_GATED } from "../../../../server/src/fleet/protocol";
import { fmtCount } from "../format";
import type { AgentView, SessionView } from "../types";
import { dotsText } from "../ui/Dots";
import { Panel } from "../ui/Panel";
import { getJson } from "../views/settings/api";
import "../views/session/session.css";
import { Markdown } from "./Markdown";
import { useCopy } from "./SessionId";

type Doc = "prompt" | "answer";
type Texts = Record<Doc, string | null>;
/** Where the whole text stands: not asked for, on its way, read, or not read. */
type Whole = { at: "none" } | { at: "loading" } | { at: "read"; texts: Texts } | { at: "failed" };

const DOC_TITLE: Readonly<Record<Doc, string>> = { prompt: "Prompt", answer: "Result" };

/** The whole texts, by the console's open read (settings api getJson), so a refusal by the view gate is told to the console. */
const readTexts = (sessionId: string, agentId: string): Promise<Texts> => getJson<Texts>(`/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/text`);

/** The length of the whole text the server holds (0 for none), and the excerpt the state carries. */
const wholeLength = (a: AgentView, doc: Doc): number => (doc === "prompt" ? a.promptChars : a.answerChars) ?? 0;
const excerpt = (a: AgentView, doc: Doc): string => (doc === "prompt" ? a.promptExcerpt : a.answerExcerpt) ?? "";

/** What a button says under its title: the whole text's length, an excerpt alone, an answer still to come, or nothing reported. */
function docMeta(a: AgentView, doc: Doc): { meta: string; any: boolean } {
  const length = wholeLength(a, doc);
  if (length > 0) return { meta: `${fmtCount(length)} chars`, any: true };
  if (excerpt(a, doc) !== "") return { meta: "excerpt only", any: true };
  const running = a.status === "running" || a.status === "queued";
  return { meta: doc === "answer" && running ? "not finished" : "not reported", any: false };
}

function DocButton({ doc, a, onOpen }: { doc: Doc; a: AgentView; onOpen: (doc: Doc, from: HTMLButtonElement) => void }) {
  const { meta, any } = docMeta(a, doc);
  return (
    <button type="button" className="rd-btn" disabled={!any} aria-haspopup="dialog" onClick={(e) => onOpen(doc, e.currentTarget)}>
      <span className="rd-t">{DOC_TITLE[doc]}</span>
      <span className="rd-m">{meta}</span>
    </button>
  );
}

/** A text in the modal panel, as markdown, with Copy. Without the whole text it shows the excerpt and says so. */
function DocPanel({ doc, a, whole, onClose }: { doc: Doc; a: AgentView; whole: Whole; onClose: () => void }) {
  const titleId = useId();
  const read = whole.at === "read" ? whole.texts[doc] : null;
  const short = excerpt(a, doc);
  const text = read ?? short;
  const { state, copy } = useCopy(text);
  let note: string | null = null;
  if (whole.at === "failed") note = "The whole text could not be read; this is its first 400 characters.";
  else if (read === null && whole.at !== "loading" && short) note = "First 400 characters; the reporter's fullPrompts option sends the whole text.";
  let body: ReactNode;
  if (whole.at === "loading") body = <p className="sv-muted">Loading…</p>;
  else if (text) body = <Markdown source={text} />;
  else body = <p className="sv-muted">—</p>;
  return (
    <Panel modal titleId={titleId} title={DOC_TITLE[doc]} sub={dotsText([a.description, a.type])} onClose={onClose} className="rd-panel">
      <div className="rd-tools">
        <button type="button" className="ui-button" disabled={!text} onClick={copy}>
          <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
        </button>
      </div>
      <div className="rd-body sv-md" tabIndex={0}>
        {body}
        {note ? <p className="rd-note">{note}</p> : null}
      </div>
    </Panel>
  );
}

/**
 * The whole text behind an open panel. Opening asks the server when it holds any; an answer that arrives after the panel
 * closed, after a newer request, or for another agent counts for nothing.
 */
function useWholeText(s: SessionView, a: AgentView) {
  const [whole, setWhole] = useState<Whole>({ at: "none" });
  const asked = useRef(0);
  const forget = useCallback(() => {
    asked.current += 1;
    setWhole({ at: "none" });
  }, []);
  const ask = useCallback(
    (doc: Doc) => {
      const request = ++asked.current;
      if (wholeLength(a, doc) === 0) return setWhole({ at: "none" });
      setWhole({ at: "loading" });
      const settle = (next: Whole) => {
        if (request === asked.current) setWhole(next);
      };
      readTexts(s.id, a.id).then(
        (texts) => settle({ at: "read", texts }),
        // A refusal by the view gate is not "could not be read": the console shows the sign-in screen in its place.
        (err: unknown) => {
          if (!(err instanceof Error && err.message === VIEW_GATED)) settle({ at: "failed" });
        },
      );
    },
    [s.id, a],
  );
  return { whole, ask, forget };
}

export function ReportDocs({ s, a }: { s: SessionView; a: AgentView }) {
  const [shown, setShown] = useState<Doc | null>(null);
  const openedBy = useRef<HTMLButtonElement | null>(null);
  const { whole, ask, forget } = useWholeText(s, a);

  const open = useCallback(
    (doc: Doc, button: HTMLButtonElement) => {
      openedBy.current = button;
      setShown(doc);
      ask(doc);
    },
    [ask],
  );
  const close = useCallback(() => {
    forget();
    setShown(null);
    openedBy.current?.focus();
  }, [forget]);
  // Another agent picked while a panel is open closes it.
  useEffect(() => {
    forget();
    setShown(null);
  }, [s.id, a.id, forget]);

  return (
    <div className="ag-part">
      <h4>Task and answer</h4>
      <div className="rd-btns">
        <DocButton doc="prompt" a={a} onOpen={open} />
        <DocButton doc="answer" a={a} onOpen={open} />
      </div>
      {shown ? <DocPanel doc={shown} a={a} whole={whole} onClose={close} /> : null}
    </div>
  );
}
