<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page, updated } from '$app/state';
  import logo from '../assets/pi-companion.webp';
  import AboutSheet from '#lib/AboutSheet.svelte';
  import ConnectionNotice from '#lib/ConnectionNotice.svelte';
  import Icon, { type IconName } from '#lib/Icon.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { devicePermissions } from '#lib/device-permissions.svelte.ts';
  import { theme, type ThemePreference } from '#lib/theme.svelte.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  let { children } = $props();

  type NavItem = { href: string; label: string; icon: IconName; admin?: boolean };
  const nav: NavItem[] = [
    { href: '/', label: 'Overview', icon: 'home' },
    { href: '/sessions', label: 'Sessions', icon: 'sessions' },
    { href: '/devices', label: 'Devices', icon: 'devices', admin: true },
    { href: '/settings', label: 'Settings', icon: 'settings' }
  ];
  const visibleNav = $derived(nav.filter((item) => !item.admin || companion.isAdmin));
  const path = $derived(page.url.pathname);
  const bare = $derived(companion.remote && !companion.paired);
  const waiting = $derived(Object.values(companion.asks).reduce((total, list) => total + list.length, 0));
  const workSession = $derived(page.params.id
    ? companion.sessions.find((session) => session.id === page.params.id)
    : companion.sessions.find((session) => session.status === 'active'));
  const workPhase = $derived(companion.connection === 'online' && workSession?.status === 'active'
    ? companion.activity[workSession.id]?.at(-1)?.kind === 'thinking' ? 'thinking' : 'working'
    : '');
  let aboutOpen = $state(false);
  let insecureContext = $state(false);

  const connectionLabel = $derived(
    {
      connecting: 'Connecting…',
      online: 'Live',
      offline: 'Offline',
      disconnected: 'Disconnected',
      revoked: 'Access removed'
    }[companion.connection]
  );

  const themes: { value: ThemePreference; label: string; icon: IconName }[] = [
    { value: 'system', label: 'Match system', icon: 'monitor' },
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'dark', label: 'Dark', icon: 'moon' }
  ];

  function active(href: string) {
    return href === '/' ? path === '/' : path === href || path.startsWith(href + '/');
  }

  // Cache busting: when a new UI build is deployed, finish the next navigation with a
  // full page load so the new shell and hashed assets are fetched.
  beforeNavigate(({ willUnload, to }) => {
    if (updated.current && !willUnload && to?.url) location.href = to.url.href;
  });

  // Paired devices only see sessions; unpaired devices only see the pairing screen.
  $effect(() => {
    if (!companion.booted) return;
    if (bare && path !== '/pair' && path !== '/privacy' && path !== '/terms') void goto('/pair', { replaceState: true });
    else if (companion.remote && path.startsWith('/devices')) void goto('/', { replaceState: true });
  });

  let notificationPromptDismissed = $state(true);
  const showNotificationPrompt = $derived(
    companion.booted && companion.paired && !notificationPromptDismissed && devicePermissions.notifications === 'prompt'
  );

  function dismissNotificationPrompt() {
    notificationPromptDismissed = true;
    try { localStorage.setItem('pi-companion-notification-prompt', 'dismissed'); } catch { /* storage blocked */ }
  }

  async function enableNotifications() {
    // Must stay inside the click handler: browsers only prompt from a user gesture.
    await devicePermissions.requestNotifications();
    dismissNotificationPrompt();
  }

  onMount(() => {
    insecureContext = !window.isSecureContext;
    theme.init();
    devicePermissions.init();
    companion.onSessionChange = (previous, next) => devicePermissions.sessionChanged(previous, next);
    try { notificationPromptDismissed = localStorage.getItem('pi-companion-notification-prompt') === 'dismissed'; } catch { /* storage blocked */ }
    const stopConnectivity = companion.watchConnectivity();
    void companion.boot();

    // The PWA worker only caches the shell and immutable static assets. API/session data
    // stays network-only so an installed Companion never replays stale control state.
    if ('serviceWorker' in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(() => {});
    }

    // A file dropped outside a drop zone would make the browser navigate to file:///…,
    // which it blocks with a security error. Swallow stray drops everywhere.
    const swallow = (event: DragEvent) => {
      if ((event.target as Element | null)?.closest?.('[data-dropzone]')) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    };
    const offline = () => companion.networkOffline();
    addEventListener('offline', offline);
    addEventListener('dragover', swallow);
    addEventListener('drop', swallow);
    return () => {
      stopConnectivity();
      removeEventListener('offline', offline);
      removeEventListener('dragover', swallow);
      removeEventListener('drop', swallow);
    };
  });
