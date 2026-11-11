// Codex session files: where they are, which one belongs to a thread, and what one record says.
// Read-only throughout: Codex owns `~/.codex`, its files and its SQLite, so another program may only read them, and nothing
// here opens anything for writing. Record shapes are Codex's own (`codex-rs/history` RolloutLine, `protocol` EventMsg,
// `rollout/src/policy.rs`); unknown fields and record types are ignored.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { LIMITS, RESPOND_LIMITS } from '../../server/src/fleet/protocol.js';
import { activityText, clip, clipFreeText, excerpt, promptName, redact, summarizeCall } from './report.js';
import type { Line } from './spool.js';

/** `$CODEX_HOME`, else `~/.codex`, as Codex finds its home (`utils/home-dir/src/lib.rs:13-40`). */
export function codexHome(): string {
  const env = process.env.CODEX_HOME?.trim();
  return env ? path.resolve(env) : path.join(os.homedir(), '.codex');
}

/**
 * The thread id of a rollout file name, compressed or not: `rollout-<YYYY-MM-DDThh-mm-ss>-<thread>[_<rollout>].jsonl[.zst]`
 * (`rollout_file_name.rs`; a reverted thread's new file carries a rollout id after its own).
 */
export function threadOfFile(name: string): string | null {
  const plain = name.endsWith('.zst') ? name.slice(0, -'.zst'.length) : name;
  if (!plain.startsWith('rollout-') || !plain.endsWith('.jsonl')) return null;
  const core = plain.slice('rollout-'.length, -'.jsonl'.length);
  if (core[19] !== '-') return null;
  const id = core.slice(20).split('_')[0] ?? '';
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export interface RolloutFile {
  path: string;
  thread: string;
  mtimeMs: number;
}

/**
 * Every rollout file under `sessions`, plain and compressed. Codex compresses a file cold for 7 days to `.jsonl.zst`, keeping
 * its mtime, and writes the plain file again before it appends after a resume; a compressed file is left out while its plain
 * sibling exists, as Codex reads them (`rollout/src/compression.rs:99-183, 211-241, 853-975, 1334-1336`).
 */
export function listRollouts(home: string): RolloutFile[] {
  const out: RolloutFile[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
        continue;
      }
      const thread = threadOfFile(e.name);
      if (!thread || (e.name.endsWith('.zst') && names.has(e.name.slice(0, -'.zst'.length)))) continue;
      try {
        out.push({ path: p, thread, mtimeMs: fs.statSync(p).mtimeMs });
      } catch {
        // gone since the listing (compressed or restored): the next scan finds it as it is now
      }
    }
  };
  walk(path.join(home, 'sessions'), 0);
  return out;
}

/**
 * A rollout file's lines, plain or compressed, streamed: a compressed one through Node's own zstd decoder, so no whole file is
 * held in memory and the reporter's tick is never held up by it. `at` is each line's byte offset in the decompressed file.
 */
