<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import SessionCard from '#lib/SessionCard.svelte';
  import PageHero from '#lib/PageHero.svelte';
  import PullToRefresh from '#lib/PullToRefresh.svelte';
  import clayIcon from '../../assets/clay/chat-bubble.webp';
  import { companion } from '#lib/companion.svelte.ts';
  import { prettyPath, sessionTitle } from '#lib/format.ts';
  import type { SessionStatus } from '#lib/types.ts';

  type Filter = 'all' | SessionStatus;
  let filter = $state<Filter>('all');
  let query = $state('');

  const counts = $derived({
    all: companion.sessions.length,
    active: companion.sessions.filter((s) => s.status === 'active').length,
    idle: companion.sessions.filter((s) => s.status === 'idle').length,
    stopped: companion.sessions.filter((s) => s.status === 'stopped').length
  });

  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Working' },
    { value: 'idle', label: 'Waiting' },
    { value: 'stopped', label: 'Ended' }
  ];

  const shown = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return companion.sessions.filter((session) => {
      if (filter !== 'all' && session.status !== filter) return false;
      if (!needle) return true;
      return [sessionTitle(session), session.shortTitle, prettyPath(session.cwd), session.mainModel ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  });
</script>

<svelte:head><title>Sessions · Pi Companion</title></svelte:head>

<div class="page automation-workspace">
  <PullToRefresh onrefresh={() => companion.refresh()} />
  <PageHero icon={clayIcon} eyebrow="A LITTLE SPACE TO THINK" title="Sessions" subtitle="Big ideas, small check-ins. Follow what Pi’s working on from anywhere." />

  <div class="toolbar clay">
    <label class="search">
      <span class="field-label">Search sessions</span>
      <span class="search-field"><Icon name="search" size={16} /><input class="input" type="search" placeholder="Name, workspace or model" bind:value={query} autocomplete="off" /></span>
    </label>
    <div class="filter-field">
      <span class="field-label" id="session-status-label">Session status</span>
      <div class="segmented scroll-x" role="group" aria-labelledby="session-status-label">
        {#each filters as option (option.value)}
          <button aria-pressed={filter === option.value} onclick={() => (filter = option.value)}>
            {option.label}<span class="badge count quiet">{counts[option.value]}</span>
          </button>
        {/each}
      </div>
    </div>
  </div>

  {#if companion.sessions.length}<p class="list-summary" role="status">Showing {shown.length} of {companion.sessions.length} {companion.sessions.length === 1 ? 'session' : 'sessions'}</p>{/if}

  {#if shown.length}
    <ul class="session-list" aria-label="Pi sessions">
      {#each shown as session (session.id)}<li><SessionCard {session} /></li>{/each}
    </ul>
  {:else if companion.sessions.length}
    <div class="card empty">
      <span class="empty-icon"><Icon name="search" /></span>
      <h2>No matching sessions</h2>
      <p>Try a different search or status filter.</p>
      <button class="btn btn-sm" onclick={() => ((query = ''), (filter = 'all'))}>Clear filters</button>
    </div>
  {:else}
    <div class="card empty">
      <span class="empty-icon"><Icon name="sessions" /></span>
      {#if companion.connection !== 'online'}
        <h2>Waiting for workspace connection</h2>
        <p>Your session list will refresh when the workspace is reachable again.</p>
      {:else if companion.isAdmin}
        <h2>No Pi sessions yet</h2>
        <p>Start <code>pi</code> in any project folder, then run <code>/companion</code> to start the daemon and connect that session.</p>
      {:else}
        <h2>Nothing shared yet</h2>
        <p>On your computer, type <code>/companion</code> inside a Pi session to share it here.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) auto; align-items: end; gap: 18px; padding: 18px; border-radius: 22px; box-shadow: var(--clay-raised); }
  .search, .filter-field { display: grid; gap: 8px; min-width: 0; }
  .field-label { color: var(--text-2); font-size: 0.76rem; font-weight: 650; }
  .search-field { display: block; position: relative; min-width: 0; color: var(--text-3); }
  .search-field :global(.icon) { position: absolute; left: 13px; top: 50%; translate: 0 -50%; pointer-events: none; }
  .search .input { width: 100%; min-height: 48px; padding-left: 38px; border-radius: 15px; box-shadow: var(--clay-pressed); }
  .segmented { max-width: 100%; min-width: 0; border-radius: 15px; padding: 4px; box-shadow: var(--clay-pressed); }
  .segmented button { min-height: 44px; padding: 9px 12px; border-radius: 12px; }
  .session-list { display: grid; gap: 16px; padding: 0; margin: 0; list-style: none; min-width: 0; }
  .session-list li { min-width: 0; }
  .list-summary { margin: -4px 4px -4px; color: var(--text-2); font-size: 0.8rem; }
  @media (max-width: 1100px) {
    .toolbar { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 16px; }
    .segmented { width: 100%; }
    .segmented button { flex: 1 0 auto; }
  }
</style>
