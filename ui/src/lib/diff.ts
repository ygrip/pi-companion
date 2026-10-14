export type ChangedFile = {
  id: string;
  path: string;
  oldPath: string;
  newPath: string;
  lines: string[];
  additions: number;
  deletions: number;
  binary: boolean;
  isNew: boolean;
  previewUnavailable?: boolean;
};

/** Decode Git's quoted paths (including octal UTF-8 bytes) without evaluating strings. */
export function decodeGitPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const input = trimmed.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== '\\') {
      const point = input.codePointAt(i)!;
      bytes.push(...new TextEncoder().encode(String.fromCodePoint(point)));
      if (point > 0xffff) i++;
      continue;
    }
    const octal = input.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) { bytes.push(parseInt(octal, 8)); i += octal.length; continue; }
    const next = input[++i] ?? '\\';
    const escape: Record<string, string> = { t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v', a: '\u0007' };
    bytes.push(...new TextEncoder().encode(escape[next] ?? next));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function withoutPrefix(path: string): string {
  return path === '/dev/null' ? '' : path.replace(/^[ab]\//, '');
}

function headerPaths(line: string): [string, string] {
  const body = line.slice('diff --git '.length);
  if (body.startsWith('"')) {
    const tokens = body.match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
    return [withoutPrefix(decodeGitPath(tokens[0] ?? '')), withoutPrefix(decodeGitPath(tokens[1] ?? ''))];
  }
  const split = body.lastIndexOf(' b/');
  if (split >= 0) return [withoutPrefix(body.slice(0, split)), withoutPrefix(decodeGitPath(body.slice(split + 1)))];
  const tokens = body.split(' ');
  return [withoutPrefix(decodeGitPath(tokens[0] ?? '')), withoutPrefix(decodeGitPath(tokens[1] ?? ''))];
}

export function splitChangedFiles(text: string, inventory?: { path: string; untracked: boolean }[]): ChangedFile[] {
  if (!text.trim() && !inventory?.length) return [];
  const groups: string[][] = [];
  for (const line of text.split('\n')) {
    if (/^diff --(?:git|cc|combined) /.test(line) || !groups.length) groups.push([]);
    groups.at(-1)!.push(line);
  }
  const parsed = groups.filter((lines) => lines.some((line) => line.trim())).map((lines, index) => {
    const combinedPath = lines[0].match(/^diff --(?:cc|combined) (.+)$/)?.[1];
    let [oldPath, newPath] = lines[0].startsWith('diff --git ') ? headerPaths(lines[0]) : combinedPath ? [decodeGitPath(combinedPath), decodeGitPath(combinedPath)] : ['', ''];
    let additions = 0, deletions = 0, inHunk = false, prefixColumns = 1;
    for (const line of lines) {
      const hunk = line.match(/^(@{2,}) /);
      if (hunk) { inHunk = true; prefixColumns = hunk[1].length - 1; continue; }
      if (inHunk) {
        const prefix = line.slice(0, prefixColumns);
        if (prefix.includes('+')) additions++;
        if (prefix.includes('-')) deletions++;
        continue;
      }
      if (line.startsWith('--- ')) oldPath = withoutPrefix(decodeGitPath(line.slice(4).split('\t')[0]));
      else if (line.startsWith('+++ ')) newPath = withoutPrefix(decodeGitPath(line.slice(4).split('\t')[0]));
      else if (line.startsWith('rename from ')) oldPath = decodeGitPath(line.slice(12));
      else if (line.startsWith('rename to ')) newPath = decodeGitPath(line.slice(10));
      else if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
    const path = newPath || oldPath || 'Changes';
    return { id: `${index}:${path}`, path, oldPath, newPath, lines, additions, deletions, binary: lines.some((line) => line.startsWith('Binary files ') || line === 'GIT binary patch'), isNew: lines.some(line => line.startsWith('new file mode ')), previewUnavailable: lines.some(line => line.startsWith('Preview omitted')) };
  });
  const inventoryPaths = inventory && new Set(inventory.map(entry => entry.path));
  const files: ChangedFile[] = inventoryPaths ? parsed.filter(file => inventoryPaths.has(file.path)) : parsed;
  const paths = new Set(files.map(file => file.path));
  for (const entry of inventory ?? []) {
    if (paths.has(entry.path)) continue;
    files.push({ id: `inventory:${entry.path}`, path: entry.path, oldPath: entry.untracked ? '' : entry.path,
      newPath: entry.path, lines: ['Preview unavailable for this file. It is still included in the changed-file list.'],
      additions: 0, deletions: 0, binary: false, isNew: entry.untracked, previewUnavailable: true });
  }
  return files;
}

export function diffLineClass(line: string) {
  if (/^diff --(?:git|cc|combined) /.test(line)) return 'file-header';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'del';
  return '';
}

export function filterChangedFiles(files: ChangedFile[], query: string): ChangedFile[] {
  const needle = query.trim().toLowerCase();
  return needle ? files.filter((file) => `${file.path}\n${file.oldPath}\n${file.newPath}`.toLowerCase().includes(needle)) : files;
}
