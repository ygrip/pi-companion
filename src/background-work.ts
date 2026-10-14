import type { BackgroundWork } from './protocol.js';

type Item = { id: string; name: string; state: string; startedAt?: number };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Observe structured Jar results, never infer process liveness from transcript text. */
export class BackgroundWorkTracker {
  private shells = new Map<string, Item>();
  private agents = new Map<string, Item>();

  constructor(private readonly now: () => number = Date.now) {}

  ingest(tool: string, value: unknown) {
    const details = object(value);
    const name = tool.split(/[._]/).slice(-2).join('_');
    if ((name === 'jar_shell' || tool === 'pi-jar.shell') && Array.isArray(details.jobs)) {
      const ids = new Set(details.jobs.map(job => object(job).id));
      for (const job of details.jobs) this.upsert(this.shells, job, 'status');
      for (const id of this.shells.keys()) if (!ids.has(id)) this.shells.delete(id);
    }
    if (name === 'jar_delegate' && Array.isArray(details.runs)) {
      for (const raw of details.runs) {
        const run = object(raw);
        this.upsert(this.agents, { ...run, id: run.key ?? `delegate-${details.batch}-${run.index}` }, 'state');
      }
    }
    if (name === 'jar_subagent' && typeof details.key === 'string') {
      if (details.state) this.upsert(this.agents, details, 'state');
      else if (details.status === 'accepted' && details.action === 'resume') this.update(this.agents, details.key, 'working');
    }
    if (tool === 'pi-jar.shell' && Array.isArray(details.events)) {
      for (const event of details.events) this.upsert(this.shells, event, 'status');
    }
    if (tool === 'pi-jar.subagent' && Array.isArray(details.events)) {
      for (const raw of details.events) {
        const event = object(raw);
        if (typeof event.key !== 'string') continue;
        const report = object(event.report);
        if (report.state) this.upsert(this.agents, { ...report, key: event.key }, 'state');
        else if (typeof event.turn === 'number') this.update(this.agents, event.key, 'idle');
        else if (event.status === 'completed') {
          const state = event.action === 'resume' ? 'working' : event.action === 'stop' ? 'stopped' : event.action === 'pause' ? 'paused' : undefined;
          if (state) this.update(this.agents, event.key, state);
        }
      }
    }
  }

  private upsert(items: Map<string, Item>, raw: unknown, field: string) {
    const value = object(raw);
    const id = value.key ?? value.id;
    if (typeof id !== 'string' || typeof value[field] !== 'string') return;
    const previous = items.get(id);
    const state = value[field] as string;
    const reported = typeof value.startedAt === 'string' ? Date.parse(value.startedAt)
      : typeof value.startedAt === 'number' ? (value.startedAt < 1e12 ? value.startedAt * 1000 : value.startedAt) : NaN;
    // Without a source timestamp, measure from the first active report, not popup opening.
    const startedAt = Number.isFinite(reported) && reported > 0 ? reported
      : previous?.state === state ? previous.startedAt : ['running', 'working', 'queued'].includes(state) ? this.now() : undefined;
    items.set(id, { id, name: typeof value.name === 'string' ? value.name.slice(0, 120) : previous?.name ?? id, state, ...(startedAt !== undefined ? { startedAt } : {}) });
  }

  private update(items: Map<string, Item>, id: string, state: string) {
    this.upsert(items, { id, state }, 'state');
  }

  snapshot(): BackgroundWork {
    return {
      shells: [...this.shells.values()].filter(item => item.state === 'running').map(item => ({ ...item })),
      agents: [...this.agents.values()].filter(item => item.state === 'working' || item.state === 'queued').map(item => ({ ...item }))
    };
  }
}
