// Tokens to dollars, in one place. The table is LiteLLM's published price file,
// `model_prices_and_context_window.json`: a copy ships with the server, the server refreshes it from LiteLLM
// once at start, and prices.json lays the owner's overrides on top. A model is priced under its own id only, or a bare Claude
// alias under its family's current model; a model with no row has no price: its cost is unknown, never $0, and never an older
// model's. Every figure is an estimate, never a bill.
import { readFileSync } from 'node:fs';
import type { ModelPriceSet, ModelUsage, PriceRowView, SettingsBody, UsageTokens } from './protocol.js';

/** The most one price may be, USD per million tokens: it catches a typo, not a real price. */
export const MAX_PRICE = 1000;

/** LiteLLM's published price file. */
export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
/** When the copy shipped as server/model_prices_and_context_window.json was fetched; update it with that file. */
export const SNAPSHOT_AS_OF = '2026-11-06T20:22:42.000Z';
/** The longest the refresh at start may take before the shipped copy is used. */
const REFRESH_TIMEOUT_MS = 5000;

export interface ModelPrice {
  label: string;
  std: ModelPriceSet;
  /** Higher prices for a long request (the reporters' `long` tier: Claude over 100,000 prompt tokens, Codex over 272,000 input tokens); only some models have them. */
  long?: ModelPriceSet;
}

/** Where a start's price table came from (Settings). */
export type PriceSource = Omit<SettingsBody['prices'], 'rows'>;

/** The model each bare Claude Code alias stands for now (`opus[1m]` too): its family's current model. */
const ALIASES: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5-5',
  opusplan: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
  mythos: 'claude-mythos-5-1',
};

/** A Claude model: a bare alias, or an id with `claude` in it (as `family()` reads it). */
const isClaude = (id: string): boolean => id.includes('claude') || /^(opus|sonnet|haiku|fable|mythos|opusplan)(\[[^\]]*\])?$/.test(id);

/** The reporters' long tier, by LiteLLM's name for the same line: Claude's prompt over 100K tokens, Codex's input over 272K. */
const longSuffix = (id: string): string => (isClaude(id) ? '_above_100k_tokens' : '_above_272k_tokens');

/** A model id as the table is keyed: lower case, without Claude Code's context suffix (`claude-opus-5-5[1m]`). */
const keyOf = (model: string): string => model.toLowerCase().replace(/\[[^\]]*\]$/, '');

const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'] as const;

/**
 * The first fault in a set of prices, worded for the owner (a bad row in prices.json stops the server with it); null when all
 * five prices are numbers from 0 to MAX_PRICE.
 */
function priceFault(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return 'a price set is required';
  const set = v as Record<string, unknown>;
  const fault = (field: string, price: unknown): string | null => {
    if (typeof price !== 'number' || !Number.isFinite(price)) return `${field} must be a number`;
    if (price < 0) return `${field} must be zero or more`;
    return price > MAX_PRICE ? `${field} must be at most ${String(MAX_PRICE)} USD per million tokens` : null;
  };
  return PRICE_FIELDS.map((field) => fault(field, set[field])).find((f) => f !== null) ?? null;
}

/** USD for one model's tokens at one set of prices, each per million tokens. */
const usdAt = (t: UsageTokens, p: ModelPriceSet): number => PRICE_FIELDS.reduce((sum, field) => sum + t[field] * p[field], 0) / 1e6;

/** A rate in USD per million, rounded clear of float noise (1e-7 × 1e6 is 0.09999999999999999). */
const tidy = (n: number): number => Number(n.toPrecision(12));

/**
 * One LiteLLM entry as a price row, or null when it has no input and output price per token. A cache rate it leaves out is, for
 * Claude, its usual multiple of the input price (reads 0.1×, 5-minute writes 1.25×, 1-hour writes 2×), and the input price for
 * any other model, as OpenAI bills cache use it lists no price for. The 1-hour write is LiteLLM's `_above_1hr` rate (Anthropic)
 * or `_above_12hr` (OpenAI's 12-hour write).
 */
function litellmRow(id: string, e: Record<string, unknown>): ModelPrice | null {
  const rate = (field: string): number | null => {
    const v = e[field];
    return typeof v === 'number' && Number.isFinite(v) ? tidy(v * 1e6) : null;
  };
  const claude = isClaude(id);
  const set = (suffix: string): ModelPriceSet | null => {
    const input = rate(`input_cost_per_token${suffix}`);
    const output = rate(`output_cost_per_token${suffix}`);
    if (input === null || output === null) return null;
    const unlisted = (claudeTimesInput: number): number => (claude ? tidy(input * claudeTimesInput) : input);
    const write = 'cache_creation_input_token_cost';
    const prices = {
      input,
      output,
      cacheRead: rate(`cache_read_input_token_cost${suffix}`) ?? unlisted(0.1),
      cacheWrite: rate(`${write}${suffix}`) ?? unlisted(1.25),
      cacheWrite1h: rate(`${write}_above_1hr${suffix}`) ?? rate(`${write}_above_12hr${suffix}`) ?? unlisted(2),
    };
    return priceFault(prices) === null ? prices : null;
  };
  const std = set('');
  if (std === null) return null;
  const long = set(longSuffix(id));
  return { label: id, std, ...(long ? { long } : {}) };
}

