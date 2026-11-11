// The sidebar: the mark and the name over what it is and the server's version; the four views at the top, in their order and never moving: Fleet (how many need you and how
// many sessions are live, of those the sidebar lists: Background set aside as the Fleet sets it aside), History, Plans and
// Machines (how many problems its page lists, views/machines problemCount, and "+" for Add a machine). A view's link only opens
// its page. Under them, "× Show all machines" while the filter field holds an `m:` word, then the tree, the one part that
// scrolls; at the foot, Details.
// The tree: each machine with sessions to list, a chevron that folds its sessions away (remembered per browser) beside a button
// that selects the machine: its `m:` word in the field, the one selection, pressed again taken out (filter.ts withScope); it
// stays pressed wherever the word is in force. Under it its sessions by Project (the Fleet's own grouping, groups.ts), projects in
// the order of their names, sessions in the Fleet's sort. A project of one session is one row, "project · name"; a project of
// more gets a header that folds its sessions away, remembered per browser and never opened by anything but a press. A folded
// header keeps its counts and shows the worst state it hides. A name that is only its project's folder gives way to the
// session's branch. Then how many more machines the server knows, opening Machines. A session's row opens its page (the current
// row while it is open). An ended session keeps its row until it leaves, counted in no live count. Details (useDetails, the
// switch the Fleet's cards and List rows read too) gives each session row a second line (its model, plan and agents) or keeps it
// to one, remembered per browser, one line by default.
import { useId, useState, type ReactNode } from "react";
import { isKnownProvider, type RefusalView } from "../../../../server/src/fleet/protocol";
import { ADD_MACHINE_HASH, hashFor, VIEWS, type Route, type View } from "../../route";
import { BlowBadge, ContextBar, ModelChip } from "../components/Chips";
import { IconChevron, IconDetails, IconX, osLogo } from "../components/Icons";
import { fmtAge, fmtPct, plural } from "../format";
import { groupSessions, shortId } from "../groups";
import { planProgress, sessionCounts } from "../logic";
import { providerInfo } from "../provider";
import { liveCount, stateOf, STATE_WORD, type State } from "../states";
import { readJson, writeJson } from "../storage";
import type { FleetState } from "../store";
import { APP_KIND, APP_NAME, type SessionView } from "../types";
import { Dots } from "../ui/Dots";
import { MidCut } from "../ui/MidCut";
import { Station } from "../ui/Station";
import { Unknown } from "../ui/Unknown";
import { useDetails } from "../useDetails";
import { problemCount } from "../views/machines";
import { Mark } from "./Mark";

export const VIEW_LABELS: Record<View, string> = { now: "Fleet", history: "History", plans: "Plans", machines: "Machines", settings: "Settings" };

/** "3 need you", "1 needs you". */
export function needYouWords(n: number): string {
  return `${n} ${n === 1 ? "needs" : "need"} you`;
}

/** The needs-you mark and a count, the same wherever a count of waits shows. */
function NeedsCount({ n }: { n: number }) {
  return (
    <span className="ui-needs" title={needYouWords(n)}>
      <Station kind="needs-you" />
      <span aria-hidden="true">{n}</span>
      <span className="ui-vh">{`, ${needYouWords(n)}`}</span>
    </span>
  );
}

/** A machine with sessions the sidebar lists. */
export interface SidebarMachine {
  id: string;
  name: string;
  os: string | null;
  /** Another machine has the same name: the start of its id is shown. */
  shared: boolean;
  /** The filter word that scopes the console to it (filter.ts scopeTerm). */
  term: string;
  /** The sessions the sidebar lists (background ones set aside unless the Fleet shows them), in the Fleet's sort. */
  sessions: SessionView[];
}

const WARN = (
  <svg className="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M8 2.5 14 13H2zM8 6.5v3M8 11.25v.25" />
  </svg>
);

/** How many of these sessions need you: the count beside a machine or a project, and their sum beside Fleet. */
const waitsIn = (sessions: readonly SessionView[]): number => sessions.filter((s) => stateOf(s) === "needs-you").length;

