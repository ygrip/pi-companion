<script lang="ts">
  import { onMount, type Component } from 'svelte';
  import piArt from '../assets/morph/pi.png';
  import computerArt from '../assets/morph/computer.svg';
  import companionArt from '../assets/morph/companion.svg';
  import Icon, { type IconName } from '#lib/Icon.svelte';
  import SessionCard from '#lib/SessionCard.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  // The dot field morphs Pi → computer → companion, on the same loop as Raksara.
  const art = [piArt, computerArt, companionArt];
  let visual = $state<HTMLDivElement | null>(null);
  let DotField = $state<Component<any> | null>(null);

  const live = $derived(companion.sessions.filter((s) => s.status !== 'stopped'));
  const working = $derived(companion.sessions.filter((s) => s.status === 'active').length);
  const waiting = $derived(Object.values(companion.asks).reduce((n, list) => n + list.length, 0));
  const connected = $derived(companion.devices.filter((d) => d.connected).length);
  const recent = $derived(companion.sessions.slice(0, 4));

  type Stat = { label: string; value: number | string; hint: string; icon: IconName; href: string };
  const stats = $derived<Stat[]>([
    { label: 'Live sessions', value: live.length, hint: working ? working + ' working right now' : 'None working right now', icon: 'sessions', href: '/sessions' },
    { label: 'Waiting on you', value: waiting, hint: waiting ? 'Pi asked a question' : 'No open questions', icon: 'question', href: '/sessions' },
    ...(companion.isAdmin
      ? [
          { label: 'Paired devices', value: companion.devices.length, hint: connected ? connected + ' connected now' : 'None connected', icon: 'devices' as IconName, href: '/devices' },
          { label: 'Shared sessions', value: companion.sessions.filter((s) => s.remoteEnabled && s.status !== 'stopped').length, hint: 'Visible on your devices', icon: 'link' as IconName, href: '/sessions' }
        ]
      : [])
  ]);

  const steps = $derived(
    companion.isAdmin
      ? [
          { title: 'Install the Pi package', body: 'Install the extension once. The matching daemon binary downloads automatically on first use.', code: 'pi install git:github.com/ygrip/pi-companion' },
          { title: 'Enable each Pi session', body: 'Open Pi in your project and run /companion in every session you want to control. It starts the daemon, prints this dashboard URL and enables remote control for that session. /remote-control toggles sharing off or on.' },
          { title: 'Open this dashboard', body: 'Keep this dashboard open on your computer to follow the sessions you enabled.' },
          { title: 'Pair your phone', body: 'From Devices, scan the QR code or enter the one-time code. Pairing is an admin-only setup step.' },
          { title: 'Follow and steer', body: 'Watch activity, answer Pi’s questions, drop files into a session and review changes.' }
        ]
      : [
          { title: 'Choose a shared session', body: 'Your computer shares sessions only when remote control is enabled for them.' },
          { title: 'Follow activity', body: 'Read Pi’s replies and tool activity as it happens.' },
          { title: 'Answer and steer', body: 'Answer questions, send a prompt, drop files and review changes.' }
        ]
  );

  async function copyInstall() {
    try {
      await navigator.clipboard.writeText('pi install git:github.com/ygrip/pi-companion');
      toasts.show('Install command copied.', 'success');
    } catch {
      toasts.show('Copy failed.', 'error');
    }
  }

  onMount(() => {
    // The canvas is decorative: load it after first paint and when the browser is idle.
    const load = () => void import('#lib/DotField.svelte').then((module) => (DotField = module.default));
    if ('requestIdleCallback' in window) {
      const id = requestIdleCallback(load, { timeout: 800 });
      return () => cancelIdleCallback(id);
    }
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  });
</script>

<svelte:head><title>Overview · Pi Companion</title></svelte:head>

