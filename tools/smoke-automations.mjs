// Run after cargo build + ui:build. Uses isolated state and disposable loopback ports.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  return { port, close: () => new Promise(resolve => server.close(resolve)) };
}
const admin = await reservePort(), device = await reservePort();
const home = await mkdtemp(join(tmpdir(), 'companion-automation-smoke-'));
await admin.close(); await device.close();
const daemon = spawn('server/target/debug/pi-companion-server' + (process.platform === 'win32' ? '.exe' : ''), [], {
  env: { ...process.env, PI_COMPANION_HOME: home, PI_COMPANION_ADMIN_ADDR: `127.0.0.1:${admin.port}`, PI_COMPANION_DEVICE_ADDR: `127.0.0.1:${device.port}` },
  stdio: ['ignore', 'pipe', 'pipe']
});
const exited = new Promise((resolve, reject) => { daemon.once('error', reject); daemon.once('exit', resolve); });
let log = '';
daemon.stdout.on('data', chunk => { log += chunk; });
daemon.stderr.on('data', chunk => { log += chunk; });
const base = `http://127.0.0.1:${admin.port}`;
const request = (path, init) => fetch(base + path, { ...init, signal: AbortSignal.timeout(5000) });
try {
  await Promise.race([
    (async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(base + '/api/context', { signal: AbortSignal.timeout(300) });
          if (response.ok && (await response.json()).pid === daemon.pid) return;
        } catch { /* The owned listener has not started yet. */ }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Daemon startup timed out: ' + log);
    })(),
    exited.then(code => { throw new Error(`Daemon exited before readiness (${code}): ${log}`); })
  ]);
  assert.equal((await (await request('/api/context')).json()).version, '0.3.0');
  for (const path of ['/automations', '/automations/example', '/automations/example/runs/run']) {
    const response = await request(path);
    assert.equal(response.status, 200); assert.match(await response.text(), /<!doctype html>/i);
  }
  let response = await request('/api/automations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    name: 'Release smoke', enabled: true, schedule: null, preconditions: [],
    actions: [{ type: 'command', command: process.execPath, args: ['-e', 'console.log("release smoke")'] }], postActions: []
  }) });
  assert.equal(response.status, 200); const definition = await response.json();
  response = await request(`/api/automations/${definition.id}/start`, { method: 'POST' });
  assert.equal(response.status, 200); const run = await response.json();
  let result;
  for (let i = 0; i < 100; i++) {
    result = await (await request(`/api/automations/${definition.id}/runs/${run.id}`)).json();
    if (result.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(result.status, 'succeeded'); assert.match(result.result, /release smoke/);
  assert.equal((await fetch(`http://127.0.0.1:${device.port}/api/automations`, { signal: AbortSignal.timeout(5000) })).status, 401);
  response = await request('/api/shutdown', { method: 'POST' });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  let timer;
  try {
    assert.equal(await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Shutdown timed out: ' + log)), 5000); })]), 0);
  } finally { clearTimeout(timer); }
  console.log('Daemon HTTP smoke passed: routes, version, create/start/history, authentication, shutdown.');
} finally {
  daemon.kill();
  await exited;
  await rm(home, { recursive: true, force: true });
}
