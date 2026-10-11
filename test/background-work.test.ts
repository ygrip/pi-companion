import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundWorkTracker } from '../src/background-work.ts';

test('background shells use complete job snapshots and completion notifications', () => {
  const tracker = new BackgroundWorkTracker();
  tracker.ingest('functions.jar_shell', { jobs: [
    { id: 's1', name: 'server', status: 'running' },
    { id: 's2', name: 'test', status: 'exited' }
  ] });
  assert.deepEqual(tracker.snapshot(), { shells: [{ id: 's1', name: 'server' }], agents: [] });
  tracker.ingest('pi-jar.shell', { events: [{ id: 's1', name: 'server', kind: 'match', status: 'running' }] });
  assert.equal(tracker.snapshot().shells.length, 1, 'ready is not exited');
  tracker.ingest('pi-jar.shell', { events: [{ id: 's1', name: 'server', kind: 'exit', status: 'failed' }] });
  assert.equal(tracker.snapshot().shells.length, 0);
  tracker.ingest('jar_shell', { jobs: [] });
  assert.deepEqual(tracker.snapshot().shells, []);
});

test('subagents are merged across batches and settle, resume, pause and stop independently', () => {
  const tracker = new BackgroundWorkTracker();
  tracker.ingest('jar_delegate', { batch: 'a', runs: [{ index: 0, name: 'scout', state: 'working' }] });
  tracker.ingest('jar_delegate', { batch: 'b', runs: [{ index: 0, name: 'reviewer', state: 'queued' }] });
  assert.equal(tracker.snapshot().agents.length, 2);
  tracker.ingest('pi-jar.subagent', { events: [{ key: 'delegate-a-0', turn: 1 }] });
  assert.deepEqual(tracker.snapshot().agents, [{ id: 'delegate-b-0', name: 'reviewer' }]);
  tracker.ingest('jar_subagent', { key: 'delegate-a-0', action: 'resume', status: 'accepted' });
  assert.equal(tracker.snapshot().agents.length, 2);
  tracker.ingest('pi-jar.subagent', { events: [{ key: 'delegate-a-0', action: 'pause', status: 'completed' }] });
  tracker.ingest('pi-jar.subagent', { events: [{ key: 'delegate-b-0', action: 'stop', status: 'completed', report: { name: 'reviewer', state: 'stopped' } }] });
  assert.deepEqual(tracker.snapshot().agents, []);
});

test('unrelated or malformed details do not invent active work', () => {
  const tracker = new BackgroundWorkTracker();
  for (const value of [null, 'running', { jobs: [{ id: 1, status: 'running' }] }]) tracker.ingest('jar_shell', value);
  tracker.ingest('bash', { jobs: [{ id: 'fake', status: 'running' }] });
  tracker.ingest('jar_delegate', { batch: 'a', runs: [{ index: 0, state: 'hibernated' }] });
  assert.deepEqual(tracker.snapshot(), { shells: [], agents: [] });
});
