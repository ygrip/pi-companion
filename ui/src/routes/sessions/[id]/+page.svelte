<script lang="ts">
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import AskSheet from '#lib/AskSheet.svelte';
  import Icon, { type IconName } from '#lib/Icon.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { formatBytes, prettyPath, relativeTime, sessionTitle, statusLabel } from '#lib/format.ts';
  import { codeBlock, looksLikeJson, prettify, prettyJson, renderMarkdown } from '#lib/markdown.ts';
  import { errorMessage, toasts } from '#lib/toast.svelte.ts';
  import type { ActivityEntry } from '#lib/activity.ts';

  /** A tool entry's body is its arguments, then "\n→ " and the result once it finishes. */
  function toolParts(entry: ActivityEntry) {
    const split = entry.body.indexOf('\n→ ');
    if (split >= 0) return { args: entry.body.slice(0, split), result: entry.body.slice(split + 3) };
    return entry.toolCallId ? { args: entry.body, result: '' } : { args: '', result: entry.body };
  }

  const lineCount = (text: string) => text.split('\n').length;

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
  let infoOpen = $state(false);
  let askOpen = $state(false);
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
    infoOpen = false;
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
    if (!companion.prompt(id, text, steer && session?.status === 'active')) {
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

  // Shell-style line prefixes for the activity transcript.
  const glyph: Record<ActivityEntry['kind'], string> = {
    assistant: '│',
    thinking: '∴',
    tool: '$',
    lifecycle: '·',
    error: '!',
    user: '❯'
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
      <a class="btn btn-ghost btn-icon" href="/sessions" aria-label="All sessions"><Icon name="back" /></a>
      <h1 class="title">
        <button aria-expanded={infoOpen} aria-controls="session-info" onclick={() => (infoOpen = !infoOpen)}>
          <span>{sessionTitle(session)}</span>
          <Icon name="chevron" size={16} class="caret" />
        </button>
      </h1>
      <span class="badge" class:ok={session.status === 'active'} class:accent={session.status === 'idle'}>
        <span class="dot {session.status}" aria-hidden="true"></span>{statusLabel[session.status]}
      </span>
      {#if asks.length}
        <button class="badge count ask-count" onclick={() => (askOpen = true)} aria-label="{asks.length} {asks.length === 1 ? 'question' : 'questions'} waiting, open">
          {asks.length}
        </button>
      {/if}
    </header>

    <div class="info chips" id="session-info" hidden={!infoOpen}>
      <span class="chip mono" title={session.cwd}><Icon name="folder" size={13} /><span>{prettyPath(session.cwd)}</span></span>
      {#if session.mainModel}<span class="chip"><Icon name="sparkle" size={13} /><span>{session.mainModel}</span></span>{/if}
      {#if session.effort}<span class="chip"><Icon name="brain" size={13} /><span>{session.effort}</span></span>{/if}
      {#if companion.isAdmin}
        <span class="chip" class:on={session.remoteEnabled}>
          <Icon name="link" size={13} /><span>{session.remoteEnabled ? 'Shared with devices' : 'Not shared · run /companion'}</span>
        </span>
      {/if}
      <span class="chip"><span>Started {relativeTime(session.connectedAt)}</span></span>
    </div>

    <section class="panel">
      <div class="tabs" role="tablist" aria-label="Session views" tabindex="-1" onkeydown={onTabKey}>
        {#each tabs as item (item.key)}
          <button
            id="tab-{item.key}"
            role="tab"
            aria-selected={tab === item.key}
            aria-controls="panel"
            tabindex={tab === item.key ? 0 : -1}
            onclick={() => selectTab(item.key)}>
            <Icon name={item.icon} size={18} />
            <span>{item.label}</span>
            {#if item.key === 'files' && files.length}<span class="badge count quiet" aria-label="{files.length} files">{files.length}</span>{/if}
            {#if item.key === 'changes' && diff?.text && diffStats.files}<span class="badge count quiet" aria-label="{diffStats.files} changed files">{diffStats.files}</span>{/if}
          </button>
        {/each}
      </div>

      <div class="body" id="panel" role="tabpanel" aria-labelledby="tab-{tab}">
        {#if tab === 'activity'}
          <div class="term">
            <!-- Scrollable region must be keyboard-focusable (WCAG 2.1.1). -->
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <div class="feed scroll" bind:this={feedEl} onscroll={onFeedScroll} tabindex="0" aria-label="Session activity">
              <p class="line banner"><span class="glyph">~</span><span>{prettyPath(session.cwd)}</span></p>
              {#if feed.length === 0}
                <p class="line dim"><span class="glyph">#</span><span>Waiting for Pi. Replies, tool calls and questions stream here.</span></p>
              {:else}
                <ol aria-live="polite" aria-relevant="additions">
                  {#each feed as entry (entry.id)}
                    <li class="line {entry.kind} {entry.status ?? ''}">
                      <span class="glyph" aria-hidden="true">{glyph[entry.kind]}</span>
                      <div class="line-main">
                        {#if entry.kind === 'tool'}
                          {@const parts = toolParts(entry)}
                          <div class="cmd">
                            <b>{entry.title}</b>
                            {#if parts.args}<code class="args" title={parts.args}>{parts.args}</code>{/if}
                            {#if entry.status === 'running'}<span class="state run">running</span>
                            {:else if entry.status === 'ok'}<span class="state ok">ok</span>
                            {:else if entry.status === 'error'}<span class="state err">failed</span>{/if}
                          </div>
                          {#if parts.result}
                            {@const json = looksLikeJson(parts.result)}
                            {@const shown = json ? prettyJson(parts.result) : parts.result}
                            {@const lines = lineCount(shown)}
                            <details class="out" open={entry.status === 'error' || lines <= 6}>
                              <summary>output · {lines} {lines === 1 ? 'line' : 'lines'}</summary>
                              {#if json}
                                <div use:prettify={{ text: shown, final: true }}>{@html codeBlock(shown, 'json')}</div>
                              {:else}
                                <pre>{shown}</pre>
                              {/if}
                            </details>
                          {/if}
                        {:else if entry.kind === 'lifecycle'}
                          <span>{entry.title}{entry.body ? ' · ' + entry.body : ''}</span>
                        {:else if entry.kind === 'error'}
                          <pre><b>{entry.title}:</b> {entry.body}</pre>
                        {:else if entry.kind === 'thinking'}
                          <details class="thought">
                            <summary>thinking · {lineCount(entry.body)} {lineCount(entry.body) === 1 ? 'line' : 'lines'}</summary>
                            <pre>{entry.body}</pre>
                          </details>
                        {:else if entry.kind === 'assistant'}
                          {@const final = entry !== feed.at(-1) || session.status !== 'active'}
                          <div class="md" use:prettify={{ text: entry.body, final }}>{@html renderMarkdown(entry.body)}</div>
                        {:else}
                          {#if entry.kind === 'user' && entry.title !== 'You'}<span class="tag">{entry.title.replace('You · ', '')}</span>{/if}
                          <pre>{entry.body}</pre>
                        {/if}
                      </div>
                      <time datetime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                    </li>
                  {/each}
                </ol>
              {/if}
              {#if session.status === 'active'}
                <p class="line working" role="status"><span class="glyph" aria-hidden="true">›</span><span>Pi is working<span class="cursor" aria-hidden="true"></span></span></p>
              {/if}
            </div>
            {#if unseen > 0 && !follow}
              <button class="btn btn-sm jump" onclick={jumpToLatest}>Jump to latest<Icon name="chevron" size={14} /></button>
            {/if}
          </div>
        {:else if tab === 'files'}
          <div class="pane scroll">
            <div
              class="tile sunken dropzone"
              class:dragging
              data-dropzone
              role="group"
              aria-label="Upload files"
              ondragenter={(e) => { e.preventDefault(); dragging = !ended; }}
              ondragover={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = ended ? 'none' : 'copy'; }}
              ondragleave={(e) => { if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) dragging = false; }}
              ondrop={onDrop}>
              <span class="empty-icon"><Icon name="upload" /></span>
              <strong>{uploading ? 'Uploading…' : 'Share files with Pi'}</strong>
              <p class="muted">Private to this session and deleted when it ends.</p>
              <input bind:this={fileInput} id="file-input" class="sr-only" type="file" multiple disabled={ended} onchange={(e) => uploadFiles((e.currentTarget as HTMLInputElement).files)} />
              <label for="file-input" class="btn-bento primary pick" class:disabled={ended}><Icon name="plus" size={18} />Choose files</label>
            </div>

            {#if files.length}
              <ul class="bento file-list">
                {#each files as file (file.id)}
                  <li class="tile file">
                    <Icon name="file" />
                    <div class="file-main">
                      <strong title={file.name}>{file.name}</strong>
                      <span class="chips"><span class="chip">{formatBytes(file.size)}</span><span class="chip">{relativeTime(file.createdAt)}</span></span>
                    </div>
                    <button class="btn btn-ghost btn-icon" aria-label="Remove {file.name}" onclick={() => remove(file.id, file.name)}><Icon name="trash" size={16} /></button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {:else if tab === 'changes'}
          <div class="changes">
            <div class="changes-bar">
              <div class="segmented" role="group" aria-label="Which changes">
                <button aria-pressed={!staged} onclick={() => loadDiff(false)}>Unstaged</button>
                <button aria-pressed={staged} onclick={() => loadDiff(true)}>Staged</button>
              </div>
              {#if diff?.text}
                <span class="chips">
                  <span class="chip plus">+{diffStats.add}</span>
                  <span class="chip minus">−{diffStats.del}</span>
                </span>
              {/if}
              <button class="btn btn-ghost btn-icon refresh" aria-label="Refresh changes" onclick={() => loadDiff()} disabled={ended}><Icon name="refresh" size={16} /></button>
            </div>
            <div class="diff scroll">
              {#if !diff}
                <p class="subtle none">Loading changes…</p>
              {:else if diff.error}
                <p class="subtle none">Changes unavailable. {diff.error}</p>
              {:else if !diff.text.trim()}
                <p class="subtle none">No {diff.staged ? 'staged' : 'unstaged'} changes.</p>
              {:else}
                <pre>{#each diff.text.split('\n') as line, index (index)}<span class={lineClass(line)}>{line || ' '}</span>{/each}</pre>
              {/if}
            </div>
          </div>
        {:else}
          <form class="pane plan scroll" onsubmit={(event) => { event.preventDefault(); runPlan(); }}>
            <div class="field">
              <label for="plan-goal">What should Pi plan?</label>
              <textarea id="plan-goal" class="textarea" rows="5" bind:value={plan} disabled={ended}
                placeholder="Leave empty to plan from the current conversation"></textarea>
              <span class="hint">Runs <code>/plan</code> in this session.</span>
            </div>
            <button class="btn-bento primary" disabled={ended}><Icon name="plan" size={18} />Ask Pi to plan</button>
          </form>
        {/if}
      </div>

      {#if !ended && asks.length && !askOpen}
        <button type="button" class="ask-pill" onclick={() => (askOpen = true)}>
          <Icon name="question" size={16} />
          <span>Pi is waiting for your answer</span>
          <span class="badge count">{asks.length}</span>
        </button>
      {/if}

      {#if tab === 'activity'}
        <form class="composer" onsubmit={(event) => { event.preventDefault(); submit(); }}>
          {#if ended}
            <p class="ended"><span class="glyph">!</span>Session ended. History is read-only.</p>
          {:else}
            <div class="prompt-row">
              <span class="ps1" aria-hidden="true">❯</span>
              <label class="sr-only" for="prompt">Message Pi</label>
              <textarea
                id="prompt"
                rows="1"
                bind:this={promptEl}
                bind:value={prompt}
                oninput={autosize}
                onkeydown={onComposerKey}
                placeholder={steer && session.status === 'active' ? 'steer the current turn…' : 'message pi…'}></textarea>
            </div>
            <div class="composer-bar">
              {#if session.status === 'active'}
                <label class="toggle" title="Send into the turn Pi is working on instead of queueing a new prompt">
                  <input type="checkbox" bind:checked={steer} />
                  <span class="track" aria-hidden="true"></span>
                  Steer current turn
                </label>
              {:else}
                <span class="hint">Enter to send · Shift+Enter for a new line</span>
              {/if}
              <button class="btn btn-primary send" disabled={!prompt.trim()}><Icon name="send" size={16} />{steer && session.status === 'active' ? 'Steer' : 'Send'}</button>
            </div>
          {/if}
        </form>
      {/if}
    </section>
  </div>

  {#if !ended}<AskSheet sessionId={id} {asks} bind:open={askOpen} />{/if}
{/if}

<style>
  /* Fills the content area; only regions inside the panel scroll. */
  .detail {
    height: 100%;
    width: min(1180px, 100%);
    margin: 0 auto;
    padding: 16px 28px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
  }

  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .title {
    flex: 1;
    min-width: 0;
    font-size: 1.15rem;
  }

  .title button {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    min-height: 40px;
    padding: 0 8px;
    border: 0;
    border-radius: 12px;
    background: none;
    font: inherit;
    letter-spacing: inherit;
    text-align: left;
  }

  .title button:hover {
    background: var(--surface-2);
  }

  .title span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title :global(.caret) {
    flex: none;
    color: var(--text-3);
    transition: rotate 150ms var(--ease);
  }

  .title button[aria-expanded='true'] :global(.caret) {
    rotate: 90deg;
  }

  .ask-count {
    cursor: pointer;
    height: 24px;
    min-width: 24px;
  }

  .info {
    flex: none;
    padding: 0 4px;
  }

  .info[hidden] {
    display: none;
  }

  .panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* Wide, equal-width tabs: big targets that are easy to hit with a thumb. */
  .tabs {
    flex: none;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: var(--clay-radius);
    background: var(--bg-sunken);
    box-shadow: var(--clay-pressed);
  }

  .tabs button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-width: 0;
    min-height: 48px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 14px;
    background: none;
    color: var(--text-2);
    font-weight: 600;
    white-space: nowrap;
    transition: background-color 150ms var(--ease), color 150ms var(--ease);
  }

  .tabs button:hover {
    color: var(--text);
    background: var(--surface-2);
  }

  .tabs button[aria-selected='true'] {
    border-color: var(--border);
    background: var(--surface);
    color: var(--accent-text);
    box-shadow: var(--clay-soft);
  }

  .body {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--clay-radius);
    background: var(--surface);
    box-shadow: var(--clay-raised);
    overflow: hidden;
  }

  /* ---------- Terminal transcript ---------- */

  /* The shell follows the app theme. */
  .term,
  .composer {
    --term-bg: var(--code-bg);
    --term-line: var(--border);
    --term-text: var(--text);
    --term-dim: var(--text-3);
    --term-accent: var(--accent-text);
    --term-ok: var(--ok);
    --term-err: var(--danger);
  }

  .term {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--term-bg);
    color: var(--term-text);
  }

  .feed {
    flex: 1;
    min-height: 0;
    padding: 14px 16px 18px;
    font-family: var(--mono);
    font-size: 0.84rem;
    line-height: 1.6;
  }

  .feed ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }

  .line {
    display: grid;
    grid-template-columns: 1.4ch minmax(0, 1fr) auto;
    column-gap: 1ch;
    margin: 0;
  }

  .glyph {
    color: var(--term-dim);
    user-select: none;
  }

  .line-main {
    min-width: 0;
  }

  .line pre {
    margin: 0;
    font: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .line time {
    color: var(--term-dim);
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
  }

  .banner,
  .dim,
  .lifecycle {
    color: var(--term-dim);
  }

  .banner {
    margin-bottom: 8px;
  }

  .banner .glyph {
    color: var(--term-accent);
  }

  .user .glyph,
  .user pre {
    color: var(--term-accent);
    font-weight: 600;
  }

  .thinking pre,
  .thinking .glyph {
    color: var(--term-dim);
    font-style: italic;
  }

  .error,
  .error .glyph {
    color: var(--term-err);
  }

  .tool .glyph {
    color: var(--term-ok);
  }

  .cmd {
    display: flex;
    align-items: baseline;
    gap: 1ch;
    min-width: 0;
  }

  .cmd b {
    flex: none;
    color: var(--term-text);
  }

  .args {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--term-dim);
    font-size: 0.78rem;
  }

  .state {
    flex: none;
    font-size: 0.75rem;
  }

  .state.run {
    color: var(--term-accent);
  }

  .state.ok {
    color: var(--term-ok);
  }

  .state.err {
    color: var(--term-err);
  }

  /* Collapsible tool output and thinking. */
  details.out,
  details.thought {
    margin-top: 2px;
  }

  details summary {
    width: fit-content;
    padding: 0 6px;
    border-radius: 6px;
    color: var(--term-dim);
    font-size: 0.75rem;
    cursor: pointer;
    list-style: none;
  }

  details summary::-webkit-details-marker {
    display: none;
  }

  details summary::before {
    content: '▸ ';
  }

  details[open] > summary::before {
    content: '▾ ';
  }

  details summary:hover {
    color: var(--term-text);
    background: var(--surface-2);
  }

  .out > pre,
  .out > div {
    max-height: 260px;
    overflow: auto;
    margin-top: 4px;
    padding-left: 1.5ch;
    border-left: 2px solid var(--term-line);
    color: var(--term-dim);
    scrollbar-width: thin;
  }

  .out > pre,
  .out :global(pre) {
    margin: 0;
    font: inherit;
    white-space: pre;
    overflow-wrap: normal;
  }

  .thought pre {
    margin-top: 4px;
    padding-left: 1.5ch;
    border-left: 2px solid var(--term-line);
  }

  /* ---------- Rendered Markdown (Pi's replies) ---------- */

  .md {
    font-family: var(--font);
    font-size: 0.92rem;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }

  .md :global(> :first-child) {
    margin-top: 0;
  }

  .md :global(> :last-child) {
    margin-bottom: 0;
  }

  .md :global(p),
  .md :global(ul),
  .md :global(ol),
  .md :global(blockquote),
  .md :global(table),
  .md :global(pre),
  .md :global(figure) {
    margin: 0 0 10px;
  }

  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    margin: 14px 0 6px;
    font-size: 1rem;
    line-height: 1.3;
  }

  .md :global(h1) {
    font-size: 1.15rem;
  }

  .md :global(ul),
  .md :global(ol) {
    padding-left: 22px;
  }

  .md :global(a) {
    color: var(--accent-text);
  }

  .md :global(code) {
    padding: 1px 5px;
    border-radius: 6px;
    background: var(--surface-2);
    font-size: 0.85em;
  }

  .md :global(pre),
  .out :global(pre) {
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    font-size: 0.8rem;
  }

  .md :global(pre code) {
    padding: 0;
    background: none;
  }

  .md :global(blockquote) {
    padding-left: 12px;
    border-left: 3px solid var(--accent-line);
    color: var(--text-2);
  }

  .md :global(table) {
    display: block;
    overflow-x: auto;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .md :global(th),
  .md :global(td) {
    padding: 6px 10px;
    border: 1px solid var(--border);
  }

  .md :global(.mermaid-diagram) {
    overflow-x: auto;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    text-align: center;
  }

  .md :global(.mermaid-diagram svg) {
    max-width: 100%;
    height: auto;
  }

  /* highlight.js tokens mapped to theme colors (works in both themes). */
  .term :global(.hljs-keyword),
  .term :global(.hljs-selector-tag),
  .term :global(.hljs-built_in),
  .term :global(.hljs-literal) {
    color: var(--accent-text);
  }

  .term :global(.hljs-string),
  .term :global(.hljs-attr),
  .term :global(.hljs-template-tag) {
    color: var(--ok);
  }

  .term :global(.hljs-number),
  .term :global(.hljs-symbol),
  .term :global(.hljs-variable) {
    color: var(--danger);
  }

  .term :global(.hljs-comment),
  .term :global(.hljs-quote) {
    color: var(--text-3);
    font-style: italic;
  }

  .term :global(.hljs-title),
  .term :global(.hljs-function),
  .term :global(.hljs-type),
  .term :global(.hljs-property) {
    color: var(--text);
    font-weight: 600;
  }

  .tag {
    display: inline-block;
    margin-bottom: 2px;
    padding: 0 6px;
    border: 1px solid var(--term-line);
    border-radius: 6px;
    color: var(--term-dim);
    font-size: 0.72rem;
  }

  .working {
    margin-top: 6px;
    color: var(--term-accent);
  }

  .cursor {
    display: inline-block;
    width: 0.6em;
    height: 1.1em;
    margin-left: 4px;
    vertical-align: text-bottom;
    background: var(--term-accent);
    animation: blink 1s steps(1) infinite;
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }

  .jump {
    position: absolute;
    left: 50%;
    bottom: 12px;
    translate: -50% 0;
    box-shadow: var(--shadow);
  }

  /* ---------- Files / plan ---------- */

  .pane {
    flex: 1;
    min-height: 0;
    display: grid;
    align-content: start;
    gap: 14px;
    padding: 16px;
  }

  .dropzone {
    justify-items: start;
    border-style: dashed;
    border-width: 1.5px;
    transition: border-color 150ms var(--ease), background-color 150ms var(--ease);
  }

  .dropzone.dragging {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .dropzone p {
    font-size: 0.85rem;
  }

  .pick {
    width: 100%;
    cursor: pointer;
  }

  .pick.disabled {
    opacity: 0.45;
    pointer-events: none;
  }

  .empty-icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .file-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .file {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 8px 12px 14px;
    color: var(--text-3);
  }

  .file-main {
    display: grid;
    gap: 6px;
    min-width: 0;
    flex: 1;
  }

  .file-main strong {
    color: var(--text);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .plan {
    max-width: 720px;
  }

  .none {
    padding: 16px 20px;
    font-size: 0.9rem;
  }

  /* ---------- Changes ---------- */

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
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }

  .refresh {
    margin-left: auto;
  }

  .chip.plus {
    color: var(--ok);
  }

  .chip.minus {
    color: var(--danger);
  }

  .diff {
    flex: 1;
    min-height: 0;
    background: var(--code-bg);
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

  /* ---------- Composer: a shell prompt ---------- */

  .composer {
    flex: none;
    display: grid;
    gap: 8px;
  }

  .ask-pill {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 0 14px;
    border: 1px solid var(--accent-line);
    border-radius: var(--radius-bento);
    background: var(--accent-soft);
    color: var(--accent-text);
    font-weight: 600;
    text-align: left;
  }

  .ask-pill span:first-of-type {
    flex: 1;
  }

  .prompt-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 8px 8px 14px;
    border: 1px solid var(--term-line);
    border-radius: var(--radius-bento);
    background: var(--term-bg);
    color: var(--term-text);
    font-family: var(--mono);
  }

  .prompt-row:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .ps1 {
    align-self: center;
    color: var(--term-accent);
    font-weight: 700;
  }

  .prompt-row textarea {
    flex: 1;
    min-width: 0;
    min-height: 36px;
    max-height: 180px;
    padding: 7px 0;
    border: 0;
    background: transparent;
    color: var(--term-text);
    caret-color: var(--term-accent);
    font: 0.9rem/1.5 var(--mono);
    resize: none;
    outline: none;
  }

  .prompt-row textarea::placeholder {
    color: var(--term-dim);
  }

  .composer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 0 4px;
  }

  .composer-bar .hint {
    font-size: 0.78rem;
    color: var(--text-3);
  }

  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    color: var(--text-2);
    font-size: 0.88rem;
    font-weight: 550;
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
    width: 38px;
    height: 22px;
    border-radius: 999px;
    background: var(--surface-3);
    box-shadow: var(--clay-pressed);
    transition: background-color 150ms var(--ease);
  }

  .track::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--text-3);
    box-shadow: var(--clay-soft);
    transition: translate 200ms ease-out, background-color 150ms var(--ease);
  }

  .toggle input:checked + .track {
    background: var(--accent);
  }

  .toggle input:checked + .track::after {
    translate: 16px 0;
    background: var(--accent-ink);
  }

  .toggle input:focus-visible + .track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .send {
    flex: none;
    min-width: 112px;
    min-height: 44px;
    border-radius: 14px;
  }

  .ended {
    display: flex;
    gap: 1ch;
    padding: 12px 14px;
    border-radius: var(--radius-bento);
    background: var(--term-bg);
    color: var(--term-dim);
    font: 0.85rem var(--mono);
  }

  .ended .glyph {
    color: var(--term-err);
  }

  @media (max-width: 900px) {
    .detail {
      padding: 8px 10px 10px;
      gap: 8px;
    }

    .title {
      font-size: 1.05rem;
    }

    /* Icon and label stay inline; tabs are compact but still 48px tall. */
    .tabs {
      gap: 4px;
      padding: 4px;
    }

    .tabs button {
      gap: 5px;
      min-height: 48px;
      padding: 0 4px;
      font-size: 0.78rem;
    }

    .tabs button :global(.icon) {
      width: 16px;
      height: 16px;
    }

    .feed {
      padding: 12px;
      font-size: 0.8rem;
    }

    .line time {
      display: none;
    }

    .line {
      grid-template-columns: 1.4ch minmax(0, 1fr);
    }
  }
</style>
