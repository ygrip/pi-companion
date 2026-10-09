import test from 'node:test';
import assert from 'node:assert/strict';
import { automationDraft, automationTime, automationDuration, automationSchedule, pageItems, parseAutomationDraft } from './src/lib/automations.ts';
import { matchingSlashCommands } from './src/lib/slash-commands.ts';
import { adfHtml, resultSections, safeResultLink, structuredResult } from './src/lib/automation-result.ts';

test('slash suggestions are matched, deduplicated and only offered for a command token', () => {
  const commands = [ { name: 'review', description: 'Review code', source: 'extension' as const }, { name: 'skill:qa', description: 'Report bugs', source: 'skill' as const }, { name: 'review', source: 'extension' as const } ];
  assert.equal(matchingSlashCommands('/', commands).length, 2);
  assert.equal(matchingSlashCommands('/bug', commands)[0].name, 'skill:qa');
  assert.equal(matchingSlashCommands('/review args', commands).length, 0);
  assert.equal(matchingSlashCommands('hello /', commands).length, 0);
  assert.equal(matchingSlashCommands('/', [{ name: '<script>', source: 'extension' }]).length, 0);
});
test('automation default script is valid and manual', () => {
  const draft = automationDraft();
  assert.equal(draft.schedule, null);
  assert.deepEqual(parseAutomationDraft(JSON.stringify(draft)), draft);
});
test('automation editor rejects malformed scripts before save', () => {
  for (const value of [null, [], {}, { ...automationDraft(), name: '' }, { ...automationDraft(), enabled: 1 }, { ...automationDraft(), schedule: 123 }, { ...automationDraft(), actions: [] }, { ...automationDraft(), postActions: null }]) {
    assert.throws(() => parseAutomationDraft(JSON.stringify(value)));
  }
});
test('automation validation rejects malformed steps, cron, retry values and unknown fields', () => {
  const base = automationDraft();
  for (const patch of [
    { schedule: '60 9 * * *' }, { schedule: '*/0 * * * *' }, { schedule: '0 9' }, { schedule: '0 9 * * monday' },
    { actions: [null] }, { actions: [{ type: 'shell', command: 'echo' }] },
    { actions: [{ type: 'command', command: 'echo', args: [2] }] },
    { actions: [{ type: 'pi', prompt: 'hi', cwd: 'relative' }] },
    { actions: [{ type: 'command', command: 'echo', args: [], extra: true }] },
    { maxRetries: 6 }, { historyLimit: 0 }, { historyLimit: 1001 }, { maxRetries: 5, retryIntervalSeconds: 12, schedule: '* * * * *' }, { maxRetries: 1.5 }, { retryIntervalSeconds: 0 }, { retryIntervalSeconds: '60' },
    { name: 'x'.repeat(121) }, { unknown: true }
  ]) assert.throws(() => parseAutomationDraft(JSON.stringify({ ...base, ...patch })));
  assert.equal(parseAutomationDraft(JSON.stringify({ ...base, schedule: '30 3,6,9 * * 1-5', maxRetries: 2, retryIntervalSeconds: 60 })).maxRetries, 2);
});
test('default page size is ten and default retry delay fits a minutely schedule', () => {
  assert.equal(pageItems(Array.from({ length: 30 }, (_, i) => i), 1).items.length, 10);
  assert.equal(parseAutomationDraft(JSON.stringify({ ...automationDraft(), maxRetries: 5, schedule: '* * * * *', historyLimit: 30 })).maxRetries, 5);
});
test('pagination clamps after filters and handles empty lists', () => {
  assert.deepEqual(pageItems([1, 2, 3], 8, 2), { items: [3], page: 2, pages: 2, total: 3 });
  assert.equal(pageItems([], 5).page, 1);
  assert.equal(pageItems([1], -1).page, 1);
});
test('schedule and duration labels stay honest', () => {
  assert.equal(automationSchedule('0 2,5,8 * * 1-5'), 'Weekdays at 02:00, 05:00, 08:00 UTC');
  assert.equal(automationSchedule('*/7 2 * * *'), 'Custom schedule · UTC');
  assert.equal(automationDuration(100, 165), '1m 5s');
});
test('phase parsing preserves code fences and splits daemon output', () => {
  const result = resultSections('[precondition]\nOK\n[action]\n```text\n[post-action]\n```\n[post-action]\n## Review\n| PR | Status |');
  assert.equal(result.length, 3);
  assert.ok(result[1].content.includes('[post-action]'));
});
test('ADF uses an allowlist and preserves tables, marks and links', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }, { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'text', text: 'PR' }] }] }] }] };
  const output = adfHtml(doc);
  assert.ok(output.includes('&lt;script&gt;'));
  assert.ok(output.includes('<th>PR</th>'));
  assert.ok(!output.includes('href='));
  assert.equal(safeResultLink('data:text/html,hi'), null);
  assert.equal(structuredResult(JSON.stringify(doc))?.kind, 'adf');
  assert.equal(structuredResult('```json\n{"ok":true}\n```')?.kind, 'json');
  assert.equal(structuredResult('ordinary output'), null);
});

test('automation timestamps accept epoch seconds and milliseconds', () => {
  assert.equal(automationTime(1700000000), automationTime(1700000000000));
  assert.equal(automationTime(null), 'In progress');
});
