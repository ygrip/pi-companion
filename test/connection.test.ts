import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveConnection, type Connection } from '../ui/src/lib/connection.ts';

class Socket {
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  sent: string[] = [];
  closed = false;
  send(text: string) { this.sent.push(text); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

function setup() {
  const sockets: Socket[] = [];
  const states: Connection[] = [];
  const messages: string[] = [];
  let enabled = true, online = 0, lost = 0, revoked = 0;
  const live = new LiveConnection({
    enabled: () => enabled,
    create: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    state: (state) => states.push(state),
    online: () => { online++; },
    message: (data) => messages.push(data),
    lost: () => { lost++; },
    revoked: () => { revoked++; enabled = false; }
  });
  return { live, sockets, states, messages, counts: () => ({ online, lost, revoked }), disable: () => { enabled = false; } };
}

test('network loss retries with bounded backoff and never replays commands', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.live.start();
  s.sockets[0].open();
  assert.equal(s.live.send('prompt-once'), true);
  s.sockets[0].drop();
  assert.equal(s.live.send('not-queued'), false);
  t.mock.timers.tick(1000);
  assert.equal(s.sockets.length, 2);
  s.sockets[1].drop();
  t.mock.timers.tick(1999);
  assert.equal(s.sockets.length, 2);
  t.mock.timers.tick(1);
  s.sockets[2].open();
  assert.deepEqual(s.sockets[2].sent, []);
  assert.equal(s.counts().online, 2);
  s.live.stop();
});

test('a silent OPEN socket times out; heartbeat messages keep it alive', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.live.start();
  const old = s.sockets[0];
  old.open();
  t.mock.timers.tick(30_000);
  old.onmessage?.({ data: '{"type":"ping"}' });
  t.mock.timers.tick(30_000);
  assert.equal(old.closed, false);
  t.mock.timers.tick(15_000);
  assert.equal(old.closed, true);
  assert.equal(s.states.at(-1), 'offline');
  t.mock.timers.tick(1000);
  assert.equal(s.sockets.length, 2);
  s.live.stop();
});

test('hung handshake retries and socket creation failure does not wedge recovery', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.live.start();
  t.mock.timers.tick(15_000);
  assert.equal(s.sockets[0].closed, true);
  t.mock.timers.tick(1000);
  assert.equal(s.sockets.length, 2);
  s.live.stop();
  let attempts = 0;
  const failing = new LiveConnection({ enabled: () => true, create: () => { attempts++; throw new Error('offline'); }, state: () => {}, online: () => {}, message: () => {}, lost: () => {}, revoked: () => {} });
  failing.start();
  t.mock.timers.tick(1000);
  assert.equal(attempts, 2);
  failing.stop();
});

test('foreground recovery retires the old socket and ignores late callbacks', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.live.start();
  s.live.start();
  assert.equal(s.sockets.length, 1);
  const old = s.sockets[0];
  old.open();
  s.live.resume();
  assert.equal(old.closed, true);
  assert.equal(s.sockets.length, 2);
  s.sockets[1].open();
  old.onopen?.();
  old.onmessage?.({ data: 'stale' });
  old.onclose?.({ code: 4003 });
  assert.deepEqual(s.messages, []);
  assert.deepEqual(s.counts(), { online: 2, lost: 0, revoked: 0 });
  assert.equal(s.states.at(-1), 'online');
  s.live.stop();
});

test('administrator disconnect needs explicit retry; revoked access stays disabled', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.live.start();
  s.sockets[0].open();
  s.sockets[0].drop(4001);
  s.live.resume();
  s.live.start();
  t.mock.timers.tick(60_000);
  assert.equal(s.sockets.length, 1);
  assert.equal(s.states.at(-1), 'disconnected');
  s.live.reconnect();
  assert.equal(s.sockets.length, 2);
  s.sockets[1].open();
  s.sockets[1].drop(4003);
  s.live.resume();
  s.live.reconnect();
  t.mock.timers.tick(60_000);
  assert.equal(s.sockets.length, 2);
  assert.equal(s.counts().revoked, 1);
  assert.equal(s.states.at(-1), 'revoked');
  s.live.stop();
});

test('stopping removes watchdogs/retries and disabled clients never open a socket', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.disable();
  s.live.start();
  assert.equal(s.sockets.length, 0);
  const active = setup();
  active.live.start();
  active.sockets[0].drop();
  active.live.stop();
  t.mock.timers.tick(60_000);
  assert.equal(active.sockets.length, 1);
});
