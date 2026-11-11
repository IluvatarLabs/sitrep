// The top bar's filter field. Plain words are one phrase matched against a session's name, project, branch and machine
// (logic.ts filterSessions). A word with a prefix narrows one field: `s:` state, `m:` machine, `p:` project, `h:` harness; every
// prefixed word must match, and a prefix with nothing after it yet narrows nothing. `m:` is also the machine the sidebar selects
// (scopeTerm, withScope): a machine's whole name picks that machine alone, a part of a name every machine it is in, and the start
// of an id the machine it begins. `s:` is also what the Fleet's state chips write (withState). The field shows only on the pages
// that apply every word (FILTERED_ROUTES). Pure.
import type { Route } from "../../route";
import { shortId } from "../groups";
import { filterSessions, type StatusFilter } from "../logic";
import { providerInfo } from "../provider";
import { stateOf, STATE_WORD, type State } from "../states";
import type { MachineView, SessionView } from "../types";

export type FilterField = "s" | "m" | "p" | "h";

/** What each prefix narrows, for the field's hint. */
export const FILTER_FIELDS: Record<FilterField, string> = { s: "state", m: "machine", p: "project", h: "harness" };

type Term = { field: FilterField; value: string };

const PREFIXED = /^([smph]):(.*)$/;

/** The field's words: the plain ones as one phrase, and the prefixed ones. */
function parse(q: string): { phrase: string; terms: Term[] } {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const terms = words.flatMap((w): Term[] => {
    const m = PREFIXED.exec(w);
    return m?.[2] ? [{ field: m[1] as FilterField, value: m[2] }] : [];
  });
  return { phrase: words.filter((w) => !PREFIXED.test(w)).join(" "), terms };
}

/** Whether a state answers to an `s:` value: its word ("needs you", "idle") or its key ("needs-you") begins with it. */
const stateAnswers = (state: State, value: string): boolean => STATE_WORD[state].toLowerCase().startsWith(value) || state.startsWith(value);

/** Whether an `m:` value picks this machine: a whole machine name that alone, a part of one every machine it is in, or the start
 * of its id. `wholeNames` holds the lower-cased names of the machines in view. */
export function machineMatches(machine: { id: string; name: string }, value: string, wholeNames: ReadonlySet<string>): boolean {
  const name = machine.name.toLowerCase();
  return (wholeNames.has(value) ? name === value : name.includes(value)) || machine.id.toLowerCase().startsWith(value);
}

function matches(s: SessionView, { field, value }: Term, wholeNames: ReadonlySet<string>): boolean {
  switch (field) {
    case "s":
      return stateAnswers(stateOf(s), value);
    case "m":
      return machineMatches(s.machine, value, wholeNames);
    case "p":
      return s.project.toLowerCase().includes(value) || (s.repoName ?? "").toLowerCase().includes(value);
    case "h":
      return s.provider.includes(value) || providerInfo(s.provider).app.toLowerCase().includes(value);
  }
}

/**
 * The pages that apply the field: FleetApp hands every view the filtered sessions, and only the Fleet and Plans read them
 * (History and Machines apply only its `m:` word, scopedMachines; Settings nothing; a session's page is one session), which is
 * why the field shows only there. Elsewhere the top bar keeps the field's place with the field unseen, its words kept.
 */
export const FILTERED_ROUTES: ReadonlySet<Route> = new Set<Route>(["now", "plans"]);

/** The sessions the field lets through, in the order given. */
export function applyFilter(list: readonly SessionView[], q: string): SessionView[] {
  const { phrase, terms } = parse(q);
  const wholeNames = new Set(list.map((s) => s.machine.name.toLowerCase()));
  const narrowed = terms.length > 0 ? list.filter((s) => terms.every((t) => matches(s, t, wholeNames))) : list;
  return filterSessions(narrowed, { status: "all", q: phrase });
}

/**
 * The `m:` word that picks one machine: its name, or the start of its id where another machine has the same name or the name
 * has a space in it (a word of the field cannot).
 */
export function scopeTerm(machine: { id: string; name: string }, nameShared: boolean): string {
  return `m:${nameShared || /\s/.test(machine.name) ? shortId(machine.id) : machine.name}`.toLowerCase();
}

/** The machines an `m:` word picks, by the Fleet's own rule (machineMatches, with the live sessions' machines as the names in view). */
export function scopedMachines(scope: string, machines: readonly MachineView[], live: readonly SessionView[]): MachineView[] {
  const value = scope.slice("m:".length);
  const wholeNames = new Set(live.map((s) => s.machine.name.toLowerCase()));
  return machines.filter((m) => machineMatches(m, value, wholeNames));
}

/**
 * The field's words with `term` as its only `m:` word, or without any `m:` word when `term` is already the one in force: a
 * machine pressed in the sidebar or on the Graph, a toggle.
 */
export function withScope(q: string, term: string): string {
  const words = q.trim().split(/\s+/).filter(Boolean);
  const others = words.filter((w) => !/^m:/i.test(w));
  const already = words.some((w) => w.toLowerCase() === term) && others.length === words.length - 1;
  return [...others, ...(already ? [] : [term])].join(" ");
}

/** Whether the field narrows by machine: it has an `m:` word with something after it (a bare `m:` narrows nothing). */
export const hasScope = (q: string): boolean => q.trim().split(/\s+/).some((w) => /^m:./i.test(w));

/** The field's words without any word of `field`, the rest as they were. */
const without = (q: string, field: FilterField): string =>
  q
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "" && !w.toLowerCase().startsWith(`${field}:`))
    .join(" ");

/** The field's words without any `m:` word: what "Show all machines" leaves. */
export const withoutScope = (q: string): string => without(q, "m");

/** The field's words without any `s:` word: what the state chips count, each its state among the rest of the field's narrowing. */
export const withoutState = (q: string): string => without(q, "s");

/** The state chip the field presses: All with no `s:` word, else the state every `s:` word picks (stateAnswers); null for none. */
export function stateIn(q: string): StatusFilter | null {
  const values = parse(q).terms.flatMap((t) => (t.field === "s" ? [t.value] : []));
  if (values.length === 0) return "all";
  return (Object.keys(STATE_WORD) as State[]).find((state) => values.every((v) => stateAnswers(state, v))) ?? null;
}

/**
 * The field after a state chip is pressed, as an issue tracker's filters write qualifiers into its query: `s:<state>` as its only
 * `s:` word, or none for All and for the chip the field already presses.
 */
export function withState(q: string, state: StatusFilter): string {
  const rest = withoutState(q);
  return state === "all" || stateIn(q) === state ? rest : [rest, `s:${state}`].filter(Boolean).join(" ");
}

/** The machine scope in force: the field's one `m:` word, lower-cased, or null. */
export function scopeIn(q: string): string | null {
  const scoped = q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => /^m:./.test(w));
  return scoped.length === 1 ? scoped[0]! : null;
}
