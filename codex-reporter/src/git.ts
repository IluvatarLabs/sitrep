// Git state of a session's working directory (branch, worktree, ahead/behind, the dirty count, and the files changed since the
// session began), read by running `git` in the thread's cwd. Every query runs as `git --no-optional-locks …`
// (gitRunner) and is limited to 5 s; the parsers below are pure.
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ChangedFile, FileStatus, FilesReport, GitInfo } from '../../server/src/fleet/protocol.js';
import { lastSegment } from './report.js';

export interface RunResult {
  exitCode: number;
  stdout: string;
}
/** `git <args>` in one working directory. */
export type Git = (args: string[]) => Promise<RunResult>;

/**
 * `git` in `cwd`, 5 s at most; a failure to start is exit code 1. Every command runs as `git --no-optional-locks …`: these
 * reads run in the background, so none may take the optional index lock that `git status` would take to write back its
 * refreshed index ("Scripts running status in the background should consider using git --no-optional-locks status",
 * git-status(1) BACKGROUND REFRESH).
 */
export function gitRunner(cwd: string): Git {
  return (args) =>
    new Promise((resolve) => {
      execFile('git', ['--no-optional-locks', ...args], { cwd, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ exitCode: code, stdout: String(stdout ?? '') });
      });
    });
}

// ---- branch, worktree, status ------------------------------------------------------------------------

/**
 * Counts from `git status --porcelain=v1 -b`. Its first line, `## branch...upstream [ahead N, behind M]`, carries ahead and
 * behind (0 when absent); each line after it is one dirty path.
 */
function statusCounts(stdout: string): { ahead: number; behind: number; dirty: number } {
  const rows = stdout.split('\n').filter((row) => row !== '');
  const header = rows[0]?.startsWith('##') ? rows.shift()! : '';
  const count = (word: 'ahead' | 'behind') => Number(new RegExp(`${word} (\\d+)`).exec(header)?.[1] ?? 0);
  return { ahead: count('ahead'), behind: count('behind'), dirty: rows.length };
}

/** The branch (or short commit when detached), whether `cwd` is a linked worktree, and the status counts; null outside a repository. */
export async function readGit(git: Git, cwd: string): Promise<GitInfo | null> {
  /** `git rev-parse …`, trimmed; any failure ends the read. */
  const revParse = async (...args: string[]) => {
    const r = await git(['rev-parse', ...args]);
    if (r.exitCode !== 0) throw new Error(`git rev-parse ${args.join(' ')}: exit ${r.exitCode}`);
    return r.stdout.trim();
  };
  try {
    const [ref, gitDir, commonDir, top, st] = await Promise.all([
      revParse('--abbrev-ref', 'HEAD'),
      revParse('--git-dir'),
      revParse('--git-common-dir'),
      revParse('--show-toplevel'),
      git(['status', '--porcelain=v1', '-b']),
    ]);
    // A linked worktree has its own git dir inside the main repository's common dir.
    const linked = path.posix.resolve(cwd, gitDir) !== path.posix.resolve(cwd, commonDir);
    const detached = ref === 'HEAD';
    return {
      branch: detached ? await revParse('--short', 'HEAD').catch(() => null) : ref,
      detached,
      isWorktree: linked,
      worktreePath: linked ? top : null,
      ...(st.exitCode === 0 ? statusCounts(st.stdout) : { ahead: 0, behind: 0, dirty: 0 }),
    };
  } catch {
    return null;
  }
}

// ---- files changed since the session began --------------------------------------------------------------

/** Git's empty tree: what a repository without commits is compared with. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Files listed per report (the totals count every file). */
const MAX_FILES = 200;
/** Untracked paths per `git grep -c` line count. */
const GREP_CHUNK = 100;
/** Untracked files `git grep` skips (empty, binary) counted one `git diff --no-index` each, at most this many per read. */
const NUMSTAT_LIMIT = 20;
/** A listed path is cut to this length. */
const PATH_CUT = 300;

interface Changed {
  status: FileStatus;
  path: string;
  from: string | null;
}

interface Counts {
  added: number | null;
  removed: number | null;
}

