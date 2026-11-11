// Settings (#/settings): one-line rows. Server: what the
// server keeps in its settings table with server.env as the defaults and applies at once, Require sign-in to view among
// them; a change needs the sign-in, goes out as a partial PUT, and Reset sends null, which drops the stored value so
// server.env's applies again; a timer below its minimum is refused here as the server refuses it. Prices: where the table came
// from (LiteLLM at start, or the built-in snapshot and why), the table, read-only, a row's long-request prices on a second line
// under it, and the models seen with no price. This browser: theme, animation, notifications, refresh rates, and the console's
// keys with a button that hides or shows the top bar. About: what only server.env and a restart change, the server's commands,
// and the backup.
import { Fragment, useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { SETTINGS_MIN_MS, type EditableSettings, type ModelPriceSet, type SettingsBody } from "../../../../../server/src/fleet/protocol";
import { NotifyToggle } from "../../components/NotifyToggle";
import { ThemePicker } from "../../components/ThemePicker";
import { UpdateEveryPicker } from "../../components/UpdateEveryPicker";
import { adminApi, type SettingsPatch } from "../../respondApi";
import { MOTIONS, readMotion, setMotion, type MotionChoice } from "../../shell/useMotion";
import type { FleetState } from "../../store";
import { Dots } from "../../ui/Dots";
import { EVERY_CHOICES, readEvery, writeEvery } from "../../useActivityFeed";
import { useRespond } from "../../useRespond";
import { Command, OsPicker, serverCommands, tunnelCommand, type Os } from "../machines/commands";
import type { BrowserPrefs, ViewProps } from "../types";
import { failure, getJson, type Load } from "./api";
import "./settings.css";

// ---- the server's settings ---------------------------------------------------------------------------------------------

const UNIT_MS = { s: 1000, min: 60_000, h: 3_600_000, days: 86_400_000 } as const;
type Unit = keyof typeof UNIT_MS;

/** Milliseconds in a row's unit, to two places at most: 600000 in min is "10", 90000 "1.5". */
const inUnit = (ms: number, unit: Unit): string => String(Number((ms / UNIT_MS[unit]).toFixed(2)));

type Group = "stuckAfterMs" | "lifecycle" | "retention";

/** The least a timer of each group takes, as the server refuses less, so a stray 0 can't empty History. */
const MIN: Record<Group, { ms: number; text: string }> = {
  stuckAfterMs: { ms: SETTINGS_MIN_MS.stuckAfterMs, text: "10 s" },
  lifecycle: { ms: SETTINGS_MIN_MS.lifecycle, text: "1 s" },
  retention: { ms: SETTINGS_MIN_MS.retention, text: "1 h" },
};

interface TimeSetting {
  group: Group;
  key: string;
  label: string;
  unit: Unit;
  /** Said on hover, where the label alone could mislead. */
  hint?: string;
}

/** Each group of timers in the order the page lists them, each setting in the unit it reads best in. */
const TIMES: { title: string; hint?: string; rows: TimeSetting[] }[] = [
  {
    title: "Stuck after",
    hint: "Running with no activity for this long; doubled while a tool call is open",
    rows: (
      [
        ["opus", "Opus"],
        ["sonnet", "Sonnet"],
        ["haiku", "Haiku"],
        ["fable", "Fable"],
        ["openai", "OpenAI"],
        ["other", "Other"],
      ] as const
    ).map(([key, label]) => ({ group: "stuckAfterMs" as const, key, label, unit: "min" as const })),
  },
  {
    title: "Timers",
    rows: [
      { group: "lifecycle", key: "removeAfterMs", label: "Removed after", unit: "s", hint: "No report for this long" },
      { group: "lifecycle", key: "lingerMs", label: "Ended sessions stay", unit: "s" },
      { group: "lifecycle", key: "detachedHideAfterMs", label: "Background hidden after", unit: "s", hint: "Sessions nobody is attached to" },
    ],
  },
  {
    title: "Keep",
    rows: [
      { group: "retention", key: "samplesMs", label: "Charts", unit: "h" },
      { group: "retention", key: "eventsMs", label: "Activity", unit: "days" },
      { group: "retention", key: "sessionsMs", label: "History", unit: "days" },
    ],
  },
];

const valueOf = (s: EditableSettings, t: TimeSetting): number => (s[t.group] as Record<string, number>)[t.key] ?? 0;

/** The server's settings: read on open and after each snapshot, replaced by the reply to a change. `save` never throws. */
function useServerSettings(fleet: FleetState) {
  const [load, setLoad] = useState<Load<SettingsBody>>({ state: "loading" });
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    getJson<SettingsBody>("/settings").then(
      (body) => current && setLoad({ state: "ok", data: body }),
      (err: unknown) => current && setLoad((was) => (was.state === "ok" ? was : { state: "error", message: failure(err) })),
    );
    return () => {
      current = false;
    };
    // A new snapshot (after a reconnect, or another browser's change) carries new settings objects.
  }, [fleet.settings, fleet.config]);
  const save = useCallback(async (patch: SettingsPatch) => {
    setSaveError(null);
    try {
      setLoad({ state: "ok", data: await adminApi.saveSettings(patch) });
    } catch (err) {
      setSaveError(failure(err));
    }
  }, []);
  return { load, saveError, save };
}

