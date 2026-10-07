<script lang="ts">
  import Icon from '#lib/Icon.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { toasts } from '#lib/toast.svelte.ts';

  const installCommand = 'pi install git:github.com/ygrip/pi-companion';

  const steps = $derived(
    companion.remote && !companion.isAdmin
      ? [
          { title: 'Pick a session', body: 'You’ll see every session your computer has shared with you. Tap one to open it.' },
          { title: 'Watch it work', body: 'Pi’s replies and what it’s doing show up as they happen. Close the tab and come back later, it’ll catch you up.' },
          { title: 'Jump in when you want', body: 'Answer its questions, send a new message, nudge it mid-task or drop in a file. All from here.' }
        ]
      : [
          { title: 'Install', body: 'Paste this into your terminal once. It grabs everything it needs on its own.' },
          { title: 'Switch it on in Pi', body: 'In any Pi session you want to keep an eye on, type /companion. That session shows up here. Sessions you don’t switch on stay private.' },
          { title: 'Keep this page handy', body: 'This is home base on your computer. Everything you’ve switched on lives here.' },
          { title: 'Add your phone', body: 'Go to Devices, then scan the QR code with your phone’s camera. Or type the short code instead.', link: '/devices' },
          { title: 'Get on with your day', body: 'Pi will ping you when it needs an answer or finishes up. Reply from wherever you are.' }
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
      <h1>How it works</h1>
      <p>Pi Companion lets you check on Pi from your phone or any browser, so you don’t have to babysit the terminal. Here’s the quick version.</p>
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
              <a class="btn btn-ghost step-link" href={step.link}><Icon name="devices" />Go to Devices</a>
            {/if}
          </div>
        </li>
      {/each}
    </ol>
  </section>

  <section class="bento" aria-label="Help topics">
    <article class="tile">
      <span class="topic-icon"><Icon name="tool" /></span>
      <h2>The two commands you’ll use</h2>
      <p class="muted">Type these inside a Pi session on your computer.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Type this</th><th>What happens</th></tr></thead>
          <tbody>
            <tr><th><code>/companion</code></th><td>Switches this session on, so you can see it here and on your phone. Starts everything up if it isn’t running yet.</td></tr>
            <tr><th><code>/remote-control</code></th><td>Flips sharing off and on again. Off hides the session from your phone; Pi carries on as normal on your computer.</td></tr>
          </tbody>
        </table>
      </div>
    </article>

    <article class="tile">
      <span class="topic-icon"><Icon name="bell" /></span>
      <h2>Notifications and camera</h2>
      <p>Want a buzz when Pi needs you? Turn on notifications in <a href="/settings">Settings</a>. You’ll hear about it when Pi asks something, wraps up a task or a session ends.</p>
      <p>The camera is only for scanning the pairing QR code. Nothing gets recorded or sent anywhere.</p>
      <dl>
        <dt>iPhone or iPad</dt><dd>Add Pi Companion to your Home Screen first (see below), open it from there, then turn notifications on. Apple only allows them that way.</dd>
        <dt>Said no by accident?</dt><dd>Tap the icon next to the web address, find Notifications or Camera, and switch it to Allow. Then reload.</dd>
      </dl>
    </article>

    <article class="tile">
      <span class="topic-icon"><Icon name="chat" /></span>
      <h2>When Pi asks you something</h2>
      <p>Sometimes Pi needs a decision: pick an option, say yes or no, or type a quick answer. Those questions pop up here and on your phone. Answer wherever’s easiest. Whoever answers first, terminal or phone, wins.</p>
      <p class="muted">For the curious: this covers Pi’s <code>companion_ask_user</code> tool plus questions from other extensions, like <code>jar_ask</code> and the usual select, confirm and input prompts.</p>
    </article>

    <article class="tile">
      <span class="topic-icon"><Icon name="devices" /></span>
      <h2>Adding a phone</h2>
      <p>Head to <a href="/devices">Devices</a> on your computer and scan the code. Each code works once and runs out after a few minutes, so a screenshot floating around won’t let anyone in.</p>
      <p>Once your phone is in, it stays in until you remove it. <strong>Disconnect</strong> just kicks it off for now. <strong>Revoke</strong> removes it for good.</p>
      <p class="muted">Not on the same Wi-Fi? Use the device link from Settings (usually an HTTPS tunnel), not the local one.</p>
    </article>

    <article class="tile">
      <span class="topic-icon"><Icon name="download" /></span>
      <h2>Put it on your home screen</h2>
      <p>Pair first, then add it to your home screen so it opens like a normal app.</p>
      <dl>
        <dt>iPhone or iPad</dt><dd>In Safari, tap Share → Add to Home Screen. If you see “Open as Web App”, leave it on.</dd>
        <dt>Android</dt><dd>In Chrome, open the ⋮ menu → Install app (or Add to Home screen).</dd>
        <dt>Don’t see the option?</dt><dd>Make sure the address starts with <code>https://</code> and you’re in Safari or Chrome, not a browser inside another app.</dd>
      </dl>
      <p class="muted">It still needs a connection to your computer to show anything live.</p>
    </article>

    <article class="tile">
      <span class="topic-icon"><Icon name="alert" /></span>
      <h2>Something’s off?</h2>
      <dl>
        <dt>“Can’t reach your computer”</dt><dd>Check your internet and that the computer is awake. If you use a tunnel, restart it; if the link changed, open the new one. Hit <strong>Retry now</strong>. Your pairing and anything you were typing are kept, but nothing gets resent on its own.</dd>
        <dt>Activity looks stale</dt><dd>It catches up by itself when the connection comes back. Still stuck? Leave the session and open it again.</dd>
        <dt>Nothing shows up on the computer</dt><dd>Type <code>/companion</code> in the Pi session again. It normally runs on port <code>43721</code>.</dd>
        <dt>A file won’t attach</dt><dd>It might be empty, too big or a type that isn’t allowed. You’ll see the reason right under the file. Remove it and try another.</dd>
        <dt>Need a clean restart</dt><dd>On macOS or Linux run <code>pkill -f pi-companion-server</code>, then type <code>/companion</code> again.</dd>
        <dt>Git errors in Changes</dt><dd>They show as a pop-up message. Usually it means the folder isn’t a git repo or git isn’t installed.</dd>
        <dt>Power-user settings</dt><dd><code>PI_COMPANION_URL</code>, <code>PI_COMPANION_SERVER</code> and <code>PI_COMPANION_AUTOSTART=0</code> change where and how it runs.</dd>
      </dl>
    </article>

    <article class="tile">
      <span class="topic-icon"><Icon name="help" /></span>
      <h2>Quick questions</h2>
      <dl>
        <dt>Why don’t I see all my Pi sessions?</dt><dd>On purpose. Only sessions where you typed <code>/companion</code> show up. Everything else stays private.</dd>
        <dt>Can my phone see everything?</dt><dd>Nope. Just the sessions you’ve shared. Pairing a phone doesn’t share anything by itself.</dd>
        <dt>Where do my uploaded files go?</dt><dd>Into a temporary folder on your computer, just for that session. They’re cleaned up when the session ends. Nothing goes to the cloud.</dd>
        <dt>What does Archive do?</dt><dd>Tidies a finished session out of the list. Your Pi history and project files aren’t touched.</dd>
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
