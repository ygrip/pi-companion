import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundWorkTracker } from '../src/background-work.ts';
import { elapsedTime } from '../ui/src/lib/format.ts';

const startedAt = 1_700_000_000_000;

test('background shells use complete job snapshots and completion notifications', () => {
  const tracker = new BackgroundWorkTracker(() => startedAt);
  tracker.ingest('functions.jar_shell', { jobs: [
    { id: 's1', name: 'server', status: 'running' },
    { id: 's2', name: 'test', status: 'exited' }
  ] });
  assert.deepEqual(tracker.snapshot(), { shells: [{ id: 's1', name: 'server', state: 'running', startedAt }], agents: [] });
  tracker.ingest('pi-jar.shell', { events: [{ id: 's1', name: 'server', kind: 'match', status: 'running' }] });
  assert.equal(tracker.snapshot().shells.length, 1, 'ready is not exited');
  tracker.ingest('pi-jar.shell', { events: [{ id: 's1', name: 'server', kind: 'exit', status: 'failed' }] });
  assert.equal(tracker.snapshot().shells.length, 0);
  tracker.ingest('jar_shell', { jobs: [] });
  assert.deepEqual(tracker.snapshot().shells, []);
});

test('subagents are merged across batches and settle, resume, pause and stop independently', () => {
  const tracker = new BackgroundWorkTracker(() => startedAt);
  tracker.ingest('jar_delegate', { batch: 'a', runs: [{ index: 0, name: 'scout', state: 'working' }] });
  tracker.ingest('jar_delegate', { batch: 'b', runs: [{ index: 0, name: 'reviewer', state: 'queued' }] });
  assert.equal(tracker.snapshot().agents.length, 2);
  tracker.ingest('pi-jar.subagent', { events: [{ key: 'delegate-a-0', turn: 1 }] });
  assert.deepEqual(tracker.snapshot().agents, [{ id: 'delegate-b-0', name: 'reviewer', state: 'queued', startedAt }]);
  tracker.ingest('jar_subagent', { key: 'delegate-a-0', action: 'resume', status: 'accepted' });
  assert.equal(tracker.snapshot().agents.length, 2);
  tracker.ingest('pi-jar.subagent', { events: [{ key: 'delegate-a-0', action: 'pause', status: 'completed' }] });
  tracker.ingest('pi-jar.subagent', { events: [{ key: 'delegate-b-0', action: 'stop', status: 'completed', report: { name: 'reviewer', state: 'stopped' } }] });
  assert.deepEqual(tracker.snapshot().agents, []);
});

test('unrelated or malformed details do not invent active work', () => {
  const tracker = new BackgroundWorkTracker(() => startedAt);
  for (const value of [null, 'running', { jobs: [{ id: 1, status: 'running' }] }]) tracker.ingest('jar_shell', value);
  tracker.ingest('bash', { jobs: [{ id: 'fake', status: 'running' }] });
  tracker.ingest('jar_delegate', { batch: 'a', runs: [{ index: 0, state: 'hibernated' }] });
  assert.deepEqual(tracker.snapshot(), { shells: [], agents: [] });
});

test('elapsed starts survive repeated shell snapshots and reset for resumed agent turns', () => {
  let now = startedAt;
  const tracker = new BackgroundWorkTracker(() => now);
  tracker.ingest('jar_shell', { jobs: [{ id: 's1', status: 'running' }] });
  tracker.ingest('jar_delegate', { runs: [{ key: 'a1', state: 'working' }] });
  now += 90_000;
  tracker.ingest('jar_shell', { jobs: [{ id: 's1', status: 'running' }] });
  assert.equal(tracker.snapshot().shells[0].startedAt, startedAt);
  assert.equal(tracker.snapshot().agents[0].startedAt, startedAt);
  tracker.ingest('pi-jar.subagent', { events: [{ key: 'a1', turn: 1 }] });
  tracker.ingest('jar_subagent', { key: 'a1', action: 'resume', status: 'accepted' });
  assert.equal(tracker.snapshot().agents[0].startedAt, now);
});

test('source start timestamps override observation time and malformed timestamps stay safe', () => {
  const tracker = new BackgroundWorkTracker(() => startedAt);
  tracker.ingest('jar_shell', { jobs: [{ id: 's1', status: 'running', startedAt: (startedAt - 60_000) / 1000 }] });
  assert.equal(tracker.snapshot().shells[0].startedAt, startedAt - 60_000);
  tracker.ingest('jar_shell', { jobs: [{ id: 's1', status: 'running', startedAt: 'invalid' }] });
  assert.equal(tracker.snapshot().shells[0].startedAt, startedAt - 60_000);
  tracker.ingest('jar_delegate', { runs: [{ key: 'a1', state: 'working', startedAt: new Date(startedAt - 120_000).toISOString() }] });
  assert.equal(tracker.snapshot().agents[0].startedAt, startedAt - 120_000);
});

test('elapsed labels cover seconds, minutes, hours, days and missing legacy timestamps', () => {
  for (const [seconds, label] of [[0, '0s'], [59, '59s'], [60, '1m 0s'], [90, '1m 30s'], [3600, '1h 0m'], [90061, '1d 1h']] as const) {
    assert.equal(elapsedTime(startedAt, startedAt + seconds * 1000), label);
  }
  assert.equal(elapsedTime(startedAt, startedAt - 1000), '0s');
  assert.equal(elapsedTime(undefined, startedAt), 'Time unavailable');
  assert.equal(elapsedTime(NaN, startedAt), 'Time unavailable');
});
