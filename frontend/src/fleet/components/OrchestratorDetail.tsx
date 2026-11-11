// The main loop's own detail: its notes, its facts, the tool it is on, the tools and skills it used, git, and its live
// activity, with runs of file edits folded. Steps, tools and skills come from the report's main-loop block and are the main
// loop's own, not its agents'. `OrchestratorDetailBody` is the content, laid out for the inspector's pane (300 px by default)
// as an agent's detail is; `stored`: a stored session (History), whose feed is not fetched.
import { fmtSpan, fmtTok, plural } from "../format";
import { COST_HINT_ORCHESTRATOR, familyName, ORCHESTRATOR_ROW, orchestratorCostUsd, sessionElapsedSec, TOKENS_HINT } from "../logic";
import type { SessionView } from "../types";
import { Unknown } from "../ui/Unknown";
import { dotsText } from "../ui/Dots";
import { ContextMeter, Usd } from "../views/session/bits";
import { GitFacts } from "../views/session/GitFacts";
import "../views/session/session.css";
import { ActivityFeed } from "./ActivityFeed";
import { CurrentTool, Pair, SkillChips, ToolChips } from "./AgentDetail";
import { HOOKS_OFF_NOTE, hooksOffText, versionNote } from "./SessionCard";

/** What the main loop's own figures leave out. */
const OWN_ONLY = "The main loop's own, not its agents'.";

export function OrchestratorDetailBody({ s, now, feedOn, stored = false }: { s: SessionView; now: number; feedOn: boolean; stored?: boolean }) {
  const reporterNote = versionNote(s);
  const loop = s.loop;
  const mainBlowouts = s.blowouts?.orchestrator ?? null;
  return (
    <>
      {s.hooksActive === false ? (
        <p className="ag-note warn" title={HOOKS_OFF_NOTE}>
          {hooksOffText(s)}
        </p>
      ) : null}
      {reporterNote ? (
        <p className="ag-note warn" title={reporterNote.text}>
          {`Reporter ${reporterNote.label}`}
        </p>
      ) : null}
      <dl className="ag-facts">
        <Pair term="Role">Main loop</Pair>
        <Pair term="Model">
          <span title={s.model ?? undefined}>{familyName(s.modelFamily, s.model)}</span>
        </Pair>
        <Pair term="Effort">{s.effort ?? <Unknown reason="Effort is not reported" />}</Pair>
        <Pair term="Current tool">{loop ? <CurrentTool tool={loop.lastTool} open={s.toolOpen} calls={loop.toolCalls} /> : <Unknown reason="Not reported" />}</Pair>
        <Pair term="Context">
          <ContextMeter percent={s.context.percent} blowouts={mainBlowouts} wide />
        </Pair>
        <Pair term="Tokens" termTitle={TOKENS_HINT} cls="sv-num" title={TOKENS_HINT}>
          {s.context.tokens === null ? <Unknown reason="Not reported" /> : fmtTok(s.context.tokens)}
        </Pair>
        <Pair term="Est. cost" termTitle={COST_HINT_ORCHESTRATOR} cls="sv-num" title={COST_HINT_ORCHESTRATOR}>
          <Usd usd={orchestratorCostUsd(s)} /> <span className="sv-muted">its own share</span>
        </Pair>
        <Pair term="Time" cls="sv-num">
          {fmtSpan(sessionElapsedSec(s, now))}
        </Pair>
        {loop ? (
          <Pair term="Steps" termTitle={OWN_ONLY} cls="sv-num">
            {plural(loop.steps.done, "model request")}
          </Pair>
        ) : null}
        <Pair term="Git">
          <GitFacts git={s.git} />
        </Pair>
      </dl>
      {loop ? <ToolChips key={s.id} counts={loop.toolCounts} calls={loop.toolCalls} lastTool={loop.lastTool} /> : null}
      {loop ? <SkillChips skills={loop.skills} /> : null}
      <ActivityFeed key={`${s.id}:activity`} s={s} loop={ORCHESTRATOR_ROW} title={dotsText([s.name, "main loop"])} startedAt={s.startedAt} active={s.status !== "done"} isMain serverOn={feedOn} foldEdits stored={stored} />
    </>
  );
}
