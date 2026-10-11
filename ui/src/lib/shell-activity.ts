import type { ActivityEntry } from './activity.ts';

export function isShellTool(name: string): boolean {
  return /(?:^|[._])(bash|shell|run|execute|terminal|jar_shell)$/.test(name.toLowerCase());
}

/** Steps that only set up the shell and say nothing about what the command does. */
const SETUP = /^(?:cd|pushd|popd|export|set|source|\.|true|false|:|unset|ulimit|trap|sleep|for|while|until|if|then|else|elif|fi|do|done|case|esac|\[\[?|test|wait|exit|return|local|declare|[}\])])(?:\s|$)/;
const WRAPPERS = /^(?:sudo|time|nohup|env|npx|bunx|pnpx|exec|command|xargs)\s+/;

function steps(command: string): string[] {
  return command
    // Heredoc bodies are data, not steps; keep anything after the delimiter on its line.
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, '$3')
    .replace(/\\\n/g, ' ')
    .split(/\n|&&|\|\||;/)
    // A pipeline is described by its producer; `| head`, `| grep` only shape its output.
    .map(step => {
      let s = step.split('|')[0].trim().replace(/^[({]+\s*/, '');
      for (let i = 0; i < 4; i++) {
        const next = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '').replace(WRAPPERS, '');
        if (next === s) break;
        s = next;
      }
      return s;
    })
    .filter(s => s && !s.startsWith('#') && !SETUP.test(s) && !/^echo\s+["']?-+/.test(s));
}

const words = (step: string) => step.split(/\s+/).filter(Boolean);
const base = (word = '') => word.split('/').pop() ?? word;

const GIT: Record<string, string> = {
  status: 'Check git status', log: 'Read git history', diff: 'Review changes', show: 'Inspect a commit',
  add: 'Stage changes', commit: 'Commit changes', push: 'Push to remote', pull: 'Pull from remote',
  fetch: 'Fetch from remote', tag: 'Manage tags', checkout: 'Switch branch', switch: 'Switch branch',
  branch: 'Manage branches', merge: 'Merge branches', rebase: 'Rebase branch', stash: 'Stash changes',
  clone: 'Clone repository', reset: 'Reset changes', restore: 'Restore files', 'rev-parse': 'Resolve git refs',
  blame: 'Inspect line history', grep: 'Search the repository'
};

const SCRIPT: Record<string, string> = {
  test: 'Run tests', check: 'Run checks', lint: 'Lint code', build: 'Build', dev: 'Start dev server',
  serve: 'Start server', start: 'Start app', install: 'Install dependencies', i: 'Install dependencies',
  ci: 'Install dependencies', add: 'Add dependency', remove: 'Remove dependency', publish: 'Publish package',
  version: 'Bump version', format: 'Format code', fmt: 'Format code', typecheck: 'Type-check', clippy: 'Lint code',
  run: 'Run program', audit: 'Audit dependencies', update: 'Update dependencies', outdated: 'Check outdated dependencies'
};

function scriptLabel(name: string): string {
  const key = name.replace(/^run\s+/, '');
  const [head, tail] = key.split(':');
  if (SCRIPT[key]) return SCRIPT[key];
  // Scripts are named either verb:scope (test:server) or scope:verb (ui:check).
  if (tail && SCRIPT[head]) return `${SCRIPT[head]} (${tail})`;
  if (tail && SCRIPT[tail]) return `${SCRIPT[tail]} (${head})`;
  return `Run ${key}`;
}

/** One human-readable phrase for a single shell step. */
function describeStep(step: string): string {
  const [first = '', second = '', third = ''] = words(step);
  const prog = base(first);
  if (prog === 'git') return GIT[second] ?? `Run git ${second}`.trim();
  if (/^(?:npm|pnpm|yarn|bun)$/.test(prog)) {
    if (!second) return 'Run package script';
    if (second === 'run' || second === 'run-script') return third ? scriptLabel(third) : 'List package scripts';
    return scriptLabel(second);
  }
  if (prog === 'cargo') return SCRIPT[second] ? `${SCRIPT[second]} (Rust)` : `Run cargo ${second}`.trim();
  if (prog === 'go') return SCRIPT[second] ? `${SCRIPT[second]} (Go)` : `Run go ${second}`.trim();
  if (/^(?:tsc|vue-tsc|svelte-check)$/.test(prog)) return 'Type-check';
  if (/^(?:vitest|jest|pytest|mocha|playwright)$/.test(prog)) return 'Run tests';
  if (/^(?:eslint|biome|ruff|prettier)$/.test(prog)) return /prettier|format/.test(step) ? 'Format code' : 'Lint code';
  if (/^(?:rg|grep|ag|ack)$/.test(prog)) return 'Search code';
  if (/^(?:ls|find|fd|tree|du)$/.test(prog)) return 'List files';
  if (/^(?:cat|head|tail|less|sed|awk|bat|wc|nl|jq)$/.test(prog)) return /\s-i\b/.test(step) && prog === 'sed' ? 'Edit file' : 'Read file';
  if (/^(?:curl|wget|http)$/.test(prog)) return 'Fetch URL';
  if (/^(?:mkdir)$/.test(prog)) return 'Create folder';
  if (/^(?:rm|rmdir|trash)$/.test(prog)) return 'Delete files';
  if (/^(?:mv|cp|rsync|ln)$/.test(prog)) return prog === 'cp' || prog === 'rsync' ? 'Copy files' : prog === 'ln' ? 'Link files' : 'Move files';
  if (/^(?:chmod|chown)$/.test(prog)) return 'Change permissions';
  if (/^(?:tar|zip|unzip|gzip)$/.test(prog)) return 'Archive files';
  if (/^(?:docker|podman)$/.test(prog)) return `Docker ${second}`.trim();
  if (/^(?:kubectl|helm)$/.test(prog)) return `${prog} ${second}`.trim();
  if (prog === 'gh') return `GitHub ${[second, third].filter(Boolean).join(' ')}`.trim();
  if (/^(?:node|deno|python3?|ruby|bash|sh|zsh|tsx|ts-node)$/.test(prog)) {
    const script = words(step).slice(1).find(word => !word.startsWith('-'));
    if (/^(?:python3?|node)$/.test(prog) && (/^-[ce]?$/.test(second) || !second)) return `Run inline ${prog === 'node' ? 'Node' : 'Python'} script`;
    return script ? `Run ${base(script.replace(/['"]/g, ''))}` : `Run ${prog}`;
  }
  if (/^(?:echo|printf)$/.test(prog)) return 'Print text';
  if (/^(?:ps|pgrep|lsof|top)$/.test(prog)) return 'Inspect processes';
  if (/^(?:kill|pkill|killall)$/.test(prog)) return 'Stop process';
  if (/^(?:open|xdg-open)$/.test(prog)) return 'Open file';
  if (/^(?:make|just|task)$/.test(prog)) return second ? `Run ${prog} ${second}` : `Run ${prog}`;
  const sub = second && /^[a-z][\w:-]*$/.test(second) && second.length <= 20 ? ` ${second}` : '';
  return `Run ${prog}${sub}`;
}

/** A single readable line summarising what a shell command does; the full script stays out of view. */
export function shellSummary(command: string): string {
  const found = steps(command.trim());
  // Status echoes are noise next to real work.
  const work = found.filter(step => !/^(?:echo|printf)\s/.test(step));
  const all = work.length ? work : found;
  if (!all.length) return command.trim() ? 'Shell command' : '';
  const labels: string[] = [];
  for (const step of all) {
    const label = describeStep(step);
    if (!labels.includes(label)) labels.push(label);
  }
  const head = labels.slice(0, 2).join(', ');
  const rest = labels.length - 2;
  const line = rest > 0 ? `${head} +${rest} more` : head;
  return line.length > 90 ? line.slice(0, 89) + '…' : line;
}

/**
 * Brief label for a shell tool call. Prefers a caller-supplied name/description, then a
 * summary derived from the command. Status is shown separately, so it is never claimed here.
 */
export function shellLabel(input: Record<string, unknown>, _status?: ActivityEntry['status']): string {
  const action = String(input.action ?? '');
  const operation: Record<string, string> = { output: 'Read shell output', peek: 'Check shell status', list: 'List shell jobs', wait: 'Wait for shell work', kill: 'Stop shell work' };
  if (operation[action]) return operation[action];
  for (const key of ['description', 'name', 'title']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      const text = value.trim().replace(/\s+/g, ' ');
      return (text[0].toUpperCase() + text.slice(1)).slice(0, 90);
    }
  }
  const command = String(input.command ?? input.cmd ?? '');
  return shellSummary(command) || 'Shell command';
}

/** Keep useful trailing diagnostics, bounded by lines and characters; raw output stays available. */
export function shellPreview(output: string): { text: string; truncated: boolean; lines: number } {
  const clean = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const lines = clean ? clean.split('\n') : [];
  const preview = lines.slice(-8).map(line => line.length > 300 ? line.slice(0, 299) + '…' : line).join('\n');
  return { text: preview, truncated: lines.length > 8 || lines.some(line => line.length > 300) || clean !== output.trim(), lines: lines.length };
}
