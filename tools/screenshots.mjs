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
const binary = process.env.COMPANION_BINARY ?? join(root, 'server/target/release/pi-companion-server');
const { chromium } = await import(process.env.PLAYWRIGHT ? pathToFileURL(process.env.PLAYWRIGHT).href : 'playwright');

const home = mkdtempSync(join(tmpdir(), 'pi-companion-shots-'));
const now = Math.floor(Date.now() / 1000);
const demoAutomations = [
  { id: 'demo-review', name: 'Review requested pull requests', enabled: true, schedule: '0 2,5,8 * * 1-5', historyLimit: 30,
    preconditions: [{ type: 'command', command: 'python3', args: ['review.py', 'check'], cwd: '/Users/demo/code/shop-api' }],
    actions: [{ type: 'pi', prompt: 'Review new commits in requested PRs. Approve only when everything looks good.', cwd: '/Users/demo/code/shop-api' }],
    postActions: [{ type: 'command', command: 'python3', args: ['review.py', 'summary'], cwd: '/Users/demo/code/shop-api' }], createdAt: now - 86400, updatedAt: now },
  { id: 'demo-health', name: 'Morning repository health check', enabled: true, schedule: '0 9 * * 1-5', maxRetries: 2, retryIntervalSeconds: 10, historyLimit: 30,
    preconditions: [], actions: [{ type: 'command', command: 'git', args: ['status', '--short'] }], postActions: [], createdAt: now - 86400, updatedAt: now - 60 },
  { id: 'demo-release', name: 'Prepare release notes', enabled: false, schedule: null, preconditions: [],
    actions: [{ type: 'pi', prompt: 'Summarize recent commits into release notes.', cwd: '/Users/demo/code/handbook' }], postActions: [], createdAt: now - 86400, updatedAt: now - 120 }
];
const demoResult = '[precondition]\\nFound 3 pull requests with new commits. Work profile usage is available.\\n[action]\\nReviewed all new commits and checked CI.\\n[post-action]\\n## Pull request review summary\\n\\n| Pull request | Result | Summary |\\n| --- | --- | --- |\\n| [PR shop-api:#42 — (reviewed 3x)](https://github.com/example/shop-api/pull/42) | Approved | Input validation and tests look good. |\\n| [PR checkout:#18 — (reviewed 2x)](https://github.com/example/checkout/pull/18) | Needs changes | Handle a missing payment token before retrying. |\\n| [PR handbook:#7 — (reviewed 1x)](https://github.com/example/handbook/pull/7) | Skipped | Another person already reviewed this commit. |\\n\\n> 1 approved · 1 needs changes · 1 skipped. No branches were merged.';
const demoRuns = Array.from({ length: 24 }, (_, i) => ({ id: 'demo-run-' + i, automationId: 'demo-review', startedAt: now - (24 - i) * 5400,
  finishedAt: now - (24 - i) * 5400 + 95, status: i === 23 ? 'succeeded' : ['succeeded', 'skipped', 'failed', 'stopped'][i % 4], result: i === 23 ? demoResult.replaceAll('\\n', '\n') : '[precondition]\nNo new commits to review.', sessionId: i === 23 ? 'demo-automated' : undefined }));
writeFileSync(join(home, 'automations.json'), JSON.stringify({ definitions: demoAutomations, runs: demoRuns }));
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

