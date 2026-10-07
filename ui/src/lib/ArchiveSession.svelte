<script lang="ts">
  import { goto } from '$app/navigation';
  import Icon from './Icon.svelte';
  import { companion } from './companion.svelte.ts';
  import { sessionTitle } from './format.ts';
  import { errorMessage, toasts } from './toast.svelte.ts';
  import type { Session } from './types.ts';

  let { session, redirect = false, label = 'Archive session' }: { session: Session; redirect?: boolean; label?: string } = $props();
  let busy = $state(false);

  async function archive() {
    if (busy || session.status !== 'stopped') return;
    if (!confirm(`Archive “${sessionTitle(session)}” from Pi Companion?\n\nThis removes only the ended session from the daemon. Your local Pi session and history are not deleted.`)) return;
    busy = true;
    try {
      await companion.archiveSession(session.id);
      toasts.show('Session archived from the daemon. Local Pi history is unchanged.', 'success');
      if (redirect) await goto('/sessions');
    } catch (error) {
      toasts.show(errorMessage(error), 'error');
      void companion.refreshSessions().catch(() => {});
    } finally {
      busy = false;
    }
  }
</script>

<button
  class="archive btn btn-ghost btn-sm"
  disabled={busy || session.status !== 'stopped'}
  title={session.status === 'stopped' ? 'Remove from daemon only; keep local Pi history' : 'Working and waiting sessions cannot be archived'}
  aria-label={label + ': ' + sessionTitle(session)}
  onclick={archive}><Icon name="archive" size={16} />{busy ? 'Archiving…' : label}</button>

<style>
  .archive { min-height: 44px; justify-content: flex-start; }
  .archive:not(:disabled) { color: var(--danger); }
</style>
