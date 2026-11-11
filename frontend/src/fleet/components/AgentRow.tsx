// One row of the agent tree table: its tree guides, its station and task, then model, effort, context, tokens, cost, time and
// state in fixed columns. The main loop's row and every agent's row share the cells, so the columns line up.
import { forwardRef, type ReactNode } from "react";
import { fmtSpan, fmtTok } from "../format";
import { agentElapsedSec, COST_HINT_AGENT, familyName, TOKENS_HINT, type Guide } from "../logic";
import type { AgentView, ModelFamily } from "../types";
import { dotsText } from "../ui/Dots";
import { Station, StationWord } from "../ui/Station";
import { Unknown } from "../ui/Unknown";
import { ContextMeter, Usd } from "../views/session/bits";
import { agentStationKind } from "../views/session/trace";
import "../views/session/session.css";

/** The tree's guide lines, one per level: a line passing down, a tee or an elbow at the row's own level, or a gap. */
function Guides({ guides }: { guides: readonly Guide[] }) {
  if (guides.length === 0) return null;
  const ownLevel = guides.length - 1;
  const guideClass = (g: Guide, level: number) => {
    if (g === "blank") return "blank";
    if (level === ownLevel) return g === "last" ? "elbow" : "tee";
    return "pass";
  };
  return (
    <span className="ag-indent" aria-hidden="true">
      {guides.map((g, level) => (
        <s key={level} className={guideClass(g, level)} />
      ))}
    </span>
  );
}

/**
 * The seven cells after a row's task: model, effort, context, tokens, cost, time and state. `family` decides how a missing
 * cost reads (a model with no price, or a figure not reported).
 */
export function RowCells(props: { family: ModelFamily; model: string | null; effort: string | null; contextPct: number | null; blowouts: number | null; tokens: number | null; costUsd: number | null; costTitle: string; elapsedSec: number; status: ReactNode }) {
  const { family } = props;
  return (
    <>
      <span className="ag-c" title={props.model ?? undefined}>
        {props.model === null && family === "other" ? <Unknown reason="The model is not reported" /> : familyName(family, props.model)}
      </span>
      <span className="ag-c">{props.effort ?? <Unknown reason="Effort is not reported" />}</span>
      <span className="ag-c">
        <ContextMeter percent={props.contextPct} blowouts={props.blowouts} />
      </span>
      <span className="ag-c ag-n" title={TOKENS_HINT}>
        {props.tokens === null ? <Unknown reason="Not reported" /> : fmtTok(props.tokens)}
      </span>
      <span className="ag-c ag-n" title={props.costTitle}>
        <Usd usd={props.costUsd} />
      </span>
      <span className="ag-c ag-n">{fmtSpan(props.elapsedSec)}</span>
      <span className="ag-c">{props.status}</span>
    </>
  );
}

/** A row's task cell: its marks (guides and station), then its name and kind and any flag. */
export function TaskCell({ marks, name, kind, title, flag }: { marks: ReactNode; name: string; kind: string; title?: string; flag?: ReactNode }) {
  return (
    <span className="ag-task">
      {marks}
      <span className="ag-tx" title={title}>
        <b>{name}</b>
        <em>{kind}</em>
        {flag}
      </span>
    </span>
  );
}

export const AgentRow = forwardRef<HTMLButtonElement, { a: AgentView; guides: Guide[]; now: number; selected: boolean; flash: boolean; delegating?: string; asking?: boolean; onSelect: (id: string) => void }>(
  function AgentRow({ a, guides, now, selected, flash, delegating, asking, onSelect }, ref) {
    const kind = a.kind === "fork" ? "fork" : a.type;
    const station = agentStationKind(a, asking === true, !!delegating);
    const state = (
      <span title={delegating ?? (station === "stuck" ? "No activity past its model's threshold" : undefined)}>
        <StationWord kind={station} />
      </span>
    );
    return (
      <button ref={ref} type="button" className={flash ? "ag-row flash" : "ag-row"} id={`row-${a.id}`} aria-current={selected ? "true" : undefined} data-agent={a.id} onClick={() => onSelect(a.id)}>
        <TaskCell
          marks={
            <>
              <Guides guides={guides} />
              <Station kind={station} />
            </>
          }
          name={a.description}
          kind={kind}
          title={dotsText([a.description, kind])}
          flag={a.failure ? <em className="ag-err">{a.failure.class}</em> : null}
        />
        <RowCells
          family={a.modelFamily}
          model={a.model}
          effort={a.effort}
          contextPct={a.context.percent}
          blowouts={a.blowouts}
          tokens={a.context.tokens}
          costUsd={a.costUsdEst}
          costTitle={COST_HINT_AGENT}
          elapsedSec={agentElapsedSec(a, now)}
          status={state}
        />
      </button>
    );
  },
);
