<script lang="ts">
  import Icon from './Icon.svelte';
  import ArchiveSession from './ArchiveSession.svelte';
  import { companion } from './companion.svelte.ts';
  import { prettyPath, relativeTime, sessionTitle, statusLabel } from './format.ts';
  import type { Session } from './types.ts';

  let { session, highlighted = false }: { session: Session; highlighted?: boolean } = $props();
  const waiting = $derived(companion.pendingAsks(session.id));
  const title = $derived(sessionTitle(session));
</script>

<article class="session-row clay" class:stopped={session.status === 'stopped'} class:highlighted>
  <div class="row-main">
    <header class="row-head">
      <div class="title-copy">
        <!-- The title link stretches over the whole card, so any tap on the row opens it. -->
        <h2><a class="title-link" href="/sessions/{encodeURIComponent(session.id)}">{title}</a></h2>
        {#if session.shortTitle.trim() && session.shortTitle.trim() !== title}<p class="short-title">{session.shortTitle}</p>{/if}
      </div>
      <span class="badge status" class:ok={session.status === 'active'} class:accent={session.status === 'idle'}>
        <span class="dot {session.status}" aria-hidden="true"></span>{statusLabel[session.status]}
      </span>
    </header>

    <p class="workspace"><Icon name="folder" size={15} /><span><span class="workspace-label">Workspace</span><code title={session.cwd}>{prettyPath(session.cwd)}</code></span></p>

    <dl class="metadata" aria-label="Session metadata">
      <div><dt>Model</dt><dd>{session.mainModel ?? 'Not reported'}</dd></div>
      {#if session.effort}<div><dt>Thinking</dt><dd>{session.effort}</dd></div>{/if}
      <div><dt>Started</dt><dd>{relativeTime(session.connectedAt)}</dd></div>
      <div><dt>Sharing</dt><dd>{session.remoteEnabled ? 'Shared with devices' : 'Local only'}</dd></div>
    </dl>
    {#if waiting || session.status === 'stopped'}
      <div class="row-foot">
        {#if waiting}<p class="questions"><Icon name="question" size={15} /><span class="badge count">{waiting}</span><strong>{waiting === 1 ? 'question needs' : 'questions need'} your answer</strong></p>{/if}
        {#if session.status === 'stopped'}<div class="row-actions"><ArchiveSession {session} /></div>{/if}
      </div>
    {/if}
  </div>
</article>

<style>
  .session-row { position: relative; display: block; min-width: 0; padding: 20px; border-radius: 22px; background: var(--surface); box-shadow: var(--clay-raised); cursor: pointer; transition: border-color 150ms var(--ease), box-shadow 150ms var(--ease), transform 150ms var(--ease); }
  .session-row:hover { border-color: var(--accent-line); }
  .session-row:active { box-shadow: var(--clay-pressed); }
  .session-row:has(.title-link:focus-visible) { outline: 2px solid var(--accent); outline-offset: 3px; }
  .session-row.highlighted { border-color: var(--accent-line); background: linear-gradient(115deg, var(--accent-soft), transparent 58%), var(--surface); }
  .stopped .row-main { opacity: 0.78; }
  .row-main { display: grid; gap: 12px; min-width: 0; }
  /* Title takes the free space; the status badge always sits top-right. */
  .row-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 12px; min-width: 0; }
  .title-copy { min-width: 0; }
  h2 { font-size: 1.05rem; line-height: 1.35; letter-spacing: -0.015em; }
  .title-link { display: inline-flex; align-items: center; min-height: 44px; max-width: 100%; padding: 2px 0; color: var(--text); text-decoration: none; overflow-wrap: anywhere; outline: none; }
  .title-link::after { content: ''; position: absolute; inset: 0; z-index: 1; border-radius: inherit; }
  .session-row:hover .title-link { color: var(--accent-text); }
  .short-title { margin: 4px 0 0; color: var(--text-2); font-size: 0.83rem; overflow-wrap: anywhere; }
  .status { justify-self: end; margin-top: 10px; white-space: nowrap; box-shadow: var(--clay-soft); }
  .workspace { display: flex; align-items: flex-start; gap: 8px; margin: 0; color: var(--text-2); min-width: 0; }
  .workspace > :global(svg) { flex: none; margin-top: 3px; }
  .workspace > span { display: grid; gap: 3px; min-width: 0; }
  .workspace-label { color: var(--text-3); font-size: 0.7rem; font-weight: 600; }
  .workspace code { font-size: 0.81rem; line-height: 1.5; overflow-wrap: anywhere; }
  .metadata { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px; margin: 0; min-width: 0; }
  .metadata > div { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px; max-width: 100%; padding: 7px 10px; border-radius: 12px; background: var(--surface-2); box-shadow: var(--clay-soft); }
  dt { color: var(--text-3); font-size: 0.7rem; font-weight: 600; }
  dd { margin: 0; color: var(--text-2); font-size: 0.76rem; overflow-wrap: anywhere; }
  .questions { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--accent-text); font-size: 0.83rem; }
  .questions :global(svg) { flex: none; }
  .row-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
  .row-actions { margin-left: auto; }
  /* Real controls sit above the stretched link. */
  .row-actions :global(.archive) { position: relative; z-index: 2; min-height: 44px; padding: 11px 14px; border: 1px solid var(--border); border-radius: 15px; background: var(--surface-2); box-shadow: var(--clay-soft); }
  .row-actions :global(.archive:not(:disabled):hover) { background: var(--surface-3); border-color: var(--accent-line); }
  @media (max-width: 1100px) {
    .session-row { padding: 18px; }
  }
  @media (max-width: 420px) {
    .session-row { padding: 16px; }
    .row-head { gap: 8px; }
    .status { margin-top: 10px; }
    .metadata > div { padding: 7px 9px; }
  }
</style>
