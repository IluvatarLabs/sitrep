// One agent's detail: its failure and blowouts, its task prompt and final answer, its facts, the tool it is on and the tools
// and skills it used, its live activity, and the agents it launched. `AgentDetailBody` is the content the inspector shows in
// its pane (300 px by default, resizable) when an agent is picked anywhere; `stored`: the agent of a stored session (History),
// whose feed is not fetched. The fact rows are shared with the main loop's own detail.
import { useState, type ReactNode } from "react";
import { fmtSpan, fmtTok, fmtUsd, plural } from "../format";
import { agentElapsedSec, branchTotals, COST_HINT_AGENT, familyName, parentOf, TOKENS_HINT } from "../logic";
import type { AgentView, SessionView } from "../types";
import { Unknown } from "../ui/Unknown";
import { Dots, dotsText } from "../ui/Dots";
import { ContextMeter, Usd } from "../views/session/bits";
import "../views/session/session.css";
import { ActivityFeed } from "./ActivityFeed";
import { BlowoutBox } from "./BlowoutBox";
import { FailureBox } from "./FailureBox";
import { ReportDocs } from "./ReportDocs";

const TOOL_CHIPS_SHOWN = 5;

/** One fact in a detail's list: its term, then its value. */
export function Pair({ term, termTitle, cls, title, children }: { term: string; termTitle?: string; cls?: string; title?: string; children: ReactNode }) {
  return (
    <>
      <dt title={termTitle}>{term}</dt>
      <dd className={cls} title={title}>
        {children}
      </dd>
    </>
  );
}

/** Tools a loop used, most used first (ties by name): the five most used unless expanded, the last one used marked. None, no part. */
export function ToolChips({ counts, calls, lastTool }: { counts: Record<string, number>; calls: number; lastTool: string | null }) {
  const [all, setAll] = useState(false);
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (ranked.length === 0) return null;
  const shown = all ? ranked : ranked.slice(0, TOOL_CHIPS_SHOWN);
  const lastHidden = lastTool !== null && ranked.some(([name]) => name === lastTool) && !shown.some(([name]) => name === lastTool);
  const moreButton =
    ranked.length > TOOL_CHIPS_SHOWN ? (
      <button type="button" className="sv-link" aria-expanded={all} onClick={() => setAll(!all)}>
        {all ? "Show fewer" : `Show all ${ranked.length}`}
      </button>
    ) : null;
  const chips = shown.map(([name, n]) => {
    const latest = name === lastTool;
    return (
      <li key={name} className={latest ? "latest" : undefined}>
        <span className="sv-mono">{name}</span> <span className="sv-num">{n}</span>
        {latest && <span className="ag-last"> last used</span>}
      </li>
    );
  });
  return (
    <div className="ag-part">
      <h4>
        Tools <span className="sv-muted sv-num">{plural(calls, "call")}</span>
      </h4>
      <ul className="ag-tools">{chips}</ul>
      {moreButton}
      {lastHidden ? <p className="sv-muted">Last used: {lastTool}</p> : null}
    </div>
  );
}

