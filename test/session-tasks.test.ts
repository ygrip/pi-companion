import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTasks, sessionTasks } from '../src/session-tasks.ts';

const event = (data: Record<string, unknown>) => ({ type: 'custom', customType: 'pi-jar.task', data: { v: 1, ...data } });
const task = (id: string, status = 'pending', parentId?: string) => ({ id, title: `Task ${id}`, status, ...(parentId ? { parentId } : {}) });
const write = (items: unknown[]) => event({ op: 'write', items });
const tree = [task('parent'), task('child-a', 'pending', 'parent'), task('child-b', 'pending', 'parent'), task('other')];

test('native add, edit, status, toggle and delete events project complete ordered tasks', () => {
  const entries = [
    event({ op: 'add', id: 'a', title: 'Initial', details: 'Keep this context' }),
    event({ op: 'add', id: 'b', title: 'Second' }),
    event({ op: 'edit', id: 'a', title: 'Revised' }),
    event({ op: 'status', id: 'a', status: 'in_progress' }),
    event({ op: 'status', id: 'b', status: 'in_progress' })
  ];
  assert.deepEqual(sessionTasks(entries), [
    { id: 'a', title: 'Revised', status: 'pending', details: 'Keep this context' },
    { id: 'b', title: 'Second', status: 'in_progress' }
  ]);
  assert.equal(sessionTasks([...entries, event({ op: 'toggle', id: 'b', done: true })])[1].status, 'completed');
  assert.equal(sessionTasks([...entries, event({ op: 'toggle', id: 'b', done: false })])[1].status, 'pending');
  assert.deepEqual(sessionTasks([...entries, event({ op: 'delete', id: 'a' })]).map(item => item.id), ['b']);
});