<div class="page">
  <section class="hero card">
    {#if DotField}
      <DotField
        images={art}
        anchor={visual}
        className="hero-field"
        label="Dots shaping the Pi symbol, then a computer, then a phone companion" />
    {/if}
    <div class="hero-copy">
      <span class="eyebrow">{companion.isAdmin ? 'Pi Companion' : 'Paired with your computer'}</span>
      <h1>Pi keeps working.<br /><span class="accent">You stay in the loop.</span></h1>
      <p>
        Watch live Pi sessions, answer its questions, steer the next step and hand over files, from this computer or
        your phone, without going back to the terminal.
      </p>
      <div class="cta">
        <a class="btn btn-primary" href="/sessions"><Icon name="sessions" />Open sessions</a>
        {#if companion.isAdmin}
          <a class="btn" href="/devices"><Icon name="devices" />Pair a phone</a>
        {/if}
      </div>
      <ol class="journey" aria-label="How it connects">
        <li>Pi</li>
        <li>Your computer</li>
        <li>Your companion</li>
      </ol>
    </div>
    <div class="hero-visual" bind:this={visual} aria-hidden="true"></div>
  </section>

  <section class="stats" aria-label="At a glance">
    {#each stats as stat (stat.label)}
      <a class="stat tile" href={stat.href}>
        <span class="stat-icon"><Icon name={stat.icon} /></span>
        <span class="stat-label">{stat.label}</span>
        <span class="badge count">{stat.value}</span>
        <span class="subtle">{stat.hint}</span>
      </a>
    {/each}
  </section>

  <section class="recent" aria-labelledby="recent-heading">
    <div class="section-head">
      <h2 id="recent-heading">Recent sessions</h2>
      {#if companion.sessions.length > recent.length}
        <a class="btn btn-ghost btn-sm" href="/sessions">View all {companion.sessions.length}<Icon name="chevron" size={14} /></a>
      {/if}
    </div>
    {#if recent.length}
      <div class="session-grid">
        {#each recent as session (session.id)}<SessionCard {session} />{/each}
      </div>
    {:else}
      <div class="card empty">
        <span class="empty-icon"><Icon name="sessions" /></span>
        {#if companion.isAdmin}
          <h2>No Pi sessions yet</h2>
          <p>Start <code>pi</code> in any project. With the companion extension installed, the session appears here within a second.</p>
        {:else}
          <h2>Nothing shared yet</h2>
          <p>On your computer, type <code>/remote-control</code> inside a Pi session to share it with this device.</p>
        {/if}
      </div>
    {/if}
  </section>

  <section class="steps" aria-labelledby="steps-heading">
    <h2 id="steps-heading" class="sr-only">How it works</h2>
    {#each steps as step, index (step.title)}
      <article class="step tile" class:span-2={companion.isAdmin && index === 1}>
        <span class="step-index">{index + 1}</span>
        <h3>{step.title}</h3>
        {#if companion.isAdmin && index === 1}
          <p class="muted">Open Pi in your project and run <code>/companion</code> in every session you want to control. It starts the daemon, prints this dashboard URL and enables remote control for that session. <code>/remote-control</code> toggles sharing off or on.</p>
        {:else}
          <p class="muted">{step.body}</p>
        {/if}
        {#if 'code' in step && step.code}
          <div class="install-command">
            <code>{step.code}</code>
            <button class="btn btn-ghost btn-icon" aria-label="Copy install command" onclick={copyInstall}><Icon name="copy" /></button>
          </div>
        {/if}
      </article>
    {/each}
  </section>
</div>

<style>
  .hero {
    position: relative;
    overflow: hidden;
    isolation: isolate;
    display: grid;
    grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
    min-height: 400px;
    background:
      radial-gradient(circle at 78% 50%, var(--accent-soft), transparent 55%),
      var(--surface);
  }

  .hero :global(.hero-field) {
    --accent: var(--dot-color);
    z-index: 0;
    -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 30%, #000 100%);
    mask-image: linear-gradient(90deg, transparent 0, #000 30%, #000 100%);
  }

  .hero-copy {
    position: relative;
    z-index: 1;
    display: grid;
    align-content: center;
    gap: 16px;
    padding: 40px;
  }

  .hero h1 {
    font-size: clamp(2rem, 3.6vw, 3rem);
    letter-spacing: -0.035em;
    line-height: 1.04;
  }

  .accent {
    color: var(--accent-text);
  }

  .hero p {
    color: var(--text-2);
    font-size: 1.02rem;
    max-width: 48ch;
  }

  .cta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 4px;
  }

  .journey {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
    font: 600 0.72rem/1 var(--mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
  }

  .journey li:not(:last-child)::after {
    content: '→';
    margin-left: 6px;
    color: var(--accent-text);
  }

  .hero-visual {
    position: relative;
    z-index: 1;
    min-height: 360px;
    margin: 20px 28px 20px 0;
    pointer-events: none;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
  }

  .stat {
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-areas: 'icon label' 'value value' 'hint hint';
    align-items: center;
    gap: 4px 10px;
    padding: 16px;
    text-decoration: none;
    transition: border-color 150ms var(--ease);
  }

  .stat:hover {
    border-color: var(--accent-line);
  }

  .stat-icon {
    grid-area: icon;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .stat-label {
    grid-area: label;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-2);
  }

  .stat .badge {
    grid-area: value;
    justify-self: start;
    margin-top: 8px;
  }

  .stat .subtle {
    grid-area: hint;
    font-size: 0.82rem;
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .session-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }

  .steps {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
  }

  .step {
    display: grid;
    align-content: start;
    gap: 8px;
    min-width: 0;
    padding: 18px;
  }

  .step-index {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    margin-bottom: 4px;
    border-radius: 10px;
    background: var(--accent-soft);
    font: 700 0.85rem/1 var(--mono);
    color: var(--accent-text);
  }

  .step p {
    font-size: 0.9rem;
  }

  .install-command {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
    padding: 4px 4px 4px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
  }

  .install-command code {
    overflow-wrap: anywhere;
    font-size: 0.78rem;
  }

  .install-command button {
    flex: none;
  }
  @media (max-width: 900px) {
    .hero {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: 240px auto;
      min-height: 0;
    }

    .hero :global(.hero-field) {
      -webkit-mask-image: linear-gradient(180deg, #000 0, #000 45%, transparent 75%);
      mask-image: linear-gradient(180deg, #000 0, #000 45%, transparent 75%);
    }

    .hero-visual {
      grid-row: 1;
      min-height: 0;
      margin: 16px 16px 0;
    }

    .hero-copy {
      grid-row: 2;
      padding: 8px 20px 24px;
      gap: 12px;
    }

    .steps {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 520px) {
    .steps {
      grid-template-columns: minmax(0, 1fr);
    }
    .stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .stat {
      padding: 12px;
    }


    .cta .btn {
      flex: 1;
    }
  }
</style>
