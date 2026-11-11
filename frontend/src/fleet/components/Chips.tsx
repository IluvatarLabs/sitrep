// The small shared pieces: the model chip with its effort word and bars, a cost, the auto-compact badge, the git line, the
// context and plan bars, and an agent's square. Styles: chips.css; logos: ui.css. A state is drawn by ui/Station, its colour by
// stationColor.
import type { CSSProperties, HTMLAttributes } from "react";
import { EFFORTS, isKnownProvider, type Effort } from "../../../../server/src/fleet/protocol";
import { COST_PARTIAL_WHY, fmtCost, fmtPct, plural } from "../format";
import { familyName } from "../logic";
import { providerInfo, surfaceLabel } from "../provider";
import type { AgentView, ModelFamily, ProviderName, SessionView } from "../types";
import { Dots } from "../ui/Dots";
import { MidCut } from "../ui/MidCut";
import { stationColor } from "../ui/Station";
import { Unknown } from "../ui/Unknown";
import "./chips.css";
import { IconBranch, IconCompact, IconDown, IconTree, IconUp } from "./Icons";

/** Sets `--c`, the colour a dot's, a square's or a bar's CSS reads. */
export function cssVar(color: string): CSSProperties {
  return { ["--c" as string]: color };
}

/** Why a session's cost is unknown, from the server (SessionView.costReason). */
function noCost(s: Pick<SessionView, "costReason" | "model">): string {
  if (s.costReason === "unpriced") return `No price for ${s.model ?? "this model"}`;
  return s.costReason === "pending" ? "No usage yet" : "Not reported";
}

/**
 * A session's cost, or "—" with the server's reason. Never an amount made up: one that leaves out usage on a model with no price
 * reads "$817+", the reason its title (format fmtCost).
 */
export function Cost({ s }: { s: Pick<SessionView, "costUsd" | "costReason" | "costPartial" | "model"> }) {
  if (s.costUsd === null) return <Unknown reason={noCost(s)} />;
  if (!s.costPartial) return <>{fmtCost(s.costUsd, false)}</>;
  return (
    <span title={COST_PARTIAL_WHY}>
      {fmtCost(s.costUsd, true)}
      <span className="ui-vh">{` (${COST_PARTIAL_WHY})`}</span>
    </span>
  );
}

/** Codex's effort words on the same five steps as Claude's: minimal shares low's, ultra is its top step as max is Claude's. */
const CODEX_STEPS: Record<string, number> = { minimal: 1, ultra: 5 };

/** An effort's step, 1 (low) to 5 (max); 0 for none or a word on neither scale. */
export function effortLevel(effort: string): number {
  const e = effort.toLowerCase();
  return EFFORTS.indexOf(e as Effort) + 1 || CODEX_STEPS[e] || 0;
}

/**
 * A loop's effort as five bars filled to its step, in the step's colour (chips.css). Nothing for "none" or an unknown word: its
 * word says it. Decorative: the effort word beside the bars says the same.
 */
function EffortBars({ effort }: { effort: string }) {
  const filled = effortLevel(effort);
  if (filled === 0) return null;
  return (
    <span className="eff" data-level={filled} aria-hidden="true">
      {EFFORTS.map((level, i) => (
        <i key={level} className={i < filled ? "on" : undefined} />
      ))}
    </span>
  );
}

/**
 * A harness's name, shown after its logo where the logo is not its own (provider providerInfo: our generic glyph, "[▭] hermes").
 * For Claude and Codex, whose logos say it, nothing; or with `spoken`, where no other words name the harness, the name for
 * assistive technology only, as the state bar names its plan windows. The model chip and the wall view draw it.
 */
export function HarnessName({ provider, spoken = false }: { provider: ProviderName; spoken?: boolean }) {
  const { name } = providerInfo(provider);
  if (!isKnownProvider(provider)) return <span className="chip-harness">{name}</span>;
  return spoken ? <span className="ui-vh">{` ${name} `}</span> : null;
}

/**
 * "[logo] Opus 5.5 high ▮▮▮▯▯": the harness's logo, the model by its harness's own name, then the effort word as Codex's status
 * line prints it ("gpt-5.2-codex medium"), then its bars (EffortBars). The model id is the title. Nothing in the effort's place
 * when it is not reported (a stored session keeps none). A harness with no logo of its own (provider providerInfo) is named
 * after the generic glyph, "[▭] hermes Sonnet 5.5", and with no model reported the chip is that name alone.
 */
export function ModelChip({ provider, family, model, effort = null }: { provider: ProviderName; family: ModelFamily; model: string | null; effort?: string | null }) {
  const known = isKnownProvider(provider);
  const { Logo, name } = providerInfo(provider);
  const modelShown = known || model !== null || family !== "other";
  return (
    <span className="chip" title={model ?? (known ? undefined : name)}>
      <Logo />
      <HarnessName provider={provider} />
      {modelShown ? <span className="chip-name">{familyName(family, model)}</span> : null}
      {effort ? (
        <>
          <span className="eff-word">{effort}</span>
          <EffortBars effort={effort} />
        </>
      ) : null}
    </span>
  );
}

/**
 * Where a session runs ("Desktop", "headless", "via Claude Code"; provider surfaceLabel) as a tag chip, its title saying what
 * the word means; nothing for a terminal or an unknown surface.
 */
