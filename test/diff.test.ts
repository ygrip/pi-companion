import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitDiff, diffLineClass } from '../ui/src/lib/diff.ts';

test('splits patches by file and excludes headers from line counts', () => {
  const patch = 'diff --git a/one.ts b/one.ts\n--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/two.png b/two.png\nBinary files a/two.png and b/two.png differ';
  const files = splitDiff(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'one.ts');
  assert.equal(files[0].add, 1);
  assert.equal(files[0].del, 1);
  assert.equal(files[0].lines.join('\n') + '\n' + files[1].lines.join('\n'), patch);
  assert.equal(files[1].path, 'two.png');
  assert.equal(files[1].add, 0);
});

test('preserves renames, deleted files, quoted names and preambles', () => {
  const patch = 'preamble\ndiff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\ndiff --git a/gone b/gone\ndeleted file mode 100644\n--- a/gone\n+++ /dev/null\n-removed\ndiff --git "a/a\\tfile" "b/a\\tfile"\n+added';
  const files = splitDiff(patch);
  assert.equal(files.length, 4);
  assert.equal(files[1].path, 'new');
  assert.equal(files[2].path, 'gone');
  assert.equal(files[3].path, '"b/a\\tfile"');
  assert.equal(files.flatMap((file) => file.lines).join('\n'), patch);
});

test('unquoted paths containing spaces use the full destination name', () => {
  const files = splitDiff('diff --git a/folder/old name.ts b/folder/new name.ts\nrename from folder/old name.ts\nrename to folder/new name.ts');
  assert.equal(files[0].path, 'folder/new name.ts');
});

test('empty changes have no files and diff classes do not collide with upload cards', () => {
  assert.deepEqual(splitDiff(''), []);
  assert.deepEqual(splitDiff('\n\n'), []);
  assert.equal(diffLineClass('diff --git a/x b/x'), 'file-header');
  assert.equal(diffLineClass('+++ b/x'), '');
  assert.equal(diffLineClass('--- a/x'), '');
  assert.equal(diffLineClass('+added'), 'add');
  assert.equal(diffLineClass('-removed'), 'del');
  assert.equal(diffLineClass('@@ -1 +1 @@'), 'hunk');
});