const onOff = (on: boolean) => (on ? "On" : "Off");

/**
 * A switch, with one line under its label saying what it does where the label alone cannot. Signed in, it saves on a press, and
 * Reset shows and restores the default. `onSave(null)` drops the stored value, as does a press that lands on the default, so no
 * stored value outlives a later edit of server.env.
 */
function SwitchRow({ label, hint, on, fallback, signedIn, note, onSave }: { label: string; hint?: string; on: boolean; fallback: boolean; signedIn: boolean; note?: string | null; onSave: (on: boolean | null) => void }) {
  const id = useId();
  const hintId = useId();
  const next = !on;
  return (
    <div className="st-row">
      <span className="st-label">
        <span id={id}>{label}</span>
        {hint ? (
          <span id={hintId} className="st-hint">
            {hint}
          </span>
        ) : null}
      </span>
      <span className="st-value">
        {note ? <span className="st-note">{note}</span> : null}
        {signedIn && on !== fallback ? (
          <button type="button" className="ui-button" onClick={() => onSave(null)}>
            {`Reset to ${onOff(fallback)}`}
          </button>
        ) : null}
        {signedIn ? <button type="button" className="ui-switch" role="switch" aria-checked={on} aria-labelledby={id} aria-describedby={hint ? hintId : undefined} onClick={() => onSave(next === fallback ? null : next)} /> : <span>{onOff(on)}</span>}
      </span>
    </div>
  );
}

/**
 * A timer in its unit. Signed in, its field saves on Enter or on leaving it (Escape puts it back), and Reset shows and restores
 * the default (`onSave(null)` drops the stored value, as does typing the default). A value that is not a number is dropped; one
 * below its group's minimum stays in the field, refused, with the minimum beside it, and nothing is saved.
 */
