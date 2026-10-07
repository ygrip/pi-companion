<script lang="ts">
  import { onMount } from 'svelte';
  import DotField from '$lib/DotField.svelte';
  import { createApi, type PairedDevice, type Session, type TempFile } from '$lib/api';
  import { pushUser, reduceBridgeMessage, type ActivityEntry, type AskRequest } from '$lib/activity';
  import '../app.css';

  let remote = false;
  let token: string | null = null;
  let paired = true;
  let sessions: Session[] = [];
  let devices: PairedDevice[] = [];
  let files: TempFile[] = [];
  let selectedId: string | null = null;
  let ws: WebSocket | null = null;
  let activity: ActivityEntry[] = [];
  let asks: AskRequest[] = [];
  let askDrafts: Record<string, string> = {};
  let connection: 'connecting' | 'online' | 'offline' = 'connecting';
  let followTail = true;
  let terminalBody: HTMLDivElement;
  let prompt = '';
  let steer = false;
  let activeTab: 'activity' | 'files' | 'diff' | 'plan' = 'activity';
  let diff = '';
  let plan = '';
  let pairing: { code: string; url: string; qrSvg: string } | null = null;
  let deviceName = 'Phone';
  let pairError = '';
  let uploadInput: HTMLInputElement;

  $: selected = sessions.find((session) => session.id === selectedId) ?? null;
  $: api = createApi(remote, token);

  function formatBytes(bytes: number) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MiB';
  }

  function sessionLabel(session: Session) {
    return session.name || session.shortTitle || 'Pi session';
  }

  function onTerminalScroll() {
    if (!terminalBody) return;
    followTail = terminalBody.scrollHeight - terminalBody.scrollTop - terminalBody.clientHeight < 40;
  }

  function scrollToTail() {
    if (!followTail || !terminalBody) return;
    requestAnimationFrame(() => terminalBody && (terminalBody.scrollTop = terminalBody.scrollHeight));
  }

  function answerAsk(requestId: string, answer: string) {
    const text = answer.trim();
    if (!text) return;
    send({ type: 'ask_answer', requestId, answer: text });
    asks = asks.filter((ask) => ask.requestId !== requestId);
    delete askDrafts[requestId];
    activity = pushUser(activity, 'answer', text);
  }

  function onTabKey(event: KeyboardEvent) {
    const order: (typeof activeTab)[] = ['activity', 'files', 'diff', 'plan'];
    const index = order.indexOf(activeTab);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % order.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + order.length) % order.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = order.length - 1;
    else return;
    event.preventDefault();
    switchTab(order[next]);
    document.getElementById('tab-' + order[next])?.focus();
  }

  function onComposerKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitPrompt();
    }
  }

  async function refreshSessions() {
    const result = await api.request<{ sessions: Session[] }>('/api/sessions');
    sessions = result.sessions;
    if (selectedId && !sessions.some((s) => s.id === selectedId)) selectedId = null;
    if (!selectedId && sessions.length) selectedId = sessions[0].id;
  }

  async function refreshDevices() {
    if (remote) return;
    const result = await api.request<{ devices: PairedDevice[] }>('/api/devices');
    devices = result.devices;
  }

  async function refreshFiles() {
    if (!selectedId || selected?.status === 'stopped') {
      files = [];
      return;
    }
    const result = await api.request<{ files: TempFile[] }>(
      '/api/sessions/' + encodeURIComponent(selectedId) + '/files'
    );
    files = result.files;
  }

  function send(command: Record<string, unknown>) {
    if (!selectedId || selected?.status === 'stopped' || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ sessionId: selectedId, command }));
  }

  async function selectSession(id: string) {
    selectedId = id;
    activity = [];
    asks = [];
    followTail = true;
    diff = '';
    activeTab = 'activity';
    await refreshFiles().catch(() => {});
  }

  function connect() {
    if (remote && !token) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = remote
      ? new WebSocket(proto + '//' + location.host + '/ws/browser', ['pi-companion', 'token.' + token])
      : new WebSocket(proto + '//' + location.host + '/ws/browser');

    connection = 'connecting';
    ws.onopen = () => (connection = 'online');
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'session.register') {
        const next = message.session as Session;
        if (!remote || next.remoteEnabled) sessions = [...sessions.filter((s) => s.id !== next.id), next];
      } else if (message.type === 'session.update') {
        if (remote && message.patch?.remoteEnabled && !sessions.some((s) => s.id === message.sessionId)) {
          void refreshSessions().catch(() => {});
        }
        sessions = sessions
          .map((s) => s.id === message.sessionId ? { ...s, ...message.patch } : s)
          .filter((s) => !remote || s.remoteEnabled);
      } else if (message.type === 'files.update' && message.sessionId === selectedId) {
        files = message.files;
      } else if (message.type === 'devices.update') {
        void refreshDevices();
      } else if (message.type === 'bridge.event' && message.sessionId === selectedId) {
        const inner = message.message;
        if (inner.type === 'git.diff') diff = inner.diff || '(clean)';
        else if (inner.type === 'ask.request') {
          asks = [...asks.filter((a) => a.requestId !== inner.requestId), inner as AskRequest];
        } else {
          const next = reduceBridgeMessage(activity, inner);
          if (next !== activity) {
            activity = next;
            scrollToTail();
          }
        }
      }
    };
    ws.onclose = () => {
      connection = 'offline';
      setTimeout(connect, 1500);
    };
  }

  async function startPairing() {
    pairing = await api.request('/api/pairing/start', { method: 'POST' });
  }

  async function claimPairing(invite: string) {
    pairError = '';
    try {
      const response = await fetch('/api/pairing/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ invite, deviceName })
      });
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json();
      localStorage.setItem('piCompanionDeviceToken', result.token);
      location.replace('/');
    } catch (error) {
      pairError = String(error instanceof Error ? error.message : error);
    }
  }

  async function revokeDevice(id: string) {
    await api.request('/api/devices/' + encodeURIComponent(id), { method: 'DELETE' });
    await refreshDevices();
  }

  async function upload() {
    const file = uploadInput?.files?.[0];
    if (!file || !selectedId) return;
    const data = new FormData();
    data.append('file', file);
    await api.request('/api/sessions/' + encodeURIComponent(selectedId) + '/files', {
      method: 'POST',
      body: data
    });
    uploadInput.value = '';
    await refreshFiles();
  }

  async function removeFile(id: string) {
    if (!selectedId) return;
    await api.request(
      '/api/sessions/' + encodeURIComponent(selectedId) + '/files/' + encodeURIComponent(id),
      { method: 'DELETE' }
    );
    await refreshFiles();
  }

  function submitPrompt() {
    const text = prompt.trim();
    if (!text) return;
    send({ type: steer ? 'steer' : 'prompt', text });
    activity = pushUser(activity, steer ? 'steer' : 'prompt', text);
    followTail = true;
    scrollToTail();
    prompt = '';
  }

  function switchTab(tab: typeof activeTab) {
    activeTab = tab;
    if (tab === 'files') void refreshFiles();
    if (tab === 'diff') send({ type: 'git_diff', staged: false });
  }

  onMount(async () => {
    const context = await fetch('/api/context').then((r) => r.json());
    remote = Boolean(context.remote);
    token = localStorage.getItem('piCompanionDeviceToken');

    const invite = new URLSearchParams(location.search).get('invite');
    if (remote && invite && !token) {
      paired = false;
      deviceName = /Mobile|Android|iPhone/i.test(navigator.userAgent) ? 'Phone' : 'Browser';
      return;
    }
    if (remote && !token) {
      paired = false;
      return;
    }

    await refreshSessions();
    await refreshDevices();
    await refreshFiles().catch(() => {});
    connect();
  });
