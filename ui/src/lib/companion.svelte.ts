import { reduceBridgeMessage, replayActivity, type ActivityEntry } from './activity.ts';
import { sortSessions } from './format.ts';
import { toasts } from './toast.svelte.ts';
import { LiveConnection, type Connection } from './connection.ts';
export type { Connection } from './connection.ts';
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
const TOKEN_KEY = 'piCompanionDeviceToken';

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

  private live = new LiveConnection({
    enabled: () => this.booted && this.paired && navigator.onLine !== false,
    create: () => {
      const url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/browser';
      return this.remote ? new WebSocket(url, ['pi-companion', 'token.' + this.token]) : new WebSocket(url);
    },
    state: (state) => {
      if (state === 'online') return; // Confirm the workspace snapshot before enabling commands.
      this.connectionEpoch++;
      this.connection = state;
      if (state === 'disconnected' || state === 'revoked') {
        clearTimeout(this.retryTimer);
        this.connectionError = '';
      }
    },
    online: () => {
      const epoch = this.connectionEpoch;
      void this.refresh().then(() => {
        if (epoch !== this.connectionEpoch) return;
        this.connection = 'online';
        this.connectionError = '';
        this.retryMs = 1000;
        clearTimeout(this.retryTimer);
      }).catch(() => {});
    },
    message: (data) => { try { this.handle(JSON.parse(data)); } catch { /* ignore malformed frames */ } },
    lost: () => {
      this.connectionError ||= navigator.onLine ? 'Live updates disconnected. Retrying automatically.' : unreachableMessage(false);
      if (this.remote) void this.request('/api/sessions').catch(() => {});
    },
    revoked: () => this.forget()
  });
  /** Highest activity `seq` applied per session; live frames at or below it are replays. */
  private activitySeq = new Map<string, number>();
  /** Live frames that arrived while a session's activity log was being fetched. */
  private activityBuffer = new Map<string, any[]>();
  private connectionEpoch = 0;
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.connectionEpoch++;
    this.live.stop();
    this.scheduleRetry();
  }

  networkOffline() {
    if (this.connection === 'disconnected' || this.connection === 'revoked') return;
    this.unavailable(unreachableMessage(false));
  }

  async request<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const headers = new Headers(init.headers);
    const token = this.token;
    if (this.remote && token) headers.set('authorization', 'Bearer ' + token);
    try {
      return await workspaceRequest<T>(path, { ...init, headers }, timeoutMs);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && this.remote && this.token === token && path !== '/api/pairing/claim') this.forget();
      else if (error instanceof WorkspaceConnectionError) this.unavailable(error.message);
      else if (error instanceof ApiError && error.status === 403 && path === '/api/sessions') {
        this.unavailable('The workspace denied this connection (HTTP 403). Open the current device URL and check the daemon’s allowed origins and device permissions.');
      }
      throw error;
    }
  }

  async refresh() {
    await Promise.all([this.refreshSessions(), this.refreshDevices()]);
    await Promise.all([
      ...Object.keys(this.files).filter((id) => this.session(id)).map((id) => this.refreshFiles(id)),
      // Catch up on anything said while this device was offline, asleep or closed.
      ...[...this.activitySeq.keys()].filter((id) => this.session(id)).map((id) => this.loadActivity(id).catch(() => {}))
    ]);
  }

  /**
   * Load a session's recent activity from the daemon. Called when a session is opened and
   * after every (re)connect, so the feed survives reloads, closed tabs and dropped sockets.
   */
  async loadActivity(sessionId: string) {
    if (this.activityBuffer.has(sessionId)) return;
    this.activityBuffer.set(sessionId, []);
    if (!this.activitySeq.has(sessionId)) this.activitySeq.set(sessionId, 0);
    try {
      const log = await this.request<{ seq: number; messages: unknown[] }>('/api/sessions/' + encodeURIComponent(sessionId) + '/activity');
      if (!log || !Array.isArray(log.messages)) return;
      let entries = replayActivity(log.messages);
      let seq = Number(log.seq) || 0;
      for (const message of this.activityBuffer.get(sessionId) ?? []) {
        if (typeof message.seq === 'number' && message.seq <= seq) continue;
        entries = reduceBridgeMessage(entries, message);
        if (typeof message.seq === 'number') seq = message.seq;
      }
      this.activitySeq.set(sessionId, seq);
      this.activity = { ...this.activity, [sessionId]: entries };
    } finally {
      this.activityBuffer.delete(sessionId);
    }
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
    this.activitySeq.delete(sessionId);
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
    if (!navigator.onLine) return this.networkOffline();
    this.live.start();
  }

  reconnect() {
    clearTimeout(this.retryTimer);
    this.retryMs = 1000;
    if (this.bootError || !this.booted) void this.boot();
    else this.live.reconnect();
  }

  watchConnectivity() {
    const resume = () => {
      if (document.visibilityState !== 'visible' || this.connection === 'disconnected' || this.connection === 'revoked') return;
      if (this.bootError || !this.booted || this.connection === 'offline') this.reconnect();
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
      clearTimeout(this.retryTimer);
      clearTimeout(this.devicesTimer);
    };
  }

  /** Drop this device's credential (revoked or explicitly unpaired). */
  forget() {
    if (!this.remote) return;
    localStorage.removeItem(TOKEN_KEY);
    this.token = null;
    this.connection = 'revoked';
    this.connectionError = '';
    clearTimeout(this.retryTimer);
    this.live.revoke();
    this.sessions = [];
  }

  /** Observer for session snapshot changes (device notifications hook in here). */
  onSessionChange?: (previous: Session, next: Session) => void;

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
        const previous = this.sessions.find((session) => session.id === message.sessionId);
        if (previous) this.onSessionChange?.(previous, { ...previous, ...patch });
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
    if (typeof inner.seq === 'number') {
      const pending = this.activityBuffer.get(sessionId);
      if (pending) { pending.push(inner); return; }
      if (inner.seq <= (this.activitySeq.get(sessionId) ?? 0)) return;
      this.activitySeq.set(sessionId, inner.seq);
    }
    const current = this.activity[sessionId] ?? [];
    const next = reduceBridgeMessage(current, inner);
    if (next !== current) this.activity = { ...this.activity, [sessionId]: next };
  }

  send(sessionId: string, command: Record<string, unknown>) {
    const session = this.session(sessionId);
    if ((session?.readOnly || session?.automationId) && command.type !== 'ask_answer' && command.type !== 'ask_cancel') return false;
    if (this.connection !== 'online') return false;
    return this.live.send(JSON.stringify({ sessionId, command }));
  }

  prompt(sessionId: string, text: string, steer: boolean) {
    // The daemon echoes the message into every companion's feed (including this one).
    return this.send(sessionId, { type: steer ? 'steer' : 'prompt', text });
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
    return true;
  }

  dismissAsk(sessionId: string, requestId: string) {
    if (!this.send(sessionId, { type: 'ask_cancel', requestId })) return false;
    this.withoutAsk(sessionId, requestId);
    return true;
  }

  async upload(sessionId: string, file: File) {
    const session = this.session(sessionId);
    if (session?.readOnly || session?.automationId) throw new Error('Automation sessions do not accept uploads.');
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
