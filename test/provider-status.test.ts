import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderQuota, providerError, ProviderQuotaPoller } from '../src/provider-status.ts';
import { TelemetryRelay } from '../src/telemetry.ts';
import { reduceBridgeMessage } from '../ui/src/lib/activity.ts';

test('Codex windows are classified by duration, not slot; Anthropic percentages remain percentages', () => {
  const quota = parseProviderQuota('openai-codex', { rate_limit: { primary_window: { used_percent: 92, limit_window_seconds: 604800 }, secondary_window: { used_percent: 12, limit_window_seconds: 18000 } } });
  assert.equal(quota.weekly?.usedPercent, 92); assert.equal(quota.fiveHour?.usedPercent, 12);
  const anthropic = parseProviderQuota('anthropic', { seven_day: { utilization: 7 }, five_hour: { utilization: 15, resets_at: '2026-10-10T12:00:00Z' } });
  assert.equal(anthropic.weekly?.usedPercent, 7); assert.equal(anthropic.fiveHour?.usedPercent, 15);
});

test('quota poller resolves each OAuth provider independently and never publishes credentials', async () => {
  const original = globalThis.fetch;
  const reports: unknown[] = [];
  const requests: string[] = [];
  const poller = new ProviderQuotaPoller(value => reports.push(value));
  const token = 'header.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url') + '.signature';
  const ctx: any = { modelRegistry: {
    getAvailable: () => [{ provider: 'openai-codex' }, { provider: 'anthropic' }], isUsingOAuth: () => true,
    getApiKeyAndHeaders: async (model: any) => ({ ok: true, apiKey: model.provider === 'openai-codex' ? token : 'private-anthropic-token' })
  } };
  globalThis.fetch = async url => {
    requests.push(String(url));
    return new Response(JSON.stringify(String(url).includes('wham') ? { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 604800 } } } : { five_hour: { utilization: 42 } }));
  };
  try {
    await poller.refresh(ctx); await poller.refresh(ctx);
    assert.equal(requests.length, 2); assert.equal(reports.length, 2);
    assert.ok(!JSON.stringify(reports).includes(token));
    assert.ok(!JSON.stringify(reports).includes('private-anthropic-token'));
  } finally { poller.stop(); globalThis.fetch = original; }
});

test('provider errors become readable replayable feed entries without leaking raw payloads', () => {
  for (const [errorMessage, title] of [['429 too many requests', 'Provider rate limit'], ['insufficient_quota token=private', 'Provider quota exhausted'], ['401 unauthorized', 'Provider authentication failed']]) {
    const failure = providerError({ role: 'assistant', provider: 'anthropic', stopReason: 'error', errorMessage });
    assert.equal(failure?.title, title);
    assert.ok(!failure?.message.includes('private'));
    const entries = reduceBridgeMessage([], { type: 'event', event: 'provider.error', payload: failure });
    assert.equal(entries[0].kind, 'error'); assert.ok(entries[0].title.includes('anthropic'));
  }
  assert.equal(providerError({ role: 'assistant', stopReason: 'stop' }), undefined);
});

test('pi-jar JSON quota statuses retain separate providers', () => {
  const relay = new TelemetryRelay();
  relay.status('pi-jar.quota.openai-codex', JSON.stringify({ expiresAt: Date.now() + 290000, week: { used: 92 } }));
  relay.status('pi-jar.quota.anthropic', JSON.stringify({ expiresAt: Date.now() + 290000, fiveHour: { used: 8 } }));
  const providers = relay.snapshot(undefined).providers!;
  assert.equal(providers.find(p => p.provider === 'openai-codex')?.weekly?.usedPercent, 92);
  assert.equal(providers.find(p => p.provider === 'anthropic')?.fiveHour?.usedPercent, 8);
});
