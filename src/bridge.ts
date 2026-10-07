import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import WebSocket from "ws";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BridgeMessage, ServerMessage, SessionSnapshot, TempFile } from "./protocol.js";

const execFileAsync = promisify(execFile);

export class CompanionBridge {
  readonly sessionId = randomUUID();
  private ws?: WebSocket;
  private ctx?: ExtensionContext;
  private startedServer = false;
  private reconnect?: NodeJS.Timeout;
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
    const shortTitle = name?.trim() || this.snapshot.cwd.split(/[\\/]/).filter(Boolean).pop() || "Pi";
    this.snapshot.shortTitle = shortTitle;
    this.send({ type: "session.update", session: { name, shortTitle } });
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

  connect() {
    const base = process.env.PI_COMPANION_URL ?? "ws://127.0.0.1:43721";
    this.ws = new WebSocket(base.replace(/\/$/, "") + "/ws/bridge/" + this.sessionId);
    this.ws.on("open", () => this.send({ type: "register", session: this.snapshot }));
    this.ws.on("message", raw => {
      try { void this.handle(JSON.parse(raw.toString()) as ServerMessage); }
      catch (error) { this.send({ type: "error", message: "Invalid server message: " + String(error) }); }
    });
    this.ws.on("close", () => this.scheduleReconnect());
    this.ws.on("error", () => {
      if (!this.startedServer && (process.env.PI_COMPANION_AUTOSTART ?? "1") !== "0") {
        this.startedServer = true;
        const binary = process.env.PI_COMPANION_SERVER ?? "pi-companion-server";
        const child = spawn(binary, [], { detached: true, stdio: "ignore" });
        child.unref();
      }
    });
  }

  close() {
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
    this.reconnect = setTimeout(() => this.connect(), 1500);
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
