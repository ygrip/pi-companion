import { pushUser, reduceBridgeMessage, type ActivityEntry } from './activity.ts';
import { sortSessions } from './format.ts';
import { toasts } from './toast.svelte.ts';
import { LiveConnection, type Connection } from './connection.ts';
export type { Connection } from './connection.ts';
import type { AskAnswers, AskRequest, PairedDevice, Pairing, Session, SettingsResponse, Settings, TempFile } from './types.ts';

/**
 * Single live connection to the daemon, shared by every page.
 *
 * - `connecting` / `online` / `offline`: normal socket lifecycle, with backoff reconnects.
 * - `disconnected`: the computer ended this device's connection (close 4001). The device is
 *   still paired; it reconnects only when the user asks.
 * - `revoked`: the computer removed this device (close 4003 or HTTP 401). The stored
 *   credential is deleted and the device must pair again.
 */
const TOKEN_KEY = 'piCompanionDeviceToken';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type Diff = { staged: boolean; text: string; at: number; error?: string };

class Companion {
  booted = $state(false);
  bootError = $state('');
  remote = $state(false);
  version = $state('');
  token = $state<string | null>(null);
  connection = $state<Connection>('connecting');

  sessions = $state<Session[]>([]);
  devices = $state<PairedDevice[]>([]);
  // Per-session live data. Raw state + reassignment keeps streaming cheap.
  activity = $state.raw<Record<string, ActivityEntry[]>>({});
  files = $state.raw<Record<string, TempFile[]>>({});
  diffs = $state.raw<Record<string, Diff>>({});

  private live = new LiveConnection({
    enabled: () => this.booted && this.paired,
    create: () => {
      const url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/browser';
      return this.remote ? new WebSocket(url, ['pi-companion', 'token.' + this.token]) : new WebSocket(url);
    },
    state: (state) => { this.connection = state; },
    online: () => { void this.refresh().catch(() => {}); },
    message: (data) => {
      try { this.handle(JSON.parse(data)); } catch { /* ignore malformed frames */ }
    },
    lost: () => {
      // Upgrade rejection has no readable HTTP status in the WebSocket API.
      // Only a confirmed 401 removes credentials; network/daemon failures do not.
      if (this.remote) void this.request('/api/sessions').catch(() => {});
    },
    revoked: () => this.forget()
  });
  private devicesTimer: ReturnType<typeof setTimeout> | undefined;
  private booting = false;

  get isAdmin() {
    return !this.remote;
  }

  get paired() {
    return !this.remote || Boolean(this.token);
  }

  session(id: string) {
    return this.sessions.find((session) => session.id === id) ?? null;
  }

  /** Pending questions per live session. They travel in the session snapshot, so late joiners see them. */
  get asks(): Record<string, AskRequest[]> {
    const result: Record<string, AskRequest[]> = {};
    for (const session of this.sessions) {
      if (session.status !== 'stopped' && session.asks?.length) result[session.id] = session.asks;
    }
    return result;
  }

  pendingAsks(id: string) {
    return this.asks[id]?.length ?? 0;
  }