function TimeRow({ row, ms, fallback, signedIn, onSave }: { row: TimeSetting; ms: number; fallback: number; signedIn: boolean; onSave: (ms: number | null) => Promise<void> }) {
  const id = useId();
  const min = MIN[row.group];
  // What is typed and not saved yet; null shows the saved value. `low`: the draft was refused for being below the minimum.
  const [draft, setDraft] = useState<string | null>(null);
  const [low, setLow] = useState(false);
  const edit = (next: string | null) => {
    setDraft(next);
    setLow(false);
  };
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    const next = Math.round(n * UNIT_MS[row.unit]);
    if (draft.trim() === "" || !Number.isFinite(n) || next === ms) return edit(null);
    if (next < min.ms) return setLow(true);
    void onSave(next === fallback ? null : next).finally(() => edit(null));
  };
  return (
    <div className="st-row">
      {signedIn ? (
        <label htmlFor={id} title={row.hint}>
          {row.label}
        </label>
      ) : (
        <span title={row.hint}>{row.label}</span>
      )}
      <span className="st-value">
        {low ? (
          <span className="st-note" role="alert">
            {`At least ${min.text}`}
          </span>
        ) : null}
        {signedIn && ms !== fallback ? (
          <button type="button" className="ui-button" onClick={() => void onSave(null)}>
            {`Reset to ${inUnit(fallback, row.unit)} ${row.unit}`}
          </button>
        ) : null}
        {signedIn ? (
          <input
            id={id}
            className="st-num"
            type="number"
            min={min.ms / UNIT_MS[row.unit]}
            step="any"
            inputMode="decimal"
            aria-invalid={low || undefined}
            value={draft ?? inUnit(ms, row.unit)}
            onChange={(e) => edit(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") edit(null);
            }}
          />
        ) : (
          <span className="st-fig">{inUnit(ms, row.unit)}</span>
        )}
        <span className="st-unit">{row.unit}</span>
      </span>
    </div>
  );
}

function ServerRows({ body, signedIn, save, error }: { body: SettingsBody; signedIn: boolean; save: (patch: SettingsPatch) => Promise<void>; error: string | null }) {
  const { settings: s, defaults: d } = body;
  return (
    <>
      {error ? (
        <p className="st-error" role="alert">
          {`Could not save: ${error}`}
        </p>
      ) : null}
      <SwitchRow label="Answering" on={s.respond} fallback={d.respond} signedIn={signedIn} note={s.respond && !s.activityFeed ? "Needs the activity feed" : null} onSave={(on) => save({ respond: on })} />
      <SwitchRow label="Activity feed" on={s.activityFeed} fallback={d.activityFeed} signedIn={signedIn} onSave={(on) => save({ activityFeed: on })} />
      <SwitchRow
        label="Require sign-in to view"
        hint="Signed out, this dashboard shows only the sign-in."
        on={s.requireSignInToView}
        fallback={d.requireSignInToView}
        signedIn={signedIn}
        onSave={(on) => save({ requireSignInToView: on })}
      />
      {TIMES.map((g) => (
        <div key={g.title}>
          <h3 className="st-sub" title={g.hint}>
            {g.title}
          </h3>
          {g.rows.map((r) => (
            <TimeRow key={r.key} row={r} ms={valueOf(s, r)} fallback={valueOf(d, r)} signedIn={signedIn} onSave={(ms) => save({ [r.group]: { [r.key]: ms } } as SettingsPatch)} />
          ))}
        </div>
      ))}
    </>
  );
}

// ---- prices ---------------------------------------------------------------------------------------------------------------

const PRICE_COLUMNS: readonly [keyof ModelPriceSet, string][] = [
  ["input", "Input"],
  ["output", "Output"],
  ["cacheRead", "Cache read"],
  ["cacheWrite", "Cache write 5m / 30m"],
  ["cacheWrite1h", "Cache write 1h / 12h"],
];

const fmtPrice = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

/** Where this start's table came from: LiteLLM's price file fetched at start, or the copy shipped with the server, and why. */
function PriceSource({ prices: { source, asOf, error } }: { prices: SettingsBody["prices"] }) {
  const at = new Date(asOf);
  return (
    <div className="st-row">
      <span>Source</span>
      <span className="st-value">
        {source === "live" ? `LiteLLM, fetched ${at.toLocaleString()}` : `Built-in snapshot of ${at.toLocaleDateString()}`}
        {error ? <span className="st-fail">{`Refresh failed: ${error}`}</span> : null}
      </span>
    </div>
  );
}

