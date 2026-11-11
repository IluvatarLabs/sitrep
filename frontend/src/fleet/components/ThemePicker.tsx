import { useId } from "react";
import { MODES, type ModeChoice, type ThemeState } from "../useTheme";

const LABEL: Record<ModeChoice, string> = { system: "System", light: "Light", dark: "Dark" };

/** Theme on one row: System, Light or Dark, as radios drawn as a segmented control. */
export function ThemePicker({ theme }: { theme: ThemeState }) {
  const id = useId();
  return (
    <div className="ui-field-row">
      <span id={id}>Theme</span>
      <div className="ui-segment-options" role="radiogroup" aria-labelledby={id}>
        {MODES.map((m) => (
          <label key={m}>
            <input type="radio" name={id} value={m} checked={theme.mode === m} onChange={() => theme.setMode(m)} />
            <span>{LABEL[m]}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
