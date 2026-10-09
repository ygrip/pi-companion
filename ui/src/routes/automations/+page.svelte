<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import Icon from '#lib/Icon.svelte';
  import AutomationEditor from '#lib/AutomationEditor.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { errorMessage } from '#lib/toast.svelte.ts';
  import type { Automation, AutomationDraft } from '#lib/types.ts';

  let automations = $state<Automation[]>([]);
  let loading = $state(true);
  let error = $state('');
  let creating = $state(false);
  let saving = $state(false);
  let desktop = $state(false);
  const canEdit = $derived(companion.isAdmin && desktop);
  onMount(() => {
    const media = window.matchMedia('(min-width: 901px)');
    const update = () => { desktop = media.matches; };
    update(); media.addEventListener('change', update);
    void load();
    return () => media.removeEventListener('change', update);
  });
  async function load() {
    loading = true; error = '';
    try { automations = (await companion.request<{ automations: Automation[] }>('/api/automations')).automations; }
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
<div class="page automation-page">
  <header class="heading"><div><span class="eyebrow">AUTOPILOT</span><h1>Automations</h1><p class="subtle">Repeatable work, on your schedule.</p></div>{#if canEdit}<button class="btn btn-primary" onclick={() => creating = !creating}><Icon name="plus" />Create automation</button>{/if}</header>
  {#if creating && canEdit}<AutomationEditor busy={saving} onsave={create} oncancel={() => creating = false} />{/if}
  {#if error}<div class="panel state" role="alert"><p>{error}</p><button class="btn" onclick={load}>Retry</button></div>
  {:else if loading}<div class="panel state" role="status">Loading automations…</div>
  {:else if !automations.length}<div class="panel state"><Icon name="sparkle" size={30} /><h2>No automations yet</h2><p class="subtle">Create a script from the computer dashboard or ask an activated Pi agent to create one.</p></div>
  {:else}<div class="automation-list">{#each automations as automation (automation.id)}<a class="panel automation-row" href={'/automations/' + encodeURIComponent(automation.id)}><span class="automation-icon"><Icon name="sparkle" size={23} /></span><span class="row-text"><strong>{automation.name}</strong><small>{automation.schedule ? `UTC · ${automation.schedule}` : 'Manual trigger'} · {automation.actions.length} {automation.actions.length === 1 ? 'action' : 'actions'}</small></span><span class="chip">{automation.enabled ? 'Enabled' : 'Disabled'}</span><Icon name="chevron" /></a>{/each}</div>{/if}
  {#if !canEdit}<p class="subtle mobile-hint">You can view, start, and stop automations here. Editing is available on the computer’s desktop dashboard.</p>{/if}
</div>
<style>
  .automation-page { display: grid; gap: 24px; } .heading { display: flex; justify-content: space-between; align-items: center; gap: 18px; flex-wrap: wrap; } h1 { margin: 6px 0; } .heading p { margin: 0; } .eyebrow { font-size: .68rem; letter-spacing: .16em; color: var(--text-2); }
  .automation-list { display: grid; gap: 12px; } .automation-row { display: flex; align-items: center; gap: 16px; padding: 20px; color: inherit; text-decoration: none; min-width: 0; } .automation-row:hover { border-color: var(--accent); } .automation-icon { flex-shrink: 0; color: var(--accent); } .row-text { display: grid; gap: 6px; flex: 1; min-width: 0; } strong { overflow-wrap: anywhere; } small { color: var(--text-2); overflow-wrap: anywhere; } .state { display: grid; justify-items: center; text-align: center; gap: 12px; padding: 40px 24px; } .state h2, .state p { margin: 0; } .mobile-hint { font-size: .8rem; line-height: 1.6; } @media(max-width: 550px) { .automation-row { padding: 16px; gap: 10px; } .automation-icon { display: none; } .chip { font-size: .65rem; } }
</style>
