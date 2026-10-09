import type { Automation, AutomationDraft, AutomationRun } from './types.ts';

export function automationDraft(automation?: Automation): AutomationDraft {
  return automation ? { name: automation.name, enabled: automation.enabled, schedule: automation.schedule, preconditions: automation.preconditions, actions: automation.actions, postActions: automation.postActions, ...(automation.historyLimit !== undefined ? { historyLimit: automation.historyLimit } : {}), ...(automation.maxRetries !== undefined ? { maxRetries: automation.maxRetries } : {}), ...(automation.retryIntervalSeconds !== undefined ? { retryIntervalSeconds: automation.retryIntervalSeconds } : {}) } : {
    name: 'New automation', enabled: true, schedule: null, preconditions: [],
    actions: [{ type: 'command', command: 'echo', args: ['Hello from Pi Companion'] }], postActions: []
  };
}

export function automationTime(value: number | null): string {
  if (value === null) return 'In progress';
  return new Date(value < 1e12 ? value * 1000 : value).toLocaleString();
}

export const runLabels: Record<AutomationRun['status'], string> = {
  running: 'Running', succeeded: 'Succeeded', failed: 'Failed', stopped: 'Stopped', skipped: 'Skipped'
};

export function automationDuration(start: number, end: number | null): string {
  if (end === null) return 'In progress';
  const seconds = Math.max(0, Math.round((end - start) / (start < 1e12 ? 1 : 1000)));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

/** Deliberately conservative: custom expressions remain explicit rather than misdescribed. */
export function automationSchedule(schedule: string | null): string {
  if (!schedule) return 'On demand';
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return 'Custom schedule · UTC';
  const [minute, hour, day, month, weekday] = parts;
  const times = /^\d+$/.test(minute) && /^\d+(,\d+)*$/.test(hour)
    && Number(minute) < 60 && hour.split(',').every(h => Number(h) < 24)
    ? hour.split(',').map(h => `${h.padStart(2, '0')}:${minute.padStart(2, '0')}`).join(', ') : null;
  if (times && day === '*' && month === '*') {
    const days = weekday === '1-5' ? 'Weekdays' : weekday === '*' ? 'Every day' : null;
    if (days) return `${days} at ${times} UTC`;
  }
  if (schedule === '*/30 * * * *') return 'Every 30 minutes · UTC';
  if (schedule === '0 * * * *') return 'Every hour · UTC';
  return 'Custom schedule · UTC';
}

export function pageItems<T>(items: T[], page: number, size = 10): { items: T[]; page: number; pages: number; total: number } {
  const limit = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 10;
  const pages = Math.max(1, Math.ceil(items.length / limit));
  const current = Math.min(pages, Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1));
  return { items: items.slice((current - 1) * limit, current * limit), page: current, pages, total: items.length };
}

export function validateCron(value: string): void {
  const fields = value.trim().split(/\s+/);
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  if (fields.length !== 5 || value.length > 256) throw new Error('Schedule needs five UTC cron fields.');
  fields.forEach((field, index) => {
    const [min, max] = bounds[index];
    for (const part of field.split(',')) {
      if (!/^(\*|\d+|\d+-\d+)(\/\d+)?$/.test(part)) throw new Error('Cron accepts numbers, *, ranges, lists, and steps.');
      const [range, increment] = part.split('/');
      const step = increment === undefined ? 1 : Number(increment);
      if (step < 1 || step > max - min + 1) throw new Error('Cron step is out of range.');
      const [start, end] = range === '*' ? [min, max] : range.includes('-') ? range.split('-').map(Number) : [Number(range), increment ? max : Number(range)];
      if (start < min || end > max || start > end) throw new Error('Cron field is out of range.');
    }
  });
}

