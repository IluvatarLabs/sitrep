// The machine's managed Codex app-server daemon, for status broadcasts and answering only.
//
// Connection: the socket path comes from `codex app-server daemon version` on every connect (the path is a symlink that
// moves when the daemon restarts; machines run different versions, so none is pinned); a standard `ws` client opens
// `ws+unix://<socket>:/`; `initialize` declares `experimentalApi`, without which Codex strips `additionalPermissions` from
// command approvals (`app-server-protocol/src/protocol/v2/item.rs:1624-1630`, applied in `app-server/src/transport.rs:179-200`;
// `availableDecisions` is always sent), and respond.ts's Deny-only rule reads it. Then the loaded threads and their status are
// read (`thread/loaded/list`, `thread/read`), our hooks' trust (`hooks/list`), and broadcasts are listened to without
// subscribing to anything.
//
// Enforced here: the only reply this client ever sends to a daemon request is `answer()`, which respond.ts calls with
// the exact answer the dashboard gave to an open ask. A request of any other kind is never replied to — no error reply, no
// automatic reply. Only the methods in CALLABLE can be sent. Codex's `thread/resume`, `turn/start` and `turn/steer` accept
// more than we send (model, cwd, approval policy, effort, client metadata, … in its ThreadResumeParams, TurnStartParams and
// TurnSteerParams); the vendored types here keep only the fields we send, which catches an extra field written into a call
// but not a wider object passed in. What guarantees nothing more is sent is the call sites: `rejoin()`, `startTurn()` and
// `steerTurn()` build their parameters from those fixed fields alone.
import { execFile } from 'node:child_process';
import WebSocket, { type RawData } from 'ws';
import type {
  HooksListParams,
  HooksListResponse,
  InitializeParams,
  InitializeResponse,
  RequestId,
  ServerRequestMethod,
  Thread,
  ThreadCompactStartParams,
  ThreadLoadedListParams,
  ThreadLoadedListResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStatus,
  ThreadUnsubscribeParams,
  ThreadUnsubscribeResponse,
  TurnStartParams,
  TurnSteerParams,
} from './codex-protocol/v2.js';

/** What `codex app-server daemon version` prints (one JSON object). */
export interface DaemonVersion {
  status: string;
  socketPath: string;
  appServerVersion: string | null;
  managedCodexPath: string | null;
}

/** Every method this client can call, with the parameters it may send. Nothing else — no thread/start, fork or lifecycle call. */
interface Callable {
  initialize: [InitializeParams, InitializeResponse];
  'thread/loaded/list': [ThreadLoadedListParams, ThreadLoadedListResponse];
  'thread/read': [ThreadReadParams, ThreadReadResponse];
  'hooks/list': [HooksListParams, HooksListResponse];
  'thread/resume': [ThreadResumeParams, ThreadResumeResponse];
  'thread/unsubscribe': [ThreadUnsubscribeParams, ThreadUnsubscribeResponse];
  'turn/start': [TurnStartParams, unknown];
  'turn/steer': [TurnSteerParams, unknown];
  'thread/compact/start': [ThreadCompactStartParams, unknown];
}
const CALLABLE: ReadonlySet<string> = new Set<keyof Callable>([
  'initialize',
  'thread/loaded/list',
  'thread/read',
  'hooks/list',
  'thread/resume',
  'thread/unsubscribe',
  'turn/start',
  'turn/steer',
  'thread/compact/start',
]);

/** The server requests the reporter maps to asks. Every other request is ignored. */
export const MAPPED_REQUESTS: ReadonlySet<ServerRequestMethod> = new Set<ServerRequestMethod>([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'item/permissions/requestApproval',
]);

export interface DaemonListener {
  connected(): void;
  disconnected(): void;
  thread(t: Thread): void;
  status(threadId: string, status: ThreadStatus): void;
  closed(threadId: string): void;
  name(threadId: string, name: string | undefined): void;
  /** A mapped request from a thread this client has rejoined (or one replayed on rejoin). */
  request(rpcId: RequestId, method: ServerRequestMethod, params: Record<string, unknown>): void;
  resolved(threadId: string, requestId: RequestId): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const RETRY_MS = [5_000, 15_000, 30_000, 60_000] as const;
const HOOKS_REFRESH_MS = 60_000;
/** Our hook command, as `hooks/list` shows it for the plugin's entries. */
const OUR_HOOK = 'codex-hook.mjs';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

function parseVersion(text: string): DaemonVersion | null {
  try {
    const v = obj(JSON.parse(text));
    if (!v || v.status !== 'running' || typeof v.socketPath !== 'string' || !v.socketPath) return null;
    return {
      status: 'running',
      socketPath: v.socketPath,
      appServerVersion: typeof v.appServerVersion === 'string' ? v.appServerVersion : null,
      managedCodexPath: typeof v.managedCodexPath === 'string' ? v.managedCodexPath : null,
    };
  } catch {
    return null;
  }
}

function messageText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8');
  return data.toString('utf8');
}

