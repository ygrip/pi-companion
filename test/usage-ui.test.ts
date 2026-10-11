import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { contextUsage, estimatedCost, providerSnapshots, reportedTime, retainUsageSnapshots, snapshotStatus, usagePercent } from '../ui/src/lib/usage.ts';
import type { ProviderUsage, Session } from '../ui/src/lib/types.ts';

const at = '2026-10-07T10:00:00.000Z';
const session = (id: string, providers: ProviderUsage[], status: Session['status'] = 'idle'): Session => ({
  id, shortTitle: id, cwd: '/project', pid: 1, status, remoteEnabled: true, connectedAt: at,
  telemetry: { providers }
});

test('context formatting supports percentages, native token counts, zero and missing information', () => {
  assert.equal(contextUsage(undefined), 'Unavailable');
  assert.equal(contextUsage(null), 'Unavailable');
  assert.equal(contextUsage({}), 'Unavailable');
  assert.equal(contextUsage({ percent: 12.345 }), '12.3%');
  assert.equal(contextUsage({ tokens: 100, window: 200 }), '50% · 100 / 200 tokens');
  assert.equal(contextUsage({ tokens: 0, window: 200 }), '0% · 0 / 200 tokens');
  assert.equal(contextUsage({ tokens: 100 }), '100 tokens');
  assert.equal(contextUsage({ window: 200 }), '200 token window');
  assert.equal(contextUsage({ tokens: 300, window: 200 }), '150% · 300 / 200 tokens');
  assert.equal(contextUsage({ percent: -1, tokens: NaN, window: Infinity }), 'Unavailable');
  assert.equal(contextUsage({ tokens: -100, window: 0 }), 'Unavailable');
  assert.equal(contextUsage({ percent: 60, tokens: 100, window: 200 }), '60% · 100 / 200 tokens');
});

test('estimated costs distinguish unknown from zero and gracefully support nonstandard units', () => {
  assert.equal(estimatedCost(undefined), 'Unavailable');
  assert.equal(estimatedCost(null), 'Unavailable');
  assert.equal(estimatedCost({ amount: NaN }), 'Unavailable');
  assert.equal(estimatedCost({ amount: Infinity }), 'Unavailable');
  assert.equal(estimatedCost({ amount: -1 }), 'Unavailable');
  assert.match(estimatedCost({ amount: 0 }), /0\.00/);
  assert.match(estimatedCost({ amount: 0.0012 }), /0\.0012/);
  assert.match(estimatedCost({ amount: 12.34, currency: 'eur' }), /12[.,]34/);
  assert.equal(estimatedCost({ amount: 1.25, currency: 'credits' }), '1.25 CREDITS');
});

test('missing provider windows remain unknown rather than inventing zero usage', () => {
  assert.equal(usagePercent(undefined), '—');
  assert.equal(usagePercent({ usedPercent: NaN }), '—');
  assert.equal(usagePercent({ usedPercent: -1 }), '—');
  assert.equal(usagePercent({ usedPercent: 0 }), '0%');
  assert.equal(usagePercent({ usedPercent: 25.55 }), '25.6%');
});

test('provider snapshots use the newest report from any extension or session and are not summed', () => {
  const rows = providerSnapshots([
    session('first', [{ provider: ' OpenAI ', source: 'extension-a', updatedAt: at, weekly: { usedPercent: 20 }, fiveHour: { usedPercent: 60 } }]),
    session('second', [{ provider: 'openai', source: 'extension-b', updatedAt: '2026-10-07T10:02:00.000Z', weekly: { usedPercent: 30 } }]),
    session('third', [{ provider: 'Anthropic', source: 'extension-c', updatedAt: at, fiveHour: { usedPercent: 10 } }])
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].provider, 'Anthropic');
  assert.equal(rows[1].provider, 'openai');
  assert.equal(rows[1].source, 'extension-b');
  assert.equal(rows[1].weekly?.usedPercent, 30);
  assert.equal(rows[1].fiveHour, undefined, 'do not silently combine different provider snapshots');
});

