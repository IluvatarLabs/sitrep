// A session's plan as a checklist, in Codex's own form (codex-rs/tui/src/history_cell/plans.rs:278-288): in progress first,
// then blocked and pending, then done in the order they finished; a done step ticked, struck through and dimmed, the step in
// progress in bold with the working mark, a pending one a box, a blocked one stuck's orange mark (the warning colour); with none in progress, the first
// pending step is marked "Next (inferred)"; who owns a step and for how long on the right. A session without a plan has no
// checklist at all. The session page and the Fleet's opened List row draw it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fmtAge } from "../format";
import { agentElapsedSec, familyName, orderedSteps, planProgress } from "../logic";
import type { AgentView, PlanStep, PlanStepView, SessionView } from "../types";
import { dotsText } from "../ui/Dots";
import { Station } from "../ui/Station";
import "../views/session/session.css";
import { PageNav } from "./PageNav";

const PER_PAGE = 10;

/** A step's mark: the state marks for done and in progress, stuck's (the warning colour) for blocked, and Codex's box for a step not started. */
const MARK: Record<PlanStep["state"], ReactNode> = {
  done: <Station kind="done" size={14} />,
  active: <Station kind="working" size={14} />,
  blocked: <Station kind="stuck" size={14} />,
  pending: (
    <svg className="pl-box" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
    </svg>
  ),
};

/** The state for screen readers, after the step's words. */
const SAID: Record<PlanStep["state"], string> = { done: "done", active: "in progress", blocked: "blocked", pending: "pending" };

/** Who owns a step, and for how long: its agent's name or type and that agent's time; a reporter's own label when the agent is not listed. */
function owner(step: PlanStep, agents: readonly AgentView[], now: number): { label: string; age: string | null; title: string } | null {
  const a = step.ownerAgentId === null ? undefined : agents.find((x) => x.id === step.ownerAgentId);
  if (!a) return step.ownerLabel ? { label: step.ownerLabel, age: null, title: step.ownerLabel } : null;
  const kind = a.kind === "fork" ? "fork" : a.type;
  const model = `${familyName(a.modelFamily, a.model)}${a.effort ? ` ${a.effort}` : ""}`;
  return { label: a.name ?? kind, age: fmtAge(agentElapsedSec(a, now)), title: dotsText([a.description, kind, model]) };
}

/**
 * The step a plan with none in progress goes on to: its first pending one, in plan order. Null while a step is in progress
 * or none is pending.
 */
function inferredNext(plan: SessionView["plan"]): string | null {
  const steps = plan?.steps ?? [];
  if (steps.some((x) => x.state === "active")) return null;
  return steps.find((x) => x.state === "pending")?.id ?? null;
}

function Step({ step, next, agents, now }: { step: PlanStepView; next: boolean; agents: readonly AgentView[]; now: number }) {
  const who = owner(step, agents, now);
  return (
    <li className={`pl-step ${step.state}`}>
      <span className="pl-mk">{MARK[step.state]}</span>
      <span className="pl-tx" title={step.state === "active" && step.activeText ? step.activeText : undefined}>
        {step.text}
        {next ? <span className="pl-next">Next (inferred)</span> : <span className="ui-vh">{` (${SAID[step.state]})`}</span>}
      </span>
      {who ? (
        <span className="pl-ow" title={who.title}>
          <span className="pl-who">{who.label}</span>
          {who.age ? <span className="sv-num">{who.age}</span> : null}
        </span>
      ) : null}
    </li>
  );
}

/** One polite line when steps finish while the list is open; a new session or a first plan says nothing. */
function useFinishedNote(steps: readonly PlanStepView[], sessionId: string): string {
  const [note, setNote] = useState("");
  const last = useRef<{ sessionId: string; count: number; done: ReadonlySet<string> } | null>(null);
  useEffect(() => {
    const doneNow = steps.filter((x) => x.state === "done");
    const was = last.current;
    last.current = { sessionId, count: steps.length, done: new Set(doneNow.map((x) => x.id)) };
    if (!was || was.sessionId !== sessionId || was.count === 0) return setNote("");
    const finished = doneNow.filter((x) => !was.done.has(x.id));
    if (finished.length === 1) setNote(`${finished[0]!.text} done.`);
    else if (finished.length > 1) setNote(`${finished.length} steps done.`);
  }, [steps, sessionId]);
  return note;
}

/** The page holding the step in progress, else the inferred next one; the first page when there is neither. */
const pageOfCurrent = (steps: readonly PlanStepView[], next: string | null): number =>
  Math.max(0, Math.floor(steps.findIndex((x) => x.state === "active" || x.id === next) / PER_PAGE));

/**
 * A session's plan: its title and how many steps are complete, then the checklist, ten steps to a page, opening on the page
 * with the step in progress; after that the page is the viewer's. Nothing at all without a plan. `now` defaults to this
 * render's time (the owner's age moves with the caller's redraws).
 */
export function PlanSteps({ s, now = Date.now() }: { s: SessionView; now?: number }) {
  const { plan } = s;
  const ordered = useMemo(() => orderedSteps(plan), [plan]);
  const next = inferredNext(plan);
  const note = useFinishedNote(ordered, s.id);
  const [picked, setPicked] = useState<{ sessionId: string; page: number } | null>(null);
  const progress = planProgress(plan);
  if (!plan || !progress) return null;

  const pages = Math.ceil(ordered.length / PER_PAGE);
  const page = Math.min(picked?.sessionId === s.id ? picked.page : pageOfCurrent(ordered, next), pages - 1);
  const first = page * PER_PAGE;
  const shown = ordered.slice(first, first + PER_PAGE);
  return (
    <div className="pl">
      <div className="pl-head">
        <h3>{plan.title ?? "Plan"}</h3>
        <span className="pl-prog sv-num">{`${progress.done}/${progress.total} complete`}</span>
      </div>
      <ol className="pl-steps">
        {shown.map((step) => (
          <Step key={step.id} step={step} next={step.id === next} agents={s.agents} now={now} />
        ))}
      </ol>
      {pages > 1 ? <PageNav label="Plan pages" at={page} pages={pages} from={first} shown={shown.length} total={ordered.length} perPage={PER_PAGE} onPage={(n) => setPicked({ sessionId: s.id, page: n })} compact /> : null}
      <span className="ui-vh" role="status" aria-live="polite">
        {note}
      </span>
    </div>
  );
}
