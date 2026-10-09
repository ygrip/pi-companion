<script lang="ts">
  let { value }: { value: number } = $props();
  const date = $derived(new Date(value < 1e12 ? value * 1000 : value));
</script>
<time class="calendar-tile" datetime={date.toISOString()} aria-label={date.toLocaleDateString()}><span>{date.toLocaleDateString(undefined, { month: 'short' })}</span><strong>{date.getDate()}</strong><small>{date.toLocaleDateString(undefined, { weekday: 'short' })}</small></time>
<style>
  .calendar-tile { width: 58px; flex-shrink: 0; display: grid; text-align: center; border: 1px solid var(--accent-line); border-radius: 14px; overflow: hidden; background: var(--surface); box-shadow: var(--clay-soft); } span { background: var(--accent-soft); color: var(--accent-text); font-size: .6rem; font-weight: 750; text-transform: uppercase; letter-spacing: .06em; padding: 3px 4px; } strong { font-size: 1.15rem; line-height: 1.35; padding-top: 3px; } small { font-size: .58rem; color: var(--text-2); padding-bottom: 5px; }
</style>
