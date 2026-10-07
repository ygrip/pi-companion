/** Split a unified Git patch without dropping metadata, binary changes, or a preamble. */
export function splitDiff(text: string) {
  const files: { header: string; path: string; lines: string[]; add: number; del: number }[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // Git does not necessarily quote paths containing spaces.
      const path = line.match(/^diff --git a\/.* b\/(.+)$/)?.[1]
        ?? line.match(/^diff --git (?:"(?:[^"\\]|\\.)*"|\S+) (.+)$/)?.[1]?.replace(/^b\//, '')
        ?? line;
      files.push({ header: line, path, lines: [line], add: 0, del: 0 });
      continue;
    }
    if (!files.length) {
      if (!line.trim()) continue;
      files.push({ header: 'Changes', path: 'Changes', lines: [], add: 0, del: 0 });
    }
    const file = files[files.length - 1];
    file.lines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) file.add++;
    if (line.startsWith('-') && !line.startsWith('---')) file.del++;
  }
  return files;
}

export function diffLineClass(line: string) {
  if (line.startsWith('diff --git ')) return 'file-header';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'del';
  return '';
}
