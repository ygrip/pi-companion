import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import WebSocket from "ws";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { relayDialogs, ToolDialogRelay, type AskChannel, type AskInput } from "./ask.js";
import { ensureDaemon } from "./daemon.js";
import { TelemetryRelay } from "./telemetry.js";
import { PopupRelay } from "./popup.js";
import type { AskAnswers, AskRequest, BridgeMessage, ServerMessage, SessionSnapshot, TempFile } from "./protocol.js";

const execFileAsync = promisify(execFile);

export class CompanionBridge implements AskChannel {
  readonly sessionId = randomUUID();
  /** Relays question tools that ask through ctx.ui.custom (fed from tool_execution_* events). */
  readonly toolDialogs = new ToolDialogRelay(this);
  readonly popups = new PopupRelay(popups => {
    this.snapshot.popups = popups;
    this.send({ type: "session.update", session: { popups } });
  });
  private ws?: WebSocket;
  private ctx?: ExtensionContext;
  private reconnect?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private metadataTimer?: NodeJS.Timeout;
  private telemetryRequestedAt = 0;
  private restoreStatus?: () => void;
  private telemetry = new TelemetryRelay();
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
    if (this.activated && this.snapshot.remoteEnabled && ctx.hasUI && !this.restoreDialogs) this.restoreDialogs = relayDialogs(ctx.ui, this, this.toolDialogs, this.popups);
    this.refreshMetadata();
  }

  setName(name?: string) {
    this.snapshot.name = name ?? null;
    this.snapshot.shortTitle = name?.trim() || this.snapshot.cwd.split(/[\\/]/).filter(Boolean).pop() || "Pi";
    this.send({ type: "session.update", session: { name: name ?? null, shortTitle: this.snapshot.shortTitle } });
  }

  /** Context getters remain live while idle; send only changed metadata, including explicit clears. */
  refreshMetadata() {
    const ctx = this.ctx;
    if (!ctx || this.closed) return;
    const cwd = ctx.cwd || ctx.sessionManager?.getCwd?.() || process.cwd();
    const name = this.pi.getSessionName() ?? null;
    if ((this.snapshot.mainModel ?? null) !== (ctx.model?.id ?? null)) this.telemetry.invalidateContext();
    const next = {
      name, cwd,
      shortTitle: name?.trim() || cwd.split(/[\\/]/).filter(Boolean).pop() || "Pi",
      mainModel: ctx.model?.id ?? null,
      effort: ctx.thinkingLevel ?? this.pi.getThinkingLevel?.() ?? null,
      telemetry: this.telemetry.snapshot(ctx),
      // Expose only executable slash commands, not local source paths or credentials.
      commands: (this.pi.getCommands?.() ?? []).slice(0, 500).map(command => ({
        name: command.name, description: command.description?.slice(0, 500), source: command.source
      }))
    };
    const patch: Partial<SessionSnapshot> = {};
    for (const key of Object.keys(next) as Array<keyof typeof next>) {
      if (JSON.stringify(this.snapshot[key]) !== JSON.stringify(next[key])) Object.assign(patch, { [key]: next[key] });
    }
    Object.assign(this.snapshot, patch);
    if (Object.keys(patch).length) this.send({ type: "session.update", session: patch });
    if (this.activated && this.snapshot.remoteEnabled && Date.now() - this.telemetryRequestedAt >= 30_000) this.requestTelemetry();
  }

  invalidateContext() {
    this.telemetry.invalidateContext();
  }

  ingestTelemetry(value: unknown, source: string) {
    if (!this.isActivated() || !this.snapshot.remoteEnabled) return;
    const id = value && typeof value === "object" ? (value as { sessionId?: unknown }).sessionId : undefined;
    if (id !== undefined && id !== this.sessionId && id !== this.ctx?.sessionManager?.getSessionId?.()) return;
    this.telemetry.ingest(value, source);
    this.refreshMetadata();
  }

  private requestTelemetry() {
    this.telemetryRequestedAt = Date.now();
    try {
      this.pi.events?.emit("companion:telemetry:request", { sessionId: this.ctx?.sessionManager?.getSessionId?.(), companionSessionId: this.sessionId });
    } catch { /* A failing third-party responder must never interrupt sharing. */ }
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
    this.popups.clear();
    this.restoreStatus?.();
    this.restoreStatus = undefined;
    if (this.metadataTimer) clearInterval(this.metadataTimer);
    this.metadataTimer = undefined;
    for (const entry of [...this.asks.values()]) entry.settle(null);
    for (const pending of this.pendingDeletes.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "Session sharing ended." });
    }
    this.pendingDeletes.clear();
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = undefined;
    if (this.heartbeat) clearTimeout(this.heartbeat);
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
    if (this.snapshot.remoteEnabled && this.ctx?.hasUI && !this.restoreDialogs) this.restoreDialogs = relayDialogs(this.ctx.ui, this, this.toolDialogs, this.popups);
    if (!this.snapshot.remoteEnabled) return;
    const ui = this.ctx?.ui;
    if (ui && typeof ui.setStatus === "function" && !this.restoreStatus) {
      const original = ui.setStatus;
      const relay = this.telemetry;
      const wrapped: typeof original = function(key, value) {
        original.call(ui, key, value);
        relay.status(key, value);
      };
      ui.setStatus = wrapped;
      this.restoreStatus = () => { if (ui.setStatus === wrapped) ui.setStatus = original; };
    }
    if (!this.metadataTimer) {
      this.metadataTimer = setInterval(() => this.refreshMetadata(), 1000);
      this.metadataTimer.unref();
    }
    this.refreshMetadata();
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
    } catch (error) {
      this.log("Could not reconnect to Pi Companion: " + String(error), "warning");
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private open() {
    const base = process.env.PI_COMPANION_URL ?? "ws://127.0.0.1:43721";
    const ws = new WebSocket(base.replace(/\/$/, "") + "/ws/bridge/" + this.sessionId, { handshakeTimeout: 15_000 });
    this.ws = ws;
    const alive = () => {
      if (this.ws !== ws || this.closed) return;
      if (this.heartbeat) clearTimeout(this.heartbeat);
      this.heartbeat = setTimeout(() => ws.terminate(), 45_000);
      this.heartbeat.unref();
    };
    ws.on("ping", alive); // ws automatically pongs; the watchdog detects silent loss.
    ws.on("open", () => {
      if (this.ws !== ws || this.closed || !this.snapshot.remoteEnabled) return ws.terminate();
      alive();
      this.everConnected = true;
      this.downSince = 0;
      this.retryDelay = 1000;
      this.send({ type: "register", session: this.snapshot });
    });
    ws.on("message", raw => {
      if (this.ws !== ws || this.closed || !this.snapshot.remoteEnabled) return;
      alive();
      const failure = (error: unknown) => this.send({ type: "error", message: "Invalid server message: " + String(error) });
      try { void this.handle(JSON.parse(raw.toString()) as ServerMessage).catch(failure); }
      catch (error) { failure(error); }
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      if (this.heartbeat) clearTimeout(this.heartbeat);
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
    this.popups.clear();
    this.restoreStatus?.();
    this.restoreStatus = undefined;
    if (this.metadataTimer) clearInterval(this.metadataTimer);
    this.metadataTimer = undefined;
    for (const entry of [...this.asks.values()]) entry.settle(null);
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.heartbeat) clearTimeout(this.heartbeat);
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
      case "popup_input":
        this.popups.input(command.popupId, command.data);
        break;
      case "popup_close":
        this.popups.close(command.popupId);
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
