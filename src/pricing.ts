import { config } from "./config.js";

// What a model call costs us, in USD. Pure: no DB, no HTTP.
//
// Cost is computed at WRITE time and stored on the usage row (`usage.cost_usd`),
// never derived at read time. Two reasons: a price change must not silently
// rewrite what past months cost, and the quota check stays a single indexed SUM.

/** USD per 1M tokens. Verify against https://openai.com/api/pricing before editing. */
type Price = { input: number; cachedInput: number; output: number };

const PRICES: Record<string, Price> = {
  "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10.0 },
};

// Used when a call reports a model we have no price for — better to over-bill
// against the quota than to let unpriced calls run free.
const FALLBACK: Price = PRICES["gpt-5.1"]!;

const warned = new Set<string>();

export function priceFor(model: string): Price {
  // Env overrides apply only to the configured model: they exist so a price
  // change can ship without a code edit, not to price arbitrary models.
  if (model === config.model && (config.priceInputPerMtok || config.priceOutputPerMtok)) {
    const base = PRICES[model] ?? FALLBACK;
    return {
      input: config.priceInputPerMtok ?? base.input,
      cachedInput: config.priceCachedInputPerMtok ?? base.cachedInput,
      output: config.priceOutputPerMtok ?? base.output,
    };
  }
  const price = PRICES[model];
  if (price) return price;
  if (!warned.has(model)) {
    warned.add(model);
    console.warn(`No price entry for model "${model}" — billing at ${config.model} rates.`);
  }
  return FALLBACK;
}

export type TokenCounts = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
};

/**
 * USD for one model call. Null counts (a call that threw before reporting usage)
 * price as zero — a known undercount, see CLAUDE.md "Quota".
 *
 * `cachedInputTokens` is a SUBSET of `inputTokens` (it mirrors OpenAI's
 * `prompt_tokens_details.cached_tokens`), so the cached part is subtracted out
 * and re-priced at the cheaper rate rather than added on top.
 */
export function costUsd(model: string, tokens: TokenCounts): number {
  const p = priceFor(model);
  const cached = tokens.cachedInputTokens ?? 0;
  const fresh = Math.max(0, (tokens.inputTokens ?? 0) - cached);
  const output = tokens.outputTokens ?? 0;
  return (fresh * p.input + cached * p.cachedInput + output * p.output) / 1_000_000;
}
