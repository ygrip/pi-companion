<script lang="ts">
  import { untrack } from 'svelte';
  import { automationDraft, parseAutomationDraft } from './automations.ts';
  import type { Automation, AutomationDraft } from './types.ts';
  let { automation, busy = false, onsave, oncancel }: { automation?: Automation; busy?: boolean; onsave: (draft: AutomationDraft) => Promise<void>; oncancel: () => void } = $props();
  let text = $state(untrack(() => JSON.stringify(automationDraft(automation), null, 2)));
  let error = $state('');
  async function submit() {
    error = '';
    try { await onsave(parseAutomationDraft(text)); }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to save automation.'; }
  }
</script>

<form class="panel editor" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
  <h2>{automation ? 'Edit automation' : 'Create automation'}</h2>
  <p class="subtle">JSON script: preconditions run first, followed by actions and postActions. Commands use an executable and argument array, not an implicit shell. Pi actions require a prompt and working directory.</p>
  <p class="subtle">Use <code>schedule: null</code> for manual runs, or a five-field UTC cron expression such as <code>0 9 * * 1-5</code>. Executing an automation can modify files and run local programs.</p>
  <label for="automation-script">Automation script</label>
  <textarea id="automation-script" bind:value={text} spellcheck="false" rows="19" aria-invalid={Boolean(error)} aria-describedby={error ? 'script-error' : undefined} disabled={busy}></textarea>
  {#if error}<p id="script-error" class="error" role="alert">{error}</p>{/if}
  <div class="actions"><button class="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save automation'}</button><button type="button" class="btn" disabled={busy} onclick={oncancel}>Cancel</button></div>
</form>
<style>
  .editor { padding: 24px; display: grid; gap: 14px; }
  h2, p { margin: 0; } p { line-height: 1.6; font-size: .85rem; }
  textarea { width: 100%; resize: vertical; min-height: 300px; font-family: var(--mono, monospace); line-height: 1.6; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; } .error { color: var(--danger); }
</style>
