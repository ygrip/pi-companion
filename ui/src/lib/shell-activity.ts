import type { ActivityEntry } from './activity.ts';

export function isShellTool(name: string): boolean {
  return /(?:^|[._])(bash|shell|run|execute|terminal|jar_shell)$/.test(name.toLowerCase());
}

/** Conservative labels describe the operation, never infer success from output text. */
export function shellLabel(input: Record<string, unknown>, status?: ActivityEntry['status']): string {
  const action = String(input.action ?? '');
  const operation: Record<string, string> = { output: 'Shell output', peek: 'Shell status', list: 'Shell jobs', wait: 'Waiting for shell work', kill: 'Stopping shell work' };
  if (operation[action]) return operation[action];
  const command = String(input.command ?? input.cmd ?? '').trim();
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
  const simple = !/[\n;|&]/.test(command);
  let task = name;
  if (!task && simple) {
    if (/^(?:npm|pnpm|yarn|bun) (?:run )?(?:test|check)(?:\s|:|$)|^cargo (?:test|check)(?:\s|$)/.test(command)) task = 'checks';
    else if (/^(?:npm|pnpm|yarn|bun) (?:run )?(?:build|ui:build)(?:\s|$)|^cargo build(?:\s|$)/.test(command)) task = 'build';
    else if (/^git status(?:\s|$)/.test(command)) task = 'repository status';
  }
  if (status === 'error') return task ? `Failed: ${task}` : 'Shell command failed';
  if (status === 'running') return task ? `Running ${task}` : 'Running shell command';
  return task ? `Finished ${task}` : 'Shell command finished';
}

/** Keep useful trailing diagnostics, bounded by lines and characters; raw output stays available. */
export function shellPreview(output: string): { text: string; truncated: boolean; lines: number } {
  const clean = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const lines = clean ? clean.split('\n') : [];
  const preview = lines.slice(-8).map(line => line.length > 300 ? line.slice(0, 299) + '…' : line).join('\n');
  return { text: preview, truncated: lines.length > 8 || lines.some(line => line.length > 300) || clean !== output.trim(), lines: lines.length };
}
