// Activity rows in the console's words (session, agent, auto-compact, "fork of …"). Rows keep the text their reporter
// wrote, older reporters' words included ("orchestrator", "blowout", "forked fork (inherits …)"), so each is read back here:
// only the reporters' own words are rewritten, never a description, a path or a message they carry. Null for a row shown as
// written.
import { plural } from "./format";
import type { ActivityView } from "./types";
import { dotsText } from "./ui/Dots";
import { parseBackgroundEvent, parseWaitEvent } from "./waiting";

type Readable = { text: string; tool: string | null };

/** A loop as the reporters name it: the session's main loop, or an agent by its description. */
const loop = (where: string) => where.replace(/^on the orchestrator$/, "in the session");

/** Why a session ended, by the reason the harness gave. */
const ENDED: Record<string, string> = { clear: "cleared", logout: "logged out", prompt_input_exit: "you exited", resume: "switched to another session" };

/** Each kind's rewrites, tried in order: a pattern over the whole text, and the row it makes. */
const REWRITES: Partial<Record<ActivityView["kind"], [RegExp, (m: RegExpExecArray, e: Pick<ActivityView, "data">) => Readable][]>> = {
  fail: [
    [/^orchestrator turn ended with an error after a failing call: /, (_, e) => ({ text: "Turn ended with an error after a failing call", tool: typeof e.data?.tool === "string" && e.data.tool ? e.data.tool : null })],
    [/^orchestrator turn ended with (an API error|an error|a refusal)(?: \((.+)\))?$/, (m) => ({ text: `Turn ended with ${m[1]}${m[2] ? ` (${m[2].replace(/_/g, " ")})` : ""}`, tool: null })],
    [/^orchestrator thread hit a system error$/, () => ({ text: "System error", tool: null })],
  ],
  blow: [[/^context window exceeded \(blowout #(\d+)\) (on the orchestrator|in .+?)(, compacted to \d+%)?$/, (m) => ({ text: `Auto-compact #${m[1]} ${loop(m[2]!)}${m[3] ?? ""}`, tool: null })]],
  compact: [[/^(\w+) compaction (on the orchestrator|in .+)$/, (m) => ({ text: `${m[1] === "auto" ? "Auto" : "Manual"} compaction ${loop(m[2]!)}`, tool: null })]],
  spawn: [[/^forked fork \(inherits (.+?)\): (.*)$/s, (m) => ({ text: `fork (${m[1]}): ${m[2]}`, tool: null })]],
  skill: [[/^(.+) loaded into orchestrator$/s, (m) => ({ text: `${m[1]} loaded into the session`, tool: null })]],
  start: [[/^session\.start(?: · (.+))?$/, (m) => ({ text: dotsText(["Started", m[1]]), tool: null })]],
  end: [[/^session\.end · (.*)$/, (m) => ({ text: dotsText(["Ended", Object.hasOwn(ENDED, m[1]!) ? ENDED[m[1]!] : null]), tool: null })]],
  note: [[/^aborted: (.*)$/s, (m) => ({ text: `Stopped: ${m[1]}`, tool: null })]],
};

/** A wait in the harnesses' words: what it asks of you with its call or question, or the background work it rests on. */
function waitWords(text: string): Readable | null {
  const wait = parseWaitEvent(text);
  if (wait) return { text: dotsText([wait.reason === "input" ? "Question" : "Permission", text.slice(text.indexOf(":") + 1).trim()]), tool: null };
  const bg = parseBackgroundEvent(text);
  return bg ? { text: `Working · ${bg.counts.map(([kind, n]) => `${plural(n, kind === "wakeup" ? "wake-up" : kind)}`).join(", ")} in the background`, tool: null } : null;
}

export function readableEvent(e: Pick<ActivityView, "kind" | "text" | "data">): Readable | null {
  if (e.kind === "wait") return waitWords(e.text);
  for (const [pattern, make] of REWRITES[e.kind] ?? []) {
    const m = pattern.exec(e.text);
    if (m) return make(m, e);
  }
  return null;
}
