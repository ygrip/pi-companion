<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  const installCommand = 'pi install git:github.com/ygrip/pi-companion';

  const steps = $derived(
    companion.remote && !companion.isAdmin
      ? [
          { title: 'Choose a shared session', body: 'Pick one of the sessions your computer has enabled for remote control.' },
          { title: 'Follow activity', body: 'Read Pi’s replies and tool activity as it happens.' },
          { title: 'Answer and steer', body: 'Answer questions, send prompts, add files and review changes.' }
        ]
      : [
          { title: 'Install', body: 'Install the extension once. The matching daemon binary downloads automatically from GitHub Releases and is verified.' },
          { title: 'Enable each session with /companion', body: 'Run /companion in every Pi session you want to control. This starts the daemon, prints the dashboard URL and enables sharing for that session.' },
          { title: 'Open the dashboard', body: 'Keep this dashboard open to follow the sessions you enabled.' },
          { title: 'Pair your phone', body: 'An administrator can scan the QR code or enter a one-time code from Devices.', link: '/devices' },
          { title: 'Follow and answer', body: 'Watch activity, answer Pi’s questions, send prompts, add files and review changes.' }
        ]
  );

  async function copyInstall() {
    try {
      await navigator.clipboard.writeText(installCommand);
      toasts.show('Install command copied.', 'success');
    } catch {
      toasts.show('Copy failed.', 'error');
    }
  }
</script>

<svelte:head><title>Help · Pi Companion</title></svelte:head>

