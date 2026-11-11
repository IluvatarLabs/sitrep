// What the console shows for answering a session, worked out from one SessionView, the server's switches and the sign-in.
// Single owner: signed in means Admin, and Admin may answer every session. Pure.
import { LEVEL_KINDS, type RespondLimit } from "../../../server/src/fleet/protocol";
import { cardKind, liveOpenAsk, openAsk } from "./states";
import type { AskDetail, AskKind, AskSummary, DashboardCommand, Delivery, DeliveryKind, Provider, ProviderName, QuestionAnswer, RespondKind, RespondMe, SessionView } from "./types";

/** The ask the panel shows: the open one, else the one opened last. */
export const shownAsk = (s: Pick<SessionView, "asks">): AskSummary | null => openAsk(s) ?? s.asks.reduce<AskSummary | null>((last, a) => (last && last.openedAt >= a.openedAt ? last : a), null);

/** The respond kinds a session must take for an answer to each ask kind (a plan: either way of answering it). */
const KINDS_FOR_ASK: Record<AskKind, RespondKind[]> = {
  question: ["question"],
  plan: ["plan-approve", "plan-feedback"],
  permission: ["permission"],
};

/** What answering an ask of this kind needs the session to take; with no ask open, what a message needs. */
export const neededKinds = (kind: AskKind | null): RespondKind[] => (kind === null ? ["message"] : KINDS_FOR_ASK[kind]);

/**
 * Why a session can't take an answer: `outdated` (its reporter is below the server's range, so an answer from here never
 * reaches it), `observe-only` (a Codex thread the reporter cannot answer), `desktop-app` (one of those that is a Codex
 * desktop-app local thread, answered in the Codex app), `print` (a `claude -p` run), `managed` (Claude Code doesn't run the
 * reporter's permission hooks there), `old` (no respond info reported yet).
 */
export type CantReason = "outdated" | "observe-only" | "desktop-app" | "print" | "managed" | "old";

/** The limits a reason is read from, in the order they win; `managed` when none of them is reported. */
const CANT_FROM: readonly [RespondLimit, CantReason][] = [
  ["desktop-app", "desktop-app"],
  ["observe-only", "observe-only"],
  ["not-interactive", "print"],
];

export function cantReason({ respond, compat }: Pick<SessionView, "respond" | "compat">): CantReason {
  if (compat === "outdated") return "outdated";
  if (!respond) return "old";
  return CANT_FROM.find(([limit]) => respond.limits.includes(limit))?.[1] ?? "managed";
}

/**
 * `ok`; `off` when a switch is off (the server's, or the session's respond level or feed); `cant` when the session can't. An
 * outdated reporter can't: it asks for its answer by its native id, which the server answers with 404.
 */
export function canAnswer({ respond: r, compat }: Pick<SessionView, "respond" | "compat">, kind: AskKind | null): "ok" | "off" | "cant" {
  if (!r || compat === "outdated") return "cant";
  const need = neededKinds(kind);
  if (need.some((k) => r.accepts.includes(k))) return "ok";
  if (r.limits.includes("not-interactive") || r.limits.includes("observe-only")) return "cant";
  // The level allows it, so a limit took it away: the session can't, rather than a switch being off.
  const levelAllows = need.some((k) => LEVEL_KINDS[r.level].includes(k));
  return r.accepts.length > 0 && levelAllows ? "cant" : "off";
}

/** A plan this session can only send back: approving needs permission hooks it doesn't run. */
export const planBackOnly = ({ respond: r }: Pick<SessionView, "respond">): boolean => !!r && r.accepts.includes("plan-feedback") && !r.accepts.includes("plan-approve");

/**
 * Whether a session takes an answer from a row now: it waits on its person, or holds an open ask whatever its status,
 * and can take the answer.
 */
export function respondGate(s: SessionView, me: RespondMe | null, settingsOn: boolean): { show: false } | { show: true; count: string } {
  if (!settingsOn || !me?.enabled) return { show: false };
  if (cardKind(s) !== "waiting" && !liveOpenAsk(s)) return { show: false };
  const ask = openAsk(s);
  if (canAnswer(s, ask?.kind ?? null) !== "ok") return { show: false };
  return { show: true, count: ask?.kind === "question" && ask.count > 0 ? String(ask.count) : "" };
}

/** "12:23" in this browser's time zone, 24-hour: the head of the standard `HH:mm:ss GMT…` time string. */
export const clockOf = (at: number): string => new Date(at).toTimeString().slice(0, 5);

