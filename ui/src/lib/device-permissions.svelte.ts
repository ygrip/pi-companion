/**
 * Device permissions (notifications + camera) and system notifications.
 *
 * Browsers only show a permission prompt from a user gesture (tap/click) on a secure
 * origin (HTTPS or localhost), so every `request*` method must be called from a click
 * handler. Notifications are delivered through the service worker registration when one
 * is active — Android Chrome and installed iOS web apps refuse `new Notification()`.
 */
import type { AskRequest, Session } from './types.ts';
import { sessionTitle } from './format.ts';

export type PermissionValue = 'granted' | 'denied' | 'prompt' | 'unsupported' | 'insecure';

const PREF_KEY = 'pi-companion-notifications';

function secure() {
  return typeof window !== 'undefined' && window.isSecureContext;
}

function notificationState(): PermissionValue {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (!secure()) return 'insecure';
  const value = Notification.permission;
  return value === 'default' ? 'prompt' : value;
}

class DevicePermissions {
  notifications = $state<PermissionValue>('unsupported');
  camera = $state<PermissionValue>('unsupported');
  /** User preference; only meaningful while notification permission is granted. */
  notificationsEnabled = $state(true);
  /** iOS only allows web notifications from a web app added to the Home Screen. */
  needsInstall = $state(false);

  private started = false;

  /** Read the current permission states and keep them in sync. Safe to call repeatedly. */
  init() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    try { this.notificationsEnabled = localStorage.getItem(PREF_KEY) !== 'off'; } catch { /* storage blocked */ }
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
    this.needsInstall = ios && !standalone && !('Notification' in window);
    this.notifications = notificationState();
    this.camera = !secure() ? 'insecure' : typeof navigator.mediaDevices?.getUserMedia === 'function' ? 'prompt' : 'unsupported';
    void this.watch('notifications', () => (this.notifications = notificationState()));
    void this.watch('camera', (state) => { if (this.camera !== 'insecure' && this.camera !== 'unsupported') this.camera = state; });
    // Settings changed in another tab or in the OS settings while the app was hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.notifications = notificationState();
    });
  }

  private async watch(name: string, apply: (state: PermissionValue) => void) {
    try {
      const status = await navigator.permissions?.query({ name: name as PermissionName });
      if (!status) return;
      const read = () => apply(status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'prompt');
      read();
      status.addEventListener('change', read);
    } catch { /* Safari/Firefox do not know every permission name */ }
  }

  /** Ask for notification permission. Must run inside a click handler. */
  async requestNotifications(): Promise<PermissionValue> {
    this.init();
    if (this.notifications === 'unsupported' || this.notifications === 'insecure') return this.notifications;
    try {
      const result = await Notification.requestPermission();
      this.notifications = result === 'default' ? 'prompt' : result;
    } catch {
      this.notifications = notificationState();
    }
    if (this.notifications === 'granted') {
      this.setNotificationsEnabled(true);
      await this.notify('Notifications are on', 'Pi Companion will tell you when a session needs you.', { tag: 'pi-companion-welcome' });
    }
    return this.notifications;
  }

  /** Ask for camera permission. Must run inside a click handler; releases the camera right away. */
  async requestCamera(): Promise<PermissionValue> {
    this.init();
    if (this.camera === 'unsupported' || this.camera === 'insecure') return this.camera;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      stream.getTracks().forEach((track) => track.stop());
      this.camera = 'granted';
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      this.camera = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'unsupported' : this.camera;
    }
    return this.camera;
  }

  /** Record that the camera was granted/denied by another flow (e.g. the QR scanner). */
  markCamera(state: PermissionValue) {
    this.camera = state;
  }

  setNotificationsEnabled(enabled: boolean) {
    this.notificationsEnabled = enabled;
    try { localStorage.setItem(PREF_KEY, enabled ? 'on' : 'off'); } catch { /* storage blocked */ }
  }

  get canNotify() {
    return this.notifications === 'granted' && this.notificationsEnabled;
  }

  /** Show a system notification. Returns false when notifications are unavailable. */
  async notify(title: string, body: string, options: { tag?: string; url?: string; requireInteraction?: boolean } = {}) {
    if (notificationState() !== 'granted') return false;
    const payload: NotificationOptions & { renotify?: boolean } = {
      body,
      tag: options.tag,
      renotify: Boolean(options.tag),
      icon: '/pwa-192.png',
      badge: '/pwa-192.png',
      requireInteraction: options.requireInteraction,
      data: { url: options.url ?? location.pathname }
    };
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration) {
        await registration.showNotification(title, payload);
        return true;
      }
      const notification = new Notification(title, payload);
      notification.onclick = () => {
        window.focus();
        if (options.url) location.assign(options.url);
        notification.close();
      };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Notify about a session change worth interrupting for: a new question from Pi, or a
   * session that finished working. Skipped while the user is looking at that session.
   */
  sessionChanged(previous: Session | undefined, next: Session) {
    if (!this.canNotify || !previous) return;
    const url = `/sessions/${encodeURIComponent(next.id)}`;
    const watching = document.visibilityState === 'visible' && location.pathname === url;
    if (watching) return;
    const title = sessionTitle(next);
    const known = new Set((previous.asks ?? []).map((ask) => ask.requestId));
    const fresh: AskRequest | undefined = (next.asks ?? []).find((ask) => !known.has(ask.requestId));
    if (fresh) {
      const question = fresh.title || fresh.questions[0]?.question || 'Pi is waiting for your answer.';
      void this.notify(`Pi needs an answer · ${title}`, question, { tag: `ask-${fresh.requestId}`, url, requireInteraction: true });
      return;
    }
    if (previous.status === 'active' && next.status === 'idle') {
      void this.notify(`Pi finished · ${title}`, 'The session is idle and ready for your next message.', { tag: `idle-${next.id}`, url });
    } else if (previous.status !== 'stopped' && next.status === 'stopped') {
      void this.notify(`Session ended · ${title}`, 'Pi closed this session on your computer.', { tag: `stopped-${next.id}`, url });
    }
  }
}

export const devicePermissions = new DevicePermissions();
