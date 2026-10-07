<svelte:head><title>Privacy · Pi Companion</title></svelte:head>

<script lang="ts">
  import Icon from '#lib/Icon.svelte';
</script>

<div class="page info-page">
  <header class="page-head">
    <div><span class="eyebrow">Your data</span><h1>Privacy</h1><p>Pi Companion keeps its dashboard and session data on your computer.</p></div>
  </header>

  <section class="bento" aria-label="Privacy details">
    <article class="tile">
      <span class="topic-icon"><Icon name="home" /></span>
      <span class="badge ok">Local-first</span>
      <h2>Stored on your computer</h2>
      <p>Pi Companion runs locally. Settings and paired-device records are stored in the daemon’s data directory. Paired-device credentials are stored as token hashes, not plaintext tokens. Temporary uploads are kept for their session and deleted when that session ends.</p>
    </article>
    <article class="tile">
      <span class="topic-icon"><Icon name="activity" /></span>
      <h2>No analytics</h2>
      <p>Pi Companion does not send telemetry or analytics to third parties.</p>
    </article>
    <article class="tile">
      <span class="topic-icon"><Icon name="devices" /></span>
      <h2>Network access</h2>
      <p>The admin dashboard is local-only. Paired devices connect through the device URL. If you configure a LAN address, tunnel or reverse proxy, that network exposure is controlled by your configuration.</p>
    </article>
    <article class="tile">
      <span class="topic-icon"><Icon name="download" /></span>
      <h2>Daemon download</h2>
      <p>On first use, the extension downloads its daemon binary from GitHub Releases and verifies the download against its SHA256 checksum before installation.</p>
    </article>
  </section>
</div>

<style>
  .bento { grid-template-columns: minmax(0, 1fr); }
  .tile { display: grid; align-content: start; justify-items: start; gap: 12px; }
  .topic-icon { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 14px; background: var(--accent-soft); color: var(--accent-text); }
</style>