export async function* fileLines(file: string): AsyncGenerator<Line> {
  // pipeline passes a read error on to the decoder, whose error ends the iteration below: its callback has nothing left to do.
  const input = file.endsWith('.zst') ? pipeline(fs.createReadStream(file), zlib.createZstdDecompress(), () => undefined) : fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let at = 0;
  try {
    for await (const text of lines) {
      yield { text, at };
      at += Buffer.byteLength(text) + 1;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * The session a rollout file belongs to, from its first line: `session_meta.session_id`, the session tree's root, else the
 * thread's own `id`. Null while the file has no complete first line.
 */
export async function sessionOfFile(file: string): Promise<string | null> {
  for await (const line of fileLines(file)) {
    const r = parseRolloutLine(line.text, line.at)?.record;
    return r?.kind === 'meta' ? (r.sessionId ?? r.id) : null;
  }
  return null;
}

/** Codex's own thread names by thread id (threadNames), and the state of the index file they were read from. */
export interface ThreadNames {
  /** The index's inode, size and mtime when read; empty when there was none to read. */
  stamp: string;
  byId: ReadonlyMap<string, string>;
}

export const NO_NAMES: ThreadNames = { stamp: '', byId: new Map() };

/**
 * The names Codex keeps for its threads, in `$CODEX_HOME/session_index.jsonl` (`rollout/src/session_index.rs:20-33`): one
 * `{ id, thread_name, updated_at }` line is appended each time a thread is named or renamed, and an id's newest nonempty name
 * is its name (`:137-170`); dropping a thread's names rewrites the file (`:73-105`). Read whole only when the file's inode,
 * size or mtime differs from `last`'s, else `last` itself is returned, so a caller sees a change by identity. No file, or one
 * that cannot be read now, holds no names.
 */
export function threadNames(home: string, last: ThreadNames): ThreadNames {
  const file = path.join(home, 'session_index.jsonl');
  const byId = new Map<string, string>();
  let stamp = '';
  try {
    const st = fs.statSync(file);
    stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (stamp === last.stamp) return last;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const e = parseJson(line);
      const name = typeof e?.thread_name === 'string' ? e.thread_name.trim() : '';
      if (name && typeof e?.id === 'string') byId.set(e.id, name);
    }
  } catch {
    stamp = '';
  }
  return stamp === last.stamp ? last : { stamp, byId };
}

// ---- one record ---------------------------------------------------------------------------------

export interface RawUsage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  /** `reasoning_output_tokens`: read only to recognize Codex's fill to the window (mapping.ts isWindowFill). */
  reasoning: number;
  total: number;
}

export interface RawWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

/** What one session-file record says, in the reporter's terms. Free text is already cut and redacted: nothing longer is kept. */
export type RolloutRecord =
  | {
      kind: 'meta';
      id: string;
      sessionId: string | null;
      parentId: string | null;
      nickname: string | null;
      role: string | null;
      /** The agent path a multi-agent v2 spawn gave the thread (`/root/<task>`…), what a v2 message names it by; null otherwise. */
      agentPath: string | null;
      startedAt: number | null;
      cwd: string | null;
      cliVersion: string | null;
      /** `session_meta.originator`: the client that started the thread (`Codex Desktop` for the desktop app, `codex-tui` …). */
      originator: string | null;
      historyMode: 'legacy' | 'paginated' | null;
    }
  | { kind: 'turnContext'; model: string | null; effort: string | null; cwd: string | null }
  | { kind: 'turnStarted'; turnId: string | null; contextWindow: number | null }
  | { kind: 'turnEnded'; aborted: boolean; failed: boolean; errorCategory: string | null; answer: string | null }
  | { kind: 'tokens'; total: RawUsage | null; last: RawUsage | null; window: number | null; primary: RawWindow | null; secondary: RawWindow | null; hasLimits: boolean }
  /** One billed model response's own tokens (`token_usage_record`, Codex `protocol/src/protocol.rs:2391-2402`). */
  | { kind: 'usage'; threadId: string; responseId: string; usage: RawUsage }
  | {
      kind: 'call';
      callId: string;
      name: string;
      summary: string;
      plan: { step: string; status: string }[] | null;
      spawnPrompt: string | null;
      paths: string[];
      /** A valid `request_user_input_async` call's questions. */
      questions?: AsyncQuestion[];
      /** What a call that sends another agent of the session a message sends, and to whom. */
      message?: SentMessage;
    }
  /** `accepted`: the output is Codex's `{"accepted":true}`, which an async question call returns when it is shown. */
  | { kind: 'callOutput'; callId: string; spawnedId: string | null; accepted: boolean }
  | { kind: 'command'; id: string; summary: string; status: string; exitCode: number | null }
  | { kind: 'fileChange'; id: string; paths: string[] }
  | { kind: 'spawned'; prompt: string; receivers: string[] }
  | { kind: 'message'; text: string }
  /** A user message that is the reply envelope of async questions: only the question ids it answers are kept. */
  | { kind: 'questionReply'; ids: string[] }
  /** A user message's text, redacted as free text and cut to a session name's length (promptOf); nothing else of it is kept. */
  | { kind: 'prompt'; text: string };

/**
 * One `request_user_input_async` question as its ask needs it: the title, redacted and bounded, and the option labels the
 * dashboard can show unaltered, kept as written so a chosen one is sent back exactly (nothing else is kept).
 */
export interface AsyncQuestion {
  title: string;
  options: string[];
}

/**
 * One agent's message to another: `target` as the call names it (an agent id, or a v2 agent path or task name),
 * redacted and cut to LIMITS.short; `text` the message, redacted and cut to LIMITS.text, empty when Codex holds it encrypted.
 */
export interface SentMessage {
  target: string;
  text: string;
}

export interface ParsedLine {
  ts: number;
  /** A stable key for the record within its file: its ordinal, else its byte offset. */
  key: string;
  record: RolloutRecord;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The record types and payload types the reporter reads; every other line is skipped without being parsed. */
const WANTED_EVENTS = new Set(['task_started', 'task_complete', 'turn_aborted', 'token_count', 'item_completed', 'agent_message', 'patch_apply_end', 'user_message']);
const WANTED_ITEMS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'function_call_output', 'custom_tool_call_output']);
const HEAD = /"type":"([a-z_]+)"(?:,"payload":\{"type":"([A-Za-z_]+)")?/;
/** The markers of the reply envelope the Codex desktop app and TUI answer async questions with (`context-fragments/src/answered_question.rs:41-46`). */
export const REPLY_OPEN = '<send_user_message_question_reply>';
export const REPLY_CLOSE = '</send_user_message_question_reply>';

/**
 * One session-file line in the reporter's terms; null for a line it does not read. `usageOnly`: only usage records and the
 * `turn_context`s that name their model are read (a thread's older files). Never throws.
 */
export function parseRolloutLine(text: string, at: number, usageOnly = false): ParsedLine | null {
  const head = HEAD.exec(text.slice(0, 400));
  if (usageOnly && head?.[1] !== 'turn_context' && head?.[1] !== 'token_usage_record') return null;
  if (head) {
    const [, type, sub] = head;
    if (type !== 'session_meta' && type !== 'turn_context' && type !== 'event_msg' && type !== 'response_item' && type !== 'token_usage_record') return null;
    if (type === 'event_msg' && sub && !WANTED_EVENTS.has(sub)) return null;
    // A message is read only when it may be a reply to async questions; the envelope's markers are never JSON-escaped.
    if (type === 'response_item' && sub && !WANTED_ITEMS.has(sub) && !(sub === 'message' && text.includes(REPLY_OPEN))) return null;
  }
  let line: Obj | null;
  try {
    line = obj(JSON.parse(text));
  } catch {
    return null;
  }
  if (!line) return null;
  const ts = Date.parse(String(line.timestamp ?? ''));
  const payload = obj(line.payload);
  if (!Number.isFinite(ts) || !payload) return null;
  const ordinal = num(line.ordinal);
  const record = recordOf(String(line.type ?? ''), payload);
  return record ? { ts, key: ordinal !== null ? `o${ordinal}` : `b${at}`, record } : null;
}

function usageOf(v: unknown): RawUsage | null {
  const u = obj(v);
  if (!u) return null;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null || output === null) return null;
  return {
    input,
    cached: num(u.cached_input_tokens) ?? 0,
    cacheWrite: num(u.cache_write_input_tokens) ?? 0,
    output,
    reasoning: num(u.reasoning_output_tokens) ?? 0,
    total: num(u.total_tokens) ?? input + output,
  };
}

