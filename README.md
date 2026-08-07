# statlyte

**Live pricing, context windows and identifiers for every major LLM API — so you can stop hardcoding a model table that goes stale.**

Every app that touches an LLM ends up with something like this pasted into it:

```js
const PRICES = {
  'gpt-4o': { input: 2.5, output: 10 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  // …written once, wrong within a month
};
```

Then a model is retired, a new one lands, an introductory rate expires, and your cost
dashboard is quietly lying to you. This package fetches the current numbers instead.

- **110 models across 8 providers** — Anthropic, OpenAI, Google, xAI, DeepSeek, Mistral, Together AI, Voyage AI
- Read from each vendor's **own published pricing page**, every three hours, with the source URL recorded
- **Zero dependencies.** Node, Bun, Deno, Cloudflare Workers, browser
- Bundled snapshot fallback, so a flaky network never throws in your request path
- **MIT.** The data is free and the API needs no key

```bash
npm i statlyte
```

## Use it

```js
import { getModel, costOf, rankByCost, scheduledChanges } from 'statlyte';

// What does this actually cost me?
await costOf('claude-sonnet-5', { input: 12_000, output: 800 });
// => 0.032

// Look up by statlyte id or the vendor's own API id
const m = await getModel('gpt-5-mini');
m.contextWindow;        // 400000
m.prices.input;         // 0.25  (USD per million tokens)
m.prices.cache_read;    // 0.025

// Cheapest model for a real monthly workload
const ranked = await rankByCost({ inputPerMonth: 620e6, outputPerMonth: 210e6 });
ranked[0].name;         // cheapest first
ranked[0].monthlyCost;  // USD/month

// Price rises vendors have already announced
await scheduledChanges();
// [{ name: 'Claude Sonnet 5', effectiveOn: '2026-09-01',
//    from: { input: 2, output: 10 }, to: { input: 3, output: 15 },
//    reason: 'Introductory pricing ends' }]
```

Everything is cached in-process for six hours. Pass `{ offline: true }` to any call to
use only the bundled snapshot and never touch the network.

## Fail your build when a price is about to change

The genuinely useful trick. `scheduledChanges()` returns increases vendors have announced
but not yet applied — so you can find out at build time rather than on the invoice:

```js
// scripts/check-model-costs.mjs
import { scheduledChanges } from 'statlyte';

const MODELS_WE_USE = ['anthropic/claude-sonnet-5', 'openai/gpt-5-mini'];
const soon = (await scheduledChanges())
  .filter((c) => MODELS_WE_USE.includes(c.id))
  .filter((c) => new Date(c.effectiveOn) - Date.now() < 60 * 86400_000);

if (soon.length) {
  console.error('Price change coming:');
  for (const c of soon) {
    console.error(`  ${c.name} on ${c.effectiveOn}: ` +
      `in $${c.from.input}→$${c.to.input}, out $${c.from.output}→$${c.to.output} per MTok`);
  }
  process.exit(1);
}
```

## MCP server

An assistant's training data goes stale on prices within weeks, and a guessed number is
worse than no number. This gives your agent the current figures:

```bash
claude mcp add statlyte -- npx -y statlyte-mcp
```

<details>
<summary>Other MCP clients</summary>

```json
{
  "mcpServers": {
    "statlyte": { "command": "npx", "args": ["-y", "statlyte-mcp"] }
  }
}
```
</details>

Tools: `list_models`, `get_model_pricing`, `estimate_cost`, `cheapest_for_workload`,
`scheduled_price_changes`.

## Or just take the JSON

No install, no key, CORS open:

```
https://statlyte.com/api/v1/models
https://statlyte.com/api/v1/models/anthropic/claude-opus-5
https://statlyte.com/api/v1/changes
```

The raw dataset also lives in this repo as [`models.json`](models.json) and
[`changes.json`](changes.json), updated by commit — so you can diff it, pin it, or vendor it.

## Where the numbers come from

A job re-reads each provider's published pricing page every three hours. When a figure
differs from the last one on file it writes a new observation with a timestamp and the URL
it was read from. Nothing is inferred and nothing is estimated: **if a price isn't
published, it isn't listed.**

Two honest caveats:

1. **These are list prices.** Negotiated, enterprise, regional and committed-spend rates
   differ, sometimes a lot. Confirm with the vendor before making a commercial decision.
2. **Cheaper is not the same as substitutable.** This records what models cost, not what
   they can do. `rankByCost` will happily tell you an 8B model is cheaper than a frontier
   one. That is arithmetic, not advice.

Found a figure that disagrees with a vendor's page? The vendor is right and we're wrong —
[open an issue](https://github.com/richardwilkinson9/statlyte-data/issues) and it gets fixed
on the next run.

## The rest of it

[statlyte.com](https://statlyte.com) has the human-facing side: a change log, a
[calculator](https://statlyte.com/calculator) that puts two models head to head at your own
volume, and a [calendar](https://statlyte.com/calendar) of announced changes. Free, no
account.

MIT licensed. Attribution appreciated, not required.
