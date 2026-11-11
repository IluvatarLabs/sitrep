// Responding to daemon-hosted Codex threads from the dashboard, on the server's respond routes and with the
// Claude reporter's mechanics: announce an ask (PUT), wait for its answer on the held request (GET …/answer?wait=20), close it
// with `terminal` when the terminal answers first, and post what became of every delivery. Messages and /compact arrive in
// report replies.
//
// The daemon is told nothing except the exact answer the dashboard gave to an open ask (`daemon.answer`), an owner's
// message (`turn/start`; an answer to an async question is one, steered with `turn/steer` into the turn that runs) or
// `/compact` (`thread/compact/start`). A thread is rejoined only to act — when its status changes into a
// waiting flag, when a reply turns responding on, or to deliver a message, an answer or `/compact` — only if it is loaded and
// known not to be ephemeral, and is left once the request resolves or the command was accepted.
import { setTimeout as sleep } from 'node:timers/promises';
import { acceptsFor, RESPOND_LIMITS, sessionKey, type Ask, type AskQuestion, type Delivery, type DeliveryResult, type RespondInfo, type RespondKind, type RespondLevel, type RespondLimit } from '../../server/src/fleet/protocol.js';
import type {
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
  PermissionsRequestApprovalParams,
  RequestId,
  RequestPermissionProfile,
  ServerRequestMethod,
  ToolRequestUserInputParams,
  ToolRequestUserInputQuestion,
} from './codex-protocol/v2.js';
import type { Daemon } from './daemon.js';
import type { Fleet, Session, Thread } from './mapping.js';
import { REPLY_CLOSE, REPLY_OPEN, type AsyncQuestion } from './sessionFiles.js';
import { clip, clipFreeText, redact } from './report.js';
import { isDelivery, retryDelay, serverCall, type HttpResult, type Transport } from './transport.js';

const L = RESPOND_LIMITS;
const OUTBOX_MAX = 50;
const ACTED_KEPT = 100;
/** A rejoin that brings no request this reporter maps is left after this long, so no subscription lingers. */
const LEAVE_EMPTY_MS = 5000;
/** How long a file approval waits for our hook's paths: the async PreToolUse hook can land just after the request. */
const HOOK_WAIT_MS = 2000;
/** The wait note of a secret question, which the dashboard never takes; the band already says where to answer ("Answer in its terminal."). */
export const SECRET_NOTE = 'A secret question, typed in the terminal only.';
/**
 * What a thread's `session_meta.originator` adds beside `observe-only` when the daemon does not host it: `desktop-app` for one
 * the Codex desktop app started (observed in its session files), `not-interactive` for a `codex exec` run, whose process
 * sets the originator `codex_exec` (`exec/src/lib.rs:268`) that a new thread takes (`core/src/thread_manager.rs:2015-2024`).
 * A Map, so an originator such as `constructor` matches nothing.
 */
const ORIGINATOR_LIMIT: ReadonlyMap<string, RespondLimit> = new Map([
  ['Codex Desktop', 'desktop-app'],
  ['codex_exec', 'not-interactive'],
]);

/** An ask's route under its session's. */
const askPath = (a: { ask: Ask }) => `/asks/${encodeURIComponent(a.ask.id)}`;

/** What a cut text ends with, worded as the Claude reporter words it: "[cut off at 40,000 characters]". */
const cutMark = (max: number) => `[cut off at ${max.toLocaleString('en-US')} characters]`;

/** `text` if it fits in `max` characters, else its first `max` followed by `marker`. */
const fit = (text: string, max: number, marker = '') => (text.length <= max ? text : text.slice(0, max) + marker);

/** A block of an ask (a question, an option's description): redacted, line breaks kept (CRLF as LF), a cut one marked as cut. */
const block = (v: unknown, max: number) => fit(redact(String(v ?? '').replace(/\r\n?/g, '\n')), max, `\n\n${cutMark(max)}`);

/** A one-line field of an ask (a header, a label): redacted, whitespace folded to single spaces, cut without a marker. */
const oneLine = (v: unknown, max: number) => fit(redact(String(v ?? '').replace(/\s+/g, ' ').trim()), max);

/** How deep, and how many array items, a tool's arguments are shown before the rest is left out. */
const INPUT_DEPTH = 6;
const INPUT_ITEMS = 50;

/**
 * A tool's arguments as an ask shows them: every string redacted (a file approval's `patch` line by line, so no rule reaches
 * across a line break and each line of the diff is judged on its own) and held to RESPOND_LIMITS.toolInput, nesting and arrays
 * bounded, the whole held to the same limit as JSON. `cut` says the owner is not seeing the request exactly as made — something
 * was left out or redacted — and an answer may only be to what was shown (the cut rule).
 */
export function toolInput(input: Record<string, unknown>): { input: Record<string, unknown>; cut: boolean } {
  const max = L.toolInput;
  let altered = false;
  const shown = (v: unknown, depth: number, key = ''): unknown => {
    if (typeof v === 'string') {
      const clean = depth === 1 && key === 'patch' ? v.split('\n').map((line) => redact(line)).join('\n') : redact(v);
      altered ||= clean !== v || clean.length > max;
      return fit(clean, max, ` ${cutMark(max)}`);
    }
    if (v === null || typeof v !== 'object') return v;
    if (depth > INPUT_DEPTH) {
      altered = true;
      return '[cut off]';
    }
    if (Array.isArray(v)) {
      altered ||= v.length > INPUT_ITEMS;
      return v.slice(0, INPUT_ITEMS).map((item) => shown(item, depth + 1));
    }
    // fromEntries, not assignment, so a `__proto__` key stays a plain key.
    return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, shown(item, depth + 1, key)]));
  };
  const out = shown(input, 0) as Record<string, unknown>;
  if (JSON.stringify(out).length > max) return { input: { note: 'The input is too long to show here.' }, cut: true };
  return { input: out, cut: altered };
}

