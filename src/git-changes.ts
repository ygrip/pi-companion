import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { GitChanges, GitWorktree } from './protocol.js';

const exec = promisify(execFile);
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_NEW_FILE = 256 * 1024;
const MAX_NEW_PREVIEWS = 200;
const MAX_WORKTREES = 64;
const GENERATED = /(?:^|\/)(?:node_modules|\.git|\.svelte-kit|\.next|target|dist|build)(?:\/|$)/;
const git = async (cwd: string, args: string[]) => (await exec('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, maxBuffer: MAX_OUTPUT, timeout: 15_000 })).stdout;

export function gitChangesError(error: unknown): string {
  const failure = error && typeof error === 'object' ? error as { code?: unknown; stderr?: unknown } : {};
  const stderr = String(failure.stderr ?? '');
  if (/not a git repository/i.test(stderr)) return 'This project is not tracked by git.';
  if (failure.code === 'ENOENT') return 'Git or the selected worktree is unavailable on this computer.';
  return 'Changes unavailable: ' + (stderr.trim().split('\n')[0] || (error instanceof Error ? error.message : String(error)));
}

function statusEntries(output: string): { path: string; staged: boolean; unstaged: boolean; untracked: boolean }[] {
  const fields = output.split('\0');
  const entries: ReturnType<typeof statusEntries> = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    entries.push({ path: field.slice(3), staged: code !== '??' && code[0] !== ' ', unstaged: code !== '??' && code[1] !== ' ', untracked: code === '??' });
    if (/[RC]/.test(code)) index++;
  }
  return entries;
}

function within(root: string, path: string) {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}

async function newFilePatch(root: string, path: string): Promise<string> {
  const quotePath = (value: string) => '"' + value.replace(/["\\\x00-\x1f\x7f]/g, char => char === '"' || char === '\\' ? '\\' + char : '\\' + char.charCodeAt(0).toString(8).padStart(3, '0')) + '"';
  const a = quotePath('a/' + path), b = quotePath('b/' + path);
  const header = `diff --git ${a} ${b}\nnew file mode 100644\n--- /dev/null\n+++ ${b}\n`;
  if (GENERATED.test(path)) return header + 'Preview omitted for generated files.\n';
  const absolute = resolve(root, path);
  if (!within(root, absolute)) throw new Error('Untracked file is outside the selected worktree.');
  // Never follow a symlink to a file or directory outside the selected checkout.
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) return header + 'Preview omitted for a symlink or non-regular file.\n';
  const canonical = await realpath(absolute);
  if (!within(root, canonical)) return header + 'Preview omitted for a file outside the selected worktree.\n';
  if (stat.size > MAX_NEW_FILE) return header + 'Preview omitted: new file exceeds 256 KiB.\n';
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile()) return header + 'Preview omitted: file changed while loading.\n';
    // A bounded read also protects against files growing after the initial stat.
    const bytes = Buffer.alloc(MAX_NEW_FILE + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_NEW_FILE) return header + 'Preview omitted: new file exceeds 256 KiB.\n';
    const content = bytes.subarray(0, bytesRead);
    const binary = `diff --git ${a} ${b}\nnew file mode 100644\nBinary files /dev/null and ${b} differ\n`;
    if (content.includes(0)) return binary;
    if (!content.length) return header;
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch { return binary; }
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    return header + `@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line).join('\n') + '\n' + (text.endsWith('\n') ? '' : '\\ No newline at end of file\n');
  } finally {
    await handle.close();
  }
}

/** Only Git-registered worktrees of the session repository may be selected. */
export async function readGitChanges(cwd: string, staged: boolean, requestedWorktree?: string): Promise<GitChanges> {
  const sessionRoot = await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  const commonDir = await realpath(resolve(sessionRoot, (await git(sessionRoot, ['rev-parse', '--git-common-dir'])).trim()));
  const listing = await git(sessionRoot, ['worktree', 'list', '--porcelain', '-z']);
  const records: { path: string; branch: string }[] = [];
  for (const block of listing.split('\0\0')) {
    const fields = block.split('\0');
    const path = fields.find(field => field.startsWith('worktree '))?.slice(9);
    if (path) records.push({ path, branch: fields.find(field => field.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? 'Detached HEAD' });
  }
  if (records.length > MAX_WORKTREES) throw new Error('This repository has more than 64 worktrees; narrow the workspace before loading Changes.');
  const selected = requestedWorktree ? await realpath(requestedWorktree) : sessionRoot;
  let selectedEntries: ReturnType<typeof statusEntries> | undefined;
  let selectedTree: GitWorktree | undefined;
  const worktrees: GitWorktree[] = [];
  for (const record of records) {
    let path = record.path;
    try {
      path = await realpath(path);
      const treeCommonDir = await realpath(resolve(path, (await git(path, ['rev-parse', '--git-common-dir'])).trim()));
      if (treeCommonDir !== commonDir) throw new Error('The worktree no longer belongs to this session repository.');
      const entries = statusEntries(await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
      const tree: GitWorktree = { path, branch: record.branch, changedFiles: entries.length, stagedFiles: entries.filter(item => item.staged).length, unstagedFiles: entries.filter(item => item.unstaged || item.untracked).length };
      worktrees.push(tree);
      if (path === selected) { selectedTree = tree; selectedEntries = entries; }
    } catch (error) {
      worktrees.push({ path, branch: record.branch, changedFiles: null, stagedFiles: null, unstagedFiles: null, error: gitChangesError(error) });
      if (path === selected) throw error;
    }
  }
  if (!selectedTree || !selectedEntries) throw new Error('The selected directory is not a registered worktree of this session repository.');
  const warnings: string[] = [];
  let diff = '';
  try {
    diff = await git(selected, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', ...(staged ? ['--cached'] : [])]);
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
    warnings.push('Patch output exceeds 4 MiB. The changed-file list is still complete; previews are unavailable for tracked files.');
  }
  let outputBytes = Buffer.byteLength(diff);
  if (!staged) {
    const untracked = selectedEntries.filter(item => item.untracked);
    for (const entry of untracked.slice(0, MAX_NEW_PREVIEWS)) {
      let patch: string;
      try { patch = await newFilePatch(selected, entry.path); }
      catch (error) { warnings.push(`${entry.path}: ${gitChangesError(error)}`); continue; }
      const patchBytes = Buffer.byteLength(patch);
      if (outputBytes + patchBytes > MAX_OUTPUT) { warnings.push('New-file previews limited to 4 MiB.'); break; }
      diff += patch;
      outputBytes += patchBytes;
    }
    if (untracked.length > MAX_NEW_PREVIEWS) warnings.push(`Showing previews for the first ${MAX_NEW_PREVIEWS} of ${untracked.length} new files.`);
  }
  const files = selectedEntries.filter(item => staged ? item.staged : item.unstaged || item.untracked)
    .map(({ path, untracked }) => ({ path, untracked }));
  return { diff, files, worktree: selected, branch: selectedTree.branch, worktrees, warnings };
}
