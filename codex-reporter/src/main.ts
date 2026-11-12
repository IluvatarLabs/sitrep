// codex-reporter: the one long-running process per machine that reports every Codex thread on it. It reads our
// plugin's hook spool and the threads' session files, listens to the managed daemon's broadcasts, and posts its reports to the
// dashboard server (1 s dirty flush, 5 s heartbeat, git every 10 s). Configuration comes from the environment or a `.env`
// file in the working directory, like the server's:
//
//   CODEX_REPORTER_SERVER_URL     the dashboard server (default http://127.0.0.1:7487, the server's default port)
//   CODEX_REPORTER_TOKEN          the admin secret, sent as X-Sitrep-Token
//   CODEX_REPORTER_RESPOND        off | questions | questions-and-plans | everything (default everything)
//   CODEX_REPORTER_ACTIVITY_FEED  on unless "off", "false" or "0"
//   CODEX_REPORTER_CODEX_BIN      the `codex` executable used for `codex app-server daemon version` (default: codex on PATH)
// (The server's own SITREP_RESPOND is on/off while this one is a level, so the names differ.)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RESPOND_LEVELS, RESPOND_LIMITS, type MachineInfo, type RespondLevel } from '../../server/src/fleet/protocol.js';
import { env, serverUrl, token } from './config.js';
import { Daemon } from './daemon.js';
import { gitRunner, placeOf, readChanges, readGit } from './git.js';
import { readMachine } from './machine.js';
import { Fleet, LIVE_WINDOW_MS, type FileChangeOp, type HookRecord, type Session, type Thread } from './mapping.js';
import { buildReport } from './report.js';
import { Responder, type Store } from './respond.js';
import { codexHome, fileLines, listRollouts, NO_NAMES, parseRolloutLine, sessionOfFile, threadNames, type RolloutFile } from './sessionFiles.js';
import { JsonlTail } from './spool.js';
import { Transport } from './transport.js';
// This package's manifest: the build copies it beside dist/codex-reporter/src/, so the same import finds it there.
import manifest from '../package.json' with { type: 'json' };

export const VERSION = manifest.version;
const FLUSH_MS = 1000;
const HEARTBEAT_MS = 5000;
const GIT_POLL_MS = 10_000;
const SCAN_MS = 10_000;
/** Bytes read per tick: the hook spool's share, and all session files together. */
const SPOOL_BUDGET = 4 * 1024 * 1024;
const ROLLOUT_BUDGET = 16 * 1024 * 1024;

/** Each line with its UTC time: launchd's log file adds none (the journal and `docker logs -t` add their own as well). */
const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);

// ---- configuration (server URL, token and the env file in config.ts) ---------------------------------------------------

const rawLevel = env('CODEX_REPORTER_RESPOND') || 'everything';
/** The respond level: anything else reads as `off`. */
const level: RespondLevel = (RESPOND_LEVELS as readonly string[]).includes(rawLevel) ? (rawLevel as RespondLevel) : 'off';
const activityFeed = !['off', 'false', '0'].includes(env('CODEX_REPORTER_ACTIVITY_FEED').toLowerCase());
const codexBin = env('CODEX_REPORTER_CODEX_BIN') || 'codex';

const dataDir = path.join(os.homedir(), '.sitrep');
const spoolPath = path.join(dataDir, 'codex-hooks.ndjson');
const statePath = path.join(dataDir, 'codex-reporter-state.json');

// ---- what survives a restart: deliveries acted on, and each session's git base ----------------------------------------

interface Saved {
  acted: string[];
  gitBases: Record<string, string>;
}

function loadSaved(): Saved {
  try {
    const o = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<Saved>;
    return {
      acted: Array.isArray(o.acted) ? o.acted.filter((x): x is string => typeof x === 'string').slice(-100) : [],
      gitBases: o.gitBases && typeof o.gitBases === 'object' ? Object.fromEntries(Object.entries(o.gitBases).filter(([, v]) => typeof v === 'string')) : {},
    };
  } catch {
    return { acted: [], gitBases: {} };
  }
}

