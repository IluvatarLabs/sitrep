// The session's repository: branch, worktree, ahead/behind/dirty, and the files changed since the
// session began. Parsing is pure; the queries go through a runner the mod builds on `$.process.run`.
import type { ChangedFile, FilesReport, GitInfo } from './protocol.ts';

/** Git's empty tree, the base of a repository that has no commit yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** How many files a report lists by name; its totals cover all of them. */
export const MAX_FILES = 200;
/** Paths handed to one `git grep` when line-counting untracked files. */
const GREP_CHUNK = 100;
/** Untracked files `git grep` cannot count (empty or binary) that get a numstat of their own, per read. */
const NUMSTAT_LIMIT = 20;

/** Runs a command and gives back how it exited and what it printed. */
export type Runner = (argv: string[]) => Promise<{ exitCode: number; stdout: string }>;

/**
 * How every git command the mod runs starts. They all run in the background, so none takes the optional index lock that
 * `git status` would (git-status(1), BACKGROUND REFRESH: "Scripts running status in the background should consider using
 * git --no-optional-locks status"), and the agents' own `git add`, `commit` or `checkout` never meet an index.lock of ours.
 */
export const GIT = ['git', '--no-optional-locks'] as const;
/**
 * `git diff` as the mod runs it. `--no-optional-locks` covers only `git status`: a porcelain diff against the work tree still
 * refreshes and writes the index (`refresh_index_quietly`), unless `diff.autoRefreshIndex` is false (git-config(1)).
 */
const DIFF = ['-c', 'diff.autoRefreshIndex=false', 'diff'] as const;