/** An ask's kind in running text ("This request was closed…"). */
export const ASK_WORD: Readonly<Record<AskKind, string>> = { question: "question", plan: "plan", permission: "request" };

/** Claude Code's own words for the three ways of approving a plan. */
export const PLAN_LABELS = {
  auto: "Yes, and use auto mode",
  acceptEdits: "Yes, auto-accept edits",
  default: "Yes, manually approve edits",
} as const;

const RECOMMENDED = "(recommended)";
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** A label ending in "(Recommended)" shows a tag instead. Compared as text, not by a regex, which is slow on a long run of spaces. */
export function cleanLabel(raw: string): { label: string; recommended: boolean } {
  const trimmed = raw.trimEnd();
  const cut = trimmed.length - RECOMMENDED.length;
  if (cut >= 0 && trimmed.slice(cut).toLowerCase() === RECOMMENDED) {
    const head = trimmed.slice(0, cut).trimEnd();
    if (!LINE_BREAK.test(head)) return { label: head, recommended: true };
  }
  return { label: raw, recommended: false };
}

/** The labels of the options one answer picked, joined with ", ". */
export const pickedLabels = (options: readonly { label: string }[], picked: readonly number[]): string => picked.map((i) => cleanLabel(options[i]?.label ?? "").label).join(", ");

/** A question's answers as the panel quotes them: picked options or the typed text per question, questions joined with "; ". */
export function questionAnswers({ ask }: Pick<AskDetail, "ask">, answers: readonly QuestionAnswer[]): string {
  const quoted = (ask.questions ?? []).map((question, i) => {
    const answer = answers[i];
    if (!answer) return "";
    return "text" in answer ? answer.text.trim() : pickedLabels(question.options, answer.options);
  });
  return quoted.filter(Boolean).join("; ");
}

/** The deliveries whose quote is a fixed choice, in the words the form offered it. */
const CHOICE_WORDS: Partial<Record<DeliveryKind, string>> = {
  "plan-feedback": "No, keep planning",
  "allow-once": "Allow once",
  deny: "Deny",
};

/**
 * Whether allowing grants the ask's permissions for the rest of its turn: a Codex `Permissions` request, which the Codex
 * reporter answers with `scope: "turn"`, the narrowest scope the native client offers for it. The form says so in
 * the native client's own words, not "Allow once". Only the Codex reporter names a request `Permissions`; a Claude tool of
 * that name (a plugin's) is an ordinary tool, allowed once.
 */
export const grantsForTurn = (ask: AskDetail["ask"], provider: ProviderName): boolean => provider === "codex" && ask.tool?.name === "Permissions";

export const TURN_GRANT = "Grant for this turn";

const NO_ANSWERS: readonly QuestionAnswer[] = [];

/** An answer as the sending and taken-first receipts quote it (shell/answering.tsx); a reply, message or command quotes its own text. */
export function deliverySummary(detail: Pick<AskDetail, "ask">, d: Delivery, provider: ProviderName): string {
  switch (d.kind) {
    case "question":
      return questionAnswers(detail, d.answers ?? NO_ANSWERS);
    case "plan-approve":
      return PLAN_LABELS[d.mode ?? "auto"];
    case "allow-once":
      if (grantsForTurn(detail.ask, provider)) return TURN_GRANT;
      break;
  }
  return CHOICE_WORDS[d.kind] ?? (d.text ?? "").trim();
}

/** A command the message box can send: as typed, as the server takes it, and as the typeahead describes it. */
export interface SlashCommand {
  name: string;
  command: DashboardCommand;
  desc: string;
}

/** Each command described in its harness's own words: Claude Code's command list, Codex's `slash_command.rs`. */
const CLEAR: SlashCommand = { name: "/clear", command: "clear", desc: "Start a new session with empty context; previous session stays on disk (resumable with /resume)" };
const COMPACT: SlashCommand = { name: "/compact", command: "compact", desc: "Free up context by summarizing the conversation so far" };
const CODEX_COMPACT: SlashCommand = { ...COMPACT, desc: "Summarize conversation to prevent hitting the context limit" };

/** The commands the dashboard offers per provider. Codex has no native /clear, so its sessions are offered /compact only. */
export const COMMANDS: Record<Provider, readonly SlashCommand[]> = {
  claude: [CLEAR, COMPACT],
  codex: [CODEX_COMPACT],
};

const NUMBER_WORDS = ["zero", "one", "two", "three", "four"];

/** A small count in words ("two"), larger ones in figures. */
export const countWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);