<div class="page info-page">
  <header class="page-head">
    <div>
      <span class="eyebrow">Guide</span>
      <h1>Help</h1>
      <p>Get Pi Companion connected, then follow and steer the sessions you choose to share.</p>
    </div>
  </header>

  <section class="tile stepper" aria-label="Setup guide">
    <ol>
      {#each steps as step, index (step.title)}
        <li>
          <span class="step-number" aria-hidden="true">{index + 1}</span>
          <div class="step-content">
            <h2>{step.title}</h2>
            <p>{step.body}</p>
            {#if step.title === 'Install'}
              <div class="install-command">
                <code>{installCommand}</code>
                <button class="btn btn-ghost" onclick={copyInstall}><Icon name="copy" />Copy</button>
              </div>
            {/if}
            {#if 'link' in step && step.link}
              <a class="btn btn-ghost step-link" href={step.link}><Icon name="devices" />Open Devices</a>
            {/if}
          </div>
        </li>
      {/each}
    </ol>
  </section>

  <section class="bento" aria-label="Help topics">
    <article class="tile">
      <span class="topic-icon"><Icon name="tool" /></span>
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
      <span class="topic-icon"><Icon name="chat" /></span>
      <h2>Companion tools</h2>
      <dl>
        <dt><code>companion_ask_user</code></dt><dd>Ask 1–4 questions in the dashboard or paired-device sheet, with descriptions, multi-select options or free text.</dd>
        <dt><code>companion_temp_files</code></dt><dd>List temporary files uploaded for the current session.</dd>
        <dt><code>companion_delete_temp_file</code></dt><dd>Delete a temporary upload before the session ends.</dd>
      </dl>
      <p class="muted">Questions from other extensions are relayed too, including <code>ctx.ui</code> select/confirm/input dialogs and pi-jar’s <code>jar_ask</code>. Answer in the terminal or Companion; the first answer wins. Temporary uploads are removed when their session ends.</p>
    </article>
    <article class="tile">
      <span class="topic-icon"><Icon name="devices" /></span>
      <h2>Pairing</h2>
      <p>Pair phones from <a href="/devices">Devices</a>. A pairing code is one-time and expires quickly. Paired devices stay trusted until you revoke them. Disconnect ends the current connection without revoking the device.</p>
      <p>For a remote connection, use the device URL shown in Settings—not the local-only admin URL.</p>
    </article>
    <article class="tile">
      <span class="topic-icon"><Icon name="download" /></span>
      <h2>Install on your phone</h2>
      <p>Open the paired-device dashboard using its HTTPS address in your phone’s browser, then install Pi Companion to launch it as an app.</p>
      <dl>
        <dt>iPhone or iPad</dt><dd>In Safari, tap Share → Add to Home Screen. Enable Open as Web App if offered, then tap Add.</dd>
        <dt>Android</dt><dd>In Chrome, open the browser menu → Install app or Add to Home screen.</dd>
        <dt>No install option?</dt><dd>Use HTTPS, not a plain HTTP LAN address. Open the link in Safari or Chrome rather than an in-app browser. Ask your administrator for the HTTPS tunnel or reverse-proxy address configured in Settings.</dd>
      </dl>
      <p class="muted">An internet or local-network connection to the daemon is still required. Installing does not enable offline session access.</p>
    </article>
    <article class="tile">
      <span class="topic-icon"><Icon name="alert" /></span>
      <h2>Troubleshooting</h2>
      <dl>
        <dt>Daemon not reachable</dt><dd>Run <code>/companion</code> in the Pi session. The admin service normally listens on port <code>43721</code>.</dd>
        <dt>Custom daemon behavior</dt><dd>Check <code>PI_COMPANION_URL</code>, <code>PI_COMPANION_SERVER</code>, and <code>PI_COMPANION_AUTOSTART=0</code>.</dd>
        <dt>Restarting the daemon</dt><dd>On macOS or Linux, stop it with <code>pkill -f pi-companion-server</code>, then run <code>/companion</code> again.</dd>
        <dt>Git errors</dt><dd>Git problems on the Changes tab appear as a toast; check the message and your repository state.</dd>
      </dl>
    </article>
    <article class="tile">
      <span class="topic-icon"><Icon name="help" /></span>
      <h2>Frequently asked questions</h2>
      <dl>
        <dt>Why don’t I see every Pi session?</dt><dd>Control is opt-in per session. Run <code>/companion</code> in each session you want to manage.</dd>
        <dt>Can a paired phone see all sessions?</dt><dd>No. It sees sessions that are shared for remote control. Pairing alone does not share sessions.</dd>
        <dt>How do questions work?</dt><dd><code>companion_ask_user</code> can show several questions together, with choices, descriptions, multi-select or free text. Companion also relays other extensions’ select, confirm and input dialogs, including pi-jar’s <code>jar_ask</code>. The first terminal or Companion answer wins.</dd>
        <dt>Where do uploads go?</dt><dd>They are stored in the daemon’s local temporary folder for the session and deleted when that session ends.</dd>
      </dl>
    </article>
  </section>

  <footer class="help-footer" aria-label="Legal links">
    <a href="/privacy">Privacy</a><span aria-hidden="true">·</span><a href="/terms">Terms</a>
  </footer>
</div>

<style>
  .bento { grid-template-columns: minmax(0, 1fr); }
  .tile { display: grid; align-content: start; gap: 12px; }
  .topic-icon { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 14px; background: var(--accent-soft); color: var(--accent-text); }
  .stepper { padding: 22px; }
  .stepper ol { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
  .stepper li { position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 14px; padding-bottom: 24px; }
  .stepper li:last-child { padding-bottom: 0; }
  .stepper li:not(:last-child)::after { content: ''; position: absolute; left: 16px; top: 34px; bottom: 0; width: 2px; background: var(--border); }
  .step-number { z-index: 1; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-text); font: 700 0.85rem/1 var(--mono); }
  .step-content { display: grid; align-content: start; gap: 8px; min-width: 0; padding-top: 4px; }
  .step-content h2 { font-size: 1.05rem; }
  .step-content p, dl { color: var(--text-2); }
  .install-command { display: flex; align-items: center; justify-content: space-between; gap: 8px; max-width: 620px; min-width: 0; padding: 4px 4px 4px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-sunken); }
  .install-command code { overflow-wrap: anywhere; font-size: 0.82rem; }
  .install-command button, .step-link { flex: none; }
  dl { margin: 0; display: grid; gap: 8px; }
  dt { color: var(--text); font-weight: 650; }
  dd { margin: -6px 0 8px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-weight: 650; }
  .help-footer { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 10px; padding: 12px; color: var(--text-3); }
  .help-footer a { color: inherit; }
  @media (max-width: 520px) { .stepper { padding: 16px; } .stepper li { gap: 10px; } }
</style>
