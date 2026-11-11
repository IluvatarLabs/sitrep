#!/usr/bin/env node
// SITREP Codex hook: reads one Codex hook event on stdin and appends one compact line to ~/.sitrep/codex-hooks.ndjson
// (owner-only), renaming it to `.1` above 5 MB.
//
// Kept: ids, the event, cwd, model, tool name and call id, the file paths an apply_patch names and the change each of its
// headers makes there (add, delete, update, move), the compaction trigger, this script's own timestamp, and a bounded,
// redacted one-line summary of a tool call (its name and main argument, at most 300 characters); and on an apply_patch
// PreToolUse line, the patch body, its content lines redacted and at most 20,000 characters, which its file approval shows (it
// stays in this spool until the spool rotates).
// Never kept: prompts, tool output, assistant messages, any other patch text, or anything else the event carries.
// Never touches the network, never prints, never decides anything; always exits 0. Codex copies an installed plugin
// directory into its cache, so this file imports nothing outside Node and this directory (redact.mjs, shared with the reporter).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact, redactFreeText } from './redact.mjs';

const MAX_BYTES = 5 * 1024 * 1024;
const PATH_MAX = 1024;

const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * One line: controls removed, whitespace collapsed, cut to 4,000 before redaction (so a secret is never cut into a stub), then
 * to `max`. A line cut at 4,000 loses its last, partial token (its final run of non-whitespace, matched from the start, which
 * is linear), so a secret cut there is never shown in part. Redacted with the narrow rules, or with `scrub` (the free-text
 * rules for a shell command's summary).
 */
function oneLine(v, max, scrub = redact) {
  if (typeof v !== 'string') return '';
  const flat = v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const r = scrub(flat.length > 4000 ? (/^[\s\S]*\s/.exec(flat.slice(0, 4000))?.[0] ?? '') : flat);
  return r.length > max ? r.slice(0, max) : r;
}

const idOf = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null);

/** An absolute, normalized path without control characters; one that is too long is dropped, never cut. */
function absPath(v, base) {
  if (typeof v !== 'string' || !v) return null;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, '');
  const p = path.isAbsolute(s) ? path.normalize(s) : base ? path.resolve(base, s) : null;
  return p && p.length <= PATH_MAX ? p : null;
}

// Codex's patch header markers (codex-rs/apply-patch/src/parser.rs:39-42), and the change each hunk header makes: Codex's hunk
// kinds AddFile, DeleteFile and UpdateFile (parser.rs `Hunk`, streaming_parser.rs:107-135). A `*** Move to:` line is no hunk of
// its own: it gives the update it follows a destination (streaming_parser.rs:253-260).
const PATCH_MARKERS = ['*** Add File: ', '*** Delete File: ', '*** Update File: ', '*** Move to: '];
const MOVE_TO = '*** Move to: ';
const HUNK_OPS = new Map([
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'delete'],
  ['*** Update File: ', 'update'],
]);
// Rust's `str::trim` and `str::trim_end` (Unicode White_Space): JavaScript's \s without U+FEFF, plus U+0085.
const RUST_TRIM = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
const RUST_TRIM_END = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/;
// An update hunk's end-of-file marker (parser.rs:43): the one line that may come between an update header and its move.
const EOF_MARKER = '*** End of File';
// What a shown path may not contain: control characters (C0, DEL, C1), line and paragraph separators, bidi controls.
const PATH_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
// What a shown patch may not contain: the same, but for the line feed and tab a patch is written with.
const PATCH_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** Characters of a patch shown, the ask's tool-input limit (RESPOND_LIMITS.toolInput). */
const PATCH_SHOWN = 20_000;
/** Characters of a patch read before redaction, so a huge body costs bounded work (Claude reporter activityDetail.ts RAW_LIMIT). */
const PATCH_RAW = 100_000;

/**
 * An apply_patch body as its file approval shows it: every CRLF as LF, as Codex reads it (its parser drops the CR of each CRLF:
 * apply-patch/src/parser.rs:194, streaming_parser.rs:143); its content lines (hunk lines that start with `+`, `-` or a space)
 * and the context after a hunk's `@@` (Codex's one leading marker, parser.rs:44-45) redacted with the narrow rules, the `@@`
 * kept, since that context is a line of the file like any other; and its first PATCH_SHOWN characters. Marker and header lines
 * (`*** Update File: <path>` and the like) are never redacted: they hold Codex's markers and the paths the owner approves.
 * `cut` when that is not the body as Codex reads it: redaction changed a line, it is longer, or it holds a character that
 * would not show as written (a control including a carriage return not followed by a line feed, a line or paragraph
 * separator, a bidi control that reorders what the page draws). The reporter then offers only Deny: the owner allows only
 * what they saw in full.
 */
