export type ActivityKind = 'assistant' | 'thinking' | 'tool' | 'lifecycle' | 'error' | 'user';

export type ActivityEntry = {
  id: number;
  kind: ActivityKind;
  title: string;
  body: string;
  status?: 'running' | 'ok' | 'error';
  toolCallId?: string;
  at: number;
};

export type AskRequest = {
  requestId: string;
  question: string;
  options?: string[];
};

const MAX_ENTRIES = 300;
let nextId = 1;

function entry(kind: ActivityKind, title: string, body = '', extra: Partial<ActivityEntry> = {}): ActivityEntry {
  return { id: nextId++, kind, title, body, at: Date.now(), ...extra };
}

function cap(entries: ActivityEntry[]) {
  return entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries;
}

export function pushUser(entries: ActivityEntry[], title: string, body: string) {
  return cap([...entries, entry('user', title, body)]);
}

/** Reduce one bridge message into the activity feed. Returns the same array when nothing changes. */
export function reduceBridgeMessage(entries: ActivityEntry[], message: any): ActivityEntry[] {
  if (message?.type === 'error') return cap([...entries, entry('error', 'error', String(message.message ?? ''))]);
  if (message?.type !== 'event') return entries;

  const payload = message.payload ?? {};
  switch (message.event) {
    case 'assistant.delta': {
      const kind: ActivityKind = payload.kind === 'thinking' ? 'thinking' : 'assistant';
      const last = entries[entries.length - 1];
      if (last && last.kind === kind) {
        const updated = { ...last, body: last.body + String(payload.delta ?? '') };
        return [...entries.slice(0, -1), updated];
      }
      return cap([...entries, entry(kind, kind === 'thinking' ? 'thinking' : 'assistant', String(payload.delta ?? ''))]);
    }
    case 'tool.start':
      return cap([
        ...entries,
        entry('tool', String(payload.toolName ?? 'tool'), String(payload.args ?? ''), {
          status: 'running',
          toolCallId: payload.toolCallId
        })
      ]);
    case 'tool.end': {
      let index = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].kind === 'tool' && entries[i].toolCallId === payload.toolCallId) { index = i; break; }
      }
      const status = payload.isError ? 'error' : 'ok';
      const result = String(payload.result ?? '');
      if (index === -1) {
        return cap([...entries, entry('tool', String(payload.toolName ?? 'tool'), result, { status })]);
      }
      const next = [...entries];
      const current = next[index];
      next[index] = { ...current, status, body: result ? current.body + (current.body ? '\n→ ' : '') + result : current.body };
      return next;
    }
    case 'agent.start':
      return cap([...entries, entry('lifecycle', 'turn started')]);
    case 'agent.end':
      return cap([...entries, entry('lifecycle', 'turn finished')]);
    case 'session.start':
      return cap([...entries, entry('lifecycle', 'session started', String(payload.cwd ?? ''))]);
    case 'session.shutdown':
      return cap([...entries, entry('lifecycle', 'session stopped')]);
    default:
      return entries;
  }
}
