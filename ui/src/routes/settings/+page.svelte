<script lang="ts">
  import { onMount } from 'svelte';
  import PageHero from '#lib/PageHero.svelte';
  import PullToRefresh from '#lib/PullToRefresh.svelte';
  import { devicePermissions } from '#lib/device-permissions.svelte.ts';
  import clayIcon from '../../assets/clay/bulb.webp';
  import Icon, { type IconName } from '#lib/Icon.svelte';
  import { companion } from '#lib/companion.svelte.ts';
  import DevicePermissions from '#lib/DevicePermissions.svelte';
  import { theme, type ThemePreference } from '#lib/theme.svelte.ts';
  import { errorMessage, toasts } from '#lib/toast.svelte.ts';
  import type { Settings, SettingsResponse } from '#lib/types.ts';
  import { estimatedCost, providerSnapshots, reportedTime, snapshotStatus, usagePercent } from '#lib/usage.ts';

  let tab = $state<'general' | 'usage'>('general');
  let usageNow = $state(Date.now());
  const usage = $derived(providerSnapshots(companion.sessions));

  onMount(() => {
    const timer = setInterval(() => { usageNow = Date.now(); }, 60_000);
    return () => clearInterval(timer);
  });

  function tabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    tab = event.key === 'Home' ? 'general' : event.key === 'End' ? 'usage' : tab === 'general' ? 'usage' : 'general';
    const button = event.currentTarget as HTMLButtonElement;
    button.parentElement?.querySelector<HTMLButtonElement>(`#settings-${tab}-tab`)?.focus();
  }

  let data = $state<SettingsResponse | null>(null);
  let draft = $state<Settings>({ publicUrl: '', pairingTtlMinutes: 5, maxUploadMb: 25, allowedUploadTypes: [] });
  /** Comma or newline separated MIME patterns, edited as text. */
  let typesText = $state('');
  let saving = $state(false);
  let error = $state('');
  let loadError = $state('');

  const parseTypes = (text: string) =>
    text
      .split(/[\s,]+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

  const dirty = $derived(
    Boolean(data) &&
      (draft.publicUrl.trim() !== data!.settings.publicUrl ||
        Number(draft.pairingTtlMinutes) !== data!.settings.pairingTtlMinutes ||
        Number(draft.maxUploadMb) !== data!.settings.maxUploadMb ||
        parseTypes(typesText).join(',') !== (data!.settings.allowedUploadTypes ?? []).join(','))
  );

  const themes: { value: ThemePreference; label: string; hint: string; icon: IconName }[] = [
    { value: 'system', label: 'System', hint: 'Follow your OS', icon: 'monitor' },
    { value: 'light', label: 'Light', hint: 'Paper and ink', icon: 'sun' },
    { value: 'dark', label: 'Dark', hint: 'Graphite and amber', icon: 'moon' }
  ];

  function apply(response: SettingsResponse) {
    const settings: Settings = {
      publicUrl: response.settings?.publicUrl ?? '',
      pairingTtlMinutes: Number(response.settings?.pairingTtlMinutes ?? 5),
      maxUploadMb: Number(response.settings?.maxUploadMb ?? 25),
      allowedUploadTypes: Array.isArray(response.settings?.allowedUploadTypes)
        ? response.settings.allowedUploadTypes
        : []
    };
    data = { ...response, settings };
    draft = { ...settings };
    typesText = settings.allowedUploadTypes.join(', ');
  }

  onMount(async () => {
    if (!companion.isAdmin) return;
    try {
      apply(await companion.getSettings());
    } catch (e) {
      loadError = errorMessage(e);
    }
  });

  async function refreshSettings() {
    await Promise.all([companion.refresh(), devicePermissions.refresh(), (async () => {
      if (!companion.isAdmin) return;
      const response = await companion.getSettings();
      if (dirty || saving) { toasts.show('Settings refreshed. Your unsaved edits are preserved.', 'info'); }
      else apply(response);
      loadError = '';
    })()]);
    usageNow = Date.now();
  }

  async function save() {
    error = '';
    saving = true;
    try {
      apply(
        await companion.saveSettings({
          publicUrl: draft.publicUrl.trim(),
          pairingTtlMinutes: Number(draft.pairingTtlMinutes),
          maxUploadMb: Number(draft.maxUploadMb),
          allowedUploadTypes: parseTypes(typesText)
        })
      );
      toasts.show('Settings saved.', 'success');
    } catch (e) {
      error = errorMessage(e);
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head><title>Settings · Pi Companion</title></svelte:head>

<div class="page narrow automation-workspace">
  <PullToRefresh onrefresh={refreshSettings} />
  <PageHero icon={clayIcon} eyebrow="MAKE YOURSELF AT HOME" title="Settings" subtitle="Your look, your alerts, your rhythm. Make Companion feel like you." />

  <div class="settings-tabs" role="tablist" aria-label="Settings sections">
    <button id="settings-general-tab" type="button" role="tab" aria-selected={tab === 'general'} aria-controls="settings-general-panel" tabindex={tab === 'general' ? 0 : -1} onclick={() => { tab = 'general'; }} onkeydown={tabKey}>General</button>
    <button id="settings-usage-tab" type="button" role="tab" aria-selected={tab === 'usage'} aria-controls="settings-usage-panel" tabindex={tab === 'usage' ? 0 : -1} onclick={() => { tab = 'usage'; }} onkeydown={tabKey}>Usage</button>
  </div>

  <div class="settings-panel stack" id="settings-general-panel" role="tabpanel" aria-labelledby="settings-general-tab" tabindex="0" hidden={tab !== 'general'}>
  <section class="card tile section" aria-labelledby="appearance">
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

  <section class="card tile section" aria-labelledby="device-permissions">
    <div class="section-copy">
      <h2 id="device-permissions">Notifications and camera</h2>
      <p class="muted">Permissions belong to this browser. Your browser asks once; you can change them in its site settings later.</p>
    </div>
    <DevicePermissions />
  </section>

  {#if !companion.isAdmin}
    <!-- Daemon settings live on the computer running Pi. -->
  {:else if loadError}
    <div class="card empty"><span class="empty-icon"><Icon name="alert" /></span><h2>Couldn’t load settings</h2><p>{loadError}</p></div>
  {:else if data}
    <form class="stack" onsubmit={(event) => { event.preventDefault(); void save(); }}>
      <section class="card tile section" aria-labelledby="pairing">
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

      <section class="card tile section" aria-labelledby="files">
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
          <div class="field">
            <label for="upload-types">Allowed file types</label>
            <input id="upload-types" class="input" type="text" placeholder="Any type" bind:value={typesText}
              autocomplete="off" spellcheck="false" aria-describedby="upload-types-hint" />
            <span class="hint" id="upload-types-hint">Optional. MIME types separated by commas, for example <code>image/*, application/pdf, text/plain</code>. Leave empty to accept any file.</span>
          </div>
        </div>
      </section>

      <!-- Appears only with unsaved edits (or a save error), docked at the bottom in thumb reach. -->
      {#if dirty || error}
        <div class="savebar" role="region" aria-label="Unsaved changes">
          <div class="savebar-copy">
            {#if error}
              <span class="error" role="alert"><Icon name="alert" size={16} />{error}</span>
            {:else}
              <span class="chip on"><span class="dot idle" aria-hidden="true"></span><span>Unsaved changes</span></span>
            {/if}
          </div>
          <div class="savebar-actions">
            <button type="button" class="btn" onclick={() => { error = ''; if (data) apply(data); }} disabled={saving}><Icon name="close" size={16} />Discard</button>
            <button class="btn btn-primary" disabled={!dirty || saving}><Icon name="check" size={16} />{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      {/if}
    </form>
  {/if}
  </div>

  <div class="settings-panel" id="settings-usage-panel" role="tabpanel" aria-labelledby="settings-usage-tab" tabindex="0" hidden={tab !== 'usage'}>
    <section class="card tile usage-section" aria-labelledby="provider-usage-heading">
      <div class="section-copy">
        <h2 id="provider-usage-heading">Provider usage</h2>
        <p class="muted">Provider quotas come from compatible extensions; recorded tokens and cost come directly from shared Pi sessions.</p>
        <p class="subtle">Account limits and session totals are different. Missing quotas stay unavailable, never estimated from token usage.</p>
      </div>
      {#if companion.connection !== 'online'}
        <p class="usage-notice" role="status">Live updates are disconnected. Showing the last available snapshots.</p>
      {/if}
      {#if usage.length}
        <!-- The scroll region is focusable so keyboard users can scroll every table column. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="usage-scroll" role="region" aria-label="Provider usage table, scroll horizontally for all columns" tabindex="0">
          <table class="usage-table">
            <caption>Weekly and 5-hour usage by provider</caption>
            <thead><tr><th scope="col">Provider</th><th scope="col">Weekly usage</th><th scope="col">5-hour usage</th><th scope="col">Session tokens</th><th scope="col">Session cost</th><th scope="col">Snapshot</th></tr></thead>
            <tbody>
              {#each usage as snapshot (snapshot.provider.toLowerCase())}
                <tr>
                  <th scope="row"><strong>{snapshot.provider}</strong><span class="subtle">{snapshot.source || 'Source not reported'}</span></th>
                  <td><strong>{usagePercent(snapshot.weekly)}</strong>{#if snapshot.weekly?.resetsAt}<span class="subtle">Resets {reportedTime(snapshot.weekly.resetsAt)}</span>{/if}</td>
                  <td><strong>{usagePercent(snapshot.fiveHour)}</strong>{#if snapshot.fiveHour?.resetsAt}<span class="subtle">Resets {reportedTime(snapshot.fiveHour.resetsAt)}</span>{/if}</td>
                  <td>{snapshot.sessionTokens === undefined ? '—' : snapshot.sessionTokens.toLocaleString()}</td>
                  <td>{snapshot.sessionCost === undefined ? '—' : estimatedCost({ amount: snapshot.sessionCost })}</td>
                  <td><span>{reportedTime(snapshot.updatedAt)}</span><span class="subtle">{snapshotStatus(snapshot, usageNow)}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="usage-cards" aria-label="Provider usage">
          {#each usage as snapshot (snapshot.provider.toLowerCase())}
            <article class="usage-card">
              <div class="usage-card-head"><strong>{snapshot.provider}</strong><span class="subtle">{snapshot.source || 'Source not reported'}</span></div>
              <dl>
                <div><dt>Weekly quota</dt><dd>{usagePercent(snapshot.weekly)}{#if snapshot.weekly?.resetsAt}<small>Resets {reportedTime(snapshot.weekly.resetsAt)}</small>{/if}</dd></div>
                <div><dt>5-hour quota</dt><dd>{usagePercent(snapshot.fiveHour)}{#if snapshot.fiveHour?.resetsAt}<small>Resets {reportedTime(snapshot.fiveHour.resetsAt)}</small>{/if}</dd></div>
                <div><dt>Session tokens</dt><dd>{snapshot.sessionTokens === undefined ? '—' : snapshot.sessionTokens.toLocaleString()}</dd></div>
                <div><dt>Session cost</dt><dd>{snapshot.sessionCost === undefined ? '—' : estimatedCost({ amount: snapshot.sessionCost })}</dd></div>
              </dl>
              <div class="usage-card-foot">{snapshotStatus(snapshot, usageNow)} · {reportedTime(snapshot.updatedAt)}</div>
            </article>
          {/each}
        </div>
      {:else}
        <div class="usage-empty"><Icon name="activity" /><h3>No provider usage reported yet</h3><p class="muted">Share a Pi session with <code>/companion</code> and send a model request to see recorded usage. Account quota limits additionally require a compatible reporting extension.</p></div>
      {/if}
    </section>
  </div>
</div>

<style>
  .narrow {
    width: min(920px, 100%);
  }

  .stack {
    display: grid;
    gap: 24px;
  }

  .settings-panel[hidden] { display: none; }
  .settings-tabs { display: flex; gap: 8px; padding: 6px; border: 1px solid var(--border); border-radius: 18px; background: var(--surface); box-shadow: var(--clay-soft); }
  .settings-tabs button { min-height: 44px; padding: 10px 20px; border: 1px solid transparent; border-radius: 12px; background: transparent; color: var(--text-2); font: inherit; font-weight: 600; cursor: pointer; }
  .settings-tabs button[aria-selected='true'] { border-color: var(--border-strong); background: var(--surface-2); color: var(--text); box-shadow: var(--clay-soft); }
  .settings-tabs button:focus-visible, .usage-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .usage-section { display: grid; gap: 20px; padding: 24px; min-width: 0; }
  .usage-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; }
  .usage-cards { display: none; }
  .usage-table { width: 100%; min-width: 850px; border-collapse: collapse; text-align: left; font-size: 0.88rem; }
  .usage-table caption { padding: 12px 16px; text-align: left; color: var(--text-2); font-size: 0.82rem; }
  .usage-table th, .usage-table td { padding: 14px 16px; border-top: 1px solid var(--border); vertical-align: top; }
  .usage-table thead { color: var(--text-2); background: var(--surface-2); }
  .usage-table tbody th { font-weight: 400; }
  .usage-table .subtle { display: block; margin-top: 5px; font-size: 0.76rem; font-weight: 400; overflow-wrap: anywhere; }
  .usage-table strong { font-variant-numeric: tabular-nums; }
  .usage-notice { padding: 12px 16px; border: 1px solid var(--border); border-radius: 12px; color: var(--text-2); background: var(--surface-2); font-size: 0.88rem; }
  .usage-empty { display: grid; gap: 8px; padding: 16px 0; justify-items: start; }
  .usage-empty h3 { margin: 0; font-size: 1rem; }
  @media (max-width: 760px) {
    .usage-scroll { display: none; }
    .usage-cards { display: grid; gap: 12px; min-width: 0; }
    .usage-card { display: grid; gap: 14px; padding: 16px; border: 1px solid var(--border); border-radius: 18px; background: var(--surface); box-shadow: var(--clay-soft); }
    .usage-card-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
    .usage-card-head strong { font-size: .95rem; overflow-wrap: anywhere; }
    .usage-card-head .subtle { font-size: .72rem; }
    .usage-card dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin: 0; }
    .usage-card dt { color: var(--text-2); font-size: .72rem; margin-bottom: 5px; }
    .usage-card dd { margin: 0; font-size: 1rem; font-weight: 650; overflow-wrap: anywhere; }
    .usage-card dd small { display: block; margin-top: 4px; font-size: .7rem; font-weight: 400; color: var(--text-2); }
    .usage-card-foot { padding-top: 10px; border-top: 1px solid var(--border); font-size: .71rem; color: var(--text-2); }
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

  .fields .field,
  .fields .input,
  .unit,
  .unit .input {
    width: 100%;
    max-width: none;
  }

  .field {
    display: grid;
    align-content: start;
    gap: 7px;
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
    width: 100%;
    min-width: 0;
    flex: 1;
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
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 10px 10px 16px;
    border: 1px solid var(--accent-line);
    border-radius: var(--radius-bento);
    background: var(--surface);
    box-shadow: var(--shadow);
    animation: savebar-in 200ms var(--ease);
  }

  .savebar-copy {
    min-width: 0;
  }

  .savebar-actions {
    display: flex;
    gap: 8px;
  }

  .savebar-actions .btn {
    min-width: 112px;
    border-radius: 14px;
  }

  @keyframes savebar-in {
    from {
      transform: translateY(12px);
    }
  }

  .error {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--danger);
    font-size: 0.9rem;
  }

  @media (max-width: 760px) {
    .usage-section { padding: 18px; }
    .settings-tabs button { flex: 1; }
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
    .savebar {
      flex-direction: column;
      align-items: stretch;
      padding: 12px;
    }

    .savebar-actions .btn {
      flex: 1;
      min-height: 48px;
    }
  }
</style>