function Prices({ body }: { body: SettingsBody }) {
  return (
    <>
      <PriceSource prices={body.prices} />
      <div className="st-scroll">
        <table className="st-prices">
          <thead>
            <tr>
              <th scope="col">Model</th>
              {PRICE_COLUMNS.map(([key, label]) => (
                <th key={key} scope="col" className="st-n">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.prices.rows.map(({ model, label, std, long }) => (
              <Fragment key={model}>
                <tr className={long ? "st-has-long" : undefined}>
                  {/* The label shows only when it differs from the id (an override's name, or the priced row's key for an alias or a
                      `[1m]` id); the id always shows, once. */}
                  <th scope="row">
                    {label !== model ? `${label} ` : null}
                    <code className="st-code">{model}</code>
                  </th>
                  {PRICE_COLUMNS.map(([key]) => (
                    <td key={key} className="st-n">
                      {fmtPrice(std[key])}
                    </td>
                  ))}
                </tr>
                {long ? (
                  <tr className="st-long">
                    <th scope="row" aria-label={`${label}, ${long.when}`}>
                      {long.when}
                    </th>
                    {PRICE_COLUMNS.map(([key]) => (
                      <td key={key} className="st-n">
                        {fmtPrice(long.prices[key])}
                      </td>
                    ))}
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {body.unpricedModels.length ? (
        <div className="st-row">
          <span>No price</span>
          <span className="st-value">
            <Dots items={body.unpricedModels.map((m) => <code key={m} className="st-code">{m}</code>)} />
          </span>
        </div>
      ) : null}
    </>
  );
}

// ---- this browser -----------------------------------------------------------------------------------------------------------

/** The top bar, folded away or not, and the shell's switch for it (the `\` key does the same). */
export interface TopBarSwitch {
  hidden: boolean;
  /** The top bar's element id. */
  controls: string;
  onToggle: () => void;
}

/** The console's single keys (FleetApp PANE_KEYS, shell/useDisplayMode, views/display, views/history DayNav), each with what it does. */
const KEYS: readonly [string, string][] = [
  ["w", "Display mode on or off"],
  ["[", "Show or hide the sidebar"],
  ["]", "Show or hide Activity"],
  ["\\", "Show or hide the top bar"],
  ["Esc", "Leave display mode"],
  ["l", "Display mode: the other layout"],
  ["↑ ↓ ← →", "Display mode: move between sessions; Enter opens one"],
  ["← →", "History: the day before or after"],
  ["t", "History: today"],
];

/** The keys, one row each; the top bar's row also has the button that does the same. */
function Keys({ topBar }: { topBar: TopBarSwitch }) {
  return (
    <>
      <h3 className="st-sub">Keys</h3>
      {KEYS.map(([key, label]) => (
        <div key={key} className="st-row">
          <span>{label}</span>
          <span className="st-value">
            {key === "\\" ? (
              <button type="button" className="ui-button" aria-controls={topBar.controls} aria-expanded={!topBar.hidden} onClick={topBar.onToggle}>
                {topBar.hidden ? "Show the top bar" : "Hide the top bar"}
              </button>
            ) : null}
            <kbd className="st-key">{key}</kbd>
          </span>
        </div>
      ))}
    </>
  );
}

const MOTION_LABEL: Record<MotionChoice, string> = { system: "System", on: "On", off: "Off" };

/** Animation on one row, as the theme's: System (the system's reduced-motion setting), On or Off, as a segmented control. */
function MotionPicker() {
  const id = useId();
  const [motion, setChoice] = useState(readMotion);
  const choose = (m: MotionChoice) => {
    setChoice(m);
    setMotion(m);
  };
  return (
    <div className="ui-field-row">
      <span id={id}>Animation</span>
      <div className="ui-segment-options" role="radiogroup" aria-labelledby={id}>
        {MOTIONS.map((m) => (
          <label key={m}>
            <input type="radio" name={id} value={m} checked={motion === m} onChange={() => choose(m)} />
            <span>{MOTION_LABEL[m]}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Theme, animation, notifications (on plain HTTP, the tunnel to localhost, where browsers allow them), how often things
 * refresh, and the keys. The shell holds the theme, notifications, the redraw interval and the top bar, so a change shows at
 * once everywhere; animation is set on the page itself (shell/useMotion); the answer panel reads the feed's interval when it
 * opens.
 */
function BrowserRows({ browser, about, topBar }: { browser: BrowserPrefs; about: SettingsBody["about"] | null; topBar: TopBarSwitch }) {
  const [feedEvery, setFeedEvery] = useState(readEvery);
  const onFeedEvery = (seconds: number) => {
    setFeedEvery(seconds);
    writeEvery(seconds);
  };
  return (
    <>
      <ThemePicker theme={browser.theme} />
      <MotionPicker />
      <NotifyToggle availability={browser.notify.availability} onToggle={browser.notify.toggle} />
      {browser.notify.availability === "insecure" && about ? <Command label={`Tunnel, then open localhost:${about.port}`} text={tunnelCommand(about.host, about.port, window.location.hostname)} /> : null}
      <UpdateEveryPicker every={browser.every} onChange={browser.onEvery} />
      <UpdateEveryPicker label="Activity feed every" choices={EVERY_CHOICES} every={feedEvery} onChange={onFeedEvery} />
      <Keys topBar={topBar} />
    </>
  );
}

// ---- about ----------------------------------------------------------------------------------------------------------------

function About({ about, signedIn }: { about: SettingsBody["about"]; signedIn: boolean }) {
  const [os, setOs] = useState<Os>("linux");
  const code = (text: string) => (
    <code key={text} className="st-code">
      {text}
    </code>
  );
  const facts: [string, ReactNode][] = [
    ["Version", about.build ? <Dots items={[about.version, `dev ${about.build}`]} /> : about.version],
    ["Address", code(`${about.host}:${about.port}`)],
    ["Allowed hosts", about.allowedHosts.length ? <Dots items={about.allowedHosts.map(code)} /> : "None"],
    ["Time zone", about.timeZone],
    ["Log level", about.logLevel],
    ["Started", new Date(about.startedAt).toLocaleString()],
  ];
  return (
    <>
      {facts.map(([label, value]) => (
        <div key={label} className="st-row">
          <span>{label}</span>
          <span className="st-value">{value}</span>
        </div>
      ))}
      <div className="st-row">
        <h3 className="st-sub">Commands</h3>
        <OsPicker value={os} onChange={setOs} label="The server's OS" />
      </div>
      {serverCommands(os, about.host, about.port, window.location.hostname).map((c) => (
        <Command key={c.key} label={c.label} note={c.note} text={c.text} />
      ))}
      {signedIn ? (
        <div className="st-row">
          <span>Backup</span>
          <a className="ui-button" href={adminApi.backupUrl} download>
            Download backup
          </a>
        </div>
      ) : null}
    </>
  );
}

// ---- the page ---------------------------------------------------------------------------------------------------------------

function Section({ id, title, meta, children }: { id: string; title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <div className="st-head">
        <h2 id={id}>{title}</h2>
        {meta ? <span className="st-meta">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function SettingsView({ fleet, browser, topBar }: ViewProps & { topBar: TopBarSwitch }) {
  const signedIn = useRespond()?.me?.signedIn === true;
  const { load, saveError, save } = useServerSettings(fleet);
  const body = load.state === "ok" ? load.data : null;
  const pending = load.state === "loading" ? <p className="ui-empty">Loading…</p> : load.state === "error" ? <p className="ui-empty">{`Could not load: ${load.message}`}</p> : null;
  return (
    <div className="st">
      <header className="ui-view-head">
        <h1>Settings</h1>
      </header>
      <Section id="st-server" title="Server" meta={signedIn ? null : "Sign in to change"}>
        {body ? <ServerRows body={body} signedIn={signedIn} save={save} error={saveError} /> : pending}
      </Section>
      <Section id="st-prices" title="Prices" meta="$ per million tokens">
        {body ? <Prices body={body} /> : pending}
      </Section>
      <Section id="st-browser" title="This browser">
        <BrowserRows browser={browser} about={body?.about ?? null} topBar={topBar} />
      </Section>
      <Section id="st-about" title="About">
        {body ? <About about={body.about} signedIn={signedIn} /> : pending}
      </Section>
    </div>
  );
}
