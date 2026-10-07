import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
// Resolve through Mermaid, so the test uses the implementation its core entry loads.
const mermaidRequire = createRequire(require.resolve('mermaid'));
const katex = mermaidRequire('katex');

test('Mermaid resolves patched KaTeX and inherited prototype trust cannot enable HTML commands', () => {
  const [major, minor, patch] = katex.version.split('.').map(Number);
  assert.ok(major > 0 || minor > 18 || (minor === 18 && patch >= 2), katex.version);
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'trust');
  Object.defineProperty(Object.prototype, 'trust', { value: true, writable: true, configurable: true });
  try {
    const html = katex.renderToString('\\htmlClass{audit-marker}{x}', { throwOnError: false });
    assert.doesNotMatch(html, /class="[^"]*\baudit-marker\b/);
    const explicitlyTrusted = katex.renderToString('\\htmlClass{audit-marker}{x}', { trust: true });
    assert.match(explicitlyTrusted, /class="[^"]*\baudit-marker\b/);
  } finally {
    if (descriptor) Object.defineProperty(Object.prototype, 'trust', descriptor);
    else Reflect.deleteProperty(Object.prototype, 'trust');
  }
});
