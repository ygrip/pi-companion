import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compileModule } from 'svelte/compiler';
import ts from 'typescript';

const dataModule = (source: string) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
function runeModule(path: string, suffix = '') {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8') + suffix, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  return compileModule(source, { filename: path, generate: 'client' }).js.code
    .replaceAll("'svelte/internal/client'", JSON.stringify(import.meta.resolve('svelte/internal/client')));
}
const toast = dataModule(runeModule('../ui/src/lib/toast.svelte.ts'));
const source = runeModule('../ui/src/lib/companion.svelte.ts', '\nexport { Companion };')
  .replaceAll("'./connection.ts'", JSON.stringify(new URL('../ui/src/lib/connection.ts', import.meta.url).href))
  .replaceAll("'./activity.ts'", JSON.stringify(new URL('../ui/src/lib/activity.ts', import.meta.url).href))
  .replaceAll("'./format.ts'", JSON.stringify(new URL('../ui/src/lib/format.ts', import.meta.url).href))
  .replaceAll("'./usage.ts'", JSON.stringify(new URL('../ui/src/lib/usage.ts', import.meta.url).href))
  .replaceAll("'./workspace-connection.ts'", JSON.stringify(new URL('../ui/src/lib/workspace-connection.ts', import.meta.url).href))
  .replaceAll("'./toast.svelte.ts'", JSON.stringify(toast));

test('actual connection store preserves pairing/drafts safety and handles recovery, stale sockets and revocation', async () => {
  const keys = ['navigator', 'location', 'localStorage', 'WebSocket', 'fetch', 'setTimeout', 'clearTimeout'] as const;
  const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const storage = new Map([['piCompanionDeviceToken', 'device-token']]);
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let fail = true;
  let acceptUpload = false;
  let uploadPosts = 0;
  const acceptedFile = { id: 'upload-one', name: 'note.txt', path: '/tmp/session/upload-one', size: 4, mime: 'text/plain', createdAt: '2026-10-07T12:00:00Z' };
  const savedUsage = { id: 'archived', status: 'stopped', remoteEnabled: true, telemetry: { providers: [{ provider: 'openai-codex', updatedAt: '2026-10-07T12:00:00Z', weekly: { usedPercent: 16 } }] } };
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onclose?: (event: { code: number }) => void;
    onmessage?: (event: { data: string }) => void;
    frames: string[] = [];
    constructor() { sockets.push(this); }
    close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
    send(data: string) { this.frames.push(data); }
    open() { this.readyState = 1; this.onopen?.(); }
  }
  const globals = {
    navigator: { onLine: true }, location: { protocol: 'https:', host: 'workspace.example' },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    WebSocket: FakeSocket,
    fetch: async (path: string, init?: RequestInit) => {
      if (path === '/api/pairing/claim') return new Response('Invalid invitation code', { status: 401 });
      if (acceptUpload && init?.method === 'POST' && path.endsWith('/files')) { uploadPosts++; return Response.json(acceptedFile); }
      if (fail) return new Response('<html>tunnel down</html>', { status: 530 });
      if (path === '/api/context') return Response.json({ remote: true, version: '0.2.2' });
      return Response.json({ sessions: [], devices: [], usageSnapshots: [savedUsage] });
    },
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id)
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    const { Companion } = await import(dataModule(source));
    const store = new Companion();
    await store.boot();
    assert.match(store.bootError, /HTTP 530/);
    assert.equal(store.connection, 'offline');
    assert.equal(storage.get('piCompanionDeviceToken'), 'device-token');
    assert.equal(sockets.length, 0);
    fail = false;
    store.reconnect();
    await tick();
    sockets[0].open();
    await tick();
    assert.equal(store.connection, 'online');
    assert.equal(store.connectionError, '');
    assert.equal(store.token, 'device-token');
    assert.equal(store.sessions.length, 0);
    assert.equal(store.usageSnapshots[0].telemetry.providers[0].weekly.usedPercent, 16, 'saved reports hydrate without any live sessions');

    fail = true;
    sockets[0].close(1011);
    await tick();
    assert.match(store.connectionError, /HTTP 530/);
    assert.equal(store.prompt('session', 'keep this draft', false), false);
    assert.equal(sockets[0].frames.length, 0);
    assert.equal(storage.get('piCompanionDeviceToken'), 'device-token');
    fail = false;
    store.reconnect();
    await tick();
    const replacement = sockets.at(-1)!;
    sockets[0].onopen?.(); // Late event from old socket must not mark the new one online.
    assert.equal(store.connection, 'connecting');
    replacement.open();
    await tick();
    assert.equal(store.connection, 'online');
    replacement.onmessage?.({ data: JSON.stringify({ type: 'session.register', session: { id: 'workspace', remoteEnabled: true, status: 'idle' } }) });
    assert.equal(store.requestDiff('workspace', false), true, 'first request has no previous diff');
    const first = JSON.parse(replacement.frames.at(-1)!).command.requestId;
    assert.equal(store.requestDiff('workspace', true, '/repo/worktree'), true);
    const second = JSON.parse(replacement.frames.at(-1)!).command.requestId;
    const diffReply = (requestId: string, diff: string) => replacement.onmessage?.({ data: JSON.stringify({ type: 'bridge.event', sessionId: 'workspace', message: { type: 'git.diff', requestId, staged: true, diff, worktree: '/repo/worktree' } }) });
    diffReply(first, 'old response');
    assert.equal(store.diffs.workspace.loading, true, 'superseded responses cannot replace the current selection');
    diffReply(second, 'current response');
    assert.equal(store.diffs.workspace.text, 'current response');
    assert.equal(store.diffs.workspace.loading, false);
    replacement.onmessage?.({ data: JSON.stringify({ type: 'session.update', sessionId: 'archived', patch: { remoteEnabled: false } }) });
    assert.equal(store.usageSnapshots.length, 0, 'revocation removes cached reports even if the session is no longer live');

    await assert.rejects(store.claim({ code: 'bad-code' }, 'Phone'), /Invalid invitation/);
    assert.equal(storage.get('piCompanionDeviceToken'), 'device-token', 'bad invite is not credential revocation');
    acceptUpload = true;
    fail = true; // POST succeeds, but the following files refresh loses the tunnel.
    const uploaded = await store.upload('session', new File(['note'], 'note.txt', { type: 'text/plain' }));
    await tick();
    assert.equal(uploaded.id, 'upload-one');
    assert.equal(store.files.session[0].id, 'upload-one');
    assert.equal(uploadPosts, 1, 'accepted uploads are not repeated after a failed refresh');
    fail = false;
    store.reconnect();
    sockets.at(-1)!.open();
    await tick();
    sockets.at(-1)!.close(4001);
    assert.equal(store.connection, 'disconnected');
    assert.equal(timers.size, 0, 'computer disconnect must not leave auto-retry timers');
    store.reconnect();
    sockets.at(-1)!.open();
    await tick();
    sockets.at(-1)!.close(4003);
    assert.equal(store.connection, 'revoked');
    assert.equal(store.usageSnapshots.length, 0);
    assert.equal(storage.has('piCompanionDeviceToken'), false);
    assert.equal(timers.size, 0);
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
