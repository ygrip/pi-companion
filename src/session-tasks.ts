import type { SessionTask } from './protocol.js';
export type { SessionTask } from './protocol.js';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value);
const validTitle = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && Boolean(value.trim());
const validStatus = (value: unknown): value is SessionTask['status'] => ['pending', 'in_progress', 'completed'].includes(value as string);
const optionalText = (value: unknown, limit: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;

function grouped(items: Map<string, SessionTask>): SessionTask[] {
  const result: SessionTask[] = [];
  for (const task of items.values()) {
    if (task.parentId) continue;
    const children = [...items.values()].filter(child => child.parentId === task.id);
    if (children.length) task.status = children.every(child => child.status === 'completed') ? 'completed'
      : children.some(child => child.status !== 'pending') ? 'in_progress' : 'pending';
    result.push(task, ...children);
  }
  return result;
}

/** Invalid snapshots return undefined; a valid empty list deliberately clears the projection. */
export function normalizeTasks(value: unknown): SessionTask[] | undefined {
  const raw = record(value).items;
  if (!Array.isArray(raw) || raw.length > 50) return undefined;
  const items = new Map<string, SessionTask>();
  for (const entry of raw) {
    const item = record(entry);
    if (!validId(item.id) || !validTitle(item.title) || !validStatus(item.status) || items.has(item.id)) return undefined;
    if (item.parentId !== undefined && (!validId(item.parentId) || !items.has(item.parentId) || items.get(item.parentId)?.parentId)) return undefined;
    if ((item.activeForm !== undefined && typeof item.activeForm !== 'string') || (item.details !== undefined && typeof item.details !== 'string')) return undefined;
    const activeForm = optionalText(item.activeForm, 80), details = optionalText(item.details, 240);
    items.set(item.id, { id: item.id, title: item.title.trim(), status: item.status,
      ...(activeForm ? { activeForm } : {}), ...(details ? { details } : {}),
      ...(typeof item.parentId === 'string' ? { parentId: item.parentId } : {}) });
  }
  return grouped(items);
}

/** Replay only the supplied active branch; jar_todo tool results can contain truncated previews. */
export function sessionTasks(entries: readonly unknown[]): SessionTask[] {
  let items = new Map<string, SessionTask>();
  const setStatus = (item: SessionTask, status: SessionTask['status']) => {
    if (status === 'in_progress') {
      const parents = new Set([...items.values()].map(task => task.parentId));
      for (const other of items.values()) if (!parents.has(other.id) && other.status === 'in_progress') other.status = 'pending';
    }
    item.status = status;
  };
  for (const raw of entries) {
    const entry = record(raw);
    if (entry.type !== 'custom' || !['pi-jar.task', 'companion.tasks'].includes(entry.customType as string)) continue;
    const event = record(entry.data);
    const neutral = entry.customType === 'companion.tasks';
    if (!neutral && event.v !== 1) continue;
    if (neutral || event.op === 'write') {
      const next = normalizeTasks(event);
      if (!next) continue;
      const parents = new Set(next.map(task => task.parentId));
      if (!neutral && next.filter(task => !parents.has(task.id) && task.status === 'in_progress').length > 1) continue;
      if (!neutral) for (const task of next) {
        const details = items.get(task.id)?.details;
        const written = (event.items as unknown[]).find(raw => record(raw).id === task.id);
        if (record(written).details === undefined && details) task.details = details;
      }
      items = new Map(next.map(task => [task.id, task]));
      continue;
    }
    if (!validId(event.id)) continue;
    const item = items.get(event.id);
    switch (event.op) {
      case 'add': {
        const parent = typeof event.parentId === 'string' ? items.get(event.parentId) : undefined;
        if (items.size >= 50 || item || !validTitle(event.title) || (event.parentId !== undefined && (!validId(event.parentId) || !parent || parent.parentId))) break;
        const details = optionalText(event.details, 240);
        items.set(event.id, { id: event.id, title: event.title.trim(), status: 'pending',
          ...(details ? { details } : {}), ...(typeof event.parentId === 'string' ? { parentId: event.parentId } : {}) });
        break;
      }
      case 'edit':
        if (item && validTitle(event.title)) item.title = event.title.trim();
        break;
      case 'toggle':
      case 'status': {
        if (!item || (event.op === 'toggle' ? typeof event.done !== 'boolean' : !validStatus(event.status))) break;
        const status = event.op === 'toggle' ? event.done ? 'completed' : 'pending' : event.status as SessionTask['status'];
        const children = [...items.values()].filter(task => task.parentId === item.id);
        if (!children.length) setStatus(item, status);
        else if (status === 'in_progress') {
          const next = children.find(child => child.status === 'in_progress') ?? children.find(child => child.status !== 'completed');
          if (next) setStatus(next, status);
        } else for (const child of children) setStatus(child, status);
        break;
      }
      case 'delete':
        if (item) {
          items.delete(item.id);
          for (const child of items.values()) if (child.parentId === item.id) items.delete(child.id);
        }
        break;
    }
    items = new Map(grouped(items).map(task => [task.id, task]));
  }
  return grouped(items);
}
