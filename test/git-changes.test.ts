import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readGitChanges } from '../src/git-changes.ts';
import { splitChangedFiles } from '../ui/src/lib/diff.ts';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => exec('git', ['-c', 'user.name=Companion Test', '-c', 'user.email=companion@example.invalid', ...args], { cwd });

async function repository(run: (repo: string, directory: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'companion-changes-')));
  const repo = join(directory, 'repo');
  await mkdir(repo);
  try {
    await git(repo, 'init', '-q');
    await writeFile(join(repo, 'tracked.txt'), 'original\n');
    await writeFile(join(repo, '.gitignore'), 'ignored/\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'initial');
    await run(repo, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('unstaged includes new text and empty files while staged stays separate', () => repository(async repo => {
  await writeFile(join(repo, 'tracked.txt'), 'modified\n');
  await writeFile(join(repo, 'new name.txt'), 'new content\n');
  await writeFile(join(repo, 'empty.txt'), '');
  await mkdir(join(repo, 'ignored'));
  await writeFile(join(repo, 'ignored', 'secret.txt'), 'must stay ignored');
  const unstaged = await readGitChanges(repo, false);
  const files = splitChangedFiles(unstaged.diff);
  assert.equal(unstaged.worktree, repo);
  assert.equal(unstaged.worktrees[0].changedFiles, 3);
  assert.equal(files.length, 3);
  assert.equal(files.find(file => file.path === 'new name.txt')?.isNew, true);
  assert.equal(files.find(file => file.path === 'new name.txt')?.additions, 1);
  assert.equal(files.find(file => file.path === 'empty.txt')?.isNew, true);
  assert.ok(!unstaged.diff.includes('secret.txt'));
  assert.equal((await readGitChanges(repo, true)).diff, '');
  await git(repo, 'add', 'new name.txt');
  const staged = await readGitChanges(repo, true);
  assert.equal(splitChangedFiles(staged.diff).length, 1);
  assert.equal(splitChangedFiles(staged.diff)[0].path, 'new name.txt');
  assert.equal(staged.worktrees[0].stagedFiles, 1);
}));

test('registered worktrees have independent file counts and cannot select another repository', () => repository(async (repo, directory) => {
  const worker = join(directory, 'worker');
  await git(repo, 'worktree', 'add', '-q', '-b', 'worker', worker, 'HEAD');
  await writeFile(join(worker, 'tracked.txt'), 'worker changes\n');
  await writeFile(join(worker, 'new.txt'), 'worker new\n');
  const main = await readGitChanges(repo, false);
  assert.equal(main.diff, '');
  assert.equal(main.worktrees.find(tree => tree.path === worker)?.changedFiles, 2);
  const selected = await readGitChanges(repo, false, worker);
  assert.equal(selected.worktree, worker);
  assert.equal(selected.branch, 'worker');
  assert.equal(splitChangedFiles(selected.diff).length, 2);
  assert.ok(selected.diff.includes('worker changes'));
  const fromWorker = await readGitChanges(worker, false);
  assert.equal(fromWorker.worktree, worker, 'default is the session checkout, not the primary worktree');
  const unrelated = join(directory, 'other');
  await mkdir(unrelated);
  await git(unrelated, 'init', '-q');
  await assert.rejects(readGitChanges(repo, false, unrelated), /not a registered worktree/);
}));

test('untracked binaries, symlinks, oversized and generated files remain visible without unsafe previews', () => repository(async (repo, directory) => {
  await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 1, 2]));
  await writeFile(join(repo, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
  await mkdir(join(repo, 'node_modules'));
  await writeFile(join(repo, 'node_modules', 'package.js'), 'generated payload must not render');
  const secret = join(directory, 'outside.txt');
  await writeFile(secret, 'external secret must not render');
  await symlink(secret, join(repo, 'link.txt'));
  const result = await readGitChanges(repo, false);
  const files = splitChangedFiles(result.diff);
  assert.equal(files.length, 4);
  assert.equal(files.find(file => file.path === 'binary.bin')?.binary, true);
  assert.equal(files.find(file => file.path === 'link.txt')?.isNew, true);
  assert.match(result.diff, /Preview omitted for a symlink/);
  assert.match(result.diff, /exceeds 256 KiB/);
  assert.match(result.diff, /generated files/);
  assert.ok(!result.diff.includes('external secret must not render'));
  assert.ok(!result.diff.includes('generated payload must not render'));
}));

test('status rename records count one file and quoted new paths retain their labels', () => repository(async repo => {
  await git(repo, 'mv', 'tracked.txt', 'renamed.txt');
  await writeFile(join(repo, 'tab\tname.txt'), 'one\ntwo');
  const result = await readGitChanges(repo, false);
  assert.equal(result.worktrees[0].changedFiles, 2);
  assert.equal(result.worktrees[0].stagedFiles, 1);
  assert.equal(splitChangedFiles(result.diff)[0].path, 'tab\tname.txt');
  assert.match(result.diff, /No newline at end of file/);
}));

test('new-file preview batches are bounded and disclose omitted files', () => repository(async repo => {
  await Promise.all(Array.from({ length: 202 }, (_, i) => writeFile(join(repo, `${i}.txt`), 'new\n')));
  const result = await readGitChanges(repo, false);
  assert.equal(result.worktrees[0].changedFiles, 202);
  assert.equal(splitChangedFiles(result.diff).length, 200);
  const allFiles = splitChangedFiles(result.diff, result.files);
  assert.equal(allFiles.length, 202, 'preview limits must not hide changed files');
  assert.equal(allFiles.filter(file => file.lines[0].startsWith('Preview unavailable')).length, 2);
  assert.ok(allFiles.every(file => file.isNew));
  assert.match(result.warnings.join(' '), /first 200 of 202/);
}));

test('oversized tracked patches preserve the complete file inventory', () => repository(async repo => {
  await writeFile(join(repo, 'tracked.txt'), 'x'.repeat(4 * 1024 * 1024 + 1));
  const result = await readGitChanges(repo, false);
  assert.equal(result.diff, '');
  assert.deepEqual(result.files, [{ path: 'tracked.txt', untracked: false }]);
  assert.match(result.warnings.join(' '), /exceeds 4 MiB/);
  const files = splitChangedFiles(result.diff, result.files);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'tracked.txt');
  assert.equal(files[0].previewUnavailable, true);
}));

test('file inventory stays scoped to selected worktree and staging area', () => repository(async repo => {
  await writeFile(join(repo, 'staged.txt'), 'staged\n');
  await git(repo, 'add', 'staged.txt');
  await writeFile(join(repo, 'new.txt'), 'untracked\n');
  await writeFile(join(repo, 'tracked.txt'), 'modified\n');
  assert.deepEqual((await readGitChanges(repo, true)).files, [{ path: 'staged.txt', untracked: false }]);
  assert.deepEqual((await readGitChanges(repo, false)).files.map(file => file.path).sort(), ['new.txt', 'tracked.txt']);
  await git(repo, 'config', 'diff.noprefix', 'true');
  await git(repo, 'config', 'diff.mnemonicPrefix', 'true');
  const result = await readGitChanges(repo, false);
  assert.equal(splitChangedFiles(result.diff, result.files).filter(file => file.path === 'tracked.txt').length, 1);
  assert.match(result.diff, /diff --git a\/tracked.txt b\/tracked.txt/);
}));

test('session scope excludes unrelated dirt from inventories, patches, previews and counts', () => repository(async repo => {
  await mkdir(join(repo, 'subdir'));
  await writeFile(join(repo, 'tracked.txt'), 'unrelated baseline dirt\n');
  await writeFile(join(repo, 'subdir', 'session.txt'), 'session change\n');
  await writeFile(join(repo, 'unrelated.txt'), 'unrelated new file\n');
  const result = await readGitChanges(join(repo, 'subdir'), false, undefined, [join(repo, 'subdir', 'session.txt')]);
  assert.equal(result.scope, 'session');
  assert.deepEqual(result.files, [{ path: 'subdir/session.txt', untracked: true }]);
  assert.equal(result.worktrees[0].changedFiles, 1);
  assert.equal(result.worktrees[0].unstagedFiles, 1);
  assert.equal(splitChangedFiles(result.diff)[0].path, 'subdir/session.txt');
  assert.ok(!result.diff.includes('unrelated'));
  assert.match(result.warnings.join(' '), /Shell-only edits/);
  const empty = await readGitChanges(repo, false, undefined, []);
  assert.equal(empty.diff, '');
  assert.deepEqual(empty.files, []);
  assert.equal(empty.worktrees[0].changedFiles, 0);
}));

test('session scope uses literal filenames and handles renamed or deleted paths', () => repository(async repo => {
  const literal = ':(glob)*.txt';
  await writeFile(join(repo, literal), 'literal original\n');
  await git(repo, 'add', '--', ':(literal)' + literal);
  await git(repo, 'commit', '-qm', 'literal fixture');
  await writeFile(join(repo, literal), 'literal edited\n');
  await writeFile(join(repo, 'tracked.txt'), 'unrelated edited\n');
  const selected = await readGitChanges(repo, false, undefined, [join(repo, literal)]);
  assert.deepEqual(selected.files, [{ path: literal, untracked: false }]);
  assert.ok(selected.diff.includes('literal edited'));
  assert.ok(!selected.diff.includes('unrelated edited'));
  await git(repo, 'restore', 'tracked.txt');
  await git(repo, 'mv', 'tracked.txt', 'renamed.txt');
  const renamed = await readGitChanges(repo, true, undefined, [join(repo, 'tracked.txt')]);
  assert.deepEqual(renamed.files, [{ path: 'renamed.txt', untracked: false }]);
  assert.match(renamed.diff, /rename from tracked.txt/);
  assert.equal(renamed.worktrees[0].stagedFiles, 1);
  await git(repo, 'reset', '--hard', '-q', 'HEAD');
  await rm(join(repo, 'tracked.txt'));
  const deleted = await readGitChanges(repo, false, undefined, [join(repo, 'tracked.txt')]);
  assert.deepEqual(deleted.files, [{ path: 'tracked.txt', untracked: false }]);
  assert.match(deleted.diff, /deleted file mode/);
}));

test('session scope does not map a main-checkout edit onto a different worktree', () => repository(async (repo, directory) => {
  const worker = join(directory, 'worker');
  await git(repo, 'worktree', 'add', '-q', '-b', 'worker', worker, 'HEAD');
  await writeFile(join(repo, 'tracked.txt'), 'main change\n');
  await writeFile(join(worker, 'tracked.txt'), 'worker change\n');
  const result = await readGitChanges(repo, false, worker, [join(repo, 'tracked.txt')]);
  assert.equal(result.diff, '');
  assert.deepEqual(result.files, []);
  assert.equal(result.worktrees.find(tree => tree.path === repo)?.changedFiles, 1);
  assert.equal(result.worktrees.find(tree => tree.path === worker)?.changedFiles, 0);
  const workerResult = await readGitChanges(repo, false, worker, [join(worker, 'tracked.txt')]);
  assert.match(workerResult.diff, /worker change/);
}));

test('Changes refreshes on open, labels workspace and distinguishes new files', () => {
  const page = readFileSync(new URL('../ui/src/routes/sessions/[id]/+page.svelte', import.meta.url), 'utf8');
  const store = readFileSync(new URL('../ui/src/lib/companion.svelte.ts', import.meta.url), 'utf8');
  assert.match(page, /if \(next === 'changes'\) loadDiff\(\)/);
  assert.match(page, /<label for="changes-worktree">Worktree<\/label>/);
  assert.match(page, /<details class="review-options">/);
  assert.match(page, /diff\?\.scope === 'session'/);
  assert.match(page, /class:reviewing=\{tab === 'changes'\}/);
  assert.match(store, /scope: inner\.scope === 'session'/);
  assert.match(page, /file\.isNew[^]*?class="chip new-file">New/);
  assert.match(store, /inner\.requestId !== expected/);
  assert.match(page, /aria-label="Changed file navigation"/);
  assert.match(page, /aria-label="Next changed file"/);
  assert.match(page, /selectedDiffFile \? \[selectedDiffFile\] : \[\]/);
  assert.match(page, /splitChangedFiles\(diff\?\.text \?\? '', diff\?\.files\)/);
});
