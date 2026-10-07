export type TempFile = {
  id: string;
  name: string;
  path: string;
  size: number;
  mime?: string;
  createdAt: string;
};

export type AskOption = { label: string; description?: string };

/** One question in an ask. No options + allowCustom means free text. */
export type AskQuestion = {
  id: string;
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
  placeholder?: string;
};

/**
 * A pending question shown in the companion UI. `source` is "companion" for the
 * companion_ask_user tool, "tool" for another extension's question tool (e.g. pi-jar's
 * jar_ask), otherwise the relayed ctx.ui dialog kind.
 */
export type AskRequest = {
  requestId: string;
  source: "companion" | "tool" | "select" | "confirm" | "input";
  title?: string;
  questions: AskQuestion[];
  createdAt: string;
};

/** Answers keyed by question id; each value lists chosen option labels and/or custom text. */
export type AskAnswers = Record<string, string[]>;

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
  /** Questions waiting for an answer. Kept in the snapshot so late-joining browsers see them. */
  asks: AskRequest[];
};

export type BrowserCommand =
  | { type: "prompt"; text: string }
  | { type: "steer"; text: string }
  | { type: "abort" }
  | { type: "plan"; text?: string }
  | { type: "git_diff"; staged?: boolean }
  | { type: "ask_answer"; requestId: string; answers: AskAnswers }
  | { type: "ask_cancel"; requestId: string };

export type BridgeMessage =
  | { type: "register"; session: SessionSnapshot }
  | { type: "session.update"; session: Partial<SessionSnapshot> }
  | { type: "event"; event: string; payload: unknown }
  | { type: "git.diff"; staged: boolean; diff: string; error?: string }
  | { type: "file.delete"; requestId: string; fileId: string }
  | { type: "error"; message: string };

export type ServerMessage =
  | { type: "command"; command: BrowserCommand }
  | { type: "temp.files"; files: TempFile[] }
  | { type: "file.delete.result"; requestId: string; ok: boolean; error?: string }
  | { type: "ping" };