export function SurfaceChip({ surface }: { surface: string | null }) {
  const label = surfaceLabel(surface);
  return label === null ? null : (
    <span className="chip surface" title={`Where it runs: ${label}, not a terminal`}>
      {label}
    </span>
  );
}

/**
 * "⟲2": auto-compacts, in ink at any count or level (neutral, never a problem: a long session compacts as it runs). Nothing for
 * none or unknown.
 */
export function BlowBadge({ n }: { n: number | null }) {
  if (!n) return null;
  return (
    <span className="blow" title={`Auto-compacted ${plural(n, "time")}`}>
      <IconCompact />
      <span aria-hidden="true">{n}</span>
      <span className="ui-vh">{plural(n, "auto-compact")}</span>
    </span>
  );
}

/** What a session's changed files are counted from (FilesReport.since). */
const LINES_SINCE: Record<NonNullable<SessionView["files"]>["since"], string> = {
  start: "since the session started",
  upstream: "since the branch's upstream",
  worktree: "in the working tree",
};

/**
 * The branch (cut in the middle) and a worktree's tag; then ahead and behind origin and the lines the session changed ("+12 −3",
 * from its changed files), as one line that ends in "…" when it has no room. The main checkout, a clean tree and a count of
 * modified files say nothing; no lines changed, or none reported, neither. Nothing without git.
 */
export function GitLine({ git, files }: { git: SessionView["git"]; files: SessionView["files"] }) {
  if (!git) return null;
  const changed = files !== null && files.added + files.removed > 0 ? files : null;
  const branch = git.branch ?? "unknown";
  const tree = git.worktreePath?.split("/").filter(Boolean).pop() ?? null;
  const drift = [
    { n: git.ahead, word: "ahead", title: "Ahead of origin", Icon: IconUp },
    { n: git.behind, word: "behind", title: "Behind origin", Icon: IconDown },
  ].filter((d) => d.n > 0);
  return (
    <div className="git">
      <span className="br">
        <IconBranch />
        {git.detached ? (
          <span>
            {branch}
            <span className="br-detached"> (detached)</span>
          </span>
        ) : (
          <MidCut text={branch} />
        )}
      </span>
      {git.isWorktree ? (
        <span className="wt" title={git.worktreePath ?? undefined}>
          <IconTree />
          <span className="wtn">{tree ? <Dots className="is-oneline" items={["worktree", tree]} /> : "worktree"}</span>
        </span>
      ) : null}
      <span className="git-facts">
        {drift.map(({ n, word, title, Icon }) => (
          <span key={word} title={title}>
            <Icon />
            {n}
            <span className="ui-vh">{` ${word}`}</span>
          </span>
        ))}
        {changed ? (
          <span className="lines" title={`Lines added and removed ${LINES_SINCE[changed.since]}, in ${plural(changed.total, "file")}`}>
            <span className="add">{`+${changed.added}`}</span>
            <span className="del">{`−${changed.removed}`}</span>
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** A bar filled to `pct` (0 to 100); the fill is the working colour unless chips.css says otherwise for its class. */
function Bar({ pct, className, ...rest }: { pct: number; className: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`bar ${className}`} {...rest}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A context window's fill as a figure, "47%", or "—" with why when the harness does not report it. */
export function ContextFigure({ percent }: { percent: number | null }) {
  return percent === null ? <Unknown reason="Context window not reported" /> : <>{fmtPct(percent)}</>;
}

/** A context window's level: "hot" (orange) from 75 %, "crit" (red) from 80 %; null below. */
export const contextLevel = (pct: number): "hot" | "crit" | null => (Math.round(pct) >= 80 ? "crit" : pct >= 75 ? "hot" : null);

/**
 * A context window's fill at its true ratio, its level in its name and its colour: orange from 75 % ("high"), red from 80 % ("nearly full"; a full
 * window is auto-compacted, it does not fail). Auto-compacts do not colour it.
 */
export function ContextBar({ percent, width }: { percent: number | null; width?: number }) {
  const pct = Math.min(100, Math.max(0, percent ?? 0));
  const level = contextLevel(pct);
  const words = level === "crit" ? ", nearly full" : level === "hot" ? ", high" : "";
  return (
    <Bar
      pct={pct}
      className={["ctx", level].filter(Boolean).join(" ")}
      style={width ? { width } : undefined}
      role="img"
      aria-label={percent === null ? "Context unknown" : `Context ${Math.round(pct)}%${words}`}
      title={percent === null ? "Context not reported" : undefined}
    />
  );
}

/** A plan's share of steps done (0 to 1). Decorative: the count beside it says the same. */
export const PlanBar = ({ pct }: { pct: number }) => <Bar pct={Math.round(pct * 100)} className="plan" aria-hidden="true" />;

/**
 * An agent's square, filled by its state: a circle for a fork, dashed while queued, stuck's orange (still, not pulsing) while it
 * runs stuck, red once it failed, grey once it ended.
 */
export function AgentSquare({ a, title, hidden }: { a: AgentView; title?: string; hidden?: boolean }) {
  const look = a.stuck ? "stuck" : a.status === "aborted" ? "done" : a.status;
  return <span className={a.kind === "fork" ? `a ${look} fork` : `a ${look}`} style={cssVar(stationColor(a.stuck ? "stuck" : a.status))} title={title} aria-hidden={hidden || undefined} />;
}