/** The id Codex gives one async question: `JSON.stringify([tool name, item id, index])` (tui/src/bottom_pane/async_questions/state.rs:21-23). */
const asyncQuestionId = (callId: string, index: number) => JSON.stringify(['request_user_input_async', callId, index]);

/**
 * The ask for an async question call: each title as the question — and, cut to the header's length, as its tab label,
 * the way Codex's TUI names a question by its title (tui/src/chatwidget/questions.rs:28-31) — its options as given, a typed
 * answer always taken ("The UI always allows a free-text answer"). Null past the limits, as questionAsk, or when the call id
 * cannot be an ask id.
 */
function asyncQuestionAsk(callId: string, openedAt: number, qs: readonly AsyncQuestion[]): Ask | null {
  if (qs.length < 1 || qs.length > L.questions || qs.some((q) => q.options.length > L.options) || !callId || callId.length > 200) return null;
  const questions: AskQuestion[] = qs.map((q) => ({
    question: block(q.title, L.question),
    header: oneLine(q.title, L.header),
    multiSelect: false,
    options: q.options.map((label) => ({ label: oneLine(label, L.label), description: '', preview: null })),
    allowsText: true,
  }));
  return { id: callId, kind: 'question', agentId: null, openedAt, allowsReply: false, questions };
}

/** `text` cut to at most `max` UTF-8 bytes on a character boundary (Rust's `floor_char_boundary`). */
function cutBytes(text: string, max: number): string {
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    bytes += Buffer.byteLength(ch);
    if (bytes > max) break;
    out += ch;
  }
  return out;
}

/**
 * The message answering an async question ask, written as Codex's AnsweredQuestion writes it
 * (`context-fragments/src/answered_question.rs:17-24, 41-57`): the reply envelope around a JSON array of `{answer, question,
 * questionItemId}`, one per question answered here and not already answered by a reply in the session file (`replied`, by
 * index), the question its title cut to 512 bytes with line breaks as spaces. An answer is the typed text, or the chosen
 * option's label exactly as Codex gave it (only unaltered labels are shown), trimmed (state.rs:131-139); null when nothing is
 * left to send.
 */
function asyncReplyText(r: { callId: string; questions: readonly AsyncQuestion[] }, d: Delivery, replied: ReadonlySet<number>): string | null {
  const replies: { answer: string; question: string; questionItemId: string }[] = [];
  r.questions.forEach((q, i) => {
    const given = d.answers?.[i];
    if (!given || replied.has(i)) return;
    const label = 'options' in given ? q.options[given.options[0] ?? -1] : undefined;
    const answer = ('text' in given ? String(given.text ?? '') : (label ?? '')).trim();
    if (answer) replies.push({ answer, question: cutBytes(q.title, 512).replace(/[\n\r]/g, ' '), questionItemId: asyncQuestionId(r.callId, i) });
  });
  return replies.length ? `${REPLY_OPEN}\n${JSON.stringify(replies)}\n${REPLY_CLOSE}` : null;
}

/** The turn Codex reports active when it refuses a steer for naming another one (`tui/src/app.rs:786-808`); null otherwise. */
function activeTurnOf(err: unknown): string | null {
  const message = typeof (err as { message?: unknown } | null)?.message === 'string' ? (err as { message: string }).message : '';
  const prefix = 'expected active turn id `';
  const separator = '` but found `';
  const rest = message.startsWith(prefix) ? message.slice(prefix.length) : null;
  const at = rest?.indexOf(separator) ?? -1;
  return rest && at !== -1 && rest.endsWith('`') ? rest.slice(at + separator.length, -1) : null;
}

/**
 * Whether Codex refused a `turn/steer` in a way Codex's TUI meets by queueing or starting a new turn (`tui/src/app.rs:768-807`):
 * the active turn is not steerable (`codexErrorInfo.activeTurnNotSteerable` in the error's data), there is no active turn, or
 * (after the one retry) the expected turn is still not the active one.
 */