function windowOf(v: unknown): RawWindow | null {
  const w = obj(v);
  const used = num(w?.used_percent);
  return w && used !== null ? { usedPercent: used, windowMinutes: num(w.window_minutes), resetsAt: num(w.resets_at) } : null;
}

/**
 * `codex_error_info` as Codex serializes it: a snake_case name, or `{ "<name>": { … } }` for a variant with fields. Null when
 * the error has none: it is then not an API failure category, whatever else it says.
 */
function errorCategory(v: unknown): string | null {
  const info = obj(v)?.codex_error_info;
  if (typeof info === 'string') return info || null;
  const o = obj(info);
  return (o && Object.keys(o)[0]) || null;
}

/** The file paths an `apply_patch` body names (`*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`); the body itself is not kept. */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
    const p = m[1]!.trim();
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= 50) break;
  }
  return out;
}

function parseJson(text: string): Obj | null {
  try {
    return obj(JSON.parse(text));
  } catch {
    return null;
  }
}

/** A shell command's argv as one line: the script of `<shell> -lc <script>`, else the words joined. */
function commandLine(argv: unknown): string {
  if (!Array.isArray(argv)) return typeof argv === 'string' ? argv : '';
  const words = argv.filter((w): w is string => typeof w === 'string');
  if (words.length === 3 && /^-l?c$/.test(words[1]!)) return words[2]!;
  return words.join(' ');
}

