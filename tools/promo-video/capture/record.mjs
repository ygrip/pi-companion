#!/usr/bin/env node
// Records the promo footage from a real Pi session and real browsers.
//
//   npm run ui:build && cargo build --release --manifest-path server/Cargo.toml
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node tools/promo-video/capture/record.mjs
//
// What it does, against a throwaway daemon on its own ports and data directory (your
// usual daemon, sessions and devices are left alone):
//   1. Starts Pi (with only the Companion extension) in a tmux pane recorded by asciinema,
//      gives it a real task in a small demo repository, then types /remote-control.
//   2. Opens the dashboard in a desktop Chromium and pairs a device.
//   3. Opens the paired-device surface in a phone-sized Chromium, enters the code, opens the
//      session, sends a prompt and answers Pi's question.
//   4. Creates a research automation on the dashboard, triggers it from the phone and opens
//      the finished run.
// Both browsers are recorded with the Chrome DevTools screencast. Output goes to
// tools/promo-video/captures/: terminal.cast, desktop/ and phone/ frame folders and
// events.json (wall-clock timestamps and tap positions used by the edit).
// This costs real model calls (Pi's default model).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const out = fileURLToPath(new URL('../captures', import.meta.url));
const ADMIN = '127.0.0.1:44721';
const DEVICE = '127.0.0.1:44722';
const binary = process.env.COMPANION_BINARY ?? join(root, 'server/target/release/pi-companion-server');
const realPi = process.env.PI_BINARY ?? execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
const { chromium } = await import(process.env.PLAYWRIGHT ? pathToFileURL(process.env.PLAYWRIGHT).href : 'playwright');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const events = [];
const mark = (name, extra = {}) => { events.push({ name, at: Date.now(), ...extra }); console.log(new Date().toISOString().slice(11, 19), name); };

// ---------------------------------------------------------------------------------------
// Isolated environment.

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'pi-companion-promo-'));
const bin = join(home, 'bin');
mkdirSync(bin);
// Pi with only the Companion extension from this checkout, for the session and automations.
writeFileSync(join(bin, 'pi'), `#!/bin/sh\nexec "${realPi}" --no-extensions --no-skills --no-prompt-templates -e "${join(root, 'src/index.ts')}" "$@"\n`);
chmodSync(join(bin, 'pi'), 0o755);

