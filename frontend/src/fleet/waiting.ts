// What a session waits on: its owner (a question or a permission), background work it started, or nothing. An idle turn
// (`waitReason: 'idle'`) is not a wait. Also the one order sessions wait on their owner in.
import { idleOnBackground } from "../../../server/src/fleet/protocol";
import { fmtClock, plural } from "./format";
import type { BackgroundWait, SessionView } from "./types";

export { idleOnBackground };

/** The reporters' activity text for a wait: one of these prefixes, then the tool call or the counts ("1 shell, 1 agent"). */
const PREFIX = { owner: "waiting on you: ", background: "waiting on background: " } as const;

/** Claude Code asks a question through a tool, as it asks any permission; the owner answers it. */
export const isQuestionTool = (tool: string | null): boolean => tool === "AskUserQuestion";

/** The tool a wait note names: "Tool(input…)", or a bare tool name on a permission wait. */
export function toolOfNote(note: string, reason: SessionView["waitReason"]): string | null {
  const called = /^([A-Za-z][\w.:-]*)\(/.exec(note)?.[1];
  if (called) return called;
  // A bare word must look like a tool (Bash, mcp__x__y), not a notification type such as idle_prompt.
  return reason === "permission" ? (/^(?:[A-Z][\w.:-]*|mcp__[\w.:-]+)$/.exec(note)?.[0] ?? null) : null;
}

export interface WaitEvent {
  reason: "permission" | "input";
  tool: string | null;
}

/** A wait event read back from its activity text; null for any other event. */
export function parseWaitEvent(text: string): WaitEvent | null {
  if (!text.startsWith(PREFIX.owner)) return null;
  const rest = text.slice(PREFIX.owner.length).trim();
  const tool = toolOfNote(rest, "permission");
  // Any tool but a question, an empty note, or one that says permission is an approval; the rest is a question.
  const approval = tool !== null ? !isQuestionTool(tool) : rest === "" || /permission/i.test(rest);
  return { reason: approval ? "permission" : "input", tool };
}

// ---- background work -----------------------------------------------------------------------------------------------

type Kind = BackgroundWait["tasks"][number]["type"];

/** Each kind of background task as a noun. Activity text is read back as any string: one not listed is a task. */
const NOUN: Record<Kind, string> = { shell: "shell", agent: "agent", monitor: "monitor", workflow: "workflow", wakeup: "wake-up", other: "task" };
const nounOf = (kind: string) => (Object.hasOwn(NOUN, kind) ? NOUN[kind as Kind] : NOUN.other);

/** Counts by kind, kinds in the order they first come. */
function countKinds(tasks: readonly { type: string }[]): [string, number][] {
  const tally = new Map<string, number>();
  for (const { type } of tasks) tally.set(type, (tally.get(type) ?? 0) + 1);
  return [...tally];
}

/** The characters of task names a state line spends before it counts the rest as "+N more". */
const NAMED_BUDGET = 64;

/**
 * What a session works on in the background, as its state line's fact: each kind's count, or the wake-up and its time when one
 * is set, with what its tasks are in the reporter's words, the kinds in the order they first come: "1 background shell
 * (nightly build) · 2 background agents (survey, tests) · wake-up at 14:05 (check CI)". A name that only repeats the kind (a
 * reporter's fallback) is left out; past NAMED_BUDGET characters the other tasks are "+N more" (the first is always named).
 */
export function backgroundFact(b: BackgroundWait): string {
  let used = 0;
  return countKinds(b.tasks)
    .map(([kind, n]) => {
      const noun = nounOf(kind);
      const wake = b.wakeAt === null ? "wake-up" : `wake-up at ${fmtClock(b.wakeAt).slice(0, 5)}`;
      const head = kind === "wakeup" ? wake : plural(n, `background ${noun}`);
      const unnamed = new Set([kind, noun, `scheduled ${noun}`]);
      const names = b.tasks
        .filter((t) => t.type === kind)
        .map((t) => t.description.trim())
        .filter((d) => d !== "" && !unnamed.has(d.toLowerCase()));
      const shown: string[] = [];
      for (const name of names) {
        if (used > 0 && used + name.length > NAMED_BUDGET) break;
        shown.push(name);
        used += name.length;
      }
      const rest = names.length - shown.length;
      const said = [...shown, ...(rest > 0 ? [`+${rest} more`] : [])];
      return said.length > 0 ? `${head} (${said.join(", ")})` : head;
    })
    .join(" · ");
}

export interface BackgroundEvent {
  counts: [string, number][];
}

/** A background wait read back from its activity text: the counts by kind ("1 shell, 2 agent"). */
export function parseBackgroundEvent(text: string): BackgroundEvent | null {
  if (!text.startsWith(PREFIX.background)) return null;
  const counts: [string, number][] = [];
  for (const part of text.slice(PREFIX.background.length).split(",")) {
    const found = /^\s*(?<n>\d+) (?<kind>\w+)\s*$/.exec(part)?.groups;
    if (found?.n && found.kind) counts.push([found.kind, Number(found.n)]);
  }
  return counts.length === 0 ? null : { counts };
}

// ---- the order of waits --------------------------------------------------------------------------------------------

/**
 * The one order sessions wait on their owner in, for the needs-you queue, its button and the answer panel's stepping: those
 * holding an open ask first, by their oldest open ask, then those that wait with none, longest first. An idle session waits
 * on no one and comes last.
 */
export function byWait(a: SessionView, b: SessionView): number {
  const key = (s: SessionView): [number, number] => {
    const asked = s.asks.reduce((t, x) => (x.state === "closed" ? t : Math.min(t, x.openedAt)), Infinity);
    if (asked < Infinity) return [0, asked];
    return [s.waitReason === "idle" ? 2 : 1, s.lastActivityAt ?? s.lastSeenAt];
  };
  const [ra, ta] = key(a);
  const [rb, tb] = key(b);
  return ra - rb || ta - tb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
