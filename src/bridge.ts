import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import WebSocket from "ws";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { relayDialogs, ToolDialogRelay, type AskChannel, type AskInput } from "./ask.js";
import { ensureDaemon } from "./daemon.js";
import type { AskAnswers, AskRequest, BridgeMessage, ServerMessage, SessionSnapshot, TempFile } from "./protocol.js";

const execFileAsync = promisify(execFile);

export class CompanionBridge implements AskChannel {
  readonly sessionId = randomUUID();
  /** Relays question tools that ask through ctx.ui.custom (fed from tool_execution_* events). */
  readonly toolDialogs = new ToolDialogRelay(this);
  private ws?: WebSocket;
  private ctx?: ExtensionContext;
  private reconnect?: NodeJS.Timeout;
  private closed = false;
  private activated = false;
  private restoreDialogs?: () => void;
  private connecting = false;
  private everConnected = false;
  private downSince = 0;
  private retryDelay = 1000;
  private lastWarning = "";
  private tempFiles: TempFile[] = [];
  private asks = new Map<string, { request: AskRequest; settle: (answers: AskAnswers | null) => void }>();
  private pendingDeletes = new Map<string, { resolve: (result: { ok: boolean; error?: string }) => void; timer: NodeJS.Timeout }>();
  private snapshot: SessionSnapshot = {
    id: this.sessionId,
    cwd: process.cwd(),
    pid: process.pid,
    shortTitle: process.cwd().split(/[\\/]/).filter(Boolean).pop() ?? "Pi",
    status: "idle",
    remoteEnabled: false,
    connectedAt: new Date().toISOString(),
    asks: []
  };

  constructor(private readonly pi: ExtensionAPI) {}

  setContext(ctx: ExtensionContext) {
    this.ctx = ctx;
    if (this.activated && this.snapshot.remoteEnabled && ctx.hasUI && !this.restoreDialogs) this.restoreDialogs = relayDialogs(ctx.ui, this, this.toolDialogs);
    const name = this.pi.getSessionName() ?? this.snapshot.name;
    this.snapshot = {
      ...this.snapshot,
      name,
      cwd: ctx.cwd,
      shortTitle: name?.trim() || ctx.cwd.split(/[\\/]/).filter(Boolean).pop() || "Pi",
      mainModel: ctx.model?.id,
      effort: ctx.thinkingLevel,
      status: ctx.isIdle() ? "idle" : "active"
    };
  }

  setName(name?: string) {
    this.snapshot.name = name;
    this.snapshot.shortTitle = name?.trim() || this.snapshot.cwd.split(/[\\/]/).filter(Boolean).pop() || "Pi";
    this.send({ type: "session.update", session: { name, shortTitle: this.snapshot.shortTitle } });
  }

