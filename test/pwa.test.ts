import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url));

test('manifest supports standalone installation without pairing credentials in its URLs', () => {
  const manifest = JSON.parse(read('../ui/static/manifest.webmanifest').toString());
  assert.equal(manifest.name, 'Pi Companion');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/sessions');
  assert.equal(manifest.prefer_related_applications, false);
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((icon: { sizes: string }) => icon.sizes === `${size}x${size}`);
    assert.ok(icon);
    assert.equal(icon.type, 'image/png');
    const png = read(`../ui/static${icon.src}`);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test('every route inherits the manifest and iOS standalone metadata', () => {
  const html = read('../ui/src/app.html').toString();
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /rel="apple-touch-icon"/);
});
