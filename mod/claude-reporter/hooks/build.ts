// Which build of the mod runs. A release has none; a mod run straight from a checkout of this repository is a dev build,
// named by its commit. An installed copy has no repository, so it is always a release.
import { GIT, type Runner } from './git.ts';

/**
 * The dev build of the mod at `root` (`$.plugin.root`): its short commit, with `-dirty` after local edits. Null for a clean
 * checkout of a `vMAJOR.MINOR.PATCH` tag, an installed copy, or when git cannot say.
 */
export async function devBuild(run: Runner, root: string): Promise<string | null> {
  /** What `git -C <root> <args>` printed, trimmed; null when it exits non-zero. */
  const git = async (...args: string[]): Promise<string | null> => {
    const { exitCode, stdout } = await run([...GIT, '-C', root, ...args]);
    return exitCode === 0 ? stdout.trim() : null;
  };
  try {
    // A copy of the mod inside some other repository (a home folder kept in git) does not track this manifest: no dev build.
    if ((await git('ls-files', '--error-unmatch', '.claude-plugin/plugin.json')) === null) return null;
    const hash = await git('rev-parse', '--short=8', 'HEAD');
    if (!hash) return null;
    // A status git cannot give reads as clean, and a tag it cannot give as none.
    if (await git('status', '--porcelain', '--', '.')) return `${hash}-dirty`;
    const tag = (await git('describe', '--exact-match', '--tags', 'HEAD')) ?? '';
    return /^v\d+\.\d+\.\d+$/.test(tag) ? null : hash;
  } catch {
    return null;
  }
}

/** A version with its dev build after it as semver build metadata (`0.1.0+a1b2c3d4`); the version alone for a release. */
export const withBuild = (version: string, build: string | null | undefined): string => (build ? `${version}+${build}` : version);