function recordOf(type: string, p: Obj): RolloutRecord | null {
  if (type === 'session_meta') {
    const id = str(p.id);
    if (!id) return null;
    const source = p.source;
    const spawn = obj(obj(obj(source)?.subagent)?.thread_spawn);
    const mode = p.history_mode === 'paginated' ? 'paginated' : p.history_mode === 'legacy' ? 'legacy' : null;
    const started = Date.parse(String(p.timestamp ?? ''));
    return {
      kind: 'meta',
      id,
      sessionId: str(p.session_id),
      parentId: str(spawn?.parent_thread_id) ?? str(p.parent_thread_id),
      nickname: str(spawn?.agent_nickname) ?? str(p.agent_nickname),
      role: str(spawn?.agent_role) ?? str(p.agent_role),
      agentPath: str(spawn?.agent_path),
      startedAt: Number.isFinite(started) ? started : null,
      cwd: str(p.cwd),
      cliVersion: str(p.cli_version),
      originator: str(p.originator),
      // A rollout without the field predates paginated history (`#[serde(default)]` is legacy).
      historyMode: mode ?? (p.history_mode === undefined ? 'legacy' : null),
    };
  }
  if (type === 'turn_context') {
    return { kind: 'turnContext', model: str(p.model), effort: str(p.effort), cwd: str(p.cwd) };
  }
  if (type === 'token_usage_record') {
    // Only `usage`, the response's own tokens: `turn_token_usage` and `thread_token_usage` beside it are running totals.
    const threadId = str(p.thread_id);
    const responseId = str(p.response_id);
    const usage = usageOf(p.usage);
    return threadId && responseId && usage ? { kind: 'usage', threadId, responseId, usage } : null;
  }
  if (type === 'event_msg') {
    switch (p.type) {
      case 'task_started':
        return { kind: 'turnStarted', turnId: str(p.turn_id), contextWindow: num(p.model_context_window) };
      // `error` is the turn's terminal error (a failed turn); its `codex_error_info`, when present, is the category.
      case 'task_complete':
        return { kind: 'turnEnded', aborted: false, failed: !!p.error, errorCategory: errorCategory(p.error), answer: str(p.last_agent_message) ? excerpt(p.last_agent_message as string) : null };
      case 'turn_aborted':
        return { kind: 'turnEnded', aborted: true, failed: !!p.error, errorCategory: errorCategory(p.error), answer: null };
      case 'token_count': {
        const info = obj(p.info);
        const limits = obj(p.rate_limits);
        return {
          kind: 'tokens',
          total: usageOf(info?.total_token_usage),
          last: usageOf(info?.last_token_usage),
          window: num(info?.model_context_window),
          primary: windowOf(limits?.primary),
          secondary: windowOf(limits?.secondary),
          hasLimits: limits !== null,
        };
      }
      case 'agent_message':
        return str(p.message) ? { kind: 'message', text: activityText(p.message as string) } : null;
      // A legacy-history thread's user message; a paginated one's is an `item_completed` UserMessage (itemOf).
      case 'user_message':
        return promptOf(str(p.message) ?? '');
      case 'patch_apply_end': {
        const changes = obj(p.changes);
        return changes ? { kind: 'fileChange', id: str(p.call_id) ?? '', paths: Object.keys(changes).slice(0, 50) } : null;
      }
      case 'item_completed':
        return itemOf(obj(p.item));
      default:
        return null;
    }
  }
  if (type === 'response_item') return responseItemOf(p);
  return null;
}

