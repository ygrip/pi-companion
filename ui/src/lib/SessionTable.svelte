<script lang="ts">
  import Icon from './Icon.svelte';
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
            {#if session.shortTitle.trim() && session.shortTitle.trim() !== sessionTitle(session)}<span class="short-title">{session.shortTitle}</span>{/if}
            {#if waiting}<span class="question-count"><Icon name="question" size={14} />{waiting} {waiting === 1 ? 'question waiting' : 'questions waiting'}</span>{/if}
          </td>
          <td class="workspace-cell" data-label="Workspace"><span class="workspace" title={session.cwd}><Icon name="folder" size={14} /><code>{prettyPath(session.cwd)}</code></span></td>
          <td class="model-cell" data-label="Model"><span class="model">{session.mainModel ?? 'Not reported'}</span>{#if session.effort}<span class="effort">Thinking: {session.effort}</span>{/if}</td>
          <td class="state-cell" data-label="Status"><span class="badge" class:ok={session.status === 'active'} class:accent={session.status === 'idle'}><span class="dot {session.status}" aria-hidden="true"></span>{statusLabel[session.status]}</span></td>
          <td class="action-cell"><a class="btn open" href="/sessions/{encodeURIComponent(session.id)}" aria-label="Open {sessionTitle(session)}">Open<Icon name="chevron" size={14} /></a></td>
        </tr>
      {/each}
    </tbody>
  </table>
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
  tbody tr { transition: background-color 150ms var(--ease); }
  tbody tr:hover { background: var(--surface-2); }
  .session-title { display: block; padding: 4px 0; min-height: 32px; color: var(--text); font-weight: 650; line-height: 1.4; text-decoration: none; }
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
  .open { min-height: 44px; padding: 10px 12px; border-radius: 14px; background: var(--surface); box-shadow: var(--clay-soft); white-space: nowrap; }
  .open:hover { background: var(--surface-3); border-color: var(--accent-line); }
  .open:active { box-shadow: var(--clay-pressed); }
  @media (max-width: 1100px) {
    .session-table { border: 0; background: none; box-shadow: none; overflow: visible; }
    table, tbody { display: block; }
    thead { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    tbody { display: grid; gap: 12px; }
    tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px 16px; padding: 16px; border: 1px solid var(--border); border-radius: 20px; background: var(--surface); box-shadow: var(--clay-raised); }
    td { display: block; padding: 0; border: 0; }
    td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 5px; color: var(--text-3); font-size: 0.7rem; font-weight: 650; letter-spacing: 0.03em; }
    .session-cell { grid-column: 1 / -1; }
    .session-cell::before { display: none !important; }
    .session-title { min-height: 44px; display: flex; align-items: center; padding: 2px 0; font-size: 1rem; }
    .workspace-cell { grid-column: 1 / -1; }
    .state-cell { align-self: start; }
    .action-cell { grid-column: 1 / -1; padding-top: 12px; border-top: 1px solid var(--border); }
    .open { width: 100%; justify-content: center; }
  }
</style>
