import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import WebSocket from "ws";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureDaemon } from "./daemon.js";
import type { BridgeMessage, ServerMessage, SessionSnapshot, TempFile } from "./protocol.js";

const execFileAsync = promisify(execFile);

export class CompanionBridge {
  readonly sessionId = randomUUID();
  private ws?: WebSocket;
  private ctx?: ExtensionContext;
  private reconnect?: NodeJS.Timeout;
  private closed = false;
  private connecting = false;
  private everConnected = false;
  private downSince = 0;
  private retryDelay = 1000;
  private lastWarning = "";
  private tempFiles: TempFile[] = [];
  private pendingAsks = new Map<string, { resolve: (answer: string) => void; timer: NodeJS.Timeout }>();
  private pendingDeletes = new Map<string, { resolve: (result: { ok: boolean; error?: string }) => void; timer: NodeJS.Timeout }>();
  private snapshot: SessionSnapshot = {
    id: this.sessionId,
    cwd: process.cwd(),
    pid: process.pid,
    shortTitle: process.cwd().split(/[\\/]/).filter(Boolean).pop() ?? "Pi",
    status: "idle",
    remoteEnabled: false,
    connectedAt: new Date().toISOString()
  };

  constructor(private readonly pi: ExtensionAPI) {}

  setContext(ctx: ExtensionContext) {
    this.ctx = ctx;
    this.snapshot = {
      ...this.snapshot,
      cwd: ctx.cwd,
      shortTitle: this.snapshot.name?.trim() || ctx.cwd.split(/[\\/]/).filter(Boolean).pop() || "Pi",
      mainModel: ctx.model?.id,
      effort: ctx.thinkingLevel,
      status: ctx.isIdle() ? "idle" : "active"
    };
  }

  setName(name?: string) {
    this.snapshot.name = name;
    this.send({ type: "session.update", session: { name } });
  }

  setRemoteEnabled(remoteEnabled: boolean) {
    this.snapshot.remoteEnabled = remoteEnabled;
    this.send({ type: "session.update", session: { remoteEnabled } });
  }

  isRemoteEnabled() {
    return this.snapshot.remoteEnabled;
  }

  getTempFiles() {
    return [...this.tempFiles];
  }

  /** Connect to the shared daemon, launching it only when nothing is listening. */
  async connect() {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    try {
      // After a live connection drops (e.g. a dev daemon restarting), give it a grace
      // period to come back before launching a replacement.
      const allowSpawn = !this.everConnected || (this.downSince > 0 && Date.now() - this.downSince > 20_000);
      if (allowSpawn) await ensureDaemon((message, level = "info") => this.log(message, level));
      if (this.closed) return;
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
      this.everConnected = true;
      this.downSince = 0;
      this.retryDelay = 1000;
      this.send({ type: "register", session: this.snapshot });
    });
    ws.on("message", raw => {
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

  async ask(question: string, options?: string[]) {
    const requestId = randomUUID();
    this.send({ type: "ask.request", requestId, question, options });
    return await new Promise<string>(resolve => {
      const timer = setTimeout(() => {
        this.pendingAsks.delete(requestId);
        resolve("");
      }, 10 * 60_000);
      this.pendingAsks.set(requestId, { resolve, timer });
    });
  }

  async deleteTempFile(fileId: string) {
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
    if (this.closed) return;
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
      case "ask_answer": {
        const pending = this.pendingAsks.get(command.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingAsks.delete(command.requestId);
        pending.resolve(command.answer);
      }
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
      this.send({ type: "error", message: "git diff failed: " + String(error) });
    }
  }
}