export function minimumTriggerGap(expression: string): number {
  validateCron(expression);
  function values(field: string, min: number, max: number): number[] {
    const result = new Set<number>();
    for (const part of field.split(',')) {
      const [range, increment] = part.split('/');
      const step = Number(increment ?? 1);
      const [start, end] = range === '*' ? [min, max] : range.includes('-') ? range.split('-').map(Number) : [Number(range), increment ? max : Number(range)];
      for (let n = start; n <= end; n += step) result.add(n);
    }
    return [...result].sort((a, b) => a - b);
  }
  const fields = expression.trim().split(/\s+/);
  const slots = values(fields[1], 0, 23).flatMap(h => values(fields[0], 0, 59).map(m => h * 60 + m));
  let gap = slots[0] + 1440 - slots.at(-1)!;
  for (let i = 1; i < slots.length; i++) gap = Math.min(gap, slots[i] - slots[i - 1]);
  return gap * 60;
}

export function validateAutomationStep(value: unknown, label = 'Step'): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: provide a JSON object.`);
  const step = value as Record<string, unknown>;
  if (!['command', 'pi'].includes(String(step.type))) throw new Error(`${label}: type must be command or pi.`);
  const allowed = step.type === 'command' ? ['type', 'command', 'args', 'cwd', 'timeoutSeconds'] : ['type', 'prompt', 'cwd', 'timeoutSeconds'];
  if (Object.keys(step).some(key => !allowed.includes(key))) throw new Error(`${label}: unknown field.`);
  const text = step.type === 'command' ? step.command : step.prompt;
  if (typeof text !== 'string' || !text.trim() || text.length > 65536 || text.includes('\0')) throw new Error(`${label}: provide a valid ${step.type === 'command' ? 'executable' : 'prompt'}.`);
  if (step.type === 'command' && (!Array.isArray(step.args) || step.args.length > 100 || step.args.some(arg => typeof arg !== 'string' || arg.length > 16384 || arg.includes('\0')))) throw new Error(`${label}: args must be an array of at most 100 valid strings.`);
  if (step.type === 'pi' && typeof step.cwd !== 'string') throw new Error(`${label}: Pi requires an absolute workdir.`);
  if (step.cwd !== undefined && (typeof step.cwd !== 'string' || !/^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(step.cwd) || step.cwd.includes('\0'))) throw new Error(`${label}: working directory must be absolute.`);
  if (step.timeoutSeconds !== undefined && (typeof step.timeoutSeconds !== 'number' || !Number.isInteger(step.timeoutSeconds) || step.timeoutSeconds < 1 || step.timeoutSeconds > 86400)) throw new Error(`${label}: timeout must be 1–86400 seconds.`);
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
  if (draft.name.length > 120) throw new Error('Name must contain 1–120 characters.');
  const allowed = ['name', 'enabled', 'schedule', 'preconditions', 'actions', 'postActions', 'maxRetries', 'retryIntervalSeconds', 'historyLimit'];
  if (Object.keys(draft).some(key => !allowed.includes(key))) throw new Error('Unknown definition field.');
  if (draft.schedule !== null) validateCron(draft.schedule);
  for (const key of ['preconditions', 'actions', 'postActions'] as const) {
    draft[key].forEach((step, index) => validateAutomationStep(step, `${key} step ${index + 1}`));
  }
  if (!draft.actions.length || draft.preconditions.length + draft.actions.length + draft.postActions.length > 50) throw new Error('Provide 1–50 steps, including at least one action.');
  if (draft.maxRetries !== undefined && (!Number.isInteger(draft.maxRetries) || draft.maxRetries < 0 || draft.maxRetries > 5)) throw new Error('Max retries must be an integer from 0 to 5.');
  if (draft.retryIntervalSeconds !== undefined && (!Number.isInteger(draft.retryIntervalSeconds) || draft.retryIntervalSeconds < 1 || draft.retryIntervalSeconds > 86400)) throw new Error('Retry interval must be 1–86400 seconds.');
  if (draft.historyLimit !== undefined && (!Number.isInteger(draft.historyLimit) || draft.historyLimit < 1 || draft.historyLimit > 1000)) throw new Error('History limit must be 1–1000 runs.');
  if (draft.schedule && draft.maxRetries && draft.maxRetries * (draft.retryIntervalSeconds ?? 10) >= minimumTriggerGap(draft.schedule)) throw new Error('Total retry delay must be shorter than the shortest scheduled trigger gap.');
  return draft;
}
