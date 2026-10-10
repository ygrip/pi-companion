<script lang="ts">
  import { companion } from './companion.svelte.ts';
  import Icon from './Icon.svelte';
  import { terminalSpans, popupKey } from './terminal-popup.ts';
  import type { TerminalPopup } from './types.ts';

  let { sessionId, popups }: { sessionId: string; popups: TerminalPopup[] } = $props();
  let dialog = $state<HTMLDialogElement>();
  let screen = $state<HTMLDivElement>();
  let text = $state('');
  let fontSize = $state(13);
  let error = $state('');
  const popup = $derived(popups[popups.length - 1]);
  const connected = $derived(companion.connection === 'online' && Boolean(companion.session(sessionId)?.remoteEnabled));
  const directionKeys = [
    { label: '↑', name: 'Move up', data: '\x1b[A' }, { label: '↓', name: 'Move down', data: '\x1b[B' },
    { label: '←', name: 'Move left', data: '\x1b[D' }, { label: '→', name: 'Move right', data: '\x1b[C' }
  ];
  const extraKeys = [
    { label: 'Tab', data: '\t' }, { label: 'Shift + Tab', data: '\x1b[Z' },
    { label: 'Space', data: ' ' }, { label: 'Backspace', data: '\x7f' },
    { label: 'Page up', data: '\x1b[5~' }, { label: 'Page down', data: '\x1b[6~' }
  ];

  $effect(() => {
    if (popup && dialog && !dialog.open) { dialog.showModal(); screen?.focus(); }
    if (!popup && dialog?.open) dialog.close();
  });
  let current = '';
  $effect(() => {
    if ((popup?.id ?? '') === current) return;
    current = popup?.id ?? '';
    text = '';
    error = '';
    if (screen) { screen.scrollTop = 0; screen.scrollLeft = 0; }
  });
  function send(data: string, close = false) {
    if (!popup) return false;
    const sent = companion.send(sessionId, close
      ? { type: 'popup_close', popupId: popup.id }
      : { type: 'popup_input', popupId: popup.id, data });
    error = sent ? '' : 'Not connected. Your text is kept here; reconnect and try again.';
    return sent;
  }
  function key(event: KeyboardEvent) {
    if (event.isComposing || event.defaultPrevented || event.target !== screen) return;
    // Tab moves focus to the accessible controls; the Tab button sends a terminal Tab.
    if (event.key === 'Tab') return;
    const data = popupKey(event);
    if (data) { event.preventDefault(); send(data); }
  }
  function scrollView(direction: number) {
    screen?.scrollBy({ top: direction * screen.clientHeight * 0.8, behavior: 'instant' });
  }
</script>

