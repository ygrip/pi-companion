<script lang="ts">
  import { onMount, type Component } from 'svelte';
  import piArt from '../assets/morph/pi.png';
  import computerArt from '../assets/morph/computer.svg';
  import companionArt from '../assets/morph/companion.svg';
  import Icon, { type IconName } from '#lib/Icon.svelte';
  import SessionCard from '#lib/SessionCard.svelte';
  import { companion } from '#lib/companion.svelte';

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
          { title: 'Run Pi as usual', body: 'Every Pi session with the extension shows up here on its own. Nothing to configure.' },
          { title: 'Pair your phone once', body: 'Scan a code from Devices. The phone stays trusted until you revoke it.' },
          { title: 'Share what you want', body: 'Type /remote-control inside a Pi session to make it visible on paired devices.' }
        ]
      : [
          { title: 'Pick a session', body: 'Only sessions your computer has chosen to share appear here.' },
          { title: 'Follow along', body: 'Read Pi’s replies, tool calls and questions as they happen.' },
          { title: 'Step in when needed', body: 'Answer questions, send a prompt, steer the current turn, or stop it.' }
        ]
  );

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
      <a class="stat card" href={stat.href}>
        <span class="stat-icon"><Icon name={stat.icon} /></span>
        <span class="stat-label">{stat.label}</span>
        <strong>{stat.value}</strong>
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
      <article class="step">
        <span class="step-index">{index + 1}</span>
        <h3>{step.title}</h3>
        <p class="muted">{step.body}</p>
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

  .stat strong {
    grid-area: value;
    margin-top: 8px;
    font-size: 1.9rem;
    line-height: 1;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
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
    gap: 12px;
  }

  .step {
    display: grid;
    gap: 6px;
    padding: 18px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-lg);
  }

  .step-index {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    margin-bottom: 4px;
    border-radius: 50%;
    background: var(--surface-3);
    font: 700 0.8rem/1 var(--mono);
    color: var(--accent-text);
  }

  .step p {
    font-size: 0.9rem;
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
      grid-template-columns: minmax(0, 1fr);
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

    .stat strong {
      font-size: 1.5rem;
    }

    .cta .btn {
      flex: 1;
    }
  }
</style>