/** The skills a loop loaded; none, no part. */
export function SkillChips({ skills }: { skills: string[] }) {
  if (skills.length === 0) return null;
  return (
    <div className="ag-part">
      <h4>Skills</h4>
      <ul className="ag-tools">
        {skills.map((skill) => (
          <li key={skill}>
            <span className="sv-mono">{skill}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** An agent's kind as a word, and what it starts from on hover. */
const KIND_WORDS: Record<AgentView["kind"], [string, string]> = {
  fork: ["Fork", "Starts with its parent's context"],
  teammate: ["Teammate", "A named agent of the session's team"],
  subagent: ["Agent", "Starts from a blank slate"],
};

/** Who launched the agent: a button to that agent, or words when it is the main loop or no longer listed. */
function LaunchedBy({ s, a, onAgent }: { s: SessionView; a: AgentView; onAgent: (id: string) => void }) {
  const parent = parentOf(s.agents, a);
  if (parent) {
    return (
      <button type="button" className="sv-link" onClick={() => onAgent(parent.id)}>
        {parent.description}
      </button>
    );
  }
  return <>{a.parentId && a.parentId !== a.id ? "an agent no longer listed" : "the main loop"}</>;
}

/** This agent with every agent under it, at every level: their cost and context, and how many. */
function BranchValue({ branch }: { branch: NonNullable<ReturnType<typeof branchTotals>> }) {
  const agentsWord = plural(branch.agents, "agent");
  return (
    <>
      <Dots
        items={[
          // Every agent of the branch, itself included, without a price: its cost is unknown, not zero.
          branch.unpriced > branch.agents ? <Unknown key="c" reason="Not priced" /> : fmtUsd(branch.costUsd),
          branch.tokens === null ? (
            <span key="t">
              <Unknown reason="Not reported" /> tokens
            </span>
          ) : (
            `${fmtTok(branch.tokens)} tokens`
          ),
          <span key="n" className="sv-muted">
            {agentsWord}
          </span>,
          branch.unpriced ? (
            <span key="u" className="sv-muted">
              {`${branch.unpriced} not priced`}
            </span>
          ) : null,
        ]}
      />
    </>
  );
}

/** The tool a loop is on: its open call, else the last one it used. */
export function CurrentTool({ tool, open, calls }: { tool: string | null; open: boolean; calls: number }) {
  if (tool === null) return <Unknown reason="No tool call seen yet" />;
  return (
    <>
      <Dots
        items={[
          <span key="t">
            <span className="sv-mono">{tool}</span> <span className="sv-muted">{open ? "running now" : "last used"}</span>
          </span>,
          open ? null : (
            <span key="n" className="sv-muted">
              {plural(calls, "call")}
            </span>
          ),
        ]}
      />
    </>
  );
}

/** Where an agent's model and effort come from, on their terms. */
const MODEL_SOURCE = "From the launch and the model requests seen since; a fork's effort is its parent's.";

/** Everything about one agent below its name: what the inspector shows for a picked agent. */
export function AgentDetailBody({ s, a, now, onAgent, feedOn, stored = false }: { s: SessionView; a: AgentView; now: number; onAgent: (id: string) => void; feedOn: boolean; stored?: boolean }) {
  const children = s.agents.filter((x) => x.parentId === a.id && x.id !== a.id);
  const branch = children.length ? branchTotals(s.agents, a.id) : null;
  const isFork = a.kind === "fork";
  const [kindWord, kindNote] = KIND_WORDS[a.kind];
  const inherited = <span className="sv-muted"> inherited</span>;
  // A fork's effort always matches its parent's; otherwise the effort says where the value came from, when known.
  const effortSource = isFork || a.effortSource === "inherited" ? inherited : a.effortSource !== "unknown" ? <span className="sv-muted">{` ${a.effortSource}`}</span> : null;
  // The noun follows the last figure said: "1 model request", "3 model requests", "1/4 model requests".
  const steps = a.steps ? `${a.steps.done}${a.steps.total === null ? "" : `/${a.steps.total}`} ${(a.steps.total ?? a.steps.done) === 1 ? "model request" : "model requests"}` : null;

  return (
    <>
      {a.failure ? <FailureBox failure={a.failure} /> : null}
      <BlowoutBox a={a} entries={s.blowouts?.log ?? []} />
      <ReportDocs s={s} a={a} />
      <dl className="ag-facts">
        <Pair term="Session">{s.name}</Pair>
        <Pair term="Parent">
          <LaunchedBy s={s} a={a} onAgent={onAgent} />
        </Pair>
        <Pair term="Kind" title={kindNote}>
          {kindWord}
        </Pair>
        <Pair term="Type" cls="sv-mono">
          {a.type}
        </Pair>
        {a.name ? (
          <Pair term="Name" cls="sv-mono">
            {a.name}
          </Pair>
        ) : null}
        <Pair term="Model" termTitle={MODEL_SOURCE}>
          <span title={a.model ?? undefined}>{familyName(a.modelFamily, a.model)}</span>
          {isFork && inherited}
        </Pair>
        <Pair term="Effort" termTitle={MODEL_SOURCE}>
          {a.effort ?? <Unknown reason="Effort is not reported" />}
          {effortSource}
        </Pair>
        <Pair term="Current tool">
          <CurrentTool tool={a.lastTool} open={a.toolOpen} calls={a.toolCalls} />
        </Pair>
        <Pair term="Context">
          <ContextMeter percent={a.context.percent} blowouts={a.blowouts} wide />
        </Pair>
        <Pair term="Tokens" termTitle={TOKENS_HINT} cls="sv-num" title={TOKENS_HINT}>
          {a.context.tokens === null ? <Unknown reason="Not reported" /> : fmtTok(a.context.tokens)}
        </Pair>
        <Pair term="Usage" cls="sv-num" title="Every model request summed, cache reads included">
          {a.tokens === null ? (
            <Unknown reason="Usage not reported" />
          ) : (
            <Dots items={[`${fmtTok(a.tokens.input)} in`, `${fmtTok(a.tokens.output)} out`, `${fmtTok(a.tokens.cacheRead)} cache read`, `${fmtTok(a.tokens.cacheWrite)} cache write`]} />
          )}
        </Pair>
        <Pair term="Est. cost" cls="sv-num" title={COST_HINT_AGENT}>
          <Usd usd={a.costUsdEst} /> <span className="sv-muted">its own</span>
        </Pair>
        {branch ? (
          <Pair term="Tree total" cls="sv-num" title="This agent and every agent under it, each counted once">
            <BranchValue branch={branch} />
          </Pair>
        ) : null}
        <Pair term="Time" cls="sv-num">
          {fmtSpan(agentElapsedSec(a, now))}
        </Pair>
        <Pair term="Steps" cls="sv-num">
          {steps ?? <Unknown reason="Not reported" />}
        </Pair>
      </dl>
      {a.toolCounts === null ? null : <ToolChips key={a.id} calls={a.toolCalls} counts={a.toolCounts} lastTool={a.lastTool} />}
      <SkillChips skills={a.skills} />
      <ActivityFeed key={`${s.id}:${a.id}:activity`} s={s} loop={a.id} title={dotsText([a.description, a.type])} startedAt={a.startedAt} active={a.status === "running" || a.status === "queued"} serverOn={feedOn} stored={stored} />
      {children.length > 0 && (
        <div className="ag-part">
          <h4>Agents it launched</h4>
          <ul className="ag-kids">
            {children.map((child) => (
              <li key={child.id}>
                <button type="button" className="sv-link" onClick={() => onAgent(child.id)}>
                  {child.description}
                </button>
                <span className="sv-muted">{` ${child.kind === "fork" ? "fork" : child.type}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
