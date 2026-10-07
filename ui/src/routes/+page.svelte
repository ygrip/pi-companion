<script lang="ts">
  import { onMount, type Component } from 'svelte';
  import computerArt from '../assets/morph/computer.svg';
  import phoneArt from '../assets/morph/phone.svg';
  import terminalArt from '../assets/morph/terminal.svg';
  import bulbClay from '../assets/clay/bulb.webp';
  import chatBubbleClay from '../assets/clay/chat-bubble.webp';
  import computerClay from '../assets/clay/computer.webp';
  import Icon, { type IconName } from '#lib/Icon.svelte';
  import SessionCard from '#lib/SessionCard.svelte';
  import SessionTable from '#lib/SessionTable.svelte';
  import { companion } from '#lib/companion.svelte.ts';

  // The dot field cycles through clear computer, phone and terminal shapes.
  const art = [computerArt, phoneArt, terminalArt];
  let visual = $state<HTMLDivElement | null>(null);
  let DotField = $state<Component<any> | null>(null);

  const live = $derived(companion.sessions.filter((session) => session.status !== 'stopped'));
  const needsAnswer = $derived(live.filter((session) => companion.pendingAsks(session.id) > 0));
  const liveNow = $derived(
    live
      .filter((session) => companion.pendingAsks(session.id) === 0)
      .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))
      .slice(0, 6)
  );
  const working = $derived(companion.sessions.filter((session) => session.status === 'active').length);
  const waiting = $derived(Object.values(companion.asks).reduce((n, list) => n + list.length, 0));
  const connected = $derived(companion.devices.filter((d) => d.connected).length);
  const totalSessions = $derived(companion.sessions.length);

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
        label="Dots morphing between a computer, phone and terminal window" />
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
        <a class="btn" href="/help"><Icon name="help" />Help</a>
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
  <section class="guide-tile tile" aria-labelledby="guide-heading">
    <span class="guide-art"><img src={bulbClay} alt="" aria-hidden="true" /></span>
    <div class="guide-copy">
      <h2 id="guide-heading">New here?</h2>
      <p>Connect a workspace, enable a Pi session, and pair your phone with the setup guide.</p>
    </div>
    <a class="btn guide-action" href="/help">Setup guide<Icon name="chevron" size={16} /></a>
  </section>


  {#if needsAnswer.length}
    <section class="recent" aria-labelledby="needs-answer-heading">
      <div class="section-head">
        <h2 id="needs-answer-heading"><img src={chatBubbleClay} alt="" aria-hidden="true" />Needs your answer</h2>
      </div>
      <div class="session-grid">
        {#each needsAnswer as session (session.id)}<SessionCard {session} highlighted />{/each}
      </div>
    </section>
  {/if}

  <section class="recent" aria-labelledby="live-heading">
    <div class="section-head">
      <h2 id="live-heading">Live now</h2>
      <a class="btn view-all" href="/sessions">View all sessions<span class="badge count quiet">{totalSessions}</span><Icon name="chevron" size={16} /></a>
    </div>
    {#if live.length}
      {#if liveNow.length}
        <SessionTable sessions={liveNow} label="Live now" />
      {:else}
        <p class="muted">All live sessions are shown above because they need your answer.</p>
      {/if}
    {:else}
      <div class="tile empty">
        <span class="empty-icon"><img src={computerClay} alt="" aria-hidden="true" /></span>
        {#if companion.connection !== 'online'}
          <h2>Waiting for workspace connection</h2>
          <p>Live session information will refresh when the workspace is reachable again.</p>
        {:else if companion.isAdmin}
          <h2>No live sessions</h2>
          <p>Run <code>/companion</code> in a Pi session to bring it here. Install the extension first if you haven't already.</p>
        {:else}
          <h2>No live sessions</h2>
          <p>Ask the administrator to share a session by enabling remote control with <code>/companion</code>.</p>
        {/if}
        <a class="btn" href="/help"><Icon name="help" />Setup guide</a>
      </div>
    {/if}
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
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
  }

  .session-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }

  .guide-tile {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 18px;
    padding: 20px;
    border-radius: 22px;
    box-shadow: var(--clay-raised);
  }
  .guide-art { display: grid; place-items: center; width: 68px; height: 68px; border-radius: 20px; background: var(--accent-soft); box-shadow: var(--clay-pressed); }
  .guide-art img, .section-head h2 img, .empty .empty-icon img { filter: sepia(0.55) saturate(1.65) hue-rotate(350deg); }
  .guide-art img { width: 58px; height: 58px; object-fit: contain; }
  .guide-copy { display: grid; gap: 6px; min-width: 0; }
  .guide-copy h2 { font-size: 1.05rem; line-height: 1.35; }
  .guide-copy p { max-width: 54ch; margin: 0; color: var(--text-2); font-size: 0.9rem; line-height: 1.6; }
  .guide-action, .view-all { min-height: 44px; padding: 11px 16px; border-radius: 16px; background: var(--surface-2); box-shadow: var(--clay-soft); }
  .guide-action:hover, .view-all:hover { border-color: var(--accent-line); background: var(--surface-3); }
  .guide-action:active, .view-all:active { box-shadow: var(--clay-pressed); }
  .section-head h2 { display: flex; align-items: center; gap: 10px; }
  .section-head h2 img { width: 48px; height: 48px; object-fit: contain; flex: none; }
  .empty .empty-icon img { width: 64px; height: 64px; object-fit: contain; }
  .empty .btn { justify-self: start; }
  @media (max-width: 600px) {
    .guide-tile { grid-template-columns: auto minmax(0, 1fr); gap: 14px; padding: 16px; }
    .guide-art { width: 54px; height: 54px; border-radius: 16px; }
    .guide-art img { width: 46px; height: 46px; }
    .guide-action { grid-column: 1 / -1; width: 100%; justify-content: center; }
    .guide-copy p { font-size: 0.85rem; }
    .view-all { width: 100%; justify-content: center; }
    .section-head { gap: 10px; }
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

  }

  @media (max-width: 520px) {
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