const saved = loadSaved();
function save(): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
    fs.renameSync(tmp, statePath);
  } catch (err) {
    log(`codex-reporter: could not save ${statePath}: ${(err as Error).message}`);
  }
}
const store: Store = { acted: saved.acted, save };

// ---- the hook spool -------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const absPath = (v: unknown): string | undefined => (typeof v === 'string' && path.isAbsolute(v) && v.length <= 1024 ? v : undefined);
const idOf = (v: unknown): string | undefined => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : undefined);
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const OPS: readonly string[] = ['add', 'delete', 'update', 'move'] satisfies FileChangeOp['op'][];

/** One `changes` entry as the hook script writes it: an operation and an absolute path, and for a move maybe its destination. */
function changeOf(v: unknown): FileChangeOp | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const c = v as Obj;
  const at = absPath(c.path);
  if (typeof c.op !== 'string' || !OPS.includes(c.op) || !at) return undefined;
  const op = c.op as FileChangeOp['op'];
  if (c.to === undefined) return { op, path: at };
  const to = absPath(c.to);
  return op === 'move' && to ? { op, path: at, to } : undefined;
}

/** One spool line as a HookRecord; null for anything the hook script would not have written. */
function parseHook(line: string): HookRecord | null {
  let o: Obj;
  try {
    o = JSON.parse(line) as Obj;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || typeof o.t !== 'number' || typeof o.ev !== 'string') return null;
  const listed: unknown[] = Array.isArray(o.files) ? o.files : [];
  const files = listed.map(absPath).filter((p): p is string => !!p).slice(0, 50);
  const listedChanges: unknown[] = Array.isArray(o.changes) ? o.changes : [];
  const changes = listedChanges.map(changeOf).filter((c): c is FileChangeOp => !!c).slice(0, 50);
  const patch = typeof o.patch === 'string' ? o.patch : undefined;
  return {
    t: o.t,
    ev: o.ev.slice(0, 40),
    sid: idOf(o.sid),
    aid: idOf(o.aid),
    atype: text(o.atype, 120),
    cwd: absPath(o.cwd),
    tp: absPath(o.tp),
    m: text(o.m, 120),
    tool: text(o.tool, 120),
    tuid: text(o.tuid, 200),
    sum: text(o.sum, 300),
    files: files.length ? files : undefined,
    changes: changes.length ? changes : undefined,
    // Cut when the hook left a path or change out, or when this parse drops or slices one of the line's paths or changes.
    filesCut: o.filesCut === true || files.length < listed.length || changes.length < listedChanges.length,
    patch: patch?.slice(0, RESPOND_LIMITS.toolInput),
    // Cut when the hook cut it, or when this parse shortens it.
    patchCut: o.patchCut === true || (patch !== undefined && patch.length > RESPOND_LIMITS.toolInput),
    trigger: text(o.trigger, 20),
  };
}

/** A short stable key for a spool line, so an event it produced keeps its id when the spool is read again after a restart. */
const lineKey = (line: string) => `h${createHash('sha1').update(line).digest('hex').slice(0, 12)}`;

// ---- the process --------------------------------------------------------------------------------------

const fleet = new Fleet(activityFeed);
const transports = new Map<string, Transport>();
const transportOf = (id: string) => transports.get(id);
/** This machine; null while its id cannot be read, and till then nothing is reported or answered (readThisMachine). */
let machine: MachineInfo | null = null;
const gitBusy = new Set<string>();

// The session index: every rollout file by thread, newest first (a plain file before a compressed one, then
// the latest written), and the threads of each session as each file's first line names it, which never changes.
let filesOf = new Map<string, RolloutFile[]>();
let threadsIn = new Map<string, Set<string>>();
let sessionOfPath = new Map<string, string>();
/** A scan has finished since this start: until then no session's usage is known to be complete. */
let indexed = false;
let scanning = false;
/** Files read whole, one at a time in the order asked (readWhole, which never rejects). */
let wholeReads = Promise.resolve();
/** Codex's own thread names, read again each time its session index changes (sessionFiles threadNames). */
let names = NO_NAMES;