const base = { pid: 4242, remoteEnabled: true, asks: [], commands: [{ name: 'review', description: 'Review changes and look for regressions', source: 'extension' }, { name: 'skill:qa', description: 'Report bugs and check behavior', source: 'skill' }, { name: 'summarize', description: 'Summarize the current work', source: 'prompt' }] };
const sessions = {
  billing: {
    ...base, id: 'demo-billing', name: 'Coupon discounts', shortTitle: 'Add coupon support to invoices', cwd: '/Users/demo/code/shop-api',
    status: 'active', mainModel: 'claude-sonnet-4.5', effort: 'medium', connectedAt: minutesAgo(18)
  },
  docs: {
    ...base, id: 'demo-docs', name: 'Docs refresh', shortTitle: 'Rewrite the onboarding guide', cwd: '/Users/demo/code/handbook',
    status: 'idle', mainModel: 'gpt-5', effort: 'low', connectedAt: minutesAgo(64),
    commands: [{ name: 'review', description: 'Review changes and look for regressions', source: 'extension' }, { name: 'skill:qa', description: 'Report bugs and check behavior', source: 'skill' }, { name: 'summarize', description: 'Summarize the current work', source: 'prompt' }],
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
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error('Horizontal overflow in ' + name);
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
  page.on('pageerror', error => console.error('Browser error:', error.message));
  return { context, page };
}

async function checkPullToRefresh(page, path, endpoint) {
  await page.goto(BASE + path); await settle(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const [selector, dx, dy] of [['.page h1', 0, 60], ['.page h1', 150, 20], ['.refresh-control button', 0, 160]]) {
    await page.evaluate(({ selector, dx, dy }) => {
      const target = document.querySelector(selector);
      const touch = (x, y) => new Touch({ identifier: 1, target, clientX: x, clientY: y });
      target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(100, 100)] }));
      target.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [touch(100 + dx, 100 + dy)] }));
      target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
    }, { selector, dx, dy });
    if (await page.locator('.refresh-message').textContent()) throw new Error('Non-refresh gesture triggered refresh: ' + selector);
  }
  const response = page.waitForResponse(r => r.url().endsWith(endpoint) && r.ok());
  await page.evaluate(() => {
    const target = document.querySelector('.page h1');
    if (!target) throw new Error('Missing gesture target');
    const touch = y => new Touch({ identifier: 1, target, clientX: 100, clientY: y });
    target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(100)] }));
    target.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [touch(260)] }));
    target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
  });
  await response;
  await page.getByRole('status').filter({ hasText: 'Up to date' }).waitFor();
  await page.getByRole('button', { name: 'Refresh page data' }).click();
  await page.getByRole('status').filter({ hasText: 'Up to date' }).waitFor();
}

async function settle(page, ms = 1200) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(ms);
}

