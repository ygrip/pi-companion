import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, WorkspaceConnectionError, unreachableMessage, workspaceRequest } from '../ui/src/lib/workspace-connection.ts';

const originalFetch = globalThis.fetch;
async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = originalFetch; }
}

test('workspace requests return JSON/204 and never cache API responses', async () => {
  await withFetch(async (_path, init) => {
    assert.equal(init?.cache, 'no-store');
    assert.ok(init?.signal);
    return Response.json({ sessions: [] });
  }, async () => { assert.deepEqual(await workspaceRequest('/api/sessions'), { sessions: [] }); });
  await withFetch(async () => new Response(null, { status: 204 }), async () => {
    assert.equal(await workspaceRequest('/api/sessions/a', { method: 'DELETE' }), undefined);
  });
});

test('file downloads return exact blob bytes and reject non-attachment proxy pages', async () => {
  await withFetch(async (_path, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer device-token');
    return new Response('file bytes', { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="example.txt"' } });
  }, async () => {
    const blob = await workspaceRequest<Blob>('/api/sessions/a/files/id', { headers: { authorization: 'Bearer device-token' } }, 1000, 'blob');
    assert.equal(await blob.text(), 'file bytes');
  });
  await withFetch(async () => new Response('<html>portal</html>', { headers: { 'content-type': 'text/html' } }), async () => {
    await assert.rejects(workspaceRequest('/api/sessions/a/files/id', {}, 1000, 'blob'), /did not return a file download/);
  });
});

test('closed tunnel and gateway responses produce readable errors rather than proxy HTML', async () => {
  for (const status of [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]) {
    await withFetch(async () => new Response('<html>Cloudflare secret diagnostic</html>', {
      status, headers: { 'content-type': 'text/html' }
    }), async () => {
      await assert.rejects(workspaceRequest('/api/context'), (error: unknown) => {
        assert.ok(error instanceof WorkspaceConnectionError);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.match(error.message, /tunnel/);
        assert.doesNotMatch(error.message, /<html>|secret diagnostic/);
        return true;
      });
    });
  }
});

test('DNS/network failure and offline messages do not falsely assert tunnel closure', async () => {
  await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
    await assert.rejects(workspaceRequest('/api/context'), /Cannot reach your workspace.*may be closed/);
  });
  assert.match(unreachableMessage(false), /device is offline/);
});

test('stale tunnel URL, captive portal and malformed JSON are actionable', async () => {
  for (const [body, type, expected] of [
    ['<html>portal</html>', 'text/html', /current Pi Companion URL/],
    ['not json', 'application/json', /unreadable response/]
  ] as const) {
    await withFetch(async () => new Response(body, { headers: { 'content-type': type } }), async () => {
      await assert.rejects(workspaceRequest('/api/context'), expected);
    });
  }
});

test('authorization and ordinary API errors retain status without displaying HTML', async () => {
  for (const status of [401, 403, 404, 409]) {
    await withFetch(async () => new Response('Only ended sessions can be archived.', { status }), async () => {
      await assert.rejects(workspaceRequest('/api/sessions/a'), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, status);
        assert.match(error.message, /ended sessions/);
        return true;
      });
    });
  }
  await withFetch(async () => new Response('<html>proxy access denied</html>', { status: 403 }), async () => {
    await assert.rejects(workspaceRequest('/api/sessions'), /workspace rejected this request \(HTTP 403\)/);
  });
});

test('timeouts are bounded and caller cancellation is not mislabeled as a tunnel failure', async () => {
  const slowFetch: typeof fetch = async (_path, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('test fetch should have been aborted')), 1000);
    init!.signal!.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(init!.signal!.reason);
    }, { once: true });
  });
  await withFetch(slowFetch, async () => {
    await assert.rejects(workspaceRequest('/api/context', {}, 5), /did not respond in time/);
    const controller = new AbortController();
    const pending = workspaceRequest('/api/context', { signal: controller.signal });
    controller.abort(new DOMException('Cancelled by caller', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError', message: 'Cancelled by caller' });
  });
});