function shownPatch(body) {
  const raw = (body.length > PATCH_RAW ? body.slice(0, PATCH_RAW) : body).replaceAll('\r\n', '\n');
  const clean = raw
    .split('\n')
    .map((line) => (/^[+\- ]/.test(line) ? redact(line) : line.startsWith('@@') ? `@@${redact(line.slice(2))}` : line))
    .join('\n');
  return { patch: clean.slice(0, PATCH_SHOWN), cut: clean !== raw || raw.length > PATCH_SHOWN || PATCH_UNSAFE.test(raw) };
}

/**
 * The absolute path Codex writes for a patch's file name — the name itself, or `base` (the cwd) joined with it — exactly as
 * written; null when it cannot be shown unchanged (an unsafe character, `.`/`..`/empty segments that normalizing would
 * rewrite, no usable base for a relative name) or is too long.
 */
function exactPath(name, base) {
  if (PATH_UNSAFE.test(name)) return null;
  const joined = path.isAbsolute(name) ? name : base ? `${base === '/' ? '' : base}/${name}` : null;
  return joined && joined.length <= PATH_MAX && path.normalize(joined) === joined ? joined : null;
}

/**
 * The paths an apply_patch body names, found the way Codex's own parser finds its headers (openai/codex@970111f,
 * codex-rs/apply-patch/src): lines split on "\n" only (parser.rs:194-200, streaming_parser.rs:139-146); each line trimmed with
 * Rust's `str::trim` before a marker is tested (streaming_parser.rs:176 — inside an update hunk Codex trims only the end,
 * :228, which finds a subset of these lines, so trimming both ends can only add a path); the marker prefixes of
 * parser.rs:39-42; the path the rest of the trimmed line, untouched (streaming_parser.rs:107-131, :255). At most 50 paths, and
 * `cut` when any was left out: a 51st distinct path, or one exactPath cannot show as Codex writes it. Whoever leaves
 * something out says so (the cut rule). Only paths and changes leave this function (the body is shown through shownPatch).
 *
 * `changes` is what those headers do, in order, as Codex's own approval names a patch's changes (its prompt lists each path and
 * a move's destination, tui/src/bottom_pane/apply_patch_header.rs:34-71; the patch cell beside it says Added, Deleted or Edited
 * per path, with `→ destination` for a move, tui/src/diff_render.rs:442-480): `add`, `delete` or `update` per hunk
 * header, and an update becomes `move` from its path `to` the destination (`to` left out when exactPath cannot show it, which
 * cuts the list) exactly when Codex's parser takes a `*** Move to:` line as its destination (streaming_parser.rs:227-260): the
 * line, trimmed only at its end, starts with the marker, and comes right after the update header with nothing between but
 * `*** End of File` lines (any other line opens a hunk, after which no move is taken). Any other `*** Move to:` line names no
 * change: it is hunk text Codex does not act on, or it makes the patch invalid, and Codex parses a patch before it asks
 * (core/src/tools/handlers/apply_patch.rs:325-333). Exact repeats are listed once; at most 50 changes, and `cut` when more.
 */
