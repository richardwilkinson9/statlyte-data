/**
 * statlyte — live LLM pricing, without the stale table.
 *
 * Every app that touches an LLM ends up with a hardcoded map of model ids to
 * prices and context windows. It is wrong within weeks. This fetches the live
 * one, and falls back to a snapshot bundled at publish time so it never throws
 * on a flaky network.
 *
 * Zero dependencies. Works in Node, Bun, Deno, Workers and the browser.
 */

import snapshot from './models.json' with { type: 'json' };

const API = 'https://statlyte.com/api/v1/models';
const TTL = 6 * 60 * 60 * 1000; // Prices move slowly; six hours is plenty.

let cache = null;
let cachedAt = 0;

/** Normalises both the live API shape and the bundled snapshot into one form. */
function normalise(raw) {
  const models = raw.models ?? raw;
  return models.map((m) => ({
    id: m.id,
    provider: m.provider,
    name: m.name,
    apiId: m.api_id ?? m.apiId ?? m.slug,
    status: m.status ?? 'ga',
    modality: m.modality ?? 'text',
    contextWindow: m.context_window ?? m.contextWindow ?? null,
    maxOutput: m.max_output ?? m.maxOutput ?? null,
    /** USD per million tokens. */
    prices: m.usd_per_mtok ?? m.prices ?? {},
    scheduledChange: m.scheduled_change ?? m.scheduledChange ?? null,
    notes: m.notes ?? null,
  }));
}

/**
 * All tracked models. Hits the network at most once every six hours.
 * Pass `{ offline: true }` to use only the bundled snapshot.
 */
export async function getModels(opts = {}) {
  if (opts.offline) return normalise(snapshot);
  if (cache && Date.now() - cachedAt < TTL) return cache;
  try {
    const res = await fetch(API, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`statlyte api ${res.status}`);
    cache = normalise(await res.json());
    cachedAt = Date.now();
    return cache;
  } catch {
    // A stale price beats an exception in someone's request path.
    return normalise(snapshot);
  }
}

/** Look a model up by statlyte id (`openai/gpt-5`) or by the vendor's own api id (`gpt-5`). */
export async function getModel(idOrApiId, opts = {}) {
  const models = await getModels(opts);
  const needle = String(idOrApiId).toLowerCase();
  return (
    models.find((m) => m.id.toLowerCase() === needle) ??
    models.find((m) => (m.apiId ?? '').toLowerCase() === needle) ??
    models.find((m) => m.name.toLowerCase() === needle) ??
    null
  );
}

/**
 * What a call actually cost. Token counts are raw tokens, not millions.
 *
 *   await costOf('claude-sonnet-5', { input: 12_000, output: 800 })  // => 0.032
 */
export async function costOf(idOrApiId, tokens = {}, opts = {}) {
  const m = await getModel(idOrApiId, opts);
  if (!m) throw new Error(`statlyte: unknown model "${idOrApiId}"`);
  const p = m.prices;
  const per = (n, rate) => ((n ?? 0) / 1e6) * (rate ?? 0);
  return (
    per(tokens.input, p.input) +
    per(tokens.output, p.output) +
    per(tokens.cacheRead ?? tokens.cache_read, p.cache_read ?? p.input) +
    per(tokens.cacheWrite ?? tokens.cache_write, p.cache_write_5m ?? p.input)
  );
}

/** Models ranked by what a given monthly volume would cost, cheapest first. */
export async function rankByCost({ inputPerMonth = 0, outputPerMonth = 0 } = {}, opts = {}) {
  const models = await getModels(opts);
  return models
    .filter((m) => m.prices.input != null && m.prices.output != null && m.status === 'ga')
    .map((m) => ({
      ...m,
      monthlyCost:
        (inputPerMonth / 1e6) * m.prices.input + (outputPerMonth / 1e6) * m.prices.output,
    }))
    .sort((a, b) => a.monthlyCost - b.monthlyCost);
}

/**
 * Announced future price changes. Worth checking in CI: if a model you depend on
 * is about to get dearer, you would rather know at build time than on the invoice.
 */
export async function scheduledChanges(opts = {}) {
  const models = await getModels(opts);
  return models
    .filter((m) => m.scheduledChange)
    .map((m) => ({
      id: m.id,
      name: m.name,
      effectiveOn: m.scheduledChange.effective_on ?? m.scheduledChange.effectiveOn,
      reason: m.scheduledChange.reason ?? null,
      from: { input: m.prices.input, output: m.prices.output },
      to: m.scheduledChange.prices,
    }))
    .sort((a, b) => String(a.effectiveOn).localeCompare(String(b.effectiveOn)));
}

export default { getModels, getModel, costOf, rankByCost, scheduledChanges };
