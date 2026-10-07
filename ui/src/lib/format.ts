import type { Session, SessionStatus } from './types.ts';

export function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** Accepts epoch seconds, epoch milliseconds or an ISO string. */
export function toDate(value: number | string) {
  if (typeof value === 'string') return new Date(value);
  return new Date(value < 1e12 ? value * 1000 : value);
}

export function relativeTime(value: number | string, now = Date.now()) {
  const seconds = Math.round((now - toDate(value).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hours / 24);
  if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
  return toDate(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function shortDate(value: number | string) {
  return toDate(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export const statusLabel: Record<SessionStatus, string> = {
  active: 'Working',
  idle: 'Waiting',
  stopped: 'Ended'
};

export function sessionTitle(session: Session) {
  return session.name?.trim() || session.shortTitle || 'Pi session';
}

/** Collapse the home directory so paths stay readable in narrow cards. */
export function prettyPath(path: string) {
  return path.replace(/^\/(Users|home)\/[^/]+/, '~');
}

const order: Record<SessionStatus, number> = { active: 0, idle: 1, stopped: 2 };

export function sortSessions(sessions: Session[]) {
  return [...sessions].sort(
    (a, b) => order[a.status] - order[b.status] || b.connectedAt.localeCompare(a.connectedAt)
  );
}
