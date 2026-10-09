<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import Icon from '#lib/Icon.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { automationTime } from '#lib/automations.ts';
  import { errorMessage } from '#lib/toast.svelte.ts';
  import type { AutomationRun } from '#lib/types.ts';
  const id = $derived(page.params.id ?? '');
  const runId = $derived(page.params.runId ?? '');
  let run = $state<AutomationRun | null>(null);
  let error = $state('');
  let mounted = $state(false);
  onMount(() => { mounted = true; return () => { mounted = false; }; });
  $effect(() => {
    if (!mounted) return;
    const url = '/api/automations/' + encodeURIComponent(id) + '/runs/' + encodeURIComponent(runId);
    let alive = true;
    run = null; error = '';
    const refresh = async () => {
      try { const result = await companion.request<AutomationRun>(url); if (alive) { run = result; error = ''; } }
      catch (cause) { if (alive) error = errorMessage(cause); }
    };
    void refresh();
    const timer = setInterval(() => { if (run?.status === 'running' && document.visibilityState === 'visible') void refresh(); }, 3000);
    return () => { alive = false; clearInterval(timer); };
  });
</script>
<svelte:head><title>Run result · Pi Companion</title></svelte:head>
<div class="page run-detail">
  <a class="back subtle" href={'/automations/' + encodeURIComponent(id)}><Icon name="back" size={16} />Automation</a>
  <header><span class="eyebrow">RUN RESULT</span><h1>Automation run</h1>{#if run}<p class="subtle">{automationTime(run.startedAt)} <span class="chip">{run.status}</span></p>{/if}</header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if run}
    <div class="panel metadata"><div><span class="subtle">Started</span><strong>{automationTime(run.startedAt)}</strong></div><div><span class="subtle">Finished</span><strong>{automationTime(run.finishedAt)}</strong></div>{#if run.sessionId}<a class="btn" href={'/sessions/' + encodeURIComponent(run.sessionId)}><Icon name="sessions" />View read-only Pi session</a>{/if}</div>
    <section class="panel result"><h2>Output &amp; summary</h2><pre>{run.result || (run.status === 'running' ? 'Waiting for output…' : 'No output was recorded.')}</pre></section>
  {:else if !error}<div class="panel state" role="status">Loading run result…</div>{/if}
</div>
<style>
  .run-detail { display: grid; gap: 24px; } .back { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; } .eyebrow { font-size: .68rem; letter-spacing: .16em; color: var(--text-2); } h1 { margin: 7px 0; } header p { margin: 0; line-height: 1.8; } .metadata { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; padding: 24px; } .metadata > div { display: grid; gap: 6px; } .metadata strong { font-size: .85rem; } .metadata .subtle { font-size: .75rem; } .result { padding: 24px; min-width: 0; } h2 { margin: 0 0 20px; font-size: 1rem; } pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .82rem; line-height: 1.7; } .error { color: var(--danger); } .state { padding: 32px; text-align: center; }
</style>
