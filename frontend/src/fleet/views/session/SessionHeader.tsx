// The top of a session's page, two lines. First its state mark and name (Rename, signed in, gives it a display name for the
// dashboard only), then its state line; then where and on what it runs: the machine with its OS, where it runs on it when that
// is not a terminal (Chips SurfaceChip), the model with its effort, its directory (cut at the front, so its last folders stay), its repository and git line, and copy controls for its resume
// and fork commands (when its harness has them) and its id. `SessionNotices`: its reporter out of range, its Codex hooks off, and files another loop also
// edited.
import { useState, type FormEvent, type ReactNode } from "react";
import { LIMITS } from "../../../../../server/src/fleet/protocol";
import { ModelChip, SurfaceChip } from "../../components/Chips";
import { IconCheck, IconCopy, osLogo } from "../../components/Icons";
import { HOOKS_OFF_NOTE, hooksOffText, versionNote } from "../../components/SessionCard";
import { SHORT_ID, useCopy } from "../../components/SessionId";
import { adminApi, RespondError } from "../../respondApi";
import { stateLine, stateOf } from "../../states";
import type { SessionView } from "../../types";
import { Dots, dotsText } from "../../ui/Dots";
import { Station } from "../../ui/Station";
import { Unknown } from "../../ui/Unknown";
import { useRespond } from "../../useRespond";
import { clock, type Part } from "./bits";
import { endReasonWords } from "./endReason";
import { gitFacts } from "./GitFacts";

/** A pencil: the Rename control beside the name. */
const PENCIL = (
  <svg className="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M10.6 3.1l2.3 2.3-7.4 7.4-3 .7.7-3zM9.4 4.3l2.3 2.3" />
  </svg>
);

/** The name in a field: Enter or Save sends it, an empty field goes back to the reported name, Escape or Cancel leaves it. */
function RenameField({ s, onDone }: { s: SessionView; onDone: () => void }) {
  const ctx = useRespond();
  const [draft, setDraft] = useState(s.name);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await adminApi.rename(s.id, draft.trim() || null);
      onDone();
    } catch (err) {
      if (err instanceof RespondError && err.status === 403) void ctx?.refresh();
      setProblem(err instanceof RespondError ? `Not renamed: ${err.message}.` : "Not renamed: the server can't be reached.");
      setSaving(false);
    }
  };
  return (
    <form className="sv-rename" onSubmit={(e) => void save(e)}>
      <input
        aria-label="Display name"
        maxLength={LIMITS.name}
        placeholder="Reported name"
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
        }}
      />
      <button type="submit" className="ui-button ui-button--primary" disabled={saving}>
        Save
      </button>
      <button type="button" className="ui-button" onClick={onDone}>
        Cancel
      </button>
      {problem ? (
        <span className="sv-rename-err" role="alert">
          {problem}
        </span>
      ) : null}
    </form>
  );
}

/** What resuming and forking can do that the command does not say. */
const RESUME_NOTE = "Resuming a session that still runs elsewhere writes both into one conversation. Start-up flags are not restored: pass them again.";
const FORK_NOTE = "A fork does not carry this session's permissions, and works in the same directory, so its file edits are real: start it in a worktree. Start-up flags are not restored.";

/**
 * A copy control: its icon and word, a check and "Copied" for a moment after a press; the whole text on hover, with `note` (what
 * the command does that it does not say) under it, which assistive tech reads as the control's description.
 */
function CopyButton({ word, label, text, note }: { word: string; label: string; text: string; note?: string }) {
  const { state, copy } = useCopy(text);
  const Mark = state === "copied" ? IconCheck : IconCopy;
  return (
    <button type="button" className="sv-copy" title={note ? `${label}: ${text}\n${note}` : `${label}: ${text}`} aria-label={label} onClick={copy}>
      <Mark />
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : word}</span>
    </button>
  );
}

interface HeadProps {
  s: SessionView;
  now: number;
  /** A stored session (History): how it ended instead of its state, and nothing to change. */
  readOnly: boolean;
}

