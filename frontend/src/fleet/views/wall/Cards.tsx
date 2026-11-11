// The Fleet's Cards layout: every session as a card, in its group, the columns fitted to the width and shared by
// every group so they line up; a pinned card keeps its slot.
import type { CSSProperties } from "react";
import { inSlots, type Pin } from "../../pins";
import type { FleetPrefsApi } from "../../useGroupPrefs";
import { useWallColumns } from "../../useWallColumns";
import { Groups } from "../now/controls";
import type { FleetShape } from "../now/fleet";
import { WallCard } from "./WallCard";
import "./wall.css";

interface CardsProps {
  shape: FleetShape;
  now: number;
  prefs: FleetPrefsApi;
  pins: Pin[];
  onPin: (id: string, slot: number) => void;
  spendOf: (machineId: string) => number | null;
  labels: ReadonlyMap<string, string>;
}

export function Cards({ shape, now, prefs, pins, onPin, spendOf, labels }: CardsProps) {
  const { ref, cols } = useWallColumns();
  const named = prefs.prefs.groupBy === "machine";
  return (
    <div ref={ref} className={cols ? "wc-area has-cols" : "wc-area"} style={cols ? ({ "--wc-cols": cols } as CSSProperties) : undefined}>
      <Groups shape={shape} prefs={prefs} spendOf={spendOf} idPrefix="wc">
        {(list, bodyId, hidden) => (
          <div className="wc-grid" id={bodyId} hidden={hidden}>
            {inSlots(list, pins).map((s, slot) => (
              <WallCard
                key={s.id}
                s={s}
                now={now}
                machine={named ? null : (labels.get(s.machine.id) ?? s.machine.name)}
                pinned={pins.some((p) => p.id === s.id)}
                onPin={() => onPin(s.id, slot)}
              />
            ))}
          </div>
        )}
      </Groups>
    </div>
  );
}