/** A paginated-history item (`TurnItem`, tagged with its PascalCase variant name). */
function itemOf(item: Obj | null): RolloutRecord | null {
  if (!item) return null;
  switch (item.type) {
    case 'CommandExecution':
      return { kind: 'command', id: str(item.id) ?? '', summary: summarizeCall('Shell', { command: commandLine(item.command) }), status: String(item.status ?? ''), exitCode: num(item.exit_code) };
    case 'FileChange': {
      const changes = obj(item.changes);
      return changes ? { kind: 'fileChange', id: str(item.id) ?? '', paths: Object.keys(changes).slice(0, 50) } : null;
    }
    case 'CollabAgentToolCall': {
      if (item.tool !== 'spawn_agent') return null;
      const receivers = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.filter((r): r is string => typeof r === 'string') : [];
      return receivers.length ? { kind: 'spawned', prompt: excerpt(str(item.prompt) ?? ''), receivers } : null;
    }
    case 'AgentMessage': {
      const parts = Array.isArray(item.content) ? item.content.map((c) => str(obj(c)?.text) ?? '').filter(Boolean) : [];
      return parts.length ? { kind: 'message', text: activityText(parts.join(' ')) } : null;
    }
    // Its text inputs joined, as Codex's `UserMessageItem::message` joins them (`protocol/src/items.rs:545-554`; only the text
    // input has a `text`, `protocol/src/user_input.rs:16-57`).
    case 'UserMessage':
      return promptOf(Array.isArray(item.content) ? item.content.map((c) => str(obj(c)?.text) ?? '').join('') : '');
    default:
      return null;
  }
}

/** Where an IDE extension's user message starts what the user typed, after the context it prepends (`protocol/src/protocol.rs:148`). */
const USER_MESSAGE_BEGIN = '## My request for Codex:';

/**
 * A user message as a session name: its text as Codex previews a thread's first user message in its thread list
 * (`protocol/src/protocol.rs:150-156, 2743-2747` user_message_preview, read by `rollout/src/list.rs:1061-1076`) — what follows
 * an IDE context's USER_MESSAGE_BEGIN, trimmed — then redacted as free text and cut to a name's length (report.ts promptName).
 * Null for a message with no text (Codex's `[Image]` and `[Audio]` placeholders name nothing) and for a reply to async
 * questions, which answers rather than asks.
 */
function promptOf(text: string): RolloutRecord | null {
  const at = text.indexOf(USER_MESSAGE_BEGIN);
  const own = (at === -1 ? text : text.slice(at + USER_MESSAGE_BEGIN.length)).trim();
  const name = own && !questionReplyIds(text) ? promptName(own, LIMITS.name) : '';
  return name ? { kind: 'prompt', text: name } : null;
}

/** How many questions, and options per question, a call keeps: past the ask's limits it is not announced anyway. */
const QUESTIONS_KEPT = 8;

/**
 * The questions of a `request_user_input_async` call, checked as Codex checks them before it shows any
 * (`core/src/tools/handlers/request_user_input_async.rs:29-33, 106-129`; `protocol/src/items.rs:144-150`, both
 * `deny_unknown_fields`): null when Codex would refuse the call and show nothing. Titles and labels are kept redacted and
 * bounded; nothing else of the call is.
 */
function asyncQuestionsOf(args: Obj | null): AsyncQuestion[] | null {
  if (!args || Object.keys(args).some((k) => k !== 'questions') || !Array.isArray(args.questions) || args.questions.length === 0) return null;
  const out: AsyncQuestion[] = [];
  for (const raw of args.questions) {
    const q = obj(raw);
    if (!q || Object.keys(q).some((k) => k !== 'title' && k !== 'options') || typeof q.title !== 'string' || !q.title.trim()) return null;
    const options = q.options ?? null;
    if (options !== null && (!Array.isArray(options) || options.length === 0 || options.some((o) => typeof o !== 'string' || !o.trim()))) return null;
    out.push({ title: clip(q.title, 2000), options: ((options ?? []) as string[]).slice(0, 32).filter(showsUnaltered).slice(0, QUESTIONS_KEPT) });
  }
  return out.slice(0, QUESTIONS_KEPT);
}

/**
 * Whether the dashboard can show an option label exactly as written — within 512 bytes and our label limit, on one line with
 * no whitespace to fold, nothing redaction would change. Codex's TUI keeps at most 32 options, drops any label over 512
 * bytes, and lets only a fully displayed option become the answer (`tui/src/bottom_pane/async_questions/state.rs:29-39,
 * 121-130`); an option the dashboard would have to alter is dropped the same way, never shown altered.
 */
function showsUnaltered(label: string): boolean {
  return Buffer.byteLength(label) <= 512 && label.length <= RESPOND_LIMITS.label && redact(label.replace(/\s+/g, ' ').trim()) === label;
}

