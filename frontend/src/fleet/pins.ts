// Pins: a pinned session holds its place in the Fleet, a card its slot in reading order, a row its place among the pinned rows.
// Kept in this browser only (usePins). Pure.

/** Pins kept at most, the newest: a pin waits through a drop for its session to come back (usePins), so one that never does is
 * the oldest to go. */
const MOST = 200;

export type Pin = { id: string; slot: number };

const isPin = (v: unknown): v is Pin => {
  const p = v as Partial<Pin> | null;
  return typeof p === "object" && p !== null && typeof p.id === "string" && Number.isInteger(p.slot) && (p.slot as number) >= 0;
};

/** What was stored, as pins: each id once, anything unreadable left out, the newest MOST. */
export const readPins = (stored: unknown): Pin[] =>
  (Array.isArray(stored) ? stored : [])
    .filter(isPin)
    .filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i)
    .slice(-MOST);

/** The pins without one session's. */
export const unpin = (pins: readonly Pin[], id: string): Pin[] => pins.filter((p) => p.id !== id);

/** The pins with this session pinned at `slot`, in place of any pin it had, the newest last. */
export const pin = (pins: readonly Pin[], id: string, slot: number): Pin[] => [...unpin(pins, id), { id, slot }].slice(-MOST);

/** The pins without those of sessions in `ended`; the same array when none goes, so nothing is stored again. */
export const dropEnded = (pins: Pin[], ended: ReadonlySet<string>): Pin[] => (pins.some((p) => ended.has(p.id)) ? pins.filter((p) => !ended.has(p.id)) : pins);

/** Pinned rows first, in their pinned order, then the rest as given. */
export function pinnedFirst<T extends { id: string }>(list: readonly T[], pins: readonly Pin[]): T[] {
  const slot = new Map(pins.map((p) => [p.id, p.slot]));
  return [...list.filter((x) => slot.has(x.id)).sort((a, b) => slot.get(a.id)! - slot.get(b.id)!), ...list.filter((x) => !slot.has(x.id))];
}

/**
 * Cards with each pinned one in its slot, the lowest slots placed first, and the others filling the free slots in the order
 * given. A taken slot sends a pin to the next free one; a slot past the end means the last place, searched backwards from
 * there so it never takes a place ahead of an earlier pin.
 */
export function inSlots<T extends { id: string }>(list: readonly T[], pins: readonly Pin[]): T[] {
  const n = list.length;
  if (n === 0 || pins.length === 0) return [...list];
  const byId = new Map(list.map((x) => [x.id, x] as const));
  const placed = new Map<number, T>();
  const free = (from: number, step: 1 | -1) => {
    let at = from;
    while (placed.has(at)) at = (at + step + n) % n;
    return at;
  };
  for (const { id, slot } of [...pins].sort((a, b) => a.slot - b.slot)) {
    const card = byId.get(id);
    if (!card || [...placed.values()].includes(card)) continue;
    placed.set(slot >= n ? free(n - 1, -1) : free(slot, 1), card);
  }
  const rest = list.filter((x) => ![...placed.values()].includes(x))[Symbol.iterator]();
  return Array.from({ length: n }, (_, at) => placed.get(at) ?? (rest.next().value as T));
}
