<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { page } from '$app/state';
  import AskSheet from '#lib/AskSheet.svelte';
  import TerminalPopup from '#lib/TerminalPopup.svelte';
  import { matchingSlashCommands } from '#lib/slash-commands.ts';
  import AutomatedSessionBadge from '#lib/AutomatedSessionBadge.svelte';
  import Icon from '#lib/Icon.svelte';
  import ArchiveSession from '#lib/ArchiveSession.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { formatBytes, prettyPath, relativeTime, sessionTitle, statusLabel } from '#lib/format.ts';
  import { contextUsage, estimatedCost } from '#lib/usage.ts';
  import { prettify, renderMarkdown } from '#lib/markdown.ts';
  import { errorMessage, toasts } from '#lib/toast.svelte.ts';
  import type { ActivityEntry } from '#lib/activity.ts';
  import { isShellTool, shellLabel, shellPreview } from '#lib/shell-activity.ts';
  import type { TempFile } from '#lib/types.ts';
  import { attachmentPrompt, canPreviewAttachment, validateAttachment } from '#lib/attachments.ts';
  import { filterChangedFiles, splitChangedFiles, diffLineClass as lineClass } from '#lib/diff.ts';

  /** A tool entry's body is its arguments, then "\n→ " and the result once it finishes. */
  function toolParts(entry: ActivityEntry) {
    const split = entry.body.indexOf('\n→ ');
    if (split >= 0) return { args: entry.body.slice(0, split), result: entry.body.slice(split + 3) };
    return entry.toolCallId ? { args: entry.body, result: '' } : { args: '', result: entry.body };
  }

  type ToolSummary =
    | { kind: 'command'; command: string }
    | { kind: 'file'; path: string; range: string; oldText: string; newText: string }
    | { kind: 'search'; pattern: string; path: string }
    | { kind: 'questions'; questions: string[] }
    | { kind: 'values'; values: { key: string; value: string }[] };

  function inputFor(entry: ActivityEntry, args: string): Record<string, unknown> {
    if (entry.input) return entry.input;
    try {
      const parsed: unknown = JSON.parse(args);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  function textValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function fallbackCommand(args: string): string {
    const match = args.match(/["']?command["']?\s*:\s*"((?:\\.|[^"\\])*)/);
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        return match[1];
      }
    }
    return args.replace(/[{}"]/g, '').replace(/\s+/g, ' ').trim();
  }

  function toolSummary(entry: ActivityEntry, args: string): ToolSummary {
    const input = inputFor(entry, args);
    const tool = entry.title.toLowerCase();
    const first = (...keys: string[]) => keys.map((key) => input[key]).find((value) => value != null);
    if (isShellTool(tool)) {
      return { kind: 'command', command: textValue(first('command', 'cmd') ?? fallbackCommand(args)).trim() };
    }
    if (/^(read|write|edit)$/.test(tool)) {
      const lineRange = first('line_range', 'lineRange', 'lines');
      const offset = first('offset');
      const limit = first('limit', 'length', 'num_lines', 'numLines');
      const rangeParts = lineRange != null ? [`lines ${textValue(lineRange)}`] : offset != null ? [`offset ${textValue(offset)}`] : [];
      if (limit != null) rangeParts.push(`limit ${textValue(limit)}`);
      const range = rangeParts.join(' · ');
      return {
        kind: 'file',
        path: textValue(first('path', 'file_path', 'filePath') ?? 'unknown path'),
        range,
        oldText: textValue(first('oldText', 'old_text', 'old_string', 'old')),
        newText: textValue(first('newText', 'new_text', 'new_string', 'new'))
      };
    }
    if (/^(grep|find|ls|glob)$/.test(tool)) {
      return {
        kind: 'search',
        pattern: textValue(first('pattern', 'query', 'name') ?? ''),
        path: textValue(first('path', 'file_path', 'directory', 'cwd') ?? '')
      };
    }
    if (/^(companion_ask_user|jar_ask)$/.test(tool)) {
      const raw = first('questions', 'question', 'prompt');
      const label = (item: unknown) =>
        item && typeof item === 'object' && 'question' in item ? textValue(item.question) : textValue(item);
      const questions = Array.isArray(raw) ? raw.map(label) : raw == null ? [] : [label(raw)];
      return { kind: 'questions', questions };
    }
    const values = Object.entries(input).slice(0, 8).map(([key, value]) => ({
      key,
      value: textValue(value).replace(/\s+/g, ' ').slice(0, 120)
    }));
    if (!values.length && args.trim()) {
      return { kind: 'values', values: [{ key: 'arguments', value: args.replace(/[{}"]/g, '').replace(/\s+/g, ' ').slice(0, 160) }] };
    }
    return { kind: 'values', values };
  }

  const lineCount = (text: string) => text.split('\n').length;

  /** "Thought for 12s" once reasoning ends; the next feed entry marks when it stopped. */
  function thoughtLabel(entry: ActivityEntry, next?: ActivityEntry) {
    const seconds = next ? Math.round((next.at - entry.at) / 1000) : 0;
    if (seconds < 1) return 'Thought';
    if (seconds < 60) return `Thought for ${seconds}s`;
    return `Thought for ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  /** Latest readable line of a streaming thought, stripped of markdown syntax. */
  function lastThoughtLine(text: string) {
    const line = text.split('\n').map(part => part.trim()).filter(Boolean).at(-1) ?? '';
    return line.replace(/^[#>*\-\d.)\s]+/, '').replace(/[*_`]+/g, '').slice(-160);
  }

  type Tab = 'activity' | 'files' | 'changes';

  const id = $derived(page.params.id ?? '');
  const session = $derived(companion.session(id));
  const ended = $derived(session?.status === 'stopped');
  const readOnly = $derived(Boolean(session?.readOnly || session?.automationId));
  const feed = $derived(companion.activity[id] ?? []);
  /** Uploads use HTTP, not the live socket; only a deliberate disconnect/revocation blocks them. */
  const uploadBlocked = $derived(companion.connection === 'disconnected' || companion.connection === 'revoked');
  const asks = $derived(companion.asks[id] ?? []);
  const files = $derived(companion.files[id] ?? []);
  let fileFilter = $state('');
  const filteredFiles = $derived(files.filter(file => file.name.toLocaleLowerCase().includes(fileFilter.trim().toLocaleLowerCase())));
  const diff = $derived(companion.diffs[id]);

  let tab = $state<Tab>('activity');
  let prompt = $state('');
  let slashIndex = $state(0);
  let slashDismissed = $state(false);
  const slashMatches = $derived.by(() => !readOnly && !ended && mode === 'auto' && !slashDismissed ? matchingSlashCommands(prompt, session?.commands ?? []) : []);
  const activeSlashIndex = $derived(Math.min(slashIndex, Math.max(0, slashMatches.length - 1)));
  function chooseSlash(name: string) {
    prompt = '/' + name + ' ';
    slashDismissed = false;
    void tick().then(() => { promptEl?.focus(); autosize(); });
  }
  let steer = $state(false);
  let mode = $state<'auto' | 'plan'>('auto');
  let menuEl = $state<HTMLDetailsElement | null>(null);
  let staged = $state(false);
  let infoOpen = $state(false);
  let askOpen = $state(false);
  type DraftAttachment = { key: number; sessionId: string; file: File; preview: string; previewUnavailable?: boolean; status: 'uploading' | 'ready' | 'error'; error: string; uploaded?: TempFile };
  let attachmentKey = 0;
  let draftGeneration = 0;
  let disposed = false;
  let attachments = $state<DraftAttachment[]>([]);
  const uploading = $derived(attachments.filter((attachment) => attachment.status === 'uploading').length);
  const invalidAttachments = $derived(attachments.some((attachment) => attachment.status === 'error'));
  let diffFilter = $state('');
  const changedFiles = $derived(splitChangedFiles(diff?.text ?? ''));
  const shownChangedFiles = $derived(filterChangedFiles(changedFiles, diffFilter));

  function releasePreviews(items = attachments) {
    for (const item of items) if (item.preview) URL.revokeObjectURL(item.preview);
  }
  onDestroy(() => { disposed = true; releasePreviews(); });

  function updateAttachment(key: number, patch: Partial<DraftAttachment>) {
    attachments = attachments.map((item) => item.key === key ? { ...item, ...patch } : item);
  }

  function markPreviewUnavailable(key: number) {
    const item = attachments.find((attachment) => attachment.key === key);
    if (!item?.preview) return;
    URL.revokeObjectURL(item.preview);
    updateAttachment(key, { preview: '', previewUnavailable: true });
  }

  function detachAttachment(key: number) {
    const item = attachments.find((attachment) => attachment.key === key);
    if (!item || item.status === 'uploading') return;
    releasePreviews([item]);
    attachments = attachments.filter((attachment) => attachment.key !== key);
  }
  let dragging = $state(false);
  let follow = $state(true);
  let unseen = $state(0);
  let feedEl = $state<HTMLDivElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let promptEl = $state<HTMLTextAreaElement | null>(null);

  // Reset per-session UI state when navigating between sessions.
  let lastId = '';
  $effect(() => {
    if (id === lastId) return;
    lastId = id;
    tab = 'activity';
    prompt = '';
    mode = 'auto';
    steer = false;
    releasePreviews();
    attachments = [];
    draftGeneration += 1;
    diffFilter = '';
    infoOpen = false;
    follow = true;
    unseen = 0;
    if (session && !ended && !readOnly) void companion.refreshFiles(id).catch(() => {});
    void companion.loadActivity(id).catch(() => {});
  });

  // A real end/unshare invalidates uploads; an ordinary outage preserves drafts.
  $effect(() => {
    if (!ended && (session || companion.connection !== 'online')) return;
    if (!attachments.length) return;
    releasePreviews();
    attachments = [];
    draftGeneration += 1;
    toasts.show('Session ended or is no longer shared. Draft attachments were cleared; message text was kept.', 'info');
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
    if (readOnly && next !== 'activity') return;
    if (menuEl) menuEl.open = false;
    tab = next;
    if (next === 'files') void companion.refreshFiles(id).catch(() => {});
    if (next === 'changes' && !diff) loadDiff();
  }

  function menuKey(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !menuEl?.open) return;
    event.preventDefault();
    menuEl.open = false;
    menuEl.querySelector('summary')?.focus();
  }

  function closeMenuOutside(event: PointerEvent) {
    if (menuEl?.open && !menuEl.contains(event.target as Node | null)) menuEl.open = false;
  }

  // Reflow an existing draft on rotation or when returning from an accessory panel.
  $effect(() => {
    const element = promptEl;
    if (!element) return;
    let width = -1;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      autosize();
    });
    observer.observe(element);
    autosize();
    return () => observer.disconnect();
  });

  function submit() {
    const uploaded = attachments.flatMap((attachment) => attachment.status === 'ready' && attachment.uploaded ? [attachment.uploaded] : []);
    const text = attachmentPrompt(prompt, uploaded);
    if (readOnly || ended || uploading || invalidAttachments || (mode === 'auto' && !text)) return;
    const sent = mode === 'plan'
      ? companion.send(id, { type: 'plan', text })
      : companion.prompt(id, text, steer && session?.status === 'active');
    if (!sent) {
      toasts.show('Not connected. Your message was not sent.', 'error');
      return;
    }
    if (mode === 'plan') toasts.show('Planning requested. Follow along in Activity.', 'success');
    prompt = '';
    releasePreviews();
    attachments = [];
    steer = false;
    follow = true;
    tab = 'activity';
    void tick().then(autosize);
  }

  function onComposerKey(event: KeyboardEvent) {
    if (slashMatches.length && !event.isComposing) {
      if (event.key === 'Escape') { event.preventDefault(); slashDismissed = true; return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        slashIndex = (activeSlashIndex + (event.key === 'ArrowDown' ? 1 : -1) + slashMatches.length) % slashMatches.length;
        document.getElementById('slash-option-' + slashIndex)?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault(); chooseSlash(slashMatches[activeSlashIndex].name); return;
      }
    }
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
    promptEl.style.height = Math.min(promptEl.scrollHeight, Math.max(80, Math.min(180, innerHeight * 0.24))) + 'px';
  }

  function loadDiff(nextStaged = staged) {
    if (readOnly || ended) return;
    staged = nextStaged;
    if (!companion.send(id, { type: 'git_diff', staged: nextStaged })) toasts.show('Not connected.', 'error');
  }

  async function uploadFiles(list: FileList | File[] | null | undefined) {
    if (!list || readOnly || ended) return;
    const targetSession = id;
    const generation = draftGeneration;
    const picker = fileInput;
    const items: DraftAttachment[] = Array.from(list).map((file) => ({ key: ++attachmentKey, sessionId: targetSession, file, preview: '', status: 'uploading', error: '' }));
    attachments = [...attachments, ...items];
    let policyError = '';
    try { await companion.refreshUploadPolicy(); }
    catch (error) { policyError = errorMessage(error); }
    for (const item of items) {
      if (disposed || id !== targetSession || generation !== draftGeneration) continue;
      // Uploads are plain HTTP and do not need the live socket. On phones the file picker
      // backgrounds the page, so the socket is often still reconnecting when the picker
      // returns; only a deliberate disconnect or revoked access blocks attaching.
      const error = policyError || validateAttachment(item.file, companion.uploadPolicy) || (uploadBlocked ? 'Reconnect to your workspace before attaching files.' : '');
      if (error) { updateAttachment(item.key, { status: 'error', error }); continue; }
      try {
        if (canPreviewAttachment(item.file)) updateAttachment(item.key, { preview: URL.createObjectURL(item.file) });
        if (canPreviewAttachment(item.file) && typeof createImageBitmap === 'function') {
          try { const bitmap = await createImageBitmap(item.file); bitmap.close(); }
          catch { throw new Error('This image could not be read. Choose a valid image file and try again.'); }
        }
        if (disposed || id !== targetSession || generation !== draftGeneration) continue;
        const uploaded = await companion.upload(targetSession, item.file);
        if (!disposed && id === targetSession && generation === draftGeneration) updateAttachment(item.key, { status: 'ready', uploaded });
      } catch (error) {
        if (!disposed && id === targetSession && generation === draftGeneration) updateAttachment(item.key, { status: 'error', error: errorMessage(error) });
      }
    }
    if (picker && id === targetSession && generation === draftGeneration) picker.value = '';
  }

  let downloading = $state<string[]>([]);
  async function download(file: import('#lib/types.ts').TempFile) {
    downloading = [...downloading, file.id];
    try { await companion.downloadFile(id, file); }
    catch (error) { toasts.show(errorMessage(error), 'error'); }
    finally { downloading = downloading.filter(fileId => fileId !== file.id); }
  }

  async function remove(fileId: string, name: string) {
    const targetSession = id;
    try {
      await companion.removeFile(targetSession, fileId);
      if (id !== targetSession || disposed) return;
      for (const item of attachments.filter((attachment) => attachment.uploaded?.id === fileId)) detachAttachment(item.key);
      toasts.show(name + ' removed.');
    } catch (error) {
      if (id === targetSession && !disposed) toasts.show(errorMessage(error), 'error');
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

  const diffStats = $derived({ add: changedFiles.reduce((total, file) => total + file.additions, 0), del: changedFiles.reduce((total, file) => total + file.deletions, 0), files: changedFiles.length });
</script>

<svelte:window onkeydown={menuKey} onpointerdown={closeMenuOutside} />
<svelte:head><title>{session ? sessionTitle(session) : 'Session'} · Pi Companion</title></svelte:head>

{#if !session}
  <div class="page">
    <div class="card empty">
      <span class="empty-icon"><Icon name="sessions" /></span>
      {#if companion.connection !== 'online'}
        <h2>Waiting for workspace connection</h2>
        <p>We cannot confirm this session’s status until your workspace reconnects.</p>
      {:else}
        <h2>Session not found</h2>
        <p>It may have ended before the daemon restarted{companion.remote ? ', or your computer stopped sharing it' : ''}.</p>
      {/if}
      <a class="btn btn-sm" href="/sessions"><Icon name="back" size={16} />All sessions</a>
    </div>
  </div>
{:else}
  <div class="detail">
    <header class="head">
      <a class="btn btn-ghost btn-icon" href="/sessions" aria-label="All sessions"><Icon name="back" /></a>
      <h1 class="title">
        <button aria-expanded={infoOpen} aria-controls="session-info" aria-label="Session information: {sessionTitle(session)}. Status: {statusLabel[session.status]}" title="Show session information" onclick={() => (infoOpen = !infoOpen)}>
          <span class="dot {session.status} session-dot" aria-hidden="true"></span>
          <span>{sessionTitle(session)}</span>
          <Icon name="chevron" size={16} class="caret" />
        </button>
      </h1>
      {#if asks.length}
        <button class="badge count ask-count" onclick={() => (askOpen = true)} aria-label="{asks.length} {asks.length === 1 ? 'question' : 'questions'} waiting, open">
          {asks.length}
        </button>
      {/if}
      <details class="session-menu" bind:this={menuEl}>
        <summary class="btn btn-ghost btn-icon" aria-label="Session options" title="Session options"><Icon name="more" /></summary>
        <div class="menu-actions">
          {#if !readOnly}
            <button type="button" class="btn btn-ghost" onclick={() => selectTab('files')}><Icon name="folder" size={16} />Shared files{#if files.length}<span class="badge count quiet">{files.length}</span>{/if}</button>
            <button type="button" class="btn btn-ghost" onclick={() => selectTab('changes')}><Icon name="diff" size={16} />Changes{#if diffStats.files}<span class="badge count quiet">{diffStats.files}</span>{/if}</button>
          {/if}
          <ArchiveSession {session} redirect />
          {#if !ended}<p>Only ended sessions can be archived.</p>{/if}
        </div>
      </details>
    </header>

    <div class="info chips" id="session-info" hidden={!infoOpen}>
      <span class="chip"><span class="dot {session.status}" aria-hidden="true"></span><span>Status: {statusLabel[session.status]}</span></span>
      <span class="chip mono" title={session.cwd}><Icon name="folder" size={13} /><span>{prettyPath(session.cwd)}</span></span>
      {#if session.mainModel}<span class="chip"><Icon name="sparkle" size={13} /><span>{session.mainModel}</span></span>{/if}
      {#if session.effort}<span class="chip"><Icon name="brain" size={13} /><span>{session.effort}</span></span>{/if}
      <span class="chip" title={session.telemetry?.context?.source ? `Reported by ${session.telemetry.context.source}${ended ? ' · last session snapshot' : ''}` : 'Context usage is unavailable until Pi or an extension reports it.'}>
        <Icon name="activity" size={13} /><span>Context{ended ? ' (last report)' : ''}: {contextUsage(session.telemetry?.context)}</span>
      </span>
      <span class="chip" title={session.telemetry?.cost?.source ? `Reported by ${session.telemetry.cost.source}. Estimated, not a billing total.` : 'Estimated session cost, not a billing total. Unavailable until Pi or an extension reports it.'}>
        <span>Estimated cost: {estimatedCost(session.telemetry?.cost)}</span>
      </span>
      {#if companion.isAdmin}
        <span class="chip" class:on={session.remoteEnabled}>
          <Icon name="link" size={13} /><span>{session.remoteEnabled ? 'Shared with devices' : 'Not shared · run /companion'}</span>
        </span>
      {/if}
      <span class="chip"><span>Started {relativeTime(session.connectedAt)}</span></span>
    </div>

    {#if readOnly}<div class="composer-notice" role="status"><AutomatedSessionBadge /><p>Pi is following this automation’s instructions. You can answer its questions here; steering, plans, and file uploads are turned off.</p>{#if session.automationId}<a href={'/automations/' + encodeURIComponent(session.automationId)}>Open automation workspace →</a>{/if}</div>{/if}
    <section class="panel">
      {#if tab !== 'activity'}
        <header class="accessory-head">
          <button type="button" class="btn btn-ghost btn-sm" onclick={() => selectTab('activity')}><Icon name="back" size={16} />Activity</button>
          <h2>{tab === 'files' ? 'Shared files' : 'Changes'}</h2>
          <button type="button" class="btn btn-ghost btn-icon" aria-label="Close {tab === 'files' ? 'shared files' : 'changes'}" onclick={() => selectTab('activity')}><Icon name="close" size={16} /></button>
        </header>
      {/if}
      <input bind:this={fileInput} id="file-input" hidden type="file" multiple accept={companion.uploadPolicy.allowedUploadTypes.join(',') || undefined} disabled={ended || uploadBlocked} onchange={(e) => uploadFiles((e.currentTarget as HTMLInputElement).files)} />
      <div class="body" id="panel" role="region" aria-label={tab === 'activity' ? 'Session activity' : tab === 'files' ? 'Shared files' : 'Changes'}>
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
                  {#each feed as entry, index (entry.id)}
                    {@const liveThought = entry.kind === 'thinking' && index === feed.length - 1 && session.status === 'active'}
                    <li class="line {entry.kind} {entry.status ?? ''}" class:live-thought={liveThought}>
                      <span class="glyph" aria-hidden="true">{glyph[entry.kind]}</span>
                      <div class="line-main">
                        {#if entry.kind === 'tool'}
                          {@const parts = toolParts(entry)}
                          {@const summary = toolSummary(entry, parts.args)}
                          <div class="cmd">
                            {#if summary.kind === 'command'}
                              <b class="shell-label" title={summary.command}>{shellLabel(inputFor(entry, parts.args), entry.status)}</b>
                            {:else}
                              <b>{entry.title}</b>
                            {/if}
                            {#if entry.status === 'running'}<span class="state run">running</span>
                            {:else if entry.status === 'ok'}<span class="state ok">ok</span>
                            {:else if entry.status === 'error'}<span class="state err">failed</span>{/if}
                          </div>
                          {#if summary.kind === 'command'}
                            {@const preview = shellPreview(parts.result)}
                            {#if preview.text}
                              <pre class="shell-preview" class:error-output={entry.status === 'error'} aria-label="Shell output preview">{preview.truncated ? '…\n' : ''}{preview.text}</pre>
                              {#if preview.truncated}
                                <details class="out"><summary>Full output · {preview.lines} {preview.lines === 1 ? 'line' : 'lines'}</summary><pre class:error-output={entry.status === 'error'}>{parts.result}</pre></details>
                              {/if}
                            {:else}
                              <p class="shell-quiet">{entry.status === 'running' ? 'Waiting for output…' : 'No output returned.'}</p>
                            {/if}
                          {:else if summary.kind === 'file'}
                            <div class="tool-summary">
                              <code class="path-chip">{summary.path}</code>
                              {#if summary.range}<span class="range">{summary.range}</span>{/if}
                            </div>
                            {#if entry.title.toLowerCase() === 'edit' && (summary.oldText || summary.newText)}
                              <details class="edit-snippet">
                                <summary>edit preview</summary>
                                <div class="edit-pair">
                                  {#if summary.oldText}<pre class="old-snippet">{summary.oldText}</pre>{/if}
                                  {#if summary.newText}<pre class="new-snippet">{summary.newText}</pre>{/if}
                                </div>
                              </details>
                            {/if}
                          {:else if summary.kind === 'search'}
                            <div class="tool-summary">
                              {#if summary.pattern}<code class="pattern">{summary.pattern}</code>{/if}
                              {#if summary.path}<code class="path-chip">{summary.path}</code>{/if}
                            </div>
                          {:else if summary.kind === 'questions'}
                            {#if summary.questions.length}
                              <ul class="question-list">{#each summary.questions as question}<li>{question}</li>{/each}</ul>
                            {/if}
                          {:else if summary.kind === 'values' && summary.values.length}
                            <dl class="tool-values">
                              {#each summary.values as value}
                                <div><dt>{value.key}</dt><dd>{value.value}</dd></div>
                              {/each}
                            </dl>
                          {/if}
                          {#if parts.result && summary.kind !== 'command'}
                            {@const lines = lineCount(parts.result)}
                            <details class="out" open={entry.status === 'error' || lines <= 6}>
                              <summary>output · {lines} {lines === 1 ? 'line' : 'lines'}</summary>
                              <pre class:error-output={entry.status === 'error'}>{parts.result}</pre>
                            </details>
                          {/if}
                        {:else if entry.kind === 'lifecycle'}
                          <span>{entry.title}{entry.body ? ' · ' + entry.body : ''}</span>
                        {:else if entry.kind === 'error'}
                          <pre><b>{entry.title}:</b> {entry.body}</pre>
                        {:else if entry.kind === 'thinking'}
                          <details class="thought" class:live={liveThought}>
                            <summary>
                              {#if liveThought}
                                <span class="thought-label shimmer">Thinking</span><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                              {:else}
                                <span class="thought-label">{thoughtLabel(entry, feed[index + 1])}</span>
                              {/if}
                            </summary>
                            <div class="md thought-body" use:prettify={{ text: entry.body, final: !liveThought }}>{@html renderMarkdown(entry.body)}</div>
                          </details>
                          {#if liveThought && lastThoughtLine(entry.body)}
                            <p class="thought-peek" aria-hidden="true">{lastThoughtLine(entry.body)}</p>
                          {/if}
                        {:else if entry.kind === 'assistant'}
                          {@const final = entry !== feed.at(-1) || session.status !== 'active'}
                          <div class="md" use:prettify={{ text: entry.body, final }}>{@html renderMarkdown(entry.body)}</div>
                        {:else if entry.kind === 'user'}
                          <div class="speaker">You <span>{entry.title === 'You' ? 'Message' : entry.title.replace('You · ', '')}</span></div>
                          <pre class="user-message">{entry.body}</pre>
                        {:else}
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
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard users must be able to scroll this region) -->
          <div class="pane scroll" tabindex="0" role="region" aria-label="Session files">
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
              <button type="button" class="btn-bento primary pick" class:disabled={ended} disabled={ended || uploading > 0 || uploadBlocked} onclick={() => fileInput?.click()}><Icon name="plus" size={18} />Choose files</button>
            </div>
            {#if invalidAttachments}
              <ul class="upload-errors" aria-label="Attachment errors">{#each attachments.filter((attachment) => attachment.status === 'error') as attachment (attachment.key)}<li role="alert"><strong>{attachment.file.name}</strong>: {attachment.error}<button type="button" class="btn btn-sm" onclick={() => detachAttachment(attachment.key)}>Dismiss</button></li>{/each}</ul>
            {/if}

            {#if files.length}
              <div class="file-filter"><label for="shared-file-filter">Filter by filename</label><input id="shared-file-filter" class="input" type="search" placeholder="Search shared files…" bind:value={fileFilter} /><span class="muted">{filteredFiles.length} of {files.length} files</span></div>
              {#if !filteredFiles.length}<p class="muted" role="status">No filenames match “{fileFilter}”.</p>{/if}
              <ul class="bento file-list">
                {#each filteredFiles as file (file.id)}
                  <li class="tile file">
                    <Icon name="file" />
                    <div class="file-main">
                      <strong title={file.name}>{file.name}</strong>
                      <span class="chips"><span class="chip" title="File upload source">{file.source === 'agent' ? 'Agent' : file.source === 'user' ? 'You' : 'Unknown'}</span><span class="chip">{formatBytes(file.size)}</span><span class="chip">{relativeTime(file.createdAt)}</span></span>
                    </div>
                    <button class="btn" aria-label="Download {file.name}" disabled={downloading.includes(file.id)} onclick={() => download(file)}><Icon name="download" size={16} />{downloading.includes(file.id) ? 'Downloading…' : 'Download'}</button>
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
                <button aria-pressed={!staged} disabled={ended} onclick={() => loadDiff(false)}>Unstaged</button>
                <button aria-pressed={staged} disabled={ended} onclick={() => loadDiff(true)}>Staged</button>
              </div>
              {#if diff?.text}
                <span class="chips">
                  <span class="chip plus">+{diffStats.add}</span>
                  <span class="chip minus">−{diffStats.del}</span>
                </span>
              {/if}
              <button class="btn btn-ghost btn-icon refresh" aria-label="Refresh changes" onclick={() => loadDiff()} disabled={ended}><Icon name="refresh" size={16} /></button>
            </div>
            <div class="diff-filter-bar"><label class="diff-filter"><Icon name="search" size={16} /><span class="sr-only">Filter changed files</span><input class="input" type="search" placeholder="Filter changed files…" bind:value={diffFilter} /></label><span class="diff-count" aria-live="polite">{shownChangedFiles.length} of {changedFiles.length} files</span></div>
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard users must be able to scroll this region) -->
            <div class="diff scroll" tabindex="0" role="region" aria-label="Changed files">
              {#if !diff}
                <p class="subtle none">{ended ? 'Changes are unavailable after the session ends.' : companion.connection !== 'online' ? 'Reconnect to your workspace to load changes.' : 'Loading changes…'}</p>
              {:else if diff.error}<p class="subtle none">Changes unavailable. {diff.error}</p>
              {:else if !diff.text.trim()}<p class="subtle none">No {diff.staged ? 'staged' : 'unstaged'} changes.</p>
              {:else if !shownChangedFiles.length}<div class="none"><p>No changed files match “{diffFilter}”.</p><button type="button" class="btn btn-sm" onclick={() => (diffFilter = '')}>Clear file filter</button></div>
              {:else}
                {#each shownChangedFiles as file (file.id)}
                  <details class="diff-file" open>
                    <summary class="diff-file-head">
                      <Icon name="chevron" size={16} class="diff-caret" />
                      <div class="diff-label"><strong><Icon name="file" size={16} /><code>{file.path}</code></strong>{#if file.oldPath && file.newPath && file.oldPath !== file.newPath}<span class="diff-rename">Renamed from <code>{file.oldPath}</code></span>{/if}</div>
                      <span class="file-change-counts">{#if file.binary}<span class="chip">Binary file</span>{:else}<span class="chip plus">+{file.additions}</span><span class="chip minus">−{file.deletions}</span>{/if}</span>
                    </summary>
                    <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard users must be able to scroll long patch lines) -->
                    <div class="diff-code scroll-x" tabindex="0" role="region" aria-label="Patch for {file.path}">
                      <pre>{#each file.lines as line, index (index)}<span class={lineClass(line)}>{line || ' '}</span>{/each}</pre>
                    </div>
                  </details>
                {/each}
              {/if}
            </div>
          </div>
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
          {#if readOnly}
            <p class="ended"><span class="glyph">~</span>Automation controls are on the automation detail page.</p>
          {:else if ended}
            <p class="ended"><span class="glyph">!</span>Session ended. History is read-only.</p>
          {:else}
            {#if attachments.length}
              <ul class="selected-attachments" aria-label="Files attached to this message">
                {#each attachments as attachment (attachment.key)}
                  <li class="attachment-card" class:invalid={attachment.status === 'error'}>
                    {#if attachment.preview && attachment.status !== 'error'}<img class="attachment-preview" src={attachment.preview} alt="" onerror={() => markPreviewUnavailable(attachment.key)} />{:else}<span class="attachment-icon"><Icon name={attachment.status === 'error' ? 'alert' : 'file'} size={20} /></span>{/if}
                    <div class="attachment-copy"><strong title={attachment.file.name}>{attachment.file.name}</strong><span>{formatBytes(attachment.file.size)} · {attachment.status === 'uploading' ? 'Uploading…' : attachment.status === 'ready' ? 'Ready' : 'Not attached'}</span>{#if attachment.error}<p class="attachment-error" role="alert">{attachment.error}</p>{/if}{#if attachment.previewUnavailable && attachment.status === 'ready'}<p class="attachment-preview-note">Preview unavailable. File is still attached.</p>{/if}</div>
                    <button type="button" class="btn btn-ghost btn-icon attachment-remove" aria-label="Remove attachment: {attachment.file.name}" title="Remove from this message; uploaded files remain in Shared files" disabled={attachment.status === 'uploading'} onclick={() => detachAttachment(attachment.key)}><Icon name="close" size={14} /></button>
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="prompt-row">
              {#if slashMatches.length}<div class="slash-picker" id="slash-suggestions" role="listbox" aria-label="Available slash commands">{#each slashMatches as command, index (command.name)}<div id={'slash-option-' + index} role="option" aria-selected={index === activeSlashIndex}><button type="button" tabindex="-1" onpointerdown={event => event.preventDefault()} onclick={() => chooseSlash(command.name)}><span class="slash-command"><Icon name={command.source === 'skill' ? 'brain' : command.source === 'prompt' ? 'file' : 'lightning'} size={16} /><strong>/{command.name}</strong><span class="slash-kind">{command.source === 'prompt' ? 'Template' : command.source === 'skill' ? 'Skill' : 'Command'}</span></span>{#if command.description}<small>{command.description}</small>{/if}</button></div>{/each}</div>{/if}
              <label class="sr-only" for="prompt">{mode === 'plan' ? 'Plan request for Pi' : 'Message Pi'}</label>
              <textarea
                id="prompt"
                rows="1"
                bind:this={promptEl}
                bind:value={prompt}
                oninput={() => { slashIndex = 0; slashDismissed = false; autosize(); }}
                aria-controls={slashMatches.length ? 'slash-suggestions' : undefined}
                aria-activedescendant={slashMatches.length ? 'slash-option-' + activeSlashIndex : undefined}
                onkeydown={onComposerKey}
                title="Enter sends on desktop; Shift+Enter adds a line. On touch keyboards, Enter adds a line."
                placeholder={mode === 'plan' ? 'Plan current conversation…' : steer && session.status === 'active' ? 'Steer the current turn…' : 'Message Pi…'}></textarea>
            </div>
            <div class="composer-bar">
              <div class="mode-switch segmented" role="group" aria-label="Message mode">
                <button type="button" aria-pressed={mode === 'auto'} title="Send a normal prompt; does not change Pi permissions" onclick={() => (mode = 'auto')}>Auto</button>
                <button type="button" aria-pressed={mode === 'plan'} title="Run /plan; leave the message empty to use the current conversation" onclick={() => (mode = 'plan')}><Icon name="plan" size={14} />Plan</button>
              </div>
              {#if session.status === 'active' && mode === 'auto'}
                <label class="toggle" title="Send into the turn Pi is working on instead of queueing a new prompt">
                  <input type="checkbox" bind:checked={steer} />
                  <span class="track" aria-hidden="true"></span>
                  Steer
                </label>
              {/if}
              <div class="composer-actions"><button type="button" class="btn btn-ghost btn-icon attach" aria-label={uploading ? 'Uploading files' : 'Attach files'} title="Attach files" disabled={uploading > 0 || uploadBlocked} onclick={() => fileInput?.click()}><Icon name="attach" size={20} /></button></div>
            </div>
            {#if uploading || invalidAttachments}<p class="composer-notice" role="status">{uploading ? 'Wait for attachments to finish uploading before sending.' : 'Fix or remove invalid attachments before sending.'}</p>{/if}
            <button class="btn btn-primary send" aria-label={mode === 'plan' ? 'Send plan request' : steer && session.status === 'active' ? 'Steer current turn' : 'Send message'} disabled={companion.connection !== 'online' || uploading > 0 || invalidAttachments || (mode === 'auto' && !prompt.trim() && !attachments.some((attachment) => attachment.status === 'ready'))}>
              <Icon name="send" size={18} /><span>{mode === 'plan' ? !prompt.trim() && !attachments.length ? 'Plan current conversation' : 'Send plan request' : steer && session.status === 'active' ? 'Steer current turn' : 'Send message'}</span>
            </button>
          {/if}
        </form>
      {/if}
    </section>
  </div>

  {#if !ended}
    <AskSheet sessionId={id} {asks} bind:open={askOpen} />
    <TerminalPopup sessionId={id} popups={session?.popups ?? []} />
  {/if}
{/if}

<style>
  .shell-preview { margin: 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .shell-quiet { margin: 6px 0; color: var(--text-2); font-size: .8rem; }
  .shell-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto !important; min-width: 0; }
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
    min-width: 0;
    overflow: hidden;
  }

  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .head > .btn-icon { width: 48px; min-width: 48px; min-height: 48px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface-2); box-shadow: var(--clay-soft); }

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
    min-height: 48px;
    padding: 0 8px;
    border: 0;
    border-radius: 12px;
    background: none;
    font: inherit;
    letter-spacing: inherit;
    text-align: left;
  }

  .title button:hover { background: var(--surface-2); box-shadow: var(--clay-soft); }
  .title .session-dot { flex: none; width: 10px; height: 10px; box-shadow: 0 0 0 4px var(--surface-2), var(--clay-soft); }
  .info { border: 1px solid var(--border); border-radius: 16px; background: var(--surface); box-shadow: var(--clay-pressed); }
  .info:not([hidden]) { padding: 10px; }

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
    min-height: 44px;
    min-width: 44px;
  }

  .info {
    flex: none;
    padding: 0 4px;
  }

  .info[hidden] {
    display: none;
  }

  .panel {
    flex: 1 1 0;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .session-menu { position: relative; flex: none; }
  .session-menu summary { display: grid; place-items: center; list-style: none; cursor: pointer; width: 48px; min-width: 48px; min-height: 48px; padding: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--surface-2); box-shadow: var(--clay-soft); }
  .session-menu summary:hover { background: var(--surface-3); }
  .session-menu[open] > summary, .session-menu summary:active { box-shadow: var(--clay-pressed); }
  .session-menu summary::-webkit-details-marker { display: none; }
  .session-menu > summary::before { display: none; }
  .menu-actions {
    position: absolute;
    z-index: 30;
    top: calc(100% + 6px);
    right: 0;
    width: min(260px, calc(100vw - 28px));
    display: grid;
    gap: 8px;
    padding: 6px;
    border: 1px solid var(--border-strong);
    border-radius: 16px;
    background: var(--surface);
    box-shadow: var(--clay-raised);
  }
  .menu-actions > button { justify-content: flex-start; min-height: 44px; }
  .menu-actions p { margin: 2px 10px 6px; color: var(--text-3); font-size: 0.75rem; }
  .accessory-head { display: flex; align-items: center; gap: 10px; min-height: 44px; }
  .accessory-head h2 { flex: 1; margin: 0; font-size: 0.95rem; }
  .accessory-head > button { border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2); box-shadow: var(--clay-soft); }

  .body {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    min-width: 0;
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

  .line.user {
    margin: 14px 0 14px clamp(0px, 4vw, 36px);
    padding: 14px 16px;
    border: 1px solid color-mix(in srgb, var(--term-accent) 40%, transparent);
    border-left: 4px solid var(--term-accent);
    border-radius: 14px;
    background: color-mix(in srgb, var(--term-accent) 9%, var(--term-bg));
    box-shadow: 0 2px 8px rgb(0 0 0 / 5%);
  }
  .user .glyph { color: var(--term-accent); font-weight: 700; }
  .speaker { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; color: var(--term-accent); font-family: var(--sans, sans-serif); font-size: .8rem; font-weight: 700; }
  .speaker span { color: var(--term-dim); font-size: .7rem; font-weight: 400; }
  .user .user-message { color: var(--term-text); font-family: var(--sans, sans-serif); font-size: .9rem; font-weight: 400; line-height: 1.65; }
  @media(max-width: 550px) { .line.user { margin-left: 8px; padding: 12px 10px; } }

  .thinking .glyph {
    color: var(--term-dim);
  }

  .live-thought .glyph {
    color: var(--term-accent);
    animation: thought-pulse 1.6s ease-in-out infinite;
  }

  .thought-label {
    font-family: var(--sans, sans-serif);
    font-size: .8rem;
    font-weight: 600;
    letter-spacing: .01em;
  }

  /* A light sweep across the label signals live reasoning without flashing. */
  .shimmer {
    background: linear-gradient(90deg, var(--term-dim) 0%, var(--term-dim) 35%, var(--term-text) 50%, var(--term-dim) 65%, var(--term-dim) 100%);
    background-size: 250% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: shimmer 2.2s linear infinite;
  }

  .thinking-dots {
    display: inline-flex;
    gap: 3px;
    margin-left: 6px;
    vertical-align: middle;
  }

  .thinking-dots i {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--term-accent);
    animation: dot-bounce 1.2s ease-in-out infinite;
  }

  .thinking-dots i:nth-child(2) { animation-delay: .15s; }
  .thinking-dots i:nth-child(3) { animation-delay: .3s; }

  .thought-body {
    margin-top: 6px;
    padding-left: 1.5ch;
    border-left: 2px solid var(--term-line);
    color: var(--term-dim);
    font-size: .85rem;
  }

  .thought-peek {
    margin: 4px 0 0;
    padding-left: 1.5ch;
    overflow: hidden;
    color: var(--term-dim);
    font-family: var(--sans, sans-serif);
    font-size: .8rem;
    font-style: italic;
    white-space: nowrap;
    text-overflow: ellipsis;
    animation: peek-in .35s ease-out;
    mask-image: linear-gradient(90deg, #000 85%, transparent);
  }

  details.thought[open] + .thought-peek { display: none; }

  @keyframes shimmer {
    from { background-position: 100% 0; }
    to { background-position: -150% 0; }
  }

  @keyframes dot-bounce {
    0%, 80%, 100% { opacity: .25; transform: translateY(0); }
    40% { opacity: 1; transform: translateY(-3px); }
  }

  @keyframes thought-pulse {
    50% { opacity: .35; }
  }

  @keyframes peek-in {
    from { opacity: 0; transform: translateY(2px); }
  }

  @media (prefers-reduced-motion: reduce) {
    .shimmer { animation: none; color: var(--term-text); background: none; }
    .thinking-dots i,
    .live-thought .glyph,
    .thought-peek { animation: none; }
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
  .tool-summary {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin: 4px 0;
  }

  .path-chip,
  .pattern {
    max-width: 100%;
    padding: 3px 8px;
    border: 1px solid var(--term-line);
    border-radius: 8px;
    background: var(--term-bg);
    color: var(--term-text);
    font: 0.78rem/1.5 var(--mono);
    overflow-wrap: anywhere;
  }

  .pattern {
    color: var(--term-accent);
  }

  .range {
    color: var(--term-dim);
    font-size: 0.75rem;
  }

  .question-list {
    margin: 4px 0;
    padding-left: 2ch;
  }

  .tool-values {
    display: grid;
    gap: 3px;
    margin: 4px 0;
    font-size: 0.78rem;
  }

  .tool-values > div {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 1ch;
  }

  .tool-values dt {
    color: var(--term-dim);
  }

  .tool-values dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .edit-snippet {
    margin: 4px 0;
  }

  .edit-pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    margin: 4px 0 4px 1.5ch;
  }

  .edit-pair pre {
    min-width: 0;
    padding: 6px 8px;
    border-radius: 8px;
    font-size: 0.76rem;
  }

  .old-snippet {
    background: var(--diff-del);
  }

  .new-snippet {
    background: var(--diff-add);
  }

  .error-output {
    color: var(--term-err) !important;
    border-left-color: var(--term-err) !important;
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

  .file-filter { display: grid; gap: 8px; margin-bottom: 16px; }
  .file-filter label, .file-filter span { font-size: 12px; }
  .file-filter input { min-height: 44px; }
  @media (max-width: 600px) {
    .file { flex-wrap: wrap; }
    .file .file-main { flex: 1 1 calc(100% - 40px); }
    .file .chips { flex-wrap: wrap; }
    .file > .btn { min-height: 44px; }
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

  .none {
    padding: 16px 20px;
    font-size: 0.9rem;
  }

  /* ---------- Changes ---------- */

  .changes {
    flex: 1 1 0;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .changes-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
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
    flex: 1 1 0;
    min-height: 0;
    min-width: 0;
    background: var(--code-bg);
  }

  .diff-filter-bar { flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .diff-filter { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
  .diff-filter input { width: 100%; min-width: 0; min-height: 44px; }
  .diff-count { flex: none; color: var(--text-3); font-size: 0.75rem; }
  .diff-file { margin: 12px; min-width: 0; overflow: hidden; border: 1px solid var(--border-strong); border-top: 3px solid var(--accent-line); border-radius: 16px; background: var(--surface); box-shadow: var(--clay-soft); }
  .diff-file + .diff-file { margin-top: 20px; }
  .diff-file-head { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 12px; border-bottom: 2px solid var(--border-strong); background: var(--surface-2); box-shadow: var(--clay-pressed); cursor: pointer; list-style: none; }
  .diff-file-head::-webkit-details-marker { display: none; }
  .diff-file-head:hover { background: var(--surface-3); }
  .diff-file[open] :global(.diff-caret) { rotate: 90deg; }
  .diff-label { flex: 1; min-width: 0; }
  .diff-label strong { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; }
  .diff-label strong :global(svg) { flex: none; color: var(--accent-text); }
  .diff-file-head code { overflow-wrap: anywhere; white-space: normal; }
  .diff-rename { display: block; margin-top: 4px; color: var(--text-3); font-size: 0.75rem; }
  .file-change-counts { display: flex; gap: 6px; flex: none; }
  .diff-code { min-width: 0; }
  .diff pre { margin: 0; padding: 10px 0; width: max-content; min-width: 100%; font-size: 0.8rem; line-height: 1.55; }

  .diff pre > span {
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

  .diff .file-header {
    color: var(--text);
    font-weight: 700;
  }

  .composer {
    flex: none;
    min-width: 0;
    display: grid;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--term-line);
    border-radius: 18px;
    background: var(--surface);
    box-shadow: var(--clay-soft);
  }
  .composer:focus-within {
    border-color: var(--accent-line);
    box-shadow: var(--clay-soft), 0 0 0 2px var(--accent-soft);
  }
  .ask-pill {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--accent-line);
    border-radius: 14px;
    background: var(--accent-soft);
    color: var(--accent-text);
    font-weight: 600;
    text-align: left;
  }
  .ask-pill span:first-of-type { flex: 1; }
  .prompt-row { display: flex; min-width: 0; position: relative; }
  .slash-picker { position: absolute; bottom: calc(100% + 12px); left: 0; right: 0; max-height: min(330px, 40dvh); overflow: auto; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 18px; box-shadow: var(--clay-raised); z-index: 10; padding: 7px; }
  .slash-picker button { display: grid; gap: 5px; width: 100%; padding: 12px; min-height: 44px; text-align: left; background: transparent; border: 0; border-radius: 12px; color: var(--text); }
  .slash-picker [aria-selected='true'] button, .slash-picker button:hover { background: var(--accent-soft); }
  .slash-command { display: flex; align-items: center; gap: 8px; font-size: .8rem; } .slash-command :global(svg) { color: var(--accent-text); }
  .slash-kind { margin-left: auto; font-size: .64rem; color: var(--text-2); background: var(--surface-2); padding: 3px 7px; border-radius: 7px; }
  .slash-picker small { color: var(--text-2); font-size: .73rem; line-height: 1.5; overflow-wrap: anywhere; }
  .prompt-row textarea {
    flex: 1;
    min-width: 0;
    min-height: 42px;
    max-height: min(180px, 24dvh);
    padding: 10px 10px 6px;
    border: 0;
    background: transparent;
    color: var(--term-text);
    caret-color: var(--term-accent);
    font: 1rem/1.4 var(--font);
    resize: none;
    overflow-y: auto;
    outline: none;
  }
  .prompt-row textarea::placeholder { color: var(--term-dim); }
  .composer-bar { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .mode-switch { padding: 2px; border-radius: 12px; }
  .mode-switch button { display: flex; align-items: center; gap: 4px; min-width: 44px; min-height: 44px; padding: 0 10px; font-size: 0.8rem; }
  .composer-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .attach { flex: none; width: 48px; min-width: 48px; min-height: 48px; padding: 0; border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2); box-shadow: var(--clay-soft); }
  .send { width: 100%; min-height: 48px; gap: 8px; padding: 0 16px; border-radius: 14px; font-weight: 700; }
  .selected-attachments { display: flex; gap: 8px; min-width: 0; max-height: 144px; margin: 0; padding: 4px 2px; overflow: auto; list-style: none; }
  .attachment-card { display: flex; align-items: flex-start; gap: 8px; flex: 0 0 230px; min-width: 0; padding: 8px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2); box-shadow: var(--clay-soft); }
  .attachment-card.invalid { border-color: var(--danger); background: var(--danger-soft); }
  .attachment-preview, .attachment-icon { flex: none; width: 42px; height: 42px; border-radius: 10px; object-fit: cover; background: var(--surface); }
  .attachment-icon { display: grid; place-items: center; color: var(--accent-text); }
  .attachment-copy { flex: 1; min-width: 0; display: grid; gap: 3px; }
  .attachment-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.78rem; }
  .attachment-copy > span { color: var(--text-3); font-size: 0.7rem; }
  .attachment-error { margin: 0; color: var(--danger); font-size: 0.75rem; overflow-wrap: anywhere; }
  .attachment-preview-note { margin: 0; color: var(--text-2); font-size: 0.75rem; }
  .attachment-remove { flex: none; min-width: 44px; min-height: 44px; width: 44px; padding: 0; border-radius: 12px; background: var(--surface); box-shadow: var(--clay-soft); }
  .composer-notice { margin: 0; padding: 0 6px; color: var(--text-2); font-size: 0.75rem; }
  .upload-errors { margin: 0; padding: 10px; list-style: none; border: 1px solid var(--danger); border-radius: 14px; color: var(--danger); background: var(--danger-soft); font-size: 0.8rem; }
  .upload-errors li { overflow-wrap: anywhere; }
  .upload-errors button { margin-left: 8px; }
  .toggle { display: inline-flex; align-items: center; gap: 5px; min-height: 44px; color: var(--text-2); font-size: 0.8rem; cursor: pointer; white-space: nowrap; }
  .toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .track { position: relative; width: 30px; height: 18px; border-radius: 999px; background: var(--surface-3); box-shadow: var(--clay-pressed); }
  .track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 12px; height: 12px; border-radius: 50%; background: var(--text-3); }
  .toggle input:checked + .track { background: var(--accent); }
  .toggle input:checked + .track::after { translate: 12px 0; background: var(--accent-ink); }
  .toggle input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
  .ended { display: flex; gap: 1ch; margin: 0; padding: 8px; color: var(--term-dim); font: 0.85rem var(--mono); }
  .ended .glyph { color: var(--term-err); }
  @media (max-width: 900px) {
    .detail { padding: 4px 8px 8px; gap: 4px; }
    .title { font-size: 0.98rem; }
    .title button { padding: 0 2px; }
    .head { gap: 8px; }
    .panel { gap: 6px; }
    .body { border-radius: 16px; box-shadow: var(--clay-soft); }
    .feed { padding: 12px; font-size: 0.8rem; }
    .line time { display: none; }
    .line { grid-template-columns: 1.4ch minmax(0, 1fr); }
  }
  @media (max-width: 380px) {
    .mode-switch button { padding: 0 7px; }
    .toggle { gap: 4px; font-size: 0.75rem; }
    .track { width: 24px; height: 16px; }
    .track::after { width: 10px; height: 10px; }
    .toggle input:checked + .track::after { translate: 8px 0; }
  }
</style>
