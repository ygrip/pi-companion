<script lang="ts">
  import Icon, { type IconName } from '#lib/Icon.svelte';
  import { devicePermissions, type PermissionValue } from '#lib/device-permissions.svelte.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  $effect(() => devicePermissions.init());

  const labels: Record<PermissionValue, string> = {
    granted: 'Allowed',
    denied: 'Blocked',
    prompt: 'Not asked yet',
    unsupported: 'Not available',
    insecure: 'Needs HTTPS'
  };

  async function enableNotifications() {
    const result = await devicePermissions.requestNotifications();
    if (result === 'denied') toasts.show('Notifications are blocked. Allow them for this site in your browser settings.', 'error');
  }

  async function enableCamera() {
    const result = await devicePermissions.requestCamera();
    if (result === 'granted') toasts.show('Camera allowed. You can scan pairing codes now.', 'success');
    else if (result === 'denied') toasts.show('Camera is blocked. Allow it for this site in your browser settings.', 'error');
  }

  async function testNotification() {
    const shown = await devicePermissions.notify('Test from Pi Companion', 'This is how session alerts will look on this device.', { tag: 'pi-companion-test' });
    if (!shown) toasts.show('Could not show a notification on this device.', 'error');
  }

  function hint(kind: 'notifications' | 'camera', state: PermissionValue) {
    if (state === 'insecure') return 'Open Pi Companion through its HTTPS link to use this.';
    if (state === 'denied') return 'Blocked by your browser. Open the site settings (the icon next to the address) and set it to Allow, then reload.';
    if (kind === 'notifications') {
      if (state === 'unsupported') return devicePermissions.needsInstall
        ? 'On iPhone and iPad, add Pi Companion to your Home Screen first, then open it from there.'
        : 'This browser cannot show notifications.';
      return 'Get an alert when Pi asks a question, finishes a task or ends a session.';
    }
    if (state === 'unsupported') return 'No camera was found on this device.';
    return 'Used only to scan pairing QR codes. Nothing is recorded or uploaded.';
  }

  const rows = $derived<{ kind: 'notifications' | 'camera'; icon: IconName; title: string; state: PermissionValue }[]>([
    { kind: 'notifications', icon: 'bell', title: 'Notifications', state: devicePermissions.notifications },
    { kind: 'camera', icon: 'camera', title: 'Camera', state: devicePermissions.camera }
  ]);
</script>

<ul class="permissions">
  {#each rows as row (row.kind)}
    <li>
      <span class="permission-icon" aria-hidden="true"><Icon name={row.icon} /></span>
      <div class="permission-copy">
        <strong>{row.title} <span class="badge {row.state}">{labels[row.state]}</span></strong>
        <p class="subtle">{hint(row.kind, row.state)}</p>
      </div>
      <div class="permission-actions">
        {#if row.kind === 'notifications'}
          {#if row.state === 'prompt'}
            <button class="btn btn-primary btn-sm" type="button" onclick={enableNotifications}>Allow notifications</button>
          {:else if row.state === 'granted'}
            <label class="toggle">
              <input type="checkbox" checked={devicePermissions.notificationsEnabled} onchange={(event) => devicePermissions.setNotificationsEnabled(event.currentTarget.checked)} />
              <span>Alerts on</span>
            </label>
            <button class="btn btn-ghost btn-sm" type="button" onclick={testNotification}>Send test</button>
          {/if}
        {:else if row.state === 'prompt'}
          <button class="btn btn-primary btn-sm" type="button" onclick={enableCamera}>Allow camera</button>
        {/if}
      </div>
    </li>
  {/each}
</ul>

<style>
  .permissions { display: grid; gap: 10px; padding: 0; margin: 0; list-style: none; }
  .permissions li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 14px; border-radius: var(--radius); background: var(--bg-sunken); }
  .permission-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--surface); color: var(--accent); }
  .permission-copy { min-width: 0; }
  .permission-copy strong { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .permission-copy p { margin: 3px 0 0; }
  .permission-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; }
  .badge.granted { color: var(--ok); }
  .badge.denied, .badge.insecure { color: var(--danger); }
  .toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 0.85rem; cursor: pointer; }
  @media (max-width: 560px) {
    .permissions li { grid-template-columns: auto minmax(0, 1fr); }
    .permission-actions { grid-column: 1 / -1; justify-content: flex-start; }
  }
</style>