/** `git diff --name-status -z -M`: a status letter, then the path; a rename or copy (`R100`, `C75`) gives the old path and then the new. */
function changedPaths(stdout: string): Changed[] {
  const fields = stdout.split('\0');
  const out: Changed[] = [];
  let i = 0;
  while (i < fields.length) {
    const code = fields[i++];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const before = fields[i++];
      const after = fields[i++];
      if (after) out.push(letter === 'R' ? { status: 'renamed', path: after, from: before ?? null } : { status: 'added', path: after, from: null });
    } else {
      const only = fields[i++];
      if (only) out.push({ status: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified', path: only, from: null });
    }
  }
  return out;
}

const NUMSTAT_ROW = /^(-|\d+)\t(-|\d+)\t(.*)$/s;

/**
 * `git diff --numstat -z -M` by (new) path: `added<TAB>removed<TAB>path`, `-` for a binary file's counts. A rename leaves the
 * path empty and gives the old path and the new one as the next two fields.
 */
function lineCounts(stdout: string): Map<string, Counts> {
  const fields = stdout.split('\0');
  const byPath = new Map<string, Counts>();
  const n = (v: string) => (v === '-' ? null : Number(v));
  let i = 0;
  while (i < fields.length) {
    const row = NUMSTAT_ROW.exec(fields[i++] ?? '');
    if (!row) continue;
    let name = row[3] ?? '';
    if (name === '') {
      i++; // the old path of a rename
      name = fields[i++] ?? '';
    }
    if (name) byPath.set(name, { added: n(row[1]!), removed: n(row[2]!) });
  }
  return byPath;
}

/** `git -C <top> …`'s output; an exit code outside `ok` throws, which ends the read. */
type InTop = (args: string[], ok?: readonly number[]) => Promise<string>;

/**
 * The commit the Files list compares with, and which kind it is: the session's starting commit while HEAD still contains it,
 * else (after a rebase, an amend, a branch switch) the merge base with the upstream, else HEAD itself.
 */
async function compareBase(git: Git, top: string, start: string, head: string | null): Promise<{ ref: string; since: FilesReport['since'] }> {
  if (start === EMPTY_TREE || (await git(['-C', top, 'merge-base', '--is-ancestor', start, 'HEAD'])).exitCode === 0) return { ref: start, since: 'start' };
  const upstream = await git(['-C', top, 'merge-base', 'HEAD', '@{upstream}']);
  const mergeBase = upstream.exitCode === 0 ? upstream.stdout.trim() : '';
  return mergeBase ? { ref: mergeBase, since: 'upstream' } : { ref: head || EMPTY_TREE, since: 'worktree' };
}

/**
 * Line counts for listed untracked files, which `git diff` does not cover, written into `files`. One `git grep -c` per chunk
 * counts every text file in it; the ones it leaves out (empty or binary) get a `git diff --no-index` each, the first
 * NUMSTAT_LIMIT only; the rest stay uncounted.
 */
async function countUntracked(inTop: InTop, files: ChangedFile[]): Promise<void> {
  const uncounted = new Set(files);
  const searchable = files.filter((f) => !f.path.includes('\n'));
  for (let from = 0; from < searchable.length; from += GREP_CHUNK) {
    const chunk = new Map(searchable.slice(from, from + GREP_CHUNK).map((f) => [f.path, f] as const));
    const out = await inTop(['--literal-pathspecs', 'grep', '--no-index', '-I', '-c', '-z', '', '--', ...chunk.keys()], [0, 1]);
    for (const row of out.split('\n')) {
      const nul = row.lastIndexOf('\0');
      const file = nul > 0 ? chunk.get(row.slice(0, nul)) : undefined;
      const lines = Number(row.slice(nul + 1));
      if (!file || !Number.isInteger(lines)) continue;
      Object.assign(file, { added: lines, removed: 0 });
      uncounted.delete(file);
    }
  }
  const each = [...uncounted].slice(0, NUMSTAT_LIMIT);
  // diff.autoRefreshIndex=false, as for every porcelain `git diff` here, so none writes the index under index.lock (git-config(1)).
  const outputs = await Promise.all(each.map((f) => inTop(['-c', 'diff.autoRefreshIndex=false', 'diff', '--no-index', '--numstat', '-z', '--', '/dev/null', f.path], [0, 1])));
  each.forEach((f, k) => {
    const c = lineCounts(outputs[k]!).get(f.path);
    f.added = c?.added ?? null;
    f.removed = c?.removed ?? null;
  });
}

/**
 * The files changed since the session began. `base` is the commit HEAD was at when the reporter first read the session, or
 * null on that first read (which takes HEAD, or the empty tree before the first commit). Null when a query fails, so the
 * caller keeps what it had.
 */
export async function readChanges(git: Git, cwd: string, base: string | null): Promise<{ base: string; files: FilesReport } | null> {
  try {
    const top = (await git(['rev-parse', '--show-toplevel'])).stdout.trim() || cwd;
    const inTop: InTop = async (args, ok = [0]) => {
      const r = await git(['-C', top, ...args]);
      if (!ok.includes(r.exitCode)) throw new Error(`git ${args.join(' ')}: exit ${r.exitCode}`);
      return r.stdout;
    };
    const headRun = await git(['-C', top, 'rev-parse', 'HEAD']);
    const head = headRun.exitCode === 0 ? headRun.stdout.trim() : null;
    // The commit the session started from: the one kept from its first read, else HEAD now (the empty tree before any commit).
    const sessionStart = base ?? head ?? EMPTY_TREE;
    const { ref, since } = await compareBase(git, top, sessionStart, head);
    const [nameStatus, numstat, untracked] = await Promise.all([
      // diff.autoRefreshIndex=false: porcelain `git diff` otherwise writes the refreshed index under index.lock (git-config(1)).
      inTop(['-c', 'diff.autoRefreshIndex=false', 'diff', '--name-status', '-z', '-M', ref]),
      inTop(['-c', 'diff.autoRefreshIndex=false', 'diff', '--numstat', '-z', '-M', ref]),
      inTop(['ls-files', '-z', '--others', '--exclude-standard', '--full-name']),
    ]);
    const counts = lineCounts(numstat);
    const tracked = changedPaths(nameStatus);
    const trackedPaths = new Set(tracked.map((c) => c.path));
    const all: ChangedFile[] = tracked.map((c) => ({ ...c, added: counts.get(c.path)?.added ?? null, removed: counts.get(c.path)?.removed ?? null }));
    for (const p of untracked.split('\0')) if (p) all.push({ path: p, status: 'added', from: null, added: null, removed: null });
    all.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
    // Only listed files are counted, so pick them after sorting; every file still counts toward the totals.
    await countUntracked(
      inTop,
      all.slice(0, MAX_FILES).filter((f) => !trackedPaths.has(f.path)),
    );
    let added = 0;
    let removed = 0;
    for (const f of all) {
      added += f.added ?? 0;
      removed += f.removed ?? 0;
    }
    const listed = all.slice(0, MAX_FILES).map((f) => ({ ...f, path: f.path.slice(0, PATH_CUT), from: f.from === null ? null : f.from.slice(0, PATH_CUT) }));
    return { base: sessionStart, files: { files: listed, total: all.length, added, removed, since } };
  } catch {
    return null;
  }
}

/** `owner/name` from the last two path parts of an origin URL (`git@host:owner/name.git`, `https://host/owner/name/`); null otherwise. */
function repoOf(origin: string): string | null {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(origin);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The project root and repository name for `cwd`: from git run there (the common dir's parent, the origin remote), else the folder. */
export async function placeOf(git: Git, cwd: string): Promise<{ projectRoot: string; repoName: string }> {
  /** A query's trimmed output; empty when git fails. */
  const out = (args: string[]) => git(args).then((r) => (r.exitCode === 0 ? r.stdout.trim() : ''));
  const commonDir = (await out(['rev-parse', '--path-format=absolute', '--git-common-dir'])).replace(/\/$/, '');
  // A checkout's common dir is `<root>/.git` (a linked worktree's too: it is the main checkout's); any other is taken as the
  // root; no answer means the folder.
  let projectRoot = commonDir || cwd;
  if (commonDir.endsWith('/.git')) projectRoot = commonDir.slice(0, commonDir.length - '/.git'.length);
  return { projectRoot, repoName: repoOf(await out(['config', '--get', 'remote.origin.url'])) ?? lastSegment(projectRoot) };
}
