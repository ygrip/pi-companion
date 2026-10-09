<script lang="ts">
  import Icon from './Icon.svelte';
</script>
<span class="automated-session" title="Started by an automation. You can answer Pi’s questions, but cannot steer, plan, or upload files."><Icon name="lightning" size={13} />Automated · answers only</span>
<style>
  .automated-session { display: inline-flex; align-items: center; gap: 6px; font-size: .67rem; font-weight: 650; color: var(--accent-text); background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 10px; padding: 5px 9px; box-shadow: var(--clay-soft); margin-top: 6px; }
</style>
