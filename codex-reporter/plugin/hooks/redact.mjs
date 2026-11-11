// Secret redaction for everything the Codex side sends: imported by the hook (codex-hook.mjs, beside it) and by the reporter
// (src/report.ts). Plain JavaScript that imports nothing, because the hook runs this file from Codex's copy of the plugin
// directory (Codex copies the whole directory: core-plugins/src/store.rs copy_dir_recursive).
//
// Two sets:
// - `redact`: the narrow rules (a few token shapes, then the value after a secret-looking key), for names, ids, paths, ask
//   input and the patch: text the owner reads to identify a thing or to judge an approval, which must stay as written
//   wherever it holds no secret.
// - `redactFreeText`: the broader rules, the same as the Claude reporter applies to command text
//   (mod/claude-reporter/hooks/failures.ts), its `curl -u user:pass` rule among them, then the narrow rules, so it never redacts
//   less. Only for display text taken from a command or a tool's free-text argument (a message to another agent): their
//   entropy rule would also hide ids, names and paths.
// Best effort: a secret can take any shape.

const MARK = '[redacted]';

/** Token shapes, each replaced whole. */
const SHAPES = [
  /(?<![A-Za-z\d])sk-ant-[\w-]{10,}/g,
  /(?<![A-Za-z\d])sk-(?:proj-|svcacct-|admin-)?[\w-]{20,}/g,
  /\bgh[pousr]_[A-Za-z\d]{20,}/g,
  /\bgithub_pat_\w{20,}/g,
  /\bglpat-[\w-]{16,}/g,
  /\bA[KS]IA[\dA-Z]{16}\b/g,
  /\bAIza[\w-]{30,}/g,
  /\bxox[abprs]-[A-Za-z\d-]{10,}/g,
  /\b[srp]k_live_[A-Za-z\d]{16,}/g,
  /\bwhsec_[A-Za-z\d]{16,}/g,
  /\bnpm_[A-Za-z\d]{30,}/g,
  /\bSG(?:\.[\w-]{16,}){2}/g,
  /\bSK[\da-f]{32}\b/g,
  /\beyJ[\w-]{6,}\.eyJ[\w-]{6,}\.[\w-]{3,}/g,
];
/** Shapes that keep their label: `Bearer …`, `Basic …`, `AccountKey=…`, `SharedAccessKey=…`. */
const LABELLED = [
  /(\bBearer\s+)[\w.~+/=-]{16,}/g,
  /(\bBasic\s+)(?=[A-Za-z+/]*[\d+/=])[A-Za-z\d+/]{8,}={0,2}/g,
  /(AccountKey=)[A-Za-z\d+/=]{20,}/g,
  /(SharedAccessKey=)[^;\s"']+/g,
];
const URL_CREDENTIALS = /\b([a-z][a-z\d+.-]*:\/\/[^\s/:@"'`]+:)([^\s/@"'`]+)(@)/gi;
const HEADER = /\b((?:proxy-)?authorization|set-cookie|cookie|x-api-key|x-auth-token|x-access-token)(["']?\s*[:=]\s*["']?)([^"'\n]+)/gi;
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_INLINE = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_INLINE_ONE = new RegExp(PEM_INLINE.source);
const KEYWORD = 'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|salt|auth(?:[_-]?token)?';
// prefix, keyword, suffix, an optional `?`/`!`, an optional closing quote or bracket, the operator, then the value (quoted or bare).
const KEYED = new RegExp(`([\\w.-]*?)(${KEYWORD})([\\w.-]*)([?!]?["'\\]]?\\s*(?::=|=|:)\\s*)("[^"]*"|'[^']*'|\`[^\`]*\`|[^\\s"'\`,;&)}\\]]+)`, 'gi');
const FLAG = /(--(?:password|passwd|pass|token|secret|api-?key|auth(?:-token)?|access-key|client-secret)(?:=|\s+))([^\s$<-]\S*)/gi;
const MYSQL = /\b(mysql|mysqldump|mariadb)\b([^\n]*?\s-p)(\S+)/g;
const SSHPASS = /(\bsshpass\b[^\n]*?\s-p\s*)(\S+)/g;
/**
 * `curl … -u user:pass`: the credential (the rule's first capture group) replaced, the command before it and the space after it
 * captured so they stay, and the end of the input written `$`. A credential of entropy 2 or less, or one the rule's allowlist
 * matches, stays: it is a placeholder or a reference, not a secret (THIRD_PARTY_NOTICES.md).
 */
const CURL_USER = /(\bcurl\b(?:.*|.*(?:[\r\n]{1,2}.*){1,5})[ \t\n\r](?:-u|--user)(?:=|[ \t]{0,5}))("(:[^"]{3,}|[^:"]{3,}:|[^:"]{3,}:[^"]{3,})"|'([^:']{3,}:[^']{3,})'|((?:"[^"]{3,}"|'[^']{3,}'|[\w$@.-]+):(?:"[^"]{3,}"|'[^']{3,}'|[\w${}@.-]+)))(\s|$)/g;
/** The rule's allowlist (placeholders and variable references), `]` and `{{` escaped for JavaScript. */
const CURL_USER_ALLOWED = [
  /[^:]+:(?:change(?:it|me)|pass(?:word)?|pwd|test|token|\*+|x+)/,
  /['"]?<[^>]+>['"]?:['"]?<[^>]+>|<[^:]+:[^>]+>['"]?/,
  /[^:]+:\[[^\]]+]/,
  /['"]?[^:]+['"]?:['"]?\$(?:\d|\w+|\{(?:\d|\w+)})['"]?/,
  /\$\([^)]+\):\$\([^)]+\)/,
  /['"]?\$?\{\{[^}]+\}\}['"]?:['"]?\$?\{\{[^}]+\}\}['"]?/,
];
// The narrow rules, first the token shapes each masked whole: an Anthropic key, an OpenAI key (`sk-…`, `sk-proj-…`; never one
// inside a word such as `task-…`), a GitHub personal token, an AWS access key id and a bearer token.
const SECRET_PATTERNS = [/(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{10,}/g, /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, /ghp_[A-Za-z0-9]{20,}/g, /AKIA[0-9A-Z]{16}/g, /Bearer [A-Za-z0-9._-]{20,}/g];
// Then the value written after one of these keys, up to a space, quote, `&`, `,` or `;` (`password=hunter2`, `token: abc`,
// `"api_key": "abc"`); the key, any quote closing it, the `=` or `:` and any quote opening the value stay.
const NARROW_KEYS = 'password|passwd|token|secret|apikey|api_key';
const KEY_VALUE = new RegExp(`((?:${NARROW_KEYS})["']?\\s*[=:]\\s*["']?)([^\\s"'&,;]+)`, 'gi');
const TYPE_WORDS = /^(?:true|false|null|undefined|nil|none|string|number|boolean|any|unknown|void|object|never|bigint|symbol)$/i;
const PLACEHOLDER = /^(?:<.*>|\{.*\}|\$.*|%.*%|x{3,}|\*+|\.{3}|your[-_ ].*|process\.env.*|env\..*)$/i;
const LONG_VALUE = /[A-Za-z0-9+/_=~-]{24,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Text inside a value that shows it was masked already or is filled in later (`${…}`, `{{…}}`). */
const STAND_INS = [MARK, '${', '{{'];
/** An unquoted value shaped like code rather than a secret: a call, member or index, or a camelCase, CONSTANT_NAME or PascalCase name. */
const CODE_NAMES = [/[().<[{]/, /^[a-z]+[A-Z][A-Za-z]*$/, /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/, /^[A-Z][a-z]+(?:[A-Z][a-z]+)*$/];

/**
 * Whether the value after a secret-looking key names a secret instead of holding one: masked or filled in later, a placeholder or
 * a type word, or, when it is not quoted, a name from code. Such a value stays.
 * @param {string} value
 * @param {boolean} quoted
 */
function isReference(value, quoted) {
  const standsIn = STAND_INS.some((s) => value.includes(s)) || PLACEHOLDER.test(value) || TYPE_WORDS.test(value);
  return standsIn || (!quoted && CODE_NAMES.some((re) => re.test(value)));
}

/**
 * Shannon entropy of `s` in bits per character, its characters summed in the order they first appear.
 * @param {string} s
 */
function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return [...counts.values()].reduce((bits, n) => bits - (n / s.length) * Math.log2(n / s.length), 0);
}

/** @param {string} t */
function looksRandom(t) {
  if (/^sha\d+-/.test(t) || UUID.test(t) || /^[./~]/.test(t)) return false;
  if (/^[0-9a-f]+$/i.test(t)) return t.length >= 32 && t.length !== 40 && t.length !== 64 && entropy(t) >= 3;
  const classes = Number(/[a-z]/.test(t)) + Number(/[A-Z]/.test(t)) + Number(/[0-9]/.test(t));
  if (classes < 2) return false;
  return /[0-9]/.test(t) ? entropy(t) >= 4 : t.length >= 40 && entropy(t) >= 4.3;
}

/**
 * One line's secrets replaced.
 * @param {string} line
 */
function redactLine(line) {
  let s = line.replaceAll(PEM_INLINE, MARK);
  s = s.replaceAll(URL_CREDENTIALS, (whole, head, pass, at) => (pass === MARK ? whole : `${head}${MARK}${at}`));
  s = s.replaceAll(HEADER, (whole, name, sep, value) => (/\$|\{\{|\[redacted\]/.test(value) ? whole : `${name}${sep}${MARK}`));
  for (const re of SHAPES) s = s.replaceAll(re, MARK);
  for (const re of LABELLED) s = s.replaceAll(re, (_m, label) => `${label}${MARK}`);
  s = s.replaceAll(FLAG, (_m, head) => `${head}${MARK}`);
  s = s.replaceAll(MYSQL, (_m, cmd, mid) => `${cmd}${mid}${MARK}`);
  s = s.replaceAll(SSHPASS, (_m, head) => `${head}${MARK}`);
  s = s.replaceAll(CURL_USER, (whole, head, credential, ...rest) =>
    entropy(credential) <= 2 || CURL_USER_ALLOWED.some((re) => re.test(credential)) ? whole : `${head}${MARK}${String(rest[3])}`,
  );
  s = s.replaceAll(KEYED, (whole, _prefix, _kw, suffix, _op, value) => {
    // `author`, `tokens`, `passwords`: the keyword only begins a longer ordinary word.
    if (suffix && /^[a-z0-9]/.test(suffix)) return whole;
    const quoted = /^["'`]/.test(value);
    const inner = quoted ? value.slice(1, -1) : value;
    if (inner.length < 4 || isReference(inner, quoted)) return whole;
    const q = quoted ? value.charAt(0) : '';
    return `${whole.slice(0, whole.length - value.length)}${q}${MARK}${q}`;
  });
  return /integrity/i.test(s) ? s : s.replaceAll(LONG_VALUE, (t) => (looksRandom(t) ? MARK : t));
}

/**
 * Every line redacted; a private key block that spans lines goes whole, from its BEGIN line to its END line.
 * @param {string} text
 */
function redactText(text) {
  let inKey = false;
  return text
    .split('\n')
    .map((line) => {
      if (inKey) {
        if (PEM_END.test(line)) inKey = false;
        return MARK;
      }
      if (PEM_BEGIN.test(line) && !PEM_INLINE_ONE.test(line)) {
        inKey = true;
        return line.slice(0, line.search(PEM_BEGIN)) + MARK;
      }
      return redactLine(line);
    })
    .join('\n');
}

/** Longest stretch redacted at once: the rules cost grows with the square of a line, so a long line is done in pieces. */
const REDACT_PIECE = 1000;

/**
 * One line in pieces of at most REDACT_PIECE characters, each ending just after a space when one falls in its range.
 * @param {string} line
 */
function piecesOf(line) {
  const pieces = [];
  let start = 0;
  do {
    let stop = Math.min(start + REDACT_PIECE, line.length);
    if (stop < line.length) {
      const space = line.lastIndexOf(' ', stop);
      if (space > start) stop = space + 1;
    }
    pieces.push(line.slice(start, stop));
    start = stop;
  } while (start < line.length);
  return pieces;
}

/**
 * `redactText` for a text of any size: a line over REDACT_PIECE is cut into pieces (at a space where it has one), each piece
 * redacted, and the line put back together. A secret straddling a cut is not seen.
 * @param {string} text
 * @returns {string}
 */
function redactBounded(text) {
  if (text.length <= REDACT_PIECE) return redactText(text);
  const lines = text.split('\n').map(piecesOf);
  const flat = lines.flat();
  const redacted = redactText(flat.join('\n'));
  const back = redacted.split('\n');
  // A rule that added or removed a line break would move text between lines: then what came back is kept as it is.
  if (back.length !== flat.length) return redacted;
  let cursor = 0;
  const rebuilt = lines.map((pieces) => {
    const joined = back.slice(cursor, cursor + pieces.length).join('');
    cursor += pieces.length;
    return joined;
  });
  return rebuilt.join('\n');
}

/**
 * The narrow rules: every secret-shaped run masked, and the value after a secret-looking key masked.
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  const masked = SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, MARK), text);
  return masked.replace(KEY_VALUE, (_whole, key) => key + MARK);
}

/**
 * Display text taken from a command: the broader rules first (`redactBounded`), then the narrow ones, so it never
 * redacts less than `redact`.
 * @param {string} text
 * @returns {string}
 */
export function redactFreeText(text) {
  return redact(redactBounded(text));
}