const workspace = join(homedir(), 'pi-demo', 'mobile-app');
if (existsSync(join(homedir(), 'pi-demo'))) throw new Error('~/pi-demo exists; remove it first');
mkdirSync(join(workspace, 'src/auth'), { recursive: true });
writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'mobile-app', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
writeFileSync(join(workspace, 'src/auth/session.js'), `// Sessions last 7 days and are refreshed when the app resumes.
export const SESSION_TTL_DAYS = 7;

export function expiresAt(issuedAtMs) {
  // TTL in milliseconds.
  return issuedAtMs + SESSION_TTL_DAYS * 24 * 60 * 1000;
}

export function isExpired(session, nowMs = Date.now()) {
  return nowMs >= expiresAt(session.issuedAt);
}

export function onResume(session, nowMs = Date.now()) {
  if (isExpired(session, nowMs)) return { ...session, loggedOut: true };
  return session;
}
`);
writeFileSync(join(workspace, 'src/auth/session.test.js'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExpired } from './session.js';

test('a fresh session is valid', () => {
  assert.equal(isExpired({ issuedAt: 0 }, 1000), false);
});
`);
execFileSync('git', ['init', '-q'], { cwd: workspace });
execFileSync('git', ['add', '.'], { cwd: workspace });
execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'init'], { cwd: workspace });

let cleanup = () => {};
const fail = async (error) => {
  console.error('FAILED:', error?.stack ?? error);
  for (const page of [globalThis.D, globalThis.P]) await page?.screenshot({ path: join(out, `fail-${page === globalThis.D ? 'desktop' : 'phone'}.png`) }).catch(() => {});
  try { writeFileSync(join(out, 'fail-pane.txt'), execFileSync('tmux', ['-L', 'pcpromo', 'capture-pane', '-p', '-t', 'demo'], { encoding: 'utf8' })); } catch { /* no pane */ }
  writeFileSync(join(out, 'events.json'), JSON.stringify({ events }, null, 2));
  cleanup();
  process.exit(1);
};
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);

const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_COMPANION_URL: `ws://${ADMIN}`, PI_COMPANION_AUTOSTART: '0', PI_COMPANION_QUOTAS: '0' };
const daemon = spawn(binary, [], {
  env: { ...env, PI_COMPANION_HOME: join(home, 'companion'), PI_COMPANION_ADMIN_ADDR: ADMIN, PI_COMPANION_DEVICE_ADDR: DEVICE, RUST_LOG: 'warn' },
  stdio: 'ignore'
});
for (let i = 0; ; i++) {
  try { if ((await fetch(`http://${ADMIN}/api/context`)).ok) break; } catch { /* starting */ }
  if (i > 50) throw new Error('demo daemon did not start');
  await sleep(100);
}
cleanup = () => {
  try { execFileSync('tmux', ['-L', 'pcpromo', 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
  daemon.kill();
  rmSync(home, { recursive: true, force: true });
  rmSync(join(homedir(), 'pi-demo'), { recursive: true, force: true });
};
const api = async (path) => (await fetch(`http://${ADMIN}${path}`)).json();

// ---------------------------------------------------------------------------------------
// Terminal: tmux pane recorded by asciinema.

const COLS = 104, ROWS = 30;
const tmux = (...args) => execFileSync('tmux', ['-L', 'pcpromo', ...args], { env, encoding: 'utf8' });
tmux('new-session', '-d', '-s', 'demo', '-x', String(COLS), '-y', String(ROWS), '-c', workspace, 'zsh', '-f');
tmux('set', '-g', 'status', 'off');
tmux('set', '-g', 'window-size', 'manual');
tmux('send-keys', '-t', 'demo', "PS1='%F{yellow}~/pi-demo/mobile-app%f %F{8}❯%f '; clear", 'Enter');
await sleep(500);
const recorder = spawn('asciinema', ['rec', '--headless', '--overwrite', '--window-size', `${COLS}x${ROWS}`, '-c', 'tmux -L pcpromo attach -t demo', join(out, 'terminal.cast')], { env, stdio: 'ignore' });
await sleep(1500);
mark('terminal.start');

async function typeTerminal(text, cps = 16) {
  for (const ch of text) {
    tmux('send-keys', '-t', 'demo', '-l', ch);
    await sleep(1000 / cps * (0.7 + Math.random() * 0.6));
  }
}
const pane = () => tmux('capture-pane', '-p', '-t', 'demo');
async function waitPaneStable(ms, timeout = 240_000) {
  const end = Date.now() + timeout;
  let last = pane(), since = Date.now();
  while (Date.now() < end) {
    await sleep(400);
    const now = pane();
    if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= ms) return;
  }
  throw new Error('terminal never settled');
}

await typeTerminal('pi', 6);
tmux('send-keys', '-t', 'demo', 'Enter');
mark('terminal.pi');
await sleep(4000);
await waitPaneStable(1500);
await typeTerminal('Sessions on Android expire after a few hours instead of 7 days. Fix src/auth/session.js and add a test.', 22);
await sleep(300);
tmux('send-keys', '-t', 'demo', 'Enter');
mark('terminal.prompt');
await sleep(3000);
await waitPaneStable(5000);
mark('terminal.done');
await typeTerminal('/remote-control', 10);
await sleep(500);
tmux('send-keys', '-t', 'demo', 'Enter');
mark('terminal.remote');
let session;
for (let i = 0; i < 100 && !session; i++) {
  await sleep(200);
  session = (await api('/api/sessions')).sessions?.find((s) => s.remoteEnabled !== false);
}
if (!session) throw new Error('session was not shared');
mark('terminal.shared', { sessionId: session.id });
await sleep(3500);

// ---------------------------------------------------------------------------------------
// Browsers.

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });

async function recorded(name, { width, height, scale, mobile }) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: scale, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark',
    userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' : undefined
  });
  await context.addInitScript(() => {
    localStorage.setItem('pi-companion-theme', 'dark');
    localStorage.setItem('pi-companion-notification-prompt', 'dismissed');
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(name, 'browser error:', error.message));
  const dir = join(out, name);
  mkdirSync(dir);
  const frames = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const file = `${String(frames.length).padStart(6, '0')}.jpg`;
    writeFileSync(join(dir, file), Buffer.from(data, 'base64'));
    frames.push({ file, at: Math.round(metadata.timestamp * 1000) });
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: Math.round(width * scale), maxHeight: Math.round(height * scale) });
  // Repaint once a second so a still screen still produces frames.
  const ticker = setInterval(() => page.evaluate(() => { document.documentElement.style.setProperty('--promo-tick', String(Date.now() % 2)); }).catch(() => {}), 1000);
  return {
    page, name,
    async stop() {
      clearInterval(ticker);
      await cdp.send('Page.stopScreencast').catch(() => {});
      writeFileSync(join(dir, 'frames.json'), JSON.stringify({ width: Math.round(width * scale), height: Math.round(height * scale), scale, frames }));
    }
  };
}