test('session consumption is visible even without quota, while older real quotas remain authoritative', () => {
  const rows = providerSnapshots([
    session('quota', [{ provider: 'Codex', source: 'quota plugin', updatedAt: at, weekly: { usedPercent: 19 } }]),
    session('local', [{ provider: 'codex', source: 'Pi session', updatedAt: '2026-10-07T10:02:00Z', sessionTokens: 1234, sessionCost: 0 }])
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weekly?.usedPercent, 19);
  assert.equal(rows[0].source, 'quota plugin');
  assert.equal(rows[0].sessionTokens, 1234);
  assert.equal(rows[0].sessionCost, 0);
  const localOnly = providerSnapshots([session('local', [{ provider: 'anthropic', updatedAt: at, sessionTokens: 35 }])]);
  assert.equal(localOnly[0].sessionTokens, 35);
  assert.equal(localOnly[0].weekly, undefined);
});

test('native totals use their own freshness while quota freshness and session status stay independent', () => {
  const active = session('active', [{ provider: 'anthropic', source: 'quota', updatedAt: at,
    weekly: { usedPercent: 20 }, sessionTokens: 5000, sessionCost: 1,
    sessionUpdatedAt: '2026-10-07T10:10:00.000Z' }]);
  const stopped = session('stopped', [{ provider: 'anthropic', updatedAt: '2026-10-07T10:05:00.000Z',
    sessionTokens: 100, sessionCost: 0.01 }], 'stopped');
  for (const sessions of [[active, stopped], [stopped, active]]) {
    const row = providerSnapshots(sessions)[0];
    assert.equal(row.sessionTokens, 5000);
    assert.equal(row.sessionCost, 1);
    assert.equal(row.updatedAt, at);
    assert.equal(row.sessionUpdatedAt, '2026-10-07T10:10:00.000Z');
    assert.equal(row.sessionEnded, false);
    assert.equal(row.weekly?.usedPercent, 20);
  }
  stopped.telemetry!.providers![0].sessionUpdatedAt = '2026-10-07T10:11:00.000Z';
  const row = providerSnapshots([active, stopped])[0];
  assert.equal(row.sessionTokens, 100);
  assert.equal(row.sessionEnded, true, 'stopped consumption must not inherit the quota session status');
  assert.equal(row.ended, false);
});

test('mobile usage has compact cards and pull-to-refresh has no redundant button', () => {
  const settings = readFileSync(new URL('../ui/src/routes/settings/+page.svelte', import.meta.url), 'utf8');
  assert.match(settings, /class="usage-cards"/);
  assert.match(settings, /Latest session tokens/);
  assert.match(settings, /Latest session cost estimate/);
  const refresh = readFileSync(new URL('../ui/src/lib/PullToRefresh.svelte', import.meta.url), 'utf8');
  assert.doesNotMatch(refresh, /<button/);
  assert.match(refresh, /touchend/);
  for (const file of ['AutomationTable.svelte', 'SessionTable.svelte']) {
    const source = readFileSync(new URL('../ui/src/lib/' + file, import.meta.url), 'utf8');
    assert.match(source, /mobile-session-cards|routine-cards/);
  }
});

test('invalid timestamps cannot displace dated provider snapshots and active copies win ties', () => {
  const rows = providerSnapshots([
    session('invalid', [{ provider: 'OpenAI', updatedAt: 'bad', weekly: { usedPercent: 80 } }]),
    session('ended', [{ provider: 'OpenAI', updatedAt: at, weekly: { usedPercent: 20 } }], 'stopped'),
    session('active', [{ provider: 'OpenAI', updatedAt: at, weekly: { usedPercent: 20 } }]),
    session('invalid-last', [{ provider: 'OpenAI', updatedAt: 'bad', weekly: { usedPercent: 90 } }])
  ]);
  assert.equal(rows[0].weekly?.usedPercent, 20);
  assert.equal(rows[0].ended, false);
  assert.equal(rows[0].updatedAt, at);
});

test('empty, malformed and unavailable provider snapshots are handled gracefully', () => {
  assert.deepEqual(providerSnapshots([]), []);
  assert.deepEqual(providerSnapshots([session('empty', [{ provider: ' ', updatedAt: at }])]), []);
  const malformed = session('malformed', []);
  malformed.telemetry!.providers = { provider: 'bad' } as unknown as ProviderUsage[];
  assert.deepEqual(providerSnapshots([malformed]), []);
  const noTelemetry = session('none', []);
  delete noTelemetry.telemetry;
  assert.deepEqual(providerSnapshots([noTelemetry]), []);
});

test('saved usage survives session removal and quota and session freshness remain independent', () => {
  const original = session('closed', [{ provider: 'openai-codex', source: 'account', updatedAt: at,
    weekly: { usedPercent: 16 }, fiveHour: { usedPercent: 20 }, sessionTokens: 50 }]);
  let cache = retainUsageSnapshots([], [original]);
  cache = retainUsageSnapshots(cache, [{ ...original, status: 'stopped' }]);
  const rows = providerSnapshots([], cache);
  assert.equal(rows[0].weekly?.usedPercent, 16);
  assert.equal(rows[0].fiveHour?.usedPercent, 20);
  assert.equal(rows[0].sessionTokens, 50);
  assert.equal(rows[0].sessionId, 'closed');
  assert.equal(rows[0].ended, true);
  assert.equal(rows[0].updatedAt, at);
  // A tokens-only report must not erase a previously saved account snapshot.
  cache = retainUsageSnapshots(cache, [session('closed', [{ provider: 'openai-codex',
    updatedAt: '2026-10-07T10:05:00Z', sessionTokens: 100 }])]);
  const updated = providerSnapshots([], cache)[0];
  assert.equal(updated.weekly?.usedPercent, 16);
  assert.equal(updated.updatedAt, at);
  assert.equal(updated.sessionTokens, 100);
  assert.equal(updated.sessionUpdatedAt, '2026-10-07T10:05:00Z');
  assert.equal(updated.ended, true, 'saved reports are not live session readings');
});

test('saved usage is bounded, deduplicated and hidden when remote sharing is revoked', () => {
  const report = session('shared', [{ provider: 'anthropic', updatedAt: at, weekly: { usedPercent: 10 } }]);
  const cache = retainUsageSnapshots([], [report]);
  assert.equal(retainUsageSnapshots(cache, [report]).length, 1);
  assert.deepEqual(retainUsageSnapshots(cache, [{ ...report, remoteEnabled: false }], true), []);
  const many = Array.from({ length: 505 }, (_, index) => ({ ...report, id: String(index) }));
  const bounded = retainUsageSnapshots([], many);
  assert.equal(bounded.length, 500);
  assert.equal(bounded.some(snapshot => snapshot.id === '0'), false);
});

test('timestamps and snapshot status disclose ended sessions, old data and unknown dates', () => {
  const snapshot = { provider: 'OpenAI', updatedAt: at, ended: false };
  const now = Date.parse(at);
  assert.equal(snapshotStatus(snapshot, now), 'Recent snapshot');
  assert.equal(snapshotStatus(snapshot, now + 15 * 60_000), 'Saved snapshot · older than 15 minutes');
  assert.equal(snapshotStatus({ ...snapshot, ended: true }, now), 'Saved snapshot · session closed');
  assert.equal(snapshotStatus({ ...snapshot, updatedAt: 'bad' }, now), 'Snapshot time unknown');
  assert.equal(reportedTime(undefined), 'Unknown');
  assert.equal(reportedTime('bad'), 'Unknown');
  assert.notEqual(reportedTime(at), 'Unknown');
});

test('Settings usage tabs expose linked panels, keyboard support and a labeled scrollable table', () => {
  const settings = readFileSync(new URL('../ui/src/routes/settings/+page.svelte', import.meta.url), 'utf8');
  assert.match(settings, /role="tablist" aria-label="Settings sections"/);
  for (const name of ['general', 'usage']) {
    assert.ok(settings.includes(`id="settings-${name}-tab"`));
    assert.ok(settings.includes(`aria-controls="settings-${name}-panel"`));
    assert.ok(settings.includes(`id="settings-${name}-panel" role="tabpanel" aria-labelledby="settings-${name}-tab"`));
  }
  assert.match(settings, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(settings, /Weekly used/);
  assert.match(settings, /5-hour used/);
  assert.match(settings, /<caption>Provider-reported account limits and latest session totals<\/caption>/);
  assert.match(settings, /Not reported/);
  assert.match(settings, /Closing or archiving a session does not erase them/);
  assert.doesNotMatch(settings, /Account quota limits additionally require a compatible reporting extension/);
  assert.match(settings, /usage-scroll" role="region"[^>]+tabindex="0"/);
  assert.match(settings, /providerSnapshots\(companion.sessions, companion.usageSnapshots\)/);
  assert.match(settings, /\.settings-panel\[hidden\] \{ display: none; \}/);
  assert.match(settings, /clearInterval\(timer\)/);
  const detail = readFileSync(new URL('../ui/src/routes/sessions/[id]/+page.svelte', import.meta.url), 'utf8');
  assert.match(detail, /Context\{ended/);
  assert.match(detail, /Estimated cost: \{estimatedCost\(session.telemetry\?\.cost\)\}/);
});