/**
 * LiteLLM's file as price rows by lower-case id. An entry without a sane input and output price is left out; nothing throws but a
 * file that is not an object. The rows sit in an object with no prototype, since the ids come from a file off the internet.
 */
export function litellmPrices(json: unknown): Record<string, ModelPrice> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('expected an object of models');
  const out = Object.create(null) as Record<string, ModelPrice>;
  for (const [key, entry] of Object.entries(json as Record<string, unknown>)) {
    // `sample_spec` is the file's own description of an entry.
    if (key === 'sample_spec' || typeof entry !== 'object' || entry === null) continue;
    const row = litellmRow(key.toLowerCase(), entry as Record<string, unknown>);
    if (row) out[key.toLowerCase()] = row;
  }
  return out;
}

/** Reads the `models` table of an overrides file (prices.json). A row at fault throws, naming it and the field, so a typo stops the server at start. */
export function parsePrices(json: unknown, where = 'prices'): Record<string, ModelPrice> {
  const models = (json as { models?: unknown } | null)?.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) throw new Error(`${where}: expected an object "models"`);
  const out: Record<string, ModelPrice> = {};
  for (const [key, row] of Object.entries(models as Record<string, unknown>)) {
    const r = (row ?? {}) as { label?: unknown; std?: unknown; long?: unknown };
    for (const tier of ['std', 'long'] as const) {
      const problem = tier === 'long' && r.long === undefined ? null : priceFault(r[tier]);
      if (problem) throw new Error(`${where}: models.${key}.${tier}: ${problem}`);
    }
    const label = typeof r.label === 'string' ? r.label : key;
    out[key.toLowerCase()] = { label, std: r.std as ModelPriceSet, ...(r.long === undefined ? {} : { long: r.long as ModelPriceSet }) };
  }
  return out;
}

export const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

/** The price files: the shipped copy of LiteLLM's table, and the owner's overrides. */
export interface PriceFiles {
  snapshot: string;
  overrides: string;
}

/** LiteLLM's file, fetched within REFRESH_TIMEOUT_MS. */
async function fetchLiteLlm(): Promise<unknown> {
  const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`LiteLLM answered HTTP ${String(res.status)}`);
  return res.json();
}

/**
 * The table a start prices with: the shipped copy, LiteLLM's current file laid over it, then the overrides. A refresh that fails
 * or times out leaves the shipped copy, with the reason in `error`; it never stops the server. A missing or broken shipped copy or
 * overrides file throws: the server ships both.
 */
export async function loadPricing(files: PriceFiles): Promise<Pricing> {
  const shipped = litellmPrices(readJson(files.snapshot));
  const overrides = parsePrices(readJson(files.overrides), files.overrides);
  try {
    const live = litellmPrices(await fetchLiteLlm());
    if (Object.keys(live).length === 0) throw new Error('LiteLLM sent no usable price rows');
    return new Pricing({ ...shipped, ...live, ...overrides }, { source: 'live', asOf: new Date().toISOString(), error: null });
  } catch (err) {
    return new Pricing({ ...shipped, ...overrides }, { source: 'snapshot', asOf: SNAPSHOT_AS_OF, error: (err as Error).message || 'refresh failed' });
  }
}

export class Pricing {
  constructor(
    private readonly table: Record<string, ModelPrice>,
    readonly source: PriceSource = { source: 'snapshot', asOf: SNAPSHOT_AS_OF, error: null },
  ) {}

  /** The row a model is priced under: its own id's, else a bare alias's current model's; null for an unpriced model. */
  rowFor(model: string | null | undefined): ModelPrice | null {
    const id = keyOf(model ?? '');
    if (!id) return null;
    const key = Object.hasOwn(this.table, id) ? id : Object.hasOwn(ALIASES, id) ? ALIASES[id] : undefined;
    return key !== undefined && Object.hasOwn(this.table, key) ? this.table[key]! : null;
  }

  /** The rows that price `models`, one per model, in its order, each with its long prices and when they apply; unpriced models are left out. */
  rowsFor(models: readonly string[]): PriceRowView[] {
    return models.flatMap((model) => {
      const row = this.rowFor(model);
      if (!row) return [];
      const when = isClaude(keyOf(model)) ? 'over 100K prompt tokens' : 'over 272K input tokens';
      return [{ model, label: row.label, std: row.std, ...(row.long ? { long: { when, prices: row.long } } : {}) }];
    });
  }

  /**
   * Estimated USD for per-model usage: tokens × price / 1e6, summed. A tier the model has no price for is priced at `std`. A
   * model with no row adds nothing, so the rest of a mixed session is still priced; null only when every model that used tokens
   * is unpriced. A model with no tokens is skipped.
   */
  costOf(usage: ModelUsage[]): number | null {
    let total = 0;
    let priced = false;
    let unpriced = false;
    for (const { model, tier, tokens } of usage) {
      if (!PRICE_FIELDS.some((field) => tokens[field])) continue;
      const row = this.rowFor(model);
      if (row === null) unpriced = true;
      else {
        priced = true;
        total += usdAt(tokens, tier === 'long' && row.long ? row.long : row.std);
      }
    }
    return unpriced && !priced ? null : total;
  }

  /** Whether any model that used tokens has no row, so `costOf` leaves its tokens out. */
  hasUnpriced(usage: ModelUsage[]): boolean {
    return usage.some(({ model, tokens }) => PRICE_FIELDS.some((field) => tokens[field]) && this.rowFor(model) === null);
  }
}