function patchPaths(patch, base) {
  const files = [];
  const changes = [];
  let cut = false;
  if (typeof patch !== 'string') return { files, changes, cut };
  /** The update whose header this line follows, with only `*** End of File` lines between: a `*** Move to:` here moves it. */
  let update = null;
  for (const raw of patch.split('\n')) {
    const line = raw.replace(RUST_TRIM, '');
    const end = raw.replace(RUST_TRIM_END, '');
    const marker = PATCH_MARKERS.find((m) => line.startsWith(m));
    const opened = update;
    update = null;
    if (marker === undefined) {
      if (opened && end === EOF_MARKER) update = opened;
      continue;
    }
    const p = exactPath(line.slice(marker.length), base);
    if (!p) cut = true;
    else if (!files.includes(p)) {
      if (files.length >= 50) {
        cut = true;
        break;
      }
      files.push(p);
    }
    if (marker === MOVE_TO) {
      if (opened && end.startsWith(MOVE_TO)) {
        opened.op = 'move';
        if (p) opened.to = p;
      }
    } else {
      const change = p ? { op: HUNK_OPS.get(marker), path: p } : null;
      if (change) changes.push(change);
      update = change && change.op === 'update' ? change : null;
    }
  }
  const seen = new Set();
  const listed = changes.filter((c) => {
    const key = JSON.stringify([c.op, c.path, c.to ?? null]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (listed.length > 50) cut = true;
  return { files, changes: listed.slice(0, 50), cut };
}

/** "Tool arg" as the activity feed words a call: a shell command, a file path, an agent type, or the first argument. */
function summarize(tool, input, files) {
  const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : (JSON.stringify(v) ?? ''));
  let arg;
  let scrub = redactFreeText;
  if (tool === 'apply_patch') [arg, scrub] = [files[0] ?? '', redact];
  else if (tool === 'spawn_agent') [arg, scrub] = [str(i.agent_type), redact];
  else if (tool === 'view_image' && i.path != null) [arg, scrub] = [str(i.path), redact];
  else {
    const key = ['command', 'cmd', 'file_path', 'path'].find((k) => i[k] != null);
    arg = str(key === undefined ? Object.values(i)[0] : i[key]);
  }
  // Only the tool's name and a built-in tool's own path or name (the cases above, as the mod's PATH_TOOLS list) keep the narrow
  // rules; every other argument of every other tool, whatever its name (an MCP tool among them), is free text and gets the
  // broader rules too. Redacted apart, so no rule spans the two.
  const name = oneLine(tool, 299);
  const rest = oneLine(arg, 299 - name.length, scrub);
  return rest ? `${name} ${rest}` : name;
}

function main() {
  let p;
  try {
    p = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return;
  const ev = oneLine(p.hook_event_name, 40);
  const sid = idOf(p.session_id);
  if (!ev || !sid) return;
  const rec = { t: Date.now(), ev, sid };
  const aid = idOf(p.agent_id);
  if (aid) rec.aid = aid;
  const atype = oneLine(p.agent_type, 120);
  if (atype) rec.atype = atype;
  const cwd = absPath(p.cwd, null);
  if (cwd) rec.cwd = cwd;
  const tp = absPath(p.transcript_path, null);
  if (tp && tp.endsWith('.jsonl')) rec.tp = tp;
  const m = oneLine(p.model, 120);
  if (m) rec.m = m;
  const tool = oneLine(p.tool_name, 120);
  if (tool) rec.tool = tool;
  if (typeof p.tool_use_id === 'string' && /^[\x21-\x7e]{1,200}$/.test(p.tool_use_id)) rec.tuid = p.tool_use_id;
  if (tool && (ev === 'PreToolUse' || ev === 'PermissionRequest')) {
    // A relative patch path is joined to the cwd only when the cwd itself needs no change to be shown.
    const base = typeof p.cwd === 'string' && path.isAbsolute(p.cwd) ? exactPath(p.cwd, null) : null;
    const { files, changes, cut } = tool === 'apply_patch' ? patchPaths(p.tool_input?.command, base) : { files: [], changes: [], cut: false };
    if (files.length) rec.files = files;
    if (changes.length) rec.changes = changes;
    if (cut) rec.filesCut = true;
    // The patch body for the file approval of this call (its tool_use_id is the approval's itemId): on this line only.
    if (ev === 'PreToolUse' && tool === 'apply_patch' && rec.tuid && typeof p.tool_input?.command === 'string') {
      const shown = shownPatch(p.tool_input.command);
      rec.patch = shown.patch;
      if (shown.cut) rec.patchCut = true;
    }
    const sum = summarize(tool, p.tool_input, files);
    if (sum) rec.sum = sum;
  }
  if ((ev === 'PreCompact' || ev === 'PostCompact') && (p.trigger === 'auto' || p.trigger === 'manual')) rec.trigger = p.trigger;

  const dir = path.join(os.homedir(), '.sitrep');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'codex-hooks.ndjson');
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // no spool yet
  }
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
}

try {
  main();
} catch {
  // never fail the session
}
process.exit(0);
