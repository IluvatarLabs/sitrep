// What a failed loop looked like, and the redaction every free-text field passes before it leaves the machine. No `$` in
// this file: pure functions only.
import type { TurnCompleteReason } from 'claude-code';
import { LIMITS as CONTRACT, type Failure, type FailureClass } from './protocol.ts';

/**
 * The contract's limits, and three of this reporter's own: a whole prompt or answer (the fullPrompts option) is cut before its
 * cut note; one feed entry; a failing call older than this, when its loop ends failed, is not taken as the cause.
 */
export const LIMITS = { ...CONTRACT, fullText: 20_000, activity: CONTRACT.activityText, candidateMaxAgeMs: 60_000 } as const;

/** Anthropic and OpenAI API keys (`sk-ant-…`, `sk-…`, `sk-proj-…`), in both rule sets. */
const API_KEYS: readonly RegExp[] = [/(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{10,}/g, /(?<![A-Za-z0-9])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g];

/** Token shapes replaced whole: the API keys, GitHub tokens, AWS key ids, bearer tokens. */
const SECRET_SHAPES: readonly RegExp[] = [
  ...API_KEYS,
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer [A-Za-z0-9._-]{20,}/g,
];
/** `token=abc`, `password: abc`, `"api_key": "abc"`: the key stays, its value goes. */
const SECRET_VALUE = /((?:password|passwd|token|secret|apikey|api_key)["']?\s*[=:]\s*["']?)([^\s"'&,;]+)/gi;

/** Anything shaped like a secret becomes `[redacted]`: each token shape in turn, then every keyed value (its key kept). */
export const redact = (text: string): string => SECRET_SHAPES.reduce((out, shape) => out.replace(shape, '[redacted]'), text).replace(SECRET_VALUE, '$1[redacted]');

/** Redacted first, then held to `max` characters. */
export const clip = (text: string, max: number): string => redact(text).slice(0, max);

/**
 * 40000 as "40,000": each run of digits grouped in threes from its right, with a comma before a run of a multiple of three
 * digits that follows a word character. The text is split into digit and other runs in one linear pass (a lookahead regex
 * is quadratic on a long run).
 */
function thousands(n: number): string {
  const runs = String(n).match(/\d+|\D+/g) ?? [];
  return runs
    .map((run, k) => {
      if (!/^\d/.test(run)) return run;
      const groups = [run.slice(0, run.length % 3 || 3)];
      for (let at = groups[0]!.length; at < run.length; at += 3) groups.push(run.slice(at, at + 3));
      const afterWord = k > 0 && /\w$/.test(runs[k - 1]!);
      return (afterWord && run.length % 3 === 0 ? ',' : '') + groups.join(',');
    })
    .join('');
}

/** What a text cut at `n` characters says after the cut, as every cut in a report says it. */
export const cutNote = (n: number): string => `[cut off at ${thousands(n)} characters]`;

// ---- free text from commands and tool input or output (the broader rules) ---------------------------------------------
//
// Run only over what a person or a model wrote freely: a command, a tool's free-text argument, a failed call's output, a
// denial's reason, a message, a first prompt. Ids, paths, names and asks get `redact` above instead, since the long random
// value rule here would mistake a `toolu_…` id or a path segment for a secret.

const MARK = '[redacted]';
/** What a rule that keeps the text before the secret leaves: that text (its first group, or first two), then the mark. */
const AFTER_1 = `$1${MARK}`;
const AFTER_2 = `$1$2${MARK}`;

/**
 * The rules that always replace, in the order they run: token shapes go whole; `Bearer …`, `Basic …`, `AccountKey=…` and
 * `SharedAccessKey=…` keep their label; a credential flag, `mysql … -p<pass>` and `sshpass -p <pass>` keep their command.
 */
const ALWAYS: readonly (readonly [RegExp, string])[] = [
  ...API_KEYS.map((re) => [re, MARK] as const),
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MARK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MARK],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, MARK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MARK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MARK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MARK],
  [/\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}/g, MARK],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, MARK],
  [/\bnpm_[A-Za-z0-9]{30,}/g, MARK],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, MARK],
  [/\bSK[0-9a-f]{32}\b/g, MARK],
  [/\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{3,}/g, MARK],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, AFTER_1],
  [/(\bBasic\s+)(?=[A-Za-z+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/g, AFTER_1],
  [/(AccountKey=)[A-Za-z0-9+/=]{20,}/g, AFTER_1],
  [/(SharedAccessKey=)[^;\s"']+/g, AFTER_1],
  [/(--(?:password|passwd|pass|token|secret|api-?key|auth(?:-token)?|access-key|client-secret)(?:=|\s+))([^\s$<-]\S*)/gi, AFTER_1],
  [/\b(mysql|mysqldump|mariadb)\b([^\n]*?\s-p)([^\s]+)/g, AFTER_2],
  [/(\bsshpass\b[^\n]*?\s-p\s*)(\S+)/g, AFTER_1],
];
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:)([^\s/@"'`]+)(@)/gi;
const HEADER = /\b((?:proxy-)?authorization|set-cookie|cookie|x-api-key|x-auth-token|x-access-token)(["']?\s*[:=]\s*["']?)([^"'\n]+)/gi;
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_INLINE = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_INLINE_ONE = new RegExp(PEM_INLINE.source);
const KEYWORD = 'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|salt|auth(?:[_-]?token)?';
// prefix, keyword, suffix, an optional `?`/`!`, an optional closing quote or bracket, the operator, then the value (quoted or bare).
const KEYED = new RegExp(`([A-Za-z0-9_.-]*?)(${KEYWORD})([A-Za-z0-9_.-]*)([?!]?["'\\]]?\\s*(?::=|=|:)\\s*)("[^"]*"|'[^']*'|\`[^\`]*\`|[^\\s"'\`,;&)}\\]]+)`, 'gi');
/**
 * `curl … -u user:pass`: the credential (the first capture group) replaced, with the command before the credential and the
 * space after it captured. A credential of entropy 2 or less, or one the allowlist matches, stays (THIRD_PARTY_NOTICES.md).
 */
const CURL_USER = /(\bcurl\b(?:.*|.*(?:[\r\n]{1,2}.*){1,5})[ \t\n\r](?:-u|--user)(?:=|[ \t]{0,5}))("(:[^"]{3,}|[^:"]{3,}:|[^:"]{3,}:[^"]{3,})"|'([^:']{3,}:[^']{3,})'|((?:"[^"]{3,}"|'[^']{3,}'|[\w$@.-]+):(?:"[^"]{3,}"|'[^']{3,}'|[\w${}@.-]+)))(\s|$)/g;
/** The rule's allowlist. */
const CURL_USER_ALLOWED: readonly RegExp[] = [
  /[^:]+:(?:change(?:it|me)|pass(?:word)?|pwd|test|token|\*+|x+)/,
  /['"]?<[^>]+>['"]?:['"]?<[^>]+>|<[^:]+:[^>]+>['"]?/,
  /[^:]+:\[[^\]]+\]/,
  /['"]?[^:]+['"]?:['"]?\$(?:\d|\w+|\{(?:\d|\w+)})['"]?/,
  /\$\([^)]+\):\$\([^)]+\)/,
  /['"]?\$?\{\{[^}]+\}\}['"]?:['"]?\$?\{\{[^}]+\}\}['"]?/,
];
const TYPE_WORDS = /^(?:true|false|null|undefined|nil|none|string|number|boolean|any|unknown|void|object|never|bigint|symbol)$/i;
const PLACEHOLDER = /^(?:<.*>|\{.*\}|\$.*|%.*%|x{3,}|\*+|\.{3}|your[-_ ].*|process\.env.*|env\..*)$/i;
const LONG_VALUE = /[A-Za-z0-9+/_=~-]{24,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Text that marks a value as already redacted or filled in later by a template. */
const STAND_IN_MARKS = [MARK, '${', '{{'];
/**
 * An unquoted value that reads as code, not as a secret: a call, member access, index or generic (`f(x)`, `a.b`), or a
 * camelCase, CONSTANT_NAME or PascalCase identifier.
 */
const CODE_LIKE: readonly RegExp[] = [/[().<[{]/, /^[a-z]+[A-Z][A-Za-z]*$/, /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/, /^[A-Z][a-z]+(?:[A-Z][a-z]+)*$/];

/** Whether a keyed value only stands in for a secret: marked or templated, a placeholder or a type word, or (unquoted) code. */
function standsIn(value: string, quoted: boolean): boolean {
  if (STAND_IN_MARKS.some((mark) => value.includes(mark)) || PLACEHOLDER.test(value) || TYPE_WORDS.test(value)) return true;
  return !quoted && CODE_LIKE.some((re) => re.test(value));
}

/**
 * One KEYED match with its value masked, the quotes around it kept; unchanged when the keyword only starts a longer
 * lower-case word (`tokens`, `author`), or the value is under 4 characters or stands in for a secret.
 */
function maskKeyed(whole: string, _prefix: string, _keyword: string, rest: string, _operator: string, value: string): string {
  if (/^[a-z0-9]/.test(rest)) return whole;
  const quote = /^["'`]/.test(value) ? value.charAt(0) : '';
  const bare = quote ? value.slice(1, -1) : value;
  if (bare.length < 4 || standsIn(bare, quote !== '')) return whole;
  return whole.slice(0, -value.length) + quote + MARK + quote;
}

/** Shannon entropy of `s` in bits per character, its characters summed in the order they first appear. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return [...counts.values()].reduce((bits, n) => bits - (n / s.length) * Math.log2(n / s.length), 0);
}

function looksRandom(t: string): boolean {
  if (/^sha\d+-/.test(t) || UUID.test(t) || /^[./~]/.test(t)) return false;
  if (/^[0-9a-f]+$/i.test(t)) return t.length >= 32 && t.length !== 40 && t.length !== 64 && entropy(t) >= 3;
  const classes = Number(/[a-z]/.test(t)) + Number(/[A-Z]/.test(t)) + Number(/[0-9]/.test(t));
  if (classes < 2) return false;
  return /[0-9]/.test(t) ? entropy(t) >= 4 : t.length >= 40 && entropy(t) >= 4.3;
}

/** One line's secrets replaced. */
function redactLine(line: string): string {
  let s = line.replaceAll(PEM_INLINE, MARK);
  s = s.replaceAll(URL_CREDENTIALS, (whole, head: string, pass: string, at: string) => (pass === MARK ? whole : `${head}${MARK}${at}`));
  s = s.replaceAll(HEADER, (whole, name: string, sep: string, value: string) => (/\$|\{\{|\[redacted\]/.test(value) ? whole : `${name}${sep}${MARK}`));
  for (const [re, to] of ALWAYS) s = s.replaceAll(re, to);
  s = s.replaceAll(CURL_USER, (whole, head: string, credential: string, _dq: string, _sq: string, _bare: string, after: string) =>
    entropy(credential) <= 2 || CURL_USER_ALLOWED.some((re) => re.test(credential)) ? whole : `${head}${MARK}${after}`,
  );
  s = s.replaceAll(KEYED, maskKeyed);
  return /integrity/i.test(s) ? s : s.replaceAll(LONG_VALUE, (t) => (looksRandom(t) ? MARK : t));
}

/** Every line redacted; a private key block that spans lines goes whole, from its BEGIN line to its END line. */
function redactText(text: string): string {
  let inKey = false;
  return text
    .split('\n')
    .map((line) => {
      if (inKey) {
        if (PEM_END.test(line)) inKey = false;
        return MARK;
      }
      if (PEM_BEGIN.test(line) && !PEM_INLINE_ONE.test(line)) {
        inKey = true;
        return line.slice(0, line.search(PEM_BEGIN)) + MARK;
      }
      return redactLine(line);
    })
    .join('\n');
}

/** Longest stretch redacted at once: the rules cost grows with the square of a line, so a long line is done in pieces. */
const REDACT_PIECE = 1000;

/**
 * `redactText` for a text of any size: a line over REDACT_PIECE is cut into pieces (at a space where it has one), each piece
 * redacted, and the line put back together. A secret straddling a cut is not seen.
 */
function redactBroad(text: string): string {
  if (text.length <= REDACT_PIECE) return redactText(text);
  const lines = text.split('\n').map(piecesOf);
  const flat = lines.flat();
  const redacted = redactText(flat.join('\n'));
  const back = redacted.split('\n');
  // A rule that added or removed a line break would move text between lines: then what came back is kept as it is.
  if (back.length !== flat.length) return redacted;
  let cursor = 0;
  const rebuilt = lines.map((pieces) => {
    const joined = back.slice(cursor, cursor + pieces.length).join('');
    cursor += pieces.length;
    return joined;
  });
  return rebuilt.join('\n');
}

/** One line in pieces of at most REDACT_PIECE characters, each ending just after a space when one falls in its range. */
function piecesOf(line: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  do {
    let stop = Math.min(start + REDACT_PIECE, line.length);
    if (stop < line.length) {
      const space = line.lastIndexOf(' ', stop);
      if (space > start) stop = space + 1;
    }
    pieces.push(line.slice(start, stop));
    start = stop;
  } while (start < line.length);
  return pieces;
}

/**
 * Free text with anything shaped like a secret as `[redacted]`: the broader rules, then the rules of `redact` over the whole
 * text, so it never redacts less than `redact` does.
 */
export function redactFreeText(text: string): string {
  return redact(redactBroad(text));
}

/**
 * Raw characters a clipped free text is redacted from: ten times the longest `max` it is held to (400), and a bound on the
 * work, as ACTIVITY_RAW is for the feed: on some inputs the broader rules cost up to 50 ms per thousand characters.
 */
const CLIP_RAW = 4000;

/**
 * `text` held to `max` raw characters before it is redacted. A token the cut splits is dropped whole: its first characters
 * alone may match no rule (`postgres://admin:hu`). The lookbehind starts a match only where a token starts, so it stays linear.
 */
export function cutRaw(text: string, max: number): string {
  return text.length > max ? text.slice(0, max).replace(/(?<!\S)\S+$/, '') : text;
}

/** Free text redacted first (`redactFreeText`), then held to `max` characters. */
export function clipFreeText(text: string, max: number): string {
  return redactFreeText(cutRaw(text, CLIP_RAW)).slice(0, max);
}

/** Whitespace folded to single spaces, redacted, at most `max` (400) characters. Empty for no text. */
export const excerpt = (text?: string | null, max: number = LIMITS.excerpt): string => (text ? clip(text.replace(/\s+/g, ' ').trim(), max) : '');

/** A whole text with its line breaks, redacted, held to LIMITS.fullText with the cut note after a cut. */
export function fullText(text?: string | null): string {
  const whole = text ? redact(text.replace(/\r\n?/g, '\n')).trim() : '';
  return whole.length > LIMITS.fullText ? `${whole.slice(0, LIMITS.fullText)}\n\n${cutNote(LIMITS.fullText)}` : whole;
}

/** The last lines of what a call returned, trailing blank lines left off, each redacted as free text and held to a line. */
function outputTail(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  return lines.slice(-LIMITS.outputLines).map((l) => clipFreeText(l, LIMITS.line));
}

/** The exit code a failed call's text states ("Exit code 1"), best effort; null when it states none. */
function statedExitCode(text: string): number | null {
  const stated = /(?:exit code|exit status|exited with(?: code)?)[\s:]*(-?\d{1,3})\b/i.exec(text)?.[1];
  return stated === undefined ? null : Number(stated);
}

/** Fields of a `tool.call` event that belong to the engine, not to the tool's own arguments. */
const ENGINE_FIELDS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta']);
const PATH_TOOLS = new Set(['Edit', 'Read', 'Write', 'NotebookEdit', 'MultiEdit']);
/** Tools whose call is shown by a path or a name, which only `clip`'s rules may touch; any other call shows free text. */
const NOT_FREE_TEXT = new Set([...PATH_TOOLS, 'Grep', 'Glob', 'Skill']);

/** A tool call's argument held to `max`: a path or a name by `clip`, a command or any other argument by `clipFreeText`. */
export function clipCall(tool: string, text: string, max: number): string {
  return NOT_FREE_TEXT.has(tool) ? clip(text, max) : clipFreeText(text, max);
}

/** `tool argument` held to `max`: the tool's name by `clip` and its argument by `clipCall`, redacted apart as a wait note's are. */
function namedCall(tool: string, arg: string, max: number): string {
  const name = clip(tool, max - 1);
  return arg ? `${name} ${clipCall(tool, arg, max - name.length - 1)}` : name;
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : (JSON.stringify(v) ?? ''));

/** The first argument of a call that is the tool's own. */
function firstArgument(input: Record<string, unknown>): unknown {
  for (const [key, value] of Object.entries(input)) if (!ENGINE_FIELDS.has(key)) return value;
  return undefined;
}

/**
 * The argument a call is shown by: Bash its command, a file tool its path, anything else its first own argument. The feed
 * (`feed`) also shows Grep and Glob by their pattern and where, Agent by its description and Skill by its skill.
 */
function shownArgument(tool: string, input: Record<string, unknown>, feed: boolean): string {
  if (tool === 'Bash') return asText(input.command);
  if (PATH_TOOLS.has(tool)) return asText(input.file_path ?? input.notebook_path);
  if (feed && (tool === 'Grep' || tool === 'Glob')) {
    const pattern = tool === 'Grep' ? `"${asText(input.pattern)}"` : asText(input.pattern);
    return input.path ? `${pattern} in ${asText(input.path)}` : pattern;
  }
  if (feed && tool === 'Agent') return asText(input.description);
  if (feed && tool === 'Skill') return asText(input.skill);
  return asText(firstArgument(input));
}

/** A failing call in one line: Bash its command alone, any other tool its name and argument. */
function callLine(tool: string, input: Record<string, unknown>): string {
  const arg = shownArgument(tool, input, false).replace(/\s+/g, ' ').trim();
  return tool === 'Bash' ? clipCall(tool, arg, LIMITS.call) : namedCall(tool, arg, LIMITS.call);
}

/** Raw characters an activity entry is made from: plenty for 300 after redaction, and a bound on the work. */
const ACTIVITY_RAW = 4000;

/** Whitespace folded before the raw cut, so redaction always sees whole whatever an entry can show. */
function folded(text: string): string {
  return cutRaw(text.replace(/\s+/g, ' ').trim(), ACTIVITY_RAW);
}

/** The feed's line for a tool call: its name, a space, and the argument it is shown by. */
export const feedCall = (tool: string, input: Record<string, unknown>): string => namedCall(tool, folded(shownArgument(tool, input, true)), LIMITS.activity);

/** The feed's line for the text one model request wrote; empty when it wrote only whitespace. */
export const feedText = (text: string): string => clip(folded(text), LIMITS.activity);

/** A loop's last failing call: what its failure is blamed on if the loop ends failed soon after. */
export interface FailureCandidate {
  /** A permission decision refused the call; it did not fail by itself. */
  denied: boolean;
  denyText: string | null;
  tool: string;
  /** The call in one line (callLine). */
  call: string;
  /** The last lines of what the call returned, redacted. */
  outputTail: string[];
  exitCode: number | null;
  /** When the call returned (epoch ms). */
  at: number;
}

/** What a tool call's `next(e)` resolves to, as the reporter reads it. */
export type CallResult = { deny?: string; isError?: boolean; text?: string; result?: unknown };

/** A candidate from a call that a permission decision refused (its reason as the output) or that errored; null for one that succeeded. */
export function failingCall(tool: string, input: Record<string, unknown>, result: CallResult, at: number): FailureCandidate | null {
  if (typeof result.deny === 'string') {
    const denyText = clipFreeText(result.deny.replace(/\s+/g, ' ').trim(), LIMITS.line);
    return { at, tool, call: callLine(tool, input), exitCode: null, outputTail: outputTail(result.deny), denied: true, denyText };
  }
  if (result.isError !== true) return null;
  const text = [result.text, result.result].find((v): v is string => typeof v === 'string') ?? '';
  return { at, tool, call: callLine(tool, input), exitCode: statedExitCode(text), outputTail: outputTail(text), denied: false, denyText: null };
}

/** What a loop's failure class is decided from. */
export interface ClassifyInput {
  /** When the turn ended. */
  now: number;
  reason: TurnCompleteReason;
  /** Blowouts on the loop so far; three or more is an exhausted window. */
  blowouts: number;
  /** The stop reason of the loop's last model request. */
  stopReason: string | null;
  /** The loop's last failing call, counted only while recent. */
  candidate: FailureCandidate | null;
}

/**
 * The failure classes in the order they are tried, each with what makes it hold; the first that holds is the class. A full
 * context window comes before the API error because the engine's `error` covers running out of context.
 */
const CLASS_RULES: readonly (readonly [FailureClass, (i: ClassifyInput, recent: FailureCandidate | null) => boolean])[] = [
  ['Blocked by permission', (_i, recent) => recent?.denied === true],
  ['Refusal', (i) => i.reason === 'refusal'],
  ['Context window exhausted', (i) => i.stopReason === 'model_context_window_exceeded' || i.blowouts >= 3],
  ['Model API error', (i, recent) => i.reason === 'error' && recent === null],
  ['Aborted', (i) => i.reason === 'aborted'],
  ['Tool error', (_i, recent) => recent !== null],
];

/** The class of a loop that ended `error`, `refusal` or `aborted` (CLASS_RULES, else Unknown); null for one that answered. */
export function failureClass(i: ClassifyInput): FailureClass | null {
  if (i.reason === 'answer') return null;
  const recent = i.candidate !== null && i.now - i.candidate.at <= LIMITS.candidateMaxAgeMs ? i.candidate : null;
  const rule = CLASS_RULES.find(([, holds]) => holds(i, recent));
  return rule ? rule[0] : 'Unknown';
}

export interface EvidenceInput {
  denyText: string | null;
  /** How often each file was read in the loop. */
  reads: Record<string, number>;
  /** How often each failing call failed in the loop. */
  failedCalls: Record<string, number>;
  blowoutTimes: number[];
}

/** `at` on this machine's clock as `HH:MM:SS`, or `HH:MM` without seconds. */
export function wallClock(at: number, seconds = true): string {
  const d = new Date(at);
  const parts = [d.getHours(), d.getMinutes()];
  if (seconds) parts.push(d.getSeconds());
  return parts.map((v) => String(v).padStart(2, '0')).join(':');
}

/** Facts the reporter saw, never guesses: at most five lines. */
export function evidenceLines(i: EvidenceInput): string[] {
  const lines: string[] = [];
  const blown = i.blowoutTimes.length;
  if (blown > 0) lines.push(`exceeded the context window ${blown} time${blown > 1 ? 's' : ''} (${i.blowoutTimes.slice(-3).map((t) => wallClock(t)).join(', ')})`);
  const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1];
  for (const [call, n] of Object.entries(i.failedCalls).sort(byCount)) if (n >= 2) lines.push(clip(`same call failed ${n} times: ${call}`, LIMITS.line));
  for (const [file, n] of Object.entries(i.reads).sort(byCount)) if (n >= 3) lines.push(clip(`${file} read ${n} times`, LIMITS.line));
  if (i.denyText) lines.push(clip(`permission denied: ${i.denyText}`, LIMITS.line));
  return lines.slice(0, LIMITS.evidenceLines);
}

/** A loop's failure record: from its candidate when there is one, else naming what `blamed` gives (a model request). */
export function failureRecord(cls: FailureClass, candidate: FailureCandidate | null, facts: string[], at: number, blamed: { tool?: string; call?: string } = {}): Failure {
  const evidence = facts.slice(0, LIMITS.evidenceLines);
  if (candidate === null) return { class: cls, at, tool: blamed.tool ?? null, call: blamed.call ? clip(blamed.call, LIMITS.call) : null, exitCode: null, outputTail: [], evidence, retriedAs: null };
  const { tool, call, exitCode } = candidate;
  return { class: cls, at, tool, call, exitCode, outputTail: candidate.outputTail.slice(-LIMITS.outputLines), evidence, retriedAs: null };
}
