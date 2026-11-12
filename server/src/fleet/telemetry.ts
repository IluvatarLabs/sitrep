// Claude Code's own telemetry (code.claude.com/docs/en/monitoring-usage): one OTLP log event, `api_request`, per model API request,
// naming its request id, session, agent, model, speed and token counts. Claude usage comes from these. This reads one OTLP/HTTP
// JSON logs export (opentelemetry.io/docs/specs/otlp, "JSON Protobuf Encoding": lowerCamelCase keys, 64-bit integers as decimal
// strings or numbers) and keeps only those events, and of each only the attributes usage needs. Every other event and attribute
// (the account, email and prompt fields among them) is dropped here and never stored or logged.
import { LIMITS, type ModelUsage, type UsageTokens } from './protocol.js';

/** One model API request of a Claude Code session, as usage needs it. */
export interface ApiRequest {
  /** The API's request id: a request is counted once by it, however often its record is sent. */
  requestId: string;
  /** Claude Code's session id, the plugin's too; and the agent that made it, null for the main loop and Claude Code's side requests. */
  sessionId: string;
  agentId: string | null;
  /** When it was recorded, epoch ms. */
  t: number;
  usage: ModelUsage;
}

/** A request whose prompt (input, cache reads and cache writes) is over this is priced at the long tier, pricing.ts's Claude line. */
const LONG_PROMPT = 100_000;

/** The only attributes read. */
const WANTED = new Set(['event.name', 'request_id', 'session.id', 'agent_id', 'model', 'speed', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cache_creation_5m_tokens', 'cache_creation_1h_tokens']);

/** An OTLP AnyValue, of the kinds read here. */
interface AnyValue {
  stringValue?: unknown;
  intValue?: unknown;
  doubleValue?: unknown;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const field = (o: unknown, key: string): unknown => (typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[key] : undefined);

/** A string value of 1 to `max` characters; null for anything else. */
function str(v: AnyValue | undefined, max: number): string | null {
  const s = v?.stringValue;
  return typeof s === 'string' && s !== '' && s.length <= max ? s : null;
}

/** A token count: a whole number, 0 or more, sent as an int (a decimal string or a number), a double, or a string of digits. */
function count(v: AnyValue | undefined): number | null {
  const raw = v?.intValue ?? v?.doubleValue ?? v?.stringValue;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * An OTLP time in nanoseconds (a decimal string or a number) as epoch ms, rounded: a double near 1.8e18 is within 256 ns, so a
 * whole millisecond can read just below itself. Null when absent or 0, which OTLP reads as unknown.
 */
function ms(nanos: unknown): number | null {
  const n = typeof nanos === 'string' || typeof nanos === 'number' ? Number(nanos) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1e6) : null;
}

/**
 * One `api_request` record as a request; null when it lacks what counting it needs: its request id, session id, model and four token
 * counts. Cache writes are split by lifetime as Claude Code reports them; writes it gives no lifetime for (both splits 0, as when
 * the API reports none) are 5-minute writes, the API's default lifetime. A request Claude Code marks `speed: "fast"` is of the
 * fast tier at any prompt length, as fast mode is billed; one it marks "normal", or does not mark, is long or standard.
 */
function requestOf(attrs: ReadonlyMap<string, AnyValue>, t: number): ApiRequest | null {
  const requestId = str(attrs.get('request_id'), LIMITS.id);
  const sessionId = str(attrs.get('session.id'), LIMITS.id);
  const model = str(attrs.get('model'), LIMITS.short);
  const [input, output, cacheRead, written] = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'].map((k) => count(attrs.get(k)));
  if (!requestId || !sessionId || !model || input === null || output === null || cacheRead === null || written === null) return null;
  const oneHour = count(attrs.get('cache_creation_1h_tokens')) ?? 0;
  const tokens: UsageTokens = { input, output, cacheRead, cacheWrite: Math.max(count(attrs.get('cache_creation_5m_tokens')) ?? 0, written - oneHour), cacheWrite1h: oneHour };
  const tier = str(attrs.get('speed'), LIMITS.short) === 'fast' ? 'fast' : input + cacheRead + written > LONG_PROMPT ? 'long' : 'std';
  return { requestId, sessionId, agentId: str(attrs.get('agent_id'), LIMITS.id), t, usage: { model, tier, tokens } };
}

/**
 * The `api_request` events of one OTLP/HTTP JSON logs export (an ExportLogsServiceRequest), and how many such events were rejected
 * for lacking a field counting needs. A record's time is its own (`timeUnixNano`, else `observedTimeUnixNano`), never after `now`.
 */
export function apiRequestsOf(body: unknown, now: number): { requests: ApiRequest[]; rejected: number } {
  const requests: ApiRequest[] = [];
  let rejected = 0;
  const records = list(field(body, 'resourceLogs')).flatMap((rl) => list(field(rl, 'scopeLogs')).flatMap((sl) => list(field(sl, 'logRecords'))));
  for (const record of records) {
    const attrs = new Map<string, AnyValue>();
    for (const a of list(field(record, 'attributes'))) {
      const key = field(a, 'key');
      if (typeof key === 'string' && WANTED.has(key)) attrs.set(key, (field(a, 'value') ?? {}) as AnyValue);
    }
    if (str(attrs.get('event.name'), LIMITS.short) !== 'api_request') continue;
    const request = requestOf(attrs, Math.min(ms(field(record, 'timeUnixNano')) ?? ms(field(record, 'observedTimeUnixNano')) ?? now, now));
    if (request) requests.push(request);
    else rejected++;
  }
  return { requests, rejected };
}
