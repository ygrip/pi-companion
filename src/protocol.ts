export type SessionSnapshot = {
  id: string;
  name?: string;
  cwd: string;
  pid: number;
  model?: string;
  thinkingLevel?: string;
  idle: boolean;
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
  | { type: "error"; message: string };

export type ServerMessage =
  | { type: "command"; command: BrowserCommand }
  | { type: "ping" };
