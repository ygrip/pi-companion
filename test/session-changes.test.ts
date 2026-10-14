import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { sessionChangedPaths } from '../src/session-changes.ts';

function tool(id: string, name: string, args: unknown, isError = false) {
  return [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: id, isError } }
  ];
}

test('successful session file operations resolve paths from cwd and ignore failed or read-only tools', () => {
  const cwd = resolve('project/subdir');
  const absolute = resolve('project/absolute.txt');
  const entries = [
    ...tool('write', 'functions.write', { path: 'new.txt', content: 'payload' }),
    ...tool('edit', 'mcp__files__edit', { file_path: '../edited.txt' }),
    ...tool('absolute', 'write', { path: absolute }),
    ...tool('failed', 'edit', { path: 'failed.txt' }, true),
    ...tool('read', 'read', { path: 'read.txt' }),
    ...tool('shell', 'bash', { command: 'echo x > shell.txt' }),
    ...tool('invalid', 'write', { path: 'bad\0path' }),
    { type: 'message', message: { role: 'toolResult', toolCallId: 'unknown', isError: false } }
  ];
  assert.deepEqual(sessionChangedPaths(entries, cwd), [resolve(cwd, 'new.txt'), resolve(cwd, '../edited.txt'), absolute]);
});

test('multi-file edits inherit their default path and patch operations include moves and deletions', () => {
  const cwd = resolve('project');
  const entries = [
    ...tool('batch', 'functions.multi_file_edit', { path: 'default.txt', edits: [{ oldText: 'a' }, { path: 'other.txt' }, { path: 'default.txt' }] }),
    ...tool('patch', 'functions.apply_patch', { patch: '*** Begin Patch\n*** Add File: added.txt\n+text\n*** Update File: original.txt\n*** Move to: renamed.txt\n@@\n-old\n+new\n*** Delete File: removed.txt\n*** End Patch' }),
    ...tool('failed-patch', 'apply_patch', { patch: '*** Add File: failed.txt\n+x' }, true)
  ];
  assert.deepEqual(sessionChangedPaths(entries, cwd).map(path => path.slice(cwd.length + 1)), ['default.txt', 'other.txt', 'added.txt', 'original.txt', 'renamed.txt', 'removed.txt']);
});

test('uncompleted calls and isolated subagent report files are not attributed to the session', () => {
  const entries = [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'pending', name: 'write', arguments: { path: 'pending.txt' } }] } },
    { type: 'message', message: { role: 'custom', customType: 'pi-jar.subagent', details: { events: [{ report: { changedFiles: ['private.txt'] } }] } } },
    null
  ];
  assert.deepEqual(sessionChangedPaths(entries, resolve('project')), []);
});

test('only proven parent-applied subagent files join the session, including partial recovery', () => {
  const cwd = resolve('project');
  const entries = [{ type: 'message', message: { role: 'custom', customType: 'pi-jar.subagent', details: { events: [
    { action: 'stop', status: 'completed', report: { changed: ['isolated.txt'], applied: ['applied.txt'] } },
    { action: 'stop', status: 'failed', report: { applied: ['partially-applied.txt'], changed: ['remaining.txt'] } },
    { action: 'discard', status: 'completed', report: { applied: ['discarded.txt'] } },
    { turn: 1, report: { changedFiles: ['unapplied.txt'] } }
  ] } } }];
  assert.deepEqual(sessionChangedPaths(entries, cwd), [resolve(cwd, 'applied.txt'), resolve(cwd, 'partially-applied.txt')]);
  const synchronous = tool('stop', 'functions.jar_subagent', { action: 'stop' }, true);
  Object.assign(synchronous[1].message, { details: { applied: ['partial-sync.txt'] } });
  assert.deepEqual(sessionChangedPaths(synchronous, cwd), [resolve(cwd, 'partial-sync.txt')]);
});