export function SessionHead({ s, now, readOnly }: HeadProps) {
  const respond = useRespond();
  const [renaming, setRenaming] = useState(false);
  const state = stateOf(s);
  const canRename = !readOnly && respond?.me?.signedIn === true;
  // A reason that only says "Ended" (the generic one) would repeat the line's own word: the time says it alone.
  const why = readOnly ? endReasonWords(s.endReason) : null;
  const line: ReactNode = readOnly ? dotsText([`Ended ${clock(s.lastSeenAt)}`, why === "Ended" ? null : why]) : stateLine(s, now);
  // The repository, then git's facts (gitFacts: branch, a worktree, ahead, behind; "—" with its reason when git is not
  // reported), less the main checkout and the modified count, which say nothing (GitFacts).
  const git: Part[] = [...(s.repoName ? [{ key: "repo", text: s.repoName }] : []), ...gitFacts(s.git, s.cwd)];

  return (
    <header className="sv-head">
      <div className="sv-l1">
        <Station kind={readOnly ? "done" : state} />
        {renaming ? (
          <RenameField s={s} onDone={() => setRenaming(false)} />
        ) : (
          <>
            <h1 className="sv-name" title={s.name}>
              {s.name}
            </h1>
            {canRename ? (
              <button type="button" className="ui-button ui-button--icon sv-pencil" aria-label="Rename" title="Rename" onClick={() => setRenaming(true)}>
                {PENCIL}
              </button>
            ) : null}
          </>
        )}
        <span className={`sv-state ${readOnly ? "done" : state}`}>{line}</span>
      </div>
      <div className="sv-l2">
        <span className="sv-machine" title={s.machine.os ?? "OS not reported"}>
          {osLogo(s.machine.os)}
          {s.machine.name}
        </span>
        <SurfaceChip surface={s.hostSurface} />
        <ModelChip provider={s.provider} family={s.modelFamily} model={s.model} effort={s.effort} />
        {/* Right to left puts the ellipsis at the front of a long path; bdi keeps the path's own order. With no directory there is
            no git to say either: one "—" says both. */}
        {s.cwd ? (
          <>
            <span className="sv-path" title={s.cwd}>
              <bdi>{s.cwd}</bdi>
            </span>
            <span className="sv-gitline" title={dotsText(git.map((f) => f.text))}>
              <Dots className="is-oneline" items={git.map((f) => f.node ?? f.text)} />
            </span>
          </>
        ) : (
          <Unknown reason="Working directory not reported" />
        )}
        <span className="sv-copies">
          {/* A harness with no resume or fork command the server knows (Hermes) offers none. */}
          {s.resumeCommand ? <CopyButton word="Resume" label="Copy resume command" text={s.resumeCommand} note={RESUME_NOTE} /> : null}
          {s.forkCommand ? <CopyButton word="Fork" label="Copy fork command" text={s.forkCommand} note={FORK_NOTE} /> : null}
          <CopyButton word={s.nativeId.slice(0, SHORT_ID)} label="Copy session id" text={s.nativeId} />
        </span>
      </div>
    </header>
  );
}

/** Files another loop edited within 5 minutes of this session editing them, each with who and when. */
function Collisions({ s }: { s: SessionView }) {
  const fileName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
  return (
    <ul className="sv-notice sv-coll" aria-label="Files also edited by another loop">
      {s.collisions.map((c) => (
        <li key={`${c.path}:${c.sessionId}:${c.agentId ?? ""}`} title={c.path}>
          {`Also edited by ${c.name}${c.sessionId === s.id ? " in this session" : ""}: `}
          <span className="sv-mono">{fileName(c.path)}</span>
          <span className="sv-muted">{` at ${clock(c.at)}`}</span>
        </li>
      ))}
    </ul>
  );
}

/** What the owner should know about this session's reporting: a reporter out of range, Codex hooks off, files another loop edited. */
export function SessionNotices({ s, readOnly }: { s: SessionView; readOnly: boolean }) {
  const reporter = versionNote(s);
  return (
    <>
      {reporter ? (
        <p className="sv-notice" title={reporter.text}>
          {`Reporter ${reporter.label}`}
        </p>
      ) : null}
      {s.hooksActive === false ? (
        <p className="sv-notice" title={HOOKS_OFF_NOTE}>
          {hooksOffText(s)}
        </p>
      ) : null}
      {!readOnly && s.collisions.length ? <Collisions s={s} /> : null}
    </>
  );
}
