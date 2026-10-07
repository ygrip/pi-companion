<script lang="ts">
  import Icon from './Icon.svelte';
  import { companion } from './companion.svelte.ts';
  import { prettyPath, relativeTime, sessionTitle, statusLabel } from './format.ts';
  import type { Session } from './types.ts';

  let { session }: { session: Session } = $props();
  const waiting = $derived(companion.pendingAsks(session.id));
</script>

<a class="session-card" class:stopped={session.status === 'stopped'} href="/sessions/{encodeURIComponent(session.id)}">
  <div class="row top">
    <span class="state">
      <span class="dot {session.status}" aria-hidden="true"></span>
      {statusLabel[session.status]}
    </span>
    {#if waiting}
      <span class="badge accent"><Icon name="question" size={12} />{waiting === 1 ? 'Needs your answer' : waiting + ' questions'}</span>
    {:else if session.remoteEnabled && companion.isAdmin}
      <span class="badge" title="Visible on paired devices"><Icon name="link" size={12} />Shared</span>
    {/if}
  </div>
  <div class="title">
    <strong>{sessionTitle(session)}</strong>
    {#if session.name && session.shortTitle !== session.name}<span class="subtle">{session.shortTitle}</span>{/if}
  </div>
  <code class="path" title={session.cwd}>{prettyPath(session.cwd)}</code>
  <div class="row meta">
    <span class="model">{session.mainModel ?? 'Model not reported'}{session.effort ? ' · ' + session.effort : ''}</span>
    <span class="subtle">{relativeTime(session.connectedAt)}</span>
  </div>
  <Icon name="chevron" class="chev" />
</a>

<style>
  .session-card {
    position: relative;
    display: grid;
    gap: 8px;
    min-width: 0;
    padding: 16px 40px 16px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    text-decoration: none;
    transition: border-color 150ms var(--ease), transform 150ms var(--ease), box-shadow 150ms var(--ease);
  }

  .session-card:hover {
    border-color: var(--accent-line);
    box-shadow: var(--shadow);
    transform: translateY(-1px);
  }

  .session-card.stopped {
    opacity: 0.72;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-2);
  }

  .title {
    display: grid;
    min-width: 0;
  }

  .title strong,
  .title span,
  .path,
  .model {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title strong {
    font-size: 1rem;
    letter-spacing: -0.01em;
  }

  .title span {
    font-size: 0.82rem;
  }

  .path {
    color: var(--text-3);
    font-size: 0.78rem;
  }

  .meta {
    font-size: 0.8rem;
    color: var(--text-2);
  }

  .model {
    min-width: 0;
  }

  .meta .subtle {
    flex: none;
  }

  .session-card :global(.chev) {
    position: absolute;
    right: 14px;
    top: 50%;
    translate: 0 -50%;
    color: var(--text-3);
    transition: translate 150ms var(--ease), color 150ms var(--ease);
  }

  .session-card:hover :global(.chev) {
    color: var(--accent-text);
    translate: 3px -50%;
  }
</style>
