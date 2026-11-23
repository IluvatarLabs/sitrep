// The two findings read straight from a prompt's words, shown on a turn as something to check, never as a state: `correction`,
// a short reply that sets the agent right, and `frustration`, a prompt that sounds fed up. Both rules are ported under the MIT
// licence; the notice is in THIRD_PARTY_NOTICES.md. Pure, with no imports, so the browser runs it on the prompt it shows.

/** Changes whenever a rule's results change. */
export const FINDINGS_VERSION = 1;

export interface Finding {
  rule: 'correction' | 'frustration';
  /** The words that matched. */
  words: string;
}

const bytes = (s: string): number => new TextEncoder().encode(s).length;

const CORRECTIONS: readonly RegExp[] = [
  /^no[,.! ]/i,
  /\bdon'?t\b/i,
  /\bdo not\b/i,
  /\bplease stop\b/i,
  /\bstop (doing|replying|posting|answering|sending|using|adding)\b/i,
  /\bwrong\b/i,
  /\bincorrect\b/i,
  /\bnot (that|what|like that|right|the right)\b/i,
  /\bshould(n'?t| not| never)\b/i,
  /\bthat'?s not\b/i,
];

/** A reply of at most 200 bytes, at least 15 trimmed, with a corrective phrase: the first pattern's match, or null. */
function correction(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (bytes(prompt) > 200 || bytes(trimmed) < 15) return null;
  for (const re of CORRECTIONS) {
    const m = re.exec(trimmed);
    if (m) return m[0];
  }
  return null;
}

const FENCE = /```[\s\S]*?```/g;
const PHRASE = /(!{3,}|\?{3,}|\b(?:wtf|come on|why won't|this is broken|doesn't work|does not work|still broken|same error|you broke|fucking|fuck)\b)/i;

/**
 * Fenced code aside: a prompt of 10 bytes or more with a frustrated phrase or repeated marks, or with three or more words of
 * which three or more have two letters and at least 40 % of those are all capitals. The phrase, or the capitalised words.
 */
function frustration(prompt: string): string | null {
  const text = prompt.replace(FENCE, ' ');
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (bytes(normalized) < 10) return null;
  const phrase = PHRASE.exec(normalized);
  if (phrase) return phrase[0];
  const words = text.match(/\p{L}+/gu) ?? [];
  const long = words.filter((w) => Array.from(w).length >= 2);
  const caps = long.filter((w) => /\p{Lu}/u.test(w) && !/\p{Ll}/u.test(w));
  return words.length >= 3 && long.length >= 3 && caps.length / long.length >= 0.4 ? caps.slice(0, 5).join(' ') : null;
}

/** A turn's findings from its prompt. A correction needs the agent to have spoken first, so the session's first turn has none. */
export function findingsOf(prompt: string, firstTurn: boolean): Finding[] {
  const found: Finding[] = [];
  const corrected = firstTurn ? null : correction(prompt);
  if (corrected !== null) found.push({ rule: 'correction', words: corrected });
  const frustrated = frustration(prompt);
  if (frustrated !== null) found.push({ rule: 'frustration', words: frustrated });
  return found;
}
