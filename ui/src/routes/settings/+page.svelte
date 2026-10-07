<script lang="ts">
  import { onMount } from 'svelte';
  import Icon, { type IconName } from '#lib/Icon.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import { theme, type ThemePreference } from '#lib/theme.svelte.ts';
  import { errorMessage, toasts } from '#lib/toast.svelte.ts';
  import type { Settings, SettingsResponse } from '#lib/types.ts';

  let data = $state<SettingsResponse | null>(null);
  let draft = $state<Settings>({ publicUrl: '', pairingTtlMinutes: 5, maxUploadMb: 25 });
  let saving = $state(false);
  let error = $state('');
  let loadError = $state('');

  const dirty = $derived(
    Boolean(data) &&
      (draft.publicUrl.trim() !== data!.settings.publicUrl ||
        Number(draft.pairingTtlMinutes) !== data!.settings.pairingTtlMinutes ||
        Number(draft.maxUploadMb) !== data!.settings.maxUploadMb)
  );

  const themes: { value: ThemePreference; label: string; hint: string; icon: IconName }[] = [
    { value: 'system', label: 'System', hint: 'Follow your OS', icon: 'monitor' },
    { value: 'light', label: 'Light', hint: 'Paper and ink', icon: 'sun' },
    { value: 'dark', label: 'Dark', hint: 'Graphite and amber', icon: 'moon' }
  ];

  function apply(response: SettingsResponse) {
    data = response;
    draft = { ...response.settings };
  }

  onMount(async () => {
    try {
      apply(await companion.getSettings());
    } catch (e) {
      loadError = errorMessage(e);
    }
  });

  async function save() {
    error = '';
    saving = true;
    try {
      apply(
        await companion.saveSettings({
          publicUrl: draft.publicUrl.trim(),
          pairingTtlMinutes: Number(draft.pairingTtlMinutes),
          maxUploadMb: Number(draft.maxUploadMb)
        })
      );
      toasts.show('Settings saved.', 'success');
    } catch (e) {
      error = errorMessage(e);
    } finally {
      saving = false;
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toasts.show('Copied.', 'success');
    } catch {
      toasts.show('Copy failed.', 'error');
    }
  }
</script>

<svelte:head><title>Settings · Pi Companion</title></svelte:head>

