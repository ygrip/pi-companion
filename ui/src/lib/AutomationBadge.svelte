<script lang="ts">
  import Icon, { type IconName } from './Icon.svelte';
  import { runLabels } from './automations.ts';
  import type { AutomationRun } from './types.ts';
  let { status }: { status: AutomationRun['status'] | 'enabled' | 'disabled' | 'scheduled' | 'manual' } = $props();
  const labels = { ...runLabels, enabled: 'Enabled', disabled: 'Disabled', scheduled: 'Scheduled', manual: 'Manual' };
  const icons: Record<string, IconName> = { succeeded: 'check', failed: 'alert', skipped: 'ban', stopped: 'stop', running: 'activity', enabled: 'check', disabled: 'ban', scheduled: 'refresh', manual: 'user' };
</script>
<span class="automation-badge" data-status={status}><Icon name={icons[status]} size={13} />{labels[status]}</span>
<style>
  .automation-badge { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; padding: 5px 10px; border: 1px solid var(--border-strong); border-radius: 10px; font-size: .72rem; font-weight: 650; color: var(--text-2); background: var(--surface-2); box-shadow: var(--clay-soft); }
  [data-status='enabled'], [data-status='succeeded'] { color: var(--ok); background: var(--ok-soft); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
  [data-status='running'], [data-status='scheduled'] { color: var(--accent-text); background: var(--accent-soft); border-color: var(--accent-line); }
  [data-status='failed'] { color: var(--danger); background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
</style>