  setRemoteEnabled(remoteEnabled: boolean) {
    this.snapshot.remoteEnabled = remoteEnabled;
    this.snapshot.status = remoteEnabled ? (this.ctx?.isIdle() === false ? "active" : "idle") : "stopped";
    this.send({ type: "session.update", session: { remoteEnabled, status: this.snapshot.status } });
    if (remoteEnabled) {
      if (this.isActivated()) { this.activate(); void this.connect(); }
      return;
    }
    // End only Companion sharing: Pi itself and its local history keep running.
    this.restoreDialogs?.();
    this.restoreDialogs = undefined;
    for (const entry of [...this.asks.values()]) entry.settle(null);
    for (const pending of this.pendingDeletes.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "Session sharing ended." });
    }
    this.pendingDeletes.clear();
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  isRemoteEnabled() {
    return this.snapshot.remoteEnabled;
  }

  getTempFiles() {
    return [...this.tempFiles];
  }

  /** Only an explicit /companion command may activate this session's bridge. */
  activate() {
    this.activated = true;
    if (this.snapshot.remoteEnabled && this.ctx?.hasUI && !this.restoreDialogs) this.restoreDialogs = relayDialogs(this.ctx.ui, this, this.toolDialogs);
  }

  isActivated() {
    return this.activated && !this.closed;
  }

  /** Connect to the shared daemon only after this session opted in. */
  async connect() {
    if (!this.activated || !this.snapshot.remoteEnabled || this.closed || this.connecting) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return; // connecting or already live
    this.connecting = true;
    try {
      // After a live connection drops (e.g. a dev daemon restarting), give it a grace
      // period to come back before launching a replacement.
      const allowSpawn = !this.everConnected || (this.downSince > 0 && Date.now() - this.downSince > 20_000);
      if (allowSpawn) await ensureDaemon((message, level = "info") => this.log(message, level));
      if (this.closed || !this.snapshot.remoteEnabled) return;
      this.open();
    } finally {
      this.connecting = false;
    }
  }

  private open() {
    const base = process.env.PI_COMPANION_URL ?? "ws://127.0.0.1:43721";
    const ws = new WebSocket(base.replace(/\/$/, "") + "/ws/bridge/" + this.sessionId);
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws || this.closed || !this.snapshot.remoteEnabled) { ws.close(); return; }
      this.everConnected = true;
      this.downSince = 0;
      this.retryDelay = 1000;
      this.send({ type: "register", session: this.snapshot });
    });
    ws.on("message", raw => {
      if (this.ws !== ws || this.closed || !this.snapshot.remoteEnabled) return;
      try { void this.handle(JSON.parse(raw.toString()) as ServerMessage); }
      catch (error) { this.send({ type: "error", message: "Invalid server message: " + String(error) }); }
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      if (!this.downSince) this.downSince = Date.now();
      this.scheduleReconnect();
    });
    ws.on("error", () => { /* close follows; reconnect is scheduled there */ });
  }

  private log(message: string, level: "info" | "warning" | "error") {
    if (level !== "info" && message === this.lastWarning) return;
    if (level !== "info") this.lastWarning = message;
    this.ctx?.ui.notify(message, level);
  }

  close() {
    this.closed = true;
    this.restoreDialogs?.();
    this.restoreDialogs = undefined;
    for (const entry of [...this.asks.values()]) entry.settle(null);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.ws?.close();
  }

  emit(event: string, payload: unknown) {
    this.send({ type: "event", event, payload });
  }

  updateStatus(status: "active" | "idle" | "stopped") {
    this.snapshot.status = status;
    this.send({ type: "session.update", session: { status } });
  }

  /**
   * Publish a question to the companion UI. Pending questions live in the session snapshot,
   * so browsers that connect later still see them.
   */
  ask(input: AskInput, signal?: AbortSignal) {
    const request: AskRequest = { ...input, requestId: randomUUID(), createdAt: new Date().toISOString() };
    return new Promise<AskAnswers | null>(resolve => {
      if (!this.isActivated() || !this.snapshot.remoteEnabled || signal?.aborted) return resolve(null);
      const onAbort = () => settle(null);
      const settle = (answers: AskAnswers | null) => {
        if (!this.asks.delete(request.requestId)) return;
        signal?.removeEventListener("abort", onAbort);
        this.publishAsks();
        resolve(answers);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.asks.set(request.requestId, { request, settle });
      this.publishAsks();
    });
  }

  private publishAsks() {
    const asks = [...this.asks.values()].map(entry => entry.request);
    this.snapshot.asks = asks;
    this.send({ type: "session.update", session: { asks } });
  }

  async deleteTempFile(fileId: string) {
    if (!this.isActivated()) return { ok: false, error: "Run /companion first to enable this session." };
    const requestId = randomUUID();
    this.send({ type: "file.delete", requestId, fileId });
    return await new Promise<{ ok: boolean; error?: string }>(resolve => {
      const timer = setTimeout(() => {
        this.pendingDeletes.delete(requestId);
        resolve({ ok: false, error: "Timed out waiting for the companion daemon." });
      }, 10_000);
      this.pendingDeletes.set(requestId, { resolve, timer });
    });
  }

  private send(message: BridgeMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private scheduleReconnect() {
    if (this.reconnect) clearTimeout(this.reconnect);
    if (!this.activated || !this.snapshot.remoteEnabled || this.closed) return;
    this.reconnect = setTimeout(() => void this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
  }

  private async handle(message: ServerMessage) {
    if (message.type === "ping") return;
    if (message.type === "temp.files") {
      this.tempFiles = message.files;
      return;
    }
    if (message.type === "file.delete.result") {
      const pending = this.pendingDeletes.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingDeletes.delete(message.requestId);
      pending.resolve({ ok: message.ok, error: message.error });
      return;
    }

    const command = message.command;
    switch (command.type) {
      case "prompt":
        await this.pi.sendUserMessage(command.text, { expandPromptTemplates: true });
        break;
      case "steer":
        await this.pi.sendUserMessage(command.text, { deliverAs: "steer", expandPromptTemplates: true });
        break;
      case "abort":
        this.ctx?.abort();
        break;
      case "plan":
        await this.pi.sendUserMessage(command.text?.trim() ? "/plan " + command.text.trim() : "/plan");
        break;
      case "git_diff":
        await this.sendGitDiff(Boolean(command.staged));
        break;
      case "ask_answer":
        this.asks.get(command.requestId)?.settle(command.answers ?? {});
        break;
      case "ask_cancel":
        this.asks.get(command.requestId)?.settle(null);
        break;
    }
  }

  private async sendGitDiff(staged: boolean) {
    const args = ["diff", "--no-ext-diff", "--no-color"];
    if (staged) args.push("--cached");
    try {
      const result = await execFileAsync("git", args, {
        cwd: this.ctx?.cwd ?? process.cwd(),
        maxBuffer: 4 * 1024 * 1024
      });
      this.send({ type: "git.diff", staged, diff: result.stdout });
    } catch (error) {
      // Reported with the diff (shown as a toast), never as a session activity error.
      const failure = error && typeof error === "object" ? error : {};
      const stderr = "stderr" in failure ? String(failure.stderr ?? "") : "";
      const missingGit = "code" in failure && failure.code === "ENOENT";
      const message = /not a git repository/i.test(stderr)
        ? "This project is not tracked by git."
        : missingGit
          ? "git is not installed on this computer."
          : "git diff failed: " + (stderr.trim().split("\n")[0] || String(error));
      this.send({ type: "git.diff", staged, diff: "", error: message });
    }
  }
}
