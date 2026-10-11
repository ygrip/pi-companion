import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanInferredTitle, heuristicTitle, inferTitle, needsInference } from '../src/title.ts';

test('short prompts stay recognisable; long prompts become a short clause', () => {
  assert.equal(heuristicTitle('Fix login\n  redirect handling'), 'Fix login redirect handling');
  assert.equal(heuristicTitle('review authorization flow.'), 'Review authorization flow');
  const long = 'reindex with codebase memory, i want the session shell message brevity, aim for user centric and human easiness to read the shell streaming rendered on the companion session';
  const title = heuristicTitle(long);
  assert.ok(title.length <= 61, title);
  assert.ok(title.startsWith('Reindex with codebase memory'));
  assert.equal(heuristicTitle('```\ncode only\n```'), '');
  assert.equal(needsInference(long), true);
  assert.equal(needsInference('Fix login redirect handling'), false);
});

test('inferred titles are cleaned to a single short line', () => {
  assert.equal(cleanInferredTitle('Title: "Concise shell activity feed".\n'), 'Concise shell activity feed');
  assert.equal(cleanInferredTitle('x'.repeat(200)), '');
  assert.equal(cleanInferredTitle(''), '');
});

test('inference uses the session model and fails closed', async () => {
  const model = { id: 'm' };
  const ok = { model, modelRegistry: { hasConfiguredAuth: () => true, complete: async () => ({ content: [{ type: 'text', text: 'Readable session titles' }] }) } };
  assert.equal(await inferTitle(ok as any, 'make titles readable please'), 'Readable session titles');
  const broken = { model, modelRegistry: { hasConfiguredAuth: () => true, complete: async () => { throw new Error('down'); } } };
  assert.equal(await inferTitle(broken as any, 'x'), '');
  const noAuth = { model, modelRegistry: { hasConfiguredAuth: () => false, complete: async () => ({ content: [] }) } };
  assert.equal(await inferTitle(noAuth as any, 'x'), '');
  assert.equal(await inferTitle({} as any, 'x'), '');
});