const liveCwds = () =>
  [...fleet.sessions.values()].filter((s) => fleet.isLive(s)).map((s) => fleet.cwdOf(s)).filter((c): c is string => !!c);

const daemon = new Daemon(
  codexBin,
  VERSION,
  {
    connected: () => undefined,
    disconnected: () => {
      fleet.daemonGone();
      responder.disconnected();
    },
    thread: (t) => {
      fleet.applyDaemonThread(t);
      responder.statusChanged(t.id);
      void responder.considerRejoin(t.id);
      responder.pump();
    },
    status: (id, status) => {
      const known = fleet.threads.get(id);
      if (!known) {
        // Not seen yet: read it (read-only) to learn its session tree; the read applies its status.
        void daemon.readThread(id).catch(() => undefined);
        return;
      }
      // A thread known only from hooks or its file (one resumed in the daemon sends no thread/started): read it (read-only) to
      // learn whether it is ephemeral, since only a thread known not to be is answerable; the read considers a rejoin.
      if (known.ephemeral === null && status.type !== 'notLoaded') void daemon.readThread(id).catch(() => undefined);
      responder.statusBroadcast(id);
      fleet.applyDaemonStatus(id, status);
      responder.statusChanged(id);
      void responder.considerRejoin(id);
      responder.pump();
    },
    closed: (id) => {
      fleet.unloaded(id);
      responder.pump();
    },
    name: (id, name) => fleet.threadName(id, name),
    request: (rpcId, method, params) => void responder.request(rpcId, method, params),
    resolved: (threadId, requestId) => responder.resolved(threadId, requestId),
  },
  liveCwds,
  (trusted) => {
    fleet.hooksTrusted = trusted;
    for (const s of fleet.sessions.values()) s.dirty = true;
  },
  log,
);

const spool = new JsonlTail(spoolPath, `${spoolPath}.1`);

const responder = new Responder(fleet, daemon, level, activityFeed, serverUrl, token, transportOf, store, () => readHooks(spool, SPOOL_BUDGET), () => machine?.id ?? null);

function readHooks(tail: JsonlTail, budget: number): void {
  for (const line of tail.read(budget)) {
    const rec = parseHook(line.text);
    if (rec) fleet.applyHook(rec, lineKey(line.text));
  }
}

/**
 * Reported now: live, or left by its last taken report without usage until a report with it lands, so a card never
 * keeps an unknown figure; ended, until its final report is taken.
 */
function reported(s: Session, now: number): boolean {
  const root = fleet.thread(s.id);
  return root.ended ? s.finalFor !== root.endedAt : fleet.isLive(s, now) || s.usagePending;
}

/** New records of every thread's tailed (plain) newest file, live sessions first, within the tick's budget. */
function readSessionFiles(now: number): void {
  let left = ROLLOUT_BUDGET;
  const threads = [...fleet.threads.values()].filter((t) => t.rollout?.tail).sort((a, b) => b.lastEvidenceAt - a.lastEvidenceAt);
  for (const t of threads) {
    if (left <= 0) break;
    const tail = t.rollout!.tail!;
    let st: fs.Stats;
    try {
      st = fs.statSync(tail.path);
    } catch {
      continue;
    }
    // Nothing new: not read. Unread bytes of an old file of a thread with nothing recent are read only when its session is
    // reported: a child first seen in its parent's spawn record has no evidence yet, and only its file's recorded turn end
    // tells it finished, so after a restart or a re-read it would otherwise stay `running`.
    if (st.size <= tail.offset && st.ino === tail.ino) continue;
    const stale = !t.loaded && now - t.lastEvidenceAt > LIVE_WINDOW_MS && now - st.mtimeMs > LIVE_WINDOW_MS;
    const session = fleet.sessions.get(t.sessionId);
    if (stale && !(session && reported(session, now))) continue;
    const before = tail.offset;
    for (const line of tail.read(Math.min(left, 4 * 1024 * 1024))) {
      const parsed = parseRolloutLine(line.text, line.at);
      if (parsed) fleet.applyRollout(t, parsed);
    }
    left -= Math.max(0, tail.offset - before);
    if (tail.offset >= st.size) t.files.set(tail.path, true);
  }
}

