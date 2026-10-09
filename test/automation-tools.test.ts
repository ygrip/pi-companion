import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { automationTool, executeAutomation, type AutomationDefinition } from '../src/automation.ts';

const definition: AutomationDefinition = {
  name: 'Verify repo', enabled: true, schedule: null, preconditions: [],
  actions: [{ type: 'command', command: 'git', args: ['status', '--short'] }], postActions: [],
  maxRetries: 2, retryIntervalSeconds: 30
};

test('automation tool maps every action to the admin API and preserves argv', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.PI_COMPANION_URL;
  process.env.PI_COMPANION_URL = 'ws://127.0.0.1:43721';
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ...definition, id: 'id', createdAt: 1, updatedAt: 2 }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await executeAutomation({ action: 'list' });
    await executeAutomation({ action: 'create', automation: definition });
    await executeAutomation({ action: 'update', id: 'a/b', automation: definition });
    await executeAutomation({ action: 'disable', id: 'id' });
    assert.deepEqual(calls.at(-1)?.body, { ...definition, enabled: false });
    await executeAutomation({ action: 'enable', id: 'id' });
    assert.deepEqual(calls.at(-1)?.body, definition);
    for (const action of ['get', 'delete', 'start', 'stop', 'runs'] as const) await executeAutomation({ action, id: 'id' });
    await executeAutomation({ action: 'run', id: 'id', runId: 'run/id' });
    assert.equal(calls[0].url, 'http://127.0.0.1:43721/api/automations');
    assert.equal(calls[1].method, 'POST');
    assert.deepEqual(calls[1].body, definition);
    assert.equal(calls[2].url, 'http://127.0.0.1:43721/api/automations/a%2Fb');
    assert.equal(calls.at(-1)?.url, 'http://127.0.0.1:43721/api/automations/id/runs/run%2Fid');
    assert.ok(calls.some(call => call.method === 'DELETE'));
    const count = calls.length;
    await assert.rejects(executeAutomation({ action: 'run', id: 'id' }), /runId/);
    await assert.rejects(executeAutomation({ action: 'update', id: 'id' }), /complete automation/);
    await assert.rejects(executeAutomation({ action: 'get' }), /requires id/);
    assert.equal(calls.length, count);
    process.env.PI_COMPANION_URL = 'wss://example.com';
    await assert.rejects(executeAutomation({ action: 'list' }), /local Companion admin/);
    assert.equal(calls.length, count);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.PI_COMPANION_URL; else process.env.PI_COMPANION_URL = originalUrl;
  }
});

test('API failures and no-content responses are explicit', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('Automation is already running', { status: 409 });
    await assert.rejects(executeAutomation({ action: 'start', id: 'id' }), /409: Automation is already running/);
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.deepEqual(await executeAutomation({ action: 'delete', id: 'id' }), { ok: true });
  } finally { globalThis.fetch = original; }
});

test('stdio MCP initializes and exposes the same tool without contacting or launching daemon', async () => {
  const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', new URL('../src/automation-mcp.ts', import.meta.url).pathname], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_COMPANION_URL: 'ws://127.0.0.1:1' }
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  child.stdin.end([
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    '{"jsonrpc":"2.0","id":3,"method":"unknown"}',
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"missing","arguments":{}}}',
    'invalid json', ''
  ].join('\n'));
  assert.equal(await exited, 0, stderr);
  const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.length, 5);
  assert.equal(messages[0].result.protocolVersion, '2024-11-05');
  assert.deepEqual(messages[1].result.tools, [automationTool]);
  assert.equal(messages[2].error.code, -32601);
  assert.equal(messages[3].error.code, -32602);
  assert.equal(messages[4].error.code, -32700);
});
