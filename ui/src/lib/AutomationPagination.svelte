<script lang="ts">
  import Icon from './Icon.svelte';
  let { page, pages, total, onchange }: { page: number; pages: number; total: number; onchange: (page: number) => void } = $props();
</script>
<nav class="automation-pagination" aria-label="Pagination">
  <span class="subtle">{total} {total === 1 ? 'item' : 'items'} · Page {page} of {pages}</span>
  <div><button class="btn btn-sm" aria-label="Previous page" disabled={page <= 1} onclick={() => onchange(page - 1)}><Icon name="back" size={16} />Previous</button><button class="btn btn-sm" aria-label="Next page" disabled={page >= pages} onclick={() => onchange(page + 1)}>Next<Icon name="chevron" size={16} /></button></div>
</nav>
<style>
  nav { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding-top: 16px; border-top: 1px solid var(--border); font-size: .76rem; } nav > div { display: flex; gap: 8px; } .btn { min-height: 44px; }
</style>
