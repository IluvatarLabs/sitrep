// An agent's failure: its class and time, the failing call, the tail of its output, the evidence, and whether the step was
// retried. Everything in it is reported text, shown as text, never as HTML. No model writes an explanation of it: no LLM sits
// in a status path.
import type { ReactNode } from "react";
import type { Failure } from "../types";
import { Dots } from "../ui/Dots";
import { Station } from "../ui/Station";
import { Unknown } from "../ui/Unknown";
import { clock } from "../views/session/bits";
import "../views/session/session.css";

/** Output lines that read as the failure itself; the last line is always one of them. */
const ERROR_LINE = /^(Error|FAIL|fatal|\d{3} |PreToolUse)/;

/** One labelled part of the box. */
function Part({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="fb-part">
      <h5>{label}</h5>
      {children}
    </div>
  );
}

/** The output tail, one span per line, with the lines that read as errors picked out. */
function OutputTail({ lines }: { lines: string[] }) {
  const lastIndex = lines.length - 1;
  return (
    <pre className="sv-code">
      {lines.map((text, i) => {
        const isError = i === lastIndex || ERROR_LINE.test(text);
        return (
          <span key={i} className={isError ? "fb-bad" : undefined}>
            {text}
            {i === lastIndex ? "" : "\n"}
          </span>
        );
      })}
    </pre>
  );
}

/** The heading: the failed station and the failure's class, and its time on the right. */
function Heading({ f }: { f: Failure }) {
  return (
    <div className="fb-head">
      <Station kind="failed" />
      <b>{f.class}</b>
      <time className="sv-num sv-muted">{clock(f.at)}</time>
    </div>
  );
}

export function FailureBox({ failure: f }: { failure: Failure }) {
  const callLabel = <Dots items={["Failing call", f.tool, f.exitCode === null ? null : `exit ${f.exitCode}`]} />;
  return (
    <section className="fb" aria-label={`Failure: ${f.class}`}>
      <Heading f={f} />
      <div className="fb-body">
        <Part label={callLabel}>{f.call === null ? <Unknown reason="The call was not recorded" /> : <pre className="sv-code">{f.call}</pre>}</Part>
        {f.outputTail.length > 0 ? (
          <Part label="Output">
            <OutputTail lines={f.outputTail} />
          </Part>
        ) : null}
        {f.evidence.length > 0 ? (
          <Part label="Evidence">
            <ul className="fb-evid">
              {f.evidence.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </Part>
        ) : null}
        <p className="fb-after">{f.retriedAs ? "Retried by a new agent" : "Not retried"}</p>
      </div>
    </section>
  );
}