/**
 * The question ids a user message's text answers, parsed as Codex's TUI recognizes the desktop's replies from any client
 * (`tui/src/async_question_reply.rs:15-37`): the text trimmed, past an optional IDE-context prefix, must be exactly the reply
 * envelope around one reply or an array of them, each with string `questionItemId`, `question` and `answer`. Null otherwise.
 */
export function questionReplyIds(text: string): string[] | null {
  let t = text.trim();
  if (t.startsWith('# Context from my IDE setup:\n')) {
    const at = t.lastIndexOf('\n## My request for Codex:\n');
    if (at === -1) return null;
    t = t.slice(at + '\n## My request for Codex:\n'.length).trim();
  }
  if (!t.startsWith(REPLY_OPEN) || !t.endsWith(REPLY_CLOSE) || t.length < REPLY_OPEN.length + REPLY_CLOSE.length) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t.slice(REPLY_OPEN.length, t.length - REPLY_CLOSE.length));
  } catch {
    return null;
  }
  const replies = Array.isArray(parsed) ? parsed : [parsed];
  const ids: string[] = [];
  for (const r of replies) {
    const o = obj(r);
    if (!o || typeof o.questionItemId !== 'string' || typeof o.question !== 'string' || typeof o.answer !== 'string') return null;
    ids.push(o.questionItemId);
  }
  return ids.length ? ids : null;
}

/** Codex's shell tools (exec_command, core/src/tools/handlers/shell_spec.rs:89; shell and shell_command before it). */
const SHELL_TOOLS = new Set(['exec_command', 'shell', 'shell_command']);

/**
 * The namespaces Codex dispatches its message tools from: v1's fixed one (`core/src/tools/handlers/multi_agents_spec.rs:14`) and
 * v2's default (`core/src/config/mod.rs:263`; a v2 namespace configured otherwise is not recognized). The same names in any
 * other namespace (an MCP server's `send_message`) are not messages between agents.
 */
const MULTI_AGENT_V1 = 'multi_agent_v1';
const MULTI_AGENT_V2 = 'collaboration';

/**
 * The message a function call sends another agent of its session, null for any other call. Codex's message tools:
 * v1 `send_input` — `{ target, message?, items? }`, the target an agent id (`handlers/multi_agents/send_input.rs:146-153`),
 * the input a message or items, shown as Codex previews it for "Sent input to" (`agent/control.rs:739-760`, item paths left
 * out); v2 `send_message` and `followup_task` — `{ target, message }`, the target an agent id or a task name or path
 * (`handlers/multi_agents_v2/message_tool.rs:16-30`). A v2 message may reach the session file encrypted; it is shown only when
 * Codex itself takes it as plain text — the call's `encrypted_function_args` present and empty (`tools/router.rs:56-71`,
 * `handlers/multi_agents_v2.rs:54-67`) — and is otherwise left empty, unknown.
 */
function messageOf(p: Obj, args: Obj): SentMessage | null {
  // The tool's own name, without the namespace a call's name carries.
  const name = str(p.name);
  const v1 = name === 'send_input' && p.namespace === MULTI_AGENT_V1;
  const v2 = (name === 'send_message' || name === 'followup_task') && p.namespace === MULTI_AGENT_V2;
  const target = str(args.target);
  if (!(v1 || v2) || !target) return null;
  let text: string;
  if (v2) {
    const plain = Array.isArray(p.encrypted_function_args) && p.encrypted_function_args.length === 0;
    text = plain ? (str(args.message) ?? '') : '';
  } else if (typeof args.message === 'string') {
    text = args.message;
  } else if (Array.isArray(args.items)) {
    text = args.items
      .map((item) => {
        const o = obj(item);
        return o?.type === 'text' ? (str(o.text) ?? '') : `[${str(o?.type) ?? 'input'}]`;
      })
      .join('\n');
  } else return null;
  // The message is a tool's free-text argument: the broader rules, then the narrow ones.
  return { target: excerpt(target, LIMITS.short), text: clipFreeText(text.replace(/\s+/g, ' ').trim(), LIMITS.text) };
}

