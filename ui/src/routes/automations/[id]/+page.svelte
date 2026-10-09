<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import Icon from '#lib/Icon.svelte';
  import AutomationEditor from '#lib/AutomationEditor.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import '#lib/automation.css';
  import clayIcon from '../../../assets/automation-clay.svg';
  import AutomationBadge from '#lib/AutomationBadge.svelte';
  import AutomationPagination from '#lib/AutomationPagination.svelte';
  import { automationDraft, automationTime, automationSchedule, automationDuration, pageItems, runLabels } from '#lib/automations.ts';
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
  let tab = $state<'summary' | 'history'>('summary');
  let historyStatus = $state('all');
  let currentPage = $state(1);
  const history = $derived(pageItems([...runs].sort((a, b) => b.startedAt - a.startedAt).filter(r => historyStatus === 'all' || r.status === historyStatus), currentPage));
  const latest = $derived([...runs].sort((a, b) => b.startedAt - a.startedAt)[0]);
  function tabKeys(event: KeyboardEvent) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      tab = event.key === 'Home' ? 'summary' : event.key === 'End' ? 'history' : tab === 'summary' ? 'history' : 'summary';
      document.getElementById('tab-' + tab)?.focus();
    }
  }
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
  async function toggleEditor() {
    tab = 'summary'; editing = !editing;
    if (editing) {
      await tick();
      const form = document.getElementById('automation-editor');
      form?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
      form?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    }
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
<div class="page automation-workspace automation-detail">
  <a class="automation-back btn" href="/automations"><Icon name="back" size={16} />All automations</a>
  {#if loading}<div class="panel state" role="status">Loading automation…</div>
  {:else if !automation}<div class="panel state" role="alert">{error || 'Automation not found.'}</div>
  {:else}
    <header class="automation-hero"><div class="hero-copy"><img class="clay-icon" src={clayIcon} alt="" /><div><span class="eyebrow">AUTOMATION WORKSPACE</span><h1>{automation.name}</h1><div class="card-badges" style="margin-top: 12px"><AutomationBadge status={automation.enabled ? 'enabled' : 'disabled'} /><AutomationBadge status={automation.schedule ? 'scheduled' : 'manual'} />{#if running}<AutomationBadge status="running" />{/if}</div></div></div><div class="automation-actions">{#if running}<button class="btn-bento" disabled={busy} onclick={() => act('stop')}><Icon name="stop" />Stop run</button>{:else}<button class="btn-bento primary" disabled={busy} onclick={() => act('start')}><Icon name="send" />{busy ? 'Please wait…' : 'Run now'}</button>{/if}</div></header>
    {#if actionError}<p class="error" role="alert">{actionError}</p>{/if}
    {#if error}<p class="error" role="alert">Live refresh failed: {error}</p>{/if}
    {#if canEdit}<div class="automation-actions"><button class="btn" aria-expanded={editing} disabled={busy} aria-controls="automation-editor" onclick={toggleEditor}><Icon name="file" size={15} />{editing ? 'Close editor' : 'Edit automation'}</button><button class="btn" aria-pressed={automation.enabled} disabled={busy} onclick={() => act('toggle')}><Icon name={automation.enabled ? 'ban' : 'check'} size={15} />{automation.enabled ? 'Disable scheduling' : 'Enable automation'}</button><button class="btn btn-danger" disabled={busy || running} onclick={() => confirmingDelete = true}><Icon name="trash" size={15} />Delete</button></div>{/if}
    <div class="tab-bar" role="tablist" aria-label="Automation sections"><button id="tab-summary" role="tab" aria-selected={tab === 'summary'} aria-controls="panel-summary" tabindex={tab === 'summary' ? 0 : -1} onclick={() => tab = 'summary'} onkeydown={tabKeys}><Icon name="plan" size={16} />Summary</button><button id="tab-history" role="tab" aria-selected={tab === 'history'} aria-controls="panel-history" tabindex={tab === 'history' ? 0 : -1} onclick={() => tab = 'history'} onkeydown={tabKeys}><Icon name="activity" size={16} />Run history · {runs.length}</button></div>
    {#if confirmingDelete && canEdit}<section class="panel confirm" aria-label="Confirm deletion"><p>Delete this automation and its run history? This cannot be undone.</p><div class="actions"><button class="btn" disabled={busy} onclick={() => act('delete')}>Delete automation</button><button class="btn" onclick={() => confirmingDelete = false}>Cancel</button></div></section>{/if}
    {#if tab === 'summary'}
      <div id="panel-summary" role="tabpanel" aria-labelledby="tab-summary" tabindex="0" class="summary-grid">
        {#if editing && canEdit}<div id="automation-editor" class="span-all"><AutomationEditor {automation} {busy} onsave={save} oncancel={() => editing = false} /></div>{/if}
        <section class="bento-card"><span class="eyebrow">WHEN IT RUNS</span><h2>{automationSchedule(automation.schedule)}</h2><p class="automation-note" style="margin-top: 10px">{automation.enabled ? 'Ready to run. The daemon must remain online for scheduled triggers.' : 'Scheduled execution is disabled. Manual runs remain available.'}</p><dl class="info-pairs"><div><dt>Cron expression · UTC</dt><dd><code>{automation.schedule ?? 'Manual only'}</code></dd></div><div><dt>Last updated</dt><dd>{automationTime(automation.updatedAt)}</dd></div><div><dt>Retry policy</dt><dd>{automation.maxRetries ? `${automation.maxRetries} retries · ${automation.retryIntervalSeconds ?? 10}s interval` : 'No retries'}</dd></div></dl></section>
        <section class="bento-card"><span class="eyebrow">LATEST ACTIVITY</span>{#if latest}<AutomationBadge status={latest.status} /><dl class="info-pairs"><div><dt>Started</dt><dd>{automationTime(latest.startedAt)}</dd></div><div><dt>Duration</dt><dd>{automationDuration(latest.startedAt, latest.finishedAt)}</dd></div></dl><a class="btn" style="margin-top: 18px" href={'/automations/' + encodeURIComponent(id) + '/runs/' + encodeURIComponent(latest.id)}>View latest result<Icon name="chevron" size={16} /></a>{:else}<h2>Ready for its first run</h2><p class="automation-note" style="margin-top: 10px">Run this routine to capture output, a summary, and its execution status.</p>{/if}</section>
        <section class="bento-card span-all"><span class="eyebrow">EXECUTION FLOW</span><h2>Three steps to a finished routine</h2><div class="pipeline">{#each [{ label: 'Check eligibility', note: 'A failed precondition skips the main actions.', steps: automation.preconditions }, { label: 'Do the work', note: 'Actions execute in sequence.', steps: automation.actions }, { label: 'Wrap up & summarize', note: 'Finalizers run after success, failure, or a skip; cancellation stops all steps.', steps: automation.postActions }] as phase, index}<div class="pipeline-step"><span class="step-dot">{index + 1}</span><div><strong>{phase.label} · {phase.steps.length} {phase.steps.length === 1 ? 'step' : 'steps'}</strong><p>{phase.note}</p>{#each phase.steps as step}<code class="step-preview">{step.type === 'command' ? [step.command, ...step.args].join(' ') : step.prompt}</code>{/each}</div></div>{/each}</div><details class="script-view"><summary>View full JSON definition</summary><pre>{JSON.stringify(automationDraft(automation), null, 2)}</pre></details></section>
      </div>
    {:else}
      <div id="panel-history" role="tabpanel" aria-labelledby="tab-history" tabindex="0" class="bento-card collection"><div class="collection-toolbar"><div><h2>Run history</h2><p class="subtle">Newest first · keeps the latest {automation.historyLimit ?? 30} finished runs.</p></div><label class="filter-field">Run status<select bind:value={historyStatus} onchange={() => currentPage = 1}><option value="all">All statuses</option>{#each Object.entries(runLabels) as [value, label]}<option {value}>{label}</option>{/each}</select></label></div><div class="collection-scroll" role="region" aria-label="Scrollable run history">{#if !history.total}<div class="automation-empty"><Icon name="activity" size={28} /><h2>{runs.length ? 'No runs with this status' : 'A fresh start'}</h2><p>{runs.length ? 'Select another status to find a run.' : 'Run the automation to see its results here.'}</p></div>{:else}<div class="routine-table clay"><table aria-label="Run history"><thead><tr><th scope="col">Started</th><th scope="col">Duration</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Open result</span></th></tr></thead><tbody>{#each history.items as run (run.id)}<tr><td class="title-cell"><a class="row-link" href={'/automations/' + encodeURIComponent(id) + '/runs/' + encodeURIComponent(run.id)}>{automationTime(run.startedAt)}</a></td><td data-label="Duration">{automationDuration(run.startedAt, run.finishedAt)}</td><td class="status-cell"><AutomationBadge status={run.status} /></td><td class="arrow-cell" aria-hidden="true"><span class="row-arrow"><Icon name="chevron" size={16} /></span></td></tr>{/each}</tbody></table></div>{/if}</div><AutomationPagination page={history.page} pages={history.pages} total={history.total} onchange={value => currentPage = value} /></div>
    {/if}
  {/if}
</div>
<style>
  .state { padding: 32px; text-align: center; } .confirm { padding: 20px; } .actions { display: flex; gap: 10px; margin-top: 12px; }
</style>
