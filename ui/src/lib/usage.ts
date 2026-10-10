import type { ProviderUsage, Session, SessionTelemetry, UsageWindow } from './types.ts';

const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: number) => Math.round(value).toLocaleString();

/** Unknown usage is not zero usage. Keep missing or malformed fields visibly unknown. */
export function usagePercent(window: UsageWindow | undefined): string {
  return window && nonnegative(window.usedPercent) ? `${Number(window.usedPercent.toFixed(1))}%` : '—';
}

export function contextUsage(context: SessionTelemetry['context'] | null): string {
  if (!context) return 'Unavailable';
  const tokens = nonnegative(context.tokens) ? context.tokens : undefined;
  const window = nonnegative(context.window) && context.window > 0 ? context.window : undefined;
  const derivedPercent = tokens !== undefined && window ? tokens / window * 100 : undefined;
  const percent = nonnegative(context.percent) ? context.percent : nonnegative(derivedPercent) ? derivedPercent : undefined;
  const counts = tokens !== undefined && window ? `${count(tokens)} / ${count(window)} tokens` : tokens !== undefined ? `${count(tokens)} tokens` : window ? `${count(window)} token window` : '';
  const percentage = percent !== undefined ? `${Number(percent.toFixed(1))}%` : '';
  return counts && percentage ? `${percentage} · ${counts}` : percentage || counts || 'Unavailable';
}

export function estimatedCost(cost: SessionTelemetry['cost'] | null): string {
  if (!cost || !nonnegative(cost.amount)) return 'Unavailable';
  const currency = cost.currency?.trim().toUpperCase() || 'USD';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: cost.amount > 0 && cost.amount < 0.01 ? 4 : 2
    }).format(cost.amount);
  } catch {
    // An extension's custom unit must not break rendering for the whole session.
    return `${cost.amount.toFixed(cost.amount > 0 && cost.amount < 0.01 ? 4 : 2)} ${currency}`;
  }
}

export function reportedTime(value: string | undefined): string {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown';
}

export type ProviderSnapshot = ProviderUsage & { ended: boolean };

/** Account limits are snapshots, not additive session usage. The newest report wins. */
export function providerSnapshots(sessions: Session[]): ProviderSnapshot[] {
  const quota = new Map<string, ProviderSnapshot>();
  const local = new Map<string, ProviderSnapshot>();
  const newer = (next: ProviderSnapshot, old?: ProviderSnapshot) => {
    if (!old) return true;
    const nextTime = Date.parse(next.updatedAt);
    const oldTime = Date.parse(old.updatedAt);
    return Number.isFinite(nextTime) &&
      (!Number.isFinite(oldTime) || nextTime > oldTime || nextTime === oldTime && old.ended && !next.ended);
  };
  for (const session of sessions) {
    for (const snapshot of session.telemetry?.providers ?? []) {
      if (typeof snapshot?.provider !== 'string' || !snapshot.provider.trim()) continue;
      const provider = snapshot.provider.trim();
      const key = provider.toLowerCase();
      const next = { ...snapshot, provider, ended: session.status === 'stopped' };
      if ((snapshot.weekly || snapshot.fiveHour) && newer(next, quota.get(key))) quota.set(key, next);
      if ((nonnegative(snapshot.sessionTokens) || nonnegative(snapshot.sessionCost)) && newer(next, local.get(key))) local.set(key, next);
    }
  }
  return [...new Set([...quota.keys(), ...local.keys()])].map(key => {
    const limit = quota.get(key);
    const consumption = local.get(key);
    const chosen = (limit ?? consumption)!;
    return { ...chosen,
      ...(consumption && { sessionTokens: consumption.sessionTokens, sessionCost: consumption.sessionCost })
    };
  }).sort((a, b) => a.provider.localeCompare(b.provider));
}

export function snapshotStatus(snapshot: ProviderSnapshot, now = Date.now()): string {
  const timestamp = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(timestamp)) return 'Snapshot time unknown';
  if (snapshot.ended) return 'Last report · session ended';
  if (now - timestamp >= 15 * 60_000) return 'Older snapshot';
  return 'Latest snapshot';
}
