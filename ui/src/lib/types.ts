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
  /** Questions waiting for an answer (mirrors src/protocol.ts AskRequest). */
  asks?: AskRequest[];
};

export type AskOption = { label: string; description?: string };

export type AskQuestion = {
  id: string;
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
  placeholder?: string;
};

export type AskRequest = {
  requestId: string;
  /** "companion" for Pi's companion_ask_user tool; otherwise a relayed extension dialog. */
  source: 'companion' | 'tool' | 'select' | 'confirm' | 'input';
  title?: string;
  questions: AskQuestion[];
  createdAt: string;
};

export type AskAnswers = Record<string, string[]>;

export type TempFile = {
  id: string;
  name: string;
  path: string;
  size: number;
  /** MIME type the daemon accepted the upload as. */
  mime?: string;
  createdAt: number | string;
};

export type PairedDevice = {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen: number;
  /** Browser user agent recorded at pairing. */
  userAgent?: string;
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
  /** MIME allowlist for uploads (`image/*`, `application/pdf`); empty allows everything. */
  allowedUploadTypes: string[];
};

export type SettingsResponse = {
  settings: Settings;
  effective: { publicUrl: string; publicUrlFromEnv: boolean };
  limits: { maxUploadMb: number };
  about: { version: string; adminUrl: string; deviceUrl: string; dataDir: string; tempDir: string };
};
