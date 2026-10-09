import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { isShellTool, shellLabel, shellPreview } from '../ui/src/lib/shell-activity.ts';

test('shell tools include namespaced bash and background shell operations', () => {
  for (const name of ['bash', 'functions.bash', 'jar_shell', 'functions.jar_shell', 'shell']) assert.equal(isShellTool(name), true);
  for (const name of ['read', 'bash_script_reader', 'oslog_search_logs']) assert.equal(isShellTool(name), false);
});
test('labels are brief and describe actual status without claiming semantic success', () => {
  assert.equal(shellLabel({ command: 'npm test' }, 'running'), 'Running checks');
  assert.equal(shellLabel({ command: 'cargo build --locked' }, 'ok'), 'Finished build');
  assert.equal(shellLabel({ command: 'npm test' }, 'error'), 'Failed: checks');
  assert.equal(shellLabel({ command: 'npm test; dangerous-other-work' }, 'ok'), 'Shell command finished');
  assert.equal(shellLabel({ command: 'some complicated script\nwith more lines' }, 'running'), 'Running shell command');
  assert.equal(shellLabel({ action: 'output', id: 's1' }, 'ok'), 'Shell output');
  assert.equal(shellLabel({ name: 'release verification', command: 'long\nscript' }, 'running'), 'Running release verification');
});
test('session feed separates user messages from output and keeps script details collapsed', () => {
  const source = readFileSync(new URL('../ui/src/routes/sessions/[id]/+page.svelte', import.meta.url), 'utf8');
  assert.match(source, /class="speaker">You/);
  assert.match(source, /class="user-message"/);
  assert.match(source, /\.line\.user\s*\{[^}]*border-left: 4px/s);
  assert.match(source, /<details class="shell-script">/);
  assert.ok(source.indexOf('aria-label="Shell output preview"') < source.indexOf('<details class="shell-script">'));
});

test('output preview prioritizes tail diagnostics and retains short output', () => {
  assert.deepEqual(shellPreview('All checks passed\n'), { text: 'All checks passed', truncated: false, lines: 1 });
  const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  const preview = shellPreview(output);
  assert.equal(preview.truncated, true); assert.equal(preview.lines, 20);
  assert.equal(preview.text.split('\n').length, 8); assert.ok(preview.text.endsWith('line 20'));
  assert.ok(!preview.text.includes('line 1\n'));
  assert.equal(shellPreview('x'.repeat(10000)).text.length, 300);
  assert.equal(shellPreview('\u001b[31mFailed\u001b[0m').text, 'Failed');
  assert.equal(shellPreview('').text, '');
});
