export type SlashCommand = { name: string; description?: string; source: 'extension' | 'prompt' | 'skill' };

export function matchingSlashCommands(text: string, commands: SlashCommand[]): SlashCommand[] {
  if (!/^\/[^\s]*$/.test(text)) return [];
  const query = text.slice(1).toLowerCase();
  const unique = new Map<string, SlashCommand>();
  for (const command of commands) {
    if (!command || typeof command.name !== 'string' || !/^[a-zA-Z0-9:_-]+$/.test(command.name)) continue;
    if (command.name.toLowerCase().includes(query) || command.description?.toLowerCase().includes(query)) unique.set(command.name, command);
  }
  return [...unique.values()].sort((a, b) => Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)) || a.name.localeCompare(b.name));
}
