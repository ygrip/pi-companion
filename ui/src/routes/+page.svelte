<script lang="ts">
  import { onMount } from 'svelte';
  import DotField from '$lib/DotField.svelte';
  import { createApi, type PairedDevice, type Session, type TempFile } from '$lib/api';
  import '../app.css';

  let remote = false;
  let token: string | null = null;
  let paired = true;
  let sessions: Session[] = [];
  let devices: PairedDevice[] = [];
  let files: TempFile[] = [];
  let selectedId: string | null = null;
  let ws: WebSocket | null = null;
  let activity: string[] = [];
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

  function appendActivity(value: unknown) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    activity = [...activity.slice(-199), text];
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

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'session.register') {
        const next = message.session as Session;
        if (!remote || next.remoteEnabled) sessions = [...sessions.filter((s) => s.id !== next.id), next];
      } else if (message.type === 'session.update') {
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
        else appendActivity(inner);
      }
    };
    ws.onclose = () => setTimeout(connect, 1500);
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
    <div class="hero-status">
      <span class="status-dot"></span>
      {remote ? 'PAIRED DEVICE' : 'LOCAL ADMIN'}
    </div>
  </section>

  {#if !paired}
    <section class="pair-card bento">
      {#if new URLSearchParams(location.search).get('invite')}
        <span class="eyebrow">PAIR DEVICE</span>
        <h2>Connect this device</h2>
        <p>The invitation is single-use and expires after five minutes.</p>
        <input bind:value={deviceName} maxlength="80" aria-label="Device name" />
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
            {#each devices as device}
              <div class="device-row">
                <div><strong>{device.name}</strong><span>seen {new Date(device.lastSeen * 1000).toLocaleString()}</span></div>
                <button class="danger" onclick={() => revokeDevice(device.id)}>Revoke</button>
              </div>
            {/each}
          </div>
        </article>
      </section>
    {/if}

    <div class="workspace">
      <aside class="session-rail bento">
        <div class="rail-head"><span class="eyebrow">SESSIONS</span><span>{sessions.length}</span></div>
        <div class="session-list">
          {#if sessions.length === 0}<p class="muted">No sessions registered.</p>{/if}
          {#each sessions as session}
            <button class:active={selectedId === session.id} class="session-card" onclick={() => selectSession(session.id)}>
              <div class="session-top">
                <span class="state-dot {session.status}"></span>
                <strong>{session.shortTitle}</strong>
                <span class="state-label">{session.status}</span>
              </div>
              <span class="session-name">{session.name || 'Unnamed session'}</span>
              <span class="session-model">{session.mainModel || 'model'}{session.effort ? ' · ' + session.effort : ''}</span>
            </button>
          {/each}
        </div>
      </aside>

      <main class="session-main">
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
              <div class="terminal-lights"><i></i><i></i><i></i></div>
              <nav>
                <button class:active={activeTab === 'activity'} onclick={() => switchTab('activity')}>activity</button>
                <button class:active={activeTab === 'files'} onclick={() => switchTab('files')}>files</button>
                <button class:active={activeTab === 'diff'} onclick={() => switchTab('diff')}>git diff</button>
                <button class:active={activeTab === 'plan'} onclick={() => switchTab('plan')}>plan</button>
              </nav>
              <button class="danger compact" disabled={selected.status === 'stopped'} onclick={() => send({ type: 'abort' })}>abort</button>
            </div>

            <div class="terminal-body">
              {#if activeTab === 'activity'}
                {#if activity.length === 0}<p class="prompt-line"><span>π</span> waiting for activity…</p>{/if}
                {#each activity as entry}<pre>{entry}</pre>{/each}
              {:else if activeTab === 'files'}
                <div class="file-toolbar">
                  <input bind:this={uploadInput} type="file" disabled={selected.status === 'stopped'} />
                  <button onclick={upload} disabled={selected.status === 'stopped'}>Upload</button>
                </div>
                <div class="file-grid">
                  {#if files.length === 0}<p class="muted">No temporary files.</p>{/if}
                  {#each files as file}
                    <article class="file-card">
                      <div><strong>{file.name}</strong><span>{formatBytes(file.size)}</span></div>
                      <button class="danger compact" onclick={() => removeFile(file.id)}>Delete</button>
                    </article>
                  {/each}
                </div>
              {:else if activeTab === 'diff'}
                <pre>{diff || 'No diff loaded.'}</pre>
              {:else}
                <textarea bind:value={plan} placeholder="Optional plan goal" disabled={selected.status === 'stopped'}></textarea>
                <button onclick={() => send({ type: 'plan', text: plan })} disabled={selected.status === 'stopped'}>Run /plan</button>
              {/if}
            </div>

            <form class="composer" onsubmit={(event) => { event.preventDefault(); submitPrompt(); }}>
              <textarea bind:value={prompt} placeholder={selected.status === 'stopped' ? 'Session stopped' : 'Prompt this session…'} disabled={selected.status === 'stopped'}></textarea>
              <div class="composer-actions">
                <label><input type="checkbox" bind:checked={steer} disabled={selected.status === 'stopped'} /> steer active turn</label>
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
