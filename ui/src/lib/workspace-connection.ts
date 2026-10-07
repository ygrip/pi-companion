export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class WorkspaceConnectionError extends Error {}

export function unreachableMessage(online = typeof navigator === 'undefined' || navigator.onLine !== false) {
  return online
    ? 'Cannot reach your workspace. The tunnel may be closed, or the workspace or daemon may be unavailable.'
    : 'Your device is offline. Connect to the internet to reach your workspace.';
}

/** Never expose a reverse proxy's HTML error page as an API error or JSON parse error. */
export async function workspaceRequest<T>(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  try {
    const response = await fetch(path, { ...init, signal, cache: 'no-store' });
    if ([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530].includes(response.status)) {
      throw new WorkspaceConnectionError(`Workspace unavailable (HTTP ${response.status}). The tunnel or its connection to your workspace may be down.`);
    }
    if (!response.ok) {
      const text = await response.text();
      const html = response.headers.get('content-type')?.includes('text/html') || /<!doctype|<html|<head/i.test(text);
      const message = html ? '' : text.replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new ApiError(response.status, message || `The workspace rejected this request (HTTP ${response.status}).`);
    }
    if (response.status === 204) return undefined as T;
    if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '')) {
      throw new WorkspaceConnectionError('This address did not return a workspace response. Check that the tunnel is running and you opened the current Pi Companion URL.');
    }
    try {
      return await response.json() as T;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new WorkspaceConnectionError('The workspace returned an unreadable response. Check the tunnel and retry the connection.');
    }
  } catch (error) {
    // Caller cancellation is not a connection failure.
    if (init.signal?.aborted) throw error;
    if (error instanceof ApiError || error instanceof WorkspaceConnectionError) throw error;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new WorkspaceConnectionError(unreachableMessage(false));
    if (deadline.aborted) {
      throw new WorkspaceConnectionError('The workspace did not respond in time. Check your network and that the tunnel and Pi Companion daemon are running.');
    }
    throw new WorkspaceConnectionError(unreachableMessage());
  }
}
