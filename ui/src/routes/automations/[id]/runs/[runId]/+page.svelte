<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import Icon from '#lib/Icon.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import '#lib/automation.css';
  import clayIcon from '../../../../../assets/automation-clay.svg';
  import AutomationBadge from '#lib/AutomationBadge.svelte';
  import AutomationDate from '#lib/AutomationDate.svelte';
  import AutomationResult from '#lib/AutomationResult.svelte';
  import { automationTime, automationDuration } from '#lib/automations.ts';
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
<div class="page automation-workspace">
  <a class="automation-back subtle" href={'/automations/' + encodeURIComponent(id)}><Icon name="back" size={16} />Automation workspace</a>
  <header class="automation-hero"><div class="hero-copy"><img class="clay-icon" src={clayIcon} alt="" /><div><span class="eyebrow">EXECUTION REPORT</span><h1>Automation run</h1><p class="subtle">A clear record of what happened, from first check to final summary.</p></div></div>{#if run}<AutomationBadge status={run.status} />{/if}</header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if run}
    <section class="bento-card"><div class="run-metadata"><AutomationDate value={run.startedAt} /><dl class="info-pairs"><div><dt><Icon name="calendar" size={13} /> Started</dt><dd>{automationTime(run.startedAt)}</dd></div><div><dt><Icon name="check" size={13} /> Finished</dt><dd>{automationTime(run.finishedAt)}</dd></div><div><dt><Icon name="clock" size={13} /> Duration</dt><dd>{automationDuration(run.startedAt, run.finishedAt)}</dd></div></dl></div>{#if run.sessionId}<a class="btn" style="margin-top: 18px" href={'/sessions/' + encodeURIComponent(run.sessionId)}><Icon name="sessions" />View read-only Pi session</a>{/if}</section>
    <div class="bento-card"><AutomationResult text={run.result} running={run.status === 'running'} /></div>
  {:else if !error}<div class="panel state" role="status">Loading run result…</div>{/if}
</div>
<style>
  .run-metadata { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; } .run-metadata dl { flex: 1; margin: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); } .state { padding: 32px; text-align: center; } @media(max-width: 550px) { .run-metadata { gap: 16px; } .run-metadata dl { grid-template-columns: 1fr; gap: 12px; } }
</style>