/** Indexes every session file by thread and session; a recently written one makes its thread known. */
async function scan(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const files = new Map<string, RolloutFile[]>();
    const threads = new Map<string, Set<string>>();
    const sessions = new Map<string, string>();
    for (const f of listRollouts(codexHome())) {
      const session = sessionOfPath.get(f.path) ?? (await sessionOfFile(f.path).catch((err: Error) => void log(`codex-reporter: reading ${f.path}: ${err.message}`)));
      if (!session) continue; // no complete first line yet: tried again at the next scan
      sessions.set(f.path, session);
      files.set(f.thread, [...(files.get(f.thread) ?? []), f]);
      threads.set(session, (threads.get(session) ?? new Set()).add(f.thread));
    }
    for (const list of files.values()) list.sort((a, b) => Number(a.path.endsWith('.zst')) - Number(b.path.endsWith('.zst')) || b.mtimeMs - a.mtimeMs);
    filesOf = files;
    threadsIn = threads;
    sessionOfPath = sessions;
    indexed = true;
    const now = Date.now();
    for (const [id, list] of files) if (now - list[0]!.mtimeMs <= LIVE_WINDOW_MS) fleet.indexedThread(id, sessions.get(list[0]!.path)!);
  } finally {
    scanning = false;
  }
}

/**
 * A thread follows its newest file: the first time one is found, and again when Codex moves it to a new one (a resume or a revert
 * writes a new file; compression replaces a cold one, and a resume restores it). A plain file a hook named that the index has not
 * seen yet is kept.
 */
function follow(t: Thread): void {
  const list = filesOf.get(t.id);
  const newest = list?.[0];
  if (!newest || newest.path === t.rollout?.path) return;
  if (t.rollout?.tail && !list!.some((f) => f.path === t.rollout!.path) && fs.existsSync(t.rollout.path)) return;
  fleet.setRollout(t, newest.path);
}

/**
 * Every indexed file of each reported session is read: each thread's newest through every record (a plain one tailed by
 * readSessionFiles), every other file whole once for its usage records, so a session's usage spans all of its threads and files.
 */
function attach(now: number): void {
  for (const s of [...fleet.sessions.values()]) {
    if (!reported(s, now)) continue;
    for (const id of threadsIn.get(s.id) ?? []) {
      const t = fleet.indexedThread(id, s.id);
      follow(t);
      for (const f of filesOf.get(id) ?? []) {
        if (t.files.has(f.path) || (f.path === t.rollout?.path && t.rollout.tail)) continue;
        t.files.set(f.path, false);
        wholeReads = wholeReads.then(() => readWhole(t, f.path));
      }
    }
  }
}

/**
 * One file read whole, streamed: a thread's compressed newest file through every record (so a compressed child is known to have
 * finished), any other file for its usage records alone, each priced at the `turn_context` model in effect in that file. A file
 * that cannot be read is logged and stays unread, so its session's usage stays unknown.
 */
