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
    {#if waiting}
      <p class="questions"><Icon name="question" size={15} /><span class="badge count">{waiting}</span><strong>{waiting === 1 ? 'question needs' : 'questions need'} your answer</strong></p>
    {/if}
  </div>

  <div class="row-actions">
    <a class="btn details-action" href="/sessions/{encodeURIComponent(session.id)}" aria-label="View details: {title}">View details<Icon name="chevron" size={15} /></a>
    {#if session.status === 'stopped'}<ArchiveSession {session} />{/if}
  </div>
</article>

<style>
  .session-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 20px; min-width: 0; padding: 20px; border-radius: 22px; background: var(--surface); box-shadow: var(--clay-raised); transition: border-color 150ms var(--ease), box-shadow 150ms var(--ease); }
  .session-row:hover { border-color: var(--border-strong); }
  .session-row.highlighted { border-color: var(--accent-line); background: linear-gradient(115deg, var(--accent-soft), transparent 58%), var(--surface); }
  .stopped .row-main { opacity: 0.78; }
  .row-main { display: grid; gap: 12px; min-width: 0; }
  .row-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-width: 0; }
  .title-copy { min-width: 0; flex: 1; }
  h2 { font-size: 1.05rem; line-height: 1.35; letter-spacing: -0.015em; }
  .title-link { display: inline-flex; align-items: center; min-height: 44px; max-width: 100%; padding: 2px 0; color: var(--text); text-decoration: none; overflow-wrap: anywhere; }
  .title-link:hover { color: var(--accent-text); }
  .short-title { margin: 4px 0 0; color: var(--text-2); font-size: 0.83rem; overflow-wrap: anywhere; }
  .status { flex: none; margin-top: 8px; box-shadow: var(--clay-soft); }
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
  .row-actions { display: grid; align-content: center; gap: 8px; min-width: 148px; }
  .details-action, .row-actions :global(.archive) { width: 100%; min-height: 44px; padding: 11px 14px; justify-content: center; border: 1px solid var(--border); border-radius: 15px; background: var(--surface-2); box-shadow: var(--clay-soft); }
  .details-action:hover, .row-actions :global(.archive:not(:disabled):hover) { background: var(--surface-3); border-color: var(--accent-line); }
  .details-action:active, .row-actions :global(.archive:not(:disabled):active) { box-shadow: var(--clay-pressed); }
  @media (max-width: 1100px) {
    .session-row { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 18px; }
    .row-actions { display: flex; flex-wrap: wrap; min-width: 0; padding-top: 14px; border-top: 1px solid var(--border); }
    .row-actions > .details-action, .row-actions > :global(.archive) { flex: 1 1 140px; width: auto; }
  }
  @media (max-width: 420px) {
    .session-row { padding: 16px; }
    .row-head { flex-wrap: wrap; gap: 8px; }
    .title-copy { flex-basis: 100%; }
    .status { margin-top: 0; }
    .metadata > div { padding: 7px 9px; }
  }
</style>
