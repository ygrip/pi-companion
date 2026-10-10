export type SessionStatus = 'active' | 'idle' | 'stopped';

export type AutomationAction =
  | { type: 'command'; command: string; args: string[]; cwd?: string; timeoutSeconds?: number }
  | { type: 'pi'; prompt: string; cwd: string; timeoutSeconds?: number };

export type AutomationDraft = {
  name: string;
  enabled: boolean;
  preconditions: AutomationAction[];
  actions: AutomationAction[];
  postActions: AutomationAction[];
  schedule: string | null;
  historyLimit?: number;
  maxRetries?: number;
  retryIntervalSeconds?: number;
};
export type Automation = AutomationDraft & { id: string; createdAt: number; updatedAt: number };
export type AutomationRun = {
  id: string;
  automationId: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'succeeded' | 'failed' | 'stopped' | 'skipped';
  result: string;
  sessionId?: string;
};

export type UsageWindow = { usedPercent: number; resetsAt?: string };

/** Provider account limits, reported by any compatible extension. */
export type ProviderUsage = {
  provider: string;
  source?: string;
  updatedAt: string;
  weekly?: UsageWindow;
  fiveHour?: UsageWindow;
  sessionTokens?: number;
  sessionCost?: number;
  sessionUpdatedAt?: string;
};

export type SessionTelemetry = {
  context?: { tokens?: number; window?: number; percent?: number; source?: string };
  cost?: { amount: number; currency?: string; source?: string };
  providers?: ProviderUsage[];
};

export type TerminalPopup = { id: string; lines: string[]; width: number };

export type Session = {
  popups?: TerminalPopup[];
  id: string;
  name?: string | null;
  shortTitle: string;
  cwd: string;
  pid: number;
  status: SessionStatus;
  mainModel?: string | null;
  effort?: string | null;
  telemetry?: SessionTelemetry;
  remoteEnabled: boolean;
  commands?: { name: string; description?: string; source: 'extension' | 'prompt' | 'skill' }[];
  readOnly?: boolean;
  automationId?: string;
  automationRunId?: string;
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
  source?: 'user' | 'agent';
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
