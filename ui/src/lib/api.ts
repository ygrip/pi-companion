export type Session = {
  id: string;
  name?: string;
  shortTitle: string;
  cwd: string;
  pid: number;
  status: 'active' | 'idle' | 'stopped';
  mainModel?: string;
  effort?: string;
  remoteEnabled: boolean;
  connectedAt: string;
};

export type TempFile = {
  id: string;
  name: string;
  path: string;
  size: number;
  createdAt: number | string;
};

export type PairedDevice = {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen: number;
};

export function createApi(remote: boolean, token: string | null) {
  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers);
    if (remote && token) headers.set('authorization', 'Bearer ' + token);
    const response = await fetch(path, { ...options, headers });
    if (!response.ok) throw new Error((await response.text()) || response.statusText);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  return { request };
}
