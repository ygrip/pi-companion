import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleURL = (source: string) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');

test('live spawn-lock owners are not evicted during long downloads; dead owners can be recovered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-lock-test-'));
  const source = (await readFile(new URL('../src/daemon.ts', import.meta.url), 'utf8'))
    .replace('const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");', `const PACKAGE_ROOT = ${JSON.stringify(dir)};`)
    .replace('join(tmpdir(), "pi-companion-spawn.lock")', `join(${JSON.stringify(dir)}, "lock")`)
    .replace('async function acquireLock()', 'export async function acquireLock()');
  const js = (await import('typescript')).default.transpileModule(source, { compilerOptions: { module: 99, target: 99 } }).outputText;
  const daemon = await import(moduleURL(js));
  const lock = join(dir, 'lock');
  try {
    const release = await daemon.acquireLock();
    assert.equal(typeof release, 'function');
    const old = new Date(Date.now() - 180_000);
    await utimes(lock, old, old);
    assert.equal(await daemon.acquireLock(), null, 'age must not steal a live owner');
    await release();
    await writeFile(lock, 'not-a-pid');
    await utimes(lock, old, old);
    const recovered = await daemon.acquireLock();
    assert.equal(typeof recovered, 'function');
    await recovered();
    assert.equal(daemon.versionAtLeast('0.3.6', '0.3.5'), true);
    assert.equal(daemon.versionAtLeast('0.3.4', '0.3.5'), false);
    assert.equal(daemon.versionAtLeast('unknown', '0.3.5'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed replacement preparation leaves the running daemon untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-upgrade-test-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const source = (await readFile(new URL('../src/daemon.ts', import.meta.url), 'utf8'))
    .replace('const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");', `const PACKAGE_ROOT = ${JSON.stringify(dir)};`)
    .replace('join(tmpdir(), "pi-companion-spawn.lock")', `join(${JSON.stringify(dir)}, "lock")`)
    .replace('const binary = await resolveDaemonBinary(log);', `const binary = await Promise.reject(new Error('download failed'));`);
  const js = (await import('typescript')).default.transpileModule(source, { compilerOptions: { module: 99, target: 99 } }).outputText;
  const previousFetch = globalThis.fetch;
  const previousAutostart = process.env.PI_COMPANION_AUTOSTART;
  const previousURL = process.env.PI_COMPANION_URL;
  const requests: string[] = [];
  const logs: string[] = [];
  process.env.PI_COMPANION_AUTOSTART = '1';
  process.env.PI_COMPANION_URL = 'ws://127.0.0.1:43721';
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ version: '1.0.0', pid: process.pid }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const daemon = await import(moduleURL(js));
    assert.equal(await daemon.ensureDaemon((message: string) => logs.push(message)), false);
    assert.ok(logs.some(line => line.includes('download failed')));
    assert.equal(requests.some(url => url.includes('/api/shutdown')), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAutostart === undefined) delete process.env.PI_COMPANION_AUTOSTART; else process.env.PI_COMPANION_AUTOSTART = previousAutostart;
    if (previousURL === undefined) delete process.env.PI_COMPANION_URL; else process.env.PI_COMPANION_URL = previousURL;
    await rm(dir, { recursive: true, force: true });
  }
});

test('background services use one fixed identity and a restart supervisor on each supported OS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-service-test-'));
  const calls: { name: string; args: string[] }[] = [];
  (globalThis as any).__serviceTest = { calls };
  const childModule = moduleURL(`export function execFile(name,args,opts,callback) { globalThis.__serviceTest.calls.push({name,args}); callback(null, {stdout:'',stderr:''}); }`);
  const original = await readFile(new URL('../src/background-service.ts', import.meta.url), 'utf8');
  const oldUsername = process.env.USERNAME;
  const oldDomain = process.env.USERDOMAIN;
  process.env.USERNAME = 'TestUser'; process.env.USERDOMAIN = 'TEST';
  try {
    for (const platform of ['darwin', 'linux', 'win32']) {
      calls.length = 0;
      const home = join(dir, platform);
      const source = original.replace("from 'node:child_process'", `from ${JSON.stringify(childModule)}`)
        .replace('process.env.PI_COMPANION_HOME ?? join(homedir(),', `undefined ?? join(homedir(),`)
        .replace("import { homedir } from 'node:os';", `const homedir = () => ${JSON.stringify(home)};`)
        .replaceAll('process.platform', JSON.stringify(platform));
      const js = (await import('typescript')).default.transpileModule(source, { compilerOptions: { module: 99, target: 99 } }).outputText;
      const service = await import(moduleURL(js));
      await service.startBackgroundService('/verified/daemon');
      await service.startBackgroundService('/verified/new-daemon');
      const config = JSON.parse(await readFile(join(home, '.pi', 'agent', 'pi-companion', 'service', 'daemon.json'), 'utf8'));
      assert.equal(config.binary, '/verified/new-daemon');
      const script = await readFile(join(home, '.pi', 'agent', 'pi-companion', 'service', 'supervisor.mjs'), 'utf8');
      assert.match(script, /child.once\('exit', retry\)/);
      assert.match(script, /readFileSync/);
      if (platform === 'darwin') assert.ok(calls.some(c => c.name === 'launchctl' && c.args.includes('gui/' + process.getuid!() + '/dev.pi-companion.daemon')));
      if (platform === 'linux') assert.ok(calls.some(c => c.name === 'systemctl' && c.args.join(' ') === '--user enable --now pi-companion.service'));
      if (platform === 'win32') {
        assert.ok(calls.some(c => c.name === 'schtasks' && c.args.includes('Pi Companion')));
        const xml = await readFile(join(home, '.pi', 'agent', 'pi-companion', 'service', 'task.xml'), 'utf16le');
        assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew/);
        assert.match(xml, /<ExecutionTimeLimit>PT0S/);
        assert.match(xml, /<RunLevel>LeastPrivilege/);
      }
    }
  } finally {
    if (oldUsername === undefined) delete process.env.USERNAME; else process.env.USERNAME = oldUsername;
    if (oldDomain === undefined) delete process.env.USERDOMAIN; else process.env.USERDOMAIN = oldDomain;
    delete (globalThis as any).__serviceTest; await rm(dir, { recursive: true, force: true });
  }
});
