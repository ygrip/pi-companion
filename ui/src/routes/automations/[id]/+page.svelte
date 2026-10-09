<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import Icon from '#lib/Icon.svelte';
  import AutomationEditor from '#lib/AutomationEditor.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { automationDraft, automationTime } from '#lib/automations.ts';
  import { errorMessage } from '#lib/toast.svelte.ts';
  import type { Automation, AutomationDraft, AutomationRun } from '#lib/types.ts';
  const id = $derived(page.params.id ?? '');
  const base = $derived('/api/automations/' + encodeURIComponent(id));
  let automation = $state<Automation | null>(null);
  let runs = $state<AutomationRun[]>([]);
  let loading = $state(true);
  let error = $state('');
  let actionError = $state('');
  let busy = $state(false);
  let editing = $state(false);
  let confirmingDelete = $state(false);
  let desktop = $state(false);
  const canEdit = $derived(companion.isAdmin && desktop);
  const running = $derived(runs.some((run) => run.status === 'running'));
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
    const media = window.matchMedia('(min-width: 901px)');
    const update = () => { desktop = media.matches; };
    update(); media.addEventListener('change', update);
    return () => { mounted = false; media.removeEventListener('change', update); };
  });
  $effect(() => {
    if (!mounted) return;
    const url = base;
    let alive = true;
    const refresh = async (initial = false) => {
      if (initial) { loading = true; automation = null; runs = []; error = ''; }
      try {
        const [definition, history] = await Promise.all([companion.request<Automation>(url), companion.request<{ runs: AutomationRun[] }>(url + '/runs')]);
        if (!alive) return;
        automation = definition; runs = history.runs; error = '';
      } catch (cause) { if (alive) error = errorMessage(cause); }
      finally { if (alive) loading = false; }
    };
    void refresh(true);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  });
  async function refresh() {
    const history = await companion.request<{ runs: AutomationRun[] }>(base + '/runs');
    runs = history.runs;
  }
  async function save(draft: AutomationDraft) {
    busy = true;
    try {
      automation = await companion.request<Automation>(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
      editing = false;
    } finally { busy = false; }
  }
  async function act(action: 'start' | 'stop' | 'toggle' | 'delete') {
    busy = true; actionError = '';
    try {
      if (action === 'delete') { await companion.request(base, { method: 'DELETE' }); await goto('/automations'); }
      else if (action === 'toggle' && automation) await save({ ...automationDraft(automation), enabled: !automation.enabled });
      else { await companion.request(base + '/' + action, { method: 'POST' }); await refresh(); }
    } catch (cause) { actionError = errorMessage(cause); }
    finally { busy = false; }
  }
</script>
<svelte:head><title>{automation?.name ?? 'Automation'} · Pi Companion</title></svelte:head>
<div class="page detail">
  <a class="back subtle" href="/automations"><Icon name="back" size={16} />Automations</a>
  {#if loading}<div class="panel state" role="status">Loading automation…</div>
  {:else if !automation}<div class="panel state" role="alert">{error || 'Automation not found.'}</div>
  {:else}
    <header class="heading"><div><span class="eyebrow">AUTOMATION</span><h1>{automation.name}</h1><p class="subtle">{automation.schedule ? `Scheduled · ${automation.schedule} · UTC` : 'Manually triggered'} <span class="chip">{automation.enabled ? 'Enabled' : 'Disabled'}</span></p></div><div class="actions">{#if running}<button class="btn" disabled={busy} onclick={() => act('stop')}><Icon name="stop" />Stop run</button>{:else}<button class="btn btn-primary" disabled={busy} onclick={() => act('start')}><Icon name="sparkle" />{busy ? 'Please wait…' : 'Start run'}</button>{/if}</div></header>
    {#if actionError}<p class="error" role="alert">{actionError}</p>{/if}
    {#if error}<p class="error" role="alert">Live refresh failed: {error}</p>{/if}
    {#if canEdit}<div class="actions"><button class="btn btn-sm" disabled={busy} onclick={() => editing = !editing}>Edit script</button><button class="btn btn-sm" disabled={busy} onclick={() => act('toggle')}>{automation.enabled ? 'Disable' : 'Enable'}</button><button class="btn btn-sm" disabled={busy || running} onclick={() => confirmingDelete = true}><Icon name="trash" size={14} />Delete</button></div>{/if}
    {#if confirmingDelete && canEdit}<section class="panel confirm" aria-label="Confirm deletion"><p>Delete this automation and its run history? This cannot be undone.</p><div class="actions"><button class="btn" disabled={busy} onclick={() => act('delete')}>Delete automation</button><button class="btn" onclick={() => confirmingDelete = false}>Cancel</button></div></section>{/if}
    {#if editing && canEdit}<AutomationEditor {automation} {busy} onsave={save} oncancel={() => editing = false} />{:else}<details class="panel script"><summary>Script · {automation.actions.length} {automation.actions.length === 1 ? 'action' : 'actions'}</summary><pre>{JSON.stringify(automationDraft(automation), null, 2)}</pre></details>{/if}
    <section class="history"><h2>Run history <span class="subtle">{runs.length}</span></h2>{#if !runs.length}<div class="panel state"><Icon name="activity" size={28} /><p>No runs yet. Start this automation to see its results here.</p></div>{:else}<div class="run-list">{#each runs as run (run.id)}<a class="panel run-row" href={'/automations/' + encodeURIComponent(id) + '/runs/' + encodeURIComponent(run.id)}><span><strong>{automationTime(run.startedAt)}</strong><small>{run.finishedAt ? `Finished ${automationTime(run.finishedAt)}` : 'In progress'}</small></span><span class="chip" class:failed={run.status === 'failed'}>{run.status}</span><Icon name="chevron" size={18} /></a>{/each}</div>{/if}</section>
  {/if}
</div>
<style>
  .detail { display: grid; gap: 22px; } .back { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; } .heading { display: flex; justify-content: space-between; align-items: center; gap: 20px; flex-wrap: wrap; } h1 { margin: 7px 0; overflow-wrap: anywhere; } .heading p { margin: 0; line-height: 1.8; } .eyebrow { font-size: .68rem; letter-spacing: .16em; color: var(--text-2); } .actions { display: flex; gap: 10px; flex-wrap: wrap; } .error { color: var(--danger); margin: 0; } .script { padding: 20px; } summary { cursor: pointer; font-weight: 600; } pre { margin: 20px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .8rem; line-height: 1.6; } .history h2 { font-size: 1.1rem; } .history h2 span { margin-left: 8px; font-size: .8rem; } .run-list { display: grid; gap: 10px; } .run-row { display: flex; align-items: center; gap: 14px; padding: 20px; color: inherit; text-decoration: none; } .run-row > span:first-child { display: grid; gap: 6px; flex: 1; min-width: 0; } .run-row small { color: var(--text-2); } .run-row strong { font-size: .88rem; overflow-wrap: anywhere; } .failed { color: var(--danger); } .state { padding: 32px; text-align: center; display: grid; justify-items: center; gap: 12px; } .state p { margin: 0; } .confirm { padding: 20px; } @media(max-width: 550px) { .run-row { padding: 16px; gap: 10px; } }
</style>
