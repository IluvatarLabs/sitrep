// Answering a waiting session from the dashboard: the pure parts. What the session takes, the asks it announces
// (redacted and cut), what an answer from the dashboard becomes for Claude Code, and the lines the reporter writes in the
// transcript. No `$` here.
import { cutNote, redact, wallClock } from './failures.ts';
import { acceptsFor, RESPOND_LEVELS, RESPOND_LIMITS, type Ask, type AskQuestion, type Delivery, type PlanMode, type QuestionAnswer, type RespondInfo, type RespondLevel, type RespondLimit } from './protocol.ts';

const L = RESPOND_LIMITS;
type Obj = Record<string, unknown>;

/** The `respond` option: absent reads as the default `everything`; any value that is not a level reads as `off`. */
export const respondLevel = (v: unknown): RespondLevel => (v === undefined || v === null ? 'everything' : (RESPOND_LEVELS.find((level) => level === v) ?? 'off'));

/** Report.session.respond: the level as set, what the session takes now, and why a kind the level allows is missing. */
export function respondInfo(level: RespondLevel, here: { activityFeed: boolean; interactive: boolean; permissionHooks: boolean | null }): RespondInfo {
  // PermissionRequest hooks known not to run here first, then a run with no person's client on it.
  const limits: RespondLimit[] = [];
  if (here.permissionHooks === false) limits.push('no-permission-hooks');
  if (!here.interactive) limits.push('not-interactive');
  const accepts = acceptsFor(level, limits, here.activityFeed);
  return { level, accepts, limits };
}

/** Redacted and held to `max` with the cut note after a cut; line breaks kept. */
function cutText(text: unknown, max: number): string {
  const clean = redact(String(text ?? '').replace(/\r\n?/g, '\n'));
  return clean.length > max ? `${clean.slice(0, max)}\n\n${cutNote(max)}` : clean;
}

/** A one-line field (a header, a label): redacted, whitespace folded, held to `max` without a note. */
const oneLine = (text: unknown, max: number): string => redact(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, max);

export const LINE_OPEN = 'also open in the dashboard. Answer here or there.';
export const LINE_MESSAGES_ON = 'messages from the dashboard are on.';

/** What the transcript line says an answer from the dashboard did, by its kind: a message or a command was sent. */
const VERBS: Record<Delivery['kind'], string> = { question: 'Answered', reply: 'Replied', 'plan-approve': 'Approved', 'plan-feedback': 'Sent back', 'allow-once': 'Allowed once', deny: 'Denied', message: 'Sent', command: 'Sent' };

/** Which call an ask is for, in which loop, and when it opened. */
export type AskCall = Pick<Ask, 'id' | 'agentId' | 'openedAt'>;

/** The fields every ask of this mod starts with: Claude Code takes a message in place of any answer. */
const askBase = <K extends Ask['kind']>(kind: K, { id, agentId, openedAt }: AskCall) => ({ id, kind, agentId, openedAt, allowsReply: true });

/** One AskUserQuestion question as the ask carries it; null for a question Claude Code would not ask. Claude takes a typed answer to any question. */
function askQuestion(q: unknown): AskQuestion | null {
  const o = q && typeof q === 'object' ? (q as Obj) : null;
  const options = Array.isArray(o?.options) ? (o.options as unknown[]) : [];
  if (o === null || typeof o.question !== 'string' || options.length === 0 || options.length > L.options) return null;
  return {
    question: cutText(o.question, L.question),
    header: oneLine(o.header, L.header),
    multiSelect: o.multiSelect === true,
    options: options.map((raw) => {
      const op = (raw && typeof raw === 'object' ? raw : {}) as Obj;
      return { label: oneLine(op.label, L.label), description: cutText(op.description ?? '', L.description), preview: typeof op.preview === 'string' && op.preview ? cutText(op.preview, L.preview) : null };
    }),
    allowsText: true,
  };
}

/** A question ask from AskUserQuestion's input; null when any of its questions is one Claude Code would not ask. */
export function questionAsk(call: AskCall, input: Obj): Ask | null {
  const asked: unknown[] = Array.isArray(input.questions) ? input.questions : [];
  if (asked.length === 0 || asked.length > L.questions) return null;
  const questions = asked.map(askQuestion);
  return questions.every((q): q is AskQuestion => q !== null) ? { ...askBase('question', call), questions } : null;
}

/** A plan ask from ExitPlanMode's input, which carries `plan` and `planFilePath` (observed on Claude Code 2.1.301). */
export function planAsk(call: AskCall, input: Obj): Ask {
  const file = input.planFilePath;
  return { ...askBase('plan', call), plan: { text: cutText(input.plan ?? '', L.plan), filePath: typeof file === 'string' && file ? oneLine(file, 1024) : null } };
}

