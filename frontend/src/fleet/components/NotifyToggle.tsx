import { useId } from "react";
import type { NotifyAvailability } from "../attention";

/** Why the switch is missing, in a few words. Plain HTTP is the usual one: Settings then gives the tunnel to localhost. */
const WHY: Record<Exclude<NotifyAvailability, "on" | "off">, string> = {
  insecure: "Needs HTTPS or localhost",
  unsupported: "Not supported in this browser",
  blocked: "Blocked in this browser's site settings",
};

/** Browser notifications for this browser on one row: the switch, or why the browser cannot have them. */
export function NotifyToggle({ availability, onToggle }: { availability: NotifyAvailability; onToggle: () => void }) {
  const id = useId();
  const usable = availability === "on" || availability === "off";
  return (
    <div className="ui-field-row">
      <span id={id}>Notifications</span>
      {usable ? <button type="button" className="ui-switch" role="switch" aria-checked={availability === "on"} aria-labelledby={id} onClick={onToggle} /> : <span className="ui-switch-desc">{WHY[availability]}</span>}
    </div>
  );
}