/** `path` resolved against the folder `dir` as a POSIX path; the hooks sandbox has no Node `path`. */
export function resolvePath(dir: string, path: string): string {
  const parts: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${dir}/${path}`).split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '' && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** The last segment of a path, its trailing slashes ignored. */
export const lastSegment = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

/** Commits ahead of and behind the upstream, and how many paths are changed. */
type Counts = Pick<GitInfo, 'ahead' | 'behind' | 'dirty'>;

/** `git status --porcelain=v1 -b`: ahead and behind from its `##` line; each other line is one changed path. */
function statusCounts(stdout: string): Counts {
  const lines = stdout.split('\n').filter((l) => l !== '');
  const branchLine = lines[0]?.startsWith('##') ? lines.shift()! : '';
  const count = (re: RegExp) => Number(re.exec(branchLine)?.[1] ?? 0);
  return { ahead: count(/ahead (\d+)/), behind: count(/behind (\d+)/), dirty: lines.length };
}

/** A command's stdout as printed; it throws unless the command exits with one of `okCodes`. */
async function outputOf(run: Runner, argv: string[], okCodes: readonly number[] = [0]): Promise<string> {
  const { exitCode, stdout } = await run(argv);
  if (!okCodes.includes(exitCode)) throw new Error(`${argv.join(' ')} exited ${exitCode}`);
  return stdout;
}

const NO_COUNTS: Counts = { ahead: 0, behind: 0, dirty: 0 };

/** Branch, worktree and status; null outside a repository or when a query fails. */
export async function gitInfo(run: Runner, cwd: string): Promise<GitInfo | null> {
  const revParse = async (...args: string[]) => (await outputOf(run, [...GIT, 'rev-parse', ...args])).trim();
  try {
    // The five queries run at once; any of the rev-parses failing means there is nothing to report.
    const [headName, gitDir, commonDir, top, status] = await Promise.all([
      revParse('--abbrev-ref', 'HEAD'),
      revParse('--git-dir'),
      revParse('--git-common-dir'),
      revParse('--show-toplevel'),
      run([...GIT, 'status', '--porcelain=v1', '-b']),
    ]);
    const detached = headName === 'HEAD';
    // A detached HEAD goes by its short commit, or by nothing when even that cannot be read.
    const branch = detached ? await revParse('--short', 'HEAD').catch(() => null) : headName;
    // A linked worktree has a git dir of its own apart from the shared one.
    const absolute = (dir: string) => resolvePath(cwd, dir);
    const isWorktree = absolute(gitDir) !== absolute(commonDir);
    const counts = status.exitCode === 0 ? statusCounts(status.stdout) : NO_COUNTS;
    return { branch, detached, isWorktree, worktreePath: isWorktree ? top : null, ...counts };
  } catch {
    return null;
  }
}

/** One entry of `git diff --name-status`: the file's path, how it changed, and a rename's old path. */
type NameStatus = Pick<ChangedFile, 'status' | 'path' | 'from'>;

/** `git diff --name-status -z -M`: `M\0path\0`, and `R100\0old\0new\0` for a rename (`C` a copy, listed as added). */
function nameStatuses(stdout: string): NameStatus[] {
  const fields = stdout.split('\0');
  const entries: NameStatus[] = [];
  let i = 0;
  while (i < fields.length) {
    const code = fields[i++];
    if (!code) continue;
    const kind = code.charAt(0);
    if (kind === 'R' || kind === 'C') {
      // Two names follow; a copy keeps only the new one and counts as added.
      const oldPath = fields[i];
      const path = fields[i + 1];
      i += 2;
      if (path) entries.push(kind === 'R' ? { status: 'renamed', path, from: oldPath ?? null } : { status: 'added', path, from: null });
    } else {
      const path = fields[i++];
      if (path) entries.push({ status: kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified', path, from: null });
    }
  }
  return entries;
}

/** Lines added and removed; null where git cannot count them (a binary file). */
type LineCount = Pick<ChangedFile, 'added' | 'removed'>;

const NUMSTAT_ROW = /^(-|\d+)\t(-|\d+)\t(.*)$/s;
const lineCount = (v: string): number | null => (v === '-' ? null : Number(v));

/** `git diff --numstat -z -M` by (new) path. A binary file counts `-`; a rename has an empty path with both names after it. */
function lineCounts(stdout: string): Map<string, LineCount> {
  const fields = stdout.split('\0');
  const byPath = new Map<string, LineCount>();
  let i = 0;
  while (i < fields.length) {
    const row = NUMSTAT_ROW.exec(fields[i++] ?? '');
    if (!row) continue;
    const [, added, removed, named] = row;
    let path = named ?? '';
    if (path === '') {
      // The old name, then the new one.
      path = fields[i + 1] ?? '';
      i += 2;
    }
    if (path) byPath.set(path, { added: lineCount(added!), removed: lineCount(removed!) });
  }
  return byPath;
}

/**
 * What the files list diffs against, and which base that is: the starting commit while HEAD still descends from it, else
 * the upstream merge base, else HEAD itself (a rebase, an amend or a branch switch can drop the starting commit).
 */
async function diffBase(run: Runner, top: string, start: string, head: string | null): Promise<{ ref: string; since: FilesReport['since'] }> {
  const inTop = (...args: string[]) => run([...GIT, '-C', top, ...args]);
  if (start === EMPTY_TREE) return { ref: start, since: 'start' };
  const descends = (await inTop('merge-base', '--is-ancestor', start, 'HEAD')).exitCode === 0;
  if (descends) return { ref: start, since: 'start' };
  const upstream = await inTop('merge-base', 'HEAD', '@{upstream}');
  const mergeBase = upstream.exitCode === 0 ? upstream.stdout.trim() : '';
  if (mergeBase) return { ref: mergeBase, since: 'upstream' };
  return { ref: head || EMPTY_TREE, since: 'worktree' };
}

export interface Changes {
  /** The starting commit, handed back on the next read. */
  base: string;
  files: FilesReport;
}

/** An untracked file's line counts from a numstat against /dev/null; both unknown when git gives none. */
async function countAgainstNull(run: Runner, top: string, path: string): Promise<LineCount> {
  const numstat = await outputOf(run, [...GIT, '-C', top, ...DIFF, '--no-index', '--numstat', '-z', '--', '/dev/null', path], [0, 1]);
  return lineCounts(numstat).get(path) ?? { added: null, removed: null };
}

/**
 * Fills in line counts for untracked files, in place. One `git grep -c` per chunk counts every text file in it; the empty and
 * binary files it skips get a numstat each, the first NUMSTAT_LIMIT of them only; the rest stay uncounted.
 */
async function countUntracked(run: Runner, top: string, files: readonly ChangedFile[]): Promise<void> {
  const counted = new Set<string>();
  // grep prints one line per file, so a path holding a line break could not be read back.
  const grepable = files.filter((f) => !f.path.includes('\n'));
  for (let from = 0; from < grepable.length; from += GREP_CHUNK) {
    const byPath = new Map(grepable.slice(from, from + GREP_CHUNK).map((f) => [f.path, f] as const));
    const grep = await outputOf(run, [...GIT, '-C', top, '--literal-pathspecs', 'grep', '--no-index', '-I', '-c', '-z', '', '--', ...byPath.keys()], [0, 1]);
    for (const row of grep.split('\n')) {
      const nul = row.lastIndexOf('\0');
      const file = nul > 0 ? byPath.get(row.slice(0, nul)) : undefined;
      const lines = Number(row.slice(nul + 1));
      if (file === undefined || !Number.isInteger(lines)) continue;
      file.added = lines;
      file.removed = 0;
      counted.add(file.path);
    }
  }
  const leftover = files.filter((f) => !counted.has(f.path)).slice(0, NUMSTAT_LIMIT);
  const counts = await Promise.all(leftover.map((f) => countAgainstNull(run, top, f.path)));
  for (let j = 0; j < leftover.length; j++) {
    leftover[j]!.added = counts[j]!.added;
    leftover[j]!.removed = counts[j]!.removed;
  }
}

/**
 * The files changed since the session began. `base` is the commit HEAD was at then, or null on the first read, which takes
 * HEAD (the empty tree before a first commit). Only paths and line counts are read, never contents. Null when a query
 * fails, so the caller keeps what it had.
 */
export async function changedFiles(run: Runner, cwd: string, base: string | null): Promise<Changes | null> {
  try {
    const top = (await run([...GIT, 'rev-parse', '--show-toplevel'])).stdout.trim() || cwd;
    const inTop = (...args: string[]) => [...GIT, '-C', top, ...args];
    const headRun = await run(inTop('rev-parse', 'HEAD'));
    const head = headRun.exitCode === 0 ? headRun.stdout.trim() : null;
    const from = base ?? head ?? EMPTY_TREE;
    const { ref, since } = await diffBase(run, top, from, head);
    const [nameStatus, numstat, untracked] = await Promise.all([
      // The index is never refreshed here: a file whose only change is its stat info shows as modified until git next refreshes it.
      outputOf(run, inTop(...DIFF, '--name-status', '-z', '-M', ref)),
      outputOf(run, inTop(...DIFF, '--numstat', '-z', '-M', ref)),
      outputOf(run, inTop('ls-files', '-z', '--others', '--exclude-standard', '--full-name')),
    ]);
    const lines = lineCounts(numstat);
    const tracked = nameStatuses(nameStatus);
    const trackedPaths = new Set(tracked.map((t) => t.path));
    const files: ChangedFile[] = tracked.map(({ path, status, from }) => ({ path, status, from, added: lines.get(path)?.added ?? null, removed: lines.get(path)?.removed ?? null }));
    for (const path of untracked.split('\0')) if (path !== '') files.push({ path, status: 'added', from: null, added: null, removed: null });
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Counted after sorting, so only the untracked files a report lists cost a query; the others still add to the total.
    await countUntracked(run, top, files.slice(0, MAX_FILES).filter((f) => !trackedPaths.has(f.path)));
    let added = 0;
    let removed = 0;
    for (const f of files) {
      added += f.added ?? 0;
      removed += f.removed ?? 0;
    }
    return { base: from, files: { files: files.slice(0, MAX_FILES), total: files.length, added, removed, since } };
  } catch {
    return null;
  }
}
