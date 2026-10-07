<svelte:head><title>Privacy · Pi Companion</title></svelte:head>

<div class="page">
  <header class="page-head">
    <div><span class="eyebrow">Your data</span><h1>Privacy</h1><p>Pi Companion keeps its dashboard and session data on your computer.</p></div>
  </header>

  <section class="bento" aria-label="Privacy details">
    <article class="tile span-2">
      <span class="badge ok">Local-first</span>
      <h2>Stored on your computer</h2>
      <p>Pi Companion runs locally. Settings and paired-device records are stored in the daemon’s data directory. Paired-device credentials are stored as token hashes, not plaintext tokens. Temporary uploads are kept for their session and deleted when that session ends.</p>
    </article>
    <article class="tile">
      <h2>No analytics</h2>
      <p>Pi Companion does not send telemetry or analytics to third parties.</p>
    </article>
    <article class="tile">
      <h2>Network access</h2>
      <p>The admin dashboard is local-only. Paired devices connect through the device URL. If you configure a LAN address, tunnel or reverse proxy, that network exposure is controlled by your configuration.</p>
    </article>
    <article class="tile span-2">
      <h2>Daemon download</h2>
      <p>On first use, the extension downloads its daemon binary from GitHub Releases and verifies the download against its SHA256 checksum before installation.</p>
    </article>
  </section>
</div>

<style>
  .tile { display: grid; align-content: start; gap: 12px; }
</style>