try {
  await waitForDaemon();
  await bridge(sessions.billing, billingEvents);
  await bridge({ ...sessions.billing, id: 'demo-automated', name: 'Pull request review', shortTitle: 'Reviewing new commits', readOnly: true, automationId: 'demo-review', automationRunId: 'demo-run-23' }, [['agent.start', {}], ['assistant.delta', { kind: 'text', delta: 'I’m reviewing the new commits. I’ll share the results when the checks are finished.' }]]);
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
    await page.locator('#home-automation-heading').scrollIntoViewIfNeeded();
    await shot(page, 'overview-automations');
    await page.goto(BASE + '/sessions');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await settle(page);
    await shot(page, 'session-list-desktop');
    await page.goto(BASE + '/automations'); await settle(page);
    await shot(page, 'automations');
    await page.getByRole('button', { name: 'Disabled', exact: true }).click();
    if (await page.locator('.routine-table tbody tr').count() !== 1) throw new Error('Automation status filter failed');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('searchbox').fill('Morning');
    if (await page.locator('.routine-table tbody tr').count() !== 1) throw new Error('Automation search failed');
    await page.getByRole('searchbox').fill('');
    await page.goto(BASE + '/automations/demo-review'); await settle(page);
    await shot(page, 'automation-detail');
    await page.getByRole('tab', { name: /Run history/ }).click();
    if (await page.locator('.routine-table tbody tr').count() !== 10) throw new Error('History page size is not 10');
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    if (!(await page.locator('.automation-pagination').textContent()).includes('Page 2')) throw new Error('Pagination failed');
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await shot(page, 'automation-history');
    await page.getByLabel('Run status').selectOption('failed');
    if (await page.locator('.routine-table tbody tr').count() !== 6) throw new Error('History filter failed');
    await page.getByRole('tab', { name: 'Summary', exact: true }).click();
    await page.getByRole('button', { name: 'Edit automation', exact: true }).click();
    if (!(await page.getByLabel('Automation name', { exact: true }).evaluate(el => el === document.activeElement))) throw new Error('Editor did not focus');
    await sleep(500);
    await shot(page, 'automation-editor');
    await page.getByLabel('Automation name', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Save automation', exact: true }).click();
    if (await page.getByLabel('Automation name', { exact: true }).evaluate(el => el.validity.valid)) throw new Error('Empty name accepted');
    await page.goto(BASE + '/automations/demo-review/runs/demo-run-23'); await settle(page);
    await shot(page, 'automation-result');
    await page.locator('.rich-output table').waitFor();
    if (await page.locator('.rich-output table tbody tr').count() !== 3) throw new Error('Markdown table not rendered');
    await shot(page, 'automation-result');
    await page.goto(BASE + '/sessions/demo-automated'); await settle(page);
    if (await page.locator('.composer textarea').count()) throw new Error('Automated session exposes composer');
    await shot(page, 'automation-session');
    await page.goto(BASE + '/devices'); await settle(page); await shot(page, 'devices');
    await page.goto(BASE + '/settings'); await settle(page); await shot(page, 'settings');
    const publicUrl = page.locator('#public-url');
    await publicUrl.fill('https://unsaved.example.com');
    await page.getByRole('button', { name: 'Refresh page data' }).click();
    await page.getByRole('status').filter({ hasText: 'Up to date' }).waitFor();
    if (await publicUrl.inputValue() !== 'https://unsaved.example.com') throw new Error('Refresh discarded settings edits');
    await context.close();
  }

  // Desktop session, light.
  {
    const { context, page } = await open(browser, { width: 1440, height: 1000, theme: 'light' });
    await page.goto(BASE + '/sessions/demo-billing');
    await settle(page);
    await shot(page, 'session-light');
    await page.locator('#prompt').fill('/');
    await page.getByRole('listbox', { name: 'Available slash commands' }).waitFor();
    await shot(page, 'slash-commands');
    await page.locator('#prompt').fill('/rev');
    if (await page.getByRole('option').count() !== 1) throw new Error('Slash filtering failed');
    await page.locator('#prompt').press('Tab');
    if (await page.locator('#prompt').inputValue() !== '/review ') throw new Error('Slash selection failed');
    await page.locator('#prompt').fill('');
    await context.close();
  }

  // Phone screens, dark.
  {
    const { context, page } = await open(browser, { width: 390, height: 844, theme: 'dark', mobile: true });
    for (const [path, endpoint] of [['/', '/api/automations'], ['/sessions', '/api/sessions'], ['/automations', '/api/automations'], ['/settings', '/api/settings']]) await checkPullToRefresh(page, path, endpoint);
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

    await page.goto(BASE + '/automations'); await settle(page);
    await shot(page, 'automations-mobile');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile automation list overflows');
    await page.goto(BASE + '/automations/demo-review'); await settle(page);
    await shot(page, 'automation-detail-mobile');
    await page.getByRole('tab', { name: /Run history/ }).click();
    await page.locator('#panel-history .collection-toolbar').scrollIntoViewIfNeeded();
    await shot(page, 'automation-history-mobile');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile automation history overflows');
    await page.goto(BASE + '/automations'); await settle(page);
    await page.route('**/api/automations', route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Unavailable' }));
    await page.getByRole('button', { name: 'Refresh page data' }).click();
    await page.getByRole('status').filter({ hasText: 'Refresh failed:' }).waitFor();
    await page.unroute('**/api/automations');
    await page.getByRole('button', { name: 'Refresh page data' }).click();
    await page.getByRole('status').filter({ hasText: 'Up to date' }).waitFor();
    await page.goto(BASE + '/settings'); await settle(page); await shot(page, 'settings-mobile');
    await page.setViewportSize({ width: 320, height: 844 });
    for (const path of ['/', '/sessions', '/automations', '/automations/demo-review', '/settings', '/devices']) {
      await page.goto(BASE + path); await settle(page);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('320px overflow: ' + path);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE + '/sessions/demo-mobile'); await settle(page);
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
