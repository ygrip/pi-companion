import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Execute the real extension and bridge with an in-memory transport and daemon spy.
const dataModule = (source: string) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const state = { probes: 0, sockets: [] as any[], deferProbe: false, resolveProbe: undefined as (() => void) | undefined };
(globalThis as any).__companionLifecycleTest = state;
const daemon = dataModule(`
  export function adminHttpUrl() { return 'http://localhost:43721'; }
  export async function ensureDaemon() {
    const state = globalThis.__companionLifecycleTest;
    state.probes++;
    if (state.deferProbe) return new Promise(resolve => { state.resolveProbe = () => resolve(true); });
    return true;
  }
`);
const socket = dataModule(`
  import { EventEmitter } from 'node:events';
  export default class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    frames = [];
    constructor() { super(); globalThis.__companionLifecycleTest.sockets.push(this); }
    send(frame) { this.frames.push(JSON.parse(frame)); }
    close() { this.readyState = 3; this.emit('close'); }
  }
`);
const transpile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const ask = new URL('../src/ask.ts', import.meta.url).href;
const bridge = dataModule(transpile('../src/bridge.ts')
  .replace('from "ws"', `from ${JSON.stringify(socket)}`)
  .replace('from "./ask.js"', `from ${JSON.stringify(ask)}`)
  .replace('from "./daemon.js"', `from ${JSON.stringify(daemon)}`)
  .replace('from "./telemetry.js"', `from ${JSON.stringify(new URL('../src/telemetry.ts', import.meta.url).href)}`));
const extension = dataModule(transpile('../src/index.ts')
  .replace('from "typebox"', `from ${JSON.stringify(import.meta.resolve('typebox'))}`)
  .replace('from "./ask.js"', `from ${JSON.stringify(ask)}`)
  .replace('from "./bridge.js"', `from ${JSON.stringify(bridge)}`)
  .replace('from "./daemon.js"', `from ${JSON.stringify(daemon)}`)
  .replace('from "./automation.ts"', `from ${JSON.stringify(new URL('../src/automation.ts', import.meta.url).href)}`));

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('daemon-owned RPC automation can ask without activating a companion bridge', async () => {
  const { default: install } = await import(extension);
  const tools: Record<string, any> = {};
  install({ events: { on: () => {} }, on: () => {}, registerCommand: () => {}, registerTool: (tool: any) => { tools[tool.name] = tool; } });
  const original = process.env.PI_COMPANION_AUTOMATION_RUN_ID;
  const sockets = state.sockets.length, probes = state.probes;
  const dialogs: string[] = [];
  const ctx = { mode: 'rpc', ui: {
    select: async (title: string) => { dialogs.push(title); return 'Ship'; },
    confirm: async (_title: string, message: string) => message.includes('One'),
    input: async (title: string) => { dialogs.push(title); return 'Custom'; }
  } };
  try {
    process.env.PI_COMPANION_AUTOMATION_RUN_ID = 'run-123';
    const result = await tools.companion_ask_user.execute('tool', { questions: [
      { question: 'Release?', options: ['Ship', 'Wait'] },
      { question: 'Targets?', options: ['One', 'Two'], multiSelect: true, allowCustom: false },
      { question: 'Notes?' }
    ] }, undefined, undefined, ctx);
    assert.equal(Object.values(result.details.answers).flat().join(','), 'Ship,One,Custom');
    assert.equal(state.sockets.length, sockets);
    assert.equal(state.probes, probes);
    delete process.env.PI_COMPANION_AUTOMATION_RUN_ID;
    const inactive = await tools.companion_ask_user.execute('tool', { question: 'Release?' }, undefined, undefined, ctx);
    assert.match(inactive.content[0].text, /not enabled/);
  } finally {
    if (original === undefined) delete process.env.PI_COMPANION_AUTOMATION_RUN_ID; else process.env.PI_COMPANION_AUTOMATION_RUN_ID = original;
  }
});

