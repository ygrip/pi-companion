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
