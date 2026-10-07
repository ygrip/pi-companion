#!/usr/bin/env node
// Regenerates the README/docs screenshots from demo sessions (never real conversations).
//
// It builds nothing: run `npm run ui:build && cargo build --release --manifest-path server/Cargo.toml`
// first. Then `node tools/screenshots.mjs`. The demo daemon runs on its own ports and data
// directory, so a daemon you already have running is left alone.
//
// Needs Playwright (with Chromium) and `cwebp`. Point PLAYWRIGHT at a module path if
// Playwright is not resolvable from this repo, e.g. PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs,
// and set CHROME to a Chrome/Chromium executable if Playwright's browser is not installed.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const docs = join(root, 'docs');
const ADMIN = '127.0.0.1:43731';
const DEVICE = '127.0.0.1:43732';
const BASE = `http://${ADMIN}`;
const binary = join(root, 'server/target/release/pi-companion-server');
const { chromium } = await import(process.env.PLAYWRIGHT ? pathToFileURL(process.env.PLAYWRIGHT).href : 'playwright');

const home = mkdtempSync(join(tmpdir(), 'pi-companion-shots-'));
const daemon = spawn(binary, [], {
  env: { ...process.env, PI_COMPANION_HOME: home, PI_COMPANION_ADMIN_ADDR: ADMIN, PI_COMPANION_DEVICE_ADDR: DEVICE, RUST_LOG: 'warn' },
  stdio: 'ignore'
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDaemon() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/api/context')).ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error('demo daemon did not start');
}

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

const DIFF = `diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts
index 3f1c2aa..8b9d0e1 100644
--- a/src/billing/invoice.ts
+++ b/src/billing/invoice.ts
@@ -12,9 +12,14 @@ export function totalFor(lines: InvoiceLine[]) {
-  return lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
+  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
+  const discount = lines.some((line) => line.coupon) ? subtotal * 0.1 : 0;
+  return round(subtotal - discount);
 }
+
+const round = (value: number) => Math.round(value * 100) / 100;
diff --git a/src/billing/invoice.test.ts b/src/billing/invoice.test.ts
index 51ab0c3..77e2f10 100644
--- a/src/billing/invoice.test.ts
+++ b/src/billing/invoice.test.ts
@@ -40,3 +40,10 @@ describe('totalFor', () => {
   it('sums lines', () => expect(totalFor(lines)).toBe(42));
+  it('applies a coupon once', () => {
+    expect(totalFor([{ price: 20, quantity: 1, coupon: 'WELCOME' }])).toBe(18);
+  });
+  it('rounds to cents', () => {
+    expect(totalFor([{ price: 0.1, quantity: 3 }])).toBe(0.3);
+  });
 });
`;

/** A fake Pi session talking the bridge protocol. */
async function bridge(session, events = []) {
  const ws = new WebSocket(`ws://${ADMIN}/ws/bridge/${session.id}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (message) => ws.send(JSON.stringify(message));
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === 'command' && message.command?.type === 'git_diff') send({ type: 'git.diff', staged: Boolean(message.command.staged), diff: DIFF });
  };
  send({ type: 'register', session });
  for (const [event, payload] of events) send({ type: 'event', event, payload });
  return { ws, send };
}

const tool = (id, toolName, args, result, input) => [
  ['tool.start', { toolCallId: id, toolName, args, input }],
  ['tool.end', { toolCallId: id, toolName, result }]
];

const base = { pid: 4242, remoteEnabled: true, asks: [] };
const sessions = {
  billing: {
    ...base, id: 'demo-billing', name: 'Coupon discounts', shortTitle: 'Add coupon support to invoices', cwd: '/Users/demo/code/shop-api',
    status: 'active', mainModel: 'claude-sonnet-4.5', effort: 'medium', connectedAt: minutesAgo(18)
  },
  docs: {
    ...base, id: 'demo-docs', name: 'Docs refresh', shortTitle: 'Rewrite the onboarding guide', cwd: '/Users/demo/code/handbook',
    status: 'idle', mainModel: 'gpt-5', effort: 'low', connectedAt: minutesAgo(64),
    asks: [{
      requestId: 'ask-1', source: 'companion', title: 'Which tone should the guide use?', createdAt: minutesAgo(2),
      questions: [{ id: 'tone', question: 'Which tone should the onboarding guide use?', header: 'Tone', options: [
        { label: 'Friendly', description: 'Casual, short sentences, a bit of humour' },
        { label: 'Neutral', description: 'Plain and to the point' },
        { label: 'Formal', description: 'Polished, for customers and partners' }
      ], allowCustom: true }]
    }]
  },
  mobile: {
    ...base, id: 'demo-mobile', name: 'Fix login on Android', shortTitle: 'Session expires too early', cwd: '/Users/demo/code/mobile-app',
    status: 'active', mainModel: 'claude-opus-4.1', effort: 'high', connectedAt: minutesAgo(7)
  },
  infra: {
    ...base, id: 'demo-infra', name: 'Nightly backups', shortTitle: 'Rotate old snapshots', cwd: '/Users/demo/code/infra',
    status: 'idle', mainModel: 'gpt-5-mini', connectedAt: minutesAgo(140)
  },
  old: {
    ...base, id: 'demo-old', name: 'Landing page copy', shortTitle: 'Tweak hero wording', cwd: '/Users/demo/code/website',
    status: 'idle', mainModel: 'claude-haiku-4.5', connectedAt: minutesAgo(300)
  }
};

const billingEvents = [
  ['session.start', { cwd: sessions.billing.cwd }],
  ['agent.start', {}],
  ['assistant.delta', { kind: 'thinking', delta: 'The invoice total ignores coupons. I should look at how lines are summed and where coupons live on the line model.' }],
  ...tool('t1', 'read', 'src/billing/invoice.ts', '48 lines', { path: 'src/billing/invoice.ts' }),
  ...tool('t2', 'bash', 'npm test -- invoice', '✓ 6 passed', { command: 'npm test -- invoice' }),
  ['assistant.delta', { kind: 'text', delta: 'Found it: `totalFor` just multiplies price by quantity, so coupons never apply.\n\nI’ll:\n1. take 10% off when any line has a coupon\n2. round the result to cents\n3. add two tests for it' }],
  ...tool('t3', 'edit', 'src/billing/invoice.ts', 'Applied 1 edit', { path: 'src/billing/invoice.ts' }),
  ...tool('t4', 'edit', 'src/billing/invoice.test.ts', 'Applied 1 edit', { path: 'src/billing/invoice.test.ts' }),
  ['tool.start', { toolCallId: 't5', toolName: 'bash', args: 'npm test', input: { command: 'npm test' } }]
];

const mobileEvents = [
  ['agent.start', {}],
  ['assistant.delta', { kind: 'thinking', delta: 'Tokens are refreshed on app resume, but Android kills the background task before the refresh finishes. Checking how the refresh timer is scheduled…' }]
];

async function shot(page, name, { webp = true, png = false } = {}) {
  const file = join(docs, name + '.png');
  await page.screenshot({ path: file });
  if (webp) execFileSync('cwebp', ['-quiet', '-q', '82', file, '-o', join(docs, name + '.webp')]);
  if (!png) rmSync(file);
}

async function open(browser, { width, height, theme, mobile = false }) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile,
    reducedMotion: 'no-preference', colorScheme: theme
  });
  await context.addInitScript((pref) => {
    localStorage.setItem('pi-companion-theme', pref);
    localStorage.setItem('pi-companion-notification-prompt', 'dismissed');
  }, theme);
  const page = await context.newPage();
  return { context, page };
}

async function settle(page, ms = 1200) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(ms);
}

try {
  await waitForDaemon();
  await bridge(sessions.billing, billingEvents);
  await bridge(sessions.docs, [['agent.start', {}], ['assistant.delta', { kind: 'text', delta: 'Draft is ready. Before I polish it, one question about tone.' }], ['agent.end', {}]]);
  await bridge(sessions.mobile, mobileEvents);
  await bridge(sessions.infra, [['agent.end', {}]]);
  const ended = await bridge(sessions.old, []);
  ended.ws.close();
  await sleep(300);

  // A shared file for the billing session.
  const form = new FormData();
  form.append('file', new Blob([readFileSync(join(root, 'ui/static/pwa-512.png'))], { type: 'image/png' }), 'checkout-mock.png');
  await fetch(`${BASE}/api/sessions/demo-billing/files`, { method: 'POST', body: form, headers: { origin: BASE } });

  // CHROME=/path/to/chrome uses an existing browser instead of Playwright's bundled one.
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});

  // Desktop overview, dark.
  {
    const { context, page } = await open(browser, { width: 1440, height: 1200, theme: 'dark' });
    await page.goto(BASE + '/');
    // The logo is the first dot-field frame: catch it after the reveal, before the first morph.
    await page.waitForSelector('.dot-field canvas');
    await sleep(2800);
    await shot(page, 'dashboard', { png: true });
    await page.goto(BASE + '/sessions');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await settle(page);
    await shot(page, 'session-list-desktop');
    await context.close();
  }

  // Desktop session, light.
  {
    const { context, page } = await open(browser, { width: 1440, height: 1000, theme: 'light' });
    await page.goto(BASE + '/sessions/demo-billing');
    await settle(page);
    await shot(page, 'session-light');
    await context.close();
  }

  // Phone screens, dark.
  {
    const { context, page } = await open(browser, { width: 390, height: 844, theme: 'dark', mobile: true });
    await page.goto(BASE + '/sessions');
    await settle(page);
    await shot(page, 'session-list');

    await page.goto(BASE + '/sessions/demo-billing');
    await settle(page);
    await shot(page, 'mobile');

    await page.locator('summary[aria-label="Session options"]').click();
    await sleep(300);
    await shot(page, 'session-menu');
    await page.locator('.menu-actions button', { hasText: 'Changes' }).click();
    await settle(page);
    await shot(page, 'changes');

    await page.goto(BASE + '/sessions/demo-billing');
    await settle(page);
    const note = join(home, 'notes.txt');
    writeFileSync(note, 'Coupon rules from the product team:\n- 10% off\n- one coupon per invoice\n');
    await page.locator('#file-input').setInputFiles([join(root, 'ui/static/pwa-512.png'), note]);
    await settle(page);
    await page.locator('textarea').first().fill('Here are the coupon rules and the checkout mock. Can you match them?');
    await shot(page, 'attachments');

    await page.goto(BASE + '/sessions/demo-mobile');
    await settle(page, 1800);
    await shot(page, 'thinking');

    // Connection recovery: stop the daemon underneath the open page.
    daemon.kill();
    await sleep(2500);
    await shot(page, 'connection-error');
    await context.close();
  }

  await browser.close();
  console.log('Screenshots written to docs/.');
} finally {
  daemon.kill();
  rmSync(home, { recursive: true, force: true });
}