</script>

<svelte:head>
  <title>Pi Companion</title>
  <meta name="description" content="Minimal remote control for Pi sessions" />
</svelte:head>

<a class="skip-link" href="#main">Skip to session</a>
<div class="app-shell">
  <section class="hero bento">
    <DotField />
    <div class="hero-copy">
      <div class="brand-row">
        <div class="mark">π</div>
        <div>
          <span class="eyebrow">PI COMPANION</span>
          <h1>Sessions, without the terminal leash.</h1>
        </div>
      </div>
      <p>Lightweight remote control for live Pi sessions, plans, diffs, files and user input.</p>
    </div>
    <div class="hero-status" role="status">
      <span class="status-dot {connection}" aria-hidden="true"></span>
      {remote ? 'PAIRED DEVICE' : 'LOCAL ADMIN'} · {connection === 'online' ? 'LIVE' : connection === 'connecting' ? 'CONNECTING' : 'RECONNECTING'}
    </div>
  </section>

  {#if !paired}
    <section class="pair-card bento">
      {#if new URLSearchParams(location.search).get('invite')}
        <span class="eyebrow">PAIR DEVICE</span>
        <h2>Connect this device</h2>
        <p>The invitation is single-use and expires after five minutes.</p>
        <label class="field-label" for="device-name">Device name</label>
        <input id="device-name" bind:value={deviceName} maxlength="80" autocomplete="off" />
        <button class="primary" onclick={() => claimPairing(new URLSearchParams(location.search).get('invite')!)}>Pair device</button>
        {#if pairError}<p class="error">{pairError}</p>{/if}
      {:else}
        <span class="eyebrow">NOT PAIRED</span>
        <h2>This device needs an invitation.</h2>
        <p>Open Pi Companion locally and scan a fresh pairing QR.</p>
      {/if}
    </section>
  {:else}
    {#if !remote}
      <section class="device-bento">
        <article class="bento pair-panel">
          <div class="card-head">
            <div><span class="eyebrow">PAIRING</span><h2>Devices</h2></div>
            <button class="primary" onclick={startPairing}>Pair device</button>
          </div>
          {#if pairing}
            <div class="pairing">
              <div class="qr">{@html pairing.qrSvg}</div>
              <div>
                <strong class="pair-code">{pairing.code}</strong>
                <p>Scan with your phone. The invite expires in five minutes.</p>
                <code>{pairing.url}</code>
              </div>
            </div>
          {/if}
          <div class="device-list">
            {#if devices.length === 0}<p class="muted">No paired devices.</p>{/if}
            {#each devices as device (device.id)}
              <div class="device-row">
                <div><strong>{device.name}</strong><span>seen {new Date(device.lastSeen * 1000).toLocaleString()}</span></div>
                <button class="danger" aria-label={'Revoke ' + device.name} onclick={() => { if (confirm('Revoke ' + device.name + '? It will need to pair again.')) void revokeDevice(device.id); }}>Revoke</button>
              </div>
            {/each}
          </div>
        </article>
      </section>
    {/if}

    <div class="workspace">
      <aside class="session-rail bento">
        <div class="rail-head"><h2 class="eyebrow" id="sessions-heading">SESSIONS</h2><span>{sessions.length}</span></div>
        <nav class="session-list" aria-labelledby="sessions-heading">
          {#if sessions.length === 0}<p class="muted">No sessions registered. Start <code>pi</code> with the companion extension.</p>{/if}
          {#each sessions as session (session.id)}
            <button aria-current={selectedId === session.id ? 'true' : undefined} class:active={selectedId === session.id} class="session-card" onclick={() => selectSession(session.id)}>
              <div class="session-top">
                <span class="state-dot {session.status}" aria-hidden="true"></span>
                <strong>{session.shortTitle}</strong>
                <span class="state-label">{session.status}</span>
              </div>
              <span class="session-name">{session.name || 'Unnamed session'}</span>
              <span class="session-model">{session.mainModel || 'model'}{session.effort ? ' · ' + session.effort : ''}</span>
            </button>
          {/each}
        </nav>
      </aside>

      <main class="session-main" id="main" tabindex="-1">
        {#if selected}
          <section class="session-hero bento">
            <div>
              <span class="eyebrow">{selected.shortTitle}</span>
              <h2>{sessionLabel(selected)}</h2>
              <p>{selected.cwd}</p>
            </div>
            <div class="fact-row">
              <span class="pill"><i class="state-dot {selected.status}"></i>{selected.status}</span>
              <span class="pill">{selected.mainModel || 'unknown model'}</span>
              <span class="pill">{selected.effort || 'default effort'}</span>
              <span class="pill">{selected.remoteEnabled ? 'remote on' : 'local only'}</span>
            </div>
          </section>

          <section class="metrics">
            <article class="metric bento"><span>STATUS</span><strong>{selected.status}</strong><small>pid {selected.pid}</small></article>
            <article class="metric bento"><span>MODEL</span><strong>{selected.mainModel || 'Unknown'}</strong><small>{selected.effort || 'default effort'}</small></article>
            <article class="metric bento"><span>FILES</span><strong>{files.length}</strong><small>temporary sandbox</small></article>
          </section>

          <section class="terminal bento">
            <div class="terminal-head">
              <div class="terminal-lights" aria-hidden="true"><i></i><i></i><i></i></div>
              <div class="tabs" role="tablist" aria-label="Session views" tabindex="-1" onkeydown={onTabKey}>
                {#each [['activity', 'activity'], ['files', 'files'], ['diff', 'git diff'], ['plan', 'plan']] as [key, label] (key)}
                  <button
                    id={'tab-' + key}
                    role="tab"
                    aria-selected={activeTab === key}
                    aria-controls="terminal-panel"
                    tabindex={activeTab === key ? 0 : -1}
                    class:active={activeTab === key}
                    onclick={() => switchTab(key as typeof activeTab)}
                  >{label}{#if key === 'activity' && asks.length}<span class="badge" aria-label={asks.length + ' pending questions'}>{asks.length}</span>{/if}</button>
                {/each}
              </div>
              <button class="danger compact" disabled={selected.status === 'stopped'} onclick={() => send({ type: 'abort' })}>abort</button>
            </div>

            {#if asks.length}
              <div class="ask-stack" role="region" aria-label="Questions from Pi" aria-live="assertive">
                {#each asks as ask (ask.requestId)}
                  <form class="ask-card" aria-label="Question from Pi" onsubmit={(event) => { event.preventDefault(); answerAsk(ask.requestId, askDrafts[ask.requestId] ?? ''); }}>
                    <span class="eyebrow">PI IS ASKING</span>
                    <p class="ask-question">{ask.question}</p>
                    {#if ask.options?.length}
                      <div class="ask-options">
                        {#each ask.options as option (option)}
                          <button type="button" onclick={() => answerAsk(ask.requestId, option)}>{option}</button>
                        {/each}
                      </div>
                    {/if}
                    <div class="ask-input">
                      <label class="sr-only" for={'ask-' + ask.requestId}>Your answer</label>
                      <input id={'ask-' + ask.requestId} bind:value={askDrafts[ask.requestId]} placeholder="Type an answer…" autocomplete="off" />
                      <button class="primary" type="submit">Answer</button>
                    </div>
                  </form>
                {/each}
              </div>
            {/if}

            <div class="terminal-body" id="terminal-panel" role="tabpanel" aria-labelledby={'tab-' + activeTab} tabindex="0" bind:this={terminalBody} onscroll={onTerminalScroll}>
              {#if activeTab === 'activity'}
                {#if activity.length === 0}<p class="prompt-line"><span>π</span> waiting for activity…</p>{/if}
                <ol class="feed" aria-live="polite" aria-relevant="additions">
                  {#each activity as entry (entry.id)}
                    <li class="feed-entry {entry.kind} {entry.status ?? ''}">
                      <div class="feed-meta">
                        <span class="feed-kind">{entry.kind === 'user' ? '›' : entry.kind === 'tool' ? '⚙' : entry.kind === 'error' ? '!' : entry.kind === 'lifecycle' ? '·' : 'π'}</span>
                        <strong>{entry.title}</strong>
                        {#if entry.status}<span class="feed-status">{entry.status === 'running' ? 'running…' : entry.status}</span>{/if}
                        <time datetime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString()}</time>
                      </div>
                      {#if entry.body}<pre>{entry.body}</pre>{/if}
                    </li>
                  {/each}
                </ol>
              {:else if activeTab === 'files'}
                <div class="file-toolbar">
                  <label class="sr-only" for="upload-input">File to upload</label>
                  <input id="upload-input" bind:this={uploadInput} type="file" disabled={selected.status === 'stopped'} />
                  <button onclick={upload} disabled={selected.status === 'stopped'}>Upload</button>
                </div>
                <div class="file-grid">
                  {#if files.length === 0}<p class="muted">No temporary files.</p>{/if}
                  {#each files as file (file.id)}
                    <article class="file-card">
                      <div><strong>{file.name}</strong><span>{formatBytes(file.size)}</span></div>
                      <button class="danger compact" aria-label={'Delete ' + file.name} onclick={() => removeFile(file.id)}>Delete</button>
                    </article>
                  {/each}
                </div>
              {:else if activeTab === 'diff'}
                <div class="file-toolbar">
                  <button onclick={() => send({ type: 'git_diff', staged: false })} disabled={selected.status === 'stopped'}>Working tree</button>
                  <button onclick={() => send({ type: 'git_diff', staged: true })} disabled={selected.status === 'stopped'}>Staged</button>
                </div>
                <pre class="diff">{#each (diff || 'No diff loaded.').split('\n') as line, i (i)}<span class:add={line.startsWith('+') && !line.startsWith('+++')} class:del={line.startsWith('-') && !line.startsWith('---')} class:hunk={line.startsWith('@@')}>{line}
</span>{/each}</pre>
              {:else}
                <label class="field-label" for="plan-goal">Plan goal (optional)</label>
                <textarea id="plan-goal" bind:value={plan} placeholder="Describe what /plan should focus on" disabled={selected.status === 'stopped'}></textarea>
                <button onclick={() => send({ type: 'plan', text: plan })} disabled={selected.status === 'stopped'}>Run /plan</button>
              {/if}
            </div>

            <form class="composer" onsubmit={(event) => { event.preventDefault(); submitPrompt(); }}>
              <label class="sr-only" for="prompt-input">Prompt</label>
              <textarea id="prompt-input" bind:value={prompt} onkeydown={onComposerKey} placeholder={selected.status === 'stopped' ? 'Session stopped' : 'Prompt this session…'} disabled={selected.status === 'stopped'}></textarea>
              <div class="composer-actions">
                <label class="check"><input type="checkbox" bind:checked={steer} disabled={selected.status === 'stopped'} /> steer active turn</label>
                <span class="hint">⌘/Ctrl + Enter</span>
                <button class="primary" disabled={selected.status === 'stopped'}>Send</button>
              </div>
            </form>
          </section>
        {:else}
          <section class="empty bento"><div class="mark large">π</div><h2>Select a Pi session.</h2><p>Registered sessions will appear in the rail.</p></section>
        {/if}
      </main>
    </div>
  {/if}
</div>