async function readWhole(t: Thread, file: string): Promise<void> {
  const full = t.rollout?.path === file && !t.rollout.tail;
  let model: string | null = null;
  try {
    for await (const line of fileLines(file)) {
      // Forgotten, or no longer the file the thread follows: what is left is read again if it is still needed.
      if (fleet.threads.get(t.id) !== t || (full && t.rollout?.path !== file)) {
        t.files.delete(file);
        return;
      }
      const parsed = parseRolloutLine(line.text, line.at, !full);
      if (!parsed) continue;
      if (full) fleet.applyRollout(t, parsed);
      else if (parsed.record.kind === 'turnContext') model = parsed.record.model ?? model;
      else if (parsed.record.kind === 'usage') fleet.addUsage(t, parsed.record, model);
    }
    t.files.set(file, true);
  } catch (err) {
    log(`codex-reporter: reading ${file}: ${(err as Error).message}`);
  }
}

/**
 * Whether a session's usage is complete: the index has been built since this start, and every file of the session it lists has
 * been read to its end once. Until then its reports carry none, so the server books no partial figure as spend. Once complete it
 * stays so: a file found later only adds records, and nothing is kept across a restart or a forget, after which it is rebuilt.
 */
function usageReady(s: Session): boolean {
  s.usageReady ||= indexed && [...(threadsIn.get(s.id) ?? [])].every((id) => (filesOf.get(id) ?? []).every((f) => fleet.threads.get(id)?.files.get(f.path) === true));
  return s.usageReady;
}

/** Git polling, in the session's cwd. */
async function pollGit(s: Session): Promise<void> {
  const cwd = fleet.cwdOf(s);
  if (!cwd || gitBusy.has(s.id)) return;
  gitBusy.add(s.id);
  try {
    const git = gitRunner(cwd);
    if (s.placeCwd !== cwd) {
      const place = await placeOf(git, cwd);
      s.placeCwd = cwd;
      s.projectRoot = place.projectRoot;
      s.repoName = place.repoName;
      s.dirty = true;
    }
    s.git = await readGit(git, cwd);
    const changes = await readChanges(git, cwd, s.gitBase ?? saved.gitBases[s.id] ?? null);
    if (changes) {
      s.files = changes.files;
      if (changes.base !== saved.gitBases[s.id]) {
        saved.gitBases[s.id] = changes.base;
        save();
      }
      s.gitBase = changes.base;
    } else if (!s.git) s.files = null;
    s.dirty = true;
  } catch (err) {
    log(`codex-reporter: git in ${cwd}: ${(err as Error).message}`);
  } finally {
    gitBusy.delete(s.id);
  }
}

/** Posts a report when one is due (`force`: now, unless one is in flight or the backoff holds). */
async function sendReport(s: Session, now: number, force: boolean): Promise<void> {
  let tr = transports.get(s.id);
  if (!tr) {
    tr = new Transport(serverUrl, token, HEARTBEAT_MS, log, 'codex-reporter', s.id);
    transports.set(s.id, tr);
  }
  tr.push(fleet.drainEvents(s));
  if (s.placeCwd === null) void pollGit(s); // the first read at once, not a poll interval later
  // A report names its machine, whose id is never made up: until it can be read, nothing is sent and the session stays dirty.
  const from = machine;
  if (from === null || !tr.ready(now, force || s.dirty)) return;
  s.dirty = false;
  const respond = responder.respondInfo(s);
  const wasResponding = tr.respond;
  const root = fleet.thread(s.id);
  const final = root.ended ? root.endedAt : null;
  const ready = usageReady(s);
  const outcome = await tr.send(
    (events) =>
      buildReport(fleet, s, events, {
        version: VERSION,
        daemonVersion: daemon.version?.appServerVersion ?? null,
        machine: from,
        activityFeed,
        respond,
        asks: tr.respond ? responder.asksFor(s.id) : null,
        notes: responder.notes,
        names: names.byId,
        usageReady: ready,
        now,
      }),
    now,
  );
  if (outcome === 'ok') {
    s.usagePending = !ready;
    fleet.setWatched(s, tr.watch);
    const deliveries = tr.deliveries;
    tr.deliveries = [];
    responder.handleDeliveries(s.id, deliveries);
    // A reply that turns responding on (off or unknown in the previous one) is a rejoin trigger for a thread already waiting;
    // any other reply is not, so a request the dashboard cannot answer is not replayed after every report.
    if (tr.respond && !wasResponding) for (const t of fleet.threadsOf(s.id)) void responder.considerRejoin(t.id);
  } else if (outcome !== 'rejected') s.dirty = true;
  if (final !== null && outcome !== 'later') s.finalFor = final;
}

