import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../ui/src/lib/device-permissions.svelte.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');

function harness(options: { secure?: boolean; allowed?: boolean; media?: boolean; acquire?: (constraints: unknown) => Promise<unknown> } = {}) {
  const calls: unknown[] = [];
  let stopped = 0;
  const sandbox: any = {
    $state: (value: unknown) => value,
    window: { isSecureContext: options.secure ?? true },
    document: {
      permissionsPolicy: { allowsFeature: () => options.allowed ?? true },
      addEventListener: () => {}
    },
    navigator: {
      userAgent: 'Desktop',
      mediaDevices: options.media === false ? undefined : {
        getUserMedia: async (constraints: unknown) => {
          calls.push(constraints);
          return options.acquire ? options.acquire(constraints) : { getTracks: () => [{ stop: () => stopped++ }] };
        }
      }
    },
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => null }
  };
  runInNewContext(compiled + '\nglobalThis.cameraHarness = { cameraAvailability, cameraFailure, openCameraStream, devicePermissions };', sandbox);
  return { api: sandbox.cameraHarness, calls, stopped: () => stopped };
}

test('camera detects insecure and policy-disabled pages without prompting', async () => {
  for (const [options, expected] of [[{ secure: false }, 'insecure'], [{ allowed: false }, 'policy'], [{ media: false }, 'unsupported']] as const) {
    const { api, calls } = harness(options);
    assert.equal(api.cameraAvailability(), expected);
    assert.equal(await api.devicePermissions.requestCamera(), expected);
    assert.equal(calls.length, 0);
  }
});

test('camera permission request releases every granted track', async () => {
  const { api, stopped } = harness();
  assert.equal(await api.devicePermissions.requestCamera(), 'granted');
  assert.equal(stopped(), 1);
  assert.equal(api.devicePermissions.cameraPending, false);
});

test('camera failures distinguish denial from policy and transient device errors', () => {
  const { api } = harness();
  for (const [name, expected] of [['NotAllowedError', 'denied'], ['SecurityError', 'policy'], ['NotReadableError', 'prompt'], ['AbortError', 'prompt'], ['NotFoundError', 'unsupported'], ['OverconstrainedError', 'prompt']]) {
    const failure = api.cameraFailure({ name });
    assert.equal(failure.state, expected, name);
    assert.match(failure.message, /pairing code/);
  }
  assert.equal(harness({ allowed: false }).api.cameraFailure({ name: 'NotAllowedError' }).state, 'policy');
});

test('busy camera remains retryable instead of being reported as browser denial', async () => {
  let attempt = 0;
  let released = false;
  const { api } = harness({ acquire: async () => {
    if (!attempt++) throw { name: 'NotReadableError' };
    return { getTracks: () => [{ stop: () => { released = true; } }] };
  } });
  assert.equal(await api.devicePermissions.requestCamera(), 'prompt');
  assert.match(api.devicePermissions.cameraError, /Close other apps/);
  assert.equal(await api.devicePermissions.requestCamera(), 'granted');
  assert.equal(api.devicePermissions.cameraError, '');
  assert.equal(released, true);
});

test('unsupported camera constraints fall back to any available camera', async () => {
  let attempt = 0;
  const { api, calls } = harness({ acquire: async () => {
    if (!attempt++) throw { name: 'OverconstrainedError' };
    return { getTracks: () => [] };
  } });
  assert.equal(await api.devicePermissions.requestCamera(), 'granted');
  assert.equal(calls.length, 2);
  assert.equal((calls[1] as { video: boolean }).video, true);
});

test('concurrent camera requests do not acquire duplicate streams', async () => {
  let release!: (stream: unknown) => void;
  const { api, calls } = harness({ acquire: () => new Promise(resolve => { release = resolve; }) });
  const pending = api.devicePermissions.requestCamera();
  assert.equal(api.devicePermissions.cameraPending, true);
  await api.devicePermissions.requestCamera();
  assert.equal(calls.length, 1);
  release({ getTracks: () => [] });
  assert.equal(await pending, 'granted');
});

test('closing the scanner releases a camera granted after dismissal', async () => {
  const page = readFileSync(new URL('../ui/src/routes/pair/+page.svelte', import.meta.url), 'utf8');
  const script = page.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
  const code = ts.transpileModule(script, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText.replace(/^import .*;\s*$/gm, '');
  let release!: (stream: unknown) => void;
  let released = 0;
  const sandbox: any = {
    $state: (value: unknown) => value,
    $derived: (value: unknown) => value,
    $effect: () => {},
    onMount: (fn: () => void) => fn(),
    onDestroy: () => {},
    page: { url: new URL('https://companion.example/pair') },
    navigator: { userAgent: 'Desktop' },
    cameraAvailability: () => 'prompt',
    devicePermissions: { init: () => {}, markCamera: () => {} },
    openCameraStream: () => new Promise(resolve => { release = resolve; }),
    tick: async () => {},
    location: { href: 'https://companion.example/pair' }
  };
  runInNewContext(code + '\nglobalThis.scannerHarness = { allowCamera, stopCamera };', sandbox);
  const pending = sandbox.scannerHarness.allowCamera();
  sandbox.scannerHarness.stopCamera();
  release({ getTracks: () => [{ stop: () => { released++; } }] });
  await pending;
  assert.equal(released, 1);
});

test('camera upgrade changes the service-worker cache and HTML security validators', () => {
  const worker = readFileSync(new URL('../ui/static/service-worker.js', import.meta.url), 'utf8');
  const assets = readFileSync(new URL('../server/src/assets.rs', import.meta.url), 'utf8');
  assert.match(worker, /pi-companion-shell-v6/);
  assert.match(assets, /-camera-v2/);
  assert.ok(assets.indexOf('headers.insert(header::CONTENT_SECURITY_POLICY') < assets.indexOf('let not_modified'));
});