export class Daemon {
  version: DaemonVersion | null = null;
  /** Threads this client has rejoined (`thread/resume`) and not yet left. */
  readonly subscribed = new Set<string>();
  private ws: WebSocket | null = null;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private failures = 0;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private hooksTimer: NodeJS.Timeout | null = null;
  private loggedDown = false;

  constructor(
    private readonly codexBin: string,
    private readonly clientVersion: string,
    private readonly listener: DaemonListener,
    private readonly cwds: () => string[],
    private readonly trust: (trusted: boolean | null) => void,
    private readonly log: (line: string) => void,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.version !== null;
  }

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.hooksTimer) clearInterval(this.hooksTimer);
    this.ws?.close(1000, 'codex-reporter stopping');
  }

  private retry(): void {
    if (this.stopped) return;
    const ms = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)]!;
    this.failures++;
    this.retryTimer = setTimeout(() => void this.connect(), ms);
  }

  /** `codex app-server daemon version`: a passive probe of the managed daemon; null when none runs. */
  private probe(): Promise<DaemonVersion | null> {
    return new Promise((resolve) => {
      execFile(this.codexBin, ['app-server', 'daemon', 'version'], { timeout: 5000, maxBuffer: 64 * 1024 }, (err, stdout) => resolve(err ? null : parseVersion(String(stdout))));
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.ws) return;
    const version = await this.probe();
    if (!version) {
      if (!this.loggedDown) this.log('codex-reporter: no managed Codex daemon on this machine; Codex threads are observe-only until one runs');
      this.loggedDown = true;
      return this.retry();
    }
    const ws = new WebSocket(`ws+unix://${version.socketPath}:/`, { perMessageDeflate: false });
    this.ws = ws;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket upgrade timed out')), 5000);
        ws.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    } catch {
      this.drop(ws);
      return this.retry();
    }
    ws.on('message', (data: RawData) => this.onMessage(messageText(data)));
    ws.on('close', () => this.drop(ws));
    ws.on('error', () => this.drop(ws));
    try {
      // `codex_app_server_daemon` is the name Codex's own passive daemon probe uses (`app-server-daemon/src/client.rs:26`). Any
      // other name changes the daemon's process-wide identity at initialize — the User-Agent suffix every thread's model requests
      // carry, and for the first such client its originator and automatic-login choice — while this one is exempt
      // (`app-server/src/request_processors/initialize_processor.rs:19, 132`) and grants nothing else.
      await this.call('initialize', { clientInfo: { name: 'codex_app_server_daemon', title: 'SITREP Codex reporter', version: this.clientVersion }, capabilities: { experimentalApi: true, requestAttestation: false } });
      ws.send(JSON.stringify({ method: 'initialized' }));
      this.version = version;
      this.failures = 0;
      this.loggedDown = false;
      this.log(`codex-reporter: connected to the Codex daemon ${version.appServerVersion ?? ''}`.trim());
      this.listener.connected();
      await this.readLoaded();
      await this.refreshHooks();
      this.hooksTimer = setInterval(() => void this.refreshHooks(), HOOKS_REFRESH_MS);
    } catch {
      const wasUp = this.version !== null;
      ws.close(1011, 'initialization failed');
      this.drop(ws);
      if (!wasUp) this.retry();
    }
  }

  private drop(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    const wasUp = this.version !== null;
    this.version = null;
    this.subscribed.clear();
    if (this.hooksTimer) clearInterval(this.hooksTimer);
    this.hooksTimer = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Codex daemon connection closed'));
    }
    this.pending.clear();
    try {
      ws.terminate();
    } catch {
      // already gone
    }
    if (wasUp) {
      this.log('codex-reporter: the Codex daemon connection closed');
      this.listener.disconnected();
      this.trust(null);
      this.retry();
    }
  }

  private call<M extends keyof Callable>(method: M, params: Callable[M][0], timeoutMs = 10_000): Promise<Callable[M][1]> {
    if (!CALLABLE.has(method)) return Promise.reject(new Error(`${method} is not callable`));
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex daemon not connected'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onMessage(text: string): void {
    let m: Obj | null;
    try {
      m = obj(JSON.parse(text));
    } catch {
      return;
    }
    if (!m) return;
    const method = typeof m.method === 'string' ? m.method : null;
    if (m.id !== undefined && method === null) {
      // A response to one of our calls (our ids are numbers).
      const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id as number);
      const err = obj(m.error);
      // The error's `data` rides along: a refused turn/steer says why there (respond.ts steerFallsBack).
      if (err) p.reject(Object.assign(new Error(typeof err.message === 'string' ? err.message : 'Codex daemon error'), { data: err.data }));
      else p.resolve(m.result);
      return;
    }
    if (method === null) return;
    const params = obj(m.params) ?? {};
    if (m.id !== undefined) {
      // A server request. A mapped one becomes an ask; any other is ignored and never replied to.
      const id = m.id;
      if ((typeof id === 'string' || typeof id === 'number') && MAPPED_REQUESTS.has(method as ServerRequestMethod)) {
        this.listener.request(id, method as ServerRequestMethod, params);
      }
      return;
    }
    switch (method) {
      case 'thread/started': {
        const t = obj(params.thread);
        if (t && typeof t.id === 'string') this.listener.thread(t as unknown as Thread);
        break;
      }
      case 'thread/status/changed':
        if (typeof params.threadId === 'string' && obj(params.status)) this.listener.status(params.threadId, params.status as ThreadStatus);
        break;
      case 'thread/closed':
        if (typeof params.threadId === 'string') {
          this.subscribed.delete(params.threadId);
          this.listener.closed(params.threadId);
        }
        break;
      case 'thread/name/updated':
        if (typeof params.threadId === 'string') this.listener.name(params.threadId, typeof params.threadName === 'string' ? params.threadName : undefined);
        break;
      case 'serverRequest/resolved':
        if (typeof params.threadId === 'string' && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
          this.listener.resolved(params.threadId, params.requestId);
        }
        break;
      default:
        // turn, item and token notifications of a rejoined thread: telemetry comes from hooks and session files.
        break;
    }
  }

  /** The loaded threads and each one's current status, so a request already pending at start-up is not missed. */
  private async readLoaded(): Promise<void> {
    const ids: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res: ThreadLoadedListResponse = await this.call('thread/loaded/list', { cursor, limit: 200 });
      ids.push(...(Array.isArray(res?.data) ? res.data.filter((id): id is string => typeof id === 'string') : []));
      cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null;
      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    for (let i = 0; i < ids.length; i += 10) {
      await Promise.all(
        ids.slice(i, i + 10).map(async (threadId) => {
          try {
            const res = await this.call('thread/read', { threadId, includeTurns: false }, 5000);
            if (res?.thread && res.thread.id === threadId) this.listener.thread(res.thread);
          } catch {
            // gone meanwhile
          }
        }),
      );
    }
  }

  /** Our plugin hooks' trust (`trustStatus`): active only when every entry of ours is enabled and trusted or managed. */
  async refreshHooks(): Promise<void> {
    if (!this.connected) return;
    try {
      const cwds = [...new Set(this.cwds())].slice(0, 20);
      const res = await this.call('hooks/list', cwds.length ? { cwds } : {}, 10_000);
      const ours = (Array.isArray(res?.data) ? res.data : []).flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks : [])).filter((h) => h.handlerType === 'command' && h.source === 'plugin' && typeof h.command === 'string' && h.command.includes(OUR_HOOK));
      this.trust(ours.length > 0 && ours.every((h) => h.enabled && (h.trustStatus === 'trusted' || h.trustStatus === 'managed')));
    } catch {
      // keep what was known
    }
  }

  // ---- acting --------------------------------------------------------------------------------------

  /** Rejoins a loaded thread: `thread/resume {threadId, excludeTurns: true}` and nothing else. A pending request is replayed. */
  async rejoin(threadId: string): Promise<Thread> {
    const res = await this.call('thread/resume', { threadId, excludeTurns: true }, 15_000);
    this.subscribed.add(threadId);
    if (res?.thread) this.listener.thread(res.thread);
    return res.thread;
  }

  /** A loaded thread's current state (read-only `thread/read`). */
  async readThread(threadId: string): Promise<Thread | null> {
    const res = await this.call('thread/read', { threadId, includeTurns: false }, 5000);
    if (!res?.thread || res.thread.id !== threadId) return null;
    this.listener.thread(res.thread);
    return res.thread;
  }

  async unsubscribe(threadId: string): Promise<void> {
    if (!this.subscribed.delete(threadId)) return;
    try {
      await this.call('thread/unsubscribe', { threadId });
    } catch {
      // the connection is gone, which unsubscribes too
    }
  }

  /** An owner's message as a new turn: the thread and the text input, no other field. */
  startTurn(threadId: string, text: string): Promise<unknown> {
    return this.call('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] }, 15_000);
  }

  /** An answer to an async question into the running turn: the thread, the turn it must still be, and the text input. */
  steerTurn(threadId: string, expectedTurnId: string, text: string): Promise<unknown> {
    return this.call('turn/steer', { threadId, expectedTurnId, input: [{ type: 'text', text, text_elements: [] }] }, 15_000);
  }

  compact(threadId: string): Promise<unknown> {
    return this.call('thread/compact/start', { threadId }, 15_000);
  }

  /** THE reply path: the dashboard's exact answer to an open ask, sent once to the request it answers. */
  answer(rpcId: RequestId, result: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ id: rpcId, result }));
      return true;
    } catch {
      return false;
    }
  }
}
