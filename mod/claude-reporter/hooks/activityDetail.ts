// What a Bash entry of the activity feed carries beyond its 300-character summary: the call's id, its whole
// command, and once it returns how it ended. Never its output: the contract leaves command output out.
// Pure. A command goes through the free-text redaction in failures.ts (its broader rules), after ANSI codes and
// other control characters are taken out, so a coloured secret is still caught.
import { cutNote, cutRaw, feedCall, redactFreeText, type CallResult } from './failures.ts';
import type { ActivityEntry } from './protocol.ts';

/** Characters of a command sent, before the cut-off marker. */
const COMMAND_MAX = 20_000;
/** Raw characters read before redaction, so a huge command costs bounded work. */
const RAW_MAX = 100_000;
/** A failed Bash call's text starts with Claude Code's own status line, such as `Exit code 1`. */
const EXIT_LINE = /^Exit code (-?\d{1,3})(?:\n|$)/;

// ---- control characters ---------------------------------------------------------------------------------------------

const ESC = 0x1b;
const BEL = 0x07;
/** What follows ESC to open a control string that runs until BEL or ESC backslash: OSC, DCS, APC, PM and SOS. */
const STRING_OPENERS = new Set([']', 'P', '_', '^', 'X']);

/** A UTF-16 code unit that stays: printable text, a line feed or a tab. */
const printable = (code: number): boolean => code === 0x09 || code === 0x0a || (code >= 0x20 && code < 0x7f) || code > 0x9f;

/** Where the escape sequence opened by the ESC at `at` stops: the index after its last character, or the text's end. */
function afterEscape(text: string, at: number): number {
  const opener = text.charAt(at + 1);
  let j = at + 2;
  if (opener === '[') {
    // A CSI runs to its first final byte, 0x40 to 0x7e.
    while (j < text.length) {
      const code = text.charCodeAt(j++);
      if (code >= 0x40 && code <= 0x7e) return j;
    }
    return text.length;
  }
  if (STRING_OPENERS.has(opener)) {
    for (; j < text.length; j++) {
      const code = text.charCodeAt(j);
      if (code === BEL) return j + 1;
      if (code === ESC && text.charAt(j + 1) === '\\') return j + 2;
    }
    return text.length;
  }
  // Any other ESC takes the one character after it along.
  return Math.min(text.length, at + 2);
}

/** `text` without escape sequences or control characters; line feeds and tabs stay, a carriage return goes. */
function withoutControls(text: string): string {
  const kept: string[] = [];
  let runStart = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (printable(code)) {
      i++;
    } else {
      kept.push(text.slice(runStart, i));
      i = code === ESC ? afterEscape(text, i) : i + 1;
      runStart = i;
    }
  }
  if (runStart === 0) return text;
  kept.push(text.slice(runStart));
  return kept.join('');
}

// ---- entries ----------------------------------------------------------------------------------------------------------

/**
 * The feed entry for a call about to run. A Bash entry also carries the call's id and its whole command: control characters
 * out, redacted, and cut at COMMAND_MAX with the marker.
 */
export function toolEntry(at: number, tool: string, input: Record<string, unknown>, id?: string): ActivityEntry {
  const entry: ActivityEntry = { at, kind: 'tool', text: feedCall(tool, input) };
  if (tool !== 'Bash') return entry;
  if (id) entry.id = id;
  const command = typeof input.command === 'string' ? redactFreeText(withoutControls(cutRaw(input.command, RAW_MAX))) : null;
  if (command === null) return entry;
  const cut = command.length > COMMAND_MAX;
  entry.command = cut ? `${command.slice(0, COMMAND_MAX)}\n\n${cutNote(COMMAND_MAX)}` : command;
  if (cut) entry.commandCut = true;
  return entry;
}

/**
 * How a Bash call ended, for its entry: always `done`; `failed` when a permission decision denied it or it errored; and for an
 * error, `exitCode` from the status line Claude Code writes first in the call's text. The result has no numeric code and no
 * output past that line is read (never parsed from output text), so an error without the line, or with a negative code the
 * contract cannot carry, has none. Every field is checked, as the result arrives untyped.
 */
export function finishedCall(res: CallResult): Pick<ActivityEntry, 'done' | 'failed' | 'exitCode'> {
  const denied = typeof res.deny === 'string';
  if (!denied && res.isError !== true) return { done: true };
  const text = denied ? '' : ([res.text, res.result].find((v): v is string => typeof v === 'string') ?? '');
  const exitCode = Number(EXIT_LINE.exec(text)?.[1] ?? -1);
  return exitCode >= 0 ? { done: true, failed: true, exitCode } : { done: true, failed: true };
}