/** The states worst first, needs you left out: the count beside a header already shows it. */
const WORST: readonly State[] = ["failed", "stuck", "working", "idle", "done"];

/** The state a folded machine or project shows beside its counts: the worst of its sessions (WORST); null when every one needs you. */
function worstOf(sessions: readonly SessionView[]): State | null {
  const states = new Set(sessions.map(stateOf));
  return WORST.find((st) => states.has(st)) ?? null;
}

// ---- projects -----------------------------------------------------------------------------------------------------------

/** A project of a machine's listed sessions, as the sidebar names it. */
interface SidebarProject {
  /** groups.ts's key, `p:<project>`. */
  key: string;
  /** Its last folder: `~/code/sitrep` is "sitrep". A worktree is a project of its own. "" when the project is not
   * reported: its header shows it as unknown, and its one session's row shows the session's name alone. */
  label: string;
  /** Its whole path, and its repository's name where that is not the label. */
  title: string;
  sessions: SessionView[];
}

/** A path's last folder; the path itself when it has none (`~`, `/`); "" for a project not reported. */
const lastFolder = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** groupSessions takes machine labels only for grouping by machine. */
const NO_LABELS: ReadonlyMap<string, string> = new Map();
const NO_PROJECT = "Project not reported";

/** A machine's listed sessions by project (the Fleet's Group by Project), in the order of the names shown; each project's sessions in the order given. */
function projectsOf(sessions: readonly SessionView[]): SidebarProject[] {
  return groupSessions(sessions, "project", NO_LABELS)
    .map((g) => {
      const label = lastFolder(g.name);
      const repo = g.sessions.find((s) => s.repoName)?.repoName ?? null;
      return { key: g.key, label, title: !g.name ? NO_PROJECT : repo && repo !== label ? `${g.name} · ${repo}` : g.name, sessions: g.sessions };
    })
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || (a.key < b.key ? -1 : 1));
}

/** A session's words in its row: its name, or its git branch where the name is only its project's folder, which says nothing the project does not. */
const rowName = (s: SessionView, project: string): string => (s.name === project && s.git?.branch ? s.git.branch : s.name);

// ---- remembered per browser ---------------------------------------------------------------------------------------------

/** The old sidebar's key, so the machines a browser folded then stay folded. */
const FOLD_KEY = "sidebar.folded";
/** Folds kept, newest first: a project folded and never seen again does not stay for ever. */
const FOLDS_KEPT = 200;

/** The machines (by id) and projects (`<machine id> <project key>`) whose sessions are folded away. */
function useFolded(): [ReadonlySet<string>, (key: string) => void] {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => {
    const saved = readJson<unknown>(FOLD_KEY, []);
    return new Set(Array.isArray(saved) ? saved.filter((v): v is string => typeof v === "string") : []);
  });
  const flip = (key: string) => {
    const next = new Set(folded);
    if (!next.delete(key)) next.add(key);
    setFolded(next);
    writeJson(FOLD_KEY, [...next].slice(-FOLDS_KEPT));
  };
  return [folded, flip];
}

// ---- rows ---------------------------------------------------------------------------------------------------------------

/** When a session began to need you: its oldest open ask, else its last event. */
function waitingSince(s: SessionView): number | null {
  const asked = s.asks.reduce((t, a) => (a.state === "closed" ? t : Math.min(t, a.openedAt)), Infinity);
  return asked < Infinity ? asked : s.lastActivityAt;
}

/**
 * A row's second line (Details): the model with its effort, the plan's steps done when it has steps (nothing in their place
 * when it has none), and its loops running of all. No plan bar: in the sidebar's width the figure says it, and the model keeps
 * its name. Under it, on a line of its own so it takes no room from the model's name, the context window's bar when its fill
 * is reported: the cards' bar, its percent in its title.
 */
