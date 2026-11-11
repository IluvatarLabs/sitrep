// The server settings the Settings page edits: the switches (respond, activityFeed and requireSignInToView), the stuck
// thresholds per model family, the lifecycle timers and retention. `server.env` gives each one's default; what the owner
// changes is kept in the `settings` table, wins over the default, and applies without a restart. Resetting a setting drops the
// owner's change.
import { SETTINGS_MIN_MS, type EditableSettings } from './protocol.js';

const DAY_MS = 86_400_000;

/** The defaults when `server.env` names none. */
export const BUILT_IN: EditableSettings = {
  respond: true,
  activityFeed: true,
  requireSignInToView: false,
  stuckAfterMs: { opus: 600_000, sonnet: 240_000, haiku: 180_000, fable: 180_000, openai: 180_000, other: 180_000 },
  lifecycle: { removeAfterMs: 75_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 },
  retention: { samplesMs: DAY_MS, eventsMs: 30 * DAY_MS, sessionsMs: 30 * DAY_MS },
};

/** The groups of numbers, each setting with the environment variable that gives its default. */
const NUMBERS = {
  stuckAfterMs: {
    opus: 'STUCK_AFTER_MS_OPUS',
    sonnet: 'STUCK_AFTER_MS_SONNET',
    haiku: 'STUCK_AFTER_MS_HAIKU',
    fable: 'STUCK_AFTER_MS_FABLE',
    openai: 'STUCK_AFTER_MS_OPENAI',
    other: 'STUCK_AFTER_MS_OTHER',
  },
  lifecycle: { removeAfterMs: 'REMOVE_AFTER_MS', lingerMs: 'LINGER_MS', detachedHideAfterMs: 'DETACHED_HIDE_AFTER_MS' },
  retention: { samplesMs: 'RETAIN_SAMPLES_MS', eventsMs: 'RETAIN_EVENTS_MS', sessionsMs: 'RETAIN_SESSIONS_MS' },
} as const satisfies { [G in Group]: Record<keyof EditableSettings[G], string> };

type Group = 'stuckAfterMs' | 'lifecycle' | 'retention';
const GROUPS = Object.keys(NUMBERS) as Group[];
const SWITCHES = ['respond', 'activityFeed', 'requireSignInToView'] as const;

/** The owner's changes as stored: any switch, and any settings of any group. */
export type SettingsPatch = Partial<Pick<EditableSettings, (typeof SWITCHES)[number]>> & { [G in Group]?: Partial<EditableSettings[G]> };

/** A change as PUT /admin/settings takes it: like a SettingsPatch, but a setting may be null, which drops the owner's change to it. */
export type SettingsChange = { [S in (typeof SWITCHES)[number]]?: boolean | null } & { [G in Group]?: { [K in keyof EditableSettings[G]]?: number | null } };

/** Sets `key` to `value`; null deletes it, and undefined leaves it as it is. */
function lay(rec: Record<string, unknown>, key: string, value: unknown): void {
  if (value === null) delete rec[key];
  else if (value !== undefined) rec[key] = value;
}

/** `base` with `change` laid over it, setting by setting; a setting `change` sets to null is taken out of `base`. */
export function patched<T extends SettingsPatch>(base: T, change: SettingsChange): T {
  const out: Record<string, unknown> = { ...base };
  for (const s of SWITCHES) lay(out, s, change[s]);
  for (const g of GROUPS) {
    const settings = change[g];
    if (!settings) continue;
    const group: Record<string, unknown> = { ...base[g] };
    for (const [key, value] of Object.entries(settings)) lay(group, key, value);
    out[g] = group;
  }
  return out as T;
}

/** A timer read from the environment: a finite number, 0 or more; unset, empty or anything else keeps `fallback`. */
function envMs(raw: string | undefined, fallback: number): number {
  const ms = raw?.trim() ? Number(raw) : Number.NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

/** A switch read from the environment: on, off, true, false, 1 or 0 in any case; unset keeps `fallback`, anything else stops the server. */
function envSwitch(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = (env[name] ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  if (['on', 'true', '1'].includes(v)) return true;
  if (['off', 'false', '0'].includes(v)) return false;
  throw new Error(`${name}: "${v}" is not on or off`);
}

/** Every setting's default: `server.env`, else the built-in value. */
export function settingsFromEnv(env: NodeJS.ProcessEnv): EditableSettings {
  const out = {
    respond: envSwitch(env, 'SITREP_RESPOND', BUILT_IN.respond),
    activityFeed: envSwitch(env, 'SITREP_ACTIVITY_FEED', BUILT_IN.activityFeed),
    requireSignInToView: envSwitch(env, 'SITREP_REQUIRE_SIGN_IN_TO_VIEW', BUILT_IN.requireSignInToView),
  } as EditableSettings;
  for (const g of GROUPS) {
    const fallback = BUILT_IN[g] as Record<string, number>;
    const read = Object.entries(NUMBERS[g]).map(([key, name]) => [key, envMs(env[name], fallback[key]!)]);
    Object.assign(out, { [g]: Object.fromEntries(read) });
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A change as the browser sends it, checked: a switch true, false or null; a timer whole milliseconds, at least its group's
 * SETTINGS_MIN_MS, or null; nothing unknown.
 */
export function parsePatch(body: unknown): { patch: SettingsChange } | { error: string; path: string } {
  if (!isRecord(body)) return { error: 'expected an object', path: '$' };
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const at = `$.${key}`;
    if ((SWITCHES as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean' && value !== null) return { error: 'expected true, false or null', path: at };
    } else if (Object.hasOwn(NUMBERS, key)) {
      if (!isRecord(value)) return { error: 'expected an object', path: at };
      const min = SETTINGS_MIN_MS[key as Group];
      for (const [name, ms] of Object.entries(value)) {
        if (!Object.hasOwn(NUMBERS[key as Group], name)) return { error: 'unknown setting', path: `${at}.${name}` };
        if (ms !== null && !(Number.isSafeInteger(ms) && (ms as number) >= min)) return { error: `expected whole milliseconds, ${String(min)} or more, or null`, path: `${at}.${name}` };
      }
    } else {
      return { error: 'unknown setting', path: at };
    }
    patch[key] = value;
  }
  return { patch: patch as SettingsChange };
}

/**
 * The owner's stored changes, each setting checked alone by parsePatch, so one that no longer passes (say, under a newer
 * minimum) is left out by itself and named in `dropped` ("$.path: why"), and the rest still apply.
 */
export function storedPatch(stored: unknown): { patch: SettingsPatch; dropped: string[] } {
  let patch: SettingsPatch = {};
  const dropped: string[] = [];
  const take = (one: Record<string, unknown>) => {
    const read = parsePatch(one);
    if ('patch' in read) patch = patched(patch, read.patch);
    else dropped.push(`${read.path}: ${read.error}`);
  };
  if (!isRecord(stored)) return { patch, dropped: ['$: expected an object'] };
  for (const [key, value] of Object.entries(stored)) {
    if (isRecord(value)) for (const [name, ms] of Object.entries(value)) take({ [key]: { [name]: ms } });
    else take({ [key]: value });
  }
  return { patch, dropped };
}
