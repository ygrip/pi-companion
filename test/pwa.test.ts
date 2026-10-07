import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const staticDir = new URL('../ui/static/', import.meta.url);
const worker = readFileSync(new URL('service-worker.js', staticDir), 'utf8');

function harness(online = true, status = 200) {
  const handlers: Record<string, (event: any) => void> = {};
  const writes: string[] = [];
  const removed: string[] = [];
  const shell = new Response('<html>public shell</html>');
  const cache = {
    addAll: async (urls: string[]) => { writes.push(...urls); },
    put: async (request: Request) => { writes.push(request.url); }
  };
  runInNewContext(worker, {
    self: {
      location: { origin: 'https://companion.example' },
      addEventListener: (name: string, handler: (event: any) => void) => { handlers[name] = handler; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} }
    },
    caches: {
      open: async () => cache,
      keys: async () => ['pi-companion-shell-v2', 'other-app'],
      delete: async (key: string) => { removed.push(key); },
      match: async (request: string) => request === '/' ? shell.clone() : undefined
    },
    fetch: async () => {
      if (!online) throw new Error('offline');
      return new Response('network', { status });
    },
    URL, Response
  });
  return { handlers, writes, removed };
}

test('manifest exposes real 192px, 512px and maskable PNG install icons', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', staticDir), 'utf8'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  for (const [size, purpose] of [[192, 'any'], [512, 'any'], [512, 'maskable']] as const) {
    const icon = manifest.icons.find((i: any) => i.sizes === `${size}x${size}` && i.purpose === purpose);
    assert.ok(icon);
    const bytes = readFileSync(new URL(icon.src.slice(1), staticDir));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  for (const icon of manifest.icons) assert.ok(existsSync(new URL(icon.src.slice(1), staticDir)));
});

test('worker installs the public shell and removes only old Companion caches', async () => {
  const { handlers, writes, removed } = harness();
  let work: Promise<unknown>;
  handlers.install({ waitUntil: (p: Promise<unknown>) => { work = p; } });
  await work!;
  assert.ok(writes.includes('/'));
  assert.ok(writes.includes('/pwa-maskable-512.png'));
  for (const path of writes) assert.ok(path === '/' || existsSync(new URL(path.slice(1), staticDir)));
  handlers.activate({ waitUntil: (p: Promise<unknown>) => { work = p; } });
  await work!;
  assert.deepEqual(removed, ['pi-companion-shell-v2']);
});

test('worker never intercepts authenticated API, websocket, external or mutation requests', () => {
  const { handlers } = harness();
  for (const [path, method] of [['/api/sessions', 'GET'], ['/api/sessions/a/files/image.png', 'GET'], ['/ws/browser', 'GET'], ['https://external.example/app.js', 'GET'], ['/api/sessions/a', 'DELETE']]) {
    let intercepted = false;
    handlers.fetch({
      request: new Request(new URL(path, 'https://companion.example'), { method }),
      respondWith: () => { intercepted = true; }
    });
    assert.equal(intercepted, false, `${method} ${path}`);
  }
});

test('gateway navigation falls back to the public shell instead of replacing the app with proxy HTML', async () => {
  const { handlers } = harness(true, 530);
  let response: Promise<Response>;
  handlers.fetch({
    request: { url: 'https://companion.example/sessions/private', method: 'GET', mode: 'navigate' },
    respondWith: (p: Promise<Response>) => { response = p; }
  });
  assert.equal(await (await response!).text(), '<html>public shell</html>');
});

test('offline navigation falls back to public shell without caching session HTML', async () => {
  for (const online of [true, false]) {
    const { handlers, writes } = harness(online);
    let response: Promise<Response>;
    handlers.fetch({
      request: { url: 'https://companion.example/sessions/private', method: 'GET', mode: 'navigate' },
      respondWith: (p: Promise<Response>) => { response = p; }
    });
    assert.equal(await (await response!).text(), online ? 'network' : '<html>public shell</html>');
    assert.deepEqual(writes, []);
  }
});
