// A session's changed files: a summary line, a page of files with their status and line counts, and a pager. Paths and line
// counts only; no diffs leave the machine. No changed files, no list.
import { useState } from "react";
import { plural } from "../format";
import type { ChangedFile, FilesReport } from "../types";
import { Dots } from "../ui/Dots";
import "../views/session/session.css";
import { PageNav } from "./PageNav";

/** Files per page; a reporter sends at most 200, so at most ten pages. */
const PER_PAGE = 20;
const STATUS_LETTER: Record<ChangedFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

/** What the list is measured from when the commit the session started from is gone (a rebase or amend); null from the start. */
const SINCE_WORDS: Record<FilesReport["since"], string | null> = { start: null, upstream: "Since the branch's upstream", worktree: "Working tree only" };

/** A path as its folder (with the trailing slash) and its file name. */
function splitPath(path: string): [string, string] {
  const cut = path.lastIndexOf("/") + 1;
  return [path.slice(0, cut), path.slice(cut)];
}

/**
 * Five blocks: added lines' share in green, the removed lines' in red; any added line shows at least one added block and
 * any removed line at least one removed. Decoration: the counts carry the numbers.
 */
function ShareBlocks({ lines }: { lines: { added: number; removed: number } }) {
  const total = lines.added + lines.removed;
  const share = total === 0 ? 0 : Math.round((5 * lines.added) / total);
  const addedBlocks = total === 0 ? 0 : Math.min(lines.removed > 0 ? 4 : 5, Math.max(lines.added > 0 ? 1 : 0, share));
  return (
    <span className="fl-bars" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className={total === 0 ? undefined : i < addedBlocks ? "add" : "del"} />
      ))}
    </span>
  );
}

/** Lines added and removed, as +12 −3. */
function LineCounts({ lines }: { lines: { added: number; removed: number } }) {
  return (
    <span className="fl-cnt sv-num">
      <span className="add">{`+${lines.added}`}</span>
      <span className="del">{`−${lines.removed}`}</span>
    </span>
  );
}

/** One changed file: its status letter, its name with its folder (and where a renamed file came from), and its line counts. */
function FileRow({ file }: { file: ChangedFile }) {
  const [dir, name] = splitPath(file.path);
  const letter = STATUS_LETTER[file.status];
  const renamedFrom = file.status === "renamed" && file.from ? file.from : null;
  const where =
    dir || renamedFrom ? (
      <i className="sv-mono">
        <bdi>{dir}</bdi>
        {renamedFrom ? `, renamed from ${renamedFrom}` : null}
      </i>
    ) : null;
  const lines =
    file.added === null || file.removed === null ? (
      <span className="fl-cnt sv-muted">binary</span>
    ) : (
      <>
        <LineCounts lines={{ added: file.added, removed: file.removed }} />
        <ShareBlocks lines={{ added: file.added, removed: file.removed }} />
      </>
    );
  return (
    <li className={`fl-row ${file.status}`}>
      <span className="fl-st sv-mono" aria-hidden="true" title={file.status}>
        {letter}
      </span>
      <span className="fl-fn" title={file.path}>
        <b className="sv-mono">{name}</b>
        <span className="ui-vh">{` (${file.status})`}</span>
        {where}
      </span>
      <span className="fl-df">{lines}</span>
    </li>
  );
}

/** The session page's Files: a summary line, a page of files and a pager; nothing while no file has changed. */
export function FilesList({ report }: { report: FilesReport | null }) {
  const [page, setPage] = useState(0);
  const files = report?.files ?? [];
  if (!report || files.length === 0) return null;
  const pages = Math.ceil(files.length / PER_PAGE);
  const at = Math.min(page, pages - 1);
  const first = at * PER_PAGE;
  const shown = files.slice(first, first + PER_PAGE);
  // The reporter lists at most 200; the summary counts them all.
  const capped = report.total > files.length ? `First ${files.length} of ${report.total}` : null;
  return (
    <>
      <p className="fl-sum">
        <Dots items={[plural(report.total, "file"), <LineCounts key="n" lines={report} />, SINCE_WORDS[report.since], capped]} />
      </p>
      <ul className="fl-list">
        {shown.map((f) => (
          <FileRow key={f.path} file={f} />
        ))}
      </ul>
      {pages > 1 ? <PageNav label="Files pages" at={at} pages={pages} from={first} shown={shown.length} total={files.length} perPage={PER_PAGE} onPage={setPage} compact /> : null}
    </>
  );
}