<dialog class="clay popup" bind:this={dialog} aria-labelledby="terminal-popup-title" aria-describedby="terminal-popup-help"
  oncancel={(event) => { event.preventDefault(); send('\x1b'); }} onkeydown={key}>
  <div class="popup-layout">
    <header>
      <div class="heading">
        <span class="clay-well"><Icon name="sessions" size={22} /></span>
        <div><h2 id="terminal-popup-title">Pi popup</h2><span class="connection"><i class:offline={!connected}></i>{connected ? 'Connected to your terminal' : 'Waiting for connection'}</span></div>
      </div>
      <button class="btn close" onclick={() => send('', true)} disabled={!connected} title="Send Escape to close the terminal popup"><Icon name="close" /> Close</button>
    </header>

    <div class="popup-body">
      <p id="terminal-popup-help">Scroll to explore. Use the controls below to choose, type, or submit—just like in Pi.</p>
      <div class="viewer clay">
        <div class="viewer-toolbar">
          <span class="viewer-label">Terminal view</span>
          <div class="view-controls" role="group" aria-label="Terminal view controls">
            <button class="btn" aria-label="Smaller terminal text" disabled={fontSize <= 10} onclick={() => fontSize--}>A−</button>
            <span class="zoom">{fontSize}px</span>
            <button class="btn" aria-label="Larger terminal text" disabled={fontSize >= 22} onclick={() => fontSize++}>A+</button>
            <button class="btn" aria-label="Scroll view up" onclick={() => scrollView(-1)} title="Scroll view up">↑</button>
            <button class="btn" aria-label="Scroll view down" onclick={() => scrollView(1)} title="Scroll view down">↓</button>
          </div>
        </div>
        <div class="screen" bind:this={screen} tabindex="0" role="textbox" aria-readonly="true" aria-multiline="true"
          aria-label="Live terminal popup. Use arrow keys to interact, or Tab to reach the controls." style:--terminal-font-size={`${fontSize}px`}>
          {#each popup?.lines ?? [] as line}
            <div class="line">{#each terminalSpans(line) as span}<span style:color={span.inverse ? (span.background ?? '#151515') : span.color} style:background-color={span.inverse ? (span.color ?? '#dddddd') : span.background} style:font-weight={span.bold ? '700' : undefined}>{span.text}</span>{/each}{#if !line} {' '}{/if}</div>
          {/each}
          {#if !popup?.lines.length}<div class="waiting">Waiting for the popup to render…</div>{/if}
        </div>
        <div class="viewer-caption">Scroll vertically or sideways · Terminal layout preserved</div>
      </div>

      <div class="interaction">
        <div class="control-row">
          <div class="direction-keys" role="group" aria-label="Move terminal selection">
            {#each directionKeys as item}<button class="btn" disabled={!connected} aria-label={item.name} title={item.name} onclick={() => send(item.data)}>{item.label}</button>{/each}
          </div>
          <div class="action-keys">
            <button class="btn" disabled={!connected} onclick={() => send('\x1b')} title="Send Escape to the popup">Back / Esc</button>
            <button class="btn btn-primary" disabled={!connected} onclick={() => send('\r')}><Icon name="check" /> Enter / select</button>
          </div>
        </div>
        <details>
          <summary>More terminal keys</summary>
          <div class="extra-keys" role="group" aria-label="Additional terminal keys">
            {#each extraKeys as item}<button class="btn" disabled={!connected} onclick={() => send(item.data)}>{item.label}</button>{/each}
          </div>
        </details>
      </div>
    </div>

    <footer>
      <form onsubmit={(event) => { event.preventDefault(); if (text && send(text)) text = ''; }}>
        <label for="terminal-popup-text">Send text to Pi</label>
        <div class="text-row"><input id="terminal-popup-text" class="input" placeholder="Search or type an answer…" bind:value={text} maxlength="4096" autocomplete="off" />
          <button class="btn btn-primary" type="submit" disabled={!text || !connected}><Icon name="send" /> Send text</button></div>
      </form>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <p class="footer-hint">Send text types into the popup; Enter submits. Close sends Esc—the extension decides when to dismiss.</p>
    </footer>
  </div>
</dialog>

<style>
  .popup { width: min(1000px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); margin: auto; padding: 0; overflow: hidden; color: var(--text); }
  .popup::backdrop { background: rgb(0 0 0 / 0.65); }
  .popup-layout { display: flex; flex-direction: column; max-height: calc(100dvh - 34px); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 24px; border-bottom: 1px solid var(--border); flex: none; }
  .heading { display: flex; align-items: center; gap: 12px; min-width: 0; }
  h2 { font-size: 18px; margin: 0 0 4px; letter-spacing: -0.02em; }
  .connection { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
  .connection i { width: 6px; height: 6px; border-radius: 50%; background: #8ed28e; }
  .connection i.offline { background: var(--text-2); }
  .popup-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 18px 24px; scrollbar-gutter: stable; }
  p { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-2); }
  #terminal-popup-help { margin-bottom: 14px; }
  .viewer { overflow: hidden; border-radius: 18px; }
  .viewer-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; background: var(--surface-2); }
  .viewer-label { font-size: 12px; font-weight: 600; color: var(--text-2); }
  .view-controls { display: flex; align-items: center; gap: 6px; }
  .zoom { font-size: 12px; min-width: 32px; text-align: center; color: var(--text-2); }
  .screen { overflow: auto; max-height: min(48dvh, 560px); min-height: 100px; padding: 16px; background: #101010; color: #ddd; box-shadow: inset 0 3px 12px #0007; overscroll-behavior: contain; scrollbar-gutter: stable; scrollbar-color: #666 #1b1b1f; scrollbar-width: auto; outline-offset: -3px; }
  .screen::-webkit-scrollbar { width: 12px; height: 12px; }
  .screen::-webkit-scrollbar-thumb { background: #666; border: 3px solid #1b1b1f; border-radius: 12px; }
  .screen::-webkit-scrollbar-track, .screen::-webkit-scrollbar-corner { background: #1b1b1f; }
  .line { white-space: pre; min-height: 1.55em; font: var(--terminal-font-size)/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .waiting { font: 13px/1.5 ui-monospace, monospace; color: #aaa; }
  .viewer-caption { padding: 8px 12px; font-size: 11px; color: var(--text-2); background: var(--surface-2); }
  .interaction { margin-top: 16px; }
  .control-row, .direction-keys, .action-keys, .extra-keys { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .control-row { justify-content: space-between; gap: 12px; }
  .direction-keys .btn { font-size: 19px; padding: 8px; }
  .btn { min-width: 44px; min-height: 44px; flex: none; }
  .btn:focus-visible, input:focus-visible, summary:focus-visible, .screen:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .screen:focus-visible { outline-offset: -3px; }
  details { margin-top: 12px; border-radius: 12px; background: var(--surface-2); box-shadow: var(--clay-pressed); }
  summary { cursor: pointer; padding: 12px; min-height: 44px; font-size: 12px; color: var(--text-2); }
  .extra-keys { padding: 0 12px 12px; }
  footer { flex: none; padding: 16px 24px 20px; border-top: 1px solid var(--border); background: var(--surface-2); }
  label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 8px; }
  .text-row { display: flex; gap: 8px; }
  input { flex: 1; min-width: 0; min-height: 44px; font-size: 16px; }
  .footer-hint { margin-top: 8px; font-size: 11px; }
  .error { margin-top: 8px; color: var(--danger); }
  @media (max-width: 600px) {
    .popup { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); border-radius: 20px; }
    .popup-layout { max-height: calc(100dvh - 18px); }
    header { padding: 16px; gap: 8px; }
    .popup-body { padding: 14px 16px; }
    footer { padding: 14px 16px max(14px, env(safe-area-inset-bottom)); }
    .clay-well { width: 32px; height: 32px; }
    h2 { font-size: 16px; }
    .connection { font-size: 11px; }
    .screen { padding: 12px; max-height: 40dvh; }
    .control-row { flex-direction: column; align-items: stretch; }
    .direction-keys .btn, .action-keys .btn { flex: 1; }
    .viewer-toolbar { padding: 8px; }
    .viewer-label { display: none; }
    .view-controls { width: 100%; justify-content: space-between; }
    .footer-hint { font-size: 10px; }
  }
  @media (max-height: 500px) { header, footer { padding: 10px 16px; } .screen { max-height: 35dvh; } .footer-hint { display: none; } }
  @media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
</style>
