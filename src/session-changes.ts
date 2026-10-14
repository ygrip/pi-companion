import { resolve } from 'node:path';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** File-operation records establish touched files, not ownership of every hunk in a shared file. */
export function sessionChangedPaths(entries: readonly unknown[], cwd: string): string[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const paths = new Set<string>();
  const add = (path: unknown) => {
    if (typeof path === 'string' && path.trim() && !path.includes('\0')) paths.add(resolve(cwd, path));
  };
  for (const raw of entries) {
    const entry = object(raw);
    if (entry.type !== 'message') continue;
    const message = object(entry.message);
    if (message.customType === 'pi-jar.subagent') {
      const events = object(message.details).events;
      if (Array.isArray(events)) for (const rawEvent of events) {
        const event = object(rawEvent);
        const applied = object(event.report).applied;
        if (event.action === 'stop' && Array.isArray(applied)) for (const path of applied) add(path);
      }
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const rawPart of message.content) {
        const part = object(rawPart);
        if (part.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string') {
          calls.set(part.id, { name: part.name, args: object(part.arguments) });
        }
      }
    }
    if (message.role !== 'toolResult' || typeof message.toolCallId !== 'string') continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    const { args } = call;
    if (/(?:^|[._])jar_subagent$/.test(call.name) && args.action === 'stop') {
      const applied = object(message.details).applied;
      if (Array.isArray(applied)) for (const path of applied) add(path);
      continue;
    }
    if (message.isError === true) continue;
    if (/(?:^|[._])multi_file_edit$/.test(call.name) && Array.isArray(args.edits)) {
      for (const rawEdit of args.edits) add(object(rawEdit).path ?? args.path);
    } else if (/(?:^|[._])(?:write|edit)$/.test(call.name)) {
      add(args.path ?? args.file_path ?? args.filePath);
    } else if (/(?:^|[._])apply_patch$/.test(call.name)) {
      const patch = args.patch ?? args.input;
      if (typeof patch === 'string') {
        for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)) add(match[1].replace(/\r$/, ''));
      }
    }
  }
  return [...paths];
}
