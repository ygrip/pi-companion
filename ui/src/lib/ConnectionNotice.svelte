<script lang="ts">
  import Icon from './Icon.svelte';
  import { companion } from './companion.svelte.ts';
</script>

{#if companion.connectionError}
  <section class="connection-notice" role="alert" aria-label="Workspace connection problem">
    <Icon name="unplug" size={18} />
    <div class="copy">
      <strong>{companion.bootError ? 'Cannot connect to workspace' : 'Workspace connection interrupted'}</strong>
      <p>{companion.connectionError}</p>
      {#if !companion.bootError}<p class="muted">Activity may be out of date. Messages are not queued or sent while disconnected.</p>{/if}
      <details>
        <summary>How to reconnect</summary>
        <ul>
          <li>Check your internet connection.</li>
          <li>On your computer, restart the tunnel and keep the workspace running.</li>
          <li>Run <code>/companion</code> in Pi if the daemon is not running.</li>
          <li>If the tunnel URL changed, open the new HTTPS device URL.</li>
        </ul>
        <p>Connection failures keep your pairing. A new device URL on a different hostname may require pairing again. Retrying never resends a message or upload.</p>
      </details>
    </div>
    <button class="btn btn-sm" disabled={companion.connection === 'connecting'} onclick={() => companion.reconnect()}>
      {companion.connection === 'connecting' ? 'Retrying…' : 'Retry now'}
    </button>
  </section>
{/if}

<style>
  .connection-notice { flex: none; display: flex; align-items: flex-start; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--accent-soft); }
  .connection-notice > :global(svg) { flex: none; margin-top: 3px; color: var(--accent-text); }
  .copy { flex: 1; min-width: 0; font-size: 0.85rem; }
  strong { display: block; margin-bottom: 3px; }
  p { margin: 0; overflow-wrap: anywhere; }
  .muted { margin-top: 4px; font-size: 0.8rem; }
  button { flex: none; min-height: 44px; }
  details { margin-top: 6px; }
  summary { cursor: pointer; width: fit-content; min-height: 32px; padding: 5px 0; font-weight: 600; }
  ul { margin: 6px 0; padding-left: 20px; }
  li { margin-bottom: 4px; }
  @media (max-width: 420px) { .connection-notice { padding: 10px; gap: 8px; } }
</style>
