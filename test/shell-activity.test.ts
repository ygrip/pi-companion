import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { isShellTool, shellLabel, shellPreview, shellSummary } from '../ui/src/lib/shell-activity.ts';

test('shell tools include namespaced bash and background shell operations', () => {
  for (const name of ['bash', 'functions.bash', 'jar_shell', 'functions.jar_shell', 'shell']) assert.equal(isShellTool(name), true);
  for (const name of ['read', 'bash_script_reader', 'oslog_search_logs']) assert.equal(isShellTool(name), false);
});
test('labels are one human line describing the command, never the raw script', () => {
  assert.equal(shellLabel({ command: 'npm test' }, 'running'), 'Run tests');
  assert.equal(shellLabel({ command: 'cargo build --locked' }, 'ok'), 'Build (Rust)');
  assert.equal(shellLabel({ command: 'cd /repo && git status --short | head' }), 'Check git status');
  assert.equal(shellLabel({ command: 'cd x && git add -A && git commit -m "y" && git push && git push --tags' }), 'Stage changes, Commit changes +1 more');
  assert.equal(shellLabel({ command: 'FOO=1 npx tsc --noEmit 2>&1 | tail -20' }), 'Type-check');
  assert.equal(shellLabel({ command: 'npm run ui:check' }), 'Run checks (ui)');
  assert.equal(shellLabel({ command: 'python3 - <<EOF\nprint(1)\nEOF' }).startsWith('Run'), true);
  assert.equal(shellLabel({ action: 'output', id: 's1' }, 'ok'), 'Read shell output');
  assert.equal(shellLabel({ name: 'release verification', command: 'long\nscript' }, 'running'), 'Release verification');
  assert.equal(shellLabel({ description: 'List installed packages', command: 'ls node_modules' }), 'List installed packages');
  assert.equal(shellLabel({}), 'Shell command');
  assert.ok(shellSummary('x'.repeat(500)).length <= 90);
});
test('session feed separates user messages and hides raw shell scripts behind a summary', () => {
  const source = readFileSync(new URL('../ui/src/routes/sessions/[id]/+page.svelte', import.meta.url), 'utf8');
  assert.match(source, /class="speaker">You/);
  assert.match(source, /class="user-message"/);
  assert.match(source, /\.line\.user\s*\{[^}]*border-left: 4px/s);
  assert.doesNotMatch(source, /<details class="shell-script">/);
  assert.match(source, /aria-label="Shell output preview"/);
});
test('thinking renders markdown with a live animated state', () => {
  const source = readFileSync(new URL('../ui/src/routes/sessions/[id]/+page.svelte', import.meta.url), 'utf8');
  assert.match(source, /class="md thought-body"[^>]*>\{@html renderMarkdown\(entry\.body\)\}/);
  assert.match(source, /class="thought-label shimmer"/);
  assert.match(source, /@keyframes shimmer/);
  assert.match(source, /prefers-reduced-motion: reduce/);
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
