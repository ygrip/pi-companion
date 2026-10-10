import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ProviderUsage, UsageWindow } from './protocol.js';
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
const window = (used: unknown, reset: unknown): UsageWindow | undefined => {
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return;
  const date = typeof reset === 'number' ? new Date(reset * 1000) : typeof reset === 'string' ? new Date(reset) : undefined;
  return { usedPercent: used, ...(date && Number.isFinite(date.getTime()) ? { resetsAt: date.toISOString() } : {}) };
};
export function parseProviderQuota(provider: string, value: unknown): Pick<ProviderUsage, 'weekly' | 'fiveHour'> {
  const body = object(value);
  if (provider === 'anthropic') return {
    weekly: window(object(body.seven_day).utilization, object(body.seven_day).resets_at),
    fiveHour: window(object(body.five_hour).utilization, object(body.five_hour).resets_at)
  };
  const quota: Pick<ProviderUsage, 'weekly' | 'fiveHour'> = {};
  const rate = object(body.rate_limit);
  for (const [raw, fallback] of [[rate.primary_window, 'fiveHour'], [rate.secondary_window, 'weekly']] as const) {
    const item = object(raw), parsed = window(item.used_percent, item.reset_at);
    if (!parsed) continue;
    const seconds = item.limit_window_seconds;
    const key = typeof seconds === 'number' && seconds > 0 ? (seconds <= 86400 ? 'fiveHour' : 'weekly') : fallback;
    quota[key] = parsed;
  }
  return quota;
}

/** Fetch only known subscription endpoints using Pi's OAuth resolver. No credentials leave Pi. */
export class ProviderQuotaPoller {
  private pending = new Set<string>();
  private next = new Map<string, number>();
  private failures = new Map<string, number>();
  private stopped = false;
  private controllers = new Set<AbortController>();
  constructor(private publish: (value: unknown) => void) {}
  stop() { this.stopped = true; for (const controller of this.controllers) controller.abort(); }
  async refresh(ctx: ExtensionContext) {
    if (this.stopped || process.env.PI_COMPANION_QUOTAS === '0') return;
    let available: ReturnType<ExtensionContext['modelRegistry']['getAvailable']>;
    try { available = ctx.modelRegistry?.getAvailable?.() ?? []; } catch { return; }
    for (const provider of ['openai-codex', 'anthropic']) {
      const model = available.find(item => item.provider === provider);
      let oauth = false;
      try { oauth = Boolean(model && ctx.modelRegistry.isUsingOAuth(model)); } catch { /* unsupported registry */ }
      if (!model || !oauth || this.pending.has(provider) || Date.now() < (this.next.get(provider) ?? 0)) continue;
      this.pending.add(provider);
      const controller = new AbortController(); this.controllers.add(controller);
      this.next.set(provider, Date.now() + 300_000);
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey || this.stopped) continue;
        const headers: Record<string, string> = { Authorization: 'Bearer ' + auth.apiKey, Accept: 'application/json' };
        let url = 'https://api.anthropic.com/api/oauth/usage';
        if (provider === 'openai-codex') {
          const payload = JSON.parse(Buffer.from(auth.apiKey.split('.')[1] ?? '', 'base64url').toString('utf8'));
          const id = object(payload['https://api.openai.com/auth']).chatgpt_account_id;
          if (typeof id !== 'string' || !id) continue;
          headers['ChatGPT-Account-Id'] = id;
          url = 'https://chatgpt.com/backend-api/wham/usage';
        } else headers['anthropic-beta'] = 'oauth-2025-04-20';
        const response = await fetch(url, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
        if (!response.ok) throw new Error('quota lookup failed');
        const quota = parseProviderQuota(provider, await response.json());
        if (!this.stopped && (quota.weekly || quota.fiveHour)) this.publish({ source: 'Companion subscription limits', providers: [{ provider, ...quota, updatedAt: new Date().toISOString() }] });
        this.failures.delete(provider);
      } catch {
        // Never forward response bodies or authentication data. Back off per provider.
        const failures = Math.min(6, (this.failures.get(provider) ?? 0) + 1);
        this.failures.set(provider, failures);
        this.next.set(provider, Date.now() + Math.min(1800_000, 300_000 * 2 ** failures));
      } finally { this.pending.delete(provider); this.controllers.delete(controller); }
    }
  }
}

export function providerError(value: unknown): { provider: string; title: string; message: string } | undefined {
  const raw = object(value);
  if (raw.role !== 'assistant' || raw.stopReason !== 'error') return;
  const text = typeof raw.errorMessage === 'string' ? raw.errorMessage : '';
  const provider = typeof raw.provider === 'string' ? raw.provider : 'Provider';
  const quota = /quota|usage.limit|credit|billing|insufficient_quota|exhausted/i.test(text);
  const rate = /rate.limit|429|too many requests/i.test(text);
  const auth = /401|403|unauthori[sz]ed|authentication|invalid.api.key/i.test(text);
  return { provider, title: quota ? 'Provider quota exhausted' : rate ? 'Provider rate limit' : auth ? 'Provider authentication failed' : 'Provider request failed',
    message: quota ? 'The provider reports that your usage allowance or credits are exhausted. Check your plan or wait for the limit to reset, then retry or switch provider.' : rate ? 'The provider is limiting requests. Wait before retrying, or switch provider. Pi may retry automatically.' : auth ? 'Your provider login or credentials were rejected. Reauthenticate in Pi, then retry.' : 'The provider could not complete this request. Check the Pi terminal for details, then retry or switch provider.' };
}
