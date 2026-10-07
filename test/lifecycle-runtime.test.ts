import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Execute the real extension and bridge with an in-memory transport and daemon spy.
const dataModule = (source: string) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const state = { probes: 0, sockets: [] as any[] };
(globalThis as any).__companionLifecycleTest = state;
const daemon = dataModule(`
  export function adminHttpUrl() { return 'http://localhost:43721'; }
  export async function ensureDaemon() { globalThis.__companionLifecycleTest.probes++; return true; }
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
  .replace('from "./daemon.js"', `from ${JSON.stringify(daemon)}`));
const extension = dataModule(transpile('../src/index.ts')
  .replace('from "typebox"', `from ${JSON.stringify(import.meta.resolve('typebox'))}`)
  .replace('from "./ask.js"', `from ${JSON.stringify(ask)}`)
  .replace('from "./bridge.js"', `from ${JSON.stringify(bridge)}`)
  .replace('from "./daemon.js"', `from ${JSON.stringify(daemon)}`));

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('real extension remains inert until /companion and resets activation on session switch', async () => {
  const { default: install } = await import(extension);
  const events: Record<string, (event: any, ctx: any) => any> = {};
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const notices: string[] = [];
  const ctx = {
    cwd: '/project/demo', hasUI: true, isIdle: () => true,
    ui: {
      notify: (message: string) => notices.push(message),
      select: async () => undefined, confirm: async () => false,
      input: async () => undefined, custom: async () => undefined
    }
  };
  const originalSelect = ctx.ui.select;
  install({
    getSessionName: () => 'Workspace polish',
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
  await commands.companion.handler('', ctx);
  assert.equal(state.sockets.length, 1, 'repeated activation does not duplicate sockets');

  const probes = state.probes;
  events.session_start({}, ctx);
  assert.equal(ctx.ui.select, originalSelect, 'switch restores terminal dialogs');
  await commands['remote-control'].handler('', ctx);
  events.agent_start({}, ctx);
  await nextTurn();
  assert.equal(state.probes, probes, 'new session does not inherit daemon opt-in');
  assert.equal(state.sockets.length, 1);
  assert.equal(live.readyState, 3);
  events.session_shutdown({}, ctx);
  delete (globalThis as any).__companionLifecycleTest;
});
