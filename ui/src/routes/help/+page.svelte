<svelte:head><title>Help · Pi Companion</title></svelte:head>

<div class="page">
  <header class="page-head">
    <div>
      <span class="eyebrow">Guide</span>
      <h1>Help</h1>
      <p>Get Pi Companion connected, then follow and steer the sessions you choose to share.</p>
    </div>
  </header>

  <section class="bento" aria-label="Getting started">
    <article class="tile span-2">
      <span class="badge accent">Getting started</span>
      <h2>Connect Pi to this dashboard</h2>
      <ol>
        <li>Install the extension with <code>pi install git:github.com/ygrip/pi-companion</code>. The daemon binary downloads automatically when first needed.</li>
        <li>Open Pi in your project and run <code>/companion</code> in each session you want to control. This starts the daemon, prints the dashboard URL and enables remote control for that session.</li>
        <li>Open the dashboard URL on this computer. Sessions are opt-in individually.</li>
        <li>To use a phone, an administrator pairs it from Devices by scanning the QR code or entering its one-time code.</li>
        <li>Follow activity, answer Pi’s questions, send prompts, drop files and review changes.</li>
      </ol>
    </article>
    <article class="tile">
      <h2>Pairing</h2>
      <p>Pair phones from <a href="/devices">Devices</a>. A pairing code is one-time and expires quickly. Paired devices stay trusted until you revoke them. Disconnect ends the current connection without revoking the device.</p>
      <p>For a remote connection, use the device URL shown in Settings—not the local-only admin URL.</p>
    </article>
    <article class="tile span-2">
      <h2>Pi commands</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Command</th><th>What it does</th></tr></thead>
          <tbody>
            <tr><th><code>/companion</code></th><td>Starts the daemon if needed, prints the dashboard URL and enables remote control for the current session.</td></tr>
            <tr><th><code>/remote-control</code></th><td>Toggles sharing for the current session off or on.</td></tr>
          </tbody>
        </table>
      </div>
    </article>
    <article class="tile">
      <h2>Companion tools</h2>
      <dl>
        <dt><code>companion_ask_user</code></dt><dd>Ask you a question through the dashboard or paired device.</dd>
        <dt><code>companion_temp_files</code></dt><dd>List temporary files uploaded for the current session.</dd>
        <dt><code>companion_delete_temp_file</code></dt><dd>Delete a temporary upload before the session ends.</dd>
      </dl>
      <p class="muted">Temporary uploads are removed when their session ends.</p>
    </article>
    <article class="tile">
      <h2>Troubleshooting</h2>
      <dl>
        <dt>Daemon not reachable</dt><dd>Run <code>/companion</code> in the Pi session. The admin service normally listens on port <code>43721</code>.</dd>
        <dt>Custom daemon behavior</dt><dd>Check <code>PI_COMPANION_URL</code>, <code>PI_COMPANION_SERVER</code>, and <code>PI_COMPANION_AUTOSTART=0</code>.</dd>
        <dt>Restarting the daemon</dt><dd>On macOS or Linux, stop it with <code>pkill -f pi-companion-server</code>, then run <code>/companion</code> again.</dd>
      </dl>
    </article>
    <article class="tile span-2">
      <h2>Frequently asked questions</h2>
      <dl>
        <dt>Why don’t I see every Pi session?</dt><dd>Control is opt-in per session. Run <code>/companion</code> in each session you want to manage.</dd>
        <dt>Can a paired phone see all sessions?</dt><dd>No. It sees sessions that are shared for remote control. Pairing alone does not share sessions.</dd>
        <dt>Where do uploads go?</dt><dd>They are stored in the daemon’s local temporary folder for the session and deleted when that session ends.</dd>
      </dl>
    </article>
  </section>

  <footer class="help-footer" aria-label="Legal and help links">
    <a href="/help" aria-current="page">Help</a><span aria-hidden="true">·</span><a href="/privacy">Privacy</a><span aria-hidden="true">·</span><a href="/terms">Terms</a>
  </footer>
</div>

<style>
  .tile { display: grid; align-content: start; gap: 12px; }
  ol, dl { margin: 0; padding-left: 22px; display: grid; gap: 10px; color: var(--text-2); }
  dl { padding-left: 0; }
  dt { color: var(--text); font-weight: 650; }
  dd { margin: 2px 0 8px; color: var(--text-2); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-weight: 650; }
  .help-footer { display: flex; justify-content: center; gap: 10px; padding: 12px; color: var(--text-3); }
  .help-footer a { color: inherit; }
</style>
