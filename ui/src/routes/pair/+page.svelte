<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import logo from '../../assets/pi-companion.webp';
  import Icon from '#lib/Icon.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { errorMessage } from '#lib/toast.svelte.ts';

  const invite = $derived(page.url.searchParams.get('invite'));
  let name = $state(guessName());
  let pairing = $state(false);
  let error = $state('');

  function guessName() {
    const agent = navigator.userAgent;
    if (/iPhone/.test(agent)) return 'iPhone';
    if (/iPad/.test(agent)) return 'iPad';
    if (/Android/.test(agent)) return 'Android phone';
    if (/Mac/.test(agent)) return 'Mac browser';
    if (/Windows/.test(agent)) return 'Windows browser';
    return 'My device';
  }

  // Already paired: nothing to do here.
  $effect(() => {
    if (companion.booted && companion.paired && !pairing) void goto('/', { replaceState: true });
  });

  async function pair() {
    if (!invite) return;
    error = '';
    pairing = true;
    try {
      await companion.claim(invite, name.trim());
      await goto('/', { replaceState: true });
    } catch (e) {
      const message = errorMessage(e);
      error = /invalid|already used|expired/i.test(message)
        ? 'This code was already used or has expired. Ask your computer for a new one.'
        : message;
    } finally {
      pairing = false;
    }
  }
</script>

<svelte:head><title>Pair this device · Pi Companion</title></svelte:head>

<div class="wrap">
  <section class="card pair">
    <img src={logo} alt="Pi Companion" width="64" height="64" />

    {#if companion.connection === 'revoked' && !invite}
      <span class="eyebrow">Access removed</span>
      <h1>This device was unpaired</h1>
      <p class="muted">Your computer revoked this device. To use it again, scan a new pairing code from <strong>Devices</strong> on your computer.</p>
    {:else if invite}
      <span class="eyebrow">Pair this device</span>
      <h1>Connect to your computer</h1>
      <p class="muted">Give this device a name so you can recognise it in the Devices list later.</p>
      <form onsubmit={(event) => { event.preventDefault(); void pair(); }}>
        <div class="field">
          <label for="device-name">Device name</label>
          <input id="device-name" class="input" bind:value={name} maxlength="80" required autocomplete="off" />
          {#if error}<span class="error" role="alert">{error}</span>{/if}
        </div>
        <button class="btn btn-primary" disabled={pairing || !name.trim()}>{pairing ? 'Pairing…' : 'Pair device'}</button>
      </form>
      <p class="subtle small"><Icon name="check" size={14} />The code works once. Your computer can disconnect or revoke this device at any time.</p>
    {:else}
      <span class="eyebrow">Not paired yet</span>
      <h1>Scan a code to get started</h1>
      <ol class="muted">
        <li>On your computer, open Pi Companion and go to <strong>Devices</strong>.</li>
        <li>Choose <strong>Pair a device</strong>.</li>
        <li>Scan the code with this device’s camera.</li>
      </ol>
    {/if}
  </section>
</div>

<style>
  .wrap {
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
    background: radial-gradient(circle at 50% 0%, var(--accent-soft), transparent 60%), var(--bg);
  }

  .pair {
    width: min(440px, 100%);
    display: grid;
    gap: 12px;
    padding: 28px;
  }

  .pair img {
    border-radius: 15px;
    margin-bottom: 6px;
  }

  form {
    display: grid;
    gap: 14px;
    margin-top: 6px;
  }

  ol {
    margin: 0;
    padding-left: 20px;
    display: grid;
    gap: 6px;
  }

  .error {
    color: var(--danger);
    font-size: 0.85rem;
  }

  .small {
    display: flex;
    gap: 6px;
    font-size: 0.8rem;
  }
</style>