function SecondLine({ s }: { s: SessionView }) {
  const plan = planProgress(s.plan);
  const loops = sessionCounts(s);
  const pct = s.context.percent;
  return (
    <>
      <SecondLineFacts s={s} plan={plan} loops={loops} />
      {pct === null ? null : (
        <div className="shell-sess-ctx" title={`Context ${fmtPct(pct)}`}>
          <ContextBar percent={pct} />
        </div>
      )}
    </>
  );
}

function SecondLineFacts({ s, plan, loops }: { s: SessionView; plan: ReturnType<typeof planProgress>; loops: ReturnType<typeof sessionCounts> }) {
  return (
    <div className="shell-sess-l2">
      {s.model === null && s.modelFamily === "other" && isKnownProvider(s.provider) ? <Unknown reason="Model not reported" /> : <ModelChip provider={s.provider} family={s.modelFamily} model={s.model} effort={s.effort} />}
      {plan ? (
        <>
          <span className="shell-sess-fig" title="Plan steps done">
            {`${plan.done}/${plan.total}`}
            <span className="ui-vh"> plan steps done</span>
          </span>
        </>
      ) : null}
      <span className="shell-sess-fig shell-sess-agents" title="Agents running / all, the main loop included">
        {`${loops.running}/${loops.all}`}
        <span className="ui-vh"> agents running</span>
      </span>
    </div>
  );
}

interface RowProps {
  s: SessionView;
  /** What the row calls it ("project · name" alone in its project, rowName under a project's header). */
  name: string;
  /** Under a project's header, one step further in. */
  nested: boolean;
  now: number;
  current: boolean;
  fresh: boolean;
  detailed: boolean;
}

/**
 * A session: its mark, name and harness, then how long it has waited on you or its auto-compacts. Detailed, the line also
 * keeps the auto-compacts while it waits, and a second line follows (SecondLine).
 */
function SessionRow({ s, name, nested, now, current, fresh, detailed }: RowProps) {
  const state = stateOf(s);
  const { Logo, name: harness } = providerInfo(s.provider);
  const since = state === "needs-you" ? waitingSince(s) : null;
  const head = (
    <>
      <Station kind={state} />
      <span className="shell-sess-name">
        <MidCut text={name} />
      </span>
      <span className="ui-vh">{`, ${STATE_WORD[state]}, ${harness}`}</span>
      <Logo className="shell-sess-logo" />
    </>
  );
  const clock =
    since !== null ? (
      <span className="shell-sess-clock" title={`Waiting ${fmtAge((now - since) / 1000)}`}>
        {fmtAge((now - since) / 1000)}
      </span>
    ) : null;
  const blowouts = <BlowBadge n={s.blowouts?.total ?? null} />;
  const cls = ["shell-sess", nested && "is-nested", detailed && "is-detailed", fresh && "ui-flash"].filter(Boolean).join(" ");
  return (
    <li className="shell-sess-slot">
      <a className={cls} href={hashFor("session", s.id)} aria-current={current ? "page" : undefined}>
        {detailed ? (
          <>
            <div className="shell-sess-l1">
              {head}
              {blowouts}
              {clock}
            </div>
            <SecondLine s={s} />
          </>
        ) : (
          <>
            {head}
            {clock ?? blowouts}
          </>
        )}
      </a>
    </li>
  );
}

/** How many need you and how many are live (an ended one not counted), at a header's right end; folded, the worst state it hides
 * comes first (worstOf). */
function Counts({ waits, live, worst = null }: { waits: number; live: number; worst?: State | null }) {
  return (
    <>
      {worst ? (
        <span className="shell-worst" title={`Worst: ${STATE_WORD[worst]}`}>
          <Station kind={worst} size={14} />
          <span className="ui-vh">{`, worst: ${STATE_WORD[worst]}`}</span>
        </span>
      ) : null}
      {waits > 0 ? <NeedsCount n={waits} /> : null}
      <span className="shell-mach-count" title={plural(live, "live session")}>
        {live}
        <span className="ui-vh"> live</span>
      </span>
    </>
  );
}