</script>

<svelte:head>
  <title>Pi Companion</title>
  <meta name="description" content="Follow and steer your Pi sessions from your browser or phone." />
</svelte:head>

<a class="skip-link" href="#main">Skip to content</a>

{#if bare}
  <main class="bare scroll" id="main"><ConnectionNotice />{@render children()}</main>
{:else}
  <div class="shell" class:working={Boolean(workPhase)} data-work-phase={workPhase}>
    <span class="sr-only" role="status">{workPhase === 'thinking' ? 'Pi is thinking.' : workPhase === 'working' ? 'Pi is working.' : ''}</span>
    <aside class="sidebar scroll" aria-label="Primary">
      <a class="brand" href="/">
        <img src={logo} alt="" width="36" height="36" />
        <span>
          <strong>Pi Companion</strong>
          <small>{companion.remote ? 'Paired device' : 'This computer'}</small>
        </span>
      </a>

      <nav class="nav">
        {#each visibleNav as item (item.href)}
          <a href={item.href} class:active={active(item.href)} aria-current={active(item.href) ? 'page' : undefined}>
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {#if item.href === '/sessions' && waiting}
              <span class="count" aria-label="{waiting} questions waiting">{waiting}</span>
            {/if}
          </a>
        {/each}
      </nav>

      <div class="sidebar-foot">
        <button class="status status-trigger" aria-haspopup="dialog" aria-label="Connection: {connectionLabel}. Open connection details" onclick={() => (aboutOpen = true)}>
          <span class="dot {companion.connection}" aria-hidden="true"></span>
          <span>{connectionLabel}</span>
          {#if companion.version}<span class="subtle mono">v{companion.version}</span>{/if}
        </button>
        <div class="segmented theme-switch" role="radiogroup" aria-label="Theme">
          {#each themes as option (option.value)}
            <button
              role="radio"
              aria-checked={theme.preference === option.value}
              aria-label={option.label}
              title={option.label}
              onclick={() => theme.set(option.value)}><Icon name={option.icon} size={16} /></button>
          {/each}
        </div>
        <nav class="legal-links" aria-label="Information">
          <a href="/privacy">Privacy</a><span aria-hidden="true">·</span><a href="/terms">Terms</a>
        </nav>
      </div>
    </aside>

    <div class="main-col">
      <header class="topbar">
        <a class="brand" href="/">
          <img src={logo} alt="" width="30" height="30" />
          <strong>Pi Companion</strong>
        </a>
        <div class="topbar-actions">
          <button class="status compact status-trigger" aria-haspopup="dialog" aria-label="Connection: {connectionLabel}. Open connection details" onclick={() => (aboutOpen = true)} title={connectionLabel}>
            <span class="dot {companion.connection}" aria-hidden="true"></span>
            <span>{connectionLabel}</span>
          </button>
          <button
            class="btn btn-ghost btn-icon"
            aria-label={theme.resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onclick={() => theme.toggle()}><Icon name={theme.resolved === 'dark' ? 'sun' : 'moon'} /></button>
        </div>
      </header>

      {#if insecureContext}
        <div class="banner danger" role="alert">
          <Icon name="alert" />
          <span>Install and offline features require HTTPS. Open Pi Companion through its secure remote URL instead of a LAN HTTP address.</span>
        </div>
      {/if}
      {#if companion.connection === 'disconnected'}
        <div class="banner" role="alert">
          <Icon name="unplug" />
          <span>Your computer ended this connection. You are still paired.</span>
          <button class="btn btn-sm" onclick={() => companion.reconnect()}>Reconnect</button>
        </div>
      {/if}
      <ConnectionNotice />
      {#if showNotificationPrompt}
        <div class="banner" role="region" aria-label="Notifications">
          <Icon name="bell" />
          <span>Turn on notifications to hear when Pi asks a question or finishes a task.</span>
          <button class="btn btn-sm btn-primary" onclick={enableNotifications}>Turn on</button>
          <button class="btn btn-sm btn-ghost" onclick={dismissNotificationPrompt}>Not now</button>
        </div>
      {/if}
      {#if updated.current}
        <div class="banner" role="status">
          <Icon name="sparkle" />
          <span>A new version of Pi Companion is ready.</span>
          <button class="btn btn-sm btn-primary" onclick={() => location.reload()}>Reload</button>
        </div>
      {/if}

      <main class="content scroll" id="main" tabindex="-1">
        {#if companion.booted && !companion.bootError}
          {@render children()}
        {:else}
          <div class="page connection-placeholder" role="status">
            <h1>{companion.bootError ? 'Workspace unavailable' : 'Connecting to workspace…'}</h1>
            <p>{companion.bootError ? 'Your sessions will appear when the connection is restored.' : 'Waiting for Pi Companion to respond.'}</p>
          </div>
        {/if}
      </main>

      <nav class="tabbar" aria-label="Primary">
        {#each visibleNav as item (item.href)}
          <a href={item.href} class:active={active(item.href)} aria-current={active(item.href) ? 'page' : undefined}>
            <span class="tab-icon">
              <Icon name={item.icon} size={20} />
              {#if item.href === '/sessions' && waiting}<span class="pip" aria-hidden="true"></span>{/if}
            </span>
            <span>{item.label}</span>
          </a>
        {/each}
      </nav>
    </div>
  </div>
{/if}
<AboutSheet bind:open={aboutOpen} />

<div class="toasts" aria-live="polite">
  {#each toasts.items as toast (toast.id)}
    <div class="toast {toast.tone}">
      <Icon name={toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'check' : 'sparkle'} size={16} />
      <span>{toast.message}</span>
      <button class="btn btn-ghost btn-sm" aria-label="Dismiss" onclick={() => toasts.dismiss(toast.id)}><Icon name="close" size={14} /></button>
    </div>
  {/each}
</div>

<style>
  .skip-link {
    position: fixed;
    left: 12px;
    top: -60px;
    z-index: 100;
    padding: 10px 14px;
    border-radius: 10px;
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
    text-decoration: none;
  }

  .skip-link:focus {
    top: 12px;
  }

  /* The window never scrolls; sidebar and content scroll independently. */
  .shell {
    height: 100dvh;
    display: grid;
    grid-template-columns: var(--sidebar) minmax(0, 1fr);
  }

  .bare {
    height: 100dvh;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 20px 14px 16px;
    border-right: 1px solid var(--border);
    background: var(--bg-sunken);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px;
    text-decoration: none;
  }

  .brand img {
    border-radius: 9px;
    flex: none;
  }

  .brand span {
    display: grid;
    line-height: 1.2;
  }

  .brand strong {
    font-size: 0.98rem;
    letter-spacing: -0.01em;
  }

  .brand small {
    color: var(--text-3);
    font-size: 0.78rem;
  }

  .nav {
    display: grid;
    gap: 2px;
  }

  .nav a {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 38px;
    padding: 0 10px;
    border-radius: 9px;
    color: var(--text-2);
    font-weight: 550;
    text-decoration: none;
    transition: background-color 150ms var(--ease), color 150ms var(--ease);
  }

  .nav a:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .nav a.active {
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .count {
    margin-left: auto;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-ink);
    font-size: 0.72rem;
    font-weight: 800;
  }

  .legal-links {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 0 4px;
    color: var(--text-3);
    font-size: 0.78rem;
  }

  .legal-links a {
    color: inherit;
    text-decoration: none;
  }

  .legal-links a:hover {
    color: var(--accent-text);
    text-decoration: underline;
  }
  .sidebar-foot {
    margin-top: auto;
    display: grid;
    gap: 12px;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    font-size: 0.82rem;
    color: var(--text-2);
  }

  .status .mono {
    margin-left: auto;
    font-size: 0.75rem;
  }

  .theme-switch {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
  }

  .theme-switch button {
    justify-content: center;
  }

  .main-col {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .content {
    flex: 1;
    min-height: 0;
    outline: none;
  }

  .topbar,
  .tabbar {
    display: none;
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 12px 16px 0;
    padding: 10px 14px;
    border: 1px solid var(--accent-line);
    border-radius: var(--radius);
    background: var(--accent-soft);
    color: var(--text);
    font-size: 0.9rem;
  }

  .banner span {
    flex: 1;
  }

  .banner.danger {
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
    background: var(--danger-soft);
  }

  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 90;
    display: grid;
    gap: 8px;
    width: min(380px, calc(100vw - 32px));
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 8px 14px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
    font-size: 0.9rem;
    animation: toast-in 220ms var(--ease);
  }

  .toast span {
    flex: 1;
  }

  .toast.success {
    color: var(--ok);
  }

  .toast.error {
    color: var(--danger);
  }

  .toast span {
    color: var(--text);
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }

  @media (max-width: 900px) {
    .shell {
      grid-template-columns: minmax(0, 1fr);
    }

    .sidebar {
      display: none;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: calc(4px + env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) 4px
        max(8px, env(safe-area-inset-left));
      border-bottom: 1px solid var(--border);
      background: var(--bg-sunken);
    }

    .topbar .brand {
      padding: 0;
    }

    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .status.compact {
      font-size: 0.78rem;
    }

    .tabbar {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: 1fr;
      padding: 2px max(8px, env(safe-area-inset-right)) calc(2px + env(safe-area-inset-bottom))
        max(8px, env(safe-area-inset-left));
      border-top: 1px solid var(--border);
      background: var(--bg-sunken);
    }

    .tabbar a {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      min-width: 0;
      min-height: 44px;
      margin: 0;
      padding: 2px 4px;
      border-radius: 12px;
      color: var(--text-3);
      font-size: 0.68rem;
      font-weight: 600;
      text-decoration: none;
      transition: background-color 150ms ease-out, color 150ms ease-out, box-shadow 150ms ease-out;
    }

    .tabbar a.active {
      border-radius: 999px;
      color: var(--accent-text);
      background: var(--clay-surface);
      box-shadow: var(--clay-pressed);
    }

    .tab-icon {
      position: relative;
      display: grid;
      place-items: center;
      width: 22px;
      height: 24px;
      border-radius: 999px;
    }

    .tabbar a.active .tab-icon {
      background: var(--accent-soft);
    }

    .pip {
      position: absolute;
      top: 1px;
      right: 0;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 2px var(--bg-sunken);
    }

    .toasts {
      bottom: calc(48px + 12px + env(safe-area-inset-bottom));
      left: 16px;
      right: 16px;
      width: auto;
    }
  }

  @media (max-width: 380px) {
    .status.compact span:last-child { max-width: 58px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .topbar .brand { min-width: 0; }
    .topbar .brand strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  }
  .sidebar {
    margin: 10px 0 10px 10px;
    border: 1px solid var(--border);
    border-radius: var(--clay-radius);
    background: var(--clay-surface);
    box-shadow: var(--clay-raised);
  }
  .nav { gap: 6px; }
  .nav a {
    min-height: 44px;
    border-radius: var(--clay-radius);
    background: var(--surface-2);
    box-shadow: var(--clay-soft);
    transition: background-color 200ms ease-out, color 200ms ease-out, box-shadow 200ms ease-out, transform 200ms ease-out;
  }
  .nav a:hover { background: var(--clay-surface); color: var(--text); box-shadow: var(--clay-soft); }
  .nav a.active { background: var(--clay-surface); color: var(--accent-text); box-shadow: var(--clay-pressed); }
  .nav a:active { transform: scale(0.97); }
  .status-trigger {
    width: 100%;
    min-height: 42px;
    border: 1px solid var(--border);
    border-radius: var(--clay-radius);
    background: var(--clay-surface);
    box-shadow: var(--clay-soft);
    text-align: left;
    cursor: pointer;
  }
  .status-trigger:hover { color: var(--text); }
  .status-trigger:active { transform: scale(0.97); box-shadow: var(--clay-pressed); }
  .topbar, .tabbar { background: var(--clay-surface); box-shadow: var(--clay-raised); }
  @media (max-width: 900px) {
    .topbar {
      flex: none;
      margin: 6px 8px 4px;
      padding: calc(4px + env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) 4px max(8px, env(safe-area-inset-left));
      border: 1px solid var(--border);
      border-radius: 20px;
      box-shadow: var(--clay-raised);
    }
    .topbar .brand { min-height: 44px; }
    .topbar .brand strong { font-size: 0.9rem; }
    .topbar-actions { gap: 8px; }
    .topbar-actions > .btn-icon { border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2); box-shadow: var(--clay-soft); }
    .tabbar {
      flex: none;
      margin: 4px 8px calc(6px + env(safe-area-inset-bottom));
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: 20px;
      box-shadow: var(--clay-raised);
      gap: 6px;
    }
    .tabbar a { border-radius: 16px; background: var(--surface-2); box-shadow: var(--clay-soft); }
    .tabbar a.active { border-radius: 16px; color: var(--accent-text); background: var(--accent-soft); box-shadow: var(--clay-pressed); }
    .tabbar a:active { transform: scale(0.97); box-shadow: var(--clay-pressed); }
    .tab-icon, .tabbar a.active .tab-icon { background: transparent; }
    .status-trigger.compact { width: auto; min-height: 44px; padding: 0 10px; border-radius: 16px; background: var(--surface-2); box-shadow: var(--clay-soft); }
  }
  :global(:focus-visible) { outline: 3px solid var(--accent); outline-offset: 3px; }
  .shell.working .brand img { animation: clay-breathe 2.2s ease-in-out infinite; }
  .shell.working .topbar { position: relative; }
  .shell.working .topbar::after {
    content: ''; position: absolute; left: 20px; right: 20px; bottom: 1px; height: 3px;
    border-radius: 999px; pointer-events: none;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    animation: clay-sweep 2.2s ease-in-out infinite alternate;
  }
  .shell.working :global(.dot.active) { animation: clay-breathe 2.2s ease-in-out infinite; }
  .shell[data-work-phase='thinking'] .brand img,
  .shell[data-work-phase='thinking'] .topbar::after { animation-duration: 3.2s; }
  @keyframes clay-breathe { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.72; transform: scale(1.04); } }
  @keyframes clay-sweep { from { opacity: 0.45; transform: scaleX(0.25); } to { opacity: 0.85; transform: scaleX(1); } }
  @media (prefers-reduced-motion: reduce) {
    .shell.working .brand img, .shell.working .topbar::after, .shell.working :global(.dot.active) { animation: none; transform: none; }
    .nav a, .status-trigger, .tabbar a { transition: none; }
    .nav a:active, .status-trigger:active, .tabbar a:active { transform: none; }
  }
</style>
