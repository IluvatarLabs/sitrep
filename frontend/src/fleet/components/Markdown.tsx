// A small markdown renderer for task prompts, final answers and plans. It builds React elements, never an HTML string, so
// raw HTML in the text shows as text. Blocks: headings, flat ordered and bulleted lists, block quotes, fenced code and
// paragraphs. Inline: code, bold, italic and links (http, https and mailto only), scanned left to right in linear time.
import type { ReactNode } from "react";

/** The only links drawn as links; any other target shows its words alone. */
const LINK_SCHEME = /^(?:https?:\/\/|mailto:)/i;
/** A fence closes on backticks alone on a line, at least as many as opened it. */
const FENCE_CLOSE = /^\s*(`{3,})\s*$/;
const isWordChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c);

/** The end of a link's URL starting at `from`: non-space, non-paren characters and one level of balanced (…); -1 when not closed by ")". */
function urlEnd(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ")") return i > from ? i : -1;
    if (/\s/.test(c)) return -1;
    if (c === "(") {
      const close = src.indexOf(")", i + 1);
      if (close < 0 || /[\s(]/.test(src.slice(i + 1, close))) return -1;
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * Inline marks in one block's text. Blocks join their lines with spaces, so the text holds no line breaks. Each search for a
 * closing mark ends at that mark's next occurrence, and the next `]` is found once and reused by every `[` before it.
 */
function inlineMarks(src: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let text = "";
  let n = 0;
  // The next `]` after the current position, and the last `]` that cannot end a link (no "(" after it, or a bad URL).
  let nextClose = -1;
  let deadClose = -1;
  const flush = () => {
    if (text) out.push(text);
    text = "";
  };
  const push = (node: ReactNode) => {
    flush();
    out.push(node);
    n += 1;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const key = `${keyBase}-${n}`;
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        push(<code key={key}>{src.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    } else if ((c === "*" || c === "_") && src[i + 1] === c) {
      const end = src.indexOf(c + c, i + 2);
      if (end > i + 2) {
        push(<strong key={key}>{inlineMarks(src.slice(i + 2, end), key)}</strong>);
        i = end + 2;
        continue;
      }
    } else if ((c === "*" || c === "_") && src[i + 1] !== undefined && !/\s/.test(src[i + 1]!) && !(c === "_" && isWordChar(src[i - 1]))) {
      const end = src.indexOf(c, i + 1);
      if (end > i + 1 && !(c === "_" && isWordChar(src[end + 1]))) {
        push(<em key={key}>{inlineMarks(src.slice(i + 1, end), key)}</em>);
        i = end + 1;
        continue;
      }
    } else if (c === "[") {
      if (nextClose <= i) nextClose = src.indexOf("]", i + 1);
      const close = nextClose;
      if (close > i + 1 && close !== deadClose) {
        const end = src[close + 1] === "(" ? urlEnd(src, close + 2) : -1;
        if (end > 0) {
          const label = src.slice(i + 1, close);
          const url = src.slice(close + 2, end);
          push(
            LINK_SCHEME.test(url) ? (
              <a key={key} href={url} target="_blank" rel="noopener noreferrer">
                {inlineMarks(label, key)}
              </a>
            ) : (
              <span key={key}>{label}</span>
            ),
          );
          i = end + 1;
          continue;
        }
        deadClose = close;
      }
    }
    text += c;
    i += 1;
  }
  flush();
  return out;
}

/** The text after a heading or list marker: at least one space, then something. */
function textAfter(line: string, at: number): string | undefined {
  const tail = line.slice(at);
  const rest = tail.trimStart();
  return rest.length === tail.length || rest.length === 0 ? undefined : rest;
}

function heading(line: string): { level: number; text: string } | undefined {
  let level = 0;
  while (line[level] === "#" && level < 7) level += 1;
  if (level === 0 || level > 6) return undefined;
  const text = textAfter(line, level);
  if (text === undefined) return undefined;
  return { level, text: text.trim() };
}

function orderedItem(line: string): string | undefined {
  const s = line.trimStart();
  let i = 0;
  while (i < s.length && s[i]! >= "0" && s[i]! <= "9") i += 1;
  const mark = s[i];
  if (i === 0 || (mark !== "." && mark !== ")")) return undefined;
  return textAfter(s, i + 1);
}

const BULLET_MARKS = "-*+";

function bulletItem(line: string): string | undefined {
  const trimmed = line.trimStart();
  return trimmed !== "" && BULLET_MARKS.includes(trimmed[0]!) ? textAfter(trimmed, 1) : undefined;
}

/** What one line outside a fence is, tried in this order. */
type Line =
  | { kind: "heading"; level: number; text: string }
  | { kind: "item"; ordered: boolean; text: string }
  | { kind: "quote"; text: string }
  | { kind: "text"; text: string }
  | { kind: "blank" };

function classify(line: string): Line {
  const h = heading(line);
  if (h) return { kind: "heading", ...h };
  const ordered = orderedItem(line);
  if (ordered !== undefined) return { kind: "item", ordered: true, text: ordered };
  const bullet = bulletItem(line);
  if (bullet !== undefined) return { kind: "item", ordered: false, text: bullet };
  const quoted = /^\s*>\s?(.*)$/.exec(line);
  if (quoted) return { kind: "quote", text: quoted[1]! };
  const text = line.trim();
  return text ? { kind: "text", text } : { kind: "blank" };
}

export function Markdown(props: { source: string }) {
  // The blocks built so far, then whichever block is still open and taking lines: a fence, a quote, a list or a paragraph.
  const blocks: ReactNode[] = [];
  let fence: { width: number; lines: string[] } | null = null;
  let quote: string[] = [];
  let openList: { ordered: boolean; entries: string[] } | null = null;
  let para: string[] = [];
  const next = () => blocks.length;

  const endPara = () => {
    if (para.length) blocks.push(<p key={next()}>{inlineMarks(para.join(" "), `p${next()}`)}</p>);
    para = [];
  };
  const endList = () => {
    if (openList) {
      const k = next();
      const entries = openList.entries.map((t, i) => <li key={i}>{inlineMarks(t, `l${k}-${i}`)}</li>);
      blocks.push(openList.ordered ? <ol key={k}>{entries}</ol> : <ul key={k}>{entries}</ul>);
    }
    openList = null;
  };
  const endQuote = () => {
    if (quote.length) blocks.push(<blockquote key={next()}>{inlineMarks(quote.join(" "), `q${next()}`)}</blockquote>);
    quote = [];
  };
  const endText = () => {
    endPara();
    endList();
    endQuote();
  };
  const addItem = (ordered: boolean, item: string) => {
    endPara();
    endQuote();
    if (!openList || openList.ordered !== ordered) {
      endList();
      openList = { ordered, entries: [] };
    }
    openList.entries.push(item);
  };

  const lines = props.source.replace(/\r\n?/g, "\n").split("\n");
  for (const line of lines) {
    if (fence) {
      const closing = FENCE_CLOSE.exec(line);
      if (closing && closing[1]!.length >= fence.width) {
        blocks.push(
          <pre key={next()}>
            <code>{fence.lines.join("\n")}</code>
          </pre>,
        );
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    const open = /^\s*(`{3,})/.exec(line);
    if (open) {
      endText();
      fence = { width: open[1]!.length, lines: [] };
      continue;
    }
    // Each kind of line closes the open blocks it cannot continue, then joins or starts its own.
    const c = classify(line);
    switch (c.kind) {
      case "heading": {
        endText();
        const Tag = `h${c.level}` as "h1";
        blocks.push(<Tag key={next()}>{inlineMarks(c.text, `h${next()}`)}</Tag>);
        break;
      }
      case "item":
        addItem(c.ordered, c.text);
        break;
      case "quote":
        endPara();
        endList();
        quote.push(c.text);
        break;
      case "text":
        endList();
        endQuote();
        para.push(c.text);
        break;
      case "blank":
        endText();
        break;
    }
  }
  // A fence left open runs to the end of the text.
  if (fence) {
    const unclosed: string[] = (fence as { lines: string[] }).lines;
    blocks.push(
      <pre key={next()}>
        <code>{unclosed.join("\n")}</code>
      </pre>,
    );
  }
  endText();
  return <>{blocks}</>;
}
