import { pushUser, reduceBridgeMessage, type ActivityEntry } from './activity.ts';
import { sortSessions } from './format.ts';
import { toasts } from './toast.svelte.ts';
import { ApiError, WorkspaceConnectionError, unreachableMessage, workspaceRequest } from './workspace-connection.ts';
export { ApiError } from './workspace-connection.ts';
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

type Diff = { staged: boolean; text: string; at: number; error?: string };
type UploadPolicy = { maxUploadMb: number; allowedUploadTypes: string[] };

class Companion {
  booted = $state(false);
  bootError = $state('');
  connectionError = $state('');
  uploadPolicy = $state<UploadPolicy>({ maxUploadMb: 25, allowedUploadTypes: [] });
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
  private socketTimer: ReturnType<typeof setTimeout> | undefined;
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
    if (this.booting || (this.booted && !this.bootError)) return;
    this.booting = true;
    this.connection = 'connecting';
    clearTimeout(this.retryTimer);
    try {
      const context = await workspaceRequest<{ remote: boolean; version: string; uploadPolicy?: UploadPolicy }>('/api/context');
      if (!context || typeof context.remote !== 'boolean' || typeof context.version !== 'string') {
        throw new WorkspaceConnectionError('This address is not responding as a Pi Companion workspace. Check the current tunnel URL.');
      }
      this.setUploadPolicy(context.uploadPolicy);
      this.remote = context.remote;
      this.version = context.version;
      this.token = this.remote ? localStorage.getItem(TOKEN_KEY) : null;
      this.bootError = '';
      this.connectionError = '';
      this.booted = true;
    } catch (error) {
      this.bootError = error instanceof Error ? error.message : unreachableMessage();
      this.unavailable(this.bootError);
      this.booted = true;
      return;
    } finally {
      this.booting = false;
    }
    if (!this.paired) return;
    try {
      await this.refresh();
      if (this.paired) this.connect();
    } catch { /* request() exposes connection errors and schedules recovery */ }
  }

  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (!navigator.onLine || this.connection === 'disconnected' || this.connection === 'revoked') return;
    this.retryTimer = setTimeout(() => {
      if (this.bootError) void this.boot();
      else if (this.paired) this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 15_000);
  }

  private unavailable(message: string) {
    if (this.connection === 'disconnected' || this.connection === 'revoked') return;
    this.connectionError = message;
    this.connection = 'offline';
    this.scheduleRetry();
  }

  networkOffline() {
    if (this.connection === 'disconnected' || this.connection === 'revoked') return;
    this.unavailable(unreachableMessage(false));
    this.ws?.close();
  }

  async request<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.remote && this.token) headers.set('authorization', 'Bearer ' + this.token);
    try {
      return await workspaceRequest<T>(path, { ...init, headers }, timeoutMs);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && this.remote && path !== '/api/pairing/claim') this.forget();
      else if (error instanceof WorkspaceConnectionError) this.unavailable(error.message);
      else if (error instanceof ApiError && error.status === 403 && path === '/api/sessions') {
        this.unavailable('The workspace denied this connection (HTTP 403). Open the current device URL and check the daemon’s allowed origins and device permissions.');
      }
      throw error;
    }
  }

  async refresh() {
    await Promise.all([this.refreshSessions(), this.refreshDevices()]);
  }

  async refreshSessions() {
    const result = await this.request<{ sessions: Session[] }>('/api/sessions');
    if (!result || !Array.isArray(result.sessions)) {
      const error = new WorkspaceConnectionError('The workspace returned an invalid session list. Check the tunnel URL and retry.');
      this.unavailable(error.message);
      throw error;
    }
    this.sessions = sortSessions(result.sessions);
  }

  async refreshDevices() {
    if (!this.isAdmin) return;
    const result = await this.request<{ devices: PairedDevice[] }>('/api/devices');
    if (!result || !Array.isArray(result.devices)) {
      const error = new WorkspaceConnectionError('The workspace returned an invalid device list. Check the tunnel URL and retry.');
      this.unavailable(error.message);
      throw error;
    }
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

  private setUploadPolicy(policy?: UploadPolicy) {
    if (!policy || !Number.isFinite(policy.maxUploadMb) || policy.maxUploadMb < 1 || policy.maxUploadMb > 100 || !Array.isArray(policy.allowedUploadTypes) || !policy.allowedUploadTypes.every((type) => typeof type === 'string')) return;
    this.uploadPolicy = { maxUploadMb: policy.maxUploadMb, allowedUploadTypes: [...policy.allowedUploadTypes] };
  }

  async refreshUploadPolicy() {
    const context = await this.request<{ uploadPolicy?: UploadPolicy }>('/api/context');
    this.setUploadPolicy(context.uploadPolicy);
    return this.uploadPolicy;
  }

  async refreshFiles(sessionId: string) {
    const result = await this.request<{ files: TempFile[] }>(
      '/api/sessions/' + encodeURIComponent(sessionId) + '/files'
    );
    if (!result || !Array.isArray(result.files)) {
      const error = new WorkspaceConnectionError('The workspace returned an invalid file list. Check the tunnel URL and retry.');
      this.unavailable(error.message);
      throw error;
    }
    this.files = { ...this.files, [sessionId]: result.files };
  }

  connect() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.socketTimer);
    if (!this.paired) return;
    if (!navigator.onLine) return this.networkOffline();
    // Invalidate the previous socket before closing it; late events cannot reset recovery.
    const previous = this.ws;
    this.ws = null;
    previous?.close();
    this.connection = 'connecting';
    const url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/browser';
    let ws: WebSocket;
    try {
      ws = this.remote ? new WebSocket(url, ['pi-companion', 'token.' + this.token]) : new WebSocket(url);
    } catch {
      this.unavailable('Could not open the live workspace connection. Check that the tunnel allows WebSocket connections.');
      return;
    }
    this.ws = ws;
    this.socketTimer = setTimeout(() => {
      if (this.ws !== ws) return;
      this.unavailable('The live workspace connection timed out. Check that the tunnel is running and supports WebSocket connections.');
      ws.close();
    }, 10_000);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      clearTimeout(this.socketTimer);
      void this.refresh().then(() => {
        if (this.ws !== ws) return;
        this.connection = 'online';
        this.connectionError = '';
        this.retryMs = 1000;
        clearTimeout(this.retryTimer);
      }).catch(() => {});
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      try {
        this.handle(JSON.parse(event.data));
      } catch { /* ignore malformed frames */ }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      clearTimeout(this.socketTimer);
      this.ws = null;
      if (event.code === CLOSE_REVOKED) return this.forget();
      if (event.code === CLOSE_DISCONNECTED) {
        clearTimeout(this.retryTimer);
        this.connectionError = '';
        this.connection = 'disconnected';
        return;
      }
      this.unavailable(this.connectionError || (navigator.onLine
        ? 'Live updates disconnected. The tunnel may be closed, or your workspace may be unavailable. Retrying automatically.'
        : unreachableMessage(false)));
      // Browsers hide WebSocket upgrade status. Probe HTTP for a gateway error or revoked token.
      void this.request('/api/sessions').catch(() => {});
    };
  }

  reconnect() {
    this.retryMs = 1000;
    if (this.bootError || !this.booted) void this.boot();
    else this.connect();
  }

  /** Drop this device's credential (revoked or explicitly unpaired). */
  forget() {
    if (!this.remote) return;
    localStorage.removeItem(TOKEN_KEY);
    this.token = null;
    this.connection = 'revoked';
    this.connectionError = '';
    clearTimeout(this.retryTimer);
    clearTimeout(this.socketTimer);
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
    if (this.connection !== 'online' || this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ sessionId, command }));
      return true;
    } catch {
      this.unavailable('Your message could not be sent because the live workspace connection was lost. Reconnect before trying again.');
      return false;
    }
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
    const uploaded = await this.request<TempFile>('/api/sessions/' + encodeURIComponent(sessionId) + '/files', { method: 'POST', body: data }, 60_000);
    if (!uploaded || typeof uploaded.id !== 'string' || typeof uploaded.name !== 'string' || typeof uploaded.path !== 'string' || typeof uploaded.size !== 'number') {
      throw new Error('The workspace could not confirm this upload. Check Shared files before uploading again.');
    }
    // A successful upload must not become a failed/duplicate upload if the follow-up list refresh fails.
    this.files = { ...this.files, [sessionId]: [...(this.files[sessionId] ?? []).filter((file) => file.id !== uploaded.id), uploaded] };
    void this.refreshFiles(sessionId).catch(() => {});
    return uploaded;
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
    const result = await this.request<{ token: string }>('/api/pairing/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...source, deviceName })
    });

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