function steerFallsBack(err: unknown): boolean {
  const e = err as { message?: unknown; data?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : '';
  if (message === 'no active turn to steer' || message.startsWith('expected active turn id `')) return true;
  const info = (e?.data as { codexErrorInfo?: unknown } | null | undefined)?.codexErrorInfo;
  return !!info && typeof info === 'object' && 'activeTurnNotSteerable' in info;
}

interface Native {
  rpcId: RequestId;
  method: ServerRequestMethod;
  threadId: string;
  askId: string | null;
  blocking: boolean;
}

interface OpenAsk {
  ask: Ask;
  kind: RespondKind;
  sessionId: string;
  threadId: string;
  /** The daemon request it answers; null for an async question ask, which no request backs. */
  native: Native | null;
  done: boolean;
  announced: boolean;
  /** Something waits on the server for this ask's answer; once that stops, the ask stops riding in reports. */
  listening: boolean;
  /** The question ask's questions as Codex asked them: answers by position are turned back into these. */
  questions?: ToolRequestUserInputQuestion[];
  /** The permissions request's profile as Codex asked for it: Allow once grants exactly this. */
  permissions?: RequestPermissionProfile;
  /** An async question ask: the call it answers and its questions as kept, for the reply message. */
  reply?: { callId: string; questions: AsyncQuestion[] };
}

interface Held {
  sessionId: string;
  threadId: string;
  d: Delivery;
  /** `queued` has been reported for it. */
  queued: boolean;
}

export interface Store {
  acted: string[];
  save(): void;
}

export class Responder {
  private readonly asks = new Map<string, OpenAsk>();
  private readonly natives = new Map<string, Native>();
  /** What a waiting thread waits on, for the session's wait note (`Shell(…)`, `Edit(…)`, or SECRET_NOTE). */
  readonly notes = new Map<string, string>();
  private outbox: { sessionId: string; path: string; body: Record<string, unknown> }[] = [];
  private held: Held[] = [];
  private readonly joining = new Set<string>();
  /** Threads with a message or /compact being delivered now. */
  private readonly acting = new Set<string>();
  /** Threads left while still waiting, on something this dashboard cannot answer: not rejoined until their status changes. */
  private readonly unanswerable = new Set<string>();
  /** Async question calls this dashboard has answered: their asks are not announced again. */
  private readonly answeredCalls = new Set<string>();

  constructor(
    private readonly fleet: Fleet,
    private readonly daemon: Daemon,
    private readonly level: RespondLevel,
    private readonly activityFeed: boolean,
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly transportOf: (sessionId: string) => Transport | undefined,
    private readonly store: Store,
    /** Reads the hook lines already in the spool (main.ts readHooks), so a file approval sees paths recorded just before it. */
    private readonly readSpool: () => void,
    /** This machine's id; null while it cannot be read (main.ts readThisMachine). */
    private readonly machineId: () => string | null,
  ) {}

  // ---- what the session takes ------------------------------------------------------------------------

  /**
   * Report.session.respond: a daemon-hosted thread takes the level's kinds (acceptsFor); any other is
   * `observe-only` — a desktop-app local thread, an excluded CLI run, `codex exec`, or a machine without a daemon. Its
   * originator may add one more (ORIGINATOR_LIMIT): `desktop-app`, answered in the Codex app, or `not-interactive`, a
   * headless run, counted as background like `claude -p`. A desktop-app thread in the daemon (a remote project) is answerable
   * like any other.
   */
  respondInfo(s: Session): RespondInfo {
    const root = this.fleet.thread(s.id);
    const hosted = this.daemon.connected && this.fleet.isDaemonHosted(root);
    const own = root.originator === null ? undefined : ORIGINATOR_LIMIT.get(root.originator);
    const limits: RespondLimit[] = hosted ? [] : own ? ['observe-only', own] : ['observe-only'];
    return { level: this.level, accepts: acceptsFor(this.level, limits, this.activityFeed), limits };
  }

  private responding(sessionId: string, kind: RespondKind): boolean {
    const s = this.fleet.sessions.get(sessionId);
    return !!s && !!this.transportOf(sessionId)?.respond && !this.fleet.thread(sessionId).ended && this.respondInfo(s).accepts.includes(kind);
  }

  /** The asks open now for a session, sent with its report while the server takes answers. */
  asksFor(sessionId: string): Ask[] {
    return [...this.asks.values()].filter((a) => !a.done && a.listening && a.sessionId === sessionId).map((a) => a.ask);
  }

  // ---- rejoining to act -------------------------------------------------------------------------------

  /**
   * Rejoins a daemon-hosted thread that waits on an approval or a question the dashboard can answer now: the last reply said
   * `respond: true`, the level covers the kind (questions for user input, everything for approvals), and the thread is known
   * not to be ephemeral. The pending request is replayed on rejoin. Called only on three triggers — a status
   * change (main.ts), a thread first seen, a reply that turns responding on — and never for a thread whose request was already
   * seen to be unanswerable, until its status changes. A failed rejoin ("no rollout found") is tried again on the next status
   * change; meanwhile the ask is answer-in-terminal.
   */
  async considerRejoin(threadId: string): Promise<void> {
    const t = this.fleet.threads.get(threadId);
    if (!t || !t.loaded || !this.daemon.connected || this.daemon.subscribed.has(threadId) || this.joining.has(threadId) || this.unanswerable.has(threadId)) return;
    const waiting = this.fleet.waitingOn(t);
    if (!waiting || !this.responding(t.sessionId, waiting === 'approval' ? 'permission' : 'question')) return;
    this.joining.add(threadId);
    try {
      if (!(await this.resumable(t))) return;
      await this.daemon.rejoin(threadId);
      setTimeout(() => void this.maybeLeave(threadId), LEAVE_EMPTY_MS);
    } catch {
      // tried again on the next status change
    } finally {
      this.joining.delete(threadId);
    }
  }

  /** A `thread/status/changed` broadcast for the thread: a request seen unanswerable on it no longer holds a rejoin back. */
  statusBroadcast(threadId: string): void {
    this.unanswerable.delete(threadId);
  }

  /**
   * Whether a thread may be rejoined: connected, loaded in the daemon, and known not to be ephemeral. Unknown is read
   * first with the read-only `thread/read`; anything but `ephemeral: false` afterwards is no.
   */
  private async resumable(t: Thread): Promise<boolean> {
    if (!this.daemon.connected || !t.loaded) return false;
    if (t.ephemeral === null) await this.daemon.readThread(t.id).catch(() => null);
    return this.daemon.connected && t.loaded && t.ephemeral === false;
  }

  /**
   * Leaves a rejoined thread once nothing of ours is open on it. A thread left while it still waits waits on something the
   * dashboard cannot answer (a secret question, a request not mapped, one the level does not cover), so it is marked and not
   * rejoined for that again until its status changes. (One left just as its request resolved, before the status broadcast
   * that says so, is marked for that moment only: the broadcast clears it.)
   */
  private async maybeLeave(threadId: string): Promise<void> {
    if (!this.daemon.subscribed.has(threadId) || this.acting.has(threadId) || this.joining.has(threadId)) return;
    if ([...this.natives.values()].some((n) => n.threadId === threadId)) return;
    const t = this.fleet.threads.get(threadId);
    if (t && this.fleet.waitingOn(t)) this.unanswerable.add(threadId);
    await this.daemon.unsubscribe(threadId);
  }

  // ---- requests ---------------------------------------------------------------------------------------

  /** A mapped request from a rejoined thread (live, or replayed on rejoin). Never answered here: only an answer from the dashboard is. */
  async request(rpcId: RequestId, method: ServerRequestMethod, params: Record<string, unknown>, now = Date.now()): Promise<void> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const itemId = typeof params.itemId === 'string' ? params.itemId : null;
    if (!threadId || !itemId) return;
    const t = this.fleet.thread(threadId);
    const approvalId = typeof params.approvalId === 'string' && params.approvalId ? params.approvalId : null;
    const askId = approvalId ? `${itemId}:${approvalId}` : itemId;
    const native: Native = { rpcId, method, threadId, askId: null, blocking: method !== 'item/tool/requestUserInput' || params.isBlocking !== false };
    this.natives.set(String(rpcId), native);
    const agentId = this.fleet.isChild(t) ? t.id : null;
    const openedAt = typeof params.startedAtMs === 'number' ? params.startedAtMs : now;
    let built: { ask: Ask; kind: RespondKind; note: string; questions?: ToolRequestUserInputQuestion[]; permissions?: RequestPermissionProfile } | null = null;
    if (method === 'item/commandExecution/requestApproval') built = this.commandAsk(askId, agentId, openedAt, params as unknown as CommandExecutionRequestApprovalParams);
    else if (method === 'item/fileChange/requestApproval') built = await this.fileAsk(rpcId, askId, agentId, openedAt, params as unknown as FileChangeRequestApprovalParams);
    else if (method === 'item/permissions/requestApproval') built = this.permissionsAsk(askId, agentId, openedAt, params as unknown as PermissionsRequestApprovalParams);
    else if (method === 'item/tool/requestUserInput') {
      const q = params as unknown as ToolRequestUserInputParams;
      // A secret question is not answerable here and never announced.
      if (Array.isArray(q.questions) && q.questions.some((x) => x?.isSecret)) this.notes.set(threadId, SECRET_NOTE);
      else built = this.questionAsk(askId, agentId, openedAt, q);
    }
    if (!this.natives.has(String(rpcId))) return; // resolved while the file paths were read
    if (built) this.notes.set(threadId, built.note);
    this.fleet.session(t.sessionId).dirty = true;
    if (!built || !this.responding(t.sessionId, built.kind)) {
      // Not answerable from the dashboard now: left to the terminal, and nothing of ours holds the thread.
      this.natives.delete(String(rpcId));
      return void this.maybeLeave(threadId);
    }
    native.askId = askId;
    const was = this.asks.get(askId);
    const a: OpenAsk = was && !was.done ? { ...was, native, listening: true } : { ask: built.ask, kind: built.kind, sessionId: t.sessionId, threadId, native, done: false, announced: false, listening: true, questions: built.questions, permissions: built.permissions };
    this.asks.set(askId, a);
    await this.announce(a);
    void this.waitForAnswer(a);
  }

  /** A status change: a thread that no longer waits has no wait note. */
  statusChanged(threadId: string): void {
    const t = this.fleet.threads.get(threadId);
    if (t && !this.fleet.waitingOn(t)) this.notes.delete(threadId);
  }

  /** The session ended: the server closes its asks itself; the waits here just stop. */
  sessionEnded(sessionId: string): void {
    for (const a of [...this.asks.values()]) if (a.sessionId === sessionId) this.finish(a);
  }

  private commandAsk(id: string, agentId: string | null, openedAt: number, p: CommandExecutionRequestApprovalParams) {
    const command = typeof p.command === 'string' ? p.command : '';
    const input: Record<string, unknown> = { command };
    if (p.cwd) input.cwd = p.cwd;
    if (p.reason) input.reason = p.reason;
    if (p.kind === 'writeStdin') input.stdin = true;
    if (p.networkApprovalContext) input.network = `${p.networkApprovalContext.protocol}://${p.networkApprovalContext.host}`;
    if (p.additionalPermissions != null) input.additionalPermissions = p.additionalPermissions;
    const shown = toolInput(input);
    // Codex may list the decisions this prompt can take; when it does without `accept`, Allow once is not one of them.
    const decisions = p.availableDecisions;
    const acceptOffered = decisions == null || (Array.isArray(decisions) && decisions.includes('accept'));
    // Allow once (`accept`, "User approved the command") approves this one command; it never applies a proposed exec- or
    // network-policy amendment, which only `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment` do and this reporter
    // never sends, so a proposal alone does not make the ask Deny-only. Deny only: a cut or empty command, a stdin
    // write, a network-access prompt, an extra filesystem or network grant, or a prompt that does not offer `accept`.
    const denyOnly =
      shown.cut ||
      !command.trim() ||
      p.kind !== 'command' ||
      !!p.networkApprovalContext ||
      p.additionalPermissions != null ||
      !acceptOffered;
    const ask: Ask = { id, kind: 'permission', agentId, openedAt, allowsReply: false, tool: { name: 'Shell', input: shown.input, cut: denyOnly, denyReason: false } };
    // The wait note is display text taken from the command: the broader rules too (the ask's input keeps the narrow ones).
    return { ask, kind: 'permission' as const, note: `Shell(${clipFreeText(command.replace(/\s+/g, ' ').trim(), 153)})` };
  }

  /**
   * A file approval's changes come from our PreToolUse hook for the same call — its `tool_use_id` equals the request's
   * `itemId` (observed on Codex 0.164.0) — because Codex's `thread/items/read` reads only completed items, and a
   * pending approval's item has not completed. The spool is read now and then every 100 ms for up to HOOK_WAIT_MS until
   * the paths appear or the request resolves; with no wait while `hooks/list` reports our hooks untrusted. The ask shows each
   * change's operation and path (`changes`: add, delete, update, or a move with its destination), as Codex's own approval names
   * them (codex-hook.mjs patchPaths), and the patch itself (`patch`, from the same hook line), which lives only in the open ask,
   * as a Claude Write or Edit's content does. Allow once is offered only when the owner sees all of what `accept` applies
   * (the cut rule): Deny only when no change is recorded, when the recorded list leaves any path or change out (the hook
   * keeps at most 50 and drops an unusable one, and marks the list cut — Codex's `accept` applies the whole patch), when
   * the patch is missing or not shown whole (redacted, longer than the limit, or past toolInput's bound — then the changes are
   * shown without it), when the shown input was cut, or with a grantRoot (writes under it for the rest of the session, which
   * the dashboard never grants).
   */
  private async fileAsk(rpcId: RequestId, id: string, agentId: string | null, openedAt: number, p: FileChangeRequestApprovalParams) {
    const recorded = () => {
      this.readSpool();
      return this.fleet.threads.get(p.threadId)?.patchPaths.get(p.itemId) ?? { paths: [], changes: [], cut: false, patch: undefined, patchCut: false };
    };
    let found = recorded();
    const waiting = () => found.paths.length === 0 && this.fleet.hooksTrusted !== false && this.natives.has(String(rpcId));
    for (let waited = 0; waited < HOOK_WAIT_MS && waiting(); waited += 100) {
      await sleep(100);
      found = recorded();
    }
    const { paths, changes, patch } = found;
    const extra: Record<string, unknown> = {};
    if (p.reason) extra.reason = p.reason;
    if (p.grantRoot) extra.grantRoot = p.grantRoot;
    const withPatch = patch === undefined ? null : toolInput({ changes, patch, ...extra });
    // Past toolInput's bound the whole input becomes a note: the changes are then shown without the patch. A line from the
    // hook before `changes` existed names only paths: those are shown, and the ask is Deny-only (no changes).
    const shown = withPatch && 'patch' in withPatch.input ? withPatch : toolInput(changes.length || !paths.length ? { changes, ...extra } : { paths, ...extra });
    const denyOnly =
      shown.cut || !('patch' in shown.input) || found.patchCut || changes.length === 0 || found.cut || (p.grantRoot !== null && p.grantRoot !== undefined);
    const ask: Ask = { id, kind: 'permission', agentId, openedAt, allowsReply: false, tool: { name: 'Edit', input: shown.input, cut: denyOnly, denyReason: false } };
    const first = paths[0] ?? '';
    return { ask, kind: 'permission' as const, note: clip(`Edit(${first}${paths.length > 1 ? ` +${paths.length - 1}` : ''})`, 160) };
  }

  private permissionsAsk(id: string, agentId: string | null, openedAt: number, p: PermissionsRequestApprovalParams) {
    const input: Record<string, unknown> = { permissions: p.permissions ?? {} };
    if (p.cwd) input.cwd = p.cwd;
    if (p.reason) input.reason = p.reason;
    const shown = toolInput(input);
    const ask: Ask = { id, kind: 'permission', agentId, openedAt, allowsReply: false, tool: { name: 'Permissions', input: shown.input, cut: shown.cut || !p.permissions, denyReason: false } };
    // The wait note is display text: the reason gets the broader rules too, as the mod's note for any tool but a path does.
    return { ask, kind: 'permission' as const, note: `Permissions(${clipFreeText((p.reason ?? '').replace(/\s+/g, ' ').trim(), 147)})`, permissions: p.permissions };
  }

  /** 1–4 questions, one answer each; options as given; a typed answer only with `isOther` or no options. */
  private questionAsk(id: string, agentId: string | null, openedAt: number, p: ToolRequestUserInputParams) {
    const qs = Array.isArray(p.questions) ? p.questions : [];
    if (qs.length < 1 || qs.length > L.questions) return null;
    const questions: AskQuestion[] = [];
    for (const q of qs) {
      const options = Array.isArray(q?.options) ? q.options : [];
      if (typeof q?.question !== 'string' || options.length > L.options) return null;
      questions.push({
        question: block(q.question, L.question),
        header: oneLine(q.header, L.header),
        multiSelect: false,
        options: options.map((o) => ({ label: oneLine(o?.label, L.label), description: block(o?.description ?? '', L.description), preview: null })),
        allowsText: q.isOther === true || options.length === 0,
      });
    }
    const ask: Ask = { id, kind: 'question', agentId, openedAt, allowsReply: false, questions };
    // The note is built from the question as Codex asked it, so the broader rules see it whole before their own cut.
    return { ask, kind: 'question' as const, note: clipFreeText(String(qs[0]!.header || qs[0]!.question).replace(/\s+/g, ' ').trim(), 160), questions: qs };
  }

  /** The request resolved: by our answer, or by another client first (the terminal), or on its own (a non-blocking question). */
  resolved(threadId: string, requestId: RequestId): void {
    const native = this.natives.get(String(requestId));
    if (!native || native.threadId !== threadId) return;
    this.natives.delete(String(requestId));
    if (![...this.natives.values()].some((n) => n.threadId === threadId)) this.notes.delete(threadId);
    const a = native.askId ? this.asks.get(native.askId) : undefined;
    if (a && !a.done && a.native === native) {
      this.finish(a);
      if (a.announced) this.queueClose(a, native.blocking ? 'terminal' : 'closed');
    }
    this.fleet.session(this.fleet.thread(threadId).sessionId).dirty = true;
    void this.maybeLeave(threadId);
  }

  /** The daemon connection ended: no request can be answered by this client any more, and nothing seen on it still holds. */
  disconnected(): void {
    this.natives.clear();
    this.notes.clear();
    this.unanswerable.clear();
    for (const a of this.asks.values()) if (!a.done) this.finish(a);
    for (const h of this.held.splice(0)) this.queueResult(h.sessionId, h.d.id, 'not-taken');
  }

  private finish(a: OpenAsk): void {
    a.done = true;
    this.asks.delete(a.ask.id);
    const s = this.fleet.sessions.get(a.sessionId);
    if (s) s.dirty = true;
  }

  // ---- the server side (the respond routes) --------------------------------------------------------------

  /**
   * One call on `path` under the route of the session `sessionId` names, which takes its id there: that id at this machine's
   * (sessionKey). Null when it could not be made: offline, or this machine's id not yet read, so asks, closes and results wait
   * as the reports do.
   */
  private call(method: string, sessionId: string, path: string, body: unknown, timeoutMs: number): Promise<HttpResult | null> {
    const machine = this.machineId();
    if (machine === null) return Promise.resolve(null);
    return serverCall(this.serverUrl, this.token, method, `/api/fleet/sessions/${encodeURIComponent(sessionKey(sessionId, machine))}${path}`, body, timeoutMs);
  }

  private async announce(a: OpenAsk): Promise<number> {
    const res = await this.call('PUT', a.sessionId, askPath(a), a.ask, 15_000);
    if (res?.status === 200) a.announced = true;
    return res?.status ?? 0;
  }

  private queueOut(item: { sessionId: string; path: string; body: Record<string, unknown> }): void {
    this.outbox = [...this.outbox, item].slice(-OUTBOX_MAX);
  }

  private queueResult(sessionId: string, deliveryId: string, result: DeliveryResult): void {
    this.queueOut({ sessionId, path: `/deliveries/${encodeURIComponent(deliveryId)}/result`, body: { result, at: Date.now() } });
  }

  private queueClose(a: OpenAsk, outcome: 'terminal' | 'closed' | 'ended'): void {
    this.queueOut({ sessionId: a.sessionId, path: `${askPath(a)}/close`, body: { outcome, at: Date.now() } });
  }

  /** Sends the queued closes and results, oldest first. A call that could not be made keeps the rest; any answer drops the item. */
  async flushOutbox(): Promise<void> {
    while (this.outbox.length) {
      const item = this.outbox[0]!;
      const res = await this.call('POST', item.sessionId, item.path, item.body, 15_000);
      if (!res) return;
      this.outbox.shift();
    }
  }

  /** Notes a delivery as acted on, kept across restarts, so one handed over twice acts once. */
  private markActed(id: string): boolean {
    const acted = this.store.acted;
    if (acted.includes(id)) return false;
    acted.push(id);
    while (acted.length > ACTED_KEPT) acted.shift();
    this.store.save();
    return true;
  }

  /** What the held answer request handed over: the delivery a 200 answer carries; null for any other answer or body. */
  private deliveryOf(res: HttpResult | null): Delivery | null {
    if (res?.status !== 200) return null;
    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      return null;
    }
    const d = (body as { delivery?: unknown } | null)?.delivery;
    return isDelivery(d) ? d : null;
  }

  /**
   * An answer this ask takes, while the dashboard may still answer it: one that arrives after responding stopped (the last
   * reply turned it off, the session ended, its root is no longer daemon-hosted) is refused, never sent: `responding` is
   * checked again here for the question and permission races, as the Claude reporter's `wanted` predicates check it.
   */
  private wanted(a: OpenAsk, d: Delivery): boolean {
    const fits = a.kind === 'question' ? d.kind === 'question' : d.kind === 'deny' || (d.kind === 'allow-once' && !a.ask.tool?.cut);
    return fits && this.responding(a.sessionId, a.kind);
  }

  /**
   * The held-answer loop (the Claude reporter's pollAnswer) while the ask is open and the server takes answers — and, for a daemon
   * request's ask, while its thread is joined (an async question ask has no request to join for).
   */
  private async waitForAnswer(a: OpenAsk): Promise<void> {
    while (!a.done && this.responding(a.sessionId, a.kind) && (a.native === null || this.daemon.subscribed.has(a.threadId))) {
      const res = await this.call('GET', a.sessionId, `${askPath(a)}/answer?wait=${L.holdSeconds}`, undefined, (L.holdSeconds + 10) * 1000);
      if (a.done) {
        const d = this.deliveryOf(res);
        if (d && this.markActed(d.id)) this.queueResult(a.sessionId, d.id, 'closed');
        return;
      }
      if (!res) {
        await sleep(retryDelay(1));
        continue;
      }
      if (res.status === 204) continue;
      if (res.status === 404) {
        if ((await this.announce(a)) !== 200) await sleep(retryDelay(2));
        continue;
      }
      const d = this.deliveryOf(res);
      if (!d) break;
      if (!this.markActed(d.id)) {
        await sleep(1000);
        continue;
      }
      if (d.askId === a.ask.id && this.wanted(a, d) && this.act(a, d)) return;
      this.queueResult(a.sessionId, d.id, 'refused');
    }
    if (!a.done) {
      a.listening = false;
      const s = this.fleet.sessions.get(a.sessionId);
      if (s) s.dirty = true;
    }
  }

  /** The native response for an answer from the dashboard; null when it cannot be expressed. */
  private nativeAnswer(a: OpenAsk, d: Delivery): unknown {
    const method = a.native?.method;
    if (method === 'item/tool/requestUserInput') {
      const answers: Record<string, { answers: string[] }> = {};
      (a.questions ?? []).forEach((q, i) => {
        const ans = d.answers?.[i];
        if (!ans || typeof q?.id !== 'string') return;
        if ('text' in ans) {
          const text = typeof ans.text === 'string' ? ans.text : '';
          if (text.trim() && (q.isOther || !q.options?.length)) answers[q.id] = { answers: [text] };
        } else if (Array.isArray(ans.options) && ans.options.length) {
          const label = q.options?.[ans.options[0]!]?.label;
          if (typeof label === 'string') answers[q.id] = { answers: [label] };
        }
      });
      return { answers };
    }
    const allow = d.kind === 'allow-once';
    if (method === 'item/permissions/requestApproval') {
      const p = a.permissions;
      const granted = allow && p ? { ...(p.network ? { network: p.network } : {}), ...(p.fileSystem ? { fileSystem: p.fileSystem } : {}) } : {};
      return { permissions: granted, scope: 'turn' };
    }
    return { decision: allow ? 'accept' : 'decline' };
  }

  /**
   * Sends the dashboard's answer once: as the reply to the daemon request it answers, or for an async question ask as the reply
   * message, through the message path (the delivery's results are the answer's). False when it took nothing: an async
   * answer to questions all already answered in the session file, which waitForAnswer refuses and keeps waiting past, as it
   * does an answer the ask cannot take.
   */
  private act(a: OpenAsk, d: Delivery): boolean {
    if (a.reply && !a.done) {
      const text = asyncReplyText(a.reply, d, this.fleet.threads.get(a.threadId)?.asyncQuestions.get(a.reply.callId)?.replied ?? new Set());
      if (text === null) return false;
      this.finish(a);
      this.answeredCalls.add(a.reply.callId);
      if (this.answeredCalls.size > ACTED_KEPT) this.answeredCalls.delete(this.answeredCalls.values().next().value as string);
      void this.steer(a.sessionId, { ...d, kind: 'message', text });
      return true;
    }
    if (a.done || !a.native || !this.natives.has(String(a.native.rpcId))) {
      this.queueResult(a.sessionId, d.id, 'closed');
      return true;
    }
    const sent = this.daemon.answer(a.native.rpcId, this.nativeAnswer(a, d));
    this.finish(a);
    this.queueResult(a.sessionId, d.id, sent ? 'took' : 'not-taken');
    return true;
  }

  // ---- Codex async questions ----------------------------------------------------------------------------------

  /**
   * Codex asks async questions with `request_user_input_async`: an agent message, read from the session file, and no daemon
   * request. Each one a root thread still has open is announced as a question ask while the session takes questions, once its
   * session file has been read to the end; the ask closes when the file shows replies naming all its questions or the call,
   * from any client (`terminal`), when its turn ended (`closed`; Codex's TUI drops pending questions then), or when Codex
   * refused the call (`closed`). An answer this dashboard already took is delivered all the same. Called every tick, after the
   * session files are read.
   */
  asyncQuestions(): void {
    for (const t of this.fleet.threads.values()) {
      // Codex offers the tool to root threads only (core/tests/suite/request_user_input_async.rs, the "subagent" cases).
      if (this.fleet.isChild(t)) continue;
      for (const [callId, q] of t.asyncQuestions) {
        const a = this.asks.get(callId);
        if (q.state !== 'open') {
          if (a?.reply && !a.done) {
            this.finish(a);
            if (a.announced) this.queueClose(a, q.state === 'replied' ? 'terminal' : 'closed');
          }
          continue;
        }
        if (!this.responding(t.sessionId, 'question')) continue;
        if (a?.reply && !a.done && !a.listening) {
          a.listening = true;
          void this.waitForAnswer(a);
          continue;
        }
        // Only once the session file has been read to its end: a file re-read from its start (a restart, a first attach) must
        // not revive a question its later lines answered or ended.
        if (a || this.answeredCalls.has(callId) || !t.rollout?.tail?.caughtUp()) continue;
        const ask = asyncQuestionAsk(callId, q.at, q.questions);
        if (!ask) continue; // over the limits: answered in its terminal, as questionAsk leaves them
        const open: OpenAsk = { ask, kind: 'question', sessionId: t.sessionId, threadId: t.id, native: null, done: false, announced: false, listening: true, reply: { callId, questions: q.questions } };
        this.asks.set(callId, open);
        this.fleet.session(t.sessionId).dirty = true;
        void this.announce(open).then(() => this.waitForAnswer(open));
      }
    }
  }

  /**
   * An async question's answer goes into the running turn, as Codex's TUI sends it (`tui/src/app/user_turn_submission.rs:30-90`,
   * `tui/src/app_server_session.rs:1543-1565`): with the thread joined like a message, `turn/steer` naming the turn the session
   * file shows running. When Codex answers that another turn is active, the steer is tried once more naming that turn
   * (user_turn_submission.rs:66-79). With no turn known, or when Codex answers that the turn is not steerable, that no turn is
   * active, or (after that retry) that another turn still is (`tui/src/app.rs:768-807`), it goes the message way instead — idle:
   * `turn/start`; else held until idle — as the TUI falls back to its queue or a new turn. A steer taken is `took`.
   */
  private async steer(sessionId: string, d: Delivery): Promise<void> {
    const root = this.fleet.thread(sessionId);
    const turnId = root.turnId;
    if (turnId === null || this.acting.has(root.id)) return this.deliver(sessionId, d);
    let fallBack = false;
    this.acting.add(root.id);
    try {
      if (!(await this.resumable(root))) return this.queueResult(sessionId, d.id, 'not-taken');
      if (!this.daemon.subscribed.has(root.id)) await this.daemon.rejoin(root.id);
      try {
        await this.daemon.steerTurn(root.id, turnId, d.text ?? '');
      } catch (err) {
        const actual = activeTurnOf(err);
        if (actual === null || actual === turnId) throw err;
        await this.daemon.steerTurn(root.id, actual, d.text ?? '');
      }
      this.queueResult(sessionId, d.id, 'took');
    } catch (err) {
      if (steerFallsBack(err)) fallBack = true;
      else this.queueResult(sessionId, d.id, 'not-taken');
    } finally {
      this.acting.delete(root.id);
      void this.maybeLeave(root.id);
    }
    if (fallBack) await this.deliver(sessionId, d);
  }

  // ---- messages and commands (report-reply deliveries) ----------------------------------------------------

  /** Messages and commands from one reply: each acted on once, within the session's own level. */
  handleDeliveries(sessionId: string, list: Delivery[]): void {
    for (const d of list) {
      if (!this.markActed(d.id)) continue;
      if (d.kind === 'message' && typeof d.text === 'string' && d.text.trim() && this.responding(sessionId, 'message')) void this.deliver(sessionId, d);
      else if (d.kind === 'command' && d.command === 'compact' && this.responding(sessionId, 'command')) void this.deliver(sessionId, d);
      else this.queueResult(sessionId, d.id, 'refused'); // includes /clear: Codex has no equivalent
    }
  }

  /**
   * Idle: rejoin and act now. Running: `queued`, held until idle. Not loaded in the daemon, or not known to be non-ephemeral
   * once read: `not-taken`.
   */
  private async deliver(sessionId: string, d: Delivery): Promise<void> {
    const root = this.fleet.thread(sessionId);
    if (!(await this.resumable(root))) return this.queueResult(sessionId, d.id, 'not-taken');
    if (root.status?.type === 'idle' && !this.acting.has(root.id) && !this.held.some((h) => h.threadId === root.id)) void this.run({ sessionId, threadId: root.id, d, queued: false });
    else {
      this.held.push({ sessionId, threadId: root.id, d, queued: true });
      this.queueResult(sessionId, d.id, 'queued');
    }
  }

  /** Called on every status change and tick: a held message or command goes once its thread is idle. */
  pump(): void {
    for (const h of [...this.held]) {
      const t = this.fleet.threads.get(h.threadId);
      if (!t || !t.loaded || !this.daemon.connected) {
        this.held.splice(this.held.indexOf(h), 1);
        this.queueResult(h.sessionId, h.d.id, 'not-taken');
        continue;
      }
      if (t.status?.type !== 'idle' || this.acting.has(h.threadId)) continue;
      if (this.held.find((x) => x.threadId === h.threadId) !== h) continue; // one at a time, oldest first
      this.held.splice(this.held.indexOf(h), 1);
      void this.run(h);
    }
  }

  private async run(h: Held): Promise<void> {
    this.acting.add(h.threadId);
    try {
      const t = this.fleet.threads.get(h.threadId);
      if (!t || !(await this.resumable(t))) return this.queueResult(h.sessionId, h.d.id, 'not-taken');
      // The status right before `turn/start` or `thread/compact/start`: the one the broadcasts keep while we are joined, else the
      // rejoin's own answer. A turn started meanwhile (from the terminal, or since the idle check) holds this again rather than
      // steering a running turn.
      const status = this.daemon.subscribed.has(h.threadId) ? t.status : ((await this.daemon.rejoin(h.threadId))?.status ?? null);
      if (status?.type !== 'idle') {
        if (!h.queued) this.queueResult(h.sessionId, h.d.id, 'queued');
        this.held.unshift({ ...h, queued: true });
        return;
      }
      if (h.d.kind === 'message') await this.daemon.startTurn(h.threadId, h.d.text ?? '');
      else await this.daemon.compact(h.threadId);
      this.queueResult(h.sessionId, h.d.id, 'took');
    } catch {
      this.queueResult(h.sessionId, h.d.id, 'not-taken');
    } finally {
      this.acting.delete(h.threadId);
      void this.maybeLeave(h.threadId);
    }
  }
}
