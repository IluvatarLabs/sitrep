// Where a session works in git: the branch (or a detached head), a worktree, and commits ahead of and behind its upstream. The
// main checkout and a count of modified files or a clean tree say nothing; the changed files beside the page carry the lines.
// Unknown when git is not reported.
import type { GitInfo } from "../../types";
import { Unknown } from "../../ui/Unknown";
import { Dots } from "../../ui/Dots";
import type { Part } from "./bits";

const BRANCH = (
  <svg className="sv-ic" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <circle cx="4.5" cy="3.5" r="1.6" />
    <circle cx="4.5" cy="12.5" r="1.6" />
    <circle cx="11.5" cy="5.5" r="1.6" />
    <path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-7 1.8-7 3.8" />
  </svg>
);

/**
 * The git facts as parts, each drawn with its own hover note and said in words, for a line that joins them with others.
 * `cwd`: the directory shown beside them; a worktree it already names is then said as "worktree" alone.
 */
export function gitFacts(git: GitInfo | null, cwd?: string): Part[] {
  if (!git) {
    const why = "Git is not reported: the session may not be in a repository";
    return [{ key: "none", text: "git not reported", node: <Unknown reason={why} /> }];
  }
  const tree = git.worktreePath?.split("/").filter(Boolean).pop() ?? null;
  const branch = `${git.branch ?? "unknown branch"}${git.detached ? " (detached)" : ""}`;
  const named = tree !== null && cwd !== undefined && cwd.split("/").filter(Boolean).pop() === tree;
  const checkout = `worktree${tree && !named ? ` ${tree}` : ""}`;
  const facts: (Part | null)[] = [
    {
      key: "branch",
      text: branch,
      node: (
        <span className="sv-git" title={`${git.detached ? "Detached HEAD" : "Branch"}: ${git.branch ?? "unknown"}`}>
          {BRANCH}
          <span className="sv-mono">{git.branch ?? "unknown"}</span>
          {git.detached ? " (detached)" : null}
        </span>
      ),
    },
    git.isWorktree ? { key: "tree", text: checkout, node: <span title={`Git worktree at ${git.worktreePath ?? "an unknown path"}`}>{checkout}</span> } : null,
    git.ahead > 0 ? { key: "ahead", text: `${git.ahead} ahead`, node: <span title="Commits ahead of the upstream">{`${git.ahead} ahead`}</span> } : null,
    git.behind > 0 ? { key: "behind", text: `${git.behind} behind`, node: <span title="Commits behind the upstream">{`${git.behind} behind`}</span> } : null,
  ];
  return facts.filter((f): f is Part => f !== null);
}

export function GitFacts({ git }: { git: GitInfo | null }) {
  return <Dots items={gitFacts(git).map((f) => f.node ?? f.text)} />;
}
