import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentMime, attachmentPrompt, canPreviewAttachment, validateAttachment } from '../ui/src/lib/attachments.ts';
import { decodeGitPath, filterChangedFiles, splitChangedFiles } from '../ui/src/lib/diff.ts';

const policy = { maxUploadMb: 1, allowedUploadTypes: ['image/*', 'application/pdf'] };
const png = { name: 'screen.png', type: 'image/png', size: 1024 };

test('attachments validate size, names, empty files and the daemon MIME policy', () => {
  assert.equal(validateAttachment(png, policy), null);
  assert.match(validateAttachment({ ...png, size: 0 }, policy)!, /empty/);
  assert.match(validateAttachment({ ...png, size: 1024 * 1024 + 1 }, policy)!, /too large/);
  assert.match(validateAttachment({ ...png, name: 'bad\nname.png' }, policy)!, /invalid name/);
  assert.match(validateAttachment({ name: 'script.js', type: 'application/javascript', size: 12 }, policy)!, /not allowed/);
  assert.equal(validateAttachment({ name: 'notes.txt', type: 'text/plain', size: 12 }, { maxUploadMb: 25, allowedUploadTypes: [] }), null);
  assert.equal(validateAttachment({ ...png, size: 1024 * 1024 }, policy), null);
});

test('unknown browser MIME falls back to extension and unsafe documents never get image previews', () => {
  assert.equal(attachmentMime({ ...png, type: '' }), 'image/png');
  assert.equal(attachmentMime({ ...png, type: 'application/octet-stream' }), 'image/png');
  assert.equal(validateAttachment({ ...png, type: 'application/octet-stream' }, policy), null);
  assert.equal(canPreviewAttachment(png), true);
  assert.equal(canPreviewAttachment({ ...png, name: 'image.svg', type: 'image/svg+xml' }), false);
  assert.equal(canPreviewAttachment({ ...png, name: 'image.svg', type: 'image/png' }), false);
  assert.equal(canPreviewAttachment({ ...png, name: 'page.html', type: 'image/png' }), false);
  assert.equal(canPreviewAttachment({ ...png, name: 'doc.pdf', type: 'application/pdf' }), false);
});

test('attachment prompt includes explicit uploaded path references and allows attachment-only messages', () => {
  assert.equal(attachmentPrompt('  hello  ', []), 'hello');
  const files = [{ name: 'screen "one".png', path: '/tmp/session/upload-id' }];
  assert.match(attachmentPrompt('Review this', files), /Review this/);
  assert.match(attachmentPrompt('', files), /Attached files already uploaded/);
  assert.ok(attachmentPrompt('', files).includes(JSON.stringify(files[0].name)));
  assert.ok(attachmentPrompt('', files).includes(JSON.stringify(files[0].path)));
});

const diff = `diff --git a/src/first.ts b/src/first.ts
--- a/src/first.ts
+++ b/src/first.ts
@@ -1 +1 @@
-old
+new
+more
diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
diff --git a/deleted.txt b/deleted.txt
--- a/deleted.txt
+++ /dev/null
@@ -1 +0,0 @@
-goodbye`;

test('changed files split into independently labeled sections with correct additions/deletions', () => {
  const files = splitChangedFiles(diff);
  assert.equal(files.length, 4);
  assert.equal(files[0].path, 'src/first.ts');
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].deletions, 1);
  assert.equal(files[1].oldPath, 'old name.txt');
  assert.equal(files[1].newPath, 'new name.txt');
  assert.equal(files[2].binary, true);
  assert.equal(files[3].path, 'deleted.txt');
  assert.equal(files[3].newPath, '');
});

test('changed-file filtering matches case-insensitive old and new names, not arbitrary patch content', () => {
  const files = splitChangedFiles(diff);
  assert.equal(filterChangedFiles(files, ' FIRST.TS ')[0].path, 'src/first.ts');
  assert.equal(filterChangedFiles(files, 'old name').length, 1);
  assert.equal(filterChangedFiles(files, 'new name').length, 1);
  assert.equal(filterChangedFiles(files, 'goodbye').length, 0);
  assert.equal(filterChangedFiles(files, '').length, 4);
  assert.deepEqual(splitChangedFiles(''), []);
});

test('Git quoted UTF-8 paths and combined conflict diffs retain file boundaries', () => {
  assert.equal(decodeGitPath('"caf\\303\\251.txt"'), 'café.txt');
  const quoted = splitChangedFiles('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n+ok');
  assert.equal(quoted[0].path, 'café.txt');
  const combined = splitChangedFiles('diff --cc src/conflict.ts\nindex 123,456..789\n@@@ -1,1 -1,1 +1,1 @@@\n++merged\ndiff --combined other.txt\nindex 123,456..789\n@@@ -1,1 -1,1 +1,1 @@@\n++second');
  assert.equal(combined.length, 2);
  assert.equal(combined[0].path, 'src/conflict.ts');
  assert.equal(combined[1].path, 'other.txt');
});