test('real extension remains inert until /companion and resets activation on session switch', async () => {
  const { default: install } = await import(extension);
  const events: Record<string, (event: any, ctx: any) => any> = {};
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const notices: string[] = [];
  let prompts = 0;
  let sessionName: string | undefined = 'Workspace polish';
  const bus: Record<string, (data: any) => void> = {};
  const ctx = {
    cwd: '/project/demo', hasUI: true, isIdle: () => true,
    model: { id: 'initial-model' } as { id: string } | undefined, thinkingLevel: 'medium' as string | undefined,
    ui: {
      notify: (message: string) => notices.push(message),
      select: async () => undefined, confirm: async () => false,
      input: async () => undefined, custom: async () => undefined,
      setStatus: (_key: string, _value: string | undefined) => {}
    }
  };
  const originalSelect = ctx.ui.select;
  const originalStatus = ctx.ui.setStatus;
  install({
    getSessionName: () => sessionName,
    events: { on: (channel: string, fn: any) => { bus[channel] = fn; }, emit: () => {} },
    sendUserMessage: async () => { prompts++; },
    on: (name: string, fn: any) => { events[name] = fn; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    registerTool: (tool: any) => { tools[tool.name] = tool; }
  });
  events.session_start({}, ctx);
  events.agent_start({}, ctx);
  events.agent_end({}, ctx);
  events.model_select({}, ctx);
  await commands['remote-control'].handler('', ctx);
  await commands.companion.handler('off', ctx);
  await nextTurn();
  assert.equal(state.probes, 0);
  assert.equal(state.sockets.length, 0);
  assert.equal(ctx.ui.select, originalSelect, 'dialog wrappers are deferred too');

  await commands.companion.handler('', ctx);
  await nextTurn();
  assert.ok(state.probes > 0);
  assert.equal(state.sockets.length, 1);
  const live = state.sockets[0];
  live.readyState = 1;
  live.emit('open');
  assert.equal(live.frames[0].session.remoteEnabled, true);
  assert.equal(live.frames[0].session.shortTitle, 'Workspace polish', 'existing Pi names survive session startup');
  assert.equal(live.frames[0].session.name, 'Workspace polish');
  assert.notEqual(ctx.ui.select, originalSelect);
  ctx.model = { id: 'new-model' };
  ctx.thinkingLevel = 'high';
  events.model_select({}, ctx);
  assert.equal(live.frames.at(-1).session.mainModel, 'new-model');
  assert.equal(live.frames.at(-1).session.effort, 'high');
  ctx.cwd = '/project/moved';
  events.thinking_level_select({}, ctx);
  assert.equal(live.frames.at(-1).session.cwd, '/project/moved');
  sessionName = undefined;
  events.session_info_changed({}, ctx);
  assert.equal(live.frames.at(-1).session.name, null, 'cleared titles do not stick in the browser');
  assert.equal(live.frames.at(-1).session.shortTitle, 'moved');
  bus['companion:telemetry']({ source: 'quota-extension', providers: [{ provider: 'codex', weekly: { usedPercent: 25 } }] });
  assert.equal(live.frames.at(-1).session.telemetry.providers[0].weekly.usedPercent, 25);
  bus['session:usage']({ source: 'other-footer', cost: { amount: 1.25 }, context: { percent: 40 } });
  assert.equal(live.frames.at(-1).session.telemetry.cost.amount, 1.25);
  assert.equal(live.frames.at(-1).session.telemetry.providers[0].provider, 'codex');
  const beforeWrongSession = live.frames.length;
  bus['companion:telemetry']({ sessionId: 'some-other-session', cost: 999 });
  assert.equal(live.frames.length, beforeWrongSession);
  ctx.ui.setStatus('another-footer', 'ctx 51% | cost $2.50');
  sessionName = 'Auto refreshed while idle';
  ctx.cwd = '/project/idle-move';
  ctx.model = { id: 'idle-model' };
  ctx.thinkingLevel = 'low';
  await new Promise(resolve => setTimeout(resolve, 1100));
  const refreshed = live.frames.at(-1).session;
  assert.equal(refreshed.name, sessionName);
  assert.equal(refreshed.cwd, ctx.cwd);
  assert.equal(refreshed.mainModel, 'idle-model');
  assert.equal(refreshed.effort, 'low');
  assert.equal(refreshed.telemetry.cost.amount, 2.5);
  assert.equal(refreshed.telemetry.context, undefined, 'switching models invalidates old extension context estimates');
  ctx.ui.setStatus('another-footer', 'ctx 51% | cost $2.50');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(live.frames.at(-1).session.telemetry.context.percent, 51);
  events.session_compact({}, ctx);
  assert.equal(live.frames.at(-1).session.telemetry.context, undefined, 'compaction clears fallback context when native usage is unavailable');
  assert.equal(live.frames.at(-1).session.telemetry.cost.amount, 2.5);
  ctx.model = undefined;
  ctx.thinkingLevel = undefined;
  events.model_select({}, ctx);
  assert.equal(live.frames.at(-1).session.mainModel, null, 'missing models explicitly clear browser metadata');
  assert.equal(live.frames.at(-1).session.effort, null, 'missing effort explicitly clears browser metadata');
  const unchanged = live.frames.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(live.frames.length, unchanged, 'unchanged idle metadata does not flood the transport');
  await commands.companion.handler('', ctx);
  assert.equal(state.sockets.length, 1, 'repeated activation does not duplicate sockets');

  const probes = state.probes;
  await commands['remote-control'].handler('', ctx);
  assert.deepEqual(live.frames.at(-1).session, { remoteEnabled: false, status: 'stopped' });
  assert.equal(live.readyState, 3, 'remote off closes the daemon channel so local UI ends the session too');
  assert.equal(ctx.ui.select, originalSelect, 'remote off restores local dialogs');
  assert.equal(ctx.ui.setStatus, originalStatus, 'remote off restores extension status producers');
  live.emit('message', JSON.stringify({ type: 'command', command: { type: 'prompt', text: 'stale control' } }));
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(prompts, 0, 'retired transport cannot execute queued controls');
  assert.equal(state.probes, probes);
  assert.equal(state.sockets.length, 1, 'disabled sharing never reconnects itself');
  await commands['remote-control'].handler('', ctx);
  await nextTurn();
  const resumed = state.sockets[1];
  resumed.readyState = 1;
  resumed.emit('open');
  assert.equal(resumed.frames[0].session.remoteEnabled, true);
  assert.equal(resumed.frames[0].session.status, 'idle');
  assert.notEqual(ctx.ui.select, originalSelect);
  live.emit('close');
  assert.equal(state.sockets.length, 2, 'stale close cannot replace the resumed channel');
  await commands.companion.handler('off', ctx);
  assert.equal(resumed.readyState, 3, '/companion off has the same end-sharing semantics');
  events.session_start({}, ctx);
  assert.equal(ctx.ui.select, originalSelect, 'switch restores terminal dialogs');
  await commands['remote-control'].handler('', ctx);
  events.agent_start({}, ctx);
  await nextTurn();
  assert.equal(state.probes, probes, 'new session does not inherit daemon opt-in');
  assert.equal(state.sockets.length, 2);
  assert.equal(live.readyState, 3);
  state.deferProbe = true;
  const pendingEnable = commands.companion.handler('', ctx);
  await nextTurn();
  assert.ok(state.resolveProbe);
  await commands.companion.handler('off', ctx);
  state.deferProbe = false;
  state.resolveProbe();
  await pendingEnable;
  await nextTurn();
  assert.equal(state.sockets.length, 2, 'a late daemon probe cannot undo a newer sharing-off command');
  assert.equal(ctx.ui.select, originalSelect);
  events.session_shutdown({}, ctx);
  delete (globalThis as any).__companionLifecycleTest;
});
