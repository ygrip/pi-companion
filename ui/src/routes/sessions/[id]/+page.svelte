<script lang="ts">
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import Icon, { type IconName } from '#lib/Icon.svelte';
  import { companion } from '#lib/companion.svelte';
  import { formatBytes, prettyPath, relativeTime, sessionTitle, statusLabel } from '#lib/format';
  import { errorMessage, toasts } from '#lib/toast.svelte';
  import type { ActivityEntry } from '#lib/activity';

  type Tab = 'activity' | 'files' | 'changes' | 'plan';

  const id = $derived(page.params.id ?? '');
  const session = $derived(companion.session(id));
  const ended = $derived(session?.status === 'stopped');
  const feed = $derived(companion.activity[id] ?? []);
  const asks = $derived(companion.asks[id] ?? []);
  const files = $derived(companion.files[id] ?? []);
  const diff = $derived(companion.diffs[id]);

  let tab = $state<Tab>('activity');
  let prompt = $state('');
  let steer = $state(false);
  let plan = $state('');
  let staged = $state(false);
  let askDrafts = $state<Record<string, string>>({});
  let uploading = $state(0);
  let dragging = $state(false);
  let follow = $state(true);
  let unseen = $state(0);
  let feedEl = $state<HTMLDivElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let promptEl = $state<HTMLTextAreaElement | null>(null);

  const tabs: { key: Tab; label: string; icon: IconName }[] = [
    { key: 'activity', label: 'Activity', icon: 'activity' },
    { key: 'files', label: 'Files', icon: 'folder' },
    { key: 'changes', label: 'Changes', icon: 'diff' },
    { key: 'plan', label: 'Plan', icon: 'plan' }
  ];

  // Reset per-session UI state when navigating between sessions.
  let lastId = '';
  $effect(() => {
    if (id === lastId) return;
    lastId = id;
    tab = 'activity';
    follow = true;
    unseen = 0;
    if (session && !ended) void companion.refreshFiles(id).catch(() => {});
  });

  // Follow the newest activity unless the reader scrolled up.
  let lastLength = 0;
  $effect(() => {
    const length = feed.length + (feed.at(-1)?.body.length ?? 0);
    if (length === lastLength) return;
    lastLength = length;
    if (follow) void tick().then(pin);
    else unseen += 1;
  });

  // Layout changes (an ask card appearing, the composer growing, rotation) shrink the
  // feed; keep it pinned to the newest entry while following.
  $effect(() => {
    const element = feedEl;
    const hasEntries = feed.length > 0; // re-observe once the list replaces the empty state
    if (!element || !hasEntries) return;
    const observer = new ResizeObserver(() => {
      if (follow) pin();
    });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  });

  // Scroll events arrive a frame late. One caused by our own pinning can land after the
  // layout changed again, so it must not be mistaken for the reader scrolling up.
  let pinnedTop = -1;

  function pin() {
    if (!feedEl) return;
    feedEl.scrollTop = feedEl.scrollHeight;
    pinnedTop = feedEl.scrollTop;
  }

  function onFeedScroll() {
    if (!feedEl) return;
    if (feedEl.scrollTop === pinnedTop) return;
    pinnedTop = -1;
    follow = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 48;
    if (follow) unseen = 0;
  }

  function jumpToLatest() {
    follow = true;
    unseen = 0;
    pin();
  }

  function selectTab(next: Tab) {
    tab = next;
    if (next === 'files') void companion.refreshFiles(id).catch(() => {});
    if (next === 'changes' && !diff) loadDiff();
  }

  function onTabKey(event: KeyboardEvent) {
    const keys = tabs.map((t) => t.key);
    const index = keys.indexOf(tab);
    const target =
      event.key === 'ArrowRight' ? (index + 1) % keys.length
      : event.key === 'ArrowLeft' ? (index - 1 + keys.length) % keys.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? keys.length - 1
      : -1;
    if (target < 0) return;
    event.preventDefault();
    selectTab(keys[target]);
    document.getElementById('tab-' + keys[target])?.focus();
  }

  function submit() {
    const text = prompt.trim();
    if (!text || ended) return;
    if (!companion.prompt(id, text, steer)) {
      toasts.show('Not connected. Your message was not sent.', 'error');
      return;
    }
    prompt = '';
    steer = false;
    follow = true;
    tab = 'activity';
    void tick().then(autosize);
  }

  function onComposerKey(event: KeyboardEvent) {
    // Desktop: Enter sends, Shift+Enter adds a line. Touch keyboards keep Enter as newline.
    const touch = matchMedia('(pointer: coarse)').matches;
    if (event.key === 'Enter' && !event.isComposing && ((!touch && !event.shiftKey) || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }

  function autosize() {
    if (!promptEl) return;
    promptEl.style.height = 'auto';
    promptEl.style.height = Math.min(promptEl.scrollHeight, 180) + 'px';
  }

  function answer(requestId: string, value: string) {
    const text = value.trim();
    if (!text) return;
    if (!companion.answer(id, requestId, text)) toasts.show('Not connected. Try again in a moment.', 'error');
  }

  function stop() {
    if (companion.send(id, { type: 'abort' })) toasts.show('Asked Pi to stop the current turn.');
    else toasts.show('Not connected.', 'error');
  }

  function loadDiff(nextStaged = staged) {
    staged = nextStaged;
    if (!companion.send(id, { type: 'git_diff', staged: nextStaged })) toasts.show('Not connected.', 'error');
  }

  function runPlan() {
    if (!companion.send(id, { type: 'plan', text: plan })) return toasts.show('Not connected.', 'error');
    toasts.show('Planning started. Follow along in Activity.', 'success');
    plan = '';
    tab = 'activity';
  }

  async function uploadFiles(list: FileList | File[] | null | undefined) {
    if (!list || ended) return;
    for (const file of Array.from(list)) {
      uploading += 1;
      try {
        await companion.upload(id, file);
        toasts.show(file.name + ' is ready for Pi.', 'success');
      } catch (error) {
        toasts.show(file.name + ': ' + errorMessage(error), 'error');
      } finally {
        uploading -= 1;
      }
    }
    if (fileInput) fileInput.value = '';
  }

  async function remove(fileId: string, name: string) {
    try {
      await companion.removeFile(id, fileId);
      toasts.show(name + ' removed.');
    } catch (error) {
      toasts.show(errorMessage(error), 'error');
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    void uploadFiles(event.dataTransfer?.files);
  }

  const kindIcon: Record<ActivityEntry['kind'], IconName> = {
    assistant: 'sparkle',
    thinking: 'brain',
    tool: 'tool',
    lifecycle: 'dot',
    error: 'alert',
    user: 'user'
  };

  const diffStats = $derived.by(() => {
    if (!diff?.text) return { add: 0, del: 0, files: 0 };
    let add = 0, del = 0, filesChanged = 0;
    for (const line of diff.text.split('\n')) {
      if (line.startsWith('diff --git')) filesChanged++;
      else if (line.startsWith('+') && !line.startsWith('+++')) add++;
      else if (line.startsWith('-') && !line.startsWith('---')) del++;
    }
    return { add, del, files: filesChanged };
  });

  function lineClass(line: string) {
    if (line.startsWith('diff --git')) return 'file';
    if (line.startsWith('@@')) return 'hunk';
    if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
    if (line.startsWith('-') && !line.startsWith('---')) return 'del';
    return '';
  }
</script>

<svelte:head><title>{session ? sessionTitle(session) : 'Session'} · Pi Companion</title></svelte:head>

{#if !session}
  <div class="page">
    <div class="card empty">
      <span class="empty-icon"><Icon name="sessions" /></span>
      <h2>Session not found</h2>
      <p>It may have ended before the daemon restarted{companion.remote ? ', or your computer stopped sharing it' : ''}.</p>
      <a class="btn btn-sm" href="/sessions"><Icon name="back" size={16} />All sessions</a>
    </div>
  </div>
{:else}
  <div class="detail">
    <header class="head">
      <a class="back" href="/sessions"><Icon name="back" size={16} />Sessions</a>
      <div class="title-row">
        <div class="title">
          <h1>{sessionTitle(session)}</h1>
          <code title={session.cwd}>{prettyPath(session.cwd)}</code>
        </div>
        <button class="btn btn-danger" onclick={stop} disabled={ended || session.status !== 'active'} title="Stop Pi's current turn">
          <Icon name="stop" size={16} />Stop
        </button>
      </div>
      <div class="chips scroll-x">
        <span class="badge" class:ok={session.status === 'active'} class:accent={session.status === 'idle'}>
          <span class="dot {session.status}" aria-hidden="true"></span>{statusLabel[session.status]}
        </span>
        <span class="badge">{session.mainModel ?? 'Model not reported'}</span>
        {#if session.effort}<span class="badge">Thinking: {session.effort}</span>{/if}
        {#if companion.isAdmin}
          <span class="badge" title={session.remoteEnabled ? 'Visible on paired devices' : 'Type /remote-control in Pi to share'}>
            <Icon name="link" size={12} />{session.remoteEnabled ? 'Shared with devices' : 'This computer only'}
          </span>
        {/if}
        <span class="badge">Started {relativeTime(session.connectedAt)}</span>
      </div>
    </header>

    <section class="panel card">
      <div class="tabs scroll-x" role="tablist" aria-label="Session views" tabindex="-1" onkeydown={onTabKey}>
        {#each tabs as item (item.key)}
          <button
            id="tab-{item.key}"
            role="tab"
            aria-selected={tab === item.key}
            aria-controls="panel"
            tabindex={tab === item.key ? 0 : -1}
            onclick={() => selectTab(item.key)}>
            <Icon name={item.icon} size={16} />{item.label}
            {#if item.key === 'activity' && asks.length}<span class="count">{asks.length}</span>{/if}
            {#if item.key === 'files' && files.length}<span class="count muted-count">{files.length}</span>{/if}
          </button>
        {/each}
      </div>

      {#if asks.length}
        <div class="asks scroll" role="region" aria-label="Questions from Pi" aria-live="assertive">
          {#each asks as ask (ask.requestId)}
            <form class="ask" onsubmit={(event) => { event.preventDefault(); answer(ask.requestId, askDrafts[ask.requestId] ?? ''); }}>
              <div class="ask-head"><Icon name="question" size={16} /><span class="eyebrow">Pi is asking</span></div>
              <p>{ask.question}</p>
              {#if ask.options?.length}
                <div class="options">
                  {#each ask.options as option (option)}
                    <button type="button" class="btn btn-sm" onclick={() => answer(ask.requestId, option)}>{option}</button>
                  {/each}
                </div>
              {/if}
              <div class="ask-input">
                <label class="sr-only" for="ask-{ask.requestId}">Your answer</label>
                <input id="ask-{ask.requestId}" class="input" bind:value={askDrafts[ask.requestId]} placeholder="Or type your own answer" autocomplete="off" />
                <button class="btn btn-primary" type="submit">Answer</button>
              </div>
            </form>
          {/each}
        </div>
      {/if}

      <div class="body" id="panel" role="tabpanel" aria-labelledby="tab-{tab}">
        {#if tab === 'activity'}
          <!-- Scrollable region must be keyboard-focusable (WCAG 2.1.1). -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="feed scroll" bind:this={feedEl} onscroll={onFeedScroll} tabindex="0" aria-label="Session activity">
            {#if feed.length === 0}
              <div class="empty quiet">
                <span class="empty-icon"><Icon name="activity" /></span>
                <p>Nothing yet. Pi's replies, tool calls and questions will stream in here as they happen.</p>
              </div>
            {:else}
              <ol aria-live="polite" aria-relevant="additions">
                {#each feed as entry (entry.id)}
                  <li class="entry {entry.kind} {entry.status ?? ''}">
                    <span class="marker"><Icon name={kindIcon[entry.kind]} size={14} /></span>
                    <div class="entry-main">
                      <div class="entry-meta">
                        <strong>{entry.title}</strong>
                        {#if entry.status === 'running'}<span class="badge accent">Running</span>
                        {:else if entry.status === 'ok'}<span class="badge ok">Done</span>
                        {:else if entry.status === 'error'}<span class="badge danger">Failed</span>{/if}
                        <time datetime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                      </div>
                      {#if entry.body}<pre>{entry.body}</pre>{/if}
                    </div>
                  </li>
                {/each}
              </ol>
            {/if}
          </div>
          {#if unseen > 0 && !follow}
            <button class="btn btn-sm jump" onclick={jumpToLatest}>Jump to latest<Icon name="chevron" size={14} /></button>
          {/if}
        {:else if tab === 'files'}
          <div class="files scroll">
            <div
              class="dropzone"
              class:dragging
              data-dropzone
              role="group"
              aria-label="Upload files"
              ondragenter={(e) => { e.preventDefault(); dragging = !ended; }}
              ondragover={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = ended ? 'none' : 'copy'; }}
              ondragleave={(e) => { if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) dragging = false; }}
              ondrop={onDrop}>
              <span class="empty-icon"><Icon name="upload" /></span>
              <div>
                <strong>{uploading ? 'Uploading…' : 'Drop files for Pi'}</strong>
                <p class="muted">Files go to a private folder for this session only. Pi finds them with <code>companion_temp_files</code>. They are deleted when the session ends.</p>
              </div>
              <input bind:this={fileInput} id="file-input" class="sr-only" type="file" multiple disabled={ended} onchange={(e) => uploadFiles((e.currentTarget as HTMLInputElement).files)} />
              <label for="file-input" class="btn" class:disabled={ended}><Icon name="plus" size={16} />Choose files</label>
            </div>

            {#if files.length}
              <ul class="file-list">
                {#each files as file (file.id)}
                  <li>
                    <Icon name="file" />
                    <div class="file-main">
                      <strong title={file.name}>{file.name}</strong>
                      <span class="subtle">{formatBytes(file.size)} · added {relativeTime(file.createdAt)}</span>
                    </div>
                    <button class="btn btn-ghost btn-icon" aria-label="Remove {file.name}" onclick={() => remove(file.id, file.name)}><Icon name="trash" size={16} /></button>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="subtle none">No files shared with this session.</p>
            {/if}
          </div>
        {:else if tab === 'changes'}
          <div class="changes">
            <div class="changes-bar">
              <div class="segmented" role="group" aria-label="Which changes">
                <button aria-pressed={!staged} onclick={() => loadDiff(false)}>Not staged</button>
                <button aria-pressed={staged} onclick={() => loadDiff(true)}>Staged</button>
              </div>
              {#if diff?.text}
                <span class="stat"><b class="plus">+{diffStats.add}</b> <b class="minus">−{diffStats.del}</b> · {diffStats.files} {diffStats.files === 1 ? 'file' : 'files'}</span>
              {/if}
              <button class="btn btn-ghost btn-sm" onclick={() => loadDiff()} disabled={ended}><Icon name="refresh" size={14} />Refresh</button>
            </div>
            <div class="diff scroll">
              {#if !diff}
                <p class="subtle none">Loading changes from the session’s working folder…</p>
              {:else if !diff.text.trim()}
                <p class="subtle none">No {diff.staged ? 'staged' : 'unstaged'} changes. The working tree is clean.</p>
              {:else}
                <pre>{#each diff.text.split('\n') as line, index (index)}<span class={lineClass(line)}>{line || ' '}</span>{/each}</pre>
              {/if}
            </div>
          </div>
        {:else}
          <form class="plan scroll" onsubmit={(event) => { event.preventDefault(); runPlan(); }}>
            <div class="field">
              <label for="plan-goal">What should Pi plan?</label>
              <textarea id="plan-goal" class="textarea" rows="5" bind:value={plan} disabled={ended}
                placeholder="For example: split the settings page into sections and add validation"></textarea>
              <span class="hint">Runs <code>/plan</code> in this session. Leave it empty to plan from the current conversation.</span>
            </div>
            <div><button class="btn btn-primary" disabled={ended}><Icon name="plan" size={16} />Ask Pi to plan</button></div>
          </form>
        {/if}
      </div>

      <form class="composer" onsubmit={(event) => { event.preventDefault(); submit(); }}>
        {#if ended}
          <p class="ended"><Icon name="alert" size={16} />This session has ended. You can still read its history.</p>
        {:else}
          <label class="sr-only" for="prompt">Message Pi</label>
          <textarea
            id="prompt"
            class="textarea"
            rows="1"
            bind:this={promptEl}
            bind:value={prompt}
            oninput={autosize}
            onkeydown={onComposerKey}
            placeholder={steer ? 'Redirect the current turn…' : 'Message Pi…'}></textarea>
          <div class="composer-bar">
            <label class="toggle" title="Send into the turn Pi is working on, instead of queueing a new prompt">
              <input type="checkbox" bind:checked={steer} disabled={session.status !== 'active'} />
              <span class="track" aria-hidden="true"></span>
              Steer current turn
            </label>
            <span class="hint">Enter to send · Shift+Enter for a new line</span>
            <button class="btn btn-primary" disabled={!prompt.trim()}><Icon name="send" size={16} />Send</button>
          </div>
        {/if}
      </form>
    </section>
  </div>
{/if}

<style>
  /* Fills the content area; only regions inside the panel scroll. */
  .detail {
    height: 100%;
    width: min(1180px, 100%);
    margin: 0 auto;
    padding: 20px 32px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
  }

  .head {
    display: grid;
    gap: 10px;
    flex: none;
  }

  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: fit-content;
    color: var(--text-2);
    font-size: 0.85rem;
    font-weight: 550;
    text-decoration: none;
  }

  .back:hover {
    color: var(--accent-text);
  }

  .title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .title {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .title h1 {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title code {
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chips {
    display: flex;
    gap: 6px;
    padding-bottom: 2px;
  }

  .panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .tabs {
    display: flex;
    gap: 2px;
    flex: none;
    padding: 6px 8px 0;
    border-bottom: 1px solid var(--border);
  }

  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 40px;
    padding: 0 12px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-2);
    font-weight: 550;
    white-space: nowrap;
  }

  .tabs button:hover {
    color: var(--text);
  }

  .tabs button[aria-selected='true'] {
    color: var(--text);
    border-bottom-color: var(--accent);
  }

  .count {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-ink);
    font-size: 0.7rem;
    font-weight: 800;
  }

  .muted-count {
    background: var(--surface-3);
    color: var(--text-2);
  }

  .asks {
    flex: none;
    max-height: 40%;
    display: grid;
    gap: 10px;
    padding: 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-sunken);
  }

  .ask {
    display: grid;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--accent-line);
    border-radius: var(--radius);
    background: var(--accent-soft);
  }

  .ask-head {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--accent-text);
  }

  .ask p {
    white-space: pre-wrap;
    font-weight: 550;
  }

  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .ask-input {
    display: flex;
    gap: 8px;
  }

  .body {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .feed,
  .files,
  .plan {
    flex: 1;
    min-height: 0;
    padding: 16px 20px;
  }

  .feed ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 14px;
  }

  .entry {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr);
    gap: 10px;
  }

  .marker {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text-3);
  }

  .entry.assistant .marker,
  .entry.user .marker {
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .entry.tool.ok .marker {
    color: var(--ok);
  }

  .entry.tool.error .marker,
  .entry.error .marker {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .entry-main {
    min-width: 0;
  }

  .entry-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 26px;
    font-size: 0.85rem;
  }

  .entry-meta time {
    margin-left: auto;
    font-size: 0.75rem;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  .entry pre {
    margin: 4px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.85rem;
    line-height: 1.6;
    color: var(--text);
  }

  .entry.assistant pre,
  .entry.user pre {
    font-family: var(--font);
    font-size: 0.95rem;
  }

  .entry.thinking pre {
    color: var(--text-3);
    font-style: italic;
  }

  .entry.tool pre {
    max-height: 240px;
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--code-bg);
    color: var(--text-2);
    white-space: pre;
    overflow-wrap: normal;
  }

  .entry.lifecycle {
    opacity: 0.8;
  }

  .entry.lifecycle .entry-meta strong {
    font-weight: 500;
    color: var(--text-2);
  }

  .jump {
    position: absolute;
    left: 50%;
    bottom: 12px;
    translate: -50% 0;
    box-shadow: var(--shadow);
  }

  .quiet {
    padding: 32px 12px;
  }

  .dropzone {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 14px;
    padding: 18px;
    border: 1.5px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-sunken);
    transition: border-color 150ms var(--ease), background-color 150ms var(--ease);
  }

  .dropzone.dragging {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .dropzone p {
    font-size: 0.85rem;
    margin-top: 2px;
  }

  .dropzone .disabled {
    opacity: 0.45;
    pointer-events: none;
  }

  .file-list {
    list-style: none;
    margin: 14px 0 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }

  .file-list li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 8px 8px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-3);
  }

  .file-main {
    display: grid;
    min-width: 0;
    flex: 1;
  }

  .file-main strong {
    color: var(--text);
    font-weight: 550;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-main span {
    font-size: 0.8rem;
  }

  .none {
    padding: 16px 0;
    font-size: 0.9rem;
  }

  .changes {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .changes-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  .changes-bar .btn {
    margin-left: auto;
  }

  .stat {
    font-size: 0.82rem;
    color: var(--text-2);
  }

  .plus {
    color: var(--ok);
  }

  .minus {
    color: var(--danger);
  }

  .diff {
    flex: 1;
    min-height: 0;
    background: var(--code-bg);
  }

  .diff .none {
    padding: 16px 20px;
  }

  .diff pre {
    margin: 0;
    padding: 12px 0;
    width: max-content;
    min-width: 100%;
    font-size: 0.8rem;
    line-height: 1.55;
  }

  .diff span {
    display: block;
    padding: 0 20px;
    white-space: pre;
  }

  .diff .add {
    background: var(--diff-add);
    color: var(--ok);
  }

  .diff .del {
    background: var(--diff-del);
    color: var(--danger);
  }

  .diff .hunk {
    color: var(--accent-text);
  }

  .diff .file {
    margin-top: 10px;
    padding-top: 6px;
    border-top: 1px solid var(--border);
    color: var(--text);
    font-weight: 700;
  }

  .plan {
    display: grid;
    align-content: start;
    gap: 14px;
    max-width: 720px;
  }

  .composer {
    flex: none;
    display: grid;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid var(--border);
    background: var(--surface-2);
  }

  .composer .textarea {
    min-height: 44px;
    max-height: 180px;
    resize: none;
    background: var(--surface);
  }

  .composer-bar {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .composer-bar .hint {
    margin-left: auto;
    font-size: 0.78rem;
    color: var(--text-3);
  }

  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
    color: var(--text-2);
    cursor: pointer;
  }

  .toggle input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
  }

  .track {
    position: relative;
    width: 32px;
    height: 18px;
    border-radius: 999px;
    background: var(--surface-3);
    border: 1px solid var(--border-strong);
    transition: background-color 150ms var(--ease);
  }

  .track::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--text-3);
    transition: translate 150ms var(--ease), background-color 150ms var(--ease);
  }

  .toggle input:checked + .track {
    background: var(--accent);
    border-color: var(--accent);
  }

  .toggle input:checked + .track::after {
    translate: 14px 0;
    background: var(--accent-ink);
  }

  .toggle input:focus-visible + .track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .toggle:has(input:disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ended {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-2);
    font-size: 0.9rem;
  }

  @media (max-width: 900px) {
    .detail {
      padding: 12px 10px 10px;
      gap: 10px;
    }

    .title h1 {
      font-size: 1.3rem;
    }

    .feed,
    .files,
    .plan {
      padding: 14px;
    }

    .composer-bar .hint {
      display: none;
    }

    .composer-bar .btn {
      margin-left: auto;
    }

    .dropzone {
      grid-template-columns: minmax(0, 1fr);
      justify-items: start;
    }

    .ask-input {
      flex-direction: column;
    }

    .entry-meta time {
      display: none;
    }
  }

  @media (max-width: 900px) and (max-height: 640px) {
    .chips {
      display: none;
    }
  }
</style>