/** Tap/click a locator and log where it landed (CSS px of that viewport). */
async function press(rec, locator, label) {
  await locator.scrollIntoViewIfNeeded();
  await sleep(250);
  const box = await locator.boundingBox();
  const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  mark(`${rec.name}.tap`, { label, ...at });
  if (rec.name === 'phone') {
    // Live feeds re-render under sheets; fall back to a DOM click when the tap never settles.
    try { await locator.tap({ timeout: 8000 }); } catch (error) { console.warn('tap fallback for', label, String(error).split('\n')[0]); await locator.dispatchEvent('click'); }
  } else { await rec.page.mouse.move(at.x, at.y, { steps: 12 }); await locator.click(); }
}
async function type(rec, locator, text, label, delay = 70) {
  await press(rec, locator, label);
  await locator.fill('');
  mark(`${rec.name}.type`, { label, text, delay: delay / 1000 });
  await locator.pressSequentially(text, { delay });
}

const desktop = await recorded('desktop', { width: 1440, height: 900, scale: 4 / 3, mobile: false });
const phone = await recorded('phone', { width: 390, height: 844, scale: 2, mobile: true });
const D = desktop.page, P = phone.page;
globalThis.D = D; globalThis.P = P;

// Dashboard: pair a device.
await D.goto(`http://${ADMIN}/`);
mark('desktop.overview');
await sleep(3000);
await press(desktop, D.getByRole('link', { name: 'Devices' }).first(), 'Devices');
await sleep(2000);
await press(desktop, D.getByRole('button', { name: 'Pair a device' }), 'Pair a device');
const codeEl = D.getByLabel('One-time pairing code').locator('.pair-code');
await codeEl.waitFor();
const code = (await codeEl.innerText()).trim();
mark('desktop.code', { code });
await sleep(2500);

// Phone: enter the code.
await P.goto(`http://${DEVICE}/`);
await P.getByLabel('Pairing code').waitFor();
mark('phone.pair');
await sleep(1500);
await type(phone, P.getByLabel('Pairing code'), code, 'Pairing code', 140);
await sleep(400);
const nameField = P.getByLabel('Device name');
await press(phone, nameField, 'Device name');
await nameField.fill('');
await nameField.pressSequentially('iPhone', { delay: 90 });
await sleep(600);
await press(phone, P.getByRole('button', { name: 'Connect device' }), 'Connect device');
mark('phone.paired');
await sleep(2500);
mark('desktop.paired');
await sleep(2500);

