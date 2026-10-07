export type SessionStatus = 'active' | 'idle' | 'stopped';

export type Session = {
  id: string;
  name?: string;
  shortTitle: string;
  cwd: string;
  pid: number;
  status: SessionStatus;
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
  connected: boolean;
  connections: number;
};

export type Pairing = {
  code: string;
  url: string;
  qrSvg: string;
  expiresAt: number;
};

export type Settings = {
  publicUrl: string;
  pairingTtlMinutes: number;
  maxUploadMb: number;
};

export type SettingsResponse = {
  settings: Settings;
  effective: { publicUrl: string; publicUrlFromEnv: boolean };
  limits: { maxUploadMb: number };
  about: { version: string; adminUrl: string; deviceUrl: string; dataDir: string; tempDir: string };
};
