// The parts a session's card and its List row both draw (fleet.ts says what they hold): what it is doing, with the names of the
// agents it delegates to, cut at the end; its plan step, or the next one inferred, muted; and its notes and
// relations as muted facts. Each part is one item of its container's flex line (`fl-line`, lines.css), so on a line that runs
// short they give way in order: the names first, then the facts, then the step, then the state.
import { Dots, dotsText } from "../../ui/Dots";
import type { Doing, Fact, Step } from "../now/fleet";
import "./lines.css";

/** The state and its fact, then the delegates' names when it delegates. */
export function DoingParts({ d }: { d: Doing }) {
  return (
    <>
      <span className="fl-said" title={d.title}>
        {d.line}
      </span>
      {d.names !== null ? (
        <span className="fl-names">
          <span className="ui-vh">: </span>
          <span className="fl-cut">{d.names}</span>
        </span>
      ) : null}
    </>
  );
}

export function StepPart({ step }: { step: Step }) {
  return (
    <span className={step.inferred ? "fl-step is-next" : "fl-step"} title={step.title}>
      {step.text}
    </span>
  );
}

export function FactsPart({ facts }: { facts: readonly Fact[] }) {
  return (
    <span className="fl-facts" title={dotsText(facts.map((f) => f.text))}>
      <Dots
        className="is-oneline"
        items={facts.map((f) => (
          <span key={f.key} title={f.title} data-warn={f.key === "hooks" || f.key === "reporter" || undefined}>
            {f.text}
          </span>
        ))}
      />
    </span>
  );
}
