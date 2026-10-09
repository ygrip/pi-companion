import type { Automation, AutomationDraft } from './types.ts';

export function automationDraft(automation?: Automation): AutomationDraft {
  return automation ? { name: automation.name, enabled: automation.enabled, schedule: automation.schedule, preconditions: automation.preconditions, actions: automation.actions, postActions: automation.postActions } : {
    name: 'New automation', enabled: true, schedule: null, preconditions: [],
    actions: [{ type: 'command', command: 'echo', args: ['Hello from Pi Companion'] }], postActions: []
  };
}

export function automationTime(value: number | null): string {
  if (value === null) return 'In progress';
  return new Date(value < 1e12 ? value * 1000 : value).toLocaleString();
}

export function parseAutomationDraft(text: string): AutomationDraft {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The script must be a JSON object.');
  const draft = value as AutomationDraft;
  if (typeof draft.name !== 'string' || !draft.name.trim()) throw new Error('Provide a name.');
  if (typeof draft.enabled !== 'boolean') throw new Error('enabled must be true or false.');
  if (draft.schedule !== null && typeof draft.schedule !== 'string') throw new Error('schedule must be a five-field UTC cron expression or null.');
  for (const key of ['preconditions', 'actions', 'postActions'] as const) {
    if (!Array.isArray(draft[key])) throw new Error(`${key} must be an array.`);
  }
  if (!draft.actions.length) throw new Error('Provide at least one action.');
  return draft;
}
