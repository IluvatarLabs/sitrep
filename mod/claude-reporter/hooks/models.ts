// Claude model families and context windows. Pure.

const CLAUDE = ['opus', 'sonnet', 'haiku', 'fable'] as const;
type Family = (typeof CLAUDE)[number] | 'other';

/**
 * The family by lowercase substring. Only a Claude model has one: a bare alias (`opus`, `sonnet[1m]`, `opusplan`) or an id
 * holding `claude`. A local model whose name happens to hold a family word is `other`.
 */
export function family(model?: string | null): Family {
  const id = (model ?? '').toLowerCase();
  const alias = /^(opus|sonnet|haiku|fable|opusplan)(\[[^\]]*\])?$/.test(id);
  if (!alias && !id.includes('claude')) return 'other';
  return CLAUDE.find((f) => id.includes(f)) ?? 'other';
}

/**
 * The context window in tokens; null for a model that is not Claude (its percent is then unknown, never figured against
 * 1M). Haiku 4.5 and older and the Claude 3 ids have 200K, every other current model 1M. The main loop prefers
 * `$.session.usage().context.window`.
 */
export function windowOf(model?: string | null): number | null {
  const id = (model ?? '').toLowerCase();
  if (family(id) === 'other') return null;
  return /haiku-4|haiku-3|claude-3/.test(id) ? 200_000 : 1_000_000;
}

/** `Opus`, `Sonnet`, `Haiku` or `Fable`; any other model by its own id. */
export function shortName(model?: string | null): string {
  const f = family(model);
  return f === 'other' ? (model ?? 'unknown') : f[0]!.toUpperCase() + f.slice(1);
}
