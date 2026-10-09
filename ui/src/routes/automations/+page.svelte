<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import '#lib/automation.css';
  import clayIcon from '../../assets/automation-clay.svg';
  import Icon from '#lib/Icon.svelte';
  import AutomationEditor from '#lib/AutomationEditor.svelte';
  import AutomationBadge from '#lib/AutomationBadge.svelte';
  import AutomationPagination from '#lib/AutomationPagination.svelte';
  import { automationSchedule, pageItems } from '#lib/automations.ts';
  import { companion } from '#lib/companion.svelte.ts';
  import { errorMessage } from '#lib/toast.svelte.ts';
  import type { Automation, AutomationDraft } from '#lib/types.ts';

  let automations = $state<Automation[]>([]);
  let loading = $state(true);
  let error = $state('');
  let creating = $state(false);
  let saving = $state(false);
  let desktop = $state(false);
  let query = $state('');
  let status = $state('all');
  let currentPage = $state(1);
  const canEdit = $derived(companion.isAdmin && desktop);
  const enabled = $derived(automations.filter(a => a.enabled).length);
  const filtered = $derived(automations.filter(a => a.name.toLowerCase().includes(query.toLowerCase()) && (status === 'all' || a.enabled === (status === 'enabled'))));
  const pagination = $derived(pageItems(filtered, currentPage));
  onMount(() => {
    const media = window.matchMedia('(min-width: 901px)');
    const update = () => { desktop = media.matches; };
    update(); media.addEventListener('change', update);
    void load();
    return () => media.removeEventListener('change', update);
  });
  async function load() {
    loading = true; error = '';
    try { automations = (await companion.request<{ automations: Automation[] }>('/api/automations')).automations.sort((a, b) => b.updatedAt - a.updatedAt); }
    catch (cause) { error = errorMessage(cause); }
    finally { loading = false; }
  }
  async function create(draft: AutomationDraft) {
    saving = true;
    try {
      const result = await companion.request<Automation>('/api/automations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
      await goto('/automations/' + encodeURIComponent(result.id));
    } finally { saving = false; }
  }
</script>
<svelte:head><title>Automations · Pi Companion</title></svelte:head>
<div class="page automation-workspace">
  <header class="automation-hero"><div class="hero-copy"><img class="clay-icon" src={clayIcon} alt="" /><div><span class="eyebrow">YOUR WORK, ON AUTOPILOT</span><h1>Automations</h1><p class="subtle">Small routines. More room for the work that matters.</p></div></div>{#if canEdit}<button class="btn-bento primary" aria-expanded={creating} onclick={() => creating = !creating}><Icon name="plus" />{creating ? 'Close editor' : 'Create automation'}</button>{/if}</header>
  {#if creating && canEdit}<AutomationEditor busy={saving} onsave={create} oncancel={() => creating = false} />{/if}
  {#if error}<div class="bento-card automation-empty" role="alert"><Icon name="alert" /><p>{error}</p><button class="btn" onclick={load}>Try again</button></div>
  {:else if loading}<div class="bento-card automation-empty" role="status">Loading your automations…</div>
  {:else}
    <section class="bento-stats" aria-label="Automation overview"><div class="bento-card stat"><strong>{automations.length}</strong><span>Total routines</span></div><div class="bento-card stat"><strong>{enabled}</strong><span>Enabled</span></div><div class="bento-card stat"><strong>{automations.filter(a => a.schedule && a.enabled).length}</strong><span>On a schedule</span></div></section>
    <section class="bento-card collection" aria-label="Automation list">
      <div class="collection-toolbar"><div><h2>Your routines</h2><p class="subtle">Find a routine, inspect its steps, or start a run.</p></div><div class="filters"><label class="filter-field">Search automations<input class="search-input" type="search" placeholder="Search by name…" bind:value={query} oninput={() => currentPage = 1} /></label><label class="filter-field">Status<select bind:value={status} onchange={() => currentPage = 1}><option value="all">All statuses</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label><button class="btn btn-icon" aria-label="Refresh automations" onclick={load}><Icon name="refresh" /></button></div></div>
      <div class="collection-scroll" role="region" aria-label="Scrollable automation cards">
        {#if !filtered.length}<div class="automation-empty"><Icon name={automations.length ? 'search' : 'sparkle'} size={30} /><h2>{automations.length ? 'No matching routines' : 'Your autopilot starts here'}</h2><p>{automations.length ? 'Try another name or status filter.' : 'Create an automation from the desktop dashboard, or ask Pi to set one up.'}</p>{#if automations.length}<button class="btn" onclick={() => { query = ''; status = 'all'; currentPage = 1; }}>Clear filters</button>{/if}</div>
        {:else}<div class="automation-grid">{#each pagination.items as automation (automation.id)}<a class="automation-card" href={'/automations/' + encodeURIComponent(automation.id)}><div class="card-top"><span class="card-badges"><AutomationBadge status={automation.enabled ? 'enabled' : 'disabled'} /><AutomationBadge status={automation.schedule ? 'scheduled' : 'manual'} /></span><Icon name="chevron" size={18} /></div><h3>{automation.name}</h3><p class="schedule-copy">{automationSchedule(automation.schedule)}</p><div class="card-footer"><span><Icon name="plan" size={14} />{automation.actions.length} {automation.actions.length === 1 ? 'action' : 'actions'}</span><span>{automation.preconditions.length} checks · {automation.postActions.length} finalizers</span></div></a>{/each}</div>{/if}
      </div>
      <AutomationPagination page={pagination.page} pages={pagination.pages} total={pagination.total} onchange={value => currentPage = value} />
    </section>
  {/if}
  <p class="automation-note">Schedules use UTC and require the daemon to stay running. {#if !canEdit}You can start and stop routines here. Editing is available on the computer’s desktop dashboard.{/if}</p>
</div>
