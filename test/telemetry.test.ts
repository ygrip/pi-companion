import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { normalizeTelemetry, TelemetryRelay } from '../src/telemetry.ts';

const context = (overrides: object) => overrides as ExtensionContext;

test('telemetry allowlists fields and handles aliases, absent windows, invalid data and reset timestamps', () => {
  const data = normalizeTelemetry({
    contextUsage: { tokens: 100, contextWindow: 200 }, cost: { total: 0.125 },
    providers: [{ provider: 'codex', apiKey: 'secret', weekly: { used_percent: 30, reset_at: 1800000000 }, five_hour: { remainingPercent: 80 } },
      { provider: 'bad', weekly: { usedPercent: NaN } }, { provider: 'empty' }, { provider: 'over', weekly: { usedPercent: 101 } }]
  }, 'adapter', 1000);
  assert.equal(data.context?.percent, 50);
  assert.equal(data.cost?.currency, 'USD');
  assert.equal(data.providers?.length, 1);
  assert.equal(data.providers?.[0].fiveHour?.usedPercent, 20);
  assert.equal(data.providers?.[0].weekly?.resetsAt, new Date(1800000000000).toISOString());
  assert.ok(!JSON.stringify(data).includes('secret'));
  for (const value of [null, [], 'invalid', { cost: -1 }, { cost: Infinity }]) assert.deepEqual(normalizeTelemetry(value), {});
});

test('independent adapters merge fieldwise and malformed adapters cannot erase valid fallbacks', () => {
  const relay = new TelemetryRelay();
  relay.ingest({ source: 'footer-a', context: { percent: 20 } }, '', 1000);
  relay.ingest({ source: 'cost-b', cost: 1.5 }, '', 1000);
  relay.ingest({ source: 'quota-c', provider: 'anthropic', weekly: { usedPercent: 45 } }, '', 1000);
  relay.ingest({ source: 'broken', context: { percent: NaN }, cost: -1 }, '', 1000);
  const data = relay.snapshot(undefined, 1001);
  assert.equal(data.context?.source, 'footer-a');
  assert.equal(data.cost?.amount, 1.5);
  assert.equal(data.providers?.[0].weekly?.usedPercent, 45);
  assert.equal(data.providers?.[0].fiveHour, undefined);
  relay.ingest({ context: { percent: 40 } }, 'newer-context', 2000);
  relay.ingest({ source: 'footer-a', cost: 3 }, '', 3000);
  assert.equal(relay.snapshot(undefined, 3001).context?.percent, 40, 'a cost-only update cannot promote an older context estimate');
});

test('native context and full session cost win, including zero cost and compacted usage', () => {
  const relay = new TelemetryRelay();
  relay.ingest({ context: { percent: 70 }, cost: 100 }, 'extension', 1000);
  const ctx = context({
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    sessionManager: { getEntries: () => [
      { type: 'message', message: { role: 'assistant', usage: { cost: { total: 0.5 } } } },
      { type: 'compaction', usage: { cost: { total: 0.25 } } },
      { type: 'branch_summary', usage: { cost: { total: 0.125 } } },
      { type: 'usage', usage: { cost: { total: 0.125 } } },
      { type: 'message', message: { role: 'toolResult', usage: { cost: { total: 0.5 } } } },
      { type: 'custom', data: { cost: { total: 999 } } }
    ] }
  });
  assert.equal(relay.snapshot(ctx, 1001).context?.source, 'native');
  assert.equal(relay.snapshot(ctx, 1001).cost?.amount, 1.5);
  assert.equal(relay.snapshot(context({ sessionManager: { getEntries: () => [{ type: 'usage', usage: { cost: { total: 0 } } }] } }), 1001).cost?.amount, 0);
  const compacted = relay.snapshot(context({ getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }) }), 1001);
  assert.equal(compacted.context?.tokens, undefined);
  assert.equal(compacted.context?.percent, undefined);
  assert.equal(compacted.context?.source, 'native');
});

test('missing/throwing native methods preserve extension fields and stale session readings expire independently', () => {
  const relay = new TelemetryRelay();
  relay.ingest({ context: { percent: 30 }, cost: 2, provider: 'codex', weekly: { usedPercent: 10 } }, 'footer', 1000);
  const unavailable = context({ getContextUsage: () => { throw Error('unavailable'); }, sessionManager: { getEntries: () => { throw Error('unsupported'); } } });
  assert.equal(relay.snapshot(unavailable, 1001).cost?.amount, 2);
  relay.ingest({ cost: 3 }, 'footer', 301001);
  const stale = relay.snapshot(unavailable, 301002);
  assert.equal(stale.context, undefined, 'cost updates cannot revive an old context reading');
  assert.equal(stale.cost?.amount, 3);
  assert.equal(stale.providers?.[0].weekly?.usedPercent, 10, 'quota snapshots retain their original timestamp');
});

test('provider updates replace whole snapshots and delayed snapshots cannot roll usage backward', () => {
  const relay = new TelemetryRelay();
  relay.ingest({ source: 'quota', provider: 'codex', updatedAt: '2026-10-07T10:00:00Z', weekly: { usedPercent: 30 } });
  relay.ingest({ source: 'quota', provider: 'codex', updatedAt: '2026-10-07T11:00:00Z', fiveHour: { usedPercent: 10 } });
  relay.ingest({ source: 'quota', provider: 'codex', updatedAt: '2026-10-07T09:00:00Z', weekly: { usedPercent: 1 } });
  const provider = relay.snapshot(undefined).providers?.[0];
  assert.equal(provider?.weekly, undefined, 'do not combine quota windows from unrelated snapshots/accounts');
  assert.equal(provider?.fiveHour?.usedPercent, 10);
  assert.equal(provider?.updatedAt, '2026-10-07T11:00:00.000Z');
});

test('legacy status adapters work without stealing another extension status renderer', () => {
  const relay = new TelemetryRelay();
  relay.status('custom-footer', '\x1b[32mctx: 42% | cost $1.23\x1b[0m');
  relay.status('quota-display', 'provider=codex | 5h 80% left | 7d 35% used');
  assert.equal(relay.snapshot(undefined).context?.percent, 42);
  assert.equal(relay.snapshot(undefined).cost?.amount, 1.23);
  assert.equal(relay.snapshot(undefined).providers?.[0].fiveHour?.usedPercent, 20);
  relay.status('custom-footer', undefined);
  assert.equal(relay.snapshot(undefined).cost, undefined);
  relay.status('any-extension-name', 'cost: $4.00');
  assert.equal(relay.snapshot(undefined).cost?.amount, 4, 'explicit cost labels work regardless of extension name');
  relay.status('any-extension-name', 'Budget $100 | cost $2.50');
  assert.equal(relay.snapshot(undefined).cost?.amount, 2.5, 'labelled session cost wins over unrelated dollar amounts');
  relay.invalidateContext();
  assert.equal(relay.snapshot(undefined).context, undefined);
  assert.equal(relay.snapshot(undefined).cost?.amount, 2.5);
  assert.equal(relay.snapshot(undefined).providers?.[0].provider, 'codex');
});
