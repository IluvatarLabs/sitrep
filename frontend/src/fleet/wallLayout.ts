// The Cards layout's columns, from the width alone, so a card coming or going never resizes the others: as many cards of at
// least 340 px, 12 px apart, as the width holds, at most four; the cards stretch to fill the row. 340 keeps three columns in a
// 1728 CSS px window beside both panes, and in a 1503 or 1382 CSS px one with the Activity pane folded (usePanes); 1152 CSS px
// gives two.
export const CARD_MIN = 340;
export const GAP = 12;
const MOST = 4;

export function wallColumns(width: number): number {
  return Math.max(1, Math.min(MOST, Math.floor((width + GAP) / (CARD_MIN + GAP))));
}
