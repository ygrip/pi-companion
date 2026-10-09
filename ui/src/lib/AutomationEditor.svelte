<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { automationDraft, parseAutomationDraft } from './automations.ts';
  import type { Automation, AutomationDraft } from './types.ts';
  let { automation, busy = false, onsave, oncancel }: { automation?: Automation; busy?: boolean; onsave: (draft: AutomationDraft) => Promise<void>; oncancel: () => void } = $props();
  const initial = untrack(() => automationDraft(automation));
  let name = $state(initial.name);
  let enabled = $state(initial.enabled);
  let scheduled = $state(initial.schedule !== null);
  let cron = $state(initial.schedule ?? '0 9 * * 1-5');
  let historyLimit = $state<number | undefined>(initial.historyLimit ?? 30);
  let retries = $state<number | undefined>(initial.maxRetries);
  let interval = $state<number | undefined>(initial.retryIntervalSeconds);
  type Stage = 'preconditions' | 'actions' | 'postActions';
  type Step = { id: number; text: string };
  let nextId = 0;
  const makeSteps = (stage: Stage): Step[] => initial[stage].map(step => ({ id: nextId++, text: JSON.stringify(step, null, 2) }));
  let stages = $state<Record<Stage, Step[]>>({ preconditions: makeSteps('preconditions'), actions: makeSteps('actions'), postActions: makeSteps('postActions') });
  const labels: { key: Stage; title: string; note: string }[] = [
    { key: 'preconditions', title: 'Preconditions', note: 'Check before starting. A failed check skips the work.' },
    { key: 'actions', title: 'Actions', note: 'The main job. Steps execute in order; at least one is required.' },
    { key: 'postActions', title: 'Post-actions', note: 'Cleanup and summaries after success, failure, or skip. Cancellation stops everything.' }
  ];
  let error = $state('');
  let stepErrors = $state<Record<number, string>>({});
  function add(stage: Stage, type: 'command' | 'pi') {
    stages[stage].push({ id: nextId++, text: JSON.stringify(type === 'command' ? { type, command: 'echo', args: ['Hello from Pi Companion'] } : { type, prompt: 'Summarize this repository without changing files.', cwd: '/absolute/project' }, null, 2) });
  }
  function move(stage: Stage, index: number, delta: number) {
    const list = [...stages[stage]];
    [list[index], list[index + delta]] = [list[index + delta], list[index]];
    stages[stage] = list;
  }
  async function submit() {
    error = ''; stepErrors = {};
    const parsed: Record<Stage, unknown[]> = { preconditions: [], actions: [], postActions: [] };
    for (const { key } of labels) {
      for (const step of stages[key]) {
        try { parsed[key].push(JSON.parse(step.text)); }
        catch { stepErrors[step.id] = 'Malformed JSON. Check quotes, commas, and brackets.'; }
      }
    }
    if (Object.keys(stepErrors).length) { error = 'Fix the highlighted steps before saving.'; return; }
    try {
      const draft = parseAutomationDraft(JSON.stringify({ name, enabled, schedule: scheduled ? cron : null, ...parsed, historyLimit,
        ...(retries !== undefined ? { maxRetries: retries } : {}), ...(interval !== undefined ? { retryIntervalSeconds: interval } : {}) }));
      await onsave(draft);
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to save automation.'; }
  }
</script>
<form class="bento-card editor" onsubmit={event => { event.preventDefault(); void submit(); }}>
  <header><span class="eyebrow">JOB CONFIGURATION</span><h2>{automation ? 'Edit automation' : 'Create automation'}</h2><p class="subtle">Configure the routine, then arrange its steps. Changes apply after saving.</p></header>
  <fieldset disabled={busy}>
    <div class="fields"><label class="field wide">Automation name<input required maxlength="120" bind:value={name} placeholder="e.g. Review requested pull requests" /></label><label class="check-field"><input type="checkbox" bind:checked={enabled} />Automation enabled</label></div>
    <section class="form-section"><div class="section-title"><Icon name="calendar" /><h3>Schedule</h3></div><label class="check-field"><input type="checkbox" bind:checked={scheduled} />Run on a schedule</label>{#if scheduled}<label class="field">Cron expression · UTC<input required bind:value={cron} placeholder="0 9 * * 1-5" spellcheck="false" /></label><p class="hint">Minute · Hour · Day · Month · Weekday. Example: <code>0 9 * * 1-5</code> runs at 09:00 UTC on weekdays.</p>{:else}<p class="hint">Manual only. You can start this automation from its workspace.</p>{/if}</section>
    <section class="form-section"><div class="section-title"><Icon name="refresh" /><h3>Retry policy <span class="subtle">· optional</span></h3></div><div class="fields"><label class="field">Max retries<input type="number" min="0" max="5" step="1" bind:value={retries} placeholder="0 · no retries" /></label><label class="field">Retry interval · seconds<input type="number" min="1" max="86400" step="1" bind:value={interval} placeholder="10 · default when retries are enabled" /></label></div><p class="hint">Retries only the failed main action, not completed steps. Preconditions and finalizers are not retried. Commands and Pi prompts may repeat side effects—enable only for retry-safe work.</p></section>
    <section class="form-section"><div class="section-title"><Icon name="archive" /><h3>Saved run history</h3></div><label class="field">Keep the latest runs<input type="number" min="1" max="1000" step="1" bind:value={historyLimit} placeholder="30" /></label><p class="hint">Keep 30 by default, or choose 1–1000. Older finished runs are automatically removed as new ones finish. Lowering this limit deletes older history when saved.</p></section>
    {#each labels as stage, index}
      <section class="form-section"><div class="section-title"><span class="step-dot">{index + 1}</span><h3>{stage.title}</h3><span class="count">{stages[stage.key].length} steps</span></div><p class="hint">{stage.note}</p>
        {#each stages[stage.key] as step, stepIndex (step.id)}<div class="step-editor"><div class="step-toolbar"><label for={'step-' + step.id}>Step {stepIndex + 1} · JSON DSL</label><div><button type="button" class="btn btn-sm" aria-label={'Move step ' + (stepIndex + 1) + ' up'} disabled={stepIndex === 0} onclick={() => move(stage.key, stepIndex, -1)}>↑</button><button type="button" class="btn btn-sm" aria-label={'Move step ' + (stepIndex + 1) + ' down'} disabled={stepIndex === stages[stage.key].length - 1} onclick={() => move(stage.key, stepIndex, 1)}>↓</button><button type="button" class="btn btn-sm btn-danger" aria-label={'Remove step ' + (stepIndex + 1)} onclick={() => stages[stage.key] = stages[stage.key].filter(s => s.id !== step.id)}><Icon name="trash" size={14} /></button></div></div><textarea id={'step-' + step.id} bind:value={step.text} spellcheck="false" rows="7" aria-invalid={Boolean(stepErrors[step.id])} aria-describedby={stepErrors[step.id] ? 'error-' + step.id : undefined}></textarea>{#if stepErrors[step.id]}<p class="error" id={'error-' + step.id}>{stepErrors[step.id]}</p>{/if}</div>{/each}
        <div class="automation-actions"><button type="button" class="btn" onclick={() => add(stage.key, 'command')}><Icon name="plus" size={15} />Command step</button><button type="button" class="btn" onclick={() => add(stage.key, 'pi')}><Icon name="brain" size={15} />Pi step</button></div>
      </section>
    {/each}
  </fieldset>
  <p class="hint">Commands use an executable and argument array, never an implicit shell. Pi steps require a prompt and absolute workdir. These jobs run with your computer’s permissions.</p>
  {#if error}<p class="validation-error" role="alert">{error}</p>{/if}
  <footer class="automation-actions"><button class="btn-bento primary" disabled={busy}><Icon name="check" />{busy ? 'Saving…' : 'Save automation'}</button><button type="button" class="btn" disabled={busy} onclick={oncancel}>Cancel</button></footer>
</form>
<style>
  .editor { display: grid; gap: 20px; } header p { font-size: .8rem; margin-top: 8px; } fieldset { margin: 0; padding: 0; border: 0; min-width: 0; } .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: center; } .wide { grid-column: 1 / -1; } .field { display: grid; gap: 8px; font-size: .77rem; font-weight: 650; } .check-field { display: flex; gap: 10px; align-items: center; font-size: .8rem; min-height: 44px; } .check-field input { min-height: auto; width: 18px; height: 18px; accent-color: var(--accent); box-shadow: none; } .form-section { display: grid; gap: 14px; border-top: 1px solid var(--border); padding-top: 22px; margin-top: 22px; } .section-title { display: flex; align-items: center; gap: 10px; } h3 { font-size: .88rem; } .count { margin-left: auto; color: var(--text-2); font-size: .7rem; } .hint { font-size: .75rem; color: var(--text-2); line-height: 1.7; } .step-editor { padding: 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--clay-soft); } .step-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; } .step-toolbar label { font-size: .72rem; font-weight: 650; } .step-toolbar > div { display: flex; gap: 6px; } textarea { width: 100%; min-height: 160px; resize: vertical; padding: 14px; background: var(--code-bg); border: 1px solid var(--border-strong); border-radius: 12px; font-family: var(--mono); font-size: .76rem; line-height: 1.7; } textarea[aria-invalid='true'] { border-color: var(--danger); } .validation-error { color: var(--danger); padding: 14px; border-radius: 12px; border: 1px solid var(--danger); background: var(--danger-soft); font-size: .8rem; } @media(max-width: 550px) { .fields { grid-template-columns: 1fr; } }
</style>
