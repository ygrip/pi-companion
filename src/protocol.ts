export type TempFile = {
  id: string;
  name: string;
  path: string;
  size: number;
  createdAt: string;
};

export type SessionSnapshot = {
  id: string;
  name?: string;
  cwd: string;
  pid: number;
  shortTitle: string;
  status: "active" | "idle" | "stopped";
  mainModel?: string;
  effort?: string;
  remoteEnabled: boolean;
  connectedAt: string;
};

export type BrowserCommand =
  | { type: "prompt"; text: string }
  | { type: "steer"; text: string }
  | { type: "abort" }
  | { type: "plan"; text?: string }
  | { type: "git_diff"; staged?: boolean }
  | { type: "ask_answer"; requestId: string; answer: string };

export type BridgeMessage =
  | { type: "register"; session: SessionSnapshot }
  | { type: "session.update"; session: Partial<SessionSnapshot> }
  | { type: "event"; event: string; payload: unknown }
  | { type: "ask.request"; requestId: string; question: string; options?: string[] }
  | { type: "git.diff"; staged: boolean; diff: string }
  | { type: "file.delete"; requestId: string; fileId: string }
  | { type: "error"; message: string };

export type ServerMessage =
  | { type: "command"; command: BrowserCommand }
  | { type: "temp.files"; files: TempFile[] }
  | { type: "file.delete.result"; requestId: string; ok: boolean; error?: string }
  | { type: "ping" };
