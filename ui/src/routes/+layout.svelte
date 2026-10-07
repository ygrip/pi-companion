<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page, updated } from '$app/state';
  import logo from '../assets/pi-companion.webp';
  import Icon, { type IconName } from '#lib/Icon.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { theme, type ThemePreference } from '#lib/theme.svelte.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  let { children } = $props();

  type NavItem = { href: string; label: string; icon: IconName; admin?: boolean };
  const nav: NavItem[] = [
    { href: '/', label: 'Overview', icon: 'home' },
    { href: '/sessions', label: 'Sessions', icon: 'sessions' },
    { href: '/devices', label: 'Devices', icon: 'devices', admin: true },
    { href: '/settings', label: 'Settings', icon: 'settings', admin: true }
  ];
  const visibleNav = $derived(nav.filter((item) => !item.admin || companion.isAdmin));
  const path = $derived(page.url.pathname);
  const bare = $derived(companion.remote && !companion.paired);
  const waiting = $derived(Object.values(companion.asks).reduce((total, list) => total + list.length, 0));

  const connectionLabel = $derived(
    {
      connecting: 'Connecting…',
      online: 'Live',
      offline: 'Reconnecting…',
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
    if (bare && path !== '/pair') void goto('/pair', { replaceState: true });
    else if (companion.remote && (path.startsWith('/devices') || path.startsWith('/settings'))) void goto('/', { replaceState: true });
  });

  onMount(() => {
    theme.init();
    void companion.boot();

    // A file dropped outside a drop zone would make the browser navigate to file:///…,
    // which it blocks with a security error. Swallow stray drops everywhere.
    const swallow = (event: DragEvent) => {
      if ((event.target as Element | null)?.closest?.('[data-dropzone]')) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    };
    addEventListener('dragover', swallow);
    addEventListener('drop', swallow);
    return () => {
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
  <main class="bare scroll" id="main">{@render children()}</main>
{:else}
  <div class="shell">
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
        <div class="status" role="status">
          <span class="dot {companion.connection}" aria-hidden="true"></span>
          <span>{connectionLabel}</span>
          {#if companion.version}<span class="subtle mono">v{companion.version}</span>{/if}
        </div>
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
      </div>
    </aside>

    <div class="main-col">
      <header class="topbar">
        <a class="brand" href="/">
          <img src={logo} alt="" width="30" height="30" />
          <strong>Pi Companion</strong>
        </a>
        <div class="topbar-actions">
          <span class="status compact" role="status" title={connectionLabel}>
            <span class="dot {companion.connection}" aria-hidden="true"></span>
            <span>{connectionLabel}</span>
          </span>
          <button
            class="btn btn-ghost btn-icon"
            aria-label={theme.resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onclick={() => theme.toggle()}><Icon name={theme.resolved === 'dark' ? 'sun' : 'moon'} /></button>
        </div>
      </header>

      {#if companion.connection === 'disconnected'}
        <div class="banner" role="alert">
          <Icon name="unplug" />
          <span>Your computer ended this connection. You are still paired.</span>
          <button class="btn btn-sm" onclick={() => companion.reconnect()}>Reconnect</button>
        </div>
      {:else if companion.bootError}
        <div class="banner danger" role="alert"><Icon name="alert" /><span>{companion.bootError}</span></div>
      {/if}
      {#if updated.current}
        <div class="banner" role="status">
          <Icon name="sparkle" />
          <span>A new version of Pi Companion is ready.</span>
          <button class="btn btn-sm btn-primary" onclick={() => location.reload()}>Reload</button>
        </div>
      {/if}

      <main class="content scroll" id="main" tabindex="-1">
        {#if companion.booted}{@render children()}{/if}
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
      gap: 12px;
      padding: calc(8px + env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 8px
        max(12px, env(safe-area-inset-left));
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
      padding: 4px max(8px, env(safe-area-inset-right)) calc(4px + env(safe-area-inset-bottom))
        max(8px, env(safe-area-inset-left));
      border-top: 1px solid var(--border);
      background: var(--bg-sunken);
    }

    .tabbar a {
      display: grid;
      justify-items: center;
      gap: 2px;
      min-height: 52px;
      padding-top: 6px;
      border-radius: 10px;
      color: var(--text-3);
      font-size: 0.72rem;
      font-weight: 600;
      text-decoration: none;
    }

    .tabbar a.active {
      color: var(--accent-text);
    }

    .tab-icon {
      position: relative;
      display: grid;
      place-items: center;
      width: 44px;
      height: 26px;
      border-radius: 999px;
    }

    .tabbar a.active .tab-icon {
      background: var(--accent-soft);
    }

    .pip {
      position: absolute;
      top: 1px;
      right: 8px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 2px var(--bg-sunken);
    }

    .toasts {
      bottom: calc(var(--tabbar) + 16px + env(safe-area-inset-bottom));
      left: 16px;
      right: 16px;
      width: auto;
    }
  }

  @media (max-width: 380px) {
    .status.compact span:last-child {
      display: none;
    }
  }
</style>