/** A machine: the chevron that folds its sessions away, beside the button that selects it (pressed while its word is in force). */
function MachineHead({ m, pressed, folded, listId, onFold, onPick }: { m: SidebarMachine; pressed: boolean; folded: boolean; listId: string; onFold: () => void; onPick: () => void }) {
  return (
    <div className={pressed ? "shell-mach-row is-on" : "shell-mach-row"}>
      <button type="button" className="shell-mach-fold" aria-expanded={!folded} aria-controls={listId} aria-label={`${folded ? "Show" : "Hide"} ${m.name}'s sessions`} onClick={onFold}>
        <IconChevron />
      </button>
      <button type="button" className="shell-mach" aria-pressed={pressed} title={pressed ? "Show all machines" : `Show only ${m.name}`} onClick={onPick}>
        <span className="shell-mach-os" title={m.os ?? undefined}>
          {osLogo(m.os)}
        </span>
        <span className="shell-mach-name">{m.name}</span>
        {m.shared ? <span className="shell-mach-id">{shortId(m.id)}</span> : null}
        <span className="ui-vh">{m.os ? `, ${m.os}` : ""}</span>
        <Counts waits={waitsIn(m.sessions)} live={liveCount(m.sessions)} worst={folded ? worstOf(m.sessions) : null} />
      </button>
    </div>
  );
}

/**
 * A project of two or more sessions: a header (its chevron in the sessions' mark column, its name in their names' column) that
 * folds them away, then its sessions one step further in.
 */
function ProjectGroup({ p, folded, onFold, children }: { p: SidebarProject; folded: boolean; onFold: () => void; children: ReactNode }) {
  const listId = useId();
  return (
    <li>
      <button type="button" className="shell-mach shell-proj" aria-expanded={!folded} aria-controls={listId} title={p.title} onClick={onFold}>
        <IconChevron />
        <span className="shell-mach-name">{p.label || <Unknown reason={NO_PROJECT} />}</span>
        <Counts waits={waitsIn(p.sessions)} live={liveCount(p.sessions)} worst={folded ? worstOf(p.sessions) : null} />
      </button>
      <ul className="shell-sessions" id={listId} hidden={folded} aria-label={p.label ? `${p.label}'s sessions` : `Sessions, ${NO_PROJECT.toLowerCase()}`}>
        {children}
      </ul>
    </li>
  );
}

// ---- the sidebar ---------------------------------------------------------------------------------------------------------

interface NavProps {
  id: string;
  hidden: boolean;
  route: Route;
  /** The session whose page is open: its row is the current one. */
  openSession: string | null;
  fleet: FleetState;
  now: number;
  /** Every live session and the refused reports, for the problems the Machines view lists. */
  live: readonly SessionView[];
  refusals: readonly RefusalView[];
  machines: SidebarMachine[];
  /** The machine selected: the filter's one `m:` word, or null. */
  scope: string | null;
  /** The filter narrows by machine (any `m:` word, filter.ts hasScope), whether or not a machine here answers to it. */
  scoped: boolean;
  /** "Show all machines", pressed: every `m:` word out of the filter. */
  onShowAll: () => void;
  /** A machine, pressed: its `m:` word (filter.ts scopeTerm) in or out. */
  onMachine: (term: string) => void;
  onHide: () => void;
  /** A session that arrived a moment ago: its row flashes once. */
  isNew: (id: string) => boolean;
}