  async boot() {
    if (this.booted || this.booting) return;
    this.booting = true;
    try {
      const response = await fetch('/api/context', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new ApiError(response.status, 'Daemon context unavailable.');
      const context = await response.json();
      this.remote = Boolean(context.remote);
      this.version = String(context.version ?? '');
      this.token = this.remote ? localStorage.getItem(TOKEN_KEY) : null;
    } catch {
      this.bootError = 'Pi Companion is not responding. Is the daemon running?';
      this.connection = 'offline';
      this.booted = true;
      setTimeout(() => {
        this.booted = false;
        this.bootError = '';
        void this.boot();
      }, 3000);
      return;
    } finally {
      this.booting = false;
    }
    this.booted = true;
    if (!this.paired) return;
    this.connect();
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    const token = this.token;
    if (this.remote && token) headers.set('authorization', 'Bearer ' + token);
    // Bound snapshot reads, not uploads or mutations which may legitimately take longer.
    let signal = init.signal;
    if (!init.method || ['GET', 'HEAD'].includes(init.method.toUpperCase())) {
      const timeout = AbortSignal.timeout(15_000);
      signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    }
    const response = await fetch(path, { ...init, headers, signal, cache: 'no-store' });
    if (response.status === 401 && this.remote && this.token === token) this.forget();
    if (!response.ok) throw new ApiError(response.status, (await response.text()) || response.statusText);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async refresh() {
    await Promise.all([this.refreshSessions(), this.refreshDevices()]);
    // Upload notifications missed while offline are not replayed by the daemon.
    await Promise.all(Object.keys(this.files).filter((id) => this.session(id)).map((id) => this.refreshFiles(id)));
  }

  async refreshSessions() {
    const result = await this.request<{ sessions: Session[] }>('/api/sessions');
    this.sessions = sortSessions(result.sessions);
  }

  async refreshDevices() {
    if (!this.isAdmin) return;
    const result = await this.request<{ devices: PairedDevice[] }>('/api/devices');
    this.devices = result.devices;
  }

  async refreshFiles(sessionId: string) {
    const result = await this.request<{ files: TempFile[] }>(
      '/api/sessions/' + encodeURIComponent(sessionId) + '/files'
    );
    this.files = { ...this.files, [sessionId]: result.files };
  }

  connect() {
    this.live.start();
  }

  reconnect() {
    if (this.bootError) {
      this.booted = false;
      this.bootError = '';
      void this.boot();
      return;
    }
    this.live.reconnect();
  }

  /** Install once in the root layout; backgrounded PWAs resume without re-pairing. */
  watchConnectivity() {
    const resume = () => {
      if (document.visibilityState !== 'visible') return;
      if (this.bootError) this.reconnect();
      else if (!this.booted) void this.boot();
      else this.live.resume();
    };
    window.addEventListener('online', resume);
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.removeEventListener('online', resume);
      window.removeEventListener('pageshow', resume);
      document.removeEventListener('visibilitychange', resume);
      this.live.stop();
      clearTimeout(this.devicesTimer);
    };
  }

  /** Drop this device's credential (revoked or explicitly unpaired). */
  forget() {
    if (!this.remote) return;
    localStorage.removeItem(TOKEN_KEY);
    this.token = null;
    this.connection = 'revoked';
    this.live.revoke();
    this.sessions = [];
  }

  private handle(message: any) {
    switch (message.type) {
      case 'session.register': {
        const next = message.session as Session;
        const others = this.sessions.filter((session) => session.id !== next.id);
        this.sessions = sortSessions(this.remote && !next.remoteEnabled ? others : [...others, next]);
        break;
      }
      case 'session.update': {
        const patch = message.patch ?? {};
        const known = this.sessions.some((session) => session.id === message.sessionId);
        if (this.remote && patch.remoteEnabled === true && !known) {
          void this.refreshSessions().catch(() => {});
          break;
        }
        this.sessions = sortSessions(
          this.sessions
            .map((session) => (session.id === message.sessionId ? { ...session, ...patch } : session))
            .filter((session) => !this.remote || session.remoteEnabled)
        );
        break;
      }
      case 'resync':
        // This socket fell behind and the daemon dropped frames; re-read the snapshots so a
        // missed question or status change shows up now instead of at the next reconnect.
        void this.refresh().catch(() => {});
        break;
      case 'files.update':
        this.files = { ...this.files, [message.sessionId]: message.files };
        break;
      case 'devices.update':
        // Several sockets can open/close at once; coalesce refreshes.
        clearTimeout(this.devicesTimer);
        this.devicesTimer = setTimeout(() => void this.refreshDevices().catch(() => {}), 150);
        break;
      case 'bridge.event':
        this.handleBridge(message.sessionId, message.message);
        break;
    }
  }

  private handleBridge(sessionId: string, inner: any) {
    if (!sessionId || !inner) return;
    if (inner.type === 'git.diff') {
      const error = typeof inner.error === 'string' ? inner.error : undefined;
      this.diffs = { ...this.diffs, [sessionId]: { staged: Boolean(inner.staged), text: inner.diff ?? '', at: Date.now(), error } };
      if (error) toasts.show(error, 'error');
      return;
    }
    const current = this.activity[sessionId] ?? [];
    const next = reduceBridgeMessage(current, inner);
    if (next !== current) this.activity = { ...this.activity, [sessionId]: next };
  }

  send(sessionId: string, command: Record<string, unknown>) {
    return this.live.send(JSON.stringify({ sessionId, command }));
  }

  prompt(sessionId: string, text: string, steer: boolean) {
    if (!this.send(sessionId, { type: steer ? 'steer' : 'prompt', text })) return false;
    this.activity = { ...this.activity, [sessionId]: pushUser(this.activity[sessionId] ?? [], steer ? 'You · steer' : 'You', text) };
    return true;
  }

  /** Drop an ask locally right away; the bridge's session.update confirms it. */
  private withoutAsk(sessionId: string, requestId: string) {
    this.sessions = this.sessions.map((session) =>
      session.id === sessionId ? { ...session, asks: (session.asks ?? []).filter((ask) => ask.requestId !== requestId) } : session
    );
  }

  answer(sessionId: string, requestId: string, answers: AskAnswers) {
    if (!this.send(sessionId, { type: 'ask_answer', requestId, answers })) return false;
    this.withoutAsk(sessionId, requestId);
    const summary = Object.values(answers).map((values) => values.join(', ')).join(' · ');
    this.activity = { ...this.activity, [sessionId]: pushUser(this.activity[sessionId] ?? [], 'You · answer', summary) };
    return true;
  }

  dismissAsk(sessionId: string, requestId: string) {
    if (!this.send(sessionId, { type: 'ask_cancel', requestId })) return false;
    this.withoutAsk(sessionId, requestId);
    return true;
  }

  async upload(sessionId: string, file: File) {
    const data = new FormData();
    data.append('file', file);
    await this.request('/api/sessions/' + encodeURIComponent(sessionId) + '/files', { method: 'POST', body: data });
    await this.refreshFiles(sessionId);
  }

  async removeFile(sessionId: string, fileId: string) {
    await this.request(
      '/api/sessions/' + encodeURIComponent(sessionId) + '/files/' + encodeURIComponent(fileId),
      { method: 'DELETE' }
    );
    await this.refreshFiles(sessionId);
  }

  startPairing() {
    return this.request<Pairing>('/api/pairing/start', { method: 'POST' });
  }

  async claim(source: { invite: string } | { code: string }, deviceName: string) {
    const response = await fetch('/api/pairing/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...source, deviceName })
    });
    if (!response.ok) throw new ApiError(response.status, (await response.text()) || response.statusText);
    const result = (await response.json()) as { token: string };
    localStorage.setItem(TOKEN_KEY, result.token);
    this.token = result.token;
    await this.refresh().catch(() => {});
    this.reconnect();
  }

  async revokeDevice(id: string) {
    await this.request('/api/devices/' + encodeURIComponent(id), { method: 'DELETE' });
    await this.refreshDevices();
  }

  async disconnectDevice(id: string) {
    await this.request('/api/devices/' + encodeURIComponent(id) + '/disconnect', { method: 'POST' });
  }

  getSettings() {
    return this.request<SettingsResponse>('/api/settings');
  }

  saveSettings(settings: Settings) {
    return this.request<SettingsResponse>('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settings)
    });
  }
}

export const companion = new Companion();