function responseItemOf(p: Obj): RolloutRecord | null {
  if (p.type === 'message') {
    // Like the TUI's parse_input: a user message whose only content is one text (`tui/src/async_question_reply.rs:49-60`).
    const content = Array.isArray(p.content) ? p.content : [];
    const only = content.length === 1 ? obj(content[0]) : null;
    const ids = p.role === 'user' && only?.type === 'input_text' && typeof only.text === 'string' ? questionReplyIds(only.text) : null;
    return ids ? { kind: 'questionReply', ids: ids.slice(0, 50).map((id) => id.slice(0, 600)) } : null;
  }
  const callId = str(p.call_id);
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    if (!callId) return null;
    // Only a spawn_agent result's child and an async question call's acceptance are read; nothing else in an output is.
    const out = typeof p.output === 'string' ? parseJson(p.output) : null;
    return { kind: 'callOutput', callId, spawnedId: str(out?.agent_id), accepted: out?.accepted === true };
  }
  if (p.type === 'local_shell_call') {
    const action = obj(p.action);
    return callId ? { kind: 'call', callId, name: 'local_shell', summary: summarizeCall('Shell', { command: commandLine(action?.command) }), plan: null, spawnPrompt: null, paths: [] } : null;
  }
  // A namespaced call keeps its namespace (an MCP tool reads `mcp__<server>__<tool>`, as Codex names it to hooks), so no
  // server's tool takes a built-in's name. Codex's own V1 spawn keeps the name `spawn_agent`, as Codex names it to hooks
  // (registry.rs:1030-1036).
  const ns = str(p.namespace);
  const own = str(p.name);
  const name = own && ns && ns !== 'functions' && !(ns === 'multi_agent_v1' && own === 'spawn_agent') ? `${ns}__${own}` : own;
  if (!callId || !name) return null;
  // A shell tool's call is summarized as `Shell`, as a local_shell_call is, so its command gets the free-text rules.
  const tool = SHELL_TOOLS.has(name) ? 'Shell' : name;
  if (p.type === 'custom_tool_call') {
    const input = typeof p.input === 'string' ? p.input : '';
    if (name === 'apply_patch') return { kind: 'call', callId, name, summary: summarizeCall(name, {}), plan: null, spawnPrompt: null, paths: patchPaths(input) };
    return { kind: 'call', callId, name, summary: summarizeCall(tool, { input }), plan: null, spawnPrompt: null, paths: [] };
  }
  const args = typeof p.arguments === 'string' ? (parseJson(p.arguments) ?? {}) : {};
  if (name === 'update_plan') {
    const steps = Array.isArray(args.plan)
      ? args.plan.map((s) => obj(s)).filter((s): s is Obj => !!s && typeof s.step === 'string').map((s) => ({ step: s.step as string, status: String(s.status ?? 'pending') }))
      : [];
    return { kind: 'call', callId, name, summary: summarizeCall(name, {}), plan: steps, spawnPrompt: null, paths: [] };
  }
  if (name === 'spawn_agent') {
    const message = str(args.message) ?? '';
    return { kind: 'call', callId, name, summary: summarizeCall(name, { agent_type: args.agent_type ?? '' }), plan: null, spawnPrompt: excerpt(message), paths: [] };
  }
  if (name === 'apply_patch') {
    return { kind: 'call', callId, name, summary: summarizeCall(name, {}), plan: null, spawnPrompt: null, paths: patchPaths(str(args.input) ?? str(args.patch) ?? '') };
  }
  if (name === 'request_user_input_async') {
    // The call id is the id of the agent message that carries the questions (request_user_input_async.rs:131-140).
    const questions = asyncQuestionsOf(typeof p.arguments === 'string' ? parseJson(p.arguments) : null);
    return { kind: 'call', callId, name, summary: summarizeCall(name, {}), plan: null, spawnPrompt: null, paths: [], ...(questions ? { questions } : {}) };
  }
  const message = messageOf(p, args);
  // Summarized by its target, as a spawn by its agent type: the message itself is the event's.
  if (message) return { kind: 'call', callId, name, summary: summarizeCall(tool, { target: message.target }), plan: null, spawnPrompt: null, paths: [], message };
  return { kind: 'call', callId, name, summary: summarizeCall(tool, args), plan: null, spawnPrompt: null, paths: [] };
}