/** Each tick reads and decides synchronously; posts run on their own (one per session at a time), so a slow server never stalls reading. */
let flushing = false;
async function flushOutbox(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    await responder.flushOutbox();
  } finally {
    flushing = false;
  }
}

function tick(): void {
  try {
    const now = Date.now();
    readHooks(spool, SPOOL_BUDGET);
    for (const t of fleet.threads.values()) follow(t);
    readSessionFiles(now);
    const named = threadNames(codexHome(), names);
    if (named !== names) {
      // Codex named or renamed a thread: every session's name is sent again.
      names = named;
      for (const s of fleet.sessions.values()) s.dirty = true;
    }
    responder.asyncQuestions();
    const forgotten = fleet.forget(now);
    for (const id of forgotten) {
      transports.delete(id);
      delete saved.gitBases[id];
    }
    if (forgotten.length) save();
    // After forget, so the threads it places never keep alive a session that had nothing recent (one the spool replayed at start).
    attach(now);
    for (const s of fleet.sessions.values()) {
      const root = fleet.thread(s.id);
      if (root.ended) {
        // The final report waits for the session's usage to be complete and is sent until the server takes it (or refuses it
        // for good); then the session is no longer reported.
        if (s.finalFor !== root.endedAt) {
          responder.sessionEnded(s.id);
          if (usageReady(s)) void sendReport(s, now, true).catch((err: Error) => log(`codex-reporter: report: ${err.message}`));
        }
        continue;
      }
      if (reported(s, now)) void sendReport(s, now, false).catch((err: Error) => log(`codex-reporter: report: ${err.message}`));
    }
    responder.pump();
    void flushOutbox();
  } catch (err) {
    log(`codex-reporter: ${(err as Error).stack ?? String(err)}`);
  }
}

/** The reason this machine's id could not be read, as last logged. */
let unreadMachine = '';

/**
 * Reads this machine, at start and then every SCAN_MS until its id can be read (machine.ts makes one only for a missing file).
 * Each new reason it cannot is logged.
 */
async function readThisMachine(): Promise<void> {
  if (machine !== null) return;
  try {
    machine = await readMachine();
    log(`codex-reporter ${VERSION}: reporting to ${serverUrl} as ${machine.name} (respond ${level}, activity feed ${activityFeed ? 'on' : 'off'})`);
  } catch (err) {
    const why = (err as Error).message;
    if (why !== unreadMachine) log(`codex-reporter: not reporting or answering: this machine's id cannot be read (${why})`);
    unreadMachine = why;
  }
}

async function main(): Promise<void> {
  await readThisMachine();
  if (!token) log('codex-reporter: CODEX_REPORTER_TOKEN is not set; the server will refuse reports if it has an admin secret');
  // What the hooks wrote before this start, oldest first: hook-only facts survive a reporter restart.
  readHooks(new JsonlTail(`${spoolPath}.1`), Number.MAX_SAFE_INTEGER);
  for (let before = -1; spool.offset !== before && !spool.caughtUp(); ) {
    before = spool.offset;
    readHooks(spool, SPOOL_BUDGET);
  }
  const scanned = () => void scan().catch((err: Error) => log(`codex-reporter: scan: ${err.stack ?? err.message}`));
  scanned();
  daemon.start();
  setInterval(tick, FLUSH_MS);
  setInterval(scanned, SCAN_MS);
  setInterval(() => void readThisMachine(), SCAN_MS);
  setInterval(() => {
    for (const s of fleet.sessions.values()) if (fleet.isLive(s)) void pollGit(s);
  }, GIT_POLL_MS);
  const stop = () => {
    daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
