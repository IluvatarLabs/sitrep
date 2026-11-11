import { useId } from "react";
import { REDRAW_CHOICES } from "../updateInterval";

interface EveryProps {
  every: number;
  onChange: (seconds: number) => void;
  /** The row's name; how often the console redraws unless named otherwise. */
  label?: string;
  /** The seconds offered. */
  choices?: readonly number[];
}

/** A choice of seconds on one row: how often the console redraws, or (Settings) how often an open activity feed is fetched. */
export function UpdateEveryPicker({ every, onChange, label = "Redraw every", choices = REDRAW_CHOICES }: EveryProps) {
  const id = useId();
  return (
    <div className="ui-field-row">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="ui-select" value={every} onChange={(e) => onChange(Number(e.target.value))}>
        {choices.map((s) => (
          <option key={s} value={s}>{`${s}s`}</option>
        ))}
      </select>
    </div>
  );
}
