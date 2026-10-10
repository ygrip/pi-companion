import assert from 'node:assert/strict';
import test from 'node:test';
import { PopupRelay } from '../src/popup.ts';
import { terminalSpans, popupKey } from '../ui/src/lib/terminal-popup.ts';
import type { TerminalPopup } from '../src/protocol.ts';

test('custom component frames, remote input, local completion and stale ids', async () => {
  let frames: TerminalPopup[] = [];
  let renders = 0;
  let value = 'first';
  const answers: unknown[] = [];
  let done!: (value: unknown) => void;
  const relay = new PopupRelay(next => { frames = next; });
  const component = { invalidate() {}, render: (width: number) => [value + width], handleInput: (data: string) => { value = data; } };
  const wrapped = await relay.wrap((_tui, _theme, _keys, finish) => { done = finish; return component; })(
    { requestRender() { renders++; } } as never, {} as never, {} as never, result => answers.push(result)
  );
  assert.equal(wrapped, component);
  assert.deepEqual(wrapped.render(80), ['first80']);
  const id = frames[0].id;
  relay.input('stale', 'ignored');
  relay.input(id, 'next');
  assert.equal(renders, 1);
  wrapped.render(80);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(frames[0].lines, ['next80']);
  done('selected');
  assert.deepEqual(frames, []);
  relay.close(id);
  done('twice');
  assert.deepEqual(answers, ['selected']);
});

test('remote close uses the component cancellation result, disposal restores local behavior, sharing stop does not close', async () => {
  let frames: TerminalPopup[] = [];
  let disposed = 0;
  const answers: unknown[] = [];
  const relay = new PopupRelay(next => { frames = next; });
  const create = () => relay.wrap((_tui, _theme, _keys, done) => ({ invalidate() {}, render: () => ['hello'], handleInput(data) { if (data === '\x1b') done({ kind: 'cancel' }); }, dispose() { disposed++; } }))(
    { requestRender() {} } as never, {} as never, {} as never, value => answers.push(value)
  );
  const first = await create();
  first.render(80);
  relay.close(frames[0].id);
  assert.deepEqual(answers, [{ kind: 'cancel' }]);
  first.dispose?.();
  assert.equal(disposed, 1);
  const second = await create();
  second.render(80);
  relay.clear();
  second.render(80);
  assert.deepEqual(frames, []);
  assert.equal(answers.length, 1);
  second.dispose?.();
  assert.equal(disposed, 2);
});

test('async factories and completion before factory returns do not leave phantom popups', async () => {
  let frames: TerminalPopup[] = [];
  const relay = new PopupRelay(next => { frames = next; });
  const component = await relay.wrap(async (_tui, _theme, _keys, done) => {
    done('ready');
    return { invalidate() {}, render: () => ['gone'] };
  })({} as never, {} as never, {} as never, () => {});
  component.render(80);
  assert.deepEqual(frames, []);
});

test('ending sharing while an async factory loads does not publish a late popup', async () => {
  let frames: TerminalPopup[] = [];
  const relay = new PopupRelay(next => { frames = next; });
  let ready!: () => void;
  const gate = new Promise<void>(resolve => { ready = resolve; });
  const pending = relay.wrap(async () => { await gate; return { invalidate() {}, render: () => ['late'] }; })(
    {} as never, {} as never, {} as never, () => {}
  );
  relay.clear();
  ready();
  const component = await pending;
  component.render(80);
  assert.deepEqual(frames, []);
});

test('ANSI text is safe, colors and selection survive, terminal controls are discarded', () => {
  const spans = terminalSpans('\x1b[1;38;2;100;120;140m<b>text</b>\x1b[0m normal\x1b[7m selected');
  assert.equal(spans[0].text, '<b>text</b>');
  assert.equal(spans[0].color, 'rgb(100,120,140)');
  assert.equal(spans[0].bold, true);
  assert.equal(spans[1].bold, false);
  assert.equal(spans[2].inverse, true);
  assert.equal(terminalSpans('\x1b]52;c;secret\x07safe\x1b[2J').map(s => s.text).join(''), 'safe');
});

test('keyboard forwards terminal sequences, not browser shortcuts', () => {
  const event = (key: string, ctrlKey = false) => ({ key, ctrlKey, altKey: false, metaKey: false });
  assert.equal(popupKey(event('ArrowUp')), '\x1b[A');
  assert.equal(popupKey(event('Enter')), '\r');
  assert.equal(popupKey(event('c', true)), '\x03');
  assert.equal(popupKey({ ...event('a'), metaKey: true }), undefined);
});