// Phone: open the shared session and send a prompt.
await press(phone, P.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Sessions' }), 'Sessions');
await sleep(2200);
await press(phone, P.locator('a[href*="/sessions/"]').first(), 'Session');
mark('phone.session');
await sleep(4500);
const composer = P.getByPlaceholder(/Message Pi|Steer/);
await type(phone, composer, 'Now make the refresh on resume safer. Use companion_ask_user to ask me which approach to take, with 3 options.', 'Message', 45);
await sleep(500);
await press(phone, P.getByRole('button', { name: /^Send/ }), 'Send');
mark('phone.sent');
const answer = P.getByRole('button', { name: 'Answer', exact: true });
await answer.waitFor({ timeout: 240_000 });
mark('phone.ask');
await sleep(2500);
const option = P.locator('label.option .option-text').first();
await press(phone, option, 'Option');
await sleep(1200);
await press(phone, answer, 'Answer');
mark('phone.answered');
for (let i = 0; i < 600; i++) {
  await sleep(500);
  const s = (await api('/api/sessions')).sessions?.find((x) => x.id === session.id);
  if (s && s.status !== 'active' && i > 6) break;
}
mark('phone.idle');
await sleep(3000);

// Dashboard: create the research automation.
await press(desktop, D.getByRole('link', { name: 'Automations' }).first(), 'Automations');
await sleep(2000);
await press(desktop, D.getByRole('button', { name: 'Create automation' }).first(), 'Create automation');
mark('desktop.editor');
await sleep(1200);
await type(desktop, D.getByLabel('Automation name'), 'Daily research digest', 'Automation name', 55);
await press(desktop, D.getByLabel('Run on a schedule'), 'Run on a schedule');
const cron = D.getByLabel('Cron expression');
await cron.fill('');
await type(desktop, cron, '0 9 * * 1-5', 'Cron expression', 90);
const actions = D.locator('section.form-section').filter({ has: D.getByRole('heading', { name: 'Actions', exact: true }) });
if (!(await actions.locator('textarea').count())) await press(desktop, actions.getByRole('button', { name: 'Pi step' }), 'Pi step');
const step = actions.locator('textarea').first();
await type(desktop, step, JSON.stringify({ type: 'pi', prompt: 'Research WebGPU and write a 5-bullet brief: what it is, browser support, and one tip. Under 120 words. Do not change files.', cwd: workspace }, null, 2).replace(/\n\s*/g, ' '), 'Pi step', 12);
await sleep(600);
await press(desktop, D.getByRole('button', { name: 'Save automation' }), 'Save automation');
mark('desktop.saved');
await sleep(3500);

// Phone: trigger it and open the result.
await press(phone, P.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Automations' }), 'Automations');
await sleep(2500);
await press(phone, P.getByText('Daily research digest').filter({ visible: true }).first(), 'Automation');
mark('phone.automation');
await sleep(3000);
await press(phone, P.getByRole('button', { name: /Run now/ }).filter({ visible: true }).first(), 'Run now');
mark('phone.run');
await sleep(1500);
await press(phone, P.getByRole('tab', { name: /Run history/ }).or(P.getByRole('button', { name: /Run history/ })).first(), 'Run history');
const automation = (await api('/api/automations')).automations.find((a) => a.name === 'Daily research digest');
for (let i = 0; i < 600; i++) {
  await sleep(500);
  const runs = (await api(`/api/automations/${automation.id}/runs`)).runs ?? [];
  if (runs.length && runs.every((r) => r.status !== 'running' && r.status !== 'queued')) break;
}
mark('phone.run.done');
await sleep(3000);
await press(phone, P.locator('#panel-history a[href*="/runs/"]').filter({ visible: true }).first(), 'Run');
mark('phone.result');
await sleep(4000);
await P.mouse.wheel(0, 600).catch(() => {});
await P.evaluate(() => window.scrollBy({ top: 700, behavior: 'smooth' }));
await sleep(4000);
mark('end');

await desktop.stop();
await phone.stop();
await browser.close();
writeFileSync(join(out, 'events.json'), JSON.stringify({ events, workspace, cols: COLS, rows: ROWS }, null, 2));
cleanup();
await new Promise((resolve) => { recorder.once('exit', resolve); setTimeout(resolve, 3000); });
console.log('captures in', out);