/** How deep a tool input is copied, and how many items of a list, before the rest is left out. */
const INPUT_DEPTH = 6;
const INPUT_ITEMS = 50;
/** The note a shortened string of a tool input ends with. */
const inputCut = (n: number) => ` ${cutNote(n)}`;
const INPUT_CUT = / \[cut off at [\d,]+ characters\]$/;

/** A slot of a parsed tool input that holds a string: its container and its key. */
type Slot = { holder: Record<string | number, unknown>; key: string | number };

/** Every slot of `v` that holds a string, depth first. */
function stringSlots(v: unknown, found: Slot[] = []): Slot[] {
  if (v === null || typeof v !== 'object') return found;
  const holder = v as Record<string | number, unknown>;
  for (const [key, item] of Object.entries(v)) {
    if (typeof item === 'string') found.push({ holder, key: Array.isArray(v) ? Number(key) : key });
    else stringSlots(item, found);
  }
  return found;
}

/**
 * A copy of `v` with every string redacted and held to the limit; `marks.cut` turns true once anything was redacted, shortened
 * or left out, since the owner then does not see the request as made (the ask's `cut` mark, as codex-reporter respond.ts
 * sets it).
 */
function redactedCopy(v: unknown, depth: number, marks: { cut: boolean }): unknown {
  if (typeof v === 'string') {
    const clean = redact(v);
    if (clean !== v) marks.cut = true;
    if (clean.length <= L.toolInput) return clean;
    marks.cut = true;
    return clean.slice(0, L.toolInput) + inputCut(L.toolInput);
  }
  if (v === null || typeof v !== 'object') return v;
  if (depth > INPUT_DEPTH) {
    marks.cut = true;
    return '[cut off]';
  }
  if (!Array.isArray(v)) return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, redactedCopy(item, depth + 1, marks)]));
  if (v.length > INPUT_ITEMS) marks.cut = true;
  return v.slice(0, INPUT_ITEMS).map((item) => redactedCopy(item, depth + 1, marks));
}

/** Takes `over` characters, and room for a note, off the longest string in `obj`; false when it holds no string at all. */
function shortenLongest(obj: Obj, over: number): boolean {
  const slots = stringSlots(obj);
  if (slots.length === 0) return false;
  const textAt = (slot: Slot) => String(slot.holder[slot.key]);
  const longest = slots.reduce((best, slot) => (textAt(slot).length > textAt(best).length ? slot : best));
  const whole = textAt(longest).replace(INPUT_CUT, '');
  const keep = Math.max(0, whole.length - over - 40);
  longest.holder[longest.key] = whole.slice(0, keep) + inputCut(keep);
  return true;
}

/**
 * A tool's arguments for its ask: every string redacted, and the whole held to 20,000 characters as JSON, `cut` when anything
 * was redacted or shortened (then Allow once is refused). Past the limit the longest text is shortened, with its note, until
 * the whole fits; the rest stays as it was.
 */
export function toolInput(input: unknown): { input: Obj; cut: boolean } {
  const marks = { cut: false };
  const obj: Obj = input && typeof input === 'object' && !Array.isArray(input) ? (redactedCopy(input, 0, marks) as Obj) : {};
  const overBy = () => JSON.stringify(obj).length - L.toolInput;
  // JSON escaping can only make a text count for more, so each shortening removes at least the overflow and a few passes
  // settle it; twenty is a bound, not an expectation.
  let over = overBy();
  for (let pass = 0; pass < 20 && over > 0 && shortenLongest(obj, over); pass++) {
    marks.cut = true;
    over = overBy();
  }
  return over > 0 ? { input: { note: 'The input is too long to show here.' }, cut: true } : { input: obj, cut: marks.cut };
}

/** A permission ask. Claude Code takes a Deny's reason, so the reason box shows. */
export function toolAsk(call: AskCall, tool: string, input: unknown): Ask {
  return { ...askBase('permission', call), tool: { name: oneLine(tool, 120), ...toolInput(input), denyReason: true } };
}

/** An AskUserQuestion question as Claude asked it, unredacted. */
export type AskedQuestion = { question: string; options: readonly { label: string }[] };

/**
 * Claude Code's `answers` map from a delivery's answers by position, against the questions as Claude asked them (not the
 * redacted copy the dashboard saw): an option's label, a multi-select's labels joined with ", ", or the typed text. A
 * skipped question is left out.
 */
