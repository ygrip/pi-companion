import test from 'node:test';
import assert from 'node:assert/strict';
import { isPageAssetError, pageError } from '../ui/src/lib/page-error.ts';

test('page errors give status-specific recovery instructions', () => {
  assert.equal(pageError(404).title, 'Page not found');
  assert.match(pageError(404).message, /Open Overview/);
  assert.equal(pageError(403).title, 'Access unavailable');
  assert.match(pageError(403).message, /permission/);
  assert.deepEqual(pageError(401), pageError(403));
  assert.equal(pageError(500).title, 'Could not open this page');
  assert.match(pageError(500).message, /Reload/);
  assert.deepEqual(pageError(503), pageError(500));
  assert.equal(pageError(400).title, 'Page unavailable');
});

test('page download failures identify Chrome, Firefox, Safari and CSS load errors', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: https://example.test/private.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Unable to preload CSS for /_app/immutable/example.css'
  ]) assert.equal(isPageAssetError(new TypeError(message)), true);
  assert.equal(isPageAssetError(new Error('Cannot read properties of undefined')), false);
  assert.equal(isPageAssetError(null), false);
  assert.match(pageError(500, 'Page assets unavailable').message, /connection/);
});

test('raw exceptions are never displayed in error copy', () => {
  assert.deepEqual(pageError(500, 'secret token and internal stack trace'), pageError(500));
});
