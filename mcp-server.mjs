#!/usr/bin/env node
/**
 * statlyte MCP server — live LLM pricing for coding agents.
 *
 *   claude mcp add statlyte -- npx -y statlyte-mcp
 *
 * An assistant's training data goes stale on prices within weeks, and guessing
 * a number is worse than not answering. This gives it the current figures, read
 * from each vendor's own published pricing page.
 *
 * Raw JSON-RPC over stdio, zero dependencies, so `npx` starts it instantly.
 */
import { getModels, getModel, costOf, rankByCost, scheduledChanges } from './index.mjs';

const TOOLS = [
  {
    name: 'list_models',
    description:
      'List LLM models with current published pricing (USD per million tokens, or nonTokenPrice for audio/image models billed per minute/character/etc), context windows and API identifiers. Optionally filter by provider.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'e.g. anthropic, openai, google, mistral' },
        includeRetired: { type: 'boolean', description: 'Include deprecated and retired models' },
      },
    },
  },
  {
    name: 'get_model_pricing',
    description:
      'Current published pricing and specs for one model. Accepts a statlyte id (anthropic/claude-opus-5) or a vendor API id (gpt-5-mini).',
    inputSchema: {
      type: 'object',
      properties: { model: { type: 'string' } },
      required: ['model'],
    },
  },
  {
    name: 'estimate_cost',
    description:
      'Cost in USD of a call or workload against one model, given raw token counts.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        input: { type: 'number', description: 'input tokens' },
        output: { type: 'number', description: 'output tokens' },
        cacheRead: { type: 'number' },
      },
      required: ['model'],
    },
  },
  {
    name: 'cheapest_for_workload',
    description:
      'Rank every generally-available model by what a monthly token volume would cost. Use to answer "what is the cheapest model for this workload".',
    inputSchema: {
      type: 'object',
      properties: {
        inputPerMonth: { type: 'number', description: 'input tokens per month' },
        outputPerMonth: { type: 'number', description: 'output tokens per month' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'scheduled_price_changes',
    description:
      'Price changes vendors have announced for a future date, with the old and new figures. Check before committing to a model.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const CAVEAT =
  'Source: statlyte.com, read from each vendor\'s own published pricing page. ' +
  'List prices only — negotiated, regional and enterprise rates differ. Confirm with the vendor before acting commercially.';

async function call(name, args = {}) {
  switch (name) {
    case 'list_models': {
      const all = await getModels();
      const rows = all
        .filter((m) => (args.includeRetired ? true : m.status === 'ga'))
        .filter((m) => (args.provider ? m.provider === args.provider : true))
        .map((m) => ({
          id: m.id, name: m.name, apiId: m.apiId, provider: m.provider,
          contextWindow: m.contextWindow, usdPerMTok: m.prices,
          nonTokenPrice: m.nonTokenPrice,
        }));
      return { count: rows.length, models: rows, note: CAVEAT };
    }
    case 'get_model_pricing': {
      const m = await getModel(args.model);
      if (!m) return { error: `unknown model "${args.model}"` };
      return { ...m, note: CAVEAT };
    }
    case 'estimate_cost': {
      const usd = await costOf(args.model, {
        input: args.input, output: args.output, cacheRead: args.cacheRead,
      });
      return { model: args.model, usd: Number(usd.toFixed(6)), note: CAVEAT };
    }
    case 'cheapest_for_workload': {
      const ranked = await rankByCost({
        inputPerMonth: args.inputPerMonth ?? 0,
        outputPerMonth: args.outputPerMonth ?? 0,
      });
      return {
        ranked: ranked.slice(0, args.limit ?? 15).map((m) => ({
          id: m.id, name: m.name, provider: m.provider,
          monthlyUsd: Number(m.monthlyCost.toFixed(2)),
        })),
        note: `${CAVEAT} Price only — a cheaper model is not automatically a capable substitute.`,
      };
    }
    case 'scheduled_price_changes':
      return { changes: await scheduledChanges(), note: CAVEAT };
    default:
      return { error: `unknown tool "${name}"` };
  }
}

/* ---- JSON-RPC over stdio ------------------------------------------------ */

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'statlyte', version: '0.1.1' },
      },
    };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      const out = await call(params?.name, params?.arguments ?? {});
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] },
      };
    } catch (e) {
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `statlyte error: ${e.message}` }], isError: true },
      };
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (id === undefined) return null; // notification
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } };
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const res = await handle(JSON.parse(line));
      if (res) send(res);
    } catch (e) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(e) } });
    }
  }
});
