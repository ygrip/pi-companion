<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { automationPhases, automationStepLabel, automationStepText, type AutomationPhase } from './automation-flow.ts';
  import type { Automation } from './types.ts';

  let { automation }: { automation: Automation } = $props();
  const phases = $derived(automationPhases(automation));
  let selected = $state<AutomationPhase['id'] | null>(null);
  const phase = $derived(phases.find(item => item.id === selected));
  let dialog = $state<HTMLDialogElement | null>(null);
  let closeButton = $state<HTMLButtonElement | null>(null);
  let opener: HTMLButtonElement | null = null;

  async function showPhase(id: AutomationPhase['id'], event: MouseEvent) {
    opener = event.currentTarget as HTMLButtonElement;
    selected = id;
    await tick();
    dialog?.showModal();
    closeButton?.focus();
  }
  function close() { dialog?.close(); }
  function closed() {
    selected = null;
    if (opener?.isConnected) opener.focus();
    opener = null;
  }
</script>

<div class="phase-cards" aria-label="Automation execution phases">
  {#each phases as item, index (item.id)}
    <button type="button" class="phase-card" aria-haspopup="dialog" aria-controls="automation-flow-dialog" onclick={event => showPhase(item.id, event)}>
      <span class="phase-head"><span class="phase-number">{index + 1}</span><strong>{item.label}</strong><span class="phase-count">{item.steps.length} {item.steps.length === 1 ? 'step' : 'steps'}</span></span>
      <span class="phase-note">{item.note}</span>
      {#if item.steps.length}
        <span class="compact-stepper">
          {#each item.steps.slice(0, 4) as step, stepIndex}
            <span class="compact-step"><span class="step-number">{stepIndex + 1}</span><span class="step-copy"><span class="step-type">{step.type === 'command' ? 'Command' : 'Pi task'}</span><span class="step-label">{automationStepLabel(step)}</span></span></span>
          {/each}
          {#if item.steps.length > 4}<span class="more-steps">+{item.steps.length - 4} more steps</span>{/if}
        </span>
      {:else}<span class="phase-empty">No steps configured</span>{/if}
      <span class="view-flow">View flowchart<Icon name="chevron" size={16} /></span>
    </button>
  {/each}
</div>

<dialog id="automation-flow-dialog" class="flow-dialog clay" bind:this={dialog} aria-labelledby="automation-flow-title" aria-describedby="automation-flow-description" onclose={closed} oncancel={event => { event.preventDefault(); close(); }} onclick={event => { if (event.target === dialog) close(); }}>
  <header class="flow-head">
    <div><span class="eyebrow">EXECUTION FLOW</span><h2 id="automation-flow-title">{phase?.label ?? 'Automation flow'}</h2><p id="automation-flow-description">{phase?.note ?? 'Steps execute in the order shown.'} Scroll to explore every step.</p></div>
    <button type="button" class="btn btn-ghost btn-icon" bind:this={closeButton} aria-label="Close flowchart" onclick={close}><Icon name="close" /></button>
  </header>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="flow-scroll" role="region" aria-label="Scrollable execution flowchart" tabindex="0">
    {#if phase}
      <div class="flowchart" class:has-checks={phase.id === 'preconditions' && phase.steps.length > 0}>
        <div class="flow-terminal">Start {phase.label.toLowerCase()}</div>
        <div class="flow-connector" aria-hidden="true"><Icon name="chevron" size={18} /></div>
        <ol class="flow-steps" aria-label={phase.label + ' in execution order'}>
          {#each phase.steps as step, index}
            <li>
              <div class="flow-row">
                <article class="flow-node">
                  <div class="node-head"><span class="step-number">{index + 1}</span><strong>{step.type === 'command' ? 'Run command' : 'Ask Pi to work'}</strong><span class="node-type">{step.type === 'command' ? 'Shell' : 'Pi'}</span></div>
                  <pre>{automationStepText(step)}</pre>
                  <dl><div><dt>Directory</dt><dd><code>{step.cwd || (step.type === 'command' ? 'Daemon working directory' : 'Not specified')}</code></dd></div><div><dt>Timeout</dt><dd>{step.timeoutSeconds === undefined ? 'Default' : step.timeoutSeconds + ' seconds'}</dd></div></dl>
                </article>
                <div class="failure-path"><span class="branch-arrow" aria-hidden="true">→</span><span class="failure-note"><strong>If this {phase.id === 'preconditions' ? 'check' : 'step'} fails</strong>{#if phase.retry}<span>↻ {phase.retry}</span><strong>If retries fail</strong>{/if}<span>{phase.failure}</span></span></div>
              </div>
              <div class="flow-connector"><span>{phase.id === 'preconditions' ? 'Pass' : phase.id === 'actions' ? 'Success' : 'Next'}</span><Icon name="chevron" size={18} /></div>
            </li>
          {/each}
        </ol>
        {#if !phase.steps.length}<div class="flow-empty">No steps in this phase. Continue directly.</div><div class="flow-connector" aria-hidden="true"><Icon name="chevron" size={18} /></div>{/if}
        <div class="flow-terminal finish">{phase.end}</div>
        <p class="flow-cancellation">Cancellation stops all remaining steps, including finalizers.</p>
      </div>
    {/if}
  </div>
</dialog>

<style>
  .phase-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 20px; }
  .phase-card { display: flex; flex-direction: column; align-items: stretch; gap: 14px; min-width: 0; min-height: 44px; padding: 18px; text-align: left; font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: 20px; box-shadow: var(--clay-soft); cursor: pointer; }
  .phase-card:hover { background: var(--surface-2); }
  .phase-card:active { box-shadow: var(--clay-pressed); }
  .phase-card:focus-visible, .flow-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
  .phase-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .phase-number, .step-number { display: inline-grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); box-shadow: var(--clay-pressed); font-size: .75rem; font-weight: 700; }
  .phase-count { color: var(--text-2); font-size: .75rem; }
  .phase-note, .phase-empty { color: var(--text-2); font-size: .8rem; line-height: 1.5; }
  .compact-stepper { display: grid; gap: 12px; }
  .compact-step { display: flex; align-items: flex-start; gap: 9px; }
  .step-copy { display: grid; gap: 3px; min-width: 0; }
  .step-type { color: var(--text-2); font-size: .7rem; }
  .step-label { overflow-wrap: anywhere; font-size: .8rem; line-height: 1.45; }
  .more-steps { color: var(--text-2); font-size: .75rem; padding-left: 37px; }
  .view-flow { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 12px; margin-top: auto; border-top: 1px solid var(--border); font-size: .8rem; font-weight: 650; color: var(--accent-text); }
  .flow-dialog { width: min(1040px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; border: 1px solid var(--border-strong); border-radius: 24px; background: var(--surface); color: var(--text); box-shadow: var(--clay-raised); overflow: hidden; }
  .flow-dialog[open] { display: flex; flex-direction: column; }
  .flow-dialog::backdrop { background: rgb(0 0 0 / .4); backdrop-filter: blur(5px); }
  .flow-head { display: flex; align-items: flex-start; flex: none; gap: 16px; padding: 22px; border-bottom: 1px solid var(--border); }
  .flow-head > div { flex: 1; min-width: 0; }
  .flow-head h2 { margin: 5px 0 8px; font-size: 1.2rem; }
  .flow-head p { margin: 0; color: var(--text-2); font-size: .8rem; line-height: 1.5; }
  .flow-head button { flex: none; min-width: 44px; min-height: 44px; }
  .flow-scroll { min-height: 0; max-height: min(65dvh, 760px); overflow: auto; padding: 24px; overscroll-behavior: contain; background: var(--surface-2); }
  .flowchart { width: max-content; min-width: 100%; }
  .flow-terminal, .flow-empty { width: 380px; padding: 12px 18px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--surface); text-align: center; font-size: .85rem; font-weight: 650; box-shadow: var(--clay-soft); }
  .flow-terminal.finish { background: var(--accent-soft); color: var(--accent-text); }
  .flow-steps { margin: 0; padding: 0; list-style: none; }
  .flow-row { display: flex; align-items: center; gap: 18px; }
  .flow-node { width: 380px; flex: none; padding: 18px; border: 1px solid var(--border-strong); border-radius: 20px; background: var(--surface); box-shadow: var(--clay-soft); }
  .node-head { display: flex; align-items: center; gap: 8px; font-size: .85rem; }
  .node-type { margin-left: auto; font-size: .7rem; color: var(--text-2); }
  .flow-node pre { margin: 14px 0; max-height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .78rem; line-height: 1.5; padding: 12px; background: var(--surface-2); border-radius: 12px; border: 1px solid var(--border); }
  .flow-node dl { display: grid; gap: 9px; margin: 0; font-size: .75rem; }
  .flow-node dl > div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 8px; }
  .flow-node dt { color: var(--text-2); }
  .flow-node dd { margin: 0; overflow-wrap: anywhere; }
  .flow-connector { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; width: 380px; min-height: 54px; color: var(--text-2); font-size: .7rem; }
  .flow-connector :global(svg) { rotate: 90deg; }
  .failure-path { display: flex; align-items: center; gap: 12px; width: 250px; flex: none; }
  .branch-arrow { color: var(--text-2); font-size: 1.5rem; }
  .failure-note { display: grid; gap: 6px; padding: 14px; border: 1px dashed var(--border-strong); border-radius: 16px; background: var(--surface); font-size: .75rem; line-height: 1.5; }
  .failure-note > span, .flow-cancellation { color: var(--text-2); }
  .flow-cancellation { width: 380px; margin: 18px 0 0; font-size: .75rem; line-height: 1.5; }
  .flow-empty { border-radius: 16px; font-weight: 400; }
  @media (max-width: 900px) { .phase-cards { grid-template-columns: 1fr; } .flow-head { padding: 18px; } .flow-scroll { padding: 18px; } }
</style>