<div class="page narrow">
  <header class="page-head">
    <div>
      <h1>Settings</h1>
      <p>How Pi Companion looks on this browser, and how the daemon on this computer behaves.</p>
    </div>
  </header>

  <section class="card section" aria-labelledby="appearance">
    <div class="section-copy">
      <h2 id="appearance">Appearance</h2>
      <p class="muted">Saved in this browser only.</p>
    </div>
    <div class="themes" role="radiogroup" aria-labelledby="appearance">
      {#each themes as option (option.value)}
        <button class="theme-option" role="radio" aria-checked={theme.preference === option.value} onclick={() => theme.set(option.value)}>
          <span class="swatch {option.value}" aria-hidden="true"><Icon name={option.icon} /></span>
          <strong>{option.label}</strong>
          <span class="subtle">{option.hint}</span>
        </button>
      {/each}
    </div>
  </section>

  {#if loadError}
    <div class="card empty"><span class="empty-icon"><Icon name="alert" /></span><h2>Couldn’t load settings</h2><p>{loadError}</p></div>
  {:else if data}
    <form class="stack" onsubmit={(event) => { event.preventDefault(); void save(); }}>
      <section class="card section" aria-labelledby="pairing">
        <div class="section-copy">
          <h2 id="pairing">Pairing</h2>
          <p class="muted">Where paired devices reach this computer, and how long a pairing code stays valid.</p>
        </div>
        <div class="fields">
          <div class="field">
            <label for="public-url">Public address</label>
            <input id="public-url" class="input" type="url" inputmode="url" placeholder="https://companion.example.com"
              bind:value={draft.publicUrl} disabled={data.effective.publicUrlFromEnv} autocomplete="off" spellcheck="false" />
            {#if data.effective.publicUrlFromEnv}
              <span class="hint">Set by <code>PI_COMPANION_PUBLIC_URL</code> when the daemon started: <code>{data.effective.publicUrl}</code></span>
            {:else}
              <span class="hint">The HTTPS address of your tunnel or reverse proxy to port 43722. Leave empty to use <code>{data.about.deviceUrl}</code>, which only works on this computer.</span>
            {/if}
          </div>
          <div class="field short">
            <label for="ttl">Pairing code lifetime</label>
            <div class="unit"><input id="ttl" class="input" type="number" min="1" max="60" inputmode="numeric" bind:value={draft.pairingTtlMinutes} required /><span>minutes</span></div>
            <span class="hint">1 to 60. Each code works once.</span>
          </div>
        </div>
      </section>

      <section class="card section" aria-labelledby="files">
        <div class="section-copy">
          <h2 id="files">Files</h2>
          <p class="muted">Files you hand to a session live in its private temporary folder.</p>
        </div>
        <div class="fields">
          <div class="field short">
            <label for="max-upload">Largest file</label>
            <div class="unit"><input id="max-upload" class="input" type="number" min="1" max={data.limits.maxUploadMb} inputmode="numeric" bind:value={draft.maxUploadMb} required /><span>MB</span></div>
            <span class="hint">1 to {data.limits.maxUploadMb} MB per file.</span>
          </div>
        </div>
      </section>

      <div class="savebar" class:visible={dirty || error}>
        {#if error}<span class="error" role="alert"><Icon name="alert" size={16} />{error}</span>
        {:else}<span class="muted">You have unsaved changes.</span>{/if}
        <button type="button" class="btn btn-ghost" onclick={() => data && apply(data)} disabled={!dirty || saving}>Discard</button>
        <button class="btn btn-primary" disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>
    </form>

    <section class="card section" aria-labelledby="about">
      <div class="section-copy">
        <h2 id="about">About this daemon</h2>
        <p class="muted">Pi Companion v{data.about.version}</p>
      </div>
      <dl class="facts">
        {#each [
          ['Console', data.about.adminUrl, 'Only reachable from this computer. Never expose it.'],
          ['Device address', data.about.deviceUrl, 'Point your tunnel here.'],
          ['Settings and devices', data.about.dataDir, 'Device keys are stored hashed.'],
          ['Session files', data.about.tempDir, 'Cleared when a session ends.']
        ] as [label, value, hint] (label)}
          <div>
            <dt>{label}</dt>
            <dd>
              <code title={value}>{value}</code>
              <button class="btn btn-ghost btn-icon btn-sm" aria-label="Copy {label}" onclick={() => copy(value)}><Icon name="copy" size={14} /></button>
            </dd>
            <dd class="subtle">{hint}</dd>
          </div>
        {/each}
      </dl>
    </section>
  {/if}
</div>

<style>
  .narrow {
    width: min(920px, 100%);
  }

  .stack {
    display: grid;
    gap: 24px;
  }

  .section {
    display: grid;
    grid-template-columns: minmax(0, 240px) minmax(0, 1fr);
    gap: 24px;
    padding: 24px;
  }

  .section-copy {
    display: grid;
    align-content: start;
    gap: 4px;
  }

  .section-copy p {
    font-size: 0.88rem;
  }

  .fields {
    display: grid;
    gap: 20px;
  }

  .short {
    max-width: 260px;
  }

  .unit {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .unit .input {
    width: 110px;
  }

  .unit span {
    color: var(--text-2);
    font-size: 0.9rem;
  }

  .themes {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .theme-option {
    display: grid;
    justify-items: start;
    gap: 2px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    text-align: left;
    transition: border-color 150ms var(--ease);
  }

  .theme-option:hover {
    border-color: var(--text-3);
  }

  .theme-option[aria-checked='true'] {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .theme-option .subtle {
    font-size: 0.8rem;
  }

  .swatch {
    display: grid;
    place-items: center;
    width: 100%;
    height: 56px;
    margin-bottom: 8px;
    border-radius: 9px;
    border: 1px solid var(--border);
  }

  .swatch.light {
    background: #f6f4ef;
    color: #925800;
  }

  .swatch.dark {
    background: #141417;
    color: #f8bf4f;
  }

  .swatch.system {
    background: linear-gradient(135deg, #f6f4ef 0 50%, #141417 50% 100%);
    color: #f5b027;
  }

  .savebar {
    position: sticky;
    bottom: 12px;
    display: none;
    align-items: center;
    gap: 10px;
    padding: 10px 10px 10px 16px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .savebar.visible {
    display: flex;
  }

  .savebar > span {
    flex: 1;
    font-size: 0.9rem;
  }

  .error {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--danger);
  }

  .facts {
    display: grid;
    gap: 14px;
    margin: 0;
  }

  .facts div {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .facts dt {
    font-size: 0.85rem;
    font-weight: 600;
  }

  .facts dd {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .facts dd code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
  }

  .facts dd.subtle {
    font-size: 0.8rem;
  }

  @media (max-width: 760px) {
    .section {
      grid-template-columns: minmax(0, 1fr);
      gap: 16px;
      padding: 18px;
    }

    .themes {
      gap: 8px;
    }

    .short {
      max-width: none;
    }
  }
</style>
