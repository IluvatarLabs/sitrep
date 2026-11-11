// The agent tree as a table: the main loop, then every agent under the one that launched it, in launch order or sorted among
// siblings by a column header (no agents: the main loop's row alone). Each row shows its detail in the inspector: an agent's,
// or the main loop's from its own row. One toolbar row over it: the page's Timeline ⇄ Agents switch, and Back to launch
// order while a column sorts it.
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { agentOrder, buildTree, COST_HINT_HEADER, COST_HINT_ORCHESTRATOR, delegateText, ORCHESTRATOR_ROW, orchestratorCostUsd, sessionElapsedSec, TOKENS_HINT, treeDepth, type AgentSortKey } from "../logic";
import { stateLine, stateOf } from "../states";
import type { AgentView, SessionView } from "../types";
import { Station, StationWord } from "../ui/Station";
import { AgentRow, RowCells, TaskCell } from "./AgentRow";
import "../views/session/session.css";

export interface AgentSort {
  key: AgentSortKey | null;
  dir: 1 | -1;
}

const HEADERS: readonly { key: AgentSortKey; label: string; num?: true }[] = [
  { key: "model", label: "Model" },
  { key: "effort", label: "Effort" },
  { key: "ctx", label: "Context" },
  { key: "tok", label: "Tokens", num: true },
  { key: "cost", label: "Est. cost", num: true },
  { key: "time", label: "Time", num: true },
  { key: "status", label: "State" },
];

function headerTitle(key: AgentSortKey, label: string): string {
  if (key === "tok") return `Sort by tokens. ${TOKENS_HINT}`;
  if (key === "cost") return `Sort by cost. ${COST_HINT_HEADER}`;
  return `Sort by ${label.toLowerCase()}`;
}

/** The sort direction drawn, on the sorted column only. */
function SortMark({ dir }: { dir: 1 | -1 }) {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path d={dir > 0 ? "M2.5 7.5L6 4l3.5 3.5" : "M2.5 4.5L6 8l3.5-3.5"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The header row: Task, then a sort button per column, the sorted one showing which way it sorts. */
function SortHeaders({ sort, onSort }: { sort: AgentSort; onSort: (key: AgentSortKey) => void }) {
  return (
    <div className="ag-row ag-hd">
      <span className="ag-task">Task</span>
      {HEADERS.map(({ key, label, num }) => {
        const sorted = sort.key === key;
        return (
          <span key={key} className={num ? "ag-c ag-n" : "ag-c"}>
            <button type="button" aria-pressed={sorted} title={headerTitle(key, label)} onClick={() => onSort(key)}>
              {label}
              {sorted ? <SortMark dir={sort.dir} /> : null}
              {sorted ? <span className="ui-vh">{sort.dir > 0 ? ", ascending" : ", descending"}</span> : null}
            </button>
          </span>
        );
      })}
    </div>
  );
}

interface AgentTreeProps {
  s: SessionView;
  now: number;
  /** The agent whose detail the inspector shows, and showing one. */
  selectedAgent: string | null;
  onSelect: (id: string) => void;
  /** The row to flash once and bring into view, scrolling only as far as needed. */
  flashAgent: string | null;
  /** The running agents each loop launched (states.ts waitingOnByRow): their names are its state's title. */
  waiting: ReadonlyMap<string, readonly AgentView[]>;
  sort: AgentSort;
  /** Sorts by a column; null goes back to launch order. */
  onSort: (column: AgentSortKey | null) => void;
  /** What leads the toolbar row: the page's Timeline ⇄ Agents switch. */
  lead?: ReactNode;
}

export function AgentTree(props: AgentTreeProps) {
  const { s, now, sort, waiting, flashAgent, selectedAgent } = props;
  // A sort orders each parent's children and keeps the tree; with none, rows are in launch order.
  const order = sort.key === null ? undefined : agentOrder(sort.key, sort.dir, now);
  const rows = buildTree(s.agents, order);
  // Each level past the second widens the Task column by one guide; the table scrolls sideways in its own box.
  const extraDepth = Math.max(0, treeDepth(rows) - 2);
  const live = s.status !== "done";
  const asking = new Set(s.asks.filter((a) => live && a.state !== "closed" && a.agentId !== null).map((a) => a.agentId!));
  const delegating = (id: string) => {
    const awaited = waiting.get(id);
    return awaited ? delegateText(awaited) : undefined;
  };
  const marked = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (flashAgent) marked.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [flashAgent]);

  const unsort = sort.key ? (
    <button type="button" className="ui-button" onClick={() => props.onSort(null)}>
      Back to launch order
    </button>
  ) : null;
  const agentRows = rows.map(({ agent, guides }) => (
    <AgentRow
      key={agent.id}
      ref={flashAgent === agent.id ? marked : undefined}
      a={agent}
      guides={guides}
      now={now}
      selected={selectedAgent === agent.id}
      flash={flashAgent === agent.id}
      delegating={delegating(agent.id)}
      asking={asking.has(agent.id)}
      onSelect={props.onSelect}
    />
  ));
  const mainKind = stateOf(s);

  return (
    <section className="ag-tree" aria-label="Agents">
      <div className="sv-bar">
        {props.lead}
        {unsort}
      </div>
      <div className="ag-scroll" style={{ "--deep": extraDepth } as CSSProperties}>
        <SortHeaders sort={sort} onSort={props.onSort} />
        <button type="button" className="ag-row ag-root" data-agent={ORCHESTRATOR_ROW} aria-current={selectedAgent === ORCHESTRATOR_ROW ? "true" : undefined} onClick={() => props.onSelect(ORCHESTRATOR_ROW)}>
          <TaskCell marks={<Station kind={mainKind} />} name={s.name} kind="main loop" />
          <RowCells
            family={s.modelFamily}
            model={s.model}
            effort={s.effort}
            contextPct={s.context.percent}
            blowouts={s.blowouts?.orchestrator ?? null}
            tokens={s.context.tokens}
            costUsd={orchestratorCostUsd(s)}
            costTitle={COST_HINT_ORCHESTRATOR}
            elapsedSec={sessionElapsedSec(s, now)}
            status={
              <span title={delegating(ORCHESTRATOR_ROW) ?? stateLine(s, now)}>
                <StationWord kind={mainKind} />
              </span>
            }
          />
        </button>
        {agentRows}
      </div>
    </section>
  );
}