export function answersByQuestion(asked: readonly AskedQuestion[], given: readonly QuestionAnswer[]): Record<string, string> {
  const map: Record<string, string> = {};
  asked.forEach((q, index) => {
    const answer = given[index];
    if (!answer) return;
    if ('text' in answer) {
      map[q.question] = answer.text;
      return;
    }
    const labels = answer.options.map((n) => q.options[n]?.label).filter((label): label is string => typeof label === 'string');
    if (labels.length > 0) map[q.question] = labels.join(', ');
  });
  return map;
}

/**
 * The PermissionRequest decision that approves a plan from the dashboard. `updatedInput` is the event's own `tool_input`,
 * unchanged: without it Claude Code ignores the allow for ExitPlanMode (anthropics/claude-code#97656). The only `setMode`
 * the reporter ever sends.
 */
export function planApproval(toolInput: Obj, mode: PlanMode) {
  const setMode = { type: 'setMode' as const, mode, destination: 'session' as const };
  return { decision: { behavior: 'allow' as const, updatedInput: toolInput, updatedPermissions: [setMode] } };
}

/** What a Deny from the dashboard says when no reason was given. */
export const DENIED_FROM_DASHBOARD = 'Denied from the dashboard.';

/** A tool's decision from the dashboard: allow once, or deny with its reason. Never `updatedPermissions`, never `interrupt`. */
export const toolDecision = (d: Delivery): { decision: { behavior: 'allow' } | { behavior: 'deny'; message: string } } =>
  d.kind === 'allow-once' ? { decision: { behavior: 'allow' } } : { decision: { behavior: 'deny', message: d.text?.trim() || DENIED_FROM_DASHBOARD } };

/** A message sent in place of a tool's answer is a Deny with that message. */
export const asDecision = (d: Delivery): Delivery => (d.kind === 'reply' ? { ...d, kind: 'deny' } : d);

/**
 * "No, keep planning", or a message in place of an answer, for ExitPlanMode's `tool.call`: framed as the terminal frames
 * "Tell Claude what to change" and naming the dashboard (bare text read to Claude as an injected instruction on 2.1.301).
 */
export const planFeedback = (d: Delivery): { deny: string } => {
  const text = d.text?.trim() ?? '';
  const lead = "The user doesn't want to proceed with this plan yet.";
  return { deny: text ? `${lead} They sent this from the dashboard: ${text}` : `${lead} They chose "No, keep planning" from the dashboard.` };
};

/** Whether a rejected ExitPlanMode was dismissed in the terminal (Esc) rather than sent back with "Tell Claude what to change" (observed on Claude Code 2.1.301). */
export const planDismissed = (text: string | undefined): boolean => !/the user said:/i.test(text ?? '');

/** What the terminal's No, or a hook's deny, leaves as a refused call's text. */
const DENIED_TEXT = /doesn't want to proceed with this tool use|Denied by PermissionRequest hook|Permission to use .* (?:has been|was) denied/i;

/** Whether a tool call ended refused by a permission decision (the terminal's No, or a hook's deny) rather than run. */
export function toolDenied(res: { deny?: unknown; isError?: unknown; text?: unknown } | null | undefined, sent?: string): boolean {
  if (res?.deny !== undefined) return true;
  if (res?.isError !== true) return false;
  const text = typeof res.text === 'string' ? res.text : '';
  // A PermissionRequest deny ends the call as an error carrying only the deny's own message (observed live on Claude Code
  // 2.1.301), so this mod knows its own Deny by the message it sent.
  return (!!sent && text.includes(sent)) || DENIED_TEXT.test(text);
}

/** `v` without any "(Recommended)" mark (in any letter case) or the spaces before one; a single pass, so linear on any input. */
function dropRecommended(v: string): string {
  const mark = '(recommended)';
  const kept: string[] = [];
  let from = 0;
  for (let open = v.indexOf('('); open !== -1; open = v.indexOf('(', open + 1)) {
    if (v.slice(open, open + mark.length).toLowerCase() !== mark) continue;
    kept.push(v.slice(from, open).trimEnd());
    from = open + mark.length;
  }
  kept.push(v.slice(from));
  return kept.join('');
}

/** A short summary of a question answered in the terminal, for "Answered in the terminal" (at most 2,000 characters). */
export function terminalSummary(result: unknown): string | null {
  const answers: unknown = (result as { result?: { answers?: unknown } } | null)?.result?.answers;
  const given = answers && typeof answers === 'object' ? Object.values(answers).filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
  const joined = given.map(dropRecommended).join('; ');
  return joined === '' ? null : oneLine(joined, L.answer);
}

/** The transcript line after an answer from the dashboard: what it did, who sent it, and when (`HH:MM`, local time). */
export const answeredLine = (d: Delivery, at: number): string => `${VERBS[d.kind]} from the dashboard by ${d.by} at ${wallClock(at, false)}`;
