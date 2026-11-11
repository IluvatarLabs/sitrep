// The words beside a line's stations (SessionBlock), in the console's one vocabulary (states.ts): a state and its fact ("Stuck
// 6m", "Failed · tool error"), an agent's kind and model, and a fold's counts. Unknown facts are left out rather than guessed.
import { fmtAge } from "../../format";
import { familyName } from "../../logic";
import { stateLine, STATE_WORD } from "../../states";
import type { AgentView, ModelFamily, SessionView } from "../../types";
import { dotsText } from "../../ui/Dots";
import type { StationKind } from "../../ui/Station";

/** "Sonnet 5.5", or null when no model is reported. */
export function modelName(family: ModelFamily, model: string | null): string | null {
  return model === null && family === "other" ? null : familyName(family, model);
}

/** What kind of agent it is: a fork, a teammate, or the agent's type. */
export function kindWord(a: AgentView): string {
  if (a.kind === "fork") return "fork";
  if (a.kind === "teammate") return "teammate";
  return a.type.trim() || "agent";
}

/** A station's state in its two parts: the word that never gives way ("Failed", "Idle 12m"), and its fact when one is known. */
export interface StateWords {
  word: string;
  cause: string | null;
}

/** "word · fact" split at its first dot. */
function split(line: string): StateWords {
  const at = line.indexOf(" · ");
  return at < 0 ? { word: line, cause: null } : { word: line.slice(0, at), cause: line.slice(at + 3) };
}

/** A session's state and fact, as its row's second line says it (states.ts stateLine). */
export const sessionWords = (s: SessionView, now: number): StateWords => split(stateLine(s, now));

/** An agent's state by its station: one word per state, with how long a stuck one has been quiet or why a failed one failed. */
export function agentWords(a: AgentView, kind: StationKind, now: number): StateWords {
  switch (kind) {
    case "stuck":
      return { word: a.lastActivityAt === null ? STATE_WORD.stuck : `${STATE_WORD.stuck} ${fmtAge((now - a.lastActivityAt) / 1000)}`, cause: null };
    case "failed":
      return { word: STATE_WORD.failed, cause: a.failure && a.failure.class !== "Unknown" ? a.failure.class.toLowerCase() : null };
    case "needs-you":
      return { word: STATE_WORD["needs-you"], cause: null };
    case "queued":
      return { word: "Queued", cause: null };
    case "aborted":
      return { word: "Stopped", cause: null };
    case "done":
      return { word: STATE_WORD.done, cause: null };
    default:
      return { word: STATE_WORD.working, cause: null };
  }
}

/** "Step 3/8 · Survey the adapters", while a plan step is in progress; null otherwise. */
export function planStep(s: Pick<SessionView, "plan">): string | null {
  const steps = s.plan?.steps ?? [];
  const at = steps.findIndex((x) => x.state === "active");
  return at < 0 ? null : `Step ${at + 1}/${steps.length} · ${steps[at]!.text}`;
}

/** "3 done · 2 failed", leaving out a count of 0: the agents a fold holds. */
export function foldWords(done: number, failed: number): string {
  return dotsText([done > 0 ? `${done} done` : null, failed > 0 ? `${failed} failed` : null]);
}
