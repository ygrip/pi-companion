<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import SessionCard from '#lib/SessionCard.svelte';
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

<div class="page">
  <header class="page-head">
    <div>
      <h1>Sessions</h1>
      <p>
        {#if companion.isAdmin}
          Every Pi session running on this computer. Ended sessions stay listed until the daemon restarts.
        {:else}
          Sessions your computer has shared with this device.
        {/if}
      </p>
    </div>
  </header>

  <div class="toolbar">
    <label class="search">
      <Icon name="search" size={16} />
      <span class="sr-only">Search sessions</span>
      <input class="input" type="search" placeholder="Search by name, folder or model" bind:value={query} autocomplete="off" />
    </label>
    <div class="segmented scroll-x" role="group" aria-label="Filter by status">
      {#each filters as option (option.value)}
        <button aria-pressed={filter === option.value} onclick={() => (filter = option.value)}>
          {option.label}<span class="badge count quiet">{counts[option.value]}</span>
        </button>
      {/each}
    </div>
  </div>

  {#if shown.length}
    <div class="grid">
      {#each shown as session (session.id)}<SessionCard {session} />{/each}
    </div>
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
      {#if companion.isAdmin}
        <h2>No Pi sessions yet</h2>
        <p>Start <code>pi</code> in any project folder. Sessions connect to Pi Companion automatically.</p>
      {:else}
        <h2>Nothing shared yet</h2>
        <p>On your computer, type <code>/remote-control</code> inside a Pi session to share it here.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .search {
    position: relative;
    flex: 1 1 280px;
    color: var(--text-3);
  }

  .search :global(.icon) {
    position: absolute;
    left: 12px;
    top: 50%;
    translate: 0 -50%;
    pointer-events: none;
  }

  .search .input {
    padding-left: 36px;
  }

  .segmented {
    max-width: 100%;
  }


  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
    gap: 12px;
  }

  @media (max-width: 600px) {
    .segmented {
      width: 100%;
    }
  }
</style>
