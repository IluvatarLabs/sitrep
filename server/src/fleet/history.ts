// History's filter words, its search and its groups, over the sessions that left in a range, which the fleet has
// read already. A word narrows by what the session's own row says; only a tool an agent called or the record holds, a feedback
// tag and the search phrase ask the database, once each, and only among the sessions still in.
import type { FleetDb, SessionRow } from './db.js';
import { addDays, localDay } from './days.js';
import { fromJson, nameOf, projectOf } from './derive.js';
import { END_WORDS, modelIdName, type GitInfo, type GroupKey, type HistoryGroup, type HistoryRow, type LoopReport, type MachineInfo } from './protocol.js';

/** The filter's words as the browser sends them, each a query parameter: `q` the plain words as one phrase, the rest one field each. */
export const FILTER_WORDS = ['q', 'p', 'h', 'model', 'tool', 'end', 'fb'] as const;
export type HistoryFilter = Partial<Record<(typeof FILTER_WORDS)[number], string>>;

const has = (text: string | null | undefined, word: string): boolean => (text ?? '').toLowerCase().includes(word);

/** About 40 characters either side of where `phrase` is found in `text`, on one line. */
function around(text: string, phrase: string): string {
  const at = Math.max(0, text.toLowerCase().indexOf(phrase));
  const [from, to] = [Math.max(0, at - 40), at + phrase.length + 40];
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`;
}

export interface FilterContext {
  home: string;
  /** Why a session ended, as History words it. */
  endOf(row: SessionRow): string | null;
  /** Whether the reader may search kept text. */
  signedIn: boolean;
}

/**
 * The sessions the filter lets through, in the order given, and for each one the phrase was found in outside its name, project,
 * branch and machine: the text it was found in, or, when it was found in kept text, that text's id (History reads its snippet
 * for the page it shows, `FleetDb.keptHit`). `end:` matches a reason as stored or as its column words it (END_WORDS).
 */
export function filterHistory(db: FleetDb, rows: readonly SessionRow[], f: HistoryFilter, { home, endOf, signedIn }: FilterContext): { rows: SessionRow[]; found: Map<string, string | number> } {
  let kept = rows.filter((r) => (!f.p || has(projectOf(r, home), f.p) || has(r.repo_name, f.p)) && (!f.h || has(r.provider, f.h)) && (!f.model || has(r.model, f.model)) && (!f.end || has(endOf(r), f.end) || has(END_WORDS[endOf(r) ?? ''], f.end)));
  const ids = (): string[] => kept.map((r) => r.id);
  if (f.tool) {
    const tool = f.tool;
    // The main loop's counts are on its row; the database is asked only of the sessions they do not name: of their agents' counts,
    // and, where the report carries no counts at all (Hermes), of the record, which holds every call.
    const countsOf = (r: SessionRow): Record<string, number> | null | undefined => fromJson<LoopReport>(r.loop_json)?.toolCounts;
    const byMainLoop = new Set(kept.filter((r) => Object.keys(countsOf(r) ?? {}).some((name) => name.toLowerCase().startsWith(tool))));
    const rest = kept.filter((r) => !byMainLoop.has(r));
    const byAgentsOrRecord = new Set(db.sessionsWithTool(rest.map((r) => r.id), rest.filter((r) => countsOf(r) == null).map((r) => r.id), tool));
    kept = kept.filter((r) => byMainLoop.has(r) || byAgentsOrRecord.has(r.id));
  }
  if (f.fb) {
    const tag = f.fb;
    const tagged = new Set(db.feedbackOf(ids()).flatMap((x) => (has(x.key, tag) || has(x.value, tag) ? [x.sessionId] : [])));
    kept = kept.filter((r) => tagged.has(r.id));
  }
  const found = new Map<string, string | number>();
  if (f.q) {
    const phrase = f.q;
    // As the Fleet matches a phrase (frontend logic.ts filterSessions).
    const named = (r: SessionRow): boolean => has([nameOf(r), projectOf(r, home), fromJson<GitInfo>(r.git_json)?.branch ?? '', fromJson<MachineInfo>(r.machine_json)?.name ?? ''].join('\n'), phrase);
    const rest = kept.filter((r) => !named(r)).map((r) => r.id);
    for (const hit of db.searchStored(rest, phrase)) if (!found.has(hit.sessionId)) found.set(hit.sessionId, around(hit.text, phrase));
    if (signedIn) for (const hit of db.sessionsWithKept(rest, phrase)) if (!found.has(hit.id)) found.set(hit.id, hit.doc);
    kept = kept.filter((r) => named(r) || found.has(r.id));
  }
  return { rows: kept, found };
}

/** What a group reads of a session: enough to key it and to say what it took. */
export type GroupFacts = Pick<HistoryRow, 'provider' | 'model' | 'project' | 'machineName' | 'engineVersion' | 'endedAt' | 'durationSec' | 'costUsd' | 'costPartial' | 'record' | 'feedback'>;

/** The middle of the values (the mean of the middle two); null with none. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The Monday of the week a server-local day is in. */
const weekOf = (day: string): string => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

/** The groups a session is in: one, but a session counts under each of its feedback tags. Unknown is "—". */
function keysOf(r: GroupFacts, by: GroupKey): string[] {
  switch (by) {
    case 'day':
      return [localDay(r.endedAt)];
    case 'week':
      return [weekOf(localDay(r.endedAt))];
    case 'model':
      return [r.model === null ? '—' : modelIdName(r.model)];
    case 'engine':
      return [`${r.provider} ${r.engineVersion ?? '—'}`];
    case 'project':
      return [r.project || '—'];
    case 'machine':
      return [r.machineName ?? '—'];
    case 'feedback':
      return r.feedback.length === 0 ? ['—'] : [...new Set(r.feedback.map((f) => (f.value !== null ? `${f.key}: ${f.value}` : f.score !== null ? `${f.key}: ${String(f.score)}` : f.key)))];
  }
}

/** History's sessions as groups: days and weeks newest first, any other key by how many sessions it holds. */
export function groupHistory(rows: readonly GroupFacts[], by: GroupKey): HistoryGroup[] {
  const groups = new Map<string, GroupFacts[]>();
  for (const r of rows) {
    for (const key of keysOf(r, by)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
  }
  const out = [...groups].map(([key, of]): HistoryGroup => {
    const records = of.flatMap((r) => (r.record ? [r.record] : []));
    // Failed calls are a share of the calls whose outcome is known: with none known, the share is not known either.
    const known = records.reduce((n, c) => n + c.knownCalls, 0);
    return {
      key,
      sessions: of.length,
      durationSec: median(of.map((r) => r.durationSec)) ?? 0,
      costUsd: median(of.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]))),
      // Only a known cost is partial (derive.ts costParts), so these are among the costs the median was taken from.
      costPartial: of.some((r) => r.costPartial),
      turns: median(records.map((c) => c.turns)),
      toolCalls: median(records.map((c) => c.toolCalls)),
      failedShare: known === 0 ? null : records.reduce((n, c) => n + c.failedCalls, 0) / known,
    };
  });
  const byTime = by === 'day' || by === 'week';
  return out.sort((a, b) => (byTime ? (a.key < b.key ? 1 : -1) : b.sessions - a.sessions || (a.key < b.key ? -1 : 1)));
}
