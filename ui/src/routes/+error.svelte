<script lang="ts">
  import { page } from '$app/state';
  import Icon from '#lib/Icon.svelte';
  import { pageError } from '#lib/page-error.ts';

  const error = $derived(pageError(page.status, page.error?.message));
</script>

<svelte:head><title>{page.status} · {error.title} · Pi Companion</title></svelte:head>

<div class="page error-page">
  <section class="error-card" aria-labelledby="error-title">
    <div class="error-mark" aria-hidden="true"><Icon name="alert" size={44} /></div>
    <p class="error-status">Error {page.status}</p>
    <h1 id="error-title">{error.title}</h1>
    <p class="error-message">{error.message}</p>
    <div class="error-actions">
      <button class="btn btn-primary" onclick={() => window.location.reload()}><Icon name="refresh" />Reload page</button>
      <a class="btn" href="/" data-sveltekit-reload><Icon name="home" />Open Overview</a>
    </div>
  </section>
</div>

<style>
  .error-page { display: grid; place-items: center; min-height: 100%; padding-block: clamp(24px, 6vh, 72px); }
  .error-card { display: grid; justify-items: center; width: min(100%, 540px); padding: clamp(24px, 5vw, 48px); border: 1px solid var(--border); border-radius: 30px; background: var(--clay-surface); box-shadow: var(--clay-raised); text-align: center; }
  .error-mark { display: grid; place-items: center; width: 96px; height: 96px; margin-bottom: 24px; border: 1px solid var(--accent-line); border-radius: 30px; color: var(--accent-text); background: var(--accent-soft); box-shadow: var(--clay-soft); }
  .error-status { margin-bottom: 10px; color: var(--text-2); font-family: var(--mono); font-size: .85rem; }
  h1 { font-size: clamp(1.5rem, 3vw, 2rem); overflow-wrap: anywhere; }
  .error-message { margin-top: 16px; color: var(--text-2); font-size: 1rem; line-height: 1.65; overflow-wrap: anywhere; }
  .error-actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 12px; width: 100%; margin-top: 28px; }
  .error-actions .btn { min-height: 44px; border-radius: 14px; box-shadow: var(--clay-soft); }
  .error-actions .btn-primary { box-shadow: var(--clay-accent); }
  @media (max-width: 480px) { .error-actions .btn { width: 100%; } }
</style>
