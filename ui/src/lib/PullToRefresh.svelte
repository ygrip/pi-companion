<script lang="ts">
  import { onMount } from 'svelte';
  import { errorMessage } from './toast.svelte.ts';
  let { onrefresh }: { onrefresh: () => Promise<unknown> } = $props();
  let control: HTMLDivElement;
  let distance = $state(0);
  let busy = $state(false);
  let message = $state('');
  async function refresh() {
    if (busy) return;
    busy = true; message = ''; distance = 0;
    try { await onrefresh(); message = 'Up to date'; }
    catch (error) { message = 'Refresh failed: ' + errorMessage(error); }
    finally { busy = false; }
  }
  onMount(() => {
    const root = control.parentElement!;
    let start: { x: number; y: number } | null = null;
    function begin(event: TouchEvent) {
      start = null;
      if (busy || event.touches.length !== 1 || window.scrollY > 0) return;
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, button, a, [role="tablist"]')) return;
      for (let node: HTMLElement | null = target; node && node !== root; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
      }
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
    function move(event: TouchEvent) {
      if (!start) return;
      if (event.touches.length !== 1 || window.scrollY > 0) { start = null; distance = 0; return; }
      const dx = event.touches[0].clientX - start.x;
      const dy = event.touches[0].clientY - start.y;
      if (dy < 0 || Math.abs(dx) > Math.abs(dy)) { start = null; distance = 0; return; }
      if (dy > 10 && event.cancelable) event.preventDefault();
      distance = Math.min(100, dy * .5);
    }
    function end() { start = null; if (distance >= 70) void refresh(); else distance = 0; }
    function cancel() { start = null; distance = 0; }
    root.addEventListener('touchstart', begin, { passive: true });
    root.addEventListener('touchmove', move, { passive: false });
    root.addEventListener('touchend', end);
    root.addEventListener('touchcancel', cancel);
    return () => { root.removeEventListener('touchstart', begin); root.removeEventListener('touchmove', move); root.removeEventListener('touchend', end); root.removeEventListener('touchcancel', cancel); };
  });
</script>
<div class="refresh-control" bind:this={control}>
  <span class="refresh-message" role="status" aria-live="polite">{busy ? 'Refreshing…' : distance >= 70 ? 'Release to refresh' : distance > 0 ? 'Pull to refresh' : message}</span>
</div>
{#if distance > 0}<div class="pull-space" style:height={distance + 'px'} aria-hidden="true"><span class="pull-spinner" class:ready={distance >= 70}>↻</span></div>{/if}
<style>
  .refresh-control { display: flex; align-items: center; justify-content: center; min-width: 0; }
  .refresh-message { font-size: .75rem; color: var(--text-2); overflow-wrap: anywhere; }
  .refresh-message:empty { display: none; }
  .pull-spinner { font-size: 1.45rem; line-height: 1; opacity: .5; }
  .pull-spinner.ready { transform: rotate(90deg); opacity: 1; }
  .pull-space { display: grid; place-items: center; color: var(--accent-text); }
</style>