test('parent actions cascade and status rolls up from child progress', () => {
  const entries = [write(tree), event({ op: 'status', id: 'parent', status: 'in_progress' })];
  assert.deepEqual(sessionTasks(entries).map(item => item.status), ['in_progress', 'in_progress', 'pending', 'pending']);
  const partlyDone = [...entries, event({ op: 'toggle', id: 'child-a', done: true })];
  assert.equal(sessionTasks(partlyDone)[0].status, 'in_progress');
  const next = [...partlyDone, event({ op: 'status', id: 'parent', status: 'in_progress' })];
  assert.equal(sessionTasks(next)[2].status, 'in_progress');
  assert.deepEqual(sessionTasks([...next, event({ op: 'status', id: 'parent', status: 'completed' })]).map(item => item.status), ['completed', 'completed', 'completed', 'pending']);
  assert.deepEqual(sessionTasks([...next, event({ op: 'status', id: 'parent', status: 'pending' })]).map(item => item.status), ['pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(sessionTasks([...next, event({ op: 'delete', id: 'parent' })]).map(item => item.id), ['other']);
});

test('added children stay grouped with their parent and cannot nest below another child', () => {
  const entries = [write([task('parent'), task('other')]),
    event({ op: 'add', id: 'child', title: 'Child', parentId: 'parent' }),
    event({ op: 'add', id: 'nested', title: 'Nested', parentId: 'child' }),
    event({ op: 'add', id: 'orphan', title: 'Orphan', parentId: 'missing' })];
  assert.deepEqual(sessionTasks(entries).map(item => item.id), ['parent', 'child', 'other']);
});

test('full writes restore more than the eight-item tool preview and preserve omitted details', () => {
  const items = Array.from({ length: 12 }, (_, i) => task(`task-${i}`));
  const entries = [write([{ ...items[0], details: 'Persisted details', activeForm: 'Working' }]), write(items)];
  assert.equal(sessionTasks(entries).length, 12);
  assert.equal(sessionTasks(entries)[0].details, 'Persisted details');
  assert.equal(sessionTasks(entries)[0].activeForm, undefined);
  assert.equal(sessionTasks([...entries, write([{ ...items[0], details: '' }])])[0].details, undefined);
  const interleaved = [
    write([{ ...task('parent'), details: 'Parent details' }, { ...task('other'), details: 'Other details' }, { ...task('child', 'pending', 'parent'), details: 'Child details' }]),
    write([task('parent'), task('other'), task('child', 'pending', 'parent')])];
  assert.deepEqual(sessionTasks(interleaved).map(item => [item.id, item.details]), [['parent', 'Parent details'], ['child', 'Child details'], ['other', 'Other details']]);
  assert.deepEqual(sessionTasks([...entries, write([])]), []);
});

test('malformed writes and unsupported events cannot clear or partially mutate valid tasks', () => {
  const entries = [write([task('safe')])];
  for (const invalid of [
    write([task('new'), { id: 'broken' }]),
    write([task('dup'), task('dup')]),
    write([task('orphan', 'pending', 'missing')]),
    write([task('a', 'in_progress'), task('b', 'in_progress')]),
    event({ op: 'status', id: 'safe', status: 'invalid' }),
    event({ op: 'edit', id: 'safe', title: '' }),
    event({ op: 'toggle', id: 'safe', done: 'yes' }),
    event({ op: 'write', v: 2, items: [] }),
    { type: 'message', customType: 'pi-jar.task', data: { v: 1, op: 'write', items: [] } }
  ]) assert.deepEqual(sessionTasks([...entries, invalid]), [task('safe')]);
});

test('task lists restore only the supplied branch and ignore truncated jar_todo results', () => {
  const shared = write([task('root')]);
  const firstBranch = [shared, event({ op: 'status', id: 'root', status: 'completed' })];
  const secondBranch = [shared, write([task('branch')]),
    { type: 'message', message: { role: 'toolResult', toolName: 'jar_todo', details: { items: [task('preview')] } } }];
  assert.equal(sessionTasks(firstBranch)[0].status, 'completed');
  assert.deepEqual(sessionTasks(secondBranch), [task('branch')]);
});

test('neutral snapshots distinguish invalid data from deliberate clears and allow parallel work', () => {
  assert.deepEqual(normalizeTasks({ items: [] }), []);
  for (const value of [null, [], {}, { items: 'invalid' }, { items: [{ ...task('a'), details: 42 }] }]) assert.equal(normalizeTasks(value), undefined);
  const parallel = [task('a', 'in_progress'), task('b', 'in_progress')];
  assert.deepEqual(normalizeTasks({ items: parallel }), parallel);
  const entries = [write([task('native')]), { type: 'custom', customType: 'companion.tasks', data: { items: parallel } }];
  assert.deepEqual(sessionTasks(entries), parallel);
  assert.deepEqual(sessionTasks([...entries, { type: 'custom', customType: 'companion.tasks', data: {} }]), parallel);
  assert.deepEqual(sessionTasks([...entries, { type: 'custom', customType: 'companion.tasks', data: { items: [] } }]), []);
});

test('normalization bounds text, rejects orphan/deep children and enforces task limits', () => {
  const normalized = normalizeTasks({ items: [{ ...task('a'), title: '  A  ', activeForm: 'x'.repeat(100), details: 'y'.repeat(300) }] })!;
  assert.equal(normalized[0].title, 'A');
  assert.equal(normalized[0].activeForm?.length, 80);
  assert.equal(normalized[0].details?.length, 240);
  for (const items of [
    [task('bad id')], [task('x'.repeat(65))], [{ ...task('a'), title: 'x'.repeat(257) }],
    [task('orphan', 'pending', 'missing')],
    [task('parent'), task('child', 'pending', 'parent'), task('nested', 'pending', 'child')],
    Array.from({ length: 51 }, (_, i) => task(`task-${i}`))
  ]) assert.equal(normalizeTasks({ items }), undefined);
  const full = Array.from({ length: 50 }, (_, i) => task(`task-${i}`));
  assert.equal(sessionTasks([write(full), event({ op: 'add', id: 'overflow', title: 'Too many' })]).length, 50);
});
