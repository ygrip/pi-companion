import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderUsage, SessionTelemetry, UsageWindow } from "./protocol.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.slice(0, 160) : undefined;
function timestamp(value: unknown): string | undefined {
  const millis = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString() : undefined;
}
function usageWindow(value: unknown): UsageWindow | undefined {
  const raw = record(value);
  if (!raw) return;
  const remaining = number(raw.remainingPercent);
  const usedPercent = number(raw.usedPercent ?? raw.used_percent) ?? (remaining !== undefined && remaining <= 100 ? 100 - remaining : undefined);
  if (usedPercent === undefined || usedPercent > 100) return;
  return { usedPercent, resetsAt: timestamp(raw.resetsAt ?? raw.resetAt ?? raw.reset_at) };
}

/** Allowlisted, provider-neutral input; never relay arbitrary extension data or credentials. */
export function normalizeTelemetry(value: unknown, source = "extension", now = Date.now()): SessionTelemetry {
  const raw = record(value);
  if (!raw) return {};
  const result: SessionTelemetry = {};
  const context = record(raw.context ?? raw.contextUsage);
  if (context) {
    const tokens = number(context.tokens);
    const window = number(context.window ?? context.contextWindow);
    const percent = number(context.percent) ?? (tokens !== undefined && window ? tokens / window * 100 : undefined);
    if (tokens !== undefined || percent !== undefined) result.context = { tokens, window, percent, source };
  }
  const cost = record(raw.cost);
  const amount = number(cost?.amount ?? cost?.total ?? raw.cost);
  if (amount !== undefined) result.cost = { amount, currency: text(cost?.currency) ?? "USD", source };
  const providers = Array.isArray(raw.providers) ? raw.providers.slice(0, 100) : raw.provider ? [raw] : [];
  const normalized: ProviderUsage[] = [];
  for (const item of providers) {
    const provider = record(item);
    const name = text(provider?.provider);
    if (!provider || !name) continue;
    const weekly = usageWindow(provider.weekly ?? provider.sevenDay ?? provider.seven_day);
    const fiveHour = usageWindow(provider.fiveHour ?? provider.five_hour);
    if (!weekly && !fiveHour) continue;
    normalized.push({ provider: name, source, updatedAt: timestamp(provider.updatedAt) ?? new Date(now).toISOString(), weekly, fiveHour });
  }
  if (normalized.length) result.providers = normalized;
  return result;
}

/** Independent sources may supply different fields; one broken/missing adapter cannot erase another. */
export class TelemetryRelay {
  private sources = new Map<string, { telemetry: SessionTelemetry; contextAt?: number; costAt?: number }>();
  private nativeUsage = new Map<string, { fingerprint: string; updatedAt: string }>();

  ingest(value: unknown, fallbackSource = "extension", now = Date.now()) {
    const raw = record(value);
    const source = text(raw?.source) ?? fallbackSource;
    const telemetry = normalizeTelemetry(raw?.telemetry ?? value, source, now);
    if (!Object.keys(telemetry).length) return;
    const previousEntry = this.sources.get(source);
    const previous = previousEntry?.telemetry;
    const providers = new Map(previous?.providers?.map(provider => [provider.provider, provider]));
    for (const provider of telemetry.providers ?? []) {
      const old = providers.get(provider.provider);
      // A delayed adapter response must not roll a newer provider snapshot backward.
      if (!old || Date.parse(provider.updatedAt) >= Date.parse(old.updatedAt)) providers.set(provider.provider, provider);
    }
    this.sources.delete(source);
    this.sources.set(source, {
      telemetry: { ...previous, ...telemetry, providers: [...providers.values()] },
      contextAt: telemetry.context ? now : previousEntry?.contextAt,
      costAt: telemetry.cost ? now : previousEntry?.costAt
    });
    if (this.sources.size > 100) this.sources.delete(this.sources.keys().next().value!);
  }

  /** Token estimates from the old projection/model are not valid after compaction or a switch. */
  invalidateContext() {
    for (const entry of this.sources.values()) {
      delete entry.telemetry.context;
      delete entry.contextAt;
    }
  }

