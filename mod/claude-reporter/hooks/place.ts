// Where a session works, and noticing that it moved: the desktop app moves a pre-warmed spare session to the project the
// person picks without restarting it. Pure apart from the `$` handed in.
import type { EngineInterface, SessionRepo } from 'claude-code';
import { GIT, lastSegment, type Runner } from './git.ts';
import { repoFromRemote } from './report.ts';

/** Where a session works: the repository's top folder (the folder itself outside one) and the repository's shown name. */
export interface Place {
  projectRoot: string;
  repoName: string;
}

/** A move `follow` found: the new folder and its place. */
export type Moved = Place & { cwd: string };

/** What `read` resolves to, or `fallback` when it throws or rejects. */
export async function quietly<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

/** A repository's shown name: Claude Code's, else `owner/name` from its origin remote, else its top folder's name. */
export const repoNameOf = (root: string, repo: Pick<SessionRepo, 'name' | 'remote'> | null | undefined): string =>
  repo?.name ?? repoFromRemote(repo?.remote) ?? lastSegment(root);

/** `dir` is `folder` or lies inside it. */
const within = (folder: string | null | undefined, dir: string): boolean => !!folder && (dir === folder || dir.startsWith(folder.endsWith('/') ? folder : `${folder}/`));

/**
 * The folder the session is in now. A hook's `cwd` wins unless it lies inside the place already held: it follows the shell,
 * so a `cd` into a subfolder is no move. Otherwise `$.session.cwd()` counts once its answer differs from the last one, and an
 * answer that stayed put never undoes a move a hook reported.
 */
function currentFolder(held: { cwd: string; projectRoot: string | null; sessionCwd: string | null }, answered: string | null, hookCwd?: string): string {
  if (hookCwd && !within(held.cwd, hookCwd) && !within(held.projectRoot, hookCwd)) return hookCwd;
  return answered && answered !== held.sessionCwd ? answered : held.cwd;
}

/**
 * The place of `cwd`: what `$.session` says while its folder holds `cwd`, else what git says run in `cwd` (the common dir's
 * parent, the origin remote), else the folder itself.
 */
async function placeAt(cwd: string, root: string | null, repo: SessionRepo | null, run: Runner): Promise<Place> {
  const sessionTop = repo?.root ?? root;
  if (sessionTop && within(sessionTop, cwd)) return { projectRoot: sessionTop, repoName: repoNameOf(sessionTop, repo) };
  const git = async (...args: string[]) => {
    const { exitCode, stdout } = await run([...GIT, ...args]);
    return exitCode === 0 ? stdout.trim() : '';
  };
  const common = (await git('rev-parse', '--path-format=absolute', '--git-common-dir')).replace(/\/$/, '');
  const projectRoot = common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : common || cwd;
  return { projectRoot, repoName: repoFromRemote(await git('config', '--get', 'remote.origin.url')) ?? lastSegment(projectRoot) };
}

/**
 * Follows a moved session from what the reporter holds (the folder and root reported now, and what `$.session.cwd()` last
 * answered). `moved` is null while the folder is the one held; `sessionCwd` is the answer to hold for next time.
 */
export async function follow(
  $: Pick<EngineInterface, 'session' | 'process'>,
  held: { cwd: string; projectRoot: string | null; sessionCwd: string | null },
  hookCwd?: string,
): Promise<{ sessionCwd: string | null; moved: Moved | null }> {
  const answered = await quietly<string | null>(() => $.session.cwd(), null);
  const sessionCwd = answered || held.sessionCwd;
  const cwd = currentFolder(held, answered, hookCwd);
  if (cwd === held.cwd) return { sessionCwd, moved: null };
  // A new folder: what the session says of it first, then git run inside it.
  const root = await quietly<string | null>(() => $.session.root(), null);
  const repo = await quietly(() => $.session.repo(), null);
  const runInCwd: Runner = async (argv) => {
    const done = await quietly(() => $.process.run(argv, { cwd, timeoutMs: 5000 }), null);
    return { exitCode: done?.exitCode ?? 1, stdout: done?.stdout ?? '' };
  };
  return { sessionCwd, moved: { cwd, ...(await placeAt(cwd, root, repo, runInCwd)) } };
}
