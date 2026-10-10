<script lang="ts">
  import AutomationBadge from './AutomationBadge.svelte';
  import Icon from './Icon.svelte';
  import { automationSchedule } from './automations.ts';
  import type { Automation } from './types.ts';
  let { automations }: { automations: Automation[] } = $props();
</script>
<div class="routine-table clay">
  <table aria-label="Automations">
    <thead><tr><th scope="col">Routine</th><th scope="col">Schedule · UTC</th><th scope="col">Steps</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead>
    <tbody>{#each automations as automation (automation.id)}<tr>
      <td class="title-cell"><a class="row-link" href={'/automations/' + encodeURIComponent(automation.id)}>{automation.name}</a></td>
      <td data-label="Schedule · UTC">{automationSchedule(automation.schedule)}</td>
      <td data-label="Steps"><span>{automation.actions.length} {automation.actions.length === 1 ? 'action' : 'actions'}</span><small>{automation.preconditions.length} checks · {automation.postActions.length} finalizers</small></td>
      <td class="status-cell"><AutomationBadge status={automation.enabled ? 'enabled' : 'disabled'} /></td>
      <td class="arrow-cell" aria-hidden="true"><span class="row-arrow"><Icon name="chevron" size={16} /></span></td>
    </tr>{/each}</tbody>
  </table>
</div>

<div class="routine-cards" aria-label="Automations">
  {#each automations as automation (automation.id)}
    <a class="routine-card" href={'/automations/' + encodeURIComponent(automation.id)}>
      <div class="routine-card-head">
        <strong>{automation.name}</strong>
        <AutomationBadge status={automation.enabled ? 'enabled' : 'disabled'} />
      </div>
      <div class="routine-card-schedule"><Icon name="activity" size={15} /><span>{automationSchedule(automation.schedule)}</span></div>
      <div class="routine-card-bottom">
        <span>{automation.actions.length} {automation.actions.length === 1 ? 'action' : 'actions'} · {automation.preconditions.length} checks · {automation.postActions.length} finalizers</span>
        <span class="routine-card-arrow" aria-hidden="true"><Icon name="chevron" size={17} /></span>
      </div>
    </a>
  {/each}
</div>

<style>
  .routine-cards { display: none; }
  @media (max-width: 1100px) {
    .routine-table { display: none; }
    .routine-cards { display: grid; gap: 12px; min-width: 0; }
    .routine-card { display: grid; gap: 14px; min-width: 0; padding: 18px; border: 1px solid var(--border); border-radius: 20px; background: var(--surface); color: var(--text); text-decoration: none; box-shadow: var(--clay-raised); }
    .routine-card:hover { background: var(--surface-2); border-color: var(--accent-line); }
    .routine-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .routine-card-head { display: flex; align-items: start; justify-content: space-between; flex-wrap: wrap; gap: 10px; min-width: 0; }
    .routine-card-head strong { flex: 1; min-width: 140px; font-size: .95rem; line-height: 1.45; overflow-wrap: anywhere; }
    .routine-card-schedule { display: flex; align-items: start; gap: 9px; color: var(--text-2); font-size: .8rem; overflow-wrap: anywhere; }
    .routine-card-schedule :global(svg) { flex: none; color: var(--accent-text); }
    .routine-card-bottom { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 1px solid var(--border); color: var(--text-2); font-size: .74rem; }
    .routine-card-arrow { display: grid; place-items: center; min-width: 32px; height: 32px; border-radius: 50%; background: var(--surface-2); }
  }
</style>