  /** Legacy status producers need no Companion dependency. Explicit labels avoid ambiguous numbers. */
  status(key: string, value: string | undefined) {
    if (!value) { this.sources.delete("status:" + key); return; }
    const plain = value.replace(/\x1b\[[0-9;]*m/g, "");
    const telemetry: Record<string, unknown> = { source: "status:" + key };
    const context = plain.match(/(?:context|ctx)\s*[:=]?\s*([\d.]+)%/i);
    const labelledCost = plain.match(/cost\s*[:=]?\s*\$([\d.]+)/i);
    const cost = labelledCost ?? (/cost|usage|token|footer|context/i.test(key) ? plain.match(/\$([\d.]+)/) : null);
    if (context) telemetry.context = { percent: Number(context[1]) };
    if (cost) telemetry.cost = { amount: Number(cost[1]) };
    const weekly = plain.match(/(?:weekly|7d|7-day)\s*[:=]?\s*([\d.]+)%\s*(left|remaining|used)?/i);
    const fiveHour = plain.match(/(?:5h|5-hour)\s*[:=]?\s*([\d.]+)%\s*(left|remaining|used)?/i);
    const window = (match: RegExpMatchArray | null) => match ? { usedPercent: /left|remaining/i.test(match[2] ?? "") ? 100 - Number(match[1]) : Number(match[1]) } : undefined;
    const provider = plain.match(/provider\s*[:=]\s*([\w.-]+)/i)?.[1];
    if (provider && (weekly || fiveHour)) telemetry.providers = [{ provider, weekly: window(weekly), fiveHour: window(fiveHour) }];
    this.ingest(telemetry);
  }

  snapshot(ctx: ExtensionContext | undefined, now = Date.now()): SessionTelemetry {
    const result: SessionTelemetry = {};
    const providers = new Map<string, ProviderUsage>();
    let latestContext = -Infinity;
    let latestCost = -Infinity;
    for (const { telemetry, contextAt, costAt } of this.sources.values()) {
      if (telemetry.context && contextAt !== undefined && now - contextAt <= 300_000 && contextAt >= latestContext) {
        result.context = telemetry.context;
        latestContext = contextAt;
      }
      if (telemetry.cost && costAt !== undefined && now - costAt <= 300_000 && costAt >= latestCost) {
        result.cost = telemetry.cost;
        latestCost = costAt;
      }
      for (const provider of telemetry.providers ?? []) {
        const old = providers.get(provider.provider);
        if (!old || Date.parse(provider.updatedAt) >= Date.parse(old.updatedAt)) providers.set(provider.provider, provider);
      }
    }
    if (providers.size) result.providers = [...providers.values()];
    try {
      const native = ctx?.getContextUsage?.();
      if (native) {
        // Native unknown after compaction is authoritative: do not resurrect stale extension tokens.
        result.context = { tokens: number(native.tokens), window: number(native.contextWindow), percent: number(native.percent), source: "native" };
      }
    } catch { /* Older runtimes/other extensions may not implement this getter. */ }
    try {
      const entries = ctx?.sessionManager?.getEntries?.() ?? [];
      let total = 0;
      let known = false;
      for (const entry of entries) {
        const raw = record(entry);
        const message = record(raw?.message);
        const usage = record(raw?.type === "message" ? message?.usage : ["usage", "compaction", "branch_summary"].includes(String(raw?.type)) ? raw?.usage : undefined);
        const cost = number(record(usage?.cost)?.total);
        if (cost !== undefined) { known = true; total += cost; }
      }
      if (known && Number.isFinite(total)) result.cost = { amount: total, currency: "USD", source: "native" };
    } catch { /* Preserve extension estimate when native usage is unavailable. */ }
    // Native session entries are available without another plugin. They report actual
    // consumption, not provider subscription limits, and must never fabricate quotas.
    try {
      const totals = new Map<string, { tokens: number; cost: number; hasTokens: boolean; hasCost: boolean }>();
      for (const entry of ctx?.sessionManager?.getEntries?.() ?? []) {
        const raw = record(entry);
        if (raw?.type !== "message") continue;
        const message = record(raw.message);
        if (message?.role !== "assistant") continue;
        const provider = text(message.provider);
        const usage = record(message.usage);
        if (!provider || !usage) continue;
        const pieces = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].map(number);
        const tokens = number(usage.totalTokens) ?? (pieces.some(value => value !== undefined)
          ? pieces.reduce<number>((sum, value) => sum + (value ?? 0), 0) : undefined);
        const cost = number(record(usage.cost)?.total);
        if (tokens === undefined && cost === undefined) continue;
        const total = totals.get(provider) ?? { tokens: 0, cost: 0, hasTokens: false, hasCost: false };
        if (tokens !== undefined) { total.tokens += tokens; total.hasTokens = true; }
        if (cost !== undefined) { total.cost += cost; total.hasCost = true; }
        totals.set(provider, total);
      }
      for (const [provider, total] of totals) {
        const fingerprint = JSON.stringify(total);
        const cached = this.nativeUsage.get(provider);
        const updatedAt = cached?.fingerprint === fingerprint ? cached.updatedAt : new Date(now).toISOString();
        this.nativeUsage.set(provider, { fingerprint, updatedAt });
        const old = providers.get(provider);
        providers.set(provider, {
          ...old, provider, source: old?.source ?? "Pi session", updatedAt: old?.updatedAt ?? updatedAt,
          sessionUpdatedAt: updatedAt,
          ...(total.hasTokens ? { sessionTokens: total.tokens } : {}),
          ...(total.hasCost ? { sessionCost: total.cost } : {})
        });
      }
      if (providers.size) result.providers = [...providers.values()];
    } catch { /* Keep independently reported quota snapshots if native entries are unavailable. */ }
    return result;
  }
}
