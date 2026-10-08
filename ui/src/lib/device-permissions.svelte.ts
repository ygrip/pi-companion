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

export type PermissionValue = 'granted' | 'denied' | 'prompt' | 'unsupported' | 'insecure' | 'policy';

type CameraPolicy = { allowsFeature(feature: string): boolean };

/** Policy denial is not a browser permission: prompting cannot override it. */
export function cameraAvailability(): PermissionValue {
  if (!secure()) return 'insecure';
  const doc = document as Document & { permissionsPolicy?: CameraPolicy; featurePolicy?: CameraPolicy };
  try {
    const policy = doc.permissionsPolicy ?? doc.featurePolicy;
    if (policy && !policy.allowsFeature('camera')) return 'policy';
  } catch { /* older policy APIs may not recognize camera */ }
  return typeof navigator.mediaDevices?.getUserMedia === 'function' ? 'prompt' : 'unsupported';
}

export function cameraFailure(error: unknown): { state: PermissionValue; message: string } {
  const availability = cameraAvailability();
  if (availability === 'insecure') return { state: availability, message: 'Camera requires HTTPS or localhost. Open the HTTPS Companion link, or enter the pairing code instead.' };
  if (availability === 'policy') return { state: availability, message: 'Camera is disabled by this page’s security policy. Update/restart the Companion daemon, reload this page, and check any proxy Permissions-Policy header. You can still enter the pairing code.' };
  if (availability === 'unsupported') return { state: availability, message: 'This browser does not provide camera access. Try a supported browser, or enter the pairing code.' };
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return { state: 'denied', message: 'Camera access was denied. Allow Camera for this site in your browser settings and check OS camera access, then try again. You can also enter the pairing code.' };
  if (name === 'SecurityError') return { state: 'policy', message: 'Camera access is disabled by browser or page security settings. Open Companion directly in your browser over HTTPS, or enter the pairing code.' };
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return { state: 'unsupported', message: 'No usable camera was found. Connect a camera and try again, or enter the pairing code.' };
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return { state: 'prompt', message: 'Camera could not start. Close other apps using the camera, check OS camera access, then try again. You can also enter the pairing code.' };
  if (name === 'OverconstrainedError') return { state: 'prompt', message: 'This camera cannot use the requested settings. Try another camera, or enter the pairing code.' };
  return { state: 'prompt', message: 'Could not start the camera. Check browser and OS camera access, then try again, or enter the pairing code.' };
}

/** Prefer the rear camera, but accept any camera when constraints are unsupported. */
export async function openCameraStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (error) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    throw error;
  }
}

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
  cameraError = $state('');
  cameraPending = $state(false);
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
    this.camera = cameraAvailability();
    void this.watch('notifications', () => (this.notifications = notificationState()));
    void this.watch('camera', (state) => { if (cameraAvailability() === 'prompt') this.markCamera(state); });
    // Settings changed in another tab or in the OS settings while the app was hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.notifications = notificationState();
        void this.refreshCamera();
      }
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

  private async refreshCamera() {
    const available = cameraAvailability();
    if (available !== 'prompt') { this.camera = available; return; }
    try {
      const status = await navigator.permissions?.query({ name: 'camera' as PermissionName });
      if (status) this.markCamera(status.state);
    } catch { /* Safari does not expose camera permission; a tap can retry. */ }
  }

  /** Ask for camera permission. Must run inside a click handler; releases the camera right away. */
  async requestCamera(): Promise<PermissionValue> {
    this.init();
    if (this.cameraPending) return this.camera;
    this.cameraError = '';
    // Recheck availability rather than permanently latching an earlier failure.
    const available = cameraAvailability();
    if (available !== 'prompt') {
      this.camera = available;
      this.cameraError = cameraFailure(undefined).message;
      return this.camera;
    }
    this.cameraPending = true;
    try {
      const stream = await openCameraStream();
      stream.getTracks().forEach((track) => track.stop());
      this.camera = 'granted';
    } catch (error) {
      const failure = cameraFailure(error);
      this.camera = failure.state;
      this.cameraError = failure.message;
    } finally {
      this.cameraPending = false;
    }
    return this.camera;
  }

  /** Record that the camera was granted/denied by another flow (e.g. the QR scanner). */
  markCamera(state: PermissionValue) {
    if (state === 'granted' || state !== this.camera) this.cameraError = '';
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
