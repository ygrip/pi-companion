import { pushUser, reduceBridgeMessage, type ActivityEntry } from './activity.ts';
import { sortSessions } from './format.ts';
import { toasts } from './toast.svelte.ts';
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
export type Connection = 'connecting' | 'online' | 'offline' | 'disconnected' | 'revoked';

const TOKEN_KEY = 'piCompanionDeviceToken';
const CLOSE_DISCONNECTED = 4001;
const CLOSE_REVOKED = 4003;

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

  private ws: WebSocket | null = null;
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private devicesTimer: ReturnType<typeof setTimeout> | undefined;

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
    if (this.booted) return;
    try {
      const response = await fetch('/api/context', { cache: 'no-store' });
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
    }
    this.booted = true;
    if (!this.paired) return;
    await this.refresh().catch(() => {});
    this.connect();
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.remote && this.token) headers.set('authorization', 'Bearer ' + this.token);
    const response = await fetch(path, { ...init, headers, cache: 'no-store' });
    if (response.status === 401 && this.remote) this.forget();
    if (!response.ok) throw new ApiError(response.status, (await response.text()) || response.statusText);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async refresh() {
    await Promise.all([this.refreshSessions(), this.refreshDevices()]);
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

  private dropSession(sessionId: string) {
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);
    const { [sessionId]: _activity, ...activity } = this.activity;
    const { [sessionId]: _files, ...files } = this.files;
    const { [sessionId]: _diffs, ...diffs } = this.diffs;
    this.activity = activity;
    this.files = files;
    this.diffs = diffs;
  }

  /** Archive only the daemon's ended-session record; never Pi's local history. */
  async archiveSession(sessionId: string) {
    const session = this.session(sessionId);
    if (!session || session.status !== 'stopped') throw new Error('Only ended sessions can be archived.');
    await this.request('/api/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' });
    this.dropSession(sessionId);
  }

  async refreshFiles(sessionId: string) {
    const result = await this.request<{ files: TempFile[] }>(
      '/api/sessions/' + encodeURIComponent(sessionId) + '/files'
    );
    this.files = { ...this.files, [sessionId]: result.files };
  }

  connect() {
    clearTimeout(this.retryTimer);
    if (!this.paired) return;
    const url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/browser';
    const ws = this.remote ? new WebSocket(url, ['pi-companion', 'token.' + this.token]) : new WebSocket(url);
    this.ws = ws;
    this.connection = 'connecting';

    ws.onopen = () => {
      this.connection = 'online';
      this.retryMs = 1000;
      void this.refresh().catch(() => {});
    };
    ws.onmessage = (event) => {
      try {
        this.handle(JSON.parse(event.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (event.code === CLOSE_REVOKED) return this.forget();
      if (event.code === CLOSE_DISCONNECTED) {
        this.connection = 'disconnected';
        return;
      }
      this.connection = 'offline';
      // An upgrade rejected with 401 looks like a plain close; confirm over HTTP.
      if (this.remote) void this.request('/api/sessions').catch(() => {});
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 15_000);
    };
  }

  reconnect() {
    this.retryMs = 1000;
    this.connect();
  }

  /** Drop this device's credential (revoked or explicitly unpaired). */
  forget() {
    if (!this.remote) return;
    localStorage.removeItem(TOKEN_KEY);
    this.token = null;
    this.connection = 'revoked';
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
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
      case 'session.removed':
        this.dropSession(message.sessionId);
        break;
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
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ sessionId, command }));
    return true;
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
    this.connect();
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
