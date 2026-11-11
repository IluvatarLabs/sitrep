// The Machines panel: one row per machine with its last report, its reporters' versions, the Codex daemon's version, its live
// sessions and its plan windows per provider.
import type { MachineRow } from './db.js';
import { checkReporter, supportFor } from './compat.js';
import {
  isKnownProvider,
  MACHINE_QUIET_MS,
  MACHINE_REPORTING_MS,
  PROVIDERS,
  reporterOf,
  type AgentView,
  type MachineState,
  type MachineView,
  type Provider,
  type ProviderRateLimits,
  type RateLimit,
  type Report,
  type ReporterCompat,
  type ReporterVersion,
  type SessionView,
} from './protocol.js';

/**
 * What one accepted report says about its machine. Only the report's own reporter's version is set, so the other reporter's
 * stays. The Codex daemon's version comes only from the codex-reporter, which leaves it out when no daemon runs. A reporter of any
 * other provider has no version column: it notes only that the machine reported.
 */
export function machineNote(r: Report, now: number): Pick<MachineRow, 'id' | 'name' | 'os' | 'last_report_at'> & Partial<MachineRow> {
  const base = { id: r.machine.id, name: r.machine.name, os: r.machine.os, last_report_at: now };
  if (r.provider === 'codex') return { ...base, codex_reporter: r.reporter.version, codex_daemon: r.reporter.daemonVersion ?? null };
  if (r.provider === 'claude') return { ...base, claude_reporter: r.reporter.version };
  return base;
}

/** What the panel reads of a live session. */
type LiveSession = Pick<SessionView, 'machine' | 'provider' | 'status' | 'rateLimits' | 'lastActivityAt' | 'reporterVersion' | 'compat'> & { agents: readonly Pick<AgentView, 'lastActivityAt'>[] };

/** A live session out of range is what needs a look, an older reporter first. */
const WORST_FIRST: readonly ReporterCompat[] = ['outdated', 'newer', 'unknown', 'ok'];

/**
 * One reporter on a machine (ReporterVersion): its live sessions there, the worst compat among them with that session's version;
 * with none live, the version the machine last reported, judged against the range; null when it never reported from there.
 */
function reporterOn(provider: Provider, lastReported: string | null, sessions: readonly LiveSession[]): ReporterVersion | null {
  const mine = sessions.filter((s) => s.provider === provider);
  const worst = WORST_FIRST.flatMap((compat) => mine.filter((s) => s.compat === compat))[0];
  if (worst) return { version: worst.reporterVersion, compat: worst.compat, live: true };
  return lastReported === null ? null : { version: lastReported, compat: checkReporter(lastReported, supportFor(reporterOf(provider))), live: false };
}

/**
 * When a session last showed activity: the latest of its main loop's and its agents' last events, since its plan-window readings
 * also come from agents' work. Negative infinity when none has one yet.
 */
function lastActive(s: LiveSession): number {
  return Math.max(s.lastActivityAt ?? Number.NEGATIVE_INFINITY, ...s.agents.map((a) => a.lastActivityAt ?? Number.NEGATIVE_INFINITY));
}

/** Whether a plan window still holds at `now`: its reset is later, or not known (a null or unparsable `resetsAt`). */
function notYetReset(w: RateLimit, now: number): boolean {
  const t = w.resetsAt === null ? Number.NaN : Date.parse(w.resetsAt);
  return Number.isNaN(t) || t > now;
}

/**
 * When a session's plan-window reading was taken: its newest `measuredAt`, or, from a reporter that sends none, when the session
 * last showed activity, which stands in for it.
 */
function readingAt(s: LiveSession): number {
  const measured = Math.max(...s.rateLimits.map((w) => (w.measuredAt ? Date.parse(w.measuredAt) : Number.NaN)).filter(Number.isFinite));
  return Number.isFinite(measured) ? measured : lastActive(s);
}

/**
 * A machine's plan windows by provider, Claude's first, then Codex's, then any other's by name: those of its live session
 * of that provider whose reading is the
 * newest (`readingAt`; none known counts as oldest; on a tie the first listed), as the native clients show the freshest
 * measurement, less each window past its reset by `now`. A provider with nothing left is left out. One machine's readings only:
 * two machines can be on different accounts.
 */
function providerLimits(sessions: readonly LiveSession[], now: number): ProviderRateLimits[] {
  const out: ProviderRateLimits[] = [];
  const others = [...new Set(sessions.map((s) => s.provider))].filter((p) => !isKnownProvider(p)).sort();
  for (const provider of [...PROVIDERS, ...others]) {
    let freshest: LiveSession | undefined;
    let freshestAt = Number.NEGATIVE_INFINITY;
    for (const s of sessions) {
      if (s.provider !== provider || s.rateLimits.length === 0) continue;
      const at = readingAt(s);
      if (freshest === undefined || at > freshestAt) [freshest, freshestAt] = [s, at];
    }
    const limits = freshest === undefined ? [] : freshest.rateLimits.filter((w) => notYetReset(w, now));
    if (limits.length > 0) out.push({ provider, limits });
  }
  return out;
}

/** The panel's rows, from the stored machines and the live sessions on the wall: their count and their plan windows. */
export function machineViews(rows: readonly MachineRow[], live: readonly LiveSession[], now: number, serverStartedAt: number): MachineView[] {
  const byMachine = new Map<string, LiveSession[]>();
  for (const s of live) {
    const same = byMachine.get(s.machine.id);
    if (same) same.push(s);
    else byMachine.set(s.machine.id, [s]);
  }
  return rows.map((m) => machineView(m, byMachine.get(m.id) ?? [], now, serverStartedAt));
}

/** A machine's reporting state: heard within 2 minutes, within an hour, longer, or not since this server started. */
export function machineState(lastReportAt: number, now: number, serverStartedAt: number): MachineState {
  if (lastReportAt < serverStartedAt) return 'restart';
  const age = now - lastReportAt;
  return age < MACHINE_REPORTING_MS ? 'reporting' : age < MACHINE_QUIET_MS ? 'quiet' : 'silent';
}

/** One row of the panel: a stored machine, with its live sessions on the wall. */
const machineView = (m: MachineRow, sessions: readonly LiveSession[], now: number, serverStartedAt: number): MachineView => ({
  id: m.id,
  name: m.name,
  os: m.os,
  lastReportAt: m.last_report_at,
  state: machineState(m.last_report_at, now, serverStartedAt),
  reporters: { claude: reporterOn('claude', m.claude_reporter, sessions), codex: reporterOn('codex', m.codex_reporter, sessions) },
  codexDaemon: m.codex_daemon,
  // An ended session still lingering on the wall is not counted live.
  liveSessions: sessions.filter((s) => s.status !== 'done').length,
  rateLimits: providerLimits(sessions, now),
});
