import test from 'node:test';
import assert from 'node:assert/strict';
import { automationDraft, automationTime, parseAutomationDraft } from './src/lib/automations.ts';

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
test('automation timestamps accept epoch seconds and milliseconds', () => {
  assert.equal(automationTime(1700000000), automationTime(1700000000000));
  assert.equal(automationTime(null), 'In progress');
});