export function Nav(props: NavProps) {
  const { id, route, machines, scope } = props;
  const [detailed, setDetailed] = useDetails();
  const [folded, flipFolded] = useFolded();
  // Counts before the first snapshot would be zeros for what is not known yet: Fleet's wait for it.
  const loaded = props.fleet.server !== null;
  const problems = problemCount(props.fleet.machines, props.live, props.refusals, props.fleet.serverTime);
  const listed = new Set(machines.map((m) => m.id));
  const more = props.fleet.machines.filter((m) => !listed.has(m.id)).length;
  const row = (s: SessionView, name: string, nested: boolean) => (
    <SessionRow key={s.id} s={s} name={name} nested={nested} now={props.now} current={props.openSession === s.id} fresh={props.isNew(s.id)} detailed={detailed} />
  );
  const badge: Partial<Record<View, ReactNode>> = {
    // The sums of the machines' counts, so the column always adds up.
    now: loaded ? <Counts waits={machines.reduce((n, m) => n + waitsIn(m.sessions), 0)} live={machines.reduce((n, m) => n + liveCount(m.sessions), 0)} /> : null,
    machines:
      problems > 0 ? (
        <span className="shell-badge" title={plural(problems, "problem")}>
          {WARN}
          <span aria-hidden="true">{problems}</span>
          <span className="ui-vh">{`, ${plural(problems, "problem")}`}</span>
        </span>
      ) : null,
  };
  return (
    <nav className="shell-rail" id={id} hidden={props.hidden} aria-label="Views and machines">
      <div className="shell-brand">
        <a className="shell-brand-link" href={hashFor("now")}>
          <Mark />
          <span className="shell-brand-text">
            <span className="shell-brand-name">{APP_NAME}</span>
            {/* What it is, and the server's version once the first snapshot says it. */}
            <Dots className="shell-brand-kind is-oneline" items={[APP_KIND, props.fleet.server ? `v${props.fleet.server.version}` : null]} />
          </span>
        </a>
        <button type="button" className="ui-button ui-button--icon" aria-label="Hide the sidebar" title="Hide the sidebar ([)" aria-controls={id} aria-expanded="true" onClick={props.onHide}>
          <IconChevron className="shell-chev-left" />
        </button>
      </div>
      <ul className="shell-list" aria-label="Views">
        {VIEWS.map((v) => (
          <li key={v} className="shell-view">
            <a className="shell-item" href={hashFor(v)} aria-current={route === v ? "page" : undefined}>
              <span className="shell-item-name">{VIEW_LABELS[v]}</span>
              {badge[v]}
            </a>
            {v === "machines" ? (
              <a className="ui-button ui-button--icon shell-add" href={ADD_MACHINE_HASH} aria-label="Add a machine" title="Add a machine">
                <svg className="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M8 3v10M3 8h10" />
                </svg>
              </a>
            ) : null}
          </li>
        ))}
      </ul>
      {/* Outside the tree, so it stays in view however far the tree scrolls. */}
      {props.scoped ? (
        <button type="button" className="shell-mach shell-all" onClick={props.onShowAll}>
          <IconX />
          Show all machines
        </button>
      ) : null}
      <div className="shell-tree">
        <ul className="shell-list shell-machines" aria-label="Machines with live sessions">
          {machines.map((m) => {
            const listId = `${id}-m-${m.id}`;
            const isFolded = folded.has(m.id);
            return (
              <li key={m.id}>
                <MachineHead m={m} pressed={m.term === scope} folded={isFolded} listId={listId} onFold={() => flipFolded(m.id)} onPick={() => props.onMachine(m.term)} />
                <ul className="shell-sessions" id={listId} hidden={isFolded} aria-label={`${m.name}'s sessions`}>
                  {projectsOf(m.sessions).map((p) => {
                    if (p.sessions.length === 1) {
                      const s = p.sessions[0]!;
                      const name = rowName(s, p.label);
                      return row(s, !p.label || name === p.label ? name : `${p.label} · ${name}`, false);
                    }
                    const key = `${m.id} ${p.key}`;
                    return (
                      <ProjectGroup key={p.key} p={p} folded={folded.has(key)} onFold={() => flipFolded(key)}>
                        {p.sessions.map((s) => row(s, rowName(s, p.label), true))}
                      </ProjectGroup>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
        {more > 0 ? (
          <a className="shell-quiet" href={hashFor("machines")}>
            {`${plural(more, "more machine")} →`}
          </a>
        ) : null}
      </div>
      <footer className="shell-foot">
        <button type="button" className="shell-detail" aria-pressed={detailed} aria-label="Details" title="Details: more on each session, here, on its card and on its List row" onClick={() => setDetailed(!detailed)}>
          <IconDetails />
        </button>
      </footer>
    </nav>
  );
}
