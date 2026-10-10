<script lang="ts">
  import Icon from './Icon.svelte';
  import AutomatedSessionBadge from './AutomatedSessionBadge.svelte';
  import { companion } from './companion.svelte.ts';
  import { prettyPath, sessionTitle, statusLabel } from './format.ts';
  import type { Session } from './types.ts';

  let { sessions, label = 'Live sessions' }: { sessions: Session[]; label?: string } = $props();
</script>

<div class="session-table clay">
  <table aria-label={label}>
    <caption class="sr-only">{label}: session, workspace, model, status and actions.</caption>
    <thead>
      <tr><th scope="col">Session</th><th scope="col">Workspace</th><th scope="col">Model</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
    </thead>
    <tbody>
      {#each sessions as session (session.id)}
        {@const waiting = companion.pendingAsks(session.id)}
        <tr>
          <td class="session-cell" data-label="Session">
            <a class="session-title" href="/sessions/{encodeURIComponent(session.id)}">{sessionTitle(session)}</a>
            {#if session.readOnly || session.automationId}<AutomatedSessionBadge />{/if}
            {#if session.shortTitle.trim() && session.shortTitle.trim() !== sessionTitle(session)}<span class="short-title">{session.shortTitle}</span>{/if}
            {#if waiting}<span class="question-count"><Icon name="question" size={14} />{waiting} {waiting === 1 ? 'question waiting' : 'questions waiting'}</span>{/if}
          </td>
          <td class="workspace-cell" data-label="Workspace"><span class="workspace" title={session.cwd}><Icon name="folder" size={14} /><code>{prettyPath(session.cwd)}</code></span></td>
          <td class="model-cell" data-label="Model"><span class="model">{session.mainModel ?? 'Not reported'}</span>{#if session.effort}<span class="effort">Thinking: {session.effort}</span>{/if}</td>
          <td class="state-cell" data-label="Status"><span class="badge" class:ok={session.status === 'active'} class:accent={session.status === 'idle'}><span class="dot {session.status}" aria-hidden="true"></span>{statusLabel[session.status]}</span></td>
          <td class="action-cell" aria-hidden="true"><span class="open"><Icon name="chevron" size={16} /></span></td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<div class="mobile-session-cards" aria-label={label}>
  {#each sessions as session (session.id)}
    {@const waiting = companion.pendingAsks(session.id)}
    <a class="mobile-session-card" href="/sessions/{encodeURIComponent(session.id)}">
      <div class="mobile-session-head">
        <div class="mobile-session-name">
          <strong>{sessionTitle(session)}</strong>
          {#if session.readOnly || session.automationId}<AutomatedSessionBadge />{/if}
          {#if waiting}<span class="question-count"><Icon name="question" size={14} />{waiting} {waiting === 1 ? 'question waiting' : 'questions waiting'}</span>{/if}
        </div>
        <span class="badge" class:ok={session.status === 'active'} class:accent={session.status === 'idle'}><span class="dot {session.status}" aria-hidden="true"></span>{statusLabel[session.status]}</span>
      </div>
      <div class="mobile-session-path"><Icon name="folder" size={15} /><code>{prettyPath(session.cwd)}</code></div>
      <div class="mobile-session-bottom">
        <span class="mobile-session-model">{session.mainModel ?? 'Model not reported'}{#if session.effort}<small> · {session.effort}</small>{/if}</span>
        <span class="mobile-session-arrow" aria-hidden="true"><Icon name="chevron" size={17} /></span>
      </div>
    </a>
  {/each}
</div>

<style>
  .session-table { min-width: 0; overflow: hidden; border-radius: 20px; background: var(--surface); }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; text-align: left; }
  th { padding: 14px 16px; background: var(--surface-2); color: var(--text-2); font-size: 0.74rem; font-weight: 650; letter-spacing: 0.03em; }
  th:nth-child(1) { width: 29%; }
  th:nth-child(2) { width: 27%; }
  th:nth-child(3) { width: 18%; }
  th:nth-child(4) { width: 14%; }
  th:nth-child(5) { width: 12%; }
  td { padding: 14px 16px; border-top: 1px solid var(--border); vertical-align: middle; min-width: 0; overflow-wrap: anywhere; }
  /* The title link stretches over the row, so the whole row opens the session. */
  tbody tr { position: relative; cursor: pointer; transition: background-color 150ms var(--ease); }
  tbody tr:has(.session-title:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px; }
  .session-title::after { content: ''; position: absolute; inset: 0; z-index: 1; }
  tbody tr:hover .session-title { color: var(--accent-text); }
  tbody tr:hover { background: var(--surface-2); }
  .session-title { outline: none; display: block; padding: 4px 0; min-height: 32px; color: var(--text); font-weight: 650; line-height: 1.4; text-decoration: none; }
  .session-title:hover { color: var(--accent-text); }
  .short-title, .effort { display: block; margin-top: 4px; color: var(--text-2); font-size: 0.76rem; line-height: 1.45; }
  .workspace { display: flex; align-items: flex-start; gap: 8px; color: var(--text-2); }
  .workspace :global(svg) { flex: none; margin-top: 3px; }
  .workspace code { min-width: 0; font-size: 0.76rem; line-height: 1.55; overflow-wrap: anywhere; }
  .model { font-size: 0.82rem; line-height: 1.5; }
  .question-count { display: inline-flex; align-items: center; gap: 6px; margin-top: 5px; color: var(--accent-text); font-size: 0.76rem; }
  .question-count :global(svg) { flex: none; }
  .badge { max-width: 100%; }
  .action-cell { text-align: right; }
  .open { display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--surface); color: var(--text-2); box-shadow: var(--clay-soft); }
  tbody tr:hover .open { color: var(--accent-text); }
  @media (max-width: 1100px) {
    .session-table { border: 0; background: none; box-shadow: none; overflow: visible; }
    table, tbody { display: block; }
    thead { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    tbody { display: grid; gap: 12px; }
    tr { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px 16px; padding: 16px; border: 1px solid var(--border); border-radius: 20px; background: var(--surface); box-shadow: var(--clay-raised); }
    td { display: block; padding: 0; border: 0; }
    td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 5px; color: var(--text-3); font-size: 0.7rem; font-weight: 650; letter-spacing: 0.03em; }
    .session-cell { grid-column: 1; grid-row: 1; }
    .session-cell::before { display: none !important; }
    /* Status pinned top-right next to the title. */
    .state-cell { grid-column: 2; grid-row: 1; justify-self: end; }
    .state-cell::before { display: none !important; }
    .model-cell { grid-column: 1 / -1; }
    .session-title { min-height: 44px; display: flex; align-items: center; padding: 2px 0; font-size: 1rem; }
    .workspace-cell { grid-column: 1 / -1; }
    .state-cell { align-self: start; padding-top: 8px; }
    .action-cell { display: none; }
  }

  .mobile-session-cards { display: none; }
  @media (max-width: 1100px) {
    .session-table { display: none; }
    .mobile-session-cards { display: grid; gap: 12px; min-width: 0; }
    .mobile-session-card { display: grid; gap: 14px; min-width: 0; padding: 18px; border: 1px solid var(--border); border-radius: 20px; background: var(--surface); color: var(--text); text-decoration: none; box-shadow: var(--clay-raised); }
    .mobile-session-card:hover { background: var(--surface-2); border-color: var(--accent-line); }
    .mobile-session-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .mobile-session-head { display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: 10px; }
    .mobile-session-name { display: grid; gap: 5px; flex: 1; min-width: 120px; }
    .mobile-session-name strong { font-size: .98rem; line-height: 1.4; overflow-wrap: anywhere; }
    .mobile-session-head > .badge { flex: none; }
    .mobile-session-path { display: flex; align-items: start; gap: 8px; color: var(--text-2); font-size: .77rem; min-width: 0; }
    .mobile-session-path :global(svg) { flex: none; color: var(--accent-text); }
    .mobile-session-path code { white-space: normal; overflow-wrap: anywhere; }
    .mobile-session-bottom { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 12px; border-top: 1px solid var(--border); color: var(--text-2); font-size: .78rem; }
    .mobile-session-model { min-width: 0; overflow-wrap: anywhere; }
    .mobile-session-arrow { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: var(--surface-2); }
  }
</style>
