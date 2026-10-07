/** One live socket, bounded retries, and liveness checks (including silent network loss). */
export type Connection = 'connecting' | 'online' | 'offline' | 'disconnected' | 'revoked';

export class LiveConnection {
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private retryMs = 1000;
  private paused = false;
  private running = false;

  constructor(private readonly hooks: {
    enabled: () => boolean;
    create: () => WebSocket;
    state: (state: Connection) => void;
    online: () => void;
    message: (data: string) => void;
    lost: () => void;
    revoked: () => void;
  }) {}

  start() {
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    this.clearTimers();
    this.retire();
  }

  /** Only an explicit user retry may undo a deliberate disconnect. */
  reconnect() {
    this.paused = false;
    this.retryMs = 1000;
    this.running = true;
    this.replace();
  }

  /** A phone waking up may have an OPEN socket whose underlying network is gone. */
  resume() {
    if (!this.running || this.paused || !this.hooks.enabled()) return;
    this.retryMs = 1000;
    this.replace();
  }

  revoke() {
    this.paused = true;
    this.clearTimers();
    this.retire();
    this.hooks.state('revoked');
  }

  send(text: string) {
    if (this.socket?.readyState !== 1) return false;
    try {
      this.socket.send(text);
      return true;
    } catch {
      this.fail(this.socket);
      return false;
    }
  }

  private clearTimers() {
    clearTimeout(this.retry);
    clearTimeout(this.watchdog);
  }

  private retire() {
    const socket = this.socket;
    this.socket = null; // Late open/message/close callbacks cannot mutate a new connection.
    socket?.close();
  }

  private replace() {
    this.clearTimers();
    this.retire();
    this.connect();
  }

  private connect() {
    if (!this.running || this.paused || !this.hooks.enabled() || this.socket) return;
    clearTimeout(this.retry);
    this.hooks.state('connecting');
    let socket: WebSocket;
    try {
      socket = this.hooks.create();
    } catch {
      this.hooks.state('offline');
      this.schedule();
      return;
    }
    this.socket = socket;
    this.arm(socket, 15_000); // A handshake must not stay CONNECTING forever.
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.retryMs = 1000;
      this.hooks.state('online');
      this.arm(socket, 45_000);
      this.hooks.online();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.arm(socket, 45_000);
      this.hooks.message(String(event.data));
    };
    socket.onerror = () => this.fail(socket);
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      clearTimeout(this.watchdog);
      this.socket = null;
      if (event.code === 4003) {
        this.revoke();
        this.hooks.revoked();
      } else if (event.code === 4001) {
        this.paused = true;
        this.clearTimers();
        this.hooks.state('disconnected');
      } else {
        this.hooks.state('offline');
        this.hooks.lost();
        this.schedule();
      }
    };
  }

  private arm(socket: WebSocket, delay: number) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.fail(socket), delay);
  }

  private fail(socket: WebSocket) {
    if (this.socket !== socket) return;
    clearTimeout(this.watchdog);
    this.retire();
    this.hooks.state('offline');
    this.hooks.lost();
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.retry);
    if (!this.running || this.paused || !this.hooks.enabled()) return;
    this.retry = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 15_000);
  }
}
